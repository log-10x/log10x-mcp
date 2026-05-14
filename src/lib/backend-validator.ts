/**
 * Backend validator — shared by `log10x_configure_env` (validate
 * before persisting) and `log10x_doctor` (validate periodically).
 *
 * Probes the metrics backend in four steps, surfacing the first
 * failure with a clear, actionable diagnostic. The four checks are:
 *
 *   1. **Reachable** — TCP connect + HTTP request returns any
 *      response. Fails on DNS, connection refused, TLS handshake
 *      failure, timeout.
 *   2. **Authenticated** — `up` query returns 200 + `status:success`.
 *      Fails on 401/403 (bad auth), 429 (rate limit), 5xx (backend
 *      down). Distinguishes "wrong creds" from "wrong URL".
 *   3. **Engine metrics present** — `count(all_events_summaryBytes_total)`
 *      returns a non-empty / non-zero result. Catches the
 *      read/write URL mismatch: backend is reachable but the 10x
 *      engine isn't writing to it.
 *   4. **Expected labels present** — the metric carries the labels
 *      the env's `labels` map expects (default: `message_pattern`,
 *      `tenx_user_service`, `severity_level`, `tenx_env`). Catches
 *      the rename mismatch — engine renamed labels but the env's
 *      `labels` override wasn't updated to match.
 *
 * Returns a structured result; never throws. Callers render it as
 * markdown.
 */

import type { MetricsBackend } from './metrics-backend.js';
import type { LabelNameMap } from './promql.js';

export type CheckStatus = 'pass' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Optional remediation hint shown when status is `fail`. */
  hint?: string;
}

export interface ValidationResult {
  /** True iff every check passed. */
  ok: boolean;
  /** Ordered list of check results — first failure aborts the chain. */
  checks: CheckResult[];
}

/**
 * Run the four-step probe against a backend. Stops on the first
 * failure so the user sees the FIRST problem to fix (not a noisy
 * cascade).
 */
