/**
 * Read-only access to the per-pattern series the engine's Datadog metric
 * output publishes (`pipelines/run/output/metric/datadog/config.yaml`).
 *
 * Names. The output posts Micrometer step counters named
 * `<aggregator>_<counterField>`: `emitted_events_summaryVolume` (lines that
 * left the Receiver, any route except drop) and `emitted_events_summaryBytes`,
 * plus the `all_events_*` pair. Datadog keeps the name as posted.
 *
 * Tags. The output's `tagFields` are message_pattern, tenx_hash,
 * tenx_user_service, severity_level, routeState, k8s_container and
 * k8s_namespace; tenx_env and tenx_app ride as runtime attributes. Datadog
 * normalizes metric tag keys to lowercase
 * (docs.datadoghq.com/getting_started/tagging/), so routeState is queried as
 * `routestate`. The team label (`tenx_team`) appears once the k8s team label
 * ships; callers include it only when the series carry it.
 *
 * The generic DatadogBackend in metrics-backend.ts answers PromQL and reads a
 * fixed recent window; the weekly report needs explicit from/to and the same
 * query text the monitors use, so it reads Datadog's query API directly.
 * Every request here is a GET.
 */

import { backendJsonFetch } from './backend-fetch.js';

export const DD_VOLUME_METRIC = 'emitted_events_summaryVolume';
export const DD_BYTES_METRIC = 'emitted_events_summaryBytes';

export const DD_TAGS = {
  pattern: 'message_pattern',
  hash: 'tenx_hash',
  service: 'tenx_user_service',
  severity: 'severity_level',
  route: 'routestate',
  container: 'k8s_container',
  namespace: 'k8s_namespace',
  env: 'tenx_env',
  team: 'tenx_team',
} as const;

/**
 * Route values whose lines left the Standard index. The emitted series never
 * carries `drop` (its aggregator filters dropped lines out), and `sample` and
 * `compact` lines still reach Standard.
 */
export const HELD_ROUTES: ReadonlySet<string> = new Set(['tier_down', 'offload']);

/** An API and application key pair, or a personal access token sent as a Bearer token. */
export type DatadogMetricsCreds =
  | { site: string; apiKey: string; appKey: string; pat?: undefined }
  | { site: string; pat: string; apiKey?: undefined; appKey?: undefined };

/**
 * Credentials from the environment, read the way the Datadog logs connector
 * reads them (DD_* first, DATADOG_* as fallback): DD_PAT when set, else the
 * DD_API_KEY and DD_APP_KEY pair. Undefined when neither is complete. The
 * site defaults to US1, as the connector's SDK does.
 */
export function datadogMetricsCredsFromEnv(siteOverride?: string): DatadogMetricsCreds | undefined {
  const site = siteOverride || process.env.DD_SITE || process.env.DATADOG_SITE || 'datadoghq.com';
  const pat = process.env.DD_PAT || process.env.DATADOG_PAT;
  if (pat) return { site, pat };
  const apiKey = process.env.DD_API_KEY || process.env.DATADOG_API_KEY;
  const appKey = process.env.DD_APP_KEY || process.env.DATADOG_APP_KEY;
  if (!apiKey || !appKey) return undefined;
  return { site, apiKey, appKey };
}

export function datadogApiBase(site: string): string {
  const bare = site.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/^api\./, '');
  return `https://api.${bare}`;
}

export interface DdSeries {
  tags: Record<string, string>;
  /** Sum of the non-null points: the total over the window for an `.as_count()` query. */
  total: number;
  /** Earliest non-zero point, unix seconds; null when every point is zero. */
  firstNonZeroSec: number | null;
}

interface DdQueryResponse {
  status?: string;
  error?: string;
  series?: Array<{
    tag_set?: string[];
    scope?: string;
    pointlist?: Array<[number, number | null]>;
  }>;
}

function headers(creds: DatadogMetricsCreds): Record<string, string> {
  if (creds.pat) return { Authorization: `Bearer ${creds.pat}`, Accept: 'application/json' };
  return {
    'DD-API-KEY': creds.apiKey!,
    'DD-APPLICATION-KEY': creds.appKey!,
    Accept: 'application/json',
  };
}

