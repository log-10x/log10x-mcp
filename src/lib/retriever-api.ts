/**
 * Log10x Retriever REST client + S3 results poller.
 *
 * The Retriever's query API is two-phase:
 *
 *   1. POST /streamer/query with a body shaped like QueryRequest.java accepts.
 *      The body carries a client-generated `id` field which the engine uses
 *      as the canonical queryId and echoes back in the response.
 *
 *   2. The engine dispatches stream workers that buffer matched events to
 *      disk and upload them to S3 under {basePath}/tenx/{target}/qr/{queryId}/
 *      as JSONL files. The client polls that prefix via the AWS CLI until
 *      every expected worker has written its marker (at the sibling
 *      {basePath}/tenx/{target}/q/{queryId}/ backstop prefix) and the results
 *      prefix is stable.
 *
 * Configure with:
 *   - __SAVE_LOG10X_RETRIEVER_URL__: base URL of the query handler (e.g., the NLB).
 *   - __SAVE_LOG10X_RETRIEVER_BUCKET__: S3 bucket holding the retriever index/results.
 *   - __SAVE_LOG10X_RETRIEVER_TARGET__: default target app prefix (e.g., "app" for
 *     the otek demo env). Overridable per query.
 *   - LOG10X_RETRIEVER_POLL_MS: poll interval, default 1500 ms.
 *   - LOG10X_RETRIEVER_TIMEOUT_MS: total poll budget, default 180_000 ms.
 *     The 90s default was too small for archives where the query-handler
 *     spawns dozens of stream workers — observed live on the otel-demo
 *     env taking >60s to write the first marker. 180s covers single
 *     forensic queries; per-sub-window calls in retriever_series get the
 *     same budget but typically finish in seconds because each query is
 *     scoped to a small sub-window.
 *
 * Authentication piggybacks on the same X-10X-Auth header the Prometheus
 * gateway uses (apiKey/envId). Override via LOG10X_RETRIEVER_AUTH_HEADER /
 * LOG10X_RETRIEVER_AUTH_VALUE if the deployment uses a different scheme.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { EnvConfig } from './environments.js';
import { attachDiagnostics, type RetrieverQueryDiagnostics } from './retriever-diagnostics.js';
import { diagnoseQuery, type DoneMarker, type QueryDiagnosis } from './query-funnel.js';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const execFileP = promisify(execFile);

export class RetrieverNotConfiguredError extends Error {
  constructor() {
    super(
      'Retriever endpoint not configured for this MCP install. ' +
        'log10x_retriever_query and log10x_backfill_metric cannot reach the S3 archive in this session.\n\n' +
        'Two possible causes:\n' +
        '  1. Retriever IS deployed but MCP env vars are unset. Fix: set __SAVE_LOG10X_RETRIEVER_URL__ ' +
        'to the retriever query handler URL (e.g., the NLB) and __SAVE_LOG10X_RETRIEVER_BUCKET__ to the ' +
        'archive bucket, then restart the MCP client.\n' +
        '  2. Retriever is NOT deployed for this customer. Fix: deploy per ' +
        'https://doc.log10x.com/apps/cloud/retriever/\n\n' +
        'Workaround for the current request: if the events you need are inside SIEM hot retention ' +
        '(typically <7 days for Datadog/Splunk/Elastic), tell the user to query the SIEM directly ' +
        'with the relevant service + time filter — that is the fastest path. For events outside ' +
        'SIEM retention, the only path is enabling the retriever.'
    );
    this.name = 'RetrieverNotConfiguredError';
  }
}

export interface RetrieverQueryRequest {
  /** Absolute ISO8601, epoch millis, or relative `now("-1h")`. */
  from: string;
  /** Absolute ISO8601, epoch millis, or relative `now()`. */
  to: string;
  /** Optional Bloom-filter search expression (TenX subset: ==, ||, &&, includes). */
  search?: string;
  /** Optional in-memory JS filters applied after the Bloom-scoped fetch. */
  filters?: string[];
  /** Target app prefix to scope the index scan. Defaults to __SAVE_LOG10X_RETRIEVER_TARGET__. */
  target?: string;
  /**
   * Tier-1 result-sink redirect: bare-token prefix under which query OUTPUT
   * (qr/ events, qrs/ summaries, q/ markers, _DONE.json) is written, in the
   * SAME index bucket. Maps to the engine `queryResultTarget` option. When
   * set, the MCP polls `tenx/{resultTarget}/qr/{queryId}/` for results; when
   * omitted, results stay under `target` (legacy). Must be `[A-Za-z0-9_-]+`.
   */
  resultTarget?: string;
  /** Logical query name (appears in PERF metrics). */
  name?: string;
  /** Hard cap on total events returned after merging per-worker results. */
  limit?: number;
  /** Max milliseconds the engine has to produce results. */
  processingTimeMs?: number;
  /** Max bytes the engine will ship before terminating. */
  resultSizeBytes?: number;

  // ── Legacy fields kept for call-site compatibility. The engine contract
  //    no longer uses `pattern` (the Bloom filter uses `search`), and
  //    `format`/`bucketSize` are now client-side rollups over the events
  //    stream. These are accepted but ignored by the new client.
  /** @deprecated use `search` instead */
  pattern?: string;
  /** Per-query CloudWatch log-level escalation. Maps to the engine's `logLevels`
   *  REST body field; set to escalate one query to DEBUG for 0-result triage. */
  logLevels?: string;
  /** @deprecated format is now a client-side rollup */
  format?: 'events' | 'count' | 'aggregated';
  /** @deprecated bucket_size is now a client-side rollup */
  bucketSize?: string;

  /**
   * Gate the events writer (qr/ prefix). Defaults to true so legacy
   * call sites keep getting raw event JSONL. Set false alongside
   * `writeSummaries: true` for count/trend tools that don't need
   * per-event payload — order-of-magnitude bandwidth saving on
   * high-volume patterns.
   */
  writeResults?: boolean;

  /**
   * Gate the per-slice TenXSummary writer (qrs/ prefix). Defaults to
   * false. Each TenXSummary record carries `summaryVolume` (event
   * count for that group) + `summaryBytes` (utf8 byte sum) + the
   * grouping field values; the slice's time bounds are encoded in
   * the S3 key path (`qrs/{queryId}/{sliceFrom}_{sliceTo}/`) and the
   * client parses them back into `sliceFromMs`/`sliceToMs` on each
   * record.
   */
  writeSummaries?: boolean;
  /**
   * Caps the per-worker qr/ event DOWNLOAD (not the engine write — the engine
   * always writes the full set; results_location carries it). Only takes
   * effect when qrs/ summaries are present (they supply the whole-match count
   * + rollups, so the client doesn't need the bulk):
   *   - 0          → download NO qr/ events (count/aggregate served by summaries)
   *   - N (> 0)    → download worker files until ~N events accumulate, then stop
   *   - undefined  → download everything (legacy)
   * With NO summaries the full set is always downloaded regardless, so the
   * true count + rollups are never lost.
   */
  maxDownloadEvents?: number;
}

/**
 * Result of a `fetchExistingResults` call.
 */
export interface ExistingResultsResponse {
  /** Events recovered from the qr/{queryId}/ prefix, sorted by timestamp. */
  events: RetrieverEvent[];
  /** True when at least one worker uploaded a `.truncated` sibling. */
  truncated: boolean;
  /** Number of `.jsonl` worker files read. */
  jsonlObjectCount: number;
  /** Worker files that failed to download after retries (events incomplete). */
  failedWorkerFiles?: number;
  /** True when the `_DONE.json` marker exists. False when the query is mid-flight. */
  done: boolean;
  /** Resolved target prefix the result paths used. */
  target: string;
  /** Funnel verdict (OK / EMPTY_RANGE / BLOOM_REJECTED_ALL / MATCHED_NO_EVENTS /
   *  DISPATCHED_BLIND / NO_MARKER / INCONCLUSIVE) derived from the _DONE marker
   *  + the events that came back. Lets the agent debug a zero-result fetch. */
  diagnosis: QueryDiagnosis;
}

/**
 * Fetch results for a previously-submitted retriever query by `queryId`.
 *
 * Closes the stranded-queryId dead-end. When `runRetrieverQuery` returns
 * `partialResults: true` (its MCP-side poll budget exceeded the engine's
 * actual completion time), the engine still finishes the scan and uploads
 * results to S3 under `qr/{queryId}/`. Without this helper, those results
 * are unreachable: re-running `runRetrieverQuery` submits a new queryId.
 * `log10x_retriever_query_status` calls this helper when invoked with
 * `fetch_results: true` so the agent can recover the stranded events.
 *
 * Reads only — no engine submission. Returns `done: false` when the
 * `_DONE.json` marker is missing, in which case the caller should poll
 * status diagnostics again before re-fetching.
 */
