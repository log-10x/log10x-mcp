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
    const deadline = Date.now() + PER_HASH_MS;
    const pullOnce = async (q: string): Promise<unknown> => {
      const ms = Math.max(250, deadline - Date.now());
      const res = await Promise.race([
        conn.pullEvents({
          window: opts.window ?? '1h',
          scope: opts.scope,
          query: q,
          targetEventCount: 1,
          maxPullMinutes: 0.25,
          onProgress: () => {},
        }),
        new Promise<null>(r => setTimeout(() => r(null), ms)),
      ]);
      return (res as { events?: unknown[] } | null)?.events?.[0] ?? null;
    };
    await Promise.all(
      uniq.map(async ({ hash: h, severity, service }) => {
        try {
          // Prefer a sample whose severity matches the row it
          // illustrates; fall back to an unconstrained hash sample if
          // the severity-scoped query returns nothing (common here:
          // ~80% of events carry no severity_level, so a hard
          // constraint would zero out the sample for the top rows).
          let ev: unknown = null;
          if (severity) ev = await pullOnce(buildHashQuery(sel.id, h, service, severity));
          if (ev === null) ev = await pullOnce(buildHashQuery(sel.id, h, service));
          if (ev !== null) out.set(h, oneLine(ev));
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
