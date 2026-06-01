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
import { buildHashQuery } from '../lib/siem/hash-query.js';
import { fmtCount, normalizePattern } from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { tenxHash } from '../lib/pattern-hash.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { resolveHashFromPattern, resolvePatternFromHash } from '../lib/hash-resolve.js';
import { agentOnly } from '../lib/agent-only.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';

/**
 * Resolve a pattern's AUTHORITATIVE tenx_hash from the 10x metrics.
 *
 * The local `tenxHash(canonicalPattern)` hashes the snake_case pattern
 * NAME — but the engine's emitted `tenx_hash` (the value present in
 * both Prometheus AND the 10x-forwarded SIEM events) is
 * `PatternHashEncoder.encode(<symbol sequence of the actual event>)`,
 * a different input. They never match, so a hash-probe built from the
 * local hash silently falls back to fuzzy phrase-match. Resolving the
 * hash from the metrics label (same value the forwarder writes to the
 * SIEM) is what makes the exact-hash cross-pillar probe actually hit.
 * Returns undefined when the metrics don't carry the pattern (caller
 * falls back to the local hash, then to phrase tokens).
 */
async function resolvePatternHashFromMetrics(
  env: EnvConfig,
  canonicalPattern: string,
): Promise<string | undefined> {
  try {
    const metricsEnv = await resolveMetricsEnv(env);
    return await resolveHashFromPattern(env, canonicalPattern, metricsEnv);
  } catch {
    return undefined;
  }
}

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
    .optional()
    .describe(
      'Pattern name (Symbol Message, e.g. `Payment_Gateway_Timeout`) or a pasted raw log line. Pasted lines resolve to the matching pattern via the same templater path as log10x_resolve_batch. Omit when passing `tenxHash` instead.',
    ),
  tenxHash: z
    .string()
    .optional()
    .describe(
      'A `tenx_hash` value from log10x_top_patterns\' cross-pillar join keys, log10x_event_lookup, or seen on a SIEM/CloudWatch event. The moat path: the stamped identity is used directly as the exact SIEM probe key (no token guessing, no per-vendor query-syntax gaps) AND reverse-resolved to the pattern name for display. Prefer this over `pattern` whenever a hash is in hand.',
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
  view: z.enum(['summary', 'markdown']).default('summary').describe('Output format. summary returns structured envelope; markdown returns rendered buckets.'),
};

interface ProgressNote {
  step: string;
  pct: number;
  eventsFetched: number;
}

interface PatternExamplesArgs {
  pattern?: string;
  tenxHash?: string;
  vendor?: 'splunk' | 'datadog' | 'elasticsearch' | 'cloudwatch';
  service?: string;
  severity?: string;
  timeRange?: '15m' | '1h' | '6h' | '24h';
  limit?: number;
  scope?: string;
  environment?: string;
  view?: 'summary' | 'markdown';
}

interface PatternExamplesSummary {
  pattern: string;
  vendor: string;
  window: string;
  service?: string;
  severity?: string;
  probe_path: 'tenx_hash-exact' | 'content-token' | 'paste';
  events_pulled: number;
  distinct_templates: number;
  retained_events: number;
  retained_templates: number;
  dropped_jaccard_events: number;
  multi_line_detected: boolean;
  buckets: Array<{
    rank: number;
    template_hash: string;
    tenx_hash?: string;
    event_count: number;
    jaccard: number;
    severity?: string;
    service?: string;
    sample_event: string;
    slot_distribution: Array<{ slot: string; distinct_count: number; is_constant: boolean; sample_values: string[] }>;
  }>;
  probe_notes: string[];
}

