/**
 * log10x_retriever_query_status — post-hoc observability for a submitted retriever query.
 *
 * Reads the S3 _DONE.json marker, lists event files and byte-count markers,
 * optionally fetches per-query CloudWatch log events, and runs a diagnostics
 * engine over the combined data. Surfaces the chart 1.0.20 dispatcher-failure
 * signature (scanned=0 + submittedTasks>0) and recommends remediation.
 *
 * Call after log10x_retriever_query returns 0 events or partial_results=true
 * to understand what actually happened inside the engine.
 */

import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { getRetrieverState } from '../lib/retriever-state.js';
import { isRetrieverConfigured } from '../lib/retriever-api.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { buildNotConfiguredEnvelope } from '../lib/not-configured.js';
import { buildChassisErrorEnvelope } from '../lib/chassis-envelope.js';
import { wrapBackendError } from '../lib/primitive-errors.js';
import { run } from '../lib/discovery/shell.js';

const execFileP = promisify(execFile);

// ── Schema ───────────────────────────────────────────────────────────────────

export const retrieverQueryStatusSchema = {
  query_id: z
    .string()
    .describe(
      'UUID of a previously-submitted retriever query. Returned as data.query_id from log10x_retriever_query.'
    ),
  target: z
    .string()
    .default('app')
    .describe(
      'Target app/service prefix used when the original query was submitted. Defaults to "app". Must match the target that was passed to the original query.'
    ),
  include_pod_logs: z
    .boolean()
    .default(true)
    .describe(
      'When true and a dispatcher_failure is suspected (scanned=0 + submittedTasks>0), attempt kubectl logs on the retriever pod to confirm the chart 1.0.20 include-resolution error. Requires kubectl access from the MCP process. Set false to skip the kubectl call.'
    ),
};

// ── Types ────────────────────────────────────────────────────────────────────

interface DoneJson {
  queryId?: string;
  completedAt?: string;
  elapsedMs?: number;
  reason?: string;
  scanned?: number;
  matched?: number;
  skippedSearch?: number;
  skippedTemplate?: number;
  streamRequests?: number;
  streamBlobs?: number;
  submittedTasks?: number;
  expectedMarkers?: number;
  [key: string]: unknown;
}

interface S3ListEntry {
  Key: string;
  Size?: number;
  LastModified?: string;
}

interface CwEventEntry {
  timestamp: string;
  level: string;
  message: string;
  data?: Record<string, unknown>;
}

type DiagnosticCategory =
  | 'dispatcher_failure'
  | 'results_not_uploaded'
  | 'dispatch_failure'
  | 'observability_disabled'
  | 'ok'
  | 'unknown';

interface DiagnosticsResult {
  category: DiagnosticCategory;
  confidence: 'confirmed' | 'suspected' | 'advisory' | 'none';
  evidence: string[];
}

// ── CloudWatch client ────────────────────────────────────────────────────────

let _cwClient: CloudWatchLogsClient | undefined;
function cwClient(): CloudWatchLogsClient {
  if (!_cwClient) {
    _cwClient = new CloudWatchLogsClient({
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    });
  }
  return _cwClient;
}

// ── S3 helpers ───────────────────────────────────────────────────────────────

