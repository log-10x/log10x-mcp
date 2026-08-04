/**
 * One answer to "will this tool actually run right now?".
 *
 * Two gates decide that, and both used to live where only `wrap()` in
 * index.ts could see them: the demo gate (a metric-requiring tool called
 * while the MCP is attached read-only to the public demo dataset) and the
 * mode gate (a tool the boot-time mode-detect did not register). Anything
 * that ROUTES a user to a tool — log10x_start's action_menu, a remediation
 * `actions[]` — had no way to ask, so it guessed, and the guesses drifted.
 *
 * The drift was measurable. On a keyless boot the banner says "attaching to
 * the public demo dataset", log10x_baseline returns real numbers off that
 * same dataset, and log10x_start emitted action_menu item `investigate_spike`
 * with `applicable: true` routing to log10x_top_patterns — which then refused
 * with `not_configured (metrics_backend)`. The menu offered a door the gate
 * was holding shut.
 *
 * So the gates move here and both callers read the same function. The gate
 * behaviour is unchanged: this module is where it is asked, not a new policy.
 */

import { shouldRegisterTool, type ModeResolution } from './mode-detect.js';
import type { Environments } from './environments.js';

/**
 * Tools that query the metrics backend (top_patterns, whats_changing,
 * etc.). When the MCP is in pure-demo mode (no user configuration,
 * silently landed on the demo backend), these tools short-circuit
 * with a structured `not_configured` response instead of returning
 * demo data the user didn't ask for. We surface the conversation
 * starter without breaking the demo-mode walkthrough; the silent-demo
 * path will be removed in a later release.
 *
 * Tools NOT in this set bypass the gate: configure_env (the
 * onboarding tool itself), doctor (status reporting works in any
 * mode), local-only tools (resolve_batch, extract_templates,
 * dependency_check pasted input), signin_* (log10x account
 * management), discover_env (k8s discovery), poc_from_* (pre-config
 * sample reports).
 */
export const METRIC_REQUIRING_TOOLS: ReadonlySet<string> = new Set([
  'log10x_top_patterns',
  'log10x_pattern_trend',
  'log10x_pattern_examples',
  'log10x_event_lookup',
  'log10x_savings',
  'log10x_services',
  'log10x_overflow_contents',
  'log10x_discover_labels',
  'log10x_investigate',
  'log10x_backfill_metric',
  'log10x_metric_overlay',
  'log10x_metrics_that_moved',
  'log10x_rank_by_shape_similarity',
  'log10x_discover_join',
  'log10x_customer_metrics_query',
  'log10x_retriever_query',
  'log10x_retriever_series',
]);

/**
 * When set, the MCP is an intentional read-only demo playground: the metric
 * tools serve the public demo data instead of the not_configured onboarding
 * nag. isDemoMode stays true, so the demo banner still renders — we just stop
 * nagging. Set by the hosted deployment.
 *
 * Read per call rather than captured at import: the hosted deployment sets it
 * before boot, but tests flip it between cases and a module-load snapshot
 * would freeze the first value they happened to load under.
 */
export function demoPlaygroundEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.LOG10X_MCP_DEMO_PLAYGROUND ?? '');
}

/**
 * The demo gate. True when this tool will short-circuit with the
 * `not_configured` envelope instead of querying: a metric-requiring tool,
 * pure-demo state (nothing configured, silently landed on the demo backend),
 * and not an intentional playground.
 *
 * `demoFallbackReason` being set is a DIFFERENT state — the user tried to
 * configure and their credentials failed — which gets its own loud banner and
 * does not take this path.
 */
export function isDemoGated(toolName: string, envs: Environments | undefined): boolean {
  return (
    METRIC_REQUIRING_TOOLS.has(toolName) &&
    !!envs &&
    envs.isDemoMode &&
    !envs.demoFallbackReason &&
    !demoPlaygroundEnabled()
  );
}

/**
 * The boot mode, recorded once by index.ts so callers outside it can consult
 * the mode gate without importing index.ts (which imports every tool, so the
 * dependency would be a cycle). Undefined before boot completes and in unit
 * tests that never boot a server; every reader treats that as "no mode gate
 * to apply", which is what index.ts's own `bootMode && ...` guard does.
 */
let recordedBootMode: ModeResolution | undefined;

/**
 * The SAME Environments object `wrap()` gates on, supplied by index.ts.
 *
 * A caller must not re-derive this with its own `loadEnvironments()`. index.ts
 * loads envs BEFORE mode-detect runs, and on a keyless boot mode-detect then
 * injects the public demo key into process.env — so a later loadEnvironments()
 * sees a configured API key and reports isDemoMode: false, while the envs the
 * gate actually consults still say true. log10x_start re-derived exactly that
 * way, which is why its menu believed a tool was callable that wrap() then
 * refused. One reference, one answer.
 */
let envsProvider: (() => Environments | undefined) | undefined;

export function recordEnvsProvider(provider: () => Environments | undefined): void {
  envsProvider = provider;
}

function currentEnvs(): Environments | undefined {
  if (!envsProvider) return undefined;
  try {
    return envsProvider();
  } catch {
    // getEnvs() throws before initEnvs() completes. No envs means no demo gate,
    // which is what wrap()'s own `envs &&` guard concludes at that point too.
    return undefined;
  }
}

export function recordBootMode(mode: ModeResolution | undefined): void {
  recordedBootMode = mode;
}

export function peekBootMode(): ModeResolution | undefined {
  return recordedBootMode;
}

/** True when the boot-time mode-detect did not register this tool. */
export function isOutOfMode(toolName: string): boolean {
  if (!recordedBootMode) return false;
  return !shouldRegisterTool(toolName, recordedBootMode.mode, {
    demoFallback: recordedBootMode.demoFallback,
  });
}

/**
 * Why calling `toolName` right now would not do the job, or null when it
 * would. The string is user-facing: it goes straight into an action_menu
 * item's `gated_reason`, so it names a tool that IS callable in this state
 * rather than the one the gate just refused.
 *
 * Argument validation is deliberately out of scope. A tool that needs a
 * `service` or a `from` timestamp is not refusing the user — the agent
 * supplies those from the conversation.
 */
export function toolUnavailableReason(
  toolName: string,
  envs?: Environments | undefined,
): string | null {
  const effective = envs ?? currentEnvs();
  if (isDemoGated(toolName, effective)) {
    return (
      `Attached read-only to the public 10x demo dataset, where ${toolName} is gated and ` +
      `returns a not-configured envelope rather than your data. Call log10x_signin_start ` +
      `to connect your own environment, then pick this again.`
    );
  }
  if (isOutOfMode(toolName)) {
    return (
      `${toolName} is not registered in "${recordedBootMode?.mode}" boot mode. ` +
      `Call log10x_doctor to see what this boot resolved and why.`
    );
  }
  return null;
}
