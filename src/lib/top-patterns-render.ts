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
import { agentOnly } from './agent-only.js';
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
import { detectIncidents as detectIncidentsGeneric } from './detectors/incident-cluster.js';
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
  state: Badge;
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
  /** Cost-by-service rollup (sorted desc) — the "where is the money"
   * headline. Each entry is a service, its bytes, and its share of the
   * total. Rendered as a compact block above the pattern list. */
  costByService?: Array<{ service: string; bytes: number; pct: number }>;
  /** $/GB rate for converting rollup bytes to cost. Default 1.0. */
  costPerGb?: number;
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
  // The drop-snippet template renders once at the top in compact mode
  // (>1 row, forwarder known); each card then references it. When it is
  // NOT shown, analyzer-level facts (e.g. "cloudwatch can't drop at
  // ingest") fall back to per-card so the fact still appears somewhere.
  const templateShown = !verbose && opts.forwarder !== null && rows.length > 1;
  // Dependency check: when EVERY shown row came back with zero matches,
  // collapse the identical per-card "0 references" line into one
  // env-level statement (cuts the repetition flagged on the
  // signal-to-noise axis). Cards WITH matches still render per-card —
  // those are signal, not boilerplate.
  const depsChecked = rows.filter(r => r.deps && !r.deps.error);
  const depsAllZero =
    rows.length > 0 &&
    depsChecked.length === rows.length &&
    depsChecked.every(r => r.deps!.matches.length === 0);

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
  out.push(
    `_$/mo = volume × $${(opts.costPerGb ?? 1).toFixed(2)}/GB; the rate is assumed, not measured from your bill._`
  );
  out.push('');

  // Aggregate-savings headline — the single most decision-sealing
  // number, and the one a vanilla-SIEM SRE has to sum by hand: "act on
  // this whole list and recover $X/mo, Y% of scanned spend." Bytes-pct
  // equals spend-pct (cost is linear in bytes). "up to" because drop
  // recovers all, compact/sample less — each card says which. Sits
  // above the service rollup so the punchline ("how much is on the
  // table") lands before the structural detail ("where it concentrates").
  if (rows.length > 0) {
    const shownMonthly = rows.reduce((s, r) => s + r.costPerMonth, 0);
    const shownBytes = rows.reduce((s, r) => s + r.bytes, 0);
    const dollars = fmtDollarMo(shownMonthly);
    const pct =
      opts.totalBytesInScope > 0
        ? ` (${Math.round((shownBytes / opts.totalBytesInScope) * 100)}% of scanned spend)`
        : '';
    out.push(`**Act on these ${rows.length} → cut up to ${dollars}/mo${pct}.**`);
    out.push('');
    // Green light for dropping: when nothing in the analyzer references
    // any shown hash, say so once here instead of repeating "0
    // references" on every card.
    if (depsAllZero) {
      out.push(
        `_No saved-search, alert, or dashboard in ${opts.analyzer ?? 'the analyzer'} references any of these ${rows.length} hashes (matched on hash; name-based references not checked)._`
      );
      out.push('');
    }
  }

  // Cost-center rollup — "where is the money". This is the headline a
  // vanilla-SIEM SRE has to hand-roll (stats by service); putting it
  // ABOVE the per-pattern list answers "which service is the lever"
  // before the reader gets lost in fragmented sub-patterns.
  out.push(...renderCostByService(opts));

  // Descriptors computed once here, shared by the incident detector and
  // the list (so we don't run descriptorFromSample twice per row).
  const descriptors = rows.map(
    r =>
      descriptorFromSample(r.sample?.logJson, 80) ??
      patternDescriptor(r.pattern, r.sample?.logLine ?? '', 80)
  );

  // Co-mover / incident roll-up. The hash-level precision that gives us
  // durability also over-splits one failure into several "top" rows
  // (the OpenSearch-unreachable loop showed up as 3 of 5). Detect when
  // rows are the same underlying incident (same service + shared error
  // vocabulary or co-moving volume) and say so once, above the list, so
  // the reader sees "3 of these are one fire" instead of three costs to
  // chase. Every per-pattern row + hash stays intact below — this only
  // adds the framing, it doesn't merge the data away.
  const incidents = detectIncidents(rows, descriptors);
  for (const inc of incidents) out.push(...renderIncidentCallout(inc));

  // Top-of-output list (replaces the code-fenced table). Markdown
  // numbered list with two lines per row: identity first (bold), then
  // stats (cost / volume / events / badge / first-seen). Wraps
  // gracefully in VS Code chat where a code-fenced table would crop.
  // The trajectory badge replaces what the sparkline used to do;
  // the volume-trend chart in the card body covers shape.
  out.push(renderList(rows, descriptors));
  out.push('');

  // Snippet template at the top (compact mode). The full XML/INI/YAML
  // structure is identical for every card in this run — only the hash
  // changes. Rendering it once at the top and referencing by hash per
  // card saves ~8 lines × N cards. Verbose mode keeps per-card
  // snippets so each card is self-contained for one-pattern dives.
  if (!verbose && opts.forwarder && rows.length > 1) {
    out.push(...renderSnippetTemplate(opts.forwarder, hashField, opts.analyzer));
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
    out.push(...renderCard(r, opts, hashField, verbose, templateShown, depsAllZero));
  }

  // Footer CTAs — the post-scan questions the Reader has after
  // comparing patterns. These don't live per-card because they're
  // aggregate questions about the set, not about one pattern.
  out.push('---');
  out.push('');
  out.push('**For the full set**');
  out.push('');
  out.push(
    `- **exact savings per mitigation** (drop vs compact vs sample, per pattern)? ask: \`show me projected savings for the top ${rows.length}\``
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

/** Render the shared "act on any pattern" block once at the top of the
 * output (compact mode, >1 row). Both the find query and the drop
 * snippet have identical structure for every card — only the hash
 * changes — so each card just shows its hash and points back here.
 * Collapsing that 5x repeat is the signal-to-noise win the per-card
 * form was bleeding. */
function renderSnippetTemplate(
  forwarder: ForwarderId,
  hashField: string,
  analyzer: string | null
): string[] {
  const lines: string[] = [];
  const ana = analyzer ?? 'the analyzer';
  const snip = dropRuleSnippet(forwarder, '<HASH>', hashField);

  lines.push(
    `**To act on any pattern below** — each card shows its \`${hashField}\`; swap it in for \`<HASH>\`.`
  );
  lines.push('');

  // Find query (analyzer-specific) — once.
  lines.push(`_Find the events_ in ${ana}:`);
  lines.push('```text');
  if (ana === 'cloudwatch') {
    lines.push('fields @timestamp, @message');
    lines.push(`| filter @message like /${hashField}="<HASH>"/`);
    lines.push('| sort @timestamp desc');
  } else if (ana === 'splunk') {
    lines.push(`index=* ${hashField}="<HASH>"`);
  } else {
    lines.push(`filter on ${hashField}="<HASH>" in the ${ana} query UI`);
  }
  lines.push('```');
  lines.push('');

  // Drop snippet (forwarder-specific) — once.
  lines.push(`_Drop them_ at the ${forwarder} forwarder:`);
  lines.push('```' + snip.language);
  lines.push(snip.body);
  lines.push('```');
  lines.push(`- **placement:** ${snip.placementNote}`);
  lines.push(`- **apply** with the \`kubectl\` steps at the bottom of this output.`);
  if (ana === 'cloudwatch') {
    lines.push(
      '- **cloudwatch can\'t drop at ingest** — no content-match filter exists analyzer-side, so this forwarder snippet is the only point that stops cost.'
    );
  }
  lines.push(
    `- **drop vs compact vs sample:** the snippet above drops. compact keeps every event ~10x smaller (lossless); sample keeps 1-in-N. for either, ask with the pattern's hash.`
  );
  const others = otherForwarders(forwarder);
  lines.push(
    `- **different forwarder?** ask with the pattern's hash (also: ${others.join(', ')}).`
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
/**
 * Render the cost-by-service rollup — the "where is the money" block.
 * Leads with a concentration callout when one service dominates (the
 * single most actionable fact: "one service is 74% of spend"), then a
 * compact ranked list of the top services with share + cost. Collapses
 * the long tail into a "+N more" line.
 *
 * This is the differentiator over a vanilla SIEM: a raw-CloudWatch SRE
 * gets here only by abandoning the auto-pattern output and hand-rolling
 * `stats by container_name`. We put it first.
 */
function renderCostByService(opts: TopPatternsRenderOpts): string[] {
  const rollup = opts.costByService;
  if (!rollup || rollup.length === 0) return [];
  const costPerGb = opts.costPerGb ?? 1.0;
  const lines: string[] = [];

  const top = rollup[0];
  // Concentration callout when the top service is a clear majority.
  const headline =
    top.pct >= 0.5
      ? `**Where the cost is** — \`${top.service}\` alone is **${Math.round(top.pct * 100)}%** of spend`
      : '**Where the cost is**';
  lines.push(headline);
  lines.push('');

  // Show "material" services (>=2% of spend), capped at 6, but always
  // at least the top 3. Tail the rest. The materiality floor keeps
  // every shown row larger than the collapsed tail, so the breakdown
  // reads monotonically.
  const SHOWN_MAX = 6;
  const MATERIAL = 0.02;
  let shown = 0;
  for (const s of rollup) {
    if (shown >= SHOWN_MAX) break;
    if (shown >= 3 && s.pct < MATERIAL) break;
    const cost = (s.bytes / 1024 ** 3) * costPerGb;
    const pct = `${Math.round(s.pct * 100)}%`.padStart(4);
    lines.push(`- ${pct} · ${fmtDollar(cost)}/h · ${fmtBytes(s.bytes)} · \`${s.service}\``);
    shown++;
  }
  const remaining = rollup.length - shown;
  if (remaining > 0) {
    const tailBytes = rollup.slice(shown).reduce((sum, s) => sum + s.bytes, 0);
    const tailPct = rollup.slice(shown).reduce((sum, s) => sum + s.pct, 0);
    const tailCost = (tailBytes / 1024 ** 3) * costPerGb;
    lines.push(
      `- ${`${Math.round(tailPct * 100)}%`.padStart(4)} · ${fmtDollar(tailCost)}/h · ${fmtBytes(tailBytes)} · _+${remaining} more service${remaining > 1 ? 's' : ''}_`
    );
  }
  lines.push('');
  return lines;
}

function renderList(rows: TopPatternRow[], descs: string[]): string {
  // `descs` are precomputed by the caller (shared with the incident
  // detector). Collision discrimination below uses them: two engine
  // patterns can share the same sample-mined text (e.g. the same error
  // logged at two pipeline stages = two hashes, one error string).
  const descCount = new Map<string, number>();
  for (const d of descs) {
    const k = d.toLowerCase();
    descCount.set(k, (descCount.get(k) ?? 0) + 1);
  }

  const lines: string[] = [];
  rows.forEach((r, i) => {
    let desc = descs[i];
    // Collision discriminator: when 2+ rows share a descriptor, append
    // what actually differs between them — the top varying field from
    // each row's own field-variation. Honest (it's the real engine-level
    // difference) and tells the rows apart without inventing a "variant"
    // label. Falls back to a short hash tag when no field-variation
    // signal is available.
    if (descCount.get(desc.toLowerCase())! > 1) {
      const disc = collisionDiscriminator(r);
      if (disc) desc = `${desc} — ${disc}`;
    }
    const sev = r.severity || 'no severity';
    const svc = r.service || 'unattributed';
    // Monthly cost as the headline. /h forces mental math; /mo
    // answers the Reader's "is this worth my time" question directly.
    const cost = `${fmtDollarMo(r.costPerMonth)}/mo`;
    const bytes = fmtBytes(r.bytes);
    const events = `${fmtCount(r.events)} events`;
    // Use BadgeInfo when available (carries ratio + age for meaningful
    // text like "+85% vs baseline" or "new (since 17h ago)"); fall
    // back to the plain word form if some row doesn't have it.
    const badge = r.badgeInfo
      ? fmtBadgeInfo(r.badgeInfo)
      : r.state.toLowerCase();

    lines.push(`${r.rank}. **${desc}** _[${svc} · ${sev}]_`);
    lines.push(`   ${cost} · ${bytes} · ${events} · ${badge}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

/** When two list rows share a descriptor, return a short string naming
 * what actually distinguishes THIS row — the top field that varies
 * across its sampled events (the real engine-level difference between
 * two same-text patterns), or a short hash tag as last resort. */
function collisionDiscriminator(r: TopPatternRow): string | null {
  const top = r.fieldVar?.varying?.[0];
  if (top) return `\`${top.field}\` varies (${top.distinct})`;
  // No field-variation signal — distinguish by a short hash tag so the
  // rows are at least addressable.
  if (r.hash) return `hash ${r.hash.slice(0, 6)}`;
  return null;
}

// ── Incident roll-up (co-movers) ───────────────────────────────────────

interface Incident {
  /** 1-based list ranks of the member patterns. */
  ranks: number[];
  /** Representative descriptor (verbatim from the highest-cost member). */
  label: string;
  service: string;
  combinedMonthly: number;
}

/**
 * Adapter to the shared incident-cluster detector at
 * `src/lib/detectors/incident-cluster.ts`. Same algorithm and
 * thresholds as before; this file now keeps only the TopPatternRow
 * shaping and the rank-index roundtripping for the rendered callout.
 */
function detectIncidents(rows: TopPatternRow[], descs: string[]): Incident[] {
  const clusters = detectIncidentsGeneric(
    rows.map((r, i) => ({
      identity: r.hash || `idx-${i}`,
      service: r.service,
      descriptor: descs[i] ?? '',
      costPerMonthUsd: r.costPerMonth,
      trendBytesPerSec: r.trendBytesPerSec,
    }))
  );
  // Map cluster member identity back to the row's rank for the
  // existing callout renderer.
  const rankByIdentity = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    rankByIdentity.set(rows[i].hash || `idx-${i}`, rows[i].rank);
  }
  return clusters.map((c) => ({
    ranks: c.members
      .map((m) => rankByIdentity.get(m.identity))
      .filter((r): r is number => typeof r === 'number')
      .sort((a, b) => a - b),
    label: c.representativeLabel,
    service: c.service,
    combinedMonthly: c.combinedMonthlyUsd,
  }));
}

/** Render the incident callout shown above the list — ranks of the
 * members, the representative descriptor (verbatim, not synthesized),
 * combined monthly cost, and the fix-once nudge. */
function renderIncidentCallout(inc: Incident): string[] {
  const ranks = inc.ranks.map(r => `#${r}`).join(', ');
  return [
    `**These look like one incident:** ${ranks} share a failure — \`${inc.label}\` (${inc.service}), ~${fmtDollarMo(inc.combinedMonthly)}/mo combined. Fix the source once instead of dropping each.`,
    '',
  ];
}

function renderCard(
  r: TopPatternRow,
  opts: TopPatternsRenderOpts,
  hashField: string,
  verbose: boolean,
  /** True when the top-of-output snippet template is shown (compact,
   * >1 row). Tells the card to skip analyzer-level facts already stated
   * there (e.g. "cloudwatch can't drop at ingest"). */
  templateShown: boolean,
  /** True when every shown row had zero dependency matches and the
   * env-level "nothing references these" line was already emitted at
   * the top — so the card skips its own "0 references" line. */
  suppressZeroDeps: boolean
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
    `**${fmtDollar(r.costPerHour)}/h** · ${fmtDollarMo(r.costPerMonth)}/mo · ${fmtBytes(r.bytes)} · ${fmtCount(r.events)} events · ${ageStr}`
  );
  lines.push('');

  // Volume trend — chart appears when trend shape changes the decision.
  // Compact mode: only for ACUTE or NEW badges (steady-state patterns
  // get the table sparkline + cost number, which already answer the
  // drop/sample question for stable trajectories).
  // Verbose mode: chart on every top-3 card (legacy behavior).
  const isNew = r.state === 'NEW';
  const isAcute = r.state === 'ACUTE';
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
      const nVary = r.fieldVar.varying.length;
      lines.push(
        `→ **${nVary} field${nVary > 1 ? 's' : ''} vary** — drop loses those cases; compact or sample keeps them.`
      );
    } else {
      lines.push(
        'every field identical across all sampled events, except per-event timestamps, durations, and IDs.'
      );
      lines.push('');
      lines.push('→ **no variants** — dropping loses no distinct cases.');
    }
    lines.push('');
  }

  const analyzerName = opts.analyzer ?? 'the analyzer';

  // Severity flag — still used to gate the "investigate" CTA further down.
  const sevUpper = (r.severity || '').toUpperCase();
  const isErrorish =
    sevUpper === 'ERROR' || sevUpper === 'WARN' || sevUpper === 'CRITICAL';

  // (Removed: a hardcoded "Error loop / Debug-level output" note keyed on
  // severity + event-count alone. It asserted "not steady telemetry" / "hides
  // the failure" from two numbers it couldn't actually verify — opaque at best,
  // wrong at worst. The card already shows severity, the example event, and the
  // field-variation block; the reader (or agent) judges from those facts.)

  // Find + drop. Compact (templateShown): both live once at the top of
  // the output, so the card carries only its hash. Otherwise (verbose,
  // single-card, or forwarder not detected): full per-card form so the
  // card stands alone.
  if (templateShown) {
    // Survey context: the human reads the card's description, not a bare
    // hash. Demote the identity to the agent-only channel (the agent uses it
    // to chain exact drops/correlation; exclusion_filter/pattern_examples
    // surface it to the human with a gloss when an action needs it).
    lines.push(agentOnly(`tenx_hash ${r.hash}`));
    lines.push('');
  } else {
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

    if (opts.forwarder) {
      const snip = dropRuleSnippet(opts.forwarder, r.hash, hashField);
      const otherList = otherForwarders(opts.forwarder);
      const exampleAlt = otherList[0];
      const restAlts = otherList.slice(1).join(', ');
      lines.push(`**To drop at the ${opts.forwarder} forwarder**`);
      lines.push('');
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
    } else if (!suppressZeroDeps) {
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

  // "investigate" — heavyweight RCA. Fires for error-severity spikes
  // (ACUTE/NEW) and for sustained error loops (the source-fix note
  // above tells those readers to "investigate before you suppress", so
  // the CTA must be here for them too). sevUpper / isErrorish are
  // computed above.
  const investigateApplies =
    isErrorish && (r.state === 'ACUTE' || r.state === 'NEW' || r.events >= 100);
  if (investigateApplies || verbose) {
    const subject =
      r.state === 'ACUTE' || r.state === 'NEW'
        ? `the ${r.state.toLowerCase()} change in `
        : isErrorish
          ? 'the error loop in '
          : '';
    gatedCtas.push(
      `- **full root-cause analysis?** ask: \`investigate ${subject}hash ${r.hash}\``
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

/** Monthly-cost formatter. Whole dollars at >= $10 — the cents there are
 * false precision ($/mo = window volume × an assumed $/GB rate, not a
 * measured bill). Below $10, keep fmtDollar so small patterns stay
 * distinguishable. */
function fmtDollarMo(d: number): string {
  if (d >= 10) return `$${Math.round(d)}`;
  return fmtDollar(d);
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
