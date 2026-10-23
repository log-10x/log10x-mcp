/**
 * The rows run: rows written into a ClickHouse logs table held at a rate an hour.
 *
 * Every hour the run reads how many rows ClickHouse wrote into the table in the
 * last complete hour from its own `system.part_log` (NewPart rows, the meter that
 * equalled the hot count to the row in the gate run on 1.1.147 and ClickHouse
 * 26.5; `system.query_log` written_rows drifted with the exporter's async-insert
 * entries), reads each statement's lines an hour from the Receiver's own
 * Prometheus counters, and rewrites each service's total and each statement's
 * limit, in events, so the excess goes to the account's own bucket before
 * ClickHouse receives it. On ClickHouse an offloaded line never enters the table,
 * so there is no in-flight term, and the destination cannot count what was moved,
 * which is why the rates come from the Receiver and not from the table.
 *
 * The plan works in events with no residency:
 * allowance A = R - O - (nothing in flight), floors subtracted through
 * waterLevelWithFloor, so the criterion is the meter at or under R.
 */

import { ALWAYS_PASS_LINES, REGULATOR_WINDOW_SECONDS } from './report/user-units.js';
import { FLEET_DEFAULT_HEADROOM } from './fleet-default.js';
import { perWindowPerNode, type BudgetAction } from './budget-tick.js';
import type { RowsBudget } from './policy-loader.js';
import type { CustomerMetricsBackend } from './customer-metrics.js';

const HOUR = 3600;
const IDENT = /^[A-Za-z0-9_]+$/;

// ─── ClickHouse access ─────────────────────────────────────────────────────

export interface ChCreds {
  url: string;
  username: string;
  password: string;
}

/** CLICKHOUSE_URL with CLICKHOUSE_API_KEY, or CLICKHOUSE_USER and CLICKHOUSE_PASSWORD, as the POC connector reads them. */
export function chCredsFromEnv(env: NodeJS.ProcessEnv = process.env): ChCreds | undefined {
  const url = env.CLICKHOUSE_URL?.trim();
  if (!url) return undefined;
  const apiKey = env.CLICKHOUSE_API_KEY?.trim();
  if (apiKey) return { url, username: 'default', password: apiKey };
  const user = (env.CLICKHOUSE_USER ?? env.CLICKHOUSE_USERNAME)?.trim();
  const pass = env.CLICKHOUSE_PASSWORD ?? '';
  if (user) return { url, username: user, password: pass };
  return undefined;
}

/** One SQL statement, answered as TSV text (no header). */
export type ChQuery = (sql: string) => Promise<string>;

export function chRequester(creds: ChCreds, timeoutMs = 60_000): ChQuery {
  return async (sql: string): Promise<string> => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const base = creds.url.replace(/\/+$/, '');
      const res = await fetch(`${base}/?default_format=TSV`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`,
        },
        body: sql,
        signal: ctl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.slice(0, 300)}`);
      return text;
    } finally {
      clearTimeout(t);
    }
  };
}

/** `database.table`, each side an identifier, so the name can sit in a query unquoted. */
export function splitTable(table: string): { db: string; tbl: string } {
  const [db, tbl, ...rest] = table.split('.');
  if (!db || !tbl || rest.length > 0 || !IDENT.test(db) || !IDENT.test(tbl)) {
    throw new Error(`clickhouse_table must be database.table of identifiers; got: ${table}`);
  }
  return { db, tbl };
}

function sysTable(name: string, cluster?: string): string {
  return cluster ? `clusterAllReplicas('${cluster.replace(/'/g, '')}', system.${name})` : `system.${name}`;
}

// ─── reads ─────────────────────────────────────────────────────────────────

export interface StatementLines {
  container: string;
  hash: string;
  pattern: string;
  severity: string;
  route: string;
  linesPerHour: number;
}

export interface RowsReads {
  table: string;
  /** Rows written into the table in the last complete hour (part_log NewPart). */
  rowsLastHour: number;
  /** The same per complete window over the lookback, oldest first, each scaled to an hour. */
  rowsByHour: Array<{ hourStartSec: number; rows: number }>;
  /** Active rows in the table now (system.parts), the cross-check. */
  activeRows: number;
  /** Lines an hour the Receiver returned marked pass, and marked offload, over the same hour. */
  passLinesPerHour: number;
  offloadLinesPerHour: number;
  statements: StatementLines[];
  queries: string[];
}

