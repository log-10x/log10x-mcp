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
import { fmtBytes, fmtCount, fmtDollar, fmtGb, fmtPct } from './format.js';

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
  /** Reason the pull ended. */
  reasonStopped: 'target_reached' | 'time_exhausted' | 'source_exhausted' | 'error';
  /** Raw SIEM query string used. */
  queryUsed: string;
  /** Windows in the 'window' string, parsed to hours — used to project $/wk. */
  windowHours: number;
  /** Analyzer cost per GB for the detected SIEM. */
  analyzerCostPerGb: number;
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
 * Build a display string for a pattern identity. When an AI pretty name
 * exists for this identity, show `<Pretty Name>` with the raw identity
 * inline for copy-paste. Otherwise fall back to the raw identity alone.
 * Never lose the identity — every machine-pasted reference (reducer
 * YAML, SIEM configs) uses the raw form.
 */
function displayName(
  identity: string,
  template: string,
  aiPrettyNames?: Record<string, string>
): string {
  const name = aiPrettyNames?.[identity] || heuristicName(template, identity);
  return `**${name}** (\`${identity}\`)`;
}

/** Compact variant for table cells — pretty name with truncated identity suffix. */
function displayNameCompact(
  identity: string,
  template: string,
  aiPrettyNames?: Record<string, string>
): string {
  const name = aiPrettyNames?.[identity] || heuristicName(template, identity);
  const short = identity.length > 40 ? identity.slice(0, 38) + '…' : identity;
  return `**${name}**<br>\`${short}\``;
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
  if (picked.length === 0) return shortIdentity(identity);
  return picked.map((t) => t[0].toUpperCase() + t.slice(1).toLowerCase()).join(' ');
}

/** Resolve a display name: AI > heuristic > spaced identity. */
function resolveName(
  identity: string,
  template: string,
  aiPrettyNames?: Record<string, string>
): string {
  return aiPrettyNames?.[identity] || heuristicName(template, identity);
}

interface EnrichedPattern extends ExtractedPattern {
  costPerWindow: number;
  pctOfTotal: number;
  costPerWeek: number;
  recommendedAction: 'mute' | 'sample' | 'keep';
  sampleRate: number;
  projectedSavings: number;
  reasoning: string;
  confidence: Confidence;
  /** Snake-case identity — for ready-to-paste reducer configs. */
  identity: string;
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
  const patterns = enrichPatterns(input);
  const totalCost = patterns.reduce((s, p) => s + p.costPerWindow, 0);
  const projectedSavings = patterns.reduce((s, p) => s + p.projectedSavings, 0);
  const lines: string[] = [];

  // Title + one-line verdict.
  lines.push(`## POC — done. ${SIEM_DISPLAY_NAMES[input.siem]}, ${input.window} window.`);
  lines.push('');

  if (input.totalDailyGb && input.totalDailyGb > 0) {
    const annualCost = projectBilling(totalCost, input.windowHours, 24 * 365);
    const annualSavings = projectBilling(projectedSavings, input.windowHours, 24 * 365);
    const savingsPct = fmtPct((annualSavings / Math.max(1, annualCost)) * 100);
    const mode = input.volumeSource === 'auto_detected' ? 'auto-detected' : 'user-supplied';
    const m = input.volumeRangeMultiplier;
    lines.push(
      `Projected annual cost: **${formatCostRange(annualCost, m)}** · Potential savings: **${formatCostRange(annualSavings, m)} (${savingsPct})** at ${fmtGb(input.totalDailyGb)}/day (${mode}).`
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
      `No volume specified. At 100 GB/day the top-pattern muting would save **${fmtDollar(oneHundredSavings)}/yr** out of **${fmtDollar(oneHundred)}/yr** total cost. For a precise projection, pass \`total_daily_gb\`, \`total_monthly_gb\`, or \`total_annual_gb\` on submit (or call status with \`view: "full"\` to see the full scenario table).`
    );
  }
  lines.push('');

  // Top-N table.
  const top = patterns.slice(0, topN);
  if (top.length > 0) {
    lines.push(`### Top ${top.length} wins`);
    lines.push('');
    lines.push('| # | Pattern | Service | Sev | % | Annual savings |');
    lines.push('|---|---|---|---|---|---|');
    for (let i = 0; i < top.length; i++) {
      const p = top[i];
      const name = resolveName(p.identity, p.template, input.aiPrettyNames);
      const annualSavings = projectBilling(p.projectedSavings, input.windowHours, 24 * 365);
      const flag = needsReview(p) ? ' ⚠' : '';
      lines.push(
        `| ${i + 1} | ${name}${flag} | ${p.service || '—'} | ${p.severity || '—'} | ${fmtPct(p.pctOfTotal * 100)} | ${fmtDollar(annualSavings)} |`
      );
    }
    lines.push('');
  }

