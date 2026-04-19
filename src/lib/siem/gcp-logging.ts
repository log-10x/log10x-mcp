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

export const gcpLoggingConnector: SiemConnector = {
  id: 'gcp-logging',
  displayName: 'GCP Cloud Logging',
  discoverCredentials,
  pullEvents,
};
