/**
 * The Splunk run: each named service held at its own bytes a day, in the
 * Receiver's unit (each record whole, as the forwarder sends it), which is
 * not the text Splunk bills.
 *
 * Every hour the run reads each pattern's bytes and lines over the last
 * complete hour from the Receiver's Prometheus counters, summed over every
 * Receiver, and rewrites each named service's per-pattern limit and total in
 * bytes with the water level the other runs use: inside a service over its
 * number the loudest patterns give way first, and each keeps up to the level
 * in the index. Lines over a limit take the service's action: tier_down for
 * Machine Data Lake on Splunk Cloud, offload for the account's bucket. A
 * service without a number is left alone, since the `*` row's limit of 0
 * exempts it.
 */

import { ALWAYS_PASS_LINES, REGULATOR_WINDOW_SECONDS } from './report/user-units.js';
import { BASELINE_MAX_OVER_TOTAL_DEFAULT, ERROR_CLASS_LEVELS, KEEP_MAX_OVER_TOTAL_DEFAULT } from './fleet-default-install.js';
import { FLEET_DEFAULT_HEADROOM } from './fleet-default.js';
import type { PassStatement } from './regulator-pass.js';
import { holdService, perWindowPerNode, type BudgetAction } from './budget-tick.js';
import { fmtGB } from './elastic-budget-tick.js';
import type { SplunkBudget } from './policy-loader.js';
import type { CustomerMetricsBackend } from './customer-metrics.js';

const HOUR = 3600;
const GB = 1e9;
const ERROR_CLASS: ReadonlySet<string> = new Set(ERROR_CLASS_LEVELS);

// ─── reads ─────────────────────────────────────────────────────────────────

export interface SplunkStatement {
  container: string;
  /** The pattern hash: `tenx_pattern` on a Splunk Receiver, `tenx_hash` when the field is not renamed. */
  hash: string;
  pattern: string;
  severity: string;
  route: string;
  bytesPerHour: number;
  linesPerHour: number;
}

export interface SplunkReads {
  statements: SplunkStatement[];
  queries: string[];
}

/** A counter's increase over the window ending at `end`; a series born inside it counts from zero. */
function windowIncrease(sel: string, end: number, windowSec: number): string {
  return `clamp_min(${sel} @ ${end} - (${sel} @ ${end - windowSec} or ${sel} @ ${end} * 0), 0)`;
}

/** Bytes and lines per pattern, service and route over the last complete hour, from the Receiver's counters. */
export async function readSplunkInputs(
  nowSec: number,
  splunk: SplunkBudget,
  prom: CustomerMetricsBackend,
  envId?: string,
): Promise<SplunkReads> {
  const end = Math.floor(nowSec / HOUR) * HOUR;
  const env = envId ? `{tenx_env="${envId.replace(/"/g, '')}"}` : '';
  const by = `${splunk.container_label}, tenx_pattern, tenx_hash, message_pattern, severity_level, routeState`;
  const query = (metric: string): string => `sum by (${by}) (${windowIncrease(`${metric}${env}`, end, HOUR)})`;
  const bytesQuery = query('all_events_summaryBytes_total');
  const linesQuery = query('all_events_summaryVolume_total');
  const [bytes, lines] = await Promise.all([prom.queryInstant(bytesQuery), prom.queryInstant(linesQuery)]);
  if (bytes.status !== 'success') throw new Error(`Prometheus answered ${bytes.status} to the bytes query`);
  if (lines.status !== 'success') throw new Error(`Prometheus answered ${lines.status} to the lines query`);

  const byKey = new Map<string, SplunkStatement>();
  const statementOf = (m: Record<string, string>): SplunkStatement => {
    const s = {
      container: m[splunk.container_label] ?? '',
      hash: m['tenx_pattern'] || m['tenx_hash'] || '',
      pattern: m['message_pattern'] ?? '',
      severity: (m['severity_level'] ?? '').toUpperCase(),
      route: m['routeState'] ?? '',
    };
    const key = JSON.stringify([s.container, s.hash, s.pattern, s.severity, s.route]);
    let x = byKey.get(key);
    if (!x) {
      x = { ...s, bytesPerHour: 0, linesPerHour: 0 };
      byKey.set(key, x);
    }
    return x;
  };
  for (const r of bytes.data.result) {
    const v = Array.isArray(r.value) ? Number(r.value[1]) : NaN;
    if (v > 0) statementOf(r.metric ?? {}).bytesPerHour += v;
  }
  for (const r of lines.data.result) {
    const v = Array.isArray(r.value) ? Number(r.value[1]) : NaN;
    if (v > 0) statementOf(r.metric ?? {}).linesPerHour += v;
  }
  return { statements: [...byKey.values()].filter((s) => s.bytesPerHour > 0), queries: [bytesQuery, linesQuery] };
}