function tsvRows(text: string): string[][] {
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split('\t'));
}

/**
 * The meter and the rates. `nowSec` is the run's clock; the meter's hour is the
 * last complete one before it, read from the event's own time, never from a part
 * or object's creation time.
 */
export async function readRowsInputs(
  nowSec: number,
  rows: RowsBudget,
  ch: ChQuery,
  prom: CustomerMetricsBackend,
  envId?: string,
  lookbackHours = 24,
): Promise<RowsReads> {
  const { db, tbl } = splitTable(rows.table);
  // the meter's window: an hour in production; a shorter one on a time-scaled rig, read as a rate an hour
  const windowSec = Math.max(60, Math.round(rows.meter_minutes * 60));
  const toHour = HOUR / windowSec;
  const hourStart = Math.floor(nowSec / windowSec) * windowSec;
  const lookbackSec = lookbackHours * HOUR;
  const queries: string[] = [];
  const q = async (sql: string): Promise<string> => {
    queries.push(sql);
    return ch(sql);
  };
  const byHourSql =
    `SELECT intDiv(toUnixTimestamp(event_time), ${windowSec}) * ${windowSec} AS h, sum(rows) AS r FROM ${sysTable('part_log', rows.cluster)} ` +
    `WHERE event_type = 'NewPart' AND database = '${db}' AND table = '${tbl}' ` +
    `AND event_time >= toDateTime(${hourStart - lookbackSec}) AND event_time < toDateTime(${hourStart}) GROUP BY h ORDER BY h`;
  const byHour = tsvRows(await q(byHourSql)).map(([h, r]) => ({ hourStartSec: Number(h), rows: Number(r) * toHour }));
  const last = byHour.find((x) => x.hourStartSec === hourStart - windowSec);
  const activeSql = `SELECT sum(rows) FROM ${sysTable('parts', rows.cluster)} WHERE database = '${db}' AND table = '${tbl}' AND active`;
  const activeRows = Number((await q(activeSql)).trim() || 0);

  // the Receiver's own counters, the last complete hour, by container, statement, severity and route
  const envLabel = envId ? `{tenx_env="${envId.replace(/"/g, '')}"}` : '';
  // Each counter's value at the window's end less its value at the start; a series born inside
  // the window counts from zero (increase() drops a new series' first value, and pattern series
  // keep being born as new statements print).
  const sel = `all_events_summaryVolume_total${envLabel}`;
  const promql =
    `sum by (${rows.container_label}, tenx_hash, message_pattern, severity_level, routeState) ` +
    `(clamp_min(${sel} @ ${hourStart} - (${sel} @ ${hourStart - windowSec} or ${sel} @ ${hourStart} * 0), 0))`;
  queries.push(promql);
  const resp = await prom.queryInstant(promql);
  if (resp.status !== 'success') throw new Error(`Prometheus answered ${resp.status} to the statements query`);
  const statements: StatementLines[] = [];
  let pass = 0;
  let offload = 0;
  for (const r of resp.data.result) {
    const m = r.metric ?? {};
    const v = Array.isArray(r.value) ? Number(r.value[1]) * toHour : NaN;
    if (!(v > 0)) continue;
    const route = m['routeState'] ?? '';
    if (route === 'pass') pass += v;
    if (route === 'offload') offload += v;
    statements.push({
      container: m[rows.container_label] ?? '',
      hash: m['tenx_hash'] ?? '',
      pattern: m['message_pattern'] ?? m['tenx_hash'] ?? '',
      severity: m['severity_level'] ?? '',
      route,
      linesPerHour: v,
    });
  }
  return {
    table: rows.table,
    rowsLastHour: last?.rows ?? 0,
    rowsByHour: byHour,
    activeRows,
    passLinesPerHour: pass,
    offloadLinesPerHour: offload,
    statements,
    queries,
  };
}

// ─── the plan ──────────────────────────────────────────────────────────────

export interface RowsRow {
  container: string;
  action: BudgetAction;
  instances: number;
  /** Fleet lines an hour the service sends now. */
  linesPerHour: number;
  /** Fleet lines an hour kept in the table under this run. */
  keptPerHour: number;
  /** Per-statement limit, lines per window per node; 0 exempts the service. */
  cap: number;
  /** Service total, lines per window per node. */
  total: number;
}