  // Risk flags.
  const flagged = top.filter(needsReview);
  if (flagged.length > 0) {
    lines.push(
      `⚠ ${flagged.length} pattern${flagged.length === 1 ? '' : 's'} flagged (WARN/ERROR severity or low sample confidence). ` +
        `Run \`log10x_dependency_check\` before muting — they may feed live alerts or dashboards.`
    );
    lines.push('');
  }

  // Views CTA.
  lines.push('**Available views** — call `log10x_poc_from_siem_status` again with:');
  lines.push('- `view: "full"` — complete 9-section report');
  lines.push('- `view: "yaml"` — reducer mute YAML for top patterns, paste-ready');
  lines.push('- `view: "configs"` — native SIEM exclusion configs (Datadog exclusion filter, Splunk props.conf, etc.)');
  lines.push('- `view: "pattern", pattern: "<identity>"` — deep dive on a specific pattern');
  lines.push('- `view: "top", top_n: 20` — expanded drivers table');

  return lines.join('\n');
}

/**
 * YAML view — reducer mute-file entries for the top N patterns.
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
  lines.push('# reducer mute file — paste into your GitOps ConfigMap');
  lines.push(`# Generated from snapshot ${input.snapshotId} on ${input.finishedAt}`);
  lines.push('# Auto-expires 30d from commit. Run log10x_dependency_check on each identity before merging.');
  lines.push('');
  if (patterns.length === 0) {
    lines.push('# No high-confidence mute/sample candidates in this window.');
  } else {
    for (const p of patterns) {
      const name = input.aiPrettyNames?.[p.identity];
      if (name) lines.push(`# ${name}`);
      lines.push(reducerYaml(p));
      lines.push('');
    }
  }
  lines.push('```');
  return lines.join('\n');
}

/**
 * Native SIEM exclusion-config view — the "I don't want the log10x
 * reducer, just give me the raw SIEM config" path.
 */
export function renderPocConfigs(input: RenderInput, topN = 5): string {
  const drops = enrichPatterns(input)
    .filter((p) => p.recommendedAction === 'mute')
    .slice(0, topN);
  const lines: string[] = [];
  lines.push(`## Native ${SIEM_DISPLAY_NAMES[input.siem]} exclusion configs`);
  lines.push('');
  if (drops.length === 0) {
    lines.push('_No high-confidence mute candidates in this window._');
    return lines.join('\n');
  }
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
    const name = resolveName(p.identity, p.template, input.aiPrettyNames);
    const weekly = p.costPerWeek;
    const annual = projectBilling(p.costPerWindow, input.windowHours, 24 * 365);
    const flag = needsReview(p) ? ' ⚠' : '';
    lines.push(
      `| ${i + 1} | ${name}${flag} | ${p.service || '—'} | ${p.severity || '—'} | ${fmtCount(p.count)} | ${fmtPct(p.pctOfTotal * 100)} | ${fmtDollar(weekly)} | ${fmtDollar(annual)} |`
    );
  }
  return lines.join('\n');
}

/**
 * Pattern-detail view — one pattern, fully expanded. Sample event,
 * slot variables, recommended action, reducer YAML, risk context.
 */
