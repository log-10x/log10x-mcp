/**
 * Markdown report renderers for log10x_investigate.
 *
 * Two shapes:
 *   - Acute-spike: root cause + causal chain + verification commands
 *   - Drift: slope summary + co-drifter cohort + historical investigation window
 *
 * Empty-result format is handled by the caller via renderEmpty().
 */

import type { CorrelationResult, ChainLink } from './correlate.js';
import type { DriftResult } from './drift.js';

export interface AcuteSpikeReportInput {
  investigationId: string;
  anchor: string;
  startingPoint: string;
  inputType: string;
  service?: string;
  environment: string;
  inflectionTimestamp: number; // UNIX seconds
  windowLabel: string;
  metricsEnv: string;
  reporterTier: 'edge' | 'cloud' | 'unknown';
  metricPrimitive: 'event_count' | 'bytes';
  noiseFloor: number;
  modeDetection: string;
  correlation: CorrelationResult;
  retrieverFallback: 'disabled' | 'unavailable' | 'stage_1_only' | 'stage_1_and_2' | 'not_run';
  depth: string;
  /** Surfaced when the Reporter doesn't emit the event-count metric and the tool auto-fell back to bytes. */
  metricWarning?: string;
}

export interface DriftReportInput {
  investigationId: string;
  anchor: string;
  startingPoint: string;
  inputType: string;
  service?: string;
  environment: string;
  windowLabel: string;
  metricsEnv: string;
  reporterTier: 'edge' | 'cloud' | 'unknown';
  metricPrimitive: 'event_count' | 'bytes';
  driftThresholdApplied: number;
  drift: DriftResult;
}

