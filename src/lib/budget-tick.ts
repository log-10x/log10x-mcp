/**
 * The budget run: one tick of a Datadog Standard indexing budget held month
 * to date (handoff 4b.2, rulings 10 to 15).
 *
 * Each run:
 *   1. reads what Standard indexing counted this month for the whole account
 *      (`datadog.estimated_usage.logs.ingested_events`, indexed events only,
 *      by index) and what the Receiver itself sent to Standard (its
 *      `routeState` series), so lines outside the Receiver are known;
 *   2. sets the Receiver's rate for the rest of the month to
 *      (X - spent - what lines outside the Receiver will add) / hours left;
 *   3. reads every statement's events an hour from the Receiver's series and
 *      gives the services that rate, noisiest statements held first;
 *   4. divides each service's limit and total by the nodes its pods run on
 *      (discovered on this run, or `nodes_by_container` in policy.yaml);
 *   5. writes caps.csv, actions.csv and totals.csv (a `*` row for every
 *      service without a row of its own, from what is left of X) and
 *      config-generation.csv, to the policy ConfigMap or the gitops repo.
 *
 * Units are events: Datadog bills Standard per event, and the Receiver is
 * installed with `rateReceiverUnit events` (engine 1.1.146).
 *
 * A failed read changes nothing: the files from the last run stay in force,
 * and the run says so and exits non-zero.
 */

import { nodesPerContainerFromPods } from './enforcing-instances.js';
import { computeGeneration, renderGenerationCsv } from './config-generation.js';
import { HELD_ROUTES, datadogMetricsCredsFromEnv, ddQueryPoints, type DatadogMetricsCreds, type DdPointSeries } from './datadog-metrics-read.js';
import { ALWAYS_PASS_LINES, REGULATOR_WINDOW_SECONDS, fmtAboutUsd } from './report/user-units.js';
import { DATADOG_FLEX_LIST_PRICING, fmtEventCount, fmtListRate } from './cost.js';
import { FLEET_DEFAULT_HEADROOM, fleetDestination } from './fleet-default.js';
import type { DollarBudget } from './policy-loader.js';
import type { K8sApi } from './k8s-in-cluster.js';

const HOUR = 3600;

/** Indexed events by service and index, hourly (the series the spike audit reads). */
export const STANDARD_USAGE_QUERY =
  'sum:datadog.estimated_usage.logs.ingested_events{datadog_is_excluded:false} by {service,datadog_index}.as_count().rollup(sum, 3600)';

/**
 * Engine 1.1.146 posts its counters as distributions under `log10x.`
 * (config `pipelines/run/output/metric/datadog/config.yaml`, metricPrefix).
 */
export const DD_ALL_EVENTS_DISTRIBUTION = 'log10x.all_events_summaryVolume';
export const DD_EMITTED_EVENTS_DISTRIBUTION = 'log10x.emitted_events_summaryVolume';

function scope(envId: string | undefined): string {
  return envId ? `tenx_env:${envId}` : '*';
}

/** Every statement's events, hourly, by hash, container and level. */
export function patternEventsQuery(envId?: string): string {
  return `sum:${DD_ALL_EVENTS_DISTRIBUTION}{${scope(envId)}} by {tenx_hash,message_pattern,k8s_container,severity_level}.rollup(sum, 3600)`;
}

/** Lines the Receiver emitted, hourly, by where each went. */
export function receiverRouteQuery(envId?: string): string {
  return `sum:${DD_EMITTED_EVENTS_DISTRIBUTION}{${scope(envId)}} by {routestate}.rollup(sum, 3600)`;
}

export type BudgetAction = 'tier_down' | 'offload' | 'pass';

export interface PatternRate {
  container: string;
  pattern: string;
  /** The statement's name (message_pattern), the mute file's key. */
  name?: string;
  severity: string;
  eventsPerHour: number;
}

