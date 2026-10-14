/**
 * Local-file POC source — the analyze-file flow.
 *
 * Reads a log file (typically a fluentd/k8s/docker-wrapped JSONL dump,
 * e.g. a CloudWatch export) and normalizes it for pattern extraction.
 *
 * The normalization is the measured requirement from the engine
 * handoff §20: wrapped JSON must be pre-extracted before templating —
 * fed raw, the templater tokenizes the wrapper (mangled names, no
 * welds); pre-extracted, patterns come out clean and welds hold.
 *
 * Mechanism: when the file sniffs as wrapped JSONL, each line is
 * parsed and handed to `extractPatterns` as an OBJECT. The existing
 * `coerceToLine` descent unwraps the `log`/`message` payload for the
 * templater, and `extractEnrichmentFromEnvelope` keeps the container
 * attribution (kubernetes.container_name / pod labels) that the
 * container-keyed change rows need — the MCP-native equivalent of the
 * engine-side `<container_id>\t<log>` + sourcePattern contract.
 *
 * Byte accounting: `totalBytes` counts the UNWRAPPED payload bytes
 * (what the templater analyses); `rawBytes` keeps the on-disk wrapped
 * size (what a vendor would bill on) and travels to
 * RenderInput.rawIngestBytes.
 */

import { promises as fs } from 'fs';
import { readStridedFileLines } from './local-source.js';
import { envelopeTimestampMs } from './pattern-extraction.js';
import { compactRecordBytes, jsonStringBodyBytes } from './receiver-bytes.js';

import type { LocalSourceResult } from './local-source.js';

/** Lines sniffed to decide wrapped vs plain. */
const SNIFF_LINES = 50;
/** Fraction of sniffed lines that must parse as wrapped JSON. */
const SNIFF_THRESHOLD = 0.8;
/** Hard input cap — refuse above rather than OOM. */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
/**
 * Above this size, the single file is SAMPLED strided across its length rather
 * than fed whole to the engine. Feeding a 70MB file whole timed out the engine
 * (120s cap in dev-cli), and a contiguous read under-covers a time-ordered
 * file's pattern space (F8/F15). 24MB processes in well under the engine
 * timeout and, sampled strided, spans the whole file.
 */
export const SINGLE_FILE_SAMPLE_BYTES = 24 * 1024 * 1024;
/** Line ceiling for the sampled single-file read. */
const SINGLE_FILE_SAMPLE_LINES = 12_000;

export interface FileSourceResult extends LocalSourceResult {
  /** What extractPatterns should consume: objects when wrapped
   * (envelope-aware path), raw strings otherwise. */
  records: unknown[];
  /** On-disk bytes (wrapped size) — the billable figure. */
  rawBytes: number;
  /** On-disk bytes of the sampled lines, newlines included; equals `rawBytes` when the file was read whole. */
  sampledRawBytes: number;
  /** On-disk bytes of each sampled line, aligned with `records`, newline included. */
  lineRawBytes: number[];
  /** True when the wrapped-JSON normalization path was taken. */
  normalized: boolean;
}

interface WrappedRecord {
  obj: Record<string, unknown>;
  payloadBytes: number;
  container: string;
}

function isWrappedLine(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  try {
    const obj = JSON.parse(t) as unknown;
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const rec = obj as Record<string, unknown>;
    const payload = rec.log ?? rec.message;
    if (typeof payload !== 'string') return null;
    return rec;
  } catch {
    return null;
  }
}

function containerOf(rec: Record<string, unknown>): string {
  const kube = rec.kubernetes as Record<string, unknown> | undefined;
  if (kube && typeof kube === 'object') {
    const c = kube.container_name;
    const pod = kube.pod_name;
    if (typeof c === 'string' && c.length > 0) return c;
    if (typeof pod === 'string' && pod.length > 0) return pod;
  }
  if (typeof rec.container_name === 'string') return rec.container_name;
  if (typeof rec.container_id === 'string') return (rec.container_id as string).slice(0, 12);
  return '(no container attribution)';
}

