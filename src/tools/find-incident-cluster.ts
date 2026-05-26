/**
 * log10x_find_incident_cluster — groups patterns by shared root-cause
 * descriptor text. Surfaces "fix one thing, kill N patterns" findings.
 *
 * Stage 1: paste-mode. Caller provides patterns directly OR raw events
 * to template. Env-mode auto-pull (query Prometheus for top patterns,
 * call detector across them with their descriptors and trend curves)
 * is Stage 2.
 */

import { z } from 'zod';
import { extractPatterns } from '../lib/pattern-extraction.js';
import { detectIncidents, type IncidentInput } from '../lib/detectors/incident-cluster.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';

export const findIncidentClusterSchema = {
  events: z.array(z.unknown()).describe('Events to template and cluster. Same shape as log10x_resolve_batch.'),
  service: z
    .string()
    .optional()
    .describe('Filter clustering to one service (templater extracts the service per event; this gates which extracted patterns enter the clustering).'),
  view: z.enum(['summary', 'markdown']).default('summary'),
  privacy_mode: z.boolean().default(false),
};

export type FindIncidentClusterArgs = {
  events: unknown[];
  service?: string;
  view?: 'summary' | 'markdown';
  privacy_mode?: boolean;
};

export async function executeFindIncidentCluster(args: FindIncidentClusterArgs): Promise<StructuredOutput> {
  const extraction = await extractPatterns(args.events, { privacyMode: args.privacy_mode });
  // Convert ExtractedPatterns to IncidentInput. Cost per month is not
  // computable from a paste alone; we use bytes as the ranking proxy
  // so the most-volume pattern's descriptor wins as representative.
  const filtered = args.service
    ? extraction.patterns.filter((p) => p.service === args.service)
    : extraction.patterns;
  const inputs: IncidentInput[] = filtered.map((p) => ({
    identity: p.symbolMessage ?? p.hash,
    service: p.service,
    descriptor: p.symbolMessage ?? p.template ?? p.hash,
    // Use bytes as a proxy for cost. The caller can pair this output
    // with log10x_top_patterns to attach real $/mo per identity.
    costPerMonthUsd: p.bytes,
  }));
  const clusters = detectIncidents(inputs);

  const view = args.view ?? 'summary';

  if (view === 'markdown') {
    return buildMarkdownEnvelope({
      tool: 'log10x_find_incident_cluster',
      summary: { headline: summaryHeadline(clusters) },
      markdown: renderMarkdown(clusters),
    });
  }

  return buildEnvelope({
    tool: 'log10x_find_incident_cluster',
    view: 'summary',
    summary: {
      headline: summaryHeadline(clusters),
      bullets: clusters.slice(0, 3).map((c) =>
        `${c.members.length} patterns in service \`${c.service}\` share root cause "${c.representativeLabel.slice(0, 80)}" (signal: ${c.joinSignal}, confidence ${c.confidence.toFixed(2)}).`
      ),
      callout: clusters.length > 0 ? 'Fix the source once instead of dropping each pattern individually.' : undefined,
    },
    data: {
      clusters,
      unclusteredCount: inputs.length - clusters.reduce((s, c) => s + c.members.length, 0),
    },
    actions: clusters.slice(0, 3).flatMap((c) =>
      c.members.slice(0, 1).map((m) => ({
        tool: 'log10x_pattern_mitigate',
        args: { pattern: m.identity },
        reason: `Mitigate the highest-cost member of cluster "${c.representativeLabel.slice(0, 60)}".`,
      }))
    ),
  });
}

function summaryHeadline(clusters: ReturnType<typeof detectIncidents>): string {
  if (clusters.length === 0) return 'No incident clusters found.';
  const top = clusters[0]!;
  return `${clusters.length} incident cluster${clusters.length === 1 ? '' : 's'} found. Top: ${top.members.length} patterns in \`${top.service}\` share root cause.`;
}

function renderMarkdown(clusters: ReturnType<typeof detectIncidents>): string {
  const lines: string[] = [];
  lines.push(`## Incident clusters`);
  lines.push('');
  if (clusters.length === 0) {
    lines.push('_No incident clusters found._');
    return lines.join('\n');
  }
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i]!;
    lines.push(`### Cluster ${i + 1}: \`${c.representativeLabel.slice(0, 80)}\``);
    lines.push(`Service: \`${c.service}\` · members: ${c.members.length} · join: \`${c.joinSignal}\` · confidence: ${c.confidence.toFixed(2)}`);
    lines.push('');
    lines.push('| member | descriptor |');
    lines.push('|---|---|');
    for (const m of c.members) {
      lines.push(`| \`${m.identity}\` | ${m.descriptor.slice(0, 100)} |`);
    }
    lines.push('');
  }
  lines.push('**Fix the source once instead of dropping each pattern individually.**');
  return lines.join('\n');
}
