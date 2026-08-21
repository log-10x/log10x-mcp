/**
 * Splunk read-only dependency check.
 *
 * Endpoints used (all GET, all read-only):
 *   /services/saved/searches?output_mode=json&count=0
 *     → covers BOTH saved searches and scheduled alerts. Distinguishes
 *       via `entry.content.alert.track === '1'` and `alert_type !== ''`.
 *   /servicesNS/-/-/data/ui/views?output_mode=json&count=0
 *     → dashboard XML (Simple XML or Studio). Match against title + body.
 *
 * Auth reuses the same env var resolution as the POC connector (SPLUNK_HOST
 * + SPLUNK_TOKEN, basic auth fallback, ~/.splunkrc).
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import {
  type DepCheckOptions,
  type DepCheckResult,
  type VendorInventory,
  inventoryToDepResult,
} from './types.js';

interface Conn {
  host: string;
  token?: string;
  username?: string;
  password?: string;
}

function normalizeHost(host: string): string {
  let h = host.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
  if (!/:\d+$/.test(h.replace(/^https?:\/\//, ''))) h += ':8089';
  return h;
}

function getConn(): Conn | null {
  const envHost = process.env.SPLUNK_HOST || process.env.SPLUNK_URL;
  const envToken = process.env.SPLUNK_TOKEN;
  const envUser = process.env.SPLUNK_USERNAME;
  const envPass = process.env.SPLUNK_PASSWORD;
  if (envHost && envToken) return { host: normalizeHost(envHost), token: envToken };
  if (envHost && envUser && envPass) {
    return { host: normalizeHost(envHost), username: envUser, password: envPass };
  }
  const rc = join(homedir(), '.splunkrc');
  if (existsSync(rc)) {
    try {
      const text = readFileSync(rc, 'utf8');
      const kv: Record<string, string> = {};
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([a-zA-Z_]+)\s*=\s*(.+?)\s*$/);
        if (m) kv[m[1].toLowerCase()] = m[2];
      }
      const host = kv['host'] ? `https://${kv['host']}:${kv['port'] || 8089}` : undefined;
      if (host && kv['username'] && kv['password']) {
        return { host: normalizeHost(host), username: kv['username'], password: kv['password'] };
      }
    } catch {
      // unreadable rc — skip
    }
  }
  return null;
}

function authHeader(conn: Conn): string {
  if (conn.token) return `Bearer ${conn.token}`;
  return 'Basic ' + Buffer.from(`${conn.username}:${conn.password}`).toString('base64');
}

/**
 * Splunk Web typically lives on :8000; the management API on :8089.
 * Customers running behind a reverse proxy (one host, no port suffix)
 * can override with SPLUNK_WEB_URL.
 */
function webHostFor(mgmtHost: string): string {
  if (process.env.SPLUNK_WEB_URL) return process.env.SPLUNK_WEB_URL.replace(/\/+$/, '');
  if (/:8089$/.test(mgmtHost)) return mgmtHost.replace(/:8089$/, ':8000');
  return mgmtHost;
}

async function splunkGet(conn: Conn, path: string): Promise<unknown> {
  const r = await fetch(`${conn.host}${path}`, {
    headers: { Authorization: authHeader(conn), Accept: 'application/json' },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`splunk ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

interface SavedSearchEntry {
  name: string;
  content?: {
    search?: string;
    is_scheduled?: boolean | string;
    alert_type?: string;
    'alert.track'?: string;
    description?: string;
  };
  acl?: { app?: string; owner?: string };
}

interface ViewEntry {
  name: string;
  content?: { 'eai:data'?: string; label?: string };
  acl?: { app?: string };
}

export async function fetchSplunkInventory(): Promise<VendorInventory> {
  const inv: VendorInventory = {
    vendor: 'splunk',
    objects: [],
    notes: [],
    scanDepth: 'saved-search SPL, alert definitions, and dashboard XML',
  };
  const conn = getConn();
  if (!conn) {
    inv.error = 'Splunk credentials not detected (need SPLUNK_HOST + SPLUNK_TOKEN, or basic auth, or ~/.splunkrc)';
    return inv;
  }
  const webHost = webHostFor(conn.host);

  // 1. Saved searches (and alerts — same endpoint, distinguished by alert.track).
  try {
    const data = (await splunkGet(
      conn,
      '/services/saved/searches?output_mode=json&count=0'
    )) as { entry?: SavedSearchEntry[] };
    for (const e of data.entry || []) {
      const search = String(e.content?.search || '');
      const description = String(e.content?.description || '');
      const trackStr = String(e.content?.['alert.track'] ?? '0');
      const alertType = String(e.content?.alert_type || '');
      const isAlert = trackStr === '1' || (alertType !== '' && alertType !== 'always');
      const app = String(e.acl?.app || 'search');
      inv.objects.push({
        type: isAlert ? 'alert' : 'saved-search',
        name: e.name,
        url: `${webHost}/en-US/manager/${encodeURIComponent(app)}/saved/searches/${encodeURIComponent(e.name)}`,
        texts: { name: [e.name], query: [search, description], definition: [] },
        hasQueryText: true,
      });
    }
  } catch (e) {
    inv.notes.push(`saved/searches fetch failed: ${(e as Error).message.slice(0, 200)}`);
  }

  // 2. Dashboards (Simple XML + Studio share this endpoint).
  try {
    const data = (await splunkGet(
      conn,
      '/servicesNS/-/-/data/ui/views?output_mode=json&count=0'
    )) as { entry?: ViewEntry[] };
    for (const e of data.entry || []) {
      const xml = String(e.content?.['eai:data'] || '');
      const label = String(e.content?.label || '');
      const app = String(e.acl?.app || 'search');
      inv.objects.push({
        type: 'dashboard',
        name: label || e.name,
        url: `${webHost}/en-US/app/${encodeURIComponent(app)}/${encodeURIComponent(e.name)}`,
        texts: { name: [e.name, label], query: [], definition: [xml] },
        hasQueryText: true,
      });
    }
  } catch (e) {
    inv.notes.push(`dashboards fetch failed: ${(e as Error).message.slice(0, 200)}`);
  }

  return inv;
}

export async function checkSplunkDeps(opts: DepCheckOptions): Promise<DepCheckResult> {
  return inventoryToDepResult(await fetchSplunkInventory(), opts.pattern, opts.tokens);
}
