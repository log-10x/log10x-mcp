/**
 * One labeled live sample event from the SIEM, fetched by exact
 * tenx_hash. Used by event_lookup on the reverse cross-pillar lookup
 * (opaque SIEM hash -> named pattern): after recovering the pattern +
 * cost from the 10x metrics, this pulls a single real event the
 * forwarder shipped, so the human sees the actual line behind the
 * hash, not just the name.
 *
 * Best effort and silent: if no SIEM is unambiguously available, or
 * the probe errors / returns nothing, it returns null and the caller
 * simply omits the sample. It never blocks or fails the lookup. The
 * pull is hard-bounded (1 event, 30s) so a misconfigured SIEM cannot
 * stall event_lookup.
 */
import { resolveSiemSelection } from './resolve.js';
import { getConnector } from './index.js';
import { buildHashQuery } from './hash-query.js';

export interface HashSample {
  vendor: string;
  displayName: string;
  /** Single truncated line, ready to print. */
  line: string;
}

/** Pull the real log payload out of one event, unwrapping the
 * transport envelope. SIEM events commonly arrive as the
 * fluentd/docker shape `{"stream":..,"log":"<real line>","docker":..}`
 * (or a JSON string of it). The `.log`/`.message` field is the actual
 * log; the wrapper is transport metadata. Unwrapping is more faithful
 * to "what is this pattern", not less. One level only, defensive. */
function oneLine(ev: unknown, max = 220): string {
  const pickStr = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const p = o.log ?? o.message ?? o._raw ?? o.body;
      return typeof p === 'string' ? p : JSON.stringify(o);
    }
    return String(v);
  };
  let s = pickStr(ev);
  // Unwrap up to two transport envelopes: the SIEM event often arrives
  // as {message:'{"stream":..,"log":"<real line>",..}'} (CW) so the
  // real payload is one or two JSON levels in. Try-parse is the test
  // (a startsWith/endsWith gate misses huge or noisy envelopes).
  for (let i = 0; i < 2; i++) {
    const t = s.trim();
    if (t.length < 2 || t[0] !== '{') break;
    try {
      const parsed = JSON.parse(t) as unknown;
      if (parsed && typeof parsed === 'object') {
        const next = pickStr(parsed);
        if (next && next !== s) { s = next; continue; }
      }
    } catch { /* not JSON: stop unwrapping */ }
    break;
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + ' ...' : s;
}

/**
 * Resolve the SIEM ONCE, then pull one real event per hash in
 * parallel. For the top_patterns list: a verbatim sample is the
 * readable identity of a pattern (the tokenized name degenerates to
 * field-soup for JSON logs), and it is ground truth, not fabrication.
 *
 * Zero-egress consistent: the events + tenx_hash are already in the
 * user's own SIEM; the agent reads them with the user's creds. No new
 * data plane, no bucket, no extra forwarder reach. Best-effort and
 * silent: no SIEM resolved / a hash with no hit / any error -> that
 * hash is simply absent from the returned map.
 *
 * Each hash is bounded by its OWN timeout, not an all-or-nothing batch
 * timeout. A hash with no events (e.g. a pattern the forwarder drops)
 * makes the SIEM scan the whole window and is the slowest possible
 * query; with a batch-level race that one query would sink every other
 * sample (observed: run-to-run flicker between all samples and none).
 * Per-hash bounding means a slow/empty hash costs only its own row.
 * The probe window is short on purpose: a recent sample is enough, and
 * an empty match fails fast instead of scanning hours.
 */
const PER_HASH_MS = 2500;

export interface HashSpec {
  hash: string;
  /** Constrain the sample to this severity so the example matches the
   * row it illustrates (a pattern hash is severity-agnostic; without
   * this an ERROR-tagged row can show an INFO sample, contradicting
   * its own cut-risk tag). */
  severity?: string;
  service?: string;
}

