/**
 * Stamped-identity resolution against the 10x TSDB, the moat layer.
 *
 * The engine stamps every event it processes with a stable pattern
 * identity (`tenx_hash` / `message_pattern`) at ingest, and PERSISTS a
 * per-fingerprint Prometheus time series keyed to it. That identity
 * survives deploys, restarts, pod renames, and request-id churn, a
 * generic agent re-grouping log lines ad hoc cannot reconstruct it, and
 * its grouping decays on the next deploy.
 *
 * This module is the shared resolver for the two directions every
 * investigative tool needs:
 *
 *   reverse  (hash → named pattern):  an opaque `tenx_hash` seen on a
 *            SIEM/CloudWatch event, or surfaced by top_patterns' cross-
 *            pillar join keys, resolved back to the named pattern + its
 *            history. Used by event_lookup, pattern_trend, pattern_examples.
 *
 *   forward  (pattern → authoritative hash):  the snake_case pattern
 *            label resolved to the `tenx_hash` the forwarder actually
 *            wrote (so an exact-hash SIEM probe hits). Used by
 *            pattern_examples; previously lived inline there.
 *
 *   first-seen (history floor for one identity):  the earliest non-zero
 *            bucket for a hash across the retained history, the
 *            zero-setup answer to "is this new / when did it start",
 *            honest about the retention floor. Used by event_lookup,
 *            pattern_trend.
 *
 * Every function is best-effort and returns `undefined`/`null` on any
 * failure (network, malformed response, no series), never throws, so
 * callers fold the result into a richer answer without a try/catch.
 */

import type { EnvConfig } from './environments.js';
import { queryInstant, queryRange } from './api.js';
import { LABELS } from './promql.js';
import { parsePrometheusValue } from './cost.js';

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Reverse lookup: opaque `tenx_hash` → the named pattern that carries
 * it. Counts `all_events` bytes per pattern under the hash filter over
 * the window and returns the dominant pattern. `undefined` when the
 * hash carries no pattern in this env/window (wrong env, or older than
 * the retained history).
 *
 * This is non-replicable by construction: the hash only means something
 * because the engine stamped it at ingest and kept a series for it.
 */
export async function resolvePatternFromHash(
  env: EnvConfig,
  hash: string,
  metricsEnv: string,
  range: string,
): Promise<string | undefined> {
  const h = hash.trim();
  if (!h) return undefined;
  const q =
    `count by (${LABELS.pattern}) (increase(all_events_summaryBytes_total{` +
    `${LABELS.hash}="${escapeLabel(h)}",${LABELS.env}="${escapeLabel(metricsEnv)}"}[${range}]))`;
  const r = await queryInstant(env, q).catch(() => null);
  if (!r || r.status !== 'success') return undefined;
  return r.data.result
    .map((x) => ({ p: x.metric[LABELS.pattern] || '', v: parsePrometheusValue(x) }))
    .filter((x) => x.p)
    .sort((a, b) => b.v - a.v)[0]?.p;
}

/**
 * Forward lookup: a snake_case pattern label → the AUTHORITATIVE
 * `tenx_hash` the forwarder wrote (the same value present in both the
 * TSDB label and the 10x-forwarded SIEM events).
 *
 * Why not just `tenxHash(pattern_name)` locally? The local hash is of
 * the pattern NAME; the engine's emitted `tenx_hash` is of the actual
 * event's symbol sequence, a different input, so the two never match
 * for the SIEM probe. Reading the label the forwarder actually wrote is
 * what makes an exact-hash cross-pillar probe hit. Returns `undefined`
 * when the metrics don't carry the pattern (caller falls back to the
 * local hash, then to phrase tokens).
 *
 * Handles the Reporter's ~80-char `message_pattern` truncation via a
 * prefix-anchored regex fallback (a pure anchor, no wildcard softening,
 * so no fuzziness): all truncated labels for a pattern still start with
 * its first 60 chars, distinctive enough that unrelated patterns won't
 * collide. Most-emitting hash wins.
 */
export async function resolveHashFromPattern(
  env: EnvConfig,
  canonicalPattern: string,
  metricsEnv: string,
): Promise<string | undefined> {
  const pickBest = (
    rows: Array<{ metric?: Record<string, string>; value?: [number, string] }>,
  ): string | undefined => {
    let best: { h: string; v: number } | undefined;
    for (const row of rows) {
      const h = row.metric?.[LABELS.hash];
      if (!h) continue;
      const v = parsePrometheusValue(row);
      if (!best || v > best.v) best = { h, v };
    }
    return best?.h;
  };

  try {
    // 1) Exact match on the (possibly full) snake_case identity.
    const exactQ =
      `count by (${LABELS.hash}) (increase(all_events_summaryBytes_total{` +
      `${LABELS.pattern}="${escapeLabel(canonicalPattern)}",${LABELS.env}="${escapeLabel(metricsEnv)}"}[24h]))`;
    const exact = await queryInstant(env, exactQ).catch(() => null);
    const exactHit = pickBest(exact?.data?.result ?? []);
    if (exactHit) return exactHit;

    // 2) Prefix-anchor fallback for truncated labels. Prometheus `=~`
    //    is fully anchored, so `<prefix>.*` consumes the truncated tail.
    const regexEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = regexEsc(canonicalPattern.slice(0, 60));
    const prefixQ =
      `count by (${LABELS.hash}) (increase(all_events_summaryBytes_total{` +
      `${LABELS.pattern}=~"${prefix}.*",${LABELS.env}="${escapeLabel(metricsEnv)}"}[24h]))`;
    const prefixR = await queryInstant(env, prefixQ).catch(() => null);
    return pickBest(prefixR?.data?.result ?? []);
  } catch {
    return undefined;
  }
}

