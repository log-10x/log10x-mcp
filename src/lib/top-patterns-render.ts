/**
 * Renderer for the v2 `log10x_top_patterns` layout. Keep this separate
 * from `pattern-render.ts` (which `cost_drivers`, `event_lookup`,
 * `services`, `trend` still rely on); only `top_patterns` uses this.
 *
 * Output is **GitHub-flavored markdown** designed to render inside an AI
 * IDE chat panel. Section headers use **bold**, multi-row ASCII (table,
 * chart, snippets, queries) lives inside ```fenced blocks so monospace
 * spacing survives VS Code's proportional-font renderer, and sub-items
 * use bullet lists. The previous "ASCII-art-everywhere" layout rendered
 * as a wall of proportional text once VS Code's markdown engine got
 * hold of it.
 *
 * Layout, top to bottom:
 *   1. Orientation header (window, sort key, forwarder + analyzer detected, totals)
 *   2. Compact table (one row per pattern, identity-first columns, fenced)
 *   3. Per-pattern cards, each with:
 *      - ### row header + bold cost line ($/h, $/mo, MB, events, first seen)
 *      - **Volume trend** + fenced chart (top-3 / NEW only; y-axis is
 *        MB/h — volume parses faster than $/h since the row header
 *        already names the cost)
 *      - **Example event** *(sample from namespace X)* + fenced semantic
 *        excerpt (namespace lives in the header so we don't need a
 *        separate "where this comes from" section)
 *      - **What varies across these events** (markdown table when fields
 *        vary; one-line verdict when not — replaces the legacy
 *        varying/noise/constant tri-bucket)
 *      - **To find these events in <analyzer>** + fenced query
 *      - **To drop at the <forwarder> forwarder** + fenced snippet +
 *        bullets (placement / sample variant / "using a different
 *        forwarder? ask: …" — action-shaped, not just a list / and a
 *        final "analyzer-side drop: unavailable" bullet when the
 *        analyzer can't drop at ingest)
 *      - **To drop at <analyzer> (analyzer-side)** — only when the
 *        analyzer actually supports drop-at-ingest (splunk, datadog)
 *      - **To apply this to the running <forwarder>** — kubectl
 *        commands when sample has k8s metadata, host-level otherwise;
 *        closes the loop from "here's the snippet" to "production is
 *        now dropping these events"
 */

import { lineChart } from './line-chart.js';
import { patternDescriptor, descriptorFromSample } from './pattern-descriptor.js';
import {
  dropRuleSnippet,
  otherForwarders,
  applyInstructions,
  type ForwarderId,
} from './forwarder-snippets.js';
import { semanticExcerpt } from './semantic-excerpt.js';
import type { FieldVariation } from './field-variation.js';
import type { ParsedSiemEvent } from './siem/sample.js';
import { fmtAge } from './first-seen.js';
import { type Badge, type BadgeInfo, fmtBadgeInfo } from './top-patterns-extras.js';
import type { DepCheckResult } from './siem/deps/index.js';

export interface TopPatternRow {
  rank: number;
  hash: string;
  pattern: string;
  service: string;
  severity: string;
  bytes: number;
  costPerHour: number;
  costPerMonth: number;
  events: number;
  /** Age in seconds, or null when unknown. */
  firstSeenAgeSeconds: number | null;
  /** Byte-rate values from the 24h trend Prom query, or empty. */
  trendBytesPerSec: number[];
  /** One parsed SIEM event used as the sample. */
  sample?: ParsedSiemEvent;
  /** Per-field variation across N sampled events. */
  fieldVar?: FieldVariation;
  /** Trajectory classification (v3 — see top-patterns-extras.ts). */
  badge: Badge;
  /** Full BadgeInfo with ratio + first-seen-age for richer rendering
   * ("+85% vs baseline" instead of just "ACUTE"). Optional for
   * backward compat; renderers should prefer this when present. */
  badgeInfo?: BadgeInfo;
  /** Distinct services emitting this hash. >1 surfaces the breakdown CTA. */
  serviceCount?: number;
  /** Per-hash dependency-check result (token-AND match against the
   * detected analyzer's saved searches / alerts / dashboards). */
  deps?: DepCheckResult;
  /** Datadog ingest-exclusion query for this hash. Set when the env's
   * analyzer is Datadog; folded inline as a pre-meter drop option. */
  datadogAnalyzerQuery?: string;
}

