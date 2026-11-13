/**
 * The tools this server actually registered, after mode and operator gates.
 *
 * The hosted demo registers 36 of the server's tools. Tool descriptions, the
 * server instructions and many envelopes' `actions[]` name tools by their
 * full catalogue, so an agent on a gated server was routed to tools it could
 * not call: every cost tool's description began "call log10x_start first",
 * and log10x_start is not on the demo (2026-11-13). Callers ask this registry
 * before naming a tool to the agent.
 *
 * Unset (null) means "not known yet": every tool counts as exposed, so code
 * paths that run before registration (tests, stdio boot) behave as before.
 */
let exposed: Set<string> | null = null;

export function setExposedTools(names: Iterable<string>): void {
  exposed = new Set(names);
}

export function isToolExposed(name: string): boolean {
  return exposed === null ? true : exposed.has(name);
}

/** Test seam. */
export function resetExposedToolsForTest(): void {
  exposed = null;
}

/**
 * Drop the leading "[FRESH-SESSION ROUTING: ... log10x_start ...]" block a
 * description carries when log10x_start is not exposed.
 */
export function stripStartRouting(description: string): string {
  if (isToolExposed('log10x_start')) return description;
  return description.replace(/^\s*\[FRESH-SESSION ROUTING:[^\]]*\]\s*/, '');
}

/** Keep only the actions whose tool is exposed. Actions without a tool are kept. */
export function filterExposedActions<T extends { tool?: unknown }>(actions: T[] | undefined): T[] | undefined {
  if (!Array.isArray(actions)) return actions;
  return actions.filter((a) => typeof a.tool !== 'string' || isToolExposed(a.tool));
}