function parseTagSet(tagSet: string[] | undefined, scope: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = tagSet && tagSet.length > 0 ? tagSet : (scope ?? '').split(',');
  for (const raw of parts) {
    const t = raw.trim();
    const i = t.indexOf(':');
    if (i <= 0) continue;
    out[t.slice(0, i).toLowerCase()] = t.slice(i + 1);
  }
  return out;
}

/**
 * Run one Datadog metrics query over [fromSec, toSec] (GET /api/v1/query)
 * and return one row per group with the window total.
 */
export async function ddQueryWindow(
  creds: DatadogMetricsCreds,
  query: string,
  fromSec: number,
  toSec: number,
  timeoutMs?: number,
): Promise<DdSeries[]> {
  const url = new URL('/api/v1/query', datadogApiBase(creds.site));
  url.searchParams.set('from', String(Math.floor(fromSec)));
  url.searchParams.set('to', String(Math.floor(toSec)));
  url.searchParams.set('query', query);
  const res = await backendJsonFetch<DdQueryResponse>(
    url.toString(),
    { method: 'GET', headers: headers(creds) },
    { kindLabel: 'datadog', timeoutMs },
  );
  if (res.status === 'error') {
    throw new Error(`datadog query error: ${res.error ?? '(no message)'}`);
  }
  return (res.series ?? []).map((s) => {
    let total = 0;
    let first: number | null = null;
    for (const [ts, v] of s.pointlist ?? []) {
      if (v === null || !Number.isFinite(v)) continue;
      total += v;
      if (v > 0 && (first === null || ts < first)) first = ts;
    }
    return {
      tags: parseTagSet(s.tag_set, s.scope),
      total,
      firstNonZeroSec: first === null ? null : Math.floor(first / 1000),
    };
  });
}

/**
 * Tag keys present on a metric (GET /api/v2/metrics/{name}/all-tags).
 * Used to include the team tag only once the series carry it.
 */
export async function ddMetricTagKeys(
  creds: DatadogMetricsCreds,
  metric: string,
  timeoutMs?: number,
): Promise<Set<string>> {
  const url = new URL(`/api/v2/metrics/${encodeURIComponent(metric)}/all-tags`, datadogApiBase(creds.site));
  const res = await backendJsonFetch<{
    data?: { attributes?: { tags?: string[]; ingested_tags?: string[] } };
  }>(url.toString(), { method: 'GET', headers: headers(creds) }, { kindLabel: 'datadog', timeoutMs });
  const keys = new Set<string>();
  const attrs = res.data?.attributes;
  for (const t of [...(attrs?.tags ?? []), ...(attrs?.ingested_tags ?? [])]) {
    const i = t.indexOf(':');
    keys.add((i > 0 ? t.slice(0, i) : t).toLowerCase());
  }
  return keys;
}

/** Datadog scope from tag filters; `*` when empty. */
export function ddScope(filters: Array<string | undefined>): string {
  const parts = filters.filter((f): f is string => !!f && f.length > 0);
  return parts.length === 0 ? '*' : parts.join(' AND ');
}

export interface DdPointSeries {
  tags: Record<string, string>;
  /** [unix seconds, value], null points left out. */
  points: Array<[number, number]>;
}

/**
 * Run one Datadog metrics query over [fromSec, toSec] (GET /api/v1/query)
 * and return each group's points.
 */
export async function ddQueryPoints(
  creds: DatadogMetricsCreds,
  query: string,
  fromSec: number,
  toSec: number,
  timeoutMs?: number,
): Promise<DdPointSeries[]> {
  const url = new URL('/api/v1/query', datadogApiBase(creds.site));
  url.searchParams.set('from', String(Math.floor(fromSec)));
  url.searchParams.set('to', String(Math.floor(toSec)));
  url.searchParams.set('query', query);
  const res = await backendJsonFetch<DdQueryResponse>(
    url.toString(),
    { method: 'GET', headers: headers(creds) },
    { kindLabel: 'datadog', timeoutMs },
  );
  if (res.status === 'error') {
    throw new Error(`datadog query error: ${res.error ?? '(no message)'}`);
  }
  return (res.series ?? []).map((s) => ({
    tags: parseTagSet(s.tag_set, s.scope),
    points: (s.pointlist ?? [])
      .filter((p): p is [number, number] => p[1] !== null && Number.isFinite(p[1]))
      .map(([ts, v]) => [Math.floor(ts / 1000), v] as [number, number]),
  }));
}
