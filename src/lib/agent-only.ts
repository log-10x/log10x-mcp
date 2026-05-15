/**
 * Agent-facing prose helper.
 *
 * Background — the MCP "audience separation" problem:
 *
 * MCP tools return one markdown blob. That blob has two readers: the
 * end-user (who reads the rendered prose) and the agent / driver / LLM
 * (which consumes the same text + chains follow-up tool calls). The
 * protocol has NO standard way to separate the two.
 *
 * Without a convention, tools end up mixing:
 *   - "**Next actions**: call log10x_cost_drivers({…})"
 *   - "⚠ do not re-label as cost drivers"
 *   - "Do not speculate about event content"
 * …into the visible user output. Users see directives meant for the
 * agent ("call log10x_X", "do not Y"). Agents miss them when they
 * dump raw output to users.
 *
 * Our convention:
 *   - Visible markdown is for the user.
 *   - Anything that says "do not X" / "call log10x_Y" / "for growth use Z"
 *     is wrapped in `<!-- agent-only: ... -->` HTML comments via
 *     `agentOnly()`.
 *   - HTML comments don't render in markdown clients, so users see
 *     clean prose. Agents read the raw text and pick up the guidance
 *     from the comment payload.
 *   - The system prompt for agents (system-prompt-addendum.md) tells
 *     them: "Do not pass `<!-- agent-only: ... -->` content verbatim to
 *     the user. It is tool→agent communication."
 *
 * The pre-existing `<!-- NEXT_ACTIONS:[...] -->` structured-JSON block
 * (in `next-actions.ts`) follows the same shape but holds programmatic
 * tool-chain hints. `agent-only` is for free-prose guidance.
 */

const OPEN = '<!-- agent-only:';
const CLOSE = '-->';

/**
 * Wrap a string in an HTML comment marked as agent-only. Returns a
 * single-line comment safe to splice into any markdown output.
 *
 * Use for:
 *   - Behavioral constraints ("don't re-label this as growth")
 *   - Tool-chain hints in prose form ("call log10x_investigate to drill")
 *   - "Do not speculate" / "Do not relay" warnings
 *
 * Do NOT use for:
 *   - Facts the user should see (volume, costs, % shares, severity tags)
 *   - The factual half of caveats that double as user info, e.g.,
 *     "Current rank by cost, not week-over-week growth" — that's still
 *     valuable for the human reading the report.
 */
export function agentOnly(content: string): string {
  // Normalize whitespace to keep it on one line (a multi-line HTML
  // comment is valid but agents-parsing-by-regex can stumble).
  // Escape any embedded `-->` so we don't truncate the comment.
  const safe = content.replace(/\s+/g, ' ').replace(/-->/g, '--&gt;').trim();
  return `${OPEN} ${safe} ${CLOSE}`;
}

/**
 * Strip every `<!-- agent-only: ... -->` block from a string. The
 * counterpart to `agentOnly()` — agents call this before relaying a
 * tool response to the user.
 *
 * Also strips the structured `<!-- NEXT_ACTIONS:[...] -->` block, since
 * that's likewise agent-only (programmatic chain hints).
 */
export function stripAgentOnly(text: string): string {
  return text
    .replace(/<!-- agent-only:[\s\S]*?-->/g, '')
    .replace(/<!-- NEXT_ACTIONS:[\s\S]*?-->/g, '')
    // Collapse the blank lines that result from removing block-level comments.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