/**
 * The S3 location where a query's matched events land as JSONL objects:
 * `{indexSubpath}/tenx/{target}/qr/{queryId}/`. This is the canonical
 * "list of result objects" a caller reads to get the full match set
 * beyond the in-context preview, and the handoff point for the
 * customer's own S3 -> SIEM path. The engine writes one `*.jsonl` per
 * stream worker plus a `_DONE.json` marker here.
 */
export async function retrieverResultsLocation(
  target: string,
  queryId: string,
): Promise<{ bucket: string; prefix: string; uri: string }> {
  const bucket = await getRetrieverBucket();
  const indexSubpath = (process.env.LOG10X_RETRIEVER_INDEX_SUBPATH || 'indexing-results').replace(/^\/+|\/+$/g, '');
  const basePrefix = indexSubpath ? `${indexSubpath}/` : '';
  const prefix = `${basePrefix}tenx/${target}/qr/${queryId}/`;
  return { bucket, prefix, uri: `s3://${bucket}/${prefix}` };
}

export async function fetchExistingResults(
  queryId: string,
  options?: { target?: string },
): Promise<ExistingResultsResponse> {
  const bucket = await getRetrieverBucket();
  const target = options?.target || (await getDefaultTarget());

  const indexSubpath = (process.env.LOG10X_RETRIEVER_INDEX_SUBPATH || 'indexing-results').replace(/^\/+|\/+$/g, '');
  const basePrefix = indexSubpath ? `${indexSubpath}/` : '';
  const resultsPrefix = `${basePrefix}tenx/${target}/qr/${queryId}/`;
  const doneMarkerKey = `${resultsPrefix}_DONE.json`;

  // Probe the _DONE marker without retry. The marker either exists (engine
  // finished) or doesn't (engine still running). Distinguishing missing from
  // 4xx is unimportant here — both mean "not done."
  let done = false;
  let doneMarker: DoneMarker | null = null;
  try {
    const body = await s3Get(bucket, doneMarkerKey);
    done = true;
    try {
      doneMarker = JSON.parse(body) as DoneMarker;
    } catch {
      doneMarker = null; // marker present but unparseable — still "done"
    }
  } catch {
    done = false;
  }

  const resultObjects = await s3List(bucket, resultsPrefix);

  let truncated = false;
  const jsonlKeys: string[] = [];
  for (const obj of resultObjects) {
    if (obj.Key.endsWith('.truncated')) {
      truncated = true;
      continue;
    }
    if (obj.Key.endsWith('.jsonl')) {
      jsonlKeys.push(obj.Key);
    }
  }

  // Download the per-worker JSONL results concurrently (bounded pool) with
  // per-file retry; a file that still fails after retries degrades the fetch
  // to partial (failedWorkerFiles > 0) instead of losing the whole query.
  // Order-preserving + flattened, so the downstream sort + cap matches the
  // old serial loop.
  const events: RetrieverEvent[] = [];
  const eventDl = await mapWithConcurrencySettled(
    jsonlKeys,
    RETRIEVER_DOWNLOAD_CONCURRENCY,
    async (key) => parseJsonl(await s3GetWithRetry(bucket, key)),
  );
  const failedWorkerFiles = eventDl.failures.length;
  for (const chunk of eventDl.results) if (chunk) events.push(...chunk);

  events.sort((a, b) => eventTimestampMs(a) - eventTimestampMs(b));

  // Backfill legacy fields the same way runRetrieverQuery does so callers
  // see a consistent event shape regardless of which path produced them.
  for (const ev of events) {
    const levelTemplated = (ev as Record<string, unknown>)['LevelTemplate.severity_level'];
    if (ev.severity_level == null && typeof levelTemplated === 'string') {
      ev.severity_level = levelTemplated;
    }
    if (ev.service == null && typeof ev.tenx_user_service === 'string') {
      ev.service = ev.tenx_user_service;
    }
    if (ev.severity == null && typeof ev.severity_level === 'string') {
      ev.severity = ev.severity_level;
    }
  }

  const diagnosis = diagnoseQuery(doneMarker, events.length, { failedWorkerFiles });
  return { events, truncated, jsonlObjectCount: jsonlKeys.length, done, target, diagnosis, ...(failedWorkerFiles > 0 ? { failedWorkerFiles } : {}) };
}

/**
 * Build a Bloom-filter `search` expression from a Reporter-named pattern
 * (Symbol Message). Tools that take a user-facing pattern name (the same
 * snake_case identity surfaced by event_lookup, top_patterns, cost_drivers)
 * call this before submitting to runRetrieverQuery so the engine actually
 * scopes the scan to the pattern. Without this translation the engine sees
 * `search: ''` (the deprecated `pattern` field is silently dropped at body
 * build time) and runs unfiltered across the window.
 *
 * The inverse — parsing a pattern back out of a search expression — lives
 * in retriever-fidelity.ts as `extractPatternFromSearch`.
 *
 * Pattern values are expected to be snake_case (Symbol Message form). Quotes
 * are stripped defensively; legitimate Symbol Messages never contain them.
 */
