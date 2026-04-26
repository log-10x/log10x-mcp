/**
 * Log10x Retriever REST client + S3 results poller.
 *
 * The Retriever's query API is two-phase:
 *
 *   1. POST /retriever/query with a body shaped like QueryRequest.java accepts.
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
}

export type RetrieverDetectionPath =
  | 'explicit_env'
  | 'aws_s3_bucket_pattern'
  | 'kubectl_service'
  | 'terraform_state';

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

  return { trace };
}

export function isRetrieverConfigured(): boolean {
  // Sync helper retained for callers that need a quick check before paying
  // the cost of a full async resolve. Covers only the explicit-env path;
  // `resolveRetriever()` for the full cascade.
  return Boolean(process.env.__SAVE_LOG10X_RETRIEVER_URL__ && process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__);
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
 * Empirical behavior of the retriever server (tested 2026-04-15 against the
 * demo env deployment):
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
  // silently dropped. GAPS G12 root cause (client-side half).
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

interface S3ListEntry {
  Key: string;
  Size: number;
}

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
 * land in 1970. (Bug discovered live during retriever_series testing
 * 2026-04-23 — the entire bucket histogram aliased to 1970-01-21.)
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
  const queryId = randomUUID();
  const pollMs =
    options?.pollIntervalMs ?? parseInt(process.env.LOG10X_RETRIEVER_POLL_MS || '1500', 10);
  const timeoutMs =
    options?.timeoutMs ?? parseInt(process.env.LOG10X_RETRIEVER_TIMEOUT_MS || '180000', 10);

  // Minimal body format — matches the shape the engine's query-handler
  // actually expects (verified live on the otel-demo env 2026-04-15).
  // Previously the MCP sent `target`, `readContainer`, `indexContainer`,
  // `objectStorageName`, `processingTime`, `resultSize` fields which the
  // engine silently ignored — but the missing `name` field caused the
  // query-handler to drop the request without any log trace. The `name`
  // field becomes `queryName` in the engine override chain and is used
  // as the input stream handle inside the pipeline. GAPS G12.
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

  const body: Record<string, unknown> = {
    id: queryId,
    name: req.name || `mcp-${queryId.slice(0, 8)}`,
    from: normalizeTimeExpression(req.from),
    to: normalizeTimeExpression(req.to || 'now'),
    search: req.search || '',
    filters: req.filters || [],
    writeResults,
    writeSummaries,
  };

  const started = Date.now();
  await submitQuery(env, body);

  // The engine's indexObjectPath builds `tenx/{target}/q(r)/{queryId}/`
  // under the configured indexContainer. On the otek demo env the
  // indexContainer is `tenx-demo-cloud-retriever-351939435334/indexing-results/`
  // so the full S3 key is `indexing-results/tenx/{target}/...`. The
  // `LOG10X_RETRIEVER_INDEX_SUBPATH` env var lets deployments configure
  // their own index sub-prefix; default to `indexing-results` to match
  // the otek deploy.
  const indexSubpath = (process.env.LOG10X_RETRIEVER_INDEX_SUBPATH || 'indexing-results').replace(/^\/+|\/+$/g, '');
  const basePrefix = indexSubpath ? `${indexSubpath}/` : '';
  const markerPrefix = `${basePrefix}tenx/${target}/q/${queryId}/`;
  const resultsPrefix = `${basePrefix}tenx/${target}/qr/${queryId}/`;
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

  const events: RetrieverEvent[] = [];
  for (const key of jsonlKeys) {
    const content = await s3Get(bucket, key);
    events.push(...parseJsonl(content));
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
    const summariesPrefix = `${basePrefix}tenx/${target}/qrs/${queryId}/`;
    const summaryObjects = await s3List(bucket, summariesPrefix);
    summaries = [];
    const distinctSlices = new Set<string>();
    for (const obj of summaryObjects) {
      if (!obj.Key.endsWith('.jsonl')) continue;
      const sliceSegment = parseSliceSegment(obj.Key, summariesPrefix);
      if (!sliceSegment) continue;
      distinctSlices.add(`${sliceSegment.fromMs}_${sliceSegment.toMs}`);
      const content = await s3Get(bucket, obj.Key);
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

  return {
    queryId,
    target,
    from: String(body.from),
    to: String(body.to),
    execution: {
      wallTimeMs: Date.now() - started,
      eventsMatched: events.length,
      workerFiles: jsonlKeys.length,
      truncated,
      ...(summaries ? { summariesMatched: summaries.length, slicesObserved } : {}),
    },
    events: finalEvents,
    summaries,
    format: req.format || 'events',
    buckets,
    countSummary,
  };
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