export interface TopPatternsRenderOpts {
  windowLabel: string;
  totalBytesInScope: number;
  totalCostPerHour: number;
  totalCostMonthly: number;
  patternCountShown: number;
  patternCountTotal?: number;
  /** Detected forwarder for this env. `null` when detection fails. */
  forwarder: ForwarderId | null;
  /** Detected analyzer name (e.g. "cloudwatch", "splunk"). Lowercase. */
  analyzer: string | null;
  /** Engine's symbolMessageHashField value. Defaults to "tenx_hash". */
  hashField?: string;
  /** Log group / index / scope to surface in the analyzer query line. */
  analyzerScope?: string;
  /** Optional degraded-state banner from healthBanner(). */
  healthBanner?: string | null;
  /** Verbose mode — when true, every card carries the full forwarder
   * snippet inline, all CTAs render unconditionally, and the volume
   * trend chart shows on every top-3 card instead of only ACUTE/NEW.
   * Default false (compact, badge-driven, gated CTAs). */
  verbose?: boolean;
}

const PAT_COL = 44;
const EV_COL = 14;

export function renderTopPatterns(
  rows: TopPatternRow[],
  opts: TopPatternsRenderOpts
): string {
  const out: string[] = [];
  const hashField = opts.hashField ?? 'tenx_hash';
  const verbose = opts.verbose ?? false;

  // Health banner (pinned at the very top when present). When the
  // engine metric tier is degraded, the Reader needs to know BEFORE
  // they trust any number below.
  if (opts.healthBanner) {
    out.push(opts.healthBanner);
    out.push('');
  }

  // Orientation header — bold tool name, then a one-line stats summary
  out.push(
    `## \`log10x_top_patterns\` · window ${opts.windowLabel} · ranked by cost/h ↓`
  );
  out.push('');
  const fwd = opts.forwarder ?? '_(not detected)_';
  const ana = opts.analyzer ?? '_(not detected)_';
  out.push(
    `**forwarder:** ${fwd} · **analyzer:** ${ana} · *(ask for --explain-detection)*`
  );
  out.push(
    `**total in scope:** ${fmtBytes(opts.totalBytesInScope)} · ${fmtDollar(opts.totalCostPerHour)}/h · ${rows.length} of ${opts.patternCountTotal ?? '?'} patterns`
  );
  out.push('');

  // Top-of-output list (replaces the code-fenced table). Markdown
  // numbered list with two lines per row: identity first (bold), then
  // stats (cost / volume / events / badge / first-seen). Wraps
  // gracefully in VS Code chat where a code-fenced table would crop.
  // The trajectory badge replaces what the sparkline used to do;
  // the volume-trend chart in the card body covers shape.
  out.push(renderList(rows));
  out.push('');

  // Snippet template at the top (compact mode). The full XML/INI/YAML
  // structure is identical for every card in this run — only the hash
  // changes. Rendering it once at the top and referencing by hash per
  // card saves ~8 lines × N cards. Verbose mode keeps per-card
  // snippets so each card is self-contained for one-pattern dives.
  if (!verbose && opts.forwarder && rows.length > 1) {
    out.push(...renderSnippetTemplate(opts.forwarder, hashField));
    out.push('');
  }

  // k8s detection: env-level. Any card with k8s metadata implies the
  // env is k8s; cards with missing samples shouldn't degrade the env's
  // apply guidance to "host-level systemctl" — that was a per-card
  // sample-availability bug fixed by lifting detection to the env.
  const envIsK8s = rows.some(r => r.sample?.k8s);
  const envNamespace =
    rows.find(r => r.sample?.k8s?.namespace)?.sample?.k8s?.namespace;

  // Per-row cards — markdown horizontal rule between them
  for (const r of rows) {
    out.push('---');
    out.push('');
    out.push(...renderCard(r, opts, hashField, verbose));
  }

  // Footer CTAs — the post-scan questions the Reader has after
  // comparing patterns. These don't live per-card because they're
  // aggregate questions about the set, not about one pattern.
  out.push('---');
  out.push('');
  out.push('**For the full set**');
  out.push('');
  out.push(
    `- **aggregate savings if you act on the top ${rows.length}?** ask: \`show me projected savings for the top ${rows.length}\``
  );
  out.push(
    '- **what\'s growing vs stable across the whole env?** ask: `show me cost drivers over the last 7d` *(point-in-time rank vs growth-delta rank are different questions)*'
  );
  out.push('');

  // Env-level apply block — placed AFTER the cards, not before, so its
  // header reads naturally ("steps for any snippet above"). Putting it
  // before the cards forced a forward reference: the Reader hadn't seen
  // a "drop snippet" yet, so "for any drop snippet below" was jargon
  // for content they hadn't reached. After-cards = self-contained.
  if (opts.forwarder) {
    const apply = applyInstructions(opts.forwarder, {
      namespace: envNamespace,
      isK8s: envIsK8s,
    });
    out.push('---');
    out.push('');
    out.push(`**${apply.heading} — same 3 steps apply for every snippet above**`);
    out.push('');
    if (apply.steps.startsWith('_')) {
      const [note, ...rest] = apply.steps.split('\n\n');
      out.push(note);
      out.push('');
      out.push('```bash');
      out.push(rest.join('\n\n'));
      out.push('```');
    } else {
      out.push('```bash');
      out.push(apply.steps);
      out.push('```');
    }
    out.push('');
  }

  return out.join('\n');
}

