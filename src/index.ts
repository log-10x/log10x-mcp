#!/usr/bin/env node

/**
 * Log10x MCP Server
 *
 * Gives AI assistants real-time access to per-pattern log cost attribution data.
 * Queries pre-aggregated Prometheus metrics — no log scanning, sub-second at any scale.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
import { streamerQuerySchema, executeStreamerQuery } from './tools/streamer-query.js';
import { streamerSeriesSchema, executeStreamerSeries } from './tools/streamer-series.js';
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
import { discoverEnvSchema, executeDiscoverEnv } from './tools/discover-env.js';
import { adviseReporterSchema, executeAdviseReporter } from './tools/advise-reporter.js';
import { adviseRegulatorSchema, executeAdviseRegulator } from './tools/advise-regulator.js';
import { adviseStreamerSchema, executeAdviseStreamer } from './tools/advise-streamer.js';
import { adviseInstallSchema, executeAdviseInstall } from './tools/advise-install.js';
import { adviseCompactSchema, executeAdviseCompact } from './tools/advise-compact.js';
import { getStatus } from './resources/status.js';

// ── Environment + cost cache ──
//
// Env loading is deferred until after CLI flag handling so `--version`,
// `--list-tools`, `--doctor`, and `--help` all work without env vars set.
// Tool callbacks reference `envs` lazily through `getEnvs()`.

let envs: Environments | undefined;

function getEnvs(): Environments {
  if (!envs) envs = loadEnvironments();
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
      return { content: [{ type: 'text' as const, text }] };
    })
    .catch((e) => {
      const raw = e instanceof Error ? e.message : String(e);
      log.debug(`tool.${toolName}.raw_err`, { msg: raw });
      log.warn(`tool.${toolName}.err`, { ms: Date.now() - started, msg: raw });
      return {
        content: [{ type: 'text' as const, text: describeToolError(toolName, e) }],
        isError: true,
      };
    });
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
4. Storage Streamer (deployable with or without Reporter) — S3 archive with Bloom-filter index.
   Adds: log10x_streamer_query (forensic retrieval), log10x_backfill_metric (new metric
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
  "I need the events themselves, not aggregates"                 → log10x_streamer_query
- "get me all <pattern> events from 90 days ago"                 → log10x_streamer_query
- "get all events for customer X filtered by Y, 60d window"      → log10x_streamer_query
- "backfill a new metric with 90d of history from the archive"   → log10x_backfill_metric
  (Critical: when a user asks for raw events OR mentions S3 / archive / cold storage
   explicitly, route to streamer_query even if the framing also mentions an incident.
   investigate returns aggregate pattern analysis; streamer_query returns actual log
   lines. "Post-mortem needs the actual log events" = streamer_query, not investigate.)

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
    log10x_event_lookup  →  log10x_streamer_query

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
- log10x_dependency_check returns a COMMAND the user must run locally. It does NOT scan the
  SIEM. Never report "zero dependencies found" or "safe to drop" based on this tool's output
  alone — wait for the user to paste the script's actual results.

Analyzer cost is auto-detected from the user's profile. Typical rates if unspecified:
Splunk $6/GB, Datadog $2.50/GB, Elasticsearch $1/GB, CloudWatch $0.50/GB.`,
  }
);

// ── Tool: log10x_cost_drivers ──

server.tool(
  'log10x_cost_drivers',
  'Answer "which log patterns made the bill jump this week" or "what changed since yesterday\'s deploy". Returns a dollar-ranked list of patterns whose cost grew versus a prior baseline, with before→after values, exact delta percentages, and new-pattern flags. **By default**: compares the current window against a 3-window average (e.g., timeRange=7d → avg of weeks 1, 2, 3 ago) to smooth noise. **For anchor-aligned deploy comparison**: pass `baselineOffsetDays` to compare against a single specific offset instead — `{timeRange: "1d", baselineOffsetDays: 1}` means "today vs yesterday", which is what you want for "did the deploy change anything". Attribution is keyed by **stable templateHash identity** that stays constant across query windows — Datadog Log Patterns and Splunk Pattern Explorer re-cluster per query, so their week-over-week diffs compare different clusters and are structurally unreliable. **Tier prerequisites**: requires a Reporter pipeline (Cloud or Edge).',
  costDriversSchema,
  (args) =>
    wrap('log10x_cost_drivers', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      return executeCostDrivers({ ...args, analyzerCost: cost }, env);
    })
);

// ── Tool: log10x_event_lookup ──

server.tool(
  'log10x_event_lookup',
  'Resolve a raw log line or pattern name to its stable identity (field-set), then return cost per service, before→after delta, first-seen timestamp within the observation window, and an AI classification (error/debug/info) with a recommended action (filter/keep/reduce). **Call this first** whenever a user pastes a SINGLE log line and asks "what is this", "is this new", or "is this safe to drop". The lookup is structural, not byte-exact — different timestamps/request IDs/user IDs on the same underlying pattern resolve to the same identity. If no match is returned, say so honestly. Use log10x_resolve_batch instead when the user pastes MULTIPLE events, a SIEM dump, or a batch to triage. **Tier prerequisites**: requires Reporter pipeline for live pattern lookup. In CLI-only mode, use log10x_resolve_batch instead.',
  eventLookupSchema,
  (args) =>
    wrap('log10x_event_lookup', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      return executeEventLookup({ ...args, analyzerCost: cost }, env);
    })
);

// ── Tool: log10x_savings ──

server.tool(
  'log10x_savings',
  'Show pipeline savings — how much the regulator (filtering), optimizer (compaction), and streamer (indexing) are saving in dollars. Use for "how much are we saving", "pipeline ROI", or "what is the Log10x stack worth financially". **Tier prerequisites**: requires Reporter pipeline. Savings attribution requires per-app continuous metric emission.',
  savingsSchema,
  (args) =>
    wrap('log10x_savings', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      return executeSavings({ ...args, analyzerCost: cost }, env);
    })
);

// ── Tool: log10x_pattern_trend ──

server.tool(
  'log10x_pattern_trend',
  'Return the volume + cost history for a single pattern over a chosen window (e.g. 1h, 24h, 7d, 30d), with a sparkline and spike detection. **Call this after log10x_event_lookup** when the user asks "is this getting worse", "has it been louder before", "when did it start", or wants temporal context on a pattern surfaced in an earlier step. Always state the observation window explicitly in the reply — "flat at 2/h for the last 6 months of observation, spiked at 13:58 today" — and never claim history older than the window. **Tier prerequisites**: requires Reporter pipeline. Time series queries need continuous metric emission.',
  trendSchema,
  (args) =>
    wrap('log10x_pattern_trend', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      return executeTrend({ ...args, analyzerCost: cost }, env);
    })
);

// ── Tool: log10x_services ──

server.tool(
  'log10x_services',
  'List every service the Log10x pipeline is watching, ranked by cost with per-service volume and share of total. Call first on open-ended cost questions, before drilling into a specific service. **Tier prerequisites**: requires Reporter pipeline.',
  servicesSchema,
  (args) =>
    wrap('log10x_services', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      return executeServices({ ...args, analyzerCost: cost }, env);
    })
);

// ── Tool: log10x_exclusion_filter ──

server.tool(
  'log10x_exclusion_filter',
  'Generate a config snippet to silence or reduce a log pattern. Produces either (a) a Log10x rate regulator mute-file entry keyed by field-set with explicit sampleRate and untilEpochSec expiry (the preferred path — self-expiring, git-reviewable, no regex), or (b) a native drop rule for the user\'s forwarder or SIEM (Datadog, Splunk, Elasticsearch, CloudWatch, Fluent Bit, OTel Collector, Vector, and others). Call when the user asks to "mute", "silence", "drop", "cap", or "reduce" a specific pattern. Always run log10x_dependency_check first so the reply can flag anything that will break. **Tier prerequisites**: none. Generates mute file entries independent of the Reporter tier.',
  exclusionFilterSchema,
  (args) => wrap('log10x_exclusion_filter', async () => executeExclusionFilter(args))
);

// ── Tool: log10x_dependency_check ──

server.tool(
  'log10x_dependency_check',
  'Given a pattern identity, generate commands to scan the user\'s SIEM/observability stack (Datadog monitors, Splunk saved searches, Grafana dashboards, Prometheus alert rules) for anything that depends on that pattern. **Call this before any mute, drop, or source-code deletion** — deleting a log line that feeds a live alert silently breaks the alert. Also call when a developer asks "am I allowed to delete this log.info() call" or "what references this pattern". This is the blast-radius check that turns a risky refactor into a reviewed one. **Tier prerequisites**: none. Operates against the customer\'s SIEM, dashboards, and alert surfaces via Bash + credentials.',
  dependencyCheckSchema,
  (args) => wrap('log10x_dependency_check', async () => executeDependencyCheck(args))
);

// ── Tool: log10x_discover_labels ──

server.tool(
  'log10x_discover_labels',
  'List the labels Log10x metrics can be filtered or grouped by. Call at the start of a session, or before calling any tool that takes a label/filter argument — stops the model from guessing label names like "namespace" when the real name is "k8s_namespace". Pass a label name to get its distinct values. **Tier prerequisites**: requires Reporter pipeline.',
  discoverLabelsSchema,
  (args) =>
    wrap('log10x_discover_labels', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeDiscoverLabels(args, env);
    })
);

// ── Tool: log10x_top_patterns ──

server.tool(
  'log10x_top_patterns',
  'Return the top N log patterns by current cost, with no baseline comparison or filtering gate. Use for "what is expensive right now", "what are the noisy patterns in <service> this hour", or "give me a snapshot of my loudest events". Can be scoped by service label. For "what changed this week" (deltas vs baseline) use log10x_cost_drivers instead; for "why did costs spike" always prefer cost_drivers because this tool has no new-pattern flag. **Tier prerequisites**: requires Reporter pipeline.',
  topPatternsSchema,
  (args) =>
    wrap('log10x_top_patterns', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      return executeTopPatterns({ ...args, analyzerCost: cost }, env);
    })
);

// ── Tool: log10x_list_by_label ──

server.tool(
  'log10x_list_by_label',
  'Rank the distinct values of any label by cost. Use for "cost by namespace", "cost by severity", "cost by country", "cost by container", or any other group-by question. Call log10x_discover_labels first if unsure which label names are valid. **Tier prerequisites**: requires Reporter pipeline.',
  listByLabelSchema,
  (args) =>
    wrap('log10x_list_by_label', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      return executeListByLabel({ ...args, analyzerCost: cost }, env);
    })
);

// ── Tool: log10x_investigate ──

server.tool(
  'log10x_investigate',
  'Single-call root-cause investigation for any log line, pattern, service, or environment. Returns a complete causal chain (for acute spikes) or co-drifter cohort (for gradual drift) with confidence scores derived mechanically from data signal quality, plus ready-to-run verification commands. Call whenever the user asks "what is going on with X", "why is X spiking", "investigate X", "what is causing this alert", "why is X creeping", or pastes a log line / alert and asks for diagnosis. Input is the user\'s natural-language target — pass their words verbatim. The tool detects whether the input is a raw log line, pattern identity, service name, or "environment" and runs the appropriate flow. It also detects whether the trajectory is an acute spike or gradual drift and renders a different report shape for each. **Structural wedge**: surfaces log-only signals (connection pool saturation, cache eviction storms, feature-flag cache flushes, retry amplification) that APM does NOT see because they manifest as slow-success traces rather than errors — this is why the tool catches causal chains that Datadog APM, Splunk APM, and OpenTelemetry tracing structurally cannot catch. Show the entire markdown report to the user without modification. Confidence percentages decompose into named sub-scores (stat × lag × chain for acute; slope_sig × cohort for drift) — walk the user through the decomposition when asked. **Tier prerequisites**: requires Reporter pipeline (Cloud or Edge). Drift detection requires continuous historical metrics — the CLI-only mode cannot do slope-similarity correlation. For direct forensic retrieval of specific historical events, use log10x_streamer_query instead. For metric backfill from the archive, use log10x_backfill_metric instead. **Example**: `{"starting_point": "payments-svc", "window": "1h", "depth": "normal"}` for a service-mode acute-spike investigation, or `{"starting_point": "environment", "window": "7d"}` for an env-wide audit.',
  investigateSchema,
  (args) =>
    wrap('log10x_investigate', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeInvestigate(args, env);
    })
);

// ── Tool: log10x_investigation_get ──

server.tool(
  'log10x_investigation_get',
  'Retrieve a prior log10x_investigate report by investigation_id, or list the most recent investigations in this session. Call when the user references a prior investigation ("expand on investigation abc123", "what did we find last time", "show me that report again") or when you need to cross-reference patterns across multiple investigations in the same session without re-running the correlation. Session-local — the cache dies with the process and holds the 50 most recent investigations.',
  investigationGetSchema,
  (args) => wrap('log10x_investigation_get', async () => executeInvestigationGet(args))
);

// ── Tool: log10x_resolve_batch ──

server.tool(
  'log10x_resolve_batch',
  'Templatize a batch of log events and return structured per-pattern triage with variable concentrations and next-action suggestions. Call whenever the user provides a batch of events to analyze: a pasted Datadog/Splunk/Elastic query result, a Slack incident with attached log lines, kubectl logs output, any raw log text dump, or when the user asks "what patterns are in these events" / "triage this batch". Input is the events themselves (file path, inline array, or raw text). The templater runs via the Log10x paste endpoint; the response structures the batch by stable templateHash, per-pattern frequency and severity, full template structure, and per-slot variable value distribution (answering "for whom is this happening" within the batch). Each pattern in the output carries next_actions suggesting log10x_investigate (for historical correlation), log10x_streamer_query (for archive retrieval), and native SIEM commands with the dominant variable filter pre-constructed. Do NOT call for single-line resolution — use log10x_event_lookup for that. Variable naming honest: structured-log slots get high-confidence names from JSON/logfmt keys; free-text slots with natural-language tokens get medium-confidence inferred names with "(inferred)" annotation; positional-only slots get "slot N" with no hallucinated name. **Tier prerequisites**: works at any tier including CLI-only. Runs via the Log10x paste endpoint by default (raw log text leaves the caller\'s machine); set privacy_mode=true to route through a locally-installed tenx CLI instead (local-only processing, CLI install required). **Example**: `{"source": "text", "text": "2026-04-13 ERROR checkout-svc ...\\n2026-04-13 INFO ..."}` for a pasted Slack dump, or `{"source": "file", "path": "/tmp/incident.log", "top_n_patterns": 10}` for a local file.',
  resolveBatchSchema,
  (args) => wrap('log10x_resolve_batch', async () => executeResolveBatch(args))
);

// ── Tool: log10x_extract_templates ──

server.tool(
  'log10x_extract_templates',
  'Extract the structural template library from a log corpus via the local tenx CLI. Returns per-template identity (stable templateHash), template body with variable slots, and event count. Use for: (a) bootstrapping a pattern catalog before wiring up a Reporter, (b) offline auditing of archived log corpora, (c) validating that a config change produces expected template identities (pass `expected` assertions). Input: inline events, raw text, or a file path/glob. The tenx CLI must be installed locally (`brew install log10x/tap/tenx`). **Validation mode**: pass `expected.min_templates`, `expected.required_patterns`, and/or `expected.forbidden_merges` to turn extraction into assertion-checked validation — each assertion reports PASS/FAIL in the output. **Example**: `{"source": "events", "events": ["ERROR checkout-svc ...", "INFO cart-svc ..."], "expected": {"min_templates": 2, "forbidden_merges": [["checkout", "cart"]]}}` to assert the two services produce separate templates.',
  extractTemplatesSchema,
  (args) => wrap('log10x_extract_templates', async () => executeExtractTemplates(args))
);

// ── Tool: log10x_streamer_query ──

server.tool(
  'log10x_streamer_query',
  'Direct retrieval of historical events from the Log10x Storage Streamer archive (customer\'s S3 bucket) by stable pattern identity, with optional JavaScript filter expressions over event payloads. Call when: (a) the user asks for specific events matching a pattern over a time window that is OUTSIDE the SIEM\'s retention, (b) the user asks to retrieve events filtered by a variable value that is NOT a faceted dimension in their SIEM (e.g., "all payment_retry events for customer acme-corp from 90 days ago"), (c) compliance, legal, audit, or forensic workflows need exact event retrieval with stable identity. Do NOT call when the events are in the SIEM\'s current retention and can be queried natively faster, or when the user wants aggregated metrics over time instead of specific events (use log10x_backfill_metric or log10x_investigate instead). No re-ingestion. No proprietary format. The archive is in the customer\'s own S3 bucket and queries are scoped to the matching templateHash via pre-computed Bloom filters so only relevant byte ranges are fetched. Three output formats: events (raw with metadata), count (distribution summary), aggregated (bucketed time series). **Tier prerequisites**: requires Storage Streamer component deployed. Does NOT require Reporter. Returns a graceful "Streamer not configured" message when LOG10X_STREAMER_URL is unset. **Example**: `{"pattern": "payment_retry_attempt", "from": "now-90d", "to": "now-15d", "filters": ["event.customer_id === \\"acme-corp-inc\\""], "format": "events", "limit": 10000}` for a 90-day legal forensic retrieval.',
  streamerQuerySchema,
  (args) =>
    wrap('log10x_streamer_query', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeStreamerQuery(args, env);
    })
);

// ── Tool: log10x_streamer_series ──

server.tool(
  'log10x_streamer_series',
  'Materialize a fidelity-aware time series from the customer\'s S3 archive over an arbitrary window, with optional group-by on enrichment fields. Auto-selects between exact full aggregation (Strategy A) and per-window-sampled fan-out (Strategy B) based on Reporter pattern volume — small/moderate-volume queries get exact counts; high-volume / long-window queries get a sampled series with time-distribution and group-ranking fidelity preserved and tail caveats reported. Pathological volume is refused with structured narrowing guidance, never silently truncated. Call when: (a) the user wants a "what is the rate of pattern X over the last 30 days, broken down by tenant" answer that exceeds the SIEM\'s retention or query budget, (b) a baseline needs building from cost-driver patterns where Prometheus has continuous metrics but the *grouped breakdown* lives only in the S3 archive, (c) any time series question over a window where you don\'t know in advance whether full aggregation will fit. Use `log10x_streamer_query` instead when you need the actual event payloads (not aggregates). Use `log10x_backfill_metric` instead when you want to push the resulting series to a TSDB rather than just see it. **Tier prerequisites**: requires Storage Streamer deployed. Reporter is optional — when absent, mode selection falls back to window-length heuristic. **Example**: `{"search": "tenx_user_pattern == \\"PaymentRetry\\"", "from": "now-30d", "to": "now", "bucket_size": "1h", "group_by": "tenx_user_service", "fidelity": "auto"}` for a 30-day grouped baseline.',
  streamerSeriesSchema,
  (args) =>
    wrap('log10x_streamer_series', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeStreamerSeries(args, env);
    })
);

// ── Tool: log10x_backfill_metric ──

server.tool(
  'log10x_backfill_metric',
  'Define a new metric (Datadog, Prometheus remote_write) backfilled with historical data from the Log10x Streamer archive, with optional forward-emission handoff to the live Reporter for continuous population going forward. Call when: (a) the user wants to define a new SLO, alert, or dashboard metric that needs historical context from day one, (b) the customer did not pre-instrument the metric in their TSDB and cannot backfill it from the TSDB\'s own data, (c) historical events are available in the Streamer archive (typically 90-180 days back), (d) the user specifies a pattern, grouping dimensions, aggregation, and destination TSDB. Do NOT call when the metric already exists in the destination TSDB. **This is the single highest-value Log10x-only capability**: Datadog log-based metrics only work on currently-indexed data; Splunk log-based metrics only work over indexed retention; Cribl can emit forward but cannot backfill from archive; Athena + remote-write Lambda is possible but represents 2-4 weeks of data-engineering per metric. This tool collapses that to ~15 minutes of config. Tool runs the Streamer query, aggregates events into bucketed time series (count / sum_bytes / unique_values / rate_per_second), emits to the destination with historical timestamps preserved, and returns a view URL. Datadog and Prometheus (via remote_write adapter) are wired today; CloudWatch/Elastic/SignalFx return "not yet implemented". **Tier prerequisites**: requires Streamer component deployed. Reporter required only when emit_forward=true (default false in this build — the Reporter config update path for forward-emission handoff is not yet wired, so current usage is one-time historical backfill). **Example**: `{"pattern": "db_query_timeout", "metric_name": "log10x.db_query_timeout_by_tenant", "destination": "datadog", "bucket_size": "5m", "aggregation": "count", "from": "now-90d", "to": "now", "group_by": ["tenant_id"]}` for a 90-day Datadog backfill grouped by tenant.',
  backfillMetricSchema,
  (args) =>
    wrap('log10x_backfill_metric', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeBackfillMetric(args, env);
    })
);

// ── Tool: log10x_doctor ──

server.tool(
  'log10x_doctor',
  'Run a startup health check on the Log10x MCP installation. Probes: environment configuration validity, prometheus.log10x.com reachability and auth, Reporter tier detection (Edge / Cloud / none), Storage Streamer endpoint configuration (informational), Datadog destination credentials (informational), paste endpoint reachability, cross-pillar enrichment floor (v1.4, when LOG10X_CUSTOMER_METRICS_URL is set). Returns a markdown report with pass / warn / fail per check and remediation hints. Call this once at the start of a session to verify the install, or any time a tool returns an unexpected error and you want to isolate whether the problem is configuration or transient. **Tier prerequisites**: none. Doctor checks never block; missing components produce warnings with remediation hints.',
  doctorSchema,
  (args) => wrap('log10x_doctor', async () => executeDoctor(args))
);

// ── Tool: log10x_customer_metrics_query (v1.4) ──

server.tool(
  'log10x_customer_metrics_query',
  'Low-level PromQL passthrough to the customer metric backend configured via LOG10X_CUSTOMER_METRICS_URL. Returns the raw Prometheus response shape plus metadata about which backend served the query. This is the escape hatch for cross-pillar investigations the higher-level tools don\'t cover — use it to explore the customer backend\'s label universe, run a one-off PromQL expression, or verify that a specific metric exists before correlating against it. For typical cross-pillar workflows, prefer `log10x_translate_metric_to_patterns` (customer metric → log patterns) or `log10x_correlate_cross_pillar` (bidirectional). **Tier prerequisites**: requires LOG10X_CUSTOMER_METRICS_URL configured (grafana_cloud, amp, datadog_prom, or generic_prom backend type). This tool issues exactly 1 PromQL query against the customer backend. **Example**: `{"promql": "apm_request_duration_p99{service=\\"payments-svc\\"}", "mode": "instant"}`.',
  customerMetricsQuerySchema,
  (args) => wrap('log10x_customer_metrics_query', async () => executeCustomerMetricsQuery(args))
);

// ── Tool: log10x_discover_join (v1.4) ──

server.tool(
  'log10x_discover_join',
  'Auto-discover the structural join label between Log10x pattern metrics and the customer metric backend. Runs Jaccard similarity on label value sets across candidate label pairs, returns the best pair above the 0.7 threshold plus runner-ups above 0.5. The result is cached per-session keyed by (environment, customer-backend-endpoint) so the higher-level cross-pillar correlation tools can auto-run this once at session start and reuse the cached join without re-probing. Agents should normally NOT need to call this tool directly — `log10x_correlate_cross_pillar` and `log10x_translate_metric_to_patterns` call it internally. The explicit tool exists for power users who want to inspect the join universe or force a re-discovery after backend changes. When no pair crosses the threshold, returns a structured `no_join_available` response with the full probed-label matrix and recommended next actions. **Tier prerequisites**: requires LOG10X_CUSTOMER_METRICS_URL configured. This tool issues up to 12 PromQL queries (6 Log10x-side + 6 customer-side label value fetches) on first call; subsequent calls in the same session return the cached result. **Example**: `{"minimum_jaccard": 0.7}`.',
  discoverJoinSchema,
  (args) =>
    wrap('log10x_discover_join', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeDiscoverJoin(args, env);
    })
);

// ── Tool: log10x_correlate_cross_pillar (v1.4) ──

server.tool(
  'log10x_correlate_cross_pillar',
  'Bidirectional cross-pillar correlation with structural validation. Takes an anchor that\'s either a Log10x pattern (`anchor_type: "log10x_pattern"`) OR a customer metric expression (`anchor_type: "customer_metric"`) and returns ranked co-movers from the OTHER pillar, tiered by structural validation confidence. **Four output tiers**: `confirmed` (full structural overlap on join key + at least one additional label — highest confidence), `service-match` (join key match but partial overlap — service-level issue affecting all instances), `unconfirmed` (temporal match but required Log10x enrichment labels missing — unknown causality, do not drill autonomously), `coincidence` (temporal match with NO structural overlap despite having both sides\' labels — this is coincidence, not causation, and the tool explicitly flags it as such). **The structural validation phase is the differentiating capability vs every other agent observability tool in 2026.** Every temporal Pearson ranker produces false positives on workloads that share a daily cycle; cross-pillar bridge filters these out by checking whether the candidate\'s metadata labels could plausibly overlap with the anchor\'s labels. When no structural join exists at all (e.g., node-level anchors against v1.4\'s service/pod/namespace/container label set), the tool returns a structured `no_join_available` refusal with probed-label diagnostics and recommended next actions — never a fall-through to temporal-only ranking. Refusal is a feature, not a failure. **Tier prerequisites**: requires LOG10X_CUSTOMER_METRICS_URL configured AND Reporter tier with k8s_pod / k8s_container / k8s_namespace / tenx_user_service enrichments (defaults on any fluent-k8s or filebeat-k8s install). This tool issues 4-12 PromQL queries for join discovery + candidate generation + up to 8 candidate range queries for temporal scoring. **Example**: `{"anchor_type": "customer_metric", "anchor": "apm_request_duration_p99{service=\\"payments-svc\\"}", "window": "1h"}`.',
  correlateCrossPillarSchema,
  (args) =>
    wrap('log10x_correlate_cross_pillar', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeCorrelateCrossPillar(args, env);
    })
);

// ── Tool: log10x_translate_metric_to_patterns (v1.4) ──

server.tool(
  'log10x_translate_metric_to_patterns',
  'Preset wrapper for the customer-metric-to-log-patterns direction of cross-pillar correlation. Given a customer APM / infra / business metric, return the Log10x patterns whose rate curves correspond to the metric\'s movements, with the same four-tier structural validation as `log10x_correlate_cross_pillar`. This is the "agent looking at an APM metric asks what logs correspond" workflow, which is the most common cross-pillar direction and worth routing via a descriptively-named tool rather than through the generic bidirectional primitive. Output is identical to `correlate_cross_pillar`: confirmed / service-match / unconfirmed / coincidence tiers with per-candidate confidence sub-scores. **Tier prerequisites**: same as correlate_cross_pillar. Identical query cost. **Example**: `{"customer_metric": "apm_request_duration_p99{service=\\"payments-svc\\"}", "window": "1h"}`.',
  translateMetricToPatternsSchema,
  (args) =>
    wrap('log10x_translate_metric_to_patterns', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeTranslateMetricToPatterns(args, env);
    })
);

// ── Tool: log10x_discover_env (install advisor) ──

server.tool(
  'log10x_discover_env',
  'Read-only discovery of the caller\'s Kubernetes cluster + AWS account. Probes kubectl (workloads, DaemonSets, Helm releases, service-account IRSA annotations) and AWS (EKS, S3, SQS, CloudWatch log groups) to detect: which forwarder is running (Fluent Bit, Fluentd, Filebeat, Logstash, OTel Collector), which log10x apps are already installed (Reporter, Regulator, Streamer), and what infrastructure exists that could host a Streamer install. Returns a terse markdown report + a `snapshot_id` (cached 30 min) the advisor tools consume. Use this tool BEFORE calling `log10x_advise_reporter`, `log10x_advise_regulator`, or `log10x_advise_streamer` — they read the snapshot to tailor their install/verify/teardown commands to the specific cluster state. Every shell call is logged in the snapshot\'s `probeLog` for audit. No writes, no state mutation: only `kubectl get` and `aws ... describe/list` verbs. **Tier prerequisites**: none — this is a pre-install tool and runs against any customer environment.',
  discoverEnvSchema,
  (args) => wrap('log10x_discover_env', () => executeDiscoverEnv(args))
);

// ── Tool: log10x_advise_reporter (install advisor) ──

server.tool(
  'log10x_advise_reporter',
  'Given a DiscoverySnapshot (from `log10x_discover_env`) + a forwarder choice + a license key, produce a tailored install/verify/teardown plan for the Log10x Reporter. Supports 5 forwarders (fluent-bit, fluentd, filebeat, logstash, otel-collector). The plan includes: preflight checks (namespace existence, release-name collision, chart availability, forwarder alignment); per-step install commands (helm repo, values.yaml, helm upgrade, rollout wait); verify probes that answer specific questions (pods ready? 10x sidecar processing events? forwarder emitting output?); and teardown commands (helm uninstall, PVC cleanup, residue check). Every step is paste-ready — no shell interpolation. Use `action: "verify"` or `action: "teardown"` to scope the output. Default destination is `mock` (forwarder stdout) which is safe for dogfooding; switch to `elasticsearch|splunk|datadog|cloudwatch` with `destination` + `output_host` for production installs. **Tier prerequisites**: none — this is a pre-install tool.',
  adviseReporterSchema,
  (args) => wrap('log10x_advise_reporter', () => executeAdviseReporter(args))
);

// ── Tool: log10x_advise_regulator (install advisor) ──

server.tool(
  'log10x_advise_streamer',
  'Given a DiscoverySnapshot (from `log10x_discover_env`), produce an install/verify/teardown plan for the Log10x Streamer. Unlike Reporter + Regulator, the Streamer has no forwarder choice — it is a standalone set of workloads (indexer + query-handler + stream-worker + filter CronJobs) that read from S3 via SQS and serve an HTTP query endpoint. The advisor detects existing AWS infra (input bucket with `indexing-results/` prefix, four SQS queues — index/query/subquery/stream — and an IRSA-annotated ServiceAccount) from the discovery snapshot, or accepts explicit overrides. Preflight fails closed when any required resource is missing — the Streamer depends on Terraform-provisioned infra that this advisor does NOT create. Verify probes: pods Ready, indexer processing messages, query endpoint responding, S3 indexing-results/ getting writes, SQS queue drainage. Teardown uninstalls the Helm release but leaves AWS infra alone (Terraform\'s concern). **Tier prerequisites**: none — but AWS infra must exist before install.',
  adviseStreamerSchema,
  (args) => wrap('log10x_advise_streamer', () => executeAdviseStreamer(args))
);

// ── Tool: log10x_advise_regulator (install advisor) ──

server.tool(
  'log10x_advise_regulator',
  'Given a DiscoverySnapshot (from `log10x_discover_env`) + a forwarder choice + a license key, produce a tailored install/verify/teardown plan for the Log10x Regulator. Same 5 forwarders as the Reporter (fluent-bit, fluentd, filebeat, logstash, otel-collector) and same charts — the Regulator differs from the Reporter by writing regulated events back through the forwarder (with mute/sample/compact applied) instead of only emitting metrics. Values files carry `kind: "regulate"` which routes the tenx launcher to `@run/input/forwarder/<fw>/regulate` + `@apps/regulator`. Output shape is identical to `log10x_advise_reporter`: preflight, install steps, verify probes, teardown. **Tier prerequisites**: none — this is a pre-install tool.',
  adviseRegulatorSchema,
  (args) => wrap('log10x_advise_regulator', () => executeAdviseRegulator(args))
);

// ── Tool: log10x_advise_install (mode selector + front-end advisor) ──

server.tool(
  'log10x_advise_install',
  'Front-end install advisor — picks the RIGHT install path based on what `log10x_discover_env` detected. Sits in front of `log10x_advise_{reporter,regulator,streamer}`. Takes a snapshot_id + optional `goal` and decides between: standalone reporter (log10x-k8s/reporter-10x parallel DaemonSet, zero-touch to user forwarder), inline reporter/regulator (log10x-repackaged forwarder charts that replace the user\'s deployment), or Streamer (S3 archive). Detection rules: no forwarder OR hand-rolled forwarder → standalone; helm-managed fluent-bit/fluentd → inline (optimize-capable on 1.0.7); helm-managed filebeat/otel-collector → inline without optimize (1.0.6); helm-managed logstash → standalone (chart broken for sidecar mode). **Two call modes**: (1) with `goal` → returns a concrete install plan for the top-ranked path; goals are `just-metrics` (pattern fingerprinting + cost attribution), `cut-cost` (regulate: filter/sample), `compact` (regulate + compact encoding, only on fluent-bit/fluentd 1.0.7), `archive` (Streamer). (2) without `goal` → returns a ranked table of candidates + structured top-pick args so the caller can re-invoke with `goal=<winner>` or jump to an app-specific advisor. Call this BEFORE `log10x_advise_reporter`/`log10x_advise_regulator`/`log10x_advise_streamer` when you want the tool to pick the shape/app/forwarder combination for you. **Tier prerequisites**: none — this is a pre-install tool.',
  adviseInstallSchema,
  (args) => wrap('log10x_advise_install', () => executeAdviseInstall(args))
);

// ── Tool: log10x_advise_compact (compact-lookup PR author) ──

server.tool(
  'log10x_advise_compact',
  'Emit a literal `gh` PR command + the file diff for a compactRegulator lookup-CSV update against the customer\'s GitOps repo. The compactRegulator decides per-event whether each event is emitted via `encode()` (compact templateHash+vars, ~20-40x volume reduction) or as `fullText`, keyed off a CSV lookup of `compactRegulatorFieldNames` (default: `[symbolMessage]`). The engine hot-reloads the CSV via `FileResourceLookup.reset()` on each gitops poll — **no pipeline restart, no event drops** — so per-pattern decisions take effect within seconds of the PR being merged. This tool is a *renderer*, not a decider: the caller decides which patterns to compact (typically using `log10x_top_patterns` + `log10x_cost_drivers`) and passes the lists in. Output is markdown with a diff summary, the new full CSV content, and two ready-to-run shell snippets (one-shot via `gh api`, or local clone+edit+push). **Tier prerequisites**: requires a Reporter (Cloud or Edge) so pattern keys exist; the regulator pod must be configured with `compactRegulatorLookupFile` pointing at the same path inside its gitops-pulled tree. v1 scope: CSV edits only. JS predicate updates (which trigger a full pipeline restart) are a follow-up.',
  adviseCompactSchema,
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
  { name: 'log10x_savings', intent: 'Pipeline ROI — how much regulator / optimizer / streamer are saving in dollars' },
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
  { name: 'log10x_streamer_query', intent: 'Direct archive retrieval by templateHash with JS filter expressions' },
  { name: 'log10x_backfill_metric', intent: 'Create a new Datadog / Prometheus metric backfilled from Streamer archive' },
  { name: 'log10x_doctor', intent: 'Startup health check — env config, gateway, tier, freshness, Streamer, paste endpoint, cross-pillar enrichment floor' },
  { name: 'log10x_customer_metrics_query', intent: 'Direct PromQL passthrough to the customer metric backend (escape hatch for cross-pillar investigations)' },
  { name: 'log10x_discover_join', intent: 'Auto-discover the join label between Log10x pattern metrics and the customer metric backend via Jaccard similarity' },
  { name: 'log10x_correlate_cross_pillar', intent: 'Bidirectional cross-pillar correlation with structural validation — confirmed / service-match / coincidence / unconfirmed tiering' },
  { name: 'log10x_translate_metric_to_patterns', intent: 'Given a customer APM metric, return the Log10x patterns whose rate curves correspond — with structural validation' },
  { name: 'log10x_discover_env', intent: 'Read-only probe of k8s + AWS — returns a snapshot_id the advise_* tools consume' },
  { name: 'log10x_advise_install', intent: 'Front-end install advisor — picks standalone vs inline + app + forwarder + optimize based on what was detected' },
  { name: 'log10x_advise_reporter', intent: 'Reporter install/verify/teardown plan for a forwarder — inline or standalone (shape=standalone)' },
  { name: 'log10x_advise_regulator', intent: 'Regulator install/verify/teardown plan — inline only, with optional compact encoding (optimize=true)' },
  { name: 'log10x_advise_streamer', intent: 'Streamer install/verify/teardown plan — standalone S3 + SQS archive + query' },
  { name: 'log10x_advise_compact', intent: 'Render a `gh` PR command + diff for a compactRegulator lookup-CSV update against the customer GitOps repo (engine hot-reloads the CSV without a pipeline restart)' },
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
        '  LOG10X_API_KEY            API key from console.log10x.com (single-env mode)',
        '  LOG10X_ENV_ID             Environment ID (single-env mode)',
        '  LOG10X_ENVS               JSON array for multi-env: [{"nickname","apiKey","envId"}]',
        '  LOG10X_API_BASE           Override Prometheus gateway URL',
        '  LOG10X_STREAMER_URL       Storage Streamer query endpoint (optional)',
        '  LOG10X_PASTE_URL          Override Log10x paste endpoint (optional)',
        '  LOG10X_TENX_PATH          Path to local tenx CLI for privacy_mode resolve_batch',
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
  // Eagerly validate environment configuration before the server connects.
  // A malformed LOG10X_ENVS or missing API key surfaces here with a clear
  // structured error instead of crashing on the first tool call from the
  // model, which is much harder to debug from a Claude Desktop log.
  try {
    getEnvs();
  } catch (e) {
    if (e instanceof EnvironmentValidationError) {
      // eslint-disable-next-line no-console
      console.error(`\n[log10x-mcp] Configuration error:\n${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  log.info('mcp.boot', { version: '1.4.0', tools: REGISTERED_TOOLS.length });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', error);
  process.exit(1);
});
