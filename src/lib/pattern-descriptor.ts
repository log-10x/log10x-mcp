/**
 * Algorithmic short descriptor for a pattern, derived from its tokenized
 * (underscored) form. Replaces the previous "tokenized name as
 * description" leak — that string is machine identity, unusable as a
 * human label.
 *
 * Strategy: take the underscored pattern, strip leading boilerplate
 * tokens (otel / open-telemetry prefixes, vendor names), then pack as
 * many tokens as fit in `maxChars`. This is deterministic and never
 * synthesizes content — every token shown is verbatim from the
 * engine-extracted pattern.
 *
 * Falls back to the sample event's first 60 chars if the tokenized
 * pattern is empty.
 */

const PREFIX_SKIP = new Set([
  'open',
  'telemetry',
  'opentelemetry',
  'collector',
  'contrib',
  'tenx',
  'log10x',
  'com',
  'the',
  'a',
  'an',
]);

export function patternDescriptor(
  messagePattern: string,
  sampleLog = '',
  maxChars = 44
): string {
  if (!messagePattern) {
    return sampleLog ? sampleLog.slice(0, 60) : '(no descriptor)';
  }
  const tokens = messagePattern.split('_');
  // Strip up to 6 leading boilerplate tokens
  let cursor = 0;
  while (
    cursor < tokens.length &&
    cursor < 6 &&
    PREFIX_SKIP.has(tokens[cursor].toLowerCase())
  ) {
    cursor++;
  }
  const meaningful = tokens.slice(cursor);
  if (meaningful.length === 0) {
    // All tokens were prefix-skip; fall back to the raw head
    return tokens.slice(0, 5).join(' ').slice(0, maxChars);
  }
  // Pack tokens until we'd exceed maxChars, deduping repeats. Engine
  // names for package-path patterns repeat tokens (the otel collector's
  // Go path appears twice; payment's `runtime`/`nodejs`/`node modules`
  // recur) — skipping already-seen tokens collapses the soup into a
  // readable sequence without inventing content.
  const out: string[] = [];
  const seen = new Set<string>();
  let len = 0;
  for (const t of meaningful) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    const newLen = len + t.length + (out.length > 0 ? 1 : 0);
    if (newLen > maxChars) break;
    out.push(t);
    seen.add(key);
    len = newLen;
  }
  if (out.length === 0) out.push(...meaningful.slice(0, 3));
  return out.join(' ');
}

/**
 * Sample-mined descriptor — pull the value of a priority key from the
 * sample event's parsed JSON. Operates on a different axis than the
 * engine: the engine's `message_pattern` label is a structural
 * fingerprint (which code path), while this descriptor is a content
 * snapshot (what the event actually says).
 *
 * Priority order mirrors what an SRE looks for first in a log line:
 * an `error` field, then `reason`, then `exception`, then a generic
 * `message`/`msg` body, then `status`. Returns the literal value of
 * the first key present, first-line-only (stack traces strip), with a
 * length cap.
 *
 * Returns null when:
 *  - No parsed JSON tail is available (sample fetch failed, multi-
 *    line event the unwrap couldn't reduce, etc.)
 *  - None of the priority keys are present (plain-text logs, events
 *    keyed on non-conventional fields like `action`/`event`/etc.)
 *
 * In both null cases the caller falls back to `patternDescriptor`
 * (engine pattern-name tail), which is the current behavior. So this
 * is strictly equal-or-better than today across all log formats —
 * never a regression.
 *
 * Where it actually adds value: OTel-collector-style structured
 * logger output where the discriminative content lives inside a
 * field value rather than as the log line itself. In those cases
 * the engine's "longest run from same source" extraction anchors on
 * the LOGGER source path; this function surfaces the actual error
 * MESSAGE.
 */
// Priority order mirrors what an SRE looks for first when reading a
// log line. `error`/`reason`/`exception`/`message`/`msg` are the most
// discriminative; `status` carries some signal; `component` is a
// last-resort fallback for events whose message body is itself
// envelope-only (e.g. OTel debug exporter dumps where the only
// discriminative-ish field is `component=debug/exporter`).
const PRIORITY_KEYS = ['error', 'reason', 'exception', 'message', 'msg', 'status', 'component'] as const;