/** Render the forwarder drop-snippet template once at the top of the
 * output (compact mode). Per-card sections reference it by hash. The
 * full XML/INI/YAML body has identical structure for every card in
 * the run — only the hash changes — so showing it 5 times in a 5-card
 * output is wasted real estate. */
function renderSnippetTemplate(
  forwarder: ForwarderId,
  hashField: string
): string[] {
  const lines: string[] = [];
  const snip = dropRuleSnippet(forwarder, '<HASH>', hashField);
  lines.push(
    `**To drop any pattern below at the ${forwarder} forwarder, use this template** ` +
    '*(swap `<HASH>` for the row\'s hash — shown on each card below)*'
  );
  lines.push('');
  lines.push('```' + snip.language);
  lines.push(snip.body);
  lines.push('```');
  lines.push('');
  lines.push(`- **placement:** ${snip.placementNote}`);
  lines.push(
    `- **apply** with the \`kubectl\` steps at the bottom of this output.`
  );
  return lines;
}

/**
 * Render the top-of-output as a markdown numbered list (replaces the
 * earlier code-fenced ASCII table). Each row is 2 lines:
 *
 *   1. **identity** _[service · severity]_
 *      $/h · MB · events · badge · first-seen
 *
 * The list shape wraps in VS Code chat (the code-fenced table cropped
 * at ~85 chars and lost the right half of every row). Identity-first
 * (descriptor leads the row, not the cost) because the Reader's first
 * question is "what is this?" before "how expensive is it?". The
 * trajectory badge replaces the sparkline; the volume-trend chart in
 * the card body covers within-1h shape when shape changes the decision.
 */
