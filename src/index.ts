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

import { loadEnvironments, resolveEnv, type EnvConfig } from './lib/environments.js';
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
import {
  investigateSchema,
  executeInvestigate,
  investigationGetSchema,
  executeInvestigationGet,
} from './tools/investigate.js';
import { streamerQuerySchema, executeStreamerQuery } from './tools/streamer-query.js';
import { backfillMetricSchema, executeBackfillMetric } from './tools/backfill-metric.js';
import { getStatus } from './resources/status.js';

// ── Environment + cost cache ──

const envs = loadEnvironments();
const costCache = new Map<string, { cost: number; fetchedAt: number }>();
const COST_REFRESH_MS = 3_600_000; // 1 hour

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
  { name: 'log10x', version: '1.3.0' },
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
- "what's expensive right now" / quick ranking                   → log10x_top_patterns
- "why did costs spike" / week-over-week deltas                  → log10x_cost_drivers
- "cost by namespace / service / severity / country"             → log10x_list_by_label
- "pipeline savings / ROI"                                       → log10x_savings

Forensic / audit / archive:
- "get me all <pattern> events from 90 days ago"                 → log10x_streamer_query
- "get all events for customer X filtered by Y, 60d window"      → log10x_streamer_query
- "backfill a new metric with 90d of history from the archive"   → log10x_backfill_metric

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

