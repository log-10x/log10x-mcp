#!/usr/bin/env node

/**
 * Log10x MCP Server
 *
 * Gives AI assistants real-time access to per-pattern log cost attribution data.
 * Queries pre-aggregated Prometheus metrics — no log scanning, sub-second at any scale.
 */

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { recordStart, withTelemetry, setEnvsProvider } from './lib/self-telemetry.js';
import {
  loadManifest,
  applyManifestToTools,
  readClientVersion,
  getPackageDefaultTool,
} from './lib/manifest.js';
import { z } from 'zod';
import {
  StructuredOutputSchema,
  type StructuredOutput,
} from './lib/output-types.js';
import {
  detectMode,
  shouldRegisterTool,
  formatModeResolution,
  type ModeResolution,
} from './lib/mode-detect.js';

import { loadEnvironments, resolveEnv, revalidateEnvironments, type EnvConfig, type Environments, EnvironmentValidationError } from './lib/environments.js';
import { fetchAnalyzerCost } from './lib/api.js';
import { eventLookupSchema, executeEventLookup } from './tools/event-lookup.js';
import { savingsSchema, executeSavings } from './tools/savings.js';
import { trendSchema, executeTrend } from './tools/trend.js';
import { patternExamplesSchema, executePatternExamples } from './tools/pattern-examples.js';
import { dependencyCheckSchema, executeDependencyCheck } from './tools/dependency-check.js';
import { configureEnvSchema, executeConfigureEnv } from './tools/configure-env.js';
import { renderNotConfigured } from './lib/not-configured.js';

function notConfiguredMessageForTool(toolName: string): string {
  return renderNotConfigured({ callingTool: toolName });
}
import { topPatternsSchema, executeTopPatterns } from './tools/top-patterns.js';
import { resolveBatchSchema, executeResolveBatch } from './tools/resolve-batch.js';
import {
  investigateSchema,
  executeInvestigate,
} from './tools/investigate.js';
import { doctorSchema, executeDoctor, runDoctorChecks, renderDoctorReport } from './tools/doctor.js';
import { log } from './lib/log.js';
import { describeToolError } from './lib/tool-errors.js';
import { retrieverQuerySchema, executeRetrieverQuery } from './tools/retriever-query.js';
import { retrieverSeriesSchema, executeRetrieverSeries } from './tools/retriever-series.js';
import { backfillMetricSchema, executeBackfillMetric } from './tools/backfill-metric.js';
import {
  customerMetricsQuerySchema,
  executeCustomerMetricsQuery,
} from './tools/customer-metrics-query.js';
import { discoverJoinSchema, executeDiscoverJoin } from './tools/discover-join.js';
import {
  correlateCrossPillarSchema,
  executeCorrelateCrossPillar,
} from './tools/correlate-cross-pillar.js';
import {
  pocFromSiemSubmitSchema,
  pocFromSiemStatusSchema,
  executePocSubmit,
  executePocStatus,
} from './tools/poc-from-siem.js';
import { pocFromLocalSchema, executePocFromLocal } from './tools/poc-from-local.js';
import { discoverEnvSchema, executeDiscoverEnv } from './tools/discover-env.js';
import { adviseReporterSchema, executeAdviseReporter } from './tools/advise-reporter.js';
import { adviseReceiverSchema, executeAdviseReceiver } from './tools/advise-receiver.js';
import { adviseRetrieverSchema, executeAdviseRetriever } from './tools/advise-retriever.js';
import { adviseInstallSchema, executeAdviseInstall } from './tools/advise-install.js';
import { configureCompactSchema, executeConfigureCompact } from './tools/configure-compact.js';
import { configureRegulatorSchema, executeConfigureRegulator } from './tools/configure-regulator.js';
import { patternMitigateSchema, executePatternMitigate } from './tools/pattern-mitigate.js';
import { loginStatusSchema, executeLoginStatus } from './tools/login-status.js';
import {
  signinStartSchema,
  signinCompleteSchema,
  executeSigninStart,
  executeSigninComplete,
} from './tools/signin.js';
import { signoutSchema, executeSignout } from './tools/signout.js';
import { updateSettingsSchema, executeUpdateSettings } from './tools/update-settings.js';
import { createEnvSchema, executeCreateEnv } from './tools/create-env.js';
import { updateEnvSchema, executeUpdateEnv } from './tools/update-env.js';
import { deleteEnvSchema, executeDeleteEnv } from './tools/delete-env.js';
import { rotateApiKeySchema, executeRotateApiKey } from './tools/rotate-api-key.js';
import { servicesSchema, executeServices } from './tools/services.js';
import { findSkewSchema, executeFindSkew } from './tools/find-skew.js';
import { findConstantSlotsSchema, executeFindConstantSlots } from './tools/find-constant-slots.js';
import { findUuidInBodySchema, executeFindUuidInBody } from './tools/find-uuid-in-body.js';
import { findIncidentClusterSchema, executeFindIncidentCluster } from './tools/find-incident-cluster.js';
import { discoverLabelsSchema, executeDiscoverLabels } from './tools/discover-labels.js';
import { extractTemplatesSchema, executeExtractTemplates } from './tools/extract-templates.js';
import {
  translateMetricToPatternsSchema,
  executeTranslateMetricToPatterns,
} from './tools/translate-metric-to-patterns.js';
import { getStatus } from './resources/status.js';

// ── Environment + cost cache ──
//
// Env loading is deferred until after CLI flag handling so `--version`,
// `--list-tools`, `--doctor`, and `--help` all work without env vars set.
// `main()` calls `initEnvs()` once before `server.connect(transport)`,
// so every tool callback can use `getEnvs()` synchronously from that
// point onward. The async load path is required because autodiscovery
// (apiKey alone → GET /api/v1/user) hits the network.

let envs: Environments | undefined;
let bootMode: ModeResolution | undefined;

async function initEnvs(): Promise<void> {
  envs = await loadEnvironments();
}

/**
 * Detect the operating mode (analysis | analysis_pending | poc) for
 * this MCP boot. Runs once after envs are loaded; result is fixed for
 * the lifetime of the process. Tool handlers consult `bootMode.mode`
 * via `getBootMode()` to gate themselves; agents see all 44 tools in
 * `tools/list` and the client's tool-search ranks per query, but a
 * tool called in the wrong mode returns a clear "not available" reply
 * instead of 5xx'ing on a missing backend.
 */
async function initBootMode(): Promise<void> {
  bootMode = await detectMode();
}

export function getBootMode(): ModeResolution {
  if (!bootMode) {
    throw new Error(
      '[log10x-mcp] internal error: bootMode accessed before initBootMode() completed.'
    );
  }
  return bootMode;
}

function getEnvs(): Environments {
  if (!envs) {
    throw new Error(
      '[log10x-mcp] internal error: envs accessed before initEnvs() completed.'
    );
  }
  return envs;
}

const costCache = new Map<string, { cost: number; fetchedAt: number }>();
const COST_REFRESH_MS = 3_600_000; // 1 hour

/**
 * Wrap a tool implementation in a try/catch that produces actionable error
 * suggestions via `describeToolError(toolName, e)`. Every tool callback
 * goes through this helper instead of the raw try/catch idiom so error
 * surfaces are uniform and self-coaching for the model.
 *
 * Also instruments every call with `timed()` for free observability — ops
 * can set LOG10X_MCP_LOG_LEVEL=info to get per-tool call counts and
 * durations on stderr without any new endpoints or resources. On errors,
 * the raw error message is logged at debug level before `describeToolError`
 * rewrites it, so ops can see the original text when hunting root causes.
 */