export async function fetchSamplesByHashes(
  specs: Array<HashSpec | string>,
  opts: { scope?: string; window?: string } = {}
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const norm: HashSpec[] = specs
    .map(s => (typeof s === 'string' ? { hash: s } : s))
    .map(s => ({ ...s, hash: s.hash?.trim() }))
    .filter(s => s.hash);
  // de-dupe by hash, keeping the first spec (carries severity/service)
  const seen = new Set<string>();
  const uniq = norm.filter(s => (seen.has(s.hash) ? false : (seen.add(s.hash), true)));
  if (uniq.length === 0) return out;
  try {
    const sel = await resolveSiemSelection({});
    if (sel.kind !== 'resolved') return out; // no unambiguous SIEM: silent
    const conn = getConnector(sel.id);
    // Each query gets its OWN independent PER_HASH_MS bound. A previous
    // version shared one budget across a severity-then-fallback
    // sequence; the severity query (slow + empty here, since ~80% of
    // events carry no severity_level) ate the budget and starved the
    // fallback, so the top rows lost their sample entirely (worse than
    // a severity-mismatched sample). Run both in PARALLEL, prefer the
    // severity-matched result, fall back to the unconstrained one.
    const pullOnce = async (q: string): Promise<unknown> => {
      const res = await Promise.race([
        conn.pullEvents({
          window: opts.window ?? '1h',
          scope: opts.scope,
          query: q,
          targetEventCount: 1,
          maxPullMinutes: 0.25,
          onProgress: () => {},
        }),
        new Promise<null>(r => setTimeout(() => r(null), PER_HASH_MS)),
      ]);
      return (res as { events?: unknown[] } | null)?.events?.[0] ?? null;
    };
    // CloudWatch enriched events only carry `tenx_hash` as a queryable
    // top-level field; tenx_user_service / severity_level live under
    // kubernetes.* and are NOT selectable, so constraining by them
    // returns nothing. Splunk/Datadog/ES DO carry them as fields (the
    // 10x forwarder sets them), so a severity-matched sample is both
    // possible and better there. Hence: hash-only for CloudWatch;
    // severity-matched-with-fallback elsewhere.
    const cwLike = sel.id === 'cloudwatch';
    await Promise.all(
      uniq.map(async ({ hash: h, severity, service }) => {
        try {
          let ev: unknown;
          if (cwLike || !severity) {
            ev = await pullOnce(buildHashQuery(sel.id, h));
          } else {
            const [matched, any] = await Promise.all([
              pullOnce(buildHashQuery(sel.id, h, service, severity)),
              pullOnce(buildHashQuery(sel.id, h, service)),
            ]);
            ev = matched ?? any;
          }
          if (ev !== null && ev !== undefined) out.set(h, oneLine(ev));
        } catch {
          /* skip this hash; never fail the batch */
        }
      })
    );
  } catch {
    /* no SIEM / discovery error: return whatever we have (likely empty) */
  }
  return out;
}

/**
 * Parsed SIEM event used by field-variation analysis. The Python prototype
 * does this client-side after pulling 250 events per hash via the AWS CLI;
 * the TS port does it via the same connector that `fetchSamplesByHashes`
 * uses, so it shares the SIEM auth / scope / retry plumbing.
 */
export interface ParsedSiemEvent {
  /** Original SIEM event (whatever the connector returned). */
  raw: unknown;
  /** The unwrapped log line text — same logic as oneLine but un-truncated. */
  logLine: string;
  /** If the log line has a JSON object tail (otelcol envelopes,
   *  structured logs), the parsed object. `null` for plaintext lines
   *  or unparseable bodies (e.g. multi-line JSON `{` openers). */
  logJson: Record<string, unknown> | null;
  /** Kubernetes metadata pulled from the transport envelope, if present. */
  k8s?: { container?: string; pod?: string; namespace?: string };
  /** Unix-ms timestamp from the SIEM event, if extractable. */
  timestampMs?: number;
}

/** Like oneLine, but returns the full unwrapped string AND the JSON tail
 * (if any). No truncation here — caller decides. */
function parseEvent(ev: unknown): ParsedSiemEvent {
  const result: ParsedSiemEvent = { raw: ev, logLine: '', logJson: null };

  // Pull timestamp + k8s from the outer envelope before unwrapping.
  if (ev && typeof ev === 'object') {
    const outer = ev as Record<string, unknown>;
    const ts = outer.timestamp ?? outer['@timestamp'] ?? outer._time;
    if (typeof ts === 'number') result.timestampMs = ts;
    else if (typeof ts === 'string') {
      const n = Number(ts);
      if (Number.isFinite(n)) result.timestampMs = n;
      else {
        const d = Date.parse(ts);
        if (Number.isFinite(d)) result.timestampMs = d;
      }
    }
  }

  // Two-level transport envelope unwrap (CloudWatch wraps the fluentd
  // record in a `message` JSON string; the fluentd record itself has
  // `log` for the raw log line + `kubernetes` for the metadata).
  const pickStr = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      // Capture k8s metadata if we see it
      if (o.kubernetes && typeof o.kubernetes === 'object') {
        const k = o.kubernetes as Record<string, unknown>;
        result.k8s = {
          container: typeof k.container_name === 'string' ? k.container_name : undefined,
          pod: typeof k.pod_name === 'string' ? k.pod_name : undefined,
          namespace: typeof k.namespace_name === 'string' ? k.namespace_name : undefined,
        };
      }
      const p = o.log ?? o.message ?? o._raw ?? o.body;
      return typeof p === 'string' ? p : JSON.stringify(o);
    }
    return String(v);
  };

  let s = pickStr(ev);
  for (let i = 0; i < 2; i++) {
    const t = s.trim();
    if (t.length < 2 || t[0] !== '{') break;
    try {
      const parsed = JSON.parse(t) as unknown;
      if (parsed && typeof parsed === 'object') {
        const next = pickStr(parsed);
        if (next && next !== s) {
          s = next;
          continue;
        }
      }
    } catch {
      /* not JSON: stop unwrapping */
    }
    break;
  }
  result.logLine = s.replace(/\s+/g, ' ').trim();

  // Parse the JSON tail in the log line (otelcol envelopes etc.)
  // Look for the first `{` and try to parse the substring from there.
  // Defensive: ignore parse errors (multi-line `{` openers, unstructured
  // logs, etc.) — caller treats absence as "no field variation possible
  // for this row".
  const jsonStart = s.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(s.slice(jsonStart));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        result.logJson = parsed as Record<string, unknown>;
      }
    } catch {
      /* unparseable tail — leave logJson null */
    }
  }
  return result;
}

