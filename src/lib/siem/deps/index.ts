/**
 * Dispatch read-only dependency-check API calls per SIEM.
 *
 * Each vendor module exports `check<Vendor>Deps(opts)`; this file selects
 * the right one and renders the normalized result as markdown for the
 * dependency-check tool to return.
 */

import type { SiemId } from '../pricing.js';
import { SIEM_DISPLAY_NAMES } from '../pricing.js';
import type { DepCheckOptions, DepCheckResult } from './types.js';
import { checkSplunkDeps } from './splunk.js';
import { checkDatadogDeps } from './datadog.js';
import { checkCloudWatchDeps } from './cloudwatch.js';
import { checkElasticsearchDeps } from './elasticsearch.js';

export type { DepCheckOptions, DepCheckResult } from './types.js';

/** Which SIEM ids the dep-check tool supports (subset of full registry). */
export const DEP_CHECK_VENDORS: SiemId[] = ['datadog', 'splunk', 'elasticsearch', 'cloudwatch'];

export async function checkDeps(vendor: SiemId, opts: DepCheckOptions): Promise<DepCheckResult> {
  switch (vendor) {
    case 'splunk':
      return checkSplunkDeps(opts);
    case 'datadog':
      return checkDatadogDeps(opts);
    case 'cloudwatch':
      return checkCloudWatchDeps(opts);
    case 'elasticsearch':
      return checkElasticsearchDeps(opts);
    default:
      return {
        vendor,
        scannedAt: new Date().toISOString(),
        pattern: opts.pattern,
        matches: [],
        byType: { dashboards: 0, alerts: 0, savedSearches: 0, monitors: 0, metricFilters: 0 },
        notes: [],
        error: `Vendor "${vendor}" is not in the dep-check supported set (${DEP_CHECK_VENDORS.join(', ')})`,
      };
  }
}

/**
 * Render the normalized result as markdown. Used by the dependency-check
 * tool when an in-process scan succeeded; the bash-fallback path renders
 * a different surface.
 */
export function renderDepCheckResult(result: DepCheckResult): string {
  const lines: string[] = [];
  const vendorLabel = SIEM_DISPLAY_NAMES[result.vendor] || result.vendor;
  lines.push(`Dependency Check — ${vendorLabel} (executed)`);
  lines.push('');
  const total = result.matches.length;
  if (total === 0) {
    lines.push(`Scan complete: 0 dependencies found in ${vendorLabel} for pattern \`${result.pattern}\`.`);
  } else {
    const counts: string[] = [];
    if (result.byType.dashboards) counts.push(`${result.byType.dashboards} dashboard${result.byType.dashboards === 1 ? '' : 's'}`);
    if (result.byType.alerts) counts.push(`${result.byType.alerts} alert${result.byType.alerts === 1 ? '' : 's'}`);
    if (result.byType.monitors) counts.push(`${result.byType.monitors} monitor${result.byType.monitors === 1 ? '' : 's'}`);
    if (result.byType.savedSearches) counts.push(`${result.byType.savedSearches} saved search${result.byType.savedSearches === 1 ? '' : 'es'}`);
    if (result.byType.metricFilters) counts.push(`${result.byType.metricFilters} metric filter${result.byType.metricFilters === 1 ? '' : 's'}`);
    lines.push(`Found **${total}** dependencies in ${vendorLabel} for pattern \`${result.pattern}\`: ${counts.join(', ')}.`);
  }
  lines.push('');

  if (total > 0) {
    lines.push('| Type | Name | Matched in | Link |');
    lines.push('|---|---|---|---|');
    for (const m of result.matches) {
      const link = m.url ? `[open](${m.url})` : '—';
      lines.push(`| ${m.type} | ${escapePipe(m.name)} | ${m.matchedIn.join(', ')} | ${link} |`);
    }
    lines.push('');
  }

  if (result.notes.length > 0) {
    lines.push('**Scan notes:**');
    for (const n of result.notes) lines.push(`- ${n}`);
    lines.push('');
  }

  lines.push(`_Scanned at ${result.scannedAt}. Read-only — no SIEM state was modified._`);
  return lines.join('\n');
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, '\\|');
}