/**
 * Tools that query the metrics backend (cost_drivers, top_patterns,
 * etc.). When the MCP is in pure-demo mode (no user configuration,
 * silently landed on the demo backend), these tools short-circuit
 * with a structured `not_configured` response instead of returning
 * demo data the user didn't ask for. Phase 5b — phase 7 will remove
 * the silent-demo path entirely; for now we surface the conversation
 * starter without breaking the demo-mode walkthrough.
 *
 * Tools NOT in this set bypass the gate: configure_env (the
 * onboarding tool itself), doctor (status reporting works in any
 * mode), local-only tools (resolve_batch, extract_templates,
 * dependency_check pasted input), signin_* (log10x account
 * management), discover_env (k8s discovery), poc_from_* (pre-config
 * sample reports).
 */
const METRIC_REQUIRING_TOOLS = new Set([
  'log10x_top_patterns',
  'log10x_pattern_trend',
  'log10x_pattern_examples',
  'log10x_event_lookup',
  'log10x_savings',
  'log10x_services',
  'log10x_discover_labels',
  'log10x_investigate',
  'log10x_backfill_metric',
  'log10x_correlate_cross_pillar',
  'log10x_discover_join',
  'log10x_customer_metrics_query',
  'log10x_translate_metric_to_patterns',
  'log10x_retriever_query',
  'log10x_retriever_series',
]);

async function wrap(
  toolName: string,
  fn: () => Promise<string | StructuredOutput>
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const started = Date.now();
  // Phase 5b gate: if this is a metric-requiring tool and the MCP is
  // in pure-demo state, redirect to the conversational onboarding
  // flow instead of returning silent-demo data.
  if (METRIC_REQUIRING_TOOLS.has(toolName) && envs && envs.isDemoMode && !envs.demoFallbackReason) {
    log.info(`tool.${toolName}.not_configured`);
    return {
      content: [{ type: 'text' as const, text: notConfiguredMessageForTool(toolName) }],
    };
  }
  // Mode gate: if the boot-time mode-detect determined this tool is
  // not available in the current mode, return a clear out-of-mode
  // reply rather than letting it 5xx on a missing backend. Agents see
  // all tools in `tools/list` (client-side tool-search ranks them per
  // query, so cognitive surface is not the concern); the gate just
  // ensures wrong-mode calls produce a useful response.
  if (bootMode && !shouldRegisterTool(toolName, bootMode.mode)) {
    log.info(`tool.${toolName}.wrong_mode`, { mode: bootMode.mode });
    return {
      content: [
        {
          type: 'text' as const,
          text: formatOutOfModeMessage(toolName, bootMode),
        },
      ],
    };
  }
  try {
    const result = await runWithDemoFallbackRetry(toolName, fn);
    log.info(`tool.${toolName}.ok`, { ms: Date.now() - started });
    // Legacy path: tool returned a markdown string. Apply demo banner
    // as a prepended block and wrap as text content.
    if (typeof result === 'string') {
      return { content: [{ type: 'text' as const, text: applyDemoBanner(result) }] };
    }
    // Structured envelope path. Validate first so a malformed envelope
    // surfaces as an error rather than silently emitting bad JSON to
    // the transport.
    let validated: StructuredOutput;
    try {
      validated = StructuredOutputSchema.parse(result);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      log.warn(`tool.${toolName}.envelope_invalid`, { msg: msg.slice(0, 240) });
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Internal error: tool returned an invalid StructuredOutput envelope.\n` +
              `Tool: ${toolName}\n` +
              `Validation error: ${msg}`,
          },
        ],
        isError: true,
      };
    }
    if (validated.view === 'markdown') {
      // Renderer was invoked inside the tool; data.markdown carries
      // the rendered artifact. Pull it through to the text channel
      // verbatim, with the demo banner prepended exactly as in the
      // legacy string path.
      const md = (validated.data as { markdown?: unknown }).markdown;
      if (typeof md !== 'string') {
        log.warn(`tool.${toolName}.markdown_view_missing_markdown`);
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Internal error: tool returned view: "markdown" but data.markdown is not a string.\n` +
                `Tool: ${toolName}`,
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: applyDemoBanner(md) }] };
    }
    // JSON view. The demo-mode banner is structural metadata, not a
    // prose prefix, so it lives in warnings[] rather than being
    // injected into a `text` blob. The agent reads warnings and
    // decides how to surface them to the user.
    const enriched: StructuredOutput = {
      ...validated,
      warnings: maybeAddDemoBannerWarning(validated.warnings),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(enriched, null, 2) }] };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    log.debug(`tool.${toolName}.raw_err`, { msg: raw });
    log.warn(`tool.${toolName}.err`, { ms: Date.now() - started, msg: raw });
    return {
      content: [{ type: 'text' as const, text: applyDemoBanner(describeToolError(toolName, e)) }],
      isError: true,
    };
  }
}

/**
 * Run the tool's inner function. If it throws an auth error (401/403)
 * AND the MCP is currently in demo-fallback mode, revalidate
 * credentials once and retry the tool.
 *
 * Why: every account-scoped EnvConfig bakes the apiKey at boot
 * (`environments.ts:loadFromApi`). If the user's key was invalid at
 * boot (typo, transient backend issue, rotated key whose authorizer
 * cache had not yet cleared), the MCP falls back to the public demo
 * key and every account-scoped tool keeps using that demo key for the
 * lifetime of the process, even after the real key starts working.
 * Restarting the MCP host was the only recovery path until now.
 *
 * This wrapper makes recovery automatic: any account-scoped tool that
 * gets 401/403 while in demo-fallback triggers a single revalidation
 * + retry, transparently un-sticking the user. Pure demo mode (no key
 * configured at all) does NOT trigger this; only the fallback case
 * where the user intended to use a real account.
 *
 * Tools that don't hit the gateway (resolve_batch, extract_templates)
 * never produce 401/403 errors so this is a no-op for them.
 */
async function runWithDemoFallbackRetry<T>(
  toolName: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isAuthRecoverableError(e)) throw e;
    if (!envs || !envs.isDemoMode || !envs.demoFallbackReason) throw e;
    log.info(`tool.${toolName}.auth_retry.attempt`, {
      reason: envs.demoFallbackReason.slice(0, 200),
    });
    try {
      await revalidateEnvironments(envs);
    } catch (reloadErr) {
      log.warn(`tool.${toolName}.auth_retry.reload_failed`, {
        msg: (reloadErr as Error).message,
      });
      throw e;
    }
    if (envs.isDemoMode) {
      // Reload still ended in demo. Original error stands.
      log.info(`tool.${toolName}.auth_retry.still_demo`);
      throw e;
    }
    log.info(`tool.${toolName}.auth_retry.recovered`);
    return await fn();
  }
}

function isAuthRecoverableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /HTTP 401|HTTP 403|forbidden|unauthorized/i.test(msg);
}

/**
 * Prepend a banner to the tool result when the MCP is in
 * demo-fallback mode (user supplied an API key but it failed). The
 * goal is hard-to-miss notification — but the wording matters: only
 * account-scoped tools return demo data; local-only templater tools
 * (resolve_batch, extract_templates) operate on the caller's own
 * input regardless of credential state. So the banner describes the
 * MCP's *mode*, not "this tool's data."
 *
 * Pure demo mode (no key set) is the user's own choice and gets a
 * quieter footer instead.
 */
/**
 * Structured-envelope variant of applyDemoBanner. The demo-mode
 * signal is appended to the `warnings[]` array rather than prepended
 * as prose, because JSON consumers parse fields, not prefixes. Same
 * trigger conditions and wording as applyDemoBanner; just a different
 * surface.
 */
function maybeAddDemoBannerWarning(warnings: string[]): string[] {
  if (!envs?.isDemoMode) return warnings;
  if (envs.demoFallbackReason) {
    const reason = envs.demoFallbackReason.split('\n')[0].slice(0, 240);
    return [
      `DEMO MODE — your LOG10X_API_KEY failed validation. Account-scoped tools hit the public Log10x demo env, NOT your account. Reason: ${reason}. Call log10x_login_status for fix steps.`,
      ...warnings,
    ];
  }
  return [
    `Demo mode — account-scoped tools query the read-only Log10x demo env. Call log10x_login_status to use your own data.`,
    ...warnings,
  ];
}

