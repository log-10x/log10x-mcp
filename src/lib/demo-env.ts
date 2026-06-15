/**
 * Public demo environment — the keyless fallback.
 *
 * When the MCP boots with no API key and no metrics backend, it attaches
 * READ-ONLY to the public 10x demo dataset instead of falling to POC mode.
 * This makes the keyless `npx -y log10x-mcp` first-run land on the same
 * orientation (log10x_start) and the same data as the website's live demo,
 * so the marketing promise ("demo mode, on the same dataset as the console")
 * is literally true.
 *
 * These credentials are PUBLIC read credentials: the same key/env ship in
 * the website's client-side config (console config.js) and authenticate the
 * hosted demo. Baking them here adds no exposure beyond what any visitor's
 * browser already holds. Mutating/account tools are denylisted in this mode
 * (see DEMO_FALLBACK_DENYLIST) so an agent cannot reconfigure the shared
 * demo account; sign-in tools stay registered as the upgrade path.
 *
 * Escape hatch: LOG10X_DEMO_FALLBACK=off boots straight to POC mode.
 */

export const DEMO_ENV = {
  apiKey: '4d985100-ee4a-4b6c-b784-a416b8684868',
  envId: '6aa99191-f827-4579-a96a-c0ebdfe73884',
  metricsUrl: 'https://prometheus.log10x.com',
  metricsType: 'log10x',
} as const;

/** Env-var marker tools can read to know the demo fallback is active. */
export const DEMO_FALLBACK_FLAG = 'LOG10X_DEMO_FALLBACK_ACTIVE';

/**
 * Apply the demo env to process.env so BOTH layers resolve coherently:
 * backend detection (resolveBackend) and per-tool env resolution
 * (loadEnvironments) read the same variables the bridge/console use.
 */
export function applyDemoEnv(): void {
  process.env.LOG10X_API_KEY = DEMO_ENV.apiKey;
  process.env.LOG10X_CUSTOMER_METRICS_URL = DEMO_ENV.metricsUrl;
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = DEMO_ENV.metricsType;
  process.env.LOG10X_CUSTOMER_METRICS_AUTH = `${DEMO_ENV.apiKey}/${DEMO_ENV.envId}`;
  process.env[DEMO_FALLBACK_FLAG] = '1';
}

export function isDemoFallbackActive(): boolean {
  return process.env[DEMO_FALLBACK_FLAG] === '1';
}

/**
 * Tools that must NOT register against the shared public demo account.
 * UX guardrail, not a security boundary (the key is public either way):
 * an agent in demo mode should never mutate account/env/engine state that
 * every other demo visitor shares. Sign-in, discovery, analysis, and the
 * install advisors (paste-ready commands for the user's OWN stack) stay.
 */
export const DEMO_FALLBACK_DENYLIST: ReadonlySet<string> = new Set([
  'log10x_update_settings',
  'log10x_rotate_api_key',
  'log10x_create_env',
  'log10x_update_env',
  'log10x_delete_env',
  'log10x_env_register',
  'log10x_configure_env',
  'log10x_set_gitops_repo',
  'log10x_dest_set',
  'log10x_offload_add',
  'log10x_offload_archive',
  'log10x_retriever_register',
  'log10x_configure_engine',
  'log10x_setup_recurring',
  'log10x_backfill_metric',
]);
