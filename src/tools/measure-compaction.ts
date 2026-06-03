/**
 * log10x_measure_compaction — measure real per-pattern compaction ratios
 * from live SIEM samples.
 *
 * Pulls N events from the SIEM scoped to a service, runs them through the
 * tenx engine, and returns per-pattern compaction ratios derived from actual
 * byte measurements rather than hardcoded model estimates.
 *
 * Flow:
 *   1. Fetch `sample_size` events from the SIEM for the given service over
 *      `timeRange` via the existing connector.pullEvents() plumbing.
 *   2. Run events through tenx @apps/mcp-file via runMcpAppOnEvents().
 *   3. Group encoded events by patternHash (tenxHash anchor on the encoded
 *      line; falls back to templateHash).
 *   4. For each pattern:
 *        - total_encoded_bytes = sum of EncodedEvent.lineBytes
 *        - total_original_bytes = sum of expandedByteLength(template, values)
 *          for each event (the reconstructed original text byte length)
 *        - compaction_ratio_x = total_original_bytes / total_encoded_bytes
 *   5. Return per-pattern envelope with confidence tiers.
 *
 * The measured ratio replaces the hardcoded estimates in cost.ts
 * (compact_ratio_low/high) and configure-engine.ts's hardcoded 0.15.
 * That migration is a separate step — this tool just ships the measurements.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { resolveSiemSelection, formatAmbiguousError, formatNoneError } from '../lib/siem/resolve.js';
import { getConnector } from '../lib/siem/index.js';
import { runMcpAppOnEvents } from '../lib/mcp-app-runner.js';
import { DevCliNotInstalledError } from '../lib/dev-cli.js';
import { expandedByteLength } from '../lib/template-expander.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';

// ── Schema ──

export const measureCompactionSchema = {
  service: z
    .string()
    .describe(
      'Service name to scope the SIEM sample to. Used as the query filter (e.g., Datadog `service:<name>`, Splunk `sourcetype=<name>`, CloudWatch stream prefix).'
    ),
  sample_size: z
    .number()
    .int()
    .min(10)
    .max(5000)
    .default(500)
    .optional()
    .describe(
      'Number of events to pull from the SIEM for measurement. Default 500. Larger samples improve confidence (high confidence requires >=50 events per pattern) but take longer to pull and process.'
    ),
  timeRange: z
    .string()
    .regex(/^\d+[mhd]$/)
    .default('24h')
    .optional()
    .describe(
      'Lookback window for the SIEM pull. Format: <N><unit> where unit is m (minutes), h (hours), or d (days). Default "24h".'
    ),
  environment: z
    .string()
    .optional()
    .describe('Log10x environment id. Omit to use the default environment.'),
};

export type MeasureCompactionArgs = {
  service: string;
  sample_size?: number;
  timeRange?: string;
  environment?: string;
};

// ── Output types ──

export interface PatternCompactionResult {
  /** Stable per-pattern identity (tenxHash / patternHash). */
  pattern_hash: string;
  /** Human-readable pattern name (symbolMessage), when available. */
  symbol_message?: string;
  /** Number of events contributing to this measurement. */
  sample_count: number;
  /** Sum of reconstructed original text byte lengths across all sampled events. */
  total_original_bytes: number;
  /** Sum of encoded-line byte lengths (wire bytes) across all sampled events. */
  total_encoded_bytes: number;
  /**
   * Compaction ratio: original_bytes / encoded_bytes.
   * A ratio of 8.5 means compaction shrinks events to ~11.8% of original size.
   * Higher is better.
   */
  compaction_ratio_x: number;
  /** Confidence tier based on sample_count. */
  confidence: 'low' | 'medium' | 'high';
}

interface MeasureCompactionData {
  service: string;
  sample_size_requested: number;
  sample_size_actual: number;
  timeRange: string;
  patterns: PatternCompactionResult[];
  /** Wall time for the SIEM pull in ms. */
  siem_pull_ms: number;
  /** Wall time for the tenx engine run in ms. */
  engine_ms: number;
  /**
   * Verbatim table for must_render_verbatim. One row per pattern, sorted by
   * total_original_bytes descending (highest-volume patterns first).
   */
  must_render_verbatim: string;
}

// ── Helpers ──

function confidenceTier(count: number): 'low' | 'medium' | 'high' {
  if (count >= 50) return 'high';
  if (count >= 10) return 'medium';
  return 'low';
}

/**
 * Coerce a SIEM event object to a raw log line string. Same logic as
 * pattern-extraction.ts coerceToLine — pulls the `message`/`log`/`_raw`
 * field out of transport envelopes before feeding to tenx.
 */
