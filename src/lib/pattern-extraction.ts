/**
 * Shared pattern-extraction lib — templatize a batch of events.
 *
 * Used by log10x_resolve_batch and log10x_poc_from_siem. Both tools feed
 * raw log lines through this and get back a structured list of per-pattern
 * records with aggregated counts, bytes, severity, service, and sample
 * event bodies.
 *
 * Honors `privacyMode`:
 *   - false (default): route through the paste Lambda (events leave the box)
 *   - true: shell out to a locally-installed `tenx` binary (events stay local)
 *
 * Under the hood this uses the existing paste-api + dev-cli + cli-output-parser
 * machinery so the templater contract stays single-source.
 */

import { submitPaste, PASTE_MAX_BYTES } from './paste-api.js';
import { runDevCli, DevCliNotInstalledError } from './dev-cli.js';
import {
  parseTemplates,
  parseEncoded,
  parseAggregated,
  type Template,
  type EncodedEvent,
  type AggregatedRow,
} from './cli-output-parser.js';

export interface ExtractedPattern {
  /** Stable template hash — key for round-trip identity. */
  hash: string;
  /** Template body with `$` marking variable slots. */
  template: string;
  /** Dominant service label, when resolvable from sample events. */
  service?: string;
  /** Dominant severity (uppercase standard form). */
  severity?: string;
  /** Number of events in this batch matching the pattern. */
  count: number;
  /** Total bytes across all matching events. */
  bytes: number;
  /** One representative raw event (from the first encoded match). */
  sampleEvent: string;
  /** Per-slot captured values (slot name or positional index → distinct values observed). */
  variables: Record<string, string[]>;
}

export interface ExtractedPatterns {
  patterns: ExtractedPattern[];
  totalEvents: number;
  totalBytes: number;
  /** Number of raw input lines the caller passed in. */
  inputLineCount: number;
  /** Wall time spent in the templater (network + CLI). */
  templaterWallTimeMs: number;
  /** `paste_lambda` or `local_cli`. */
  executionMode: 'paste_lambda' | 'local_cli';
}

export interface ExtractPatternsOptions {
  /** Route through the local `tenx` CLI instead of the paste Lambda. */
  privacyMode?: boolean;
  /**
   * When true, automatically batch the input through multiple paste-Lambda
   * calls if it exceeds PASTE_MAX_BYTES. Merges results by templateHash.
   * Default false to preserve existing `resolve_batch` semantics.
   */
  autoBatch?: boolean;
}

/**
 * Templatize a batch of events and return structured pattern records.
 *
 * `events` may contain raw strings, objects with a `text`/`message`/`log`
 * field, or JSON lines. Everything gets stringified into newline-separated
 * raw text before submission.
 */
export async function extractPatterns(
  events: unknown[],
  opts: ExtractPatternsOptions = {}
): Promise<ExtractedPatterns> {
  if (opts.privacyMode) {
    // Fail fast if tenx isn't installed — don't silently degrade.
    // The DevCliNotInstalledError shape has a user-actionable install hint.
  }
  const lines = events
    .map((e) => coerceToLine(e))
    .filter((l) => l && l.trim().length > 0);

  if (lines.length === 0) {
    return {
      patterns: [],
      totalEvents: 0,
      totalBytes: 0,
      inputLineCount: 0,
      templaterWallTimeMs: 0,
      executionMode: opts.privacyMode ? 'local_cli' : 'paste_lambda',
    };
  }

  const mergedTemplates = new Map<string, Template>();
  const mergedEncoded: EncodedEvent[] = [];
  const mergedAggregated: AggregatedRow[] = [];
  let totalWallTimeMs = 0;
  let executionMode: 'paste_lambda' | 'local_cli' = opts.privacyMode ? 'local_cli' : 'paste_lambda';

  if (opts.privacyMode) {
    // Local CLI can absorb the full batch in one shot.
    const text = lines.join('\n');
    try {
      const local = await runDevCli(text);
      for (const [hash, tpl] of parseTemplates(local.templatesJson)) {
        mergedTemplates.set(hash, tpl);
      }
      mergedEncoded.push(...parseEncoded(local.encodedLog));
      mergedAggregated.push(...parseAggregated(local.aggregatedCsv));
      totalWallTimeMs += local.wallTimeMs;
    } catch (e) {
      if (e instanceof DevCliNotInstalledError) throw e;
      throw new Error(`Local tenx CLI run failed: ${(e as Error).message}`);
    }
  } else {
    // Paste Lambda has a 100 KB body limit. Split by lines into chunks.
    const chunks = opts.autoBatch ? chunkByBytes(lines, PASTE_MAX_BYTES) : [lines.join('\n')];
    for (const chunk of chunks) {
      const size = Buffer.byteLength(chunk, 'utf8');
      if (size > PASTE_MAX_BYTES) {
        // Only possible when autoBatch=false and the caller passed an oversize batch.
        throw new Error(
          `Batch too large: ${(size / 1024).toFixed(1)} KB exceeds the 100 KB paste Lambda limit. ` +
            `Set autoBatch=true (the tool layer does this automatically) or privacy_mode=true to ` +
            `route through a locally-installed tenx CLI.`
        );
      }
      const started = Date.now();
      const resp = await submitPaste(chunk);
      totalWallTimeMs += Date.now() - started;
      for (const [hash, tpl] of parseTemplates(resp['templates.json'])) {
        if (!mergedTemplates.has(hash)) mergedTemplates.set(hash, tpl);
      }
      mergedEncoded.push(...parseEncoded(resp['encoded.log']));
      mergedAggregated.push(...parseAggregated(resp['aggregated.csv']));
    }
  }

  // Build the pattern records.
  const byHash = new Map<string, {
    count: number;
    bytes: number;
    sampleEvent: string;
    variables: Map<string, Set<string>>;
    lineIndices: number[];
  }>();

  for (let i = 0; i < mergedEncoded.length; i++) {
    const ev = mergedEncoded[i];
    const rec = byHash.get(ev.templateHash) || {
      count: 0,
      bytes: 0,
      sampleEvent: '',
      variables: new Map<string, Set<string>>(),
      lineIndices: [],
    };
    rec.count += 1;
    // Best-effort: attribute the raw-line bytes to this pattern by index into `lines`.
    const raw = i < lines.length ? lines[i] : undefined;
    if (raw) {
      rec.bytes += Buffer.byteLength(raw, 'utf8');
      if (!rec.sampleEvent) rec.sampleEvent = raw;
      rec.lineIndices.push(i);
    }
    const tpl = mergedTemplates.get(ev.templateHash);
    for (let s = 0; s < ev.values.length; s++) {
      const slotName = tpl?.variableSlots?.[s]?.name || `slot_${s}`;
      const set = rec.variables.get(slotName) || new Set<string>();
      set.add(ev.values[s]);
      rec.variables.set(slotName, set);
    }
    byHash.set(ev.templateHash, rec);
  }

  // Severity lookup: try aggregated rows (keyed by pattern name) first by
  // Jaccard token match between template body + aggregated pattern token set.
  const aggTokenized = mergedAggregated.map((r) => ({ row: r, tokens: tokenize(r.pattern) }));

  const patterns: ExtractedPattern[] = [];
  for (const [hash, rec] of byHash) {
    const tpl = mergedTemplates.get(hash);
    const body = tpl?.template || hash;
    const severity = tpl?.severity || bestAggregatedMatch(body, aggTokenized)?.row.severity;

    const variables: Record<string, string[]> = {};
    for (const [slot, set] of rec.variables) {
      // Cap at 20 sample values per slot — enough for dependency analysis, not enough to blow context.
      variables[slot] = Array.from(set).slice(0, 20);
    }

    patterns.push({
      hash,
      template: body,
      severity: severity ? severity.toUpperCase() : undefined,
      service: inferServiceFromSample(rec.sampleEvent, variables),
      count: rec.count,
      bytes: rec.bytes,
      sampleEvent: rec.sampleEvent,
      variables,
    });
  }

  patterns.sort((a, b) => b.count - a.count);

  const totalBytes = patterns.reduce((s, p) => s + p.bytes, 0);

  return {
    patterns,
    totalEvents: mergedEncoded.length,
    totalBytes,
    inputLineCount: lines.length,
    templaterWallTimeMs: totalWallTimeMs,
    executionMode,
  };
}

