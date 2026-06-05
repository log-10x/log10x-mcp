/**
 * log10x_investigate — single-call root-cause investigation.
 *
 * Orchestration tool. Takes a polymorphic starting point (raw log line,
 * pattern identity, service name, or the literal "environment") and
 * returns a complete markdown report by composing:
 *
 *   0. Environment selection
 *   1. Anchor resolution (pattern / service / env mode)
 *   2. Trajectory shape detection (acute vs drift vs flat)
 *   3. Acute-spike correlation with lag analysis          (Phase 3)
 *      — OR —
 *      Drift slope-similarity cohort analysis             (Phase 3-D)
 *   4. Causal chain construction (acute only)
 *   5. Confidence scoring
 *   6. Two-stage Retriever fallback (graceful degradation)
 *   7. Verification command generation
 *
 * Intelligence lives in the tool, not the model. Any MCP-aware client
 * should be able to call this one tool and get a coherent investigation.
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { parsePrometheusValue } from '../lib/cost.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { DEFAULT_THRESHOLDS } from '../lib/thresholds.js';
import { classifyTrajectory, runDriftCorrelation } from '../lib/drift.js';
import { agentOnly, stripAgentOnly } from '../lib/agent-only.js';
import { runAcuteSpikeCorrelation } from '../lib/correlate.js';
import { detectInflection } from '../lib/inflection.js';
import { patternDisplay } from '../lib/pattern-descriptor.js';
import {
  renderAcuteSpikeReport,
  renderDriftReport,
  renderEmpty,
  collectPatternsReferenced,
  collectDriftPatternsReferenced,
} from '../lib/investigation-templates.js';
import { recordInvestigation, getInvestigation, listInvestigations } from '../lib/investigation-cache.js';
import { isRetrieverConfigured, runRetrieverQuery, parseTimeExpression } from '../lib/retriever-api.js';
import { renderNextActions, extractNextActions, type NextAction } from '../lib/next-actions.js';
import { getOffloadStatusBatch } from '../lib/offload-status.js';
import { buildChassisEnvelope } from '../lib/chassis-envelope.js';
import type { Action, StructuredOutput } from '../lib/output-types.js';

export const investigateSchema = {
  starting_point: z
    .string()
    .describe('The user\'s target, verbatim. Can be a raw log line, a pattern identity (symbolMessage or tenx_hash), a service name, or the literal string "environment"/"all"/"audit". The tool detects the mode automatically.'),
  window: z
    .string()
    .default('1h')
    .describe('Analysis window. `1h` default for acute-spike cases; `30d` recommended for drift cases. Accepts any PromQL-style duration string (`15m`, `1h`, `6h`, `24h`, `7d`). Alias: `timeRange`.'),
  timeRange: z
    .string()
    .optional()
    .describe('Alias for `window` for consistency with other Log10x tools. If both are set, `window` wins.'),
  baseline_offset: z
    .string()
    .optional()
    .describe('Offset for the baseline comparison. Defaults to `24h` for short windows (acute-spike cases) and to the same value as `window` for long windows (≥7d, drift cases). Override only if you need a non-standard comparison.'),
  depth: z
    .enum(['shallow', 'normal', 'deep'])
    .default('normal')
    .describe('`shallow`: anchor service only. `normal` (default): anchor service + immediate dependencies. `deep`: full environment-wide.'),
  environment: z.string().optional().describe('Environment nickname — required in multi-env setups.'),
  use_bytes: z.boolean().default(false).describe('Use byte-based rate instead of event-count. Event-count is strongly preferred; use only if the Reporter does not emit the count metric.'),
};

type Mode = 'pattern' | 'service' | 'environment' | 'raw_line';

/**
 * Top-level call status. Agent branches on this before reading anything else.
 *   - `success`: investigation produced a usable narrative. Read `findings`
 *     and `human_summary`. Whether to ACT on the findings depends on
 *     `threshold_basis` and the agent contract.
 *   - `no_signal`: anchor resolved but no co-movers crossed the noise
 *     floor. Stop searching.
 *   - `insufficient_data`: anchor couldn't be resolved, window too short,
 *     or backend returned too few buckets. Re-anchor or widen the window.
 *   - `error`: structural failure. Read `data.error`.
 */
export type InvestigateStatus = 'success' | 'no_signal' | 'insufficient_data' | 'error';

/**
 * Threshold provenance. Calibration honesty: investigate's thresholds
 * (clean-chain confidence floor, acute noise floor, drift slope, etc.)
 * are hand-picked SPEC_DEFAULTS unless the operator points
 * LOG10X_THRESHOLDS_FILE at a calibrated config. Agents MUST NOT
 * auto-mitigate when threshold_basis === 'unvalidated_default'.
 */
export type ThresholdBasis = 'unvalidated_default' | 'config_file' | 'caller_override';

export interface ParsedReport {
  shape: string | null;
  mode: string | null;
  investigationId: string | null;
  leadPattern: string | null;
  leadService: string | null;
  leadConfidence: number | null;
  leadLagSeconds: number | null;
  chainLength: number;
  coMoverCount: number;
  hasNoSignalMarker: boolean;
}

/**
 * Best-effort extraction of structured signals from the rendered
 * markdown. Used to populate the agent-facing envelope without
 * refactoring the rendering pipeline. Regex-fragile by design — if a
 * template changes, the agent gets `null` for that field and falls
 * back to reading `data.report_markdown`.
 */