export interface BudgetInput {
  budget: DollarBudget;
  nowSec: number;
  /** Indexed events this month, by service and datadog_index. */
  usage: DdPointSeries[];
  /** Events the Receiver sent to Standard this month (route not tier_down or offload). */
  receiverStandardEvents: number;
  /** Every statement's events an hour over the lookback. */
  patterns: PatternRate[];
  /** Nodes each container's pods run on. */
  instances: Record<string, number>;
  /** Receivers in the fleet, for the `*` row. */
  nodesTotal: number;
  /** Where the node counts came from, stated in the report. */
  instanceBasis: 'discovery' | 'policy';
  exceptions: string[];
  targetServices: string[];
  /**
   * Statements a manual mute protects (sample rate 1): they always pass and
   * count toward their service's total, so the other lines give way first.
   */
  protectedPatterns?: ReadonlySet<string>;
  /** Lines the Receiver moved off Standard this month, by route. */
  movedEvents?: { tier_down: number; offload: number };
}

export interface ServiceRow {
  container: string;
  action: BudgetAction;
  instances: number;
  /** Fleet events an hour the service sends now. */
  eventsPerHour: number;
  /** Fleet events an hour Standard keeps from it under this run. */
  allowancePerHour: number;
  /** Per-statement limit, events per window per node; 0 exempts the service. */
  cap: number;
  /** Service total, events per window per node. */
  total: number;
  /** Fleet events an hour from statements a mute protects. */
  protectedPerHour: number;
}

export interface BudgetPlan {
  monthStartSec: number;
  monthEndSec: number;
  /** End of the last hour Datadog's usage metric returned. */
  dataThroughSec: number;
  hoursLeft: number;
  budgetEvents: number;
  spentEvents: number;
  spentUsd: number;
  outsideEvents: number;
  outsideProjectedMonthEvents: number;
  /** Fleet events an hour left for the Receiver's budgeted services. */
  receiverAllowancePerHour: number;
  /** Fleet events an hour each statement keeps when the budget binds; undefined under it. */
  statementLevelPerHour?: number;
  exhausted: boolean;
  overBudget: boolean;
  rows: ServiceRow[];
  star: { action: BudgetAction; instances: number; cap: number; total: number; allowancePerHour: number };
  /** The one line: Standard held at X, and what moved this month priced where it went. */
  heldLine: string;
  lines: string[];
  warnings: string[];
}

function monthBounds(nowSec: number): { start: number; end: number } {
  const d = new Date(nowSec * 1000);
  return {
    start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000,
    end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000,
  };
}

/** A fleet rate (events an hour) as events per regulator window per node, at least 1. */
export function perWindowPerNode(eventsPerHour: number, instances: number): number {
  const v = (eventsPerHour * REGULATOR_WINDOW_SECONDS) / HOUR / Math.max(1, instances);
  return Math.max(1, Math.floor(v));
}

/**
 * The level L at which sum(min(rate, L)) equals the allowance: the noisiest
 * statements are held at L, every smaller one keeps all its lines.
 */
export function waterLevel(rates: number[], allowance: number): number {
  const sorted = rates.filter((r) => r > 0).sort((a, b) => a - b);
  let below = 0;
  for (let i = 0; i < sorted.length; i++) {
    const rest = sorted.length - i;
    const level = (allowance - below) / rest;
    if (level <= sorted[i]) return Math.max(0, level);
    below += sorted[i];
  }
  return sorted.length ? sorted[sorted.length - 1] : 0;
}

function utcHour(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 13).replace('T', ' ') + ':00 UTC';
}

/**
 * A service the run leaves alone: a cap row of 0, which exempts the container
 * from every limit even with a `*` row (config `rate-object-cap.js`, the
 * container's own row first), and `pass` as its action. Its total is written
 * above its rate so no reader of the totals file holds it either.
 */
function leftAlone(container: string, instances: number, eventsPerHour: number): ServiceRow {
  return {
    container,
    action: 'pass',
    instances,
    eventsPerHour,
    allowancePerHour: eventsPerHour,
    protectedPerHour: 0,
    cap: 0,
    total: perWindowPerNode(eventsPerHour * FLEET_DEFAULT_HEADROOM, instances),
  };
}