export async function executePatternExamples(
  rawArgs: PatternExamplesArgs,
  env: EnvConfig,
): Promise<string | import('../lib/output-types.js').StructuredOutput> {
  const view = rawArgs.view ?? 'summary';
  const telemetry = newTelemetry();
  const sumOut: { data?: PatternExamplesSummary } = {};
  const md = await executePatternExamplesInner(rawArgs, env, sumOut);
  const { buildMarkdownEnvelope, buildEnvelope } = await import('../lib/output-types.js');
  if (view === 'markdown' || !sumOut.data) {
    return buildMarkdownEnvelope({
      tool: 'log10x_pattern_examples',
      summary: { headline: md.split('\n')[0]?.slice(0, 200) || 'pattern_examples result' },
      markdown: md,
    });
  }
  const d = sumOut.data;
  const headline = `\`${d.pattern}\` (${d.vendor}, ${d.window}): ${d.events_pulled} events pulled, ${d.retained_events} retained across ${d.retained_templates} templates via ${d.probe_path}`;
  // Truncation signal: the SIEM probe hit its limit (rawArgs.limit defaults to 5).
  // If events_pulled equals the requested limit, there are likely more matching
  // events the agent could see by widening the limit or narrowing the timeRange.
  const requestedLimit = rawArgs.limit ?? 5;
  const truncated = d.events_pulled >= requestedLimit;
  return buildEnvelope({
    tool: 'log10x_pattern_examples',
    view: 'summary',
    summary: { headline },
    data: { ...d, ...buildUnifiedFields({ status: 'success', telemetry, humanSummary: headline }) },
    truncated,
  });
}

