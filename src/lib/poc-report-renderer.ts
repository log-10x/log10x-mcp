/**
 * Renders the 9-section POC markdown report.
 *
 * Input is the templatized pattern set + per-SIEM context; output is a
 * single markdown document. Every number here must come from pulled
 * events. No fabrication — confidence grades mark any estimate.
 */

import type { ExtractedPattern, ExtractedPatterns } from './pattern-extraction.js';
import type { SiemId } from './siem/pricing.js';
import { SIEM_DISPLAY_NAMES } from './siem/pricing.js';
import {
  getDefaultActionForDestination,
  getAllowedActionsForDestination,
  type Action as CostAction,
  type DollarSource,
  type DisclosedDollarValue,
  buildDisclosedDollarValue,
} from './cost.js';
import { fmtBytes, fmtCount, fmtDisclosedDollar, fmtDollar, fmtGb, fmtPct } from './format.js';
import { buildDfContext, buildDisplayName } from './pattern-df.js';
import { renderNextActions, type NextAction } from './next-actions.js';
import { agentOnly } from './agent-only.js';
import { enrichForPoc, type PocEnrichment } from './poc-enrichers.js';
import type { IncidentCluster } from './detectors/incident-cluster.js';
import type { RedundancyPair } from './poc-enrichers.js';
import { fmtAge } from './first-seen.js';

export interface RenderInput {
  siem: SiemId;
  window: string;
  scope?: string;
  query?: string;
  extraction: ExtractedPatterns;
  /** Target event count for the pull (not necessarily reached). */
  targetEventCount: number;
  /** Wall time spent inside SIEM pull. */
  pullWallTimeMs: number;
  /** Wall time spent in the templater. */
  templateWallTimeMs: number;
  /**
   * Raw bytes the customer's SIEM actually ingested across the
   * sampled events — i.e., the size of `events.jsonl` on disk, the
   * outer CW envelope and all. Cost projections use this when
   * present so the dollar figure matches what the vendor bills on,
   * NOT the smaller templater-input size after coerceToLine strips
   * the envelope. If absent, the envelope falls back to
   * extraction.totalBytes (templater input) and notes the gap.
   */
  rawIngestBytes?: number;
  /** Reason the pull ended. */
  reasonStopped: 'target_reached' | 'time_exhausted' | 'source_exhausted' | 'error';
  /** Raw SIEM query string used. */
  queryUsed: string;
  /** Windows in the 'window' string, parsed to hours, used to project $/wk. */
  windowHours: number;
  /** Analyzer cost per GB for the detected SIEM. */
  analyzerCostPerGb: number;
  /**
   * Origin of `analyzerCostPerGb`. Threaded so every dollar emission can
   * route through `fmtDisclosedDollar` with the right disclosure tail.
   *  - 'list_price'        — pulled from vendors.json (needs caveat).
   *  - 'customer_supplied' — caller passed an override rate (no caveat).
   *  - 'unset'             — no rate available (dollar lines drop).
   *
   * TODO(Phase 1.4 upstream): wire from `cost.ts` rate_source upstream of
   * `poc-envelope-v2.ts`; today most callers default to 'list_price' via
   * the vendors.json lookup.
   */
  rateSource?: DollarSource;
  /**
   * Vendor display name for the disclosure tail (e.g. "Splunk", "Datadog").
   * When null, the disclosure renders "at SIEM list price …". Resolved
   * upstream from `SIEM_DISPLAY_NAMES[siem]` when not provided.
   */
  siemLabel?: string | null;
  snapshotId: string;
  startedAt: string;
  finishedAt: string;
  mcpVersion: string;
  /** When a note needs to surface in the banner (e.g., dropped events). */
  banners?: string[];
  /** Pull notes from the connector (retry info, error detail, etc.). */
  pullNotes?: string[];
  /**
   * The customer's total daily log volume (GB/day). Provided by user
   * arg OR auto-detected from the SIEM. When set (and positive), per-
   * pattern costs are scaled from the sample to the full daily volume.
   */
  totalDailyGb?: number;
  /**
   * Where the totalDailyGb came from: 'user_arg' | 'auto_detected' |
   * 'none'. Drives the banner text in the executive summary.
   */
  volumeSource?: 'user_arg' | 'auto_detected' | 'none';
  /** Human-readable label for the detection source (e.g., "Datadog Usage API, 7d avg"). */
  volumeDetectSource?: string;
  /** Error note when auto-detect was attempted but failed. Surfaced under the banner. */
  volumeDetectErrorNote?: string;
  /**
   * Cost-figure uncertainty bracket attached by the volume-detection
   * connector. Set when the detected `totalDailyGb` came from a fallback
   * estimator (Datadog `logs_by_index` × 500 B/event, CloudWatch
   * NEVER_EXPIRE retention) rather than a byte-precise source. When
   * present, every projected cost figure is rendered as a range
   * (`$3.8K - $15.2K/yr`) instead of a single misleading number.
   * Multipliers apply to the central estimate.
   */
  volumeRangeMultiplier?: { low: number; high: number };
  /**
   * Optional: AI-generated display name per pattern identity. When set,
   * the identity is rendered as `<Pretty Name> (<identity>)` in every
   * table instead of just the identity. Missing entries fall back to
   * raw identity — fail-soft.
   */
  aiPrettyNames?: Record<string, string>;
  /** Error note from the AI prettify call, if any. Surfaced in the appendix. */
  aiPrettifyErrorNote?: string;
  /**
   * Per-pattern dependency-check counts, pre-warmed by the POC submit
   * pipeline. When present, the action column refines `mute` →
   * `blocked` for any identity with refs in monitors/dashboards/saved
   * searches. Absence ≠ "no deps"; the renderer marks the cell
   * `(not checked)` when the identity is missing from the map.
   */
  dependencyByIdentity?: Map<string, number>;
  /**
   * Per-pattern first-seen age in seconds, from engine history. Only
   * resolvable when the POC submit pipeline also has an engine env
   * configured AND the pattern has a `tenxHash` known to the engine.
   * Otherwise the column reads `(unknown)` — a degraded, honest cell.
   */
  firstSeenByIdentity?: Map<string, number>;
  /**
   * Epoch-ms window bounds of the SIEM pull. When set, the renderer
   * passes them to the enricher so per-pattern emergence (new / growing
   * / stable / recent_burst) is computed from per-event timestamps
   * inside the window rather than relying on engine history.
   */
  windowStartMs?: number;
  windowEndMs?: number;
}

export interface RenderResult {
  markdown: string;
  summary: {
    eventsAnalyzed: number;
    patternsFound: number;
    totalCostAnalyzed: number;
    projectedSavings: number;
    top3Actions: string[];
  };
}

type Confidence = 'high' | 'medium' | 'low';

/**
 * Local adapter: wrap a bare-number cost as a `DisclosedDollarValue` using
 * the renderer-input's resolved `rateSource` + `siemLabel` + list rate.
 *
 * TODO(Phase 1.4 upstream): once `poc-envelope-v2.ts` and
 * `poc-host-agent-enricher.ts` populate `_disclosed` mirrors on every
 * per-pattern record, delete this adapter and read the mirror directly.
 * Until then this is the single chokepoint so the renderer NEVER calls
 * `fmtDollar` on a raw cost — every $ goes through `fmtDisclosedDollar`
 * with a structurally-attached disclosure tail.
 */
function discloseCost(input: RenderInput, amount: number): DisclosedDollarValue | null {
  const source: DollarSource = input.rateSource ?? 'list_price';
  if (source === 'unset') return null;
  const siemLabel = input.siemLabel ?? SIEM_DISPLAY_NAMES[input.siem] ?? null;
  return buildDisclosedDollarValue(amount, source, siemLabel, input.analyzerCostPerGb);
}

/**
 * Compact disclosed-dollar for table cells. The dollar-discipline invariant
 * requires a `list price` / `may differ` token within 200 chars of every `$`
 * — but the full ~150-char tail repeated in every cell made the tables
 * unreadable. This keeps the invariant with a terse `(list price)` marker and
 * defers the full caveat to `disclosureFootnote()`, rendered ONCE per view.
 *   - list_price        → `$8.6K (list price)`
 *   - customer_supplied → `$8.6K` (no caveat — invariant: real rate, no tail)
 *   - unset             → `—`
 */
function fmtCostDisclosed(input: RenderInput, amount: number): string {
  const d = discloseCost(input, amount);
  if (d == null || d.source === 'unset') return '-';
  const head = fmtDollar(d.value);
  return d.source === 'customer_supplied' ? head : `${head} (list price)`;
}

/**
 * The one-time, full dollar caveat for a view — what every `(list price)`
 * cell points at. Returns null on a customer-supplied / unset rate (nothing
 * to caveat). Append once near the end of each dollar-emitting view instead
 * of repeating the tail per cell.
 */
function disclosureFootnote(input: RenderInput): string | null {
  const source: DollarSource = input.rateSource ?? 'list_price';
  if (source !== 'list_price') return null;
  const siemLabel = input.siemLabel ?? SIEM_DISPLAY_NAMES[input.siem] ?? 'the SIEM';
  return (
    `_Figures marked "(list price)" use ${siemLabel} list price $${input.analyzerCostPerGb}/GB; ` +
    'your actual bill may differ with discounts, commits, or contract tier. Set `analyzerCost` ' +
    'in your env config or pass `effective_ingest_per_gb` for your real rate._'
  );
}

/**
 * Build a display string for a pattern identity. When an AI pretty name
 * exists for this identity, show `<Pretty Name>` with the raw identity
 * inline for copy-paste. Otherwise fall back to the raw identity alone.
 * Never lose the identity — every machine-pasted reference (receiver
 * YAML, SIEM configs) uses the raw form.
 */
/**
 * Convert an engine-emitted symbolMessage (snake_case Reporter-tier name)
 * into a readable bold label. We do NOT invent any words — just replace
 * `_` with space and title-case the existing tokens. The full string
 * stays in the identity code-span next to it.
 */
function formatEngineLabel(symbolMessage: string, maxWords = 6): string {
  const words = symbolMessage.split('_').filter((w) => w.length > 0);
  if (words.length === 0) return symbolMessage;
  const picked = words.slice(0, maxWords).map((w) => w[0].toUpperCase() + w.slice(1));
  const more = words.length > maxWords ? ' …' : '';
  return picked.join(' ') + more;
}

function displayName(
  identity: string,
  template: string,
  aiPrettyNames?: Record<string, string>,
  symbolMessage?: string,
  /**
   * Pre-computed set-difference label for this row. Caller derives it
   * once per visible row set via `setDifferenceLabels()`. When present,
   * overrides the first-N-tokens fallback so rows that share a long
   * symbolMessage prefix get distinct bold names.
   */
  labelOverride?: string,
): string {
  // Priority: AI-prettified > set-difference label > engine symbolMessage > heuristic on body.
  const aiName = aiPrettyNames?.[identity];
  const name = aiName
    ? aiName
    : labelOverride
      ? labelOverride
      : symbolMessage
        ? formatEngineLabel(symbolMessage)
        : heuristicName(template, identity);
  // User-facing rendering leads with the readable name + service; the raw
  // identity (symbolMessage / pattern_hash) is carried in the structured
  // envelope, the receiver-config YAML, and the dependency-check commands,
  // not in the display name. Keeping it out of the name keeps the report
  // scannable and screenshot-clean.
  return `**${name}**`;
}

/** Compact variant for table cells: pretty name with truncated identity suffix. */
function displayNameCompact(
  identity: string,
  template: string,
  aiPrettyNames?: Record<string, string>,
  symbolMessage?: string,
  /**
   * Optional pre-computed display form to use in place of head-truncated
   * identity. Used for common-prefix cropping across multi-row tables:
   * the caller computes the longest common prefix across all rendered
   * identities and passes each row's cropped `…<unique tail>`. The
   * full identity is still used internally for the AI-pretty-names
   * lookup so we don't lose that mapping.
   */
  displayOverride?: string,
  /**
   * Pre-computed set-difference label for this row. See `displayName`.
   */
  labelOverride?: string,
): string {
  const aiName = aiPrettyNames?.[identity];
  const name = aiName
    ? aiName
    : labelOverride
      ? labelOverride
      : symbolMessage
        ? formatEngineLabel(symbolMessage)
        : heuristicName(template, identity);
  // Identity intentionally omitted from the rendered table cell (see
  // displayName): the report leads with the readable name + service.
  void displayOverride;
  return `**${name}**`;
}

