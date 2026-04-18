/**
 * Streamer query diagnostics — polls CloudWatch Logs to extract structured
 * execution metadata (query plan, Bloom filter scan stats, worker stats,
 * errors) from a query's per-stream CW log.
 *
 * Shape this module emits: `StreamerQueryDiagnostics`. Consumers (the
 * streamer-query tool, investigate fallback) use this to:
 *   (a) report real execution progress to the LLM (not just "0 events"), and
 *   (b) diagnose WHY a query returned 0 — stale indexer vs. no matching tokens
 *       vs. Bloom false positives vs. mid-execution timeout.
 *
 * Polling is best-effort. Failures surface via `diagnostics.pollingError`,
 * not silent undefined — callers MUST check and degrade explicitly.
 */

import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

let _cwClient: CloudWatchLogsClient | undefined;
function cwClient(): CloudWatchLogsClient {
  if (!_cwClient) {
    _cwClient = new CloudWatchLogsClient({
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    });
  }
  return _cwClient;
}

/**
 * Execution diagnostics for a streamer query, built from CloudWatch Logs events.
 *
 * Field guide (how to diagnose a 0-event result):
 *   - queryPlan missing        → query submission failed or CW events not visible yet
 *   - emptyReason present      → search expression produced no parseable tokens
 *   - scanStats missing        → no sub-queries reported scan completion (likely no
 *                                index data for the time range, i.e. stale indexer)
 *   - scanStats.matched === 0  → Bloom filter rejected every index object
 *   - scanStats.matched > 0 but
 *     workerStats.totalResultEvents === 0
 *                              → Bloom false positives OR workers timed out
 *   - workerStats.complete < started
 *                              → some workers still running when MCP polled
 *   - pollingError present     → CW polling failed; diagnostics are incomplete
 *   - partialResults === true  → MCP poll timeout hit; server query may still be running
 */
export interface StreamerQueryDiagnostics {
  /** Coordinator's query plan. Present if the main query log stream was readable. */
  queryPlan?: {
    templateHashes: number;
    vars: number;
    timeslice: number;
    dispatch: 'local' | 'remote' | 'unknown';
  };
  /** Populated when isEmptyQuery() returned true — no parseable search tokens. */
  emptyReason?: string;
  /** Aggregated Bloom filter scan stats across all sub-queries. */
  scanStats?: {
    scanned: number;
    matched: number;
    skippedSearch: number;
    skippedTemplate: number;
    skippedDuplicate: number;
  };
  /**
   * Coordinator's view of stream dispatch. Represents SQS send() calls, NOT
   * worker completion. Use workerStats for actual worker execution.
   */
  streamDispatch?: {
    requests: number;
    objects: number;
    blobs: number;
  };
  /**
   * Stream worker execution. `started` and `complete` are counted from CW events,
   * so they reflect CW visibility, not necessarily ground truth if CW buffer hasn't
   * flushed. If complete < started, some workers were still running when polled.
   */
  workerStats?: {
    started: number;
    complete: number;
    totalFetchedBytes: number;
    totalResultEvents: number;
  };
  /** Main coordinator pipeline elapsed time (NOT full query wall time). */
  coordinatorElapsedMs?: number;
  /** ERROR-level CW events from any pipeline component. */
  errors?: string[];
  /**
   * True when the MCP's S3 marker poll timed out before the server query finished.
   * The server query may still be running and writing more results.
   */
  partialResults?: boolean;
  /**
   * If CW polling itself failed (AWS CLI missing, access denied, log group wrong),
   * the reason is reported here. Diagnostics are incomplete when set.
   */
  pollingError?: string;
}

interface CWEvent {
  level: string;
  message: string;
  data?: Record<string, number | string>;
  /** CW event timestamp in ms. */
  ts: number;
}

const CW_POLL_CONCURRENCY = 8;
const CW_POLL_MAX_STREAMS = 500;

/**
 * Fetch CloudWatch log events for a given queryId, bounded by an optional
 * time window. Streams are listed by prefix, events fetched in parallel.
 *
 * Throws when the AWS CLI itself is missing or the log group is inaccessible —
 * per-stream failures are swallowed (a stream may be empty or mid-write).
 */