export interface FirstSeenObservation {
  /** Unix-seconds of the earliest non-zero bucket within the scan, or null. */
  firstSeenUnix: number | null;
  /** Seconds since that bucket, or null. */
  ageSeconds: number | null;
  /**
   * True when the pattern's earliest observed bucket coincides with the
   * env's overall data horizon, i.e. the pattern was ALREADY firing when
   * the retained history begins, so its true onset is older than the TSDB
   * can see. The honest "this is the retention floor, not the birth"
   * signal. When false, the first-seen is a real onset INSIDE the retained
   * window, the pattern genuinely emerged then. Null when the env horizon
   * couldn't be established.
   */
  clampedToRetentionFloor: boolean | null;
  /** Env data horizon (earliest non-zero env-total bucket), unix-seconds. */
  envHorizonUnix: number | null;
}

const HOURLY_STEP = 3600;

/**
 * Scan the earliest non-zero bucket of a range matrix. First non-zero per
 * series, min across series.
 */
function earliestNonZero(
  result: Array<{ values?: [number, string][] }>,
): number | null {
  let earliest: number | null = null;
  for (const series of result) {
    if (!series.values) continue;
    for (const [ts, vStr] of series.values) {
      const v = Number(vStr);
      if (Number.isFinite(v) && v > 0) {
        if (earliest === null || ts < earliest) earliest = ts;
        break;
      }
    }
  }
  return earliest;
}

/**
 * The env's overall data horizon: the earliest non-zero bucket of the
 * env-total series for a metric. Anchors the retention-floor judgement:
 * a pattern whose first-seen equals this predates the retained history.
 */
export async function fetchEnvDataHorizon(
  env: EnvConfig,
  metricsEnv: string,
  metric = 'all_events_summaryBytes_total',
  lookbackSeconds = 60 * 86400,
): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const q = `sum(${metric}{${LABELS.env}="${escapeLabel(metricsEnv)}"})`;
    const res = await queryRange(env, q, now - lookbackSeconds, now, HOURLY_STEP);
    if (res.status !== 'success' || !Array.isArray(res.data.result)) return null;
    return earliestNonZero(res.data.result as Array<{ values?: [number, string][] }>);
  } catch {
    return null;
  }
}

/**
 * First-seen for one stamped identity: scan the retained per-fingerprint
 * history backwards for the earliest non-zero bucket. Keyed on
 * `tenx_hash` (short, exact, robust to the message_pattern label
 * truncation). This is the zero-setup "is this new / when did it start"
 * the moat promises, and it is honest about the retention floor (it
 * cross-checks the env horizon) so the caller never claims a birth date
 * the TSDB can't support.
 *
 * Runs two cheap range scans in parallel (the hash series + the env
 * horizon). Pass a precomputed `envHorizonUnix` to skip the second.
 */
export async function fetchFirstSeenObservation(
  env: EnvConfig,
  hash: string,
  opts: { metricsEnv: string; metric?: string; lookbackSeconds?: number; envHorizonUnix?: number | null },
): Promise<FirstSeenObservation> {
  const metric = opts.metric ?? 'all_events_summaryBytes_total';
  const lookbackSeconds = opts.lookbackSeconds ?? 60 * 86400;
  const empty: FirstSeenObservation = {
    firstSeenUnix: null,
    ageSeconds: null,
    clampedToRetentionFloor: null,
    envHorizonUnix: opts.envHorizonUnix ?? null,
  };
  const h = hash.trim();
  if (!h) return empty;
  const now = Math.floor(Date.now() / 1000);
  try {
    // Scope by env so a hash that appears in more than one env (e.g. edge
    // AND local) reports THIS env's onset, not the cross-env minimum.
    // Mirrors every other query in this file.
    const q = `${metric}{${LABELS.hash}="${escapeLabel(h)}",${LABELS.env}="${escapeLabel(opts.metricsEnv)}"}`;
    const [hashRes, envHorizon] = await Promise.all([
      queryRange(env, q, now - lookbackSeconds, now, HOURLY_STEP),
      opts.envHorizonUnix !== undefined
        ? Promise.resolve(opts.envHorizonUnix)
        : fetchEnvDataHorizon(env, opts.metricsEnv, metric, lookbackSeconds),
    ]);
    if (hashRes.status !== 'success' || !Array.isArray(hashRes.data.result)) {
      return { ...empty, envHorizonUnix: envHorizon };
    }
    const earliest = earliestNonZero(hashRes.data.result as Array<{ values?: [number, string][] }>);
    if (earliest === null) return { ...empty, envHorizonUnix: envHorizon };
    // Clamped iff the pattern's onset coincides (within ~1 day) with the
    // env's data horizon, then it predates retention and the date is a
    // floor, not a birth. Genuinely new patterns onset clearly later.
    const clamped =
      envHorizon === null ? null : earliest - envHorizon <= 86400;
    return {
      firstSeenUnix: earliest,
      ageSeconds: now - earliest,
      clampedToRetentionFloor: clamped,
      envHorizonUnix: envHorizon,
    };
  } catch {
    return empty;
  }
}

/** Format an age (seconds) per the locked time-bucket rule. */
export function fmtAge(ageSeconds: number | null): string {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return '(unknown)';
  if (ageSeconds < 60) return `${Math.floor(ageSeconds)}s ago`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 2 * 86400) return `${Math.floor(ageSeconds / 3600)}h ago`;
  return `${Math.floor(ageSeconds / 86400)}d ago`;
}