/**
 * Set-difference labeling: pick bold tokens that DIFFER across the
 * visible row set, not the first six tokens of each row's symbolMessage.
 *
 * Problem: every K8s audit-log pattern starts with
 * `kind_Event_apiVersion_audit_ks_io_…` so the first-six-tokens label
 * is identical for every row. The discriminator is buried in the tail
 * (requestURI path, verb, level), which the label drops.
 *
 * Algorithm: delegates to the shared discriminator-first naming
 * (lib/pattern-df.ts `buildDisplayName`). Boilerplate is learned from
 * cross-pattern token frequency (absolute df ≥ ceil(N/2)), the rarest
 * tokens are surfaced in the name's ORIGINAL order, and camelCase is
 * preserved (never Title-cased). This is the SAME naming top_patterns /
 * pattern_detail use, so a pattern reads consistently across surfaces.
 *
 * No cross-page uniqueness pass here (unlike top_patterns): the PoC renders
 * the raw identity alongside every name, so near-identical patterns (e.g. a
 * crash-loop logged 13× as one incident) are still distinguishable — and
 * forcing distinct labels on them produced long token-stuffed names. They
 * SHOULD read alike; the report already clusters them as one incident.
 *
 * (Replaces the prior hand-rolled set-difference: a fractional 60% common
 * threshold that leaked the boilerplate run at small N, and a Title-case
 * join that mangled camelCase — ValkeyCartStore → Valkeycartstore. It also
 * omitted sparse rows, which is what surfaced raw hashes / "Unnamed pattern"
 * downstream; buildDisplayName never blanks, so those rows now get a name.)
 *
 * Returns identity → label map. Identities without a symbolMessage are
 * omitted (the caller falls back to the template heuristic).
 */
function setDifferenceLabels(
  rows: Array<{ identity: string; symbolMessage?: string; service?: string; severity?: string }>,
): Map<string, string> {
  const out = new Map<string, string>();
  const withSym = rows.filter((r) => r.symbolMessage && r.symbolMessage.length > 0);
  if (withSym.length === 0) return out;
  // One df-map over the visible pattern set — same basis as top_patterns.
  const df = buildDfContext(withSym.map((r) => r.symbolMessage as string));
  for (const r of withSym) {
    // Wider budget than the console (56 vs 44) — the markdown report has room,
    // and it avoids mid-cropping a discriminator token ("transport" -> "tra…rt").
    const { display_name } = buildDisplayName(r.symbolMessage as string, {
      df,
      service: r.service,
      severity: r.severity,
      width: 56,
    });
    if (display_name) out.set(r.identity, display_name);
  }
  return out;
}

/**
 * Longest common prefix across a set of strings. Returns empty string
 * if the set has fewer than 2 entries or no shared lead-in. Used by
 * table renderers to crop a noisy common prefix off the displayed
 * identity column so the per-row tail (the part that actually differs)
 * is visible.
 */
function longestCommonPrefix(strs: string[]): string {
  if (strs.length < 2) return '';
  let prefix = strs[0];
  for (let i = 1; i < strs.length && prefix.length > 0; i++) {
    const s = strs[i];
    let j = 0;
    while (j < prefix.length && j < s.length && prefix.charCodeAt(j) === s.charCodeAt(j)) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix;
}

/**
 * Per-row crop of a shared prefix. The naive "longest prefix across
 * the whole table" approach fails the moment a single outlier row
 * doesn't share that prefix (LCP collapses to empty). Instead we sort
 * the identities lexicographically and find runs where each adjacent
 * pair's LCP meets `minPrefix`; each run gets cropped against the
 * run's own LCP. Outliers (singletons) are left alone and the caller
 * falls back to head-truncation for them.
 *
 *   - maxLen: visible cap on each row's cropped display.
 *   - minPrefix: minimum shared prefix length before cropping fires.
 */
function buildCroppedDisplays(
  identities: string[],
  maxLen = 40,
  minPrefix = 12,
): Map<string, string> {
  const out = new Map<string, string>();
  if (identities.length < 2) return out;
  const sorted = [...identities].sort();
  // Walk sorted list, group into runs where adjacent pair-LCP ≥ minPrefix.
  let runStart = 0;
  for (let i = 1; i <= sorted.length; i++) {
    const pairLcp = i < sorted.length ? longestCommonPrefix([sorted[i - 1], sorted[i]]) : '';
    if (i === sorted.length || pairLcp.length < minPrefix) {
      // Close the current run [runStart, i)
      if (i - runStart >= 2) {
        const run = sorted.slice(runStart, i);
        const lcp = longestCommonPrefix(run);
        if (lcp.length >= minPrefix) {
          for (const id of run) {
            if (id.length <= lcp.length) continue;
            const tail = id.slice(lcp.length);
            const display = tail.length > maxLen - 1 ? '…' + tail.slice(-(maxLen - 1)) : '…' + tail;
            out.set(id, display);
          }
        }
      }
      runStart = i;
    }
  }
  return out;
}

/**
 * Build a "good enough" human-readable pattern name WITHOUT an LLM.
 * Used when MCP sampling (AI prettify) isn't available or returned
 * nothing for this identity. Strictly better than the raw underscored
 * identity — turns
 *   `$(ts) ERROR payment_gateway_timeout customer=$ amount=$ provider=$`
 * into `Payment Gateway Timeout Customer`.
 *
 * Heuristic steps:
 *   1. Strip `$(…)` format specs (timestamps, typed slots).
 *   2. Strip literal ISO-ish timestamps baked into the text
 *      (`2025-10-01T21:25:01.539Z`, bare `HH:MM:SS`, etc.).
 *   3. Strip leading severity keyword.
 *   4. Collapse `key=$` → `key` (keep the attribute name as a word).
 *   5. Drop bare `$` placeholders.
 *   6. Split on non-word, drop short / purely-numeric tokens.
 *   7. Title-case the first 4 content tokens.
 */
function heuristicName(template: string, identity: string): string {
  let s = template;
  s = s.replace(/\$\([^)]*\)/g, ' ');
  s = s.replace(
    /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}([T\s]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?Z?)?\b/g,
    ' '
  );
  s = s.replace(/\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?Z?\b/g, ' ');
  s = s.trim().replace(/^(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|CRIT(?:ICAL)?)\b\s*/i, '');
  s = s.replace(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\$/g, '$1');
  s = s.replace(/\$/g, ' ');
  const tokens = s
    .split(/[^A-Za-z0-9]+/)
    .filter((t) => t.length >= 2)
    .filter((t) => !/^\d+$/.test(t));
  const picked = tokens.slice(0, 4);
  if (picked.length === 0) return 'Unnamed pattern';
  // If every picked token is short (≤3 chars) and there's no
  // recognizable content word, we're tokenizing a templateHash
  // (happens when the engine didn't emit a body for this hash and
  // pattern-extraction fell back to `hash` as the body). Better to
  // label honestly than to print "Hu Zz6j Mr" / "Sy8fu9l" gibberish.
  const hasContentWord = picked.some((t) => t.length >= 4);
  if (!hasContentWord) return 'Unnamed pattern';
  return picked.map((t) => t[0].toUpperCase() + t.slice(1).toLowerCase()).join(' ');
}

/** Resolve a display name: AI > set-difference label > heuristic > spaced identity. */
function resolveName(
  identity: string,
  template: string,
  aiPrettyNames?: Record<string, string>,
  labelOverride?: string,
): string {
  return aiPrettyNames?.[identity] || labelOverride || heuristicName(template, identity);
}

interface EnrichedPattern extends ExtractedPattern {
  costPerWindow: number;
  pctOfTotal: number;
  costPerWeek: number;
  /**
   * The lossless cost-cutting lever picked for this pattern. We NEVER
   * auto-recommend `mute`/`drop`/`sample` (that contradicts the "save
   * money WITHOUT losing data" pitch). Every reducible pattern gets a
   * lossless lever; everything else is kept verbatim.
   *   - `compact`   — re-encode in place, stays searchable in the SIEM.
   *   - `offload`   — route to the customer's own S3, recoverable any time.
   *   - `tier_down` — move to the SIEM's cheaper in-platform tier, retained.
   *   - `keep`      — errors/warnings + low-volume patterns pass through.
   */
  recommendedAction: 'compact' | 'offload' | 'tier_down' | 'keep';
  /**
   * The MEASURED (compact) or modeled (offload/tier_down) fraction of
   * this pattern's bytes the lever removes from the SIEM bill. Drives
   * projectedSavings. `keep` → 0.
   */
  leverFraction: number;
  /**
   * Retained for type-compat with the envelope/enricher param shapes.
   * Always 1 now (we do not sample).
   */
  sampleRate: number;
  projectedSavings: number;
  reasoning: string;
  confidence: Confidence;
  /** Snake-case identity, for ready-to-paste receiver configs. */
  identity: string;
  /** POC enrichment fields (incident cluster id, top slot, redundancy, dep-check, first-seen). */
  poc: PocEnrichment;
  /**
   * Longest verbatim literal run from the template body, used as a
   * phrase-match anchor in exclusion configs. Indexed phrase queries
   * are 1–2 orders of magnitude cheaper at SIEM ingest scale than
   * regex with `.*` interleaving, and don't false-positive on token
   * reorderings.
   */
  literalPhrase: string;
  /**
   * True when `literalPhrase` sits at the start of the template (so
   * a phrase-prefix anchor is exact). False when the template begins
   * with a variable slot and the phrase is the longest internal run.
   * Exclusion configs prepend an approximation footnote in that case.
   */
  literalLeading: boolean;
  /**
   * The destination's preferred level-1 action (`tier_down`, `offload`,
   * `compact`, ...) per `DEFAULT_ACTION_BY_DESTINATION`. Informs which
   * lossless lever the decision falls to when compact is unavailable
   * (Datadog: tier_down, Splunk: offload, ClickHouse: compact, ...).
   */
  destinationLevel1Action: CostAction;
}

/**
 * ────────── View-specific renderers ──────────
 *
 * The MCP tool returns one of six shapes depending on the caller's
 * `view` arg. The idea is progressive disclosure: the default
 * `summary` is scannable in a CLI (~30 lines); callers can re-invoke
 * status with a more verbose view when they need specific artifacts.
 *
 * All views share the same `enrichPatterns()` + `displayName()`
 * helpers so a given RenderInput always produces consistent output
 * across views — only the level of detail changes.
 */

/**
 * Short-form view — the default. Annual savings banner, top-5 table,
 * risk flags, available views CTA. Intended to be scannable in one
 * terminal screen.
 */
