/**
 * Shared receiver-in-path probe helpers.
 *
 * Extracted from pattern-mitigate.ts so discover_env can reuse the same
 * SIEM-event tenx_hash detection without duplicating logic.
 *
 * Usage:
 *   import { probeReceiverInPath } from '../lib/receiver-probe.js';
 *   const result = await probeReceiverInPath(vendor, connector);
 *   // true  → Receiver is in-path (tenx_hash seen in recent events)
 *   // false → Receiver not in-path (no hash in sample)
 *   // null  → Inconclusive (no events in window or connector error)
 */

import type { SiemConnector } from './siem/index.js';

/**
 * Probe the SIEM for 1–3 recent events and check if any carry tenx_hash.
 * Returns true  → Receiver is in-path (hash stamp confirmed)
 * Returns false → No hash found in sample (Receiver likely absent or bypassed)
 * Returns null  → Probe failed / SIEM unavailable (inconclusive)
 *
 * Uses a 5-minute window and limit=3 so the probe is fast and non-intrusive.
 */
export async function probeReceiverInPath(
  _vendor: string,
  connector: SiemConnector,
): Promise<boolean | null> {
  try {
    const probe = await connector.pullEvents({
      window: '5m',
      query: '',
      targetEventCount: 3,
      maxPullMinutes: 1,
      onProgress: () => { /* swallow */ },
      buckets: 1,
    });

    if (probe.events.length === 0) {
      // No events in the last 5 min — inconclusive, not confirmed absent.
      return null;
    }

    for (const evt of probe.events) {
      if (eventHasTenxHash(evt)) return true;
    }
    return false;
  } catch {
    return null;
  }
}

/**
 * Check whether a raw SIEM event (any shape) carries tenx_hash.
 * Handles flat objects and nested envelopes (docker/kubernetes/log field).
 */
export function eventHasTenxHash(evt: unknown): boolean {
  if (typeof evt === 'string') {
    try {
      return eventHasTenxHash(JSON.parse(evt));
    } catch {
      // Plain-text event — check for "tenx_hash" substring (e.g. key=value in raw log)
      return evt.includes('tenx_hash');
    }
  }
  if (typeof evt !== 'object' || evt === null) return false;
  const obj = evt as Record<string, unknown>;
  // Flat top-level field (Datadog, ES, CloudWatch JSON events)
  if ('tenx_hash' in obj) return true;
  // Nested under common envelope keys.
  //
  // 'message' covers CloudWatch (the actual event JSON is wrapped in a
  // message string field), 'log' covers fluentd-style envelopes, '_raw'
  // covers Splunk, the rest covers Datadog / OTel / ES variants.
  //
  // Note: 'message' is a string in CloudWatch's case — the recursive call
  // hits the string branch above, JSON.parses it, and re-enters here on
  // the parsed object.
  for (const key of ['message', '_raw', 'attributes', 'docker', 'kubernetes', 'log', 'fields', 'extra']) {
    const sub = obj[key];
    if (sub && (typeof sub === 'object' || typeof sub === 'string') && eventHasTenxHash(sub)) return true;
  }
  return false;
}
