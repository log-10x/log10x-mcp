/**
 * Autonomous runner — drives Anthropic Messages API and lets the model
 * decide which tools to call. Tool execution happens via the SAME
 * tool-registry the deterministic runner uses (in-process, no stdio
 * MCP server) — this keeps the harness simple and avoids spinning up a
 * subprocess for every scenario.
 *
 * Why local execution rather than the MCP-connector REST endpoint: the
 * connector requires the MCP server to be HTTP-reachable from
 * Anthropic's API, which means tunneling. We get equivalent semantics
 * (the model picks tools, args, and ordering) by exposing the same tools
 * via the regular Messages API tool_use loop. The judge cannot tell the
 * difference.
 *
 * The runner emits the same JSONL transcript shape as deterministic
 * mode, so judge / sequence-diff / autonomy code is mode-agnostic.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Scenario, RunOutcome, StepLog } from './types.js';
import { interpolateEnvVars, type EvalEnv } from './env.js';
import { invokeTool, TOOL_NAMES, TOOL_SCHEMAS } from './tool-registry.js';
import type { TranscriptWriter, StepLogWriter } from './transcript-writer.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export interface AutonomousResult {
  outcome: RunOutcome;
  totalSteps: number;
  finalText: string;
  stepLogs: StepLog[];
}

interface ToolDecl {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Build tool declarations using each tool's real Zod-derived JSON Schema.
 *
 * Why this matters for evaluation: a production MCP client (Claude
 * Desktop, Cursor, etc.) sees the full schema with `properties` —
 * including literal field names like `backends`, `app`, `snapshot_id`.
 * When the harness advertised only `additionalProperties: true`, Sonnet
 * had to recover field names from description prose alone, which lets
 * common-API priors leak in (`targets` instead of `backends`, etc.). The
 * eval should mirror production discoverability, not handicap the model.
 *
 * Tools missing from TOOL_SCHEMAS fall back to an open-object schema so
 * the runner still works during incremental rollout — `missingSchemas`
 * is logged once at the call site so the gap is visible.
 */
function buildToolDecls(): { decls: ToolDecl[]; missingSchemas: string[] } {
  const missingSchemas: string[] = [];
  const decls = TOOL_NAMES.map((name) => {
    const zodSchema = TOOL_SCHEMAS[name];
    let input_schema: Record<string, unknown>;
    if (zodSchema) {
      // Cast the schema to the loose ZodTypeAny shape because zodToJsonSchema's
      // generic return type is recursive and trips ts2589 on deeply-typed
      // schemas. The JSON object we cast the result to is what we need anyway.
      const jsonSchema = zodToJsonSchema(zodSchema as unknown as Parameters<typeof zodToJsonSchema>[0], {
        $refStrategy: 'none',
        target: 'openApi3',
      }) as Record<string, unknown>;
      // Strip the $schema / definitions wrappers — Anthropic's tool format
      // expects a bare JSON Schema object, not a Draft-7 envelope.
      delete jsonSchema.$schema;
      delete jsonSchema.definitions;
      input_schema = jsonSchema;
    } else {
      missingSchemas.push(name);
      input_schema = { type: 'object', additionalProperties: true };
    }
    return {
      name,
      description: `Log10x MCP tool ${name}. Read input_schema.properties for the exact arg names and types.`,
      input_schema,
    };
  });
  return { decls, missingSchemas };
}

interface AnthropicLike {
  messages: {
    create(opts: {
      model: string;
      max_tokens: number;
      system?: string;
      tools: ToolDecl[];
      messages: Array<{
        role: 'user' | 'assistant';
        content:
          | string
          | Array<
              | { type: 'text'; text: string }
              | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
              | {
                  type: 'tool_result';
                  tool_use_id: string;
                  content: string;
                  is_error?: boolean;
                }
            >;
      }>;
    }): Promise<{
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      >;
      stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
    }>;
  };
}