function payloadOf(rec: Record<string, unknown>): string {
  const p = rec.log ?? rec.message;
  return typeof p === 'string' ? p : '';
}

/**
 * The forwarder's record a captured line stands for, when the line is one: a
 * JSON object whose payload is a string `log` or `message`. A CloudWatch
 * export wraps the forwarder's JSON record in `message`; that inner record is
 * the one the Receiver received.
 */
function forwarderRecord(rec: unknown): { record: Record<string, unknown>; payload: string } | undefined {
  let obj: unknown = rec;
  if (typeof obj === 'string') {
    const t = obj.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) return undefined;
    try {
      obj = JSON.parse(t);
    } catch {
      return undefined;
    }
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const o = obj as Record<string, unknown>;
  if (typeof o.message === 'string' && typeof o.log !== 'string') {
    const m = o.message.trim();
    if (m.startsWith('{') && m.endsWith('}')) {
      try {
        const inner = JSON.parse(m) as unknown;
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
          const i = inner as Record<string, unknown>;
          if (typeof i.log === 'string' && (i.kubernetes || i.stream || i.docker)) return { record: i, payload: i.log };
        }
      } catch {
        // not JSON: the outer record is the one
      }
    }
  }
  const payload = o.log ?? o.message;
  return typeof payload === 'string' ? { record: o, payload } : undefined;
}

/**
 * What `extractPatterns` needs to count each event in the Receiver's unit:
 * the forwarder's record bytes where a line carries one, and every line's
 * time. Lines without a record are counted as payload plus the assumed
 * metadata (see receiver-bytes.ts).
 */
export function receiverExtractionInputs(records: unknown[]): {
  lineRecordBytes: Array<number | undefined>;
  linePayloadJsonBytes: Array<number | undefined>;
  lineTimesMs: Array<number | undefined>;
} {
  // A record with no time of its own takes the previous record's, in the
  // capture's arrival order, before any reordering.
  const lineTimesMs: Array<number | undefined> = [];
  let last: number | undefined;
  for (const r of records) {
    const t = recordTimestampMs(r);
    if (t !== undefined) last = t;
    lineTimesMs.push(t ?? last);
  }
  return { ...receiverRecordBytes(records), lineTimesMs };
}

/**
 * The order to hand a capture's records to the templater: grouped by
 * container, file order kept within each. A capture interleaves containers,
 * and the templater joins a continuation line to the line before it, which
 * in file order can be another container's; the Receiver joins only within
 * a container's stream.
 */
export function containerOrder(records: unknown[]): number[] {
  const keyOf = (r: unknown): string => {
    const f = forwarderRecord(r);
    return f ? containerOf(f.record) : '';
  };
  const firstSeen = new Map<string, number>();
  const keys = records.map((r, i) => {
    const k = keyOf(r);
    if (!firstSeen.has(k)) firstSeen.set(k, i);
    return k;
  });
  return records
    .map((_, i) => i)
    .sort((a, b) => firstSeen.get(keys[a])! - firstSeen.get(keys[b])! || a - b);
}

/** Each record's compact bytes and its payload's JSON bytes, where the record is a forwarder's. */
export function receiverRecordBytes(records: unknown[]): {
  lineRecordBytes: Array<number | undefined>;
  linePayloadJsonBytes: Array<number | undefined>;
} {
  const lineRecordBytes: Array<number | undefined> = [];
  const linePayloadJsonBytes: Array<number | undefined> = [];
  for (const r of records) {
    const f = forwarderRecord(r);
    lineRecordBytes.push(f ? compactRecordBytes(f.record) : undefined);
    linePayloadJsonBytes.push(f ? jsonStringBodyBytes(f.payload) : undefined);
  }
  return { lineRecordBytes, linePayloadJsonBytes };
}

