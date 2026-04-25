/**
 * Time-bucketed aggregation for log10x_backfill_metric.
 *
 * Takes a list of events (from the Retriever) and produces a time-series
 * of `(timestamp, labels, value)` points suitable for emission to a TSDB.
 *
 * Aggregation types:
 *   count             — number of events in the bucket
 *   sum_bytes         — total byte size of events in the bucket
 *   unique_values     — cardinality of a named dimension in the bucket
 *   rate_per_second   — events per second (count / bucket_seconds)
 *
 * Grouping dimensions come from the Retriever event's `enrichedFields`
 * (severity, service, tenant_id, http_code, ...). If the caller passes a
 * group_by that is not present on any event, the aggregator treats the
 * dimension as an empty string so the caller still gets a single series
 * rather than a silent drop.
 */

import type { RetrieverEvent } from './retriever-api.js';

export type AggregationType = 'count' | 'sum_bytes' | 'unique_values' | 'rate_per_second';

export interface AggregatorOptions {
  bucketSize: string; // "5m", "1h", "1d"
  aggregation: AggregationType;
  /** Fields to group on — each combination becomes its own time series. */
  groupBy?: string[];
  /** For unique_values aggregation: the field whose cardinality is counted per bucket. */
  uniqueField?: string;
}

export interface MetricPoint {
  /** UNIX seconds since epoch. */
  timestamp: number;
  /** Labels identifying the time series. */
  labels: Record<string, string>;
  value: number;
}

export interface AggregatedSeries {
  points: MetricPoint[];
  seriesCount: number;
  bucketSeconds: number;
  eventCount: number;
}

export function aggregate(
  events: RetrieverEvent[],
  options: AggregatorOptions
): AggregatedSeries {
  const bucketSeconds = parseBucketSize(options.bucketSize);
  // Map key: `${bucketStart}\0${groupBy joined}` → aggregator state
  const state = new Map<string, AggregatorState>();

  for (const ev of events) {
    if (ev.timestamp == null) continue;
    const ts = Math.floor(new Date(ev.timestamp).getTime() / 1000);
    if (isNaN(ts) || ts === 0) continue;
    const bucket = Math.floor(ts / bucketSeconds) * bucketSeconds;

    const labels = selectLabels(ev, options.groupBy);
    const key = `${bucket}\0${stableStringify(labels)}`;
    let slot = state.get(key);
    if (!slot) {
      slot = { bucket, labels, count: 0, bytes: 0, unique: new Set<string>() };
      state.set(key, slot);
    }
    slot.count += 1;
    slot.bytes += Buffer.byteLength(ev.text || '', 'utf8');
    if (options.uniqueField) {
      const v = ev.enrichedFields?.[options.uniqueField];
      if (v !== undefined) slot.unique.add(v);
    }
  }

  const points: MetricPoint[] = [];
  for (const s of state.values()) {
    let value: number;
    switch (options.aggregation) {
      case 'count':
        value = s.count;
        break;
      case 'sum_bytes':
        value = s.bytes;
        break;
      case 'unique_values':
        value = s.unique.size;
        break;
      case 'rate_per_second':
        value = s.count / bucketSeconds;
        break;
    }
    points.push({ timestamp: s.bucket, labels: s.labels, value });
  }

  // Sort by timestamp ascending, then by label stable order
  points.sort((a, b) => a.timestamp - b.timestamp || stableStringify(a.labels).localeCompare(stableStringify(b.labels)));

  const seriesCount = new Set(points.map((p) => stableStringify(p.labels))).size;

  return {
    points,
    seriesCount,
    bucketSeconds,
    eventCount: events.length,
  };
}

// ── internals ──

interface AggregatorState {
  bucket: number;
  labels: Record<string, string>;
  count: number;
  bytes: number;
  unique: Set<string>;
}

function selectLabels(ev: RetrieverEvent, groupBy?: string[]): Record<string, string> {
  if (!groupBy || groupBy.length === 0) return {};
  const out: Record<string, string> = {};
  for (const g of groupBy) {
    if (g === 'service' && ev.service) {
      out.service = ev.service;
    } else if (g === 'severity' && ev.severity) {
      out.severity = ev.severity;
    } else if (ev.enrichedFields && ev.enrichedFields[g] !== undefined) {
      out[g] = ev.enrichedFields[g];
    } else {
      out[g] = '';
    }
  }
  return out;
}

function stableStringify(obj: Record<string, string>): string {
  const keys = Object.keys(obj).sort();
  return keys.map((k) => `${k}=${obj[k]}`).join('|');
}

/** Parse `5m` / `1h` / `1d` into seconds. */
export function parseBucketSize(s: string): number {
  const m = s.match(/^(\d+)([smhd])$/);
  if (!m) throw new Error(`Invalid bucket_size: "${s}". Use 5m, 1h, 1d, etc.`);
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
    default:
      throw new Error(`Unknown bucket unit: ${m[2]}`);
  }
}