export function buildPatternSearch(pattern: string): string {
  const safe = pattern.trim().replace(/"/g, '');
  return `tenx_user_pattern == "${safe}"`;
}

export interface RetrieverEvent {
  timestamp?: string;
  text?: string;
  severity_level?: string;
  tenx_user_service?: string;
  k8s_namespace?: string;
  k8s_pod?: string;
  k8s_container?: string;
  http_code?: string;

  // Legacy fields kept for aggregator/backfill compatibility. Populated
  // from the canonical enrichment fields inside runRetrieverQuery.
  service?: string;
  severity?: string;
  /** Engine-INTERNAL field-set fingerprint that joins encoded events to
   * templates.json. NOT the agent-facing identity — that is tenx_hash /
   * pattern_hash. Do not surface as the event's stable ID. */
  templateHash?: string;
  enrichedFields?: Record<string, string>;
  values?: string[];

  /** Any additional fields returned by the engine. */
  [key: string]: unknown;
}

export interface RetrieverBucket {
  timestamp: string;
  count: number;
  labels?: Record<string, string>;
}

/**
 * One TenXSummary record uploaded by the engine's per-slice summaries
 * writer (qrs/ prefix). Aggregated by the pipeline's grouping fields
 * (typically pattern + service + pod + severity); `summaryVolume` is
 * the event count contributed to this row by THIS worker. The slice
 * bounds come from the S3 key path, NOT the record itself.
 *
 * The engine emits enrichment fields as NAMED top-level keys (same
 * pattern the events writer uses, via `$=yield TenXEnv.get("enrichmentFields")`)
 * so consumers can look up `record.severity_level` / `record.k8s_pod`
 * directly. This makes the schema self-describing and survives
 * customer customization of `enrichmentFields`.
 */
export interface RetrieverSummary {
  /** Lower bound (epoch ms) of the slice this summary belongs to. */
  sliceFromMs: number;
  /** Upper bound (epoch ms, exclusive) of the slice. */
  sliceToMs: number;
  /** Event count this summary row aggregates. */
  summaryVolume: number;
  /** UTF-8 byte sum of the events in this row. */
  summaryBytes: number;
  /** Hash over the grouping fields (deterministic group key). */
  summaryValuesHash?: string;
  /**
   * Named enrichment fields (severity_level, tenx_user_service,
   * k8s_pod, message_pattern, etc.). Order/presence depends on the
   * deployment's `enrichmentFields` config — consumers should look up
   * by name, never by position.
   */
  [field: string]: unknown;
}

export interface RetrieverQueryResponse {
  queryId: string;
  target: string;
  from: string;
  to: string;
  execution: {
    wallTimeMs: number;
    eventsMatched: number;
    workerFiles: number;
    truncated: boolean;
    /**
     * Worker JSONL files that failed to download after retries. > 0 means
     * the event set (and event-derived rollups) are INCOMPLETE — surface a
     * partial caveat; the full set is still intact in S3.
     */
    failedWorkerFiles?: number;
    /** True when the qr/ download was capped (summaries served the rollups). */
    downloadCapped?: boolean;
    /** Total qr/ worker files that exist for this query (vs downloaded). */
    totalWorkerFiles?: number;
    /** Per-slice summary record count when summaries were requested. */
    summariesMatched?: number;
    /** Distinct slice subdirs observed. */
    slicesObserved?: number;
  };
  events: RetrieverEvent[];
  /**
   * Populated only when the request set `writeSummaries: true`. Each
   * record carries its slice bounds from the S3 key path so callers
   * can bucket by slice (typically 1 minute on the demo cluster's
   * `queryScanFunctionParallelTimeslice` default).
   */
  summaries?: RetrieverSummary[];
  /**
   * Structured execution diagnostics built by polling CloudWatch Logs for
   * the query's per-stream-worker streams. Populated when
   * `LOG10X_RETRIEVER_LOG_GROUP` is set and the CW SDK can reach the log
   * group. `pollingError` is set in place of a silent undefined when CW
   * is unreachable — callers should check and degrade explicitly.
   */
  diagnostics?: RetrieverQueryDiagnostics;

  // Legacy-compatible fields populated client-side from `events` so that
  // callers written against the old Retriever contract (investigate, backfill)
  // keep working without a rewrite.
  format?: 'events' | 'count' | 'aggregated';
  buckets?: RetrieverBucket[];
  countSummary?: {
    total: number;
    byService?: Record<string, number>;
    bySeverity?: Record<string, number>;
    byDay?: Record<string, number>;
  };
  /**
   * Which ingress path delivered the query to the retriever engine.
   * `"http"` — normal path: POST /streamer/query to the query-handler URL.
   * `"sqs"` — fallback path: SendMessage to the Quarkus ingress queue
   *   (LOG10X_RETRIEVER_QUERY_QUEUE_URL), used when the HTTP URL is a
   *   ClusterIP address unreachable from outside the cluster.
   */
  transport?: 'http' | 'sqs';
  /**
   * Wall time from SQS SendMessage until S3 polling completed, in ms.
   * Populated only when transport="sqs".
   */
  sqsLatencyMs?: number;
}

export type RetrieverDetectionPath =
  | 'explicit_env'
  | 'aws_s3_bucket_pattern'
  | 'kubectl_service'
  | 'terraform_state'
  | 'helm_release_probe';

export interface RetrieverResolution {
  url?: string;
  bucket?: string;
  target?: string;
  detectionPath?: RetrieverDetectionPath;
  trace: Array<{ path: RetrieverDetectionPath; status: 'matched' | 'skipped' | 'failed'; reason: string }>;
}

/**
 * Resolve the Retriever URL + bucket from the ambient environment.
 *
 * Detection order (first hit wins):
 *   1. explicit __SAVE_LOG10X_RETRIEVER_URL__ + __SAVE_LOG10X_RETRIEVER_BUCKET__
 *   2. AWS conventional bucket naming (log10x-retriever-*, *-log10x-archive)
 *      combined with a kubectl-discovered query-handler service URL
 *   3. kubectl service probe alone (url resolved, bucket from annotation)
 *   4. Terraform state file (~/.log10x/retriever.tfstate or LOG10X_TERRAFORM_STATE)
 */
export async function resolveRetriever(): Promise<RetrieverResolution> {
  const trace: RetrieverResolution['trace'] = [];

  if (process.env.__SAVE_LOG10X_RETRIEVER_URL__ && process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__) {
    trace.push({
      path: 'explicit_env',
      status: 'matched',
      reason: `__SAVE_LOG10X_RETRIEVER_URL__ + __SAVE_LOG10X_RETRIEVER_BUCKET__ set`,
    });
    return {
      url: process.env.__SAVE_LOG10X_RETRIEVER_URL__.replace(/\/+$/, ''),
      bucket: process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__,
      target: process.env.__SAVE_LOG10X_RETRIEVER_TARGET__,
      detectionPath: 'explicit_env',
      trace,
    };
  }
  if (process.env.__SAVE_LOG10X_RETRIEVER_URL__ || process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__) {
    trace.push({
      path: 'explicit_env',
      status: 'skipped',
      reason: 'only one of __SAVE_LOG10X_RETRIEVER_URL__ / __SAVE_LOG10X_RETRIEVER_BUCKET__ set — need both',
    });
  } else {
    trace.push({ path: 'explicit_env', status: 'skipped', reason: '__SAVE_LOG10X_RETRIEVER_URL__ / __SAVE_LOG10X_RETRIEVER_BUCKET__ not set' });
  }

  // 4. Terraform state file (checked before AWS/kubectl so scripted installs
  //    that write a state file are deterministic regardless of ambient AWS).
  const tfRes = await tryDetectRetrieverFromTerraformState();
  if (tfRes.url && tfRes.bucket) {
    trace.push({ path: 'terraform_state', status: 'matched', reason: tfRes.reason });
    return { ...tfRes, detectionPath: 'terraform_state', trace };
  }
  trace.push({ path: 'terraform_state', status: tfRes.failed ? 'failed' : 'skipped', reason: tfRes.reason });

  // 2. AWS bucket pattern.
  const awsRes = await tryDetectRetrieverBucketFromAws();
  if (awsRes.bucket) {
    // Bucket found; probe kubectl for URL (or fall back to explicit override).
    const svc = process.env.__SAVE_LOG10X_RETRIEVER_URL__
      ? { url: process.env.__SAVE_LOG10X_RETRIEVER_URL__, reason: '__SAVE_LOG10X_RETRIEVER_URL__ explicit' }
      : await tryDetectRetrieverUrlFromKubectl();
    if (svc.url) {
      trace.push({
        path: 'aws_s3_bucket_pattern',
        status: 'matched',
        reason: `${awsRes.reason}; url: ${svc.reason}`,
      });
      return {
        bucket: awsRes.bucket,
        url: svc.url.replace(/\/+$/, ''),
        target: process.env.__SAVE_LOG10X_RETRIEVER_TARGET__,
        detectionPath: 'aws_s3_bucket_pattern',
        trace,
      };
    }
    trace.push({
      path: 'aws_s3_bucket_pattern',
      status: 'skipped',
      reason: `${awsRes.reason}; no query-handler URL — kubectl probe: ${svc.reason}`,
    });
  } else {
    trace.push({ path: 'aws_s3_bucket_pattern', status: awsRes.failed ? 'failed' : 'skipped', reason: awsRes.reason });
  }

  // 3. kubectl service probe alone (no bucket).
  const kRes = await tryDetectRetrieverUrlFromKubectl();
  if (kRes.url) {
    trace.push({
      path: 'kubectl_service',
      status: 'skipped',
      reason: `${kRes.reason} — but no matching bucket found; set __SAVE_LOG10X_RETRIEVER_BUCKET__`,
    });
  } else {
    trace.push({ path: 'kubectl_service', status: kRes.failed ? 'failed' : 'skipped', reason: kRes.reason });
  }

  // Fix 83b — helm_release_probe fallback.
  // getRetrieverState() reads both URL and bucket from the helm release
  // (via `helm get values … tenx.bucket`). This covers the post-install
  // gap where the MCP wizard has just deployed the Retriever but the user
  // has not yet set the env vars — resolveRetriever()'s earlier paths all
  // miss it (terraform state absent, AWS env not set, kubectl label probe
  // returns 0 services because the Service's label set doesn't include the
  // log10x-retriever selector used by tryDetectRetrieverUrlFromKubectl).
  const { getRetrieverState } = await import('./retriever-state.js');
  const helmState = await getRetrieverState(null);
  if (helmState.installed && helmState.url && helmState.bucket) {
    trace.push({
      path: 'helm_release_probe',
      status: 'matched',
      reason: `getRetrieverState helm probe: url=${helmState.url} bucket=${helmState.bucket}`,
    });
    return {
      url: helmState.url,
      bucket: helmState.bucket,
      target: process.env.__SAVE_LOG10X_RETRIEVER_TARGET__,
      detectionPath: 'helm_release_probe',
      trace,
    };
  }
  if (helmState.installed && helmState.url) {
    trace.push({
      path: 'helm_release_probe',
      status: 'skipped',
      reason: `helm probe resolved url=${helmState.url} but no bucket — set __SAVE_LOG10X_RETRIEVER_BUCKET__ or add tenx.bucket to helm values`,
    });
  } else {
    trace.push({
      path: 'helm_release_probe',
      status: helmState.source === 'none' ? 'skipped' : 'failed',
      reason: `getRetrieverState: source=${helmState.source}, installed=${helmState.installed}`,
    });
  }

  return { trace };
}

/**
 * Fast-path synchronous check (explicit env vars only).
 * Kept for back-compat with any callers that cannot await.
 * For the full kubectl-probe cascade use isRetrieverConfigured().
 */
export function isRetrieverConfiguredSync(): boolean {
  return Boolean(process.env.__SAVE_LOG10X_RETRIEVER_URL__ && process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__);
}

/**
 * Fix 83a/83b — async gate that consults resolveRetriever so a
 * helm-probe-discovered install (no env vars set) is treated as configured.
 *
 * Resolution order (matches resolveRetriever()):
 *   1. Env-var fast-path — if both __SAVE_LOG10X_RETRIEVER_URL__ and
 *      __SAVE_LOG10X_RETRIEVER_BUCKET__ are set, return true immediately.
 *   2. resolveRetriever() — full cascade (terraform state, AWS bucket
 *      pattern, kubectl probe, helm_release_probe). Returns true only when
 *      BOTH url AND bucket are resolved, which is the same precondition
 *      that runRetrieverQuery requires. This closes the 83a gap where
 *      getRetrieverState() returned url-only (helm probe, no bucket) and
 *      isRetrieverConfigured() returned true while the inner tool call still
 *      threw RetrieverNotConfiguredError on the missing bucket.
 */
export async function isRetrieverConfigured(): Promise<boolean> {
  // Fast-path: explicit env vars set — no kubectl needed.
  if (isRetrieverConfiguredSync()) return true;
  // Full cascade — requires BOTH url and bucket.
  const r = await resolveRetrieverCached();
  return r.url != null && r.bucket != null;
}

export function formatRetrieverTrace(trace: RetrieverResolution['trace']): string {
  if (!trace.length) return '(no detection attempts logged)';
  return trace.map((t) => `  - ${t.path}: ${t.status} — ${t.reason}`).join('\n');
}

/** Cached resolution so call-sites inside a single tool invocation don't re-spawn aws/kubectl. */
let cachedResolution: { resolution: RetrieverResolution; at: number } | undefined;

async function resolveRetrieverCached(): Promise<RetrieverResolution> {
  const now = Date.now();
  if (cachedResolution && now - cachedResolution.at < 60_000) return cachedResolution.resolution;
  const r = await resolveRetriever();
  cachedResolution = { resolution: r, at: now };
  return r;
}

/** Reset the resolver cache — only for tests. */
export function clearRetrieverResolutionCacheForTest(): void {
  cachedResolution = undefined;
}

async function getRetrieverUrl(): Promise<string> {
  const r = await resolveRetrieverCached();
  if (!r.url) throw new RetrieverNotConfiguredError();
  return r.url;
}

async function getRetrieverBucket(): Promise<string> {
  const r = await resolveRetrieverCached();
  if (!r.bucket) throw new RetrieverNotConfiguredError();
  return r.bucket;
}

async function tryDetectRetrieverBucketFromAws(): Promise<{ bucket?: string; reason: string; failed?: boolean }> {
  // Skip if aws CLI is obviously not reachable (cheap check to avoid spawn cost).
  if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION && !process.env.AWS_PROFILE) {
    return { reason: 'no AWS_REGION / AWS_PROFILE in env' };
  }
  try {
    const { stdout } = await execFileP('aws', ['s3api', 'list-buckets', '--output', 'json'], {
      timeout: 8_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { Buckets?: Array<{ Name: string }> };
    const names = (parsed.Buckets || []).map((b) => b.Name);
    const matches = names.filter(
      (n) =>
        n.startsWith('log10x-retriever-') ||
        n.endsWith('-log10x-archive') ||
        n.includes('log10x-retriever')
    );
    if (matches.length === 0) {
      return { reason: `aws s3api list-buckets returned ${names.length} buckets, none match log10x-retriever-* / *-log10x-archive` };
    }
    if (matches.length > 1) {
      return {
        reason: `${matches.length} candidate buckets match log10x-retriever patterns — set __SAVE_LOG10X_RETRIEVER_BUCKET__ to disambiguate (candidates: ${matches.join(', ')})`,
      };
    }
    return { bucket: matches[0], reason: `aws s3api list-buckets → single log10x-retriever bucket ${matches[0]}` };
  } catch (e) {
    return {
      failed: true,
      reason: `aws s3api list-buckets failed: ${((e as Error).message || '').slice(0, 160)}`,
    };
  }
}

async function tryDetectRetrieverUrlFromKubectl(): Promise<{ url?: string; reason: string; failed?: boolean }> {
  try {
    const { stdout } = await execFileP(
      'kubectl',
      ['get', 'svc', '-A', '-l', 'app.kubernetes.io/name=log10x-retriever', '-o', 'json'],
      { timeout: 8_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout) as {
      items?: Array<{
        metadata: { name: string; namespace: string };
        spec?: { ports?: Array<{ port: number; name?: string }> };
      }>;
    };
    const items = parsed.items || [];
    // Prefer the query-handler service; fall back to any single match.
    const qh = items.find((i) => i.metadata.name.includes('query-handler') || i.metadata.name.endsWith('query'));
    const chosen = qh || (items.length === 1 ? items[0] : undefined);
    if (!chosen) {
      return { reason: `kubectl found ${items.length} log10x-retriever services — none clearly a query-handler` };
    }
    const port = chosen.spec?.ports?.[0]?.port ?? 8080;
    const url = `http://${chosen.metadata.name}.${chosen.metadata.namespace}.svc.cluster.local:${port}`;
    return {
      url,
      reason: `kubectl get svc → ${chosen.metadata.namespace}/${chosen.metadata.name}:${port}`,
    };
  } catch (e) {
    return { failed: true, reason: `kubectl probe failed: ${((e as Error).message || '').slice(0, 160)}` };
  }
}

async function tryDetectRetrieverFromTerraformState(): Promise<{ url?: string; bucket?: string; target?: string; reason: string; failed?: boolean }> {
  const path =
    process.env.LOG10X_TERRAFORM_STATE ||
    (process.env.HOME ? `${process.env.HOME}/.log10x/retriever.tfstate` : undefined);
  if (!path) return { reason: 'no LOG10X_TERRAFORM_STATE and no HOME to find ~/.log10x/retriever.tfstate' };
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(path, 'utf8');
    const state = JSON.parse(raw) as { outputs?: Record<string, { value: unknown }> };
    const outputs = state.outputs || {};
    const get = (k: string): string | undefined => {
      const v = outputs[k]?.value;
      return typeof v === 'string' ? v : undefined;
    };
    const url = get('retriever_url') || get('query_handler_url');
    const bucket = get('retriever_bucket') || get('archive_bucket');
    const target = get('retriever_target');
    if (!url || !bucket) {
      return { reason: `terraform state at ${path} missing retriever_url/retriever_bucket outputs` };
    }
    return { url: url.replace(/\/+$/, ''), bucket, target, reason: `read ${path}` };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { reason: `${path} not present` };
    return { failed: true, reason: `read ${path} failed: ${(err.message || '').slice(0, 160)}` };
  }
}

async function getDefaultTarget(): Promise<string> {
  const explicit = process.env.__SAVE_LOG10X_RETRIEVER_TARGET__;
  if (explicit) return explicit;
  const r = await resolveRetrieverCached();
  return r.target || 'app';
}

function authHeaders(env: EnvConfig): Record<string, string> {
  const customHeader = process.env.LOG10X_RETRIEVER_AUTH_HEADER;
  const customValue = process.env.LOG10X_RETRIEVER_AUTH_VALUE;
  if (customHeader && customValue) {
    return { [customHeader]: customValue, 'Content-Type': 'application/json' };
  }
  return {
    'X-10X-Auth': `${env.apiKey}/${env.envId}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Convert the MCP-level `from`/`to` expressions to a form the retriever engine
 * reliably parses.
 *
 * Empirical behavior of the retriever server:
 *   - `now("-1h")` / `now()`    → accepted, matches events
 *   - epoch millis as a string  → accepted, matches events
 *   - ISO8601 like `2026-04-15T11:00:00Z` → accepted (HTTP 200), runs the
 *     query, returns ZERO events even when the wall-clock range should match
 *     — the server-side TenXDate parser mishandles ISO8601 and silently
 *     produces a non-matching range.
 *
 * To make ISO8601 inputs work reliably, this function converts them to epoch
 * millis strings before they leave the MCP. `now(...)` expressions are
 * preserved verbatim (they require server-side evaluation).
 *
 * Filed upstream as a retriever engine bug. The client-side conversion below
 * is the workaround, not the fix.
 */
export function normalizeTimeExpression(expr: string): string {
  const trimmed = expr.trim();
  if (!trimmed) throw new Error('Empty time expression');

  // The engine expects runtime-evaluated JS expressions prefixed with `$=`
  // (the template-language marker). Without the prefix, the engine treats
  // the string as a literal and fails to parse. Verified live on the
  // otel-demo env: CronJob-dispatched query bodies use `$=now("-5m")` /
  // `$=now()` and run correctly; the same bodies without the prefix get
  // silently dropped (client-side root cause).
  if (trimmed === 'now') return '$=now()';

  const rel = trimmed.match(/^now\s*([+-])\s*(\d+)\s*([smhdwMy])$/);
  if (rel) {
    return `$=now("${rel[1]}${rel[2]}${rel[3]}")`;
  }

  // Already in now("-1h") form — prepend the eval prefix.
  if (/^now\s*\(/.test(trimmed)) return `$=${trimmed}`;

  // Already in $=now(...) form — pass through.
  if (/^\$=now\s*\(/.test(trimmed)) return trimmed;

  // Pure digit string — already epoch millis, pass through as a literal
  // (no $= prefix — the engine treats plain millis as a value, not JS).
  if (/^\d+$/.test(trimmed)) return trimmed;

  // ISO8601 or any other string JavaScript's Date.parse() understands.
  // Convert to epoch millis as a literal string.
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return String(parsed);
  }

  // Unknown format — pass through and let the server reject it loudly.
  return trimmed;
}

/** Expose for validation at the tool layer. */
export function parseTimeExpression(expr: string): string {
  return normalizeTimeExpression(expr);
}

interface SubmitResponse {
  queryId: string;
}

async function submitQuery(
  env: EnvConfig,
  body: Record<string, unknown>
): Promise<SubmitResponse> {
  const base = await getRetrieverUrl();
  // The engine still routes the query handler at `/streamer/query`
  // (see StreamerQuery.java) — the path will rename to `/retriever/query`
  // when the engine cuts the rename PR. `LOG10X_RETRIEVER_QUERY_PATH`
  // lets the MCP work against both old and new engines without a rebuild.
  const path = process.env.LOG10X_RETRIEVER_QUERY_PATH || '/streamer/query';
  const resp = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Retriever POST ${path} HTTP ${resp.status}: ${errText.slice(0, 500)}`);
  }

  const parsed = (await resp.json()) as SubmitResponse;
  if (!parsed.queryId) {
    throw new Error('Retriever response missing queryId');
  }
  return parsed;
}

/**
 * Returns true when the thrown error from `submitQuery()` is a transport-level
 * failure (DNS, TCP) where the SQS fallback is meaningful. HTTP-level errors
 * (4xx, 5xx) indicate the server is reachable — SQS would face the same
 * rejection and should NOT be attempted.
 */
function isNetworkLevelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Match ENOTFOUND (DNS), ECONNREFUSED (port closed), ECONNRESET (TCP torn),
  // ETIMEDOUT (TCP connect timeout), and Node fetch's generic "fetch failed"
  // wrapper. Exclude "HTTP <status>" messages — those are reachable-server
  // errors where SQS is no better.
  return /ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|network/i.test(msg) &&
    !/HTTP\s+\d{3}/i.test(msg);
}

