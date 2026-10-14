/**
 * log10x_datadog_change_report: what changed in a Datadog install since a
 * point in time, read from the per-pattern series the engine's Datadog
 * output publishes, plus the monitor definitions that watch the same series.
 *
 * view=markdown|summary: statements new in a service since `since`, each
 * with lines a day, estimated Standard indexing cost a month, whether a rule
 * held it and which (container row and action from the engine files), and
 * proposed per-service rows in the plan's sentence form.
 *
 * view=monitors: the route monitor and the weekly-baseline monitor as JSON
 * (lib/datadog-monitors.ts). Reads nothing.
 *
 * Stateless by design: "since the last run" is the `since` argument, and
 * every report returns `next_since` for the next call. Reads only: Datadog's
 * query API (GET) and the engine's caps.csv / actions.csv from the gitops
 * repo or the policy ConfigMap.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import {
  DD_TAGS,
  DD_VOLUME_METRIC,
  HELD_ROUTES,
  datadogMetricsCredsFromEnv,
  ddMetricTagKeys,
  ddQueryWindow,
  ddScope,
  type DatadogMetricsCreds,
  type DdSeries,
} from '../lib/datadog-metrics-read.js';
import { buildSpikeMonitors, normalizeTagKey, type SpikeMonitors } from '../lib/datadog-monitors.js';
import { DATADOG_FLEX_LIST_PRICING, HOURS_PER_MONTH, fmtListRate, type PerEventTierPricing } from '../lib/cost.js';
import { FLEET_DEFAULT_HEADROOM, fleetDefaultLimit } from '../lib/fleet-default.js';
import { fmtAboutUsd, fmtLinesPerDay, serviceLimitSentence } from '../lib/report/user-units.js';
import { parseCapCsv } from '../lib/cap-csv-parser.js';
import {
  envWithResolvedGitops,
  fetchActionsCsvForEnv,
  fetchActionsCsvFromConfigMap,
  fetchCapCsvForEnv,
  fetchCapCsvFromConfigMap,
} from '../lib/cap-csv-fetch.js';
import { validateStrictArgs } from '../lib/strict-args.js';
import {
  buildChassisEnvelope,
  buildChassisErrorEnvelope,
  newChassisTelemetry,
  recordQuery,
  type ChassisEnvelope,
} from '../lib/chassis-envelope.js';
import { QUERY_BUDGET } from '../lib/interactive-query.js';

const TOOL = 'log10x_datadog_change_report';

export const datadogChangeReportSchema = {
  view: z
    .enum(['markdown', 'summary', 'monitors'])
    .default('markdown')
    .describe(
      '`markdown` (default): the weekly change report. `summary`: the same data without the rendered page. ' +
        '`monitors`: two Datadog monitor definitions as JSON (a statement turning tier_down or offload; a statement above its weekly baseline), for the account owner to apply. `monitors` reads nothing.',
    ),
  since: z
    .string()
    .default('7d')
    .describe(
      'Start of the report: a duration back from now (`7d`, `36h`) or a date or ISO timestamp (`2026-10-06`). ' +
        'A statement is new when it had no line in its service in the `lookback` before this point. ' +
        'Pass the previous report\'s `next_since` to continue where it ended. Default `7d`.',
    ),
  lookback: z
    .string()
    .regex(/^\d+d$/)
    .default('28d')
    .describe('How far before `since` to look for earlier lines of a statement. Default `28d`, at most `90d`.'),
  tenx_env: z.string().optional().describe('`tenx_env` tag value to scope the series to. Omit for every environment.'),
  team_tag: z
    .string()
    .optional()
    .describe('Team tag key on the series (e.g. `tenx_team`). Omit to detect `tenx_team` on the series; the team is shown only when present.'),
  action: z
    .enum(['tier_down', 'offload'])
    .default('tier_down')
    .describe('Where a proposed row sends a statement: `tier_down` (Flex, the default) or `offload` (S3) for an account without Flex.'),
  headroom: z
    .number()
    .min(1)
    .max(10)
    .default(FLEET_DEFAULT_HEADROOM)
    .describe('Multiplier on the fleet\'s largest kept statement, for a service with no history of its own. Default 2.'),
  limit: z.number().int().min(1).max(100).default(25).describe('Most new statements listed. Default 25.'),
  site: z.string().optional().describe('Datadog site (e.g. `us5.datadoghq.com`). Defaults to DD_SITE, then `datadoghq.com`.'),
  notify: z
    .array(z.string())
    .optional()
    .describe('Notification handles for the monitors view (e.g. `@slack-log-cost`).'),
  environment: z.string().optional().describe('MCP environment nickname, used to find the gitops repo holding caps.csv and actions.csv.'),
};

export interface DatadogChangeReportArgs {
  view?: 'markdown' | 'summary' | 'monitors';
  since?: string;
  lookback?: string;
  tenx_env?: string;
  team_tag?: string;
  action?: 'tier_down' | 'offload';
  headroom?: number;
  limit?: number;
  site?: string;
  notify?: string[];
  environment?: string;
}

export interface PolicyFiles {
  /** Where the files came from, or null when neither source answered. */
  source: string | null;
  capsCsv?: string;
  actionsCsv?: string;
}