export function planBudget(input: BudgetInput): BudgetPlan {
  const b = input.budget;
  const { start, end } = monthBounds(input.nowSec);
  const perEventUsd = b.standard_usd_per_million / 1e6;
  const budgetEvents = b.usd_monthly / perEventUsd;
  const warnings: string[] = [];
  const lines: string[] = [];

  const standard = new Set(b.standard_indexes);
  let spent = 0;
  let lastPoint = -1;
  for (const s of input.usage) {
    const idx = s.tags['datadog_index'] ?? '';
    if (standard.size > 0 && !standard.has(idx)) continue;
    for (const [ts, v] of s.points) {
      if (ts < start || ts >= end) continue;
      spent += v;
      if (ts > lastPoint) lastPoint = ts;
    }
  }
  const dataThroughSec = Math.min(input.nowSec, lastPoint >= 0 ? lastPoint + HOUR : start);
  const hoursLeft = Math.max(1 / 60, (end - dataThroughSec) / HOUR);
  const elapsedHours = Math.max(1, (dataThroughSec - start) / HOUR);

  const outside = Math.max(0, spent - input.receiverStandardEvents);
  const outsidePerHour = outside / elapsedHours;
  const outsideProjectedMonth = outside + outsidePerHour * hoursLeft;
  const remaining = budgetEvents - spent - outsidePerHour * hoursLeft;
  const exhausted = remaining <= 0;
  const allowance = exhausted ? 0 : remaining / hoursLeft;

  const exempt = new Set(input.exceptions);
  const inScope = (c: string): boolean =>
    !exempt.has(c) && (input.targetServices.length === 0 || input.targetServices.includes(c));

  const byContainer = new Map<string, PatternRate[]>();
  for (const p of input.patterns) {
    if (!p.container || !(p.eventsPerHour > 0)) continue;
    const list = byContainer.get(p.container) ?? [];
    list.push(p);
    byContainer.set(p.container, list);
  }

  let exemptPerHour = 0;
  let budgetedPerHour = 0;
  const budgetedRates: number[] = [];
  for (const [c, ps] of byContainer) {
    const sum = ps.reduce((a, p) => a + p.eventsPerHour, 0);
    if (inScope(c)) {
      budgetedPerHour += sum;
      for (const p of ps) budgetedRates.push(p.eventsPerHour);
    } else {
      exemptPerHour += sum;
    }
  }
  const forBudgeted = Math.max(0, allowance - exemptPerHour);
  const overBudget = !exhausted && budgetedPerHour > forBudgeted;
  const level = exhausted ? 0 : overBudget ? waterLevel(budgetedRates, forBudgeted) : undefined;
  const headroom = budgetedPerHour > 0 ? Math.min(FLEET_DEFAULT_HEADROOM, forBudgeted / budgetedPerHour) : FLEET_DEFAULT_HEADROOM;

  const rows: ServiceRow[] = [];
  let kept = 0;
  for (const c of [...byContainer.keys()].sort()) {
    const ps = byContainer.get(c)!;
    const n = Math.max(1, input.instances[c] ?? 1);
    const rate = ps.reduce((a, p) => a + p.eventsPerHour, 0);
    const largest = Math.max(...ps.map((p) => p.eventsPerHour));
    if (!inScope(c)) {
      rows.push(leftAlone(c, n, rate));
      continue;
    }
    const action: BudgetAction = b.service_actions[c] ?? b.default_action;
    let allowancePerHour: number;
    let capPerHour: number;
    if (level !== undefined) {
      allowancePerHour = ps.reduce((a, p) => a + Math.min(p.eventsPerHour, level), 0);
      capPerHour = level;
    } else {
      allowancePerHour = rate * headroom;
      capPerHour = largest * headroom;
    }
    kept += allowancePerHour;
    const protectedPerHour = ps.reduce((a, p) => a + (p.name && input.protectedPatterns?.has(p.name) ? p.eventsPerHour : 0), 0);
    rows.push({ container: c, action, instances: n, eventsPerHour: rate, allowancePerHour, protectedPerHour, cap: perWindowPerNode(capPerHour, n), total: perWindowPerNode(allowancePerHour, n) });
  }
  // A service named in exceptions gets its own row even when it sent nothing
  // in the lookback, so the `*` row never holds it.
  for (const c of input.exceptions) {
    if (!byContainer.has(c)) rows.push(leftAlone(c, Math.max(1, input.instances[c] ?? 1), 0));
  }
  rows.sort((a, b) => a.container.localeCompare(b.container));
  const starPerHour = Math.max(0, forBudgeted - kept);
  const nodesTotal = Math.max(1, input.nodesTotal);
  const star = {
    action: b.default_action as BudgetAction,
    instances: nodesTotal,
    cap: perWindowPerNode(starPerHour, nodesTotal),
    total: perWindowPerNode(starPerHour, nodesTotal),
    allowancePerHour: starPerHour,
  };

  const usd = (events: number): string => fmtAboutUsd(events * perEventUsd);
  const heldLine = ceilingReportLine({
    budgetUsd: b.usd_monthly,
    spentUsd: spent * perEventUsd,
    standardUsdPerMillion: b.standard_usd_per_million,
    flexEvents: input.movedEvents?.tier_down ?? 0,
    s3Events: input.movedEvents?.offload ?? 0,
  });
  const where = fleetDestination(b.default_action === 'offload' ? 'offload' : 'tier_down');
  lines.push(
    `Standard indexing this month: ${usd(spent)} of ${fmtAboutUsd(b.usd_monthly)} (${fmtEventCount(spent)} events through ${utcHour(dataThroughSec)}), ${Math.round(hoursLeft)} hours left.`,
  );
  if (standard.size === 0) {
    warnings.push('No standard_indexes in policy.yaml, so every index counts toward the budget. Name the Standard indexes if the account has a Flex-only index.');
  }
  lines.push(
    `Lines that do not pass the Receiver: ${fmtEventCount(outside)} events in Standard this month, about ${usd(outsideProjectedMonth)} by the month's end at this rate. The Receiver's services get the rest.`,
  );
  if (outsideProjectedMonth >= 0.8 * budgetEvents) {
    warnings.push(
      `Lines that do not pass the Receiver alone reach ${usd(outsideProjectedMonth)} of the ${fmtAboutUsd(b.usd_monthly)} budget by the month's end; the Receiver cannot hold those.`,
    );
  }
  if (exhausted) {
    lines.push(
      `Standard has reached ${fmtAboutUsd(b.usd_monthly)} for this month. Until the month ends, every line past its ${ALWAYS_PASS_LINES}-line sample moves to ${where}, except up to ${b.keep_count} error lines per statement per node per window.`,
    );
  } else if (overBudget) {
    lines.push(
      `The Receiver's services may send ${fmtEventCount(forBudgeted)} events an hour to Standard against ${fmtEventCount(budgetedPerHour)} now: each statement keeps up to ${fmtEventCount(level ?? 0)} an hour, and the noisiest move to ${where} first.`,
    );
  } else {
    lines.push(
      `The Receiver's services send ${fmtEventCount(budgetedPerHour)} events an hour, under the ${fmtEventCount(forBudgeted)} the budget leaves: each keeps room to grow ${Number(headroom.toFixed(2))}x, and a service without a row gets the ${fmtEventCount(starPerHour)} an hour left over.`,
    );
  }
  lines.push(
    `Node counts ${input.instanceBasis === 'discovery' ? 'discovered on this run' : 'from nodes_by_container in policy.yaml'}; ${nodesTotal} Receiver${nodesTotal === 1 ? '' : 's'} share the \`*\` row.`,
  );
  for (const r of rows) {
    if (r.action !== 'pass' && r.protectedPerHour > r.allowancePerHour) {
      warnings.push(
        `In ${r.container}, statements a mute protects send ${fmtEventCount(r.protectedPerHour)} events an hour, above its total of ${fmtEventCount(r.allowancePerHour)}: they still pass, every other line in it moves, and Standard can run over by the difference.`,
      );
    }
  }
  for (const c of byContainer.keys()) {
    if (inScope(c) && input.instances[c] === undefined) {
      warnings.push(`No node count for ${c}: its limits are written for one Receiver.`);
    }
  }
  return {
    monthStartSec: start,
    monthEndSec: end,
    dataThroughSec,
    hoursLeft,
    budgetEvents,
    spentEvents: spent,
    spentUsd: spent * perEventUsd,
    outsideEvents: outside,
    outsideProjectedMonthEvents: outsideProjectedMonth,
    receiverAllowancePerHour: forBudgeted,
    ...(level !== undefined ? { statementLevelPerHour: level } : {}),
    exhausted,
    overBudget,
    rows,
    star,
    heldLine,
    lines,
    warnings,
  };
}