// Mirrors the production MCP server's `instructions` (build/index.js) so
// autonomous mode tests under realistic guidance. Without these the
// agent has to re-discover canonical chain order from tool descriptions
// alone — caught when the safety-gate scenario inverted
// dependency_check / exclusion_filter order on a Sonnet 4.6 run.
const SYSTEM_PROMPT = `You are an SRE assistant for the Log10x observability platform.

You have access to log10x_* tools that hit a live customer environment.
Call tools to investigate; do NOT speculate. After each tool result
you'll see a NEXT_ACTIONS comment block at the bottom — these are
structured chain hints. Walk the chain when relevant; don't stall to
ask the user for permission to take an obvious next step.

CANONICAL TOOL CHAINS

  Incident triage from a pasted log line:
    log10x_event_lookup → log10x_investigate
    (or for a batch: log10x_resolve_batch → log10x_investigate)

  Cost investigation (always start with cost_drivers when the user
  frames the question as "the bill changed"):
    log10x_cost_drivers → log10x_dependency_check → log10x_exclusion_filter

  Mute / drop a pattern (ALWAYS run dependency_check FIRST as a safety
  gate — never call exclusion_filter without first checking what
  dashboards / alerts depend on the pattern):
    log10x_dependency_check → log10x_exclusion_filter

  Forensic retrieval beyond SIEM retention:
    log10x_event_lookup → log10x_retriever_query

  Install advisor:
    log10x_discover_env → log10x_advise_install

NUMBERS DISCIPLINE

When you write a final text reply, use ONLY numbers and pattern names
that appeared verbatim in tool results. Do not fabricate metrics. If a
number wasn't returned, say "not reported". Do NOT compute percentages
from before/after values — the tools emit deltas pre-computed.`;

export async function runAutonomous(
  scenario: Scenario,
  env: EvalEnv,
  transcript: TranscriptWriter,
  stepLog: StepLogWriter,
  modelOverride?: string
): Promise<AutonomousResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'runAutonomous requires ANTHROPIC_API_KEY env var (autonomous mode is gated).'
    );
  }
  transcript.writeUserPrompt(scenario.prompt);

  const client = new Anthropic() as unknown as AnthropicLike;
  const { decls: tools, missingSchemas } = buildToolDecls();
  if (missingSchemas.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[autonomous-runner] ${missingSchemas.length} tool(s) missing from TOOL_SCHEMAS — model will see additionalProperties:true fallback: ${missingSchemas.join(', ')}`
    );
  }
  const stepLogs: StepLog[] = [];
  const messages: Parameters<typeof client.messages.create>[0]['messages'] = [
    { role: 'user', content: scenario.prompt },
  ];

  let step = 0;
  let outcome: RunOutcome = 'inconclusive';
  let finalText = '';

  while (step < scenario.max_steps) {
    const resp = await client.messages.create({
      model: modelOverride || DEFAULT_MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    const assistantBlocks = resp.content;
    messages.push({ role: 'assistant', content: assistantBlocks });

    const toolUses = assistantBlocks.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        b.type === 'tool_use'
    );
    const textBlocks = assistantBlocks.filter(
      (b): b is { type: 'text'; text: string } => b.type === 'text'
    );

    // Mirror tool_use blocks into the harness JSONL transcript before
    // executing, so the order matches what the model emitted.
    for (const tu of toolUses) {
      transcript.writeToolUse(tu.id, tu.name, tu.input);
    }

    if (resp.stop_reason === 'end_turn' || toolUses.length === 0) {
      finalText = textBlocks.map((b) => b.text).join('\n');
      transcript.writeFinalAssistantText(finalText, 'end_turn');
      outcome = 'completed';
      break;
    }

    // Execute every tool_use, append tool_result blocks, loop.
    const toolResults: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }> = [];
    for (const tu of toolUses) {
      step++;
      const args = interpolateEnvVars(
        { ...(scenario.tool_arg_defaults ?? {}), ...tu.input },
        env
      ) as Record<string, unknown>;
      let result: { text: string; isError: boolean; durationMs: number };
      try {
        result = await invokeTool(tu.name, args, env);
      } catch (e) {
        result = {
          text: `Tool ${tu.name} not registered in eval harness: ${(e as Error).message}`,
          isError: true,
          durationMs: 0,
        };
        const entry: StepLog = {
          step,
          kind: 'unknown_tool',
          tool: tu.name,
          args,
          reason: result.text,
        };
        stepLog.write(entry);
        stepLogs.push(entry);
      }
      transcript.writeToolResult(tu.id, result.text, result.isError);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.text,
        is_error: result.isError,
      });
      const entry: StepLog = {
        step,
        kind: 'tool_call',
        tool: tu.name,
        args,
        durationMs: result.durationMs,
        isError: result.isError,
        resultBytes: result.text.length,
      };
      stepLog.write(entry);
      stepLogs.push(entry);

      if (result.isError && scenario.error_policy === 'stop') {
        outcome = 'tool_error';
        break;
      }
    }
    if (outcome === 'tool_error') break;
    messages.push({ role: 'user', content: toolResults });
  }

  if (step >= scenario.max_steps && outcome === 'inconclusive') {
    outcome = 'max_steps';
    transcript.writeFinalAssistantText(finalText, 'max_tokens');
  }

  stepLog.write({ step, kind: 'terminate', outcome, totalSteps: step });
  stepLogs.push({ step, kind: 'terminate', outcome, totalSteps: step });

  return { outcome, totalSteps: step, finalText, stepLogs };
}