async function executePatternExamplesInner(
  rawArgs: PatternExamplesArgs,
  env: EnvConfig,
  sumOut?: { data?: PatternExamplesSummary },
): Promise<string> {
  // Defensive defaults — match patternExamplesSchema. Tools dispatched
  // outside the MCP-SDK Zod boundary (chains, scripts, harness) can
  // land here with timeRange/limit unset; without these we'd hit
  // `${undefined}` template renders and `undefined * 5` NaN math.
  const args: Required<Pick<PatternExamplesArgs, 'timeRange' | 'limit'>> & PatternExamplesArgs = {
    ...rawArgs,
    timeRange: rawArgs.timeRange ?? '1h',
    limit: rawArgs.limit ?? 10,
  };
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

  // ── 2. Resolve pattern: provided hash vs pasted-line vs Symbol Message ──
  const providedHash = args.tenxHash?.trim() || undefined;
  if (!providedHash && !args.pattern) {
    return graceful('Pattern Examples: input required', [
      'Pass `pattern` (a Symbol Message or pasted log line) or `tenxHash` (a stamped pattern identity, e.g. from log10x_top_patterns or log10x_event_lookup).',
    ]);
  }
  const looksLikeRawLogLine =
    !providedHash && !!args.pattern && /\s/.test(args.pattern) && /["'{}:/]/.test(args.pattern);
  let canonicalPattern: string;       // Display label for output rendering.
  let probeTokenSource: string;       // String to derive probe tokens from.
  let inputTemplateBody: string | undefined;
  let inputTemplateHash: string | undefined;
  let resolvedFromHash: string | undefined;

  if (providedHash) {
    // Moat path: the caller already holds the stamped identity. Use it
    // directly as the exact SIEM probe key (no token guessing, no
    // per-vendor query gaps) and reverse-resolve it to the pattern name
    // for display, the same hash→name lookup event_lookup does.
    const metricsEnv = await resolveMetricsEnv(env);
    const named = await resolvePatternFromHash(env, providedHash, metricsEnv, '24h');
    canonicalPattern = named ?? `tenx_hash:${providedHash}`;
    probeTokenSource = canonicalPattern;
    resolvedFromHash = providedHash;
  } else if (looksLikeRawLogLine) {
    // Pasted-line input: templatize once via tenx to discover the input
    // event's templateHash. The hash is the verification key. The probe
    // tokens come from the SAMPLE EVENT's content (the original raw text),
    // not the template body — pattern-extraction.ts sometimes returns
    // `template: <hash>` instead of the actual template body when the
    // engine's template cache short-circuits the parser, so the sample
    // event is the only reliably-populated source of searchable words
    // for the probe.
    const rawLine = args.pattern as string; // guarded by looksLikeRawLogLine
    try {
      const resolved = await extractPatterns([rawLine], { privacyMode: true });
      if (resolved.patterns[0]) {
        const p = resolved.patterns[0];
        canonicalPattern = p.hash;
        probeTokenSource = p.sampleEvent || rawLine;
        inputTemplateBody = p.sampleEvent || rawLine;
        inputTemplateHash = p.hash;
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
    canonicalPattern = normalizePattern(args.pattern as string); // guarded above
    probeTokenSource = canonicalPattern; // tokens come from underscore-split below
  }

  // ── 3. Build per-vendor probe query ────────────────────────────────
  // Two paths:
  //   - Symbol Message input: split on `_`, drop short tokens, dedupe.
  //     Each token is a searchable phrase in the log analyzer.
  //   - Pasted-line input: extract content tokens from the template body
  //     (alphanumeric runs ≥ 2 chars, deduped). The body's literal tokens
  //     are what appears in actual log lines; the hash is opaque.
  let tokens: string[];
  if (looksLikeRawLogLine) {
    // Cap at 10 tokens — Datadog query DSL has ~2-3KB budget and other
    // vendors get noisy with too many AND clauses. Top 10 by length
    // (longer = more selective) is the heuristic.
    const all = Array.from(contentTokens(probeTokenSource)).filter((t) => t.length >= 3);
    tokens = all.sort((a, b) => b.length - a.length).slice(0, 10);
  } else {
    const rawTokens = canonicalPattern.split('_').filter((t) => t.length >= 2);
    tokens = Array.from(new Set(rawTokens));
  }
  if (tokens.length === 0) {
    return graceful('Pattern Examples — pattern has no usable tokens', [
      `The pattern \`${canonicalPattern}\` produced no tokens after normalization. Pass a real Symbol Message or pasted log line.`,
    ]);
  }
  const vendorQuery = buildVendorQuery(vendor, tokens, args.service, args.severity);

  // ── 4. Probe the SIEM ──────────────────────────────────────────────
  // Prefer an EXACT tenx_hash filter for Symbol-Message input: it is the
  // engine's portable pattern identity, so it pins exactly the events a
  // 10x-powered forwarder shipped — no token coincidence, no per-vendor
  // query-syntax gaps. Self-verifying capability detection: a non-empty
  // hash probe proves this env's SIEM carries tenx_hash; an empty one
  // falls back to the content-token query (env is on the no-hash plane).
  const probeNotes: string[] = [];
  const onProgress = (_p: ProgressNote): void => {
    /* swallow — we render summary at the end, not per-step */
  };
  const probeBatch = Math.max(args.limit * 5, 100);
  const doProbe = (q: string) =>
    connector.pullEvents({
      window: args.timeRange,
      scope: args.scope,
      query: q,
      targetEventCount: probeBatch,
      maxPullMinutes: 2,
      onProgress,
    });

  // Hash probe key, in priority order:
  //   1. a tenx_hash the caller passed, already the stamped identity,
  //      used verbatim (the moat path).
  //   2. for a Symbol Message: the authoritative hash from the metrics
  //      (the value the forwarder also wrote to the SIEM), falling back
  //      to the local pattern-name hash if the metrics don't carry it.
  //   3. for a pasted raw line: none, the hash isn't a reliable probe
  //      key, stay on content tokens.
  const hashKey = providedHash
    ? providedHash
    : looksLikeRawLogLine
      ? undefined
      : (await resolvePatternHashFromMetrics(env, canonicalPattern)) ?? tenxHash(canonicalPattern);
  const hashQuery = hashKey
    ? buildHashQuery(vendor, hashKey, args.service, args.severity)
    : undefined;

  // When the input was a bare tenx_hash that didn't reverse-resolve to a
  // name, the only "tokens" are from the `tenx_hash:<hash>` placeholder,
  // so the content-token fallback would search garbage. Skip it: the exact
  // hash probe is already authoritative; an empty result means the SIEM
  // doesn't carry this identity in-window, not that tokens would do better.
  const tokensAreUsable = !canonicalPattern.startsWith('tenx_hash:');
  let probe = await doProbe(hashQuery ?? vendorQuery);
  let probePath: 'tenx_hash-exact' | 'content-token' = hashQuery
    ? 'tenx_hash-exact'
    : 'content-token';
  if (hashQuery && probe.events.length === 0 && tokensAreUsable) {
    if (probe.metadata.notes) probeNotes.push(...probe.metadata.notes);
    probe = await doProbe(vendorQuery);
    probePath = 'content-token';
  }
  if (probe.metadata.notes) probeNotes.push(...probe.metadata.notes);

  if (probe.events.length === 0) {
    const lines: string[] = [
      `No events matched the probe in the ${args.timeRange} window on ${vendor}.`,
      `Query used: \`${probe.metadata.queryUsed || vendorQuery}\``,
    ];
    // Surface connector-level notes — rate limits, auth issues, partial
    // failures — so the agent can distinguish "no matching events" from
    // "couldn't query the SIEM at all." Empty-state without these notes
    // misleads chains: a 429-rate-limited probe looks identical to a
    // genuinely empty result.
    if (probeNotes.length > 0) {
      lines.push('');
      lines.push('### Probe notes');
      for (const n of probeNotes.slice(0, 5)) lines.push(`- ${n.slice(0, 200)}`);
      if (probeNotes.length > 5) lines.push(`- ... (${probeNotes.length - 5} more notes truncated)`);
    }
    lines.push('');
    lines.push('Try a longer `timeRange` (max 24h), or use `log10x_retriever_query` for events older than the analyzer\'s retention.');
    return graceful(`Pattern Examples — no events in ${args.timeRange} window`, lines);
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
  // Reference body = the input event's content (pasted-line case) or the
  // dominant returned bucket's sample event (Symbol Message case).
  // Sample events are used INSTEAD of template bodies because
  // pattern-extraction.ts sometimes populates `template` with just the
  // hash; sample events are reliably the original raw text.
  let referenceBody = inputTemplateBody;
  if (!referenceBody) {
    const dominant = extracted.patterns[0];
    referenceBody = dominant.sampleEvent || dominant.template;
    inputTemplateHash = dominant.hash;
  }
  const referenceTokens = contentTokens(referenceBody);

  // Group events by templateHash, attach Jaccard score against reference.
  const buckets = extracted.patterns.map((p) => {
    const bodySource = p.sampleEvent || p.template;
    const bodyTokens = contentTokens(bodySource);
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
      ...buckets.slice(0, 5).map((b) => `  - patternHash \`${(b.p.tenxHash ?? b.p.hash).slice(0, 12)}\`: ${b.p.count} events, jaccard=${b.jaccard.toFixed(2)} (threshold ${b.threshold})`),
    ]);
  }

  // Top 3 retained buckets.
  const topK = retained.slice(0, 3);
  const droppedFromTopK = retained.slice(3);

  // Populate typed summary for view='summary' callers.
  if (sumOut) {
    sumOut.data = {
      pattern: canonicalPattern,
      vendor,
      window: args.timeRange,
      service: args.service,
      severity: args.severity,
      probe_path: probePath,
      events_pulled: probe.events.length,
      distinct_templates: extracted.patterns.length,
      retained_events: retained.reduce((s, b) => s + b.p.count, 0),
      retained_templates: retained.length,
      dropped_jaccard_events: dropped.reduce((s, b) => s + b.p.count, 0),
      multi_line_detected: isMultiLine,
      buckets: topK.map((bucket, i) => ({
        rank: i + 1,
        template_hash: bucket.p.hash,
        tenx_hash: bucket.p.tenxHash,
        event_count: bucket.p.count,
        jaccard: bucket.jaccard,
        severity: bucket.p.severity,
        service: bucket.p.service,
        sample_event: bucket.p.sampleEvent.slice(0, 200),
        slot_distribution: Object.entries(bucket.p.variables)
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 6)
          .map(([slot, vals]) => ({
            slot,
            distinct_count: vals.length,
            is_constant: vals.length === 1,
            sample_values: vals.slice(0, 3),
          })),
      })),
      probe_notes: probeNotes.slice(0, 5),
    };
  }

  // ── 7. Render output ───────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`## Pattern Examples — ${vendor}`);
  lines.push('');
  if (resolvedFromHash) {
    lines.push(`**Resolved** tenx_hash \`${resolvedFromHash}\` → \`${canonicalPattern}\``);
  }
  lines.push(`**Pattern**: \`${canonicalPattern}\``);
  lines.push(`**Window**: last ${args.timeRange}${args.service ? ` · service=${args.service}` : ''}${args.severity ? ` · severity=${args.severity}` : ''}`);
  lines.push(`**Probe**: ${fmtCount(probe.events.length)} events pulled · ${extracted.patterns.length} distinct templates`);
  lines.push(
    probePath === 'tenx_hash-exact'
      ? agentOnly(
          `Probe path: tenx_hash-exact (filter ${hashQuery}). These events were pinned by the engine's portable pattern hash, so this env's SIEM carries tenx_hash — exact cross-pillar joins and forwarder-native drops by tenx_hash are available here. Prefer tenx_hash over message regex for any follow-up SIEM filter on this env.`,
        )
      : agentOnly(
          `Probe path: content-token (tenx_hash not present in this env's SIEM events, or pasted-line input). Results are phrase-match approximate; exact-hash correlation is unavailable on this env's data plane — do not claim hash-based precision.`,
        ),
  );
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
  // Gloss the hash once: a human seeing "patternHash a1b2c3…" needs to know
  // what it is before the buckets below.
  lines.push('_Buckets group the matched events by `patternHash` (the engine\'s portable pattern fingerprint); the slot table in each shows what varies within that pattern._');
  lines.push('');

  for (let i = 0; i < topK.length; i++) {
    const bucket = topK[i];
    const p = bucket.p;
    const eventsToShow = Math.min(args.limit, p.count);
    lines.push(`### Bucket ${i + 1}: patternHash \`${(p.tenxHash ?? p.hash).slice(0, 16)}\` (${fmtCount(p.count)} events, jaccard=${bucket.jaccard.toFixed(2)})`);
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
    lines.push(`_${fmtCount(droppedCount)} additional events from ${droppedFromTopK.length} additional patternHash bucket(s) not shown (only top 3 by count rendered)._`);
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
      // ES query_string syntax. Bare quoted phrases search the default
      // field (typically all text fields) — works across the common
      // shipper conventions: `log` for OTel/k8s/fluent-bit envelopes,
      // `message` for direct ingest, `_raw` for Splunk-forwarder shape.
      // Hardcoding `message:` would miss `log`-field logs entirely.
      const parts: string[] = [...phrases];
      if (service) parts.push(`service: "${service}"`);
      if (severity) parts.push(`severity: "${severity}"`);
      return parts.join(' AND ');
    }
    case 'cloudwatch': {
      // CloudWatch FilterLogEvents pattern syntax — quoted phrases
      // joined with implicit AND. The previous code emitted Logs
      // Insights syntax (`@message like /.../`), which the
      // FilterLogEvents API rejects with "Invalid character(s) in
      // term '@'". See eval/gaps/MCP_cloudwatch_filterpattern_syntax_mismatch.md
      // for the full diagnosis. Filter-pattern reference:
      // https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html
      const quotedPhrases = tokens.map((t) => `"${t.replace(/"/g, '\\"')}"`);
      const parts: string[] = quotedPhrases;
      if (severity) parts.push(`"${severity.replace(/"/g, '\\"')}"`);
      return parts.join(' ');
    }
    default:
      return phrases.join(' ');
  }
}

// buildHashQuery moved to ../lib/siem/hash-query.js (shared with
// event_lookup's reverse-lookup live sample). Imported at the top.

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
