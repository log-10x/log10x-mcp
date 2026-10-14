/**
 * The fleet default: the limit and the route for a service with no rule of
 * its own. One module so the number rule and the user-unit sentences change
 * in one place.
 *
 * Engine semantics this states (config `pipelines/run/receive/rate/
 * rate-object-cap.js`): in each reset window, per statement per container per
 * node, the first `rateReceiverBaselineCount` lines pass; then lines pass while
 * the statement's bytes stay under the cap; above it a line passes with the
 * probability of its severity floor, and the rest take the action.
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
): string {
  const f = Math.min(1, Math.max(0, Number.isFinite(errorFloor) ? errorFloor : defaultErrorFloor(action)));
  const first = `up to ${fmtLinesPerDay(alwaysPassLinesPerDay(alwaysPass))} lines a day of each statement on each node`;
  if (f >= 1) {
    return 'An error monitor sees every ERROR and CRITICAL line: none leaves Standard, whatever the limit.';
  }
  const kept =
    f > 0
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
