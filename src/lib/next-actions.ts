/**
 * Structured next-action hints.
 *
 * Tools render human-readable "Next actions:" sections in their markdown
 * output. To let programmatic callers (agents, harnesses, sub-models)
 * chain tools deterministically without regex-parsing markdown, tools
 * can append a machine-parseable block to the END of their output via
 * `renderNextActions()`.
 *
 * The block format is a single-line HTML comment so it renders as empty
 * in humane markdown but is trivially extractable with
 * `extractNextActions(response)`.
 *
 * Convention: place the block as the LAST line of the response.
 */

export interface NextAction {
  /** MCP tool name, e.g. 'log10x_investigate' */
  tool: string;
  /** Args to pass to the tool, pre-validated to match the tool's schema. */
  args: Record<string, unknown>;
  /** One-line rationale for why this is the recommended next call. */
  reason: string;
}

const OPEN = '<!-- NEXT_ACTIONS:';
const CLOSE = '-->';
const PRESENT_OPEN = '<!-- NEXT_STEPS_FOR_USER:';

/**
 * Serialize next-action hints. Emits TWO HTML-comment blocks (both
 * invisible to humans, so the clean-output / Gate-6 invariant holds):
 *
 *  1. NEXT_STEPS_FOR_USER — a presentation directive + the plain
 *     rationale of each action. The agent MUST render this to the user
 *     as a short numbered "What you can do next" list, phrased as
 *     things THEY can ask for, in plain language, never tool names or
 *     "call log10x_X". A user does not know what is possible next
 *     unless the agent surfaces it; this makes that consistent across
 *     every tool that emits next-actions, without polluting the
 *     human-visible tool text.
 *  2. NEXT_ACTIONS — the machine-parseable JSON, kept as the LAST
 *     token so extractNextActions() / chain-walkers are unchanged.
 *
 * Returns '' when the list is empty.
 */
export function renderNextActions(actions: NextAction[]): string {
  if (!actions || actions.length === 0) return '';
  const items = actions
    .map((a, i) => `${i + 1}) ${a.reason}`)
    .join('  ');
  const present =
    `${PRESENT_OPEN} Surface these to the user as a short numbered list ` +
    `titled "What you can do next". Rephrase each as a plain-language ` +
    `action the user can ask for (e.g. "ask me to generate a ` +
    `forwarder/SIEM drop filter for X"), NOT a tool name and NOT ` +
    `"call log10x_*". Keep to one line each. Items: ${items} ${CLOSE}`;
  // Single-line JSON; newlines inside would break the HTML-comment guard.
  return `${present}\n${OPEN}${JSON.stringify(actions)}${CLOSE}`;
}

/**
 * Extract the structured next-actions block from a tool response string.
 * Returns [] when no block is present or parsing fails.
 *
 * Callers should use this instead of regex-matching the markdown "Next
 * actions:" section — that format is for human consumption and may change.
 */
export function extractNextActions(response: string): NextAction[] {
  const start = response.lastIndexOf(OPEN);
  if (start === -1) return [];
  const end = response.indexOf(CLOSE, start);
  if (end === -1) return [];
  const json = response.slice(start + OPEN.length, end).trim();
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is NextAction =>
        typeof a === 'object' && a !== null && typeof a.tool === 'string' && typeof a.args === 'object',
    );
  } catch {
    return [];
  }
}