/**
 * Format a clear "this tool is not available in the current boot mode"
 * reply. The agent calls a tool that mode-detect determined is
 * irrelevant (analysis tool in POC mode, POC tool in analysis mode);
 * we tell it why and what would change the mode.
 */
function formatOutOfModeMessage(toolName: string, mode: ModeResolution): string {
  const lines = [
    `## \`${toolName}\` is not available in this mode`,
    ``,
    `**Current mode**: \`${mode.mode}\``,
    `**Reason**: ${mode.reason}`,
    ``,
  ];
  if (mode.mode === 'poc') {
    lines.push(
      `This MCP detected no TSDB backend at boot and registered the POC tools (`,
      `\`log10x_poc_from_siem_*\`, \`log10x_poc_from_local\`) plus install advisors instead.`,
      ``,
      `If you have a 10x deployment with a TSDB (Grafana Cloud, AMP, GCP Managed Prometheus,`,
      `Datadog Prom, self-hosted Prometheus, or 10x Cloud), set the corresponding env vars`,
      `(\`LOG10X_CUSTOMER_METRICS_URL\` + \`LOG10X_CUSTOMER_METRICS_TYPE\` + \`LOG10X_CUSTOMER_METRICS_AUTH\`,`,
      `or any of the ambient detect paths) and restart the MCP. The analysis tools will`,
      `register on the next boot.`
    );
  } else if (mode.mode === 'analysis') {
    lines.push(
      `This MCP detected a live 10x deployment at boot and registered the analysis tools.`,
      ``,
      `\`${toolName}\` is a POC / install-advisor tool that runs against prospect environments.`,
      `If you actually want POC / install-advisor behavior in an analysis-mode env, unset the`,
      `customer-metrics env vars and restart.`
    );
  }
  return lines.join('\n');
}

function applyDemoBanner(text: string): string {
  if (!envs?.isDemoMode) return text;
  if (envs.demoFallbackReason) {
    const reason = envs.demoFallbackReason.split('\n')[0].slice(0, 240);
    return (
      `> ⚠ **DEMO MODE — your LOG10X_API_KEY failed validation.** ` +
      `Account-scoped tools (top_patterns, investigate, services, etc.) hit the public Log10x demo env, NOT your account. ` +
      `Local-only tools (resolve_batch, extract_templates) are unaffected. ` +
      `Reason: ${reason} ` +
      `Call \`log10x_login_status\` for fix steps.\n\n` +
      text
    );
  }
  // Pure demo: lighter footer; the user opted in by not setting a key.
  return text + `\n\n_(Demo mode — account-scoped tools query the read-only Log10x demo env. Call \`log10x_login_status\` to use your own data.)_`;
}

async function getAnalyzerCost(env: EnvConfig, override?: number): Promise<number> {
  if (override !== undefined) return override;

  const key = env.envId;
  const cached = costCache.get(key);
  const now = Date.now();

  if (cached && (now - cached.fetchedAt) < COST_REFRESH_MS) {
    return cached.cost;
  }

  const cost = await fetchAnalyzerCost(env);
  costCache.set(key, { cost, fetchedAt: now });
  return cost;
}

// ── Server ──

