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
  type DepMatchedIn,
  emptyResult,
  anyTokenMatches,
  meaningfulTokens,
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

export async function checkDatadogDeps(opts: DepCheckOptions): Promise<DepCheckResult> {
  const result = emptyResult('datadog', opts.pattern);
  const { apiKey, appKey, site } = getKeys();
  if (!apiKey || !appKey) {
    result.error = 'Datadog credentials not detected (need DD_API_KEY + DD_APP_KEY)';
    return result;
  }

  const config = client.createConfiguration({ authMethods: { apiKeyAuth: apiKey, appKeyAuth: appKey } });
  if (site) config.setServerVariables({ site });
  const dashboardsApi = new v1.DashboardsApi(config);
  const monitorsApi = new v1.MonitorsApi(config);
  const appUrl = appUrlFor(site);
  const tokens = meaningfulTokens(opts.pattern, opts.tokens);

  // 1. Dashboards.
  try {
    const resp = await dashboardsApi.listDashboards({});
    const dashboards = resp.dashboards || [];
    for (const d of dashboards) {
      const id = d.id || '';
      const title = d.title || '';
      const description = d.description || '';
      const matchedIn: DepMatchedIn[] = [];
      if (anyTokenMatches(title, tokens)) matchedIn.push('name');
      if (anyTokenMatches(description, tokens)) matchedIn.push('definition');
      if (matchedIn.length === 0) continue;
      result.matches.push({
        type: 'dashboard',
        name: title || id,
        url: id ? `${appUrl}/dashboard/${id}` : undefined,
        matchedIn,
      });
      result.byType.dashboards++;
    }
  } catch (e) {
    result.notes.push(`dashboards list failed: ${(e as Error).message.slice(0, 200)}`);
  }

  // 2. Monitors. Datadog uses "monitor" terminology; we surface as `monitor`
  //    type (alerting is implied — monitors that aren't alerting are rare).
  try {
    const monitors = await monitorsApi.listMonitors({});
    for (const m of monitors) {
      const id = m.id ? String(m.id) : '';
      const name = m.name || '';
      const query = m.query || '';
      const message = m.message || '';
      const matchedIn: DepMatchedIn[] = [];
      if (anyTokenMatches(name, tokens)) matchedIn.push('name');
      if (anyTokenMatches(query, tokens) || anyTokenMatches(message, tokens)) matchedIn.push('query');
      if (matchedIn.length === 0) continue;
      result.matches.push({
        type: 'monitor',
        name: name || id,
        url: id ? `${appUrl}/monitors/${id}` : undefined,
        matchedIn,
      });
      result.byType.monitors++;
    }
  } catch (e) {
    result.notes.push(`monitors list failed: ${(e as Error).message.slice(0, 200)}`);
  }

  return result;
}