/**
 * Pull N events per hash, parsed. Used by field-variation analysis in
 * `top_patterns` to compute distinct-values-per-field across the events
 * that match a pattern's hash. Same SIEM auth + scope + per-hash timeout
 * as `fetchSamplesByHashes`, just returning the underlying events
 * (parsed) instead of a single line.
 *
 * Per-hash timeout is wider than the single-sample case (5s vs 2.5s)
 * because 250 events is a heavier SIEM query than 1.
 */
/** Per-hash timeout for the parsed-events batch fetch. Wider than the
 * single-sample timeout because 50–250 events is a heavier query than 1
 * and parallel SIEM queries can hit per-tenant rate limits. */
const PER_HASH_BATCH_MS = 15000;

export async function fetchEventsByHashes(
  specs: Array<HashSpec | string>,
  opts: { scope?: string; window?: string; perHash?: number } = {}
): Promise<Map<string, ParsedSiemEvent[]>> {
  const out = new Map<string, ParsedSiemEvent[]>();
  const target = opts.perHash ?? 250;
  const norm: HashSpec[] = specs
    .map(s => (typeof s === 'string' ? { hash: s } : s))
    .map(s => ({ ...s, hash: s.hash?.trim() }))
    .filter(s => s.hash);
  const seen = new Set<string>();
  const uniq = norm.filter(s => (seen.has(s.hash) ? false : (seen.add(s.hash), true)));
  if (uniq.length === 0) return out;
  try {
    const sel = await resolveSiemSelection({});
    if (sel.kind !== 'resolved') return out;
    const conn = getConnector(sel.id);
    await Promise.all(
      uniq.map(async ({ hash: h, severity, service }) => {
        try {
          const cwLike = sel.id === 'cloudwatch';
          const q = cwLike || !severity
            ? buildHashQuery(sel.id, h)
            : buildHashQuery(sel.id, h, service, severity);
          const res = await Promise.race([
            conn.pullEvents({
              window: opts.window ?? '1h',
              scope: opts.scope,
              query: q,
              targetEventCount: target,
              maxPullMinutes: 0.5,
              onProgress: () => {},
            }),
            new Promise<null>(r => setTimeout(() => r(null), PER_HASH_BATCH_MS)),
          ]);
          const events = (res as { events?: unknown[] } | null)?.events ?? [];
          if (events.length > 0) {
            out.set(h, events.map(parseEvent));
          }
        } catch {
          /* skip this hash */
        }
      })
    );
  } catch {
    /* no SIEM / discovery error */
  }
  return out;
}

export async function fetchOneSampleByHash(opts: {
  hash: string;
  service?: string;
  severity?: string;
  /** SIEM scope (CloudWatch log group, ES index, Splunk index). */
  scope?: string;
  /** Lookback window for the probe. Default 6h. */
  window?: string;
}): Promise<HashSample | null> {
  const hash = opts.hash?.trim();
  if (!hash) return null;
  try {
    const sel = await resolveSiemSelection({});
    // Only proceed on an unambiguous single SIEM. 'ambiguous' / 'none'
    // -> skip silently rather than guess or probe everything.
    if (sel.kind !== 'resolved') return null;
    const conn = getConnector(sel.id);
    const res = await conn.pullEvents({
      window: opts.window ?? '6h',
      scope: opts.scope,
      query: buildHashQuery(sel.id, hash, opts.service, opts.severity),
      targetEventCount: 1,
      maxPullMinutes: 0.5,
      onProgress: () => {},
    });
    const ev = res?.events?.[0];
    if (ev === undefined || ev === null) return null;
    return { vendor: sel.id, displayName: sel.displayName, line: oneLine(ev) };
  } catch {
    return null;
  }
}