export interface RowsPlan {
  /** R, rows an hour. */
  targetRows: number;
  targetSource: string;
  /** W, the meter's last complete hour. */
  rowsLastHour: number;
  activeRows: number;
  /** O, rows an hour other writers put into the table (the policy's outside_rows_per_hour). */
  outsidePerHour: number;
  /** Meter rows on the Receiver over the pass lines its counters read: each statement's rate is scaled by it. */
  counterScale: number;
  allowancePerHour: number;
  levelPerHour?: number;
  floorPerHour: number;
  floorExceedsRate: boolean;
  movedPerHour: number;
  /** Rows an hour the table takes at these limits. */
  projectedPerHour: number;
  overRate: boolean;
  rows: RowsRow[];
  star: { action: BudgetAction; instances: number; cap: number; total: number; keptPerHour: number };
  heldLine: string;
  lines: string[];
  warnings: string[];
}

export interface RowsPlanInput {
  rows: RowsBudget;
  reads: RowsReads;
  instances: Record<string, number>;
  nodesTotal: number;
  exceptions: string[];
  targetServices: string[];
  /** R recorded by an earlier run when the policy says `auto`. */
  recordedRate?: number;
}

/**
 * The level L at which the kept total, sum(max(min(rate, L), floor)), equals the
 * allowance: the regulator passes each statement's always-pass sample (and an
 * error statement's keep count) whatever its limit, so no statement keeps less
 * than its floor. Undefined when the floors alone exceed the allowance.
 */
export function waterLevelWithFloor(items: Array<{ rate: number; floor: number }>, allowance: number): number | undefined {
  const kept = (L: number): number => items.reduce((a, x) => a + Math.max(Math.min(x.rate, L), Math.min(x.floor, x.rate)), 0);
  if (kept(0) > allowance) return undefined;
  let lo = 0;
  let hi = Math.max(0, ...items.map((x) => x.rate));
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (kept(mid) > allowance) hi = mid;
    else lo = mid;
  }
  return lo;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function fmtRows(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return `${Math.round(n)}`;
}

