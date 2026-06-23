/**
 * log10x_pattern_examples — return recent live events for a pattern with
 * template-extracted slot values per match.
 *
 * Orchestration primitive, not user-callable in practice. Intended to be
 * called by `log10x_investigate` (or another orchestrator) after a metric
 * tier identification when the chain needs event evidence to form a
 * hypothesis.
 *
 * Design contract:
 *   - Inputs: Symbol Message (pattern name) OR pasted log line.
 *   - Bounded to 24h window, log analyzer retention.
 *   - For the offloaded cohort of a pattern (events the Receiver routed to
 *     the overflow bucket) use log10x_retriever_query.
 *   - Mechanism: SIEM phrase-search probe, group by template, content-token
 *     shape-match to discriminate, top 3 buckets by event count.
 *   - Honest output: per-bucket template labels, recall counts, parseFailed
 *     markers when slot extraction fails per event.
 *   - Multi-line group templates: head-line-only with explicit warning,
 *     detected via input_line_count vs encoded.log_row_count delta.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { extractPatterns } from '../lib/pattern-extraction.js';
import { resolveSiemSelection } from '../lib/siem/resolve.js';
import { getConnector, type SiemConnector } from '../lib/siem/index.js';
import type { SiemId } from '../lib/siem/pricing.js';
import { buildHashQuery } from '../lib/siem/hash-query.js';
import { fmtCount, normalizePattern } from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { tenxHash } from '../lib/pattern-hash.js';
import { resolvePatternHashFromMetrics } from '../lib/resolve-pattern-hash.js';
import { agentOnly } from '../lib/agent-only.js';
import {
  buildChassisEnvelope,
  buildChassisErrorEnvelope,
  newChassisTelemetry,
  recordQuery,
} from '../lib/chassis-envelope.js';
import { computeBucketInterpretation } from '../lib/bucket-interpretation.js';
import { normalizeTimeRange } from '../lib/time-range.js';
import { queryInstant } from '../lib/api.js';
import { LABELS } from '../lib/promql.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { sanitizeUserProse } from '../lib/anti-jargon-prose.js';

/**
 * Resolve a pattern_hash to its dominant pattern name (Symbol Message)
 * via TSDB. Mirrors `resolvePatternName` in pattern-detail.ts — topk(1)
 * by total bytes over 7d. Returns null when no metrics carry the hash.
 *
 * pattern_examples accepts pattern_hash as a first-class input; this is
 * the bridge to its existing pattern-name code path. See the executor
 * entry in executePatternExamples for the call site.
 */