export async function sampleFromFile(path: string): Promise<FileSourceResult> {
  const notes: string[] = [];
  const stat = await fs.stat(path);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `file is ${stat.size} bytes; the cap is ${MAX_FILE_BYTES}. Split the file and analyse a slice.`,
    );
  }
  const start = Date.now();
  // Large files are sampled strided across their length rather than read whole:
  // the engine has a bounded per-run timeout, and a contiguous read of a
  // time-ordered log under-covers its pattern space (F8/F15).
  let lines: string[];
  let sampledLargeFile = false;
  if (stat.size > SINGLE_FILE_SAMPLE_BYTES) {
    lines = await readStridedFileLines(path, SINGLE_FILE_SAMPLE_LINES, SINGLE_FILE_SAMPLE_BYTES);
    sampledLargeFile = true;
  } else {
    const text = await fs.readFile(path, 'utf8');
    lines = text.split('\n').filter((l) => l.trim().length > 0);
  }
  if (sampledLargeFile) {
    notes.push(
      `file is ${(stat.size / 1024 / 1024).toFixed(0)} MB; sampled ${lines.length.toLocaleString()} lines ` +
        `across ${8} windows spanning the whole file (not read whole). The reduction estimate assumes these ` +
        `windows are representative of the file's pattern mix — if it has phases with very different logging, ` +
        `split it and analyse each phase.`,
    );
  }
  const lineRawBytes = lines.map((l) => Buffer.byteLength(l, 'utf8') + 1);
  const sampledRawBytes = sampledLargeFile ? lineRawBytes.reduce((s, b) => s + b, 0) : stat.size;
  if (lines.length === 0) {
    notes.push(`file ${path} contains no non-empty lines.`);
    return {
      events: [],
      records: [],
      totalBytes: 0,
      rawBytes: stat.size,
      sampledRawBytes,
      lineRawBytes,
      normalized: false,
      composition: [],
      failedSources: [],
      wallTimeMs: Date.now() - start,
      notes,
    };
  }

  // Sniff.
  const sniff = lines.slice(0, SNIFF_LINES);
  const wrappedCount = sniff.filter((l) => isWrappedLine(l) !== null).length;
  const wrapped = wrappedCount / sniff.length >= SNIFF_THRESHOLD;

  if (!wrapped) {
    const totalBytes = lines.reduce((s, l) => s + Buffer.byteLength(l, 'utf8'), 0);
    notes.push('file read as plain log lines (no JSON wrapper detected).');
    return {
      events: lines,
      records: lines,
      totalBytes,
      rawBytes: stat.size,
      sampledRawBytes,
      lineRawBytes,
      normalized: false,
      composition: [{ source: path, bytes: totalBytes, lines: lines.length, pct: 100 }],
      failedSources: [],
      wallTimeMs: Date.now() - start,
      notes,
    };
  }

  // Wrapped: normalize. Unparseable lines fall through as raw strings
  // (counted, noted — never silently dropped).
  const records: unknown[] = [];
  const events: string[] = [];
  const compositionMap = new Map<string, { bytes: number; lines: number }>();
  let totalBytes = 0;
  let unparseable = 0;
  for (const line of lines) {
    const rec = isWrappedLine(line);
    if (rec === null) {
      unparseable += 1;
      records.push(line);
      events.push(line);
      const b = Buffer.byteLength(line, 'utf8');
      totalBytes += b;
      const e = compositionMap.get('(unwrapped lines)') ?? { bytes: 0, lines: 0 };
      e.bytes += b;
      e.lines += 1;
      compositionMap.set('(unwrapped lines)', e);
      continue;
    }
    const payload = payloadOf(rec);
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    const container = containerOf(rec);
    records.push(rec);
    events.push(payload);
    totalBytes += payloadBytes;
    const e = compositionMap.get(container) ?? { bytes: 0, lines: 0 };
    e.bytes += payloadBytes;
    e.lines += 1;
    compositionMap.set(container, e);
  }
  notes.push(
    `wrapped-JSON normalization applied: ${lines.length - unparseable} of ${lines.length} lines decoded; ` +
      `analysed bytes count the unwrapped payload, raw file size is ${stat.size} bytes.`,
  );
  if (unparseable > 0) {
    notes.push(`${unparseable} line(s) did not parse as wrapped JSON and were analysed as-is.`);
  }
  const composition = Array.from(compositionMap.entries())
    .map(([source, v]) => ({
      source,
      bytes: v.bytes,
      lines: v.lines,
      pct: totalBytes > 0 ? (v.bytes / totalBytes) * 100 : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);
  return {
    events,
    records,
    totalBytes,
    rawBytes: stat.size,
    sampledRawBytes,
    lineRawBytes,
    normalized: true,
    composition,
    failedSources: [],
    wallTimeMs: Date.now() - start,
    notes,
  };
}

/** The time span a file sample covers, and what it was read from. */
export interface FileSpan {
  seconds: number;
  source: 'timestamps' | 'window';
  /** First and last record timestamps, when the span came from them. */
  firstIso?: string;
  lastIso?: string;
  recordsWithTimestamp: number;
  records: number;
  /** The caller's `window`, when one was passed. */
  window?: string;
}

/** A file run with no way to know the span its bytes cover. */
export class FileSpanRefusal extends Error {}

const TIMESTAMP_FIELDS = '`timestamp`, `@timestamp`, `_time`, `TimeGenerated`, `_messagetime` or `time`';

// An ISO-8601 time at the start of a plain line, optionally bracketed. A time
// with no zone is read as UTC: only differences between lines are used.
const LINE_TIMESTAMP =
  /^\s*\[?(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?/;

function lineTimestampMs(line: string): number | undefined {
  // Coloured output (Rust tracing, for one) wraps the time in ANSI escapes.
  const m = LINE_TIMESTAMP.exec(line.includes('\x1b[') ? line.replace(/\x1b\[[0-9;]*m/g, '') : line);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const ms = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0;
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  if (zone && zone !== 'Z') {
    const z = zone.replace(':', '');
    const offsetMin = (z[0] === '-' ? -1 : 1) * (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5)));
    t -= offsetMin * 60_000;
  }
  return Number.isFinite(t) ? t : undefined;
}

/**
 * A JSON record's own event time: an envelope field; else, for a docker or
 * CRI wrapper, its top-level `time`, or the ISO-8601 time that leads the
 * wrapped `log` or `message` payload.
 */
function objectTimestampMs(obj: Record<string, unknown>): number | undefined {
  const env = envelopeTimestampMs(obj);
  if (env !== undefined) return env;
  const time = obj.time;
  if (typeof time === 'string') {
    const t = Date.parse(time);
    if (Number.isFinite(t)) return t;
  }
  for (const key of ['log', 'message', 'msg']) {
    const payload = obj[key];
    if (typeof payload !== 'string') continue;
    const t = lineTimestampMs(payload) ?? jsonPayloadTimestampMs(payload);
    if (t !== undefined) return t;
  }
  return undefined;
}

/** A JSON log line's own time field (pino `time` in epoch ms, `timestamp`, `ts`), epoch or ISO. */
function jsonPayloadTimestampMs(payload: string): number | undefined {
  const t = payload.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    return undefined;
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  for (const key of ['time', 'timestamp', 'ts', '@timestamp']) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (v > 1e12) return v;
      if (v > 1e9) return v * 1000;
    }
    if (typeof v === 'string') {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return undefined;
}

/** A record's own event time: an envelope or wrapper field for a JSON record, a leading ISO-8601 time for a plain line. */
export function recordTimestampMs(rec: unknown): number | undefined {
  if (rec !== null && typeof rec === 'object' && !Array.isArray(rec)) {
    return objectTimestampMs(rec as Record<string, unknown>);
  }
  if (typeof rec !== 'string') return undefined;
  const t = rec.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      const obj = JSON.parse(t) as unknown;
      if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
        return objectTimestampMs(obj as Record<string, unknown>);
      }
    } catch {
      // not JSON: read it as a plain line
    }
  }
  return lineTimestampMs(rec);
}