export function renderAcuteSpikeReport(input: AcuteSpikeReportInput): string {
  const lines: string[] = [];
  const infMinsAgo = Math.max(0, Math.round((Date.now() / 1000 - input.inflectionTimestamp) / 60));
  const infIso = new Date(input.inflectionTimestamp * 1000).toISOString();

  lines.push(`## Investigation: ${input.startingPoint}, last ${input.windowLabel}`);
  lines.push('');
  lines.push(`**Investigation id**: ${input.investigationId}`);
  lines.push(`**Anchor**: \`${input.anchor}\` (resolved from ${input.inputType})`);
  if (input.service) lines.push(`**Service**: ${input.service}`);
  lines.push(`**Environment**: ${input.environment}`);
  lines.push(`**Inflection**: ${infIso} UTC, ${infMinsAgo} min ago`);
  lines.push(`**Shape**: acute spike`);
  lines.push(`**Reporter tier**: ${input.reporterTier}`);
  lines.push(`**Metric primitive**: ${input.metricPrimitive}${input.metricPrimitive === 'bytes' ? ' ⚠ _bytes-based rate can be skewed by single large events — event-count metric preferred once available_' : ''}`);
  lines.push(`**Noise floor**: ${input.noiseFloor}`);
  lines.push(`**Mode detection**: ${input.modeDetection}`);
  if (input.metricWarning) {
    lines.push('');
    lines.push(`> ⚠ **Metric warning**: ${input.metricWarning}`);
  }
  lines.push('');

  // Fidelity annotations — tier-aware
  lines.push('### Fidelity annotations');
  lines.push('');
  if (input.reporterTier === 'cloud') {
    lines.push('- **Count estimation error**: ±N% (sampled by Cloud Reporter CronJob)');
    lines.push('- **Inflection timing granularity**: bounded by the sampling window (typically 1–5 min)');
    lines.push('- **Rare-variant coverage warning**: rare variable values may be under-sampled');
    lines.push('- **Forwarder-dropped events visible**: false (Cloud Reporter inherits the SIEM coverage gap)');
  } else if (input.reporterTier === 'edge') {
    lines.push('- **Count estimation error**: 0% (exact counts via forwarder pipeline sidecar)');
    lines.push('- **Inflection timing granularity**: ~5 seconds');
    lines.push('- **Rare-variant coverage**: complete');
    lines.push('- **Forwarder-dropped events visible**: true');
  } else {
    lines.push('- Reporter tier could not be determined. Fidelity is unknown.');
  }
  lines.push('');

  // Root cause
  const chain = input.correlation.chain;
  // Pre-compute extras so the no-chain message can reference them accurately.
  const allExtras = input.correlation.coMovers.filter((m) => !chain.find((c) => c.mover.pattern === m.pattern));

  lines.push('### Most likely root cause');
  lines.push('');
  if (chain.length === 0) {
    if (allExtras.length > 0) {
      lines.push(`_No co-movers exceeded the primary confidence threshold. ${allExtras.length} lower-confidence co-mover${allExtras.length !== 1 ? 's' : ''} are listed below — they moved with the anchor but without enough lead time or magnitude to infer causality._`);
      lines.push("_Try `depth: \"deep\"` to expand the candidate universe, or paste a specific log line instead of a service name._");
    } else {
      lines.push('_No co-movers crossed the noise floor. The anchor moved but the correlation engine found no above-threshold candidates in the window and depth scope you specified._');
      lines.push("_Try widening `window` (e.g., `6h`), switching `depth: \"deep\"`, or verifying the anchor's metric has enough history in this environment._");
    }
  } else {
    const lead = chain[0];
    const conf = (lead.confidence * 100).toFixed(0);
    const lagSec = lead.mover.lagSeconds ?? 0;
    const peakedBefore = lagSec < 0 ? `${Math.abs(lagSec)}s before the anchor` : `concurrent with the anchor`;
    const multiplier = (1 + Math.abs(lead.mover.rateChange)).toFixed(1);
    lines.push(`**Pattern**: \`${lead.mover.pattern}\` in \`${lead.mover.service || 'unknown'}\``);
    lines.push(`**Confidence**: ${conf}% (stat:${lead.stat.toFixed(2)} lag:${lead.lag.toFixed(2)} chain:${lead.chain.toFixed(2)})`);
    lines.push(`**Why**: peaked ${peakedBefore}, magnitude ${multiplier}× baseline.`);
  }
  lines.push('');

  // Chain
  if (chain.length > 0) {
    lines.push('### Causal chain');
    lines.push('');
    for (let i = 0; i < chain.length; i++) {
      lines.push(formatChainLink(chain[i], i + 1));
    }
    lines.push('');
  }

  // Co-movers (not chain) — allExtras was pre-computed above, reuse here.
  const extras = allExtras;
  if (extras.length > 0) {
    lines.push('### Co-movers (lower confidence)');
    lines.push('');
    for (const m of extras.slice(0, 6)) {
      const direction = m.direction === 'up' ? `+${(m.rateChange * 100).toFixed(0)}%` : `${(m.rateChange * 100).toFixed(0)}%`;
      lines.push(`- \`${m.pattern}\` (\`${m.service || 'unknown'}\`) — ${direction} vs baseline`);
    }
    lines.push('');
  }

  // Verification commands
  lines.push('### Suggested verification commands');
  lines.push('');
  const rootService = chain[0]?.mover.service || input.service || '<service>';
  const windowStart = Math.max(0, input.inflectionTimestamp - 900);
  const windowEnd = input.inflectionTimestamp + 900;
  lines.push('```bash');
  lines.push(`gh api /repos/$GH_OWNER/${rootService}/commits?since=${new Date(windowStart * 1000).toISOString()}&until=${new Date(windowEnd * 1000).toISOString()}`);
  lines.push(`kubectl get events -n ${rootService} --since=${infMinsAgo}m`);
  lines.push(`dog metric query "avg:trace.${rootService}.requests{*} by {resource_name}" --from ${windowStart} --to ${windowEnd}`);
  lines.push('```');
  lines.push('');

  // Next actions
  lines.push('### Recommended next actions');
  lines.push('');
  if (chain.length > 0) {
    const lead = chain[0];
    lines.push(`1. Verify the root cause: run the commands above. If the ${rootService} commits or kube events line up with the inflection, the hypothesis is confirmed.`);
    lines.push(`2. Check blast-radius before any action: \`log10x_dependency_check({ pattern: '${lead.mover.pattern}' })\`.`);
    lines.push(`3. For forensic retrieval of the actual root-cause events: \`log10x_retriever_query({ pattern: '${lead.mover.pattern}', from: 'now-2h' })\` (requires Retriever tier).`);
  } else {
    lines.push('1. Widen the investigation window or switch to `depth: "deep"` to expand the pattern universe.');
    lines.push('2. If the symptom is a specific customer or request subset, re-run with a narrower anchor (paste the exact log line instead of a service name).');
  }
  lines.push('');

  // Patterns referenced — flat list the model can cite in follow-up turns.
  const referenced = collectPatternsReferenced(input.anchor, input.correlation);
  if (referenced.length > 0) {
    lines.push('### Patterns referenced in this investigation');
    lines.push('');
    lines.push(referenced.map((p) => `\`${p}\``).join(', '));
    lines.push('');
  }

  // Metadata
  lines.push('---');
  lines.push('');
  lines.push(
    `**Investigation metadata**: ${input.correlation.metadata.patternsAnalyzed} patterns analyzed, ` +
      `${input.correlation.metadata.queriesExecuted} PromQL queries executed, ` +
      `total wall time ${input.correlation.metadata.wallTimeMs}ms. ` +
      `Retriever fallback: ${input.retrieverFallback}. ` +
      `Timeout: ${input.correlation.metadata.hardTimeoutHit ? 'hard' : input.correlation.metadata.softTimeoutHit ? 'soft' : 'none'}.`
  );
  lines.push('');
  lines.push('**Confidence note**: every percentage in this report is mechanically derived from the underlying data signal quality (stat × lag × chain). Ask Claude to explain any specific number and it will walk you through the decomposition.');

  return lines.join('\n');
}