export interface ChangeReportDeps {
  /** Datadog keys. Undefined reads DD_API_KEY / DD_APP_KEY / DD_SITE; null means none. */
  creds?: DatadogMetricsCreds | null;
  readPolicy?: (env: EnvConfig | undefined) => Promise<PolicyFiles>;
  nowMs?: () => number;
}

// ── Engine files ─────────────────────────────────────────────────────────

export async function readPolicyFilesDefault(env: EnvConfig | undefined): Promise<PolicyFiles> {
  const envRepo = env ? envWithResolvedGitops(env) : undefined;
  const repo = envRepo?.gitops?.repo ?? process.env.LOG10X_GH_REPO?.trim();
  if (repo) {
    const target = (envRepo?.gitops?.repo ? envRepo : { gitops: { repo } }) as EnvConfig;
    const [capsCsv, actionsCsv] = await Promise.all([
      fetchCapCsvForEnv(target).catch(() => undefined),
      fetchActionsCsvForEnv(target).catch(() => undefined),
    ]);
    if (capsCsv || actionsCsv) return { source: `gitops repo ${repo}`, capsCsv, actionsCsv };
  }
  const name = process.env.K8S_CONFIGMAP || 'log10x-action-intent';
  const ns = process.env.K8S_NAMESPACE || 'default';
  const [capsCsv, actionsCsv] = await Promise.all([
    fetchCapCsvFromConfigMap(name, ns).catch(() => undefined),
    fetchActionsCsvFromConfigMap(name, ns).catch(() => undefined),
  ]);
  if (capsCsv || actionsCsv) return { source: `ConfigMap ${ns}/${name}`, capsCsv, actionsCsv };
  return { source: null };
}

const ACTIONS = new Set(['pass', 'sample', 'compact', 'tier_down', 'offload', 'drop']);
const SEED_KEY = 'tenx-seed';

/** actions.csv: `<container>,<action>[:<until>][:<reason>]`, header `container,action`. */
export function parseActionsCsv(csv: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!csv) return out;
  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(',');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const action = line.slice(i + 1).split(':')[0].trim().toLowerCase();
    if (key === SEED_KEY || !ACTIONS.has(action)) continue;
    out.set(key, action);
  }
  return out;
}

// ── Report model ─────────────────────────────────────────────────────────

export type RuleKind = 'statement_row' | 'service_row' | 'fleet_default' | 'not_read';

export interface HoldingRule {
  kind: RuleKind;
  container: string;
  /** Action from actions.csv, or the observed route when the file has no row. */
  action: string;
  text: string;
}

export interface NewStatement {
  pattern: string;
  pattern_hash: string;
  container: string;
  service: string;
  team: string | null;
  routes: string[];
  first_seen_iso: string | null;
  lines_a_day: number;
  held_lines_a_day: number;
  standard_usd_month: number;
  held: boolean;
  rule: HoldingRule | null;
}

