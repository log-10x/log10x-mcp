/**
 * Azure Monitor / Log Analytics connector.
 *
 * Uses @azure/monitor-query `LogsQueryClient` with KQL. `scope` is the
 * workspace id; `query` is layered onto the default KQL.
 *
 * Auth: DefaultAzureCredential walks env vars, managed identity, and
 * `az login` cache — the standard Azure SDK flow.
 */

import { LogsQueryClient, LogsQueryResultStatus } from '@azure/monitor-query';
import { DefaultAzureCredential } from '@azure/identity';

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
  const workspaceId = process.env.AZURE_LOG_ANALYTICS_WORKSPACE_ID;
  if (!workspaceId) {
    return { available: false, source: 'none' };
  }
  // Explicit service-principal env var set.
  if (process.env.AZURE_CLIENT_ID && process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_SECRET) {
    return {
      available: true,
      source: 'env',
      details: { workspace_id: workspaceId, auth: 'service_principal' },
    };
  }
  // `az login` cache — usually under ~/.azure on mac/linux.
  const azDir = join(homedir(), '.azure');
  if (existsSync(azDir)) {
    return {
      available: true,
      source: 'cli_config',
      details: { workspace_id: workspaceId, auth: 'az-login' },
    };
  }
  // DefaultAzureCredential will still try managed identity, IMDS, etc.
  return {
    available: true,
    source: 'ambient',
    details: { workspace_id: workspaceId, auth: 'default-credential' },
  };
}

async function pullEvents(opts: PullEventsOptions): Promise<PullEventsResult> {
  const workspaceId = opts.scope || process.env.AZURE_LOG_ANALYTICS_WORKSPACE_ID;
  if (!workspaceId) {
    return {
      events: [],
      metadata: {
        actualCount: 0,
        truncated: false,
        queryUsed: '',
        reasonStopped: 'error',
        notes: ['Pass `scope` as the workspace id, or set AZURE_LOG_ANALYTICS_WORKSPACE_ID.'],
      },
    };
  }

  const client = new LogsQueryClient(new DefaultAzureCredential());
  const deadline = Date.now() + opts.maxPullMinutes * 60_000;
  const windowMs = parseWindowMs(opts.window);
  const windowSec = Math.max(60, Math.floor(windowMs / 1000));

  // Default table when none specified: AppTraces or Event — we use
  // `union * | where …` to query across all tables. Callers with a specific
  // table can pass it via `query`, e.g., `AppTraces | where Message has "..."`.
  const userQuery = (opts.query || '').trim();
  const baseQuery = userQuery.startsWith('union') || /^[A-Z][A-Za-z]*\s*\|/.test(userQuery)
    ? userQuery
    : `AppTraces ${userQuery ? '| ' + userQuery : ''}`;

  // Take-based pagination. `take` caps rows; we page by chunking the time
  // window when the user asks for a lot of data. KQL has no cursor pagination,
  // so we split the window into equal halves if the first response is saturated.
  const events: unknown[] = [];
  const notes: string[] = [];
  let reasonStopped: PullStopReason = 'source_exhausted';

  // Single-call strategy: ask for up to targetEventCount. Workspace limit
  // per call is usually 30k rows; we cap to 10k per call and chunk if needed.
  const PER_CALL_LIMIT = 10_000;
  let pulledTotal = 0;
  let endTime = Date.now();
  let pageIndex = 0;
  const maxPages = 20;

  while (pageIndex < maxPages) {
    if (shouldStop(deadline, events.length, opts.targetEventCount)) {
      reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
      break;
    }
    const wantThisPage = Math.min(PER_CALL_LIMIT, opts.targetEventCount - pulledTotal);
    if (wantThisPage <= 0) {
      reasonStopped = 'target_reached';
      break;
    }
    const pageQuery = `${baseQuery} | order by TimeGenerated desc | take ${wantThisPage}`;
    try {
      const resp = await retryWithBackoff(() =>
        client.queryWorkspace(workspaceId, pageQuery, {
          // Query across the current window, trimming the end time forward.
          duration: `PT${windowSec}S`,
          endTime: new Date(endTime),
        } as unknown as Parameters<typeof client.queryWorkspace>[2])
      );
      type AnyQueryResult = {
        status: string;
        tables?: Array<{ columnDescriptors: Array<{ name: string }>; rows: unknown[][] }>;
        partialTables?: Array<{ columnDescriptors: Array<{ name: string }>; rows: unknown[][] }>;
      };
      const respAny = resp as unknown as AnyQueryResult;
      let tables: Array<{ columnDescriptors: Array<{ name: string }>; rows: unknown[][] }> = [];
      if (respAny.status === LogsQueryResultStatus.Success) {
        tables = respAny.tables || [];
      } else if (respAny.status === LogsQueryResultStatus.PartialFailure) {
        notes.push(`azure_query_partial: ${respAny.status}`);
        tables = respAny.partialTables || [];
      } else {
        notes.push(`azure_query_failure: ${respAny.status}`);
      }
      let rowsThisCall = 0;
      for (const table of tables) {
        for (const row of table.rows) {
          const obj: Record<string, unknown> = {};
          for (let i = 0; i < table.columnDescriptors.length; i++) {
            const colName = table.columnDescriptors[i].name || `col_${i}`;
            obj[colName] = row[i];
          }
          events.push(obj);
          rowsThisCall++;
        }
      }
      pulledTotal += rowsThisCall;
      opts.onProgress({
        step: `azure page ${pageIndex + 1} (${rowsThisCall} rows)`,
        pct: Math.min(50, Math.round((events.length / opts.targetEventCount) * 50)),
        eventsFetched: events.length,
      });
      if (rowsThisCall < wantThisPage) {
        reasonStopped = 'source_exhausted';
        break;
      }
      // Advance the endTime backwards by the window. Using KQL, we can't
      // deep-paginate cleanly without a known TimeGenerated cursor — for
      // large pulls, callers should narrow the query via `query`.
      endTime = endTime - windowMs;
      pageIndex++;
    } catch (e) {
      notes.push(`azure_page_error: ${(e as Error).message.slice(0, 200)}`);
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
      queryUsed: baseQuery,
      reasonStopped,
      notes: notes.length > 0 ? notes : undefined,
    },
  };
}

export const azureMonitorConnector: SiemConnector = {
  id: 'azure-monitor',
  displayName: 'Azure Monitor / Log Analytics',
  discoverCredentials,
  pullEvents,
};
