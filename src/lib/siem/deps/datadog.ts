/**
 * Datadog read-only dependency check.
 *
 * Endpoints (all GET, read-only):
 *   GET /api/v1/dashboard                 dashboards (id, title, description), paged by count/start
 *   GET /api/v1/monitor                   monitors (id, type, name, query, options), paged by page/page_size
 *   GET /api/v2/logs/config/metrics       log-based metrics (id, compute, filter.query, group_by), one page
 *
 * Dashboards are matched on title and description only; widget queries need a
 * per-dashboard fetch, too chatty for large accounts on the default path.
 * Log monitors (type `log alert`) and log-based metrics also feed the per-rule
 * check with their parsed log searches.
 *
 * DD_SITE / DATADOG_SITE selects the region (datadoghq.com, datadoghq.eu,
 * us3/us5/ap1.datadoghq.com).
 */

import {
  type DepCheckOptions,
  type DepCheckResult,
  type LogQueryObject,
  type VendorInventory,
  inventoryToDepResult,
} from './types.js';
import { logMonitorSearches } from './datadog-log-queries.js';

const REQUEST_TIMEOUT_MS = 10_000;
const MONITOR_PAGE_SIZE = 1000;
const MONITOR_MAX_PAGES = 10;
const DASHBOARD_PAGE_SIZE = 100;
const DASHBOARD_MAX_PAGES = 50;

function getKeys(): { apiKey?: string; appKey?: string; site?: string } {
  return {
    apiKey: process.env.DD_API_KEY || process.env.DATADOG_API_KEY,
    appKey: process.env.DD_APP_KEY || process.env.DATADOG_APP_KEY,
    site: process.env.DD_SITE || process.env.DATADOG_SITE,
  };
}

function normalizeSite(site: string | undefined): string {
  return (site || 'datadoghq.com')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/^(app|api)\./, '');
}

/** US1 and EU1 serve the app on `app.`; the regional sites serve it on the site host. */
function appUrlFor(site: string): string {
  return /^datadoghq\.(com|eu)$/.test(site) ? `https://app.${site}` : `https://${site}`;
}

function shortError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}

export async function fetchDatadogInventory(): Promise<VendorInventory> {
  const inv: VendorInventory = {
    vendor: 'datadog',
    objects: [],
    notes: [],
    scanDepth: 'monitor queries and dashboard titles/descriptions',
  };
  const { apiKey, appKey, site: rawSite } = getKeys();
  if (!apiKey || !appKey) {
    inv.error = 'Datadog credentials not detected (need DD_API_KEY + DD_APP_KEY)';
    return inv;
  }
  const site = normalizeSite(rawSite);
  const apiBase = `https://api.${site}`;
  const appUrl = appUrlFor(site);
  const headers = { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey, Accept: 'application/json' };

  const get = async (path: string): Promise<unknown> => {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
    }
    return res.json();
  };

  const dashboardObjects: VendorInventory['objects'] = [];
  const monitorObjects: VendorInventory['objects'] = [];
  const logMonitors: LogQueryObject[] = [];
  const logMetricObjects: LogQueryObject[] = [];
  const logNotes: string[] = [];
  let monitorsRead = false;
  let metricsRead = false;

  const dashboards = (async () => {
    try {
      for (let page = 0; page < DASHBOARD_MAX_PAGES; page++) {
        const body = (await get(`/api/v1/dashboard?count=${DASHBOARD_PAGE_SIZE}&start=${page * DASHBOARD_PAGE_SIZE}`)) as {
          dashboards?: Array<{ id?: string; title?: string; description?: string | null }>;
        };
        const list = body.dashboards ?? [];
        for (const d of list) {
          const id = d.id || '';
          const title = d.title || '';
          dashboardObjects.push({
            type: 'dashboard',
            name: title || id,
            url: id ? `${appUrl}/dashboard/${id}` : undefined,
            texts: { name: [title], query: [], definition: [d.description || ''] },
            hasQueryText: false,
          });
        }
        if (list.length < DASHBOARD_PAGE_SIZE) break;
        if (page === DASHBOARD_MAX_PAGES - 1) {
          inv.notes.push(`dashboard list stopped at ${DASHBOARD_PAGE_SIZE * DASHBOARD_MAX_PAGES}`);
        }
      }
      inv.notes.push('dashboard match is title/description only (widget queries need per-dashboard fetches)');
    } catch (e) {
      inv.notes.push(`dashboards list failed: ${shortError(e)}`);
    }
  })();

  const monitors = (async () => {
    try {
      for (let page = 0; page < MONITOR_MAX_PAGES; page++) {
        const list = (await get(
          `/api/v1/monitor?page=${page}&page_size=${MONITOR_PAGE_SIZE}&with_downtimes=false`,
        )) as Array<{
          id?: number;
          type?: string;
          name?: string;
          query?: string;
          message?: string;
          options?: { variables?: unknown };
        }>;
        if (!Array.isArray(list)) throw new Error('unexpected monitor list shape');
        for (const m of list) {
          const id = m.id !== undefined ? String(m.id) : '';
          const name = m.name || '';
          const url = id ? `${appUrl}/monitors/${id}` : undefined;
          monitorObjects.push({
            type: 'monitor',
            name: name || id,
            url,
            texts: { name: [name], query: [m.query || '', m.message || ''], definition: [] },
            hasQueryText: true,
          });
          if (m.type === 'log alert') {
            logMonitors.push({
              kind: 'log_monitor',
              id,
              name: name || id,
              ...(url ? { url } : {}),
              searches: logMonitorSearches(m.query, m.options?.variables),
            });
          }
        }
        if (list.length < MONITOR_PAGE_SIZE) break;
        if (page === MONITOR_MAX_PAGES - 1) {
          const n = MONITOR_PAGE_SIZE * MONITOR_MAX_PAGES;
          inv.notes.push(`monitor list stopped at ${n}`);
          logNotes.push(`monitor list stopped at ${n}`);
        }
      }
      monitorsRead = true;
    } catch (e) {
      inv.notes.push(`monitors list failed: ${shortError(e)}`);
      logNotes.push(`log monitors could not be read (${shortError(e)})`);
    }
  })();

  // Not paginated: the endpoint returns every log-based metric in one response.
  const logMetrics = (async () => {
    try {
      const body = (await get('/api/v2/logs/config/metrics')) as {
        data?: Array<{ id?: string; attributes?: { filter?: { query?: string } } }>;
      };
      if (!Array.isArray(body.data)) throw new Error('unexpected log-based metric list shape');
      for (const d of body.data) {
        const id = d.id || '';
        if (!id) continue;
        logMetricObjects.push({
          kind: 'log_metric',
          id,
          name: id,
          searches: [d.attributes?.filter?.query ?? '*'],
        });
      }
      metricsRead = true;
    } catch (e) {
      inv.notes.push(`log-based metrics list failed: ${shortError(e)}`);
      logNotes.push(`log-based metrics could not be read (${shortError(e)})`);
    }
  })();

  await Promise.all([dashboards, monitors, logMetrics]);
  inv.objects.push(...dashboardObjects, ...monitorObjects);
  inv.logQueries = { objects: [...logMonitors, ...logMetricObjects], monitorsRead, metricsRead, notes: logNotes };
  return inv;
}

export async function checkDatadogDeps(opts: DepCheckOptions): Promise<DepCheckResult> {
  return inventoryToDepResult(await fetchDatadogInventory(), opts.pattern, opts.tokens);
}
