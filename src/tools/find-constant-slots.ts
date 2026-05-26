/**
 * log10x_find_constant_slots — surfaces slots that never vary
 * (compact-mode candidates).
 *
 * Stage 1: paste-mode only. Env-mode auto-pull is Stage 2.
 */

import { z } from 'zod';
import { extractPatterns } from '../lib/pattern-extraction.js';
import { findConstantSlots } from '../lib/detectors/constant-slots.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';

export const findConstantSlotsSchema = {
  events: z.array(z.unknown()).describe('Events to analyze. Same shape as log10x_resolve_batch.'),
  top_n: z.number().min(1).max(50).default(20).describe('Number of findings to return. Default 20.'),
  min_sample_count: z.number().min(1).default(10).describe('Minimum events per pattern. Default 10.'),
  view: z.enum(['summary', 'markdown']).default('summary'),
  privacy_mode: z.boolean().default(false),
};

export type FindConstantSlotsArgs = {
  events: unknown[];
  top_n?: number;
  min_sample_count?: number;
  view?: 'summary' | 'markdown';
  privacy_mode?: boolean;
};

export async function executeFindConstantSlots(args: FindConstantSlotsArgs): Promise<StructuredOutput> {
  const extraction = await extractPatterns(args.events, { privacyMode: args.privacy_mode });
  const findings = findConstantSlots(extraction.patterns, {
    topN: args.top_n ?? 20,
    minSampleCount: args.min_sample_count ?? 10,
  });

  const view = args.view ?? 'summary';

  if (view === 'markdown') {
    return buildMarkdownEnvelope({
      tool: 'log10x_find_constant_slots',
      summary: { headline: summaryHeadline(findings) },
      markdown: renderMarkdown(findings),
    });
  }

  return buildEnvelope({
    tool: 'log10x_find_constant_slots',
    view: 'summary',
    summary: {
      headline: summaryHeadline(findings),
      bullets: findings.slice(0, 3).map((f) =>
        `\`${f.patternIdentity}\`: ${f.constantSlots.length} constant slot${f.constantSlots.length === 1 ? '' : 's'} (${f.constantSlots.map((s) => `\`${s.slotName}\`=${JSON.stringify(s.constantValue)}`).join(', ')}) — compact saves ~${Math.round(f.estimatedCompactSavingsPct * 100)}%.`
      ),
    },
    data: { findings },
    actions: findings.slice(0, 3).map((f) => ({
      tool: 'log10x_pattern_mitigate',
      args: { pattern: f.patternIdentity },
      reason: `Apply compact mode at the receiver to strip ${f.constantSlots.length} constant slot(s).`,
    })),
  });
}

function summaryHeadline(findings: ReturnType<typeof findConstantSlots>): string {
  if (findings.length === 0) return 'No constant slots found.';
  const top = findings[0]!;
  return `${findings.length} pattern${findings.length === 1 ? '' : 's'} with constant slots. Top: \`${top.patternIdentity}\` has ${top.constantSlots.length} constant slot${top.constantSlots.length === 1 ? '' : 's'} (~${Math.round(top.estimatedCompactSavingsPct * 100)}% compact savings).`;
}

function renderMarkdown(findings: ReturnType<typeof findConstantSlots>): string {
  const lines: string[] = [];
  lines.push(`## Constant-slot findings`);
  lines.push('');
  if (findings.length === 0) {
    lines.push('_No constant slots found._');
    return lines.join('\n');
  }
  lines.push('| pattern | constant slots | sample count | est. compact savings |');
  lines.push('|---|---|---|---|');
  for (const f of findings) {
    const slots = f.constantSlots.map((s) => `\`${s.slotName}\`=${JSON.stringify(s.constantValue)}`).join('<br>');
    lines.push(
      `| \`${f.patternIdentity}\` | ${slots} | ${f.totalEvents} | ${Math.round(f.estimatedCompactSavingsPct * 100)}% |`
    );
  }
  return lines.join('\n');
}