export function planRows(input: RowsPlanInput): RowsPlan {
  const { rows, reads } = input;
  const warnings: string[] = [];
  const lines: string[] = [];
  const W = reads.rowsLastHour;
  let R: number;
  let targetSource: string;
  if (rows.rows_per_hour !== undefined) {
    R = rows.rows_per_hour;
    targetSource = `${fmtRows(R)} rows an hour set in the policy`;
  } else if (input.recordedRate !== undefined && input.recordedRate > 0) {
    R = input.recordedRate;
    targetSource = `${fmtRows(R)} rows an hour, the meter's hour recorded at the first run`;
  } else {
    R = W;
    targetSource = `${fmtRows(R)} rows an hour, the meter's last complete hour, recorded by this run`;
    if (!(W > 0)) warnings.push('The meter counted no rows in the last complete hour, so no rate is recorded yet; the next run reads it again.');
  }
  // The meter is the truth for totals; the Receiver's counters apportion it across statements.
  const O = Math.min(W, rows.outside_rows_per_hour);
  const receiverRows = Math.max(0, W - O);
  const counterScale = reads.passLinesPerHour > 0 && receiverRows > 0 ? Math.max(1, receiverRows / reads.passLinesPerHour) : 1;

  // statements by container, all routes summed: the Receiver's intake, and the floor each keeps
  // whatever its limit: the always-pass sample per window per node, plus the keep count for an
  // error statement, in lines.
  const windowsPerHour = HOUR / REGULATOR_WINDOW_SECONDS;
  const agg = new Map<string, Map<string, { rate: number; error: boolean }>>();
  for (const s of reads.statements) {
    if (!s.container || !(s.linesPerHour > 0)) continue;
    const m = agg.get(s.container) ?? new Map<string, { rate: number; error: boolean }>();
    const key = s.hash || s.pattern;
    const x = m.get(key) ?? { rate: 0, error: false };
    x.rate += s.linesPerHour * counterScale;
    x.error = x.error || ['ERROR', 'CRITICAL', 'FATAL'].includes(s.severity);
    m.set(key, x);
    agg.set(s.container, m);
  }
  const floorOf = (c: string, x: { rate: number; error: boolean }): number => {
    const perWindow = ALWAYS_PASS_LINES + (x.error ? rows.keep_count : 0);
    return Math.min(x.rate, perWindow * windowsPerHour * Math.max(1, input.instances[c] ?? 1));
  };
  const exempt = new Set(input.exceptions);
  const inScope = (c: string): boolean => !exempt.has(c) && (input.targetServices.length === 0 || input.targetServices.includes(c));
  const actionOf = (c: string): BudgetAction => rows.service_actions[c] ?? rows.default_action;
  let exemptPerHour = 0;
  const budgeted: Array<{ c: string; rate: number; floor: number }> = [];
  for (const [c, m] of agg) {
    for (const x of m.values()) {
      if (inScope(c)) budgeted.push({ c, rate: x.rate, floor: floorOf(c, x) });
      else exemptPerHour += x.rate;
    }
  }
  const budgetedPerHour = budgeted.reduce((a, x) => a + x.rate, 0);
  const floorPerHour = budgeted.reduce((a, x) => a + x.floor, 0);
  const keptOf = (x: { rate: number; floor: number }, L: number | undefined): number => (L === undefined ? x.rate : Math.max(Math.min(x.rate, L), x.floor));

  // A = R - O, less the exempt services' lines; no residency and nothing in flight on this route.
  const allowance = Math.max(0, R - O);
  const forBudgeted = Math.max(0, allowance - exemptPerHour);
  let level: number | undefined;
  let infeasible = false;
  if (budgetedPerHour > forBudgeted) {
    const L = waterLevelWithFloor(budgeted, forBudgeted);
    if (L === undefined) {
      level = 0;
      infeasible = true;
    } else {
      level = L;
    }
  }
  const moved = budgeted.reduce((a, x) => a + (x.rate - keptOf(x, level)), 0);
  const keptBudgeted = budgeted.reduce((a, x) => a + keptOf(x, level), 0);
  const headroom = budgetedPerHour > 0 ? Math.min(FLEET_DEFAULT_HEADROOM, Math.max(1, forBudgeted / budgetedPerHour)) : FLEET_DEFAULT_HEADROOM;

  const byContainer = new Map<string, number[]>();
  for (const [c, m] of agg) byContainer.set(c, [...m.values()].map((x) => x.rate));
  const out: RowsRow[] = [];
  const knownCaps: number[] = [];
  const knownTotals: number[] = [];
  const knownNodes: number[] = [];
  for (const c of [...byContainer.keys()].sort()) {
    const ps = byContainer.get(c)!;
    const n = Math.max(1, input.instances[c] ?? 1);
    const rate = ps.reduce((a, r) => a + r, 0);
    if (!inScope(c)) {
      out.push({ container: c, action: 'pass', instances: n, linesPerHour: rate, keptPerHour: rate, cap: 0, total: perWindowPerNode(rate * FLEET_DEFAULT_HEADROOM, n) });
      continue;
    }
    const items = budgeted.filter((x) => x.c === c);
    const capPerHour = level !== undefined ? level : Math.max(...ps) * headroom;
    const keptPerHour = level !== undefined ? items.reduce((a, x) => a + keptOf(x, level), 0) : rate * headroom;
    knownCaps.push(capPerHour);
    knownTotals.push(keptPerHour);
    if (input.instances[c] !== undefined) knownNodes.push(n);
    out.push({ container: c, action: actionOf(c), instances: n, linesPerHour: rate, keptPerHour, cap: perWindowPerNode(capPerHour, n), total: perWindowPerNode(keptPerHour, n) });
  }
  for (const c of input.exceptions) {
    if (!byContainer.has(c)) out.push({ container: c, action: 'pass', instances: Math.max(1, input.instances[c] ?? 1), linesPerHour: 0, keptPerHour: 0, cap: 0, total: 1 });
  }
  out.sort((a, b) => a.container.localeCompare(b.container));

  // A service the run has not seen: the level the others get, and the median total.
  const leftover = Math.max(0, forBudgeted - keptBudgeted);
  const mCap = median(knownCaps);
  const mTotal = median(knownTotals);
  const starCap = mCap === undefined ? leftover : level !== undefined ? level : Math.max(leftover, mCap);
  const starTotal = mTotal === undefined ? leftover : level !== undefined ? mTotal : Math.max(leftover, mTotal);
  const mNodes = median(knownNodes);
  const starNodes = mNodes !== undefined ? Math.max(1, Math.round(mNodes)) : Math.max(1, input.nodesTotal);
  const star = { action: rows.default_action as BudgetAction, instances: starNodes, cap: perWindowPerNode(starCap, starNodes), total: perWindowPerNode(starTotal, starNodes), keptPerHour: starTotal };

  const projected = O + keptBudgeted + exemptPerHour;
  const overRate = W > R;
  const heldLine =
    `Rows written: ${fmtRows(W)} of ${fmtRows(R)} an hour last hour (${targetSource}; part_log on ${rows.table}); ` +
    `at these limits the table takes about ${fmtRows(projected)} an hour, with ${fmtRows(moved)} an hour of lines to the account's bucket.`;
  lines.push(
    `Outside the Receiver: ${fmtRows(O)} rows an hour (outside_rows_per_hour). The Receiver's counters read ${fmtRows(reads.passLinesPerHour)} pass lines an hour against ${fmtRows(receiverRows)} rows the meter puts on it, so each statement's rate is scaled by ${counterScale.toFixed(2)}. The table holds ${fmtRows(reads.activeRows)} active rows.`,
    `The Receiver's statements send ${fmtRows(budgetedPerHour)} lines an hour` +
      (level !== undefined
        ? `; ${fmtRows(forBudgeted)} an hour fits the rate, so each statement keeps up to ${fmtRows(level)} an hour and the noisiest give way first.`
        : `, under the ${fmtRows(forBudgeted)} an hour that fits the rate; every statement keeps its lines, with room to grow ${headroom.toFixed(1)} times.`),
    `The always-pass sample (${ALWAYS_PASS_LINES} lines a statement a window on every node, ${rows.keep_count} more for an error statement over its limit) keeps about ${fmtRows(floorPerHour)} lines an hour whatever the limits; the rate holds down to that floor.`,
  );
  if (overRate) lines.push(`The meter read above the rate last hour; the limits below hold the next hour at the rate, and each node's totals bind inside every window.`);
  if (infeasible) {
    warnings.push(
      `The always-pass sample alone keeps about ${fmtRows(floorPerHour)} lines an hour, more than the ${fmtRows(forBudgeted)} an hour that fits, so the table takes about ${fmtRows(projected)} an hour above the rate. Raise the rate, lower rateReceiverBaselineCount, or add the noisiest services to the Receiver's scope.`,
    );
  }
  if (counterScale > 1.5) warnings.push(`The Receiver's counters read ${fmtRows(reads.passLinesPerHour)} pass lines an hour against ${fmtRows(receiverRows)} rows on the meter; rates are scaled by ${counterScale.toFixed(2)}, which assumes the counters miss lines evenly across statements.`);
  if (O >= R) warnings.push(`Rows from writers outside the Receiver already reach ${fmtRows(O)} an hour, at or above the rate, so the Receiver's services keep nothing beyond the always-pass sample.`);
  return {
    targetRows: R,
    targetSource,
    rowsLastHour: W,
    activeRows: reads.activeRows,
    outsidePerHour: O,
    counterScale,
    allowancePerHour: allowance,
    ...(level !== undefined ? { levelPerHour: level } : {}),
    floorPerHour,
    floorExceedsRate: infeasible,
    movedPerHour: moved,
    projectedPerHour: projected,
    overRate,
    rows: out,
    star,
    heldLine,
    lines,
    warnings,
  };
}