export function renderPocSummary(input: RenderInput, topN = 5): string {
  const { patterns, clusters, redundancyPairs } = enrichPatternsWithSections(input);
  const setDiff = setDifferenceLabels(patterns);
  const totalCost = patterns.reduce((s, p) => s + p.costPerWindow, 0);
  const projectedSavings = patterns.reduce((s, p) => s + p.projectedSavings, 0);
  const lines: string[] = [];

  // Title + one-line verdict.
  lines.push(`## POC done. ${SIEM_DISPLAY_NAMES[input.siem]}, ${input.window} window.`);
  lines.push('');

  // Scale-brag line + emergence categorization. The agent reading the
  // report sees what was analyzed AT WHAT SCALE — the differentiator
  // against an unaided AI that pulled a 5,000-line sample.
  lines.push(renderScaleHeader(input, patterns));
  lines.push('');
  const emergence = countEmergence(patterns);
  if (emergence.hasTimestamps) {
    lines.push(renderEmergenceSummary(emergence));
    lines.push('');
  }

  if (input.totalDailyGb && input.totalDailyGb > 0) {
    const annualCost = projectBilling(totalCost, input.windowHours, 24 * 365);
    const annualSavings = projectBilling(projectedSavings, input.windowHours, 24 * 365);
    const savingsPct = fmtPct((annualSavings / Math.max(1, annualCost)) * 100);
    const mode = input.volumeSource === 'auto_detected' ? 'auto-detected' : 'user-supplied';
    const m = input.volumeRangeMultiplier;
    lines.push(
      `Projected annual cost: **${formatCostRange(input, annualCost, m)}** · Potential savings: **${formatCostRange(input, annualSavings, m)} (${savingsPct})** at ${fmtGb(input.totalDailyGb)}/day (${mode}).`
    );
    if (m) {
      lines.push('');
      lines.push(
        `_Cost range reflects ${m.low}× to ${m.high}× uncertainty in the auto-detected volume. For a single precise number, pass \`total_daily_gb\` directly or grant the SIEM API key its byte-precise scope (e.g. Datadog \`usage_read\`)._`
      );
    }
  } else {
    // No volume — give the most useful scenario on one line, point to full for the table.
    const oneHundred = scaleCostToDaily(totalCost, input.extraction.totalBytes, 100, input.windowHours);
    const oneHundredSavings = scaleCostToDaily(projectedSavings, input.extraction.totalBytes, 100, input.windowHours);
    lines.push(
      `No volume specified. At 100 GB/day the lossless plan would save **${fmtCostDisclosed(input, oneHundredSavings)}/yr** out of **${fmtCostDisclosed(input, oneHundred)}/yr** total cost, with every line kept (compacted in place or recoverable from your S3). For a precise projection, pass \`total_daily_gb\`, \`total_monthly_gb\`, or \`total_annual_gb\` on submit (or call status with \`view: "full"\` to see the full scenario table).`
    );
  }
  lines.push('');

  // Incident-grouping section — surfaces multi-pattern incidents
  // before the top-N table so the agent sees co-occurring failures
  // grouped. The detector itself sits in detectors/incident-cluster.ts.
  if (clusters.length > 0) {
    lines.push('### Same incident, multiple patterns');
    lines.push('');
    lines.push(
      `${clusters.length} incident${clusters.length === 1 ? '' : 's'} detected: co-occurring patterns that share a service and overlap on descriptor tokens.`,
    );
    lines.push('');
    lines.push('| Incident | Service | Patterns | Combined $/mo | Signal |');
    lines.push('|---|---|---|---|---|');
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      const label = truncate(c.representativeLabel, 60);
      const ids = c.members.map((m) => `\`${shortIdentity(m.identity)}\``).join(', ');
      lines.push(
        `| ${i + 1}. ${label} | ${c.service} | ${ids} | ${fmtCostDisclosed(input, c.combinedMonthlyUsd)} | ${c.joinSignal} (${(c.confidence * 100).toFixed(0)}%) |`,
      );
    }
    lines.push('');
    lines.push(
      '_When two patterns cluster as one incident, the right next step is usually a single upstream fix (broken dependency, missing config) rather than reducing each pattern separately._',
    );
    lines.push('');
  }

  // Redundancy pairs — patterns whose event counts match 1:1 within
  // the sample. Likely the same business event logged at two stages
  // (request-received + transaction-complete, http-in + http-out).
  if (redundancyPairs.length > 0) {
    lines.push('### Redundant pairs');
    lines.push('');
    lines.push(
      `${redundancyPairs.length} pair${redundancyPairs.length === 1 ? '' : 's'} of patterns fire ~1:1 in the sample, likely the same event logged at two stages. Consolidate to one stage upstream if you can.`,
    );
    lines.push('');
    lines.push('| Pattern A | Pattern B | Count ratio | Min count |');
    lines.push('|---|---|---|---|');
    for (const pair of redundancyPairs.slice(0, 5)) {
      lines.push(
        `| \`${shortIdentity(pair.identityA)}\` | \`${shortIdentity(pair.identityB)}\` | ${pair.ratio.toFixed(2)} | ${fmtCount(pair.minCount)} |`,
      );
    }
    lines.push('');
  }

  // Top-N table.
  const top = patterns.slice(0, topN);
  if (top.length > 0) {
    lines.push(`### Top ${top.length} wins`);
    lines.push('');
    // New columns: Action (refined from dep-check + severity), Slot fan-out
    // (top cardinality), Age (first-seen from engine or `(unknown)`).
    lines.push('| # | Pattern | Service | Sev | % | Action | Slot fan-out | Age | Annual savings |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (let i = 0; i < top.length; i++) {
      const p = top[i];
      const name = resolveName(p.identity, p.template, input.aiPrettyNames, setDiff.get(p.identity));
      const annualSavings = projectBilling(p.projectedSavings, input.windowHours, 24 * 365);
      const flag = needsReview(p) ? ' ⚠' : '';
      const cluster = p.poc.incidentClusterId !== null ? ` 🔗${p.poc.incidentClusterId + 1}` : '';
      const action = renderActionCell(p);
      const slot = renderSlotCell(p);
      const age = renderEmergenceCell(p);
      lines.push(
        `| ${i + 1} | ${name}${flag}${cluster} | ${p.service || '-'} | ${p.severity || '-'} | ${fmtPct(p.pctOfTotal * 100)} | ${action} | ${slot} | ${age} | ${fmtCostDisclosed(input, annualSavings)} |`,
      );
    }
    lines.push('');
    if (clusters.length > 0) {
      lines.push('_🔗N marks a row that belongs to incident #N above._');
      lines.push('');
    }
  }

  // Risk flags.
  const flagged = top.filter(needsReview);
  if (flagged.length > 0) {
    lines.push(
      `⚠ ${flagged.length} pattern${flagged.length === 1 ? '' : 's'} flagged (WARN/ERROR severity or low sample confidence). ` +
        `Run \`log10x_dependency_check\` before changing them; they may feed live alerts or dashboards.`
    );
    lines.push('');
  }

  // Views CTA.
  lines.push('**Available views**, call `log10x_poc_from_siem_status` again with:');
  lines.push('- `view: "full"`: complete 9-section report');
  lines.push('- `view: "yaml"`: receiver config for top patterns (compact / offload), paste-ready');
  lines.push('- `view: "configs"`: native SIEM hard-drop configs (lossy escape hatch, not recommended)');
  lines.push('- `view: "pattern", pattern: "<identity>"`: deep dive on a specific pattern');
  lines.push('- `view: "top", top_n: 20`: expanded drivers table');

  const foot = disclosureFootnote(input);
  if (foot) {
    lines.push('');
    lines.push(foot);
  }

  return lines.join('\n');
}

/**
 * YAML view — receiver mute-file entries for the top N patterns.
 * Paste-ready for a GitOps ConfigMap commit. Includes the display
 * name as a YAML comment so reviewers can scan without decoding the
 * identity strings.
 */
export function renderPocYaml(input: RenderInput, topN = 5): string {
  const patterns = enrichPatterns(input)
    .filter((p) => p.recommendedAction !== 'keep')
    .slice(0, topN);
  const lines: string[] = [];
  lines.push('```yaml');
  lines.push('# receiver config, paste into your GitOps ConfigMap');
  lines.push(`# Generated from snapshot ${input.snapshotId} on ${input.finishedAt}`);
  lines.push('# Lossless: every entry is compacted, offloaded (recoverable), or tier-dropped. Nothing dropped.');
  lines.push('# Run log10x_dependency_check on each identity before committing.');
  lines.push('');
  if (patterns.length === 0) {
    lines.push('# Nothing reducible in this window. 10x keeps everything; no config entries needed.');
  } else {
    for (const p of patterns) {
      const name = input.aiPrettyNames?.[p.identity];
      if (name) lines.push(`# ${name}`);
      lines.push(receiverYaml(p));
      lines.push('');
    }
  }
  lines.push('```');
  return lines.join('\n');
}

/**
 * Native SIEM exclusion-config view — the "I don't want the log10x
 * receiver, just give me the raw SIEM config" path.
 */
export function renderPocConfigs(input: RenderInput, topN = 5): string {
  // The default plan is lossless (compact / offload / tier_down) and drops
  // nothing. This view is the explicit escape hatch for a user who wants to
  // HARD-DROP a pattern at the SIEM/forwarder (lossy, not recommended). The
  // candidates are the reducible patterns; the user opted in by asking for
  // native exclusion configs.
  const drops = enrichPatterns(input)
    .filter((p) => p.recommendedAction !== 'keep')
    .slice(0, topN);
  const lines: string[] = [];
  lines.push(`## Native ${SIEM_DISPLAY_NAMES[input.siem]} exclusion configs`);
  lines.push('');
  if (drops.length === 0) {
    lines.push('_Nothing reducible in this window. 10x keeps everything, so there is nothing to exclude._');
    return lines.join('\n');
  }
  lines.push(
    `> **Lossy, not recommended.** These configs hard-drop the lines at ${SIEM_DISPLAY_NAMES[input.siem]} / the forwarder, so the data is gone. 10x's default plan keeps every line (compact in place or offload to your S3, recoverable). Use these only if you specifically want to discard a pattern.`,
  );
  lines.push('');
  lines.push('Apply these in your SIEM admin console OR via the vendor API. Run `log10x_dependency_check` first.');
  lines.push('');
  lines.push(`### ${SIEM_DISPLAY_NAMES[input.siem]}`);
  lines.push('');
  lines.push('```');
  lines.push(nativeConfig(input.siem, drops).trim());
  lines.push('```');
  lines.push('');
  lines.push('### Fluent Bit (universal forwarder)');
  lines.push('');
  lines.push('```');
  lines.push(fluentBitConfig(drops).trim());
  lines.push('```');
  return lines.join('\n');
}

/**
 * Top-N drivers view — the summary's table, but larger and without
 * the surrounding banner/CTA. For "show me the top 20."
 */
export function renderPocTop(input: RenderInput, topN = 20): string {
  const patterns = enrichPatterns(input);
  const setDiff = setDifferenceLabels(patterns);
  const top = patterns.slice(0, topN);
  const lines: string[] = [];
  lines.push(`## Top ${top.length} cost drivers`);
  lines.push('');
  const hasScaledCost = Boolean(input.totalDailyGb && input.totalDailyGb > 0);
  if (hasScaledCost) {
    lines.push(`_Scaled to ${fmtGb(input.totalDailyGb!)}/day_`);
    lines.push('');
  }
  lines.push('| # | Pattern | Service | Sev | Events | % | $/week | $/year |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (let i = 0; i < top.length; i++) {
    const p = top[i];
    const name = resolveName(p.identity, p.template, input.aiPrettyNames, setDiff.get(p.identity));
    const weekly = p.costPerWeek;
    const annual = projectBilling(p.costPerWindow, input.windowHours, 24 * 365);
    const flag = needsReview(p) ? ' ⚠' : '';
    lines.push(
      `| ${i + 1} | ${name}${flag} | ${p.service || '-'} | ${p.severity || '-'} | ${fmtCount(p.count)} | ${fmtPct(p.pctOfTotal * 100)} | ${fmtCostDisclosed(input, weekly)} | ${fmtCostDisclosed(input, annual)} |`
    );
  }
  return lines.join('\n');
}

/**
 * Pattern-detail view — one pattern, fully expanded. Sample event,
 * slot variables, recommended action, receiver YAML, risk context.
 */