function coerceEventToLine(ev: unknown): string {
  if (ev == null) return '';
  if (typeof ev === 'string') return ev.replace(/\r?\n/g, ' ');
  if (typeof ev === 'object') {
    const o = ev as Record<string, unknown>;
    // Common text-field candidates.
    const cand =
      o.text ??
      o.message ??
      (o.attributes && typeof o.attributes === 'object'
        ? (o.attributes as Record<string, unknown>).message
        : undefined) ??
      o.log ??
      o.log_s ??
      o.body ??
      o._raw ??
      o.Message ??
      o.Message_s;
    if (typeof cand === 'string') {
      // Unwrap one JSON envelope level if the candidate is itself JSON.
      const t = cand.trim();
      if (t.startsWith('{') && t.endsWith('}')) {
        try {
          const nested = JSON.parse(t) as Record<string, unknown>;
          if (nested && typeof nested === 'object') {
            const inner = coerceEventToLine(nested);
            if (inner) return inner;
          }
        } catch {
          // not JSON
        }
      }
      return cand.replace(/\r?\n/g, ' ');
    }
    try {
      return JSON.stringify(o).replace(/\r?\n/g, ' ');
    } catch {
      return '';
    }
  }
  return String(ev);
}

/**
 * Build a readable ASCII table for must_render_verbatim.
 * Columns: pattern_hash (truncated), sample_count, original_bytes,
 *          encoded_bytes, ratio_x, confidence.
 */
function buildTable(patterns: PatternCompactionResult[]): string {
  if (patterns.length === 0) {
    return '(no patterns measured)';
  }
  const header =
    'pattern_hash        | samples | orig_bytes | enc_bytes | ratio_x | confidence';
  const sep =
    '--------------------|---------|------------|-----------|---------|----------';
  const rows = patterns.map((p) => {
    const hash = p.pattern_hash.slice(0, 18).padEnd(18);
    const samples = String(p.sample_count).padStart(7);
    const orig = String(p.total_original_bytes).padStart(10);
    const enc = String(p.total_encoded_bytes).padStart(9);
    const ratio = p.compaction_ratio_x.toFixed(1).padStart(7);
    const conf = p.confidence.padEnd(10);
    return `${hash} | ${samples} | ${orig} | ${enc} | ${ratio} | ${conf}`;
  });
  return [header, sep, ...rows].join('\n');
}

// ── Tool implementation ──