/**
 * Standard held at X, and what the Receiver moved off it this month, priced
 * where it went: Flex at the list storage rate (compute unpriced, left out),
 * S3 off the Datadog bill. Each also at the Standard rate it did not pay.
 */
export function ceilingReportLine(input: {
  budgetUsd: number;
  spentUsd: number;
  standardUsdPerMillion: number;
  flexEvents: number;
  s3Events: number;
}): string {
  const p = DATADOG_FLEX_LIST_PRICING;
  const std = (e: number): string => fmtAboutUsd((e / 1e6) * input.standardUsdPerMillion);
  const parts: string[] = [];
  if (input.flexEvents > 0) {
    parts.push(
      `${fmtEventCount(input.flexEvents)} events to Flex, about ${fmtAboutUsd((input.flexEvents / 1e6) * p.tier_storage_usd_per_million_events_month)} a month of Flex storage at ${fmtListRate(p.tier_storage_usd_per_million_events_month)} per million (Flex compute is unpriced and left out), ${std(input.flexEvents)} at the Standard rate`,
    );
  }
  if (input.s3Events > 0) {
    parts.push(`${fmtEventCount(input.s3Events)} events to S3, off the Datadog bill, ${std(input.s3Events)} at the Standard rate`);
  }
  const moved = parts.length > 0 ? `Moved this month: ${parts.join('; ')}.` : 'Nothing moved off Standard this month.';
  return `Standard held at ${fmtAboutUsd(input.budgetUsd)} a month: ${fmtAboutUsd(input.spentUsd)} so far this month. ${moved}`;
}

