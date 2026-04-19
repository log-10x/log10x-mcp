/**
 * SIEM connector registry.
 *
 * Every connector implements the same `SiemConnector` interface so the
 * poc-from-siem tool can iterate them for credential discovery and pick
 * one by id for event pulls.
 *
 * Adding a new SIEM:
 *   1. Implement a `SiemConnector` in its own file under src/lib/siem/
 *   2. Export it here in `ALL_CONNECTORS`
 *   3. Add its id to `SiemId` in pricing.ts
 *   4. Add defaults to `DEFAULT_ANALYZER_COST_PER_GB`
 */

import type { SiemId } from './pricing.js';
import { SIEM_DISPLAY_NAMES } from './pricing.js';
import { cloudwatchConnector } from './cloudwatch.js';
import { datadogConnector } from './datadog.js';
import { sumoConnector } from './sumo.js';
import { gcpLoggingConnector } from './gcp-logging.js';
import { elasticsearchConnector } from './elasticsearch.js';
import { azureMonitorConnector } from './azure-monitor.js';
import { splunkConnector } from './splunk.js';
import { clickhouseConnector } from './clickhouse.js';

export type CredentialSource = 'env' | 'cli_config' | 'ambient' | 'none';

export interface CredentialDiscovery {
  available: boolean;
  source: CredentialSource;
  details?: Record<string, unknown>;
}

export interface SiemSchemaOverride {
  timestampColumn?: string;
  messageColumn?: string;
  serviceColumn?: string;
  severityColumn?: string;
  table?: string;
}

export interface PullEventsOptions {
  window: string;
  scope?: string;
  query?: string;
  targetEventCount: number;
  maxPullMinutes: number;
  onProgress: (p: { step: string; pct: number; eventsFetched: number }) => void;
  schemaOverride?: SiemSchemaOverride;
}

export type PullStopReason = 'target_reached' | 'time_exhausted' | 'source_exhausted' | 'error';

export interface PullEventsResult {
  events: unknown[];
  metadata: {
    actualCount: number;
    truncated: boolean;
    queryUsed: string;
    reasonStopped: PullStopReason;
    notes?: string[];
  };
}

export interface SiemConnector {
  id: SiemId;
  displayName: string;
  discoverCredentials(): Promise<CredentialDiscovery>;
  pullEvents(opts: PullEventsOptions): Promise<PullEventsResult>;
}

export const ALL_CONNECTORS: SiemConnector[] = [
  cloudwatchConnector,
  datadogConnector,
  sumoConnector,
  gcpLoggingConnector,
  elasticsearchConnector,
  azureMonitorConnector,
  splunkConnector,
  clickhouseConnector,
];

const BY_ID = new Map<SiemId, SiemConnector>(ALL_CONNECTORS.map((c) => [c.id, c]));

export function getConnector(id: string): SiemConnector {
  const hit = BY_ID.get(id as SiemId);
  if (!hit) {
    throw new Error(
      `Unknown SIEM id "${id}". Valid ids: ${ALL_CONNECTORS.map((c) => c.id).join(', ')}.`
    );
  }
  return hit;
}

export interface DiscoveredConnector {
  id: SiemId;
  displayName: string;
  detection: CredentialDiscovery;
}

/** Run credential discovery on every registered connector in parallel. */
export async function discoverAvailable(): Promise<DiscoveredConnector[]> {
  const results = await Promise.all(
    ALL_CONNECTORS.map(async (c) => ({
      id: c.id,
      displayName: c.displayName,
      detection: await safeDiscover(c),
    }))
  );
  return results;
}

async function safeDiscover(c: SiemConnector): Promise<CredentialDiscovery> {
  try {
    return await c.discoverCredentials();
  } catch (e) {
    // Never let a connector's discovery probe throw — downgrade to "not configured".
    return {
      available: false,
      source: 'none',
      details: { discovery_error: (e as Error).message },
    };
  }
}

/**
 * Parse a window expression like `1h`, `24h`, `7d`, `30d` into milliseconds.
 * Accepts minute/hour/day suffixes. Throws on invalid input.
 */
export function parseWindowMs(expr: string): number {
  const m = expr.trim().match(/^(\d+)([smhd])$/i);
  if (!m) throw new Error(`Invalid window "${expr}". Expected format like "1h", "24h", "7d".`);
  const n = parseInt(m[1], 10);
  switch (m[2].toLowerCase()) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'd':
      return n * 86_400_000;
    default:
      throw new Error(`Invalid window unit in "${expr}"`);
  }
}

export { SIEM_DISPLAY_NAMES };
export type { SiemId } from './pricing.js';
