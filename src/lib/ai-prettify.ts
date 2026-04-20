/**
 * Batch-call the Log10x /api/v1/query_ai endpoint to turn raw snake_case
 * pattern identities into 3-5-word human-readable names.
 *
 * Mirrors the Slack bot's `SlackAiService.java` approach: one HTTP call
 * with all top-N patterns, gets back `INDEX | NAME` per line. Fail-soft:
 * on any error the caller keeps the raw identities and prints a single-
 * line note in the report appendix.
 *
 * Respects privacy_mode semantics — the caller should decide whether to
 * invoke this. Templated patterns don't contain variable values (the
 * templater already stripped them), but they DO contain field names /
 * class names / path fragments that identify the customer's app. Strict
 * privacy_mode: true users will want to skip this.
 */

import type { EnvConfig } from './environments.js';

const AI_PATH = '/api/v1/query_ai';

const PROMPT = [
  'The data below contains log event patterns extracted from production logs.',
  'Each pattern is a templatized log message where variable parts (IDs, values) are replaced with underscores.',
  "The 'tenx_user_service' column is the microservice that emitted the log.",
  '',
  'Generate a short human-readable name (3-5 words, title case) for each pattern.',
  'Focus on the specific class, method, or operation — not the service name (users already know the service).',
  'Look for CamelCase class names, method names, HTTP verbs, queue/cache operations, and error types.',
  'Every pattern MUST get a DIFFERENT name — do not repeat names.',
  '',
  'Patterns:',
  '${CSV}',
  '',
  'Respond with EXACTLY one line per data row (skip the header), numbered from 1, nothing else:',
  'INDEX | NAME',
].join('\n');

const LINE_RE = /^(\d+)\s*\|\s*(.+)$/;

export interface PrettifyInput {
  identity: string; // snake_case identity — the key we return against
  service?: string;
  severity?: string;
  /** Raw event count over the sample window. Used by the model to order by impact. */
  count: number;
  bytes: number;
}

export interface PrettifyOptions {
  env: EnvConfig;
  apiBase: string; // e.g. https://prometheus.log10x.com
  costPerGb: number;
  timeoutMs?: number;
}

export interface PrettifyResult {
  /** identity → pretty name. Missing entries mean the model didn't return one — caller keeps the identity. */
  names: Record<string, string>;
  /** Reason string when the call failed or returned nothing useful. undefined on success. */
  errorNote?: string;
}

/**
 * Returns a map of pattern identity → AI-generated short name. Never throws;
 * on any failure returns an empty map and a human-readable errorNote string
 * the renderer can include in the appendix.
 */
export async function prettifyPatterns(
  patterns: PrettifyInput[],
  opts: PrettifyOptions
): Promise<PrettifyResult> {
  if (patterns.length === 0) return { names: {} };

  try {
    const queryResult = buildBatchQueryResult(patterns, opts.costPerGb);
    const url = buildUrl(opts.apiBase, queryResult, opts.costPerGb, patterns.length * 20);
    const authHeader = `${opts.env.apiKey}/${opts.env.envId}`;

    const abort = new AbortController();
    const t = setTimeout(() => abort.abort(), opts.timeoutMs ?? 30_000);

    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-10X-Auth': authHeader },
      signal: abort.signal,
    });
    clearTimeout(t);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        names: {},
        errorNote: `AI prettify HTTP ${res.status}${body ? ` — ${body.slice(0, 120)}` : ''}`,
      };
    }

    const json = (await res.json()) as { ai?: string };
    const aiText = (json.ai || '').trim();
    if (!aiText) {
      return { names: {}, errorNote: 'AI prettify returned empty response' };
    }

    const names: Record<string, string> = {};
    for (const line of aiText.split('\n')) {
      const m = LINE_RE.exec(line.trim());
      if (!m) continue;
      const idx = parseInt(m[1], 10) - 1; // 1-based → 0-based
      const name = m[2].trim();
      if (idx >= 0 && idx < patterns.length && name) {
        names[patterns[idx].identity] = name;
      }
    }
    if (Object.keys(names).length === 0) {
      return { names: {}, errorNote: 'AI prettify response did not match expected INDEX | NAME format' };
    }
    return { names };
  } catch (e) {
    return {
      names: {},
      errorNote: `AI prettify error: ${(e as Error).message.slice(0, 200)}`,
    };
  }
}

/**
 * Build the `query_result` JSON payload that QueryAIHandler expects. The
 * handler expects a Prometheus-shaped vector; `metric.message_pattern`,
 * `metric.severity_level`, `metric.tenx_user_service` are the columns
 * the prompt template references.
 */
function buildBatchQueryResult(patterns: PrettifyInput[], costPerGb: number): string {
  const result = patterns.map((p) => {
    // Convert underscored identity back to space-separated for readability.
    const displayText = p.identity.replace(/_/g, ' ');
    // Convert bytes → cost (backend divides by this, so we must feed it bytes
    // consistent with the cost field it'll compute).
    const bytes = Math.max(0, Math.round(p.bytes));
    return {
      metric: {
        message_pattern: displayText,
        severity_level: p.severity || '',
        tenx_user_service: p.service || '',
      },
      value: [0, String(bytes)],
    };
  });
  const payload = { status: 'success', data: { resultType: 'vector', result } };
  return JSON.stringify(payload);
}

function buildUrl(apiBase: string, queryResult: string, costPerGb: number, maxTokens: number): string {
  const base = apiBase.replace(/\/+$/, '');
  const params = new URLSearchParams({
    query: 'vector(0)',
    query_result: queryResult,
    prompt: PROMPT,
    ingestion_cost: String(costPerGb),
    total_volume: '0',
    output_table: 'false',
    prompt_timeout: '25000',
  });
  // `maxTokens` is intentionally unused here — the current QueryAIHandler
  // defaults the model-side token cap based on input size; we honor that.
  void maxTokens;
  return `${base}${AI_PATH}?${params.toString()}`;
}