const server = new McpServer(
  { name: 'log10x', version: readClientVersion() },
  {
    // Declare the `logging` capability so calls to extra.sendNotification
    // ('notifications/message', ...) inside tool handlers don't throw
    // synchronously from the SDK's assertNotificationCapability guard.
    // We don't currently rely on mid-tool push for the sign-in flow
    // (the two-tool log10x_signin_start / log10x_signin_complete split
    // sidesteps Cursor's lack of mid-tool rendering), but declaring the
    // capability is correct hygiene and unblocks any other tool that
    // wants to use the channel on hosts that do support it.
    capabilities: { logging: {} },
    instructions: `Log10x is the observability memory for the user's logs. Every log line the pipeline
has ever seen is fingerprinted into a stable pattern identity (field-set) that stays constant across
deploys, restarts, pod names, timestamps, and request IDs. That identity is the key to a Prometheus
time series of volume and cost, so any pattern the user has ever emitted is instantly queryable by
name, by history, or by sample line — with zero prior query setup.

CUSTOMER TIER LADDER (determines which tools are available)

1. Dev CLI only — free local binary, no pipeline infrastructure.
   Available tools: log10x_resolve_batch (pasted-batch triage), log10x_dependency_check,
                    log10x_pattern_mitigate.
2. Cloud Reporter — k8s CronJob sampling from the SIEM via REST API.
   Adds: log10x_investigate (sampled fidelity), log10x_pattern_trend,
         log10x_top_patterns, log10x_event_lookup, log10x_savings.
3. Edge Reporter — forwarder pipeline sidecar.
   Same tools as Cloud, but with full-fidelity metrics, ~5s inflection granularity, and
   coverage of events dropped before the SIEM.
4. Retriever (deployable with or without Reporter) — S3 archive with Bloom-filter index.
   Adds: log10x_retriever_query (forensic retrieval), log10x_backfill_metric (new metric
         backfilled from archive + forward-emission handoff to the Reporter).

TOOL ROUTING BY USER INTENT

Daily-habit / operational:
- user pastes a raw log line, asks "what is this"                → log10x_event_lookup
- user pastes MULTIPLE events or a SIEM dump, asks "triage this" → log10x_resolve_batch
- "is this pattern new" / "when did this start"                  → log10x_event_lookup then log10x_pattern_trend
- "how often is this happening" / "is it getting worse"          → log10x_pattern_trend
- "top patterns in <service> right now"                          → log10x_top_patterns
- "why is X spiking" / "investigate X" / "what's causing this"   → log10x_investigate
- "am I allowed to drop this" / "what references this"           → log10x_dependency_check
- "drop X" / "filter X" / "mute X" / "stop ingesting X" /
  "reduce cost of X" / "kill X" / "get rid of X" / "shrink X" /
  "compact X" / "exclude X from Datadog/Splunk/Elastic/CloudWatch" → log10x_pattern_mitigate (returns the
                                                                      env-gated mitigation options + exact configs
                                                                      for this pattern: drop @ analyzer / drop @
                                                                      forwarder / mute @ 10x / compact @ 10x —
                                                                      only the options available in this env are
                                                                      included. Each option carries a paste-ready
                                                                      config snippet inline. Once the user picks one:
                                                                        option 1 or 2 → log10x_dependency_check
                                                                                        (paste the snippet from
                                                                                         pattern_mitigate.options[i].config_snippet)
                                                                        option 3       → log10x_dependency_check
                                                                                        → log10x_advise_receiver
                                                                        option 4       → log10x_configure_compact)
- (proactive): after log10x_top_patterns / log10x_event_lookup surfaces a
  high-volume pattern AND the user's framing is cost-related ("expensive", "bill", "save",
  "reduce", "spike"), offer to reduce it as a follow-up question — "Want me to show
  you options for reducing this?" Do this even if not asked. When the user says yes, call
  log10x_pattern_mitigate with the pattern identity from the prior row; it returns the
  env-gated mitigation options + exact configs for that pattern.

Cost investigation:
- "what's expensive right now" / "top patterns by cost" /
  "what changed" / "week-over-week delta" /
  "why did costs go up"                                          → log10x_top_patterns
  (log10x_top_patterns surfaces current rank + newly-emerged + delta-from-baseline
   for each pattern in one call. Use the \`comparison_window\` arg for "what changed
   since last week" framing.)
- "pipeline savings / ROI"                                       → log10x_savings

Forensic / audit / archive — ANY request for RAW EVENTS from the S3 archive:
- "pull the actual log events", "get me the raw events", "retrieve events from S3",
  "fetch events from the archive", "show me what was in the logs during <time window>",
  "I need the events themselves, not aggregates"                 → log10x_retriever_query
- "get me all <pattern> events from 90 days ago"                 → log10x_retriever_query
- "get all events for customer X filtered by Y, 60d window"      → log10x_retriever_query
- "backfill a new metric with 90d of history from the archive"   → log10x_backfill_metric
  (Critical: when a user asks for raw events OR mentions S3 / archive / cold storage
   explicitly, route to retriever_query even if the framing also mentions an incident.
   investigate returns aggregate pattern analysis; retriever_query returns actual log
   lines. "Post-mortem needs the actual log events" = retriever_query, not investigate.)

Root-cause across services (the investigate wedge):
- user pastes an error, asks "what's causing the upstream"       → log10x_investigate
- Critical: log10x_investigate surfaces log-only signals (connection pool saturation, cache
  eviction storms, feature-flag cache flushes, retry amplification) that APM does NOT see
  because they manifest as slow-success traces, not errors. This is the structural wedge vs
  Datadog APM, Splunk APM, and OpenTelemetry tracing — correlation happens on the pattern-rate
  universe, not on spans that already exist.

Account / setup / discovery:
- "am I logged in" / "login status" / "what envs do I have"      → log10x_login_status
- "log me in" / "sign me up" / "create a Log10x account"         → log10x_signin_start, then log10x_signin_complete
  (Two-tool chain: log10x_signin_start opens the browser and returns the device_code + user_code,
   the model surfaces the code so the user can verify it matches the Auth0 page, then the model
   automatically calls log10x_signin_complete with that device_code to finish the flow. The user
   does NOT need to ask for the second step explicitly. For pasted-key sign-in instead of browser,
   skip log10x_signin_start and call log10x_signin_complete directly with { api_key: "<key>" }.)
- "sign out" / "log out" / "remove my credentials"               → log10x_signout
- "rotate my API key" / "I think my key was leaked"              → log10x_rotate_api_key
- "health check" / "is the MCP set up right" / "diagnose"        → log10x_doctor
- "create / rename / delete / set-default an env"                → log10x_{create,update,delete}_env
- "set analyzer cost" / "switch AI provider" / "use my own key"  → log10x_update_settings
- Critical: when the user asks about Log10x setup state, NEVER shell out to probe for a
  CLI binary. There is no log10x shell command. The MCP IS the surface. Framings like
  "is the log10x CLI installed", "log10x version", "whats my log10 status" should route
  to log10x_doctor or log10x_login_status — never to "which log10x" / "log10x --version"
  / env-var probes. If you find yourself reaching for shell tools to answer a Log10x
  question, stop and call the matching MCP tool instead.

NATURAL TOOL CHAINS

  Incident anchoring (user pastes a line during oncall):
    log10x_event_lookup  →  log10x_investigate
    (or for a batch: log10x_resolve_batch  →  log10x_investigate on the top pattern)

  Cost investigation:
    log10x_top_patterns  →  log10x_pattern_mitigate  →  log10x_dependency_check

  Forensic retrieval across retention boundaries:
    log10x_event_lookup  →  log10x_retriever_query

  New metric from historical archive:
    log10x_top_patterns or log10x_investigate  →  log10x_backfill_metric

RESPONSE STYLE

- For cost questions: show dollar amounts prominently, emphasize before→after deltas, flag new
  patterns. The value is attribution ("which specific patterns drive costs"), not "costs went up."
- For investigation results: confidence percentages are mechanically derived from data signal
  quality (stat × lag × chain for acute spikes; slope_sig × cohort for drift). When asked, walk
  the user through the decomposition.
- Never fabricate a pattern identity. The primitive is deterministic: same line → same identity,
  forever. If log10x_event_lookup returns no match, say so — do not guess.
- Honest empty returns are a feature. If log10x_investigate finds no significant movement, report
  that, do not pad with low-confidence noise.

NUMBERS DISCIPLINE — hard rules, no exceptions:

- Every dollar amount, percentage, event count, or timestamp in your response must appear
  verbatim in a tool result you called in this session. If you cannot point to the exact tool
  output, do not write the number. Say "not reported" instead.
- Do NOT compute percentages from before→after values — log10x_top_patterns emits the
  exact (+N%) delta on each row when comparison_window is set. Quote it. Do not re-derive it.
- Do NOT invent "peak" values. log10x_top_patterns returns window averages, not peaks.
  If the user asks for peaks, call log10x_pattern_trend explicitly and quote its max bucket.
- Do NOT synthesize a baseline number. If log10x_top_patterns does not list a pattern under
  the comparison_window delta, that pattern is not a cost driver — do not invent a baseline.
- log10x_dependency_check has two output modes. When SIEM credentials are present in the env
  (DD_API_KEY, SPLUNK_HOST+SPLUNK_TOKEN, ELASTIC_URL+KIBANA_URL, AWS chain), the tool runs the
  scan in-process and returns ACTUAL dashboard/alert/saved-search/monitor/metric-filter names
  + URLs — header reads "Dependency Check — <Vendor> (executed)". Treat these as authoritative.
  When credentials are missing, the tool falls back to a paste-ready bash command — header
  reads "(paste-ready)". In that case do NOT report "zero dependencies found" or "safe to drop"
  — wait for the user to run the script and paste back its results.

Analyzer cost is auto-detected from the user's profile. Typical rates if unspecified:
Splunk $6/GB, Datadog $2.50/GB, Elasticsearch $1/GB, CloudWatch $0.50/GB.

TOOL OUTPUT — AUDIENCE-SEPARATED MARKDOWN

Every tool returns one markdown blob. Two audiences read it:
  1. The user (sees rendered prose).
  2. You, the agent (read the raw text, chain follow-up calls).

The MCP marks agent-only content with these inline HTML comments so you can identify and consume them without leaking them to the user:

  <!-- agent-only: <free prose for the agent — constraints, suggested next calls, "do not X" warnings> -->
  <!-- NEXT_ACTIONS:[{...JSON tool-call hints...}] -->

Rule: when you produce a user-facing reply, DO NOT pass the contents of \`<!-- agent-only: ... -->\` or \`<!-- NEXT_ACTIONS: ... -->\` blocks to the user verbatim. They are tool→agent communication.

Consume them by:
  - Using the constraints inside \`agent-only\` to shape your synthesis (e.g., "do not re-label current-rank as growth" → say "top patterns by current cost" not "top cost drivers").
  - Using the \`NEXT_ACTIONS\` JSON when you decide your next tool call.

The visible markdown is the FACTS the user gets. Everything inside an HTML comment is for you to internalize, not relay.

INTERPRETING METRIC PATTERNS — what you may and may not say

Tool responses carry rich label context per series (message_pattern, severity_level, k8s_container, k8s_namespace, k8s_pod, tenx_user_service, tenx_user_process, instance, http_code, http_message, tenx_reported_name, tenx_unit_name, etc.). When the user asks you to describe or explain a result, you may decode and interpret these labels — that produces more useful prose than a deterministic decoder ever will. But it comes with strict rules to keep your synthesis grounded.

1. **Cite the source — by default LIGHTLY.** Render the decoded prose first, with the raw token suppressed or shown only as a short inline annotation. Heavy citation (full \`message_pattern=...\` blocks, side-by-side raw/decoded tables) is reserved for when the user explicitly asks for verification or when a row makes a high-stakes claim (cost driver, regression, safe-to-drop). The default user experience is the decode; the citation is on demand. If you can't cite at all, don't make the claim.

2. **Numbers come from the response.** Quote dollar amounts and byte volumes verbatim from the tool output. Scaling math (12h → annual, etc.) is allowed only when you show the arithmetic ("$1.4/12h × 730 = $1,022/yr"). Never derive a figure in your head and present it as a fact.

3. **Two tiers when the user asks for verification or audit.** A "**Facts:**" / "**Interpretation:**" split is appropriate when the user is auditing or debugging your synthesis. For a normal "show me X" request, write the decoded answer inline — facts and interpretation woven together — and skip the tiering. Default to terse, single-pass prose; reach for the two-tier layout only when warranted.

4. **Refusal beats guess.** If you don't recognize a \`message_pattern\` token, severity, or label value with high confidence, say "symbol unknown" or "context unclear" and suggest pulling raw events via \`log10x_retriever_query\` (when Retriever is deployed) or running \`log10x_event_lookup\` for a known sample. Do not invent a plausible-sounding identity.

5. **No reference to patterns/services/severities outside the response.** The label set in the tool result is the universe. Phrases like "you probably also have…" or "I'd expect to see…" are forbidden — they invite the user to look for problems that aren't in the data.

6. **No "safe to drop" claims without dependency_check.** You may SUGGEST muting or dropping a pattern. You may NOT assert it's safe. "Safe to drop" / "won't break any dashboards" / "no alerts depend on this" all require \`log10x_dependency_check\` evidence in the same conversation turn. The drop chain is deliberately gated this way to firewall interpretive hallucination from production-affecting action.

7. **Semantic decode for recognized public packages.** Syntactic renaming alone ("tgo_opentelemetry_io_collector_consumer_logs_go" → "consumer logs.go") is useless to a reader who doesn't already know what the file does. When the decoded symbol refers to a **widely-known public package, library, framework, or service** that you recognize with high confidence — OpenTelemetry Collector internals, AWS / GCP / Azure SDK code paths, Kafka clients, JVM runtimes, Stripe/Twilio/SendGrid SDKs, Kubernetes / Envoy / Istio internals, common ORMs, common databases, etc. — describe what the code path actually does in one short business-term phrase. Example: not "consumer logs.go" but "OTel Collector's logs-consumer dispatch — hands log batches from processors to exporters". This is not fabrication; it is recognition of public OSS / vendor code whose purpose is documented. For symbols that look CUSTOM to the user's own codebase (their company package names, internal service names, or anything you don't recognize confidently), render the decoded identifier only and say "application-specific symbol" or "unknown function". Confidence gate: if you wouldn't bet on the business meaning without checking the source, stay literal.

Decoding aids you may use:
- \`message_pattern\` tokens of shape \`<vendor>_<package>_<subpackage>_<file_or_method>\` are usually Go package paths or fully-qualified Go functions. Reconstruct with \`/\` separators and recognize the shape (e.g., \`go_opentelemetry_io_collector_…\` → \`go.opentelemetry.io/collector/…\`).
- Tokens ending \`_go\` are typically Go source-file references.
- CamelCase trailing tokens (e.g., \`…ConsumeLogsFunc_ConsumeLogs\`) usually indicate a Go method on a type.
- Tokens containing \`_id_\`, \`_name_\`, \`_version_\` often indicate a log line carrying those keys as resource attributes — the severity label may reflect the wrapper severity, not a real error semantic. Flag this distinction when relevant.

These are aids, not certainties. Cite the raw token; let the user verify.`,
  }
);

