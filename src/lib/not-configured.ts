/**
 * Conversational "not configured" response — every metric tool calls
 * this when the MCP has no real env configured for the call. Returns
 * a structured markdown message that names the supported backend
 * kinds, lists what info each needs, and tells the agent to drive the
 * user through `log10x_configure_env`.
 *
 * The MCP doesn't ask the user directly — agents do, by reading this
 * response and turning it into a conversation. Same pattern
 * `signin_start` already uses for the log10x backend's Auth0 device
 * flow.
 *
 * Phase 5b: surface when `envs.isDemoMode && !envs.demoFallbackReason`
 * (pure-demo state means nothing was configured and we silently
 * landed on the demo backend). Phase 7 makes the unconfigured state
 * explicit — no more silent demo.
 */

import type { Environments } from './environments.js';

export interface NotConfiguredOptions {
  /** The tool that's reporting the not-configured state, for context. */
  callingTool: string;
}

/**
 * Build the structured `not_configured` response. Returns a markdown
 * string that the calling tool returns directly.
 */
export function renderNotConfigured(opts: NotConfiguredOptions): string {
  const { callingTool } = opts;
  return [
    `# Metrics backend not configured`,
    '',
    `The MCP has no metrics backend configured for this session — \`${callingTool}\` cannot query metrics until one is set up.`,
    '',
    `**To set up**: ask the user where their 10x engine ships metrics, then call \`log10x_configure_env\` with the corresponding \`metricsBackend\` config. Supported backend kinds:`,
    '',
    `- \`log10x\` — the hosted Log10x metrics backend at \`prometheus.log10x.com\`. Needs: \`apiKey\`, \`envId\`. Use when the customer is comfortable with their telemetry going to the Log10x SaaS endpoint.`,
    `- \`prometheus\` — any self-hosted Prometheus instance. Needs: \`url\`, \`auth\` (\`{ type: 'none' | 'bearer' | 'basic' | 'header', ... }\`). The most common choice for enterprise customers with strict data-residency requirements.`,
    `- \`mimir\` — Grafana Mimir. Needs: \`url\`, \`auth\`, optional \`orgId\` (sent as \`X-Scope-OrgID\`).`,
    `- \`cortex\` — Cortex (multi-tenant Prometheus). Needs: \`url\`, \`auth\`, required \`orgId\`.`,
    `- \`amp\` — AWS Managed Prometheus. Needs: \`url\` (workspace URL), \`region\`. Auth resolves from the ambient AWS credential chain (\`AWS_PROFILE\` / IAM role / SSO / env vars).`,
    `- \`datadog\` — Datadog (via its Prometheus-compatible API). Needs: \`site\` (e.g., \`us5.datadoghq.com\`), \`apiKey\`, \`appKey\`.`,
    `- \`grafana_cloud_prom\` — Grafana Cloud Prometheus. Needs: \`url\`, \`user\` (instance ID), \`apiKey\`.`,
    `- \`gcp_managed_prom\` — GCP Managed Prometheus. Needs: \`url\`, \`projectId\`. Auth resolves from the ambient Google SDK chain (\`GOOGLE_APPLICATION_CREDENTIALS\`).`,
    '',
    `**Required follow-up by the agent**:`,
    '',
    `1. Ask the user: "Where does your 10x engine ship metrics? (log10x hosted / your own Prometheus / Mimir / Cortex / AMP / Datadog / Grafana Cloud / GCP Managed Prom)"`,
    `2. Collect URL + auth + (for kinds that need them) org / region / project / site.`,
    `3. Call \`log10x_configure_env\` with \`nickname\`, \`metricsBackend\`, optional \`labels\` overrides.`,
    `4. The tool validates the backend live and persists to \`~/.log10x/envs.json\` on success.`,
    `5. Re-run the original \`${callingTool}\` call.`,
    '',
    `**Credentials in config**: prefer \`\${VAR_NAME}\` references (resolved from the user's shell env) over literal values. \`log10x_configure_env\` refuses to persist obvious literal secrets.`,
    '',
    `**Tier prerequisites**: the 10x engine must already be configured to write metrics to the chosen backend (see \`config/pipelines/run/output/metric/<backend>/config.yaml\` in your config repo). The MCP only reads from the same store.`,
  ].join('\n');
}

/**
 * Returns the `not_configured` markdown if the MCP is in pure-demo
 * state (no user configuration, silently landed on the demo backend);
 * returns undefined otherwise.
 *
 * Phase 5b: tools check this at the top of their execute() and
 * return the response immediately if defined.
 */
export function notConfiguredMessageIfNeeded(envs: Environments, callingTool: string): string | undefined {
  // Pure demo state = no real configuration. demoFallbackReason being
  // set means the user TRIED to configure but their creds failed —
  // that's a different problem (loud banner already surfaced); don't
  // hijack it with the not-configured flow.
  if (envs.isDemoMode && !envs.demoFallbackReason) {
    return renderNotConfigured({ callingTool });
  }
  return undefined;
}
