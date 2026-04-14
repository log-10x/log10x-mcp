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

export const discoverLabelsSchema = {
  label: z.string().optional().describe('If set, return distinct values for this label (e.g., "tenx_user_service" returns every service). If omitted, return the full label name list.'),
  limit: z.number().min(1).max(200).default(100).describe('Max values to return when a label is specified.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
};

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
  args: { label?: string; limit: number },
  env: EnvConfig
): Promise<string> {
  // Mode 1: return values for a specific label.
  if (args.label) {
    const values = await fetchLabelValues(env, args.label);
    if (values.length === 0) {
      return `Label "${args.label}" has no values. Check the label name or try a different time range by querying a tool that accepts filters.`;
    }
    const shown = values.slice(0, args.limit);
    const lines: string[] = [];
    lines.push(`Label "${args.label}" — ${values.length} distinct value${values.length !== 1 ? 's' : ''}${values.length > shown.length ? ` (showing ${shown.length})` : ''}`);
    lines.push('');
    for (const v of shown) lines.push(`  ${v}`);
    return lines.join('\n');
  }

  // Mode 2: return the full label list, with featured labels annotated.
  const all = await fetchLabels(env);
  const queryable = all.filter(l => !INTERNAL_LABELS.has(l)).sort();

  const lines: string[] = [];
  lines.push(`Queryable labels (${queryable.length})`);
  lines.push('');
  lines.push('Featured — use these as filter keys in log10x_cost_drivers, log10x_list_by_label, etc.:');
  for (const feat of FEATURED_LABELS) {
    if (queryable.includes(feat.name)) {
      lines.push(`  ${feat.name.padEnd(22)} ${feat.hint}`);
    }
  }

  const rest = queryable.filter(l => !FEATURED_LABELS.some(f => f.name === l));
  if (rest.length > 0) {
    lines.push('');
    lines.push(`Other labels (${rest.length}):`);
    lines.push(`  ${rest.join(', ')}`);
  }

  lines.push('');
  lines.push('Tip: call log10x_discover_labels with a specific label name (e.g., label="tenx_user_service") to list its distinct values.');

  return lines.join('\n');
}
