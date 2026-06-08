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
 * Demo-mode gate: surface when `envs.isDemoMode && !envs.demoFallbackReason`
 * (pure-demo state means nothing was configured and we silently
 * landed on the demo backend). Phase 7 makes the unconfigured state
 * explicit — no more silent demo.
 */

import type { Environments } from './environments.js';
import {
  StructuredOutputSchema,
  type StructuredOutput,
  type Action,
} from './output-types.js';
import {
  buildChassisEnvelope,
  type ChassisEnvelope,
} from './chassis-envelope.js';

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
 * Demo-mode gate: tools check this at the top of their execute() and
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

// ── Typed not-configured envelope framework ───────────────────────────
//
// A tool that hits a missing precondition (no metrics backend, no SIEM
// creds, no Retriever, no gitops repo) should hand the agent a
// BRANCHABLE result, not an opaque error string, otherwise one missing
// precondition aborts the whole autonomous chain. `not_configured` is an
// EXPECTED state, not a failure: the envelope carries `data.status =
// 'not_configured'`, a remediation block, and optional next-step
// `actions[]`, and the call does NOT set `isError`. The agent reads the
// status, surfaces the fix, and continues the chain without this tool.
//
// Two ways in:
//   1. A tool returns `buildNotConfiguredEnvelope(...)` directly (the
//      graceful path, what the cross-pillar primitives / discover_join do).
//   2. A tool THROWS (the loud human-escape-hatch path, e.g.
//      customer_metrics_query). `wrap()` in index.ts catches it, recognises
//      it via `isNotConfiguredError`, and converts it with
//      `notConfiguredEnvelopeFromError`, so even a deliberate throw reaches
//      the agent as a structured, chain-safe envelope.

/** Which precondition is missing. Drives the default remediation copy. */
export type NotConfiguredKind =
  | 'metrics_backend'
  | 'customer_metrics'
  | 'retriever'
  | 'siem'
  | 'gitops'
  | 'generic';

/**
 * Throw this from a tool when a precondition is missing and you want the
 * loud-failure path (the throw is caught at the `wrap()` chokepoint and
 * converted to a structured `not_configured` envelope). Carries the kind,
 * a remediation markdown block, and optional next-step actions so the
 * chokepoint can build a rich envelope without re-deriving them.
 */
export class NotConfiguredError extends Error {
  /** Stable discriminator read by `isNotConfiguredError` (survives bundling). */
  readonly code = 'not_configured' as const;
  readonly kind: NotConfiguredKind;
  readonly remediation?: string;
  readonly actions?: Action[];
  constructor(
    kind: NotConfiguredKind,
    opts?: { message?: string; remediation?: string; actions?: Action[] },
  ) {
    super(opts?.message ?? `Precondition not configured: ${kind}.`);
    this.name = 'NotConfiguredError';
    this.kind = kind;
    this.remediation = opts?.remediation;
    this.actions = opts?.actions;
  }
}

/**
 * Recognise a "not configured" error at the `wrap()` chokepoint:
 * precisely, by discriminator, NOT by fuzzy message matching (a stray
 * "...is not configured" in some unrelated error must not be hijacked).
 * Matches: our own `NotConfiguredError` (by `code`), and the engine's
 * `CustomerMetricsNotConfiguredError` (by `name`). Matching by name keeps
 * this base module dependency-free: it must not import customer-metrics.ts
 * (this is a low-level module many tools import; pulling the heavy
 * customer-metrics graph in here would bloat the import surface and risk a
 * future cycle).
 */
export function isNotConfiguredError(e: unknown): boolean {
  if (e instanceof NotConfiguredError) return true;
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; name?: unknown };
    if (o.code === 'not_configured') return true;
    if (o.name === 'CustomerMetricsNotConfiguredError') return true;
  }
  return false;
}

/**
 * Build a structured `not_configured` envelope. `remediation` is the
 * markdown the agent should surface; `actions` are the next-step tool
 * calls that fix it. The headline tells the agent this is an expected
 * state to branch on, not a failure to retry.
 *
 * Returns a ChassisEnvelope (which extends StructuredOutput) so every
 * caller gets invocation_id, performance, and a valid ChassisData shape.
 * The existing precondition + remediation fields are preserved in
 * data.payload so agents that already read data.payload.status /
 * data.payload.precondition / data.payload.remediation continue to work.
 *
 * Chassis wire-up: status=error, error_type=config_missing,
 * retryable=false — the clean, branchable signal that the chassis
 * verifier expects. NOT isError on the MCP transport; not_configured is
 * an expected state.
 */