let _sqsClient: SQSClient | undefined;
function sqsClient(): SQSClient {
  if (!_sqsClient) {
    _sqsClient = new SQSClient({
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    });
  }
  return _sqsClient;
}

/**
 * Send the query body to the Quarkus ingress queue as a fallback when the
 * HTTP path fails with a transport-level error (e.g., ClusterIP URL
 * unreachable from outside the cluster). The queryId is pre-generated by the
 * caller so S3 polling uses the same key regardless of which transport fires.
 *
 * Requires `LOG10X_RETRIEVER_QUERY_QUEUE_URL` to be set. When absent, throws
 * with error_type "config_missing" so the chassis envelope surfaces the
 * missing env var rather than a confusing network error.
 *
 * IAM required (caller's AWS credentials):
 *   - sqs:SendMessage on the queue URL
 *
 * Response delivery is identical to the HTTP path — results land in S3 under
 * the same `qr/{queryId}/` prefix. No SQS reply-to; the caller polls S3.
 */
async function submitViaSqs(
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<void> {
  const queueUrl = process.env.LOG10X_RETRIEVER_QUERY_QUEUE_URL;
  if (!queueUrl) {
    const err = new Error(
      'SQS fallback requires LOG10X_RETRIEVER_QUERY_QUEUE_URL to be set. ' +
      'Set it to the Quarkus ingress queue URL (e.g., https://sqs.<region>.amazonaws.com/<account>/tenx-retriever-query-<id>). ' +
      'The queue name can be found in the retriever pod env as TENX_QUARKUS_QUERY_QUEUE_URL. ' +
      'Also ensure the MCP process has sqs:SendMessage on the queue.'
    );
    (err as Error & { error_type?: string }).error_type = 'config_missing';
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5_000));
  try {
    await sqsClient().send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(body),
        DelaySeconds: 0,
      }),
      { abortSignal: controller.signal }
    );
  } finally {
    clearTimeout(timer);
  }
}