async function resolvePatternNameFromHash(env: EnvConfig, hash: string): Promise<string | null> {
  try {
    const metricsEnv = await resolveMetricsEnv(env);
    const q =
      `topk(1, sum by (${LABELS.pattern}) (increase(all_events_summaryBytes_total{` +
      `${LABELS.hash}="${hash.replace(/"/g, '\\"')}",` +
      `${LABELS.env}="${metricsEnv}"}[7d])))`;
    const res = await queryInstant(env, q);
    if (res.status === 'success' && res.data.result.length > 0) {
      return res.data.result[0].metric[LABELS.pattern] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/** SIEM vendors supported by pattern_examples. Inherits from the dep-check / exclusion-filter list. */
const EXAMPLES_VENDORS: readonly SiemId[] = [
  'splunk',
  'datadog',
  'elasticsearch',
  'cloudwatch',
] as const;

export const patternExamplesSchema = {
  pattern: z
    .string()
    .optional()
    .describe(
      'Pattern name (e.g. `Payment_Gateway_Timeout`) or a pasted raw log line. Pasted lines resolve to the matching pattern via the same pattern-extraction path as log10x_resolve_batch. Either pattern or pattern_hash must be provided; pattern_hash is preferred when available.',
    ),
  pattern_hash: z
    .string()
    .optional()
    .describe(
      'Canonical 11-char hash. Either pattern (Symbol Message name) or pattern_hash must be provided; pattern_hash is preferred when available. Resolved to the pattern name via the 10x metrics (same path pattern_detail uses).',
    ),
  vendor: z
    .enum(['splunk', 'datadog', 'elasticsearch', 'cloudwatch'])
    .optional()
    .describe(
      'Log analyzer to search. Auto-detected when exactly one of the supported vendors has credentials in the env; pass explicitly when multiple are configured.',
    ),
  service: z
    .string()
    .optional()
    .describe('Optional service-name scope. Translated to the vendor-specific service filter.'),
  severity: z
    .string()
    .optional()
    .describe('Optional severity scope (e.g., `ERROR`, `WARN`).'),
  timeRange: z
    .enum(['15m', '1h', '6h', '24h', '1d', '7d', '30d'])
    .default('1h')
    .describe("Window for the live SIEM probe. Capped at 24h. To sample a pattern's offloaded cohort (events the Receiver routed to the overflow bucket, which the SIEM never received), use log10x_retriever_query. '1d' is a legacy alias for '24h'."),
  limit: z
    .number()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of sample events per templateHash bucket. 1-50, default 10.'),
  scope: z
    .string()
    .optional()
    .describe(
      'Vendor-specific scope (Splunk index, Datadog index, ES index pattern, CloudWatch log group). Defaults to a sensible per-vendor value when omitted.',
    ),
  slot_filter: z
    .object({
      name: z.string().describe('Slot name as it appears in the slot_distribution (e.g. `userId`, `slot_4`).'),
      value: z.string().describe('Slot value to filter for. Buckets are kept only when their slot_distribution[<name>].sample_values includes <value>.'),
    })
    .optional()
    .describe('Optional slot-value filter. When provided, only buckets whose slot_distribution carries the given slot value pass through. Useful for drilling into a single dominant value from a previous pattern_examples call.'),
  view: z
    .enum(['summary', 'detail'])
    .default('summary')
    .describe(
      "Response shape. `summary` (default) returns slim top-3 buckets (rank, template_hash, tenx_hash, event_count, jaccard, severity, service, recommended_action, headline, ~200-char sample_event preview) plus pattern-level counts. No raw_events, no full sample_event, no slot_distribution, no rationale prose. Target: under 8K tokens. `detail` returns one fully-hydrated bucket (requires bucket_id); pair with retriever_query for raw events.",
    ),
  bucket_id: z
    .string()
    .optional()
    .describe(
      'Bucket identifier to fully hydrate. Accepts either the `template_hash` or the `tenx_hash` returned in a prior `view=summary` call. When supplied, the response carries one bucket with full sample_event, full slot_distribution (un-cropped sample_values), bucket_interpretation.rationale, and human_summary. Other buckets are omitted.',
    ),
  environment: z.string().optional().describe('Environment nickname.'),
};

interface ProgressNote {
  step: string;
  pct: number;
  eventsFetched: number;
}

interface PatternExamplesArgs {
  pattern?: string;
  pattern_hash?: string;
  vendor?: 'splunk' | 'datadog' | 'elasticsearch' | 'cloudwatch';
  service?: string;
  severity?: string;
  timeRange?: string;
  limit?: number;
  scope?: string;
  slot_filter?: { name: string; value: string };
  view?: 'summary' | 'detail';
  bucket_id?: string;
  environment?: string;
}

interface PatternExamplesSummary {
  pattern: string;
  vendor: string;
  window: string;
  service?: string;
  severity?: string;
  probe_path: 'tenx_hash-exact' | 'content-token' | 'paste';
  events_pulled: number;
  distinct_templates: number;
  retained_events: number;
  retained_templates: number;
  dropped_jaccard_events: number;
  multi_line_detected: boolean;
  // Catalog-identity-handoff: the raw SIEM events pulled by the probe,
  // re-emitted in full (no truncation) so chain steps that need
  // the live lines, e.g. resolve_batch, paste-triage, a secondary
  // 10x-engine pass, don't re-issue the same SIEM round-trip. Upstream probe size
  // is bounded by probeBatch + maxPullMinutes so there is no runaway-size
  // risk. Strings are stringified once at emit time (events arrive as
  // `unknown[]` from the connector layer).
  raw_events: string[];
  buckets: Array<{
    rank: number;
    template_hash: string;
    tenx_hash?: string;
    event_count: number;
    jaccard: number;
    severity?: string;
    service?: string;
    sample_event: string;
    slot_distribution: Array<{ slot: string; distinct_count: number; is_constant: boolean; sample_values: string[]; naming_confidence: 'high' | 'medium' | 'low' }>;
    bucket_interpretation: {
      active_emitters: number;
      emitter_type: 'pod' | 'container' | 'process' | 'host';
      content_variance: 'none' | 'low' | 'high';
      envelope_share_of_named_slots: number;
      recommended_action: 'drop' | 'compact' | 'sample' | 'keep';
      rationale: string;
    };
    human_summary: string;
  }>;
  probe_notes: string[];
}

export async function executePatternExamples(
  rawArgs: PatternExamplesArgs,
  env: EnvConfig,
): Promise<import('../lib/output-types.js').StructuredOutput> {
  // Legacy `telemetry = newTelemetry()` dropped along with legacyExtraFields:
  // it only fed the now-removed legacy query_count / total_latency_ms spread,
  // and chassisTelemetry drives the chassis Performance block.
  const chassisTelemetry = newChassisTelemetry();

  // Input acceptance: accept pattern_hash as a first-class alternative to
  // pattern (Symbol Message name). When pattern_hash is supplied and
  // pattern is not, resolve the hash to its dominant pattern name via the
  // same TSDB lookup pattern_detail uses (most-emitting pattern label for
  // this hash over 7d). On resolution failure we fall through with a
  // graceful no_signal envelope rather than blocking the call — the
  // canonical-pattern path also gracefully degrades when no metrics carry
  // the pattern.
  let resolvedArgs: PatternExamplesArgs = rawArgs;
  let hashResolutionNote: string | undefined;
  if (rawArgs.pattern_hash && !rawArgs.pattern) {
    const resolvedName = await resolvePatternNameFromHash(env, rawArgs.pattern_hash).catch(() => null);
    if (resolvedName) {
      resolvedArgs = { ...rawArgs, pattern: resolvedName };
    } else {
      // No metrics carry this hash. Surface an explicit no_signal envelope
      // so the agent gets a clear "looked up by pattern_hash, none found
      // in window" hint rather than the generic content-token fallback.
      return buildChassisErrorEnvelope({
        tool: 'log10x_pattern_examples',
        err: {
          error_type: 'no_signal',
          retryable: true,
          suggested_backoff_ms: null,
          hint: `pattern_hash \`${rawArgs.pattern_hash}\` did not resolve to a pattern name via TSDB lookup (most-emitting label over 7d). The hash may be from a different environment or outside retention. Try passing \`pattern\` directly, or call log10x_top_patterns to surface active patterns.`,
        },
        telemetry: chassisTelemetry,
        scope: { window: rawArgs.timeRange ?? '1h', window_basis: 'explicit' },
        contextPayload: { pattern_hash: rawArgs.pattern_hash },
        source_disclosure: { bytes_source: 'tsdb' },
      });
    }
  } else if (!rawArgs.pattern && !rawArgs.pattern_hash) {
    return buildChassisErrorEnvelope({
      tool: 'log10x_pattern_examples',
      err: {
        error_type: 'missing_identifier',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'pattern_examples requires either pattern (Symbol Message name / pasted log line) or pattern_hash (canonical 11-char hash).',
      },
      telemetry: chassisTelemetry,
      scope: { window: rawArgs.timeRange ?? '1h', window_basis: 'explicit' },
      source_disclosure: { bytes_source: 'tsdb' },
    });
  }
  if (hashResolutionNote) {
    /* reserved for future use */
  }

  const sumOut: { data?: PatternExamplesSummary } = {};
  const md = await executePatternExamplesInner(resolvedArgs, env, sumOut);
  // The inner drove SIEM queries. Record one query for the probe pass.
  recordQuery(chassisTelemetry);

  if (!sumOut.data) {
    // Graceful no-signal / error cases: the inner returns a markdown
    // narrative. Strip the leading `## ` heading and collapse to a
    // single-paragraph human_summary so the envelope stays typed.
    const stripped = md
      .replace(/^##\s*/m, '')
      .split('\n')
      .filter((l) => l.trim().length > 0 && !l.trim().startsWith('-'))
      .join(' ')
      .slice(0, 600);
    const headline = md.split('\n')[0]?.replace(/^##\s*/, '').slice(0, 200) || 'pattern_examples — no result';
    return buildChassisErrorEnvelope({
      tool: 'log10x_pattern_examples',
      err: {
        error_type: 'no_signal',
        retryable: true,
        suggested_backoff_ms: null,
        hint: stripped.slice(0, 300) || 'No matching events found in the requested window.',
      },
      telemetry: chassisTelemetry,
      scope: { window: rawArgs.timeRange ?? '1h', window_basis: 'explicit' },
      contextPayload: { pattern_ref: rawArgs.pattern },
      warnings: [`Original headline: ${headline}`],
      // Pattern volume figures always come from TSDB regardless of whether
      // the SIEM probe succeeded. Pass bytes_source so error envelopes carry
      // the same provenance as success envelopes.
      source_disclosure: {
        bytes_source: 'tsdb',
        ...(rawArgs.vendor ? { siem_vendor: rawArgs.vendor } : {}),
      },
    });
  }

  const d = sumOut.data;
  // sanitizeUserProse is invoked explicitly on the user-visible headline +
  // human_summary strings before they reach buildChassisEnvelope. The chassis
  // does not run sanitizeUserProse itself, so tool authors must call it at the
  // build site. Pattern terms like "templates", "candidate", "similarity gate"
  // are rewritten to plain English via BANNED_PHRASE_REWRITES.
  const rawHeadline = `\`${d.pattern}\` (${d.vendor}, ${d.window}): ${d.events_pulled} events pulled, ${d.retained_events} retained across ${d.retained_templates} templates via ${d.probe_path}`;
  const headline = sanitizeUserProse(rawHeadline);
  // Truncation signal: the SIEM probe hit its pull ceiling.
  // The probe pulls up to probeBatch = max(limit*5, 100) events (see line ~705);
  // `limit` only caps per-bucket DISPLAY, not the pull. Compare events_pulled
  // against the actual pull target so the flag fires only when the probe was
  // genuinely capped, not on every pattern with >= limit live events.
  const requestedLimit = rawArgs.limit ?? 10;
  const probeBatchTarget = Math.max(requestedLimit * 5, 100);
  const truncated = d.events_pulled >= probeBatchTarget;

  // Build actions[] — when any bucket recommends drop or compact, surface
  // log10x_pattern_mitigate as a recommended next step. Deduplicate: only
  // emit the action once regardless of how many buckets qualify.
  const envelopeActions: import('../lib/output-types.js').Action[] = [];
  const needsMitigate = d.buckets.some(
    (b) =>
      b.bucket_interpretation.recommended_action === 'drop' ||
      b.bucket_interpretation.recommended_action === 'compact',
  );
  if (needsMitigate) {
    const topAction = d.buckets[0]?.bucket_interpretation.recommended_action ?? 'compact';
    envelopeActions.push({
      tool: 'log10x_pattern_mitigate',
      args: { pattern: d.pattern },
      role: 'recommended-next',
      reason: `Bucket analysis recommends ${topAction} — pattern_mitigate applies the regulator rule.`,
    });
  }

  // Honest human_summary: event counts + bucket recommendation.
  // Explicit sanitize pass so banned vocabulary ("templates", "candidate"
  // etc.) gets rewritten before emit.
  const topBucketAction = d.buckets[0]?.bucket_interpretation.recommended_action;
  const rawHumanSummary =
    `${d.events_pulled} events pulled, ${d.retained_events} retained across ${d.retained_templates} buckets` +
    ` (${d.probe_path}, ${d.window} window).` +
    (topBucketAction ? ` Top bucket recommends: ${topBucketAction}.` : '') +
    (d.multi_line_detected ? ' Multi-line grouping detected.' : '');
  const chassis_human_summary = sanitizeUserProse(rawHumanSummary);

  // ── View projection ───────────────────────────────────────────────
  // Default `view='summary'` strips heavy fields. `view='detail'` (or a
  // supplied bucket_id, which implies detail) hydrates one bucket fully.
  // The audit identified these as the dominant token offenders:
  //   - duplicate legacyExtraFields spread (~45% of bytes — removed
  //     entirely below; the `payload` block is now the only carrier)
  //   - raw_events[] of up to 100 full SIEM events (~30%)
  //   - un-cropped sample_event per bucket (~8%)
  //   - full slot_distribution per bucket (~6%)
  //   - rationale + human_summary prose per bucket (~5%)
  // Summary view drops or trims each of those; detail view hydrates one
  // bucket so the agent can drill in without re-running the probe.
  const requestedView: 'summary' | 'detail' =
    rawArgs.view ?? (rawArgs.bucket_id ? 'detail' : 'summary');
  const requestedBucketId = rawArgs.bucket_id;

  const warnings: string[] = [];
  let payload: Record<string, unknown>;

  if (requestedView === 'detail') {
    // Find the bucket by template_hash or tenx_hash. Both are valid
    // identifiers — the audit redesign called for either; accepting both
    // spares the caller a re-lookup when they already have one.
    const target = requestedBucketId
      ? d.buckets.find(
          (b) => b.template_hash === requestedBucketId || b.tenx_hash === requestedBucketId,
        )
      : d.buckets[0];
    if (!target) {
      // bucket_id supplied but not found. Don't error — emit the slim
      // summary with a warning explaining which bucket_ids are available.
      // The summary still gives the agent enough to pick a valid bucket
      // and re-call without another probe round-trip.
      warnings.push(
        `bucket_id \`${requestedBucketId ?? ''}\` not found in retained buckets. Available bucket_ids (template_hash or tenx_hash): ${
          d.buckets
            .map((b) => `${b.template_hash}${b.tenx_hash ? `/${b.tenx_hash}` : ''}`)
            .join(', ') || '(none)'
        }.`,
      );
      payload = buildSummaryPayload(d, truncated, probeBatchTarget);
    } else {
      payload = {
        pattern: d.pattern,
        pattern_hash: target.tenx_hash ?? target.template_hash,
        vendor: d.vendor,
        window: d.window,
        service: d.service,
        severity: d.severity,
        probe_path: d.probe_path,
        events_pulled: d.events_pulled,
        retained_events: d.retained_events,
        retained_templates: d.retained_templates,
        multi_line_detected: d.multi_line_detected,
        bucket: target, // fully hydrated: full sample_event, full slot_distribution, rationale, human_summary
        details_available: {
          raw_events_via: 'log10x_retriever_query',
          raw_events_hint:
            'For un-encoded live event payloads, call log10x_retriever_query with the same pattern + window.',
          other_bucket_ids: d.buckets
            .filter((b) => b !== target)
            .map((b) => ({
              template_hash: b.template_hash,
              tenx_hash: b.tenx_hash,
              event_count: b.event_count,
            })),
        },
        probe_notes: d.probe_notes,
        ...(truncated
          ? {
              truncation_detail: `events_pulled (${d.events_pulled}) reached the probe batch target (${probeBatchTarget}); there may be more matching events — widen limit or narrow timeRange`,
            }
          : {}),
      };
    }
  } else {
    payload = buildSummaryPayload(d, truncated, probeBatchTarget);
  }

  // Token-budget warning. The audit set 8K tokens as the target for the
  // default summary; estimate bytes/4 ≈ tokens (a conservative
  // Anthropic-leaning approximation) and warn the agent if we blew the
  // budget so it can decide whether to narrow scope (smaller limit,
  // tighter timeRange) or call view=detail on a specific bucket.
  const estimatedTokens = Math.ceil(JSON.stringify(payload).length / 4);
  if (estimatedTokens > 8000) {
    warnings.push(
      `response payload ~${estimatedTokens} tokens, exceeds the 8K target for view='summary'. ` +
        "Try narrower timeRange or smaller limit; for raw events use log10x_retriever_query.",
    );
  }

  return buildChassisEnvelope({
    tool: 'log10x_pattern_examples',
    view: 'summary',
    headline,
    status: 'success',
    decisions: {
      // pattern_examples has no numeric threshold — it's Jaccard-discriminated
      // but that's an algorithm, not a user-configurable threshold.
      threshold_used: null,
      threshold_basis: 'default',
    },
    source_disclosure: {
      // Bytes figures come from TSDB (tenx_hash query volume). SIEM events
      // are used for content only, not for cost estimates.
      bytes_source: 'tsdb',
      // No rate-based dollar values in this tool.
      pattern_count_source: {
        kind: 'scoped_total',
        count: d.retained_templates,
        // Plain English: the data-sci phrasing for the kept buckets is
        // vocabulary the user has no model for. "Shape" is the user-facing word
        // for what we previously called a template; "shape-match" replaces the
        // similarity-gate jargon per the anti-jargon-prose dictionary rewrites.
        denominator_meaning: `Kept ${d.retained_templates} of ${d.distinct_templates} matching shapes from the log platform probe (others were a different variant of the error and held back to avoid mixing distinct issues)`,
      },
      siem_vendor: d.vendor,
    },
    scope: {
      window: d.window,
      window_basis: 'explicit',
      candidates_count: d.distinct_templates,
      candidates_usable: d.retained_templates,
      candidates_evaluated: d.buckets.length,
      // Plain English replacement for the data-sci phrasing. Users don't think
      // in templates or similarity scores; they think in event variants.
      candidates_failed:
        d.dropped_jaccard_events > 0
          ? [
              `${d.dropped_jaccard_events} events from a different variant of the same error were kept separate to avoid mixing two distinct issues`,
            ]
          : undefined,
    },
    payload,
    human_summary: chassis_human_summary,
    telemetry: chassisTelemetry,
    actions: envelopeActions.length > 0 ? envelopeActions : undefined,
    truncated,
    warnings: warnings.length > 0 ? warnings : undefined,
    // legacyCompat dropped per audit finding: the legacyExtraFields
    // spread was duplicating the entire payload (`d`) into chassisData
    // alongside `payload`, doubling raw_events / sample_event /
    // slot_distribution / rationale prose. Callers now read fields off
    // `data.payload.*` (the chassis-canonical path); the legacy flat
    // path is gone. chassisTelemetry continues to drive Performance, so
    // query_count / total_latency_ms remain at `performance.*`.
  });
}

/**
 * Build the slim default-view payload. Drops raw_events entirely (point
 * callers at retriever_query), crops bucket sample_event to ~200 chars,
 * removes slot_distribution + rationale prose. Keeps the headline-level
 * fields the agent needs to decide whether to drill in.
 */
function buildSummaryPayload(
  d: PatternExamplesSummary,
  truncated: boolean,
  probeBatchTarget: number,
): Record<string, unknown> {
  const SAMPLE_PREVIEW_CHARS = 200;
  const slimBuckets = d.buckets.map((b) => ({
    rank: b.rank,
    template_hash: b.template_hash,
    tenx_hash: b.tenx_hash,
    event_count: b.event_count,
    jaccard: b.jaccard,
    severity: b.severity,
    service: b.service,
    recommended_action: b.bucket_interpretation.recommended_action,
    // One-line headline from the interpretation summary, capped to keep
    // the slim card light. The full prose lives on view='detail'.
    headline:
      b.human_summary.length > 160 ? b.human_summary.slice(0, 157) + '...' : b.human_summary,
    sample_event_preview:
      b.sample_event.length > SAMPLE_PREVIEW_CHARS
        ? b.sample_event.slice(0, SAMPLE_PREVIEW_CHARS) + '...'
        : b.sample_event,
  }));

  return {
    pattern: d.pattern,
    // Top-level pattern_hash mirrors the audit's "template_body (once)"
    // anchor — agents can match against this identity without paging
    // through buckets[]. tenx_hash is the ONLY value valid under this
    // user-facing key (pattern_hash === tenx_hash identity contract). On
    // the content-token data plane tenx_hash is absent; we leave this
    // undefined rather than substitute the engine-internal template_hash,
    // which is mislabeling. template_hash stays available per-bucket and
    // in details_available.bucket_ids as the drill-in key.
    pattern_hash: d.buckets[0]?.tenx_hash,
    vendor: d.vendor,
    window: d.window,
    service: d.service,
    severity: d.severity,
    probe_path: d.probe_path,
    events_pulled: d.events_pulled,
    distinct_templates: d.distinct_templates,
    retained_events: d.retained_events,
    retained_templates: d.retained_templates,
    dropped_jaccard_events: d.dropped_jaccard_events,
    multi_line_detected: d.multi_line_detected,
    bucket_count: d.buckets.length,
    buckets: slimBuckets,
    details_available: {
      // Tell the agent how to drill in without guessing.
      bucket_ids: d.buckets.map((b) => b.tenx_hash ?? b.template_hash),
      detail_view_hint:
        "Call pattern_examples again with view='detail' and bucket_id=<template_hash or tenx_hash> for full sample_event + slot_distribution + rationale.",
      raw_events_via: 'log10x_retriever_query',
    },
    probe_notes: d.probe_notes,
    ...(truncated
      ? {
          truncation_detail: `events_pulled (${d.events_pulled}) reached the probe batch target (${probeBatchTarget}); there may be more matching events — widen limit or narrow timeRange`,
        }
      : {}),
  };
}

async function executePatternExamplesInner(
  rawArgs: PatternExamplesArgs,
  env: EnvConfig,
  sumOut?: { data?: PatternExamplesSummary },
): Promise<string> {
  // Defensive defaults — match patternExamplesSchema. Tools dispatched
  // outside the MCP-SDK Zod boundary (chains, scripts, harness) can
  // land here with timeRange/limit unset; without these we'd hit
  // `${undefined}` template renders and `undefined * 5` NaN math.
  // The outer executePatternExamples guarantees pattern is set (either
  // pass-through or resolved from pattern_hash); we still narrow the
  // type here so the rest of this function can treat args.pattern as
  // string without `!` assertions.
  if (!rawArgs.pattern) {
    return graceful('Pattern Examples — missing identifier', [
      'pattern_examples requires either `pattern` (Symbol Message name / pasted log line) or `pattern_hash` (canonical 11-char hash).',
    ]);
  }
  const args: Required<Pick<PatternExamplesArgs, 'timeRange' | 'limit' | 'pattern'>> & PatternExamplesArgs = {
    ...rawArgs,
    pattern: rawArgs.pattern,
    // Normalise '1d' legacy alias → '24h'; cap is 24h for this tool.
    timeRange: normalizeTimeRange(rawArgs.timeRange ?? '1h'),
    limit: rawArgs.limit ?? 10,
  };
  // ── 1. Resolve vendor ──────────────────────────────────────────────
  const resolution = await resolveSiemSelection({
    explicit: args.vendor,
    restrictTo: [...EXAMPLES_VENDORS],
  });
  if (resolution.kind === 'none') {
    return [
      '## Pattern Examples — vendor required',
      '',
      `No SIEM credentials detected and no \`vendor\` arg supplied. Pass \`vendor=<name>\` (one of: ${EXAMPLES_VENDORS.join(', ')}) and corresponding env vars.`,
      '',
      `_Probed: ${resolution.probedIds.join(', ')}._`,
    ].join('\n');
  }
  if (resolution.kind === 'ambiguous') {
    return [
      '## Pattern Examples — vendor ambiguous',
      '',
      `Multiple log analyzers detected: ${resolution.candidates.join(', ')}. Pass \`vendor=<name>\` to disambiguate.`,
    ].join('\n');
  }
  const vendor = resolution.id;
  const connector = getConnector(vendor);

  // ── 2. Resolve pattern: pasted-line vs Symbol Message ──────────────
  const looksLikeRawLogLine = /\s/.test(args.pattern) && /["'{}:/]/.test(args.pattern);
  let canonicalPattern: string;       // Display label for output rendering.
  let probeTokenSource: string;       // String to derive probe tokens from.
  let inputTemplateBody: string | undefined;
  let inputTemplateHash: string | undefined;

  if (looksLikeRawLogLine) {
    // Pasted-line input: run once through the 10x engine to discover the input
    // event's templateHash. The hash is the verification key. The probe
    // tokens come from the SAMPLE EVENT's content (the original raw text),
    // not the template body — pattern-extraction.ts sometimes returns
    // `template: <hash>` instead of the actual template body when the
    // engine's template cache short-circuits the parser, so the sample
    // event is the only reliably-populated source of searchable words
    // for the probe.
    try {
      const resolved = await extractPatterns([args.pattern], { useFileOutput: true, preserveEnvelope: true });
      if (resolved.patterns[0]) {
        const p = resolved.patterns[0];
        canonicalPattern = p.hash;
        probeTokenSource = p.sampleEvent || args.pattern;
        inputTemplateBody = p.sampleEvent || args.pattern;
        inputTemplateHash = p.hash;
      } else {
        return graceful('Pattern Examples — could not resolve pasted log line', [
          'The pattern extractor returned no patterns for the pasted line. Verify the line is well-formed and contains at least one recurring symbol.',
        ]);
      }
    } catch (e) {
      return graceful('Pattern Examples — pasted-line resolution failed', [
        `tenx CLI invocation failed: ${(e as Error).message.slice(0, 200)}`,
        '',
        'Either install tenx locally or pass the Symbol Message form (snake_case identity) instead of a raw log line.',
      ]);
    }
  } else {
    canonicalPattern = normalizePattern(args.pattern);
    probeTokenSource = canonicalPattern; // tokens come from underscore-split below
  }

  // ── 3. Build per-vendor probe query ────────────────────────────────
  // Two paths:
  //   - Symbol Message input: split on `_`, drop short tokens, dedupe.
  //     Each token is a searchable phrase in the log analyzer.
  //   - Pasted-line input: extract content tokens from the template body
  //     (alphanumeric runs ≥ 2 chars, deduped). The body's literal tokens
  //     are what appears in actual log lines; the hash is opaque.
  let tokens: string[];
  if (looksLikeRawLogLine) {
    // Cap at 10 tokens — Datadog query DSL has ~2-3KB budget and other
    // vendors get noisy with too many AND clauses. Top 10 by length
    // (longer = more selective) is the heuristic.
    const all = Array.from(contentTokens(probeTokenSource)).filter((t) => t.length >= 3);
    tokens = all.sort((a, b) => b.length - a.length).slice(0, 10);
  } else {
    const rawTokens = canonicalPattern.split('_').filter((t) => t.length >= 2);
    tokens = Array.from(new Set(rawTokens));
  }
  if (tokens.length === 0) {
    return graceful('Pattern Examples — pattern has no usable tokens', [
      `The pattern \`${canonicalPattern}\` produced no tokens after normalization. Pass a real Symbol Message or pasted log line.`,
    ]);
  }
  const vendorQuery = buildVendorQuery(vendor, tokens, args.service, args.severity);

  // ── 4. Probe the SIEM ──────────────────────────────────────────────
  // Prefer an EXACT tenx_hash filter for Symbol-Message input: it is the
  // engine's portable pattern identity, so it pins exactly the events a
  // 10x-powered forwarder shipped — no token coincidence, no per-vendor
  // query-syntax gaps. Self-verifying capability detection: a non-empty
  // hash probe proves this env's SIEM carries tenx_hash; an empty one
  // falls back to the content-token query (env is on the no-hash plane).
  const probeNotes: string[] = [];
  const onProgress = (_p: ProgressNote): void => {
    /* swallow — we render summary at the end, not per-step */
  };
  const probeBatch = Math.max(args.limit * 5, 100);
  const doProbe = (q: string) =>
    connector.pullEvents({
      window: args.timeRange,
      scope: args.scope,
      query: q,
      targetEventCount: probeBatch,
      maxPullMinutes: 2,
      onProgress,
    });

  // Authoritative hash from the metrics (the value the forwarder also
  // wrote to the SIEM) — falls back to the local pattern-name hash only
  // if the metrics don't carry this pattern. For pasted raw lines the
  // hash isn't a reliable probe key, so stay on content tokens.
  const hashKey = looksLikeRawLogLine
    ? undefined
    : (await resolvePatternHashFromMetrics(env, canonicalPattern)) ?? tenxHash(canonicalPattern);
  const hashQuery = hashKey
    ? buildHashQuery(vendor, hashKey, args.service, args.severity)
    : undefined;

  let probe = await doProbe(hashQuery ?? vendorQuery);
  let probePath: 'tenx_hash-exact' | 'content-token' = hashQuery
    ? 'tenx_hash-exact'
    : 'content-token';
  if (hashQuery && probe.events.length === 0) {
    if (probe.metadata.notes) probeNotes.push(...probe.metadata.notes);
    probe = await doProbe(vendorQuery);
    probePath = 'content-token';
  }
  if (probe.metadata.notes) probeNotes.push(...probe.metadata.notes);
  // Sequential hash-exact + content-token probes can each emit the same
  // connector note (e.g. CloudWatch scope auto-discovery). Dedup in place so
  // probe_notes / empty-state lines / markdown don't surface the same string twice.
  probeNotes.splice(0, probeNotes.length, ...new Set(probeNotes));

  if (probe.events.length === 0) {
    const lines: string[] = [
      `No events matched the probe in the ${args.timeRange} window on ${vendor}.`,
      `Query used: \`${probe.metadata.queryUsed || vendorQuery}\``,
    ];
    // Surface connector-level notes — rate limits, auth issues, partial
    // failures — so the agent can distinguish "no matching events" from
    // "couldn't query the SIEM at all." Empty-state without these notes
    // misleads chains: a 429-rate-limited probe looks identical to a
    // genuinely empty result.
    if (probeNotes.length > 0) {
      lines.push('');
      lines.push('### Probe notes');
      for (const n of probeNotes.slice(0, 5)) lines.push(`- ${n.slice(0, 200)}`);
      if (probeNotes.length > 5) lines.push(`- ... (${probeNotes.length - 5} more notes truncated)`);
    }
    lines.push('');
    lines.push('Try a longer `timeRange` (max 24h). If this pattern is offloaded, use `log10x_retriever_query` to inspect its events in the overflow bucket. Only offloaded events land there, not everything the analyzer aged out.');
    return graceful(`Pattern Examples — no events in ${args.timeRange} window`, lines);
  }

  // ── 5. Run the probe batch through the engine ──────────────────────
  const inputLineCount = probe.events.length;
  let extracted;
  try {
    extracted = await extractPatterns(probe.events, { useFileOutput: true, preserveEnvelope: true, bucketHashHint: hashKey });
  } catch (e) {
    return graceful('Pattern Examples — pattern extractor invocation failed', [
      `tenx CLI failed on ${probe.events.length} events: ${(e as Error).message.slice(0, 200)}`,
      '',
      'Verify tenx is installed (`brew install log-10x/tap/log10x`) or set `LOG10X_TENX_MODE=docker`.',
    ]);
  }

  // Multi-line detection: when the engine groups multiple input lines
  // into fewer encoded events, the input was multi-line (stack trace etc).
  const encodedEventCount = extracted.totalEvents;
  const isMultiLine = encodedEventCount < inputLineCount && inputLineCount > 1;

  if (extracted.patterns.length === 0) {
    return graceful('Pattern Examples — no templates resolved', [
      `Pulled ${probe.events.length} events but the pattern extractor produced no patterns. The events may be malformed or the tenx version may not support this format.`,
    ]);
  }

  // ── 6. Discriminate by content-token Jaccard ───────────────────────
  // Reference body = the input event's content (pasted-line case) or the
  // dominant returned bucket's sample event (Symbol Message case).
  // Sample events are used INSTEAD of template bodies because
  // pattern-extraction.ts sometimes populates `template` with just the
  // hash; sample events are reliably the original raw text.
  let referenceBody = inputTemplateBody;
  if (!referenceBody) {
    const dominant = extracted.patterns[0];
    referenceBody = dominant.sampleEvent || dominant.template;
    inputTemplateHash = dominant.hash;
  }
  const referenceTokens = contentTokens(referenceBody);

  // Group events by templateHash, attach Jaccard score against reference.
  const buckets = extracted.patterns.map((p) => {
    const bodySource = p.sampleEvent || p.template;
    const bodyTokens = contentTokens(bodySource);
    const jaccard = jaccardSimilarity(referenceTokens, bodyTokens);
    const threshold = Math.min(referenceTokens.size, bodyTokens.size) < 8 ? 0.7 : 0.85;
    return { p, jaccard, threshold, kept: jaccard >= threshold };
  });

  const retained = buckets.filter((b) => b.kept).sort((a, b) => b.p.count - a.p.count);
  const dropped = buckets.filter((b) => !b.kept);

  if (retained.length === 0) {
    return graceful('Pattern Examples — no matching templates', [
      `Probe returned ${probe.events.length} events spanning ${extracted.patterns.length} templates, but none matched the reference template at content-token Jaccard ≥ 0.85.`,
      '',
      'The pattern may not be active in this window, or the input pattern doesn\'t correspond to events in the requested timeRange.',
      '',
      'Drop counts by Jaccard:',
      ...buckets.slice(0, 5).map((b) => `  - patternHash \`${(b.p.tenxHash ?? b.p.hash).slice(0, 12)}\`: ${b.p.count} events, jaccard=${b.jaccard.toFixed(2)} (threshold ${b.threshold})`),
    ]);
  }

  // ── 6b. Optional slot_filter ───────────────────────────────────────
  // Drill-down: when the caller passes slot_filter={ name, value }, keep
  // only buckets whose `variables[name]` contains `value` (string match,
  // case-sensitive, slot values are taken verbatim from the 10x engine).
  // The slot name matches BOTH the raw slot key AND the collapsed base
  // (e.g. `slot_4_part2` collapses to `slot_4` in the rendered output);
  // we check both so a filter named for the collapsed form still hits.
  // No buckets match → return a graceful no_signal narrative explaining
  // the filter excluded everything.
  let filteredRetained = retained;
  if (rawArgs.slot_filter && rawArgs.slot_filter.name && rawArgs.slot_filter.value) {
    const slotName = rawArgs.slot_filter.name;
    const slotValue = rawArgs.slot_filter.value;
    const partPrefixRe = new RegExp(`^${slotName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:_part\\d+)?$`);
    filteredRetained = retained.filter((b) => {
      for (const [key, vals] of Object.entries(b.p.variables)) {
        if (key === slotName || partPrefixRe.test(key)) {
          if (vals.includes(slotValue)) return true;
        }
      }
      return false;
    });
    if (filteredRetained.length === 0) {
      return graceful('Pattern Examples — no buckets match slot_filter', [
        `slot_filter \`${slotName}\` = \`${slotValue}\` excluded all ${retained.length} retained bucket(s) in the ${args.timeRange} window on ${vendor}.`,
        '',
        'Either the slot value is not present in any current bucket, or the slot name does not appear in this pattern\'s slot_distribution. Drop the slot_filter to see the un-narrowed buckets and verify the slot name + value before re-applying.',
      ]);
    }
  }

  // Top 3 retained buckets (post slot_filter).
  const topK = filteredRetained.slice(0, 3);
  const droppedFromTopK = filteredRetained.slice(3);

  // Populate typed summary for view='summary' callers.
  if (sumOut) {
    sumOut.data = {
      pattern: canonicalPattern,
      vendor,
      window: args.timeRange,
      service: args.service,
      severity: args.severity,
      probe_path: probePath,
      events_pulled: probe.events.length,
      distinct_templates: extracted.patterns.length,
      // When slot_filter is active these reflect the post-filter set so
      // downstream renderers and chain steps see counts consistent with
      // the buckets[] they receive. The un-filtered counts are recoverable
      // via probe.events.length / extracted.patterns.length above.
      retained_events: filteredRetained.reduce((s, b) => s + b.p.count, 0),
      retained_templates: filteredRetained.length,
      dropped_jaccard_events: dropped.reduce((s, b) => s + b.p.count, 0),
      multi_line_detected: isMultiLine,
      // Re-emit the SIEM events already pulled by the probe.
      // Surface ALL raw events without truncation. The previous
      // .slice(0, 50) hid evidence the user needed to read; we already
      // bounded probe.events upstream via probeBatch + maxPullMinutes,
      // so there is no runaway-size risk. Stringify defensively:
      // connectors return `unknown[]` (some yield raw lines, others
      // structured records), so coerce via String() with a JSON fallback
      // for object shapes.
      raw_events: probe.events.map((e) =>
        typeof e === 'string'
          ? e
          : (() => {
              try {
                return JSON.stringify(e);
              } catch {
                return String(e);
              }
            })(),
      ),
      buckets: topK.map((bucket, i) => {
        // Build slot distribution with deduplication of _partN sequences and
        // filtering of low-signal constant slots.
        const rawSlots = Object.entries(bucket.p.variables).map(([slot, vals]) => ({
          slot,
          distinct_count: bucket.p.slotDistinctCounts?.[slot] ?? vals.length,
          is_constant: (bucket.p.slotDistinctCounts?.[slot] ?? vals.length) === 1,
          sample_values: vals.slice(0, 3),
          naming_confidence: slotNamingConfidence(slot),
        }));

        // Collapse _part2/_part3/... sequences into the base slot when all
        // parts are constant single-value slots sharing a common prefix.
        // e.g. slot_4_part2, slot_4_part3 → folded into slot_4 with combined sample_values.
        const partPattern = /^(.+)_part\d+$/;
        const collapsed = new Map<string, typeof rawSlots[0]>();
        const collapsedBases = new Set<string>();
        for (const s of rawSlots) {
          const m = partPattern.exec(s.slot);
          if (m && s.is_constant) {
            const base = m[1];
            collapsedBases.add(base);
            const existing = collapsed.get(base);
            if (existing) {
              existing.sample_values = [...new Set([...existing.sample_values, ...s.sample_values])].slice(0, 3);
            } else {
              collapsed.set(base, { ...s, slot: base });
            }
          }
        }

        const dedupedSlots = rawSlots
          .filter((s) => {
            const m = partPattern.exec(s.slot);
            return !(m && s.is_constant && collapsedBases.has(m[1]));
          })
          .map((s) => collapsed.get(s.slot) ?? s);

        // Filter: drop slots where naming_confidence === 'low' AND either:
        //   (a) distinct_count === 1 — constant noise with no meaningful label, or
        //   (b) slot name matches /^slot_\d+$/ — positional placeholder with no
        //       semantic meaning regardless of how many distinct values it carries
        //       (numeric ID variants are uninterpretable without a name).
        const slotDist = dedupedSlots
          .filter((s) => !(s.naming_confidence === 'low' && (s.distinct_count === 1 || /^slot_\d+$/.test(s.slot ?? ''))))
          .sort((a, b) => {
            const confRank = (c: 'high' | 'medium' | 'low') => c === 'high' ? 0 : c === 'medium' ? 1 : 2;
            const cr = confRank(a.naming_confidence) - confRank(b.naming_confidence);
            if (cr !== 0) return cr;
            return b.distinct_count - a.distinct_count;
          });
        const patternTotalEvents = retained.reduce((s, b) => s + b.p.count, 0);
        const interpretation = computeBucketInterpretation({
          eventCount: bucket.p.count,
          patternEventCount: patternTotalEvents,
          slotDistribution: slotDist,
        });
        // Rationale + human_summary lead with the recommendation framed as a
        // cost-saving action, tie to % impact for this pattern, and CTA to
        // log10x_pattern_mitigate. The earlier "Why compact:" framing read as
        // product trivia, not a recommendation.
        const shareOfPattern = patternTotalEvents > 0
          ? Math.round((bucket.p.count / patternTotalEvents) * 100)
          : 0;
        const sharePhrase = shareOfPattern > 0
          ? `roughly ${shareOfPattern}% of this pattern's volume`
          : 'this bucket of events';
        const action = interpretation.recommended_action;
        const ctaTail = ' Run log10x_pattern_mitigate to apply this, or log10x_cost_options to see alternatives.';
        let recommendation: string;
        if (action === 'compact') {
          recommendation = `Recommended: compact this pattern. It would cut ${sharePhrase} of your bill while preserving the signal — you'd still see the failure pattern and rate, just without the redundant copies.${ctaTail}`;
        } else if (action === 'drop') {
          recommendation = `Recommended: drop this pattern. It would remove ${sharePhrase} from your bill. The events carry no per-event signal (uniform stream from ${interpretation.active_emitters} ${interpretation.emitter_type}${interpretation.active_emitters !== 1 ? 's' : ''}).${ctaTail}`;
        } else if (action === 'sample') {
          recommendation = `Recommended: sample this pattern. It would cut ${sharePhrase} of your bill while keeping coverage — the events vary, so sampling preserves distribution shape without keeping every copy.${ctaTail}`;
        } else {
          recommendation = `Recommended: keep this pattern as-is. ${sharePhrase} of this pattern's volume; mixed content with per-event signal, so no safe reduction at this time.`;
        }
        const sanitizedRecommendation = sanitizeUserProse(recommendation);
        const sanitizedHumanSummary = sanitizeUserProse(interpretation.human_summary);
        return {
          rank: i + 1,
          template_hash: bucket.p.hash,
          tenx_hash: bucket.p.tenxHash,
          event_count: bucket.p.count,
          jaccard: bucket.jaccard,
          severity: bucket.p.severity,
          service: bucket.p.service,
          // Do not crop sample events. Showing the full payload is the whole
          // point of pattern_examples; truncating at 200 chars hides the parts
          // the user actually needs to read. raw_events[] surfaces the same
          // events un-truncated; sample_event is the bucket-pinned canonical
          // line and stays full-length here.
          sample_event: bucket.p.sampleEvent,
          slot_distribution: slotDist,
          bucket_interpretation: {
            active_emitters: interpretation.active_emitters,
            emitter_type: interpretation.emitter_type,
            content_variance: interpretation.content_variance,
            envelope_share_of_named_slots: interpretation.envelope_share_of_named_slots,
            recommended_action: interpretation.recommended_action,
            rationale: sanitizedRecommendation,
          },
          human_summary: sanitizedHumanSummary,
        };
      }),
      probe_notes: probeNotes.slice(0, 5),
    };
  }

  // ── 7. Render output ───────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`## Pattern Examples — ${vendor}`);
  lines.push('');
  lines.push(`**Pattern**: \`${canonicalPattern}\``);
  lines.push(`**Window**: last ${args.timeRange}${args.service ? ` · service=${args.service}` : ''}${args.severity ? ` · severity=${args.severity}` : ''}`);
  lines.push(`**Probe**: ${fmtCount(probe.events.length)} events pulled · ${extracted.patterns.length} distinct templates`);
  lines.push(
    probePath === 'tenx_hash-exact'
      ? agentOnly(
          `Probe path: tenx_hash-exact (filter ${hashQuery}). These events were pinned by the engine's portable pattern hash, so this env's SIEM carries tenx_hash — exact cross-pillar joins and forwarder-native drops by tenx_hash are available here. Prefer tenx_hash over message regex for any follow-up SIEM filter on this env.`,
        )
      : agentOnly(
          `Probe path: content-token (tenx_hash not present in this env's SIEM events, or pasted-line input). Results are phrase-match approximate; exact-hash correlation is unavailable on this env's data plane — do not claim hash-based precision.`,
        ),
  );
  lines.push(`**Retained**: ${fmtCount(filteredRetained.reduce((s, b) => s + b.p.count, 0))} events across ${filteredRetained.length} matching templates (Jaccard ≥ threshold)`);
  if (rawArgs.slot_filter && filteredRetained.length < retained.length) {
    const excluded = retained.length - filteredRetained.length;
    lines.push(`**slot_filter applied**: \`${rawArgs.slot_filter.name}\` = \`${rawArgs.slot_filter.value}\` (excluded ${excluded} bucket(s) of ${retained.length} retained)`);
  }
  if (dropped.length > 0) {
    const droppedCount = dropped.reduce((s, b) => s + b.p.count, 0);
    lines.push(`**Dropped on Jaccard**: ${fmtCount(droppedCount)} events from ${dropped.length} unrelated templates`);
  }
  if (isMultiLine) {
    lines.push('');
    lines.push('> **Multi-line detected**: the engine grouped multiple input lines into fewer encoded events. Showing head lines only; continuation frames (e.g. stack-trace `at ` lines) live separately in the analyzer and are not joined here.');
  }
  lines.push('');
  // Gloss the hash once: a human seeing "patternHash a1b2c3…" needs to know
  // what it is before the buckets below.
  lines.push('_Buckets group the matched events by `patternHash` (the engine\'s portable pattern fingerprint); the slot table in each shows what varies within that pattern._');
  lines.push('');

  for (let i = 0; i < topK.length; i++) {
    const bucket = topK[i];
    const p = bucket.p;
    const eventsToShow = Math.min(args.limit, p.count);
    lines.push(`### Bucket ${i + 1}: patternHash \`${(p.tenxHash ?? p.hash).slice(0, 16)}\` (${fmtCount(p.count)} events, jaccard=${bucket.jaccard.toFixed(2)})`);
    lines.push('');
    if (p.severity) lines.push(`**Severity**: ${p.severity}`);
    if (p.service) lines.push(`**Service**: ${p.service}`);
    // Full sample event, no truncation. Cropping at 200 chars hid the part
    // of the event the user actually needed (e.g. "Request failed.
    // {service.instance.X" cut off the failure reason).
    lines.push(`**Sample event**:`);
    lines.push('```');
    lines.push(p.sampleEvent);
    lines.push('```');
    if (Object.keys(p.variables).length > 0) {
      const allSlots = Object.entries(p.variables)
        .map(([slot, vals]) => {
          const trueDistinct = p.slotDistinctCounts?.[slot] ?? vals.length;
          return { slot, vals, trueDistinct, conf: slotNamingConfidence(slot) };
        })
        .sort((a, b) => {
          const confRank = (c: 'high' | 'medium' | 'low') => c === 'high' ? 0 : c === 'medium' ? 1 : 2;
          const cr = confRank(a.conf) - confRank(b.conf);
          if (cr !== 0) return cr;
          return b.trueDistinct - a.trueDistinct;
        });
      lines.push(`**Slot distribution** (${allSlots.length} slot${allSlots.length === 1 ? '' : 's'}, named slots first):`);
      for (const { slot, vals, trueDistinct } of allSlots) {
        const distinct = trueDistinct === 1 ? 'constant' : `${trueDistinct} distinct`;
        const sample = vals.slice(0, 3).map((v) => `\`${v.slice(0, 30)}\``).join(', ');
        lines.push(`  - \`${slot}\` (${distinct}): ${sample}${vals.length > 3 ? `, …` : ''}`);
      }
    }
    lines.push('');
    if (i === 0 && eventsToShow < p.count) {
      lines.push(`_Showing slot summary; ${fmtCount(p.count)} matching events available. Use log10x_retriever_query for full event payload retrieval._`);
      lines.push('');
    }
  }

  if (droppedFromTopK.length > 0) {
    const droppedCount = droppedFromTopK.reduce((s, b) => s + b.p.count, 0);
    lines.push(`_${fmtCount(droppedCount)} additional events from ${droppedFromTopK.length} additional patternHash bucket(s) not shown (only top 3 by count rendered)._`);
    lines.push('');
  }

  if (probeNotes.length > 0) {
    lines.push('### Probe notes');
    for (const n of probeNotes) lines.push(`- ${n}`);
    lines.push('');
  }

  // ── 8. Structured NEXT_ACTIONS ─────────────────────────────────────
  const nextActions: NextAction[] = [
    {
      tool: 'log10x_dependency_check',
      args: { pattern: canonicalPattern },
      reason: 'check dashboards / alerts before any mute action',
    },
    {
      tool: 'log10x_pattern_trend',
      args: { pattern: canonicalPattern },
      reason: 'see the volume trend for this pattern',
    },
  ];
  // If multi-line, point at retriever_query for full-trace history.
  if (isMultiLine) {
    nextActions.push({
      tool: 'log10x_retriever_query',
      args: { pattern: canonicalPattern, from: 'now-7d', to: 'now', limit: 50 },
      reason: 'multi-line composites — retriever has the complete grouped events',
    });
  }
  const block = renderNextActions(nextActions);
  if (block) lines.push(block);

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a vendor-specific phrase-AND query from the pattern tokens. */
function buildVendorQuery(
  vendor: SiemId,
  tokens: string[],
  service?: string,
  severity?: string,
): string {
  const phrases = tokens.map((t) => `"${t.replace(/"/g, '\\"')}"`);
  switch (vendor) {
    case 'splunk': {
      // SPL: phrases AND'd by default. Service/severity filters are
      // user-namespaced fields.
      const parts: string[] = [...phrases];
      if (service) parts.push(`tenx_user_service="${service}"`);
      if (severity) parts.push(`severity_level="${severity}"`);
      return parts.join(' ');
    }
    case 'datadog': {
      // Datadog DSL: phrases AND'd by space.
      const parts: string[] = [...phrases];
      if (service) parts.push(`service:${service}`);
      if (severity) parts.push(`status:${severity.toLowerCase()}`);
      return parts.join(' ');
    }
    case 'elasticsearch': {
      // ES query_string syntax. Bare quoted phrases search the default
      // field (typically all text fields) — works across the common
      // shipper conventions: `log` for OTel/k8s/fluent-bit envelopes,
      // `message` for direct ingest, `_raw` for Splunk-forwarder shape.
      // Hardcoding `message:` would miss `log`-field logs entirely.
      const parts: string[] = [...phrases];
      if (service) parts.push(`service: "${service}"`);
      if (severity) parts.push(`severity: "${severity}"`);
      return parts.join(' AND ');
    }
    case 'cloudwatch': {
      // CloudWatch FilterLogEvents pattern syntax — quoted phrases
      // joined with implicit AND. The previous code emitted Logs
      // Insights syntax (`@message like /.../`), which the
      // FilterLogEvents API rejects with "Invalid character(s) in
      // term '@'". See eval/gaps/MCP_cloudwatch_filterpattern_syntax_mismatch.md
      // for the full diagnosis. Filter-pattern reference:
      // https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html
      const quotedPhrases = tokens.map((t) => `"${t.replace(/"/g, '\\"')}"`);
      const parts: string[] = quotedPhrases;
      if (severity) parts.push(`"${severity.replace(/"/g, '\\"')}"`);
      return parts.join(' ');
    }
    default:
      return phrases.join(' ');
  }
}

// buildHashQuery moved to ../lib/siem/hash-query.js (shared with
// event_lookup's reverse-lookup live sample). Imported at the top.

/**
 * Extract content-only alphanumeric tokens from a template body.
 *
 * Strips JSON envelope keys via the same field-priority list coerceToLine
 * uses (`.log`, `.message`, `attributes.message`, `_raw`). When the body
 * is bare (no envelope), uses it directly. Tokenizes on non-alphanumeric
 * runs ≥ 2 chars, deduped, matches the 10x engine's symbol tokenization.
 */
function contentTokens(templateBody: string): Set<string> {
  if (!templateBody) return new Set();
  // Try to peel out the inner log-content field if the body looks JSON.
  const trimmed = templateBody.trim();
  let content = trimmed;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const inner =
        (parsed?.log as string) ||
        (parsed?.message as string) ||
        (parsed?.attributes?.message as string) ||
        (parsed?._raw as string);
      if (typeof inner === 'string' && inner.length > 0) content = inner;
    } catch {
      /* not strict JSON — use as-is */
    }
  }
  return new Set(
    content
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2),
  );
}

/** Compute Jaccard similarity between two token sets. Returns 0..1. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function graceful(title: string, lines: string[]): string {
  return [`## ${title}`, '', ...lines].join('\n');
}

/**
 * Derive naming confidence from a slot name string.
 *
 * After FIX 1 (inferSlotNameFromToken wired into extractSlotsFromBody),
 * slot names have predictable shapes:
 *   - `slot_N`           → low (no preceding token could be decoded)
 *   - `<word> (inferred)` → medium (natural-language word before the slot)
 *   - anything else      → high (structured-log key or typed format spec)
 */
function slotNamingConfidence(slot: string): 'high' | 'medium' | 'low' {
  if (/^slot_\d+$/.test(slot)) return 'low';
  if (slot.endsWith(' (inferred)')) return 'medium';
  return 'high';
}

// Exported for tests.
export const __testables = {
  buildVendorQuery,
  contentTokens,
  jaccardSimilarity,
};