export async function executeMeasureCompaction(
  args: MeasureCompactionArgs,
  _env: EnvConfig,
): Promise<StructuredOutput> {
  const sampleSize = args.sample_size ?? 500;
  const timeRange = args.timeRange ?? '24h';

  // 1. Resolve SIEM.
  const sel = await resolveSiemSelection({});
  if (sel.kind === 'ambiguous') {
    throw new Error(
      formatAmbiguousError(sel.candidates, 'vendor') +
        '\n\nPass the SIEM id explicitly via an environment override if needed.'
    );
  }
  if (sel.kind === 'none') {
    throw new Error(
      formatNoneError(sel.probedIds, 'Run log10x_doctor for per-SIEM credential setup detail.')
    );
  }

  // 2. Pull events from SIEM scoped to the service.
  // Build a vendor-appropriate service query. We use a simple service-filter
  // pattern consistent with what poc-from-siem uses.
  let serviceQuery: string;
  switch (sel.id) {
    case 'datadog':
      serviceQuery = `service:${args.service}`;
      break;
    case 'splunk':
      serviceQuery = `sourcetype="${args.service}"`;
      break;
    case 'cloudwatch':
      // CloudWatch uses logStreamName prefix; service is best-effort.
      serviceQuery = args.service;
      break;
    case 'elasticsearch':
      serviceQuery = `service.name:${args.service} OR kubernetes.labels.app:${args.service}`;
      break;
    case 'azure-monitor':
      serviceQuery = `AppRoleName == "${args.service}"`;
      break;
    case 'gcp-logging':
      serviceQuery = `resource.labels.service_name="${args.service}"`;
      break;
    case 'sumo':
      serviceQuery = `_sourceCategory=${args.service}`;
      break;
    case 'clickhouse':
      serviceQuery = `service = '${args.service}'`;
      break;
    default:
      serviceQuery = args.service;
  }

  const conn = getConnector(sel.id);
  const pullStart = Date.now();
  let pullResult: { events: unknown[] };
  try {
    pullResult = await conn.pullEvents({
      window: timeRange,
      query: serviceQuery,
      targetEventCount: sampleSize,
      maxPullMinutes: 2,
      buckets: 1,
      onProgress: () => {},
    });
  } catch (e) {
    throw new Error(
      `SIEM pull failed for service="${args.service}" on ${sel.displayName}: ${(e as Error).message}`
    );
  }
  const siemPullMs = Date.now() - pullStart;

  const rawEvents = pullResult.events;
  if (rawEvents.length === 0) {
    return buildEnvelope({
      tool: 'log10x_measure_compaction',
      view: 'summary',
      summary: {
        headline: `No events found for service "${args.service}" in ${sel.displayName} over ${timeRange}.`,
        bullets: [
          'Try a wider timeRange (e.g., "7d")',
          'Verify the service name matches your SIEM labels',
          'Check that the service is actively emitting logs',
        ],
      },
      data: {
        service: args.service,
        sample_size_requested: sampleSize,
        sample_size_actual: 0,
        timeRange,
        patterns: [],
        siem_pull_ms: siemPullMs,
        engine_ms: 0,
        must_render_verbatim: '(no events found)',
      } as MeasureCompactionData,
      actions: [],
    });
  }

  // 3. Coerce events to raw log lines.
  const lines = rawEvents
    .map(coerceEventToLine)
    .filter((l) => l.trim().length > 0);

  // 4. Run tenx engine on the events.
  let engineResult: Awaited<ReturnType<typeof runMcpAppOnEvents>>;
  try {
    engineResult = await runMcpAppOnEvents(lines);
  } catch (e) {
    if (e instanceof DevCliNotInstalledError) {
      throw new Error(
        'log10x_measure_compaction requires the tenx CLI. ' + (e as Error).message
      );
    }
    throw e;
  }

  const { templates, encodedLines, wallTimeMs: engineMs } = engineResult;

  // 5. Group encoded events by patternHash (tenxHash > templateHash fallback).
  const byPatternHash = new Map<
    string,
    {
      symbolMessage?: string;
      templateHash: string;
      totalOriginalBytes: number;
      totalEncodedBytes: number;
      count: number;
    }
  >();

  for (const ev of encodedLines) {
    // Use the engine-emitted tenxHash as the stable pattern identity.
    // Fall back to templateHash for older engine builds that don't emit
    // the patternHash= anchor.
    const patternHash = ev.tenxHash ?? ev.templateHash;
    if (!patternHash) continue;

    const tpl = templates.get(ev.templateHash);
    const templateBody = tpl?.template ?? '';

    // Measure original bytes by expanding the template.
    let originalBytes = 0;
    if (templateBody) {
      originalBytes = expandedByteLength(templateBody, ev.values);
    }

    // Measure encoded bytes (wire bytes for this event).
    const encodedBytes = ev.lineBytes ?? 0;

    const rec = byPatternHash.get(patternHash) ?? {
      symbolMessage: ev.symbolMessage,
      templateHash: ev.templateHash,
      totalOriginalBytes: 0,
      totalEncodedBytes: 0,
      count: 0,
    };
    if (!rec.symbolMessage && ev.symbolMessage) rec.symbolMessage = ev.symbolMessage;
    rec.totalOriginalBytes += originalBytes;
    rec.totalEncodedBytes += encodedBytes;
    rec.count += 1;
    byPatternHash.set(patternHash, rec);
  }

  // 6. Build per-pattern result records.
  const patterns: PatternCompactionResult[] = [];
  for (const [patternHash, rec] of byPatternHash) {
    const ratio =
      rec.totalEncodedBytes > 0
        ? rec.totalOriginalBytes / rec.totalEncodedBytes
        : 0;
    patterns.push({
      pattern_hash: patternHash,
      symbol_message: rec.symbolMessage,
      sample_count: rec.count,
      total_original_bytes: rec.totalOriginalBytes,
      total_encoded_bytes: rec.totalEncodedBytes,
      compaction_ratio_x: Math.round(ratio * 10) / 10,
      confidence: confidenceTier(rec.count),
    });
  }

  // Sort by total_original_bytes descending (highest-volume patterns first).
  patterns.sort((a, b) => b.total_original_bytes - a.total_original_bytes);

  const table = buildTable(patterns);
  const avgRatio =
    patterns.length > 0
      ? Math.round(
          (patterns.reduce((s, p) => s + p.compaction_ratio_x * p.total_original_bytes, 0) /
            Math.max(1, patterns.reduce((s, p) => s + p.total_original_bytes, 0))) *
            10
        ) / 10
      : 0;

  const data: MeasureCompactionData = {
    service: args.service,
    sample_size_requested: sampleSize,
    sample_size_actual: rawEvents.length,
    timeRange,
    patterns,
    siem_pull_ms: siemPullMs,
    engine_ms: engineMs,
    must_render_verbatim: table,
  };

  const lowConfidenceCount = patterns.filter((p) => p.confidence === 'low').length;
  const warnings: string[] = [];
  if (lowConfidenceCount > 0) {
    warnings.push(
      `${lowConfidenceCount} pattern(s) have low confidence (< 10 events). Pull a larger sample_size to improve accuracy.`
    );
  }

  return buildEnvelope({
    tool: 'log10x_measure_compaction',
    view: 'summary',
    summary: {
      headline:
        `Measured compaction for ${patterns.length} pattern(s) in service "${args.service}" ` +
        `from ${rawEvents.length} SIEM events. ` +
        `Volume-weighted average ratio: ${avgRatio}x (${(100 / Math.max(avgRatio, 0.001)).toFixed(1)}% of original size on wire).`,
      bullets: [
        `SIEM: ${sel.displayName}, window: ${timeRange}`,
        `Patterns measured: ${patterns.length} (${patterns.filter((p) => p.confidence === 'high').length} high confidence)`,
        `Encoded bytes / original bytes: see must_render_verbatim table`,
      ],
    },
    data,
    warnings,
    actions: [
      {
        tool: 'log10x_estimate_savings',
        args: { service: args.service },
        reason:
          'Use measured compaction ratios to refine savings estimates for this service.',
        role: 'recommended-next',
      },
      {
        tool: 'log10x_pattern_detail',
        args: {},
        reason: 'Drill into a specific high-ratio pattern for action options.',
        role: 'optional-followup',
      },
    ],
  });
}
