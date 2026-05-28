/**
 * Deterministic runner — in-process simulator of an autonomous chain.
 *
 * Seeds the queue with `scenario.initial_tool`, then BFS-expands by
 * extracting NEXT_ACTIONS hints from each tool's response. Cycle
 * detection is on `tool + JSON(args)` so the same call never runs twice.
 *
 * Why this exists: lets us regression-test the *chain shape* (every tool
 * emits the right hints, every hint args validates against the receiving
 * tool's schema) without burning Anthropic tokens. CI runs the full
 * suite in <3 min on demo env.
 *
 * What it does NOT test: the LLM's tool-selection decisions. That's the
 * autonomous-runner's job.
 */
import type { Scenario, StepLog, RunOutcome } from './types.js';
import { interpolateEnvVars, type EvalEnv } from './env.js';
import { invokeTool, UnknownToolError } from './tool-registry.js';
import { extractNextActions } from '../../build/lib/next-actions.js';
import type { TranscriptWriter, StepLogWriter } from './transcript-writer.js';

export interface DeterministicResult {
  outcome: RunOutcome;
  totalSteps: number;
  finalText: string;
  stepLogs: StepLog[];
}

interface NextAction {
  tool: string;
  args: Record<string, unknown>;
  reason?: string;
}

/**
 * Extract chain hints from a tool result. Two paths:
 *
 *   1. HTML-comment `<!-- NEXT_ACTIONS: ... -->` block at the end of a
 *      markdown response. Used by tools that emit markdown bodies
 *      (pattern_mitigate, configure_compact, etc.) via renderNextActions().
 *   2. Structured envelope's `actions: [...]` field. Used by tools that
 *      return a StructuredOutput envelope (discover_env, advise_install,
 *      top_patterns, etc.) via buildEnvelope().
 *
 * The HTML-comment path runs first to preserve backwards-compatible
 * behavior; the JSON envelope path is a fallback so envelope-based tools
 * can chain through the deterministic runner without burning tokens.
 */
function extractActionsFromResult(text: string): NextAction[] {
  const fromComment = extractNextActions(text) as NextAction[];
  if (fromComment.length > 0) return fromComment;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const actions = (parsed as { actions?: unknown }).actions;
      if (Array.isArray(actions)) {
        return actions.filter(
          (a): a is NextAction =>
            !!a &&
            typeof a === 'object' &&
            typeof (a as { tool?: unknown }).tool === 'string' &&
            typeof (a as { args?: unknown }).args === 'object' &&
            (a as { args: unknown }).args !== null
        );
      }
    }
  } catch {
    // Not JSON — that's fine, just means there's no envelope and no hints.
  }
  return [];
}

export async function runDeterministic(
  scenario: Scenario,
  env: EvalEnv,
  transcript: TranscriptWriter,
  stepLog: StepLogWriter
): Promise<DeterministicResult> {
  transcript.writeUserPrompt(scenario.prompt);

  const queue: NextAction[] = [
    {
      tool: scenario.initial_tool.tool,
      args: scenario.initial_tool.args,
      reason: scenario.initial_tool.reason,
    },
  ];
  const seen = new Set<string>();
  const stepLogs: StepLog[] = [];

  let step = 0;
  let outcome: RunOutcome = 'inconclusive';
  let lastText = '';

  while (queue.length > 0 && step < scenario.max_steps) {
    const action = queue.shift()!;

    // Apply tool_arg_defaults + env-var interpolation. Defaults are
    // shallow-merged so per-call args win.
    const merged: Record<string, unknown> = {
      ...(scenario.tool_arg_defaults ?? {}),
      ...action.args,
    };
    const args = interpolateEnvVars(merged, env) as Record<string, unknown>;

    const cycleKey = `${action.tool}|${stableStringify(args)}`;
    if (seen.has(cycleKey)) {
      const entry: StepLog = {
        step: step + 1,
        kind: 'cycle_skipped',
        tool: action.tool,
        args,
        reason: 'cycle: same tool+args already invoked',
      };
      stepLog.write(entry);
      stepLogs.push(entry);
      continue;
    }
    seen.add(cycleKey);
    step++;

    const useId = `det-${step}-${action.tool}`;
    transcript.writeToolUse(useId, action.tool, args);

    let result: { text: string; isError: boolean; durationMs: number };
    try {
      result = await invokeTool(action.tool, args, env);
    } catch (e) {
      if (e instanceof UnknownToolError) {
        const entry: StepLog = {
          step,
          kind: 'unknown_tool',
          tool: action.tool,
          args,
          reason: e.message,
        };
        stepLog.write(entry);
        stepLogs.push(entry);
        outcome = 'unknown_tool';
        if (scenario.error_policy === 'stop') break;
        continue;
      }
      throw e;
    }

    transcript.writeToolResult(useId, result.text, result.isError);
    lastText = result.text;

    const hints = extractActionsFromResult(result.text);
    const entry: StepLog = {
      step,
      kind: 'tool_call',
      tool: action.tool,
      args,
      durationMs: result.durationMs,
      isError: result.isError,
      resultBytes: result.text.length,
      nextActionsFound: hints.length,
      reason: action.reason,
    };
    stepLog.write(entry);
    stepLogs.push(entry);

    if (result.isError && scenario.error_policy === 'stop') {
      outcome = 'tool_error';
      break;
    }

    // BFS-enqueue novel hints.
    for (const hint of hints) {
      const hintArgs = (hint.args ?? {}) as Record<string, unknown>;
      const k = `${hint.tool}|${stableStringify({
        ...(scenario.tool_arg_defaults ?? {}),
        ...hintArgs,
      })}`;
      if (!seen.has(k)) {
        queue.push({ tool: hint.tool, args: hintArgs, reason: hint.reason });
      }
    }
  }

  if (step >= scenario.max_steps && outcome === 'inconclusive') {
    outcome = 'max_steps';
  } else if (queue.length === 0 && outcome === 'inconclusive') {
    outcome = 'completed';
  }

  // Synthesize a final assistant text. Deterministic mode has no LLM,
  // so the "final text" is the last tool's response — the judge / final-text
  // ground-truth assertions interpret it as the agent's terminal output.
  transcript.writeFinalAssistantText(lastText, 'end_turn');

  const terminate: StepLog = {
    step,
    kind: 'terminate',
    outcome,
    totalSteps: step,
  };
  stepLog.write(terminate);
  stepLogs.push(terminate);

  return { outcome, totalSteps: step, finalText: lastText, stepLogs };
}

/**
 * Stable stringify for cycle keys — so {a:1,b:2} and {b:2,a:1} hash to
 * the same string. We do not handle non-JSON values (functions etc.) —
 * tool args are JSON-serializable by construction.
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}