// ─── the plan ──────────────────────────────────────────────────────────────

export interface SplunkRow {
  container: string;
  action: BudgetAction;
  instances: number;
  /** The service's number, bytes a day. */
  targetBytesPerDay: number;
  /** Fleet bytes an hour the Receiver sees from the service, every route summed. */
  bytesPerHour: number;
  /** Fleet lines an hour the Receiver sees from the service. */
  linesPerHour: number;
  /** Fleet bytes an hour the index keeps at these limits: the total and what passes past it. */
  keptPerHour: number;
  /** Per-pattern limit, bytes per window per node. */
  cap: number;
  /** Service total, bytes per window per node. */
  total: number;
}

export interface SplunkPlan {
  rows: SplunkRow[];
  /** Every service without a number: a limit of 0, which exempts it. */
  star: { action: BudgetAction; instances: number; cap: number; total: number };
  targetBytesPerDay: number;
  keptBytesPerDay: number;
  movedBytesPerDay: number;
  heldLine: string;
  lines: string[];
  warnings: string[];
}

export interface SplunkPlanInput {
  splunk: SplunkBudget;
  reads: SplunkReads;
  /** Nodes each container's pods run on. */
  instances: Record<string, number>;
  nodesTotal: number;
  instanceBasis: 'discovery' | 'policy';
}

/** What the Splunk run's numbers count, for every surface that states them. */
export const RECEIVER_BYTES_WORDS =
  "The Receiver counts each record whole, as the forwarder sends it, metadata included. " +
  'Splunk meters the text it indexes, which can be much less: on the OpenTelemetry Collector route Splunk indexes the message alone.';

function bytesPerLine(r: Pick<SplunkRow, 'bytesPerHour' | 'linesPerHour'>): string {
  return r.linesPerHour > 0 ? String(Math.round(r.bytesPerHour / r.linesPerHour)) : '';
}

function destinationOf(action: BudgetAction): string {
  return action === 'tier_down' ? 'Machine Data Lake' : action === 'offload' ? "the account's bucket" : 'left alone';
}