export interface BudgetFiles {
  'caps.csv': string;
  'actions.csv': string;
  'totals.csv': string;
  'config-generation.csv': string;
}

/** The four files the Receiver reads. Rows: `<container>,<value>::<reason>`; `*` last. */
export function renderBudgetFiles(plan: BudgetPlan): BudgetFiles {
  const reason = 'budget run';
  const caps = ['container,cap'];
  const actions = ['container,action'];
  const totals = ['container,total'];
  for (const r of plan.rows) {
    caps.push(`${r.container},${r.cap}::${reason}`);
    actions.push(`${r.container},${r.action}::${reason}`);
    totals.push(`${r.container},${r.total}::${reason}`);
  }
  caps.push(`*,${plan.star.cap}::${reason}`);
  actions.push(`*,${plan.star.action}::${reason}`);
  totals.push(`*,${plan.star.total}::${reason}`);
  const capsCsv = caps.join('\n') + '\n';
  return {
    'caps.csv': capsCsv,
    'actions.csv': actions.join('\n') + '\n',
    'totals.csv': totals.join('\n') + '\n',
    'config-generation.csv': renderGenerationCsv(computeGeneration(capsCsv)),
  };
}

export function renderBudgetReport(plan: BudgetPlan, budget: DollarBudget, nowSec: number, extra: string[] = []): string {
  const out = [
    `# Budget run: ${new Date(nowSec * 1000).toISOString()}`,
    '',
    plan.heldLine,
    '',
    ...plan.lines.map((l) => `- ${l}`),
    ...extra.map((l) => `- ${l}`),
    ...plan.warnings.map((w) => `- Warning: ${w}`),
    '',
    `| Service | Destination | Nodes | Events an hour now | Kept an hour | Limit per statement | Total |`,
    `|---|---|---|---|---|---|---|`,
    ...plan.rows.map(
      (r) =>
        `| ${r.container} | ${r.action === 'pass' ? 'left alone' : fleetDestination(r.action)} | ${r.instances} | ${fmtEventCount(r.eventsPerHour)} | ${fmtEventCount(r.allowancePerHour)} | ${r.cap} | ${r.total} |`,
    ),
    `| \`*\` (any other service) | ${fleetDestination(budget.default_action)} | ${plan.star.instances} | | ${fmtEventCount(plan.star.allowancePerHour)} | ${plan.star.cap} | ${plan.star.total} |`,
    '',
    `Limits and totals are events per ${REGULATOR_WINDOW_SECONDS / 60}-minute window per node. Error lines pass ${budget.keep_count} over a limit per statement per node per window.`,
    '',
  ];
  return out.join('\n');
}