export function renderPocPattern(input: RenderInput, identity: string): string {
  const patterns = enrichPatterns(input);
  const setDiff = setDifferenceLabels(patterns);
  const p = patterns.find((x) => x.identity === identity);
  if (!p) {
    const suggestions = patterns
      .slice(0, 5)
      .map((x) => `  - \`${x.identity}\``)
      .join('\n');
    return (
      `## Pattern not found\n\nNo pattern with identity \`${identity}\` in snapshot ${input.snapshotId}.\n\n` +
      `Top patterns in this snapshot (any of these work):\n${suggestions}`
    );
  }
  const lines: string[] = [];
  const name = resolveName(p.identity, p.template, input.aiPrettyNames, setDiff.get(p.identity));
  const annualSavings = projectBilling(p.projectedSavings, input.windowHours, 24 * 365);
  lines.push(`## ${name}`);
  lines.push('');
  lines.push(`**Identity**: \`${p.identity}\``);
  lines.push(
    `**Stats**: ${p.severity || '-'} severity · ${fmtCount(p.count)} events · ${fmtPct(p.pctOfTotal * 100)} of sample volume · ${p.service || 'unknown service'}`
  );
  if ((p.costPerWindow > 0 || annualSavings > 0) && (input.rateSource ?? 'list_price') !== 'unset') {
    lines.push(`**Projected cost**: ${fmtCostDisclosed(input, p.costPerWindow)}/window · **Lossless savings**: ${fmtCostDisclosed(input, annualSavings)}/year`);
  }
  lines.push(`**Confidence**: ${p.confidence}`);
  lines.push('');
  lines.push('### Sample event');
  lines.push('```');
  lines.push(truncate(p.sampleEvent, 400));
  lines.push('```');
  lines.push('');
  lines.push('### Template');
  lines.push('```');
  lines.push(truncate(p.template, 400));
  lines.push('```');
  lines.push('');
  // Sort slots so high-cardinality (interesting variation) and low-cardinality
  // (good grouping / filter candidates) are clearly distinguishable. Low-card
  // slots (1-3 distinct values) are surfaced as candidate filters in the
  // structured next-actions block below; high-card slots (10+ distinct values)
  // signal where event-by-event variation actually lives.
  const slotsByCount = Object.entries(p.variables)
    .map(([slot, vals]) => ({ slot, vals, distinct: vals.length }))
    .sort((a, b) => b.distinct - a.distinct);
  if (slotsByCount.length > 0) {
    lines.push('### Variable slots (sorted by distinct count, descending)');
    for (const { slot, vals, distinct } of slotsByCount.slice(0, 6)) {
      const distinctTag = distinct === 1 ? 'constant' : `${distinct} distinct`;
      lines.push(`- \`${slot}\` (${distinctTag}): ${vals.slice(0, 5).map((v) => `\`${truncate(v, 40)}\``).join(', ')}${vals.length > 5 ? `, … (${vals.length - 5} more)` : ''}`);
    }
    lines.push('');
  }
  lines.push(`### Recommendation: ${actionLabel(p, SIEM_DISPLAY_NAMES[input.siem])}`);
  lines.push(p.reasoning);
  lines.push('');
  if (p.recommendedAction !== 'keep') {
    lines.push('**Receiver config** (paste into GitOps ConfigMap):');
    lines.push('```yaml');
    lines.push(receiverYaml(p));
    lines.push('```');
    lines.push('');
  }
  if (needsReview(p)) {
    // User-facing fact: this pattern has a profile that warrants review.
    lines.push(
      `> **Review before changing**: this pattern\'s ${p.severity || 'severity'}/${p.confidence} profile means it may feed live alerts or dashboards. The lever is lossless (nothing is dropped), but confirm the dependency surface first.`
    );
    // Agent-only: the specific tool to call before any change.
    lines.push(agentOnly(`Constraint: before generating a receiver config for '${p.identity}', call log10x_dependency_check({ pattern: '${p.identity}' }) and surface its findings to the user.`));
  }

  // Structured NEXT_ACTIONS for autonomous chains. The pattern view is a
  // natural handoff into deeper investigation: dependency_check before any
  // change, retriever_query for archive history (with a worked filter on the
  // strongest low-cardinality slot when one exists), pattern_trend for
  // volume series.
  const nextActions: NextAction[] = [
    {
      tool: 'log10x_dependency_check',
      args: { pattern: p.identity },
      reason: 'check dashboards / alerts before changing this pattern',
    },
    {
      tool: 'log10x_pattern_trend',
      args: { pattern: p.identity },
      reason: 'volume series for the resolved pattern',
    },
  ];
  // Pick a candidate filter slot: lowest non-1 distinct count (not constant,
  // not too high-cardinality). Surface as a worked retriever_query that the
  // agent can run verbatim or adjust.
  const filterCandidate = slotsByCount.find((s) => s.distinct >= 2 && s.distinct <= 10);
  if (filterCandidate && filterCandidate.vals[0]) {
    const slotName = filterCandidate.slot.replace(/^slot_/, 'slot_');
    const sampleValue = filterCandidate.vals[0];
    nextActions.push({
      tool: 'log10x_retriever_query',
      args: {
        pattern: p.identity,
        from: 'now-7d',
        to: 'now',
        filters: [`event.${slotName} === ${JSON.stringify(sampleValue)}`],
      },
      reason: `historical events of this pattern filtered to ${slotName}=${truncate(sampleValue, 30)} (one of ${filterCandidate.distinct} distinct values)`,
    });
  }
  const block = renderNextActions(nextActions);
  if (block) {
    lines.push('');
    lines.push(block);
  }
  return lines.join('\n');
}

/**
 * Full view — the original 9-section report. Unchanged; the summary
 * / yaml / configs / top / pattern views are slices of the same data.
 */
export function renderPocReport(input: RenderInput): RenderResult {
  const patterns = enrichPatterns(input);
  // Set-difference labels: one stable label per pattern across the
  // whole report, computed against the full visible set so rows
  // sharing a long symbolMessage prefix (K8s audit logs, OTel spans)
  // get distinct bold names instead of all reading "Kind Event …".
  const setDiff = setDifferenceLabels(patterns);
  const lines: string[] = [];

  // Banner block
  if (input.banners && input.banners.length > 0) {
    for (const b of input.banners) {
      lines.push(`> **Note**: ${b}`);
      lines.push('');
    }
  }
  if (input.extraction.totalEvents < 10_000) {
    lines.push(
      '> **Low-confidence mode**: fewer than 10,000 events analyzed. Top-5 drivers are reliable; long-tail recommendations are flagged low-confidence. Rerun with a larger `target_event_count` or `window` for deeper coverage.'
    );
    lines.push('');
  }
  // G11 mitigation: the engine-side templater silently drops input
  // lines under certain conditions (multi-line stack traces, event-
  // boundary crossings, high-cardinality variant overfitting). The
  // resolve_batch tool surfaces the same warning at lines 160-195;
  // mirror it here so POC users see the gap too. Gate at >50 input
  // lines because tiny batches can lose lines for legitimate
  // template-overfitting reasons; >50 is anomalous.
  const lineCount = input.extraction.inputLineCount;
  const accountedEvents = input.extraction.totalEvents;
  const droppedEvents = Math.max(0, lineCount - accountedEvents);
  const dropRate = lineCount > 0 ? droppedEvents / lineCount : 0;
  if (lineCount > 50 && droppedEvents > 0) {
    const pctLabel = `${Math.round(dropRate * 100)}%`;
    if (dropRate >= 0.2) {
      // User-facing fact about the dropped lines.
      lines.push(
        `> **${fmtCount(droppedEvents)} input lines (${pctLabel}) were not accounted for by the engine.** ` +
          `Per-pattern event counts sum to ${fmtCount(accountedEvents)}, less than the sample line count (${fmtCount(lineCount)}). ` +
          `Known engine-side bug (GAPS G11): the engine silently drops lines under certain conditions ` +
          `(multi-line stack traces, event-boundary crossings, high-cardinality variant overfitting). ` +
          `The dropped lines may contain the highest-volume patterns, so the savings projection below should be treated as a lower bound.`
      );
      // Agent-only constraint + workarounds.
      lines.push(agentOnly(
        `Constraint: do not treat the savings projection as complete when drop_rate ≥ 20%. ` +
        `Workarounds to surface: (1) rerun with a smaller target_event_count and broader window so each batch is large enough that overfitting is unlikely; ` +
        `(2) use log10x_event_lookup on an individual line for ground truth on a specific pattern.`
      ));
      lines.push('');
    } else if (dropRate >= 0.05) {
      lines.push(
        `_Note: ${fmtCount(droppedEvents)} sample lines (${pctLabel}) were not accounted for by the engine. Minor drop, likely tiny-batch overfitting._`
      );
      lines.push('');
    }
  }
  if (input.reasonStopped === 'time_exhausted') {
    lines.push(
      `> Analyzed ${fmtCount(input.extraction.totalEvents)} events (time budget reached before target count). Top patterns reliable; long-tail recommendations may be noisy. Rerun with \`max_pull_minutes: 15\` for deeper coverage.`
    );
    lines.push('');
  }

  const siemName = SIEM_DISPLAY_NAMES[input.siem];
  lines.push(`# Log10x POC Report: ${siemName}`);
  lines.push('');
  lines.push(
    `_${input.window} window · scope=\`${input.scope || '(none)'}\`${input.query ? ` · query=\`${input.query}\`` : ''} · snapshot_id=\`${input.snapshotId}\`_`
  );
  lines.push('');

  // Section 1: Executive summary
  const totalCost = patterns.reduce((s, p) => s + p.costPerWindow, 0);
  const projectedSavings = patterns.reduce((s, p) => s + p.projectedSavings, 0);
  const top3 = patterns.slice(0, 3);
  // Lossless headline: lead with the % cut and "without losing data". The
  // levers behind it are compact (stays searchable) + offload (recoverable);
  // we never sample or drop. Volume framing first, dollars trail in the body.
  const savingsPctVal = totalCost > 0 ? (projectedSavings / totalCost) * 100 : 0;
  if (savingsPctVal > 0) {
    lines.push(`## Result: about ${fmtPct(savingsPctVal)} less ${siemName} spend, without losing data`);
    lines.push('');
    lines.push(
      `10x groups your logs by message type, then cuts the cost of the heavy ones without deleting them. ` +
        `Every line stays queryable in ${siemName} (compacted in place) or recoverable from your own S3 (offloaded). No sampling, no dropping.`,
    );
    lines.push('');
  }
  lines.push('## 1. Executive Summary');
  lines.push('');
  lines.push(
    `Analyzed **${fmtCount(input.extraction.totalEvents)} events** (${fmtBytes(input.extraction.totalBytes)}) from ${siemName} across the last ${input.window}.`
  );
  lines.push('');
  if (input.totalDailyGb && input.totalDailyGb > 0) {
    // Volume known — costs are scaled from sample to real daily spend.
    const bannerTitle =
      input.volumeSource === 'auto_detected'
        ? `**Volume auto-detected**: ${fmtGb(input.totalDailyGb)}/day (${input.volumeDetectSource || 'SIEM usage API'})`
        : `**Volume-scaled mode**: ${fmtGb(input.totalDailyGb)}/day (user-supplied)`;
    lines.push(`> ${bannerTitle}`);
    lines.push('>');
    lines.push(
      `> Cost figures below extrapolate from the pulled sample (${fmtBytes(input.extraction.totalBytes)}) to the full daily volume by per-pattern %. Pattern rankings and the receiver config are the same regardless of volume; only the dollar figures scale.`
    );
    lines.push('');
    const dailyCost = projectBilling(totalCost, input.windowHours, 24);
    const weeklyCost = projectBilling(totalCost, input.windowHours, 24 * 7);
    const monthlyCost = projectBilling(totalCost, input.windowHours, 24 * 30);
    const annualCost = projectBilling(totalCost, input.windowHours, 24 * 365);
    const annualSavings = projectBilling(projectedSavings, input.windowHours, 24 * 365);
    const m = input.volumeRangeMultiplier;
    const savingsPctAnnual = fmtPct((annualSavings / Math.max(1, annualCost)) * 100);
    lines.push(`- **Lossless reduction**: about ${savingsPctAnnual} of volume, with every line kept (compacted in place or recoverable from your S3).`);
    lines.push(`- **Projected daily cost**: ${formatCostRange(input, dailyCost, m)}`);
    lines.push(`- **Projected monthly cost**: ${formatCostRange(input, monthlyCost, m)}`);
    lines.push(`- **Projected annual cost**: ${formatCostRange(input, annualCost, m)}`);
    void weeklyCost;
    lines.push(
      `- **Potential annual savings**: **${formatCostRange(input, annualSavings, m)}**, ${savingsPctAnnual} of annual cost`
    );
    if (m) {
      lines.push('');
      lines.push(
        `> Cost ranges reflect ${m.low}× to ${m.high}× uncertainty in the volume estimate (${input.volumeDetectSource || 'auto-detected'}). For a single precise number, pass \`total_daily_gb\` directly or unlock the byte-precise SIEM endpoint (e.g. Datadog \`usage_read\` scope).`
      );
    }
  } else {
    // Volume unknown — render scenario brackets so the user still sees
    // dollar magnitudes, plus an explicit call-to-action with whatever
    // error note we got from auto-detection (if attempted).
    const detectHeader = input.volumeDetectErrorNote
      ? `**Volume auto-detection skipped**: ${input.volumeDetectErrorNote}. Showing scenario brackets below.`
      : `**No volume specified**: showing scenario brackets. Pass \`total_daily_gb\`, \`total_monthly_gb\`, or \`total_annual_gb\` for a precise projection.`;
    lines.push(`> ${detectHeader}`);
    lines.push('');
    lines.push('**Projected annual savings by ingest volume** (lossless: compact in place + offload to your S3, nothing dropped):');
    lines.push('');
    lines.push('| Daily ingest | Monthly ingest | Projected annual cost | Projected annual savings |');
    lines.push('|---|---|---|---|');
    const scenarios: Array<{ daily: number; label: string }> = [
      { daily: 10, label: '10 GB/day' },
      { daily: 50, label: '50 GB/day' },
      { daily: 100, label: '100 GB/day' },
      { daily: 500, label: '500 GB/day' },
      { daily: 2000, label: '2 TB/day' },
    ];
    // Scale factor per scenario: scenarioDailyGb / sampleGb. Our totalCost
    // is over the pulled window — scale up proportionally.
    const sampleGb = input.extraction.totalBytes / (1024 ** 3);
    for (const sc of scenarios) {
      if (sampleGb === 0) continue;
      const factor = sc.daily / sampleGb;
      const annualCost = projectBilling(totalCost * factor, input.windowHours, 24 * 365);
      const annualSavings = projectBilling(projectedSavings * factor, input.windowHours, 24 * 365);
      const monthlyLabel = `${(sc.daily * 30).toLocaleString()} GB/mo`;
      lines.push(
        `| ${sc.label} | ${monthlyLabel} | ${fmtCostDisclosed(input, annualCost)} | **${fmtCostDisclosed(input, annualSavings)}** |`
      );
    }
    lines.push('');
    lines.push('_Sample-only costs (for reference)_:');
    lines.push(`- **Observed sample cost (window)**: ${fmtCostDisclosed(input, totalCost)}`);
    lines.push(
      `- **Sample lossless savings (window)**: ${fmtCostDisclosed(input, projectedSavings)}, ${fmtPct((projectedSavings / Math.max(1, totalCost)) * 100)} of analyzed cost`
    );
  }
  // The analyzer rate is now structurally attached to every $ line above via
  // `fmtDisclosedDollar`'s disclosure tail. The source-of-rate prose stays
  // here so users still know it came from vendors.json and how to override.
  lines.push(
    `- **Analyzer rate source**: vendors.json (override via \`analyzer_cost_per_gb\`)`
  );
  lines.push('');
  if (top3.length > 0) {
    lines.push('**Top 3 wins** (lossless):');
    for (const p of top3) {
      const dn = displayName(p.identity, p.template, input.aiPrettyNames, p.symbolMessage, setDiff.get(p.identity));
      lines.push(`- ${top3WinLabel(p, dn, fmtCostDisclosed(input, p.projectedSavings))}`);
    }
    lines.push('');
  }

  // Section 2: Top cost drivers
  lines.push('## 2. Top Cost Drivers');
  lines.push('');
  const topN = Math.min(patterns.length, 20);
  if (topN === 0) {
    lines.push('_No patterns resolved from the pulled events; the engine returned zero. This is usually a sign the events are pre-aggregated JSON blobs rather than raw log lines. Try a narrower `query`, and make sure a local tenx CLI is installed._');
    lines.push('');
  } else {
    lines.push(
      '| # | pattern identity | service | sev | events | % total | $/window | $/wk projected | newly-emerged |'
    );
    lines.push('|---|---|---|---|---|---|---|---|---|');
    // Crop the shared identity prefix across the rendered top-N so the
    // per-row tail (the disambiguating part) is what the reader sees,
    // not 20 copies of `kind_event_apiversion_audit_k8s_io_v1_…`.
    const cropped = buildCroppedDisplays(patterns.slice(0, topN).map((p) => p.identity));
    for (let i = 0; i < topN; i++) {
      const p = patterns[i];
      const newFlag = p.count === 1 && input.extraction.totalEvents > 100 ? 'new?' : '';
      lines.push(
        `| ${i + 1} | ${displayNameCompact(p.identity, p.template, input.aiPrettyNames, p.symbolMessage, cropped.get(p.identity), setDiff.get(p.identity))} | ${p.service || 'unknown'} | ${p.severity || '-'} | ${fmtCount(p.count)} | ${fmtPct(p.pctOfTotal * 100)} | ${fmtCostDisclosed(input, p.costPerWindow)} | ${fmtCostDisclosed(input, p.costPerWeek)} | ${newFlag} |`
      );
    }
    lines.push('');
  }

  // Section 3: Service-level breakdown
  lines.push('## 3. Service-Level Breakdown');
  lines.push('');
  const byService = groupBy(patterns, (p) => p.service || 'unknown');
  const svcRows = Array.from(byService.entries())
    .map(([svc, ps]) => ({
      svc,
      cost: ps.reduce((s, p) => s + p.costPerWindow, 0),
      events: ps.reduce((s, p) => s + p.count, 0),
      severityMix: severityMix(ps),
    }))
    .sort((a, b) => b.cost - a.cost);
  if (svcRows.length === 0) {
    lines.push('_No service labels resolved from the pulled events._');
    lines.push('');
  } else {
    lines.push('| service | events | $/window | severity mix |');
    lines.push('|---|---|---|---|');
    for (const r of svcRows.slice(0, 15)) {
      lines.push(`| ${r.svc} | ${fmtCount(r.events)} | ${fmtCostDisclosed(input, r.cost)} | ${r.severityMix || '-'} |`);
    }
    lines.push('');
    // Anomaly flag: any service with >50% of total cost?
    const dominating = svcRows.find((r) => r.cost / Math.max(1, totalCost) > 0.5);
    if (dominating) {
      lines.push(
        `> ⚠ **Anomaly**: \`${dominating.svc}\` is ${fmtPct((dominating.cost / totalCost) * 100)} of analyzed cost. One service dominating spend is either a hot-loop emitter (filter opportunity) or a mis-routed service (instrumentation issue).`
      );
      lines.push('');
    }
  }

  // Section 4: Receiver recommendations
  lines.push('## 4. Receiver Recommendations');
  lines.push('');
  lines.push(
    `Per-pattern lossless lever with reasoning, projected savings, and a ready-to-paste log10x receiver config. Each entry compacts the line in place (stays searchable in ${siemName}), offloads it to your own S3 (recoverable any time), or moves it to a cheaper retained tier. Nothing is sampled or dropped.`
  );
  lines.push('');
  const receiverTopN = Math.min(patterns.length, 10);
  for (let i = 0; i < receiverTopN; i++) {
    const p = patterns[i];
    lines.push(`### #${i + 1}: ${displayName(p.identity, p.template, input.aiPrettyNames, p.symbolMessage, setDiff.get(p.identity))}  _(${p.confidence} confidence)_`);
    lines.push('');
    lines.push(`- **Lever**: ${actionLabel(p, siemName)}`);
    lines.push(`- **Reasoning**: ${p.reasoning}`);
    lines.push(`- **Projected savings (window)**: ${fmtCostDisclosed(input, p.projectedSavings)}`);
    lines.push(
      `- **Dependency warning**: ${p.recommendedAction === 'keep' ? 'none (kept verbatim)' : `run \`log10x_dependency_check(pattern: "${p.identity}")\` first to surface alerts/dashboards/saved searches referencing this pattern`}`
    );
    lines.push('');
    if (p.recommendedAction !== 'keep') {
      lines.push('```yaml');
      lines.push(receiverYaml(p));
      lines.push('```');
      lines.push('');
    }
  }

  // Section 5: Native SIEM exclusion configs (demoted).
  // The default plan is lossless and drops nothing, so this section does
  // NOT emit null-queue / Exclude configs. It points to the explicit
  // `configs` view for users who specifically want to hard-drop (lossy).
  lines.push('## 5. Native SIEM Exclusion Configs');
  lines.push('');
  lines.push(
    `10x keeps every line (compact or offload), so this plan has no drop candidates. If you specifically want to hard-drop a pattern (lossy, not recommended), native ${siemName} and Fluent Bit exclusion configs are available via the \`configs\` view (\`log10x_poc_from_siem_status\` with \`view: "configs"\`).`,
  );
  lines.push('');

  // Section 6: Compact-byte ratio (measured, only where the engine
  // emitted encoded lines and only for SIEMs that ingest forwarder-
  // compacted streams).
  const compactionApplies = input.siem === 'splunk' || input.siem === 'elasticsearch' || input.siem === 'clickhouse';
  if (compactionApplies) {
    const measured = patterns.filter((p) => (p.encodedBytes ?? 0) > 0).slice(0, 8);
    lines.push('## 6. Compact-byte Ratio (Measured)');
    lines.push('');
    if (measured.length === 0) {
      lines.push(
        `_No measured compact bytes available. The local tenx CLI did not emit encoded lines for these events (older CLI build). Re-run on a tenx CLI ≥ 1.1.0 to see the real per-pattern ratio._`
      );
      lines.push('');
    } else {
      lines.push(
        `Numbers below are summed from the engine's actual \`encoded.log\` lines for these events. Not estimated. Each row's "compact bytes" is the total bytes the 10x forwarder would ship downstream for this pattern. Install: https://doc.log10x.com/apps/receiver/`
      );
      lines.push('');
      lines.push(
        'The compacted line carries the full template plus every captured variable, so the original line reconstructs exactly. This is lossless: nothing is summarized away or dropped.',
      );
      lines.push('');
      lines.push('| pattern | raw bytes | compact bytes | ratio | $ saved /window |');
      lines.push('|---|---|---|---|---|');
      // Daily-scale the saved-dollars column with the SAME factor enrichPatterns
      // uses, so these match the rest of the report instead of showing the raw
      // sub-cent sample figure.
      const sampleGbForScale = input.extraction.totalBytes / (1024 ** 3);
      const scaleFactor =
        input.totalDailyGb && sampleGbForScale > 0 ? input.totalDailyGb / sampleGbForScale : 1;
      for (const p of measured) {
        const encBytes = p.encodedBytes ?? 0;
        const ratio = p.bytes > 0 ? p.bytes / Math.max(1, encBytes) : 1;
        const savedBytes = Math.max(0, p.bytes - encBytes) * scaleFactor;
        const saveCost = costFromBytes(savedBytes, input.analyzerCostPerGb);
        lines.push(
          `| ${displayNameCompact(p.identity, p.template, input.aiPrettyNames, p.symbolMessage, undefined, setDiff.get(p.identity))} | ${fmtBytes(p.bytes)} | ${fmtBytes(encBytes)} | ${ratio.toFixed(1)}× | ${fmtCostDisclosed(input, saveCost)} |`
        );
      }
      lines.push('');
    }
  }

  // Section 7: Risk / dependency check
  lines.push('## 7. Risk / Dependency Check');
  lines.push('');
  const riskyChanges = patterns.slice(0, 10).filter((p) => p.recommendedAction !== 'keep').filter((p) => {
    const errorSev = p.severity && /ERROR|CRIT|FATAL|WARN/i.test(p.severity);
    const smallCount = p.count < 10;
    return errorSev || smallCount;
  });
  if (riskyChanges.length === 0) {
    lines.push('_All patterns with a lever are high-volume, non-error patterns, and the lever is lossless (nothing dropped). Standard dependency check recommended but risk is low._');
    lines.push('');
  } else {
    lines.push('**These patterns need careful review before changing**:');
    lines.push('');
    for (const p of riskyChanges) {
      const why: string[] = [];
      if (p.severity && /ERROR|CRIT|FATAL|WARN/i.test(p.severity)) {
        why.push(`severity=${p.severity}, may feed alerts`);
      }
      if (p.count < 10) {
        why.push(`only ${p.count} events in window, low confidence on statistical behavior`);
      }
      lines.push(`- ${displayName(p.identity, p.template, input.aiPrettyNames, p.symbolMessage, setDiff.get(p.identity))}: ${why.join('; ')}`);
    }
    lines.push('');
  }
  lines.push(
    'Before changing any pattern, run `log10x_dependency_check(pattern: "<identity>")` which scans Datadog monitors, Splunk saved searches, Grafana dashboards, and Prometheus rules for references. The lever is lossless, but compacting or offloading a pattern that feeds a search-time field extraction is worth confirming first.'
  );
  lines.push('');

  // Section 8: Deployment paths
  lines.push('## 8. Deployment Paths');
  lines.push('');
  lines.push('### Automated: log10x receiver (recommended)');
  lines.push('');
  lines.push(
    '1. Install the Log10x Receiver in your forwarder pipeline: https://doc.log10x.com/apps/receiver/'
  );
  lines.push(
    '2. Commit the compact/offload config above into your GitOps repo (the receiver watches a ConfigMap).'
  );
  lines.push(
    '3. Verify before you trust it: the receiver publishes exact before/after bytes per pattern, so you watch the reduction land in your own metrics before you commit. Nothing is dropped, so there is nothing to expire or roll back.'
  );
  lines.push('');
  lines.push('### Manual: native SIEM config (no log10x runtime)');
  lines.push('');
  lines.push(
    'Without the receiver runtime there is no in-place compaction or offload (those need the engine). The native path can only hard-drop a pattern, which is lossy and not the recommended plan.',
  );
  lines.push(
    `If you specifically want to discard a pattern at ${SIEM_DISPLAY_NAMES[input.siem]} or the forwarder, the exclusion configs are in the \`configs\` view. Run \`log10x_dependency_check\` on each pattern first, then monitor ingestion volume for 24-48h to confirm the change.`,
  );
  lines.push('');

  // Section 9: Appendix
  lines.push('## 9. Appendix');
  lines.push('');
  lines.push('### Full pattern table');
  lines.push('');
  if (patterns.length === 0) {
    lines.push('_No patterns._');
  } else {
    lines.push('| identity | events | bytes | severity | service | sample |');
    lines.push('|---|---|---|---|---|---|');
    const appendixSlice = patterns.slice(0, 50);
    const croppedAppendix = buildCroppedDisplays(appendixSlice.map((p) => p.identity));
    for (const p of appendixSlice) {
      lines.push(
        `| ${displayNameCompact(p.identity, p.template, input.aiPrettyNames, p.symbolMessage, croppedAppendix.get(p.identity), setDiff.get(p.identity))} | ${fmtCount(p.count)} | ${fmtBytes(p.bytes)} | ${p.severity || '-'} | ${p.service || '-'} | \`${truncate(p.sampleEvent, 80).replace(/\|/g, '\\|')}\` |`
      );
    }
    if (patterns.length > 50) {
      lines.push('');
      lines.push(`_${patterns.length - 50} additional patterns omitted from the table (see JSON summary)._`);
    }
  }
  lines.push('');
  lines.push('### SIEM query used');
  lines.push('');
  lines.push('```');
  lines.push(input.queryUsed);
  lines.push('```');
  lines.push('');
  lines.push('### Methodology');
  lines.push('');
  lines.push(
    '- **Pattern identity** is the engine\'s Reporter-tier `message_pattern` when the engine produced one (a stable symbol-lookup name; same identity across deploys, restarts, pod names, timestamps, and request IDs). When the engine did not produce one, identity falls back to the engine\'s short `templateHash`. Identity values shown here are emitted by the engine, never derived from the log body by this report.'
  );
  lines.push(
    '- **Cost model**: `bytes × analyzer_cost_per_gb` over the pulled window. Window cost is projected to weekly cost via `$/window × (168h / window_hours)`.'
  );
  lines.push(
    '- **Recommendation rules** (all lossless): for a reducible pattern (DEBUG/INFO/TRACE/WARN or no severity AND ≥1% of total volume), compact in place when the SIEM supports it and the line is compressible (measured ≥40% smaller), else tier_down to a cheaper retained tier (Datadog/CloudWatch), else offload to your own S3 (recoverable). ERROR/CRIT/FATAL and low-volume patterns are kept verbatim. Nothing is sampled or dropped.'
  );
  lines.push(
    '- **Confidence** is `high` for patterns with ≥100 events in the window (stable rate), `medium` for 10-99, `low` for <10.'
  );
  lines.push('');
  lines.push('### Run metadata');
  lines.push('');
  lines.push(`- **snapshot_id**: \`${input.snapshotId}\``);
  lines.push(`- **started**: ${input.startedAt}`);
  lines.push(`- **finished**: ${input.finishedAt}`);
  lines.push(`- **mcp_version**: ${input.mcpVersion}`);
  lines.push(
    `- **pull_wall_time_ms**: ${input.pullWallTimeMs} (engine ${input.templateWallTimeMs}ms)`
  );
  lines.push(
    `- **events_analyzed**: ${fmtCount(input.extraction.totalEvents)} / target ${fmtCount(input.targetEventCount)} (${input.reasonStopped})`
  );
  lines.push(`- **bytes_analyzed**: ${fmtBytes(input.extraction.totalBytes)}`);
  lines.push(`- **execution_mode**: ${input.extraction.executionMode}`);
  if (input.totalDailyGb && input.totalDailyGb > 0) {
    lines.push(`- **volume_scaling**: ${input.totalDailyGb} GB/day (costs scaled from sample)`);
  } else {
    lines.push(`- **volume_scaling**: disabled (sample-only costs)`);
  }
  if (input.aiPrettyNames && Object.keys(input.aiPrettyNames).length > 0) {
    lines.push(
      `- **naming**: ${Object.keys(input.aiPrettyNames).length} pattern(s) AI-prettified via MCP sampling; remainder use template-based heuristic`
    );
  } else if (input.aiPrettifyErrorNote) {
    lines.push(`- **naming**: template-based heuristic (AI prettify skipped: ${input.aiPrettifyErrorNote})`);
  } else {
    lines.push(`- **naming**: template-based heuristic`);
  }
  if (input.pullNotes && input.pullNotes.length > 0) {
    lines.push('- **pull notes**:');
    for (const n of input.pullNotes) lines.push(`  - ${n}`);
  }
  lines.push('');

  const markdown = lines.join('\n');
  return {
    markdown,
    summary: {
      eventsAnalyzed: input.extraction.totalEvents,
      patternsFound: patterns.length,
      totalCostAnalyzed: totalCost,
      projectedSavings,
      top3Actions: top3.map((p) => {
        const name = resolveName(p.identity, p.template, input.aiPrettyNames);
        return top3WinLabel(p, name, fmtCostDisclosed(input, p.projectedSavings));
      }),
    },
  };
}

