/**
 * log10x_discover_labels — metadata discovery for Claude.
 *
 * Without this tool, Claude has to guess which labels exist when a user asks
 * "show me errors by namespace" — and the guess is often wrong (`k8s_ns`,
 * `namespace`, `kube_namespace`). With it, Claude calls discover_labels once
 * per session and gets the real label set before constructing filter args
 * for any other tool.
 *
 * Wraps Prometheus /api/v1/labels and /api/v1/label/{name}/values.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { fetchLabels, fetchLabelValues } from '../lib/api.js';
import { agentOnly } from '../lib/agent-only.js';
import { type StructuredOutput } from '../lib/output-types.js';
import { newChassisTelemetry, buildChassisEnvelope } from '../lib/chassis-envelope.js';
import { wrapBackendError, type PrimitiveError } from '../lib/primitive-errors.js';

export const discoverLabelsSchema = {
  label: z.string().optional().describe('If set, return distinct values for this label (e.g., "tenx_user_service" returns every service). If omitted, return the full label name list.'),
  limit: z.number().min(1).max(200).default(100).describe('Max values to return when a label is specified.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
};

interface DiscoverLabelsSummary {
  mode: 'label_values' | 'label_names';
  label?: string;
  total_count: number;
  shown_count: number;
  values?: string[];
  /** Featured labels that are present (available=true) in this environment. */
  featured_labels?: Array<{ name: string; hint: string }>;
  /**
   * Featured labels defined in FEATURED_LABELS but not present in this
   * environment. Kept in a separate field so the array length of
   * featured_labels always matches the headline count.
   */
  featured_labels_unavailable?: Array<{ name: string; hint: string }>;
  other_labels?: string[];
}

// Labels that are infrastructure-level and uninteresting to an SRE writing queries.
const INTERNAL_LABELS = new Set([
  '__name__', 'job', 'instance', 'TENX_Tenant', 'tenx_tenant',
]);

// Curated prefixes worth highlighting in the "what's queryable" response.
const FEATURED_LABELS = [
  { name: 'tenx_user_service', hint: 'the service that emitted the log' },
  { name: 'severity_level', hint: 'TRACE / DEBUG / INFO / WARN / ERROR / CRITICAL' },
  { name: 'message_pattern', hint: 'the stable pattern identity (symbolMessage; its hash is tenx_hash) — the unit of cost attribution' },
  { name: 'tenx_env', hint: 'edge or cloud' },
  { name: 'http_code', hint: 'HTTP response status (100–511)' },
  { name: 'k8s_namespace', hint: 'Kubernetes namespace (from enrichment)' },
  { name: 'k8s_container', hint: 'Kubernetes container name' },
  { name: 'k8s_pod', hint: 'Kubernetes pod name' },
  { name: 'country', hint: 'GeoIP-resolved country' },
  { name: 'continent', hint: 'GeoIP-resolved continent' },
  { name: 'symbol_origin', hint: 'source code file that emitted the log' },
];

function buildDiscoverLabelsHumanSummary(d: DiscoverLabelsSummary): string {
  if (d.mode === 'label_values') {
    if (d.total_count === 0) {
      return `Label "${d.label}" has no distinct values; check the label name or query in a different time window.`;
    }
    const shown = d.shown_count < d.total_count ? ` Showing ${d.shown_count} of ${d.total_count}.` : '';
    return `Label "${d.label}" has ${d.total_count} distinct value${d.total_count === 1 ? '' : 's'}.${shown} Sample: ${(d.values ?? []).slice(0, 3).join(', ')}.`;
  }
  // featured_labels now contains only available entries (available=true ones were kept).
  const featuredAvailable = d.featured_labels?.length ?? 0;
  const otherCount = d.other_labels?.length ?? 0;
  return `${d.total_count} queryable labels on this env: ${featuredAvailable} featured (use as filter keys) and ${otherCount} additional. Call again with a label name to enumerate its values.`;
}

