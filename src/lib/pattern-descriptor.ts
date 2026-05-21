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
  // Pack tokens until we'd exceed maxChars
  const out: string[] = [];
  let len = 0;
  for (const t of meaningful) {
    const newLen = len + t.length + (out.length > 0 ? 1 : 0);
    if (newLen > maxChars) break;
    out.push(t);
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