export interface ProposedRow {
  container: string;
  lines_a_day_limit: number;
  basis: 'service' | 'fleet';
  action: 'tier_down' | 'offload';
  statements: Array<{ pattern: string; pattern_hash: string; lines_a_day: number; standard_usd_month: number }>;
  standard_usd_month: number;
  sentence: string;
}

export interface ChangeReport {
  since_iso: string;
  until_iso: string;
  next_since: string;
  window_days: number;
  team_tag: string | null;
  statements: NewStatement[];
  statement_count_total: number;
  held_count: number;
  standard_usd_month_total: number;
  proposed_rows: ProposedRow[];
  services_without_proposal: string[];
  policy_source: string | null;
  pricing: { standard_usd_per_million_events: number; text: string };
  caveats: string[];
}

export interface BuildChangeReportInput {
  current: DdSeries[];
  prior: DdSeries[];
  sinceSec: number;
  nowSec: number;
  teamTag: string | null;
  policy: PolicyFiles;
  action: 'tier_down' | 'offload';
  headroom: number;
  limit: number;
  pricing?: PerEventTierPricing;
}

const DAYS_PER_MONTH = HOURS_PER_MONTH / 24;

function tv(tags: Record<string, string>, key: string): string {
  const v = (tags[key] ?? '').trim();
  return v === '' || v.toLowerCase() === 'n/a' ? '' : v;
}

function statementKey(hash: string, pattern: string, container: string): string {
  return `${hash || pattern}\u0000${container}`;
}

function containerOf(tags: Record<string, string>): string {
  return tv(tags, DD_TAGS.container) || tv(tags, DD_TAGS.service) || '(no container)';
}

function routeWord(route: string): string {
  switch (route) {
    case 'tier_down': return 'Flex';
    case 'offload': return 'S3';
    case 'drop': return 'dropped';
    case 'sample': return 'sampled';
    default: return route;
  }
}

export function fmtLinesADay(n: number): string {
  if (n > 0 && n < 1) return 'under 1';
  return fmtLinesPerDay(n);
}

export function fmtUsdMonth(v: number): string {
  if (v > 0 && v < 0.01) return 'under $0.01';
  return fmtAboutUsd(v);
}

function isoMinute(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z');
}

export function standardUsdMonth(linesADay: number, pricing: PerEventTierPricing = DATADOG_FLEX_LIST_PRICING): number {
  return ((linesADay * DAYS_PER_MONTH) / 1e6) * pricing.standard_index_usd_per_million_events;
}

