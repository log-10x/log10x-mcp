/**
 * Datadog monitor definitions on the per-pattern series the engine's Datadog
 * output publishes. Rendered as JSON for the account owner to apply with
 * their own tooling; nothing here calls Datadog.
 *
 * Route monitor: a metric monitor (multi alert) that fires for a statement
 * the first time its lines carry `routestate:tier_down` or
 * `routestate:offload`. Datadog notifies on the OK to Alert transition, so a
 * statement a rule holds every day alerts once, when it turns.
 *
 * Volume monitor: an anomaly monitor with weekly seasonality, so a statement
 * alerts when its volume rises above what the same hour of the week usually
 * shows. Datadog documents weekly seasonality for the `agile` and `robust`
 * algorithms and needs three weeks of data for it
 * (docs.datadoghq.com/monitors/types/anomaly/). `robust` is the one Datadog
 * recommends when a slow level shift counts as an anomaly, which is the cost
 * case: a statement that stays loud keeps costing.
 */

import { DD_TAGS, DD_VOLUME_METRIC, ddScope } from './datadog-metrics-read.js';

export interface DatadogMonitorDefinition {
  name: string;
  type: 'query alert';
  query: string;
  message: string;
  tags: string[];
  priority: null;
  options: Record<string, unknown>;
}

export interface SpikeMonitorOptions {
  /** `tenx_env` value to scope both monitors to. */
  tenxEnv?: string;
  /** Team tag key, included only when the series carry it (e.g. `tenx_team`). */
  teamTag?: string;
  /** Notification handles appended to each message (e.g. `@slack-log-cost`). */
  notify?: string[];
  /** Anomaly bounds, in deviations. Default 3. */
  deviations?: number;
}

export interface SpikeMonitors {
  route: DatadogMonitorDefinition;
  volume: DatadogMonitorDefinition;
  group_by: string[];
  docs: string[];
}

export const MONITOR_DOCS = [
  'https://docs.datadoghq.com/monitors/types/metric/',
  'https://docs.datadoghq.com/monitors/types/anomaly/',
  'https://docs.datadoghq.com/metrics/advanced-filtering/',
  'https://docs.datadoghq.com/getting_started/tagging/',
  'https://docs.datadoghq.com/api/latest/monitors/',
];

const TAG_KEY_RE = /^[a-z][a-z0-9_.\-/]*$/;

export function normalizeTagKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const k = key.trim().toLowerCase();
  return TAG_KEY_RE.test(k) ? k : undefined;
}

function tagValue(v: string): string {
  return v.trim().toLowerCase().replace(/[^a-z0-9_.\-/:]/g, '_');
}

export function spikeMonitorGroupBy(teamTag?: string): string[] {
  const keys: string[] = [DD_TAGS.pattern, DD_TAGS.hash, DD_TAGS.container, DD_TAGS.service];
  const team = normalizeTagKey(teamTag);
  if (team) keys.push(team);
  return keys;
}

export function buildSpikeMonitors(opts: SpikeMonitorOptions = {}): SpikeMonitors {
  const team = normalizeTagKey(opts.teamTag);
  const envFilter = opts.tenxEnv ? `${DD_TAGS.env}:${tagValue(opts.tenxEnv)}` : undefined;
  const groupBy = spikeMonitorGroupBy(team);
  const routeGroupBy = [...groupBy.slice(0, 4), DD_TAGS.route, ...groupBy.slice(4)];
  const deviations = opts.deviations && opts.deviations > 0 ? opts.deviations : 3;
  const notify = (opts.notify ?? []).map((h) => h.trim()).filter((h) => h.startsWith('@'));
  const teamLine = team ? `\nTeam: {{${team}.name}}.` : '';
  const notifyLine = notify.length > 0 ? `\n${notify.join(' ')}` : '';
  const envName = opts.tenxEnv ? ` (${opts.tenxEnv})` : '';

  const routeScope = ddScope([envFilter, `${DD_TAGS.route} IN (tier_down, offload)`]);
  const routeQuery =
    `sum(last_1h):sum:${DD_VOLUME_METRIC}{${routeScope}} by {${routeGroupBy.join(',')}}.as_count() > 0`;
  const where =
    `{{#is_match "${DD_TAGS.route}.name" "tier_down"}}Flex (tier_down){{/is_match}}` +
    `{{#is_match "${DD_TAGS.route}.name" "offload"}}S3 (offload){{/is_match}}`;
  const route: DatadogMonitorDefinition = {
    name: `[log10x] {{${DD_TAGS.pattern}.name}} in {{${DD_TAGS.container}.name}} turned {{${DD_TAGS.route}.name}}${envName}`,
    type: 'query alert',
    query: routeQuery,
    message:
      `{{#is_alert}}The statement {{${DD_TAGS.pattern}.name}} ({{${DD_TAGS.hash}.name}}) in {{${DD_TAGS.container}.name}} ` +
      `went over its limit, and the log10x Receiver now routes its lines above the limit to ${where} instead of the Standard index.{{/is_alert}}` +
      `{{#is_recovery}}No line of {{${DD_TAGS.pattern}.name}} in {{${DD_TAGS.container}.name}} left the Standard index in the last hour.{{/is_recovery}}` +
      teamLine +
      `\nThe log10x weekly change report names the rule that held it and its estimated cost.` +
      notifyLine,
    tags: ['integration:log10x', 'log10x:route-change'],
    priority: null,
    options: {
      thresholds: { critical: 0 },
      notify_no_data: false,
      require_full_window: false,
      include_tags: true,
      notify_audit: false,
      new_group_delay: 0,
    },
  };

  const volumeScope = ddScope([envFilter]);
  const volumeQuery =
    `avg(last_5h):anomalies(sum:${DD_VOLUME_METRIC}{${volumeScope}} by {${groupBy.join(',')}}.as_count(), ` +
    `'robust', ${deviations}, direction='above', alert_window='last_1h', interval=300, ` +
    `count_default_zero='true', seasonality='weekly') >= 1`;
  const volume: DatadogMonitorDefinition = {
    name: `[log10x] {{${DD_TAGS.pattern}.name}} in {{${DD_TAGS.container}.name}} is above its weekly baseline${envName}`,
    type: 'query alert',
    query: volumeQuery,
    message:
      `{{#is_alert}}Lines of {{${DD_TAGS.pattern}.name}} ({{${DD_TAGS.hash}.name}}) in {{${DD_TAGS.container}.name}} ` +
      `are above the range the same hour of the week usually shows.{{/is_alert}}` +
      `{{#is_recovery}}{{${DD_TAGS.pattern}.name}} in {{${DD_TAGS.container}.name}} is back inside its weekly range.{{/is_recovery}}` +
      teamLine +
      `\nThe weekly baseline needs three weeks of data before it alerts on a statement.` +
      notifyLine,
    tags: ['integration:log10x', 'log10x:volume-baseline'],
    priority: null,
    options: {
      thresholds: { critical: 1, critical_recovery: 0 },
      threshold_windows: { trigger_window: 'last_1h', recovery_window: 'last_1h' },
      notify_no_data: false,
      require_full_window: false,
      include_tags: true,
      notify_audit: false,
    },
  };

  return { route, volume, group_by: groupBy, docs: MONITOR_DOCS };
}