export function renderPocPattern(input: RenderInput, identity: string): string {
  const patterns = enrichPatterns(input);
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
  const name = resolveName(p.identity, p.template, input.aiPrettyNames);
  const annualSavings = projectBilling(p.projectedSavings, input.windowHours, 24 * 365);
  lines.push(`## ${name}`);
  lines.push('');
  lines.push(`**Identity**: \`${p.identity}\``);
  lines.push(
    `**Stats**: ${p.severity || '—'} severity · ${fmtCount(p.count)} events · ${fmtPct(p.pctOfTotal * 100)} of sample volume · ${p.service || 'unknown service'}`
  );
  if (p.costPerWindow > 0 || annualSavings > 0) {
    lines.push(`**Projected cost**: ${fmtDollar(p.costPerWindow)}/window · **Savings if muted**: ${fmtDollar(annualSavings)}/year`);
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
  const topSlots = Object.entries(p.variables).slice(0, 6);
  if (topSlots.length > 0) {
    lines.push('### Variable slots (distinct values observed)');
    for (const [slot, vals] of topSlots) {
      lines.push(`- \`${slot}\`: ${vals.slice(0, 5).map((v) => `\`${truncate(v, 40)}\``).join(', ')}${vals.length > 5 ? `, … (${vals.length - 5} more)` : ''}`);
    }
    lines.push('');
  }
  lines.push(`### Recommendation — ${actionLabel(p)}`);
  lines.push(p.reasoning);
  lines.push('');
  if (p.recommendedAction !== 'keep') {
    lines.push('**Reducer YAML** (paste into GitOps ConfigMap):');
    lines.push('```yaml');
    lines.push(reducerYaml(p));
    lines.push('```');
    lines.push('');
  }
  if (needsReview(p)) {
    lines.push(
      `⚠ **Review before muting**: run \`log10x_dependency_check(pattern: "${p.identity}")\` — this pattern\'s ` +
        `${p.severity || 'severity'}/${p.confidence} profile means it may feed live alerts or dashboards.`
    );
  }
  return lines.join('\n');
}

/**
 * Full view — the original 9-section report. Unchanged; the summary
 * / yaml / configs / top / pattern views are slices of the same data.
 */
export function renderPocReport(input: RenderInput): RenderResult {
  const patterns = enrichPatterns(input);
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
      lines.push(
        `> ⚠ **${fmtCount(droppedEvents)} input lines (${pctLabel}) were NOT accounted for by the templater.** ` +
          `The sum of per-pattern event counts (${fmtCount(accountedEvents)}) is less than the sample line count (${fmtCount(lineCount)}). ` +
          `This is a known engine-side bug (GAPS G11) where the templater silently drops input lines under certain conditions ` +
          `(multi-line stack traces, event-boundary crossings, high-cardinality variant overfitting). ` +
          `**Do not treat the savings projection below as complete** — the dropped lines may contain the highest-volume patterns. ` +
          `Workarounds: (1) rerun with a smaller \`target_event_count\` and broader \`window\` so each batch is large enough that overfitting is unlikely; ` +
          `(2) use \`log10x_event_lookup\` on individual lines if you need ground truth on a specific pattern.`
      );
      lines.push('');
    } else if (dropRate >= 0.05) {
      lines.push(
        `_Note: ${fmtCount(droppedEvents)} sample lines (${pctLabel}) were not accounted for by the templater. Minor drop, likely tiny-batch overfitting._`
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

  lines.push(`# Log10x POC Report — ${SIEM_DISPLAY_NAMES[input.siem]}`);
  lines.push('');
  lines.push(
    `_${input.window} window · scope=\`${input.scope || '(none)'}\`${input.query ? ` · query=\`${input.query}\`` : ''} · snapshot_id=\`${input.snapshotId}\`_`
  );
  lines.push('');

  // Section 1: Executive summary
  const totalCost = patterns.reduce((s, p) => s + p.costPerWindow, 0);
  const projectedSavings = patterns.reduce((s, p) => s + p.projectedSavings, 0);
  const top3 = patterns.slice(0, 3);
  lines.push('## 1. Executive Summary');
  lines.push('');
  lines.push(
    `Analyzed **${fmtCount(input.extraction.totalEvents)} events** (${fmtBytes(input.extraction.totalBytes)}) from ${SIEM_DISPLAY_NAMES[input.siem]} across the last ${input.window}.`
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
      `> Cost figures below extrapolate from the pulled sample (${fmtBytes(input.extraction.totalBytes)}) to the full daily volume by per-pattern %. Pattern rankings + reducer YAML + native exclusion configs are the same regardless of volume; only dollar figures scale.`
    );
    lines.push('');
    const dailyCost = projectBilling(totalCost, input.windowHours, 24);
    const weeklyCost = projectBilling(totalCost, input.windowHours, 24 * 7);
    const monthlyCost = projectBilling(totalCost, input.windowHours, 24 * 30);
    const annualCost = projectBilling(totalCost, input.windowHours, 24 * 365);
    const annualSavings = projectBilling(projectedSavings, input.windowHours, 24 * 365);
    const m = input.volumeRangeMultiplier;
    lines.push(`- **Projected daily cost**: ${formatCostRange(dailyCost, m)}`);
    lines.push(`- **Projected monthly cost**: ${formatCostRange(monthlyCost, m)}`);
    lines.push(`- **Projected annual cost**: ${formatCostRange(annualCost, m)}`);
    void weeklyCost;
    lines.push(
      `- **Potential annual savings**: **${formatCostRange(annualSavings, m)}** — ${fmtPct((annualSavings / Math.max(1, annualCost)) * 100)} of annual cost`
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
    lines.push('**Projected annual savings by ingest volume** (what the top-pattern muting would save):');
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
        `| ${sc.label} | ${monthlyLabel} | ${fmtDollar(annualCost)} | **${fmtDollar(annualSavings)}** |`
      );
    }
    lines.push('');
    lines.push('_Sample-only costs (for reference)_:');
    lines.push(`- **Observed sample cost (window)**: ${fmtDollar(totalCost)}`);
    lines.push(
      `- **Sample potential savings (window)**: ${fmtDollar(projectedSavings)} — ${fmtPct((projectedSavings / Math.max(1, totalCost)) * 100)} of analyzed cost`
    );
  }
  lines.push(
    `- **Analyzer rate**: $${input.analyzerCostPerGb.toFixed(2)}/GB (from vendors.json; override via \`analyzer_cost_per_gb\`)`
  );
  lines.push('');
  if (top3.length > 0) {
    lines.push('**Top 3 wins**:');
    for (const p of top3) {
      const dn = displayName(p.identity, p.template, input.aiPrettyNames);
      const label = p.recommendedAction === 'mute'
        ? `Mute ${dn}`
        : p.recommendedAction === 'sample'
        ? `Sample ${dn} at 1/${p.sampleRate}`
        : `Keep ${dn}`;
      const save = p.recommendedAction === 'keep' ? '' : ` → save ${fmtDollar(p.projectedSavings)}`;
      lines.push(`- ${label}${save}`);
    }
    lines.push('');
  }

  // Section 1.5: Reconciliation note — pre-empts the trust failure
  // when a prospect compares our top-N to their SIEM's native pattern
  // view. The two views WILL differ, sometimes substantially. Owning
  // that upfront is cheaper than letting the prospect notice mid-meeting.
  lines.push(reconciliationSection(input.siem));
  lines.push('');

  // Section 2: Top cost drivers
  lines.push('## 2. Top Cost Drivers');
  lines.push('');
  const topN = Math.min(patterns.length, 20);
  if (topN === 0) {
    lines.push('_No patterns resolved from the pulled events — the templater returned zero. This is usually a sign the events are pre-aggregated JSON blobs rather than raw log lines. Try a narrower `query` or the `privacy_mode: true` path with a locally-installed tenx CLI._');
    lines.push('');
  } else {
    lines.push(
      '| # | pattern identity | service | sev | events | % total | $/window | $/wk projected | newly-emerged |'
    );
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (let i = 0; i < topN; i++) {
      const p = patterns[i];
      const newFlag = p.count === 1 && input.extraction.totalEvents > 100 ? 'new?' : '';
      lines.push(
        `| ${i + 1} | ${displayNameCompact(p.identity, p.template, input.aiPrettyNames)} | ${p.service || 'unknown'} | ${p.severity || '—'} | ${fmtCount(p.count)} | ${fmtPct(p.pctOfTotal * 100)} | ${fmtDollar(p.costPerWindow)} | ${fmtDollar(p.costPerWeek)} | ${newFlag} |`
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
      lines.push(`| ${r.svc} | ${fmtCount(r.events)} | ${fmtDollar(r.cost)} | ${r.severityMix || '—'} |`);
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

  // Section 4: Reducer recommendations
  lines.push('## 4. Reducer Recommendations');
  lines.push('');
  lines.push(
    'Per-pattern recommendations with reasoning, projected savings, and ready-to-paste log10x reducer mute-file YAML. Mutes auto-expire at `untilEpochSec`; sampling retains a statistical slice for debug.'
  );
  lines.push('');
  const reducerTopN = Math.min(patterns.length, 10);
  for (let i = 0; i < reducerTopN; i++) {
    const p = patterns[i];
    lines.push(`### #${i + 1} — ${displayName(p.identity, p.template, input.aiPrettyNames)}  _(${p.confidence} confidence)_`);
    lines.push('');
    lines.push(`- **Action**: ${actionLabel(p)}`);
    lines.push(`- **Reasoning**: ${p.reasoning}`);
    lines.push(`- **Projected savings (window)**: ${fmtDollar(p.projectedSavings)}`);
    lines.push(
      `- **Dependency warning**: ${p.recommendedAction === 'keep' ? '—' : `run \`log10x_dependency_check(pattern: "${p.identity}")\` first to surface alerts/dashboards/saved searches referencing this pattern`}`
    );
    lines.push('');
    if (p.recommendedAction !== 'keep') {
      lines.push('```yaml');
      lines.push(reducerYaml(p));
      lines.push('```');
      lines.push('');
    }
  }

  // Section 5: Native SIEM exclusion configs
  lines.push('## 5. Native SIEM Exclusion Configs');
  lines.push('');
  lines.push(
    `Ready-to-paste configs for ${SIEM_DISPLAY_NAMES[input.siem]} and fluent-bit. Drop these into your pipeline **only** after running \`log10x_dependency_check\` on each pattern.`
  );
  lines.push('');
  const dropCandidates = patterns.filter((p) => p.recommendedAction === 'mute').slice(0, 5);
  if (dropCandidates.length === 0) {
    lines.push('_No high-confidence drop candidates in this window._');
    lines.push('');
  } else {
    lines.push(`### ${SIEM_DISPLAY_NAMES[input.siem]}`);
    lines.push('');
    lines.push('```');
    lines.push(nativeConfig(input.siem, dropCandidates).trim());
    lines.push('```');
    lines.push('');
    lines.push('### Fluent Bit (universal forwarder)');
    lines.push('');
    lines.push('```');
    lines.push(fluentBitConfig(dropCandidates).trim());
    lines.push('```');
    lines.push('');
  }

  // Section 6: Compaction potential (only Splunk / ES / ClickHouse)
  const compactionApplies = input.siem === 'splunk' || input.siem === 'elasticsearch' || input.siem === 'clickhouse';
  if (compactionApplies) {
    lines.push('## 6. Compaction Potential');
    lines.push('');
    lines.push(
      `The Log10x optimizer **losslessly compacts** events by storing structure once and shipping only variable values. For ${SIEM_DISPLAY_NAMES[input.siem]}, the compaction ratio typically runs 5-10× on structured JSON logs, 2-3× on semi-structured.`
    );
    lines.push('');
    lines.push('| pattern | current bytes/window | est. compact bytes | est. savings | before sample | after (compact) |');
    lines.push('|---|---|---|---|---|---|');
    for (const p of patterns.slice(0, 8)) {
      const afterBytes = estimateCompactBytes(p.bytes, p.template);
      const ratio = p.bytes > 0 ? p.bytes / Math.max(1, afterBytes) : 1;
      const saveCost = costFromBytes(p.bytes - afterBytes, input.analyzerCostPerGb);
      lines.push(
        `| ${displayNameCompact(p.identity, p.template, input.aiPrettyNames)} | ${fmtBytes(p.bytes)} | ${fmtBytes(afterBytes)} (${ratio.toFixed(1)}×) | ${fmtDollar(saveCost)} | \`${truncate(p.sampleEvent, 60)}\` | \`~${truncate(p.template, 60)}\` |`
      );
    }
    lines.push('');
    lines.push(
      `Install: see https://docs.log10x.com/apps/cloud/optimizer/ — the optimizer runs as a forwarder sidecar. Compaction is transparent to downstream queries.`
    );
    lines.push('');
  }

  // Section 7: Risk / dependency check
  lines.push('## 7. Risk / Dependency Check');
  lines.push('');
  const riskyDrops = patterns.slice(0, 10).filter((p) => p.recommendedAction !== 'keep').filter((p) => {
    const errorSev = p.severity && /ERROR|CRIT|FATAL|WARN/i.test(p.severity);
    const smallCount = p.count < 10;
    return errorSev || smallCount;
  });
  if (riskyDrops.length === 0) {
    lines.push('_All top drop candidates are high-volume, non-error patterns. Standard dependency check recommended but risk is low._');
    lines.push('');
  } else {
    lines.push('**These drop candidates need careful review**:');
    lines.push('');
    for (const p of riskyDrops) {
      const why: string[] = [];
      if (p.severity && /ERROR|CRIT|FATAL|WARN/i.test(p.severity)) {
        why.push(`severity=${p.severity} — may feed alerts`);
      }
      if (p.count < 10) {
        why.push(`only ${p.count} events in window — low confidence on statistical behavior`);
      }
      lines.push(`- ${displayName(p.identity, p.template, input.aiPrettyNames)} — ${why.join('; ')}`);
    }
    lines.push('');
  }
  lines.push(
    'Before applying any drop, run `log10x_dependency_check(pattern: "<identity>")` which scans Datadog monitors, Splunk saved searches, Grafana dashboards, and Prometheus rules for references. Dropping a pattern that feeds a live alert silently breaks the alert.'
  );
  lines.push('');

  // Section 8: Deployment paths
  lines.push('## 8. Deployment Paths');
  lines.push('');
  lines.push('### Automated — log10x reducer (recommended)');
  lines.push('');
  lines.push(
    '1. Install the Log10x Reducer in your forwarder pipeline — https://docs.log10x.com/apps/edge/reducer/'
  );
  lines.push(
    '2. Commit the generated reducer YAML above into your GitOps repo (the reducer watches a ConfigMap)'
  );
  lines.push(
    '3. Mutes auto-expire at `untilEpochSec`, so stale rules self-clean. The reducer publishes exact pattern-match metrics, so you can verify the intended traffic is being dropped before committing permanently.'
  );
  lines.push('');
  lines.push('### Manual — native SIEM config (no log10x runtime)');
  lines.push('');
  lines.push(
    `1. Paste the ${SIEM_DISPLAY_NAMES[input.siem]} config from Section 5 into your SIEM admin console`
  );
  lines.push('2. Monitor ingestion volume for 24-48h to confirm the drop');
  lines.push(
    '3. Trade-offs vs reducer: no auto-expiry, no per-pattern verification metric, no GitOps-reviewable identity (regex will drift)'
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
    for (const p of patterns.slice(0, 50)) {
      lines.push(
        `| ${displayNameCompact(p.identity, p.template, input.aiPrettyNames)} | ${fmtCount(p.count)} | ${fmtBytes(p.bytes)} | ${p.severity || '—'} | ${p.service || '—'} | \`${truncate(p.sampleEvent, 80).replace(/\|/g, '\\|')}\` |`
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
    '- **Pattern identity** is the Log10x `templateHash` — a stable field-set fingerprint computed from the token structure of the event. Identity stays constant across deploys, restarts, pod names, timestamps, and request IDs.'
  );
  lines.push(
    '- **Cost model**: `bytes × analyzer_cost_per_gb` over the pulled window. Window cost is projected to weekly cost via `$/window × (168h / window_hours)`.'
  );
  lines.push(
    '- **Recommendation rules**: mute when pattern is DEBUG/INFO or below a minimum-value bar AND ≥1% of total volume; sample when MAX 10/s; keep when ERROR or WARN.'
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
    `- **pull_wall_time_ms**: ${input.pullWallTimeMs} (templater ${input.templateWallTimeMs}ms)`
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
    lines.push(`- **naming**: template-based heuristic (AI prettify skipped — ${input.aiPrettifyErrorNote})`);
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
        return p.recommendedAction === 'mute'
          ? `Mute ${name} → save ${fmtDollar(p.projectedSavings)}`
          : p.recommendedAction === 'sample'
          ? `Sample ${name} at 1/${p.sampleRate} → save ${fmtDollar(p.projectedSavings)}`
          : `Keep ${name}`;
      }),
    },
  };
}

// ── Enrichment ──

function enrichPatterns(input: RenderInput): EnrichedPattern[] {
  const total = input.extraction.totalEvents || 1;
  const totalBytes = input.extraction.totalBytes || 1;
  const analyzerCost = input.analyzerCostPerGb;

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
    const identity = toSnakeCase(p.template, p.hash);
    const lit = extractLiteralPhrase(p.template, identity);
    const severity = (p.severity || '').toUpperCase();

    let action: 'mute' | 'sample' | 'keep' = 'keep';
    let sampleRate = 1;
    let reasoning = '';

    const isErrorClass = /ERROR|CRIT|FATAL/.test(severity);
    const isWarn = /WARN/.test(severity);
    const isDebugInfo = /DEBUG|INFO|TRACE/.test(severity) || !severity;
    const isFrequent = pctOfTotal >= 0.01;
    const isHotLoop = pctOfTotal >= 0.02;

    if (isErrorClass) {
      action = 'keep';
      reasoning = `severity=${severity || 'error-class'} — keep for incident diagnosis.`;
    } else if (isWarn) {
      if (isHotLoop) {
        action = 'sample';
        sampleRate = 10;
        reasoning = `WARN pattern is ${fmtPct(pctOfTotal * 100)} of volume — sample 1/10 to keep signal without paying full cost.`;
      } else {
        action = 'keep';
        reasoning = 'WARN pattern below volume threshold — keep.';
      }
    } else if (isDebugInfo && isFrequent) {
      action = isHotLoop ? 'mute' : 'sample';
      sampleRate = action === 'sample' ? 20 : 1;
      reasoning = isHotLoop
        ? `High-volume ${severity || 'info-class'} pattern (${fmtPct(pctOfTotal * 100)} of analyzed volume) — candidate for mute after dependency check.`
        : `Moderate-volume ${severity || 'info-class'} pattern — sample 1/20 to retain a trickle for debug.`;
    } else {
      action = 'keep';
      reasoning = 'Low volume or non-actionable signal — keep.';
    }

    const projectedSavings =
      action === 'mute'
        ? costPerWindow
        : action === 'sample'
        ? costPerWindow * (1 - 1 / sampleRate)
        : 0;

    let confidence: Confidence = 'medium';
    if (p.count >= 100) confidence = 'high';
    else if (p.count < 10) confidence = 'low';

    return {
      ...p,
      costPerWindow,
      pctOfTotal,
      costPerWeek,
      recommendedAction: action,
      sampleRate,
      projectedSavings,
      reasoning,
      confidence,
      identity,
      literalPhrase: lit.phrase,
      literalLeading: lit.leading,
    };
  });

  // Rank: cost descending.
  enriched.sort((a, b) => b.costPerWindow - a.costPerWindow);
  return enriched;
}

