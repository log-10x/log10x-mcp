/**
 * Log10x paste Lambda client.
 *
 * The paste Lambda is a public endpoint that runs the `tenx` dev CLI
 * server-side on user-submitted log events. It accepts a text/plain body
 * (max ~100KB of raw log lines) and returns the CLI's four output files
 * as JSON fields.
 *
 * Endpoint: https://meljpepqpd.execute-api.us-east-1.amazonaws.com/paste
 * No auth — public demo surface.
 *
 * Privacy note: events sent to this endpoint leave the caller's machine
 * and hit a Log10x-operated Lambda. Use privacy_mode=true on
 * log10x_resolve_batch to route through a local CLI instead.
 */

const DEFAULT_PASTE_URL = 'https://meljpepqpd.execute-api.us-east-1.amazonaws.com/paste';
const MAX_BYTES = 100 * 1024; // 100 KB — matches Lambda body limit

export interface PasteResponse {
  /** NDJSON of templates: one `{templateHash, template, ...}` per line. */
  'templates.json': string;
  /** Lines prefixed with ~templateHash followed by variable values, comma-separated. */
  'encoded.log': string;
  /** CSV of aggregated per-pattern statistics. */
  'aggregated.csv': string;
  /** Decoded events (losslessly reconstructed). Ignored by the wrapper. */
  'decoded.log'?: string;
  error?: string;
}

/** URL to call. Override via LOG10X_PASTE_URL env var. */
function getPasteUrl(): string {
  return process.env.LOG10X_PASTE_URL || DEFAULT_PASTE_URL;
}

/**
 * Submit raw log text to the paste Lambda and return the parsed response.
 *
 * Throws if the body exceeds the Lambda's 100 KB limit, if the HTTP call
 * fails, or if the response JSON is missing the expected fields.
 */
export async function submitPaste(text: string): Promise<PasteResponse> {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BYTES) {
    throw new Error(
      `Batch too large for paste Lambda: ${(bytes / 1024).toFixed(1)} KB > 100 KB limit. ` +
      `Trim the batch to ~1-2K events or use privacy_mode=true with a locally-installed tenx CLI.`
    );
  }

  const res = await fetch(getPasteUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: text,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Paste Lambda HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = await res.json() as PasteResponse;
  if (data.error) {
    throw new Error(`Paste Lambda error: ${data.error}`);
  }
  if (typeof data['templates.json'] !== 'string' || typeof data['encoded.log'] !== 'string') {
    throw new Error('Paste Lambda response missing templates.json or encoded.log fields');
  }

  return data;
}

export const PASTE_MAX_BYTES = MAX_BYTES;
