/**
 * log10x_find_uuid_in_body — flags patterns where a slot carries a
 * per-event unique value (UUID, ISO timestamp, hex ID) in the body.
 *
 * Stage 1: paste-mode only. Env-mode auto-pull is Stage 2.
 */

import { z } from 'zod';
import { extractPatterns } from '../lib/pattern-extraction.js';
import { findUuidInBody } from '../lib/detectors/uuid-in-body.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';

export const findUuidInBodySchema = {
  events: z.array(z.unknown()).describe('Events to analyze. Same shape as log10x_resolve_batch.'),
  top_n: z.number().min(1).max(50).default(20).describe('Number of findings to return. Default 20.'),
  cardinality_ratio_threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.9)
    .describe('Min distinct/event-count ratio for a slot to be flagged. Default 0.9.'),
  min_distinct_for_uuid: z
    .number()
    .min(1)
    .default(10)
    .describe('Minimum distinct value count required (anti-saturation). Default 10.'),
  view: z.enum(['summary', 'markdown']).default('summary'),
  privacy_mode: z.boolean().default(false),
};

export type FindUuidInBodyArgs = {
  events: unknown[];
  top_n?: number;
  cardinality_ratio_threshold?: number;
  min_distinct_for_uuid?: number;
  view?: 'summary' | 'markdown';
  privacy_mode?: boolean;
};

export async function executeFindUuidInBody(args: FindUuidInBodyArgs): Promise<StructuredOutput> {
  const extraction = await extractPatterns(args.events, { privacyMode: args.privacy_mode });
  const findings = findUuidInBody(extraction.patterns, {
    topN: args.top_n ?? 20,
    cardinalityRatioThreshold: args.cardinality_ratio_threshold ?? 0.9,
    minDistinctForUuid: args.min_distinct_for_uuid ?? 10,
  });

  const view = args.view ?? 'summary';

  if (view === 'markdown') {
    return buildMarkdownEnvelope({
      tool: 'log10x_find_uuid_in_body',
      summary: { headline: summaryHeadline(findings) },
      markdown: renderMarkdown(findings),
    });
  }

  return buildEnvelope({
    tool: 'log10x_find_uuid_in_body',
    view: 'summary',
    summary: {
      headline: summaryHeadline(findings),
      bullets: findings.slice(0, 3).map((f) => {
        const slot = f.uuidLikeSlots[0]!;
        return `\`${f.patternIdentity}\`: slot \`${slot.slotName}\` is ${slot.regexMatch}-shaped at ${Math.round(slot.cardinalityRatio * 100)}% cardinality. ${f.fixHint.slice(0, 120)}`;
      }),
    },
    data: { findings },
    actions: findings.slice(0, 3).map((f) => ({
      tool: 'log10x_pattern_mitigate',
      args: { pattern: f.patternIdentity },
      reason: `Promote uuid-like slot(s) to a structured label or strip from body.`,
    })),
  });
}

function summaryHeadline(findings: ReturnType<typeof findUuidInBody>): string {
  if (findings.length === 0) return 'No UUID-in-body anti-patterns found above the threshold.';
  const top = findings[0]!;
  const slot = top.uuidLikeSlots[0]!;
  return `${findings.length} UUID-in-body finding${findings.length === 1 ? '' : 's'}. Top: \`${top.patternIdentity}\` slot \`${slot.slotName}\` (${slot.regexMatch}).`;
}

function renderMarkdown(findings: ReturnType<typeof findUuidInBody>): string {
  const lines: string[] = [];
  lines.push(`## UUID-in-body findings`);
  lines.push('');
  if (findings.length === 0) {
    lines.push('_No UUID-in-body anti-patterns found above the threshold._');
    return lines.join('\n');
  }
  for (const f of findings) {
    lines.push(`### \`${f.patternIdentity}\``);
    lines.push('');
    lines.push('| slot | cardinality ratio | regex match | sample values |');
    lines.push('|---|---|---|---|');
    for (const s of f.uuidLikeSlots) {
      lines.push(
        `| \`${s.slotName}\` | ${Math.round(s.cardinalityRatio * 100)}% | ${s.regexMatch} | ${s.sampleValues.map((v) => `\`${v.slice(0, 40)}\``).join(', ')} |`
      );
    }
    lines.push('');
    lines.push(`**Fix hint**: ${f.fixHint}`);
    lines.push('');
  }
  return lines.join('\n');
}