async function fetchQueryCWEvents(
  queryId: string,
  logGroup: string,
  startTimeMs?: number,
): Promise<CWEvent[]> {
  const client = cwClient();

  // Page through streams with the queryId prefix.
  const streamNames: string[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await client.send(new DescribeLogStreamsCommand({
      logGroupName: logGroup,
      logStreamNamePrefix: `${queryId}/`,
      nextToken,
    }));
    for (const s of resp.logStreams || []) {
      if (s.logStreamName) streamNames.push(s.logStreamName);
      if (streamNames.length >= CW_POLL_MAX_STREAMS) break;
    }
    nextToken = resp.nextToken;
  } while (nextToken && streamNames.length < CW_POLL_MAX_STREAMS);

  if (streamNames.length === 0) return [];

  const events: CWEvent[] = [];
  const queue = [...streamNames];
  const workers: Promise<void>[] = [];

  for (let i = 0; i < Math.min(CW_POLL_CONCURRENCY, queue.length); i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const streamName = queue.shift();
        if (!streamName) break;
        try {
          const resp = await client.send(new GetLogEventsCommand({
            logGroupName: logGroup,
            logStreamName: streamName,
            startFromHead: true,
            startTime: startTimeMs,
          }));
          for (const ev of resp.events || []) {
            if (!ev.message || ev.timestamp === undefined) continue;
            try {
              const body = JSON.parse(ev.message) as Omit<CWEvent, 'ts'>;
              events.push({ ...body, ts: ev.timestamp });
            } catch {
              // skip non-JSON event bodies
            }
          }
        } catch {
          // per-stream failures are tolerated (stream may be empty or mid-write)
        }
      }
    })());
  }
  await Promise.all(workers);

  events.sort((a, b) => a.ts - b.ts);
  return events;
}

/**
 * Build diagnostics from CW events. Deterministic: each event contributes
 * to exactly one field so aggregation is idempotent across re-polls.
 */
export function buildDiagnostics(cwEvents: CWEvent[]): StreamerQueryDiagnostics {
  const diag: StreamerQueryDiagnostics = {};
  const errors: string[] = [];

  let workersStarted = 0;
  let workersComplete = 0;
  let totalFetchedBytes = 0;
  let totalResultEvents = 0;

  for (const ev of cwEvents) {
    const msg = ev.message;
    const data = ev.data || {};

    if (msg.startsWith('query plan:')) {
      const dispatch = data.dispatch as string;
      diag.queryPlan = {
        templateHashes: (data.templateHashes as number) ?? 0,
        vars: (data.vars as number) ?? 0,
        timeslice: (data.timeslice as number) ?? 0,
        dispatch: (dispatch === 'local' || dispatch === 'remote') ? dispatch : 'unknown',
      };
    } else if (msg.startsWith('query empty:')) {
      diag.emptyReason = (data.reason as string) || 'no_template_hashes_or_vars';
    } else if (msg.startsWith('scan complete:')) {
      if (!diag.scanStats) {
        diag.scanStats = { scanned: 0, matched: 0, skippedSearch: 0, skippedTemplate: 0, skippedDuplicate: 0 };
      }
      diag.scanStats.scanned += (data.scanned as number) || 0;
      diag.scanStats.matched += (data.matched as number) || 0;
      diag.scanStats.skippedSearch += (data.skippedSearch as number) || 0;
      diag.scanStats.skippedTemplate += (data.skippedTemplate as number) || 0;
      diag.scanStats.skippedDuplicate += (data.skippedDuplicate as number) || 0;
    } else if (msg.startsWith('stream dispatch:')) {
      if (!diag.streamDispatch) {
        diag.streamDispatch = { requests: 0, objects: 0, blobs: 0 };
      }
      diag.streamDispatch.requests += (data.requests as number) || 0;
      diag.streamDispatch.objects += (data.objects as number) || 0;
      diag.streamDispatch.blobs += (data.blobs as number) || 0;
    } else if (msg.startsWith('query complete:') && data.elapsedMs !== undefined) {
      // Only record the FIRST (main coordinator) "query complete" we see.
      // Sub-queries also emit this but with shorter elapsed values.
      if (diag.coordinatorElapsedMs === undefined) {
        diag.coordinatorElapsedMs = data.elapsedMs as number;
      }
    } else if (msg.startsWith('stream worker started:')) {
      workersStarted++;
    } else if (msg.startsWith('stream worker complete:')) {
      workersComplete++;
      totalFetchedBytes += (data.fetchedBytes as number) || 0;
    } else if (msg.startsWith('results writer complete:')) {
      totalResultEvents += (data.resultEvents as number) || 0;
    }

    if (ev.level === 'ERROR') {
      errors.push(msg);
    }
  }

  if (workersStarted > 0 || workersComplete > 0) {
    diag.workerStats = { started: workersStarted, complete: workersComplete, totalFetchedBytes, totalResultEvents };
  }

  if (errors.length > 0) {
    diag.errors = errors;
  }

  return diag;
}

/**
 * Populate diagnostics into a response-shaped object. Polling errors become
 * `diagnostics.pollingError`, not silent undefined.
 */