export function buildNotConfiguredEnvelope(args: {
  tool: string;
  kind?: NotConfiguredKind;
  remediation: string;
  actions?: Action[];
  diagnostic?: string;
}): ChassisEnvelope {
  const kind = args.kind ?? 'generic';
  const remediation =
    args.diagnostic ? `${args.remediation}\n\nDetection trace:\n${args.diagnostic}` : args.remediation;
  const headline =
    `\`${args.tool}\` ran but its ${kind.replace(/_/g, ' ')} precondition is not configured. ` +
    `This is an expected state, not a failure: read data.payload.remediation, surface the fix, and ` +
    `continue the chain without this tool.`;
  return buildChassisEnvelope({
    tool: args.tool,
    view: 'summary',
    headline,
    status: 'error',
    decisions: {
      threshold_used: null,
      threshold_basis: 'default',
    },
    source_disclosure: {},
    scope: {
      window: 'unknown',
      window_basis: 'auto_default',
    },
    payload: {
      status: 'not_configured',
      precondition: kind,
      remediation,
    },
    human_summary:
      `${kind.replace(/_/g, ' ')} precondition is not configured. ` +
      `Read payload.remediation, surface the fix to the user, and continue without this tool.`,
    error: {
      error_type: 'config_missing',
      retryable: false,
      suggested_backoff_ms: null,
      hint: `${kind.replace(/_/g, ' ')} not configured for tool \`${args.tool}\`. ${remediation.slice(0, 200)}`,
    },
    actions: args.actions ?? defaultActionsForKind(kind),
    warnings: [
      `${args.tool}: ${kind.replace(/_/g, ' ')} not configured, call did not fail (data.payload.status = 'not_configured'). Do not retry verbatim; remediate or continue without it.`,
    ],
  });
}

/** Default remediation actions per kind, so the agent has a concrete next step. */
export function defaultActionsForKind(kind: NotConfiguredKind): Action[] {
  switch (kind) {
    case 'metrics_backend':
      return [
        {
          tool: 'log10x_configure_env',
          args: {},
          reason: 'configure a metrics backend (log10x / Prometheus / Mimir / AMP / Datadog / ...) then re-run',
          role: 'required-next',
        },
      ];
    case 'retriever':
      return [
        {
          tool: 'log10x_advise_retriever',
          args: {},
          reason: 'stand up the Retriever S3 archive + index, then re-run',
          role: 'required-next',
        },
      ];
    // customer_metrics / siem / gitops / generic intentionally return no
    // action: their remediation is shell/env-var setup (e.g.
    // LOG10X_CUSTOMER_METRICS_URL, DD_API_KEY, AWS chain) that NO MCP tool
    // performs. Pointing at log10x_configure_env would mislead (that tool
    // configures the log-tier metrics_backend, a different backend). The
    // remediation markdown spells out the env vars; the agent continues
    // without the tool. Empty actions[] is the honest signal here.
    default:
      return [];
  }
}

/**
 * Convert a thrown error into a structured `not_configured` envelope.
 * Used by the `wrap()` chokepoint so a deliberate throw (the loud
 * human-escape-hatch path) still reaches the agent as a branchable,
 * chain-safe result. Falls back to a generic envelope carrying the raw
 * message when the throw isn't a recognised kind.
 */
export function notConfiguredEnvelopeFromError(tool: string, e: unknown): StructuredOutput {
  if (e instanceof NotConfiguredError) {
    return buildNotConfiguredEnvelope({
      tool,
      kind: e.kind,
      remediation: e.remediation ?? e.message,
      actions: e.actions ?? defaultActionsForKind(e.kind),
    });
  }
  const name = (e as { name?: string } | null)?.name;
  const message = e instanceof Error ? e.message : String(e);
  if (name === 'CustomerMetricsNotConfiguredError') {
    // The error's own message already carries the full env-var remediation.
    return buildNotConfiguredEnvelope({ tool, kind: 'customer_metrics', remediation: message });
  }
  return buildNotConfiguredEnvelope({ tool, kind: 'generic', remediation: message });
}

/**
 * Validate + shape a `not_configured` envelope into the MCP tool-result
 * form (text channel carries the JSON; structured channel ships the
 * typed envelope). Mirrors the success path in `wrap()`; kept here so the
 * chokepoint stays a one-liner and the not-configured contract lives in
 * one place. NOT `isError`: `not_configured` is an expected state.
 */
export function notConfiguredToolResult(env: StructuredOutput): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const validated = StructuredOutputSchema.parse(env);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(validated, null, 2) }],
    structuredContent: validated as unknown as Record<string, unknown>,
  };
}
