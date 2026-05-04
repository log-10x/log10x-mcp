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

import { loadEnvironments, resolveEnv, type EnvConfig, type Environments, EnvironmentValidationError } from './lib/environments.js';
import { fetchAnalyzerCost } from './lib/api.js';
import { costDriversSchema, executeCostDrivers } from './tools/cost-drivers.js';
import { eventLookupSchema, executeEventLookup } from './tools/event-lookup.js';
import { savingsSchema, executeSavings } from './tools/savings.js';
import { trendSchema, executeTrend } from './tools/trend.js';
import { servicesSchema, executeServices } from './tools/services.js';
import { exclusionFilterSchema, executeExclusionFilter } from './tools/exclusion-filter.js';
import { dependencyCheckSchema, executeDependencyCheck } from './tools/dependency-check.js';
import { discoverLabelsSchema, executeDiscoverLabels } from './tools/discover-labels.js';
import { topPatternsSchema, executeTopPatterns } from './tools/top-patterns.js';
import { listByLabelSchema, executeListByLabel } from './tools/list-by-label.js';
import { resolveBatchSchema, executeResolveBatch } from './tools/resolve-batch.js';
import { extractTemplatesSchema, executeExtractTemplates } from './tools/extract-templates.js';
import {
  investigateSchema,
  executeInvestigate,
  investigationGetSchema,
  executeInvestigationGet,
} from './tools/investigate.js';
import { doctorSchema, executeDoctor, runDoctorChecks, renderDoctorReport } from './tools/doctor.js';
import { log } from './lib/log.js';
import { describeToolError } from './lib/tool-errors.js';
import { retrieverQuerySchema, executeRetrieverQuery } from './tools/retriever-query.js';
import { retrieverQueryStatusSchema, executeRetrieverQueryStatus } from './tools/retriever-query-status.js';
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
  translateMetricToPatternsSchema,
  executeTranslateMetricToPatterns,
} from './tools/translate-metric-to-patterns.js';
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
import { adviseCompactSchema, executeAdviseCompact } from './tools/advise-compact.js';
import { loginStatusSchema, executeLoginStatus } from './tools/login-status.js';
import { signinSchema, executeSignin } from './tools/signin.js';
import { signoutSchema, executeSignout } from './tools/signout.js';
import { updateSettingsSchema, executeUpdateSettings } from './tools/update-settings.js';
import { createEnvSchema, executeCreateEnv } from './tools/create-env.js';
import { updateEnvSchema, executeUpdateEnv } from './tools/update-env.js';
import { deleteEnvSchema, executeDeleteEnv } from './tools/delete-env.js';
import { rotateApiKeySchema, executeRotateApiKey } from './tools/rotate-api-key.js';
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