// ── Self-telemetry + manifest registry hook ──
// Wrap every server.registerTool call so tool dispatches increment a counter
// (log10x_mcp_tool_call_total) that the Log10x console reads to detect MCP activity.
// Must run BEFORE any registerTool call. Silent no-op unless LOG10X_API_KEY +
// PROMETHEUS_REMOTE_WRITE_URL (or LOG10X_TELEMETRY_URL) are both set.
//
// Same wrapper also stashes the returned RegisteredTool in a registry map so
// the manifest loader can patch description/title/annotations/enabled at boot
// — see `applyManifestToTools` in main().
recordStart();
const registeredTools = new Map<string, RegisteredTool>();
const _originalRegisterTool = server.registerTool.bind(server) as typeof server.registerTool;
(server as any).registerTool = ((name: string, schema: any, handler: any) => {
  const wrapped = withTelemetry(name, handler);
  const registered = _originalRegisterTool(name as any, schema, wrapped);
  registeredTools.set(name, registered);
  return registered;
}) as any;

/**
 * Register a Log10x tool, pulling its title / description / annotations from
 * the package-baked `default-manifest.json`. Each call site only carries the
 * concrete schema + handler — copy lives in JSON, edited as a manifest, and
 * remote overrides patch it at boot.
 *
 * Throws synchronously if the tool name has no entry in default-manifest.json
 * (build-time guard against drift between code and manifest).
 */
// Pending registrations queue. Top-level registerLog10xTool() calls
// push here at module load (before mode detection runs). After
// initBootMode() resolves the mode in main(), applyToolRegistrations()
// drains the queue and registers only the tools whose TOOL_MODES
// entry includes the current boot mode. Tools registered before
// bootMode is set (e.g. integration tests that bypass main()) fall
// through to a permissive register-everything path.
type PendingTool = {
  name: string;
  inputSchema: Record<string, unknown>;
  handler: (
    args: any,
    extra?: { sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void> }
  ) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
};
const pendingTools: PendingTool[] = [];

function registerLog10xTool(
  name: string,
  inputSchema: Record<string, unknown>,
  handler: (
    args: any,
    extra?: { sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void> }
  ) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>
): void {
  // Validate manifest entry at queue-time so the build-time guard still
  // catches missing default-manifest.json entries before main() runs.
  getPackageDefaultTool(name);
  pendingTools.push({ name, inputSchema, handler });
}

/**
 * Drain the pending registration queue against the server, gated by
 * the current boot mode. Tools not allowed in this mode are skipped
 * entirely (they will not appear in tools/list). Called from main()
 * after initBootMode() resolves the operating mode.
 */
function applyToolRegistrations(): { registered: string[]; skipped: string[] } {
  const mode = bootMode?.mode;
  const registered: string[] = [];
  const skipped: string[] = [];
  for (const t of pendingTools) {
    const allowed = mode ? shouldRegisterTool(t.name, mode) : true;
    if (!allowed) {
      skipped.push(t.name);
      continue;
    }
    const meta = getPackageDefaultTool(t.name);
    (server.registerTool as any)(
      t.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: t.inputSchema,
        annotations: meta.annotations,
      },
      t.handler
    );
    registered.push(t.name);
  }
  return { registered, skipped };
}

// ── Tool: log10x_event_lookup ──

registerLog10xTool('log10x_event_lookup', eventLookupSchema, (args) =>
  wrap('log10x_event_lookup', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    const cost = await getAnalyzerCost(env, args.analyzerCost);
    return executeEventLookup({ ...args, analyzerCost: cost }, env);
  })
);

// ── Tool: log10x_pattern_examples ──
//
// Orchestration primitive for fetching live SIEM events for one pattern
// with template-extracted slot values. Designed for `log10x_investigate`
// (or another orchestrator) to call autonomously when the chain needs
// event evidence. See memory/project_pattern_examples_design.md for the
// full design contract — read before changing this tool's shape.

registerLog10xTool('log10x_pattern_examples', patternExamplesSchema, (args) =>
  wrap('log10x_pattern_examples', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executePatternExamples(args, env);
  })
);

// ── Tool: log10x_savings ──

registerLog10xTool('log10x_savings', savingsSchema, (args) =>
  wrap('log10x_savings', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    const cost = await getAnalyzerCost(env, args.analyzerCost);
    return executeSavings({ ...args, analyzerCost: cost }, env);
  })
);

// ── Tool: log10x_pattern_trend ──

registerLog10xTool('log10x_pattern_trend', trendSchema, (args) =>
  wrap('log10x_pattern_trend', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    const cost = await getAnalyzerCost(env, args.analyzerCost);
    return executeTrend({ ...args, analyzerCost: cost }, env);
  })
);

// ── Tool: log10x_dependency_check ──

registerLog10xTool('log10x_dependency_check', dependencyCheckSchema, (args) =>
  wrap('log10x_dependency_check', async () => executeDependencyCheck(args))
);

// ── Tool: log10x_configure_env ──
// Conversational onboarding entry point. Takes a backend config
// (discriminated union by kind), runs the live-backend validator,
// and on success persists to ~/.log10x/envs.json. Every metric tool
// surfaces this tool's name in its `not_configured` response so the
// agent knows how to drive setup.

