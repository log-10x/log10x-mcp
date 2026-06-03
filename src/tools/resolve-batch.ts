/**
 * log10x_resolve_batch — templatize a batch of events and return per-pattern triage.
 *
 * The tool accepts raw events from three sources (file path, inline array,
 * or a Bash-fetched SIEM dump — the model provides the text) and runs the
 * Log10x templater on the batch via the paste Lambda (default) or a local
 * `tenx` CLI when the caller requests privacy_mode.
 *
 * Output is a structured markdown report ranking patterns by interestingness
 * (volume × severity × variable-concentration strength), with per-pattern
 * variable concentrations computed across the batch and next-action
 * suggestions for follow-up via log10x_investigate, log10x_retriever_query,
 * or native SIEM commands.
 */

import { promises as fs } from 'fs';
import { z } from 'zod';
import { submitPaste, PASTE_MAX_BYTES, type PasteResponse } from '../lib/paste-api.js';
import { runDevCli, DevCliNotInstalledError, DevCliRunError } from '../lib/dev-cli.js';
import { agentOnly } from '../lib/agent-only.js';
import {
  parseTemplates,
  parseEncoded,
  parseAggregated,
  type AggregatedRow,
} from '../lib/cli-output-parser.js';
import { computeConcentration, type PatternConcentration } from '../lib/variable-concentration.js';
import { fmtCount, fmtBytes } from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { type StructuredOutput } from '../lib/output-types.js';
import { buildNotConfiguredEnvelope } from '../lib/not-configured.js';
import { newChassisTelemetry, buildChassisEnvelope } from '../lib/chassis-envelope.js';

export const resolveBatchSchema = {
  source: z
    .enum(['file', 'events', 'text'])
    .optional()
    .describe('Optional — auto-inferred from whichever of `events` / `text` / `path` you actually provide, so you normally do not set it. Provide explicitly only to disambiguate when more than one is present.'),
  path: z.string().optional().describe('Local file path when source=file. Required for file mode.'),
  events: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .describe('Inline log lines: an array of lines, or a single newline-separated string (both accepted). `source` need not be set.'),
  text: z.string().optional().describe('Raw text blob when source=text — newline-separated log events.'),
  top_n_patterns: z.number().min(1).max(50).default(20).describe('How many patterns to return in the ranked triage.'),
  include_next_actions: z.boolean().default(true).describe('Whether to generate next_action suggestions for each top pattern.'),
  environment: z.string().optional().describe('Environment nickname — used to build next_actions that call log10x_investigate.'),
  privacy_mode: z.boolean().default(true).describe('When true (default), the batch is processed by a locally-installed `tenx` CLI — events never leave the machine. Set to false to route through the public Log10x paste Lambda instead (100 KB limit, requires network). If the local CLI is not installed, the call surfaces a typed not_configured envelope with an install hint.'),
};

interface ResolveBatchSummary {
  input_line_count: number;
  input_bytes: number;
  resolved_pattern_count: number;
  shown_pattern_count: number;
  accounted_events: number;
  dropped_events: number;
  drop_rate: number;
  execution_mode: 'local_cli' | 'paste_lambda';
  cli_wall_time_ms: number;
  severity_mix: Record<string, number>;
  overfit_warning: boolean;
  human_summary: string;
  patterns: Array<{
    rank: number;
    template_hash: string;
    symbol_message?: string;
    template: string;
    event_count: number;
    share_pct: number;
    interestingness: number;
    dominant_severity?: string;
    severity_distribution: Record<string, number>;
    slots: Array<{
      slot_index: number;
      inferred_name: string;
      naming_confidence: 'high' | 'medium' | 'low';
      distinct_count: number;
      top_values: Array<{ value: string; pct: number }>;
    }>;
  }>;
}

/**
 * Three-sentence plain-prose distillation of a successful resolve_batch
 * run. No markdown syntax, no dollar figures. Mirrors the canonical
 * buildHumanSummary pattern in src/tools/find-skew.ts:216.
 */