/** Coerce an unknown value into a single log line, JSON-stringifying objects. */
function coerceToLine(e: unknown): string {
  if (e == null) return '';
  if (typeof e === 'string') return e.replace(/\r?\n/g, ' ');
  if (typeof e === 'number' || typeof e === 'boolean') return String(e);
  if (typeof e === 'object') {
    // Prefer common log-line fields over JSON-stringifying the whole thing.
    const obj = e as Record<string, unknown>;
    const cand = obj.text || obj.message || obj.log || obj.body || obj._raw;
    if (typeof cand === 'string') return cand.replace(/\r?\n/g, ' ');
    try {
      return JSON.stringify(e).replace(/\r?\n/g, ' ');
    } catch {
      return '';
    }
  }
  return String(e);
}

/** Split lines into chunks whose serialized form fits in maxBytes. */
function chunkByBytes(lines: string[], maxBytes: number): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let curBytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
    if (curBytes + lineBytes > maxBytes && cur.length > 0) {
      chunks.push(cur.join('\n'));
      cur = [];
      curBytes = 0;
    }
    // Single-line-exceeds-limit: truncate to avoid infinite loop.
    if (lineBytes > maxBytes) {
      chunks.push(line.slice(0, maxBytes - 1));
      continue;
    }
    cur.push(line);
    curBytes += lineBytes;
  }
  if (cur.length > 0) chunks.push(cur.join('\n'));
  return chunks;
}

function tokenize(s: string): Set<string> {
  const parts = s.split(/[^A-Za-z0-9]+/).filter((t) => t.length >= 2).map((t) => t.toLowerCase());
  return new Set(parts);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function bestAggregatedMatch(
  body: string,
  aggregated: Array<{ row: AggregatedRow; tokens: Set<string> }>
): { row: AggregatedRow; similarity: number } | null {
  const bodyTokens = tokenize(body);
  let best: { row: AggregatedRow; similarity: number } | null = null;
  for (const { row, tokens } of aggregated) {
    const similarity = jaccard(bodyTokens, tokens);
    if (similarity > (best?.similarity ?? 0)) {
      best = { row, similarity };
    }
  }
  if (best && best.similarity >= 0.3) return best;
  return null;
}

/**
 * Best-effort service extraction from a sample event + captured variables.
 * Services are typically emitted via a `service=name` kv pair, a JSON
 * `"service":"name"` field, or a leading token before a severity keyword.
 * Returns undefined when no candidate is found.
 */
function inferServiceFromSample(sample: string, variables: Record<string, string[]>): string | undefined {
  if (!sample) return undefined;
  const structured = variables['service'] || variables['svc'] || variables['tenx_user_service'];
  if (structured && structured.length === 1) return structured[0];

  const kv = sample.match(/\bservice[=:]\s*"?([A-Za-z0-9_.\-]+)"?/i);
  if (kv) return kv[1];

  const json = sample.match(/"service"\s*:\s*"([^"]+)"/);
  if (json) return json[1];

  return undefined;
}