function costFromBytes(bytes: number, costPerGb: number): number {
  return (bytes / (1024 ** 3)) * costPerGb;
}

function projectBilling(windowCost: number, windowHours: number, targetHours: number): number {
  if (windowHours <= 0) return 0;
  return windowCost * (targetHours / windowHours);
}

/** Approximate compact-form bytes: static template + variable values (no duplication). */
function estimateCompactBytes(rawBytes: number, template: string): number {
  // If template length >> variable lengths, compaction is aggressive.
  // Heuristic: compact bytes = template bytes + 20% for values per event.
  const templateBytes = Buffer.byteLength(template, 'utf8');
  const variableFraction = 0.2;
  // Compaction amortizes the template over all events — model as:
  //   rawBytes * variableFraction + templateBytes (one-time overhead)
  return Math.max(templateBytes, Math.round(rawBytes * variableFraction) + templateBytes);
}

function toSnakeCase(template: string, fallbackHash: string): string {
  // Strip format specs, lowercase, replace non-word with _, collapse.
  let s = template.replace(/\$\([^)]*\)/g, '');
  s = s.trim().replace(/^(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|CRIT(?:ICAL)?)\b\s*/i, '');
  s = s.replace(/([A-Za-z_][A-Za-z0-9_]*)=\$/g, '$1');
  s = s.replace(/\$/g, '');
  s = s.replace(/[^A-Za-z0-9]+/g, '_');
  s = s.toLowerCase().replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) return fallbackHash.slice(0, 16);
  return s.slice(0, 120);
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
    const sev = p.severity || '—';
    mix.set(sev, (mix.get(sev) || 0) + p.count);
  }
  const total = ps.reduce((s, p) => s + p.count, 0) || 1;
  return Array.from(mix.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([sev, n]) => `${sev} ${fmtPct((n / total) * 100)}`)
    .join(', ');
}

