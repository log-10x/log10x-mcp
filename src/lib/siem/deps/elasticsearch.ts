/**
 * Elasticsearch / Kibana read-only dependency check.
 *
 * Important: dashboards, visualizations, lens objects and alerting rules
 * live in **Kibana**, not in Elasticsearch itself. The ES API key alone
 * cannot enumerate them. We need a Kibana endpoint:
 *
 *   KIBANA_URL                — required to enable in-process scan
 *   KIBANA_API_KEY            — optional override; falls back to ELASTIC_API_KEY
 *
 * Without KIBANA_URL we return a clean error so the caller falls back to
 * the documented bash command.
 *
 * Endpoints used (all GET, read-only):
 *   /api/saved_objects/_find?type=dashboard
 *   /api/saved_objects/_find?type=visualization
 *   /api/saved_objects/_find?type=lens
 *   /api/alerting/rules/_find          (Kibana 7.16+)
 */

import {
  type DepCheckOptions,
  type DepCheckResult,
  type VendorInventory,
  inventoryToDepResult,
} from './types.js';

interface KConn {
  url: string;
  apiKey?: string;
  username?: string;
  password?: string;
}

function getKibanaConn(): KConn | null {
  const url = process.env.KIBANA_URL;
  if (!url) return null;
  const cleanUrl = url.replace(/\/+$/, '');
  const apiKey = process.env.KIBANA_API_KEY || process.env.ELASTIC_API_KEY || process.env.ELASTICSEARCH_API_KEY;
  if (apiKey) return { url: cleanUrl, apiKey };
  const username = process.env.KIBANA_USERNAME || process.env.ELASTIC_USERNAME || process.env.ELASTICSEARCH_USERNAME;
  const password = process.env.KIBANA_PASSWORD || process.env.ELASTIC_PASSWORD || process.env.ELASTICSEARCH_PASSWORD;
  if (username && password) return { url: cleanUrl, username, password };
  return { url: cleanUrl };
}

function authHeader(conn: KConn): string | undefined {
  if (conn.apiKey) return `ApiKey ${conn.apiKey}`;
  if (conn.username && conn.password) {
    return 'Basic ' + Buffer.from(`${conn.username}:${conn.password}`).toString('base64');
  }
  return undefined;
}

async function kibanaGet(conn: KConn, path: string): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    // Kibana requires this on most endpoints to confirm cross-site protection awareness.
    'kbn-xsrf': 'true',
  };
  const auth = authHeader(conn);
  if (auth) headers.Authorization = auth;
  const r = await fetch(`${conn.url}${path}`, { headers });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`kibana ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

interface SavedObjectsHit {
  id: string;
  type: string;
  attributes?: { title?: string; description?: string };
}

interface AlertingRuleHit {
  id: string;
  name: string;
  rule_type_id?: string;
  params?: Record<string, unknown>;
}

async function fetchSavedObjects(
  conn: KConn,
  type: string,
  inv: VendorInventory,
): Promise<void> {
  let page = 1;
  const perPage = 100;
  let total = Infinity;
  while ((page - 1) * perPage < total && page <= 20) {
    const data = (await kibanaGet(
      conn,
      `/api/saved_objects/_find?type=${type}&per_page=${perPage}&page=${page}&fields=title&fields=description`
    )) as { saved_objects?: SavedObjectsHit[]; total?: number };
    total = data.total ?? 0;
    for (const o of data.saved_objects || []) {
      const title = o.attributes?.title || '';
      const desc = o.attributes?.description || '';
      inv.objects.push({
        type: 'dashboard',
        name: title || o.id,
        url: `${conn.url}/app/${type === 'dashboard' ? 'dashboards#/view/' + encodeURIComponent(o.id) : 'visualize#/edit/' + encodeURIComponent(o.id)}`,
        texts: { name: [title], query: [], definition: [desc] },
        hasQueryText: false,
      });
    }
    page++;
  }
}

export async function fetchElasticsearchInventory(): Promise<VendorInventory> {
  const inv: VendorInventory = {
    vendor: 'elasticsearch',
    objects: [],
    notes: [],
    scanDepth: 'dashboard/visualization titles/descriptions and alerting-rule params',
  };
  const conn = getKibanaConn();
  if (!conn) {
    inv.error =
      'Kibana endpoint not configured (set KIBANA_URL, plus KIBANA_API_KEY or ELASTIC_API_KEY). Saved-object dependency scan needs Kibana, not bare Elasticsearch.';
    return inv;
  }

  // Dashboards, visualizations, lens — all surfaced as dashboard-type objects.
  for (const type of ['dashboard', 'visualization', 'lens']) {
    try {
      await fetchSavedObjects(conn, type, inv);
    } catch (e) {
      inv.notes.push(`${type} _find failed: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  inv.notes.push('saved-object match is title/description only (panel queries are not in the _find projection)');

  // Alerting rules (Kibana 7.16+). Endpoint may 404 on older clusters — non-fatal.
  try {
    const data = (await kibanaGet(
      conn,
      `/api/alerting/rules/_find?per_page=100&page=1`
    )) as { data?: AlertingRuleHit[] };
    for (const r of data.data || []) {
      const name = r.name || '';
      const params = r.params ? JSON.stringify(r.params) : '';
      inv.objects.push({
        type: 'alert',
        name: name || r.id,
        url: `${conn.url}/app/management/insightsAndAlerting/triggersActions/rule/${encodeURIComponent(r.id)}`,
        texts: { name: [name], query: [params], definition: [] },
        hasQueryText: true,
      });
    }
  } catch (e) {
    inv.notes.push(
      `alerting rules _find failed (cluster may pre-date 7.16): ${(e as Error).message.slice(0, 200)}`
    );
  }

  return inv;
}

export async function checkElasticsearchDeps(opts: DepCheckOptions): Promise<DepCheckResult> {
  return inventoryToDepResult(await fetchElasticsearchInventory(), opts.pattern, opts.tokens);
}