export async function attachDiagnostics<T extends { queryId: string; diagnostics?: StreamerQueryDiagnostics }>(
  resp: T,
  queryStartTimeMs: number,
): Promise<void> {
  const logGroup = process.env.LOG10X_STREAMER_LOG_GROUP;
  if (!logGroup) {
    resp.diagnostics = { pollingError: 'LOG10X_STREAMER_LOG_GROUP not set; diagnostics unavailable.' };
    return;
  }

  try {
    const cwEvents = await fetchQueryCWEvents(resp.queryId, logGroup, queryStartTimeMs);
    resp.diagnostics = buildDiagnostics(cwEvents);
  } catch (e) {
    resp.diagnostics = {
      pollingError: `CW polling failed: ${(e as Error).message.slice(0, 200)}`,
    };
  }
}

/**
 * Look up current execution diagnostics for a previously-submitted queryId.
 * Use this after runStreamerQuery returns `partialResults: true` to check
 * whether the server query has finished.
 */
export async function getStreamerQueryStatus(
  queryId: string,
  queryStartTimeMs: number,
): Promise<StreamerQueryDiagnostics> {
  const logGroup = process.env.LOG10X_STREAMER_LOG_GROUP;
  if (!logGroup) {
    return { pollingError: 'LOG10X_STREAMER_LOG_GROUP not set; diagnostics unavailable.' };
  }
  try {
    const cwEvents = await fetchQueryCWEvents(queryId, logGroup, queryStartTimeMs);
    return buildDiagnostics(cwEvents);
  } catch (e) {
    return { pollingError: `CW polling failed: ${(e as Error).message.slice(0, 200)}` };
  }
}

/**
 * Generate a human-readable explanation for a zero-result query.
 * Returns null when no specific explanation can be derived — callers should
 * fall back to a generic message.
 */
export function explainZeroResults(diag: StreamerQueryDiagnostics): string | null {
  if (diag.pollingError) {
    return `Diagnostics unavailable: ${diag.pollingError}`;
  }

  if (diag.emptyReason) {
    return 'The search expression produced no Bloom filter tokens (0 template hashes, 0 vars). ' +
      'The field names in the search may not match any indexed enrichment fields or text patterns.';
  }

  if (diag.errors && diag.errors.length > 0) {
    return `Query encountered ${diag.errors.length} error(s): ${diag.errors[0]}`;
  }

  if (diag.scanStats) {
    if (diag.scanStats.scanned === 0) {
      return 'No index objects found for the target/time range. ' +
        'The indexer may not have processed data for this time window yet.';
    }
    if (diag.scanStats.matched === 0) {
      return `The Bloom filter scanned ${diag.scanStats.scanned} index objects and none matched. ` +
        `${diag.scanStats.skippedSearch} skipped by search filter, ${diag.scanStats.skippedTemplate} by template filter. ` +
        'The search tokens do not exist in the archive for this time range.';
    }
    // Bloom matched but no result events — distinguish timeout from false-positive
    if (diag.scanStats.matched > 0 && (!diag.workerStats || diag.workerStats.totalResultEvents === 0)) {
      if (diag.workerStats && diag.workerStats.complete < diag.workerStats.started) {
        return `The Bloom filter matched ${diag.scanStats.matched} index objects and ${diag.workerStats.started} workers were dispatched, ` +
          `but only ${diag.workerStats.complete} completed before the poll timed out. Results may still be arriving — ` +
          `retry log10x_streamer_query_status with the same queryId, or rerun the query.`;
      }
      return `The Bloom filter matched ${diag.scanStats.matched} index objects, but stream workers decoded 0 matching events. ` +
        'Most likely cause: Bloom filter false positives — the search tokens exist in the index but the actual events do not match the full search expression.';
    }
  }

  // queryPlan present but no scanStats. Two very different causes collapse
  // onto the same signature — disambiguate via partialResults:
  //   partialResults=true  → MCP poll timed out; CW events may not have flushed yet
  //   partialResults=false → scan actually completed with nothing to report (likely no index data)
  if (diag.queryPlan && !diag.scanStats) {
    if (diag.partialResults) {
      return 'MCP poll timed out before the server query completed. CW scan-completion events ' +
        'have not arrived yet — the query may still be executing. Retry log10x_streamer_query_status ' +
        'with the same queryId in a few seconds for an updated view.';
    }
    return 'Query completed without any sub-query reporting scan completion. ' +
      'Most likely cause: no index objects exist for the time range — try an older window, or verify ' +
      'the indexer is running and processing new data.';
  }

  if (diag.partialResults) {
    return 'MCP poll timeout reached before the server query completed. Some results may still be ' +
      'written to S3. Retry log10x_streamer_query_status with the same queryId for an updated view.';
  }

  return null;
}
