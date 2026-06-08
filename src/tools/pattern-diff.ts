/**
 * @catalog_tier      A
 * @guardrail         pattern_id_stability
 * @joins             first_seen
 * @routes_to         log10x_pattern_examples, log10x_pattern_trend
 * @_audit_rationale  Stable pattern identity makes set-diff coherent across time boundaries (impossible on competitors that re-cluster per query); joins first-seen state for re_emerged + co_emergence_clusters enrichments unique to log10x.
 *
 * log10x_pattern_diff — set diff of patterns across a time boundary.
 *
 * Answers "what changed across this time boundary?" by comparing pattern
 * presence in two windows: a `before` window and an `after` window. Returns
 * three sets — new (present after, absent before), retired (present before,
 * absent after), persistent (present in both) — plus two enrichments only
 * meaningful in log10x:
 *
 *   - `re_emerged`: patterns flagged as new that ACTUALLY existed prior to
 *     the before-window (their first_seen predates it). These are "the bug
 *     we thought we fixed is back" cases, not genuinely new patterns.
 *
 *   - `co_emergence_clusters`: groups of 3+ patterns whose first_seen
 *     timestamps cluster within ±60s. A deploy fingerprint — no CI/CD
 *     integration required; the agent then queries the customer's deploy
 *     system externally with the timestamp.
 *
 * Why this is the differentiating tool in the catalog: pattern identity is
 * stable across log-format drift, so the set diff is COHERENT across time
 * boundaries. On any pattern-detection competitor that re-clusters per query
 * (Datadog Log Patterns, Cribl, Edge Delta), the "patterns" on each side of
 * the boundary aren't comparable — their IDs change every query. The diff
 * question is incoherent there; it works here.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { bytesToCost, parsePrometheusValue } from '../lib/cost.js';
import { resolveRate, destinationFromEnvAnalyzer } from '../lib/rate-resolution.js';
import { resolveMetricsEnv, resolveMetricsEnvFiltered } from '../lib/resolve-env.js';
import { parseTimeframe } from '../lib/format.js';
import { fetchFirstSeenBatch } from '../lib/first-seen.js';
import { type StructuredOutput } from '../lib/output-types.js';
import {
  groupRowsByPattern,
  patternDescriptor,
  type ServiceIdentity,
  type RawPatternServiceRow,
} from '../lib/pattern-descriptor.js';
import { validateStrictArgs } from '../lib/strict-args.js';
import { wrapBackendError } from '../lib/primitive-errors.js';
import {
  buildChassisEnvelope,
  buildChassisErrorEnvelope,
  newChassisTelemetry,
  recordQuery,
} from '../lib/chassis-envelope.js';

export const patternDiffSchema = {
  timeRange: z
    .enum(['1h', '6h', '1d', '7d', '30d'])
    .default('1d')
    .describe(
      'Window size on both sides of the boundary. The tool compares the most recent `timeRange` ' +
      '("after") against the immediately preceding `timeRange` ("before"). Example: ' +
      '`timeRange: "1d"` compares today vs yesterday.',
    ),
  service: z.string().optional().describe('Service name to scope. Omit for all services.'),
  severity: z.string().optional().describe('Severity to scope (e.g. `ERROR`, `CRITICAL`).'),
  limit: z
    .number()
    .min(1)
    .max(50)
    .default(20)
    .describe('Max rows per category (new / retired / persistent / re_emerged). Default 20.'),
  co_emergence_window_seconds: z
    .number()
    .min(10)
    .max(600)
    .default(60)
    .describe('Time spread for clustering co-emergent patterns. Default 60s — tight enough to fingerprint a single deploy.'),
  min_co_emergence_cluster_size: z
    .number()
    .min(2)
    .max(20)
    .default(3)
    .describe('Minimum cluster size to emit. Default 3 — 2 patterns sharing a timestamp is often coincidence.'),
  analyzerCost: z.number().optional().describe('stack ingestion cost in $/GB. Auto-detected from profile.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
  view: z.enum(['summary', 'markdown']).default('summary').describe('Output format.'),
};

interface DiffServiceRow extends ServiceIdentity {
  bytes_now: number;
  bytes_before: number;
  cost_now_usd: number;
  cost_before_usd: number;
}

interface DiffRow {
  pattern_hash: string;
  symbol_message: string;
  severities: string[];
  bytes_now: number;
  bytes_before: number;
  cost_now_usd: number;
  cost_before_usd: number;
  first_seen_age_seconds: number | null;
  services: DiffServiceRow[];
}

interface CoEmergenceCluster {
  patterns: string[];
  first_seen_window_ts: [number, number];
  cluster_size: number;
}

interface PatternDiffData {
  time_range: string;
  after_window_label: string;
  before_window_label: string;
  new: DiffRow[];
  retired: DiffRow[];
  persistent: DiffRow[];
  re_emerged: DiffRow[];
  co_emergence_clusters: CoEmergenceCluster[];
  totals: {
    new: number;
    retired: number;
    persistent: number;
    re_emerged: number;
  };
}

export async function executePatternDiff(
  args: {
    timeRange?: string;
    service?: string;
    severity?: string;
    limit?: number;
    co_emergence_window_seconds?: number;
    min_co_emergence_cluster_size?: number;
    analyzerCost?: number;
    view?: 'summary' | 'markdown';
  },
  env: EnvConfig,
): Promise<string | StructuredOutput> {
  // Strict-args boundary: reject undeclared keys at the executor entry so a
  // typo doesn't ride through into a silently dropped argument.
  const strict = validateStrictArgs<typeof args>('log10x_pattern_diff', patternDiffSchema, args);
  if (strict.error) return strict.error;

  const telemetry = newChassisTelemetry();
  const timeRange = args.timeRange ?? '1d';
  const limit = args.limit ?? 20;
  const coEmergeWindowSec = args.co_emergence_window_seconds ?? 60;
  const minClusterSize = args.min_co_emergence_cluster_size ?? 3;
  // Resolve $/GB via the shared chain (caller arg → envs.json analyzerCost →
  // LOG10X_ANALYZER_COST → destination list price). No fabricated $1.0 fallback;
  // 0 only when neither a rate nor a destination is known.
  const rateResolved = resolveRate(
    { analyzerCost: args.analyzerCost },
    env,
    destinationFromEnvAnalyzer(env),
  );
  const costPerGb = rateResolved.rate_per_gb ?? 0;
  const view = args.view ?? 'summary';

  const tf = parseTimeframe(timeRange);

  // Threshold provenance: both co-emergence thresholds are hand-picked
  // defaults until calibrated externally; surface that to the agent.
  const coEmergeIsDefault = args.co_emergence_window_seconds === undefined;
  const minClusterIsDefault = args.min_co_emergence_cluster_size === undefined;
  const decisions = {
    threshold_used: coEmergeWindowSec,
    threshold_basis:
      coEmergeIsDefault && minClusterIsDefault
        ? ('unvalidated_default' as const)
        : ('customer_supplied' as const),
    threshold_audit: {
      value: coEmergeWindowSec,
      basis: `co_emergence_window_seconds=${coEmergeWindowSec}, min_co_emergence_cluster_size=${minClusterSize}`,
    },
  };
  // Provenance for the dollar columns (cost_now_usd / cost_before_usd). The
  // rate is resolved via the shared chain above; surface its source so the
  // dollar surface is auditable, mirroring top_patterns/baseline/services.
  // 'unset' is this module's term for no rate; the chassis enum calls it 'none'.
  const sourceDisclosure = {
    bytes_source: 'tsdb' as const,
    rate_source:
      rateResolved.source === 'customer_supplied'
        ? ('customer_supplied' as const)
        : rateResolved.source === 'list_price'
          ? ('list_price' as const)
          : ('none' as const),
  };
  const scopeBase = {
    window: tf.label,
    window_basis: 'explicit' as const,
  };

  const filters: Record<string, string> = {};
  if (args.service) filters[LABELS.service] = args.service;
  if (args.severity) filters[LABELS.severity] = args.severity;

  const metricsEnv =
    Object.keys(filters).length > 0
      ? await resolveMetricsEnvFiltered(env, filters)
      : await resolveMetricsEnv(env);

  // Two PromQL queries: bytes-per-pattern at "now" and at "now - 1 window"
  // (the previous full window).
  let afterRes: Awaited<ReturnType<typeof queryInstant>>;
  let beforeRes: Awaited<ReturnType<typeof queryInstant>>;
  try {
    [afterRes, beforeRes] = await Promise.all([
      queryInstant(env, pql.bytesPerPattern(filters, metricsEnv, tf.range)),
      queryInstant(env, pql.bytesPerPattern(filters, metricsEnv, tf.range, tf.days)),
    ]);
    recordQuery(telemetry);
    recordQuery(telemetry);
  } catch (e) {
    recordQuery(telemetry);
    const err = wrapBackendError(e);
    return buildChassisErrorEnvelope({
      tool: 'log10x_pattern_diff',
      err,
      telemetry,
      scope: scopeBase,
      source_disclosure: sourceDisclosure,
      contextPayload: {
        time_range: tf.label,
        comparison: 'after_vs_before',
      },
    });
  }

  if (afterRes.status !== 'success' && beforeRes.status !== 'success') {
    return buildChassisEnvelope({
      tool: 'log10x_pattern_diff',
      view: 'summary',
      headline: `No pattern data available for ${tf.label} comparison.`,
      status: 'no_signal',
      decisions,
      source_disclosure: sourceDisclosure,
      scope: scopeBase,
      payload: {
        time_range: tf.label,
        after_window_label: `last ${tf.range}`,
        before_window_label: `prior ${tf.range}`,
        new: [],
        retired: [],
        persistent: [],
        re_emerged: [],
        co_emergence_clusters: [],
        totals: { new: 0, retired: 0, persistent: 0, re_emerged: 0 },
      },
      human_summary: `No pattern data over ${tf.label}. Patterns surface after ~24h of metric collection — widen the window or wait for ingestion to catch up.`,
      telemetry,
    });
  }

  // Raw rows for each window. Both windows produce per-(symbol_message,
  // service, severity) tuples; combine into a single raw-row list per
  // window, then group by pattern (hash derived locally from
  // symbol_message). Earlier versions of this tool stored the snake_case
  // symbol_message in fields named `hash` and last-write-wins-collapsed
  // multi-service patterns to a single service.
  interface DiffRawRow extends RawPatternServiceRow {
    bytes_now: number;
    bytes_before: number;
  }
  const rawKey = (sm: string, svc: string, sev: string) => `${sm}\x00${svc}\x00${sev}`;
  const rawByKey = new Map<string, DiffRawRow>();
  const ensure = (sm: string, svc: string, sev: string): DiffRawRow => {
    const k = rawKey(sm, svc, sev);
    let row = rawByKey.get(k);
    if (!row) {
      row = { symbolMessage: sm, service: svc, severity: sev, bytes_now: 0, bytes_before: 0 };
      rawByKey.set(k, row);
    }
    return row;
  };
  if (afterRes.status === 'success') {
    for (const r of afterRes.data.result) {
      const sm = r.metric[LABELS.pattern];
      if (!sm) continue;
      ensure(sm, r.metric[LABELS.service] || '', r.metric[LABELS.severity] || '').bytes_now =
        parsePrometheusValue(r);
    }
  }
  if (beforeRes.status === 'success') {
    for (const r of beforeRes.data.result) {
      const sm = r.metric[LABELS.pattern];
      if (!sm) continue;
      ensure(sm, r.metric[LABELS.service] || '', r.metric[LABELS.severity] || '').bytes_before =
        parsePrometheusValue(r);
    }
  }
  const rawRows = Array.from(rawByKey.values());

  // Group by pattern. A pattern is "in" a window when ANY service has
  // bytes > 0 there. This is the pattern-level identity question:
  // per-service presence becomes a structured fact inside services[].
  const groups = groupRowsByPattern(rawRows, new Map());
  const presence = new Map<string, { inAfter: boolean; inBefore: boolean }>();
  for (const g of groups) {
    let inAfter = false;
    let inBefore = false;
    for (const raw of g.rows_by_service.values()) {
      if (raw.bytes_now > 0) inAfter = true;
      if (raw.bytes_before > 0) inBefore = true;
    }
    presence.set(g.pattern_hash, { inAfter, inBefore });
  }

  const newHashes: string[] = [];
  const retiredHashes: string[] = [];
  const persistentHashes: string[] = [];
  for (const [hash, p] of presence) {
    if (p.inAfter && p.inBefore) persistentHashes.push(hash);
    else if (p.inAfter && !p.inBefore) newHashes.push(hash);
    else if (!p.inAfter && p.inBefore) retiredHashes.push(hash);
  }

  // first_seen enrichment for new + retired (used for re-emergence detection
  // and co-emergence clustering). Persistent patterns don't need it — they
  // exist in both windows by definition.
  let firstSeenByHash: Awaited<ReturnType<typeof fetchFirstSeenBatch>>;
  try {
    firstSeenByHash = await fetchFirstSeenBatch(env, [...newHashes, ...retiredHashes]);
    recordQuery(telemetry);
  } catch (e) {
    recordQuery(telemetry);
    const err = wrapBackendError(e);
    return buildChassisErrorEnvelope({
      tool: 'log10x_pattern_diff',
      err,
      telemetry,
      scope: { ...scopeBase, candidates_count: newHashes.length + retiredHashes.length },
      source_disclosure: sourceDisclosure,
      contextPayload: {
        time_range: tf.label,
        stage: 'first_seen_enrichment',
        new_candidates: newHashes.length,
        retired_candidates: retiredHashes.length,
      },
    });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const beforeWindowStartSec = nowSec - 2 * tf.days * 86400;

  // Re-emergence threshold tightening: with a sparse env, half the
  // patterns naturally blink in and out per window. "Re-emerged" should mean
  // a pattern that was meaningfully persistent BEFORE it went silent AND was
  // silent for a meaningful stretch. Defaults: persistent ≥ 6h before
  // silence, silence ≥ 6h before re-emergence. We approximate "persistent
  // before silence" by requiring first_seen to predate the before-window by
  // at least MIN_PRIOR_PERSISTENCE_SEC (so the pattern had room to be
  // persistent before it went quiet). The silence gap itself is the
  // before-window length — anything shorter than MIN_SILENCE_SEC is filtered
  // out as noise.
  const MIN_PRIOR_PERSISTENCE_SEC = 6 * 3600;
  const MIN_SILENCE_SEC = 6 * 3600;
  const windowSec = tf.days * 86400;
  const silenceGapSec = windowSec; // length of the before-window the pattern was absent from

  // Re-emergence: a "new" pattern whose first_seen predates the before
  // window AND has had time to be persistent before going quiet AND the
  // silence gap itself is meaningful. Anything else is a sparse-emission
  // blink and gets routed back into trueNewHashes for ranking sanity.
  const reEmergedHashes: string[] = [];
  const trueNewHashes: string[] = [];
  // Cache the silence gap (seconds) per re-emerged hash for ranking below.
  const silenceGapByHash = new Map<string, number>();
  for (const hash of newHashes) {
    const fs = firstSeenByHash.get(hash);
    const firstSeenOk =
      fs &&
      fs.firstSeenUnix !== null &&
      fs.firstSeenUnix < beforeWindowStartSec - MIN_PRIOR_PERSISTENCE_SEC;
    const silenceOk = silenceGapSec >= MIN_SILENCE_SEC;
    if (firstSeenOk && silenceOk) {
      reEmergedHashes.push(hash);
      silenceGapByHash.set(hash, silenceGapSec);
    } else {
      trueNewHashes.push(hash);
    }
  }

  // Co-emergence: cluster "true new" patterns by first_seen timestamp.
  // Greedy: sort by timestamp, walk forward, group anything within
  // co_emergence_window_seconds of the first member. Yields a "deploy
  // fingerprint" without touching CI/CD.
  const stampedNew: Array<{ hash: string; ts: number }> = [];
  for (const hash of trueNewHashes) {
    const fs = firstSeenByHash.get(hash);
    if (fs && fs.firstSeenUnix !== null) {
      stampedNew.push({ hash, ts: fs.firstSeenUnix });
    }
  }
  stampedNew.sort((a, b) => a.ts - b.ts);

  const clusters: CoEmergenceCluster[] = [];
  let i = 0;
  while (i < stampedNew.length) {
    const anchor = stampedNew[i];
    const members: Array<{ hash: string; ts: number }> = [anchor];
    let j = i + 1;
    while (j < stampedNew.length && stampedNew[j].ts - anchor.ts <= coEmergeWindowSec) {
      members.push(stampedNew[j]);
      j += 1;
    }
    if (members.length >= minClusterSize) {
      clusters.push({
        patterns: members.map((m) => m.hash),
        first_seen_window_ts: [members[0].ts, members[members.length - 1].ts],
        cluster_size: members.length,
      });
    }
    i = j > i + 1 ? j : i + 1;
  }

  // Build DiffRow per pattern. cost_now / cost_before are sums across
  // services. Per-service presence (bytes_now / bytes_before) is
  // exposed inside services[] so the agent can see which services
  // the pattern entered or left.
  const groupByHash = new Map(groups.map((g) => [g.pattern_hash, g]));
  const buildRow = (hash: string): DiffRow => {
    const g = groupByHash.get(hash);
    if (!g) {
      return {
        pattern_hash: hash,
        symbol_message: '',
        severities: [],
        bytes_now: 0,
        bytes_before: 0,
        cost_now_usd: 0,
        cost_before_usd: 0,
        first_seen_age_seconds: firstSeenByHash.get(hash)?.ageSeconds ?? null,
        services: [],
      };
    }
    let bytesNowTotal = 0;
    let bytesBeforeTotal = 0;
    const services: DiffServiceRow[] = [];
    for (const [svc, raw] of g.rows_by_service) {
      bytesNowTotal += raw.bytes_now;
      bytesBeforeTotal += raw.bytes_before;
      services.push({
        name: svc,
        severity: raw.severity,
        bytes_now: raw.bytes_now,
        bytes_before: raw.bytes_before,
        cost_now_usd: bytesToCost(raw.bytes_now, costPerGb),
        cost_before_usd: bytesToCost(raw.bytes_before, costPerGb),
      });
    }
    services.sort((a, b) => b.cost_now_usd + b.cost_before_usd - (a.cost_now_usd + a.cost_before_usd));
    return {
      pattern_hash: hash,
      symbol_message: g.symbol_message,
      severities: g.severities,
      bytes_now: bytesNowTotal,
      bytes_before: bytesBeforeTotal,
      cost_now_usd: bytesToCost(bytesNowTotal, costPerGb),
      cost_before_usd: bytesToCost(bytesBeforeTotal, costPerGb),
      first_seen_age_seconds: firstSeenByHash.get(hash)?.ageSeconds ?? null,
      services,
    };
  };

  // Sort each bucket by relevance. New + re_emerged: by cost_now desc (most
  // expensive new arrivals first). Retired: by cost_before desc (biggest
  // bytes-savings from a retired pattern first). Persistent: not the focus,
  // sort by cost_now desc but return only the top N.
  const sortDesc = (rows: DiffRow[], field: 'cost_now_usd' | 'cost_before_usd') =>
    rows.sort((x, y) => y[field] - x[field]);

  const newRows = sortDesc(trueNewHashes.map(buildRow), 'cost_now_usd').slice(0, limit);
  const retiredRows = sortDesc(retiredHashes.map(buildRow), 'cost_before_usd').slice(0, limit);
  const persistentRows = sortDesc(persistentHashes.map(buildRow), 'cost_now_usd').slice(0, limit);
  // Re-emerged ranking: rank by "surprise" = silence_gap × current
  // volume. The longer the silence and the louder the return, the more
  // likely this is a real regression worth surfacing. Cap displayed count
  // tightly (max 10) so the user gets a focused list even when the raw
  // re-emerged set is huge.
  const RE_EMERGED_DISPLAY_CAP = Math.min(limit, 10);
  const reEmergedAllRows = reEmergedHashes.map(buildRow);
  reEmergedAllRows.sort((a, b) => {
    const aGap = silenceGapByHash.get(a.pattern_hash) ?? 0;
    const bGap = silenceGapByHash.get(b.pattern_hash) ?? 0;
    return bGap * b.bytes_now - aGap * a.bytes_now;
  });
  const reEmergedRows = reEmergedAllRows.slice(0, RE_EMERGED_DISPLAY_CAP);

  const afterLabel = `last ${tf.range}`;
  const beforeLabel = `prior ${tf.range}`;

  const data: PatternDiffData = {
    time_range: tf.label,
    after_window_label: afterLabel,
    before_window_label: beforeLabel,
    new: newRows,
    retired: retiredRows,
    persistent: persistentRows,
    re_emerged: reEmergedRows,
    co_emergence_clusters: clusters,
    totals: {
      new: trueNewHashes.length,
      retired: retiredHashes.length,
      persistent: persistentHashes.length,
      re_emerged: reEmergedHashes.length,
    },
  };

  // Headline framing: when re-emerged count is large (>30), the
  // signal-to-noise of "silent regression" framing collapses — it's just
  // high churn in a sparse env. Flip to "high pattern churn" framing and
  // promise the top N most surprising ones. Below 30, the focused
  // "re-emerged" framing still earns its keep.
  const RE_EMERGED_CHURN_THRESHOLD = 30;
  const highChurn = reEmergedHashes.length > RE_EMERGED_CHURN_THRESHOLD;

  const headlineParts: string[] = [];
  if (trueNewHashes.length > 0) headlineParts.push(`${trueNewHashes.length} new`);
  if (retiredHashes.length > 0) headlineParts.push(`${retiredHashes.length} retired`);
  if (reEmergedHashes.length > 0) {
    headlineParts.push(
      highChurn
        ? `${reEmergedHashes.length} re-emerged (high churn)`
        : `${reEmergedHashes.length} re-emerged`,
    );
  }
  headlineParts.push(`${persistentHashes.length} persistent`);
  const headline = `Pattern diff over ${tf.label}: ${headlineParts.join(', ')}.`;

  const callout =
    clusters.length > 0
      ? `${clusters.length} group${clusters.length === 1 ? '' : 's'} of patterns appearing together ` +
        `(${minClusterSize}+ patterns first appearing within ~${coEmergeWindowSec}s of each other) — ` +
        `consider checking your deploy log around the group timestamps.`
      : reEmergedHashes.length > 0
      ? highChurn
        ? `High pattern churn this window — ${reEmergedHashes.length} patterns blinked back after silence (typical for a sparse env). Showing the top ${reEmergedRows.length} by silence-gap and current volume.`
        : `${reEmergedHashes.length} pattern${reEmergedHashes.length === 1 ? '' : 's'} re-emerged after being silent — worth a look before assuming a regression.`
      : undefined;

  const totalChange =
    trueNewHashes.length + retiredHashes.length + persistentHashes.length + reEmergedHashes.length;
  const allEmpty =
    trueNewHashes.length === 0 &&
    retiredHashes.length === 0 &&
    persistentHashes.length === 0 &&
    reEmergedHashes.length === 0;
  const status: 'success' | 'no_signal' = allEmpty ? 'no_signal' : 'success';

  const scope = {
    ...scopeBase,
    candidates_count: groups.length,
    candidates_usable: totalChange,
    candidates_evaluated: groups.length,
  };

  // Honest human_summary with a next-step pointer. Calibration caveat
  // attached when the co-emergence thresholds are still defaults.
  const calibTag =
    decisions.threshold_basis === 'unvalidated_default'
      ? ' Group window + min-group-size are unvalidated defaults; treat groups as hints, not confirmed deploys.'
      : '';
  const humanSummary =
    status === 'no_signal'
      ? `No pattern changes detected across ${afterLabel} vs ${beforeLabel}. The diff is structurally empty — either the workload is steady or the window is too narrow.${calibTag}`
      : `Pattern diff over ${tf.label}: ${trueNewHashes.length} new, ${retiredHashes.length} retired, ${reEmergedHashes.length} re-emerged, ${persistentHashes.length} persistent. ` +
        (clusters.length > 0
          ? `${clusters.length} group${clusters.length === 1 ? '' : 's'} of patterns appearing together flagged — check your deploy log around the group timestamps. `
          : reEmergedHashes.length > 0
          ? highChurn
            ? `High churn in a sparse env — showing the top ${reEmergedRows.length} re-emerged by silence gap and volume; the rest are likely sparse-emission blinks. `
            : `Re-emerged patterns ranked by silence gap × current volume — start at the top. `
          : `Inspect the top new pattern with log10x_pattern_examples. `) +
        calibTag;

  const builtActions = [
    ...(newRows[0]
      ? [
          {
            tool: 'log10x_pattern_examples',
            args: { pattern: newRows[0].pattern_hash, timeRange: tf.range },
            reason: 'see what the top new pattern actually looks like',
          },
        ]
      : []),
    ...(reEmergedRows[0]
      ? [
          {
            tool: 'log10x_pattern_trend',
            args: { pattern: reEmergedRows[0].pattern_hash, timeRange: '30d' },
            reason: "inspect the re-emerged pattern's full trajectory — when did it go silent, when did it come back",
          },
        ]
      : []),
    ...(clusters.length > 0
      ? [
          {
            tool: 'log10x_pattern_examples',
            args: { pattern: clusters[0].patterns[0], timeRange: tf.range },
            reason: `inspect the first pattern in the largest group of patterns appearing together (${clusters[0].cluster_size} patterns at ${new Date(clusters[0].first_seen_window_ts[0] * 1000).toISOString()})`,
          },
        ]
      : []),
  ];

  if (view === 'markdown') {
    const lines = [
      `## Pattern diff — ${tf.label}`,
      ``,
      `Comparison: ${afterLabel} vs ${beforeLabel}`,
      ``,
      `**Totals**: ${trueNewHashes.length} new · ${retiredHashes.length} retired · ${persistentHashes.length} persistent · ${reEmergedHashes.length} re-emerged`,
    ];
    if (clusters.length > 0) {
      lines.push(
        ``,
        `**Groups of patterns appearing together** (${clusters.length}) — likely tied to deploys or config changes:`,
      );
      // Format: "Group N (appeared around HH:MM UTC, K patterns)" followed by
      // per-pattern lines `service · severity · short descriptor`.
      // Hashes stay machine-side; the agent reads the patterns[]
      // array from the structured payload to drill in.
      const fmtClusterTime = (epochSec: number) => {
        const d = new Date(epochSec * 1000);
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        return `${hh}:${mm} UTC`;
      };
      clusters.forEach((c, idx) => {
        const when = fmtClusterTime(c.first_seen_window_ts[0]);
        lines.push(``, `**Group ${idx + 1}** (appeared around ${when}, ${c.cluster_size} patterns)`);
        for (const hash of c.patterns) {
          const g = groupByHash.get(hash);
          const topSvc = g?.rows_by_service
            ? Array.from(g.rows_by_service.values())[0]
            : undefined;
          const svc = topSvc?.service || '(unknown service)';
          const sev = topSvc?.severity || (g?.severities[0] ?? '');
          const sm = g?.symbol_message || '';
          const descriptor = sm ? patternDescriptor(sm, '', 60) : '(no descriptor)';
          const sevPart = sev ? ` · ${sev}` : '';
          lines.push(`- ${svc}${sevPart} · ${descriptor}`);
        }
      });
    }
    const svcList = (r: DiffRow) => r.services.map((s) => s.name).join(', ');
    const sevList = (r: DiffRow) => r.severities.join('/');
    // Pattern column shows the human-readable symbol_message, NOT the hash
    // (hash stays in machine fields only). Truncate long symbol
    // messages so the table column stays readable.
    const patternLabel = (r: DiffRow) => {
      const sm = r.symbol_message || '(unknown pattern)';
      return sm.length > 60 ? sm.slice(0, 57) + '…' : sm;
    };
    if (newRows.length > 0) {
      lines.push(``, `### New (${newRows.length} shown of ${trueNewHashes.length})`);
      lines.push(`| Pattern | Services | Severity | Cost now ($) |`);
      lines.push(`|---------|----------|----------|--------------|`);
      for (const r of newRows) {
        lines.push(`| ${patternLabel(r)} | ${svcList(r)} | ${sevList(r)} | $${r.cost_now_usd.toFixed(2)} |`);
      }
    }
    if (reEmergedRows.length > 0) {
      lines.push(``, `### Re-emerged (top ${reEmergedRows.length} by silence-gap × volume, of ${reEmergedHashes.length})`);
      lines.push(`| Pattern | Services | Severity | Cost now ($) | First seen (age) |`);
      lines.push(`|---------|----------|----------|--------------|------------------|`);
      for (const r of reEmergedRows) {
        const age = r.first_seen_age_seconds !== null ? `${Math.floor(r.first_seen_age_seconds / 86400)}d ago` : '?';
        lines.push(`| ${patternLabel(r)} | ${svcList(r)} | ${sevList(r)} | $${r.cost_now_usd.toFixed(2)} | ${age} |`);
      }
    }
    if (retiredRows.length > 0) {
      lines.push(``, `### Retired (${retiredRows.length} shown of ${retiredHashes.length})`);
      lines.push(`| Pattern | Services | Severity | Cost before ($) |`);
      lines.push(`|---------|----------|----------|-----------------|`);
      for (const r of retiredRows) {
        lines.push(`| ${patternLabel(r)} | ${svcList(r)} | ${sevList(r)} | $${r.cost_before_usd.toFixed(2)} |`);
      }
    }
    return buildChassisEnvelope({
      tool: 'log10x_pattern_diff',
      view: 'markdown',
      headline,
      headline_callout: callout,
      status,
      decisions,
      source_disclosure: sourceDisclosure,
      scope,
      payload: data,
      human_summary: humanSummary,
      must_render_verbatim: lines.join('\n'),
      telemetry,
      actions: builtActions,
    });
  }

  // Surface group contents in must_render_verbatim for the summary view too:
  // a bare "3 groups detected" count without member listings is useless on its
  // own. Same per-cluster format as the markdown view:
  // "Group N (appeared around HH:MM UTC, K patterns)" then per-pattern
  // `service · severity · short descriptor` lines. Hashes stay machine-side.
  let summaryVerbatim: string | undefined;
  if (clusters.length > 0) {
    const fmtClusterTime = (epochSec: number) => {
      const d = new Date(epochSec * 1000);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      return `${hh}:${mm} UTC`;
    };
    const sumLines: string[] = [
      `**Groups of patterns appearing together** (${clusters.length}) — likely tied to deploys or config changes:`,
    ];
    clusters.forEach((c, idx) => {
      const when = fmtClusterTime(c.first_seen_window_ts[0]);
      sumLines.push(``, `**Group ${idx + 1}** (appeared around ${when}, ${c.cluster_size} patterns)`);
      for (const hash of c.patterns) {
        const g = groupByHash.get(hash);
        const topSvc = g?.rows_by_service
          ? Array.from(g.rows_by_service.values())[0]
          : undefined;
        const svc = topSvc?.service || '(unknown service)';
        const sev = topSvc?.severity || (g?.severities[0] ?? '');
        const sm = g?.symbol_message || '';
        const descriptor = sm ? patternDescriptor(sm, '', 60) : '(no descriptor)';
        const sevPart = sev ? ` · ${sev}` : '';
        sumLines.push(`- ${svc}${sevPart} · ${descriptor}`);
      }
    });
    summaryVerbatim = sumLines.join('\n');
  }

  // The displayed arrays are capped at `limit` (re_emerged at min(limit,10))
  // while totals carry the full counts. Set the outer envelope truncated flag
  // whenever any category's shown rows fall short of its total, so a consumer
  // reading truncated:false can trust the arrays are complete.
  const truncated =
    newRows.length < data.totals.new ||
    retiredRows.length < data.totals.retired ||
    persistentRows.length < data.totals.persistent ||
    reEmergedRows.length < data.totals.re_emerged;

  return buildChassisEnvelope({
    tool: 'log10x_pattern_diff',
    view: 'summary',
    headline,
    headline_callout: callout,
    status,
    decisions,
    source_disclosure: sourceDisclosure,
    scope,
    payload: data,
    human_summary: humanSummary,
    must_render_verbatim: summaryVerbatim,
    telemetry,
    actions: builtActions,
    truncated,
  });
}
