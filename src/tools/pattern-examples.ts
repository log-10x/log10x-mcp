/**
 * log10x_pattern_examples — return recent live events for a pattern with
 * template-extracted slot values per match.
 *
 * Orchestration primitive, not user-callable in practice. Intended to be
 * called by `log10x_investigate` (or another orchestrator) after a metric
 * tier identification when the chain needs event evidence to form a
 * hypothesis.
 *
 * Design contract (committed in
 * memory/project_pattern_examples_design.md):
 *   - Inputs: Symbol Message (pattern name) OR pasted log line.
 *   - Bounded to 24h window, log analyzer retention.
 *   - For older / archive use log10x_retriever_query.
 *   - Mechanism: SIEM phrase-search probe → tenx → group by templateHash
 *     → content-token Jaccard ≥ 0.85 to discriminate → top 3 buckets by
 *     event count.
 *   - Honest output: per-bucket templateHash labels, recall counts,
 *     parseFailed markers when slot extraction fails per event.
 *   - Multi-line group templates: head-line-only with explicit warning,
 *     detected via input_line_count vs encoded.log_row_count delta.
 *
 * Read the planning doc before changing this tool's contract. Several
 * positions were retracted during design (template_hash indexed-field
 * fast path, dashboard parity claim, hard-error on Symbol Message
 * ambiguity) — see the retracted-positions section.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { extractPatterns } from '../lib/pattern-extraction.js';
import { resolveSiemSelection } from '../lib/siem/resolve.js';
import { getConnector, type SiemConnector } from '../lib/siem/index.js';
import type { SiemId } from '../lib/siem/pricing.js';
import { fmtCount, normalizePattern } from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';

/** SIEM vendors supported by pattern_examples. Inherits from the dep-check / exclusion-filter list. */
const EXAMPLES_VENDORS: readonly SiemId[] = [
  'splunk',
  'datadog',
  'elasticsearch',
  'cloudwatch',
] as const;

export const patternExamplesSchema = {
  pattern: z
    .string()
    .describe(
      'Pattern name (Symbol Message, e.g. `Payment_Gateway_Timeout`) or a pasted raw log line. Pasted lines resolve to the matching pattern via the same templater path as log10x_resolve_batch. Required.',
    ),
  vendor: z
    .enum(['splunk', 'datadog', 'elasticsearch', 'cloudwatch'])
    .optional()
    .describe(
      'Log analyzer to search. Auto-detected when exactly one of the supported vendors has credentials in the env; pass explicitly when multiple are configured.',
    ),
  service: z
    .string()
    .optional()
    .describe('Optional service-name scope. Translated to the vendor-specific service filter.'),
  severity: z
    .string()
    .optional()
    .describe('Optional severity scope (e.g., `ERROR`, `WARN`).'),
  timeRange: z
    .enum(['15m', '1h', '6h', '24h'])
    .default('1h')
    .describe('Window for the live SIEM probe. Capped at 24h. For older events, use log10x_retriever_query.'),
  limit: z
    .number()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of sample events per templateHash bucket. 1-50, default 10.'),
  scope: z
    .string()
    .optional()
    .describe(
      'Vendor-specific scope (Splunk index, Datadog index, ES index pattern, CloudWatch log group). Defaults to a sensible per-vendor value when omitted.',
    ),
  environment: z.string().optional().describe('Environment nickname.'),
};

interface ProgressNote {
  step: string;
  pct: number;
  eventsFetched: number;
}

interface PatternExamplesArgs {
  pattern: string;
  vendor?: 'splunk' | 'datadog' | 'elasticsearch' | 'cloudwatch';
  service?: string;
  severity?: string;
  timeRange: '15m' | '1h' | '6h' | '24h';
  limit: number;
  scope?: string;
  environment?: string;
}

