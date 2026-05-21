/**
 * Semantic excerpt of one sample log line for the new `top_patterns`
 * card. Instead of left-to-right truncation (which buries the
 * discriminative content past the resource metadata envelope), we pull
 * the key=value pairs that distinguish ONE matched event from another:
 *   - error / reason / exception
 *   - endpoint / url / path / method
 *   - status / status_code / http_status / duration
 *   - retry / attempt
 *   - the otelcol component triplet (id / kind / signal) as one line
 *
 * Everything else (resource UUIDs, service version, instance IDs) is
 * suppressed — it's the same on every event matching this hash, so it
 * doesn't help the Reader recognize the pattern.
 *
 * Input is the unwrapped log line (from `ParsedSiemEvent.logLine`) plus
 * the optional parsed JSON tail. Output is a list of lines to print,
 * one per discriminator surfaced.
 *
 * The header line (`timestamp\tlevel\tsource\tmessage`) is always
 * preserved when present — it carries the verb of the event and the
 * source location, both useful for recognition.
 */

const DISCRIMINATIVE_KEYS = [
  'error',
  'reason',
  'message',
  'msg',
  'exception',
  'endpoint',
  'url',
  'host',
  'method',
  'path',
  'status',
  'status_code',
  'http_status',
  'duration',
  'retries',
  'attempt',
] as const;

export interface ExcerptLine {
  /** Tag identifying which kind of content this line carries
   *  (`header` / `error` / `endpoint` / `otelcol` / etc.). Mostly
   *  diagnostic; callers can ignore it. */
  tag: string;
  /** The rendered line, already string-formatted. */
  text: string;
}

/**
 * Build the semantic excerpt. If `logJson` is null (no parseable JSON
 * tail), we just return the header line and let the Reader read it
 * as-is.
 *
 * `maxLines` caps the returned list (default 6) so a wildly structured
 * event can't blow up the card body.
 */
export function semanticExcerpt(
  logLine: string,
  logJson: Record<string, unknown> | null,
  maxLines = 6
): ExcerptLine[] {
  const out: ExcerptLine[] = [];

  if (!logLine) {
    return [{ tag: 'multi-line', text: '(multi-line JSON; engine grouped this — see pattern_examples for full body)' }];
  }
  if (logLine.trim() === '{') {
    return [{ tag: 'multi-line', text: '(multi-line JSON; engine grouped this — see pattern_examples for full body)' }];
  }

  // Header line: when the log is in the otelcol "ts\tlevel\tsource\tmsg"
  // shape, the first four tab-separated fields are the header. Surface
  // the leading message text (the part before the JSON tail).
  const parts = logLine.split('\t');
  if (parts.length >= 4) {
    const header = parts[3].trim();
    // Some events have the entire JSON tail glued onto the message
    // field; trim it at the first `{` if it dominates.
    const jsonInHeader = header.indexOf(' {');
    const cleanHeader = jsonInHeader > 0 ? header.slice(0, jsonInHeader) : header;
    if (cleanHeader) out.push({ tag: 'header', text: cleanHeader.slice(0, 200) });
  } else if (!logJson) {
    // Plaintext (no JSON tail to mine) — show the whole line truncated
    out.push({ tag: 'plaintext', text: logLine.slice(0, 200) });
    return out;
  }

  if (logJson) {
    // Pull discriminative keys in priority order
    for (const key of DISCRIMINATIVE_KEYS) {
      if (out.length >= maxLines) break;
      const val = logJson[key];
      if (val === undefined || val === null) continue;
      const valStr = String(val);
      // Multi-line values: take the first line only — the rest is
      // usually a stack trace, which belongs in pattern_examples.
      const firstLine = valStr.includes('\n') ? valStr.split('\n')[0] : valStr;
      out.push({ tag: key, text: `${key}=${JSON.stringify(firstLine).slice(0, 200)}` });
    }
    // otelcol component triplet on one line — fold the three fields
    if (out.length < maxLines && (
      'otelcol.component.id' in logJson ||
      'otelcol.component.kind' in logJson ||
      'otelcol.signal' in logJson
    )) {
      const id = logJson['otelcol.component.id'] ?? '';
      const kind = logJson['otelcol.component.kind'] ?? '';
      const signal = logJson['otelcol.signal'] ?? '';
      out.push({
        tag: 'otelcol',
        text: `component=${id}/${kind}  signal=${signal}`,
      });
    }
  }

  if (out.length === 0) {
    // Couldn't pull any discriminator and there's no header — show the
    // raw line truncated
    out.push({ tag: 'raw', text: logLine.slice(0, 200) });
  }
  return out;
}
