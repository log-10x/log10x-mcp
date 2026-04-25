/**
 * log10x_customer_metrics_query — low-level PromQL passthrough to the
 * customer metric backend.
 *
 * This is the agent's escape hatch. Most cross-pillar investigations go
 * through the higher-level tools (correlate_cross_pillar,
 * translate_metric_to_patterns), but exposing a pure passthrough ensures
 * the agent is never blocked on "the tool doesn't support the metric I
 * need."
 *
 * Returns the raw Prometheus response shape plus an `execution` block
 * identifying which backend served the query.
 *
 * Tier prerequisite: LOG10X_CUSTOMER_METRICS_URL configured.
 * This tool issues exactly 1 PromQL query against the customer backend.
 */

import { z } from 'zod';
import { resolveBackend, formatDetectionTrace, CustomerMetricsNotConfiguredError } from '../lib/customer-metrics.js';

export const customerMetricsQuerySchema = {
  promql: z
    .string()
    .describe('PromQL expression to execute against the customer metric backend. Example: `apm_request_duration_p99{service="payments-svc"}`.'),
  mode: z
    .enum(['instant', 'range'])
    .default('instant')
    .describe('`instant` runs a point-in-time query; `range` runs over a time window with a bucket step.'),
  start: z
    .string()
    .optional()
    .describe('Start of the range window — ISO8601 or UNIX seconds. Required when mode=range.'),
  end: z
    .string()
    .optional()
    .describe('End of the range window. Required when mode=range.'),
  step: z
    .string()
    .optional()
    .describe('Bucket step for range queries, in seconds. Required when mode=range.'),
};

export async function executeCustomerMetricsQuery(args: {
  promql: string;
  mode: 'instant' | 'range';
  start?: string;
  end?: string;
  step?: string;
}): Promise<string> {
  const resolution = await resolveBackend();
  if (!resolution.backend) {
    throw new CustomerMetricsNotConfiguredError(formatDetectionTrace(resolution.trace));
  }
  const backend = resolution.backend;

  if (args.mode === 'instant') {
    const res = await backend.queryInstant(args.promql);
    return renderQueryResult(args.promql, res, backend.backendType);
  }

  if (!args.start || !args.end || !args.step) {
    throw new Error('mode=range requires start, end, and step.');
  }
  const start = parseTimeArg(args.start);
  const end = parseTimeArg(args.end);
  const step = parseInt(args.step, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step <= 0) {
    throw new Error('Invalid start/end/step. Expect ISO8601 or UNIX seconds, and a positive integer step.');
  }

  const res = await backend.queryRange(args.promql, start, end, step);
  return renderQueryResult(args.promql, res, backend.backendType);
}

function parseTimeArg(raw: string): number {
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n > 1_000_000_000) return n;
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  return NaN;
}

function renderQueryResult(
  promql: string,
  res: import('../lib/api.js').PrometheusResponse,
  backendType: string
): string {
  const lines: string[] = [];
  lines.push(`## Customer metric query result`);
  lines.push('');
  lines.push(`**Backend**: ${backendType}`);
  lines.push(`**Query**: \`${promql}\``);
  lines.push(`**Result type**: ${res.data.resultType}`);
  lines.push(`**Series returned**: ${res.data.result.length}`);
  lines.push('');

  if (res.data.result.length === 0) {
    lines.push('_No data._');
    return lines.join('\n');
  }

  for (let i = 0; i < Math.min(res.data.result.length, 10); i++) {
    const r = res.data.result[i];
    const labelStr = Object.entries(r.metric)
      .filter(([k]) => k !== '__name__')
      .map(([k, v]) => `${k}="${v}"`)
      .join(', ');
    const name = r.metric.__name__ || 'result';
    lines.push(`### ${i + 1}. ${name}{${labelStr}}`);
    if (r.value) {
      lines.push(`  instant value: ${r.value[1]} @ ${new Date(r.value[0] * 1000).toISOString()}`);
    }
    if (r.values && r.values.length > 0) {
      lines.push(`  range: ${r.values.length} points from ${new Date(r.values[0][0] * 1000).toISOString()} to ${new Date(r.values[r.values.length - 1][0] * 1000).toISOString()}`);
      const first = r.values.slice(0, 3).map(([t, v]) => `${v}@${t}`).join(', ');
      const last = r.values.slice(-3).map(([t, v]) => `${v}@${t}`).join(', ');
      lines.push(`  first 3: ${first}`);
      lines.push(`  last 3: ${last}`);
    }
    lines.push('');
  }

  if (res.data.result.length > 10) {
    lines.push(`_${res.data.result.length - 10} additional series omitted._`);
  }

  return lines.join('\n');
}