function renderList(rows: TopPatternRow[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    // Algorithm 1: try the sample-mined descriptor first; fall back to
    // engine pattern-name extraction when no priority key is present
    // (plain-text logs, multi-line events, sample fetch failed, etc.).
    // 80-char budget — the list line wraps naturally if longer.
    const sampled = descriptorFromSample(r.sample?.logJson, 80);
    const desc = sampled ?? patternDescriptor(r.pattern, r.sample?.logLine ?? '', 80);
    const sev = r.severity || 'no severity';
    const svc = r.service || 'unattributed';
    // Monthly cost as the headline. /h forces mental math; /mo
    // answers the Reader's "is this worth my time" question directly.
    const cost = `${fmtDollar(r.costPerMonth)}/mo`;
    const bytes = fmtBytes(r.bytes);
    const events = `${fmtCount(r.events)} events`;
    // Use BadgeInfo when available (carries ratio + age for meaningful
    // text like "+85% vs baseline" or "new (since 17h ago)"); fall
    // back to the plain word form if some row doesn't have it.
    const badge = r.badgeInfo
      ? fmtBadgeInfo(r.badgeInfo)
      : r.badge.toLowerCase();

    lines.push(`${r.rank}. **${desc}** _[${svc} · ${sev}]_`);
    lines.push(`   ${cost} · ${bytes} · ${events} · ${badge}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderCard(
  r: TopPatternRow,
  opts: TopPatternsRenderOpts,
  hashField: string,
  verbose: boolean
): string[] {
  const lines: string[] = [];
  // Card header gets a longer descriptor budget (80 chars) than the
  // table row (44) — more room to breathe in the card title.
  const sampled = descriptorFromSample(r.sample?.logJson, 80);
  const desc = sampled ?? patternDescriptor(r.pattern, r.sample?.logLine ?? '');
  const sev = r.severity || '(no severity)';
  const svc = r.service || '(unattributed)';
  const namespace = r.sample?.k8s?.namespace;

  // Row header — h3 + bold cost line. The numbers a triaging SRE
  // checks first ($/h + events + first-seen) belong on a single
  // skim-able line directly under the title.
  lines.push(`### #${r.rank} · ${svc} · ${sev} · ${desc}`);
  lines.push('');
  const ageStr = r.firstSeenAgeSeconds !== null
    ? `first seen ${fmtAge(r.firstSeenAgeSeconds)}`
    : 'first seen unknown';
  lines.push(
    `**${fmtDollar(r.costPerHour)}/h** · ${fmtDollar(r.costPerMonth)}/mo · ${fmtBytes(r.bytes)} · ${fmtCount(r.events)} events · ${ageStr}`
  );
  lines.push('');

  // Volume trend — chart appears when trend shape changes the decision.
  // Compact mode: only for ACUTE or NEW badges (steady-state patterns
  // get the table sparkline + cost number, which already answer the
  // drop/sample question for stable trajectories).
  // Verbose mode: chart on every top-3 card (legacy behavior).
  const isNew = r.badge === 'NEW';
  const isAcute = r.badge === 'ACUTE';
  const showChart = verbose
    ? (r.rank <= 3 || isNew) && r.trendBytesPerSec.length > 0
    : (isAcute || isNew) && r.trendBytesPerSec.length > 0;
  if (showChart) {
    lines.push('**Volume trend** (last 24h, ~10-min buckets)');
    lines.push('');
    const chart = lineChart(r.trendBytesPerSec, { widthCap: 60, spanSeconds: 24 * 3600 });
    if (chart) {
      lines.push('```text');
      lines.push(chart);
      lines.push('```');
    }
    lines.push('');
  }

  // Example event — verb-free noun title because the sample isn't an
  // action, it's evidence. Namespace goes in the section heading so
  // we don't need a separate "where this comes from" block downstream.
  const exampleHeader = namespace
    ? `**Example event** *(sample from namespace \`${namespace}\`)*`
    : '**Example event**';
  lines.push(exampleHeader);
  lines.push('');
  if (r.sample) {
    const tsIso = r.sample.timestampMs
      ? new Date(r.sample.timestampMs).toISOString().replace(/\.\d+Z$/, 'Z')
      : '';
    const k8s = r.sample.k8s;
    const podPath = k8s
      ? `${k8s.container ?? '?'}/${k8s.pod ?? '?'}`
      : '';
    const excerpt = semanticExcerpt(r.sample.logLine, r.sample.logJson);
    lines.push('```text');
    if (tsIso || podPath) {
      lines.push(`${tsIso}  ${podPath}`.trim());
    }
    for (const line of excerpt) {
      lines.push(line.text);
    }
    lines.push('```');
  } else {
    lines.push('*sample unavailable: no events matched in last 1h, or the group is multi-line / unparseable JSON envelope.*');
    lines.push('');
    lines.push('→ try `log10x_pattern_examples` for sample retrieval with longer lookback.');
  }
  lines.push('');

  // What varies across these events — replaces the legacy varying/noise/
  // constant tri-bucket. Three columns: field name, how many distinct
  // values across the sample, and 2–3 actual sample values so the
  // Reader can tell at a glance whether "17 distinct" is meaningful
  // counts (`100, 250, 500`) or opaque IDs (`a8f3-…, 9d2e-…`). The
  // "drill candidate" flag previously here was jargon-on-first-use —
  // it implied an action without defining it. Sample values + the
  // verdict footer carry that load now.
  if (r.fieldVar && r.fieldVar.totalEvents > 0) {
    lines.push(
      `**What varies across these events** *(${r.fieldVar.totalEvents} sampled, all sharing \`${hashField}="${r.hash}"\`)*`
    );
    lines.push('');
    if (r.fieldVar.varying.length > 0) {
      lines.push('| field | how many distinct | example values |');
      lines.push('|---|---:|---|');
      for (let i = 0; i < Math.min(r.fieldVar.varying.length, 5); i++) {
        const e = r.fieldVar.varying[i];
        const samples = fmtSampleValues(e.sampleValues, e.distinct);
        lines.push(`| \`${e.field}\` | ${e.distinct} | ${samples} |`);
      }
      lines.push('');
      // Verdict — grounded in the engine's actual mitigation
      // semantics (compactReducer encodes events to ~10x smaller
      // form, lossless; it does NOT dedupe). The previous "compact
      // keeps one event per combination" was a fabrication.
      lines.push(
        '→ **drop** stops these events entirely. **compact** encodes every event in ~10x smaller form (same count, lossless). **sample** keeps 1-in-N full-form. Ask: `show me the compact or sample syntax for hash ' + r.hash + '`.'
      );
    } else {
      lines.push(
        'every field identical across all sampled events, except per-event timestamps, durations, and IDs.'
      );
      lines.push('');
      lines.push('→ **drop** is safe — no distinct cases lost.');
    }
    lines.push('');
  }

  // To find these events in <analyzer> — verb-shaped header so the
  // reader knows what to do with the snippet at a glance.
  const analyzerName = opts.analyzer ?? 'the analyzer';
  lines.push(`**To find these events in ${analyzerName}**`);
  lines.push('');
  lines.push('```text');
  if (analyzerName === 'cloudwatch') {
    lines.push('fields @timestamp, @message');
    lines.push(`| filter @message like /${hashField}="${r.hash}"/`);
    lines.push('| sort @timestamp desc');
  } else if (analyzerName === 'splunk') {
    lines.push(`index=* ${hashField}="${r.hash}"`);
  } else {
    lines.push(`filter on ${hashField}="${r.hash}" in the analyzer query UI`);
  }
  lines.push('```');
  if (opts.analyzerScope) {
    lines.push('');
    lines.push(`*paste into the ${analyzerName} query UI, scope: ${opts.analyzerScope}*`);
  }
  lines.push('');

  // To drop at <forwarder>. Compact mode references the template at
  // the top of the output (full snippet shown once). Verbose mode
  // renders the per-card snippet inline. Action bullets follow.
  if (opts.forwarder) {
    const snip = dropRuleSnippet(opts.forwarder, r.hash, hashField);
    const otherList = otherForwarders(opts.forwarder);
    const exampleAlt = otherList[0];
    const restAlts = otherList.slice(1).join(', ');
    lines.push(`**To drop at the ${opts.forwarder} forwarder**`);
    lines.push('');
    if (verbose) {
      lines.push('```' + snip.language);
      lines.push(snip.body);
      lines.push('```');
      lines.push('');
      lines.push(`- **placement:** ${snip.placementNote}`);
      lines.push(
        `- **apply this snippet:** use the \`kubectl\` steps at the bottom of this output (same 3 steps work for every snippet in this run).`
      );
      lines.push(
        `- **keep 1-in-N instead of drop-all?** ask: \`show me the ${opts.forwarder} sample syntax for hash ${r.hash}\``
      );
      lines.push(
        `- **using a different forwarder?** ask: \`show me the ${exampleAlt} syntax for hash ${r.hash}\` (also: ${restAlts})`
      );
    } else {
      // Compact: just the hash + one action bullet. The reader uses
      // the template at the top of the output, swapping <HASH> for
      // the value below.
      lines.push(`Apply the template above with hash = \`${r.hash}\`.`);
      lines.push('');
      lines.push(
        `- **keep 1-in-N instead of drop-all?** ask: \`show me the ${opts.forwarder} sample syntax for hash ${r.hash}\``
      );
      lines.push(
        `- **different forwarder?** ask: \`show me the ${exampleAlt} syntax for hash ${r.hash}\` *(also: ${restAlts})*`
      );
    }
    if (analyzerName === 'cloudwatch') {
      lines.push(
        '- **cloudwatch-side drop:** unavailable — cloudwatch has no drop-at-ingest filter for content matches. The forwarder snippet above is the only point that stops cost.'
      );
    }
    lines.push('');
  } else {
    lines.push('**To drop this pattern**');
    lines.push('');
    lines.push(`forwarder not detected. Filter on \`${hashField}="${r.hash}"\` using the forwarder's drop syntax.`);
    lines.push('');
    lines.push('→ try `log10x_pattern_mitigate` for the full mitigation menu.');
    lines.push('');
  }

  // Analyzer-side drop. Three shapes:
  //  - Datadog (PRE-METER): fold inline as a one-line ingest-
  //    exclusion query — the drop saves the metered moment, parity
  //    with the forwarder snippet's effect on cost.
  //  - Splunk (POST-LICENSE): CTA with explicit caveat —
  //    transforms.conf nullQueue drops at the indexer AFTER license
  //    consumption, so a Reader expecting parity with the forwarder
  //    drop would mislead themselves on savings expectations.
  //  - CloudWatch (UNAVAILABLE): folded as the final bullet under
  //    the forwarder section (above).
  if (analyzerName === 'datadog' && r.datadogAnalyzerQuery) {
    lines.push('**Or, drop at datadog (analyzer-side, pre-meter)**');
    lines.push('');
    lines.push('Paste into _Logs → Configuration → Indexes → Exclusion Filters_:');
    lines.push('');
    lines.push('```text');
    lines.push(r.datadogAnalyzerQuery);
    lines.push('```');
    lines.push('');
  } else if (analyzerName === 'splunk') {
    lines.push(
      `> **also drop at splunk (post-license)?** ask: \`show me the splunk drop rule for hash ${r.hash}\` ` +
      `— ⚠ splunk's \`transforms.conf\` nullQueue drops at the indexer AFTER license consumption, so this saves storage, not ingest cost.`
    );
    lines.push('');
  }

  // Dependency badge (folded inline). Renders matched names with the
  // matcher's nature on its face, so the Reader can self-check the
  // matches and the caveat travels with the data — honest precision
  // claims are what separate "useful safety signal" from "over-sold
  // safety signal" under autonomous-chain conditions.
  if (r.deps && !r.deps.error) {
    const m = r.deps.matches;
    if (m.length > 0) {
      const top3 = m
        .slice(0, 3)
        .map(x => `${x.type} "${x.name.length > 40 ? x.name.slice(0, 39) + '…' : x.name}"`)
        .join(' · ');
      const more = m.length > 3 ? ` · +${m.length - 3} more` : '';
      lines.push(
        `**references found in ${analyzerName}:** ${m.length} · ${top3}${more}`
      );
      lines.push(
        `*token-AND match on the hash; saved-searches that reference this pattern by name only will not appear here.*`
      );
      lines.push('');
    } else {
      lines.push(
        `**references found in ${analyzerName}:** 0 *(token-AND match on the hash across saved searches, alerts, dashboards; references by pattern-name not checked)*`
      );
      lines.push('');
    }
  }

  // Gated CTAs — surface "deeper investigation" options only on cards
  // where they earn their line. An unconditional CTA on every card
  // trains the Reader to skip the section, including on the day it
  // actually matters.
  const gatedCtas: string[] = [];

  // "distribution of <field>" — gated on field cardinality >= 5 AND
  // row cost > $0.05/h. Below those thresholds the distribution view
  // is unlikely to change the drop/compact decision.
  if (r.fieldVar && r.costPerHour > 0.05) {
    const topVarying = r.fieldVar.varying.find(e => e.distinct >= 5);
    if (topVarying) {
      gatedCtas.push(
        `- **distribution of \`${topVarying.field}\`?** ask: \`show me top values for ${topVarying.field} where ${hashField}="${r.hash}"\``
      );
    }
  }

  // "investigate" — heavyweight RCA. Gated to acute/new cards on
  // ERROR/WARN/CRITICAL severity. Outside that, investigate answers
  // a different question than what the Reader is asking at card-time.
  const sevUpper = (r.severity || '').toUpperCase();
  const investigateApplies =
    (r.badge === 'ACUTE' || r.badge === 'NEW') &&
    (sevUpper === 'ERROR' || sevUpper === 'WARN' || sevUpper === 'CRITICAL');
  if (investigateApplies || verbose) {
    gatedCtas.push(
      `- **full root-cause analysis?** ask: \`investigate the ${r.badge.toLowerCase()} change in hash ${r.hash}\``
    );
  }

  // "service breakdown" — only when >1 service emits this hash.
  // Single-service rows already tell the whole story in the row
  // header's service column.
  if (r.serviceCount && r.serviceCount > 1) {
    gatedCtas.push(
      `- **which services emit this?** ${r.serviceCount} distinct services share this hash. ask: \`show me the service breakdown for hash ${r.hash}\``
    );
  }

  if (gatedCtas.length > 0) {
    lines.push('**For deeper investigation**');
    lines.push('');
    for (const c of gatedCtas) lines.push(c);
    lines.push('');
  }

  // (apply instructions intentionally NOT per-card — they're env-level
  // and live once at the top of the output, immediately under the
  // orientation table. Each card's drop section above points back to
  // them via the **apply this snippet** bullet.)

  return lines;
}

// --- formatters --------------------------------------------------------

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n.toFixed(0)} B`;
}

function fmtCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtDollar(d: number): string {
  if (d >= 0.01) return `$${d.toFixed(2)}`;
  return `$${d.toFixed(4)}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Format up to 3 sample values for a field-variation table cell.
 * Each value is truncated to ~15 chars (so UUIDs become `a8f3-def-…`),
 * wrapped in backticks for visual separation, and joined with commas.
 * Trailing `, …` is added when `distinct` exceeds the shown sample
 * count so the Reader knows the list is partial.
 *
 * Pipe characters get escaped so they don't break the markdown table cell.
 */
function fmtSampleValues(values: string[], distinct: number): string {
  const shown = values.slice(0, 3).map(v => {
    const truncated = v.length > 16 ? v.slice(0, 15) + '…' : v;
    const escaped = truncated.replace(/\|/g, '\\|');
    return '`' + escaped + '`';
  });
  if (distinct > shown.length) shown.push('…');
  return shown.join(', ');
}