export function descriptorFromSample(
  logJson: Record<string, unknown> | null | undefined,
  maxChars = 60
): string | null {
  if (!logJson) return null;
  for (const key of PRIORITY_KEYS) {
    const raw = logJson[key];
    if (raw === undefined || raw === null) continue;
    let str = String(raw).trim();
    if (!str) continue;
    // First line only — stack traces, multi-line errors strip
    if (str.includes('\n')) str = str.split('\n')[0].trim();
    if (!str) continue;
    if (str.length > maxChars) str = str.slice(0, maxChars - 1) + '…';
    return str;
  }
  // Last-resort fallback: otelcol triplet. Events from the OTel
  // collector's debug exporter / processors are metadata-only — no
  // error/reason/message field. The engine often extracts a very
  // short pattern name (e.g. just `tinfo`) which reads as gibberish.
  // For these, compose the discriminative metadata into a readable
  // string: "debug/exporter (traces)" instead of "tinfo".
  const otelId = logJson['otelcol.component.id'];
  const otelKind = logJson['otelcol.component.kind'];
  const otelSignal = logJson['otelcol.signal'];
  if (otelId || otelKind || otelSignal) {
    const id = otelId ? String(otelId) : '';
    const kind = otelKind ? String(otelKind) : '';
    const signal = otelSignal ? String(otelSignal) : '';
    const pair = id && kind ? `${id}/${kind}` : (id || kind);
    const out = signal ? `${pair} (${signal})` : pair;
    return out.length > maxChars ? out.slice(0, maxChars - 1) + '…' : out;
  }
  return null;
}

/**
 * Canonical pattern display for HUMAN-facing output across the whole MCP.
 * One helper so every tool shows a pattern the same way (the inconsistency
 * fix). `title` is a readable description — from the sample event's content
 * when a sample is available (best), else the algorithmic token descriptor —
 * NEVER the raw snake_case token. `identity` is the raw token (+ hash when
 * known): the machine handle, to be demoted to a small `id:` line or the
 * agent-only channel, not the human headline.
 */
/**
 * One-line plain-English gloss for `tenx_hash`, shown the FIRST time the hash
 * is surfaced to a human in an action context (exclusion_filter,
 * pattern_examples). In survey contexts (top_patterns) the bare hash is
 * demoted to the agent-only channel instead of glossed. Keep the wording in
 * one place so it stays consistent across tools.
 */
export const TENX_HASH_GLOSS =
  '`tenx_hash` is a stable fingerprint for this exact log pattern; dropping or correlating by it is precise and survives wording changes (unlike a text match).';

export function patternDisplay(
  pattern: string,
  opts: {
    sampleJson?: Record<string, unknown> | null;
    sampleLine?: string;
    hash?: string;
    maxChars?: number;
  } = {}
): { title: string; identity: string } {
  const max = opts.maxChars ?? 60;
  const title =
    descriptorFromSample(opts.sampleJson, max) ??
    patternDescriptor(pattern, opts.sampleLine ?? '', max);
  const identity = opts.hash ? `${pattern} · hash ${opts.hash}` : pattern;
  return { title, identity };
}

// ---------------------------------------------------------------------------
// Identity descriptor (re-added post-merge) — universal pattern shape across
// identity-tier tools (top_volume / whats_changing / whats_new / pattern_diff).
// ---------------------------------------------------------------------------

import { tenxHash } from './pattern-hash.js';

export interface IdentityDescriptor {
  pattern_hash: string;
  symbol_message: string;
  severities: string[];
  first_seen_age_seconds: number | null;
  services: ServiceIdentity[];
}

export interface ServiceIdentity {
  name: string;
  severity: string;
}

export interface RawPatternServiceRow {
  symbolMessage: string;
  service: string;
  severity: string;
}

export interface GroupedPattern<R extends RawPatternServiceRow> {
  pattern_hash: string;
  symbol_message: string;
  severities: string[];
  first_seen_age_seconds: number | null;
  rows_by_service: Map<string, R>;
}

/**
 * Group per-(pattern, service) raw rows into per-pattern groups. Pure
 * transformation: pattern_hash is derived locally via tenxHash(symbolMessage),
 * severities are the unique set across the group, first_seen_age_seconds
 * comes from the supplied batch.
 */
export function groupRowsByPattern<R extends RawPatternServiceRow>(
  rows: R[],
  firstSeenByHash: Map<string, { ageSeconds: number | null }>,
): GroupedPattern<R>[] {
  const groups = new Map<
    string,
    { symbolMessage: string; sevs: Set<string>; bySvc: Map<string, R> }
  >();
  for (const r of rows) {
    if (!r.symbolMessage) continue;
    const hash = tenxHash(r.symbolMessage);
    let g = groups.get(hash);
    if (!g) {
      g = { symbolMessage: r.symbolMessage, sevs: new Set<string>(), bySvc: new Map() };
      groups.set(hash, g);
    }
    if (r.severity) g.sevs.add(r.severity);
    g.bySvc.set(r.service, r);
  }
  return Array.from(groups.entries()).map(([pattern_hash, g]) => ({
    pattern_hash,
    symbol_message: g.symbolMessage,
    severities: Array.from(g.sevs).sort(),
    first_seen_age_seconds: firstSeenByHash.get(pattern_hash)?.ageSeconds ?? null,
    rows_by_service: g.bySvc,
  }));
}