async function s3Get(bucket: string, key: string): Promise<string> {
  const { stdout } = await execFileP('aws', ['s3', 'cp', `s3://${bucket}/${key}`, '-'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function s3List(bucket: string, prefix: string): Promise<S3ListEntry[]> {
  try {
    const { stdout } = await execFileP(
      'aws',
      ['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix, '--output', 'json'],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout) as { Contents?: S3ListEntry[] };
    return parsed.Contents || [];
  } catch {
    return [];
  }
}

// ── Helm queryLogGroup resolution ────────────────────────────────────────────

async function resolveQueryLogGroup(
  releaseName: string,
  namespace: string
): Promise<string | undefined> {
  try {
    const result = await run(
      'helm',
      ['get', 'values', releaseName, '-n', namespace, '-o', 'json'],
      { timeoutMs: 8_000 }
    );
    if (result.exitCode !== 0) return undefined;
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const qlg = parsed['queryLogGroup'];
    if (typeof qlg === 'string' && qlg.trim()) return qlg.trim();
    // Also check tenx.queryLogGroup nested form
    const tenx = parsed['tenx'];
    if (tenx && typeof tenx === 'object') {
      const nested = (tenx as Record<string, unknown>)['queryLogGroup'];
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ── CloudWatch filter-log-events for a query ID ──────────────────────────────

async function fetchCwQueryEvents(
  logGroup: string,
  queryId: string
): Promise<CwEventEntry[]> {
  const client = cwClient();
  const now = Date.now();
  const startTime = now - 24 * 60 * 60 * 1000; // 24h window

  const events: CwEventEntry[] = [];
  let nextToken: string | undefined;

  do {
    const resp = await client.send(
      new FilterLogEventsCommand({
        logGroupName: logGroup,
        filterPattern: queryId,
        startTime,
        endTime: now,
        nextToken,
        limit: 100,
      })
    );
    for (const ev of resp.events || []) {
      if (!ev.message || ev.timestamp === undefined) continue;
      try {
        const body = JSON.parse(ev.message) as {
          level?: string;
          message?: string;
          data?: Record<string, unknown>;
        };
        events.push({
          timestamp: new Date(ev.timestamp).toISOString(),
          level: body.level || 'INFO',
          message: body.message || ev.message,
          data: body.data,
        });
      } catch {
        // non-JSON entry — include as raw
        events.push({
          timestamp: new Date(ev.timestamp).toISOString(),
          level: 'INFO',
          message: ev.message.slice(0, 500),
        });
      }
      if (events.length >= 100) break;
    }
    nextToken = resp.nextToken;
  } while (nextToken && events.length < 100);

  return events;
}

// ── Pod log grep for the rename-gap signature ────────────────────────────────

async function fetchPodLogSignature(
  namespace: string
): Promise<{ matched: boolean; lines: string[]; error?: string }> {
  try {
    // Find retriever pods (all-in-one container label)
    const podListResult = await run(
      'kubectl',
      ['get', 'pods', '-n', namespace, '-l', 'app=retriever-10x', '-o', 'jsonpath={.items[*].metadata.name}'],
      { timeoutMs: 8_000 }
    );
    const podNames = podListResult.stdout.trim().split(/\s+/).filter(Boolean);
    if (podNames.length === 0) {
      // Try alternate label
      const altResult = await run(
        'kubectl',
        ['get', 'pods', '-n', namespace, '-l', 'app.kubernetes.io/name=retriever-10x', '-o', 'jsonpath={.items[*].metadata.name}'],
        { timeoutMs: 8_000 }
      );
      const altNames = altResult.stdout.trim().split(/\s+/).filter(Boolean);
      if (altNames.length === 0) {
        return { matched: false, lines: [], error: `no retriever pods found in namespace ${namespace}` };
      }
      podNames.push(...altNames);
    }

    // Fetch logs from first pod, container retriever-10x-all-in-one
    const podName = podNames[0];
    const logsResult = await run(
      'kubectl',
      ['logs', '-n', namespace, podName, '-c', 'retriever-10x-all-in-one', '--tail=500'],
      { timeoutMs: 12_000 }
    );
    if (logsResult.exitCode !== 0 || !logsResult.stdout.trim()) {
      // Try without container flag
      const logsResult2 = await run(
        'kubectl',
        ['logs', '-n', namespace, podName, '--tail=500'],
        { timeoutMs: 12_000 }
      );
      if (logsResult2.exitCode !== 0) {
        return {
          matched: false,
          lines: [],
          error: `kubectl logs failed: ${logsResult2.stderr.slice(0, 200)}`,
        };
      }
      return grepForRenameSignature(logsResult2.stdout);
    }
    return grepForRenameSignature(logsResult.stdout);
  } catch (e) {
    return { matched: false, lines: [], error: (e as Error).message.slice(0, 200) };
  }
}

function grepForRenameSignature(logs: string): { matched: boolean; lines: string[] } {
  const pattern = /could not resolve include: 'cloud\/streamer\/subquery'/;
  const lines = logs.split('\n').filter((l) => pattern.test(l) || l.includes('error expanding launch macro'));
  return { matched: lines.length > 0, lines: lines.slice(0, 10) };
}

// ── Diagnostics engine ───────────────────────────────────────────────────────

async function runDiagnosticsEngine(params: {
  done: DoneJson | null;
  queryLogGroup: string | undefined;
  eventsReturned: number;
  namespace: string | undefined;
  includePodLogs: boolean;
}): Promise<DiagnosticsResult> {
  const { done, queryLogGroup, eventsReturned, namespace, includePodLogs } = params;
  const evidence: string[] = [];

  // Advisory: observability disabled — added to evidence but does NOT short-circuit
  // when a _DONE.json is present. The dispatcher-failure fingerprint from _DONE.json
  // is a stronger signal and should win over the CW-disabled advisory.
  const cwDisabledAdvisory = !queryLogGroup
    ? 'queryLogGroup is not set; per-query CloudWatch logging is disabled — pod stdout is the only observability path. Call log10x_advise_retriever for the remediation snippet.'
    : undefined;

  if (!done) {
    // Only return observability_disabled when we have nothing else to go on.
    if (cwDisabledAdvisory) {
      return {
        category: 'observability_disabled',
        confidence: 'advisory',
        evidence: [
          'queryLogGroup is not set in the retriever helm values.',
          'Per-query CloudWatch logging is disabled; dispatcher failures will not appear in CloudWatch.',
          'Only pod stdout is visible. Call log10x_advise_retriever for the remediation snippet.',
        ],
      };
    }
    return {
      category: 'unknown',
      confidence: 'none',
      evidence: ['_DONE.json not found; the query may still be running or the queryId/target is wrong.'],
    };
  }

  const reason = done.reason ?? '';
  const submittedTasks = done.submittedTasks ?? 0;
  const streamRequests = done.streamRequests ?? 0;
  const scanned = done.scanned ?? 0;

  // Dispatcher failure detection: tasks submitted but nothing scanned or streamed
  if (reason === 'dispatched' && submittedTasks > 0 && streamRequests === 0 && scanned === 0) {
    evidence.push(`_DONE.json: reason="${reason}", submittedTasks=${submittedTasks}, streamRequests=${streamRequests}, scanned=${scanned}`);
    evidence.push(
      'This is the numeric fingerprint of the chart 1.0.20 incomplete streamer->retriever rename: ' +
      "scan/stream workers fail to launch because the 'cloud/streamer/subquery' include was not renamed. " +
      "Confirm via pod logs: 'could not resolve include: cloud/streamer/subquery'."
    );

    if (includePodLogs && namespace) {
      evidence.push(`Checking pod logs in namespace ${namespace} for the include-resolution error...`);
      const podCheck = await fetchPodLogSignature(namespace);
      if (podCheck.error) {
        evidence.push(`Pod log check: ${podCheck.error}`);
      }
      if (podCheck.matched) {
        evidence.push('CONFIRMED: pod logs contain "could not resolve include: \'cloud/streamer/subquery\'"');
        for (const line of podCheck.lines.slice(0, 3)) {
          evidence.push(`  pod log: ${line.trim().slice(0, 200)}`);
        }
        return {
          category: 'dispatcher_failure',
          confidence: 'confirmed',
          evidence,
        };
      } else {
        evidence.push('Pod logs did not contain the rename-gap signature; dispatcher_failure still suspected from _DONE.json fingerprint.');
        if (podCheck.lines.length > 0) {
          for (const line of podCheck.lines.slice(0, 3)) {
            evidence.push(`  pod log: ${line.trim().slice(0, 200)}`);
          }
        }
      }
    } else if (!namespace) {
      evidence.push('Namespace not resolved; pod log check skipped.');
    }

    return {
      category: 'dispatcher_failure',
      confidence: 'suspected',
      evidence,
    };
  }

  // Results not uploaded: workers matched events but none were returned
  const matched = done.matched ?? 0;
  if (matched > 0 && eventsReturned === 0) {
    evidence.push(`_DONE.json: matched=${matched}, but 0 events were returned.`);
    evidence.push('Workers matched index objects but no event files were written to the qr/ prefix, or they were not read back.');
    return {
      category: 'results_not_uploaded',
      confidence: 'suspected',
      evidence,
    };
  }

  // Dispatch failure: done but reason is not "dispatched"
  const elapsedMs = done.elapsedMs ?? 0;
  if (elapsedMs === 0 && reason !== 'dispatched') {
    evidence.push(`_DONE.json: elapsedMs=0, reason="${reason}"`);
    evidence.push('Query appears to have failed before dispatch completed.');
    return {
      category: 'dispatch_failure',
      confidence: 'suspected',
      evidence,
    };
  }

  evidence.push(`_DONE.json: reason="${reason}", scanned=${scanned}, matched=${matched}, submittedTasks=${submittedTasks}, streamRequests=${streamRequests}`);
  return {
    category: 'ok',
    confidence: 'none',
    evidence,
  };
}

// ── Main executor ────────────────────────────────────────────────────────────

export async function executeRetrieverQueryStatus(
  args: {
    query_id: string;
    target?: string;
    include_pod_logs?: boolean;
  }
): Promise<string | StructuredOutput> {
  const queryId = args.query_id;
  const target = args.target ?? 'app';
  const includePodLogs = args.include_pod_logs ?? true;

  const retrieverState = await getRetrieverState(null);
  if (!(await isRetrieverConfigured())) {
    return buildNotConfiguredEnvelope({
      tool: 'log10x_retriever_query_status',
      kind: 'retriever',
      remediation:
        'Retriever is not configured. Set __SAVE_LOG10X_RETRIEVER_URL__ and __SAVE_LOG10X_RETRIEVER_BUCKET__, then re-run.',
    });
  }

  try {
    const bucket = process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__ ?? retrieverState.bucket ?? '';
    const namespace = retrieverState.namespace;
    const indexSubpath = (
      process.env.LOG10X_RETRIEVER_INDEX_SUBPATH || 'indexing-results'
    ).replace(/^\/+|\/+$/g, '');
    const basePrefix = indexSubpath ? `${indexSubpath}/` : '';

    const doneKey = `${basePrefix}tenx/${target}/qr/${queryId}/_DONE.json`;
    const qrPrefix = `${basePrefix}tenx/${target}/qr/${queryId}/`;
    const markerPrefix = `${basePrefix}tenx/${target}/q/${queryId}/`;

    // Step b: read _DONE.json
    let doneJson: DoneJson | null = null;
    let doneError: string | undefined;
    try {
      const raw = await s3Get(bucket, doneKey);
      doneJson = JSON.parse(raw) as DoneJson;
    } catch (e) {
      doneError = (e as Error).message.slice(0, 200);
    }

    // Step c: list qr/ prefix for event files
    const qrObjects = await s3List(bucket, qrPrefix);
    const eventFiles = qrObjects.filter((o) => o.Key.endsWith('.jsonl'));
    const totalEventBytes = eventFiles.reduce((s, o) => s + (o.Size ?? 0), 0);

    // Step d: list q/ prefix for byte-count markers
    const markerObjects = await s3List(bucket, markerPrefix);
    const markerCount = markerObjects.length;

    // Step e: CloudWatch events (if queryLogGroup configured)
    // Try helm values to get queryLogGroup
    let queryLogGroup: string | undefined;
    // First check env var fallback
    queryLogGroup = process.env.LOG10X_RETRIEVER_QUERY_LOG_GROUP || undefined;
    if (!queryLogGroup && namespace) {
      // Try to resolve from helm values
      // Find a release name from helm list
      const { run: shellRun } = await import('../lib/discovery/shell.js');
      const listResult = await shellRun('helm', ['list', '-A', '-o', 'json'], { timeoutMs: 10_000 });
      if (listResult.exitCode === 0) {
        try {
          const releases = JSON.parse(listResult.stdout) as Array<{
            name: string;
            namespace: string;
            chart: string;
          }>;
          const retrieverRelease = releases.find(
            (r) => r.chart.toLowerCase().startsWith('retriever-10x') && r.namespace === namespace
          );
          if (retrieverRelease) {
            queryLogGroup = await resolveQueryLogGroup(retrieverRelease.name, namespace);
          }
        } catch {
          // best-effort
        }
      }
    }

    let cwEvents: CwEventEntry[] = [];
    let cwError: string | undefined;
    if (queryLogGroup) {
      try {
        cwEvents = await fetchCwQueryEvents(queryLogGroup, queryId);
      } catch (e) {
        cwError = (e as Error).message.slice(0, 200);
      }
    }

    // Step f: diagnostics engine
    const diagnostics = await runDiagnosticsEngine({
      done: doneJson,
      queryLogGroup,
      eventsReturned: eventFiles.length,
      namespace,
      includePodLogs,
    });

    // Step g: build output
    const stats = doneJson
      ? {
          queryId: doneJson.queryId ?? queryId,
          completedAt: doneJson.completedAt,
          elapsedMs: doneJson.elapsedMs,
          reason: doneJson.reason,
          scanned: doneJson.scanned,
          matched: doneJson.matched,
          skippedSearch: doneJson.skippedSearch,
          skippedTemplate: doneJson.skippedTemplate,
          streamRequests: doneJson.streamRequests,
          streamBlobs: doneJson.streamBlobs,
          submittedTasks: doneJson.submittedTasks,
          expectedMarkers: doneJson.expectedMarkers,
        }
      : null;

    const humanSummary = buildHumanSummary({
      queryId,
      target,
      stats,
      doneError,
      eventFileCount: eventFiles.length,
      totalEventBytes,
      markerCount,
      cwEvents,
      cwError,
      queryLogGroup,
      diagnostics,
    });

    const actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }> = [];

    if (diagnostics.category === 'observability_disabled') {
      actions.push({
        tool: 'log10x_advise_retriever',
        args: {},
        reason:
          'queryLogGroup is empty — call advise_retriever to get the helm + IAM snippet that enables per-query CloudWatch logging',
      });
    }
    if (diagnostics.category === 'dispatcher_failure') {
      actions.push({
        tool: 'log10x_advise_retriever',
        args: {},
        reason:
          'chart 1.0.21+ upgrade or the rename-residual fix in modules/feat/soft-drop resolves this dispatcher failure',
      });
    }

    const headline = `Retriever query status for ${queryId}: ${humanSummary.slice(0, 120)}`;

    return buildEnvelope({
      tool: 'log10x_retriever_query_status',
      view: 'summary',
      summary: { headline },
      data: {
        status: doneJson ? 'done' : doneError ? 'not_found' : 'unknown',
        query_id: queryId,
        target,
        bucket,
        s3_done_key: doneKey,
        stats,
        done_read_error: doneError,
        marker_count: markerCount,
        event_files: {
          count: eventFiles.length,
          total_bytes: totalEventBytes,
          keys: eventFiles.slice(0, 20).map((o) => o.Key),
        },
        cloudwatch_events: queryLogGroup
          ? {
              log_group: queryLogGroup,
              event_count: cwEvents.length,
              events: cwEvents.slice(0, 100),
              error: cwError,
            }
          : {
              log_group: null,
              event_count: 0,
              events: [],
              advisory: 'queryLogGroup not set — CW per-query logging disabled',
            },
        diagnostics,
        human_summary: humanSummary,
        source_disclosure: {
          retriever_state_source: retrieverState.source,
          namespace: namespace ?? null,
        },
      },
      truncated: cwEvents.length >= 100,
      actions,
    });
  } catch (err: unknown) {
    const primitiveErr = wrapBackendError(err);
    return buildChassisErrorEnvelope({
      tool: 'log10x_retriever_query_status',
      err: primitiveErr,
      contextPayload: { query_id: queryId, target },
      source_disclosure: {},
    });
  }
}

// ── Human summary builder ────────────────────────────────────────────────────

function buildHumanSummary(params: {
  queryId: string;
  target: string;
  stats: DoneJson | null;
  doneError: string | undefined;
  eventFileCount: number;
  totalEventBytes: number;
  markerCount: number;
  cwEvents: CwEventEntry[];
  cwError: string | undefined;
  queryLogGroup: string | undefined;
  diagnostics: DiagnosticsResult;
}): string {
  const {
    queryId,
    target,
    stats,
    doneError,
    eventFileCount,
    totalEventBytes,
    markerCount,
    cwEvents,
    cwError,
    queryLogGroup,
    diagnostics,
  } = params;

  const parts: string[] = [];

  if (!stats) {
    parts.push(
      doneError
        ? `Query ${queryId} on target ${target}: _DONE.json not found (${doneError}). The query may still be running or the queryId/target is wrong.`
        : `Query ${queryId} on target ${target}: _DONE.json not found.`
    );
  } else {
    parts.push(
      `Query ${queryId} on target ${target} completed (reason=${stats.reason ?? '?'}, elapsed=${stats.elapsedMs ?? '?'}ms). ` +
        `Scanned ${stats.scanned ?? '?'} objects, matched ${stats.matched ?? '?'}, ` +
        `submitted ${stats.submittedTasks ?? '?'} scan tasks, stream requests: ${stats.streamRequests ?? '?'}.`
    );
  }

  if (eventFileCount > 0) {
    parts.push(`${eventFileCount} event file(s) in S3 (${formatBytes(totalEventBytes)} total).`);
  } else {
    parts.push('No event JSONL files found in the qr/ prefix.');
  }

  if (markerCount > 0) {
    parts.push(`${markerCount} byte-count marker(s) in the q/ prefix.`);
  }

  if (queryLogGroup) {
    if (cwError) {
      parts.push(`CloudWatch polling error: ${cwError}`);
    } else {
      parts.push(`${cwEvents.length} CloudWatch event(s) from log group ${queryLogGroup}.`);
    }
  } else {
    parts.push(
      'queryLogGroup not set in helm values — CW per-query logging disabled. Call log10x_advise_retriever for the remediation snippet.'
    );
  }

  // Diagnostic verdict
  if (diagnostics.category === 'dispatcher_failure') {
    const confidence = diagnostics.confidence === 'confirmed' ? 'CONFIRMED' : 'SUSPECTED';
    parts.push(
      `DIAGNOSTIC [${confidence}]: dispatcher_failure — the coordinator submitted ${stats?.submittedTasks ?? '?'} scan tasks ` +
        `that scanned nothing. This is the chart 1.0.20 incomplete-streamer-rename signature. ` +
        `Upgrade to chart 1.0.21+ or apply the rename-residual fix in modules/feat/soft-drop. ` +
        `Evidence: ${diagnostics.evidence.slice(0, 2).join(' | ')}`
    );
  } else if (diagnostics.category === 'results_not_uploaded') {
    parts.push(
      `DIAGNOSTIC [suspected]: results_not_uploaded — Bloom filter matched ${stats?.matched ?? '?'} objects but 0 events were written. ` +
        `Workers may have matched but writeResults was not triggered.`
    );
  } else if (diagnostics.category === 'dispatch_failure') {
    parts.push(
      `DIAGNOSTIC [suspected]: dispatch_failure — query completed before dispatch (reason=${stats?.reason ?? '?'}, elapsedMs=0).`
    );
  } else if (diagnostics.category === 'observability_disabled') {
    parts.push(
      'ADVISORY: queryLogGroup not set — per-query CW observability disabled. Set queryLogGroup in helm values and ensure IRSA has logs:CreateLogStream + logs:PutLogEvents.'
    );
  }

  return parts.join(' ');
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
