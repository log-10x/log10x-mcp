/**
 * Autonomous runner — drives a model's tool-use loop and lets the model
 * decide which tools to call. Tool discovery + execution go through a
 * ToolHarness so the runner is transport-agnostic:
 *
 *   - InProcessToolHarness (default): calls build/tools/*.js directly
 *     via tool-registry.ts. Fast, no subprocess, but skips the MCP wire
 *     format.
 *   - StdioMcpHarness: spawns build/index.js and talks over stdio +
 *     JSON-RPC via @modelcontextprotocol/sdk. Mirrors what Claude
 *     Desktop / Cursor / Cline actually do. Catches schema drift and
 *     wire-format bugs.
 *
 * The runner emits the same JSONL transcript shape regardless of
 * transport, so judge / sequence-diff / autonomy code is mode-agnostic.
 */
import type { Scenario, RunOutcome, StepLog } from './types.js';
import { interpolateEnvVars, type EvalEnv } from './env.js';
import type { TranscriptWriter, StepLogWriter } from './transcript-writer.js';
import {
  selectAgentClient,
  type AgentContentBlock,
  type AgentMessage,
  type AgentToolResultBlock,
  type AgentToolUseBlock,
  type AgentTextBlock,
} from './agent-clients.js';
import type { ToolHarness } from './tool-harness.js';

export interface AutonomousResult {
  outcome: RunOutcome;
  totalSteps: number;
  finalText: string;
  stepLogs: StepLog[];
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
  harness: ToolHarness,
  modelOverride?: string
): Promise<AutonomousResult> {
  // Vendor key checks are owned by each AgentClient's constructor —
  // selectAgentClient throws a vendor-specific error if the right env
  // var is missing.
  transcript.writeUserPrompt(scenario.prompt);

  const client = selectAgentClient(modelOverride);
  const { tools, missingSchemas } = await harness.listTools();
  if (missingSchemas.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[autonomous-runner] ${missingSchemas.length} tool(s) without Zod schemas — model will see additionalProperties:true fallback: ${missingSchemas.join(', ')}`
    );
  }
  const stepLogs: StepLog[] = [];
  const messages: AgentMessage[] = [
    { role: 'user', content: scenario.prompt },
  ];

  let step = 0;
  let outcome: RunOutcome = 'inconclusive';
  let finalText = '';

  while (step < scenario.max_steps) {
    const resp = await client.call({
      system: SYSTEM_PROMPT,
      tools,
      messages,
      maxTokens: 4000,
    });

    const assistantBlocks = resp.content;
    messages.push({ role: 'assistant', content: assistantBlocks as AgentContentBlock[] });

    const toolUses = assistantBlocks.filter(
      (b): b is AgentToolUseBlock => b.type === 'tool_use'
    );
    const textBlocks = assistantBlocks.filter(
      (b): b is AgentTextBlock => b.type === 'text'
    );

    // Mirror tool_use blocks into the harness JSONL transcript before
    // executing, so the order matches what the model emitted.
    for (const tu of toolUses) {
      transcript.writeToolUse(tu.id, tu.name, tu.input);
    }

    if (resp.stopReason === 'end_turn' || toolUses.length === 0) {
      finalText = textBlocks.map((b) => b.text).join('\n');
      transcript.writeFinalAssistantText(finalText, 'end_turn');
      outcome = 'completed';
      break;
    }

    // Execute every tool_use, append tool_result blocks, loop. The
    // ToolHarness owns transport-specific failure shaping; we just
    // mark unknown-tool failures so the stepLog records them as such.
    const toolResults: AgentToolResultBlock[] = [];
    for (const tu of toolUses) {
      step++;
      const args = interpolateEnvVars(
        { ...(scenario.tool_arg_defaults ?? {}), ...tu.input },
        env
      ) as Record<string, unknown>;
      const result = await harness.invoke(tu.name, args);
      if (result.isError && /not registered|MCP callTool/.test(result.text)) {
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
