/**
 * CloudWatch read-only dependency check.
 *
 * Endpoints (all read-only):
 *   logs:DescribeMetricFilters    → log-group metric filters that
 *                                   reference the pattern in their
 *                                   filterPattern (most common attach
 *                                   point for CW alarms).
 *   cloudwatch:DescribeAlarms     → metric alarms — match alarm name +
 *                                   metric name + AlarmDescription.
 *   cloudwatch:ListDashboards     → dashboards by name (full body match
 *                                   would require GetDashboard per item;
 *                                   we keep the scan to one round-trip).
 *
 * Two AWS SDKs are required: `@aws-sdk/client-cloudwatch-logs` (already
 * present for the existing pull connector) and `@aws-sdk/client-cloudwatch`
 * (added for this scanner — alarms + dashboards live there, not in logs).
 */

import {
  CloudWatchLogsClient,
  DescribeMetricFiltersCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  ListDashboardsCommand,
} from '@aws-sdk/client-cloudwatch';

import {
  type DepCheckOptions,
  type DepCheckResult,
  type DepMatchedIn,
  emptyResult,
  anyTokenMatches,
  meaningfulTokens,
} from './types.js';

function getRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
}

function consoleUrl(region: string, path: string): string {
  return `https://${region}.console.aws.amazon.com/${path}`;
}

export async function checkCloudWatchDeps(opts: DepCheckOptions): Promise<DepCheckResult> {
  const result = emptyResult('cloudwatch', opts.pattern);
  const region = getRegion();
  const tokens = meaningfulTokens(opts.pattern, opts.tokens);

  const logsClient = new CloudWatchLogsClient({ region, maxAttempts: 3 });
  const cwClient = new CloudWatchClient({ region, maxAttempts: 3 });

  // 1. Metric filters (logs:DescribeMetricFilters). Paginate via nextToken.
  try {
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const resp = await logsClient.send(
        new DescribeMetricFiltersCommand({ nextToken, limit: 50 })
      );
      for (const f of resp.metricFilters || []) {
        const name = f.filterName || '';
        const pattern = f.filterPattern || '';
        const lg = f.logGroupName || '';
        const matchedIn: DepMatchedIn[] = [];
        if (anyTokenMatches(name, tokens)) matchedIn.push('name');
        if (anyTokenMatches(pattern, tokens)) matchedIn.push('query');
        if (matchedIn.length === 0) continue;
        result.matches.push({
          type: 'metric-filter',
          name: `${lg}:${name}`,
          url: lg
            ? consoleUrl(
                region,
                `cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encodeURIComponent(lg)}/metric-filters`
              )
            : undefined,
          matchedIn,
        });
        result.byType.metricFilters++;
      }
      nextToken = resp.nextToken;
      pages++;
    } while (nextToken && pages < 20);
    if (pages >= 20) {
      result.notes.push('metric-filter scan capped at 20 pages — partial coverage on very large accounts');
    }
  } catch (e) {
    result.notes.push(`describeMetricFilters failed: ${(e as Error).message.slice(0, 200)}`);
  }

  // 2. Alarms (cloudwatch:DescribeAlarms). Both metric and composite alarms.
  try {
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const resp = await cwClient.send(
        new DescribeAlarmsCommand({ NextToken: nextToken, MaxRecords: 100 })
      );
      const all = [...(resp.MetricAlarms || []), ...(resp.CompositeAlarms || [])];
      for (const a of all) {
        const name = a.AlarmName || '';
        const desc = a.AlarmDescription || '';
        // MetricAlarm has MetricName; CompositeAlarm doesn't.
        const metricName = (a as { MetricName?: string }).MetricName || '';
        const matchedIn: DepMatchedIn[] = [];
        if (anyTokenMatches(name, tokens)) matchedIn.push('name');
        if (anyTokenMatches(metricName, tokens) || anyTokenMatches(desc, tokens)) matchedIn.push('query');
        if (matchedIn.length === 0) continue;
        result.matches.push({
          type: 'alert',
          name,
          url: name
            ? consoleUrl(
                region,
                `cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(name)}`
              )
            : undefined,
          matchedIn,
        });
        result.byType.alerts++;
      }
      nextToken = resp.NextToken;
      pages++;
    } while (nextToken && pages < 20);
    if (pages >= 20) {
      result.notes.push('alarm scan capped at 20 pages — partial coverage on very large accounts');
    }
  } catch (e) {
    result.notes.push(`describeAlarms failed: ${(e as Error).message.slice(0, 200)}`);
  }

  // 3. Dashboards (cloudwatch:ListDashboards) — name match only.
  try {
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const resp = await cwClient.send(new ListDashboardsCommand({ NextToken: nextToken }));
      for (const d of resp.DashboardEntries || []) {
        const name = d.DashboardName || '';
        if (!anyTokenMatches(name, tokens)) continue;
        result.matches.push({
          type: 'dashboard',
          name,
          url: name
            ? consoleUrl(
                region,
                `cloudwatch/home?region=${region}#dashboards:name=${encodeURIComponent(name)}`
              )
            : undefined,
          matchedIn: ['name'],
        });
        result.byType.dashboards++;
      }
      nextToken = resp.NextToken;
      pages++;
    } while (nextToken && pages < 10);
    if (pages >= 10) {
      result.notes.push('dashboard scan capped at 10 pages — partial coverage');
    }
    result.notes.push(
      'dashboard scan matches name only (full-body match needs per-dashboard GetDashboard round-trips — fall back to bash for deep scan)'
    );
  } catch (e) {
    result.notes.push(`listDashboards failed: ${(e as Error).message.slice(0, 200)}`);
  }

  logsClient.destroy();
  cwClient.destroy();
  return result;
}