export async function executeDiscoverLabels(
  args: { label?: string; limit?: number },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  const telemetry = newChassisTelemetry();
  const sumOut: { data?: DiscoverLabelsSummary; error?: PrimitiveError } = {};
  try {
    await executeDiscoverLabelsInner(args, env, sumOut);
  } catch (e) {
    sumOut.error = wrapBackendError(e);
  }

  if (sumOut.error) {
    const err = sumOut.error;
    return buildChassisEnvelope({
      tool: 'log10x_discover_labels',
      view: 'summary',
      headline: `discover_labels failed: ${err.error_type}`,
      status: 'error',
      decisions: { threshold_used: null, threshold_basis: 'default' },
      source_disclosure: { label_source: 'log10x_prom' },
      scope: { window: 'all', window_basis: 'auto_default' },
      payload: {},
      human_summary: `discover_labels failed: ${err.hint}`,
      error: err,
      telemetry,
    });
  }

  if (!sumOut.data) {
    // No data and no error — treat as unknown failure with a typed envelope
    // routed through wrapBackendError for consistency with the error path.
    const err = wrapBackendError(new Error('discover_labels inner produced no structured result'));
    return buildChassisEnvelope({
      tool: 'log10x_discover_labels',
      view: 'summary',
      headline: 'discover_labels returned no structured result.',
      status: 'error',
      decisions: { threshold_used: null, threshold_basis: 'default' },
      source_disclosure: { label_source: 'log10x_prom' },
      scope: { window: 'all', window_basis: 'auto_default' },
      payload: {},
      human_summary: 'discover_labels failed: inner produced no structured result.',
      error: err,
      telemetry,
    });
  }

  const d = sumOut.data;
  const humanSummary = buildDiscoverLabelsHumanSummary(d);

  const headline =
    d.mode === 'label_values'
      ? `Label "${d.label}": ${d.total_count} distinct value${d.total_count !== 1 ? 's' : ''}${d.shown_count < d.total_count ? ` (showing ${d.shown_count})` : ''}.`
      : `${d.total_count} queryable labels${d.featured_labels ? ` (${d.featured_labels.length} featured)` : ''}.`;

  return buildChassisEnvelope({
    tool: 'log10x_discover_labels',
    view: 'summary',
    headline,
    status: d.total_count > 0 ? 'success' : 'no_signal',
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {
      label_source: 'log10x_prom',
      ...(d.mode === 'label_values' && d.label === 'tenx_user_service'
        ? {
            service_count_source: {
              kind: 'raw_label_universe',
              count: d.total_count,
              denominator_meaning:
                'All distinct tenx_user_service values seen in the label universe (no volume floor)',
            },
          }
        : {}),
    },
    scope: {
      window: 'all',
      window_basis: 'auto_default',
      candidates_count: d.total_count,
      candidates_usable: d.shown_count,
    },
    payload: d,
    human_summary: humanSummary,
    truncated: d.mode === 'label_values' && d.shown_count < d.total_count,
    actions:
      d.mode === 'label_names'
        ? [
            { tool: 'log10x_discover_labels', args: { label: 'tenx_user_service' }, reason: 'list the services available as a filter scope' },
          ]
        : [],
    telemetry,
  });
}

async function executeDiscoverLabelsInner(
  args: { label?: string; limit?: number },
  env: EnvConfig,
  sumOut?: { data?: DiscoverLabelsSummary; error?: PrimitiveError }
): Promise<string> {
  const limit = args.limit ?? 100;
  // Mode 1: return values for a specific label.
  if (args.label) {
    let values: string[];
    try {
      values = await fetchLabelValues(env, args.label);
    } catch (e) {
      const err = wrapBackendError(e);
      if (sumOut) sumOut.error = err;
      return `Failed to fetch values for label "${args.label}": ${err.hint}`;
    }
    if (values.length === 0) {
      if (sumOut) sumOut.data = { mode: 'label_values', label: args.label, total_count: 0, shown_count: 0, values: [] };
      return `Label "${args.label}" has no values. Check the label name or try a different time range by querying a tool that accepts filters.`;
    }
    const shown = values.slice(0, limit);
    if (sumOut) sumOut.data = { mode: 'label_values', label: args.label, total_count: values.length, shown_count: shown.length, values: shown };
    const lines: string[] = [];
    lines.push(`Label "${args.label}" — ${values.length} distinct value${values.length !== 1 ? 's' : ''}${values.length > shown.length ? ` (showing ${shown.length})` : ''}`);
    lines.push('');
    for (const v of shown) lines.push(`  ${v}`);
    return lines.join('\n');
  }

  // Mode 2: return the full label list, with featured labels annotated.
  let all: string[];
  try {
    all = await fetchLabels(env);
  } catch (e) {
    const err = wrapBackendError(e);
    if (sumOut) sumOut.error = err;
    return `Failed to list labels: ${err.hint}`;
  }
  const queryable = all.filter((l) => !INTERNAL_LABELS.has(l)).sort();

  // Split featured labels into available (present in this env) and unavailable,
  // so featured_labels.length always equals the headline "N featured" count.
  const featuredAvail   = FEATURED_LABELS.filter((f) =>  queryable.includes(f.name)).map((f) => ({ name: f.name, hint: f.hint }));
  const featuredUnavail = FEATURED_LABELS.filter((f) => !queryable.includes(f.name)).map((f) => ({ name: f.name, hint: f.hint }));
  const rest = queryable.filter((l) => !FEATURED_LABELS.some((f) => f.name === l));

  if (sumOut) {
    sumOut.data = {
      mode: 'label_names',
      total_count: queryable.length,
      shown_count: queryable.length,
      featured_labels: featuredAvail,
      featured_labels_unavailable: featuredUnavail.length > 0 ? featuredUnavail : undefined,
      other_labels: rest,
    };
  }

  const lines: string[] = [];
  lines.push(`Queryable labels (${queryable.length})`);
  lines.push('');
  lines.push('Featured — use these as filter keys in log10x_top_patterns, log10x_metrics_that_moved, etc.:');
  for (const feat of featuredAvail) {
    lines.push(`  ${feat.name.padEnd(22)} ${feat.hint}`);
  }

  if (rest.length > 0) {
    lines.push('');
    lines.push(`Other labels (${rest.length}):`);
    lines.push(`  ${rest.join(', ')}`);
  }

  lines.push('');
  lines.push('Tip: call log10x_discover_labels with a specific label name (e.g., label="tenx_user_service") to list its distinct values.');

  lines.push('');
  lines.push(agentOnly(
    `Suggested next calls using these labels: ` +
    `Scope log10x_top_patterns to one label value → pass service: "..." or include the label in filter args. ` +
    `Cross-pillar investigation on a label-keyed customer metric → compose log10x_metrics_that_moved → log10x_rank_by_shape_similarity → log10x_metric_overlay.`
  ));

  return lines.join('\n');
}
