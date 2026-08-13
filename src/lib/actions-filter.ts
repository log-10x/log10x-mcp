/**
 * actions-filter — mode-aware filter for actions[] arrays.
 *
 * The chassis builder calls this before returning every envelope. It
 * drops any action whose `tool` field is not registered in the current
 * boot mode, and optionally emits a warning into warnings[] so the gap
 * is auditable even when invisible to the agent.
 *
 * WHY THIS EXISTS
 *
 * discover_env (and other tools that build actions[] inline) do not
 * have access to the boot-time mode at envelope construction time.
 * Without filtering, a session can be handed a breadcrumb like
 *   { tool: 'log10x_advise_retriever', ... }
 * for a tool that is not registered in its mode, so following the
 * breadcrumb returns an out-of-mode error. Filtering at envelope
 * construction turns any such mis-gating into a warning in warnings[]
 * rather than a confusing "tool not found" for an agent that faithfully
 * followed the chain.
 *
 * RULE
 *
 * actions[] entries MUST reference tools registered in the current mode.
 * The chassis builder filters them automatically; bypass at your own risk.
 *
 * EDGE CASES
 *
 *   - mode is null (boot incomplete): pass everything through.
 *     Defensive default — a missing mode is a boot-race, not a
 *     mis-gated tool; let the caller surface the real error.
 *
 *   - tool name not in TOOL_MODES (unknown tool): shouldRegisterTool
 *     registers unknown tools in analysis + analysis_pending as a safety
 *     net, and this filter honours that behaviour.
 */

import { shouldRegisterTool, type Mode } from './mode-detect.js';

/**
 * Filter an actions[] array to only include entries whose `tool` is
 * registered in the given mode. Returns a new array (never mutates).
 *
 * When `mode` is null (boot race / forced test environment), the
 * original array is returned unmodified.
 *
 * @param actions   Any array whose elements have a `tool: string` field.
 * @param mode      The current boot mode, or null if unknown.
 * @param warnings  Optional mutable array to collect warning strings.
 *                  When provided, a warning is appended for each dropped
 *                  action so the gap is auditable in the envelope's
 *                  warnings[] field.
 * @returns         Filtered copy of `actions`.
 */
export function filterActionsByActiveMode<A extends { tool: string }>(
  actions: A[],
  mode: Mode | null,
  warnings?: string[],
): A[] {
  if (!mode) {
    // Boot race or test override — pass through to avoid hiding real errors.
    return actions;
  }

  const kept: A[] = [];
  for (const action of actions) {
    if (shouldRegisterTool(action.tool, mode)) {
      kept.push(action);
    } else {
      if (warnings) {
        warnings.push(
          `Suggested ${action.tool} in actions[] but it is not registered in ${mode} mode — entry dropped.`,
        );
      }
    }
  }
  return kept;
}