interface S3ListEntry {
  Key: string;
  Size: number;
}

// NOTE on pagination: `aws s3api list-objects-v2` AUTO-PAGINATES by default —
// the CLI follows NextContinuationToken internally and merges all pages into
// one Contents array (verified live: 54,597 keys returned on a single call vs
// 1,000 with --no-paginate). Do NOT add manual token loops here. The real
// ceiling is maxBuffer: ~150 bytes/key JSON means 32 MB covers ~200k keys.
async function s3List(bucket: string, prefix: string): Promise<S3ListEntry[]> {
  try {
    const { stdout } = await execFileP('aws', [
      's3api',
      'list-objects-v2',
      '--bucket',
      bucket,
      '--prefix',
      prefix,
      '--output',
      'json',
    ], { maxBuffer: 32 * 1024 * 1024 });

    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout) as { Contents?: S3ListEntry[] };
    return parsed.Contents || [];
  } catch (e) {
    // list-objects-v2 returns empty stdout when the prefix has no keys;
    // only real failures raise.
    const err = e as { stderr?: string; message?: string };
    const stderr = err.stderr || err.message || '';
    if (stderr.includes('NoSuchBucket')) {
      throw new Error(`Retriever bucket does not exist: ${bucket}`);
    }
    throw new Error(`aws s3api list-objects-v2 failed: ${stderr.slice(0, 400)}`);
  }
}

async function s3Get(bucket: string, key: string): Promise<string> {
  const { stdout } = await execFileP('aws', [
    's3',
    'cp',
    `s3://${bucket}/${key}`,
    '-',
  ], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Run `fn` over `items` with at most `concurrency` calls in flight, preserving
 * input order in the returned array. The first rejection propagates and an
 * abort flag stops idle workers from pulling new items — so one failed S3 read
 * aborts the whole fetch (matching the old serial loop's throw-on-error
 * semantics) instead of silently returning a partial result set.
 *
 * Why bounded (not Promise.all over everything): the Retriever fans out to
 * dozens of stream workers, each writing its own JSONL. An unbounded fan-in
 * would spawn an `aws s3 cp` subprocess per file simultaneously (each buffering
 * up to 64 MB) and can trip S3 503 SlowDown on a hot prefix. A small pool
 * captures the bandwidth win without the blowup.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let aborted = false;
  async function worker(): Promise<void> {
    while (!aborted) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        aborted = true;
        throw e;
      }
    }
  }
  const pool = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return results;
}

/**
 * Like mapWithConcurrency but per-item failures do NOT abort the run:
 * failed slots return undefined and are reported in `failures`. Used by the
 * result-download paths so one persistently-failing worker file (e.g. S3
 * 503 SlowDown that outlives retries) degrades the fetch to partial instead
 * of losing the whole query.
 */
export async function mapWithConcurrencySettled<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<{ results: Array<R | undefined>; failures: Array<{ index: number; error: Error }> }> {
  // fill() makes failed slots EXPLICIT undefined (not array holes) so
  // consumers can rely on results.length === items.length with in-band
  // undefined markers.
  const results = new Array<R | undefined>(items.length).fill(undefined);
  const failures: Array<{ index: number; error: Error }> = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        failures.push({ index: i, error: e instanceof Error ? e : new Error(String(e)) });
      }
    }
  }
  const pool = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return { results, failures };
}

/**
 * Download per-worker JSONL in concurrency-bounded BATCHES, stopping once
 * `budget` events have accumulated. Order-preserving over the files actually
 * pulled. Used to cap the qr/ download to a preview-sized sample when qrs/
 * summaries already supply the whole-match count + rollups, so a huge match
 * never materializes client-side.
 */
export async function downloadEventsUntilBudget(
  keys: readonly string[],
  budget: number,
  concurrency: number,
  fetchParse: (key: string) => Promise<RetrieverEvent[]>,
): Promise<{ events: RetrieverEvent[]; failures: number; filesDownloaded: number; stoppedEarly: boolean }> {
  const events: RetrieverEvent[] = [];
  let failures = 0;
  let filesDownloaded = 0;
  let i = 0;
  while (i < keys.length && events.length < budget) {
    const batch = keys.slice(i, i + concurrency);
    i += batch.length;
    const dl = await mapWithConcurrencySettled(batch, concurrency, fetchParse);
    failures += dl.failures.length;
    for (const chunk of dl.results) {
      if (chunk) {
        events.push(...chunk);
        filesDownloaded++;
      }
    }
  }
  return { events, failures, filesDownloaded, stoppedEarly: i < keys.length };
}

/**
 * s3Get with bounded retry. S3 503 SlowDown / transient network errors on a
 * hot prefix are retryable; two backed-off retries clear the vast majority.
 */
async function s3GetWithRetry(bucket: string, key: string, attempts = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await s3Get(bucket, key);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1) * (i + 1)));
    }
  }
  throw lastErr;
}

/** Bounded concurrency for the per-worker S3 result downloads. */
const RETRIEVER_DOWNLOAD_CONCURRENCY =
  Number(process.env.LOG10X_RETRIEVER_DOWNLOAD_CONCURRENCY) || 8;

