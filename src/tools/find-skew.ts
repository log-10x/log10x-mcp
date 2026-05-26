/**
 * log10x_find_skew — surfaces patterns where one slot value dominates
 * (sampling opportunity).
 *
 * Stage 1 implementation: accepts an `events` paste (the same shape as
 * `log10x_resolve_batch`) and runs the local templater + skew detector.
 * Env-mode auto-pull (query Prometheus for top patterns, fetch sample
 * events, run detector) is a follow-up feature in Stage 2.
 */

import { z } from 'zod';
import { extractPatterns } from '../lib/pattern-extraction.js';
import { findSkew } from '../lib/detectors/skew.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';

export const findSkewSchema = {
  events: z
    .array(z.unknown())
    .describe(
      'Events to analyze for slot skew. Same shape as log10x_resolve_batch — raw strings or JSON objects. Each event is templated locally; skew is computed across the resulting patterns.'
    ),
  min_concentration: z
    .number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe('Minimum dominant-value fraction for a slot to be flagged as skewed. Default 0.6 (a slot is "skewed" when one value is 60%+ of events).'),
  top_n: z.number().min(1).max(50).default(20).describe('Number of findings to return. Default 20.'),
  min_events: z.number().min(1).default(10).describe('Minimum events per pattern to bother checking. Default 10 (filters low-sample noise).'),
  sample_n: z.number().min(2).default(10).describe('Sampling rate N for the savings projection (1/N of the dominant case kept). Default 10.'),
  view: z.enum(['summary', 'markdown']).default('summary'),
  privacy_mode: z.boolean().default(false).describe('Route events through a locally-installed tenx CLI instead of the paste Lambda.'),
};

export type FindSkewArgs = {
  events: unknown[];
  min_concentration?: number;
  top_n?: number;
  min_events?: number;
  sample_n?: number;
  view?: 'summary' | 'markdown';
  privacy_mode?: boolean;
};

export async function executeFindSkew(args: FindSkewArgs): Promise<StructuredOutput> {
  const extraction = await extractPatterns(args.events, { privacyMode: args.privacy_mode });
  const findings = findSkew(extraction.patterns, {
    minConcentration: args.min_concentration ?? 0.6,
    topN: args.top_n ?? 20,
    minEvents: args.min_events ?? 10,
    sampleN: args.sample_n ?? 10,
  });

  const view = args.view ?? 'summary';

  if (view === 'markdown') {
    const md = renderMarkdown(findings, args);
    return buildMarkdownEnvelope({
      tool: 'log10x_find_skew',
      summary: { headline: summaryHeadline(findings) },
      markdown: md,
    });
  }

  return buildEnvelope({
    tool: 'log10x_find_skew',
    view: 'summary',
    summary: {
      headline: summaryHeadline(findings),
      bullets: findings.slice(0, 3).map((f) => {
        const top = f.skewedSlots[0]!;
        return `\`${f.patternIdentity}\`: slot \`${top.slotName}\` is \`${top.dominantValue}\` ${Math.round(top.dominantPct * 100)}% of events — sample at 1/${args.sample_n ?? 10} saves ~${Math.round(f.samplingOpportunityPct * 100)}% of bytes.`;
      }),
    },
    data: { findings },
    actions: findings.slice(0, 3).map((f) => ({
      tool: 'log10x_pattern_mitigate',
      args: { pattern: f.patternIdentity },
      reason: `Apply sample 1/${args.sample_n ?? 10} on the dominant value for this pattern.`,
    })),
  });
}

function summaryHeadline(findings: ReturnType<typeof findSkew>): string {
  if (findings.length === 0) return 'No skewed slots found above the threshold.';
  const top = findings[0]!;
  const slot = top.skewedSlots[0]!;
  return `${findings.length} skew finding${findings.length === 1 ? '' : 's'}. Top: \`${top.patternIdentity}\` slot \`${slot.slotName}\` is \`${slot.dominantValue}\` ${Math.round(slot.dominantPct * 100)}% of events.`;
}

function renderMarkdown(findings: ReturnType<typeof findSkew>, args: FindSkewArgs): string {
  const lines: string[] = [];
  lines.push(`## Skew findings (min concentration ${args.min_concentration ?? 0.6})`);
  lines.push('');
  if (findings.length === 0) {
    lines.push('_No skewed slots found above the threshold._');
    return lines.join('\n');
  }
  lines.push('| pattern | top skewed slot | dominant value | dominant % | sampling opportunity (1/N) |');
  lines.push('|---|---|---|---|---|');
  for (const f of findings) {
    const slot = f.skewedSlots[0]!;
    lines.push(
      `| \`${f.patternIdentity}\` | \`${slot.slotName}\` | \`${slot.dominantValue}\` | ${Math.round(slot.dominantPct * 100)}% | ${Math.round(f.samplingOpportunityPct * 100)}% |`
    );
  }
  return lines.join('\n');
}
