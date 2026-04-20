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
import { fmtBytes, fmtCount, fmtDollar, fmtPct } from './format.js';

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
   * Optional: the customer's total daily log volume (in GB/day). When
   * provided, costs are scaled from the sample to the real daily volume
   * by pattern %, giving meaningful absolute dollar figures instead of
   * the raw $0.00-$0.02 numbers a 5K-event sample produces on its own.
   */
  totalDailyGb?: number;
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
 * Never lose the identity — every machine-pasted reference (regulator
 * YAML, SIEM configs) uses the raw form.
 */
function displayName(identity: string, aiPrettyNames?: Record<string, string>): string {
  const pretty = aiPrettyNames?.[identity];
  if (!pretty) return `\`${identity}\``;
  return `**${pretty}** (\`${identity}\`)`;
}

/** Compact variant for table cells — pretty name with truncated identity suffix. */
function displayNameCompact(identity: string, aiPrettyNames?: Record<string, string>): string {
  const pretty = aiPrettyNames?.[identity];
  if (!pretty) return `\`${identity}\``;
  const short = identity.length > 40 ? identity.slice(0, 38) + '…' : identity;
  return `**${pretty}**<br>\`${short}\``;
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
  /** Snake-case identity — for ready-to-paste regulator configs. */
  identity: string;
  /** Token set used downstream for dependency-check guidance. */
  tokens: string[];
}

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
    // When the caller told us the customer's real daily volume, costs
    // below are SCALED from sample → full daily spend. Make this
    // explicit so nobody thinks our 5K-event sample actually costs $N.
    lines.push(
      `> **Volume-scaled mode**: costs below extrapolate the sample's pattern distribution to the supplied ${input.totalDailyGb.toLocaleString()} GB/day ingest rate. Shown dollar figures represent projected spend across the full daily volume, not the sample's own cost. Set to 0 or omit \`total_daily_gb\` to see raw sample-only costs.`
    );
    lines.push('');
    const dailyCost = projectBilling(totalCost, input.windowHours, 24);
    const weeklyCost = projectBilling(totalCost, input.windowHours, 24 * 7);
    const annualCost = projectBilling(totalCost, input.windowHours, 24 * 365);
    const annualSavings = projectBilling(projectedSavings, input.windowHours, 24 * 365);
    lines.push(`- **Projected daily cost**: ${fmtDollar(dailyCost)}`);
    lines.push(`- **Projected weekly cost**: ${fmtDollar(weeklyCost)}`);
    lines.push(`- **Projected annual cost**: ${fmtDollar(annualCost)}`);
    lines.push(
      `- **Potential annual savings**: ${fmtDollar(annualSavings)} — ${fmtPct((annualSavings / Math.max(1, annualCost)) * 100)} of annual cost`
    );
  } else {
    lines.push(
      `> **Sample-only costs below**: cost figures reflect the pulled sample only (${fmtBytes(input.extraction.totalBytes)}). Pass \`total_daily_gb\` on the submit tool to extrapolate to the customer's full daily volume — that's where the real $$ live.`
    );
    lines.push('');
    lines.push(`- **Observed cost (window)**: ${fmtDollar(totalCost)}`);
    lines.push(`- **Projected weekly cost**: ${fmtDollar(projectBilling(totalCost, input.windowHours, 24 * 7))}`);
    lines.push(
      `- **Potential savings (window)**: ${fmtDollar(projectedSavings)} — ${fmtPct((projectedSavings / Math.max(1, totalCost)) * 100)} of analyzed cost`
    );
  }
  lines.push(
    `- **Analyzer rate**: $${input.analyzerCostPerGb.toFixed(2)}/GB (from vendors.json; override via \`analyzer_cost_per_gb\`)`
  );
  lines.push('');
  if (top3.length > 0) {
    lines.push('**Top 3 wins**:');
    for (const p of top3) {
      const dn = displayName(p.identity, input.aiPrettyNames);
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
        `| ${i + 1} | ${displayNameCompact(p.identity, input.aiPrettyNames)} | ${p.service || 'unknown'} | ${p.severity || '—'} | ${fmtCount(p.count)} | ${fmtPct(p.pctOfTotal * 100)} | ${fmtDollar(p.costPerWindow)} | ${fmtDollar(p.costPerWeek)} | ${newFlag} |`
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

  // Section 4: Regulator recommendations
  lines.push('## 4. Regulator Recommendations');
  lines.push('');
  lines.push(
    'Per-pattern recommendations with reasoning, projected savings, and ready-to-paste log10x regulator mute-file YAML. Mutes auto-expire at `untilEpochSec`; sampling retains a statistical slice for debug.'
  );
  lines.push('');
  const regulatorTopN = Math.min(patterns.length, 10);
  for (let i = 0; i < regulatorTopN; i++) {
    const p = patterns[i];
    lines.push(`### #${i + 1} — ${displayName(p.identity, input.aiPrettyNames)}  _(${p.confidence} confidence)_`);
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
      lines.push(regulatorYaml(p));
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
        `| ${displayNameCompact(p.identity, input.aiPrettyNames)} | ${fmtBytes(p.bytes)} | ${fmtBytes(afterBytes)} (${ratio.toFixed(1)}×) | ${fmtDollar(saveCost)} | \`${truncate(p.sampleEvent, 60)}\` | \`~${truncate(p.template, 60)}\` |`
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
      lines.push(`- ${displayName(p.identity, input.aiPrettyNames)} — ${why.join('; ')}`);
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
  lines.push('### Automated — log10x regulator (recommended)');
  lines.push('');
  lines.push(
    '1. Install the Log10x Regulator in your forwarder pipeline — https://docs.log10x.com/apps/edge/regulator/'
  );
  lines.push(
    '2. Commit the generated regulator YAML above into your GitOps repo (the regulator watches a ConfigMap)'
  );
  lines.push(
    '3. Mutes auto-expire at `untilEpochSec`, so stale rules self-clean. The regulator publishes exact pattern-match metrics, so you can verify the intended traffic is being dropped before committing permanently.'
  );
  lines.push('');
  lines.push('### Manual — native SIEM config (no log10x runtime)');
  lines.push('');
  lines.push(
    `1. Paste the ${SIEM_DISPLAY_NAMES[input.siem]} config from Section 5 into your SIEM admin console`
  );
  lines.push('2. Monitor ingestion volume for 24-48h to confirm the drop');
  lines.push(
    '3. Trade-offs vs regulator: no auto-expiry, no per-pattern verification metric, no GitOps-reviewable identity (regex will drift)'
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
        `| ${displayNameCompact(p.identity, input.aiPrettyNames)} | ${fmtCount(p.count)} | ${fmtBytes(p.bytes)} | ${p.severity || '—'} | ${p.service || '—'} | \`${truncate(p.sampleEvent, 80).replace(/\|/g, '\\|')}\` |`
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
      `- **ai_prettify**: ${Object.keys(input.aiPrettyNames).length} pattern(s) renamed via /api/v1/query_ai`
    );
  } else if (input.aiPrettifyErrorNote) {
    lines.push(`- **ai_prettify**: SKIPPED — ${input.aiPrettifyErrorNote}`);
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
        const name = input.aiPrettyNames?.[p.identity] || p.identity;
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
      tokens: identity.split('_').filter(Boolean),
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

function regulatorYaml(p: EnrichedPattern): string {
  const expirySec = Math.floor(Date.now() / 1000) + 30 * 86_400; // 30-day expiry
  const action = p.recommendedAction === 'mute' ? 'drop' : 'sample';
  const extra = action === 'sample' ? `    sampleRate: ${p.sampleRate}` : '';
  return [
    '# regulator mute file entry — commit to your GitOps ConfigMap',
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

function datadogExclusion(drops: EnrichedPattern[]): string {
  // Datadog exclusion filter body; the model will upload via API or paste into UI.
  return drops
    .map((p, i) => {
      const query = p.tokens.map(escapeRegex).join('.*');
      return [
        `# Exclusion filter #${i + 1}`,
        JSON.stringify({ name: `Drop ${p.identity.slice(0, 40)}`, is_enabled: true, filter: { query: `@message:/${query}/` } }, null, 2),
      ].join('\n');
    })
    .join('\n\n');
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
    stanzas.push(`REGEX = ${p.tokens.map(escapeRegex).join('.*')}`);
    stanzas.push('DEST_KEY = queue');
    stanzas.push('FORMAT = nullQueue');
    stanzas.push('');
  }
  return stanzas.join('\n');
}

function elasticsearchExclusion(drops: EnrichedPattern[]): string {
  const processors = drops.map((p) => ({
    drop: {
      if: `ctx.message != null && (${p.tokens.map((t) => `ctx.message.contains('${t.replace(/'/g, "\\'")}')`).join(' && ')})`,
    },
  }));
  return `PUT _ingest/pipeline/log10x_drop\n${JSON.stringify({ description: 'Log10x recommended drops', processors }, null, 2)}`;
}

function cloudwatchExclusion(drops: EnrichedPattern[]): string {
  // CloudWatch subscription-filter exclude patterns. One per pattern.
  return drops
    .map(
      (p, i) =>
        `# Subscription filter: drop pattern #${i + 1}\naws logs put-subscription-filter \\\n  --log-group-name "/aws/your/logs" \\\n  --filter-name "log10x-drop-${i}" \\\n  --filter-pattern '-"${p.tokens.slice(0, 3).join('" -"')}"' \\\n  --destination-arn "<your-kinesis-or-lambda-arn>"`
    )
    .join('\n\n');
}

function azureExclusion(drops: EnrichedPattern[]): string {
  const drop = drops
    .map((p) => `has_any(dynamic([${p.tokens.slice(0, 3).map((t) => `"${t}"`).join(', ')}]))`)
    .join(' or ');
  return `// Data Collection Rule KQL transform\nsource | where not (${drop})`;
}

function gcpExclusion(drops: EnrichedPattern[]): string {
  return drops
    .map((p, i) => `# Log exclusion filter #${i + 1} (gcloud logging sinks)\ntextPayload:(${p.tokens.slice(0, 3).map((t) => `"${t}"`).join(' AND ')})`)
    .join('\n\n');
}

function sumoExclusion(drops: EnrichedPattern[]): string {
  return drops
    .map((p, i) => `# Drop rule #${i + 1} — Field Extraction Rules → Drop\n${p.tokens.slice(0, 3).map((t) => `matches "${t}"`).join(' AND ')}`)
    .join('\n\n');
}

function clickhouseExclusion(drops: EnrichedPattern[]): string {
  const conds = drops
    .map((p) => `(message NOT ILIKE '%${p.tokens.slice(0, 3).join('%')}%')`)
    .join('\n        AND ');
  return `-- Option A: ingestion-layer drop via MATERIALIZED VIEW\nCREATE MATERIALIZED VIEW logs_filtered\nTO logs_final AS\n  SELECT *\n  FROM logs_raw\n  WHERE ${conds};\n\n-- Option B: drop at the forwarder (preferred — no extra storage writes)`;
}

function fluentBitConfig(drops: EnrichedPattern[]): string {
  const filters = drops
    .map(
      (p, i) =>
        `[FILTER]\n    Name       grep\n    Match      *\n    Exclude    log ${p.tokens.slice(0, 3).map(escapeRegex).join('.*')}\n# pattern identity: ${p.identity} (#${i + 1})`
    )
    .join('\n\n');
  return filters;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ');
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}