function parseJsonl(content: string): RetrieverEvent[] {
  const events: RetrieverEvent[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      let parsed: unknown = JSON.parse(trimmed);
      // Defend against double-encoded events: if the JSONL line parses to
      // a STRING (not an object), the upstream writer serialized an event
      // to JSON, then wrapped the result in another string literal. Re-parse
      // once to recover the real object. Seen in the otel-k8s sample where
      // events are captured as JSON strings embedded in a fluent-bit
      // tenx_tag field. Without this guard, downstream code that treats
      // ev as an object throws `Cannot create property 'enrichedFields' on
      // string '{...}'`.
      if (typeof parsed === 'string') {
        try {
          const reparsed = JSON.parse(parsed);
          if (reparsed && typeof reparsed === 'object') {
            parsed = reparsed;
          } else {
            continue; // still not an object — skip this line
          }
        } catch {
          continue; // double-encoded-but-not-valid-JSON; skip
        }
      }
      if (!parsed || typeof parsed !== 'object') continue;
      // Shape guard: discard records that don't look like real retriever
      // events. The upstream writer on the demo env has a bug where `text`
      // field values contain literal unescaped newlines, so our
      // split(/\r?\n/) breaks real event records into fragments. Some
      // fragments happen to be valid JSON themselves (e.g. the fluentd
      // stream/log/docker/kubernetes/tenx_tag shape embedded inside the
      // `text` field). Without a guard, those get pushed as "events" with
      // bogus shapes and pollute downstream rollups ("unknown: 9" in the
      // count summary).
      //
      // Real retriever events always have at least one of:
      //   - `timestamp` (as scalar or [scalar])
      //   - `text` (the raw content field)
      //   - `tenx_user_service` or `tenx_user_process` (enrichment labels)
      //   - `LevelTemplate.severity_level` or `MessageTemplate.message_pattern`
      // Fluentd-wrapped fragments have NONE of these — they have
      // `stream`, `log`, `docker`, `kubernetes`, `tenx_tag` instead.
      const obj = parsed as Record<string, unknown>;
      const hasRealEventShape =
        'timestamp' in obj ||
        'text' in obj ||
        'tenx_user_service' in obj ||
        'tenx_user_process' in obj ||
        'LevelTemplate.severity_level' in obj ||
        'MessageTemplate.message_pattern' in obj;
      if (!hasRealEventShape) continue;
      events.push(parsed as RetrieverEvent);
    } catch {
      // Skip unparseable lines — the worker may have written a partial
      // record on the way down; the next poll will pick up the retry.
    }
  }
  return events;
}

/**
 * Normalize a retriever event's timestamp to epoch-ms.
 *
 * The retriever encodes timestamps as `[<scalar>]` (array wrapping a single
 * value). The scalar's unit varies by upstream pipeline configuration —
 * fluent-bit ships seconds, the engine's TenXObject ships millis or nanos
 * depending on the input adapter. Magnitude-based detection is the only
 * portable approach.
 *
 * Ranges (today's epoch ≈ 1.77 × 10^X):
 *   - seconds: ~1.77e9   (10 digits)
 *   - millis:  ~1.77e12  (13 digits)
 *   - micros:  ~1.77e15  (16 digits)
 *   - nanos:   ~1.77e18  (19 digits)
 *
 * Boundaries are placed at 10^10, 10^13, 10^16 — one decade below the
 * current epoch in each unit so 13-digit millis values like 1776851170107
 * (2026-04-22) are correctly classified as millis instead of falsely
 * matching the looser `>1e12` micros boundary and dividing by 1000 to
 * land in 1970. Without the decade-below boundary, the entire bucket
 * histogram aliases to 1970 because 13-digit millis falsely match the
 * looser micros boundary and get divided by 1000.
 */
export function eventTimestampMs(ev: RetrieverEvent): number {
  let ts: unknown = ev.timestamp;
  if (Array.isArray(ts) && ts.length > 0) {
    ts = ts[0];
  }
  if (typeof ts === 'number') {
    return classifyTs(ts);
  }
  if (typeof ts === 'string') {
    const asNum = Number(ts);
    if (Number.isFinite(asNum)) return classifyTs(asNum);
    const asDate = Date.parse(ts);
    if (Number.isFinite(asDate)) return asDate;
  }
  return 0;
}

function classifyTs(ts: number): number {
  if (ts >= 1e16) return Math.floor(ts / 1_000_000); // nanos → ms
  if (ts >= 1e13) return Math.floor(ts / 1_000); // micros → ms
  if (ts >= 1e10) return ts; // millis already
  if (ts > 0) return ts * 1000; // seconds → ms
  return 0;
}

/**
 * Coordinator-written completion marker. Arrival means the coordinator has
 * finished dispatching; `expectedMarkers` tells callers how many per-worker
 * byte-count markers to wait for before reading results.
 */
interface DoneMarkerBody {
  queryId?: string;
  completedAt?: number;
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
}

async function waitForDoneMarker(
  bucket: string,
  key: string,
  pollMs: number,
  timeoutMs: number
): Promise<DoneMarkerBody | null> {

  const started = Date.now();

  while (Date.now() - started < timeoutMs) {

    try {

      const body = await s3Get(bucket, key);

      if (body && body.trim().length > 0) {
        try {
          return JSON.parse(body) as DoneMarkerBody;
        } catch {
          // Partial read; retry next poll.
        }
      }

    } catch {
      // NoSuchKey until the marker lands.
    }

    await sleep(pollMs);
  }

  return null;
}

/**
 * Poll the byte-count marker prefix until `expected` keys are present, or
 * the budget expires.
 */
async function waitForMarkerCount(
  bucket: string,
  markerPrefix: string,
  expected: number,
  pollMs: number,
  timeoutMs: number
): Promise<S3ListEntry[]> {

  const started = Date.now();
  let entries: S3ListEntry[] = [];

  while (Date.now() - started < timeoutMs) {

    entries = await s3List(bucket, markerPrefix);

    if (entries.length >= expected) {
      return entries;
    }

    await sleep(pollMs);
  }

  return entries;
}

/**
 * Poll the marker prefix until the same set of markers is observed twice in
 * a row (stability = no new workers landing). Returns the stable list of
 * marker keys.
 */
async function waitForMarkerStability(
  bucket: string,
  markerPrefix: string,
  pollMs: number,
  timeoutMs: number
): Promise<S3ListEntry[]> {
  const started = Date.now();
  let previous: string[] = [];
  let stableCount = 0;

  while (Date.now() - started < timeoutMs) {
    const entries = await s3List(bucket, markerPrefix);
    const keys = entries.map((e) => e.Key).sort();

    if (keys.length > 0 && keys.length === previous.length && keys.every((k, i) => k === previous[i])) {
      stableCount++;
      if (stableCount >= 2) {
        return entries;
      }
    } else {
      stableCount = keys.length > 0 ? 1 : 0;
    }
    previous = keys;
    await sleep(pollMs);
  }

  // Timed out — return whatever we saw last so the caller can surface a
  // partial result rather than a hard failure.
  return previous.map((key) => ({ Key: key, Size: 0 }));
}