// ── Enrichment ──

function enrichPatterns(input: RenderInput): EnrichedPattern[] {
  const total = input.extraction.totalEvents || 1;
  const totalBytes = input.extraction.totalBytes || 1;
  const analyzerCost = input.analyzerCostPerGb;
  // Destination-aware level-1 lever (per DEFAULT_ACTION_BY_DESTINATION):
  //   datadog/cloudwatch/azure -> tier_down, clickhouse -> compact,
  //   splunk / es / sumo / gcp / managed offerings -> offload, …
  // Threaded into reasoning for high-volume info-class patterns so the
  // recommendation matches the SIEM's cheapest cost-cutting path.
  const destinationAction: CostAction = getDefaultActionForDestination(input.siem, 1);
  // Does this SIEM support in-place compaction (10x envelope / plugin)?
  // Splunk, self-hosted ES/OS, and ClickHouse do; Datadog/CloudWatch/managed
  // offerings do not. When it does, compact is the lead lever for a
  // compressible pattern (keeps every line searchable in the SIEM at a
  // fraction of the bytes). When it doesn't, we fall to tier_down (cheaper
  // in-platform tier) or offload (customer-owned S3) — both lossless.
  const compactSupported = getAllowedActionsForDestination(input.siem).includes('compact');

  // When the caller provides the customer's real daily volume, scale each
  // pattern's bytes from "sample-observed" to "projected-daily" by
  // multiplying by (totalDailyGb / sampleGb). This is valid when the
  // sample is random (which every connector's default ordering gives us —
  // Datadog sort=timestamp, ES @timestamp asc, Splunk job sample). It
  // breaks down if the caller narrows to a specific service via `query`;
  // in that case the scaling overstates cost because only a fraction of
  // the daily volume matches the filter. Documented caveat.
  const sampleGb = totalBytes / (1024 ** 3);
  const scaleFactor = input.totalDailyGb && sampleGb > 0
    ? input.totalDailyGb / sampleGb
    : 1;

  const enriched: EnrichedPattern[] = input.extraction.patterns.map((p) => {
    const pctOfTotal = p.count / total;
    // Window cost = observed sample bytes scaled to daily volume if provided.
    const scaledBytesPerDay = input.totalDailyGb
      ? (p.bytes / (1024 ** 3)) * scaleFactor * (1024 ** 3) / Math.max(1, input.windowHours / 24)
      : p.bytes;
    // When totalDailyGb is set, interpret costPerWindow as "this pattern's
    // share of the daily bill scaled to the pull window." Otherwise, plain
    // bytes × rate. Either way, fmtDollar now shows sub-cent precision.
    const costPerWindow = input.totalDailyGb
      ? costFromBytes(p.bytes * scaleFactor, analyzerCost)
      : costFromBytes(p.bytes, analyzerCost);
    const costPerWeek = projectBilling(costPerWindow, input.windowHours, 24 * 7);
    // Mark unused to satisfy strict mode without altering semantics.
    void scaledBytesPerDay;
    // Identity is the engine-emitted value the receiver matches on.
    // Priority: Reporter-tier `symbolMessage` (default match field) >
    // `tenxHash` / patternHash (alternate match field). We DO NOT fall
    // back to the templater's internal `templateHash` — the receiver
    // does not match against it and pasting it into mute YAML or
    // downstream tool args produces silently broken rules.
    const identity =
      (p.symbolMessage && p.symbolMessage.length > 0 && p.symbolMessage) ||
      (p.tenxHash && p.tenxHash.length > 0 && p.tenxHash) ||
      // Last-ditch fallback only for legacy engine builds with no
      // anchored encoded layout. Marked here so the YAML emitter can
      // refuse to advertise this as a working mute identity.
      p.hash;
    const lit = extractLiteralPhrase(p.template, identity);
    const severity = (p.severity || '').toUpperCase();

    // Lossless decision: every reducible pattern gets a lossless lever
    // (compact / offload / tier_down); everything else is kept verbatim.
    // We NEVER auto-recommend mute / drop / sample.
    let action: 'compact' | 'offload' | 'tier_down' | 'keep' = 'keep';
    const sampleRate = 1; // we do not sample; retained for type-compat only.
    let leverFraction = 0;
    let reasoning = '';

    const siemName = SIEM_DISPLAY_NAMES[input.siem];
    const isErrorClass = /ERROR|CRIT|FATAL/.test(severity);
    // Reducible severities: DEBUG / INFO / TRACE / WARN / no-severity.
    const isReducibleSev = /DEBUG|INFO|TRACE|WARN/.test(severity) || !severity;
    const isFrequent = pctOfTotal >= 0.01;

    // Measured compaction fraction from the engine's encoded output.
    // encRatio = encodedBytes/bytes; compactFraction = 1 - encRatio, the
    // share of bytes the in-place re-encode removes. Clamped to [0, 0.85].
    const encRatio = p.encodedBytes && p.encodedBytes > 0 ? p.encodedBytes / Math.max(1, p.bytes) : 1;
    const compactFraction = Math.min(0.85, Math.max(0, 1 - encRatio));
    const isCompressible = compactFraction >= 0.4;

    if (isErrorClass) {
      action = 'keep';
      reasoning = `severity=${severity || 'error-class'}, kept verbatim in ${siemName} for incident diagnosis.`;
    } else if (isReducibleSev && isFrequent) {
      const sevLabel = severity || 'info-class';
      const pctLabel = fmtPct(pctOfTotal * 100);
      if (compactSupported && isCompressible) {
        action = 'compact';
        leverFraction = compactFraction; // MEASURED.
        reasoning =
          `High-volume ${sevLabel} pattern (${pctLabel} of volume). ` +
          `Compact in place: ${fmtPct(compactFraction * 100)} smaller, stays searchable in ${siemName}, ` +
          `every line reconstructs exactly.`;
      } else if (destinationAction === 'tier_down') {
        action = 'tier_down';
        leverFraction = 0.6;
        reasoning =
          `High-volume ${sevLabel} pattern (${pctLabel} of volume). ` +
          `Route to ${siemName}'s cheaper in-platform tier, fully retained and queryable.`;
      } else {
        action = 'offload';
        leverFraction = 0.95;
        reasoning =
          `High-volume ${sevLabel} pattern (${pctLabel} of volume). ` +
          `Offload to your own S3 before ${siemName} bills it, recoverable any time via log10x_retriever_query.`;
      }
    } else {
      action = 'keep';
      reasoning = `Low-volume or non-actionable pattern (${fmtPct(pctOfTotal * 100)} of volume), kept verbatim in ${siemName}.`;
    }

    // Savings = this pattern's window cost times the lever's removed
    // fraction. Because costPerWindow is already daily-scaled when
    // totalDailyGb is set, compact savings now scale exactly like the
    // old mute savings did (fixes the sample-only scaling bug). keep → 0.
    const projectedSavings = costPerWindow * leverFraction;

    let confidence: Confidence = 'medium';
    if (p.count >= 100) confidence = 'high';
    else if (p.count < 10) confidence = 'low';

    return {
      ...p,
      costPerWindow,
      pctOfTotal,
      costPerWeek,
      recommendedAction: action,
      leverFraction,
      sampleRate,
      projectedSavings,
      reasoning,
      confidence,
      identity,
      literalPhrase: lit.phrase,
      literalLeading: lit.leading,
      destinationLevel1Action: destinationAction,
      // Placeholder; overwritten by the enricher pass below once the
      // whole list is sorted and visible to the cross-pattern detectors.
      poc: {
        incidentClusterId: null,
        topSlot: null,
        redundantWith: [],
        firstSeenAgeSeconds: null,
        refinedAction: action,
        dependencyCount: null,
        dependencyChecked: false,
        emergence: null,
      },
    };
  });

  // Rank: cost descending.
  enriched.sort((a, b) => b.costPerWindow - a.costPerWindow);

  // Cross-pattern enrichment: incident clusters, redundancy pairs,
  // top-slot cardinality, refined action with dep-check fold-in.
  // Runs once per render; clusters + pairs are also returned via the
  // renderer's section helpers (see `renderIncidentSection`,
  // `renderRedundancySection`).
  const { enrichments } = enrichForPoc(enriched, {
    dependencyByIdentity: input.dependencyByIdentity,
    firstSeenByIdentity: input.firstSeenByIdentity,
    windowStartMs: input.windowStartMs,
    windowEndMs: input.windowEndMs,
  });
  for (let i = 0; i < enriched.length; i++) {
    enriched[i].poc = enrichments[i];
  }
  return enriched;
}