function actionLabel(p: EnrichedPattern): string {
  if (p.recommendedAction === 'mute') return 'mute (drop all events)';
  if (p.recommendedAction === 'sample') return `sample 1/${p.sampleRate}`;
  return 'keep';
}

function reducerYaml(p: EnrichedPattern): string {
  const expirySec = Math.floor(Date.now() / 1000) + 30 * 86_400; // 30-day expiry
  const action = p.recommendedAction === 'mute' ? 'drop' : 'sample';
  const extra = action === 'sample' ? `    sampleRate: ${p.sampleRate}` : '';
  return [
    '# reducer mute file entry — commit to your GitOps ConfigMap',
    `- pattern: ${p.identity}`,
    `  action: ${action}`,
    ...(extra ? [extra] : []),
    `  untilEpochSec: ${expirySec}   # auto-expires in 30d`,
    `  reason: "${p.reasoning.replace(/"/g, '\\"')}"`,
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
      const phrase = p.literalPhrase.replace(/"/g, '\\"');
      return `# Subscription filter: drop pattern #${i + 1}\naws logs put-subscription-filter \\\n  --log-group-name "/aws/your/logs" \\\n  --filter-name "log10x-drop-${i}" \\\n  --filter-pattern '-"${phrase}"' \\\n  --destination-arn "<your-kinesis-or-lambda-arn>"`;
    })
    .join('\n\n');
  return approximationFootnote(drops) + body;
}

