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
 * suggestions for follow-up via log10x_investigate, log10x_streamer_query,
 * or native SIEM commands.
 */

import { promises as fs } from 'fs';
import { z } from 'zod';
import { submitPaste, PASTE_MAX_BYTES, type PasteResponse } from '../lib/paste-api.js';
import { runDevCli, DevCliNotInstalledError } from '../lib/dev-cli.js';
import {
  parseTemplates,
  parseEncoded,
  parseAggregated,
  type AggregatedRow,
} from '../lib/cli-output-parser.js';
import { computeConcentration, type PatternConcentration } from '../lib/variable-concentration.js';
import { fmtCount, fmtBytes } from '../lib/format.js';

export const resolveBatchSchema = {
  source: z
    .enum(['file', 'events', 'text'])
    .describe('Input mode. `file`: read from local path. `events`: array of raw log lines. `text`: a single string containing newline-separated lines (use this when the model is passing through a Bash/SIEM output it already has in hand).'),
  path: z.string().optional().describe('Local file path when source=file. Required for file mode.'),
  events: z.array(z.string()).optional().describe('Inline log lines when source=events.'),
  text: z.string().optional().describe('Raw text blob when source=text — newline-separated log events.'),
  top_n_patterns: z.number().min(1).max(50).default(20).describe('How many patterns to return in the ranked triage.'),
  include_next_actions: z.boolean().default(true).describe('Whether to generate next_action suggestions for each top pattern.'),
  environment: z.string().optional().describe('Environment nickname — used to build next_actions that call log10x_investigate.'),
  privacy_mode: z.boolean().default(false).describe('When true, events are NOT sent to the Log10x paste Lambda. The tool instead attempts to shell out to a locally-installed `tenx` binary. If the binary is not installed, the call errors cleanly with an install hint.'),
};

export async function executeResolveBatch(args: {
  source: 'file' | 'events' | 'text';
  path?: string;
  events?: string[];
  text?: string;
  top_n_patterns: number;
  include_next_actions: boolean;
  environment?: string;
  privacy_mode: boolean;
}): Promise<string> {
  // ── 1. Materialize input text ──
  const text = await materialize(args);
  if (!text || text.trim().length === 0) {
    throw new Error('No events provided. Pass source=file with path, source=events with an events array, or source=text with raw text.');
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  const lineCount = text.split('\n').filter((l) => l.trim().length > 0).length;
  if (lineCount === 0) {
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
        throw e;
      }
      throw new Error(`Local tenx CLI run failed: ${(e as Error).message}`);
    }
  } else {
    if (bytes > PASTE_MAX_BYTES) {
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
  lines.push(
    `${fmtCount(lineCount)} events, resolved into ${concentrations.length} distinct pattern${concentrations.length === 1 ? '' : 's'}. ` +
      `Templater wall time: ${cliWallTimeMs}ms. Input size: ${fmtBytes(bytes)}. Execution: ${modeLabel}.`
  );
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
      lines.push('**Next actions**:');
      const actions = buildNextActions(p, args.environment);
      for (const a of actions) {
        lines.push(`  - ${a}`);
      }
    }
    lines.push('');
  }

  // ── 8. Closing summary ──
  if (concentrations.length > ranked.length) {
    const leftover = concentrations.length - ranked.length;
    lines.push(`_${leftover} additional pattern${leftover === 1 ? '' : 's'} not shown. Increase \`top_n_patterns\` to see them._`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Input materialization ──

async function materialize(args: {
  source: 'file' | 'events' | 'text';
  path?: string;
  events?: string[];
  text?: string;
}): Promise<string> {
  switch (args.source) {
    case 'file':
      if (!args.path) throw new Error('source=file requires a `path` argument.');
      return fs.readFile(args.path, 'utf8');
    case 'events':
      if (!Array.isArray(args.events) || args.events.length === 0) {
        throw new Error('source=events requires an `events` array.');
      }
      return args.events.join('\n');
    case 'text':
      if (!args.text || args.text.trim().length === 0) {
        throw new Error('source=text requires a non-empty `text` argument.');
      }
      return args.text;
  }
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

  // Variable-filtered Streamer query suggestion — skip typed slots like timestamps
  // where filtering on a literal value is almost never what the user wants.
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
    const jsFilter = `event.${slot} === ${JSON.stringify(val)}`;
    actions.push(
      `call \`log10x_streamer_query({ pattern: '${p.templateHash}', filters: [${JSON.stringify(jsFilter)}] })\` to retrieve all historical events concentrated on ${slot}=${truncate(val, 40)} (requires Streamer tier).`
    );
    actions.push(
      `native Datadog follow-up: \`dog log search '@${slot}:"${val.replace(/"/g, '\\"')}"' --from now-24h\` — filters to the dominant variable concentration directly in the SIEM.`
    );
  }

  return actions;
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