/**
 * Re-run the same enricher pass and return BOTH the enriched patterns
 * AND the clusters / redundancy pairs. Used by the summary view to
 * emit the "Same incident" + "Redundant pair" sections without
 * re-running the templater.
 */
function enrichPatternsWithSections(input: RenderInput): {
  patterns: EnrichedPattern[];
  clusters: IncidentCluster[];
  redundancyPairs: RedundancyPair[];
} {
  const patterns = enrichPatterns(input);
  const { clusters, redundancyPairs } = enrichForPoc(patterns, {
    dependencyByIdentity: input.dependencyByIdentity,
    firstSeenByIdentity: input.firstSeenByIdentity,
    windowStartMs: input.windowStartMs,
    windowEndMs: input.windowEndMs,
  });
  return { patterns, clusters, redundancyPairs };
}

/**
 * Public surface for the v2 envelope builder. Same shape as the
 * internal `enrichPatternsWithSections`. Underscore prefix signals
 * "internal but cross-module — may change."
 */
export function _enrichForEnvelope(input: RenderInput): {
  patterns: EnrichedPattern[];
  clusters: IncidentCluster[];
  redundancyPairs: RedundancyPair[];
} {
  return enrichPatternsWithSections(input);
}

function costFromBytes(bytes: number, costPerGb: number): number {
  return (bytes / (1024 ** 3)) * costPerGb;
}