async function initEnvs(): Promise<void> {
  envs = await loadEnvironments();
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
function wrap(
  toolName: string,
  fn: () => Promise<string>
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const started = Date.now();
  return fn()
    .then((text) => {
      log.info(`tool.${toolName}.ok`, { ms: Date.now() - started });
      return { content: [{ type: 'text' as const, text: applyDemoBanner(text) }] };
    })
    .catch((e) => {
      const raw = e instanceof Error ? e.message : String(e);
      log.debug(`tool.${toolName}.raw_err`, { msg: raw });
      log.warn(`tool.${toolName}.err`, { ms: Date.now() - started, msg: raw });
      return {
        content: [{ type: 'text' as const, text: applyDemoBanner(describeToolError(toolName, e)) }],
        isError: true,
      };
    });
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
function applyDemoBanner(text: string): string {
  if (!envs?.isDemoMode) return text;
  if (envs.demoFallbackReason) {
    const reason = envs.demoFallbackReason.split('\n')[0].slice(0, 240);
    return (
      `> ⚠ **DEMO MODE — your LOG10X_API_KEY failed validation.** ` +
      `Account-scoped tools (cost_drivers, investigate, services, etc.) hit the public Log10x demo env, NOT your account. ` +
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
    instructions: `Log10x is the observability memory for the user's logs. Every log line the pipeline
has ever seen is fingerprinted into a stable pattern identity (field-set) that stays constant across
deploys, restarts, pod names, timestamps, and request IDs. That identity is the key to a Prometheus
time series of volume and cost, so any pattern the user has ever emitted is instantly queryable by
name, by history, or by sample line — with zero prior query setup.

CUSTOMER TIER LADDER (determines which tools are available)

1. Dev CLI only — free local binary, no pipeline infrastructure.
   Available tools: log10x_resolve_batch (pasted-batch triage), log10x_dependency_check,
                    log10x_exclusion_filter.
2. Cloud Reporter — k8s CronJob sampling from the SIEM via REST API.
   Adds: log10x_investigate (sampled fidelity), log10x_cost_drivers, log10x_pattern_trend,
         log10x_top_patterns, log10x_list_by_label, log10x_event_lookup, log10x_services,
         log10x_discover_labels, log10x_savings.
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
- "silence this for N hours" / "mute this pattern"               → log10x_exclusion_filter

Cost investigation:
- "what's expensive right now" / "top patterns by cost"          → log10x_top_patterns
- ANY framing of "the bill changed" — "bill jumped", "over forecast", "over budget",
  "costs spiked", "$N over", "why did costs go up", "who is responsible for the jump",
  "week-over-week delta"                                         → log10x_cost_drivers
  (Critical: use cost_drivers NOT top_patterns when the question is about CHANGE over
   time. top_patterns shows what's big right now; cost_drivers shows what GREW. A
   surprise bill is always a cost_drivers question first, then drill down.)
- "cost by namespace / service / severity / country"             → log10x_list_by_label
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
- "log me in" / "sign me up" / "create a Log10x account"         → log10x_signin
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
    log10x_cost_drivers  →  log10x_dependency_check  →  log10x_exclusion_filter

  Forensic retrieval across retention boundaries:
    log10x_event_lookup  →  log10x_retriever_query

  New metric from historical archive:
    log10x_cost_drivers or log10x_investigate  →  log10x_backfill_metric

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
- Do NOT compute percentages from before→after values in cost_drivers — the tool emits the
  exact (+N%) delta next to each row. Quote it. Do not re-derive it.
- Do NOT merge log10x_top_patterns output into a log10x_cost_drivers table. top_patterns is
  CURRENT RANK (biggest right now); cost_drivers is GROWTH (what changed). Mixing them into
  one ranked list and labeling the result "cost drivers" is a specific failure mode that
  produces fabricated week-over-week percentages. If you need both views, show them in two
  separate tables with clear headers.
- Do NOT invent "peak" values. top_patterns and cost_drivers return window averages, not peaks.
  If the user asks for peaks, call log10x_pattern_trend explicitly and quote its max bucket.
- Do NOT synthesize a baseline number. If cost_drivers does not list a pattern, that pattern
  is not a cost driver — do not promote it into the driver list with a made-up baseline.
- log10x_dependency_check has two output modes. When SIEM credentials are present in the env
  (DD_API_KEY, SPLUNK_HOST+SPLUNK_TOKEN, ELASTIC_URL+KIBANA_URL, AWS chain), the tool runs the
  scan in-process and returns ACTUAL dashboard/alert/saved-search/monitor/metric-filter names
  + URLs — header reads "Dependency Check — <Vendor> (executed)". Treat these as authoritative.
  When credentials are missing, the tool falls back to a paste-ready bash command — header
  reads "(paste-ready)". In that case do NOT report "zero dependencies found" or "safe to drop"
  — wait for the user to run the script and paste back its results.

Analyzer cost is auto-detected from the user's profile. Typical rates if unspecified:
Splunk $6/GB, Datadog $2.50/GB, Elasticsearch $1/GB, CloudWatch $0.50/GB.`,
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
function registerLog10xTool(
  name: string,
  inputSchema: Record<string, unknown>,
  handler: (
    args: any,
    extra?: { sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void> }
  ) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>
): void {
  const meta = getPackageDefaultTool(name);
  (server.registerTool as any)(
    name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema,
      annotations: meta.annotations,
    },
    handler
  );
}

// ── Tool: log10x_cost_drivers ──

registerLog10xTool('log10x_cost_drivers', costDriversSchema, (args) =>
  wrap('log10x_cost_drivers', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    const cost = await getAnalyzerCost(env, args.analyzerCost);
    return executeCostDrivers({ ...args, analyzerCost: cost }, env);
  })
);

// ── Tool: log10x_event_lookup ──

registerLog10xTool('log10x_event_lookup', eventLookupSchema, (args) =>
  wrap('log10x_event_lookup', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    const cost = await getAnalyzerCost(env, args.analyzerCost);
    return executeEventLookup({ ...args, analyzerCost: cost }, env);
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

// ── Tool: log10x_services ──

registerLog10xTool('log10x_services', servicesSchema, (args) =>
  wrap('log10x_services', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    const cost = await getAnalyzerCost(env, args.analyzerCost);
    return executeServices({ ...args, analyzerCost: cost }, env);
  })
);

// ── Tool: log10x_exclusion_filter ──

registerLog10xTool('log10x_exclusion_filter', exclusionFilterSchema, (args) =>
  wrap('log10x_exclusion_filter', async () => executeExclusionFilter(args))
);

// ── Tool: log10x_dependency_check ──

registerLog10xTool('log10x_dependency_check', dependencyCheckSchema, (args) =>
  wrap('log10x_dependency_check', async () => executeDependencyCheck(args))
);

// ── Tool: log10x_discover_labels ──

registerLog10xTool('log10x_discover_labels', discoverLabelsSchema, (args) =>
  wrap('log10x_discover_labels', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeDiscoverLabels(args, env);
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

// ── Tool: log10x_list_by_label ──

registerLog10xTool('log10x_list_by_label', listByLabelSchema, (args) =>
  wrap('log10x_list_by_label', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    const cost = await getAnalyzerCost(env, args.analyzerCost);
    return executeListByLabel({ ...args, analyzerCost: cost }, env);
  })
);

// ── Tool: log10x_investigate ──

registerLog10xTool('log10x_investigate', investigateSchema, (args) =>
  wrap('log10x_investigate', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeInvestigate(args, env);
  })
);

// ── Tool: log10x_investigation_get ──

registerLog10xTool('log10x_investigation_get', investigationGetSchema, (args) =>
  wrap('log10x_investigation_get', async () => executeInvestigationGet(args))
);

// ── Tool: log10x_resolve_batch ──

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

// ── Tool: log10x_retriever_query_status ──
//
// Pairs with log10x_retriever_query. Reads the CW log streams for an
// existing queryId and returns a fresh diagnostics snapshot — useful
// when a prior retriever_query reported partialResults: true (poll
// budget exceeded) or when an agent wants to verify a queryId's
// progress without paying the full S3 results poll again.

registerLog10xTool('log10x_retriever_query_status', retrieverQueryStatusSchema, (args) =>
  wrap('log10x_retriever_query_status', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeRetrieverQueryStatus(args, env);
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

// ── Tool: log10x_signin ──

registerLog10xTool('log10x_signin', signinSchema, (args, extra) =>
  wrap('log10x_signin', async () => executeSignin(args, getEnvs(), extra))
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

// ── Tool: log10x_translate_metric_to_patterns (v1.4) ──

registerLog10xTool('log10x_translate_metric_to_patterns', translateMetricToPatternsSchema, (args) =>
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

// ── Tool: log10x_advise_receiver (install advisor) ──

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

// ── Tool: log10x_advise_compact (compact-lookup PR author) ──

registerLog10xTool('log10x_advise_compact', adviseCompactSchema, (args) =>
  wrap('log10x_advise_compact', () => executeAdviseCompact(args))
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
  { name: 'log10x_cost_drivers', intent: 'Why did log costs spike this week — dollar-ranked patterns with week-over-week deltas' },
  { name: 'log10x_event_lookup', intent: 'What is this single log line — resolve to stable identity + cost + AI classification' },
  { name: 'log10x_savings', intent: 'Pipeline ROI — how much receiver / optimizer / retriever are saving in dollars' },
  { name: 'log10x_pattern_trend', intent: 'Time series for a pattern — volume + cost history, spike detection, sparkline' },
  { name: 'log10x_services', intent: 'List all monitored services ranked by cost' },
  { name: 'log10x_exclusion_filter', intent: 'Generate mute file entry or SIEM drop rule for a pattern' },
  { name: 'log10x_dependency_check', intent: 'Scan SIEM + dashboards + alerts for refs to a pattern before muting / deleting it' },
  { name: 'log10x_discover_labels', intent: 'List available labels and their values for filter / group-by queries' },
  { name: 'log10x_top_patterns', intent: 'Top N patterns by current cost (no baseline comparison)' },
  { name: 'log10x_list_by_label', intent: 'Rank any label dimension by cost — "cost by namespace / tenant / severity"' },
  { name: 'log10x_investigate', intent: 'Single-call root-cause — causal chain for acute spikes or cohort for drift' },
  { name: 'log10x_investigation_get', intent: 'Retrieve a prior investigation by id or list recent investigations' },
  { name: 'log10x_resolve_batch', intent: 'Pasted-batch triage — per-pattern variable concentration + next actions' },
  { name: 'log10x_extract_templates', intent: 'Extract structural templates from a log corpus via local tenx — optional min/required/forbidden-merge assertions' },
  { name: 'log10x_retriever_query', intent: 'Direct archive retrieval by templateHash with JS filter expressions' },
  { name: 'log10x_retriever_query_status', intent: 'Poll CloudWatch diagnostics for an existing retriever query (no S3 results re-fetch)' },
  { name: 'log10x_retriever_series', intent: 'Fidelity-aware time series from the S3 archive — auto-selects exact aggregation vs sampled fan-out' },
  { name: 'log10x_backfill_metric', intent: 'Create a new Datadog / Prometheus metric backfilled from Retriever archive' },
  { name: 'log10x_doctor', intent: 'Startup health check — env config, gateway, tier, freshness, Retriever, paste endpoint, cross-pillar enrichment floor' },
  { name: 'log10x_login_status', intent: 'Report credential / env state — identity, env list with permissions, demo-mode upgrade guide if applicable' },
  { name: 'log10x_signin', intent: 'Auth0 Device Flow signup/signin (user picks GitHub or Google). Opens browser, exchanges OAuth token for a Log10x API key, hot-reloads envs (no MCP-host restart needed)' },
  { name: 'log10x_signout', intent: 'Wipe ~/.log10x/credentials and fall back to demo mode (or lower-priority config); does not revoke the key on the backend' },
  { name: 'log10x_update_settings', intent: 'Update user metadata (analyzer cost, AI provider, etc.) via POST /api/v1/user' },
  { name: 'log10x_create_env', intent: 'Create a new Log10x environment on the account; pairs with log10x_advise_install for end-to-end provision-and-install' },
  { name: 'log10x_update_env', intent: 'Rename an env or change the default — requires backend PUT route (see backend PR #62)' },
  { name: 'log10x_delete_env', intent: 'Delete an env (destructive, irrecoverable) — requires confirm_name matching the env\'s name' },
  { name: 'log10x_rotate_api_key', intent: 'Rotate the Log10x API key (destructive) — old key invalidated immediately, new one persisted to ~/.log10x/credentials' },
  { name: 'log10x_customer_metrics_query', intent: 'Direct PromQL passthrough to the customer metric backend (escape hatch for cross-pillar investigations)' },
  { name: 'log10x_discover_join', intent: 'Auto-discover the join label between Log10x pattern metrics and the customer metric backend via Jaccard similarity' },
  { name: 'log10x_correlate_cross_pillar', intent: 'Bidirectional cross-pillar correlation with structural validation — confirmed / service-match / coincidence / unconfirmed tiering' },
  { name: 'log10x_translate_metric_to_patterns', intent: 'Given a customer APM metric, return the Log10x patterns whose rate curves correspond — with structural validation' },
  { name: 'log10x_poc_from_siem_submit', intent: 'Pull a sample from the user\'s SIEM, templatize, and render a full cost-optimization POC report (async)' },
  { name: 'log10x_poc_from_siem_status', intent: 'Poll or retrieve the final report from a log10x_poc_from_siem_submit run' },
  { name: 'log10x_poc_from_local', intent: 'Run the POC from local kubectl logs (no SIEM credentials needed); industry-pricing matrix instead of bill prediction' },
  { name: 'log10x_discover_env', intent: 'Read-only probe of k8s + AWS — returns a snapshot_id the advise_* tools consume' },
  { name: 'log10x_advise_install', intent: 'Front-end install advisor — picks standalone vs inline + app + forwarder + optimize based on what was detected' },
  { name: 'log10x_advise_reporter', intent: 'Reporter install/verify/teardown plan for a forwarder — inline or standalone (shape=standalone)' },
  { name: 'log10x_advise_receiver', intent: 'Receiver install/verify/teardown plan — inline only, with optional compact encoding (optimize=true)' },
  { name: 'log10x_advise_retriever', intent: 'Retriever install/verify/teardown plan — standalone S3 + SQS archive + query' },
  { name: 'log10x_advise_compact', intent: 'Render a `gh` PR command + diff for a compactReceiver lookup-CSV update against the customer GitOps repo (engine hot-reloads the CSV without a pipeline restart)' },
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
        '  LOG10X_API_KEY            API key from console.log10x.com (or run `log10x_signin` to mint one via Auth0 Device Flow)',
        '  LOG10X_API_BASE           Override Prometheus gateway URL',
        '  LOG10X_REGULATOR_RETRIEVER_URL       Retriever query endpoint (optional)',
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
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', error);
  process.exit(1);
});