export function collectPatternsReferenced(anchor: string, correlation: CorrelationResult): string[] {
  const set = new Set<string>();
  set.add(anchor);
  for (const link of correlation.chain) set.add(link.mover.pattern);
  for (const m of correlation.coMovers) set.add(m.pattern);
  return Array.from(set);
}

function formatChainLink(link: ChainLink, idx: number): string {
  const conf = (link.confidence * 100).toFixed(0);
  const lag = link.mover.lagSeconds ?? 0;
  const peakLabel = lag < 0 ? `peaked T${lag}s` : lag > 0 ? `peaked T+${lag}s` : `concurrent`;
  const mag = (1 + Math.abs(link.mover.rateChange)).toFixed(1);
  return `${idx}. \`${link.mover.pattern}\` (\`${link.mover.service || 'unknown'}\`) — ${peakLabel}, magnitude ${mag}× — confidence ${conf}% (stat:${link.stat.toFixed(2)} lag:${link.lag.toFixed(2)} chain:${link.chain.toFixed(2)})`;
}

export function renderDriftReport(input: DriftReportInput): string {
  const lines: string[] = [];
  const slope = input.drift.anchorSlopePerWeek;
  const slopePct = (slope * 100).toFixed(1);

  lines.push(`## Investigation: ${input.startingPoint}, last ${input.windowLabel}`);
  lines.push('');
  lines.push(`**Investigation id**: ${input.investigationId}`);
  lines.push(`**Anchor**: \`${input.anchor}\` (resolved from ${input.inputType})`);
  if (input.service) lines.push(`**Service**: ${input.service}`);
  lines.push(`**Environment**: ${input.environment}`);
  lines.push(`**Shape**: gradual drift (no discrete inflection)`);
  lines.push(`**Reporter tier**: ${input.reporterTier}`);
  lines.push(`**Metric primitive**: ${input.metricPrimitive}`);
  lines.push(`**Drift threshold**: ${(input.driftThresholdApplied * 100).toFixed(1)}%/week`);
  lines.push('');

  lines.push('### Drift summary');
  lines.push('');
  lines.push(
    `\`${input.anchor}\` has been growing at **${slope >= 0 ? '+' : ''}${slopePct}%/week** across the last ${input.windowLabel}, ` +
      `with no discrete inflection point. The growth is monotonic and sustained — this is a slow regression that has been compounding.`
  );
  lines.push('');

  // Drift confidence (caller should pre-compute, but we compute inline here)
  const cohort = input.drift.cohort;
  if (cohort.length > 0) {
    lines.push('### Co-drifting patterns (cohort)');
    lines.push('');
    lines.push('Patterns growing at similar rates in the same window:');
    lines.push('');
    lines.push('| Pattern | Service | Slope/week | Similarity |');
    lines.push('|---|---|---|---|');
    for (const c of cohort) {
      lines.push(`| \`${c.pattern}\` | ${c.service || '—'} | ${c.slopePerWeek >= 0 ? '+' : ''}${(c.slopePerWeek * 100).toFixed(1)}% | ${(c.slopeSimilarity * 100).toFixed(0)}% |`);
    }
    lines.push('');
    lines.push('These patterns likely share an upstream cause — typically a change that shipped weeks ago and has been gradually scaling. **The cohort is not a causal chain** (drift cases don\'t have one); it\'s a search-space narrowing.');
  } else {
    lines.push('_No co-drifters crossed the threshold. This anchor is drifting alone, which may mean the cause is local to this pattern or that other affected patterns are below the drift sensitivity floor._');
  }
  lines.push('');

  lines.push('### Suggested verification commands');
  lines.push('');
  lines.push('The drift cause is in a historical deploy window, not recent activity. Look 4–12 weeks back:');
  lines.push('');
  lines.push('```bash');
  const service = input.service || '<service>';
  const now = new Date();
  const monthsAgo = (n: number) => new Date(now.getTime() - n * 30 * 86400_000).toISOString().slice(0, 10);
  lines.push(`gh api /repos/$GH_OWNER/${service}/commits?since=${monthsAgo(3)}&until=${monthsAgo(1)}`);
  lines.push(`gh api /repos/$GH_OWNER/${service}/releases?per_page=30`);
  lines.push('# Cross-reference with feature flag changes, config updates, rollouts in the same window.');
  lines.push('```');
  lines.push('');
  lines.push('**Note**: kubectl events older than 7 days are typically rotated out. CI/CD deploy logs older than your retention may also be unavailable. Older deploys may need to be reconstructed from release tags or change tickets.');
  lines.push('');

  lines.push('### Limitations of drift investigation');
  lines.push('');
  lines.push('Drift cases require customer institutional knowledge to fully resolve. The tool\'s job is **search-space reduction, not root-cause closure**.');
  lines.push('');
  lines.push('- The cohort narrows the candidate set from "every pattern in your environment" to "these patterns growing at similar rates".');
  lines.push('- The recommended correlation window narrows the timeframe from "the last 6 months" to "this 30-day window, 60–90 days ago".');
  lines.push('- Closing the loop requires the customer\'s knowledge of what shipped in that window.');
  lines.push('');

  lines.push('### Recommended next actions');
  lines.push('');
  lines.push('1. Pull commit and release history for the affected services in the drift window.');
  lines.push('2. Cross-reference with feature flag and config changes.');
  lines.push('3. Ask the team that owns these services what shipped in the window.');
  lines.push('4. If the cause is identified, the action is usually a code fix, not a mute — the events are real, just growing too fast.');
  lines.push('');

  const referenced = collectDriftPatternsReferenced(input.anchor, input.drift);
  if (referenced.length > 0) {
    lines.push('### Patterns referenced in this investigation');
    lines.push('');
    lines.push(referenced.map((p) => `\`${p}\``).join(', '));
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    `**Investigation metadata**: ${input.drift.metadata.patternsAnalyzed} patterns analyzed, ` +
      `${input.drift.metadata.queriesExecuted} PromQL queries executed, total wall time ${input.drift.metadata.wallTimeMs}ms.`
  );

  return lines.join('\n');
}