function projectBilling(windowCost: number, windowHours: number, targetHours: number): number {
  if (windowHours <= 0) return 0;
  return windowCost * (targetHours / windowHours);
}

function groupBy<T, K>(arr: T[], key: (x: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const x of arr) {
    const k = key(x);
    const list = out.get(k) || [];
    list.push(x);
    out.set(k, list);
  }
  return out;
}

function severityMix(ps: EnrichedPattern[]): string {
  const mix = new Map<string, number>();
  for (const p of ps) {
    const sev = p.severity || '-';
    mix.set(sev, (mix.get(sev) || 0) + p.count);
  }
  const total = ps.reduce((s, p) => s + p.count, 0) || 1;
  return Array.from(mix.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([sev, n]) => `${sev} ${fmtPct((n / total) * 100)}`)
    .join(', ');
}

function actionLabel(p: EnrichedPattern, siemName: string): string {
  if (p.recommendedAction === 'compact') {
    return `compact (stays in ${siemName}, ${fmtPct(p.leverFraction * 100)} smaller)`;
  }
  if (p.recommendedAction === 'offload') return 'offload (to your S3, recoverable)';
  if (p.recommendedAction === 'tier_down') return 'tier_down (cheaper tier)';
  return 'keep';
}

/**
 * One-line "win" label for the executive summary + the JSON summary's
 * `top3Actions`. Leads with the lossless lever verb and the parenthetical
 * that says WHY it's lossless (stays searchable / recoverable). `keep`
 * carries no savings.
 */
function top3WinLabel(p: EnrichedPattern, displayLabel: string, savings: string): string {
  if (p.recommendedAction === 'compact') {
    return `Compact ${displayLabel} -> save ${savings} (stays searchable)`;
  }
  if (p.recommendedAction === 'offload') {
    return `Offload ${displayLabel} -> save ${savings} (recoverable from your S3)`;
  }
  if (p.recommendedAction === 'tier_down') {
    return `Tier down ${displayLabel} -> save ${savings} (cheaper tier, retained)`;
  }
  return `Keep ${displayLabel} (kept verbatim)`;
}

/**
 * Quote a value for safe YAML emission. Engine templateHash values
 * routinely contain YAML-significant chars (`[`, `]`, `{`, `}`, `*`,
 * `?`, `&`, `!`, `#`, `:`, `|`, leading `-`, etc.) that would either
 * parse as flow sequences/keys or break the line. JSON.stringify
 * produces a double-quoted, backslash-escaped form that is also a
 * valid YAML double-quoted scalar — safe across the board.
 */
function yamlQuote(s: string): string {
  return JSON.stringify(s);
}

function receiverYaml(p: EnrichedPattern): string {
  // Lossless lever map. We never emit `action: drop` / `sample`. The
  // receiver re-encodes (compact), routes to customer S3 (offload), or
  // tags for the SIEM's cheaper tier (tier_down). No auto-expiry: this
  // is permanent policy, not a temporary mute.
  // The install gate sits inside the fenced block (not as a section
  // banner) so the prospect sees it at the exact moment they think
  // about acting on the config, banners get skimmed past.
  const installGate = '# Install 10x first (see https://doc.log10x.com/apps/receiver/) and then add this entry to the receiver config.';
  // Which engine field is this `pattern:` value? The receiver matches
  // against it via `compactReceiverFieldNames`. We tell the user which
  // field to configure so the rule actually fires in production.
  let matchKeyNote: string;
  if (p.symbolMessage && p.identity === p.symbolMessage) {
    matchKeyNote = '# Identity below is the engine\'s `symbolMessage` (default receiver match key, no extra config needed).';
  } else if (p.tenxHash && p.identity === p.tenxHash) {
    matchKeyNote = '# Identity below is `tenx_hash` (patternHash). Configure: `compactReceiverFieldNames: [tenx_hash]` on the receiver.';
  } else {
    // p.identity fell back to templateHash. The receiver does NOT
    // match against templateHash, so this rule is inert as-is. The
    // comment tells the user this row needs an engine with the anchored
    // encoded layout before a config entry is producible.
    matchKeyNote = '# WARNING: no engine `symbolMessage` or `tenx_hash` available for this template. The value below is the engine\'s internal `templateHash` and is NOT a valid receiver match key. Re-run with an engine that emits the anchored encoded layout (`pattern=`/`patternHash=` in apps/mcp/stdout).';
  }
  // `keep` patterns carry no config entry.
  if (p.recommendedAction === 'keep') {
    return [installGate, '# (pattern kept verbatim, no receiver entry needed)'].join('\n');
  }
  const action = p.recommendedAction; // 'compact' | 'offload' | 'tier_down'
  const extra =
    action === 'offload'
      ? ['  bucket: "s3://your-bucket/log10x/"   # your own bucket, recoverable via log10x_retriever_query']
      : [];
  return [
    installGate,
    matchKeyNote,
    `${action}:`,
    `  - pattern: ${yamlQuote(p.identity)}`,
    ...extra,
    `    reason: ${yamlQuote(p.reasoning)}`,
  ].join('\n');
}

function nativeConfig(siem: SiemId, drops: EnrichedPattern[]): string {
  switch (siem) {
    case 'datadog':
      return datadogExclusion(drops);
    case 'splunk':
      return splunkExclusion(drops);
    case 'elasticsearch':
      return elasticsearchExclusion(drops);
    case 'cloudwatch':
      return cloudwatchExclusion(drops);
    case 'azure-monitor':
      return azureExclusion(drops);
    case 'gcp-logging':
      return gcpExclusion(drops);
    case 'sumo':
      return sumoExclusion(drops);
    case 'clickhouse':
      return clickhouseExclusion(drops);
    default:
      return '# (no native template available for this SIEM)';
  }
}

/**
 * Banner prepended to a rendered exclusion block when any pattern in
 * the drop list lacks a leading literal anchor. The phrase is still
 * the strongest distinguishing run in the template, but matches it
 * as a substring rather than a prefix.
 */
function approximationFootnote(drops: EnrichedPattern[]): string {
  const approx = drops.filter((p) => !p.literalLeading);
  if (approx.length === 0) return '';
  const lines = [
    '# NOTE: one or more patterns below begin with a variable slot, so the',
    '# phrase used is the longest internal literal run, not a prefix anchor.',
    '# Approximated patterns:',
    ...approx.map((p) => `#   - ${p.identity} → "${p.literalPhrase}"`),
    '',
  ];
  return lines.join('\n');
}

