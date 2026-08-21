/**
 * Datadog read-only dependency check.
 *
 * Endpoints (all GET, read-only):
 *   v1.DashboardsApi.listDashboards     → dashboard list (id, title, description)
 *   v1.MonitorsApi.listMonitors          → monitors (id, name, query, message)
 *
 * Listing dashboards returns a flat list with title + description. We match
 * tokens against name + description; matching against widget queries would
 * require a per-dashboard `getDashboard(id)` round-trip — too chatty for
 * large accounts on the default scan path. Customers who need that depth
 * can run the python siem-check script instead.
 *
 * Site routing follows DD_SITE / DATADOG_SITE the same way the existing
 * connector does — datadoghq.com (US1), datadoghq.eu (EU1), us3/us5/ap1.
 */

import { client, v1 } from '@datadog/datadog-api-client';

import {
  type DepCheckOptions,
  type DepCheckResult,
  type VendorInventory,
  inventoryToDepResult,
} from './types.js';

function getKeys(): { apiKey?: string; appKey?: string; site?: string } {
  return {
    apiKey: process.env.DD_API_KEY || process.env.DATADOG_API_KEY,
    appKey: process.env.DD_APP_KEY || process.env.DATADOG_APP_KEY,
    site: process.env.DD_SITE || process.env.DATADOG_SITE,
  };
}

function appUrlFor(site: string | undefined): string {
  const s = site || 'datadoghq.com';
  return `https://app.${s}`;
}

export async function fetchDatadogInventory(): Promise<VendorInventory> {
  const inv: VendorInventory = {
    vendor: 'datadog',
    objects: [],
    notes: [],
    scanDepth: 'monitor queries and dashboard titles/descriptions',
  };
  const { apiKey, appKey, site } = getKeys();
  if (!apiKey || !appKey) {
    inv.error = 'Datadog credentials not detected (need DD_API_KEY + DD_APP_KEY)';
    return inv;
  }

  const config = client.createConfiguration({ authMethods: { apiKeyAuth: apiKey, appKeyAuth: appKey } });
  if (site) config.setServerVariables({ site });
  const dashboardsApi = new v1.DashboardsApi(config);
  const monitorsApi = new v1.MonitorsApi(config);
  const appUrl = appUrlFor(site);

  // 1. Dashboards — title + description only (widget queries need a
  //    per-dashboard GetDashboard round-trip; too chatty for large accounts).
  try {
    const resp = await dashboardsApi.listDashboards({});
    for (const d of resp.dashboards || []) {
      const id = d.id || '';
      const title = d.title || '';
      const description = d.description || '';
      inv.objects.push({
        type: 'dashboard',
        name: title || id,
        url: id ? `${appUrl}/dashboard/${id}` : undefined,
        texts: { name: [title], query: [], definition: [description] },
        hasQueryText: false,
      });
    }
    inv.notes.push('dashboard match is title/description only (widget queries need per-dashboard fetches)');
  } catch (e) {
    inv.notes.push(`dashboards list failed: ${(e as Error).message.slice(0, 200)}`);
  }

  // 2. Monitors — full query body available from the list call.
  try {
    const monitors = await monitorsApi.listMonitors({});
    for (const m of monitors) {
      const id = m.id ? String(m.id) : '';
      const name = m.name || '';
      const query = m.query || '';
      const message = m.message || '';
      inv.objects.push({
        type: 'monitor',
        name: name || id,
        url: id ? `${appUrl}/monitors/${id}` : undefined,
        texts: { name: [name], query: [query, message], definition: [] },
        hasQueryText: true,
      });
    }
  } catch (e) {
    inv.notes.push(`monitors list failed: ${(e as Error).message.slice(0, 200)}`);
  }

  return inv;
}

export async function checkDatadogDeps(opts: DepCheckOptions): Promise<DepCheckResult> {
  return inventoryToDepResult(await fetchDatadogInventory(), opts.pattern, opts.tokens);
}
