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
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';
import { wrapBackendError } from '../lib/primitive-errors.js';
import { newChassisTelemetry, buildChassisErrorEnvelope } from '../lib/chassis-envelope.js';

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

interface CustomerMetricsQuerySummary {
  promql: string;
  backend: string;
  mode: 'instant' | 'range';
  result_type: string;
  series_count: number;
  shown_count: number;
  human_summary: string;
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
}): Promise<string | StructuredOutput> {
  const telemetry = newTelemetry();
  const chassisTelemetry = newChassisTelemetry();
  const resolution = await resolveBackend();
  if (!resolution.backend) {
    // KEEP (precondition): throw is the loud human-escape-hatch path;
    // wrap() converts via isNotConfiguredError(name match) to a typed envelope.
    throw new CustomerMetricsNotConfiguredError(formatDetectionTrace(resolution.trace));
  }
  const backend = resolution.backend;

  let res: import('../lib/api.js').PrometheusResponse;
  try {
    if (args.mode === 'instant') {
      res = await backend.queryInstant(args.promql);
    } else {
      if (!args.start || !args.end || !args.step) {
        // KEEP (schema-violation): cross-field requirement Zod can't express.
        throw new Error('mode=range requires start, end, and step.');
      }
      const start = parseTimeArg(args.start);
      const end = parseTimeArg(args.end);
      const step = parseInt(args.step, 10);
      if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step <= 0) {
        // KEEP (schema-violation): freeform string parse, not Zod-expressible.
        throw new Error('Invalid start/end/step. Expect ISO8601 or UNIX seconds, and a positive integer step.');
      }
      res = await backend.queryRange(args.promql, start, end, step);
    }
  } catch (e) {
    const primitiveErr = wrapBackendError(e);
    return buildChassisErrorEnvelope({
      tool: 'log10x_customer_metrics_query',
      err: primitiveErr,
      telemetry: chassisTelemetry,
      source_disclosure: { siem_vendor: backend.backendType },
      scope: {
        window: args.mode === 'range' ? `${args.start ?? '?'}..${args.end ?? '?'}` : 'instant',
        window_basis: 'explicit',
      },
      contextPayload: {
        promql: args.promql,
        mode: args.mode,
        debug_error: e instanceof Error ? e.message : String(e),
      },
    });
  }

  const data = buildCustomerMetricsSummary(args.promql, res, backend.backendType, args.mode);
  data.human_summary = buildCustomerMetricsQueryHumanSummary(data, args.promql);
  const headline = `${backend.backendType} query \`${args.promql.slice(0, 60)}${args.promql.length > 60 ? '…' : ''}\`: ${data.series_count} series returned (${data.result_type}).`;
  return buildEnvelope({
    tool: 'log10x_customer_metrics_query',
    view: 'summary',
    summary: { headline },
    data: { ...data, ...buildUnifiedFields({ status: 'success', telemetry, humanSummary: data.human_summary }) },
    truncated: data.shown_count < data.series_count,
  });
}

function buildCustomerMetricsQueryHumanSummary(data: CustomerMetricsQuerySummary, promql: string): string {
  const qprev = promql.length > 60 ? `${promql.slice(0, 60)}…` : promql;
  if (data.series_count === 0) {
    return `Customer backend (${data.backend}) returned 0 series for \`${qprev}\` in ${data.mode} mode. Check label values or widen the window.`;
  }
  const top = data.series[0];
  const topLabels = top ? Object.entries(top.labels).slice(0, 2).map(([k, v]) => `${k}="${v}"`).join(', ') : '';
  const shownFrag = data.shown_count < data.series_count ? ` (showing first ${data.shown_count})` : '';
  return `Customer backend (${data.backend}) returned ${data.series_count} ${data.result_type} series for \`${qprev}\` in ${data.mode} mode${shownFrag}.${top ? ` Sample: ${top.metric_name}{${topLabels}}.` : ''}`;
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
    human_summary: '',
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

