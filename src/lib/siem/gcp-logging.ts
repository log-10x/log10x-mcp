/**
 * GCP Cloud Logging connector.
 *
 * Uses `@google-cloud/logging` Logging client. Authentication is handled
 * ambiently by the SDK — `GOOGLE_APPLICATION_CREDENTIALS` env var pointing
 * at a service-account key, or gcloud CLI's application-default credentials.
 *
 * `scope` is the GCP project id; `query` is a log filter expression.
 * The connector appends a timestamp constraint automatically.
 */

import { Logging } from '@google-cloud/logging';

import type {
  SiemConnector,
  CredentialDiscovery,
  PullEventsOptions,
  PullEventsResult,
  PullStopReason,
  VolumeDetectionOptions,
  VolumeDetectionResult,
} from './index.js';

import { retryWithBackoff, shouldStop, parseWindowMs } from './_retry.js';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

async function discoverCredentials(): Promise<CredentialDiscovery> {
  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gac && existsSync(gac)) {
    return {
      available: true,
      source: 'env',
      details: { credentials_file: gac, project_id: process.env.GOOGLE_CLOUD_PROJECT || 'not-set' },
    };
  }
  // gcloud ADC cache paths.
  const adcCandidates = [
    join(homedir(), '.config', 'gcloud', 'application_default_credentials.json'),
  ];
  for (const p of adcCandidates) {
    if (existsSync(p)) {
      return {
        available: true,
        source: 'cli_config',
        details: { adc_file: p, project_id: process.env.GOOGLE_CLOUD_PROJECT || 'not-set' },
      };
    }
  }
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    return {
      available: true,
      source: 'ambient',
      details: { project_id: process.env.GOOGLE_CLOUD_PROJECT, note: 'relying on workload identity' },
    };
  }
  return { available: false, source: 'none' };
}

async function pullEvents(opts: PullEventsOptions): Promise<PullEventsResult> {
  const projectId = opts.scope || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (!projectId) {
    return {
      events: [],
      metadata: {
        actualCount: 0,
        truncated: false,
        queryUsed: '',
        reasonStopped: 'error',
        notes: ['Pass `scope` as the GCP project id, or set GOOGLE_CLOUD_PROJECT.'],
      },
    };
  }

  const logging = new Logging({ projectId });
  const deadline = Date.now() + opts.maxPullMinutes * 60_000;
  const windowMs = parseWindowMs(opts.window);
  const sinceIso = new Date(Date.now() - windowMs).toISOString();

  // Filter: caller's query ANDed with timestamp window.
  const filters: string[] = [`timestamp >= "${sinceIso}"`];
  if (opts.query) filters.push(opts.query);
  const filter = filters.join(' AND ');

  const events: unknown[] = [];
  let reasonStopped: PullStopReason = 'source_exhausted';
  const notes: string[] = [];

  const pageSize = 1000;
  let pageToken: string | undefined;

  while (true) {
    if (shouldStop(deadline, events.length, opts.targetEventCount)) {
      reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
      break;
    }
    try {
      const [entries, nextQuery] = await retryWithBackoff(
        () =>
          logging.getEntries({
            filter,
            pageSize,
            pageToken,
            orderBy: 'timestamp desc',
            autoPaginate: false,
          }) as unknown as Promise<[unknown[], { pageToken?: string } | null]>
      );
      for (const entry of entries as Array<{ data?: unknown; metadata?: Record<string, unknown> }>) {
        const md = entry.metadata || {};
        const payload = entry.data;
        const message = typeof payload === 'string' ? payload : extractPayloadText(payload);
        events.push({
          timestamp: md.timestamp || md.receiveTimestamp,
          message,
          severity: md.severity,
          logName: md.logName,
          resource: md.resource,
          labels: md.labels,
          trace: md.trace,
          spanId: md.spanId,
          rawPayload: payload,
        });
      }
      pageToken = nextQuery?.pageToken;
      if (!pageToken) {
        reasonStopped = 'source_exhausted';
        break;
      }
      opts.onProgress({
        step: `gcp page ${pageToken.slice(0, 8)}…`,
        pct: Math.min(50, Math.round((events.length / opts.targetEventCount) * 50)),
        eventsFetched: events.length,
      });
    } catch (e) {
      notes.push(`gcp_page_error: ${(e as Error).message.slice(0, 200)}`);
      reasonStopped = 'error';
      break;
    }
  }

  const truncated = reasonStopped !== 'source_exhausted' && events.length < opts.targetEventCount;
  return {
    events,
    metadata: {
      actualCount: events.length,
      truncated,
      queryUsed: filter,
      reasonStopped,
      notes: notes.length > 0 ? notes : undefined,
    },
  };
}