export function buildChangeReport(input: BuildChangeReportInput): ChangeReport {
  const pricing = input.pricing ?? DATADOG_FLEX_LIST_PRICING;
  const windowDays = Math.max((input.nowSec - input.sinceSec) / 86400, 1 / 24);
  const teamTag = input.teamTag;

  interface Acc {
    pattern: string;
    hash: string;
    container: string;
    services: Set<string>;
    teams: Set<string>;
    routes: Map<string, number>;
    total: number;
    held: number;
    first: number | null;
  }
  const byKey = new Map<string, Acc>();
  for (const s of input.current) {
    if (!(s.total > 0)) continue;
    const pattern = tv(s.tags, DD_TAGS.pattern);
    const hash = tv(s.tags, DD_TAGS.hash);
    if (!pattern && !hash) continue;
    const container = containerOf(s.tags);
    const key = statementKey(hash, pattern, container);
    let a = byKey.get(key);
    if (!a) {
      a = { pattern, hash, container, services: new Set(), teams: new Set(), routes: new Map(), total: 0, held: 0, first: null };
      byKey.set(key, a);
    }
    if (!a.pattern && pattern) a.pattern = pattern;
    const svc = tv(s.tags, DD_TAGS.service);
    if (svc) a.services.add(svc);
    if (teamTag) {
      const team = tv(s.tags, teamTag);
      if (team) a.teams.add(team);
    }
    const route = tv(s.tags, DD_TAGS.route).toLowerCase() || 'pass';
    a.routes.set(route, (a.routes.get(route) ?? 0) + s.total);
    a.total += s.total;
    if (HELD_ROUTES.has(route)) a.held += s.total;
    if (s.firstNonZeroSec !== null && (a.first === null || s.firstNonZeroSec < a.first)) a.first = s.firstNonZeroSec;
  }

  const seenBefore = new Set<string>();
  for (const s of input.prior) {
    if (!(s.total > 0)) continue;
    const pattern = tv(s.tags, DD_TAGS.pattern);
    const hash = tv(s.tags, DD_TAGS.hash);
    if (!pattern && !hash) continue;
    seenBefore.add(statementKey(hash, pattern, containerOf(s.tags)));
  }

  const caps = parseCapCsv(input.policy.capsCsv);
  const actions = parseActionsCsv(input.policy.actionsCsv);
  const policyRead = input.policy.source !== null;
  // Datadog lower-cases metric tags, so a hash read from the series is matched without case.
  const statementRows = new Set([...caps.by_pattern.keys()].map((k) => k.toLowerCase()));
  const hasServiceRow = (c: string): boolean =>
    (caps.by_container.has(c) && c !== SEED_KEY) || actions.has(c);

  const ruleFor = (a: Acc, observedRoute: string): HoldingRule => {
    const action = actions.get(a.container) ?? observedRoute;
    if (!policyRead) {
      return { kind: 'not_read', container: a.container, action: observedRoute, text: 'rule not read (engine files unavailable)' };
    }
    if (a.hash && statementRows.has(a.hash.toLowerCase())) {
      return { kind: 'statement_row', container: a.container, action, text: `the statement row for ${a.hash} in ${a.container} (${action})` };
    }
    if (hasServiceRow(a.container)) {
      return { kind: 'service_row', container: a.container, action, text: `the ${a.container} row (${action})` };
    }
    return { kind: 'fleet_default', container: a.container, action: observedRoute, text: `the fleet default, since ${a.container} has no row (${observedRoute})` };
  };

  const statements: NewStatement[] = [];
  const keptMaxByContainer = new Map<string, number>();
  let fleetKeptMax = 0;
  for (const [key, a] of byKey) {
    const linesADay = a.total / windowDays;
    if (seenBefore.has(key)) {
      if (a.held === 0) {
        keptMaxByContainer.set(a.container, Math.max(keptMaxByContainer.get(a.container) ?? 0, linesADay));
        fleetKeptMax = Math.max(fleetKeptMax, linesADay);
      }
      continue;
    }
    const heldRoutes = [...a.routes.entries()].filter(([r]) => HELD_ROUTES.has(r)).sort((x, y) => y[1] - x[1]);
    const held = a.held > 0;
    statements.push({
      pattern: a.pattern || a.hash,
      pattern_hash: a.hash,
      container: a.container,
      service: [...a.services].sort().join(', ') || a.container,
      team: a.teams.size > 0 ? [...a.teams].sort().join(', ') : null,
      routes: [...a.routes.keys()].sort(),
      first_seen_iso: a.first !== null ? isoMinute(a.first) : null,
      lines_a_day: linesADay,
      held_lines_a_day: a.held / windowDays,
      standard_usd_month: standardUsdMonth(linesADay, pricing),
      held,
      rule: held ? ruleFor(a, heldRoutes[0][0]) : null,
    });
  }
  statements.sort((x, y) => y.standard_usd_month - x.standard_usd_month || x.pattern.localeCompare(y.pattern));

  const proposed: ProposedRow[] = [];
  const withoutProposal: string[] = [];
  const unheldByContainer = new Map<string, NewStatement[]>();
  for (const st of statements) {
    if (st.held) continue;
    if (policyRead && hasServiceRow(st.container)) continue;
    const list = unheldByContainer.get(st.container) ?? [];
    list.push(st);
    unheldByContainer.set(st.container, list);
  }
  for (const [container, list] of [...unheldByContainer.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const own = keptMaxByContainer.get(container);
    const basis: 'service' | 'fleet' = own !== undefined ? 'service' : 'fleet';
    const limit = own !== undefined ? own : fleetDefaultLimit(fleetKeptMax, input.headroom);
    if (!(limit > 0)) {
      withoutProposal.push(container);
      continue;
    }
    const limitShown = Math.round(limit);
    const moved = list.filter((s) => Math.round(s.lines_a_day) > limitShown);
    if (moved.length === 0) {
      withoutProposal.push(container);
      continue;
    }
    const usd = moved.reduce((t, s) => t + s.standard_usd_month, 0);
    proposed.push({
      container,
      lines_a_day_limit: limitShown,
      basis,
      action: input.action,
      statements: moved.map((s) => ({
        pattern: s.pattern,
        pattern_hash: s.pattern_hash,
        lines_a_day: s.lines_a_day,
        standard_usd_month: s.standard_usd_month,
      })),
      standard_usd_month: usd,
      sentence: serviceLimitSentence(
        {
          service: container,
          action: input.action,
          limitLinesPerDay: limitShown,
          movedStatements: moved.length,
          movedUsdMonthly: usd,
        },
        'datadog',
      ),
    });
  }

  const shown = statements.slice(0, input.limit);
  const caveats: string[] = [
    'Lines a day are averages over the days the report covers.',
    'The Datadog output publishes the tag sets with the most bytes (200 as shipped), so a statement outside that set appears here once it enters it.',
  ];
  if (!teamTag) caveats.push('The series carry no team tag, so statements are grouped by service only.');
  if (!policyRead) {
    caveats.push(
      'The engine files (caps.csv, actions.csv) were not read: no gitops repo or policy ConfigMap answered. Held statements show the route only, and every service with a new statement that was not held gets a proposed row.',
    );
  }
  const proposedServiceBasis = proposed.some((p) => p.basis === 'service');
  const proposedFleetBasis = proposed.some((p) => p.basis === 'fleet');
  if (proposedServiceBasis) {
    caveats.push('A proposed row\'s limit is the largest statement that service kept at Standard over those days, the same rule the plan uses.');
  }
  if (proposedFleetBasis) {
    caveats.push(
      `For a service with no earlier statements, the limit is the largest statement the fleet kept at Standard, times ${input.headroom}.`,
    );
  }

  return {
    since_iso: isoMinute(input.sinceSec),
    until_iso: isoMinute(input.nowSec),
    next_since: isoMinute(input.nowSec),
    window_days: windowDays,
    team_tag: teamTag,
    statements: shown,
    statement_count_total: statements.length,
    held_count: statements.filter((s) => s.held).length,
    standard_usd_month_total: statements.reduce((t, s) => t + s.standard_usd_month, 0),
    proposed_rows: proposed,
    services_without_proposal: withoutProposal,
    policy_source: input.policy.source,
    pricing: {
      standard_usd_per_million_events: pricing.standard_index_usd_per_million_events,
      text:
        `Standard cost is estimated at ${fmtListRate(pricing.standard_index_usd_per_million_events)} per million events indexed ` +
        `(${pricing.standard_index_retention_days}-day retention), ${pricing.source}.`,
    },
    caveats,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────

function heldText(st: NewStatement): string {
  if (!st.held || !st.rule) return 'Not held.';
  const route = st.routes.find((r) => HELD_ROUTES.has(r)) ?? st.rule.action;
  return `Held: ${fmtLinesADay(st.held_lines_a_day)} lines a day to ${routeWord(route)} by ${st.rule.text}.`;
}

export function reportHeadline(r: ChangeReport): string {
  const since = r.since_iso.slice(0, 10);
  if (r.statement_count_total === 0) return `No new statements since ${since}.`;
  const n = r.statement_count_total;
  const rows = r.proposed_rows.length;
  return (
    `${n} statement${n === 1 ? '' : 's'} new since ${since}, about ${fmtUsdMonth(r.standard_usd_month_total)} a month at Standard; ` +
    `${r.held_count} held by a rule, ${rows} proposed row${rows === 1 ? '' : 's'}.`
  );
}

export function renderChangeReportMarkdown(r: ChangeReport, opts: { tenxEnv?: string } = {}): string {
  const out: string[] = [];
  out.push(`## Datadog change report since ${r.since_iso.slice(0, 10)}`);
  out.push('');
  const scope = opts.tenxEnv ? ` in ${opts.tenxEnv}` : '';
  out.push(`From ${r.since_iso} to ${r.until_iso}${scope}. ${reportHeadline(r)}`);
  out.push('');
  if (r.statements.length > 0) {
    r.statements.forEach((st, i) => {
      const where = st.service && st.service !== st.container ? `${st.container} (service ${st.service})` : st.container;
      const team = st.team ? `, team ${st.team}` : '';
      out.push(`${i + 1}. **${st.pattern}** in ${where}${team}`);
      out.push(
        `   ${fmtLinesADay(st.lines_a_day)} lines a day, about ${fmtUsdMonth(st.standard_usd_month)} a month at Standard. ${heldText(st)}`,
      );
    });
    if (r.statement_count_total > r.statements.length) {
      out.push('');
      out.push(
        `The ${r.statements.length} with the highest Standard cost are listed; ${r.statement_count_total - r.statements.length} more new statements are not.`,
      );
    }
    out.push('');
  }
  out.push('### Proposed rows');
  out.push('');
  if (r.proposed_rows.length === 0) {
    out.push('None. Every new statement was held by a rule or sits below its service\'s largest kept statement.');
  } else {
    for (const p of r.proposed_rows) {
      out.push(`- ${p.sentence}`);
      for (const s of p.statements) {
        out.push(`  - ${s.pattern} (${fmtLinesADay(s.lines_a_day)} lines a day, about ${fmtUsdMonth(s.standard_usd_month)} a month)`);
      }
    }
  }
  out.push('');
  out.push(r.pricing.text);
  for (const c of r.caveats) out.push(c);
  out.push('');
  out.push(`Engine files: ${r.policy_source ?? 'not read'}.`);
  out.push(`Next report: since=${r.next_since}.`);
  return out.join('\n');
}

export function renderMonitorsMarkdown(m: SpikeMonitors): string {
  const out: string[] = [];
  out.push('## Datadog monitors for log10x statements');
  out.push('');
  out.push(
    `Two monitor definitions on ${DD_VOLUME_METRIC}, grouped by ${m.group_by.join(', ')}. ` +
      'Apply each with the account\'s own tooling: POST it to /api/v1/monitor, import it as JSON on the Monitors page, or wrap it in a Terraform datadog_monitor resource. ' +
      'This tool writes nothing to Datadog.',
  );
  out.push('');
  out.push('### A statement turned tier_down or offload');
  out.push('');
  out.push('```json');
  out.push(JSON.stringify(m.route, null, 2));
  out.push('```');
  out.push('');
  out.push('### A statement above its weekly baseline');
  out.push('');
  out.push('```json');
  out.push(JSON.stringify(m.volume, null, 2));
  out.push('```');
  out.push('');
  out.push('The weekly baseline is a Datadog anomaly monitor with weekly seasonality, which needs three weeks of data before it alerts.');
  out.push(`Docs: ${m.docs.join(', ')}`);
  return out.join('\n');
}

// ── Execution ────────────────────────────────────────────────────────────

export function parseSince(since: string, nowSec: number): number | null {
  const rel = since.trim().match(/^(\d+)([dh])$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    return nowSec - n * (rel[2] === 'd' ? 86400 : 3600);
  }
  const ms = Date.parse(since.trim());
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function inputError(hint: string): ChassisEnvelope {
  return buildChassisErrorEnvelope({
    tool: TOOL,
    err: { error_type: 'input_invalid', retryable: false, suggested_backoff_ms: null, hint },
  });
}

export async function executeDatadogChangeReport(
  args: DatadogChangeReportArgs,
  env?: EnvConfig,
  deps: ChangeReportDeps = {},
): Promise<ChassisEnvelope> {
  const strict = validateStrictArgs<DatadogChangeReportArgs>(TOOL, datadogChangeReportSchema, args);
  if (strict.error) return strict.error;

  const view = args.view ?? 'markdown';
  const teamArg = args.team_tag !== undefined ? normalizeTagKey(args.team_tag) : undefined;
  if (args.team_tag !== undefined && !teamArg) return inputError(`team_tag "${args.team_tag}" is not a Datadog tag key.`);

  if (view === 'monitors') {
    const monitors = buildSpikeMonitors({ tenxEnv: args.tenx_env, teamTag: teamArg, notify: args.notify });
    const markdown = renderMonitorsMarkdown(monitors);
    const headline = `Two Datadog monitors on ${DD_VOLUME_METRIC}: a statement turning tier_down or offload, and a statement above its weekly baseline.`;
    return buildChassisEnvelope({
      tool: TOOL,
      view: 'markdown',
      headline,
      status: 'success',
      decisions: { threshold_used: null, threshold_basis: 'default' },
      source_disclosure: { siem_vendor: 'datadog' },
      scope: { window: 'n/a', window_basis: 'auto_default' },
      payload: { monitors: [monitors.route, monitors.volume], group_by: monitors.group_by, docs: monitors.docs, markdown },
      human_summary:
        `${headline} Each is JSON for the account owner to apply with their own tooling; this tool writes nothing to Datadog.`,
      must_render_verbatim: markdown,
    });
  }

  const now = Math.floor((deps.nowMs ? deps.nowMs() : Date.now()) / 1000);
  const sinceSec = parseSince(args.since ?? '7d', now);
  if (sinceSec === null) return inputError(`since "${args.since}" is neither a duration like 7d nor a date.`);
  if (sinceSec >= now) return inputError(`since "${args.since}" is not in the past.`);
  const lookbackDays = parseInt((args.lookback ?? '28d').replace(/d$/, ''), 10);
  if (!(lookbackDays >= 1 && lookbackDays <= 90)) return inputError('lookback must be between 1d and 90d.');

  const creds = deps.creds === undefined ? datadogMetricsCredsFromEnv(args.site) : deps.creds ?? undefined;
  if (!creds) {
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: 'config_missing',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'Set DD_API_KEY and DD_APP_KEY (and DD_SITE when the org is not on datadoghq.com) to read the per-pattern series. The keys need read access to metrics only.',
      },
      source_disclosure: { siem_vendor: 'datadog' },
      actions: [
        {
          tool: TOOL,
          args: { view: 'monitors', ...(args.tenx_env ? { tenx_env: args.tenx_env } : {}) },
          reason: 'the monitor definitions need no keys',
        },
      ],
    });
  }

  const telemetry = newChassisTelemetry();
  let teamTag: string | null = teamArg ?? null;
  const warnings: string[] = [];
  if (!teamTag) {
    try {
      const keys = await ddMetricTagKeys(creds, DD_VOLUME_METRIC, QUERY_BUDGET.cheap);
      recordQuery(telemetry);
      if (keys.has(DD_TAGS.team)) teamTag = DD_TAGS.team;
    } catch {
      recordQuery(telemetry);
      warnings.push('Tag list for the volume series was not readable; the report is grouped without a team.');
    }
  }

  const envFilter = args.tenx_env ? `${DD_TAGS.env}:${args.tenx_env}` : undefined;
  const scope = ddScope([envFilter]);
  const currentGroup = [DD_TAGS.pattern, DD_TAGS.hash, DD_TAGS.container, DD_TAGS.service, DD_TAGS.route, ...(teamTag ? [teamTag] : [])];
  const priorGroup = [DD_TAGS.pattern, DD_TAGS.hash, DD_TAGS.container];
  const currentQuery = `sum:${DD_VOLUME_METRIC}{${scope}} by {${currentGroup.join(',')}}.as_count()`;
  const priorQuery = `sum:${DD_VOLUME_METRIC}{${scope}} by {${priorGroup.join(',')}}.as_count()`;
  const priorFrom = sinceSec - lookbackDays * 86400;

  let current: DdSeries[];
  let prior: DdSeries[];
  try {
    [current, prior] = await Promise.all([
      ddQueryWindow(creds, currentQuery, sinceSec, now, QUERY_BUDGET.heavy),
      ddQueryWindow(creds, priorQuery, priorFrom, sinceSec, QUERY_BUDGET.heavy),
    ]);
    recordQuery(telemetry);
    recordQuery(telemetry);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: /HTTP 40[13]/.test(msg) ? 'config_missing' : 'backend_error',
        retryable: !/HTTP 4\d\d/.test(msg),
        suggested_backoff_ms: /HTTP 4\d\d/.test(msg) ? null : 5000,
        hint: `Datadog metrics query failed at ${creds.site}: ${msg.slice(0, 240)}`,
      },
      telemetry,
      source_disclosure: { siem_vendor: 'datadog' },
    });
  }

  const readPolicy = deps.readPolicy ?? readPolicyFilesDefault;
  const policy = await readPolicy(env).catch((): PolicyFiles => ({ source: null }));

  const report = buildChangeReport({
    current,
    prior,
    sinceSec,
    nowSec: now,
    teamTag,
    policy,
    action: args.action ?? 'tier_down',
    headroom: args.headroom ?? FLEET_DEFAULT_HEADROOM,
    limit: args.limit ?? 25,
  });

  const headline = reportHeadline(report);
  const markdown = renderChangeReportMarkdown(report, { tenxEnv: args.tenx_env });
  const rowsText = report.proposed_rows.map((p) => p.sentence).join(' ');
  const humanSummary =
    `${headline}${rowsText ? ` Proposed: ${rowsText}` : ''} ` +
    `Next report: since=${report.next_since}.`;
  const noSignal = current.length === 0;
  const payload = {
    ...report,
    site: creds.site,
    queries: { current: currentQuery, prior: priorQuery },
  };

  return buildChassisEnvelope({
    tool: TOOL,
    view: view === 'markdown' ? 'markdown' : 'summary',
    headline: noSignal ? `No per-pattern series for ${DD_VOLUME_METRIC} at ${creds.site} since ${report.since_iso.slice(0, 10)}.` : headline,
    status: noSignal ? 'no_signal' : 'success',
    decisions: {
      threshold_used: args.headroom ?? FLEET_DEFAULT_HEADROOM,
      threshold_basis: args.headroom !== undefined ? 'customer_supplied' : 'default',
      threshold_audit: { value: args.headroom ?? FLEET_DEFAULT_HEADROOM, basis: 'headroom on the fleet\'s largest kept statement, for a service with no history' },
    },
    source_disclosure: {
      bytes_source: 'siem_direct',
      rate_source: 'list_price',
      siem_vendor: 'datadog',
      source_label: `Datadog ${creds.site}${args.tenx_env ? `, tenx_env ${args.tenx_env}` : ''}`,
      pattern_count_source: {
        kind: 'scoped_total',
        count: report.statement_count_total,
        denominator_meaning: `Statements with no line in their service in the ${lookbackDays} days before ${report.since_iso}`,
      },
    },
    scope: {
      window: `${report.since_iso}/${report.until_iso}`,
      window_basis: args.since !== undefined ? 'explicit' : 'auto_default',
      candidates_count: report.statement_count_total,
      candidates_usable: report.statements.length,
    },
    payload: view === 'markdown' ? { ...payload, markdown } : payload,
    human_summary: noSignal
      ? `No ${DD_VOLUME_METRIC} series at ${creds.site} since ${report.since_iso.slice(0, 10)}. Check that the engine's Datadog metric output posts to this site (DD_SITE on the Receiver) and that tenx_env matches.`
      : humanSummary,
    ...(view === 'markdown' ? { must_render_verbatim: markdown } : {}),
    telemetry,
    warnings,
    actions: [
      {
        tool: TOOL,
        args: {
          view: 'monitors',
          ...(args.tenx_env ? { tenx_env: args.tenx_env } : {}),
          ...(teamTag ? { team_tag: teamTag } : {}),
        },
        reason: 'the Datadog monitors that alert on these statements between reports',
      },
    ],
  });
}