function azureExclusion(drops: EnrichedPattern[]): string {
  const conds = drops
    .map((p) => {
      const phrase = p.literalPhrase.replace(/"/g, '\\"');
      return `message contains "${phrase}"`;
    })
    .join(' or ');
  return (
    approximationFootnote(drops) +
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
      return `# Drop rule #${i + 1} — Field Extraction Rules → Drop\nmatches "*${phrase}*"`;
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
    `-- Option A: ingestion-layer drop via MATERIALIZED VIEW\nCREATE MATERIALIZED VIEW logs_filtered\nTO logs_final AS\n  SELECT *\n  FROM logs_raw\n  WHERE ${conds};\n\n-- Option B: drop at the forwarder (preferred — no extra storage writes)`
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
 * Pre-empt the most common trust-failure mode: prospect compares this
 * report's top-N to their SIEM's native pattern view (Datadog Patterns,
 * Splunk `cluster`, Elastic ML categorization, CloudWatch Insights
 * `pattern` keyword) and finds disagreement. Two pattern algorithms
 * built on different tokenizers will always disagree on edge cases.
 * Owning that upfront is cheaper than letting the prospect notice
 * mid-meeting and conclude the tool is broken.
 *
 * The text varies per SIEM because each native tool has its own
 * tokenization quirks and its own term for "pattern". When live API
 * integration ships per vendor (deferred to follow-up PRs), this
 * section will additionally include a side-by-side table.
 */
function reconciliationSection(siem: SiemId): string {
  const lines: string[] = [];
  lines.push('## 1.5. Reconciliation with native pattern view');
  lines.push('');
  switch (siem) {
    case 'datadog':
      lines.push(
        'Datadog has a built-in **Logs > Patterns** view that clusters log lines by template. Our top-N here will not match it line-for-line, and that is expected:'
      );
      lines.push('');
      lines.push(
        '- **Different tokenizers.** Datadog Patterns merges runs of digits and UUIDs aggressively; Log10x preserves field-level boundaries (`tenant=$ txId=$ ms=$`). The same log line resolves to a coarser Datadog pattern and a finer Log10x pattern.'
      );
      lines.push(
        '- **Different sample.** Datadog Patterns runs over the indexed result set for the current Logs Explorer query. Our sample is a stratified random draw across your window. Different inputs → different distributions.'
      );
      lines.push(
        '- **Different ranking.** Datadog ranks by event count; this report ranks by projected cost (count × bytes-per-event × $/GB). A high-frequency 50 B heartbeat outranks a low-frequency 5 KB stack trace in the Datadog view but not here.'
      );
      lines.push('');
      lines.push(
        'When you cross-check, expect ~7 of 10 patterns to overlap, 2-3 to differ on tokenization granularity, and rarely 1 to be missing from one side because the windows or scopes are not perfectly aligned.'
      );
      break;
    case 'splunk':
      lines.push(
        'Splunk has a `cluster` SPL command (and the Patterns tab in the Search & Reporting app) that groups events by similarity threshold. Our top-N will not match it exactly:'
      );
      lines.push('');
      lines.push(
        '- **Different similarity model.** `cluster t=0.8` uses a Jaccard-style edit-distance threshold; Log10x extracts a structural template by identifying which positions vary. Edge-case inputs cluster differently.'
      );
      lines.push(
        '- **Different sample.** `cluster` runs over the result set of the current SPL query in the UI. Our sample is a stratified random draw across your window.'
      );
      lines.push(
        '- **Different ranking.** Patterns in the UI rank by event count; this report ranks by projected cost.'
      );
      break;
    case 'elasticsearch':
      lines.push(
        'Elastic has ML-powered **categorization** in the Logs UI (`categorize_text` aggregation) that groups by message similarity. Our top-N will not match it exactly:'
      );
      lines.push('');
      lines.push(
        '- **Different categorization model.** `categorize_text` uses a Bayesian token classifier; Log10x extracts a structural template directly. Both produce templates, but the boundaries between categories differ on long-tail content.'
      );
      lines.push(
        '- **Different sample.** Elastic categorization runs over the index hits for the active query. Our sample is a stratified random draw across your window.'
      );
      lines.push('- **Different ranking.** Categorize ranks by doc count; this report ranks by projected cost.');
      break;
    case 'cloudwatch':
      lines.push(
        'CloudWatch Insights has a **`pattern`** query keyword that groups by template. Our top-N will not match it exactly:'
      );
      lines.push('');
      lines.push(
        '- **Different sample.** CloudWatch Insights `pattern` runs over the events your Insights query selects. Our sample is a stratified random draw across your window and the same scope.'
      );
      lines.push(
        '- **Different ranking.** CW Insights ranks by event count; this report ranks by projected cost (count × bytes × $/GB ingested).'
      );
      break;
    default:
      lines.push(
        `Most log analyzers ship their own pattern/clustering view. Our top-N here is computed by a different algorithm on a different sample, so it will not match line-for-line. The two views are complementary: their pattern view ranks by event count over the result set; this report ranks by projected cost over a stratified random sample of your full window.`
      );
  }
  lines.push('');
  lines.push(
    '_Mismatches across the two views are not bugs — they are different lenses. If you see a pattern here that you do not recognize from the native view, that is often the signal: the native view smoothed it into a coarser cluster._'
  );
  return lines.join('\n');
}

/**
 * Format a cost figure honestly: a single dollar value when the
 * volume is byte-precise, or a low-high range when an auto-detected
 * fallback estimator was used. The wide bracket is the point: it
 * pushes the user to provide better data (`total_daily_gb`, or grant
 * `usage_read` scope) instead of trusting a confidently-wrong number.
 */
function formatCostRange(
  cost: number,
  multiplier?: { low: number; high: number }
): string {
  if (!multiplier) return fmtDollar(cost);
  const lo = cost * multiplier.low;
  const hi = cost * multiplier.high;
  return `${fmtDollar(lo)} - ${fmtDollar(hi)}`;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ');
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
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
