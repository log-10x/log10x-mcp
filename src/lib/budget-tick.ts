/**
 * The budget run: one run of a Datadog Standard indexing budget held month
 * to date. X is the whole account's Standard bill.
 *
 * Each run:
 *   1. reads what Standard indexing counted this month for the whole account
 *      (`datadog.estimated_usage.logs.ingested_events`, indexed events only,
 *      by index) and what the Receiver itself sent to Standard (its
 *      `routeState` series, by container), so lines outside the Receiver are
 *      known;
 *   2. holds each service with its own number (`service_budgets`) to that
 *      number, and sets the rate for the rest of the Receiver's services to
 *      (X - their numbers - spent - what lines outside the Receiver will
 *      add) / hours left;
 *   3. reads every statement's events an hour from the Receiver's series and
 *      gives each service its rate, noisiest statements held first;
 *   4. divides each service's limit and total by the nodes its pods run on
 *      (discovered on this run, or `nodes_by_container` in policy.yaml);
 *   5. writes caps.csv, actions.csv and totals.csv (a `*` row for every
 *      service without a row of its own) and config-generation.csv, to the
 *      policy ConfigMap or the gitops repo.
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
 * Every statement's events, hourly, by hash, name, container and level. A
 * series is at most 1,500 points (docs.datadoghq.com/dashboards/functions/
 * rollup/); a 24-hour lookback is 25. Hourly buckets, summed over the span
 * they cover: Datadog aligns a rollup bucket to its interval, so one bucket
 * the size of the lookback would start before the window and be lost.
 */
export function patternEventsQuery(envId?: string): string {
  return `sum:${DD_ALL_EVENTS_DISTRIBUTION}{${scope(envId)}} by {tenx_hash,message_pattern,k8s_container,severity_level}.rollup(sum, 3600)`;
}

/** Events an hour from a series of hourly buckets: their sum over the hours they span, whatever their alignment. */
export function hourlyRate(points: Array<[number, number]>): number {
  if (points.length === 0) return 0;
  let total = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const [ts, v] of points) {
    total += v;
    if (ts < first) first = ts;
    if (ts > last) last = ts;
  }
  return total / Math.max(1, (last + HOUR - first) / HOUR);
}

