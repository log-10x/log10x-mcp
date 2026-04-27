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

/**
 * Serialize a list of next-action hints into a single-line HTML comment.
 * Returns '' when the list is empty.
 */
export function renderNextActions(actions: NextAction[]): string {
  if (!actions || actions.length === 0) return '';
  // Single-line JSON; newlines inside would break the HTML-comment guard.
  return `${OPEN}${JSON.stringify(actions)}${CLOSE}`;
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