export function parseReport(md: string): ParsedReport {
  // Match the template's "**Investigation id**: <uuid>" line OR the
  // legacy "investigation_id: <uuid>" form.
  const idMatch =
    md.match(/\*\*Investigation id\*\*:\s*([0-9a-f-]{36})/i) ??
    md.match(/investigation_id`?:?\s*`?([0-9a-f-]{36})/i);
  const shapeMatch = md.match(/\*\*shape\*\*:\s*`?(acute|drift|environment|no_significant_movement|empty)`?/i);
  const modeMatch = md.match(/\*\*mode\*\*:\s*`?(pattern|service|environment|raw_line)`?/i);
  const leadPatternMatch = md.match(/\*\*Pattern\*\*:\s*`([^`]+)`(?:\s+in\s+`([^`]+)`)?/);
  const confMatch = md.match(/\*\*Confidence\*\*:\s*(\d+)%/);
  const lagMatch = md.match(/peaked\s+(\d+)s\s+before/i);
  // Chain section: each link is rendered as `${idx}. \`pattern\` (...)`.
  // Count numbered list items inside the section.
  let chainCount = 0;
  if (/^### Temporal chain/m.test(md)) {
    const afterChain = md.split(/^### Temporal chain[^\n]*$/m)[1] ?? '';
    const upToNextSection = afterChain.split(/^### /m)[0] ?? '';
    chainCount = (upToNextSection.match(/^\d+\.\s+`/gm) ?? []).length;
  }
  // Co-mover section: each line is `- \`pattern\` ...`.
  let coMoverCount = 0;
  if (/^### Co-movers \(lower confidence\)/m.test(md)) {
    const afterCM = md.split(/^### Co-movers[^\n]*$/m)[1] ?? '';
    const upToNextSection = afterCM.split(/^### /m)[0] ?? '';
    coMoverCount = (upToNextSection.match(/^- `/gm) ?? []).length;
  }
  const hasNoSignal =
    /No co-movers exceeded|No co-movers crossed the noise floor/i.test(md);
  return {
    shape: shapeMatch?.[1] ?? null,
    mode: modeMatch?.[1] ?? null,
    investigationId: idMatch?.[1] ?? null,
    leadPattern: leadPatternMatch?.[1] ?? null,
    leadService: leadPatternMatch?.[2] ?? null,
    leadConfidence: confMatch ? parseInt(confMatch[1], 10) / 100 : null,
    leadLagSeconds: lagMatch ? -parseInt(lagMatch[1], 10) : null, // negative = leads
    chainLength: chainCount,
    coMoverCount: coMoverCount,
    hasNoSignalMarker: hasNoSignal,
  };
}

export function detectThresholdBasis(): ThresholdBasis {
  return process.env.LOG10X_THRESHOLDS_FILE ? 'config_file' : 'unvalidated_default';
}

export function buildHumanSummary(
  starting_point: string,
  window: string,
  status: InvestigateStatus,
  parsed: ParsedReport,
  thresholdBasis: ThresholdBasis,
): string {
  const calibTag =
    thresholdBasis === 'unvalidated_default'
      ? ' Thresholds are unvalidated defaults — compare the observed confidence against the clean-chain floor (default 0.70) before acting.'
      : '';
  if (status === 'insufficient_data') {
    return `Investigation of "${starting_point}" over ${window} could not produce a usable analysis. The anchor resolved but the window or backend coverage was too thin. Widen the window or re-anchor.${calibTag}`;
  }
  if (status === 'no_signal') {
    return `Investigation of "${starting_point}" over ${window} found no co-movers above the noise floor. Anchor moved, but nothing else moved with it in this window. Widen the window, switch to deep depth, or conclude there is no detectable lead.${calibTag}`;
  }
  if (status === 'error') {
    return `Investigation of "${starting_point}" failed structurally. See data.error for details.${calibTag}`;
  }
  if (!parsed.leadPattern) {
    return `Investigation of "${starting_point}" produced a ${parsed.shape ?? 'unknown'}-shape narrative over ${window}. No single lead pattern was identified.${calibTag}`;
  }
  const lagFragment =
    parsed.leadLagSeconds !== null && parsed.leadLagSeconds < 0
      ? `peaked ${Math.abs(parsed.leadLagSeconds)}s before the anchor`
      : 'moved concurrently with the anchor';
  const confFragment =
    parsed.leadConfidence !== null
      ? ` Observed lead confidence: ${(parsed.leadConfidence * 100).toFixed(0)}% (clean-chain floor: 70%${thresholdBasis === 'unvalidated_default' ? ', unvalidated' : ''}).`
      : '';
  return `Strongest temporal evidence on "${starting_point}" (${window}): \`${parsed.leadPattern}\`${parsed.leadService ? ` in \`${parsed.leadService}\`` : ''} ${lagFragment}.${confFragment} ${parsed.chainLength} chain step(s), ${parsed.coMoverCount} additional lower-confidence co-mover(s). This is correlation, not proven cause — verify via traces / deploy timeline before acting.${calibTag}`;
}

/**
 * Offload-status hint shape surfaced on the envelope. One entry per
 * pattern (by name) that the env-mode top-N or the acute-spike chain
 * reports as in the receiver's drop/offload cohort (isDropped). Best-effort;
 * the field is absent on lookup failure. isDropped does not distinguish
 * offload-to-S3 from hard-drop, so fetchability is conditional, not implied.
 */
export interface TopOffloadedPattern {
  pattern: string;
  service: string | null;
  tenx_hash: string;
  /** Null when the kept-cohort scan timed out — share math suppressed. */
  dropped_share_pct_24h: number | null;
  last_seen_dropped_ts: number | null;
  /** True when the kept-cohort PromQL scan timed out on a heavy pattern. */
  kept_timed_out?: boolean;
}

/**
 * Extract candidate pattern tokens from the rendered markdown. The
 * `parseReport` lead pattern is added first; we then grep the Top
 * movers / Co-movers / Temporal chain sections for backtick-quoted
 * tokens. Capped at 10 distinct candidates so the downstream hash
 * resolution stays bounded.
 */
function collectCandidatePatterns(md: string, parsed: ParsedReport): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | null | undefined): void => {
    if (!p) return;
    const trimmed = p.trim();
    if (!trimmed || seen.has(trimmed)) return;
    if (trimmed.length > 200) return; // skip pathological tokens
    seen.add(trimmed);
    out.push(trimmed);
  };
  add(parsed.leadPattern);
  for (const sectionHdr of [/^### Top movers/m, /^### Co-movers[^\n]*$/m, /^### Temporal chain[^\n]*$/m]) {
    if (!sectionHdr.test(md)) continue;
    const after = md.split(sectionHdr)[1] ?? '';
    const upTo = after.split(/^### /m)[0] ?? '';
    const matches = upTo.match(/`([^`\n]+)`/g) ?? [];
    for (const m of matches) {
      if (out.length >= 10) break;
      add(m.slice(1, -1));
    }
    if (out.length >= 10) break;
  }
  return out.slice(0, 10);
}

/**
 * Resolve pattern names to their `tenx_hash` values via topk(1) by
 * total volume in the lookback window. One PromQL call per pattern,
 * fired in parallel. Patterns whose hash can't be resolved are absent
 * from the returned map. Per-call timeout matches the batch lookup.
 */
async function resolveHashesForPatterns(
  env: EnvConfig,
  patterns: string[],
  metricsEnv: string,
  timeoutMs = 2000,
): Promise<Map<string, { hash: string; service: string | null }>> {
  const out = new Map<string, { hash: string; service: string | null }>();
  if (patterns.length === 0) return out;
  const lookups = patterns.map(async (p) => {
    const q =
      `topk(1, sum by (${LABELS.hash}, ${LABELS.service}) ` +
      `(increase(all_events_summaryBytes_total{${LABELS.env}="${metricsEnv}",${LABELS.pattern}="${escape(p)}"}[24h])))`;
    try {
      const racer = Promise.race([
        queryInstant(env, q),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      const res = await racer;
      if (!res || res.status !== 'success') return;
      const row = res.data.result[0];
      if (!row) return;
      const hash = row.metric[LABELS.hash];
      if (!hash) return;
      const service = row.metric[LABELS.service] ?? null;
      out.set(p, { hash, service });
    } catch {
      /* best-effort */
    }
  });
  await Promise.all(lookups);
  return out;
}

export async function executeInvestigate(
  args: {
    starting_point: string;
    window: string;
    timeRange?: string;
    baseline_offset?: string;
    depth: 'shallow' | 'normal' | 'deep';
    environment?: string;
    use_bytes: boolean;
    effective_ingest_per_gb?: number;
  },
  env: EnvConfig
): Promise<StructuredOutput> {
  const startedAt = Date.now();
  const thresholdBasis = detectThresholdBasis();
  const { wrapBackendError } = await import('../lib/primitive-errors.js');

  // ── Structural failure path ────────────────────────────────────────
  let md: string;
  try {
    md = await executeInvestigateInner(args, env);
  } catch (e) {
    const err = wrapBackendError(e);
    return buildChassisEnvelope({
      tool: 'log10x_investigate',
      view: 'summary',
      headline: `Investigation of "${args.starting_point}" failed: ${err.error_type}`,
      status: 'error',
      decisions: { threshold_used: null, threshold_basis: thresholdBasis === 'config_file' ? 'snapshot' : 'unvalidated_default' },
      source_disclosure: {},
      scope: { window: args.window, window_basis: 'explicit' },
      payload: {
        status: 'error' as InvestigateStatus,
        threshold_basis: thresholdBasis,
        anchor_ref: { type: 'starting_point', expression: args.starting_point },
        starting_point: args.starting_point,
        window: args.window,
        depth: args.depth,
        baseline_offset: args.baseline_offset,
        use_bytes: args.use_bytes,
        total_latency_ms: Date.now() - startedAt,
        report_markdown: '',
      },
      human_summary: `Investigation failed: ${err.hint}`,
      error: err,
    });
  }

  const parsed = parseReport(md);

  // ── Offload-status hint (best-effort, 2s outer timeout) ───────────
  // Piggyback on the patterns the investigation already ranked: lead
  // pattern + tokens grepped from Top movers / Co-movers / Temporal
  // chain sections. Resolve names to tenx_hash, then one batched
  // PromQL pair per cohort (kept + dropped) via getOffloadStatusBatch.
  // Output: top_offloaded_patterns on the envelope + an appended
  // markdown nudge when any candidate is offloaded. Lookup failure
  // leaves the field undefined and the markdown untouched.
  let topOffloaded: TopOffloadedPattern[] | undefined;
  try {
    const offloadResult = await Promise.race([
      (async (): Promise<TopOffloadedPattern[] | undefined> => {
        const candidates = collectCandidatePatterns(md, parsed);
        if (candidates.length === 0) return undefined;
        const metricsEnv = await resolveMetricsEnv(env);
        const resolved = await resolveHashesForPatterns(env, candidates, metricsEnv);
        if (resolved.size === 0) return undefined;
        const hashes = [...new Set([...resolved.values()].map((v) => v.hash))];
        const batch = await getOffloadStatusBatch(env, {
          patternHashes: hashes,
          metricsEnv,
          range: '24h',
          timeoutMs: 2000,
        });
        const offloaded: TopOffloadedPattern[] = [];
        for (const pat of candidates) {
          const r = resolved.get(pat);
          if (!r) continue;
          const status = batch[r.hash];
          if (!status || !status.ok || !status.is_offloaded) continue;
          offloaded.push({
            pattern: pat,
            service: r.service,
            tenx_hash: r.hash,
            dropped_share_pct_24h: status.dropped_share_pct,
            last_seen_dropped_ts: status.last_seen_dropped_ts,
            ...(status.kept_timed_out ? { kept_timed_out: true } : {}),
          });
        }
        return offloaded.length > 0 ? offloaded : undefined;
      })(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
    ]);
    topOffloaded = offloadResult;
  } catch {
    /* best-effort */
  }

  // Markdown nudge — append BEFORE the envelope build, AFTER parseReport
  // (the regexes parseReport keys on do not appear in the nudge text,
  // verified by inspection of investigate.ts:118-143).
  if (topOffloaded && topOffloaded.length > 0) {
    const names = topOffloaded
      .map((t) => {
        // Partial-result: kept-cohort scan timed out on this heavy
        // pattern. The offload signal is still credible (from the
        // dropped cohort) — surface the pattern, omit the percent.
        if (t.dropped_share_pct_24h === null || t.kept_timed_out) {
          return `\`${t.pattern}\` (share n/a — kept query slow)`;
        }
        return `\`${t.pattern}\` (${t.dropped_share_pct_24h.toFixed(0)}%)`;
      })
      .join(', ');
    const nudge =
      `\n\n> **Reduction-aware routing**: ${topOffloaded.length} of the patterns above ` +
      `are in the receiver's drop/offload cohort (isDropped marker). If a pattern is ` +
      `offloaded to S3 (not hard-dropped), fetch its events via ` +
      `\`log10x_retriever_query{pattern: "<name>"}\`; a zero result means it was hard-dropped, not archived. ` +
      `In cohort: ${names}.`;
    md = md + nudge;
  }
  const topOffloadedSample = topOffloaded?.[0];
  if (topOffloadedSample) {
    // Re-emit the trailing NEXT_ACTIONS block with the offload-pivot
    // action threaded in. The original block was emitted by
    // executeInvestigateInner before offload-status was known.
    md = rewriteNextActionsWithOffload(md, topOffloadedSample);
  }

  // ── Status determination ──────────────────────────────────────────
  let status: InvestigateStatus = 'success';
  if (parsed.shape === 'empty' || parsed.shape === 'no_significant_movement') {
    status = 'insufficient_data';
  } else if (parsed.hasNoSignalMarker || (parsed.chainLength === 0 && parsed.coMoverCount === 0)) {
    status = 'no_signal';
  }

  const human_summary = buildHumanSummary(
    args.starting_point,
    args.window,
    status,
    parsed,
    thresholdBasis,
  );

  const headline = `Investigation of "${args.starting_point}" (window=${args.window}): status=${status}, shape=${parsed.shape ?? 'unknown'}${parsed.investigationId ? `, id=${parsed.investigationId.slice(0, 8)}` : ''}.`;

  // Extract structured next-actions BEFORE stripping the HTML comment blocks.
  // (extractNextActions reads the NEXT_ACTIONS JSON comment from md.)
  const embeddedActions = extractNextActions(md);

  // Extract agent-only diagnostic notes from <!-- agent-only: ... --> blocks
  // before they are stripped, so they can be promoted to the structured payload.
  const diagnosticNotes: string[] = [];
  const agentOnlyRe = /<!-- agent-only:\s*([\s\S]*?)\s*-->/g;
  let aoMatch: RegExpExecArray | null;
  while ((aoMatch = agentOnlyRe.exec(md)) !== null) {
    const note = aoMatch[1].replace(/--&gt;/g, '-->').trim();
    if (note) diagnosticNotes.push(note);
  }

  // Strip all HTML comment blocks from report_markdown so it contains only
  // clean human-readable prose. Agents read structured data from the envelope
  // fields (actions[], diagnostic_notes); the markdown is for the user.
  const cleanMd = stripAgentOnly(md);

  return buildChassisEnvelope({
    tool: 'log10x_investigate',
    view: 'summary',
    headline,
    status: status === 'success' ? 'success'
      : status === 'no_signal' ? 'no_signal'
      : status === 'insufficient_data' ? 'insufficient_data'
      : 'error',
    decisions: {
      threshold_used: DEFAULT_THRESHOLDS.cleanChainThreshold,
      threshold_basis: thresholdBasis === 'config_file' ? 'snapshot' : 'unvalidated_default',
      threshold_audit: {
        value: DEFAULT_THRESHOLDS.cleanChainThreshold,
        basis: thresholdBasis,
        observed_distribution: parsed.leadConfidence !== null ? {
          n: parsed.chainLength + parsed.coMoverCount,
          min: 0,
          p25: parsed.leadConfidence * 0.5,
          p50: parsed.leadConfidence,
          p75: parsed.leadConfidence,
          max: parsed.leadConfidence,
        } : null,
      },
    },
    source_disclosure: {},
    scope: {
      window: args.window,
      window_basis: 'explicit',
      candidates_count: parsed.chainLength + parsed.coMoverCount,
      candidates_usable: parsed.chainLength + parsed.coMoverCount,
    },
    payload: {
      status,
      threshold_basis: thresholdBasis,
      anchor_ref: { type: 'starting_point', expression: args.starting_point },
      total_latency_ms: Date.now() - startedAt,
      // Surfaced for agents that want to branch without parsing markdown.
      findings: parsed.leadPattern
        ? [
            {
              pattern: parsed.leadPattern,
              service: parsed.leadService,
              lag_seconds: parsed.leadLagSeconds,
              confidence: parsed.leadConfidence,
              evidence_strength:
                parsed.leadConfidence !== null && parsed.leadConfidence >= 0.7
                  ? 'strong'
                  : parsed.leadConfidence !== null && parsed.leadConfidence >= 0.4
                    ? 'medium'
                    : 'weak',
              kind: 'temporal_co_mover',
              suggestion:
                parsed.leadLagSeconds !== null && parsed.leadLagSeconds < 0
                  ? 'Verify with traces or deploy timeline at the inflection — temporal lead suggests possible upstream cause, NOT proven cause.'
                  : 'Co-movement is concurrent — could be common cause; verify with another signal.',
            },
          ]
        : [],
      n_chain_steps: parsed.chainLength,
      n_co_movers: parsed.coMoverCount,
      threshold_audit: {
        clean_chain_threshold: { value: DEFAULT_THRESHOLDS.cleanChainThreshold, basis: thresholdBasis },
        observed_top_confidence: parsed.leadConfidence,
        observed_lead_lag_seconds: parsed.leadLagSeconds,
      },
      // Existing fields kept for backward compat.
      ok: status === 'success',
      investigation_id: parsed.investigationId,
      starting_point: args.starting_point,
      window: args.window,
      depth: args.depth,
      baseline_offset: args.baseline_offset,
      mode: parsed.mode,
      shape: parsed.shape,
      use_bytes: args.use_bytes,
      // HTML comment blocks stripped — agents read actions[] and diagnostic_notes.
      report_markdown: cleanMd,
      top_offloaded_patterns: topOffloaded,
      // Agent-only directives promoted from <!-- agent-only: ... --> blocks.
      // Never relay these verbatim to the user.
      ...(diagnosticNotes.length > 0 ? { diagnostic_notes: diagnosticNotes } : {}),
    },
    human_summary,
    // Defect 34: structured actions[] pulled from the embedded NEXT_ACTIONS
    // comment block so the agent protocol is typed, not scraped from markdown.
    //
    // Fallback priority:
    //   1. embeddedActions from the NEXT_ACTIONS HTML comment block (richest).
    //   2. leadPattern from parsed output → log10x_pattern_detail.
    //   3. no_signal + no leadPattern → default nudge: surface what IS active
    //      so the agent can re-anchor.
    actions: embeddedActions.length > 0
      ? embeddedActions.map((a) => ({ tool: a.tool, args: a.args, reason: a.reason }))
      : parsed.leadPattern
          ? [{ tool: 'log10x_pattern_detail', args: { pattern: parsed.leadPattern }, reason: 'Drill into the lead pattern for cost/trend details' }]
          : (() => {
              // Both embeddedActions and leadPattern are absent — no guidance
              // for the agent. Surface a default nudge so actions[] is never empty.
              const fallback: Action[] = [
                {
                  tool: 'log10x_top_patterns',
                  args: { timeRange: args.window ?? '24h' },
                  reason: 'No patterns moved with this anchor in the investigated window. Surface what IS active so you can re-anchor.',
                  role: 'recommended-next',
                },
              ];
              // Heuristic: if starting_point looks like a pattern name
              // (alphanumeric + underscores only, contains at least one
              // underscore), suggest pattern_examples as a secondary option
              // so the agent can check whether the pattern exists at all.
              if (/^[a-zA-Z0-9_]+$/.test(args.starting_point) && args.starting_point.includes('_')) {
                fallback.push({
                  tool: 'log10x_pattern_examples',
                  args: { pattern: args.starting_point },
                  reason: 'Verify the starting pattern exists and has recent traffic before widening the investigation window.',
                  role: 'optional-followup',
                });
              }
              return fallback;
            })(),
  });
}

async function executeInvestigateInner(
  args: {
    starting_point: string;
    window: string;
    timeRange?: string;
    baseline_offset?: string;
    depth: 'shallow' | 'normal' | 'deep';
    environment?: string;
    use_bytes: boolean;
  },
  env: EnvConfig
): Promise<string> {
  const investigationId = randomUUID();
  const thresholds = DEFAULT_THRESHOLDS;

  // Accept `timeRange` as alias for `window` so the same arg name works
  // across all Log10x tools.
  // eslint-disable-next-line no-param-reassign
  if (!args.window && args.timeRange) (args as Record<string, unknown>).window = args.timeRange;

  // Apply Zod-schema defaults defensively so the function works when called
  // directly (e.g. from tests or other tools) without the schema layer.
  // eslint-disable-next-line no-param-reassign
  if (!args.window)           (args as Record<string, unknown>).window = '1h';
  if (!args.depth)            (args as Record<string, unknown>).depth = 'normal';
  if (args.use_bytes == null) (args as Record<string, unknown>).use_bytes = false;
  // baseline_offset default depends on window magnitude. For short windows
  // (<= 1h), 24h-ago is the right incident baseline ("is this hour worse than
  // yesterday this hour"). For long windows (>= 7d), 24h-ago is WORSE than
  // useless — it compares "last 30d" to "30d shifted by 1 day" (29 of 30 days
  // overlap, so any inflection older than the shift is invisible). Caught by
  // sub-agent S6 (drift scenario): a $30K/mo cart regression 6 days ago was
  // completely missed by `investigate window=30d` with default 24h baseline,
  // while `cost_drivers` immediately surfaced it as +28,000%. The investigate
  // drift flow would have told the user "everything is fine, ±4%".
  //
  // Heuristic: default baseline_offset = window for long windows, 24h for
  // short. Matches the "this month vs last month" / "this week vs last week"
  // convention that operators actually want.
  // Heuristic plus backend-limit guard. Prometheus instant queries reject
  // anything with a total time span > 32 days ("queries with long day range
  // (32d to 95d) are currently only supported for range type queries"). That
  // means window + offset must stay under 32d.
  //
  //   window  | max useful offset | chosen default
  //   5m–1h   | 32d               | 24h  (yesterday-same-hour incident compare)
  //   6h      | 32d               | 24h
  //   24h     | 31d               | 24h  (yesterday same day)
  //   7d      | 25d               | 7d   (this week vs last week)
  //   14d     | 18d               | 14d  (this fortnight vs last)
  //   16d     | 16d               | 16d  (exactly at the limit)
  //   >16d    | <16d              | use cost_drivers for drift — guard below
  //
  // If window alone is > 16d the user should be using cost_drivers() which
  // has its own drift-safe query path. Emit a helpful routing message.
  let effectiveBaselineOffset: string;
  const windowSecs = parseDurationToSeconds(args.window) || 3600;
  if (!args.baseline_offset) {
    const day = 86400;
    if (windowSecs >= 7 * day && windowSecs <= 16 * day) {
      effectiveBaselineOffset = args.window;
    } else if (windowSecs > 16 * day) {
      // Can't default to window without blowing the 32d limit — use 1d as
      // best-effort and let the audit-rendering code emit a warning.
      effectiveBaselineOffset = '1d';
    } else {
      effectiveBaselineOffset = '24h';
    }
  } else {
    effectiveBaselineOffset = args.baseline_offset;
  }
  // If the combined span would exceed the 32d limit even with an explicit
  // user offset, clamp and warn via the rendered output (we can't stop the
  // call, but we can render a clear message on the failed path).
  const baselineSecs = parseDurationToSeconds(effectiveBaselineOffset) || 86400;
  const combinedSpanSecs = windowSecs + baselineSecs;
  const exceedsPromRangeLimit = combinedSpanSecs > 32 * 86400;

  // ── Phase 0 — Environment resolution + metric primitive probe ──
  const metricsEnv = await resolveMetricsEnv(env);
  const reporterTier = metricsEnv === 'edge' ? 'edge' : metricsEnv === 'cloud' ? 'cloud' : 'unknown';

  // Probe for the event-count metric. If it's not emitted by this Reporter,
  // auto-fall back to bytes and annotate the output so the reader knows
  // the rate curves may be skewed by single large events.
  let useBytesMetric = args.use_bytes;
  let metricWarning: string | undefined;
  if (!useBytesMetric) {
    try {
      const probe = await queryInstant(
        env,
        `count(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}"}) > 0`
      );
      if (probe.status !== 'success' || probe.data.result.length === 0) {
        useBytesMetric = true;
        metricWarning = 'event-count metric unavailable — falling back to bytes. Rate curves may be skewed by single large events (a stack-trace burst looks like a volume spike). Deploy the Reporter counter emission to upgrade.';
      }
    } catch {
      // Non-fatal — default to event count optimistically.
    }
  }
  const metricName = useBytesMetric ? 'all_events_summaryBytes_total' : undefined;

  // ── Phase 1 — Anchor resolution ──
  const resolution = await resolveAnchor(args.starting_point, env, metricsEnv, args.window, effectiveBaselineOffset);

  if (resolution.mode === 'environment') {
    // For windows longer than 16 days, route to cost_drivers. Two reasons:
    //   1. Prometheus instant-query 32-day span limit makes it IMPOSSIBLE to
    //      compare "last 30d" to "30d ago" (60d total span) in one query.
    //   2. Even with a shorter offset like 1d, the ratio is meaningless — 29
    //      of 30 days overlap, so any real inflection returns ≈0% change.
    //      Caught by sub-agent S6: a $30K/mo cart regression 6 days ago was
    //      reported as "-0%" because the comparison was 30d vs 30d-minus-1d.
    // The correct tool for multi-week drift is cost_drivers (chunked range
    // query path). Route explicitly rather than produce a silently-broken
    // audit.
    const windowExceedsAuditCapability = windowSecs > 16 * 86400;
    if (exceedsPromRangeLimit || windowExceedsAuditCapability) {
      const reason = exceedsPromRangeLimit
        ? `the combined window + baseline span (${args.window} + ${effectiveBaselineOffset}) exceeds the customer TSDB's 32-day instant-query limit`
        : `a ${args.window} window cannot be compared against a prior ${args.window} (60d total span exceeds the backend limit), and a shorter baseline like 24h produces a ≈0% overlap comparison that silently hides multi-week regressions`;
      const routedReport = [
        `## Investigation: ${args.starting_point}, last ${args.window}`,
        '',
        `**Investigation id**: ${investigationId}`,
        `**Result**: Routed to \`log10x_cost_drivers\`.`,
        '',
        `This question routes better through \`log10x_cost_drivers\`: ${reason}. \`cost_drivers\` uses a chunked range-query path that handles long-window drift correctly and produces per-service week-over-week deltas.`,
        '',
        '**Try instead**:',
        `- \`log10x_cost_drivers({ timeRange: '7d' })\` for global drift ranking (week-over-week)`,
        `- \`log10x_cost_drivers({ timeRange: '30d' })\` for monthly drift`,
        `- \`log10x_investigate({ starting_point: 'environment', window: '7d' })\` if you want the audit layout with a backend-safe window`,
        `- \`log10x_pattern_trend({ pattern: '<specific>', timeRange: '30d', step: '1h' })\` for a single-pattern 30-day time series`,
      ].join('\n');
      recordInvestigation({
        investigationId,
        createdAt: Date.now(),
        startingPoint: args.starting_point,
        environment: env.nickname,
        reporterTier,
        shape: 'environment',
        report: routedReport,
        patternsReferenced: [],
      });
      return routedReport;
    }
    const report = await renderEnvironmentAudit(args, env, metricsEnv, investigationId, reporterTier, effectiveBaselineOffset);
    recordInvestigation({
      investigationId,
      createdAt: Date.now(),
      startingPoint: args.starting_point,
      environment: env.nickname,
      reporterTier,
      shape: 'environment',
      report,
      patternsReferenced: [],
    });
    return appendInvestigateNextActions(report, resolution.anchor, args.window);
  }

  if (!resolution.anchor) {
    const historical = resolution.modeDetection === 'unresolved_historical';
    const lines: string[] = [
      `## Investigation: ${args.starting_point}, last ${args.window}`,
      '',
      `**Investigation id**: ${investigationId}`,
    ];
    if (historical) {
      lines.push(
        `**Result**: "${args.starting_point}" is a known pattern but is silent in the requested window (\`${args.window}\`). ` +
        `It has fired within the last 30d — widen the window to investigate.`,
        '',
        '**Try next**:',
        `- \`log10x_investigate({ starting_point: '${args.starting_point}', window: '7d' })\` — re-run with a wider window`,
        `- \`log10x_pattern_trend({ pattern: '${args.starting_point}', timeRange: '30d' })\` — see when it last fired`,
      );
    } else {
      lines.push(
        `**Result**: Could not resolve "${args.starting_point}" to a known pattern or service.`,
        '',
        '**Supported inputs**:',
        '- A raw log line (will be templatized and matched by structural identity)',
        '- A pattern identity (symbolMessage / tenx_hash)',
        '- A service name',
        '- The literal string `"environment"`, `"all"`, or `"audit"` for an env-wide sweep',
        '',
        '**Try next**:',
        `- \`log10x_event_lookup({ pattern: '${args.starting_point}' })\` to search by substring`,
        `- \`log10x_list_by_label({ label: 'tenx_user_service' })\` to list known services`,
      );
    }
    const report = lines.join('\n');
    recordInvestigation({
      investigationId,
      createdAt: Date.now(),
      startingPoint: args.starting_point,
      environment: env.nickname,
      reporterTier,
      shape: 'unresolved',
      report,
      patternsReferenced: [],
    });
    return appendInvestigateNextActions(report, resolution.anchor, args.window);
  }

  // ── Phase 2a — Recency probe ──
  // Check whether the resolved anchor has been firing RECENTLY, not just
  // aggregating cost over the window. For service-mode and crashloop
  // diagnosis, the top-cost-pattern over 24h may be a historical error that
  // has been suppressed (e.g. the libgssapi crash that was fixed but still
  // dominates yesterday's cost), while the CURRENT failure is a different
  // pattern entirely. Caught by head-to-head test S11/S12: kubectl --previous
  // correctly surfaced a Postgres duplicate-key bug as the CURRENT crashloop
  // cause, while the MCP resolved to the Kerberos pattern (90% false
  // confidence) because it was still the top-cost-pattern for the 24h window.
  //
  // Recency check: query the anchor's rate over the last 5 minutes. If it's
  // near zero while the pattern still accumulates cost in the wider window,
  // emit a banner warning the user that the tool's answer may be historical.
  let recencyWarning: string | undefined;
  if (resolution.mode === 'service' || resolution.mode === 'pattern') {
    try {
      const freshnessMetric = metricName || 'all_events_summaryVolume_total';
      const recencyQ = `sum(rate(${freshnessMetric}{${LABELS.env}="${metricsEnv}",${LABELS.pattern}="${escape(resolution.anchor)}"}[5m]))`;
      const res = await queryInstant(env, recencyQ);
      let recentRate = 0;
      if (res.status === 'success' && res.data.result[0]) {
        recentRate = parsePrometheusValue(res.data.result[0]);
      }
      if (recentRate < thresholds.acuteNoiseFloor) {
        // Anchor hasn't fired in the last 5 minutes. If this is a service-mode
        // investigation, also run a most-recent-error probe scoped to the
        // service to see whether a DIFFERENT pattern is currently active.
        if (resolution.mode === 'service' && resolution.service) {
          // Query for ANY pattern currently firing in the service, not just
          // ERROR/CRIT. The severity label is often empty on multi-line stack
          // traces (real accounting crashloop case: 71% of logs have
          // severity="(empty)" because the Npgsql exception trace doesn't
          // parse into CRITICAL). Rank by rate so the loudest current pattern
          // surfaces first — we'll let the operator judge which is the live
          // failure.
          const activeErrorsQ =
            `topk(3, sum by (${LABELS.pattern}, ${LABELS.severity}) (rate(${freshnessMetric}{${LABELS.env}="${metricsEnv}",${LABELS.service}="${escape(resolution.service)}"}[5m])) > ${thresholds.acuteNoiseFloor}) unless on (${LABELS.pattern}) (sum by (${LABELS.pattern}) (rate(${freshnessMetric}{${LABELS.env}="${metricsEnv}",${LABELS.pattern}="${escape(resolution.anchor)}"}[5m])))`;
          const activeRes = await queryInstant(env, activeErrorsQ);
          if (activeRes.status === 'success' && activeRes.data.result.length > 0) {
            const activeNames = activeRes.data.result
              .map((r) => {
                const p = r.metric[LABELS.pattern];
                const s = r.metric[LABELS.severity] || 'unknown-severity';
                return `\`${p}\` (${s})`;
              })
              .join(', ');
            recencyWarning =
              `> **Anchor may be historical, not current**: the resolved anchor \`${resolution.anchor}\` has not fired in the last 5 minutes (rate near zero) but is still ranked top by 24h cost. For an active incident, the 24h cost ranking can surface a pattern that was loud yesterday but has since been fixed or suppressed, while a different pattern is causing the active failure.\n\n` +
              `**Currently-active patterns in \`${resolution.service}\`** (last 5 min, any severity, excluding the anchor): ${activeNames}.\n` +
              agentOnly(`To diagnose the live issue, re-run log10x_investigate with one of the currently-active patterns above as starting_point instead of the historical anchor.`);
          } else {
            recencyWarning =
              `> **Anchor may be historical**: \`${resolution.anchor}\` has not fired in the last 5 minutes. No other patterns currently active in \`${resolution.service}\` either — service may be stable and the anchor is purely historical cost.`;
          }
        } else {
          recencyWarning =
            `> **Anchor may be historical**: \`${resolution.anchor}\` has not fired in the last 5 minutes (rate near zero). The analysis below reflects cumulative behavior across the window, not current activity.`;
        }
      }
    } catch {
      // non-fatal
    }
  }

  // ── Phase 2 — Trajectory shape classification ──
  const shape = await classifyTrajectory(
    env,
    metricsEnv,
    resolution.anchor,
    args.window,
    thresholds,
    resolution.severity,
    metricName,
    effectiveBaselineOffset
  );

  if (shape.shape === 'flat') {
    const emptyReport = renderEmpty(args.starting_point, args.window, investigationId, thresholds.acuteNoiseFloor);
    // If the anchor is historical (fired below noise floor in the last 5m)
    // AND a different pattern is currently active in the service, the flat
    // "no significant movement" result is dangerously misleading — it means
    // "the HISTORICAL TOP-COST pattern is flat" not "nothing is happening".
    // Prepend the recency warning so an operator sees the live pattern
    // pointer before the empty result. Caught by sub-agent S16 on the
    // accounting crashloop rerun: the recency probe correctly found the
    // live bug but the flat-path report dropped the warning.
    const report = recencyWarning ? `${recencyWarning}\n\n---\n\n${emptyReport}` : emptyReport;
    recordInvestigation({
      investigationId,
      createdAt: Date.now(),
      startingPoint: args.starting_point,
      environment: env.nickname,
      reporterTier,
      shape: 'flat',
      report,
      patternsReferenced: [resolution.anchor],
    });
    return appendInvestigateNextActions(report, resolution.anchor, args.window);
  }

  // ── Phase 3-D — Drift flow ──
  if (shape.shape === 'drift') {
    const driftWindow = widestDriftWindow(args.window);
    const drift = await runDriftCorrelation({
      env,
      metricsEnv,
      anchor: resolution.anchor,
      window: driftWindow,
      depth: args.depth,
      thresholds,
      scopeService: resolution.service,
      anchorSeverity: resolution.severity,
      metricName,
    });

    const sevKey = (resolution.severity || 'default').toLowerCase() as keyof typeof thresholds.driftMinSlopePerWeek;
    const driftFloor = thresholds.driftMinSlopePerWeek[sevKey] ?? thresholds.driftMinSlopePerWeek.default;

    const report = renderDriftReport({
      investigationId,
      anchor: resolution.anchor,
      startingPoint: args.starting_point,
      inputType: resolution.inputType,
      service: resolution.service,
      environment: env.nickname,
      windowLabel: driftWindow,
      metricsEnv,
      reporterTier,
      metricPrimitive: useBytesMetric ? 'bytes' : 'event_count',
      driftThresholdApplied: driftFloor,
      drift,
    });
    recordInvestigation({
      investigationId,
      createdAt: Date.now(),
      startingPoint: args.starting_point,
      environment: env.nickname,
      reporterTier,
      shape: 'drift',
      report,
      patternsReferenced: collectDriftPatternsReferenced(resolution.anchor, drift),
    });
    return appendInvestigateNextActions(report, resolution.anchor, args.window);
  }

  // ── Phase 3 — Acute-spike flow ──
  const inflection = await detectInflection(
    env,
    metricsEnv,
    resolution.anchor,
    args.window,
    metricName
  );
  const baselineOffsetSeconds = parseDurationToSeconds(effectiveBaselineOffset);

  const correlation = await runAcuteSpikeCorrelation({
    env,
    metricsEnv,
    anchor: resolution.anchor,
    inflectionTimestamp: inflection.timestamp,
    baselineOffsetSeconds,
    window: args.window,
    depth: args.depth,
    thresholds,
    scopeService: resolution.service,
    metricName,
  });

  // Preserve the old "throw → typed error envelope" behavior now that
  // correlate.ts returns structural failures as a typed CorrelationResult
  // with status==='error' instead of throwing. The outer executeInvestigate
  // catch routes this through wrapBackendError into a chassis envelope.
  if (correlation.status === 'error' && correlation.error) {
    throw new Error(correlation.error.hint);
  }

  // Per spec: if the inflection is inferred (no sharp change-point), cap all
  // chain-link confidences at "low" so the report doesn't overclaim causality.
  if (inflection.confidence === 'inferred') {
    for (const link of correlation.chain) {
      link.chain = Math.min(link.chain, 0.3);
      link.confidence = link.stat * link.lag * link.chain;
    }
  }

  // ── Phase 6 — Retriever fallback (graceful) ──
  let retrieverFallback: 'disabled' | 'unavailable' | 'stage_1_only' | 'stage_1_and_2' | 'not_run' = 'not_run';
  const leadConfidence = correlation.chain[0]?.confidence ?? 0;

  if (!isRetrieverConfigured()) {
    retrieverFallback = 'unavailable';
  } else if (leadConfidence >= thresholds.cleanChainThreshold) {
    retrieverFallback = 'disabled'; // clean chain — no need
  } else if (leadConfidence < thresholds.retrieverEscalationThreshold) {
    // Stage 1 — targeted anchor history
    try {
      const stage1 = await runRetrieverQuery(
        env,
        {
          pattern: resolution.anchor,
          from: 'now-30d',
          to: 'now',
          format: 'aggregated',
          bucketSize: '1d',
          limit: 10_000,
        },
        { timeoutMs: 30_000 }
      );
      retrieverFallback = 'stage_1_only';
      // If Stage 1 reveals enough buckets with sustained movement, we'd
      // normally fire Stage 2. The MVP stops at Stage 1 and annotates.
      if ((stage1.buckets || []).length > 7) {
        // TODO: full Stage 2 re-correlation in the historical inflection window.
        retrieverFallback = 'stage_1_only';
      }
    } catch {
      retrieverFallback = 'unavailable';
    }
  }

  // ── Phase 7 — Render acute-spike report ──
  const modeDetectionParts = [resolution.modeDetection, `inflection=${inflection.confidence === 'inferred' ? 'inferred_midpoint' : inflection.confidence}`];
  if (metricWarning) modeDetectionParts.push('metric=bytes_fallback');
  const modeDetection = modeDetectionParts.join(' · ');

  const baseReport = renderAcuteSpikeReport({
    investigationId,
    anchor: resolution.anchor,
    startingPoint: args.starting_point,
    inputType: resolution.inputType,
    service: resolution.service,
    environment: env.nickname,
    inflectionTimestamp: inflection.timestamp,
    windowLabel: args.window,
    metricsEnv,
    reporterTier,
    metricPrimitive: useBytesMetric ? 'bytes' : 'event_count',
    noiseFloor: thresholds.acuteNoiseFloor,
    modeDetection,
    correlation,
    retrieverFallback,
    depth: args.depth,
    metricWarning,
  });
  // Prepend the recency warning (if any) so a reader sees it before the
  // main analysis — historical vs current misattribution is the most
  // dangerous mis-interpretation for crashloop scenarios.
  const report = recencyWarning ? `${recencyWarning}\n\n---\n\n${baseReport}` : baseReport;
  recordInvestigation({
    investigationId,
    createdAt: Date.now(),
    startingPoint: args.starting_point,
    environment: env.nickname,
    reporterTier,
    shape: 'acute',
    report,
    patternsReferenced: collectPatternsReferenced(resolution.anchor, correlation),
  });
  return appendInvestigateNextActions(report, resolution.anchor, args.window);
}

// ── Next-action generation for autonomous chains ──
//
// Investigate's natural downstream tools depend on its outcome. Always
// emit the canonical post-investigation chain links so an orchestrator
// reading the structured block can continue without prose-parsing the
// markdown body.
function buildInvestigateNextActions(
  anchor?: string,
  window?: string,
  topOffloadedSample?: { pattern: string },
): NextAction[] {
  if (!anchor) return [];
  const out: NextAction[] = [
    {
      tool: 'log10x_dependency_check',
      args: { pattern: anchor },
      reason: 'check dashboards / alerts before any mute action',
    },
    {
      tool: 'log10x_metrics_that_moved',
      args: { anchor_type: 'log10x_pattern', anchor, ...(window ? { window } : {}) },
      reason: 'first step of cross-pillar investigation — filter customer metrics to those that move with the anchor\'s incident phase. Compose with log10x_rank_by_shape_similarity + log10x_metric_overlay on the kept set',
    },
    {
      tool: 'log10x_pattern_trend',
      args: { pattern: anchor },
      reason: 'time series for the investigated pattern',
    },
  ];
  if (topOffloadedSample) {
    out.push({
      tool: 'log10x_retriever_query',
      args: { pattern: topOffloadedSample.pattern, from: 'now-24h' },
      reason: 'top mover is in the drop/offload cohort (isDropped); if offloaded to S3 (not hard-dropped), pull its events from the offload bucket — a zero result means it was hard-dropped',
    });
  }
  return out;
}

function appendInvestigateNextActions(
  report: string,
  anchor?: string,
  window?: string,
  topOffloadedSample?: { pattern: string },
): string {
  const block = renderNextActions(buildInvestigateNextActions(anchor, window, topOffloadedSample));
  return block ? `${report}\n\n${block}` : report;
}

/**
 * Rewrite the trailing NEXT_ACTIONS block in an already-rendered
 * investigation report to include an offload-pivot action. Used by
 * `executeInvestigate` after the offload-status lookup completes —
 * the `appendInvestigateNextActions` / per-mode block was emitted
 * before offload status was known, so we strip the trailing block,
 * parse out the existing actions, append the offload-pivot, and
 * re-emit. Works for both acute/drift (anchor-driven) and env-mode
 * (no anchor) paths because we read the existing actions from the
 * machine-parseable block rather than rebuilding from arguments.
 *
 * Best-effort: if the existing block can't be located the report is
 * returned unchanged.
 */
function rewriteNextActionsWithOffload(
  report: string,
  topOffloadedSample: { pattern: string },
): string {
  // The block is the trailing pair of HTML-comment-guarded segments
  // emitted by renderNextActions(); identify it by the leading
  // PRESENT_OPEN marker. Strip from there to end-of-string, re-extract
  // the existing actions, append the offload pivot, re-emit.
  const PRESENT_OPEN = '<!-- NEXT_STEPS_FOR_USER:';
  const idx = report.lastIndexOf(PRESENT_OPEN);
  if (idx === -1) return report; // no existing block — nothing to splice
  const existing = extractNextActions(report);
  const trimmed = report.slice(0, idx).replace(/\s+$/, '');
  const merged: NextAction[] = [
    ...existing,
    {
      tool: 'log10x_retriever_query',
      args: { pattern: topOffloadedSample.pattern, from: 'now-24h' },
      reason: 'top mover is in the drop/offload cohort (isDropped); if offloaded to S3 (not hard-dropped), pull its events from the offload bucket — a zero result means it was hard-dropped',
    },
  ];
  const fresh = renderNextActions(merged);
  return fresh ? `${trimmed}\n\n${fresh}` : trimmed;
}

// ── Anchor resolution ──

interface Resolution {
  mode: Mode;
  anchor?: string;
  service?: string;
  severity?: string;
  inputType: string;
  modeDetection: string;
}

async function resolveAnchor(
  startingPoint: string,
  env: EnvConfig,
  metricsEnv: string,
  window: string,
  baselineOffset: string
): Promise<Resolution> {
  const sp = startingPoint.trim();

  // Environment-wide audit literal
  if (/^(environment|all|audit)$/i.test(sp)) {
    return { mode: 'environment', inputType: 'environment_literal', modeDetection: 'environment_audit' };
  }

  // Pattern identity heuristic: symbolMessage token (`~xxx`), underscore_separated
  // token, OR dash-separated service name (e.g., `product-reviews`, `ad-service`).
  // Services in k8s commonly use kebab-case, so the regex must accept dashes
  // or the resolver falls through to the fuzzy raw-log-line matcher and finds
  // unrelated patterns with substring hits. Caught live on otel-demo: the
  // `product-reviews` input was being routed to the `llm` service because the
  // llm patterns contain "product_reviews" in their body text.
  if (/^~?[A-Za-z0-9_-]+$/.test(sp)) {
    // Try as pattern first.
    //
    // Probe window = the user's investigation window. Previously hardcoded to
    // `[5m]`, which silently rejected any sparse/bursty pattern that didn't
    // happen to fire in the last 5 minutes — even when it clearly existed in
    // the investigation's own window. Caught live on otel-demo: a shipping
    // error pattern emitted by `log10x_cost_drivers({ timeRange: "7d" })` at
    // ~2430 events/s over the 7d window was unresolvable because it was
    // silent in the last 5m/1h. Resolution window must align with scope.
    const byPattern = await queryInstant(
      env,
      `sum(rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}",${LABELS.pattern}="${escape(sp)}"}[${window}])) > 0`
    );
    if (byPattern.status === 'success' && byPattern.data.result.length > 0) {
      // Try to pull the severity + service for the anchor.
      const meta = await lookupPatternMeta(env, metricsEnv, sp, window);
      return {
        mode: 'pattern',
        anchor: sp,
        service: meta.service,
        severity: meta.severity,
        inputType: 'pattern_identity',
        modeDetection: 'direct',
      };
    }
    // Try as service — anchor becomes the pattern with the largest |rate change|
    // vs the user's baseline_offset, NOT the loudest pattern. Previous behavior
    // (topk by absolute 1h rate) meant a stable high-volume pattern would shadow
    // every actually-moving pattern in the service, producing "no significant
    // movement" reports even when env-mode surfaced clear -73% decliners on the
    // same data. The resolver must match what the user actually asked — "what
    // moved in this service" — not "what's loudest in this service".
    //
    // We bottom-guard the baseline with meaningfulBaselineFloor=0.01 events/s
    // to prevent near-zero baselines from inflating relative change to +9000%
    // on trivial activity (GAPS G6, PR #25 correction).
    const thresholds = (await import('../lib/thresholds.js')).DEFAULT_THRESHOLDS;
    const meaningfulBaselineFloor = thresholds.acuteNoiseFloor * 10;
    const signedChange =
      `(sum by (${LABELS.pattern}, ${LABELS.severity}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}",${LABELS.service}="${escape(sp)}"}[${window}])) ` +
      `/ ` +
      `sum by (${LABELS.pattern}, ${LABELS.severity}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}",${LABELS.service}="${escape(sp)}"}[${window}] offset ${baselineOffset}) > ${meaningfulBaselineFloor})` +
      `) - 1`;
    const [growRes, declineRes] = await Promise.all([
      queryInstant(env, `topk(1, ${signedChange})`),
      queryInstant(env, `bottomk(1, ${signedChange})`),
    ]);
    // Merge, pick the row with the largest |rate change|
    type Row = { pattern: string; severity: string; rc: number };
    const rows: Row[] = [];
    for (const res of [growRes, declineRes]) {
      if (res.status === 'success') {
        for (const r of res.data.result) {
          const rc = parsePrometheusValue(r);
          if (Number.isFinite(rc)) {
            rows.push({
              pattern: r.metric[LABELS.pattern],
              severity: r.metric[LABELS.severity],
              rc,
            });
          }
        }
      }
    }
    if (rows.length > 0) {
      rows.sort((a, b) => Math.abs(b.rc) - Math.abs(a.rc));
      const top = rows[0];
      return {
        mode: 'service',
        anchor: top.pattern,
        service: sp,
        severity: top.severity,
        inputType: 'service_name',
        modeDetection: 'direct',
      };
    }
    // Fallback: if no patterns crossed the meaningful baseline floor, fall
    // back to the loudest pattern so the investigate flow still has something
    // to classify (will likely hit "flat", which is the honest result).
    const svcPat = await queryInstant(
      env,
      `topk(1, sum by (${LABELS.pattern}, ${LABELS.severity}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}",${LABELS.service}="${escape(sp)}"}[${window}])))`
    );
    if (svcPat.status === 'success' && svcPat.data.result.length > 0) {
      const row = svcPat.data.result[0];
      return {
        mode: 'service',
        anchor: row.metric[LABELS.pattern],
        service: sp,
        severity: row.metric[LABELS.severity],
        inputType: 'service_name',
        modeDetection: 'direct',
      };
    }
    // Wide-probe: if the input looks like a pattern identity but isn't active
    // in the requested window, check whether it's active at 30d. If so, tag
    // the resolution with a hint so the error message can suggest widening
    // the window instead of bouncing the user to event_lookup.
    const widePatternProbe = await queryInstant(
      env,
      `sum(rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}",${LABELS.pattern}="${escape(sp)}"}[30d])) > 0`
    );
    const existsAtWider =
      widePatternProbe.status === 'success' && widePatternProbe.data.result.length > 0;
    return {
      mode: 'pattern',
      inputType: 'pattern_identity',
      modeDetection: existsAtWider ? 'unresolved_historical' : 'unresolved',
    };
  }

  // Raw log line → fuzzy substring match on the pattern label
  const fuzzy = sp
    .replace(/[0-9]+/g, '.*')
    .replace(/[_\s]+/g, '.*')
    .replace(/[^\w.*]/g, '.*')
    .slice(0, 60);
  const fuzzyQ = `topk(1, sum by (${LABELS.pattern}, ${LABELS.service}, ${LABELS.severity}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}",${LABELS.pattern}=~".*${fuzzy}.*"}[5m])))`;
  try {
    const res = await queryInstant(env, fuzzyQ);
    if (res.status === 'success' && res.data.result.length > 0) {
      const row = res.data.result[0];
      return {
        mode: 'raw_line',
        anchor: row.metric[LABELS.pattern],
        service: row.metric[LABELS.service],
        severity: row.metric[LABELS.severity],
        inputType: 'raw_log_line',
        modeDetection: 'fuzzy_match',
      };
    }
  } catch {
    // non-fatal
  }
  return { mode: 'raw_line', inputType: 'raw_log_line', modeDetection: 'unresolved' };
}

async function lookupPatternMeta(
  env: EnvConfig,
  metricsEnv: string,
  pattern: string,
  window: string
): Promise<{ service?: string; severity?: string }> {
  try {
    const q = `sum by (${LABELS.service}, ${LABELS.severity}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}",${LABELS.pattern}="${escape(pattern)}"}[${window}]))`;
    const res = await queryInstant(env, q);
    if (res.status === 'success' && res.data.result[0]) {
      return {
        service: res.data.result[0].metric[LABELS.service],
        severity: res.data.result[0].metric[LABELS.severity],
      };
    }
  } catch {
    // non-fatal
  }
  return {};
}

// ── Environment-wide audit ──

async function renderEnvironmentAudit(
  args: { window: string; starting_point: string; baseline_offset?: string; depth: 'shallow' | 'normal' | 'deep'; environment?: string; use_bytes: boolean },
  env: EnvConfig,
  metricsEnv: string,
  investigationId: string,
  reporterTier: 'edge' | 'cloud' | 'unknown',
  effectiveBaselineOffset: string
): Promise<string> {
  const lines: string[] = [];
  lines.push(`## Environment audit, last ${args.window}`);
  lines.push('');
  lines.push(`**Investigation id**: ${investigationId}`);
  lines.push(`**Environment**: ${env.nickname}`);
  lines.push(`**Reporter tier**: ${reporterTier}`);
  lines.push('');

  // Top 5 movers by rate change, preserving direction.
  //
  // Previous implementation used topk(5, abs((current/baseline) - 1)) which
  // correctly ranked by magnitude but LOST THE SIGN. A pattern going from
  // 87 events/s (baseline) to 0 events/s (current) has rc = -1, abs(rc)=1,
  // and renders as "+100% vs 24h ago" even though it's a -100% decline.
  // Caught by production investigation of cart_cartstore_ValkeyCartStore
  // during the otel-demo swap session — the pattern went to zero because
  // of an unrelated engine bug (see GAPS G8), and the "+100%" label was
  // the opposite of what happened. Sign loss makes the output structurally
  // dishonest.
  //
  // Fix: run two separate queries — topk(5, signed_change) for biggest
  // growths, bottomk(5, signed_change) for biggest declines — then merge
  // and label each with its actual sign. Baseline guard retained so
  // near-zero baselines don't amplify spurious +N% flags (GAPS G6).
  const thresholds = (await import('../lib/thresholds.js')).DEFAULT_THRESHOLDS;
  const meaningfulBaselineFloor = thresholds.acuteNoiseFloor * 10;
  const signedChangeExpr =
    `(sum by (${LABELS.pattern}, ${LABELS.service}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}"}[${args.window}])) ` +
    `/ ` +
    `sum by (${LABELS.pattern}, ${LABELS.service}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}"}[${args.window}] offset ${effectiveBaselineOffset}) > ${meaningfulBaselineFloor})` +
    `) - 1`;
  let topPatternForChain: string | undefined;
  try {
    const [growRes, declineRes] = await Promise.all([
      queryInstant(env, `topk(5, ${signedChangeExpr})`),
      queryInstant(env, `bottomk(5, ${signedChangeExpr})`),
    ]);

    type Row = { pattern: string; service: string; rc: number };
    const rows: Row[] = [];
    for (const r of [growRes, declineRes]) {
      if (r.status !== 'success') continue;
      for (const row of r.data.result) {
        const rc = parsePrometheusValue(row);
        if (!Number.isFinite(rc)) continue;
        const pattern = row.metric[LABELS.pattern];
        // Some series in Prometheus are missing the message_pattern label
        // (ingest-side artifact — series gets written without it). Previously
        // we rendered those as `undefined (service)` in the Top movers list,
        // which is actively misleading: the operator tries to investigate
        // "undefined" and hits a dead-end. Skip instead. Grok round-2 run
        // surfaced this live on the otel-demo `payment` service.
        if (!pattern) continue;
        const service = row.metric[LABELS.service] || 'unknown';
        rows.push({ pattern, service, rc });
      }
    }
    // Dedupe by pattern — a row can be in both topk/bottomk if only a handful exist.
    const seen = new Set<string>();
    const deduped = rows.filter((r) => {
      if (seen.has(r.pattern)) return false;
      seen.add(r.pattern);
      return true;
    });
    // Sort by absolute magnitude so the biggest movers come first.
    deduped.sort((a, b) => Math.abs(b.rc) - Math.abs(a.rc));

    // G10 collapse heuristic: the engine fingerprinter sometimes leaks
    // high-cardinality variable values (usernames, UUIDs, session IDs) into
    // pattern identities. When that happens, many "different" patterns from
    // the same service with near-identical rate changes (±5%) are really
    // variants of the same structural template rotating as users churn. A
    // naive top-movers list then shows "5 patterns declined -100%" in one
    // service which looks like a service incident but is actually just
    // variant rotation. Collapse them into a single summary row so the
    // operator sees one signal instead of five phantom ones.
    //
    // The collapse is conservative: only triggers when ≥3 patterns from the
    // same service have rate changes within 5% of each other AND the overall
    // magnitudes are significant (|rc| >= 0.5). Anything below that stays
    // uncollapsed so real incidents aren't hidden.
    interface DisplayRow {
      pattern: string;
      service: string;
      rc: number;
      collapsedCount?: number; // set if this row represents a collapsed group
    }
    const topMovers: DisplayRow[] = [];
    const usedPatterns = new Set<string>();
    for (const r of deduped) {
      if (usedPatterns.has(r.pattern)) continue;
      if (topMovers.length >= 8) break;
      // Find all other rows in the same service with rc within ±5% of r.rc
      if (Math.abs(r.rc) >= 0.5) {
        const siblings = deduped.filter(
          (x) =>
            x.service === r.service &&
            !usedPatterns.has(x.pattern) &&
            Math.abs(x.rc - r.rc) / Math.max(Math.abs(r.rc), 0.01) <= 0.05
        );
        if (siblings.length >= 3) {
          // Collapse the group into a single display row
          for (const s of siblings) usedPatterns.add(s.pattern);
          topMovers.push({
            pattern: r.pattern,
            service: r.service,
            rc: r.rc,
            collapsedCount: siblings.length,
          });
          continue;
        }
      }
      usedPatterns.add(r.pattern);
      topMovers.push({ pattern: r.pattern, service: r.service, rc: r.rc });
    }

    if (topMovers.length > 0) {
      lines.push('### Top movers');
      lines.push('');
      let anyCollapsed = false;
      for (const r of topMovers) {
        const pct = (r.rc * 100).toFixed(0);
        const direction = r.rc >= 0 ? `+${pct}%` : `${pct}%`;
        const label = r.rc >= 0 ? 'grew' : 'declined';
        if (r.collapsedCount && r.collapsedCount > 1) {
          anyCollapsed = true;
          lines.push(
            `- **${r.collapsedCount} high-cardinality variants in \`${r.service}\`** — each ${label} ${direction} vs ${effectiveBaselineOffset} ago (collapsed: same rate change within ±5%, likely variable-value rotation rather than a service incident). Example: ${patternDisplay(r.pattern).title}`
          );
        } else {
          lines.push(`- \`${r.service}\` · ${patternDisplay(r.pattern).title} · ${label} ${direction} vs ${effectiveBaselineOffset} ago`);
        }
      }
      lines.push('');
      // Resolve the actual top mover for the prose hint (and for the
      // structured NEXT_ACTIONS appended by the caller). Earlier this
      // section printed the literal placeholder `<top_pattern_name>`,
      // which the agent then echoed verbatim into the next call —
      // caught by the env-sweep eval scenario.
      const topMover = topMovers.find((m) => !m.collapsedCount || m.collapsedCount <= 1) ?? topMovers[0];
      topPatternForChain = topMover.pattern;
      lines.push('**Next action**: investigate the top mover individually:');
      lines.push(`\`log10x_investigate({ starting_point: '${topPatternForChain}', window: '${args.window}' })\``);
      lines.push('');
      lines.push('_Note: declines (negative %) are real signals — a pattern that stopped firing may indicate a service crashed, a monitor was muted, or a real upstream change. Treat them the same way you treat spikes._');
      if (anyCollapsed) {
        lines.push('');
        lines.push('_**Collapsed-variant note**: rows labeled "N high-cardinality variants" represent multiple pattern identities from the same service that are moving by nearly identical magnitudes. This is typically caused by high-cardinality variable values (usernames, UUIDs, session IDs) leaking into the pattern identity — the engine fingerprinter should have tokenized these out but did not. Treat as one signal, not N. If this represents a real service-level incident, drill into any one of the collapsed patterns directly._');
      }
    } else {
      lines.push('_No significant movement detected across the environment in this window._');
      lines.push('');
      lines.push(`_Top-movers pass requires the baseline-window rate to exceed ${meaningfulBaselineFloor} events/s on at least one pattern. If no pattern meets that floor, the environment is either steady-state or too sparse for meaningful delta detection. Try a longer window or investigate individual services directly._`);
    }
  } catch (e) {
    lines.push(`_Environment audit query failed: ${(e as Error).message}_`);
  }

  // Append a structured NEXT_ACTIONS block when we identified a top
  // mover. resolution.anchor is undefined for environment-mode (the
  // anchor IS the environment, not a single pattern), so the caller's
  // appendInvestigateNextActions early-returns with no hint. Emit hints
  // here so chain walkers can pivot to the top mover, dependency_check,
  // and a cross-pillar correlation without prose-parsing the report.
  if (topPatternForChain) {
    const next: NextAction[] = [
      {
        tool: 'log10x_investigate',
        args: { starting_point: topPatternForChain, window: args.window },
        reason: 'drill into the top mover from the env-wide sweep',
      },
      {
        tool: 'log10x_dependency_check',
        args: { pattern: topPatternForChain },
        reason: 'check refs before any mute on the top mover',
      },
      {
        tool: 'log10x_metrics_that_moved',
        args: { anchor_type: 'log10x_pattern', anchor: topPatternForChain, window: args.window },
        reason: 'first step of cross-pillar investigation — filter customer metrics to those that move with the top mover\'s incident phase',
      },
    ];
    const block = renderNextActions(next);
    if (block) lines.push('', block);
  }

  return lines.join('\n');
}

// ── Helpers ──

function widestDriftWindow(current: string): string {
  // Widen a short window for drift analysis. Drift needs at least 7 days of history.
  const sec = parseDurationToSeconds(current);
  if (sec >= 7 * 86400) return current;
  return '30d';
}

function parseDurationToSeconds(s: string): number {
  const m = s.match(/^(\d+)([smhdw])$/);
  if (!m) return 86400;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    case 'w':
      return n * 604800;
    default:
      return 86400;
  }
}

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