function buildResolveBatchHumanSummary(d: Omit<ResolveBatchSummary, 'human_summary'>): string {
  const top = d.patterns[0];
  const patternsWord = d.resolved_pattern_count === 1 ? 'pattern' : 'patterns';
  const first = `Resolved ${fmtCount(d.input_line_count)} events into ${d.resolved_pattern_count} ${patternsWord} via the ${d.execution_mode === 'local_cli' ? 'local tenx CLI' : 'paste Lambda'} (wall time ${d.cli_wall_time_ms}ms).`;
  const second = top
    ? `The top contributor is ${top.symbol_message ?? top.template_hash} at ${Math.round(top.share_pct)}% of the batch${top.dominant_severity ? `, dominant severity ${top.dominant_severity}` : ''}.`
    : 'No ranked patterns were produced.';
  const third = d.drop_rate >= 0.2
    ? `Warning: the templater dropped ${Math.round(d.drop_rate * 100)}% of input lines (engine GAPS G11) — treat as a partial triage.`
    : d.overfit_warning
      ? 'Tiny-batch note: every event resolved to its own template; paste at least 50 events for a converged triage.'
      : `${d.shown_pattern_count} of ${d.resolved_pattern_count} ${patternsWord} shown in the ranked output.`;
  return `${first} ${second} ${third}`;
}

export async function executeResolveBatch(args: {
  source?: 'file' | 'events' | 'text';
  path?: string;
  events?: string[] | string;
  text?: string;
  top_n_patterns: number;
  include_next_actions: boolean;
  environment?: string;
  privacy_mode: boolean;
  view?: 'summary';
}): Promise<string | StructuredOutput> {
  const telemetry = newChassisTelemetry();
  const sumOut: { data?: Omit<ResolveBatchSummary, 'human_summary'> } = {};
  try {
    await executeResolveBatchInner(args, sumOut);
  } catch (e) {
    if (e instanceof DevCliNotInstalledError) {
      return buildNotConfiguredEnvelope({
        tool: 'log10x_resolve_batch',
        kind: 'generic',
        remediation: e.message,
      });
    }
    throw e;
  }
  if (!sumOut.data) {
    const headline = 'resolve_batch returned no patterns';
    return buildChassisEnvelope({
      tool: 'log10x_resolve_batch',
      view: 'summary',
      headline,
      status: 'no_signal',
      decisions: { threshold_used: null, threshold_basis: 'default' },
      source_disclosure: {},
      scope: { window: 'paste_batch', window_basis: 'auto_default' },
      payload: { precondition: 'no_patterns' },
      human_summary: headline,
      warnings: ['resolve_batch: templater rejected the input — no patterns resolved. Check that events are raw log lines (one per line), not pre-formatted JSON blobs.'],
    });
  }
  const base = sumOut.data;
  const human_summary = buildResolveBatchHumanSummary(base);
  const d: ResolveBatchSummary = { ...base, human_summary };
  const top = d.patterns[0];
  const dropWarning = d.drop_rate >= 0.2 ? ` (${Math.round(d.drop_rate * 100)}% of input lines dropped by templater)` : '';
  const headline = `${fmtCount(d.input_line_count)} events → ${d.resolved_pattern_count} pattern${d.resolved_pattern_count !== 1 ? 's' : ''}${top ? `, top: ${top.symbol_message ?? top.template_hash} at ${Math.round(top.share_pct)}% of batch` : ''}${dropWarning}.`;
  return buildChassisEnvelope({
    tool: 'log10x_resolve_batch',
    view: 'summary',
    headline,
    status: d.resolved_pattern_count > 0 ? 'success' : 'no_signal',
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {},
    scope: {
      window: 'paste_batch',
      window_basis: 'auto_default',
      candidates_count: d.resolved_pattern_count,
      candidates_usable: d.resolved_pattern_count,
    },
    payload: d,
    human_summary,
    truncated: d.shown_pattern_count < d.resolved_pattern_count,
    warnings: d.drop_rate >= 0.2 ? [`templater dropped ${Math.round(d.drop_rate * 100)}% of input lines (engine GAPS G11) — treat as partial triage`] : [],
    actions: top && top.symbol_message
      ? [
          { tool: 'log10x_event_lookup', args: { pattern: top.symbol_message }, reason: 'look up the top pattern against the live Reporter' },
          { tool: 'log10x_investigate', args: { starting_point: top.symbol_message }, reason: 'causal-chain investigation on the top pattern' },
        ]
      : [],
  });
}

