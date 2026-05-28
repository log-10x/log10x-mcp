/**
 * log10x_customer_metrics_query — low-level PromQL passthrough to the
 * customer metric backend.
 *
 * This is the agent's escape hatch. Most cross-pillar investigations go
 * through the composable primitives (metrics_that_moved,
 * rank_by_shape_similarity, metric_overlay), but exposing a pure
 * passthrough ensures the agent is never blocked on "the tool doesn't
 * support the metric I need."
 *
 * Returns the raw Prometheus response shape plus an `execution` block
 * identifying which backend served the query.
 *
 * Tier prerequisite: LOG10X_CUSTOMER_METRICS_URL configured.
 * This tool issues exactly 1 PromQL query against the customer backend.
 */

import { z } from 'zod';
import { resolveBackend, formatDetectionTrace, CustomerMetricsNotConfiguredError } from '../lib/customer-metrics.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';

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
  view: z
    .enum(['summary', 'markdown'])
    .default('summary')
    .describe('summary returns the typed envelope (data.series[], data.backend, data.result_type). markdown wraps the rendered series view in data.markdown.'),
};

interface CustomerMetricsQuerySummary {
  promql: string;
  backend: string;
  mode: 'instant' | 'range';
  result_type: string;
  series_count: number;
  shown_count: number;
  series: Array<{
    metric_name: string;
    labels: Record<string, string>;
    instant_value?: { value: string; timestamp: number };
    range?: {
      point_count: number;
      from: number;
      to: number;
      first_points: Array<{ t: number; v: string }>;
      last_points: Array<{ t: number; v: string }>;
    };
  }>;
}

export async function executeCustomerMetricsQuery(args: {
  promql: string;
  mode: 'instant' | 'range';
  start?: string;
  end?: string;
  step?: string;
  view?: 'summary' | 'markdown';
}): Promise<string | StructuredOutput> {
  const view = args.view ?? 'summary';
  const telemetry = newTelemetry();
  const resolution = await resolveBackend();
  if (!resolution.backend) {
    throw new CustomerMetricsNotConfiguredError(formatDetectionTrace(resolution.trace));
  }
  const backend = resolution.backend;

  let res: import('../lib/api.js').PrometheusResponse;
  if (args.mode === 'instant') {
    res = await backend.queryInstant(args.promql);
  } else {
    if (!args.start || !args.end || !args.step) {
      throw new Error('mode=range requires start, end, and step.');
    }
    const start = parseTimeArg(args.start);
    const end = parseTimeArg(args.end);
    const step = parseInt(args.step, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step <= 0) {
      throw new Error('Invalid start/end/step. Expect ISO8601 or UNIX seconds, and a positive integer step.');
    }
    res = await backend.queryRange(args.promql, start, end, step);
  }

  const data = buildCustomerMetricsSummary(args.promql, res, backend.backendType, args.mode);
  const md = renderQueryResult(args.promql, res, backend.backendType);

  if (view === 'markdown') {
    return buildMarkdownEnvelope({
      tool: 'log10x_customer_metrics_query',
      summary: { headline: `Customer metrics (${backend.backendType}): ${data.series_count} series` },
      markdown: md,
    });
  }
  const headline = `${backend.backendType} query \`${args.promql.slice(0, 60)}${args.promql.length > 60 ? '…' : ''}\`: ${data.series_count} series returned (${data.result_type}).`;
  return buildEnvelope({
    tool: 'log10x_customer_metrics_query',
    view: 'summary',
    summary: { headline },
    data: { ...data, ...buildUnifiedFields({ status: 'success', telemetry, humanSummary: headline }) },
    truncated: data.shown_count < data.series_count,
  });
}

function buildCustomerMetricsSummary(
  promql: string,
  res: import('../lib/api.js').PrometheusResponse,
  backendType: string,
  mode: 'instant' | 'range'
): CustomerMetricsQuerySummary {
  const limit = 10;
  const shown = res.data.result.slice(0, limit);
  return {
    promql,
    backend: backendType,
    mode,
    result_type: res.data.resultType,
    series_count: res.data.result.length,
    shown_count: shown.length,
    series: shown.map((r) => {
      const labels: Record<string, string> = {};
      const metricName = (r.metric.__name__ as string | undefined) ?? 'result';
      for (const [k, v] of Object.entries(r.metric)) {
        if (k !== '__name__') labels[k] = v as string;
      }
      const entry: CustomerMetricsQuerySummary['series'][number] = {
        metric_name: metricName,
        labels,
      };
      if (r.value) {
        entry.instant_value = { value: String(r.value[1]), timestamp: r.value[0] };
      }
      if (r.values && r.values.length > 0) {
        entry.range = {
          point_count: r.values.length,
          from: r.values[0][0],
          to: r.values[r.values.length - 1][0],
          first_points: r.values.slice(0, 3).map(([t, v]) => ({ t, v: String(v) })),
          last_points: r.values.slice(-3).map(([t, v]) => ({ t, v: String(v) })),
        };
      }
      return entry;
    }),
  };
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
