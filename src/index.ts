#!/usr/bin/env node

/**
 * Log10x MCP Server
 *
 * Gives AI assistants real-time access to per-pattern log cost attribution data.
 * Queries pre-aggregated Prometheus metrics — no log scanning, sub-second at any scale.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { recordStart, withTelemetry, setEnvsProvider } from './lib/self-telemetry.js';
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
import { adviseReducerSchema, executeAdviseReducer } from './tools/advise-reducer.js';
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
  { name: 'log10x', version: '1.4.0' },
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

// ── Self-telemetry hook ──
// Wrap every server.registerTool call so tool dispatches increment a counter
// (log10x_mcp_tool_call_total) that the Log10x console reads to detect MCP activity.
// Must run BEFORE any registerTool call. Silent no-op unless LOG10X_API_KEY +
// PROMETHEUS_REMOTE_WRITE_URL (or LOG10X_TELEMETRY_URL) are both set.
recordStart();
const _originalRegisterTool = server.registerTool.bind(server) as typeof server.registerTool;
(server as any).registerTool = ((name: string, schema: any, handler: any) => {
  const wrapped = withTelemetry(name, handler);
  return _originalRegisterTool(name as any, schema, wrapped);
}) as any;

// ── Tool: log10x_cost_drivers ──

server.registerTool(
  'log10x_cost_drivers',
  {
    title: 'Cost drivers',
    description: 'Answer "which log patterns made the bill jump this week" or "what changed since yesterday\'s deploy". Returns a dollar-ranked list of patterns whose cost grew versus a prior baseline, with before→after values, exact delta percentages, and new-pattern flags. **By default**: compares the current window against a 3-window average (e.g., timeRange=7d → avg of weeks 1, 2, 3 ago) to smooth noise. **For anchor-aligned deploy comparison**: pass `baselineOffsetDays` to compare against a single specific offset instead — `{timeRange: "1d", baselineOffsetDays: 1}` means "today vs yesterday", which is what you want for "did the deploy change anything". Attribution is keyed by **stable templateHash identity** that stays constant across query windows — Datadog Log Patterns and Splunk Pattern Explorer re-cluster per query, so their week-over-week diffs compare different clusters and are structurally unreliable. **Tier prerequisites**: requires a Reporter pipeline (Cloud or Edge).',
    inputSchema: costDriversSchema,
    annotations: { title: 'Cost drivers', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    wrap('log10x_cost_drivers', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      return executeCostDrivers({ ...args, analyzerCost: cost }, env);
    })
);

// ── Tool: log10x_event_lookup ──

server.registerTool(
  'log10x_event_lookup',
  {
    title: 'Event lookup',
    description: 'Resolve a raw log line or pattern name to its stable identity (field-set), then return cost per service, before→after delta, first-seen timestamp within the observation window, and an AI classification (error/debug/info) with a recommended action (filter/keep/reduce). **Call this first** whenever a user pastes a SINGLE log line and asks "what is this", "is this new", or "is this safe to drop". The lookup is structural, not byte-exact — different timestamps/request IDs/user IDs on the same underlying pattern resolve to the same identity. If no match is returned, say so honestly. Use log10x_resolve_batch instead when the user pastes MULTIPLE events, a SIEM dump, or a batch to triage. **Tier prerequisites**: requires Reporter pipeline for live pattern lookup. In CLI-only mode, use log10x_resolve_batch instead.',
    inputSchema: eventLookupSchema,
    annotations: { title: 'Event lookup', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    wrap('log10x_event_lookup', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      return executeEventLookup({ ...args, analyzerCost: cost }, env);
    })
);

// ── Tool: log10x_savings ──

server.registerTool(
  'log10x_savings',
  {
    title: 'Pipeline savings',
    description: 'Show pipeline savings — how much the reducer (filtering), optimizer (compaction), and retriever (indexing) are saving in dollars. Use for "how much are we saving", "pipeline ROI", or "what is the Log10x stack worth financially". **Tier prerequisites**: requires Reporter pipeline. Savings attribution requires per-app continuous metric emission.',
    inputSchema: savingsSchema,
    annotations: { title: 'Pipeline savings', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    wrap('log10x_savings', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      return executeSavings({ ...args, analyzerCost: cost }, env);
    })
);

// ── Tool: log10x_pattern_trend ──

server.registerTool(
  'log10x_pattern_trend',
  {
    title: 'Pattern trend',
    description: 'Return the volume + cost history for a single pattern over a chosen window (e.g. 1h, 24h, 7d, 30d), with a sparkline and spike detection. **Call this after log10x_event_lookup** when the user asks "is this getting worse", "has it been louder before", "when did it start", or wants temporal context on a pattern surfaced in an earlier step. Always state the observation window explicitly in the reply — "flat at 2/h for the last 6 months of observation, spiked at 13:58 today" — and never claim history older than the window. **Tier prerequisites**: requires Reporter pipeline. Time series queries need continuous metric emission.',
    inputSchema: trendSchema,
    annotations: { title: 'Pattern trend', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    wrap('log10x_pattern_trend', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      return executeTrend({ ...args, analyzerCost: cost }, env);
    })
);

// ── Tool: log10x_services ──

server.registerTool(
  'log10x_services',
  {
    title: 'Services',
    description: 'List every service the Log10x pipeline is watching, ranked by cost with per-service volume and share of total. Call first on open-ended cost questions, before drilling into a specific service. **Tier prerequisites**: requires Reporter pipeline.',
    inputSchema: servicesSchema,
    annotations: { title: 'Services', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    wrap('log10x_services', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      return executeServices({ ...args, analyzerCost: cost }, env);
    })
);

// ── Tool: log10x_exclusion_filter ──

server.registerTool(
  'log10x_exclusion_filter',
  {
    title: 'Exclusion filter snippet',
    description: 'Generate a config snippet to silence or reduce a log pattern. Produces either (a) a Log10x rate reducer mute-file entry keyed by field-set with explicit sampleRate and untilEpochSec expiry (the preferred path — self-expiring, git-reviewable, no regex), or (b) a native drop rule for the user\'s forwarder or SIEM (Datadog, Splunk, Elasticsearch, CloudWatch, Fluent Bit, OTel Collector, Vector, and others). Call when the user asks to "mute", "silence", "drop", "cap", or "reduce" a specific pattern. Always run log10x_dependency_check first so the reply can flag anything that will break. **Tier prerequisites**: none. Generates mute file entries independent of the Reporter tier.',
    inputSchema: exclusionFilterSchema,
    annotations: { title: 'Exclusion filter snippet', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (args) => wrap('log10x_exclusion_filter', async () => executeExclusionFilter(args))
);

// ── Tool: log10x_dependency_check ──

server.registerTool(
  'log10x_dependency_check',
  {
    title: 'Dependency check command',
    description: 'Given a pattern identity, generate commands to scan the user\'s SIEM/observability stack (Datadog monitors, Splunk saved searches, Grafana dashboards, Prometheus alert rules) for anything that depends on that pattern. **Call this before any mute, drop, or source-code deletion** — deleting a log line that feeds a live alert silently breaks the alert. Also call when a developer asks "am I allowed to delete this log.info() call" or "what references this pattern". This is the blast-radius check that turns a risky refactor into a reviewed one. **Tier prerequisites**: none. Operates against the customer\'s SIEM, dashboards, and alert surfaces via Bash + credentials.',
    inputSchema: dependencyCheckSchema,
    annotations: { title: 'Dependency check command', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (args) => wrap('log10x_dependency_check', async () => executeDependencyCheck(args))
);

// ── Tool: log10x_discover_labels ──

server.registerTool(
  'log10x_discover_labels',
  {
    title: 'Discover labels',
    description: 'List the labels Log10x metrics can be filtered or grouped by. Call at the start of a session, or before calling any tool that takes a label/filter argument — stops the model from guessing label names like "namespace" when the real name is "k8s_namespace". Pass a label name to get its distinct values. **Tier prerequisites**: requires Reporter pipeline.',
    inputSchema: discoverLabelsSchema,
    annotations: { title: 'Discover labels', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    wrap('log10x_discover_labels', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeDiscoverLabels(args, env);
    })
);

// ── Tool: log10x_top_patterns ──

server.registerTool(
  'log10x_top_patterns',
  {
    title: 'Top patterns',
    description: 'Return the top N log patterns by current cost, with no baseline comparison or filtering gate. Use for "what is expensive right now", "what are the noisy patterns in <service> this hour", or "give me a snapshot of my loudest events". Can be scoped by service label. For "what changed this week" (deltas vs baseline) use log10x_cost_drivers instead; for "why did costs spike" always prefer cost_drivers because this tool has no new-pattern flag. **Tier prerequisites**: requires Reporter pipeline.',
    inputSchema: topPatternsSchema,
    annotations: { title: 'Top patterns', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    wrap('log10x_top_patterns', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      return executeTopPatterns({ ...args, analyzerCost: cost }, env);
    })
);

// ── Tool: log10x_list_by_label ──

server.registerTool(
  'log10x_list_by_label',
  {
    title: 'List by label',
    description: 'Rank the distinct values of any label by cost. Use for "cost by namespace", "cost by severity", "cost by country", "cost by container", or any other group-by question. Call log10x_discover_labels first if unsure which label names are valid. **Tier prerequisites**: requires Reporter pipeline.',
    inputSchema: listByLabelSchema,
    annotations: { title: 'List by label', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    wrap('log10x_list_by_label', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      return executeListByLabel({ ...args, analyzerCost: cost }, env);
    })
);

// ── Tool: log10x_investigate ──

server.registerTool(
  'log10x_investigate',
  {
    title: 'Investigate',
    description: 'Single-call root-cause investigation for any log line, pattern, service, or environment. Returns a complete causal chain (for acute spikes) or co-drifter cohort (for gradual drift) with confidence scores derived mechanically from data signal quality, plus ready-to-run verification commands. Call whenever the user asks "what is going on with X", "why is X spiking", "investigate X", "what is causing this alert", "why is X creeping", or pastes a log line / alert and asks for diagnosis. Input is the user\'s natural-language target — pass their words verbatim. The tool detects whether the input is a raw log line, pattern identity, service name, or "environment" and runs the appropriate flow. It also detects whether the trajectory is an acute spike or gradual drift and renders a different report shape for each. **Structural wedge**: surfaces log-only signals (connection pool saturation, cache eviction storms, feature-flag cache flushes, retry amplification) that APM does NOT see because they manifest as slow-success traces rather than errors — this is why the tool catches causal chains that Datadog APM, Splunk APM, and OpenTelemetry tracing structurally cannot catch. Show the entire markdown report to the user without modification. Confidence percentages decompose into named sub-scores (stat × lag × chain for acute; slope_sig × cohort for drift) — walk the user through the decomposition when asked. **Tier prerequisites**: requires Reporter pipeline (Cloud or Edge). Drift detection requires continuous historical metrics — the CLI-only mode cannot do slope-similarity correlation. For direct forensic retrieval of specific historical events, use log10x_retriever_query instead. For metric backfill from the archive, use log10x_backfill_metric instead. **Example**: `{"starting_point": "payments-svc", "window": "1h", "depth": "normal"}` for a service-mode acute-spike investigation, or `{"starting_point": "environment", "window": "7d"}` for an env-wide audit.',
    inputSchema: investigateSchema,
    annotations: { title: 'Investigate', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    wrap('log10x_investigate', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeInvestigate(args, env);
    })
);

// ── Tool: log10x_investigation_get ──

server.registerTool(
  'log10x_investigation_get',
  {
    title: 'Get prior investigation',
    description: 'Retrieve a prior log10x_investigate report by investigation_id, or list the most recent investigations in this session. Call when the user references a prior investigation ("expand on investigation abc123", "what did we find last time", "show me that report again") or when you need to cross-reference patterns across multiple investigations in the same session without re-running the correlation. Session-local — the cache dies with the process and holds the 50 most recent investigations.',
    inputSchema: investigationGetSchema,
    annotations: { title: 'Get prior investigation', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (args) => wrap('log10x_investigation_get', async () => executeInvestigationGet(args))
);

// ── Tool: log10x_resolve_batch ──

server.registerTool(
  'log10x_resolve_batch',
  {
    title: 'Resolve batch',
    description: 'Templatize a batch of log events and return structured per-pattern triage with variable concentrations and next-action suggestions. **This is one of two tools that ACTUALLY RUN A LOCAL LOG10X PIPELINE on the user\'s machine** (the other is `log10x_extract_templates`) — call this whenever the user asks "can you run log10x locally", "do a local pipeline run", "templatize these events", or supplies any batch of events to analyze: a pasted Datadog/Splunk/Elastic query result, a Slack incident with attached log lines, kubectl logs output, any raw log text dump. Does NOT need Kubernetes, a deployed Reporter, or a Log10x account — the pipeline runs in-process on the host. Input is the events themselves (file path, inline array, or raw text). Output structures the batch by stable templateHash, per-pattern frequency and severity, full template structure, and per-slot variable value distribution (answering "for whom is this happening" within the batch). Each pattern in the output carries next_actions suggesting log10x_investigate (for historical correlation), log10x_retriever_query (for archive retrieval), and native SIEM commands with the dominant variable filter pre-constructed. Do NOT call for single-line resolution — use log10x_event_lookup for that. Variable naming honest: structured-log slots get high-confidence names from JSON/logfmt keys; free-text slots with natural-language tokens get medium-confidence inferred names with "(inferred)" annotation; positional-only slots get "slot N" with no hallucinated name. **Two execution paths**: (a) `privacy_mode=true` (DEFAULT) — events stay on the host: the MCP spawns a local `tenx` binary OR a `docker run log10x/pipeline-10x` container (controlled by `LOG10X_TENX_MODE=local|docker`). The container path requires Docker Desktop / docker daemon running on the host; if it errors with `DockerNotAvailableError`, tell the user to start Docker Desktop. (b) `privacy_mode=false` — routes through the public Log10x paste endpoint (~100 KB limit, internet required, raw log text leaves the host). **Example**: `{"source": "text", "text": "2026-04-13 ERROR checkout-svc ...\\n2026-04-13 INFO ..."}` for a pasted Slack dump, or `{"source": "file", "path": "/tmp/incident.log", "top_n_patterns": 10}` for a local file.',
    inputSchema: resolveBatchSchema,
    annotations: { title: 'Resolve batch', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) => wrap('log10x_resolve_batch', async () => executeResolveBatch(args))
);

// ── Tool: log10x_extract_templates ──

server.registerTool(
  'log10x_extract_templates',
  {
    title: 'Extract templates',
    description: 'Extract the structural template library from a log corpus by RUNNING A LOCAL LOG10X PIPELINE on the user\'s machine. Returns per-template identity (stable templateHash), template body with variable slots, and event count. Companion to `log10x_resolve_batch` — both tools are the answer to "can you run log10x locally / do a local pipeline run / templatize these events". Does NOT need Kubernetes, a deployed Reporter, or a Log10x account; the pipeline runs in-process on the host via either a locally-installed `tenx` binary or a `docker run log10x/pipeline-10x` container (controlled by `LOG10X_TENX_MODE=local|docker`). The docker path requires Docker Desktop / docker daemon running on the host; if it errors with `DockerNotAvailableError`, tell the user to start Docker Desktop. Use for: (a) bootstrapping a pattern catalog before wiring up a Reporter, (b) offline auditing of archived log corpora, (c) validating that a config change produces expected template identities (pass `expected` assertions). Input: inline events, raw text, or a file path/glob. **Validation mode**: pass `expected.min_templates`, `expected.required_patterns`, and/or `expected.forbidden_merges` to turn extraction into assertion-checked validation — each assertion reports PASS/FAIL in the output. **Example**: `{"source": "events", "events": ["ERROR checkout-svc ...", "INFO cart-svc ..."], "expected": {"min_templates": 2, "forbidden_merges": [["checkout", "cart"]]}}` to assert the two services produce separate templates.',
    inputSchema: extractTemplatesSchema,
    annotations: { title: 'Extract templates', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) => wrap('log10x_extract_templates', async () => executeExtractTemplates(args))
);

// ── Tool: log10x_retriever_query ──

server.registerTool(
  'log10x_retriever_query',
  {
    title: 'Retriever query',
    description: 'Direct retrieval of historical events from the Log10x Retriever archive (customer\'s S3 bucket) by stable pattern identity, with optional JavaScript filter expressions over event payloads. Call when: (a) the user asks for specific events matching a pattern over a time window that is OUTSIDE the SIEM\'s retention, (b) the user asks to retrieve events filtered by a variable value that is NOT a faceted dimension in their SIEM (e.g., "all payment_retry events for customer acme-corp from 90 days ago"), (c) compliance, legal, audit, or forensic workflows need exact event retrieval with stable identity. Do NOT call when the events are in the SIEM\'s current retention and can be queried natively faster, or when the user wants aggregated metrics over time instead of specific events (use log10x_backfill_metric or log10x_investigate instead). No re-ingestion. No proprietary format. The archive is in the customer\'s own S3 bucket and queries are scoped to the matching templateHash via pre-computed Bloom filters so only relevant byte ranges are fetched. Three output formats: events (raw with metadata), count (distribution summary), aggregated (bucketed time series). **Tier prerequisites**: requires Retriever component deployed. Does NOT require Reporter. Returns a graceful "Retriever not configured" message when LOG10X_REGULATOR_RETRIEVER_URL is unset. **Example**: `{"pattern": "payment_retry_attempt", "from": "now-90d", "to": "now-15d", "filters": ["event.customer_id === \\"acme-corp-inc\\""], "format": "events", "limit": 10000}` for a 90-day legal forensic retrieval.',
    inputSchema: retrieverQuerySchema,
    annotations: { title: 'Retriever query', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
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

server.registerTool(
  'log10x_retriever_query_status',
  {
    title: 'Retriever query status',
    description:
      'Poll the CloudWatch diagnostics for an in-flight or recently-completed retriever query. ' +
      'Use when a prior `log10x_retriever_query` reported `partialResults: true` (MCP poll budget exceeded ' +
      'before the server query finished), or when the agent wants to verify a queryId\'s progress without ' +
      're-running the full query. Does NOT re-fetch result events from S3 — only reads the per-query CW ' +
      'log streams and returns a structured snapshot of plan, scan stats, worker stats, and a status verdict ' +
      '(complete / in-flight / scan pending / unknown). To fetch events, re-run `log10x_retriever_query`. ' +
      '**Tier prerequisites**: same as `log10x_retriever_query`; additionally requires `LOG10X_RETRIEVER_LOG_GROUP` ' +
      'to point at the retriever\'s per-query CW log group. **Example**: `{"queryId": "abc123", "queryStartedAt": 1777200000000}`.',
    inputSchema: retrieverQueryStatusSchema,
    annotations: { title: 'Retriever query status', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    wrap('log10x_retriever_query_status', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeRetrieverQueryStatus(args, env);
    })
);

// ── Tool: log10x_retriever_series ──

server.registerTool(
  'log10x_retriever_series',
  {
    title: 'Retriever time series',
    description: 'Materialize a fidelity-aware time series from the customer\'s S3 archive over an arbitrary window, with optional group-by on enrichment fields. Auto-selects between exact full aggregation (Strategy A) and per-window-sampled fan-out (Strategy B) based on Reporter pattern volume — small/moderate-volume queries get exact counts; high-volume / long-window queries get a sampled series with time-distribution and group-ranking fidelity preserved and tail caveats reported. Pathological volume is refused with structured narrowing guidance, never silently truncated. Call when: (a) the user wants a "what is the rate of pattern X over the last 30 days, broken down by tenant" answer that exceeds the SIEM\'s retention or query budget, (b) a baseline needs building from cost-driver patterns where Prometheus has continuous metrics but the *grouped breakdown* lives only in the S3 archive, (c) any time series question over a window where you don\'t know in advance whether full aggregation will fit. Use `log10x_retriever_query` instead when you need the actual event payloads (not aggregates). Use `log10x_backfill_metric` instead when you want to push the resulting series to a TSDB rather than just see it. **Tier prerequisites**: requires Retriever deployed. Reporter is optional — when absent, mode selection falls back to window-length heuristic. **Example**: `{"search": "tenx_user_pattern == \\"PaymentRetry\\"", "from": "now-30d", "to": "now", "bucket_size": "1h", "group_by": "tenx_user_service", "fidelity": "auto"}` for a 30-day grouped baseline.',
    inputSchema: retrieverSeriesSchema,
    annotations: { title: 'Retriever time series', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    wrap('log10x_retriever_series', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeRetrieverSeries(args, env);
    })
);

// ── Tool: log10x_backfill_metric ──

server.registerTool(
  'log10x_backfill_metric',
  {
    title: 'Backfill metric',
    description: 'Define a new metric (Datadog, Prometheus remote_write) backfilled with historical data from the Log10x Retriever archive, with optional forward-emission handoff to the live Reporter for continuous population going forward. Call when: (a) the user wants to define a new SLO, alert, or dashboard metric that needs historical context from day one, (b) the customer did not pre-instrument the metric in their TSDB and cannot backfill it from the TSDB\'s own data, (c) historical events are available in the Retriever archive (typically 90-180 days back), (d) the user specifies a pattern, grouping dimensions, aggregation, and destination TSDB. Do NOT call when the metric already exists in the destination TSDB. **This is the single highest-value Log10x-only capability**: Datadog log-based metrics only work on currently-indexed data; Splunk log-based metrics only work over indexed retention; Cribl can emit forward but cannot backfill from archive; Athena + remote-write Lambda is possible but represents 2-4 weeks of data-engineering per metric. This tool collapses that to ~15 minutes of config. Tool runs the Retriever query, aggregates events into bucketed time series (count / sum_bytes / unique_values / rate_per_second), emits to the destination with historical timestamps preserved, and returns a view URL. Datadog and Prometheus (via remote_write adapter) are wired today; CloudWatch/Elastic/SignalFx return "not yet implemented". **Tier prerequisites**: requires Retriever component deployed. Reporter required only when emit_forward=true (default false in this build — the Reporter config update path for forward-emission handoff is not yet wired, so current usage is one-time historical backfill). **Example**: `{"pattern": "db_query_timeout", "metric_name": "log10x.db_query_timeout_by_tenant", "destination": "datadog", "bucket_size": "5m", "aggregation": "count", "from": "now-90d", "to": "now", "group_by": ["tenant_id"]}` for a 90-day Datadog backfill grouped by tenant.',
    inputSchema: backfillMetricSchema,
    annotations: { title: 'Backfill metric', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) =>
    wrap('log10x_backfill_metric', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeBackfillMetric(args, env);
    })
);

// ── Tool: log10x_doctor ──

server.registerTool(
  'log10x_doctor',
  {
    title: 'Doctor (health check)',
    description: 'Run a startup health check on the Log10x MCP installation. Probes: environment configuration validity, prometheus.log10x.com reachability and auth, Reporter tier detection (Edge / Cloud / none), Retriever endpoint configuration (informational), Datadog destination credentials (informational), paste endpoint reachability, cross-pillar enrichment floor (v1.4, when LOG10X_CUSTOMER_METRICS_URL is set). Returns a markdown report with pass / warn / fail per check and remediation hints. Call this once at the start of a session to verify the install, or any time a tool returns an unexpected error and you want to isolate whether the problem is configuration or transient. **Tier prerequisites**: none. Doctor checks never block; missing components produce warnings with remediation hints.',
    inputSchema: doctorSchema,
    annotations: { title: 'Doctor (health check)', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) => wrap('log10x_doctor', async () => executeDoctor(args))
);

// ── Tool: log10x_login_status ──

server.registerTool(
  'log10x_login_status',
  {
    title: 'Login status',
    description: 'List the user\'s Log10x ACCOUNT environments and report credential / login state. **Call this — and ONLY this — for any of these phrasings**: "which Log10x environments do I have", "which environments are available to me", "list my envs", "what tenants / accounts can I query", "show me my Log10x environments", "am I logged in", "switch envs". **For "log me in" / "sign me up" / "create a Log10x account" / "use my real account" — call `log10x_signin` instead**, which runs the one-click GitHub sign-up flow. **Do NOT call `log10x_discover_env` for these questions** — that tool scans the user\'s Kubernetes cluster + AWS account for forwarder/log10x-app deployments, which is unrelated to "which Log10x service environments does my account have access to". In demo mode (no LOG10X_API_KEY set, OR a key was set but failed validation), the response is a step-by-step config guide and a pointer to `log10x_signin` for the one-click flow. In signed-in mode, the response lists the user\'s identity, every Log10x env they can reach with permissions (OWNER/WRITE/READ), the default env, and the env most-recently used this session. Read-only — does not mutate any state. Takes no args. **Tier prerequisites**: none — runs in demo mode too.',
    inputSchema: loginStatusSchema,
    annotations: { title: 'Login status', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  () => wrap('log10x_login_status', async () => executeLoginStatus({}, getEnvs()))
);

// ── Tool: log10x_signin ──

server.registerTool(
  'log10x_signin',
  {
    title: 'Sign in to Log10x',
    description: 'Sign in to a Log10x account. **Call this for any of these phrasings**: "sign me up for Log10x", "create a Log10x account", "log me in to Log10x", "register me", "set up my Log10x account", "I want my own Log10x account instead of demo", "switch from demo to my own data". **BEFORE calling this tool, ask the user how they want to sign in** unless they\'ve already specified — there are two modes: (a) **`mode: "github"`** (default) runs the GitHub Device Flow: opens the user\'s browser to https://github.com/login/device with the user_code pre-filled, polls until they click Authorize, exchanges the GitHub token with the Log10x backend for a long-lived API key. Auto-creates a Log10x account on first signup (keyed by GitHub user id, default env named after the GitHub login), or returns the existing key on subsequent signins. Zero-click if the user has `gh auth login` set up. Pops a browser, takes 30s-2min. (b) **`mode: "api_key"` with `api_key: "<key>"`** validates a Log10x API key the user already has (e.g., copied from console.log10x.com → Profile → API Settings, or issued by their workspace admin) and saves it. No browser, no GitHub. Useful for users without GitHub or for workspace-issued credentials. Either path writes the resolved API key to `~/.log10x/credentials` (mode 0600), hot-reloads the MCP\'s env list in-process so the very next tool call runs against the new account, and (if `LOG10X_API_KEY` is set in the host config and would override the new file) clears that env var in-process and tells the user to also remove it from their host config to make the change permanent. **Tier prerequisites**: none. Idempotent — safe to call multiple times.',
    inputSchema: signinSchema,
    annotations: { title: 'Sign in', readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => wrap('log10x_signin', async () => executeSignin(args, getEnvs()))
);

// ── Tool: log10x_signout ──

server.registerTool(
  'log10x_signout',
  {
    title: 'Sign out of Log10x',
    description: 'Wipe the persistent credentials file at `~/.log10x/credentials` and reload envs so subsequent calls fall back to demo mode (or whichever lower-priority configuration source picks up). **Call this for**: "sign me out of Log10x", "log out", "remove my Log10x credentials", "stop using my Log10x account", "go back to demo mode". Idempotent — running it without saved credentials is a no-op. Does NOT revoke the API key on the BE; the user must do that from console.log10x.com → Profile → API Settings if they want to invalidate the key everywhere (mirrors `gh auth logout` and `aws sso logout`). If the user has `LOG10X_API_KEY` set in their MCP host config, that env var will still be active after sign-out — the tool result will flag this so the LLM can tell the user to also unset it and restart. **Tier prerequisites**: none.',
    inputSchema: signoutSchema,
    annotations: { title: 'Sign out', readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  () => wrap('log10x_signout', async () => executeSignout({}, getEnvs()))
);

// ── Tool: log10x_update_settings ──

server.registerTool(
  'log10x_update_settings',
  {
    title: 'Update Log10x account settings',
    description: 'Update the user\'s Log10x account metadata (analyzer cost ($/GB), AI provider settings, display name, etc.) via `POST /api/v1/user`. **Call this for**: "set my analyzer cost to $3", "switch my AI provider to OpenAI", "use my own Anthropic key", "disable AI", "update my company name". Idempotent — repeated calls converge to the same state. The metadata field is a free-form key/value object; common fields are documented in the schema. Existing fields not in the payload are preserved (PATCH-like semantics). On success, the in-process env list is reloaded so subsequent tool calls see the updated metadata immediately (e.g., new analyzer_cost is honored on the next cost_drivers run). **Tier prerequisites**: requires a real signed-in account — demo accounts cannot update metadata.',
    inputSchema: updateSettingsSchema,
    annotations: { title: 'Update account settings', readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => wrap('log10x_update_settings', async () => executeUpdateSettings(args, getEnvs()))
);

// ── Tool: log10x_create_env ──

server.registerTool(
  'log10x_create_env',
  {
    title: 'Create Log10x environment',
    description: 'Provision a new Log10x environment on the user\'s account via `POST /api/v1/user/env`. **Call this for**: "create a staging env", "I need a new environment for my dev cluster", "set up a separate env for ${customer-name}". Pairs naturally with the install advisor — after creating the env, call `log10x_advise_install` with the new env_id to get the Reporter / Reducer / Retriever install plan scoped to it. The new env\'s id is returned in the result so the LLM can chain. NOT idempotent — duplicate names are rejected with 409 Conflict; the tool pre-checks the in-memory env list to surface a friendly error before the round-trip. **Tier prerequisites**: requires a real signed-in account.',
    inputSchema: createEnvSchema,
    annotations: { title: 'Create environment', readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => wrap('log10x_create_env', async () => executeCreateEnv(args, getEnvs()))
);

// ── Tool: log10x_update_env ──

server.registerTool(
  'log10x_update_env',
  {
    title: 'Rename or set-default Log10x environment',
    description: 'Update an existing Log10x environment via `PUT /api/v1/user/env`: rename it, or change which env is the user\'s default. **Call this for**: "rename my staging env to dev", "make production the default", "set my main account as the default env". Idempotent. The env_id is required (get it from `log10x_login_status`). Pass at least one of `name` or `is_default`. **Tier prerequisites**: requires a real signed-in account AND the backend gateway to have the PUT route configured (see backend PR #62). Until that ships, the tool surfaces a clean error pointing at the console workaround.',
    inputSchema: updateEnvSchema,
    annotations: { title: 'Update environment', readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => wrap('log10x_update_env', async () => executeUpdateEnv(args, getEnvs()))
);

// ── Tool: log10x_delete_env ──

server.registerTool(
  'log10x_delete_env',
  {
    title: 'Delete Log10x environment (destructive)',
    description: 'Remove an environment from the user\'s Log10x account via `DELETE /api/v1/user/env`. **DESTRUCTIVE — irrecoverable.** Metric history scoped to the env is also lost. Backend rejects 401 if the caller is not the env owner. **Call this only when the user has explicitly asked to delete an env and confirmed the env name back.** The tool requires a `confirm_name` arg matching the env\'s exact display name (case-sensitive); if it doesn\'t match, the tool refuses without contacting the backend and shows the correct name. Mirrors `gh repo delete` and the GitHub web "type the repo name to confirm" pattern. **Best practice**: when the user says "delete X env", state the name and env_id back, ask for explicit confirmation, then call this with the confirmed name. **Tier prerequisites**: requires a real signed-in account with OWNER permission on the env.',
    inputSchema: deleteEnvSchema,
    annotations: { title: 'Delete environment', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) => wrap('log10x_delete_env', async () => executeDeleteEnv(args, getEnvs()))
);

// ── Tool: log10x_rotate_api_key ──

server.registerTool(
  'log10x_rotate_api_key',
  {
    title: 'Rotate Log10x API key (destructive)',
    description: 'Replace the user\'s Log10x API key with a freshly-minted UUID via `POST /api/v1/user/rotate-key`. **DESTRUCTIVE — the previous key is invalidated immediately on the backend.** Other devices / scripts / hosts holding the old key will start receiving `401 Unauthorized` on the next request. **Call this for**: "rotate my Log10x API key", "I think my key was leaked", "regenerate my API key". Requires a `confirm: "rotate-now"` literal to prevent accidental triggering — always ask the user to confirm before calling. On success the tool: writes the new key to `~/.log10x/credentials` (so other MCP hosts on this machine pick it up), clears any in-process `LOG10X_API_KEY` so the new key takes effect for THIS server immediately, hot-reloads envs. The new key is shown in the response (also viewable later at console.log10x.com → Profile → API Settings). The result message lists every place the user should update — host configs, scripts, CI secrets, etc. **Tier prerequisites**: requires a real signed-in account — demo accounts get 403 Forbidden.',
    inputSchema: rotateApiKeySchema,
    annotations: { title: 'Rotate API key', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  (args) => wrap('log10x_rotate_api_key', async () => executeRotateApiKey(args, getEnvs())),
);

// ── Tool: log10x_customer_metrics_query (v1.4) ──

server.registerTool(
  'log10x_customer_metrics_query',
  {
    title: 'Customer metrics query',
    description: 'Low-level PromQL passthrough to the customer metric backend configured via LOG10X_CUSTOMER_METRICS_URL. Returns the raw Prometheus response shape plus metadata about which backend served the query. This is the escape hatch for cross-pillar investigations the higher-level tools don\'t cover — use it to explore the customer backend\'s label universe, run a one-off PromQL expression, or verify that a specific metric exists before correlating against it. For typical cross-pillar workflows, prefer `log10x_translate_metric_to_patterns` (customer metric → log patterns) or `log10x_correlate_cross_pillar` (bidirectional). **Tier prerequisites**: requires LOG10X_CUSTOMER_METRICS_URL configured (grafana_cloud, amp, datadog_prom, or generic_prom backend type). This tool issues exactly 1 PromQL query against the customer backend. **Example**: `{"promql": "apm_request_duration_p99{service=\\"payments-svc\\"}", "mode": "instant"}`.',
    inputSchema: customerMetricsQuerySchema,
    annotations: { title: 'Customer metrics query', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) => wrap('log10x_customer_metrics_query', async () => executeCustomerMetricsQuery(args))
);

// ── Tool: log10x_discover_join (v1.4) ──

server.registerTool(
  'log10x_discover_join',
  {
    title: 'Discover join label',
    description: 'Auto-discover the structural join label between Log10x pattern metrics and the customer metric backend. Runs Jaccard similarity on label value sets across candidate label pairs, returns the best pair above the 0.7 threshold plus runner-ups above 0.5. The result is cached per-session keyed by (environment, customer-backend-endpoint) so the higher-level cross-pillar correlation tools can auto-run this once at session start and reuse the cached join without re-probing. Agents should normally NOT need to call this tool directly — `log10x_correlate_cross_pillar` and `log10x_translate_metric_to_patterns` call it internally. The explicit tool exists for power users who want to inspect the join universe or force a re-discovery after backend changes. When no pair crosses the threshold, returns a structured `no_join_available` response with the full probed-label matrix and recommended next actions. **Tier prerequisites**: requires LOG10X_CUSTOMER_METRICS_URL configured. This tool issues up to 12 PromQL queries (6 Log10x-side + 6 customer-side label value fetches) on first call; subsequent calls in the same session return the cached result. **Example**: `{"minimum_jaccard": 0.7}`.',
    inputSchema: discoverJoinSchema,
    annotations: { title: 'Discover join label', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    wrap('log10x_discover_join', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeDiscoverJoin(args, env);
    })
);

// ── Tool: log10x_correlate_cross_pillar (v1.4) ──

server.registerTool(
  'log10x_correlate_cross_pillar',
  {
    title: 'Correlate cross-pillar',
    description: 'Bidirectional cross-pillar correlation with structural validation. Takes an anchor that\'s either a Log10x pattern (`anchor_type: "log10x_pattern"`) OR a customer metric expression (`anchor_type: "customer_metric"`) and returns ranked co-movers from the OTHER pillar, tiered by structural validation confidence. **Four output tiers**: `confirmed` (full structural overlap on join key + at least one additional label — highest confidence), `service-match` (join key match but partial overlap — service-level issue affecting all instances), `unconfirmed` (temporal match but required Log10x enrichment labels missing — unknown causality, do not drill autonomously), `coincidence` (temporal match with NO structural overlap despite having both sides\' labels — this is coincidence, not causation, and the tool explicitly flags it as such). **The structural validation phase is the differentiating capability vs every other agent observability tool in 2026.** Every temporal Pearson ranker produces false positives on workloads that share a daily cycle; cross-pillar bridge filters these out by checking whether the candidate\'s metadata labels could plausibly overlap with the anchor\'s labels. When no structural join exists at all (e.g., node-level anchors against v1.4\'s service/pod/namespace/container label set), the tool returns a structured `no_join_available` refusal with probed-label diagnostics and recommended next actions — never a fall-through to temporal-only ranking. Refusal is a feature, not a failure. **Tier prerequisites**: requires LOG10X_CUSTOMER_METRICS_URL configured AND Reporter tier with k8s_pod / k8s_container / k8s_namespace / tenx_user_service enrichments (defaults on any fluent-k8s or filebeat-k8s install). This tool issues 4-12 PromQL queries for join discovery + candidate generation + up to 8 candidate range queries for temporal scoring. **Example**: `{"anchor_type": "customer_metric", "anchor": "apm_request_duration_p99{service=\\"payments-svc\\"}", "window": "1h"}`.',
    inputSchema: correlateCrossPillarSchema,
    annotations: { title: 'Correlate cross-pillar', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) =>
    wrap('log10x_correlate_cross_pillar', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeCorrelateCrossPillar(args, env);
    })
);

// ── Tool: log10x_translate_metric_to_patterns (v1.4) ──

server.registerTool(
  'log10x_translate_metric_to_patterns',
  {
    title: 'Translate metric to patterns',
    description: 'Preset wrapper for the customer-metric-to-log-patterns direction of cross-pillar correlation. Given a customer APM / infra / business metric, return the Log10x patterns whose rate curves correspond to the metric\'s movements, with the same four-tier structural validation as `log10x_correlate_cross_pillar`. This is the "agent looking at an APM metric asks what logs correspond" workflow, which is the most common cross-pillar direction and worth routing via a descriptively-named tool rather than through the generic bidirectional primitive. Output is identical to `correlate_cross_pillar`: confirmed / service-match / unconfirmed / coincidence tiers with per-candidate confidence sub-scores. **Tier prerequisites**: same as correlate_cross_pillar. Identical query cost. **Example**: `{"customer_metric": "apm_request_duration_p99{service=\\"payments-svc\\"}", "window": "1h"}`.',
    inputSchema: translateMetricToPatternsSchema,
    annotations: { title: 'Translate metric to patterns', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
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

server.registerTool(
  'log10x_poc_from_siem_submit',
  {
    title: 'POC from SIEM (submit)',
    description: 'Kick off a full log-cost-optimization POC against the user\'s SIEM. Pulls a representative event sample, templatizes into stable pattern identities, and renders a 9-section markdown report covering top cost drivers, Reducer recommendations, ready-to-paste native SIEM exclusion configs, Compact mode potential, risk/dependency checks, and deployment paths. Supported SIEMs: cloudwatch (AWS CloudWatch Logs via IAM credential chain), datadog (DD_API_KEY + DD_APP_KEY), sumo (Sumo Logic), gcp-logging (GCP Cloud Logging), elasticsearch (Elastic Cloud / self-hosted), azure-monitor (Azure Monitor / Log Analytics), splunk (SPLUNK_HOST + SPLUNK_TOKEN), clickhouse (OpenObserve / SigNoz / custom schemas). Auto-detects the SIEM from env vars when `siem` omitted — explicitly pass `siem` if multiple credential sets exist. `scope` and `query` are SIEM-specific: CloudWatch (log group + filter pattern), Datadog (index + query), Sumo (_sourceCategory + query), GCP (project id + filter), Elasticsearch (index pattern + KQL), Azure (workspace id + KQL), Splunk (index + SPL), ClickHouse (database + SQL WHERE). For ClickHouse, also pass `clickhouse_table` (required) and column-mapping args for custom schemas (OpenObserve/SigNoz auto-detected). Returns a `snapshot_id` — poll via log10x_poc_from_siem_status to retrieve progress and the final report. Report is also written to `${LOG10X_REPORT_DIR:-/tmp/log10x-reports}/poc_from_siem-<timestamp>.md`. Default window is 7d, default target event count is 250k, default max pull time is 5 min — the pull stops at whichever of the two ceilings hits first. **Tier prerequisites**: none. No log10x API key required. **Templating defaults to privacy_mode=true**: events are templated via a locally-installed `tenx` CLI (brew install log10x/tap/tenx) and never leave the machine. Set `privacy_mode: false` to route through the public Log10x paste endpoint — demo use only, not production log content.',
    inputSchema: pocFromSiemSubmitSchema,
    annotations: { title: 'POC from SIEM (submit)', readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) =>
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

server.registerTool(
  'log10x_poc_from_siem_status',
  {
    title: 'POC from SIEM (status)',
    description: 'Retrieve progress or a view of the report from a log10x_poc_from_siem_submit run. ' +
      'Pass `snapshot_id`; optionally `view` to select the level of detail. ' +
      '**In-progress** responses report status (pulling / templatizing / rendering), progress_pct, ' +
      'step_detail, and elapsed_seconds — poll every ~30s until done. ' +
      '**Complete** responses render one of six views: ' +
      '`summary` (default, ~30 lines — exec banner + top-5 wins + views CTA), ' +
      '`full` (complete 9-section report, ~300 lines), ' +
      '`yaml` (paste-ready Reducer mute-file for the top N patterns), ' +
      '`configs` (native SIEM exclusion configs — Datadog exclusion filter / Splunk props.conf / etc.), ' +
      '`top` (expanded N-row drivers table), ' +
      '`pattern` (deep-dive on one identity — requires `pattern` arg). ' +
      '**Failures** include partial_report_markdown when any events were successfully pulled before the error. ' +
      'The full report is also written to ${LOG10X_REPORT_DIR:-/tmp/log10x-reports}/poc_from_siem-<timestamp>.md regardless of which view the caller requested. ' +
      'Snapshots live in-memory per MCP process; a restart clears them, so persist the final report path if you need it later. ' +
      '**Tier prerequisites**: none. ' +
      '**Usage guidance for the calling model**: render the returned markdown AS-IS. The view arg has already picked the right level of detail. Do NOT summarize, paraphrase, or quote selectively — the tool has already done that work. If the user wants different detail, re-call with a different view.',
    inputSchema: pocFromSiemStatusSchema,
    annotations: { title: 'POC from SIEM (status)', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (args) => wrap('log10x_poc_from_siem_status', async () => executePocStatus(args))
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

server.registerTool(
  'log10x_poc_from_local',
  {
    title: 'POC from local logs (kubectl)',
    description:
      'Run a log-cost-optimization POC entirely from local log sources — `kubectl` today, `docker` and `journald` to follow. No log-analyzer credentials required. Use when the prospect has no SIEM connection or has not yet shared API keys. ' +
      'Returns a synchronous markdown report with: ' +
      '(a) **sample composition** table — top-N pods by byte volume; the prospect must confirm the sample looks like their production mix, ' +
      '(b) **industry-pricing matrix** — projected savings at Datadog / Splunk / CloudWatch / Sumo / Elastic / OpenSearch list prices, NOT a prediction of any specific bill, ' +
      '(c) **top patterns** in the kubectl-sourced sample. ' +
      'For native exclusion configs, paste-ready Reducer YAML, and the full 9-section report tied to a specific log analyzer\'s actual GB-billed volume, run `log10x_poc_from_siem` once credentials are available. ' +
      '**No automatic fallthrough**: this tool is invoked explicitly. If `log10x_poc_from_siem` failed on missing credentials, the calling LLM should ask the user before re-invoking with this tool — local-source framing is genuinely different from SIEM-attached framing and silent fallthrough would be a bait-and-switch. ' +
      '**Tier prerequisites**: kubectl on PATH + a working kubeconfig. No log10x API key required.',
    inputSchema: pocFromLocalSchema,
    annotations: { title: 'POC from local logs (kubectl)', readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  },
  (args) =>
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

server.registerTool(
  'log10x_discover_env',
  {
    title: 'Discover env (k8s + AWS)',
    description: 'Read-only discovery of the caller\'s Kubernetes cluster + AWS account — i.e. the customer\'s INFRASTRUCTURE environment, NOT their Log10x account. Probes kubectl (workloads, DaemonSets, Helm releases, service-account IRSA annotations) and AWS (EKS, S3, SQS, CloudWatch log groups) to detect: which forwarder is running (Fluent Bit, Fluentd, Filebeat, Logstash, OTel Collector), which log10x apps are already installed (Reporter, Reducer, Retriever), and what infrastructure exists that could host a Retriever install. Returns a terse markdown report + a `snapshot_id` (cached 30 min) the advisor tools consume. **Do NOT call this tool to answer "which Log10x environments do I have access to" / "list my envs" / "switch envs" — those are about the user\'s Log10x ACCOUNT environments, use `log10x_login_status` for that.** Call THIS tool only when the question is about k8s workloads, AWS infra, or "what\'s deployed in my cluster". Use this BEFORE calling `log10x_advise_reporter`, `log10x_advise_reducer`, or `log10x_advise_retriever` — they read the snapshot to tailor their install/verify/teardown commands to the specific cluster state. Every shell call is logged in the snapshot\'s `probeLog` for audit. No writes, no state mutation: only `kubectl get` and `aws ... describe/list` verbs. **Tier prerequisites**: none — this is a pre-install tool and runs against any customer environment.',
    inputSchema: discoverEnvSchema,
    annotations: { title: 'Discover env (k8s + AWS)', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  (args) => wrap('log10x_discover_env', () => executeDiscoverEnv(args))
);

// ── Tool: log10x_advise_reporter (install advisor) ──

server.registerTool(
  'log10x_advise_reporter',
  {
    title: 'Advise: Reporter install',
    description: 'Given a DiscoverySnapshot (from `log10x_discover_env`) + a forwarder choice + a license key, produce a tailored install/verify/teardown plan for the Log10x Reporter. Supports 5 forwarders (fluent-bit, fluentd, filebeat, logstash, otel-collector). The plan includes: preflight checks (namespace existence, release-name collision, chart availability, forwarder alignment); per-step install commands (helm repo, values.yaml, helm upgrade, rollout wait); verify probes that answer specific questions (pods ready? 10x sidecar processing events? forwarder emitting output?); and teardown commands (helm uninstall, PVC cleanup, residue check). Every step is paste-ready — no shell interpolation. Use `action: "verify"` or `action: "teardown"` to scope the output. Default destination is `mock` (forwarder stdout) which is safe for dogfooding; switch to `elasticsearch|splunk|datadog|cloudwatch` with `destination` + `output_host` for production installs. **Tier prerequisites**: none — this is a pre-install tool.',
    inputSchema: adviseReporterSchema,
    annotations: { title: 'Advise: Reporter install', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (args) => wrap('log10x_advise_reporter', () => executeAdviseReporter(args))
);

// ── Tool: log10x_advise_reducer (install advisor) ──

server.registerTool(
  'log10x_advise_retriever',
  {
    title: 'Advise: Retriever install',
    description: 'Given a DiscoverySnapshot (from `log10x_discover_env`), produce an install/verify/teardown plan for the Log10x Retriever. Unlike Reporter + Reducer, the Retriever has no forwarder choice — it is a standalone set of workloads (indexer + query-handler + stream-worker + filter CronJobs) that read from S3 via SQS and serve an HTTP query endpoint. The advisor detects existing AWS infra (input bucket with `indexing-results/` prefix, four SQS queues — index/query/subquery/stream — and an IRSA-annotated ServiceAccount) from the discovery snapshot, or accepts explicit overrides. Preflight fails closed when any required resource is missing — the Retriever depends on Terraform-provisioned infra that this advisor does NOT create. Verify probes: pods Ready, indexer processing messages, query endpoint responding, S3 indexing-results/ getting writes, SQS queue drainage. Teardown uninstalls the Helm release but leaves AWS infra alone (Terraform\'s concern). **Tier prerequisites**: none — but AWS infra must exist before install.',
    inputSchema: adviseRetrieverSchema,
    annotations: { title: 'Advise: Retriever install', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (args) => wrap('log10x_advise_retriever', () => executeAdviseRetriever(args))
);

// ── Tool: log10x_advise_reducer (install advisor) ──

server.registerTool(
  'log10x_advise_reducer',
  {
    title: 'Advise: Reducer install',
    description: 'Given a DiscoverySnapshot (from `log10x_discover_env`) + a forwarder choice + a license key, produce a tailored install/verify/teardown plan for the Log10x Reducer. Same 5 forwarders as the Reporter (fluent-bit, fluentd, filebeat, logstash, otel-collector) and same charts — the Reducer differs from the Reporter by writing regulated events back through the forwarder (with mute/sample/compact applied) instead of only emitting metrics. Values files carry `kind: "regulate"` which routes the tenx launcher to `@run/input/forwarder/<fw>/regulate` + `@apps/reducer`. Output shape is identical to `log10x_advise_reporter`: preflight, install steps, verify probes, teardown. **Tier prerequisites**: none — this is a pre-install tool.',
    inputSchema: adviseReducerSchema,
    annotations: { title: 'Advise: Reducer install', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (args) => wrap('log10x_advise_reducer', () => executeAdviseReducer(args))
);

// ── Tool: log10x_advise_install (mode selector + front-end advisor) ──

server.registerTool(
  'log10x_advise_install',
  {
    title: 'Advise: install path',
    description: 'Front-end install advisor — picks the RIGHT install path based on what `log10x_discover_env` detected. Sits in front of `log10x_advise_{reporter,reducer,retriever}`. Takes a snapshot_id + optional `goal` and decides between: standalone reporter (log10x/reporter-10x parallel DaemonSet, zero-touch to user forwarder), inline reporter/reducer (log10x-repackaged forwarder charts that replace the user\'s deployment), or Retriever (S3 archive). Detection rules: no forwarder OR hand-rolled forwarder → standalone; helm-managed fluent-bit/fluentd → inline (optimize-capable on 1.0.7); helm-managed filebeat/otel-collector → inline without optimize (1.0.6); helm-managed logstash → standalone (chart broken for sidecar mode). **Two call modes**: (1) with `goal` → returns a concrete install plan for the top-ranked path; goals are `just-metrics` (pattern fingerprinting + cost attribution), `cut-cost` (regulate: filter/sample), `compact` (regulate + compact encoding, only on fluent-bit/fluentd 1.0.7), `archive` (Retriever). (2) without `goal` → returns a ranked table of candidates + structured top-pick args so the caller can re-invoke with `goal=<winner>` or jump to an app-specific advisor. Call this BEFORE `log10x_advise_reporter`/`log10x_advise_reducer`/`log10x_advise_retriever` when you want the tool to pick the shape/app/forwarder combination for you. **Tier prerequisites**: none — this is a pre-install tool.',
    inputSchema: adviseInstallSchema,
    annotations: { title: 'Advise: install path', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (args) => wrap('log10x_advise_install', () => executeAdviseInstall(args))
);

// ── Tool: log10x_advise_compact (compact-lookup PR author) ──

server.registerTool(
  'log10x_advise_compact',
  {
    title: 'Advise: compact-lookup PR',
    description: 'Emit a literal `gh` PR command + the file diff for a compactReducer change against the customer\'s GitOps repo. Two modes: `mode=csv` (default) edits `compact-lookup.csv` — the engine hot-reloads via `FileResourceLookup.reset()` on each gitops poll (**no pipeline restart, no event drops**); `mode=js` replaces `compact-object-global.js` with new predicate logic — the engine triggers `restartPipeline()` (brief drain + relaunch). Use `js` only when CSV-keyed lookup is insufficient (regex match, multi-field-set OR semantics, external-flag gate). The compactReducer decides per-event whether each event is emitted via `encode()` (compact templateHash+vars, ~20-40x volume reduction) or as `fullText`, keyed off `compactReducerFieldNames` (default: `[symbolMessage]`). This tool is a *renderer*, not a decider: the caller decides which patterns to compact (typically via `log10x_top_patterns` + `log10x_cost_drivers`) and passes the lists in. Output is markdown with a diff summary, the new full file content, and two ready-to-run shell snippets (one-shot via `gh api`, or local clone+edit+push). Pass either `gitops_repo` directly OR `snapshot_id` (from `log10x_discover_env`) — when given a snapshot, the tool auto-resolves the repo from a running reducer pod\'s `GH_REPO` env var. **Tier prerequisites**: requires a Reporter (Cloud or Edge) so pattern keys exist; the reducer pod must be configured with `GH_ENABLED=true`, `GH_REPO=<owner/name>`, `GH_TOKEN` (PAT), and `compactReducerLookupFile` pointing at the same path inside its gitops-pulled tree. The `log10x_advise_reducer` install plan now includes a "GitOps — MCP-managed runtime config" section that lists every env var to set.',
    inputSchema: adviseCompactSchema,
    annotations: { title: 'Advise: compact-lookup PR', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (args) => wrap('log10x_advise_compact', () => executeAdviseCompact(args))
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
  { name: 'log10x_savings', intent: 'Pipeline ROI — how much reducer / optimizer / retriever are saving in dollars' },
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
  { name: 'log10x_signin', intent: 'GitHub device-flow signup/signin — opens browser, exchanges OAuth token for a Log10x API key, hot-reloads envs (no MCP-host restart needed)' },
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
  { name: 'log10x_advise_reducer', intent: 'Reducer install/verify/teardown plan — inline only, with optional compact encoding (optimize=true)' },
  { name: 'log10x_advise_retriever', intent: 'Retriever install/verify/teardown plan — standalone S3 + SQS archive + query' },
  { name: 'log10x_advise_compact', intent: 'Render a `gh` PR command + diff for a compactReducer lookup-CSV update against the customer GitOps repo (engine hot-reloads the CSV without a pipeline restart)' },
];

async function handleCliFlags(): Promise<boolean> {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    // eslint-disable-next-line no-console
    console.log('log10x-mcp 1.4.0');
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
        '  LOG10X_API_KEY            API key from console.log10x.com (or run `log10x_signin` to mint one via GitHub)',
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
  const loaded = getEnvs();
  log.info('mcp.boot', {
    version: '1.4.0',
    tools: REGISTERED_TOOLS.length,
    envs: loaded.all.length,
    default_env: loaded.default.nickname,
    demo_mode: loaded.isDemoMode,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', error);
  process.exit(1);
});