export function planSplunk(input: SplunkPlanInput): SplunkPlan {
  const { splunk, reads } = input;
  const windowsPerHour = HOUR / REGULATOR_WINDOW_SECONDS;
  const lines: string[] = [];
  const warnings: string[] = [];

  // Each service's patterns, every route summed: the Receiver's intake.
  const byContainer = new Map<string, Map<string, PassStatement>>();
  for (const s of reads.statements) {
    if (!s.container) continue;
    const m = byContainer.get(s.container) ?? new Map<string, PassStatement>();
    const key = s.hash || s.pattern;
    const x = m.get(key) ?? { rate: 0, lines: 0, error: false };
    x.rate += s.bytesPerHour;
    x.lines += s.linesPerHour;
    x.error = x.error || ERROR_CLASS.has(s.severity);
    m.set(key, x);
    byContainer.set(s.container, m);
  }

  const rows: SplunkRow[] = [];
  for (const c of Object.keys(splunk.gb_per_day).sort()) {
    const n = Math.max(1, input.instances[c] ?? 1);
    const sts = [...(byContainer.get(c)?.values() ?? [])];
    const targetPerHour = (splunk.gb_per_day[c] * GB) / 24;
    const rate = sts.reduce((a, x) => a + x.rate, 0);
    const linesPerHour = sts.reduce((a, x) => a + x.lines, 0);
    const hold = holdService(sts, targetPerHour, { windowsPerHour, nodes: n, keepCount: splunk.keep_count });
    const action: BudgetAction = splunk.service_actions[c] ?? splunk.default_action;
    const kept = Math.min(rate, hold.allowancePerHour);
    rows.push({
      container: c,
      action,
      instances: n,
      targetBytesPerDay: targetPerHour * 24,
      bytesPerHour: rate,
      linesPerHour,
      keptPerHour: kept,
      cap: perWindowPerNode(hold.capPerHour, n),
      total: perWindowPerNode(hold.totalPerHour, n),
    });
    const now = `${c} sends ${fmtGB(rate * 24)} a day against its ${fmtGB(targetPerHour * 24)}`;
    if (rate === 0) {
      warnings.push(`The Receiver's counters show no lines from ${c} in the last hour (label ${splunk.container_label}), so its limits are its whole number until a run sees it.`);
    } else if (rate > targetPerHour) {
      lines.push(`${now}: each pattern keeps up to ${fmtGB(hold.capPerHour * 24)} a day in the index and the loudest give way first, ${fmtGB((rate - kept) * 24)} a day to ${destinationOf(action)}.`);
    } else {
      lines.push(`${now}: every pattern stays in the index, with room to grow ${Number(Math.min(FLEET_DEFAULT_HEADROOM, targetPerHour / rate).toFixed(2))}x.`);
    }
    if (rate > 0 && hold.floorPerHour > targetPerHour) {
      warnings.push(
        `In ${c}, the always-pass sample alone keeps about ${fmtGB(hold.floorPerHour * 24)} a day in the index, more than its ${fmtGB(targetPerHour * 24)}. Raise its number or lower rateReceiverBaselineCount.`,
      );
    }
    if (input.instances[c] === undefined) warnings.push(`No node count for ${c}: its limits are written for one Receiver.`);
  }

  const others = [...byContainer.keys()].filter((c) => splunk.gb_per_day[c] === undefined).length;
  const star = { action: 'pass' as BudgetAction, instances: Math.max(1, input.nodesTotal), cap: 0, total: 0 };
  const targetDay = rows.reduce((a, r) => a + r.targetBytesPerDay, 0);
  const keptDay = rows.reduce((a, r) => a + r.keptPerHour, 0) * 24;
  const movedDay = rows.reduce((a, r) => a + (r.bytesPerHour - r.keptPerHour), 0) * 24;
  const where = [...new Set(rows.map((r) => r.action).filter((a) => a !== 'pass'))].map(destinationOf).join(' and ') || 'nowhere';
  const heldLine =
    `Held at ${fmtGB(targetDay)} a day across ${rows.length} service${rows.length === 1 ? '' : 's'} in the Receiver's bytes: ` +
    `at these limits about ${fmtGB(keptDay)} a day of their records stay in the index, with ${fmtGB(movedDay)} a day of lines to ${where}.`;
  lines.push(
    `Whatever the limits, each pattern passes ${ALWAYS_PASS_LINES} sample lines and each error pattern ${splunk.keep_count} more a window on each node, at most ${BASELINE_MAX_OVER_TOTAL_DEFAULT} and ${KEEP_MAX_OVER_TOTAL_DEFAULT} a service past its total; each number holds down to that floor.`,
    `${RECEIVER_BYTES_WORDS} The Bytes a line column is the Receiver's figure to compare with a service's average event size in Splunk.`,
    `Node counts ${input.instanceBasis === 'discovery' ? 'discovered on this run: the nodes where both a Receiver pod and the service run' : 'from nodes_by_container in policy.yaml'}; each limit and total is divided by them.`,
    `${others} other service${others === 1 ? '' : 's'} seen by the Receiver ${others === 1 ? 'is' : 'are'} left alone.`,
  );
  return { rows, star, targetBytesPerDay: targetDay, keptBytesPerDay: keptDay, movedBytesPerDay: movedDay, heldLine, lines, warnings };
}

export function renderSplunkReport(plan: SplunkPlan, splunk: SplunkBudget, nowSec: number): string {
  return [
    `# Splunk run: ${new Date(nowSec * 1000).toISOString()}`,
    '',
    plan.heldLine,
    '',
    ...plan.lines.map((l) => `- ${l}`),
    ...plan.warnings.map((w) => `- Warning: ${w}`),
    '',
    `| Service | Held at a day | Over it to | Nodes | Sent a day | Kept a day | Bytes a line | Limit per pattern | Total |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...plan.rows.map(
      (r) =>
        `| ${r.container} | ${fmtGB(r.targetBytesPerDay)} | ${destinationOf(r.action)} | ${r.instances} | ${fmtGB(r.bytesPerHour * 24)} | ${fmtGB(r.keptPerHour * 24)} | ${bytesPerLine(r)} | ${r.cap} | ${r.total} |`,
    ),
    `| \`*\` (any other service) | | left alone | | | | | 0 | |`,
    '',
    `Every figure is in the Receiver's bytes. Limits and totals are per ${REGULATOR_WINDOW_SECONDS / 60}-minute window per node (${splunk.deployment === 'cloud' ? 'Splunk Cloud' : 'Splunk Enterprise'}).`,
    '',
  ].join('\n');
}
