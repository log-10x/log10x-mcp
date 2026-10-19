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
import { fmtEventCount } from './cost.js';
import { FLEET_DEFAULT_HEADROOM, fleetDestination } from './fleet-default.js';
import type { DollarBudget } from './policy-loader.js';
import type { K8sApi } from './k8s-in-cluster.js';
import { DATADOG_FLEX_INDEX_NAME } from './offload-recipes.js';

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

/**
 * Every statement's events over the lookback, by hash, name, container and
 * level, as one point per series (`rollup(sum, <lookback>)`): Datadog caps a
 * series at 1,500 points (docs.datadoghq.com/dashboards/functions/rollup/),
 * and one point keeps the response as small as the group count allows.
 */
export function patternEventsQuery(envId: string | undefined, lookbackSec: number): string {
  return `sum:${DD_ALL_EVENTS_DISTRIBUTION}{${scope(envId)}} by {tenx_hash,message_pattern,k8s_container,severity_level}.rollup(sum, ${Math.max(3600, Math.round(lookbackSec))})`;
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
  /** The Receiver's emitted lines this month, hourly, by routestate. */
  routes: DdPointSeries[];
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
    // The Flex index the MCP creates for tier_down never bills as Standard.
    if (idx === DATADOG_FLEX_INDEX_NAME) continue;
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

  // The Receiver's own Standard lines through the same hour the usage
  // metric reached, so its lag and the Receiver's do not skew the split.
  const receiverStandardEvents = sumPoints(
    input.routes,
    start,
    dataThroughSec,
    (s) => !HELD_ROUTES.has((s.tags['routestate'] ?? '').toLowerCase()),
  );
  const outsideRaw = spent - receiverStandardEvents;
  const outside = Math.max(0, outsideRaw);
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
  const where = fleetDestination(b.default_action === 'offload' ? 'offload' : 'tier_down');
  lines.push(
    `Standard indexing this month: ${usd(spent)} of ${fmtAboutUsd(b.usd_monthly)} (${fmtEventCount(spent)} events through ${utcHour(dataThroughSec)}), ${Math.round(hoursLeft)} hours left.`,
  );
  if (outsideRaw < 0) {
    warnings.push(
      `The Receiver's own count of lines sent to Standard (${fmtEventCount(receiverStandardEvents)}) is above Datadog's usage count (${fmtEventCount(spent)}) through ${utcHour(dataThroughSec)}, so lines that do not pass the Receiver are taken as 0.`,
    );
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
    `Node counts ${input.instanceBasis === 'discovery' ? 'discovered on this run: the nodes where both a Receiver pod and the service run' : 'from nodes_by_container in policy.yaml'}; ${nodesTotal} Receiver${nodesTotal === 1 ? '' : 's'} share the \`*\` row. The division assumes a DaemonSet Receiver, one per node, each holding its node's share.`,
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
    lines,
    warnings,
  };
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
  routes: DdPointSeries[];
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
    q(creds, patternEventsQuery(envId, lookbackHours * HOUR), from, nowSec),
  ]);
  const patterns: PatternRate[] = pats.map((s) => ({
    container: s.tags['k8s_container'] ?? '',
    pattern: s.tags['tenx_hash'] ?? '',
    name: s.tags['message_pattern'] ?? '',
    severity: (s.tags['severity_level'] ?? '').toUpperCase(),
    eventsPerHour: sumPoints([s], from, nowSec) / Math.max(1, lookbackHours),
  }));
  return { usage, routes, patterns };
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

/**
 * Node counts from the cluster, for a DaemonSet Receiver: the Receiver's
 * nodes are those running a pod in its namespace whose env names the policy
 * ConfigMap (`K8S_CONFIGMAP`, written on every Receiver install); a service's
 * count is the distinct nodes running both it and a Receiver.
 */
export async function discoverInstances(
  k8s: K8sApi,
  namespace: string,
  configMap: string,
): Promise<{ instances: Record<string, number>; nodesTotal: number }> {
  const [receivers, all] = await Promise.all([k8s.listRunningPods(namespace), k8s.listRunningPods()]);
  const receiverNodes = new Set(
    receivers.filter((p) => p.nodeName && (p.policyConfigMaps ?? []).includes(configMap)).map((p) => p.nodeName as string),
  );
  if (receiverNodes.size === 0) {
    throw new Error(`no running pod in ${namespace} names the ConfigMap ${configMap} in K8S_CONFIGMAP, so no Receiver was found to divide the limits by.`);
  }
  const onReceiverNodes = all.filter((p) => p.nodeName && receiverNodes.has(p.nodeName));
  return { instances: nodesPerContainerFromPods(onReceiverNodes), nodesTotal: receiverNodes.size };
}
