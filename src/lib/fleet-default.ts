/**
 * The fleet default: the limit and the route for a service with no rule of
 * its own. One module so the number rule and the user-unit sentences change
 * in one place.
 *
 * Engine semantics this states (config `pipelines/run/receive/rate/
 * rate-object-cap.js`): in each reset window, per statement per container per
 * node, the first `rateReceiverBaselineCount` lines pass; then lines pass while
 * the statement's bytes stay under the cap; above it an ERROR, CRITICAL or
 * FATAL line passes while the statement is under its keep count, and the rest
 * take the action.
 */

import { ALWAYS_PASS_LINES, REGULATOR_WINDOW_SECONDS, SECONDS_PER_DAY, fmtLinesPerDay } from './report/user-units.js';

export type FleetDefaultAction = 'tier_down' | 'offload';

/** Headroom on the baseline when the caller names none. */
export const FLEET_DEFAULT_HEADROOM = 2;

/**
 * The always-pass sample in lines a day per statement per node: the lines
 * that pass in every reset window, times the windows in a day (5 x 360 =
 * 1,800 at the engine defaults). People read rules in lines a day, never in
 * the window's length.
 */
export function alwaysPassLinesPerDay(alwaysPass: number = ALWAYS_PASS_LINES): number {
  return alwaysPass * (SECONDS_PER_DAY / REGULATOR_WINDOW_SECONDS);
}

/**
 * The number rule, isolated: the baseline times the headroom. The baseline is
 * the largest statement the plan keeps, in whatever unit the caller carries
 * (bytes per window per node from a capture, lines a day from a metrics
 * series); the result is in the same unit. Returns 0 when there is no
 * baseline, so a caller writes no default.
 */
export function fleetDefaultLimit(baseline: number, headroom: number = FLEET_DEFAULT_HEADROOM): number {
  if (!(baseline > 0) || !Number.isFinite(baseline)) return 0;
  const h = Number.isFinite(headroom) && headroom >= 1 ? headroom : FLEET_DEFAULT_HEADROOM;
  return baseline * h;
}

/**
 * A kept statement in one container, as the capture measured it. The cell is
 * per node: the statement's bytes per reset window over the whole stream,
 * divided by the Receivers that enforce the container's cap.
 */
export interface KeptCell {
  container: string;
  /** Bytes per reset window of the container's largest kept statement, whole stream. */
  keptMaxBytesPerWindow: number;
  /** Receivers enforcing the container's cap: its nodes for a DaemonSet, 1 for a sidecar. */
  instances: number;
  /** The statement's name, for the plan. */
  statement?: string;
  /** Average bytes per line of that statement. */
  avgBytesPerLine?: number;
}

export interface FleetDefaultNumber {
  /** The engine value: bytes per reset window per node (`rateReceiverAbsoluteCap`). */
  capBytesPerWindowPerNode: number;
  /** The baseline the cap multiplies, in the same unit. */
  baselineBytesPerWindowPerNode: number;
  headroom: number;
  /** The cell the baseline came from. */
  baseline: KeptCell;
}

/** The baseline: the largest kept per-window cell of the capture, per node. */
export function fleetDefaultBaseline(cells: KeptCell[]): (KeptCell & { perNode: number }) | undefined {
  let best: (KeptCell & { perNode: number }) | undefined;
  for (const c of cells) {
    if (!(c.keptMaxBytesPerWindow > 0)) continue;
    const perNode = c.keptMaxBytesPerWindow / Math.max(1, c.instances);
    if (!best || perNode > best.perNode) best = { ...c, perNode };
  }
  return best;
}

/**
 * The fleet default's number: the baseline cell times the headroom, in bytes
 * per reset window per node. Undefined without a kept cell, so a caller
 * writes no default and says why.
 */
export function fleetDefaultNumber(
  cells: KeptCell[],
  headroom: number = FLEET_DEFAULT_HEADROOM,
): FleetDefaultNumber | undefined {
  const b = fleetDefaultBaseline(cells);
  if (!b) return undefined;
  const h = Number.isFinite(headroom) && headroom >= 1 ? headroom : FLEET_DEFAULT_HEADROOM;
  const { perNode, ...baseline } = b;
  return {
    capBytesPerWindowPerNode: Math.max(1, Math.round(fleetDefaultLimit(perNode, h))),
    baselineBytesPerWindowPerNode: perNode,
    headroom: h,
    baseline,
  };
}

/**
 * Share of ERROR and CRITICAL lines above the limit that stay in Standard.
 * Ruled 2026-10-13: 0.5 when the excess is offloaded (S3 has no monitors),
 * 0 when it goes to Flex. A parameter, because the containment demo may move it.
 */
export function defaultErrorFloor(action: FleetDefaultAction): number {
  return action === 'offload' ? 0.5 : 0;
}

function shareWords(f: number): string {
  if (f === 0.5) return 'half';
  if (f >= 1) return 'all';
  const pct = Math.round(f * 1000) / 10;
  return `${pct}%`;
}

/** Where the lines above the limit go, as a noun phrase. */
export function fleetDestination(action: FleetDefaultAction): string {
  return action === 'tier_down' ? 'Flex' : 'S3';
}

/** The always-pass sample, in user units. */
export function alwaysPassSentence(alwaysPass: number = ALWAYS_PASS_LINES): string {
  return `Up to ${fmtLinesPerDay(alwaysPassLinesPerDay(alwaysPass))} lines a day of every statement always reach Standard on each node.`;
}

/**
 * What a Datadog log monitor on error lines sees under the fleet default.
 * The fleet default holds every statement in a service with no rule, error
 * statements included, so this is stated with every fleet-default offer.
 */
export function errorMonitorVisibility(
  action: FleetDefaultAction,
  errorFloor: number = defaultErrorFloor(action),
  alwaysPass: number = ALWAYS_PASS_LINES,
  /** Error lines over the limit that pass per statement per node per window (engine 1.1.146); replaces the floor. */
  keepCount?: number,
): string {
  const f = Math.min(1, Math.max(0, Number.isFinite(errorFloor) ? errorFloor : defaultErrorFloor(action)));
  const first = `up to ${fmtLinesPerDay(alwaysPassLinesPerDay(alwaysPass))} lines a day of each statement on each node`;
  if (keepCount === undefined && f >= 1) {
    return 'An error monitor sees every ERROR and CRITICAL line: none leaves Standard, whatever the limit.';
  }
  const kept =
    keepCount !== undefined
      ? `every ERROR and CRITICAL line under the limit, ${first}, and above the limit the first ${keepCount} lines of each error statement on each node in every ${REGULATOR_WINDOW_SECONDS / 60}-minute window (up to ${fmtLinesPerDay(alwaysPassLinesPerDay(keepCount))} a day)`
      : f > 0
        ? `every ERROR and CRITICAL line under the limit, ${first}, and ${shareWords(f)} of the rest`
        : `every ERROR and CRITICAL line under the limit and ${first}`;
  if (action === 'offload') {
    return (
      `An error monitor sees ${kept}. ` +
      `The other error lines above the limit go to S3: no Datadog log monitor sees them and no log-based metric counts them.`
    );
  }
  return (
    `An error monitor sees ${kept}, in Standard. ` +
    `The other error lines above the limit go to Flex, where Datadog runs no log monitors; ` +
    `log-based metrics still count them, because Datadog computes those at ingestion.`
  );
}
