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
  if (lines.length === 0) {
    notes.push(`file ${path} contains no non-empty lines.`);
    return {
      events: [],
      records: [],
      totalBytes: 0,
      rawBytes: stat.size,
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
    normalized: true,
    composition,
    failedSources: [],
    wallTimeMs: Date.now() - start,
    notes,
  };
}

/** Exported for tests. */
export const _internals = { isWrappedLine, containerOf, payloadOf };