export async function validateBackend(
  backend: MetricsBackend,
  labels: LabelNameMap
): Promise<ValidationResult> {
  const checks: CheckResult[] = [];

  // ── 1. Reachable + 2. Authenticated ────────────────────────────────
  // Collapsed into one probe: the `up` PromQL is a no-op that any
  // healthy Prom-compatible backend answers; failure flavor tells us
  // which of (reachable / authenticated) is broken.
  try {
    const res = await backend.queryInstant('up');
    if (res.status !== 'success') {
      checks.push({
        name: 'reachable_and_authenticated',
        status: 'fail',
        detail: `Backend responded but status was '${res.status}' (expected 'success').`,
        hint: 'The backend rejected the query. Check whether the URL points at the read API root.',
      });
      return { ok: false, checks };
    }
    checks.push({
      name: 'reachable_and_authenticated',
      status: 'pass',
      detail: `Connected to ${backend.endpoint} and authenticated successfully.`,
    });
  } catch (e) {
    const msg = (e as Error).message;
    const httpMatch = msg.match(/HTTP (\d{3})/);
    const status = httpMatch ? parseInt(httpMatch[1], 10) : 0;
    const detail = msg.slice(0, 300);
    let hint = `Verify ${backend.endpoint} is reachable from this machine and the auth credentials are correct.`;
    if (status === 401 || status === 403) {
      hint = `Auth rejected (HTTP ${status}). Check the credentials referenced by your env config.`;
    } else if (status === 404) {
      hint = `404 — the URL doesn't expose a Prometheus-compatible API root at this path. Verify the read endpoint (usually ends in /api/v1 or just the workspace root).`;
    } else if (status >= 500) {
      hint = `Backend returned ${status} — service is unhealthy or unreachable.`;
    } else if (!status) {
      hint = `Network-level error. Check DNS, firewall, and TLS settings.`;
    }
    checks.push({ name: 'reachable_and_authenticated', status: 'fail', detail, hint });
    return { ok: false, checks };
  }

  // ── 3. 10x engine metrics present ──────────────────────────────────
  try {
    const res = await backend.queryInstant('count(all_events_summaryBytes_total)');
    const result = res.data?.result;
    if (!result || result.length === 0) {
      checks.push({
        name: 'engine_metrics_present',
        status: 'fail',
        detail: 'Backend is reachable but `all_events_summaryBytes_total` has no series.',
        hint:
          'The 10x engine is not writing to this backend yet. Verify the engine\'s metric output ' +
          'module is configured to write to the same URL the MCP reads from. See ' +
          '`config/pipelines/run/output/metric/<backend>/config.yaml` in your config repo.',
      });
      return { ok: false, checks };
    }
    checks.push({
      name: 'engine_metrics_present',
      status: 'pass',
      detail: `\`all_events_summaryBytes_total\` exists (count=${result[0].value?.[1] ?? '?'}).`,
    });
  } catch (e) {
    checks.push({
      name: 'engine_metrics_present',
      status: 'fail',
      detail: `Probe query failed: ${(e as Error).message.slice(0, 300)}.`,
      hint: 'The backend rejected the probe PromQL. May indicate a non-standard PromQL dialect.',
    });
    return { ok: false, checks };
  }

  // ── 4. Expected labels present ─────────────────────────────────────
  try {
    const allLabels = await backend.listLabels();
    const expected = [labels.pattern, labels.service, labels.severity, labels.env];
    const missing = expected.filter((l) => !allLabels.includes(l));
    if (missing.length > 0) {
      const present = expected.filter((l) => allLabels.includes(l));
      checks.push({
        name: 'expected_labels_present',
        status: 'fail',
        detail:
          `Expected labels ${missing.map((l) => `\`${l}\``).join(', ')} are missing from the backend's label set. ` +
          `Found: ${present.length > 0 ? present.map((l) => `\`${l}\``).join(', ') : '(none of the expected labels)'}.`,
        hint:
          'Either (a) the engine\'s `metricFieldNames` was renamed but the env\'s `labels` map wasn\'t updated to match; ' +
          'or (b) the engine doesn\'t set `runtimeAttributes: env:edge` (or `env:cloud`), so the `tenx_env` label is absent. ' +
          'Inspect the backend\'s actual label set: ' + describeLabelSample(allLabels) + '.',
      });
      return { ok: false, checks };
    }
    checks.push({
      name: 'expected_labels_present',
      status: 'pass',
      detail: `All expected labels present: ${expected.map((l) => `\`${l}\``).join(', ')}.`,
    });
  } catch (e) {
    checks.push({
      name: 'expected_labels_present',
      status: 'fail',
      detail: `Could not list labels on the backend: ${(e as Error).message.slice(0, 300)}.`,
    });
    return { ok: false, checks };
  }

  return { ok: true, checks };
}

function describeLabelSample(labels: string[]): string {
  if (labels.length === 0) return '(label list was empty)';
  const sample = labels.slice(0, 10);
  return labels.length > 10
    ? `${sample.join(', ')}, ... (${labels.length - 10} more)`
    : sample.join(', ');
}

/**
 * Render a ValidationResult as markdown for tool output. Used by both
 * configure_env (when validation fails) and doctor (in the per-env
 * status section).
 */
export function renderValidationResult(result: ValidationResult, env: { nickname: string; metricsBackend: MetricsBackend }): string {
  const lines: string[] = [];
  lines.push(`### Backend validation for \`${env.nickname}\` (kind=${env.metricsBackend.kind}, url=${env.metricsBackend.endpoint})`);
  lines.push('');
  for (const c of result.checks) {
    const badge = c.status === 'pass' ? '`PASS`' : '**FAIL**';
    lines.push(`- ${badge} \`${c.name}\` — ${c.detail}`);
    if (c.status === 'fail' && c.hint) {
      lines.push(`  - **Hint**: ${c.hint}`);
    }
  }
  lines.push('');
  if (result.ok) {
    lines.push('**Result**: backend is healthy and the engine is writing here.');
  } else {
    lines.push('**Result**: validation failed at the first FAIL above. Fix that issue and re-run.');
  }
  return lines.join('\n');
}