async function executeResolveBatchInner(args: {
  source?: 'file' | 'events' | 'text';
  path?: string;
  events?: string[] | string;
  text?: string;
  top_n_patterns: number;
  include_next_actions: boolean;
  environment?: string;
  privacy_mode: boolean;
}, sumOut?: { data?: Omit<ResolveBatchSummary, 'human_summary'> }): Promise<string> {
  // ── 1. Materialize input text ──
  const text = await materialize(args);
  if (!text || text.trim().length === 0) {
    // KEEP: schema-violation (missing input). Caught by wrap() in src/index.ts.
    throw new Error('No events provided. Pass source=file with path, source=events with an events array, or source=text with raw text.');
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  const lineCount = text.split('\n').filter((l) => l.trim().length > 0).length;
  if (lineCount === 0) {
    // KEEP: schema-violation (empty input). Caught by wrap().
    throw new Error('Input contained no non-empty lines.');
  }

  // ── 2. Run the templater ──
  // Two execution paths:
  //   - privacy_mode: true  → local `tenx` CLI, events never leave the machine
  //   - privacy_mode: false → public paste Lambda (default), 100 KB limit
  let resp: PasteResponse;
  let cliWallTimeMs: number;
  let executionMode: 'local_cli' | 'paste_lambda';

  if (args.privacy_mode) {
    try {
      const local = await runDevCli(text);
      resp = {
        'templates.json': local.templatesJson,
        'encoded.log': local.encodedLog,
        'aggregated.csv': local.aggregatedCsv,
      };
      cliWallTimeMs = local.wallTimeMs;
      executionMode = 'local_cli';
    } catch (e) {
      if (e instanceof DevCliNotInstalledError) {
        // PORT: precondition (local tenx CLI not installed). Rethrow so the
        // outer executeResolveBatch catches at the tool boundary and converts
        // to buildNotConfiguredEnvelope (kind='generic'). The chokepoint
        // doesn't need a framework name-match — the boundary catch keeps the
        // not-configured contract self-contained to this tool.
        throw e;
      }
      if (e instanceof DevCliRunError) {
        // KEEP: internal-state (CLI ran, returned non-zero). Caught by wrap().
        throw new Error(
          `Local tenx CLI exited with code ${e.exitCode}.\n` +
            `Config: ${e.configPath}\n` +
            `${e.stderr.slice(0, 2000)}`
        );
      }
      // KEEP: internal-state (CLI invocation failed unexpectedly). Caught by wrap().
      throw new Error(`Local tenx CLI run failed: ${(e as Error).message}`);
    }
  } else {
    if (bytes > PASTE_MAX_BYTES) {
      // KEEP: schema-violation (input size limit). Caught by wrap().
      throw new Error(
        `Batch too large: ${(bytes / 1024).toFixed(1)} KB exceeds the 100 KB paste Lambda limit. ` +
          `Trim to ~1-2K events, paginate across multiple calls, or set privacy_mode=true to route through ` +
          `a locally-installed tenx CLI (no 100 KB limit).`
      );
    }
    const started = Date.now();
    resp = await submitPaste(text);
    cliWallTimeMs = Date.now() - started;
    executionMode = 'paste_lambda';
  }

  // ── 3. Parse outputs ──
  const templates = parseTemplates(resp['templates.json']);
  const encoded = parseEncoded(resp['encoded.log']);
  const aggregated = parseAggregated(resp['aggregated.csv']);

  if (templates.size === 0 || encoded.length === 0) {
    return `No patterns resolved from ${lineCount} line(s). The templater may have rejected the input — check that the events are raw log lines (one per line) and not pre-formatted JSON blobs.`;
  }

  // ── 4. Per-pattern concentration ──
  // minCount: 1 so single-occurrence patterns still surface — concentration
  // math is degenerate for a single event but the caller still wants to see it.
  const concentrations = computeConcentration(encoded, templates, { topN: 3, minCount: 1 });

  // ── 5. Merge in severity from aggregated.csv ──
  // aggregated.csv is keyed by `message_pattern` (a symbolMessage-style name)
  // and the paste Lambda does NOT emit it in the same order as templates.json.
  // We also can't compute the exact canonical because the Reporter's identity
  // rule strips some literal values (e.g., `tenant=a` → `tenant`) that are
  // visible in the template body. The robust match is **token-set Jaccard
  // similarity**: compute a loose token set for each template body, compare
  // against the token set of each aggregated row, keep the best match above
  // a minimum threshold.
  const aggTokenized = aggregated.map((r) => ({ row: r, tokens: tokenize(r.pattern) }));
  for (const p of concentrations) {
    const tpl = templates.get(p.templateHash);
    if (!tpl) continue;
    const templateTokens = tokenize(canonicalizeToSymbolMessage(tpl.template));
    const best = bestJaccardMatch(templateTokens, aggTokenized);
    if (best) {
      if (best.row.severity) {
        p.dominantSeverity = best.row.severity;
        p.severityDistribution[best.row.severity.toUpperCase()] = p.count;
      }
      p.symbolMessage = p.symbolMessage || best.row.pattern;
    }
  }

  // ── 6. Rank patterns by interestingness ──
  const totalEvents = encoded.length;
  const ranked = [...concentrations]
    .map((p) => ({ p, score: interestingnessScore(p, totalEvents) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, args.top_n_patterns);

  // ── 7. Render markdown triage ──
  const lines: string[] = [];
  lines.push(`## Batch Triage`);
  lines.push('');
  const modeLabel = executionMode === 'local_cli' ? 'local tenx CLI (privacy mode — no network egress)' : 'Log10x paste endpoint';

  // G11 mitigation: the engine-side templatizer has a known bug where it
  // silently drops input lines — up to ~70% of a 30-line batch on the
  // otel-demo env. The tool previously trusted `concentrations` as the
  // authoritative count without comparing against `lineCount`. That meant
  // the header said "30 events, resolved into 7 patterns" even when those
  // 7 patterns only accounted for 9 events — 21 input lines silently
  // vanished with no warning. This mitigation compares the sum of pattern
  // counts against the input line count and surfaces any gap as an
  // explicit "uncategorized events" number so a caller cannot be misled.
  // Does NOT fix the underlying templatizer; the engine team owns G11.
  const accountedEvents = encoded.length;
  const droppedEvents = Math.max(0, lineCount - accountedEvents);
  const dropRate = lineCount > 0 ? droppedEvents / lineCount : 0;

  lines.push(
    `${fmtCount(lineCount)} events, resolved into ${concentrations.length} distinct pattern${concentrations.length === 1 ? '' : 's'}. ` +
      `Templater wall time: ${cliWallTimeMs}ms. Input size: ${fmtBytes(bytes)}. Execution: ${modeLabel}.`
  );
  if (droppedEvents > 0) {
    const pctLabel = `${Math.round(dropRate * 100)}%`;
    if (dropRate >= 0.2) {
      lines.push('');
      // User-visible: the data-quality fact. The user must see this.
      lines.push(
        `> **${fmtCount(droppedEvents)} input lines (${pctLabel}) were not accounted for by the templatizer.** ` +
          `Per-pattern event counts sum to ${fmtCount(accountedEvents)}, less than the input line count (${fmtCount(lineCount)}). ` +
          `Known engine-side bug (GAPS G11) — the templatizer silently drops lines under certain conditions ` +
          `(multi-line stack traces, event-boundary crossings, high-cardinality variant overfitting). ` +
          `The dropped lines may contain the most important signals.`
      );
      // Agent-only: behavior constraints + the specific workaround tool calls.
      lines.push(agentOnly(
        `Constraint: do not treat this batch as a complete triage when drop_rate ≥ 20%. ` +
        `Workarounds to surface: (1) resubmit with top_n_patterns: 50 to widen the filter; ` +
        `(2) split the batch into halves and compare; ` +
        `(3) for incident response, use log10x_event_lookup on a specific line rather than trusting batch output.`
      ));
    } else if (dropRate >= 0.05) {
      lines.push(
        `_Note: ${fmtCount(droppedEvents)} lines (${pctLabel}) were not accounted for by the templatizer. Minor drop, likely tiny-batch overfitting._`
      );
    }
  }
  lines.push('');

  const distByAll = totalSeverityDistribution(concentrations);
  if (Object.keys(distByAll).length > 0) {
    const parts = Object.entries(distByAll)
      .sort((a, b) => b[1] - a[1])
      .map(([sev, n]) => `${sev}: ${fmtCount(n)}`);
    lines.push(`**Severity mix**: ${parts.join(' · ')}`);
    lines.push('');
  }

  // Tiny-batch warning: when every event resolves to its own pattern and the
  // template bodies are mostly the same tokens, the templater saw too few
  // samples to identify which tokens vary. That's not a bug — the templater
  // is statistical and needs repeated occurrences per slot to generalize.
  // With a 5-event batch of 5 distinct templates, one-slot variations (e.g.
  // user names) stay baked into the template body and inflate pattern count.
  const overfit = detectOverfittedBatch(concentrations, totalEvents);
  if (overfit) {
    lines.push(
      `> **Tiny-batch note**: ${concentrations.length} distinct templates ` +
      `across ${totalEvents} events with ~${Math.round(overfit.sharedPct * 100)}% token overlap ` +
      `between pairs suggests the templater had too few samples to generalize ` +
      `variable slots. Recurring tokens (usernames, order IDs, short identifiers) ` +
      `stay in the template body without repeated occurrences to mark them as ` +
      `variables. For statistically-converged templates on the same events, ` +
      `use \`log10x_top_patterns\` / \`log10x_event_lookup\` against the live ` +
      `Reporter — the production pipeline has seen millions of samples and ` +
      `generalizes cleanly. For one-shot batch triage, pasting ≥50 events tends ` +
      `to cross the templater's confidence floor.`
    );
    lines.push('');
  }

  lines.push(`### Top ${ranked.length} patterns by interestingness`);
  lines.push('');
  lines.push(agentOnly(
    `Correlation: the \`templateHash\` shown below is a LOCAL templating identity for this paste. ` +
    `It is NOT the live Prometheus \`tenx_hash\`. The live pipeline hashes the forwarder-wrapped ` +
    `envelope; a raw paste hashes differently, so a paste hash and a live tenx_hash never match ` +
    `by construction. To check live state, correlate by PATTERN (the pattern text shown for each ` +
    `entry) via log10x_top_patterns / log10x_event_lookup — do NOT pass any hash from this output ` +
    `as a tenxHash/pattern filter; that lookup will always return no-match and must not be read as ` +
    `"signal absent".`
  ));
  lines.push('');

  for (let i = 0; i < ranked.length; i++) {
    const { p, score } = ranked[i];
    const pctOfBatch = ((p.count / totalEvents) * 100).toFixed(p.count / totalEvents < 0.1 ? 1 : 0);
    const name = p.symbolMessage || summarizeTemplate(p.template);
    lines.push(`**#${i + 1}  ${name}**  · ${fmtCount(p.count)} events (${pctOfBatch}% of batch) · interestingness ${score.toFixed(2)}`);
    lines.push(`\`${p.templateHash}\` — ${truncate(p.template, 140)}`);
    if (p.dominantSeverity) {
      lines.push(`severity: ${p.dominantSeverity}`);
    }

    // Concentration block — only surface if there's real concentration signal
    const strong = p.slots.filter((s) => s.topValues[0] && s.topValues[0].pct >= 0.2);
    if (strong.length > 0) {
      lines.push('');
      lines.push('Variable concentration (top values within this batch):');
      for (const slot of strong.slice(0, 3)) {
        const confidence = slot.namingConfidence === 'high'
          ? ''
          : slot.namingConfidence === 'medium'
          ? ' _(name inferred — medium confidence)_'
          : ' _(no semantic name — low confidence)_';
        const label = `${slot.inferredName}${confidence}`;
        const topValsStr = slot.topValues
          .map((v) => `\`${truncate(v.value, 60)}\` ${(v.pct * 100).toFixed(0)}%`)
          .join(', ');
        lines.push(`  - ${label} · ${slot.distinctCount} distinct · ${topValsStr}`);
      }
    }

    if (args.include_next_actions) {
      lines.push('');
      const actions = buildNextActions(p, args.environment);
      lines.push(agentOnly(`Suggested next calls: ${actions.join(' ')}`));
    }
    lines.push('');
  }

  // ── 8. Closing summary ──
  if (concentrations.length > ranked.length) {
    const leftover = concentrations.length - ranked.length;
    lines.push(`_${leftover} additional pattern${leftover === 1 ? '' : 's'} not shown. Increase \`top_n_patterns\` to see them._`);
    lines.push('');
  }

  // Structured NEXT_ACTIONS for autonomous chains. Emits one investigate
  // call per top-3 pattern plus the strongest variable-filtered retriever
  // suggestion when a symbolMessage is available. Suppresses the retriever
  // suggestion when symbolMessage is missing because the retriever scopes
  // on tenx_user_pattern, not on templateHash.
  if (args.include_next_actions) {
    const block = renderNextActions(buildStructuredNextActions(ranked.map((r) => r.p), args.environment));
    if (block) lines.push(block);
  }

  if (sumOut) {
    sumOut.data = {
      input_line_count: lineCount,
      input_bytes: bytes,
      resolved_pattern_count: concentrations.length,
      shown_pattern_count: ranked.length,
      accounted_events: accountedEvents,
      dropped_events: droppedEvents,
      drop_rate: dropRate,
      execution_mode: executionMode,
      cli_wall_time_ms: cliWallTimeMs,
      severity_mix: totalSeverityDistribution(concentrations),
      overfit_warning: !!overfit,
      patterns: ranked.map(({ p, score }, i) => ({
        rank: i + 1,
        template_hash: p.templateHash,
        symbol_message: p.symbolMessage || undefined,
        template: p.template,
        event_count: p.count,
        share_pct: totalEvents > 0 ? (p.count / totalEvents) * 100 : 0,
        interestingness: score,
        dominant_severity: p.dominantSeverity || undefined,
        severity_distribution: p.severityDistribution,
        slots: p.slots.map((slot, slotIdx) => ({
          slot_index: slotIdx,
          inferred_name: slot.inferredName,
          naming_confidence: slot.namingConfidence,
          distinct_count: slot.distinctCount,
          top_values: slot.topValues.map((v) => ({ value: v.value, pct: v.pct })),
        })),
      })),
    };
  }

  return lines.join('\n');
}

// ── Input materialization ──

async function materialize(args: {
  source?: 'file' | 'events' | 'text';
  path?: string;
  events?: string[] | string;
  text?: string;
}): Promise<string> {
  // Tolerant input resolution. Cold agents routinely mismatch the
  // `source` discriminator against which of path/events/text they
  // populated (the prior hard-fail cost a wasted round-trip per the
  // hero-eval finding). Infer intent from what is actually present and
  // coerce the common shape slip (`events` passed as one string). Only
  // hard-fail when genuinely nothing usable was passed — and then with
  // a concrete example.
  const events: string[] | undefined = Array.isArray(args.events)
    ? args.events
    : typeof args.events === 'string' && args.events.trim().length > 0
      ? args.events.split('\n')
      : undefined;
  const hasEvents = !!events && events.length > 0;
  const hasText = typeof args.text === 'string' && args.text.trim().length > 0;
  const hasPath = typeof args.path === 'string' && args.path.trim().length > 0;

  // Honor an explicit source only when its payload is actually present;
  // otherwise fall through to inference so a mislabeled call still works.
  if (args.source === 'file' && hasPath) return fs.readFile(args.path as string, 'utf8');
  if (args.source === 'events' && hasEvents) return (events as string[]).join('\n');
  if (args.source === 'text' && hasText) return args.text as string;

  // Inference: use whatever payload was provided.
  if (hasEvents) return (events as string[]).join('\n');
  if (hasText) return args.text as string;
  if (hasPath) return fs.readFile(args.path as string, 'utf8');

  // KEEP: schema-violation (no input variant present). Caught by wrap().
  throw new Error(
    'No usable input. Provide exactly one of: `events` (array of log lines), ' +
      '`text` (newline-separated string), or `path` (local file). ' +
      '`source` is optional and auto-inferred. ' +
      'Example: {"events":["2026-... ERROR line one","2026-... ERROR line two"]}.'
  );
}

// ── Ranking ──

/**
 * Detect a batch where the templater was statistically under-sampled.
 *
 * Signal: N_templates == N_events (every event is its own template) AND the
 * average pairwise token overlap between template bodies is high (the
 * templates differ by only one or two tokens — a name, an ID). This is the
 * classic "I pasted 5 lines and got 5 templates back" case. The templater
 * correctly preserves identity on small samples; the note is advisory.
 *
 * Returns null when the batch doesn't match the signature (so the note is
 * suppressed). Returns { sharedPct } with the observed pairwise-Jaccard mean
 * when the note applies.
 */
function detectOverfittedBatch(
  concentrations: PatternConcentration[],
  totalEvents: number
): { sharedPct: number } | null {
  if (concentrations.length < 2) return null;
  if (concentrations.length !== totalEvents) return null;
  if (totalEvents > 20) return null;

  const tokenSets = concentrations.map((p) => tokenize(p.template));
  let pairCount = 0;
  let totalJaccard = 0;
  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      totalJaccard += jaccard(tokenSets[i], tokenSets[j]);
      pairCount++;
    }
  }

  if (pairCount === 0) return null;
  const sharedPct = totalJaccard / pairCount;
  if (sharedPct < 0.5) return null;

  return { sharedPct };
}

function interestingnessScore(p: PatternConcentration, totalEvents: number): number {
  const volumeScore = Math.min(p.count / totalEvents, 1) * 0.4;
  const severityScore = severityWeight(p.dominantSeverity) * 0.3;
  const concentrationScore = p.maxConcentration * 0.2;
  const distinctScore = p.slots.length > 0 ? Math.min(p.slots.length / 6, 1) * 0.1 : 0;
  return volumeScore + severityScore + concentrationScore + distinctScore;
}

function severityWeight(sev?: string): number {
  if (!sev) return 0.4;
  const s = sev.toUpperCase();
  if (s.startsWith('FATAL') || s.startsWith('CRIT')) return 1.0;
  if (s.startsWith('ERROR') || s === 'ERR') return 0.85;
  if (s.startsWith('WARN')) return 0.6;
  if (s.startsWith('INFO')) return 0.35;
  if (s.startsWith('DEBUG') || s.startsWith('TRACE')) return 0.15;
  return 0.4;
}

function totalSeverityDistribution(patterns: PatternConcentration[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of patterns) {
    for (const [sev, n] of Object.entries(p.severityDistribution)) {
      out[sev] = (out[sev] || 0) + n;
    }
  }
  return out;
}

// ── Next actions ──

function buildNextActions(p: PatternConcentration, environment?: string): string[] {
  const actions: string[] = [];
  const identity = p.symbolMessage || p.templateHash;
  const envArg = environment ? `, environment: '${environment}'` : '';
  actions.push(
    `call \`log10x_investigate({ starting_point: '${identity}'${envArg} })\` for historical correlation (requires Reporter tier).`
  );

  // Variable-filtered Retriever query suggestion — skip typed slots like timestamps
  // where filtering on a literal value is almost never what the user wants.
  // Skip the retriever suggestion entirely when symbolMessage is missing
  // because the retriever scopes by `tenx_user_pattern` (the Reporter-tier
  // pattern name), not by templateHash. Suggesting `pattern: '<hash>'` would
  // produce `tenx_user_pattern == "<hash>"` which never matches.
  const strong = p.slots.find(
    (s) =>
      s.topValues[0] &&
      s.topValues[0].pct >= 0.3 &&
      s.namingConfidence !== 'low' &&
      s.inferredName !== 'timestamp'
  );
  if (strong && strong.topValues[0] && p.symbolMessage) {
    const slot = strong.inferredName.replace(/\s*\(inferred\)$/i, '');
    const val = strong.topValues[0].value;
    const jsFilter = `event.${slot} === ${JSON.stringify(val)}`;
    actions.push(
      `call \`log10x_retriever_query({ pattern: '${p.symbolMessage}', filters: [${JSON.stringify(jsFilter)}] })\` to retrieve all historical events concentrated on ${slot}=${truncate(val, 40)} (requires Retriever tier).`
    );
    actions.push(
      `native Datadog follow-up: \`dog log search '@${slot}:"${val.replace(/"/g, '\\"')}"' --from now-24h\` — filters to the dominant variable concentration directly in the SIEM.`
    );
  }

  return actions;
}

/**
 * Structured NEXT_ACTIONS for autonomous-chain agents. Mirrors the prose
 * from buildNextActions but emits typed args ready to consume.
 */
function buildStructuredNextActions(
  patterns: PatternConcentration[],
  environment?: string
): NextAction[] {
  const out: NextAction[] = [];
  for (const p of patterns.slice(0, 3)) {
    const identity = p.symbolMessage || p.templateHash;
    const investigateArgs: Record<string, unknown> = { starting_point: identity };
    if (environment) investigateArgs.environment = environment;
    out.push({
      tool: 'log10x_investigate',
      args: investigateArgs,
      reason: `historical correlation for ${identity}`,
    });
    if (p.symbolMessage) {
      const strong = p.slots.find(
        (s) =>
          s.topValues[0] &&
          s.topValues[0].pct >= 0.3 &&
          s.namingConfidence !== 'low' &&
          s.inferredName !== 'timestamp'
      );
      if (strong && strong.topValues[0]) {
        const slot = strong.inferredName.replace(/\s*\(inferred\)$/i, '');
        const val = strong.topValues[0].value;
        out.push({
          tool: 'log10x_retriever_query',
          args: {
            pattern: p.symbolMessage,
            // retriever_query.from is required (no default). Use a 30d
            // window which matches the prose suggestion's intent for
            // "historical events" — agents can override.
            from: 'now-30d',
            filters: [`event.${slot} === ${JSON.stringify(val)}`],
          },
          reason: `historical events concentrated on ${slot}=${truncate(val, 40)}`,
        });
      }
    }
  }
  return out;
}

// ── Symbol message canonicalization ──

/**
 * Compute the `message_pattern` symbolMessage from a raw template body.
 *
 * Matches the paste Lambda / Reporter pipeline convention used in
 * aggregated.csv's `message_pattern` column:
 *
 *   1. Strip `$(...)` format specs entirely (timestamps, typed formats)
 *   2. Drop the severity keyword if it leads the remaining text
 *   3. Drop tenant-value-style `word=value` variables → keep only the key
 *   4. Drop bare `$` placeholders entirely
 *   5. Replace non-alphanumeric runs with `_`
 *   6. Lowercase + collapse multiple underscores + trim `_` from the ends
 *
 * Example:
 *   in:  `$(yyyy-MM-dd'T'HH:mm:ss'Z') ERROR checkout-svc tenant=$ order=$ status=failed reason=payment_gateway_timeout`
 *   out: `checkout_svc_tenant_order_status_failed_reason_payment_gateway_timeout`
 *
 * This is a best-effort reverse of the Reporter's message_pattern synthesis
 * rule. It may drift on edge cases (nested format specs, unusual delimiters);
 * falls back to `undefined` on empty output so the caller can skip the match.
 */
/** Split a snake_case identifier into its constituent tokens (length ≥ 2). */
function tokenize(s: string): Set<string> {
  const parts = s.split(/[^A-Za-z0-9]+/).filter((t) => t.length >= 2).map((t) => t.toLowerCase());
  return new Set(parts);
}

/**
 * Find the aggregated row whose token set has the highest Jaccard similarity
 * to the template's token set. Returns null if no row exceeds 0.3 similarity
 * (a weak threshold — we'd rather report "no severity" than attach a wrong one).
 */
function bestJaccardMatch(
  templateTokens: Set<string>,
  aggregated: Array<{ row: AggregatedRow; tokens: Set<string> }>
): { row: AggregatedRow; similarity: number } | null {
  let best: { row: AggregatedRow; similarity: number } | null = null;
  for (const { row, tokens } of aggregated) {
    const similarity = jaccard(templateTokens, tokens);
    if (similarity > (best?.similarity ?? 0)) {
      best = { row, similarity };
    }
  }
  if (best && best.similarity >= 0.3) return best;
  return null;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function canonicalizeToSymbolMessage(templateBody: string): string {
  // 1. Strip $(...) format specs
  let s = templateBody.replace(/\$\([^)]*\)/g, '');
  // 2. Trim + drop leading severity keyword
  s = s.trim().replace(/^(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|CRIT(?:ICAL)?)\b\s*/i, '');
  // 3. Collapse `word=$` patterns (drop the `=$` so we keep the key)
  s = s.replace(/([A-Za-z_][A-Za-z0-9_]*)=\$/g, '$1');
  // 4. Drop any remaining bare `$` placeholders
  s = s.replace(/\$/g, '');
  // 5. Replace non-alphanumerics with underscores
  s = s.replace(/[^A-Za-z0-9]+/g, '_');
  // 6. Lowercase + collapse underscores + trim
  s = s.toLowerCase().replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return s;
}

// ── Template cosmetics ──

function summarizeTemplate(template: string): string {
  // Strip leading format spec(s) like `$(yyyy-MM-dd'T'HH:mm:ss'Z')` since
  // timestamps dominate the headline and aren't distinguishing.
  const stripped = template.replace(/\$\([^)]*\)\s*/g, '').trim();
  const trimmed = stripped.replace(/\s+/g, ' ');
  const firstSentence = trimmed.split(/[.!?]/)[0];
  return truncate(firstSentence || trimmed, 60);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