export async function runRetrieverQuery(
  env: EnvConfig,
  req: RetrieverQueryRequest,
  // Per-call overrides for poll interval + total budget. When unset, the
  // env var defaults apply (LOG10X_RETRIEVER_POLL_MS, LOG10X_RETRIEVER_TIMEOUT_MS).
  // retriever_series passes a tighter budget for sampled-mode sub-window
  // calls so a single slow sub-window doesn't stall the whole fan-out.
  options?: { timeoutMs?: number; pollIntervalMs?: number }
): Promise<RetrieverQueryResponse> {
  const bucket = await getRetrieverBucket();
  const target = req.target || (await getDefaultTarget());
  // Tier-1 result-sink redirect: when set, the engine writes OUTPUT under
  // tenx/{resultTarget}/ instead of tenx/{target}/, so every result/marker
  // prefix the MCP polls below must use it. Reads of the durable index are
  // engine-side and config-bound, so they are unaffected. Blank => legacy
  // (resultTarget === target), and the body field is omitted entirely.
  const resultTarget =
    req.resultTarget && req.resultTarget.trim() ? req.resultTarget.trim() : target;
  const queryId = randomUUID();
  const pollMs =
    options?.pollIntervalMs ?? parseInt(process.env.LOG10X_RETRIEVER_POLL_MS || '1500', 10);
  const timeoutMs =
    options?.timeoutMs ?? parseInt(process.env.LOG10X_RETRIEVER_TIMEOUT_MS || '180000', 10);

  // Minimal body format that matches the shape the engine's query-handler
  // actually expects. Previously the MCP sent `target`, `readContainer`,
  // `indexContainer`, `objectStorageName`, `processingTime`, `resultSize`
  // fields which the engine silently ignored, but the missing `name` field
  // caused the query-handler to drop the request without any log trace. The
  // `name` field becomes `queryName` in the engine override chain and is used
  // as the input stream handle inside the pipeline.
  //
  // Fields that belong in the body:
  //   name           — logical query name, used as the stream handle
  //   from / to      — must be `$=now(...)` runtime-eval form or epoch ms
  //   search         — Bloom-filter-level (fast, index-scoped)
  //   filters        — JS-expression post-filter (in-memory after decode)
  //   writeResults   — gates JSONL output to the `qr/{queryId}/` prefix
  //   id             — correlation key the MCP uses to poll S3 markers
  //
  // Fields that MUST NOT be in the body (all defaulted from handler config):
  //   target, readContainer, indexContainer, objectStorageName,
  //   processingTime, resultSize — sending these causes the engine to
  //   reject the query shape and silently drop it.
  // Default to events-only for legacy call sites; opt-in to summaries
  // (or events-off) by setting the flags explicitly. `writeResults`
  // defaults to true so existing tools keep getting raw events.
  const writeResults = req.writeResults ?? true;
  const writeSummaries = req.writeSummaries ?? false;

  // `pattern` is deprecated on this request shape, but direct callers
  // (investigate stage-1) still pass it without `search` — and the old body
  // builder silently dropped it, scanning UNFILTERED. Translate it here so
  // the API layer can never silently widen a scoped query.
  const effectiveSearch = req.search || (req.pattern ? buildPatternSearch(req.pattern) : '');

  const body: Record<string, unknown> = {
    id: queryId,
    name: req.name || `mcp-${queryId.slice(0, 8)}`,
    from: normalizeTimeExpression(req.from),
    to: normalizeTimeExpression(req.to || 'now'),
    search: effectiveSearch,
    filters: req.filters || [],
    ...(req.logLevels ? { logLevels: req.logLevels } : {}),
    writeResults,
    writeSummaries,
    // Maps to the engine `queryResultTarget` option (body field -> query<Field>).
    // Only sent on an actual redirect so the legacy wire shape is preserved.
    ...(resultTarget !== target ? { resultTarget } : {}),
  };

  const started = Date.now();

  // Submit via HTTP (primary path). On a transport-level failure (DNS /
  // TCP — typically a ClusterIP URL from a helm probe that is unreachable
  // from outside the cluster), fall through to the SQS ingress queue.
  // HTTP-level errors (4xx, 5xx) propagate immediately — SQS cannot fix a
  // reachable server that is rejecting the request.
  let transport: 'http' | 'sqs' = 'http';
  let httpErr: unknown;
  try {
    await submitQuery(env, body);
  } catch (err: unknown) {
    if (!isNetworkLevelError(err)) {
      // Server was reachable; re-throw so the chassis error path handles it.
      throw err;
    }
    httpErr = err;
  }

  if (httpErr !== undefined) {
    // HTTP transport failed at the network layer. Attempt SQS fallback.
    const sqsTimeoutMs = parseInt(process.env.LOG10X_RETRIEVER_SQS_TIMEOUT_MS || '60000', 10);
    try {
      await submitViaSqs(body, sqsTimeoutMs);
      transport = 'sqs';
    } catch (sqsErr: unknown) {
      // Both paths failed. Build a dual-failure error that carries both
      // breadcrumbs. The config_missing special-case gets its own type;
      // all other SQS failures are backend_unavailable.
      const sqsMsg = sqsErr instanceof Error ? sqsErr.message : String(sqsErr);
      const sqsErrType =
        (sqsErr as Error & { error_type?: string }).error_type === 'config_missing'
          ? 'config_missing'
          : 'backend_unavailable';
      const httpMsg = httpErr instanceof Error ? httpErr.message : String(httpErr);
      const dualErr = new Error(
        `HTTP transport failed (${httpMsg.slice(0, 200)}); ` +
        `SQS fallback also failed: ${sqsMsg.slice(0, 200)}. ` +
        `Both ingress paths were attempted. ` +
        (sqsErrType === 'config_missing'
          ? 'Set LOG10X_RETRIEVER_QUERY_QUEUE_URL to the Quarkus ingress queue URL and ensure the MCP process has sqs:SendMessage on the queue.'
          : 'Check LOG10X_RETRIEVER_QUERY_QUEUE_URL is correct and the MCP process has sqs:SendMessage on the queue. Original HTTP error: ' + httpMsg.slice(0, 200))
      ) as Error & {
        transports_attempted: string[];
        http_error_message: string;
        sqs_error_type: string;
        sqs_error_message: string;
      };
      dualErr.transports_attempted = ['http', 'sqs'];
      dualErr.http_error_message = httpMsg.slice(0, 400);
      dualErr.sqs_error_type = sqsErrType;
      dualErr.sqs_error_message = sqsMsg.slice(0, 400);
      throw dualErr;
    }
  }

  // The engine's indexObjectPath builds `tenx/{target}/q(r)/{queryId}/`
  // under the configured indexContainer. When the indexContainer is
  // `<account>-cloud-retriever/indexing-results/` the full S3 key is
  // `indexing-results/tenx/{target}/...`. The
  // `LOG10X_RETRIEVER_INDEX_SUBPATH` env var lets deployments configure
  // their own index sub-prefix; default to `indexing-results`.
  const indexSubpath = (process.env.LOG10X_RETRIEVER_INDEX_SUBPATH || 'indexing-results').replace(/^\/+|\/+$/g, '');
  const basePrefix = indexSubpath ? `${indexSubpath}/` : '';
  const markerPrefix = `${basePrefix}tenx/${resultTarget}/q/${queryId}/`;
  const resultsPrefix = `${basePrefix}tenx/${resultTarget}/qr/${queryId}/`;
  const doneMarkerKey = `${resultsPrefix}_DONE.json`;

  // Prefer the coordinator-written _DONE marker. Fall back to the byte-count
  // stability heuristic for older retrievers that don't write it.
  const doneInfo = await waitForDoneMarker(bucket, doneMarkerKey, pollMs, timeoutMs);

  if (doneInfo && (doneInfo.expectedMarkers ?? 0) > 0) {
    const tailBudgetMs = Math.min(20_000, Math.max(0, timeoutMs - (Date.now() - started)));
    await waitForMarkerCount(bucket, markerPrefix, doneInfo.expectedMarkers ?? 0, pollMs, tailBudgetMs);
  } else {
    // Two cases land here:
    //   (a) _DONE.json missing entirely (legacy retriever) — pure stability fallback.
    //   (b) _DONE.json present but reports expectedMarkers=0. In remote-dispatch
    //       mode (the demo retriever, Lambda mode) the coordinator's counters
    //       only see LOCAL scan work; remote scan workers update their own
    //       per-process counters, so the coordinator writes _DONE with all-zero
    //       counts even when stream workers are still mid-flight. Trusting that
    //       value would race the stream-worker uploads. Falling back to marker
    //       stability is correct in both cases.
    await waitForMarkerStability(bucket, markerPrefix, pollMs, timeoutMs);
  }

  // The results writer only runs on workers that actually matched events, so
  // the results prefix may have fewer entries than the marker prefix — which
  // is correct. Truncation markers are siblings ending in `.truncated`.
  const resultObjects = writeResults ? await s3List(bucket, resultsPrefix) : [];

  let truncated = false;
  const jsonlKeys: string[] = [];
  for (const obj of resultObjects) {
    if (obj.Key.endsWith('.truncated')) {
      truncated = true;
      continue;
    }
    if (obj.Key.endsWith('.jsonl')) {
      jsonlKeys.push(obj.Key);
    }
  }

  // Part A: cap the qr/ DOWNLOAD when qrs/ summaries can serve the rollups +
  // count, so a huge match never materializes client-side. The engine still
  // wrote the full set (results_location carries it); we just stop pulling it.
  // Gate on a cheap qrs/ presence probe — with NO summaries we always download
  // everything so the true count + rollups are never lost.
  const maxDl = req.maxDownloadEvents;
  // The download cap is only safe to engage when summaries can serve the
  // rollups + count — which the rollup honesty rule forbids under filters[]
  // (the engine summary writer's filter behavior is unverified). So under
  // filters we keep the full download; the gate uses the SAME guard the
  // tool's selectRollups uses, or the two disagree.
  const filtersActive = Array.isArray(req.filters) && req.filters.length > 0;
  let summariesPresent = false;
  if (writeSummaries && !filtersActive && (maxDl === 0 || (typeof maxDl === 'number' && maxDl > 0))) {
    const qrsProbe = await s3List(bucket, `${basePrefix}tenx/${resultTarget}/qrs/${queryId}/`);
    summariesPresent = qrsProbe.some((o) => o.Key.endsWith('.jsonl'));
  }

  const events: RetrieverEvent[] = [];
  let failedWorkerFiles = 0;
  let downloadCapped = false;
  const fetchParse = async (key: string) => parseJsonl(await s3GetWithRetry(bucket, key));
  if (summariesPresent && maxDl === 0) {
    // Count / aggregate served entirely by summaries — pull NO qr/ events.
    downloadCapped = jsonlKeys.length > 0;
  } else if (summariesPresent && typeof maxDl === 'number' && maxDl > 0) {
    // Events format: pull only enough worker files to fill the return/preview.
    const dl = await downloadEventsUntilBudget(jsonlKeys, maxDl, RETRIEVER_DOWNLOAD_CONCURRENCY, fetchParse);
    for (const ev of dl.events) events.push(ev);
    failedWorkerFiles = dl.failures;
    downloadCapped = dl.stoppedEarly;
  } else {
    // Legacy / no-summaries path: full download (true count + rollups from events).
    const eventDl = await mapWithConcurrencySettled(jsonlKeys, RETRIEVER_DOWNLOAD_CONCURRENCY, fetchParse);
    failedWorkerFiles = eventDl.failures.length;
    for (const chunk of eventDl.results) if (chunk) events.push(...chunk);
  }

  events.sort((a, b) => eventTimestampMs(a) - eventTimestampMs(b));

  // qrs/ summaries — pulled in parallel with events, parsed with slice
  // bounds extracted from the S3 key path. Each writer outputs JSONL
  // under `qrs/{queryId}/{sliceFrom}_{sliceTo}/{worker}.jsonl` and the
  // engine sets `timestamp: []` on the records themselves, so the slice
  // segment in the key is the only time information.
  let summaries: RetrieverSummary[] | undefined;
  let slicesObserved = 0;
  if (writeSummaries) {
    const summariesPrefix = `${basePrefix}tenx/${resultTarget}/qrs/${queryId}/`;
    const summaryObjects = await s3List(bucket, summariesPrefix);
    summaries = [];
    const distinctSlices = new Set<string>();
    // Download summary files concurrently too; order-preserving so the pushed
    // summary order matches the old serial loop.
    const summaryFiles = summaryObjects
      .filter((obj) => obj.Key.endsWith('.jsonl'))
      .map((obj) => ({ obj, seg: parseSliceSegment(obj.Key, summariesPrefix) }))
      .filter((x): x is { obj: S3ListEntry; seg: NonNullable<typeof x.seg> } => x.seg !== null);
    const summaryDl = await mapWithConcurrencySettled(
      summaryFiles,
      RETRIEVER_DOWNLOAD_CONCURRENCY,
      async ({ obj, seg }) => ({ seg, content: await s3GetWithRetry(bucket, obj.Key) }),
    );
    const summaryContents = summaryDl.results.filter(
      (x): x is { seg: { fromMs: number; toMs: number }; content: string } => x !== undefined,
    );
    for (const { seg: sliceSegment, content } of summaryContents) {
      distinctSlices.add(`${sliceSegment.fromMs}_${sliceSegment.toMs}`);
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const raw = JSON.parse(trimmed) as Record<string, unknown>;
          const volume = raw.summaryVolume;
          if (typeof volume !== 'number' || volume <= 0) continue;
          // Spread the entire record so all named enrichment fields
          // (severity_level, k8s_pod, ...) come through as top-level
          // properties keyed by name. Slice bounds get attached from
          // the S3 key path; record-side `timestamp: []` is irrelevant
          // for summaries.
          summaries.push({
            ...raw,
            sliceFromMs: sliceSegment.fromMs,
            sliceToMs: sliceSegment.toMs,
            summaryVolume: volume,
            summaryBytes: typeof raw.summaryBytes === 'number' ? raw.summaryBytes : 0,
            summaryValuesHash:
              typeof raw.summaryValuesHash === 'string' ? raw.summaryValuesHash : undefined,
          } as RetrieverSummary);
        } catch {
          /* malformed line — skip */
        }
      }
    }
    slicesObserved = distinctSlices.size;
  }

  // Backfill legacy event fields from canonical enrichment fields so that
  // downstream code written against the old shape (aggregator, backfill)
  // keeps working. This is a shallow rename — we do not clone the event.
  for (const ev of events) {
    // The engine emits severity_level as the template-qualified path
    // `LevelTemplate.severity_level`. Normalize it back to the plain
    // field name the tool layer and aggregator expect.
    const levelTemplated = (ev as Record<string, unknown>)['LevelTemplate.severity_level'];
    if (ev.severity_level == null && typeof levelTemplated === 'string') {
      ev.severity_level = levelTemplated;
    }
    if (ev.service == null && typeof ev.tenx_user_service === 'string') {
      ev.service = ev.tenx_user_service;
    }
    if (ev.severity == null && typeof ev.severity_level === 'string') {
      ev.severity = ev.severity_level;
    }
    if (ev.enrichedFields == null) {
      const enriched: Record<string, string> = {};
      for (const [k, v] of Object.entries(ev)) {
        if (
          v != null &&
          typeof v !== 'object' &&
          k !== 'timestamp' &&
          k !== 'text' &&
          k !== 'service' &&
          k !== 'severity' &&
          k !== 'templateHash' &&
          k !== 'values' &&
          k !== 'enrichedFields'
        ) {
          enriched[k] = String(v);
        }
      }
      ev.enrichedFields = enriched;
    }
  }

  const limit = req.limit ?? 10_000;
  let finalEvents = events;
  if (events.length > limit) {
    finalEvents = events.slice(0, limit);
    truncated = true;
  }

  // Populate legacy aggregation fields from events for old callers.
  const buckets = computeBuckets(finalEvents, req.bucketSize || '5m');
  const countSummary = computeCountSummary(finalEvents);

  const wallTimeMs = Date.now() - started;
  const response: RetrieverQueryResponse = {
    queryId,
    // Report the prefix the result paths actually used (the redirect when set),
    // so a caller can re-fetch via fetchExistingResults({ target }) + queryId.
    target: resultTarget,
    from: String(body.from),
    to: String(body.to),
    execution: {
      wallTimeMs,
      eventsMatched: events.length,
      workerFiles: jsonlKeys.length,
      totalWorkerFiles: jsonlKeys.length,
      truncated,
      ...(failedWorkerFiles > 0 ? { failedWorkerFiles } : {}),
      ...(downloadCapped ? { downloadCapped: true } : {}),
      ...(summaries ? { summariesMatched: summaries.length, slicesObserved } : {}),
    },
    events: finalEvents,
    summaries,
    format: req.format || 'events',
    buckets,
    countSummary,
    transport,
    ...(transport === 'sqs' ? { sqsLatencyMs: wallTimeMs } : {}),
  };

  // Attach CloudWatch-sourced execution diagnostics. Best-effort — polling
  // errors surface as `diagnostics.pollingError` rather than being hidden.
  // Enables zero-result classification: stale indexer vs. bloom miss vs.
  // timeout vs. field-not-indexed, pinpointed via scanStats + errors.
  await attachDiagnostics(response, started);

  // Always-available funnel verdict from the coordinator's _DONE marker. The
  // CloudWatch diagnostics above are richer but go empty when the query-events
  // log group is unconfigured or its buffer hasn't flushed; the _DONE marker is
  // always in S3. This guarantees every zero-result query self-reports a verdict
  // + next step (EMPTY_RANGE / BLOOM_REJECTED_ALL / MATCHED_NO_EVENTS /
  // DISPATCHED_BLIND) instead of a bare "0 events".
  const funnel = diagnoseQuery(doneInfo ?? null, events.length, { failedWorkerFiles });
  response.diagnostics = { ...(response.diagnostics ?? {}), funnel };

  return response;
}