/** Lines the Receiver emitted, hourly, by where each went and by container. */
export function receiverRouteQuery(envId?: string): string {
  return `sum:${DD_EMITTED_EVENTS_DISTRIBUTION}{${scope(envId)}} by {routestate,k8s_container}.rollup(sum, 3600)`;
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
  /** A service with its own number: dollars a month, spent so far, and whether it is used up. */
  ownBudget?: { usdMonthly: number; spentUsd: number; exhausted: boolean; datadogService: string };
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

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Limits for a set of statements under an allowance (fleet events an hour):
 * over it, the noisiest are held at the water level; under it, each keeps
 * room to grow up to the fleet headroom.
 */
function holdStatements(rates: number[], allowance: number): { capPerHour: number; allowancePerHour: number } {
  const rate = rates.reduce((a, r) => a + r, 0);
  if (rate === 0) return { capPerHour: allowance, allowancePerHour: allowance };
  if (rate > allowance) {
    const level = waterLevel(rates, allowance);
    return { capPerHour: level, allowancePerHour: rates.reduce((a, r) => a + Math.min(r, level), 0) };
  }
  const headroom = Math.min(FLEET_DEFAULT_HEADROOM, allowance / rate);
  return { capPerHour: Math.max(...rates) * headroom, allowancePerHour: rate * headroom };
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
  const spentByService = new Map<string, number>();
  for (const s of input.usage) {
    const idx = s.tags['datadog_index'] ?? '';
    // The Flex index the MCP creates for tier_down never bills as Standard.
    if (idx === DATADOG_FLEX_INDEX_NAME) continue;
    if (standard.size > 0 && !standard.has(idx)) continue;
    const svc = s.tags['service'] ?? '';
    for (const [ts, v] of s.points) {
      if (ts < start || ts >= end) continue;
      spent += v;
      spentByService.set(svc, (spentByService.get(svc) ?? 0) + v);
      if (ts > lastPoint) lastPoint = ts;
    }
  }
  const dataThroughSec = Math.min(input.nowSec, lastPoint >= 0 ? lastPoint + HOUR : start);
  const hoursLeft = Math.max(1 / 60, (end - dataThroughSec) / HOUR);
  const elapsedHours = Math.max(1, (dataThroughSec - start) / HOUR);

  // The Receiver's own Standard lines through the same hour the usage
  // metric reached, so its lag and the Receiver's do not skew the split.
  const toStandard = (s: DdPointSeries): boolean => !HELD_ROUTES.has((s.tags['routestate'] ?? '').toLowerCase());
  const receiverStandardOf = (c: string): number =>
    sumPoints(input.routes, start, dataThroughSec, (s) => toStandard(s) && s.tags['k8s_container'] === c);

  const byContainer = new Map<string, PatternRate[]>();
  for (const p of input.patterns) {
    if (!p.container || !(p.eventsPerHour > 0)) continue;
    const list = byContainer.get(p.container) ?? [];
    list.push(p);
    byContainer.set(p.container, list);
  }
  const receiverSees = (c: string): boolean =>
    byContainer.has(c) || input.routes.some((s) => s.tags['k8s_container'] === c && s.points.length > 0);

  // A named service spends what Datadog's usage metric counts under its
  // service tag, its lines outside the Receiver included; with no series
  // under that name, the Receiver's own count. The rest of the account:
  // spent = account spent - named spent; outside = that - the Receiver's
  // Standard lines from containers without a number.
  const own = b.service_budgets ?? {};
  const named = Object.keys(own).sort();
  const namedSet = new Set(named);
  const ownSpent: Record<string, number> = {};
  const ownReceiver: Record<string, number> = {};
  const metered: Record<string, boolean> = {};
  for (const c of named) {
    ownReceiver[c] = receiverStandardOf(c);
    metered[c] = spentByService.has(own[c].datadog_service);
    ownSpent[c] = metered[c] ? spentByService.get(own[c].datadog_service)! : ownReceiver[c];
  }
  const namedUsd = named.reduce((a, c) => a + own[c].usd, 0);
  const poolUsd = b.usd_monthly - namedUsd;
  const poolEvents = poolUsd / perEventUsd;
  const poolSpent = Math.max(0, spent - named.reduce((a, c) => a + ownSpent[c], 0));
  const receiverStandardEvents =
    sumPoints(input.routes, start, dataThroughSec, toStandard) - named.reduce((a, c) => a + ownReceiver[c], 0);
  const outsideRaw = poolSpent - receiverStandardEvents;
  const outside = Math.max(0, outsideRaw);
  const outsidePerHour = outside / elapsedHours;
  const outsideProjectedMonth = outside + outsidePerHour * hoursLeft;
  const remaining = poolEvents - poolSpent - outsidePerHour * hoursLeft;
  const exhausted = remaining <= 0;
  const allowance = exhausted ? 0 : remaining / hoursLeft;

  const exempt = new Set(input.exceptions);
  const inScope = (c: string): boolean =>
    !exempt.has(c) && !namedSet.has(c) && (input.targetServices.length === 0 || input.targetServices.includes(c));

  let exemptPerHour = 0;
  let budgetedPerHour = 0;
  const budgetedRates: number[] = [];
  for (const [c, ps] of byContainer) {
    if (namedSet.has(c)) continue;
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
  const knownCaps: number[] = [];
  const knownTotals: number[] = [];
  const knownNodes: number[] = [];
  let kept = 0;
  const protectedIn = (ps: PatternRate[]): number =>
    ps.reduce((a, p) => a + (p.name && input.protectedPatterns?.has(p.name) ? p.eventsPerHour : 0), 0);
  for (const c of [...byContainer.keys()].sort()) {
    if (namedSet.has(c)) continue;
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
    knownCaps.push(capPerHour);
    knownTotals.push(allowancePerHour);
    if (input.instances[c] !== undefined) knownNodes.push(n);
    rows.push({ container: c, action, instances: n, eventsPerHour: rate, allowancePerHour, protectedPerHour: protectedIn(ps), cap: perWindowPerNode(capPerHour, n), total: perWindowPerNode(allowancePerHour, n) });
  }
  for (const c of named) {
    const ps = byContainer.get(c) ?? [];
    const n = Math.max(1, input.instances[c] ?? 1);
    const rates = ps.map((p) => p.eventsPerHour);
    const ownOutsidePerHour = Math.max(0, ownSpent[c] - ownReceiver[c]) / elapsedHours;
    const left = own[c].usd / perEventUsd - ownSpent[c] - ownOutsidePerHour * hoursLeft;
    const ownExhausted = left <= 0;
    const held = ownExhausted ? { capPerHour: 0, allowancePerHour: 0 } : holdStatements(rates, left / hoursLeft);
    rows.push({
      container: c,
      action: b.service_actions[c] ?? b.default_action,
      instances: n,
      eventsPerHour: rates.reduce((a, r) => a + r, 0),
      allowancePerHour: held.allowancePerHour,
      protectedPerHour: protectedIn(ps),
      cap: perWindowPerNode(held.capPerHour, n),
      total: perWindowPerNode(held.allowancePerHour, n),
      ownBudget: { usdMonthly: own[c].usd, spentUsd: ownSpent[c] * perEventUsd, exhausted: ownExhausted, datadogService: own[c].datadog_service },
    });
    const dd = own[c].datadog_service;
    const seen = receiverSees(c);
    if (!metered[c] && seen) {
      warnings.push(
        `Datadog's usage metric has no Standard series for service:${dd}, the name service_budgets gives the container ${c}. Its spend is taken from the Receiver's own count, which leaves out its lines outside the Receiver and the statements past the Receiver's top series, so it can run over its number. Set service_budgets.${c}.datadog_service to the service name Datadog uses.`,
      );
    } else if (!metered[c]) {
      warnings.push(
        `Neither Datadog's usage metric (service:${dd}) nor the Receiver (container ${c}) has any lines for ${c} this month. Check both names in service_budgets.${c}.`,
      );
    } else if (!seen) {
      warnings.push(
        `The Receiver does not see ${c}: no lines or statements under that container. Datadog counts ${fmtAboutUsd(ownSpent[c] * perEventUsd)} under service:${dd} this month, and its ${fmtAboutUsd(own[c].usd)} cannot be held.`,
      );
    }
    if (dd !== c && !namedSet.has(dd) && receiverSees(dd)) {
      warnings.push(
        `service_budgets.${c}.datadog_service is ${dd}, which is also a container the Receiver sees without its own number: Datadog's usage under service:${dd} is charged to ${c}, while the Receiver's lines from the container ${dd} count in the rest of the account.`,
      );
    }
  }
  // A service named in exceptions gets its own row even when it sent nothing
  // in the lookback, so the `*` row never holds it.
  for (const c of input.exceptions) {
    if (!byContainer.has(c)) rows.push(leftAlone(c, Math.max(1, input.instances[c] ?? 1), 0));
  }
  rows.sort((a, b) => a.container.localeCompare(b.container));

  // A service the run has not seen gets the level the known services get
  // and the median known service's total; under the budget, the larger of
  // that and what is left over. Once X is spent it gets 1 line.
  const leftover = Math.max(0, forBudgeted - kept);
  const medianCap = median(knownCaps);
  const medianTotal = median(knownTotals);
  let starCapPerHour = leftover;
  let starTotalPerHour = leftover;
  if (!exhausted && medianCap !== undefined && medianTotal !== undefined) {
    starCapPerHour = level !== undefined ? level : Math.max(leftover, medianCap);
    starTotalPerHour = level !== undefined ? medianTotal : Math.max(leftover, medianTotal);
  }
  // Divided like a known service: by the median known service's nodes.
  const nodesTotal = Math.max(1, input.nodesTotal);
  const medianNodes = median(knownNodes);
  const starNodes = medianNodes !== undefined ? Math.max(1, Math.round(medianNodes)) : nodesTotal;
  const star = {
    action: b.default_action as BudgetAction,
    instances: starNodes,
    cap: perWindowPerNode(starCapPerHour, starNodes),
    total: perWindowPerNode(starTotalPerHour, starNodes),
    allowancePerHour: starTotalPerHour,
  };

  const usd = (events: number): string => fmtAboutUsd(events * perEventUsd);
  const where = fleetDestination(b.default_action === 'offload' ? 'offload' : 'tier_down');
  const services = named.length > 0 ? "The Receiver's other services" : "The Receiver's services";
  lines.push(
    `Standard indexing this month: ${usd(spent)} of ${fmtAboutUsd(b.usd_monthly)} (${fmtEventCount(spent)} events through ${utcHour(dataThroughSec)}), ${Math.round(hoursLeft)} hours left.`,
  );
  if (outsideRaw < 0) {
    warnings.push(
      `The Receiver's own count of lines sent to Standard (${fmtEventCount(receiverStandardEvents)}) is above Datadog's usage count (${fmtEventCount(poolSpent)}) through ${utcHour(dataThroughSec)}, so lines that do not pass the Receiver are taken as 0.`,
    );
  }
  lines.push(
    `Lines that do not pass the Receiver${named.length > 0 ? ', outside the services with their own number' : ''}: ${fmtEventCount(outside)} events in Standard this month, about ${usd(outsideProjectedMonth)} by the month's end at this rate. ${services} get the rest${named.length > 0 ? ` of ${fmtAboutUsd(poolUsd)}` : ''}.`,
  );
  if (outsideProjectedMonth >= 0.8 * poolEvents) {
    warnings.push(
      `Lines that do not pass the Receiver alone reach ${usd(outsideProjectedMonth)} of the ${fmtAboutUsd(poolUsd)} ${named.length > 0 ? 'left for the rest of the account' : 'budget'} by the month's end; the Receiver cannot hold those.`,
    );
  }
  const sample = `every line past its ${ALWAYS_PASS_LINES}-line sample moves to ${where}, except up to ${b.keep_count} error lines per statement per node per window.`;
  if (exhausted) {
    lines.push(
      named.length > 0
        ? `The rest of the account has reached its ${fmtAboutUsd(poolUsd)} for this month. Until the month ends, in every service without its own number, ${sample}`
        : `Standard has reached ${fmtAboutUsd(b.usd_monthly)} for this month. Until the month ends, ${sample}`,
    );
  } else if (overBudget) {
    lines.push(
      `${services} may send ${fmtEventCount(forBudgeted)} events an hour to Standard against ${fmtEventCount(budgetedPerHour)} now: each statement keeps up to ${fmtEventCount(level ?? 0)} an hour, and the noisiest move to ${where} first. ` +
        (medianTotal !== undefined
          ? `A service the run has not seen gets the same level and the median service's ${fmtEventCount(starTotalPerHour)} an hour until the next run, which takes any overshoot back from the rest of the month.`
          : `A service the run has not seen gets the ${fmtEventCount(starTotalPerHour)} an hour left over.`),
    );
  } else {
    lines.push(
      `${services} send ${fmtEventCount(budgetedPerHour)} events an hour, under the ${fmtEventCount(forBudgeted)} the budget leaves, and each keeps room to grow ${Number(headroom.toFixed(2))}x. ` +
        (medianTotal !== undefined
          ? `A service the run has not seen gets the larger of the ${fmtEventCount(leftover)} an hour left over and the median service's limits, ${fmtEventCount(starTotalPerHour)} an hour in all, until the next run, which takes any overshoot back from the rest of the month.`
          : `A service the run has not seen gets the ${fmtEventCount(leftover)} an hour left over.`),
    );
  }
  lines.push(
    `Node counts ${input.instanceBasis === 'discovery' ? 'discovered on this run: the nodes where both a Receiver pod and the service run' : 'from nodes_by_container in policy.yaml'}; ${nodesTotal} Receiver${nodesTotal === 1 ? '' : 's'}. ${medianNodes !== undefined ? `The \`*\` row is divided by ${starNodes} node${starNodes === 1 ? '' : 's'}, the median known service's count.` : `The \`*\` row is divided by all of them.`} The division assumes a DaemonSet Receiver, one per node, each holding its node's share.`,
  );
  for (const r of rows) {
    if (!r.ownBudget || !receiverSees(r.container)) continue;
    const o = r.ownBudget;
    lines.push(
      o.exhausted
        ? `${r.container} has spent its own ${fmtAboutUsd(o.usdMonthly)} for this month (${fmtAboutUsd(o.spentUsd)} so far). Until the month ends, in ${r.container}, ${sample}`
        : `${r.container} is held to its own ${fmtAboutUsd(o.usdMonthly)} a month: ${fmtAboutUsd(o.spentUsd)} spent so far by Datadog's usage count for service:${o.datadogService}, ${fmtEventCount(r.allowancePerHour)} events an hour for the rest of the month, a limit of ${r.cap} per statement and a total of ${r.total} per window per node.`,
    );
  }
  for (const r of rows) {
    if (r.action !== 'pass' && r.protectedPerHour > r.allowancePerHour) {
      warnings.push(
        `In ${r.container}, statements a mute protects send ${fmtEventCount(r.protectedPerHour)} events an hour, above its total of ${fmtEventCount(r.allowancePerHour)}: they still pass, every other line in it moves, and Standard can run over by the difference.`,
      );
    }
  }
  for (const c of byContainer.keys()) {
    if ((inScope(c) || namedSet.has(c)) && input.instances[c] === undefined) {
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
        `| ${r.container}${r.ownBudget ? ` (own ${fmtAboutUsd(r.ownBudget.usdMonthly)} a month)` : ''} | ${r.action === 'pass' ? 'left alone' : fleetDestination(r.action)} | ${r.instances} | ${fmtEventCount(r.eventsPerHour)} | ${fmtEventCount(r.allowancePerHour)} | ${r.cap} | ${r.total} |`,
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
    q(creds, patternEventsQuery(envId), from, nowSec),
  ]);
  // A series grouped without the routestate tag would read as Standard.
  const untagged = routes.filter((s) => !('routestate' in s.tags));
  if (untagged.length > 0) {
    const keys = [...new Set(untagged.flatMap((s) => Object.keys(s.tags)))].sort();
    throw new Error(
      `${untagged.length} of the Receiver's ${routes.length} emitted series came back without a routestate tag (tags: ${keys.join(', ') || 'none'}), so the run cannot tell its Standard lines from the ones it moved.`,
    );
  }
  const patterns: PatternRate[] = pats.map((s) => ({
    container: s.tags['k8s_container'] ?? '',
    pattern: s.tags['tenx_hash'] ?? '',
    name: s.tags['message_pattern'] ?? '',
    severity: (s.tags['severity_level'] ?? '').toUpperCase(),
    eventsPerHour: hourlyRate(s.points),
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