// ─── reads ──────────────────────────────────────────────────────────────────

export type DdQuery = (creds: DatadogMetricsCreds, query: string, fromSec: number, toSec: number) => Promise<DdPointSeries[]>;

export interface BudgetReadDeps {
  creds?: DatadogMetricsCreds | null;
  query?: DdQuery;
}

function sumPoints(series: DdPointSeries[], fromSec: number, toSec: number, keep: (s: DdPointSeries) => boolean = () => true): number {
  let t = 0;
  for (const s of series) {
    if (!keep(s)) continue;
    for (const [ts, v] of s.points) if (ts >= fromSec && ts < toSec) t += v;
  }
  return t;
}

export interface BudgetReads {
  usage: DdPointSeries[];
  receiverStandardEvents: number;
  /** Lines the Receiver sent to Flex (tier_down) and S3 (offload) this month. */
  movedEvents: { tier_down: number; offload: number };
  patterns: PatternRate[];
}

/** The three Datadog reads. Throws on a missing key or a failed query: the caller keeps the last files. */
export async function readBudgetInputs(
  nowSec: number,
  lookbackHours: number,
  envId: string | undefined,
  deps: BudgetReadDeps = {},
): Promise<BudgetReads> {
  const creds = deps.creds === undefined ? datadogMetricsCredsFromEnv() : deps.creds ?? undefined;
  if (!creds) throw new Error('DD_API_KEY and DD_APP_KEY are not set; the run reads Datadog usage with them.');
  const q: DdQuery = deps.query ?? ((c, query, from, to) => ddQueryPoints(c, query, from, to));
  const { start } = monthBounds(nowSec);
  const from = nowSec - lookbackHours * HOUR;
  const [usage, routes, pats] = await Promise.all([
    q(creds, STANDARD_USAGE_QUERY, start, nowSec),
    q(creds, receiverRouteQuery(envId), start, nowSec),
    q(creds, patternEventsQuery(envId), from, nowSec),
  ]);
  const route = (s: DdPointSeries): string => (s.tags['routestate'] ?? '').toLowerCase();
  const receiverStandardEvents = sumPoints(routes, start, nowSec, (s) => !HELD_ROUTES.has(route(s)));
  const movedEvents = {
    tier_down: sumPoints(routes, start, nowSec, (s) => route(s) === 'tier_down'),
    offload: sumPoints(routes, start, nowSec, (s) => route(s) === 'offload'),
  };
  const patterns: PatternRate[] = pats.map((s) => ({
    container: s.tags['k8s_container'] ?? '',
    pattern: s.tags['tenx_hash'] ?? '',
    name: s.tags['message_pattern'] ?? '',
    severity: (s.tags['severity_level'] ?? '').toUpperCase(),
    eventsPerHour: sumPoints([s], from, nowSec) / Math.max(1, lookbackHours),
  }));
  return { usage, receiverStandardEvents, movedEvents, patterns };
}

/**
 * Statements a manual mute protects: rows of the mute file
 * (`<message_pattern>,<sampleRate>[:<untilEpoch>][:<reason>]`, header
 * `fieldSet,value`) with a sample rate of 1 that have not expired.
 */
export function protectedPatterns(mutesCsv: string | undefined, nowSec: number): Set<string> {
  const out = new Set<string>();
  for (const line of (mutesCsv ?? '').split(/\r?\n/).slice(1)) {
    const comma = line.indexOf(',');
    if (comma <= 0) continue;
    const [rate, until] = line.slice(comma + 1).split(':');
    const r = Number(rate);
    const u = until ? Number(until) : 0;
    if (Number.isFinite(r) && r >= 1 && !(u > 0 && u <= nowSec)) out.add(line.slice(0, comma));
  }
  return out;
}

/** Node counts from the cluster: nodes per container from running pods, and the node total. */
export async function discoverInstances(k8s: K8sApi): Promise<{ instances: Record<string, number>; nodesTotal: number }> {
  const [pods, nodes] = await Promise.all([k8s.listRunningPods(), k8s.countNodes()]);
  return { instances: nodesPerContainerFromPods(pods), nodesTotal: nodes };
}