/**
 * Extract `{sliceFromMs}_{sliceToMs}` from a key like
 * `indexing-results/tenx/app/qrs/{queryId}/1777143600000_1777143660000/worker.jsonl`.
 * Returns null when the key is malformed (the writer always emits this
 * shape, so a miss is a coordinator/engine problem worth surfacing —
 * but we silently skip rather than failing the whole query).
 */
function parseSliceSegment(
  key: string,
  prefix: string
): { fromMs: number; toMs: number } | null {
  if (!key.startsWith(prefix)) return null;
  const tail = key.slice(prefix.length);
  const parts = tail.split('/');
  // Expect exactly: `{sliceSegment}/{worker}.jsonl`
  if (parts.length < 2) return null;
  const segMatch = parts[0].match(/^(\d+)_(\d+)$/);
  if (!segMatch) return null;
  return { fromMs: parseInt(segMatch[1], 10), toMs: parseInt(segMatch[2], 10) };
}

function computeBuckets(events: RetrieverEvent[], bucketSize: string): RetrieverBucket[] {
  const m = bucketSize.trim().match(/^(\d+)([smhd])$/);
  let bucketMs = 5 * 60_000;
  if (m) {
    const n = parseInt(m[1], 10);
    switch (m[2]) {
      case 's':
        bucketMs = n * 1000;
        break;
      case 'm':
        bucketMs = n * 60_000;
        break;
      case 'h':
        bucketMs = n * 3_600_000;
        break;
      case 'd':
        bucketMs = n * 86_400_000;
        break;
    }
  }
  const out = new Map<number, number>();
  for (const ev of events) {
    const ts = eventTimestampMs(ev);
    if (!ts) continue;
    const key = Math.floor(ts / bucketMs) * bucketMs;
    out.set(key, (out.get(key) || 0) + 1);
  }
  return [...out.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, count]) => ({ timestamp: new Date(ts).toISOString(), count }));
}

function computeCountSummary(events: RetrieverEvent[]): RetrieverQueryResponse['countSummary'] {
  const byService: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byDay: Record<string, number> = {};

  for (const ev of events) {
    const svc = (ev.tenx_user_service as string) || (ev.service as string) || '';
    if (svc) byService[svc] = (byService[svc] || 0) + 1;

    const sev = (ev.severity_level as string) || (ev.severity as string) || '';
    if (sev) bySeverity[sev] = (bySeverity[sev] || 0) + 1;

    const ts = eventTimestampMs(ev);
    if (ts) {
      const day = new Date(ts).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
    }
  }

  return {
    total: events.length,
    byService,
    bySeverity,
    byDay,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