function windowSeconds(window: string): number | undefined {
  const m = window.trim().match(/^(\d+)([smhd])$/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  const unit = { s: 1, m: 60, h: 3600, d: 86_400 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd'];
  return n > 0 ? n * unit : undefined;
}

/**
 * The span a file sample covers: first to last record timestamp; else the
 * caller's `window`; else a refusal. A plan's per-window caps divide bytes by
 * this span, so it is never assumed.
 */
export function resolveFileSpan(records: unknown[], window: string | undefined): FileSpan {
  let first: number | undefined;
  let last: number | undefined;
  let stamped = 0;
  for (const r of records) {
    const t = recordTimestampMs(r);
    if (t === undefined) continue;
    stamped += 1;
    if (first === undefined || t < first) first = t;
    if (last === undefined || t > last) last = t;
  }
  const base = { recordsWithTimestamp: stamped, records: records.length, ...(window !== undefined ? { window } : {}) };
  if (first !== undefined && last !== undefined && last > first) {
    return {
      ...base,
      seconds: (last - first) / 1000,
      source: 'timestamps',
      firstIso: new Date(first).toISOString(),
      lastIso: new Date(last).toISOString(),
    };
  }
  const why =
    stamped === 0
      ? `none of the ${records.length.toLocaleString()} sampled records carries a timestamp (a ${TIMESTAMP_FIELDS} field, or an ISO-8601 time at the start of the line or of the wrapped \`log\` payload)`
      : `the ${stamped.toLocaleString()} timestamped records all carry the same time`;
  if (window !== undefined) {
    const secs = windowSeconds(window);
    if (secs === undefined) {
      throw new FileSpanRefusal(
        `No time span for these files: ${why}, and \`window: "${window}"\` is not a duration. ` +
          'Pass `window` as the span the files cover, for example `window: "10h"`, and re-run.',
      );
    }
    return { ...base, seconds: secs, source: 'window' };
  }
  throw new FileSpanRefusal(
    `No time span for these files: ${why}. A plan's caps are bytes per unit of time, so the span is required. ` +
      'Pass `window` with the span the files cover, for example `window: "10h"` for ten hours of logs, and re-run.',
  );
}

function fmtSpanDuration(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.round((seconds / 3600) * 10) / 10;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  if (seconds >= 60) {
    const m = Math.round((seconds / 60) * 10) / 10;
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const s = Math.round(seconds * 1000) / 1000;
  return `${s} second${s === 1 ? '' : 's'}`;
}

/**
 * One sentence naming the span and where it came from. `sampleShare` is the
 * sampled share of the files' bytes, when less than all of them was read.
 */
export function describeFileSpan(span: FileSpan, sampleShare?: number): string {
  const amount = `${fmtSpanDuration(span.seconds)} (${Math.round(span.seconds).toLocaleString()} s)`;
  const parts: string[] = [];
  if (span.source === 'timestamps') {
    parts.push(
      `Span: ${amount}, from the first to the last record timestamp (${span.firstIso} to ${span.lastIso}; ` +
        `${span.recordsWithTimestamp.toLocaleString()} of ${span.records.toLocaleString()} sampled records carry one).`,
    );
    if (span.window !== undefined) parts.push(`The \`window\` argument (${span.window}) was not used.`);
  } else {
    parts.push(
      `Span: ${amount}, from the \`window\` argument: ` +
        (span.recordsWithTimestamp === 0
          ? 'the sampled records carry no timestamp.'
          : 'the timestamped records all carry the same time.'),
    );
  }
  if (sampleShare !== undefined && sampleShare < 1) {
    parts.push(
      `The sample holds ${Math.max(1, Math.round(sampleShare * 100))}% of the files' bytes, drawn from start to end of each file; ` +
        'byte figures are scaled to the whole files.',
    );
  }
  return parts.join(' ');
}

/** Exported for tests. */
export const _internals = { isWrappedLine, containerOf, payloadOf, lineTimestampMs };