export function renderRowsReport(plan: RowsPlan, rows: RowsBudget, nowSec: number): string {
  return [
    `# Rows run: ${new Date(nowSec * 1000).toISOString()}`,
    '',
    plan.heldLine,
    '',
    ...plan.lines.map((l) => `- ${l}`),
    ...plan.warnings.map((w) => `- Warning: ${w}`),
    '',
    `| Service | Destination | Nodes | Sent an hour | Kept an hour | Limit per statement | Total |`,
    `|---|---|---|---|---|---|---|`,
    ...plan.rows.map(
      (r) => `| ${r.container} | ${r.action === 'pass' ? 'left alone' : "the account's bucket"} | ${r.instances} | ${fmtRows(r.linesPerHour)} | ${fmtRows(r.keptPerHour)} | ${r.cap} | ${r.total} |`,
    ),
    `| \`*\` (any other service) | the account's bucket | ${plan.star.instances} | | ${fmtRows(plan.star.keptPerHour)} | ${plan.star.cap} | ${plan.star.total} |`,
    '',
    `Limits and totals are lines per ${REGULATOR_WINDOW_SECONDS / 60}-minute window per node. Error lines pass ${rows.keep_count} over a limit per statement per node per window. The meter is \`system.part_log\` NewPart rows on ${rows.table}, read by the event's own time.`,
    '',
  ].join('\n');
}
