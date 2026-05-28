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
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';

export const discoverLabelsSchema = {
  label: z.string().optional().describe('If set, return distinct values for this label (e.g., "tenx_user_service" returns every service). If omitted, return the full label name list.'),
  limit: z.number().min(1).max(200).default(100).describe('Max values to return when a label is specified.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
  view: z.enum(['summary', 'markdown']).default('summary').describe('summary returns the typed envelope. markdown wraps the rendered list in data.markdown.'),
};

interface DiscoverLabelsSummary {
  mode: 'label_values' | 'label_names';
  label?: string;
  total_count: number;
  shown_count: number;
  values?: string[];
  featured_labels?: Array<{ name: string; hint: string; available: boolean }>;
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
  { name: 'message_pattern', hint: 'the stable template hash — the unit of cost attribution' },
  { name: 'tenx_env', hint: 'edge or cloud' },
  { name: 'http_code', hint: 'HTTP response status (100–511)' },
  { name: 'k8s_namespace', hint: 'Kubernetes namespace (from enrichment)' },
  { name: 'k8s_container', hint: 'Kubernetes container name' },
  { name: 'k8s_pod', hint: 'Kubernetes pod name' },
  { name: 'country', hint: 'GeoIP-resolved country' },
  { name: 'continent', hint: 'GeoIP-resolved continent' },
  { name: 'symbol_origin', hint: 'source code file that emitted the log' },
];

export async function executeDiscoverLabels(
  args: { label?: string; limit?: number; view?: 'summary' | 'markdown' },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  const view = args.view ?? 'summary';
  const sumOut: { data?: DiscoverLabelsSummary } = {};
  const md = await executeDiscoverLabelsInner(args, env, sumOut);
  if (view === 'markdown' || !sumOut.data) {
    return buildMarkdownEnvelope({
      tool: 'log10x_discover_labels',
      summary: { headline: md.split('\n').find((l) => l.trim().length > 0)?.slice(0, 200) ?? 'discover_labels result' },
      markdown: md,
    });
  }
  const d = sumOut.data;
  const headline =
    d.mode === 'label_values'
      ? `Label "${d.label}": ${d.total_count} distinct value${d.total_count !== 1 ? 's' : ''}${d.shown_count < d.total_count ? ` (showing ${d.shown_count})` : ''}.`
      : `${d.total_count} queryable labels${d.featured_labels ? ` (${d.featured_labels.filter((f) => f.available).length} featured)` : ''}.`;
  return buildEnvelope({
    tool: 'log10x_discover_labels',
    view: 'summary',
    summary: { headline },
    data: d,
    truncated: d.mode === 'label_values' && d.shown_count < d.total_count,
    actions:
      d.mode === 'label_names'
        ? [
            { tool: 'log10x_discover_labels', args: { label: 'tenx_user_service' }, reason: 'list the services available as a filter scope' },
          ]
        : [],
  });
}

async function executeDiscoverLabelsInner(
  args: { label?: string; limit?: number },
  env: EnvConfig,
  sumOut?: { data?: DiscoverLabelsSummary }
): Promise<string> {
  const limit = args.limit ?? 100;
  // Mode 1: return values for a specific label.
  if (args.label) {
    const values = await fetchLabelValues(env, args.label);
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
  const all = await fetchLabels(env);
  const queryable = all.filter((l) => !INTERNAL_LABELS.has(l)).sort();

  const featured = FEATURED_LABELS.map((feat) => ({ name: feat.name, hint: feat.hint, available: queryable.includes(feat.name) }));
  const rest = queryable.filter((l) => !FEATURED_LABELS.some((f) => f.name === l));

  if (sumOut) {
    sumOut.data = {
      mode: 'label_names',
      total_count: queryable.length,
      shown_count: queryable.length,
      featured_labels: featured,
      other_labels: rest,
    };
  }

  const lines: string[] = [];
  lines.push(`Queryable labels (${queryable.length})`);
  lines.push('');
  lines.push('Featured — use these as filter keys in log10x_top_patterns, log10x_metrics_that_moved, etc.:');
  for (const feat of featured) {
    if (feat.available) {
      lines.push(`  ${feat.name.padEnd(22)} ${feat.hint}`);
    }
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