Analyzer cost is auto-detected from the user's profile. Typical rates if unspecified:
Splunk $6/GB, Datadog $2.50/GB, Elasticsearch $1/GB, CloudWatch $0.50/GB.`,
  }
);

// ── Tool: log10x_cost_drivers ──

server.tool(
  'log10x_cost_drivers',
  'Answer "which log patterns made the bill jump this week". Returns a dollar-ranked list of patterns whose cost grew versus the prior baseline, with before→after values and new-pattern flags. Attribution is keyed by **stable templateHash identity** that stays constant across query windows — Datadog Log Patterns and Splunk Pattern Explorer re-cluster per query, so their week-over-week diffs compare different clusters and are structurally unreliable. Use this tool when the answer requires stable pattern identity across time, not just faster grouping within one window. **Tier prerequisites**: requires a Reporter pipeline (Cloud or Edge). Cost attribution with week-over-week deltas needs continuous per-pattern metric history.',
  costDriversSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      const result = await executeCostDrivers({ ...args, analyzerCost: cost }, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_event_lookup ──

server.tool(
  'log10x_event_lookup',
  'Resolve a raw log line or pattern name to its stable identity (field-set), then return cost per service, before→after delta, first-seen timestamp within the observation window, and an AI classification (error/debug/info) with a recommended action (filter/keep/reduce). **Call this first** whenever a user pastes a SINGLE log line and asks "what is this", "is this new", or "is this safe to drop". The lookup is structural, not byte-exact — different timestamps/request IDs/user IDs on the same underlying pattern resolve to the same identity. If no match is returned, say so honestly. Use log10x_resolve_batch instead when the user pastes MULTIPLE events, a SIEM dump, or a batch to triage. **Tier prerequisites**: requires Reporter pipeline for live pattern lookup. In CLI-only mode, use log10x_resolve_batch instead.',
  eventLookupSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      const result = await executeEventLookup({ ...args, analyzerCost: cost }, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_savings ──

server.tool(
  'log10x_savings',
  'Show pipeline savings — how much the regulator (filtering), optimizer (compaction), and streamer (indexing) are saving in dollars. Use for "how much are we saving", "pipeline ROI", or "what is the Log10x stack worth financially". **Tier prerequisites**: requires Reporter pipeline. Savings attribution requires per-app continuous metric emission.',
  savingsSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      const result = await executeSavings({ ...args, analyzerCost: cost }, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_pattern_trend ──

server.tool(
  'log10x_pattern_trend',
  'Return the volume + cost history for a single pattern over a chosen window (e.g. 1h, 24h, 7d, 30d), with a sparkline and spike detection. **Call this after log10x_event_lookup** when the user asks "is this getting worse", "has it been louder before", "when did it start", or wants temporal context on a pattern surfaced in an earlier step. Always state the observation window explicitly in the reply — "flat at 2/h for the last 6 months of observation, spiked at 13:58 today" — and never claim history older than the window. **Tier prerequisites**: requires Reporter pipeline. Time series queries need continuous metric emission.',
  trendSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      const result = await executeTrend({ ...args, analyzerCost: cost }, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_services ──

server.tool(
  'log10x_services',
  'List every service the Log10x pipeline is watching, ranked by cost with per-service volume and share of total. Call first on open-ended cost questions, before drilling into a specific service. **Tier prerequisites**: requires Reporter pipeline.',
  servicesSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      const result = await executeServices({ ...args, analyzerCost: cost }, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_exclusion_filter ──

server.tool(
  'log10x_exclusion_filter',
  'Generate a config snippet to silence or reduce a log pattern. Produces either (a) a Log10x rate regulator mute-file entry keyed by field-set with explicit sampleRate and untilEpochSec expiry (the preferred path — self-expiring, git-reviewable, no regex), or (b) a native drop rule for the user\'s forwarder or SIEM (Datadog, Splunk, Elasticsearch, CloudWatch, Fluent Bit, OTel Collector, Vector, and others). Call when the user asks to "mute", "silence", "drop", "cap", or "reduce" a specific pattern. Always run log10x_dependency_check first so the reply can flag anything that will break. **Tier prerequisites**: none. Generates mute file entries independent of the Reporter tier.',
  exclusionFilterSchema,
  async (args) => {
    try {
      const result = executeExclusionFilter(args);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_dependency_check ──

server.tool(
  'log10x_dependency_check',
  'Given a pattern identity, generate commands to scan the user\'s SIEM/observability stack (Datadog monitors, Splunk saved searches, Grafana dashboards, Prometheus alert rules) for anything that depends on that pattern. **Call this before any mute, drop, or source-code deletion** — deleting a log line that feeds a live alert silently breaks the alert. Also call when a developer asks "am I allowed to delete this log.info() call" or "what references this pattern". This is the blast-radius check that turns a risky refactor into a reviewed one. **Tier prerequisites**: none. Operates against the customer\'s SIEM, dashboards, and alert surfaces via Bash + credentials.',
  dependencyCheckSchema,
  async (args) => {
    try {
      const result = executeDependencyCheck(args);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_discover_labels ──

server.tool(
  'log10x_discover_labels',
  'List the labels Log10x metrics can be filtered or grouped by. Call at the start of a session, or before calling any tool that takes a label/filter argument — stops the model from guessing label names like "namespace" when the real name is "k8s_namespace". Pass a label name to get its distinct values. **Tier prerequisites**: requires Reporter pipeline.',
  discoverLabelsSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const result = await executeDiscoverLabels(args, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_top_patterns ──

server.tool(
  'log10x_top_patterns',
  'Return the top N log patterns by current cost, with no baseline comparison or filtering gate. Use for "what is expensive right now", "what are the noisy patterns in <service> this hour", or "give me a snapshot of my loudest events". Can be scoped by service label. For "what changed this week" (deltas vs baseline) use log10x_cost_drivers instead; for "why did costs spike" always prefer cost_drivers because this tool has no new-pattern flag. **Tier prerequisites**: requires Reporter pipeline.',
  topPatternsSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      const result = await executeTopPatterns({ ...args, analyzerCost: cost }, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_list_by_label ──

server.tool(
  'log10x_list_by_label',
  'Rank the distinct values of any label by cost. Use for "cost by namespace", "cost by severity", "cost by country", "cost by container", or any other group-by question. Call log10x_discover_labels first if unsure which label names are valid. **Tier prerequisites**: requires Reporter pipeline.',
  listByLabelSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      const result = await executeListByLabel({ ...args, analyzerCost: cost }, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_investigate ──

server.tool(
  'log10x_investigate',
  'Single-call root-cause investigation for any log line, pattern, service, or environment. Returns a complete causal chain (for acute spikes) or co-drifter cohort (for gradual drift) with confidence scores derived mechanically from data signal quality, plus ready-to-run verification commands. Call whenever the user asks "what is going on with X", "why is X spiking", "investigate X", "what is causing this alert", "why is X creeping", or pastes a log line / alert and asks for diagnosis. Input is the user\'s natural-language target — pass their words verbatim. The tool detects whether the input is a raw log line, pattern identity, service name, or "environment" and runs the appropriate flow. It also detects whether the trajectory is an acute spike or gradual drift and renders a different report shape for each. **Structural wedge**: surfaces log-only signals (connection pool saturation, cache eviction storms, feature-flag cache flushes, retry amplification) that APM does NOT see because they manifest as slow-success traces rather than errors — this is why the tool catches causal chains that Datadog APM, Splunk APM, and OpenTelemetry tracing structurally cannot catch. Show the entire markdown report to the user without modification. Confidence percentages decompose into named sub-scores (stat × lag × chain for acute; slope_sig × cohort for drift) — walk the user through the decomposition when asked. **Tier prerequisites**: requires Reporter pipeline (Cloud or Edge). Drift detection requires continuous historical metrics — the CLI-only mode cannot do slope-similarity correlation. For direct forensic retrieval of specific historical events, use log10x_streamer_query instead. For metric backfill from the archive, use log10x_backfill_metric instead.',
  investigateSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const result = await executeInvestigate(args, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_investigation_get ──

server.tool(
  'log10x_investigation_get',
  'Retrieve a prior log10x_investigate report by investigation_id, or list the most recent investigations in this session. Call when the user references a prior investigation ("expand on investigation abc123", "what did we find last time", "show me that report again") or when you need to cross-reference patterns across multiple investigations in the same session without re-running the correlation. Session-local — the cache dies with the process and holds the 50 most recent investigations.',
  investigationGetSchema,
  async (args) => {
    try {
      const result = executeInvestigationGet(args);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_resolve_batch ──

server.tool(
  'log10x_resolve_batch',
  'Templatize a batch of log events and return structured per-pattern triage with variable concentrations and next-action suggestions. Call whenever the user provides a batch of events to analyze: a pasted Datadog/Splunk/Elastic query result, a Slack incident with attached log lines, kubectl logs output, any raw log text dump, or when the user asks "what patterns are in these events" / "triage this batch". Input is the events themselves (file path, inline array, or raw text). The templater runs via the Log10x paste endpoint; the response structures the batch by stable templateHash, per-pattern frequency and severity, full template structure, and per-slot variable value distribution (answering "for whom is this happening" within the batch). Each pattern in the output carries next_actions suggesting log10x_investigate (for historical correlation), log10x_streamer_query (for archive retrieval), and native SIEM commands with the dominant variable filter pre-constructed. Do NOT call for single-line resolution — use log10x_event_lookup for that. Variable naming honest: structured-log slots get high-confidence names from JSON/logfmt keys; free-text slots with natural-language tokens get medium-confidence inferred names with "(inferred)" annotation; positional-only slots get "slot N" with no hallucinated name. **Tier prerequisites**: works at any tier including CLI-only. Runs via the Log10x paste endpoint by default (raw log text leaves the caller\'s machine); set privacy_mode=true to route through a locally-installed tenx CLI instead (local-only processing, CLI install required).',
  resolveBatchSchema,
  async (args) => {
    try {
      const result = await executeResolveBatch(args);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_streamer_query ──

server.tool(
  'log10x_streamer_query',
  'Direct retrieval of historical events from the Log10x Storage Streamer archive (customer\'s S3 bucket) by stable pattern identity, with optional JavaScript filter expressions over event payloads. Call when: (a) the user asks for specific events matching a pattern over a time window that is OUTSIDE the SIEM\'s retention, (b) the user asks to retrieve events filtered by a variable value that is NOT a faceted dimension in their SIEM (e.g., "all payment_retry events for customer acme-corp from 90 days ago"), (c) compliance, legal, audit, or forensic workflows need exact event retrieval with stable identity. Do NOT call when the events are in the SIEM\'s current retention and can be queried natively faster, or when the user wants aggregated metrics over time instead of specific events (use log10x_backfill_metric or log10x_investigate instead). No re-ingestion. No proprietary format. The archive is in the customer\'s own S3 bucket and queries are scoped to the matching templateHash via pre-computed Bloom filters so only relevant byte ranges are fetched. Three output formats: events (raw with metadata), count (distribution summary), aggregated (bucketed time series). **Tier prerequisites**: requires Storage Streamer component deployed. Does NOT require Reporter. Returns a graceful "Streamer not configured" message when LOG10X_STREAMER_URL is unset.',
  streamerQuerySchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const result = await executeStreamerQuery(args, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_backfill_metric ──

server.tool(
  'log10x_backfill_metric',
  'Define a new metric (Datadog, Prometheus remote_write) backfilled with historical data from the Log10x Streamer archive, with optional forward-emission handoff to the live Reporter for continuous population going forward. Call when: (a) the user wants to define a new SLO, alert, or dashboard metric that needs historical context from day one, (b) the customer did not pre-instrument the metric in their TSDB and cannot backfill it from the TSDB\'s own data, (c) historical events are available in the Streamer archive (typically 90-180 days back), (d) the user specifies a pattern, grouping dimensions, aggregation, and destination TSDB. Do NOT call when the metric already exists in the destination TSDB. **This is the single highest-value Log10x-only capability**: Datadog log-based metrics only work on currently-indexed data; Splunk log-based metrics only work over indexed retention; Cribl can emit forward but cannot backfill from archive; Athena + remote-write Lambda is possible but represents 2-4 weeks of data-engineering per metric. This tool collapses that to ~15 minutes of config. Tool runs the Streamer query, aggregates events into bucketed time series (count / sum_bytes / unique_values / rate_per_second), emits to the destination with historical timestamps preserved, and returns a view URL. Datadog and Prometheus (via remote_write adapter) are wired today; CloudWatch/Elastic/SignalFx return "not yet implemented". **Tier prerequisites**: requires Streamer component deployed. Reporter required only when emit_forward=true (default false in this build — the Reporter config update path for forward-emission handoff is not yet wired, so current usage is one-time historical backfill).',
  backfillMetricSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const result = await executeBackfillMetric(args, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Resource: log10x://status ──

server.resource(
  'pipeline-status',
  'log10x://status',
  { description: 'Current pipeline health and volume summary', mimeType: 'text/plain' },
  async () => {
    const env = envs.default;
    const text = await getStatus(env);
    return { contents: [{ uri: 'log10x://status', text, mimeType: 'text/plain' }] };
  }
);

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