registerLog10xTool('log10x_configure_env', configureEnvSchema, (args) =>
  wrap('log10x_configure_env', async () => {
    return executeConfigureEnv(args);
  })
);

// ── Tool: log10x_top_patterns ──

registerLog10xTool('log10x_top_patterns', topPatternsSchema, (args) =>
  wrap('log10x_top_patterns', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    const cost = await getAnalyzerCost(env, args.analyzerCost);
    return executeTopPatterns({ ...args, analyzerCost: cost }, env);
  })
);

// ── Tool: log10x_services ──

registerLog10xTool('log10x_services', servicesSchema, (args) =>
  wrap('log10x_services', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    const cost = await getAnalyzerCost(env, args.analyzerCost);
    return executeServices({ ...args, analyzerCost: cost }, env);
  })
);

// ── Tool: log10x_discover_labels ──

registerLog10xTool('log10x_discover_labels', discoverLabelsSchema, (args) =>
  wrap('log10x_discover_labels', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeDiscoverLabels(args, env);
  })
);

// ── Tool: log10x_investigate ──

registerLog10xTool('log10x_investigate', investigateSchema, (args) =>
  wrap('log10x_investigate', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeInvestigate(args, env);
  })
);

// ── Tool: log10x_resolve_batch ──

// ── Tool: log10x_find_skew ──

registerLog10xTool('log10x_find_skew', findSkewSchema, (args) =>
  wrap('log10x_find_skew', async () => executeFindSkew(args))
);

// ── Tool: log10x_find_constant_slots ──

registerLog10xTool('log10x_find_constant_slots', findConstantSlotsSchema, (args) =>
  wrap('log10x_find_constant_slots', async () => executeFindConstantSlots(args))
);

// ── Tool: log10x_find_uuid_in_body ──

registerLog10xTool('log10x_find_uuid_in_body', findUuidInBodySchema, (args) =>
  wrap('log10x_find_uuid_in_body', async () => executeFindUuidInBody(args))
);

// ── Tool: log10x_find_incident_cluster ──

registerLog10xTool('log10x_find_incident_cluster', findIncidentClusterSchema, (args) =>
  wrap('log10x_find_incident_cluster', async () => executeFindIncidentCluster(args))
);

registerLog10xTool('log10x_resolve_batch', resolveBatchSchema, (args) =>
  wrap('log10x_resolve_batch', async () => executeResolveBatch(args))
);

// ── Tool: log10x_extract_templates ──

registerLog10xTool('log10x_extract_templates', extractTemplatesSchema, (args) =>
  wrap('log10x_extract_templates', async () => executeExtractTemplates(args))
);

// ── Tool: log10x_retriever_query ──

registerLog10xTool('log10x_retriever_query', retrieverQuerySchema, (args) =>
  wrap('log10x_retriever_query', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeRetrieverQuery(args, env);
  })
);

// ── Tool: log10x_retriever_series ──

registerLog10xTool('log10x_retriever_series', retrieverSeriesSchema, (args) =>
  wrap('log10x_retriever_series', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeRetrieverSeries(args, env);
  })
);

// ── Tool: log10x_backfill_metric ──

registerLog10xTool('log10x_backfill_metric', backfillMetricSchema, (args) =>
  wrap('log10x_backfill_metric', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeBackfillMetric(args, env);
  })
);

// ── Tool: log10x_doctor ──

registerLog10xTool('log10x_doctor', doctorSchema, (args) =>
  wrap('log10x_doctor', async () => executeDoctor(args))
);

// ── Tool: log10x_login_status ──

registerLog10xTool('log10x_login_status', loginStatusSchema, () =>
  wrap('log10x_login_status', async () => executeLoginStatus({}, getEnvs()))
);

// ── Tool: log10x_signin_start ──
//
// Step 1 of the sign-in chain: requests an Auth0 device code, opens the
// user's browser, and returns the user_code + device_code immediately.
// Returns synchronously (no polling) because Cursor and most other MCP
// hosts do NOT render mid-tool `notifications/message` push, so the
// only reliable way to surface the user_code to a human is to put it
// in the tool's response markdown. The model then calls
// `log10x_signin_complete` with the device_code to finish the flow.

registerLog10xTool('log10x_signin_start', signinStartSchema, () =>
  wrap('log10x_signin_start', async () => executeSigninStart())
);

// ── Tool: log10x_signin_complete ──
//
// Step 2 of the sign-in chain. Two paths via mutually-exclusive args:
//   - { device_code }: finishes a browser flow started by `_start`.
//     Polls Auth0 until the user confirms in the browser, then
//     exchanges the access token for a Log10x API key.
//   - { api_key }:     pasted-key path. Validates the key against
//     /api/v1/user and persists. No browser, no IdP.
// Either path writes the resolved API key to ~/.log10x/credentials,
// hot-reloads envs in-process, and clears any overriding
// LOG10X_API_KEY env var so the new key wins the priority chain.

registerLog10xTool('log10x_signin_complete', signinCompleteSchema, (args) =>
  wrap('log10x_signin_complete', async () => executeSigninComplete(args, getEnvs()))
);

// ── Tool: log10x_signout ──

registerLog10xTool('log10x_signout', signoutSchema, () =>
  wrap('log10x_signout', async () => executeSignout({}, getEnvs()))
);

// ── Tool: log10x_update_settings ──

registerLog10xTool('log10x_update_settings', updateSettingsSchema, (args) =>
  wrap('log10x_update_settings', async () => executeUpdateSettings(args, getEnvs()))
);

// ── Tool: log10x_create_env ──

registerLog10xTool('log10x_create_env', createEnvSchema, (args) =>
  wrap('log10x_create_env', async () => executeCreateEnv(args, getEnvs()))
);

// ── Tool: log10x_update_env ──

registerLog10xTool('log10x_update_env', updateEnvSchema, (args) =>
  wrap('log10x_update_env', async () => executeUpdateEnv(args, getEnvs()))
);

// ── Tool: log10x_delete_env ──

registerLog10xTool('log10x_delete_env', deleteEnvSchema, (args) =>
  wrap('log10x_delete_env', async () => executeDeleteEnv(args, getEnvs()))
);

// ── Tool: log10x_rotate_api_key ──

registerLog10xTool('log10x_rotate_api_key', rotateApiKeySchema, (args) =>
  wrap('log10x_rotate_api_key', async () => executeRotateApiKey(args, getEnvs()))
);

// ── Tool: log10x_customer_metrics_query (v1.4) ──

registerLog10xTool('log10x_customer_metrics_query', customerMetricsQuerySchema, (args) =>
  wrap('log10x_customer_metrics_query', async () => executeCustomerMetricsQuery(args))
);

// ── Tool: log10x_discover_join (v1.4) ──

registerLog10xTool('log10x_discover_join', discoverJoinSchema, (args) =>
  wrap('log10x_discover_join', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeDiscoverJoin(args, env);
  })
);

// ── Tool: log10x_correlate_cross_pillar (v1.4) ──

registerLog10xTool('log10x_correlate_cross_pillar', correlateCrossPillarSchema, (args) =>
  wrap('log10x_correlate_cross_pillar', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeCorrelateCrossPillar(args, env);
  })
);

// ── Tool: log10x_translate_metric_to_patterns ──

registerLog10xTool(
  'log10x_translate_metric_to_patterns',
  translateMetricToPatternsSchema,
  (args) =>
    wrap('log10x_translate_metric_to_patterns', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeTranslateMetricToPatterns(args, env);
    })
);

// ── Tool: log10x_poc_from_siem_submit / _status ──
//
// Async pair: submit kicks off a background pull + templatize + render;
// status polls for progress and returns the final markdown once done.
// Supports 8 SIEMs (cloudwatch, datadog, sumo, gcp-logging, elasticsearch,
// azure-monitor, splunk, clickhouse) with auto-discovery of credentials.