function extractPayloadText(payload: unknown): string {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (typeof p.message === 'string') return p.message;
    if (typeof p.text === 'string') return p.text;
    try {
      return JSON.stringify(p);
    } catch {
      return '';
    }
  }
  return String(payload);
}

/**
 * Detect GCP Cloud Logging daily ingest via Cloud Monitoring time series
 * on `logging.googleapis.com/billing/monthly_bytes_ingested` (the same
 * metric that drives your Cloud Billing line). That metric is cumulative
 * for the current month, so we take the latest 7 data points and estimate
 * daily from the deltas.
 *
 * Falls back gracefully if Cloud Monitoring access isn't granted — the
 * SA needs `roles/monitoring.viewer` in addition to Logging roles.
 */
async function detectDailyVolumeGb(opts: VolumeDetectionOptions): Promise<VolumeDetectionResult> {
  const projectId = opts.scope || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (!projectId) return { errorNote: 'GCP: project ID not set' };
  try {
    // Use google-auth-library via @google-cloud/logging's auth so we get
    // the same ADC/SA flow without pulling in an extra package.
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/monitoring.read'],
    });
    const client = await auth.getClient();
    const tokenResp = await client.getAccessToken();
    const accessToken = typeof tokenResp === 'string' ? tokenResp : tokenResp?.token;
    if (!accessToken) {
      return { errorNote: 'GCP: could not acquire access token for Cloud Monitoring' };
    }
    const now = new Date();
    const start = new Date(now.getTime() - 7 * 86_400_000);
    const url =
      `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/timeSeries?` +
      `filter=${encodeURIComponent('metric.type="logging.googleapis.com/billing/monthly_bytes_ingested"')}` +
      `&interval.startTime=${encodeURIComponent(start.toISOString())}` +
      `&interval.endTime=${encodeURIComponent(now.toISOString())}` +
      `&aggregation.alignmentPeriod=86400s` +
      `&aggregation.perSeriesAligner=ALIGN_MAX`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        errorNote:
          `GCP Monitoring HTTP ${res.status} — SA needs roles/monitoring.viewer.${body ? ' ' + body.slice(0, 120) : ''}`,
      };
    }
    const data = (await res.json()) as {
      timeSeries?: Array<{ points?: Array<{ value?: { int64Value?: string; doubleValue?: number } }> }>;
    };
    const series = data.timeSeries || [];
    if (series.length === 0) {
      return { errorNote: 'GCP Monitoring: billing/monthly_bytes_ingested returned no data — project may have <24h of logs' };
    }
    // Each series is a (resource, metric-label) combination. Sum across
    // series at the LATEST point, then divide by days-so-far in month.
    let latestMonthBytes = 0;
    for (const s of series) {
      const latest = s.points?.[0];
      const v = latest?.value?.int64Value ?? latest?.value?.doubleValue ?? 0;
      latestMonthBytes += Number(v);
    }
    if (latestMonthBytes === 0) {
      return { errorNote: 'GCP Monitoring: latest billing bytes = 0' };
    }
    // Metric resets at month start; compute days elapsed in the current
    // billing month to convert cumulative MTD to daily average.
    const dayOfMonth = now.getUTCDate();
    const daysSinceMonthStart = Math.max(1, dayOfMonth);
    const dailyGb = latestMonthBytes / (1024 ** 3) / daysSinceMonthStart;
    return {
      dailyGb,
      source: `GCP Cloud Monitoring billing/monthly_bytes_ingested (MTD / ${daysSinceMonthStart}d)`,
    };
  } catch (e) {
    return { errorNote: `GCP volume detection failed: ${(e as Error).message.slice(0, 200)}` };
  }
}

export const gcpLoggingConnector: SiemConnector = {
  id: 'gcp-logging',
  displayName: 'GCP Cloud Logging',
  discoverCredentials,
  pullEvents,
  detectDailyVolumeGb,
};
