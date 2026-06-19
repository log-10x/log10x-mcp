/**
 * Localization probe for DISPATCHED_BLIND queries.
 *
 * In remote dispatch the coordinator's _DONE counters are structurally blind
 * (it fans work out to subqueries and scans nothing itself). But a SMALL ENOUGH
 * time window forces the coordinator to scan LOCALLY — and then its scanned /
 * matched / skippedSearch / skippedTemplate counters are precise. So to debug a
 * blind zero-result query, the MCP re-submits a narrowed window of the SAME
 * query and reads the local counts, which pinpoint the failing stage
 * (resolve vs bloom vs filter).
 *
 * `narrowWindow` derives that small window at the END of the original range, in
 * the same `now(...)` / epoch syntax the engine accepts, so the probe samples
 * the same index + the same predicate as the original query.
 */

/** Parse a `now()` / `now("-Nx")` bound to seconds-before-now. Returns null for
 *  anything not in that relative form (e.g. an absolute epoch). */
export function nowOffsetSec(v: string): number | null {
  const s = v.trim();
  if (s === 'now()') return 0;
  // now("-5m") / now('-30s') / now(-2h) — quotes optional, sign optional.
  const m = /^now\(\s*["']?\s*-?\s*(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d)?\s*["']?\s*\)$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const u = (m[2] || 's').toLowerCase()[0];
  const mult = u === 's' ? 1 : u === 'm' ? 60 : u === 'h' ? 3600 : u === 'd' ? 86400 : 1;
  return n * mult;
}

/** Absolute bound as epoch-ms: raw epoch-ms, or an ISO8601 timestamp (the form
 *  the MCP normalizes `now(...)` into before dispatch). Null otherwise. */
function epochMs(v: string): number | null {
  const s = v.trim();
  if (/^\d{12,}$/.test(s)) return Number(s);
  // ISO8601 / date string. Guard against `now(...)` (Date.parse would NaN it
  // anyway, but nowOffsetSec is tried first by the caller).
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export interface TimeWindow {
  from: string;
  to: string;
}

/**
 * Derive a `windowSec`-wide window anchored at the END of [from, to], expressed
 * in the engine's accepted syntax. Returns null when neither bound is a
 * recognizable `now(...)` offset or epoch — callers should fall back to a fixed
 * recent window.
 *
 *   narrowWindow('now("-2h")', 'now()', 60)        -> { from: 'now("-60s")',  to: 'now()' }
 *   narrowWindow('now("-15m")', 'now("-10m")', 60) -> { from: 'now("-660s")', to: 'now("-600s")' }
 *   narrowWindow('1781700000000','1781700300000',60)-> { from:'1781700240000', to:'1781700300000' }
 */
export function narrowWindow(
  from: string,
  to: string,
  windowSec = 60,
  skewSec = 0,
): TimeWindow | null {
  // `skewSec` pulls the window back from the `to` anchor so it lands on
  // already-indexed data: the freshest seconds of a range that ends at "now"
  // aren't indexed yet, and a probe there returns a misleading EMPTY_RANGE.
  const toE = epochMs(to);
  if (toE != null) {
    const anchor = toE - skewSec * 1000;
    return { from: String(anchor - windowSec * 1000), to: String(anchor) };
  }
  const toOff = nowOffsetSec(to);
  if (toOff != null) {
    const off = toOff + skewSec;
    return {
      from: `now("-${off + windowSec}s")`,
      to: off === 0 ? 'now()' : `now("-${off}s")`,
    };
  }
  return null;
}

/** A safe recent window when the original bounds can't be parsed: a `windowSec`
 *  slice ending `skewSec` ago (skew avoids the freshest, not-yet-indexed edge). */
export function recentFallbackWindow(windowSec = 60, skewSec = 90): TimeWindow {
  return { from: `now("-${windowSec + skewSec}s")`, to: `now("-${skewSec}s")` };
}