export async function executePatternExamples(
  args: PatternExamplesArgs,
  _env: EnvConfig,
): Promise<string> {
  // ── 1. Resolve vendor ──────────────────────────────────────────────
  const resolution = await resolveSiemSelection({
    explicit: args.vendor,
    restrictTo: [...EXAMPLES_VENDORS],
  });
  if (resolution.kind === 'none') {
    return [
      '## Pattern Examples — vendor required',
      '',
      `No SIEM credentials detected and no \`vendor\` arg supplied. Pass \`vendor=<name>\` (one of: ${EXAMPLES_VENDORS.join(', ')}) and corresponding env vars.`,
      '',
      `_Probed: ${resolution.probedIds.join(', ')}._`,
    ].join('\n');
  }
  if (resolution.kind === 'ambiguous') {
    return [
      '## Pattern Examples — vendor ambiguous',
      '',
      `Multiple log analyzers detected: ${resolution.candidates.join(', ')}. Pass \`vendor=<name>\` to disambiguate.`,
    ].join('\n');
  }
  const vendor = resolution.id;
  const connector = getConnector(vendor);

  // ── 2. Resolve pattern: pasted-line vs Symbol Message ──────────────
  const looksLikeRawLogLine = /\s/.test(args.pattern) && /["'{}:/]/.test(args.pattern);
  let canonicalPattern: string;
  let inputTemplateBody: string | undefined;
  let inputTemplateHash: string | undefined;

  if (looksLikeRawLogLine) {
    // Pasted-line input: templatize once via tenx to discover the input
    // event's templateHash and template body. The body is the reference
    // for Jaccard discrimination; the hash is the verification key.
    try {
      const resolved = await extractPatterns([args.pattern], { privacyMode: true });
      if (resolved.patterns[0]) {
        canonicalPattern = resolved.patterns[0].hash;
        inputTemplateBody = resolved.patterns[0].template;
        inputTemplateHash = resolved.patterns[0].hash;
      } else {
        return graceful('Pattern Examples — could not resolve pasted log line', [
          'The templater returned no patterns for the pasted line. Verify the line is well-formed and contains at least one recurring symbol.',
        ]);
      }
    } catch (e) {
      return graceful('Pattern Examples — pasted-line resolution failed', [
        `tenx CLI invocation failed: ${(e as Error).message.slice(0, 200)}`,
        '',
        'Either install tenx locally or pass the Symbol Message form (snake_case identity) instead of a raw log line.',
      ]);
    }
  } else {
    canonicalPattern = normalizePattern(args.pattern);
  }

  // ── 3. Build per-vendor probe query ────────────────────────────────
  // Split on underscores, drop short tokens, dedupe (case-sensitive — the
  // pattern often has the same word repeated, which adds no selectivity to
  // the AND query and just bloats the parser-cost). Symbol Messages from
  // the engine for templates that emit multiple distinct symbols still
  // contribute meaningfully; pure repetition gets collapsed.
  const rawTokens = canonicalPattern.split('_').filter((t) => t.length >= 2);
  const tokens = Array.from(new Set(rawTokens));
  if (tokens.length === 0) {
    return graceful('Pattern Examples — pattern has no usable tokens', [
      `The pattern \`${canonicalPattern}\` produced no tokens after normalization. Pass a real Symbol Message or pasted log line.`,
    ]);
  }
  const vendorQuery = buildVendorQuery(vendor, tokens, args.service, args.severity);

  // ── 4. Probe the SIEM ──────────────────────────────────────────────
  const probeNotes: string[] = [];
  const onProgress = (_p: ProgressNote): void => {
    /* swallow — we render summary at the end, not per-step */
  };
  const probeBatch = Math.max(args.limit * 5, 100);
  const probe = await connector.pullEvents({
    window: args.timeRange,
    scope: args.scope,
    query: vendorQuery,
    targetEventCount: probeBatch,
    maxPullMinutes: 2,
    onProgress,
  });
  if (probe.metadata.notes) probeNotes.push(...probe.metadata.notes);

  if (probe.events.length === 0) {
    return graceful(`Pattern Examples — no events in ${args.timeRange} window`, [
      `No events matched the probe in the ${args.timeRange} window on ${vendor}.`,
      `Query used: \`${probe.metadata.queryUsed || vendorQuery}\``,
      '',
      'Try a longer `timeRange` (max 24h), or use `log10x_retriever_query` for events older than the analyzer\'s retention.',
    ]);
  }

  // ── 5. Templatize the probe batch ──────────────────────────────────
  const inputLineCount = probe.events.length;
  let extracted;
  try {
    extracted = await extractPatterns(probe.events, { privacyMode: true });
  } catch (e) {
    return graceful('Pattern Examples — templater invocation failed', [
      `tenx CLI failed on ${probe.events.length} events: ${(e as Error).message.slice(0, 200)}`,
      '',
      'Verify tenx is installed (`brew install log-10x/tap/log10x`) or set `LOG10X_TENX_MODE=docker`.',
    ]);
  }

  // Multi-line detection: when the engine groups multiple input lines
  // into fewer encoded events, the input was multi-line (stack trace etc).
  const encodedEventCount = extracted.totalEvents;
  const isMultiLine = encodedEventCount < inputLineCount && inputLineCount > 1;

  if (extracted.patterns.length === 0) {
    return graceful('Pattern Examples — no templates resolved', [
      `Pulled ${probe.events.length} events but the templater produced no templates. The events may be malformed or the tenx version may not support this format.`,
    ]);
  }

  // ── 6. Discriminate by content-token Jaccard ───────────────────────
  // Reference body = the input pattern's template body when we have a
  // pasted line; otherwise pick the dominant template from the probe
  // (Symbol Message input case — top-3 fan-out fallback).
  let referenceBody = inputTemplateBody;
  if (!referenceBody) {
    const dominant = extracted.patterns[0];
    referenceBody = dominant.template;
    inputTemplateHash = dominant.hash;
  }
  const referenceTokens = contentTokens(referenceBody);

  // Group events by templateHash, attach Jaccard score against reference.
  const buckets = extracted.patterns.map((p) => {
    const bodyTokens = contentTokens(p.template);
    const jaccard = jaccardSimilarity(referenceTokens, bodyTokens);
    const threshold = Math.min(referenceTokens.size, bodyTokens.size) < 8 ? 0.7 : 0.85;
    return { p, jaccard, threshold, kept: jaccard >= threshold };
  });

  const retained = buckets.filter((b) => b.kept).sort((a, b) => b.p.count - a.p.count);
  const dropped = buckets.filter((b) => !b.kept);

  if (retained.length === 0) {
    return graceful('Pattern Examples — no matching templates', [
      `Probe returned ${probe.events.length} events spanning ${extracted.patterns.length} templates, but none matched the reference template at content-token Jaccard ≥ 0.85.`,
      '',
      'The pattern may not be active in this window, or the input pattern doesn\'t correspond to events in the requested timeRange.',
      '',
      'Drop counts by Jaccard:',
      ...buckets.slice(0, 5).map((b) => `  - templateHash \`${b.p.hash.slice(0, 12)}\`: ${b.p.count} events, jaccard=${b.jaccard.toFixed(2)} (threshold ${b.threshold})`),
    ]);
  }

  // Top 3 retained buckets.
  const topK = retained.slice(0, 3);
  const droppedFromTopK = retained.slice(3);

  // ── 7. Render output ───────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`## Pattern Examples — ${vendor}`);
  lines.push('');
  lines.push(`**Pattern**: \`${canonicalPattern}\``);
  lines.push(`**Window**: last ${args.timeRange}${args.service ? ` · service=${args.service}` : ''}${args.severity ? ` · severity=${args.severity}` : ''}`);
  lines.push(`**Probe**: ${fmtCount(probe.events.length)} events pulled · ${extracted.patterns.length} distinct templates`);
  lines.push(`**Retained**: ${fmtCount(retained.reduce((s, b) => s + b.p.count, 0))} events across ${retained.length} matching templates (Jaccard ≥ threshold)`);
  if (dropped.length > 0) {
    const droppedCount = dropped.reduce((s, b) => s + b.p.count, 0);
    lines.push(`**Dropped on Jaccard**: ${fmtCount(droppedCount)} events from ${dropped.length} unrelated templates`);
  }
  if (isMultiLine) {
    lines.push('');
    lines.push('> **Multi-line detected**: the engine grouped multiple input lines into fewer encoded events. Showing head lines only; continuation frames (e.g. stack-trace `at ` lines) live separately in the analyzer and are not joined here.');
  }
  lines.push('');

  for (let i = 0; i < topK.length; i++) {
    const bucket = topK[i];
    const p = bucket.p;
    const eventsToShow = Math.min(args.limit, p.count);
    lines.push(`### Bucket ${i + 1}: templateHash \`${p.hash.slice(0, 16)}\` (${fmtCount(p.count)} events, jaccard=${bucket.jaccard.toFixed(2)})`);
    lines.push('');
    if (p.severity) lines.push(`**Severity**: ${p.severity}`);
    if (p.service) lines.push(`**Service**: ${p.service}`);
    lines.push(`**Sample event** (truncated to 200 chars):`);
    lines.push('```');
    lines.push(p.sampleEvent.slice(0, 200));
    lines.push('```');
    if (Object.keys(p.variables).length > 0) {
      const slotsByCount = Object.entries(p.variables)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 6);
      lines.push('**Slot distribution** (top 6 by distinct count):');
      for (const [slot, vals] of slotsByCount) {
        const distinct = vals.length === 1 ? 'constant' : `${vals.length} distinct`;
        const sample = vals.slice(0, 3).map((v) => `\`${v.slice(0, 30)}\``).join(', ');
        lines.push(`  - \`${slot}\` (${distinct}): ${sample}${vals.length > 3 ? `, …` : ''}`);
      }
    }
    lines.push('');
    if (i === 0 && eventsToShow < p.count) {
      lines.push(`_Showing slot summary; ${fmtCount(p.count)} matching events available. Use log10x_retriever_query for full event payload retrieval._`);
      lines.push('');
    }
  }

  if (droppedFromTopK.length > 0) {
    const droppedCount = droppedFromTopK.reduce((s, b) => s + b.p.count, 0);
    lines.push(`_${fmtCount(droppedCount)} additional events from ${droppedFromTopK.length} additional templateHash bucket(s) not shown (only top 3 by count rendered)._`);
    lines.push('');
  }

  if (probeNotes.length > 0) {
    lines.push('### Probe notes');
    for (const n of probeNotes) lines.push(`- ${n}`);
    lines.push('');
  }

  // ── 8. Structured NEXT_ACTIONS ─────────────────────────────────────
  const nextActions: NextAction[] = [
    {
      tool: 'log10x_dependency_check',
      args: { pattern: canonicalPattern },
      reason: 'check dashboards / alerts before any mute action',
    },
    {
      tool: 'log10x_pattern_trend',
      args: { pattern: canonicalPattern },
      reason: 'see the volume trend for this pattern',
    },
  ];
  // If multi-line, point at retriever_query for full-trace history.
  if (isMultiLine) {
    nextActions.push({
      tool: 'log10x_retriever_query',
      args: { pattern: canonicalPattern, from: 'now-7d', to: 'now', limit: 50 },
      reason: 'multi-line composites — retriever has the complete grouped events',
    });
  }
  const block = renderNextActions(nextActions);
  if (block) lines.push(block);

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a vendor-specific phrase-AND query from the pattern tokens. */
function buildVendorQuery(
  vendor: SiemId,
  tokens: string[],
  service?: string,
  severity?: string,
): string {
  const phrases = tokens.map((t) => `"${t.replace(/"/g, '\\"')}"`);
  switch (vendor) {
    case 'splunk': {
      // SPL: phrases AND'd by default. Service/severity filters are
      // user-namespaced fields.
      const parts: string[] = [...phrases];
      if (service) parts.push(`tenx_user_service="${service}"`);
      if (severity) parts.push(`severity_level="${severity}"`);
      return parts.join(' ');
    }
    case 'datadog': {
      // Datadog DSL: phrases AND'd by space.
      const parts: string[] = [...phrases];
      if (service) parts.push(`service:${service}`);
      if (severity) parts.push(`status:${severity.toLowerCase()}`);
      return parts.join(' ');
    }
    case 'elasticsearch': {
      // KQL: explicit AND on the message field.
      const parts: string[] = phrases.map((p) => `message: ${p}`);
      if (service) parts.push(`service: "${service}"`);
      if (severity) parts.push(`severity: "${severity}"`);
      return parts.join(' AND ');
    }
    case 'cloudwatch': {
      // Insights: filter @message like /escaped/ AND ...
      const escapedPhrases = tokens.map((t) => {
        const escaped = t.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
        return `@message like /${escaped}/`;
      });
      const parts: string[] = escapedPhrases;
      if (severity) parts.push(`@message like /${severity.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')}/`);
      return parts.join(' and ');
    }
    default:
      return phrases.join(' ');
  }
}

/**
 * Extract content-only alphanumeric tokens from a template body.
 *
 * Strips JSON envelope keys via the same field-priority list coerceToLine
 * uses (`.log`, `.message`, `attributes.message`, `_raw`). When the body
 * is bare (no envelope), uses it directly. Tokenizes on non-alphanumeric
 * runs ≥ 2 chars, deduped — matches the templater's symbol tokenization.
 */
function contentTokens(templateBody: string): Set<string> {
  if (!templateBody) return new Set();
  // Try to peel out the inner log-content field if the body looks JSON.
  const trimmed = templateBody.trim();
  let content = trimmed;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const inner =
        (parsed?.log as string) ||
        (parsed?.message as string) ||
        (parsed?.attributes?.message as string) ||
        (parsed?._raw as string);
      if (typeof inner === 'string' && inner.length > 0) content = inner;
    } catch {
      /* not strict JSON — use as-is */
    }
  }
  return new Set(
    content
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2),
  );
}

/** Compute Jaccard similarity between two token sets. Returns 0..1. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function graceful(title: string, lines: string[]): string {
  return [`## ${title}`, '', ...lines].join('\n');
}

// Exported for tests.
export const __testables = {
  buildVendorQuery,
  contentTokens,
  jaccardSimilarity,
};
