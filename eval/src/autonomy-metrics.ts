/**
 * Deterministic autonomy scoring (no LLM).
 *
 * Three signals:
 *   1. step ratio (how close to optimal_steps)
 *   2. stalled-final-text detection ("would you like me to ...")
 *   3. abandoned NEXT_ACTIONS (tools emitted hints the agent ignored)
 *
 * Score = base_steps * stall_penalty - abandoned_penalty, clamped 0..1.
 *
 * The deterministic mode is the BFS simulator (so abandoned hints =
 * cycles or hints filtered by error_policy); the autonomous mode is
 * Anthropic-driven, where abandoned = the model decided to stop early.
 * Both feed the same metric, which keeps the autonomy axis comparable
 * across modes.
 */
import type { AutonomyMetrics } from './types.js';
import type { ParsedTranscript } from './transcript-parser.js';

const STALL_PATTERNS: RegExp[] = [
  /\bwould you like me to\b/i,
  /\bshall i\b/i,
  /\blet me know if you('?re| are) ready\b/i,
  /\bwhat would you like (me )?to (do|investigate|check) next\b/i,
  /\bdo you want me to\b/i,
  /\bi can (also )?do that next if you('?d| would) like\b/i,
];

export function detectStall(finalText: string): boolean {
  return STALL_PATTERNS.some((re) => re.test(finalText));
}

/**
 * Count NEXT_ACTIONS hints emitted by tool results that the agent did
 * not subsequently follow. "Follow" means: the hinted tool name shows
 * up SOMEWHERE in the agent's tool-call sequence after this result.
 *
 * Crucial nuance: each tool name is counted at most once per scenario.
 * Without this dedup, a chain that emits the same hint multiple times
 * (e.g., cost_drivers and savings both hint top_patterns, the agent
 * runs top_patterns once) gets penalized for "abandoning" the second
 * mention even though the agent did exactly the right thing.
 *
 * The metric is a directional signal — "agent ignored offered chain
 * options" — not a strict bookkeeping check.
 */
export function countAbandonedNextActions(parsed: ParsedTranscript): number {
  // Index from each tool_result's tool_use_id to the position of the
  // *call* in parsed.toolCalls (i.e., chronological order).
  const callIdxById = new Map<string, number>();
  parsed.toolCalls.forEach((c, i) => callIdxById.set(c.id, i));

  // For each tool name, the set of call indices where it was invoked.
  const callIdxByName = new Map<string, number[]>();
  parsed.toolCalls.forEach((c, i) => {
    const list = callIdxByName.get(c.name) ?? [];
    list.push(i);
    callIdxByName.set(c.name, list);
  });

  let abandoned = 0;
  const seenHints = new Set<string>();

  for (const r of parsed.toolResults) {
    const fromCallIdx = callIdxById.get(r.tool_use_id);
    if (fromCallIdx === undefined) continue;
    const hints = extractNextActionHints(r.text);
    for (const hint of hints) {
      // Dedup: if a tool name was already hinted at and walked, don't
      // re-penalize a duplicate hint emitted by another tool later.
      if (seenHints.has(hint)) continue;
      const callIdxs = callIdxByName.get(hint) ?? [];
      const followed = callIdxs.some((idx) => idx > fromCallIdx);
      if (followed) {
        seenHints.add(hint);
      } else {
        abandoned++;
      }
    }
  }
  return abandoned;
}

/**
 * Pulled-down copy of next-actions hint extraction — we don't need the
 * full structure (reason / args), just the tool name.
 *
 * Format emitted by tools: `<!-- NEXT_ACTIONS: [...] -->` block at the
 * end. See log10x-mcp/src/lib/next-actions.ts for the canonical format.
 */
export function extractNextActionHints(text: string): string[] {
  const m = text.match(/<!--\s*NEXT_ACTIONS:\s*([\s\S]*?)\s*-->/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((a) => (typeof a === 'object' && a && 'tool' in a ? String(a.tool) : null))
      .filter((s): s is string => !!s);
  } catch {
    return [];
  }
}

export function computeAutonomy(
  parsed: ParsedTranscript,
  optimalSteps: number,
  toolCallCount: number
): AutonomyMetrics {
  const stalled = detectStall(parsed.finalText);
  const abandoned = countAbandonedNextActions(parsed);

  // Step ratio: 1.0 if at-or-under optimal; degrades gradually as the
  // agent walks beyond. Be lenient — a chain that walks 2× optimal
  // because BFS-emitted hints fan wide is still autonomous; the agent
  // is following hints, not stalling. The stronger autonomy signal is
  // "did the agent stop short and ask the user?" (stall detection).
  let stepBase: number;
  if (toolCallCount === 0) stepBase = 0;
  else if (toolCallCount <= optimalSteps) stepBase = 1;
  else if (toolCallCount <= optimalSteps * 2) stepBase = 0.85;
  else {
    const overshoot = toolCallCount - optimalSteps * 2;
    stepBase = Math.max(0.4, 0.85 - 0.05 * overshoot);
  }

  const stallPenalty = stalled ? 0.5 : 1;
  // Cap abandoned penalty so wide-fan chains aren't over-penalized.
  const abandonedPenalty = Math.min(0.3, abandoned * 0.05);

  const score = Math.max(0, Math.min(1, stepBase * stallPenalty - abandonedPenalty));

  return {
    toolCallCount,
    optimalSteps,
    stalled,
    abandonedNextActions: abandoned,
    score,
  };
}
