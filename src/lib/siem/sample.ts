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

function oneLine(ev: unknown, max = 220): string {
  let s: string;
  if (typeof ev === 'string') {
    s = ev;
  } else if (ev && typeof ev === 'object') {
    const o = ev as Record<string, unknown>;
    const pick = o.message ?? o.log ?? o._raw ?? o.body;
    s = typeof pick === 'string' ? pick : JSON.stringify(o);
  } else {
    s = String(ev);
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + ' ...' : s;
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