function datadogExclusion(drops: EnrichedPattern[]): string {
  // Indexed phrase query against @message. Datadog evaluates this on
  // the inverted index, so it's not regex-priced at ingest.
  const body = drops
    .map((p, i) => {
      const phrase = p.literalPhrase.replace(/"/g, '\\"');
      return [
        `# Exclusion filter #${i + 1}`,
        JSON.stringify(
          {
            name: `Drop ${p.identity.slice(0, 40)}`,
            is_enabled: true,
            filter: { query: `@message:"${phrase}"` },
          },
          null,
          2
        ),
      ].join('\n');
    })
    .join('\n\n');
  return approximationFootnote(drops) + body;
}

function splunkExclusion(drops: EnrichedPattern[]): string {
  const stanzas: string[] = [];
  stanzas.push('# props.conf');
  stanzas.push('[your_sourcetype]');
  stanzas.push(
    `TRANSFORMS-log10x_drop = ${drops.map((_, i) => `log10x_drop_${i}`).join(', ')}`
  );
  stanzas.push('');
  stanzas.push('# transforms.conf');
  for (let i = 0; i < drops.length; i++) {
    const p = drops[i];
    stanzas.push(`[log10x_drop_${i}]`);
    // Substring regex. escapeRegex makes this an exact-text match,
    // no `.*` interleaving, no greedy reorderings.
    stanzas.push(`REGEX = ${escapeRegex(p.literalPhrase)}`);
    stanzas.push('DEST_KEY = queue');
    stanzas.push('FORMAT = nullQueue');
    stanzas.push('');
  }
  return approximationFootnote(drops) + stanzas.join('\n');
}

function elasticsearchExclusion(drops: EnrichedPattern[]): string {
  const processors = drops.map((p) => {
    const phrase = p.literalPhrase.replace(/'/g, "\\'");
    return {
      drop: {
        if: `ctx.message != null && ctx.message.contains('${phrase}')`,
      },
    };
  });
  return (
    approximationFootnote(drops) +
    `PUT _ingest/pipeline/log10x_drop\n${JSON.stringify(
      { description: 'Log10x recommended drops', processors },
      null,
      2
    )}`
  );
}

function cloudwatchExclusion(drops: EnrichedPattern[]): string {
  // Subscription-filter pattern: `-"phrase"` excludes lines containing
  // the literal phrase. One filter per pattern keeps blast radius
  // visible at the AWS console.
  const body = drops
    .map((p, i) => {
      // CloudWatch filter terms are single-line; collapse internal
      // whitespace/newlines so the phrase is one token.
      const flat = p.literalPhrase.replace(/\s+/g, ' ').trim();
      // CloudWatch term escaping: backslash then double-quote for the "…" literal.
      const cwTerm = flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      // The whole --filter-pattern value is a shell single-quoted arg; a
      // single quote inside the phrase would otherwise terminate the arg and
      // produce a broken `aws` command. Escape ' as the standard '\'' dance.
      const filterValue = `-"${cwTerm}"`;
      const shellArg = `'${filterValue.replace(/'/g, `'\\''`)}'`;
      return `# Subscription filter: drop pattern #${i + 1}\naws logs put-subscription-filter \\\n  --log-group-name "/aws/your/logs" \\\n  --filter-name "log10x-drop-${i}" \\\n  --filter-pattern ${shellArg} \\\n  --destination-arn "<your-kinesis-or-lambda-arn>"`;
    })
    .join('\n\n');
  return approximationFootnote(drops) + body;
}

function azureExclusion(drops: EnrichedPattern[]): string {
  const conds = drops
    .map((p) => {
      const phrase = p.literalPhrase.replace(/"/g, '\\"');
      return `text contains "${phrase}"`;
    })
    .join(' or ');
  return (
    approximationFootnote(drops) +
    // DCR ingestion-time transform. `text` is the log-line column the 10x
    // forwarder ships to its custom table (verified against a live DCR stream:
    // TimeGenerated / routeState / text / templateHash). For a non-10x table,
    // swap `text` for that table's raw-line column.
    `// Data Collection Rule KQL transform\nsource | where not (${conds})`
  );
}

function gcpExclusion(drops: EnrichedPattern[]): string {
  const body = drops
    .map((p, i) => {
      const phrase = p.literalPhrase.replace(/"/g, '\\"');
      return `# Log exclusion filter #${i + 1} (gcloud logging sinks)\ntextPayload:"${phrase}"`;
    })
    .join('\n\n');
  return approximationFootnote(drops) + body;
}

function sumoExclusion(drops: EnrichedPattern[]): string {
  const body = drops
    .map((p, i) => {
      const phrase = p.literalPhrase.replace(/"/g, '\\"');
      return `# Drop rule #${i + 1}: Field Extraction Rules → Drop\nmatches "*${phrase}*"`;
    })
    .join('\n\n');
  return approximationFootnote(drops) + body;
}

function clickhouseExclusion(drops: EnrichedPattern[]): string {
  const conds = drops
    .map((p) => `(message NOT ILIKE '%${p.literalPhrase.replace(/'/g, "''")}%')`)
    .join('\n        AND ');
  return (
    approximationFootnote(drops) +
    `-- Option A: ingestion-layer drop via MATERIALIZED VIEW\nCREATE MATERIALIZED VIEW logs_filtered\nTO logs_final AS\n  SELECT *\n  FROM logs_raw\n  WHERE ${conds};\n\n-- Option B: drop at the forwarder (preferred, no extra storage writes)`
  );
}

function fluentBitConfig(drops: EnrichedPattern[]): string {
  const filters = drops
    .map(
      (p, i) =>
        `[FILTER]\n    Name       grep\n    Match      *\n    Exclude    log ${escapeRegex(p.literalPhrase)}\n# pattern identity: ${p.identity} (#${i + 1})`
    )
    .join('\n\n');
  return approximationFootnote(drops) + filters;
}

/**
 * Pull the strongest literal anchor from a templated pattern.
 *
 * A template body looks like `$(ts) ERROR payment_gateway_timeout for tenant=$ ms=$`,
 * with `$(...)` typed slots and bare `$` value slots. Splitting on either
 * variant gives the runs of literal text the template guarantees to emit
 * verbatim. The longest such run is the cheapest, most-discriminating
 * anchor for an exclusion query.
 *
 * Returns:
 *   - `phrase`: the longest run with at least 3 alphanumeric chars.
 *   - `leading`: true if `phrase` is the first run (no variable before it).
 *
 * Fallback: when no run clears the alphanumeric threshold, return the
 * spaced identity so the renderer still has *something* paste-worthy.
 * The caller surfaces an "approximation" footnote in that case via
 * `leading=false`.
 */
function extractLiteralPhrase(
  template: string,
  identity: string
): { phrase: string; leading: boolean } {
  const runs = template
    .split(/\$\([^)]*\)|\$/)
    .map((s, idx) => ({ text: s.replace(/\s+/g, ' ').trim(), idx }))
    .filter((r) => r.text.length > 0);

  const qualifying = runs.filter(
    (r) => (r.text.match(/[A-Za-z0-9]/g) || []).length >= 3
  );
  if (qualifying.length === 0) {
    return { phrase: identity.replace(/_/g, ' ').trim() || identity, leading: false };
  }

  let best = qualifying[0];
  for (const r of qualifying) {
    if (r.text.length > best.text.length) best = r;
  }
  return { phrase: best.text, leading: best.idx === 0 };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Format a cost figure honestly: a single dollar value when the
 * volume is byte-precise, or a low-high range when an auto-detected
 * fallback estimator was used. The wide bracket is the point: it
 * pushes the user to provide better data (`total_daily_gb`, or grant
 * `usage_read` scope) instead of trusting a confidently-wrong number.
 *
 * Routes through `fmtDisclosedDollar` so the disclosure tail is
 * structurally attached. In the range case the tail rides on each
 * endpoint (spec calls for this — duplication beats stripping the
 * caveat off either side of the range).
 */
function formatCostRange(
  input: RenderInput,
  cost: number,
  multiplier?: { low: number; high: number }
): string {
  if (!multiplier) return fmtCostDisclosed(input, cost);
  const lo = cost * multiplier.low;
  const hi = cost * multiplier.high;
  return `${fmtCostDisclosed(input, lo)} - ${fmtCostDisclosed(input, hi)}`;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ');
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

/**
 * Render the scale-brag header — one line summarizing what 10x analyzed.
 * Numbers come straight from the pulled extraction (events, bytes,
 * patterns, window). The agent surfacing this report shows the prospect
 * that we operated at a scale unaided tooling can't reach.
 */
function renderScaleHeader(input: RenderInput, patterns: EnrichedPattern[]): string {
  const events = input.extraction.totalEvents.toLocaleString();
  const bytes = fmtBytes(input.extraction.totalBytes);
  const patternCount = patterns.length.toLocaleString();
  return `Analyzed **${events} events** (${bytes}) across ${input.window}, surfacing **${patternCount} distinct patterns**.`;
}

interface EmergenceTally {
  hasTimestamps: boolean;
  newCount: number;
  growingCount: number;
  stableCount: number;
  burstCount: number;
  total: number;
}

/**
 * Tally each emergence category across the enriched patterns. Used to
 * render the "of these N patterns: X new, Y growing, Z stable" line
 * that frames the report as a longitudinal analysis rather than a
 * single snapshot.
 */
function countEmergence(patterns: EnrichedPattern[]): EmergenceTally {
  const out: EmergenceTally = {
    hasTimestamps: false,
    newCount: 0,
    growingCount: 0,
    stableCount: 0,
    burstCount: 0,
    total: patterns.length,
  };
  for (const p of patterns) {
    const e = p.poc.emergence;
    if (!e || e.category === 'unknown') continue;
    out.hasTimestamps = true;
    if (e.category === 'new') out.newCount++;
    else if (e.category === 'growing') out.growingCount++;
    else if (e.category === 'stable') out.stableCount++;
    else if (e.category === 'recent_burst') out.burstCount++;
  }
  return out;
}

function renderEmergenceSummary(t: EmergenceTally): string {
  const parts: string[] = [];
  if (t.newCount > 0) parts.push(`**${t.newCount} new** (last 24h, incident signal)`);
  if (t.growingCount > 0) parts.push(`**${t.growingCount} growing** (≥2x window average, regression candidates)`);
  if (t.stableCount > 0) parts.push(`${t.stableCount} stable (steady high-volume noise, compact/offload candidates)`);
  if (t.burstCount > 0) parts.push(`${t.burstCount} bursty (transient, check correlation)`);
  if (parts.length === 0) return '';
  return `Of those patterns: ${parts.join('; ')}.`;
}

/**
 * Render the Age cell content — combines first-seen-age (from engine
 * or from the pulled sample's timestamps) with an emergence badge
 * (NEW / GROWING / STABLE / BURST) so the agent sees the longitudinal
 * shape at a glance. Falls back to the prior `(unknown)` text when no
 * timestamp data is available.
 */
function renderEmergenceCell(p: EnrichedPattern): string {
  const e = p.poc.emergence;
  if (!e || e.category === 'unknown') {
    return p.poc.firstSeenAgeSeconds !== null
      ? fmtAge(p.poc.firstSeenAgeSeconds)
      : '(unknown)';
  }
  const ageStr = e.ageInWindowMs > 0 ? fmtAge(Math.floor(e.ageInWindowMs / 1000)) : '<1s ago';
  if (e.category === 'new') return `**NEW** (${ageStr})`;
  if (e.category === 'growing') return `**GROWING** ${e.accelerationRatio.toFixed(1)}× (${ageStr})`;
  if (e.category === 'stable') return `STABLE (${ageStr})`;
  return `BURST (${ageStr})`;
}

/**
 * Render the Action cell. Reads the refined action (post dep-check
 * fold-in) and renders one of:
 *   - **FIX**     — ERROR-class with a dependency-failure descriptor
 *   - COMPACT     — lossless re-encode, stays searchable in the SIEM
 *   - OFFLOAD     — lossless route to customer S3, recoverable
 *   - TIER DOWN   — lossless move to the SIEM's cheaper tier
 *   - **BLOCKED** — dep-check found refs, confirm before changing
 *   - KEEP        — default for non-actionable rows
 *
 * Every lever here is lossless, so none are bolded as destructive.
 */
function renderActionCell(p: EnrichedPattern): string {
  const refined = p.poc.refinedAction;
  if (refined === 'fix') return '**FIX**';
  if (refined === 'blocked') return '**BLOCKED**';
  if (refined === 'compact') return 'COMPACT';
  if (refined === 'offload') return 'OFFLOAD';
  if (refined === 'tier_down') return 'TIER DOWN';
  return 'KEEP';
}

/**
 * Render the Slot fan-out cell. Shows the highest-cardinality slot for
 * the pattern with its distinct count. Empty cell when the pattern has
 * no slots (literal template).
 */
function renderSlotCell(p: EnrichedPattern): string {
  const s = p.poc.topSlot;
  if (!s) return '-';
  const unbounded = s.distinctOverCount >= 0.9 ? ' 🔥' : '';
  return `${s.slot}: ${fmtCount(s.distinctCount)}${unbounded}`;
}

/**
 * Render the Age cell. Uses engine-side first-seen when available;
 * degrades to `(unknown)` when the POC path didn't or couldn't query
 * engine history. Bold STABLE marker when age >= 7 days.
 */
function renderAgeCell(p: EnrichedPattern): string {
  const age = p.poc.firstSeenAgeSeconds;
  if (age === null) return '(unknown)';
  const formatted = fmtAge(age);
  return age >= 7 * 86400 ? `**STABLE** (${formatted})` : formatted;
}

/**
 * Display a raw identity tersely when no AI pretty name is available.
 * Caps length so a 120-char identity doesn't blow out a CLI table.
 */
function shortIdentity(identity: string): string {
  const spaced = identity.replace(/_/g, ' ');
  if (spaced.length <= 48) return spaced;
  return spaced.slice(0, 46) + '…';
}

/**
 * Whether a top-N pattern needs a review step before muting. Flags:
 *   - WARN / ERROR / FATAL severity (may feed alerts)
 *   - low-confidence (too few sample events to be sure the rate is stable)
 */
function needsReview(p: EnrichedPattern): boolean {
  const sev = (p.severity || '').toUpperCase();
  if (/ERROR|WARN|CRIT|FATAL/.test(sev)) return true;
  if (p.confidence === 'low') return true;
  return false;
}

/**
 * Extrapolate a sample-window cost to annual given a hypothetical
 * daily ingest (GB/day). Shared by the summary view's one-line
 * "at 100 GB/day" teaser so it matches the scenarios-table numbers.
 */
function scaleCostToDaily(
  sampleCost: number,
  sampleBytes: number,
  dailyGbScenario: number,
  windowHours: number
): number {
  if (sampleBytes <= 0) return 0;
  const sampleGb = sampleBytes / (1024 ** 3);
  const factor = dailyGbScenario / sampleGb;
  return projectBilling(sampleCost * factor, windowHours, 24 * 365);
}

/**
 * Test-only surface: phrase extractor + per-vendor exclusion renderer.
 * Not part of the public MCP API; the leading underscore signals
 * "internal, may change without notice."
 */
export const _internals = {
  extractLiteralPhrase,
  renderNativeExclusion: (siem: SiemId, drops: EnrichedPattern[]): string =>
    nativeConfig(siem, drops),
  renderFluentBit: (drops: EnrichedPattern[]): string => fluentBitConfig(drops),
};
export type _EnrichedPattern = EnrichedPattern;