registerLog10xTool('log10x_poc_from_siem_submit', pocFromSiemSubmitSchema, (args) =>
  wrap('log10x_poc_from_siem_submit', async () =>
    executePocSubmit({
      window: args.window ?? '7d',
      target_event_count: args.target_event_count ?? 250_000,
      max_pull_minutes: args.max_pull_minutes ?? 5,
      privacy_mode: args.privacy_mode ?? true,
      ai_prettify: args.ai_prettify ?? true,
      total_daily_gb: args.total_daily_gb,
      total_monthly_gb: args.total_monthly_gb,
      total_annual_gb: args.total_annual_gb,
      auto_detect_volume: args.auto_detect_volume ?? true,
      _mcpServer: server,
      siem: args.siem,
      scope: args.scope,
      query: args.query,
      analyzer_cost_per_gb: args.analyzer_cost_per_gb,
      environment: args.environment,
      clickhouse_table: args.clickhouse_table,
      clickhouse_timestamp_column: args.clickhouse_timestamp_column,
      clickhouse_message_column: args.clickhouse_message_column,
      clickhouse_service_column: args.clickhouse_service_column,
      clickhouse_severity_column: args.clickhouse_severity_column,
    })
  )
);

registerLog10xTool('log10x_poc_from_siem_status', pocFromSiemStatusSchema, (args) =>
  wrap('log10x_poc_from_siem_status', async () => executePocStatus(args))
);

// ── Tool: log10x_poc_from_local ──
//
// Local-source POC: pulls log lines from kubectl (and, in follow-up
// work, docker / journald) when no log-analyzer connection is
// available. Distinct from log10x_poc_from_siem in three ways:
//   1. No vendor credentials needed (uses ambient kubeconfig)
//   2. Cost framing is an industry-pricing matrix, NOT a prediction
//      of any specific bill — kubectl only sees pod stdout, not
//      CloudTrail / ALB / VM-hosted apps
//   3. Synchronous (kubectl pull is fast); no snapshot lifecycle
// The user must explicitly invoke this tool — there is NO automatic
// fallthrough from log10x_poc_from_siem when SIEM creds fail. Implicit
// fallthrough would let a prospect see local-source numbers framed as
// if they were SIEM bill predictions; explicit invocation forces the
// caller to acknowledge the framing change.

registerLog10xTool('log10x_poc_from_local', pocFromLocalSchema, (args) =>
  wrap('log10x_poc_from_local', async () =>
    executePocFromLocal({
      source: args.source ?? 'kubectl',
      namespace: args.namespace ?? 'default',
      window: args.window ?? '1h',
      per_pod_limit: args.per_pod_limit ?? 5000,
      max_pods: args.max_pods ?? 20,
      privacy_mode: args.privacy_mode ?? true,
    })
  )
);

// ── Tool: log10x_discover_env (install advisor) ──

registerLog10xTool('log10x_discover_env', discoverEnvSchema, (args) =>
  wrap('log10x_discover_env', () => executeDiscoverEnv(args))
);

// ── Tool: log10x_advise_reporter (install advisor) ──

registerLog10xTool('log10x_advise_reporter', adviseReporterSchema, (args) =>
  wrap('log10x_advise_reporter', () => executeAdviseReporter(args))
);

// ── Tool: log10x_advise_retriever (install advisor) ──

registerLog10xTool('log10x_advise_retriever', adviseRetrieverSchema, (args) =>
  wrap('log10x_advise_retriever', () => executeAdviseRetriever(args))
);

// ── Tool: log10x_advise_receiver (install advisor) ──

registerLog10xTool('log10x_advise_receiver', adviseReceiverSchema, (args) =>
  wrap('log10x_advise_receiver', () => executeAdviseReceiver(args))
);

// ── Tool: log10x_advise_install (mode selector + front-end advisor) ──

registerLog10xTool('log10x_advise_install', adviseInstallSchema, (args) =>
  wrap('log10x_advise_install', () => executeAdviseInstall(args))
);

// ── Tool: log10x_configure_compact (per-container compact decision PR author) ──

registerLog10xTool('log10x_configure_compact', configureCompactSchema, (args) =>
  wrap('log10x_configure_compact', () => executeConfigureCompact(args))
);

// ── Tool: log10x_configure_regulator (per-container cap from $ budget) ──

registerLog10xTool('log10x_configure_regulator', configureRegulatorSchema, (args) =>
  wrap('log10x_configure_regulator', () => executeConfigureRegulator(args))
);

// ── Tool: log10x_pattern_mitigate (cost-reduction menu) ──

registerLog10xTool('log10x_pattern_mitigate', patternMitigateSchema, (args) =>
  wrap('log10x_pattern_mitigate', () => executePatternMitigate(args))
);

// ── Resource: log10x://status ──

server.resource(
  'pipeline-status',
  'log10x://status',
  { description: 'Current pipeline health and volume summary', mimeType: 'text/plain' },
  async () => {
    const env = getEnvs().default;
    const text = await getStatus(env);
    return { contents: [{ uri: 'log10x://status', text, mimeType: 'text/plain' }] };
  }
);

// ── CLI flag handlers ──

const REGISTERED_TOOLS: Array<{ name: string; intent: string }> = [
  { name: 'log10x_event_lookup', intent: 'What is this single log line — resolve to stable identity + cost + AI classification' },
  { name: 'log10x_pattern_examples', intent: 'Recent live events for a pattern from the log analyzer with template-parsed slot values — bounded to 24h, for older use retriever_query' },
  { name: 'log10x_savings', intent: 'Pipeline ROI — how much receiver / retriever are saving in dollars' },
  { name: 'log10x_pattern_trend', intent: 'Time series for a pattern — volume + cost history, spike detection, sparkline' },
  { name: 'log10x_dependency_check', intent: 'Scan SIEM + dashboards + alerts for refs to a pattern before muting / deleting it' },
  { name: 'log10x_top_patterns', intent: 'Top N patterns by current cost, with per-row delta vs comparison_window and newly-emerged section' },
  { name: 'log10x_investigate', intent: 'Single-call root-cause — causal chain for acute spikes or cohort for drift' },
  { name: 'log10x_resolve_batch', intent: 'Pasted-batch triage — per-pattern variable concentration + next actions' },
  { name: 'log10x_retriever_query', intent: 'Direct archive retrieval by templateHash with JS filter expressions' },
  { name: 'log10x_retriever_series', intent: 'Fidelity-aware time series from the S3 archive — auto-selects exact aggregation vs sampled fan-out' },
  { name: 'log10x_backfill_metric', intent: 'Create a new Datadog / Prometheus metric backfilled from Retriever archive' },
  { name: 'log10x_doctor', intent: 'Startup health check — env config, gateway, tier, freshness, Retriever, paste endpoint, cross-pillar enrichment floor' },
  { name: 'log10x_login_status', intent: 'Report credential / env state — identity, env list with permissions, demo-mode upgrade guide if applicable' },
  { name: 'log10x_signin_start', intent: 'Step 1 of Auth0 Device Flow signup/signin: opens browser, returns the user_code + device_code so the model can surface them and chain to log10x_signin_complete' },
  { name: 'log10x_signin_complete', intent: 'Step 2 of sign-in: pass back the device_code from log10x_signin_start to finish the browser flow, OR pass api_key directly for pasted-key sign-in (no browser). Hot-reloads envs (no MCP-host restart needed)' },
  { name: 'log10x_signout', intent: 'Wipe ~/.log10x/credentials and fall back to demo mode (or lower-priority config); does not revoke the key on the backend' },
  { name: 'log10x_update_settings', intent: 'Update user metadata (analyzer cost, AI provider, etc.) via POST /api/v1/user' },
  { name: 'log10x_create_env', intent: 'Create a new Log10x environment on the account; pairs with log10x_advise_install for end-to-end provision-and-install' },
  { name: 'log10x_update_env', intent: 'Rename an env or change the default — requires backend PUT route (see backend PR #62)' },
  { name: 'log10x_delete_env', intent: 'Delete an env (destructive, irrecoverable) — requires confirm_name matching the env\'s name' },
  { name: 'log10x_rotate_api_key', intent: 'Rotate the Log10x API key (destructive) — old key invalidated immediately, new one persisted to ~/.log10x/credentials' },
  { name: 'log10x_customer_metrics_query', intent: 'Direct PromQL passthrough to the customer metric backend (escape hatch for cross-pillar investigations)' },
  { name: 'log10x_discover_join', intent: 'Auto-discover the join label between Log10x pattern metrics and the customer metric backend via Jaccard similarity' },
  { name: 'log10x_correlate_cross_pillar', intent: 'Bidirectional cross-pillar correlation with structural validation — confirmed / service-match / coincidence / unconfirmed tiering' },
  { name: 'log10x_poc_from_siem_submit', intent: 'Pull a sample from the user\'s SIEM, templatize, and render a full cost-optimization POC report (async)' },
  { name: 'log10x_poc_from_siem_status', intent: 'Poll or retrieve the final report from a log10x_poc_from_siem_submit run' },
  { name: 'log10x_poc_from_local', intent: 'Run the POC from local kubectl logs (no SIEM credentials needed); industry-pricing matrix instead of bill prediction' },
  { name: 'log10x_discover_env', intent: 'Read-only probe of k8s + AWS — returns a snapshot_id the advise_* tools consume' },
  { name: 'log10x_advise_install', intent: 'Front-end install advisor — picks standalone vs inline + app + forwarder + optimize based on what was detected' },
  { name: 'log10x_advise_reporter', intent: 'Reporter install/verify/teardown plan for a forwarder — inline or standalone (shape=standalone)' },
  { name: 'log10x_advise_receiver', intent: 'Receiver install/verify/teardown plan — inline only, with optional compact encoding (optimize=true)' },
  { name: 'log10x_advise_retriever', intent: 'Retriever install/verify/teardown plan — standalone S3 + SQS archive + query' },
  { name: 'log10x_configure_compact', intent: 'Resolve a service to its k8s_container set via Prometheus; emit a `gh` PR command against the compact cap-file CSV with per-container `true`/`false` decisions (engine hot-reloads the CSV without a pipeline restart)' },
  { name: 'log10x_configure_regulator', intent: 'Derive a per-container rate-regulator byte cap from a monthly dollar budget; validate against five Prometheus sanity checks; emit a `gh` PR command against the rate-cap CSV (engine hot-reloads it)' },
  { name: 'log10x_pattern_mitigate', intent: 'Return the env-gated mitigation options + exact configs for a pattern (drop @ analyzer, drop @ forwarder, mute @ 10x, compact @ 10x) in user terms with env-capability gating' },
];