export function collectDriftPatternsReferenced(anchor: string, drift: DriftResult): string[] {
  const set = new Set<string>();
  set.add(anchor);
  for (const c of drift.cohort) set.add(c.pattern);
  return Array.from(set);
}

export function renderEmpty(startingPoint: string, windowLabel: string, investigationId: string, noiseFloor: number): string {
  // Suggest concrete wider windows based on what was tried.
  const isShortWindow = /^(5m|15m|30m|1h|2h)$/.test(windowLabel);
  const nextWindows = isShortWindow
    ? '`window: "6h"`, `"24h"`, or `"7d"`'
    : '`window: "30d"`';

  return [
    `## Investigation: ${startingPoint}, last ${windowLabel}`,
    '',
    `**Investigation id**: ${investigationId}`,
    `**Result**: No significant pattern movement in the last ${windowLabel}. Nothing crossed the noise floor.`,
    '',
    `**Noise floor applied**: ${noiseFloor}`,
    '',
    '**Try next**:',
    `- Widen the window: \`log10x_investigate({ starting_point: '${startingPoint}', window: '24h' })\`${isShortWindow ? ' — most incident inflections appear within 24h' : ''}`,
    `- Or for gradual drift: \`log10x_investigate({ starting_point: '${startingPoint}', window: '30d' })\``,
    `- Check the trend directly: \`log10x_pattern_trend({ pattern: '${startingPoint}' })\``,
    '- Confirm the anchor exists: use a specific log line or pattern hash rather than a service name',
  ].join('\n');
}