async function handleCliFlags(): Promise<boolean> {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    // eslint-disable-next-line no-console
    console.log(`log10x-mcp ${readClientVersion()}`);
    return true;
  }
  if (args.includes('--list-tools')) {
    const maxNameLen = Math.max(...REGISTERED_TOOLS.map((t) => t.name.length));
    for (const t of REGISTERED_TOOLS) {
      // eslint-disable-next-line no-console
      console.log(`${t.name.padEnd(maxNameLen)}  ${t.intent}`);
    }
    return true;
  }
  if (args.includes('--doctor')) {
    try {
      const report = await runDoctorChecks();
      // eslint-disable-next-line no-console
      console.log(renderDoctorReport(report));
      process.exitCode = report.overall === 'fail' ? 1 : 0;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`Doctor failed to run: ${(e as Error).message}`);
      process.exitCode = 1;
    }
    return true;
  }
  if (args.includes('--help') || args.includes('-h')) {
    // eslint-disable-next-line no-console
    console.log(
      [
        'log10x-mcp — Log10x MCP server',
        '',
        'Usage: log10x-mcp [flag]',
        '',
        'Without flags, starts the MCP server over stdio for use by Claude Desktop, Cursor, etc.',
        '',
        'Flags:',
        '  --version, -v       Print the version and exit',
        '  --doctor            Run a startup health check and exit',
        '  --list-tools        Print the list of registered tools and exit',
        '  --help, -h          Print this help and exit',
        '',
        'Environment:',
        '  LOG10X_API_KEY            API key from console.log10x.com (or run `log10x_signin_start` then `log10x_signin_complete` to mint one via Auth0 Device Flow)',
        '  LOG10X_API_BASE           Override Prometheus gateway URL',
        '  __SAVE_LOG10X_RETRIEVER_URL__       Retriever query endpoint (optional)',
        '  LOG10X_PASTE_URL          Override Log10x paste endpoint (optional)',
        '  LOG10X_TENX_MODE          `local` (default) or `docker` — backend for privacy-mode tools',
        '  LOG10X_TENX_PATH          Path to local tenx CLI (used when LOG10X_TENX_MODE=local)',
        '  LOG10X_TENX_IMAGE         Docker image when LOG10X_TENX_MODE=docker (default: log10x/pipeline-10x:latest)',
        '  LOG10X_THRESHOLDS_FILE    JSON file overriding investigate engine thresholds',
        '  LOG10X_MCP_LOG_LEVEL      stderr log level (silent | error | warn | info | debug)',
        '  DATADOG_API_KEY           Datadog API key for backfill_metric destination',
        '',
      ].join('\n')
    );
    return true;
  }
  return false;
}

// ── Start ──

async function main() {
  if (await handleCliFlags()) return;
  // Eagerly resolve credentials before the server connects so any
  // configuration / network failure surfaces here with a clear
  // structured error instead of crashing on the first tool call from
  // the model, which is much harder to debug from a Claude Desktop log.
  try {
    await initEnvs();
  } catch (e) {
    if (e instanceof EnvironmentValidationError) {
      // eslint-disable-next-line no-console
      console.error(`\n[log10x-mcp] Configuration error:\n${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  // Detect operating mode (analysis | analysis_pending | poc) from
  // the TSDB-resolvability cascade. Bounded by 5s probe timeout. Sets
  // the module-scoped `bootMode` used by `wrap()` to gate out-of-mode
  // tool invocations with a clear reply rather than 5xx errors.
  await initBootMode();
  // Drain the pending tool registration queue, gated by boot mode.
  // Tools not allowed in this mode are skipped and will not appear
  // in tools/list. Tools that ARE registered still pass through the
  // wrap() handler-level mode gate as a defense-in-depth check.
  const regResult = applyToolRegistrations();
  log.info('mcp.tool_registration', {
    mode: bootMode?.mode,
    registered_count: regResult.registered.length,
    skipped_count: regResult.skipped.length,
    skipped: regResult.skipped,
  });
  // Plumb the envs reference into self-telemetry so the wrapper can
  // resolve which env each tool call acted on, and flush can drop counters
  // from read-only envs (incl. demo). Must happen AFTER initEnvs so the
  // first telemetry flush has a populated env list.
  setEnvsProvider(getEnvs);
  // Pull the remote manifest and patch tool metadata before the transport
  // connects. Network failure / disabled / cache miss all silently fall
  // through to the package-baked defaults — boot must succeed offline.
  const manifest = await loadManifest(readClientVersion());
  if (manifest) applyManifestToTools(manifest, registeredTools);
  const loaded = getEnvs();
  log.info('mcp.boot', {
    version: readClientVersion(),
    tools: REGISTERED_TOOLS.length,
    envs: loaded.all.length,
    default_env: loaded.default.nickname,
    demo_mode: loaded.isDemoMode,
    manifest_loaded: manifest !== null,
    boot_mode: bootMode?.mode,
    boot_mode_backend: bootMode?.detectionPath,
    boot_mode_probe_ms: bootMode?.probeDurationMs,
  });
  // Surface mode-detect resolution to stderr at boot so it shows up
  // in MCP-client logs without needing to call `log10x_doctor`.
  if (bootMode) {
    // eslint-disable-next-line no-console
    console.error(`[log10x-mcp] ${formatModeResolution(bootMode).split('\n')[0]}`);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', error);
  process.exit(1);
});
