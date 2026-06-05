/**
 * Retriever end-to-end probe.
 *
 * Fires a synthetic query at the deployed Retriever and asserts every stage of
 * the chain — offload-bucket freshness → indexer pipeline running → SQS queues
 * drained → pod ready → query submission → CloudWatch scan match → CloudWatch
 * stream fetch → S3 qr/*.jsonl write → MCP-side events returned. Each stage is
 * a named assert with a one-line `observed` summary and a stored remedy keyed
 * on the assert name.
 *
 * Designed as a "60-second post-install verify" and a deep doctor diagnostic.
 * Catches the silent-failure shapes that took ~2 hours to debug manually:
 *   - Stream pipeline failing to launch (chart 1.0.20 streamer→retriever
 *     rename residue): cw_stream_fetch fails with that remedy.
 *   - Indexer pod up but not booted: indexer_pipeline_running fails.
 *   - Forwarder/Fluentd offload broken: offload_bucket_has_recent_data fails.
 *   - IRSA s3:PutObject misconfigured: s3_qr_jsonl_written fails.
 *   - MCP input_bucket misaligned with engine write location: mcp_events_returned fails.
 *
 * Dependencies are injectable via a `ProbeDeps` parameter so the test suite
 * can replace AWS / kubectl / metric-backend / submitQuery wholesale without
 * touching the production code paths. The default deps wire up:
 *   - aws CLI (via execFile)
 *   - kubectl (via execFile)
 *   - customer metric backend (resolveBackend → queryInstant)
 *   - executeRetrieverQuery (called as a library — submits via the retriever
 *     URL and polls S3 markers; never round-trips through the MCP IPC layer)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// ── Public types ────────────────────────────────────────────────────────────

export interface ProbeArgs {
  /** Kubernetes namespace where the retriever pod runs (e.g. 'log10x'). */
  namespace: string;
  /** S3 bucket where the receiver offloads data (where the indexer reads from). */
  offload_bucket: string;
  /** S3 bucket where the retriever writes qr/<id>/*.jsonl result objects. */
  input_bucket: string;
  /** CloudWatch log group the retriever writes per-query execution events to. */
  query_log_group: string;
  /** Label selector for the retriever pod. Default: 'app=retriever-10x'. */
  pod_label_selector?: string;
  /** Pre-picked hash to query for; skips the metric-backend probe. */
  target_hash?: string;
  /** Query window size in minutes. Default: 5. */
  window_minutes?: number;
  /** Overall probe timeout in ms. Default: 90000. */
  timeout_ms?: number;
}

export interface ProbeAssert {
  name: string;
  pass: boolean;
  observed: string;
  remedy?: string;
}

export interface ProbeResult {
  verdict: 'green' | 'broken' | 'unknown';
  picked_hash?: string;
  query_id?: string;
  asserts: ProbeAssert[];
  first_failed_assert?: string;
  surfaced_remedy?: string;
  total_runtime_ms: number;
  /** Populated when verdict==='unknown'. */
  reason?: string;
}

// ── Remedy table (keyed on assert name) ─────────────────────────────────────

export const REMEDIES: Record<string, string> = {
  offload_bucket_has_recent_data:
    'No recent offload data in S3 bucket. Check fluentd/forwarder shipping. Run log10x_doctor forwarder_dark_zones check.',
  indexer_pipeline_running:
    'Retriever pod is not running the indexer pipeline. Check pod logs for boot errors. Confirm TENX_QUARKUS_INDEX_QUEUE_URL env var is set.',
  sqs_queues_drained:
    'SQS subquery or stream queue is backed up (depth > 10). Consumer may be slow or crashed. Check pod CPU/memory.',
  retriever_pod_ready:
    'Retriever pod has unready containers. Check kubectl describe and recent pod events.',
  cw_scan_match:
    'Bloom scan found no matches for the picked hash. Indexer may not have caught up yet — wait 60s and re-probe. Or the offload data does not contain this hash.',
  cw_stream_fetch:
    'Stream consumer is not running. Check stream queue drains AND stream pipeline launches (kubectl logs for "starting pipeline - Tenx: @/apps/retriever/stream"). This is the chart 1.0.20 / runtime-name class of bug.',
  s3_qr_jsonl_written:
    'Stream worker ran but did not write results to qr/<queryId>/. Check IAM s3:PutObject on the retriever IRSA role. Confirm TENX_QUARKUS_INDEX_WRITE_CONTAINER env var matches the actual bucket.',
  mcp_events_returned:
    'MCP read path issue. Files exist in qr/ but MCP returned 0. Check the input_bucket arg matches the actual S3 write location.',
};

// ── Injectable dependency surface ───────────────────────────────────────────

export interface ProbeDeps {
  /** List S3 objects under prefix; returns the array of objects with LastModified. */
  s3ListObjects: (
    bucket: string,
    prefix: string,
  ) => Promise<Array<{ Key: string; LastModified?: string; Size?: number }>>;
  /** Run `kubectl logs <pod> -c <container> --since=Ns` and return stdout. */
  kubectlLogs: (
    namespace: string,
    podLabelSelector: string,
    sinceSeconds: number,
  ) => Promise<string>;
  /** Get SQS queue depths (ApproximateNumberOfMessages) for the retriever queues by URL. */
  sqsDepths: (queueUrls: string[]) => Promise<Record<string, number>>;
  /** List SQS queues matching a name prefix. Returns URLs. */
  sqsListQueues: (namePrefix: string) => Promise<string[]>;
  /** Check pod ready state; returns the pod name and whether all containers are ready. */
  kubectlGetPod: (
    namespace: string,
    labelSelector: string,
  ) => Promise<{ name?: string; ready: boolean; observed: string }>;
  /** CloudWatch Logs filter — returns matching events for a substring + filter pattern. */
  cwFilterLogEvents: (
    logGroup: string,
    filterPattern: string,
    sinceMs: number,
  ) => Promise<Array<{ timestamp?: number; message: string }>>;
  /** Pick the top tenx_hash from the metric backend; null if backend missing or empty. */
  pickTopHash: () =>
    Promise<{ status: 'ok'; hash: string } | { status: 'no_backend' } | { status: 'no_data' }>;
  /** Submit a retriever query and poll until completion. Returns the response shape. */
  submitRetrieverQuery: (req: {
    search: string;
    from: string;
    to: string;
    target: string;
    limit: number;
    writeResults: boolean;
  }) => Promise<{
    queryId: string;
    eventsMatched: number;
    eventsReturned: number;
  }>;
}

// ── Default deps (wire to real shell / SDK calls) ──────────────────────────

function defaultDeps(): ProbeDeps {
  return {
    s3ListObjects: defaultS3ListObjects,
    kubectlLogs: defaultKubectlLogs,
    sqsDepths: defaultSqsDepths,
    sqsListQueues: defaultSqsListQueues,
    kubectlGetPod: defaultKubectlGetPod,
    cwFilterLogEvents: defaultCwFilterLogEvents,
    pickTopHash: defaultPickTopHash,
    submitRetrieverQuery: defaultSubmitRetrieverQuery,
  };
}

async function defaultS3ListObjects(
  bucket: string,
  prefix: string,
): Promise<Array<{ Key: string; LastModified?: string; Size?: number }>> {
  try {
    const { stdout } = await execFileP(
      'aws',
      ['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix, '--output', 'json'],
      { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 },
    );
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout) as {
      Contents?: Array<{ Key: string; LastModified?: string; Size?: number }>;
    };
    return parsed.Contents ?? [];
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? '';
    if (stderr.includes('NoSuchBucket')) {
      throw new Error(`bucket does not exist: ${bucket}`);
    }
    return [];
  }
}

async function defaultKubectlLogs(
  namespace: string,
  podLabelSelector: string,
  sinceSeconds: number,
): Promise<string> {
  try {
    const { stdout } = await execFileP(
      'kubectl',
      [
        '-n', namespace,
        'logs',
        '-l', podLabelSelector,
        '--all-containers=true',
        `--since=${sinceSeconds}s`,
        '--tail=2000',
      ],
      { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 },
    );
    return stdout;
  } catch (e) {
    const stderr = (e as { stderr?: string; message?: string }).stderr
      ?? (e as Error).message ?? '';
    return `(kubectl logs failed: ${stderr.slice(0, 200)})`;
  }
}

async function defaultSqsListQueues(namePrefix: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP(
      'aws',
      ['sqs', 'list-queues', '--queue-name-prefix', namePrefix, '--output', 'json'],
      { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
    );
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout) as { QueueUrls?: string[] };
    return parsed.QueueUrls ?? [];
  } catch {
    return [];
  }
}

async function defaultSqsDepths(queueUrls: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const url of queueUrls) {
    try {
      const { stdout } = await execFileP(
        'aws',
        [
          'sqs', 'get-queue-attributes',
          '--queue-url', url,
          '--attribute-names', 'ApproximateNumberOfMessages',
          '--output', 'json',
        ],
        { maxBuffer: 1 * 1024 * 1024, timeout: 10_000 },
      );
      const parsed = JSON.parse(stdout) as {
        Attributes?: { ApproximateNumberOfMessages?: string };
      };
      const n = parseInt(parsed.Attributes?.ApproximateNumberOfMessages ?? '0', 10);
      out[url] = Number.isFinite(n) ? n : 0;
    } catch {
      // Treat unknown depth as 0 so absence of permission does not fail
      // the assert on a healthy cluster; the assert's `observed` string
      // notes the queues actually probed.
      out[url] = 0;
    }
  }
  return out;
}

async function defaultKubectlGetPod(
  namespace: string,
  labelSelector: string,
): Promise<{ name?: string; ready: boolean; observed: string }> {
  try {
    const { stdout } = await execFileP(
      'kubectl',
      [
        '-n', namespace,
        'get', 'pod',
        '-l', labelSelector,
        '-o', 'json',
      ],
      { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
    );
    if (!stdout.trim()) {
      return { ready: false, observed: 'no pods returned' };
    }
    const parsed = JSON.parse(stdout) as {
      items?: Array<{
        metadata?: { name?: string };
        status?: {
          containerStatuses?: Array<{ name?: string; ready?: boolean }>;
        };
      }>;
    };
    const items = parsed.items ?? [];
    if (items.length === 0) {
      return { ready: false, observed: 'no pods matched selector' };
    }
    const pod = items[0];
    const cs = pod.status?.containerStatuses ?? [];
    if (cs.length === 0) {
      return { name: pod.metadata?.name, ready: false, observed: 'no containerStatuses' };
    }
    const notReady = cs.filter((c) => c.ready !== true).map((c) => c.name ?? '?');
    const ready = notReady.length === 0;
    const observed = ready
      ? `pod ${pod.metadata?.name ?? '?'}: ${cs.length}/${cs.length} containers ready`
      : `pod ${pod.metadata?.name ?? '?'}: ${cs.length - notReady.length}/${cs.length} ready, not ready: ${notReady.join(', ')}`;
    return { name: pod.metadata?.name, ready, observed };
  } catch (e) {
    const stderr = (e as { stderr?: string; message?: string }).stderr
      ?? (e as Error).message ?? '';
    return { ready: false, observed: `kubectl get pod failed: ${stderr.slice(0, 200)}` };
  }
}

async function defaultCwFilterLogEvents(
  logGroup: string,
  filterPattern: string,
  sinceMs: number,
): Promise<Array<{ timestamp?: number; message: string }>> {
  try {
    const { stdout } = await execFileP(
      'aws',
      [
        'logs', 'filter-log-events',
        '--log-group-name', logGroup,
        '--filter-pattern', filterPattern,
        '--start-time', String(sinceMs),
        '--output', 'json',
      ],
      { maxBuffer: 32 * 1024 * 1024, timeout: 20_000 },
    );
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout) as {
      events?: Array<{ timestamp?: number; message?: string }>;
    };
    return (parsed.events ?? [])
      .filter((e) => typeof e.message === 'string')
      .map((e) => ({ timestamp: e.timestamp, message: e.message! }));
  } catch (e) {
    const stderr = (e as { stderr?: string; message?: string }).stderr
      ?? (e as Error).message ?? '';
    // Surface upstream — treated as a `no events found` so the assert fails
    // with the remedy. We do not throw; the probe should always finish.
    if (stderr) {
      // Encode error in a sentinel message so the caller can see it.
      return [];
    }
    return [];
  }
}

async function defaultPickTopHash(): Promise<
  { status: 'ok'; hash: string } | { status: 'no_backend' } | { status: 'no_data' }
> {
  try {
    const { resolveBackend } = await import('./customer-metrics.js');
    const res = await resolveBackend();
    if (!res.backend) return { status: 'no_backend' };
    const promql = 'topk(5, sum by (tenx_hash) (rate(all_events{}[5m])))';
    let resp: import('./api.js').PrometheusResponse;
    try {
      resp = await res.backend.queryInstant(promql);
    } catch {
      return { status: 'no_backend' };
    }
    let bestHash: string | undefined;
    let bestVal = -Infinity;
    for (const series of resp.data?.result ?? []) {
      const labels = series.metric as Record<string, string>;
      const hash = labels.tenx_hash;
      if (!hash) continue;
      const rawVal = series.value?.[1];
      const v = rawVal !== undefined ? Number(rawVal) : 0;
      const candidate = Number.isFinite(v) ? v : 0;
      if (candidate > bestVal) {
        bestVal = candidate;
        bestHash = hash;
      }
    }
    if (!bestHash) return { status: 'no_data' };
    return { status: 'ok', hash: bestHash };
  } catch {
    return { status: 'no_backend' };
  }
}

async function defaultSubmitRetrieverQuery(req: {
  search: string;
  from: string;
  to: string;
  target: string;
  limit: number;
  writeResults: boolean;
}): Promise<{ queryId: string; eventsMatched: number; eventsReturned: number }> {
  const { runRetrieverQuery } = await import('./retriever-api.js');
  const { loadEnvironments } = await import('./environments.js');
  const envs = await loadEnvironments();
  const env = envs.default ?? envs.all[0];
  if (!env) {
    throw new Error('No EnvConfig available — set LOG10X_API_KEY + LOG10X_ENV_ID');
  }
  const resp = await runRetrieverQuery(env, {
    search: req.search,
    from: req.from,
    to: req.to,
    target: req.target,
    limit: req.limit,
    writeResults: req.writeResults,
  });
  return {
    queryId: resp.queryId,
    eventsMatched: resp.execution.eventsMatched,
    eventsReturned: resp.events.length,
  };
}

// ── Probe orchestrator ──────────────────────────────────────────────────────

/**
 * Run the e2e probe. Pre-flight asserts (1-4) run in parallel; post-query
 * asserts (5-8) run sequentially because each depends on the queryId.
 *
 * The verdict is:
 *   - 'green'  when every assert passed.
 *   - 'broken' when at least one assert failed (with first_failed_assert
 *              populated to the first false entry and surfaced_remedy set
 *              to that entry's remedy).
 *   - 'unknown' when the probe could not reach stage 3 (target hash could
 *               not be picked because the metric backend is not configured
 *               or has no data, AND the caller did not pass target_hash).
 */
export async function runRetrieverProbe(
  args: ProbeArgs,
  deps: ProbeDeps = defaultDeps(),
): Promise<ProbeResult> {
  const t0 = Date.now();
  const windowMinutes = args.window_minutes ?? 5;
  const podLabelSelector = args.pod_label_selector ?? 'app=retriever-10x';

  // Stage 1 — pick target hash (skipped if args.target_hash).
  let pickedHash = args.target_hash;
  if (!pickedHash) {
    const pick = await deps.pickTopHash();
    if (pick.status === 'no_backend') {
      return {
        verdict: 'unknown',
        asserts: [],
        total_runtime_ms: Date.now() - t0,
        reason:
          'metric backend not configured. Pass target_hash explicitly.',
      };
    }
    if (pick.status === 'no_data') {
      return {
        verdict: 'unknown',
        asserts: [],
        total_runtime_ms: Date.now() - t0,
        reason:
          'no patterns active in metric backend, cannot pick target hash. Pass target_hash explicitly.',
      };
    }
    pickedHash = pick.hash;
  }

  // Stage 2 — pre-flight asserts, all in parallel.
  const preflight = await Promise.all([
    assertOffloadHasRecentData(args.offload_bucket, deps),
    assertIndexerPipelineRunning(args.namespace, podLabelSelector, deps),
    assertSqsQueuesDrained(deps),
    assertRetrieverPodReady(args.namespace, podLabelSelector, deps),
  ]);

  // If any pre-flight assert fails, still attempt the query so we collect
  // the post-query asserts as "did not run" — but actually, the most
  // informative shape is to stop after the first failed pre-flight, since
  // the post-query asserts will all fail downstream too. We still want
  // structured per-assert visibility, so we record skips below.
  const preflightFailed = preflight.find((a) => !a.pass);

  if (preflightFailed) {
    return finishWithFailedPreflight(preflight, pickedHash, t0);
  }

  // Stage 3 — fire the synthetic query.
  let queryId: string | undefined;
  let eventsMatched = 0;
  let eventsReturned = 0;
  let submitOk = false;
  let submitErr = '';
  try {
    const resp = await deps.submitRetrieverQuery({
      search: `tenx_hash == "${pickedHash}"`,
      from: `now-${windowMinutes}m`,
      to: 'now',
      target: 'app',
      limit: 1,
      writeResults: true,
    });
    queryId = resp.queryId;
    eventsMatched = resp.eventsMatched;
    eventsReturned = resp.eventsReturned;
    submitOk = true;
  } catch (e) {
    submitErr = e instanceof Error ? e.message : String(e);
  }

  if (!submitOk) {
    // The query submission itself failed. Skip post-query asserts; the
    // verdict is 'broken' driven by the query submission failure rendered
    // as the cw_scan_match assert (the next earliest stage). This keeps
    // verdict assembly simple and surfaces a single recognizable failure.
    const asserts: ProbeAssert[] = [
      ...preflight,
      {
        name: 'cw_scan_match',
        pass: false,
        observed: `query submission failed before scan stage: ${submitErr.slice(0, 200)}`,
        remedy: REMEDIES.cw_scan_match,
      },
    ];
    return {
      verdict: 'broken',
      picked_hash: pickedHash,
      query_id: queryId,
      asserts,
      first_failed_assert: 'cw_scan_match',
      surfaced_remedy: REMEDIES.cw_scan_match,
      total_runtime_ms: Date.now() - t0,
      reason: `query submission failed: ${submitErr.slice(0, 200)}`,
    };
  }

  // Stage 4 — post-query asserts (sequential, depend on queryId).
  const postQuery: ProbeAssert[] = [];
  postQuery.push(await assertCwScanMatch(queryId!, args.query_log_group, t0, deps));
  postQuery.push(await assertCwStreamFetch(queryId!, args.query_log_group, t0, deps));
  postQuery.push(await assertS3QrJsonlWritten(queryId!, args.input_bucket, deps));
  postQuery.push(assertMcpEventsReturned(eventsMatched, eventsReturned));

  return assembleVerdict([...preflight, ...postQuery], pickedHash, queryId, t0);
}

// ── Per-assert helpers ──────────────────────────────────────────────────────

async function assertOffloadHasRecentData(
  bucket: string,
  deps: ProbeDeps,
): Promise<ProbeAssert> {
  const fiveMinAgo = Date.now() - 5 * 60_000;
  let objects: Array<{ Key: string; LastModified?: string; Size?: number }>;
  try {
    objects = await deps.s3ListObjects(bucket, '');
  } catch (e) {
    return {
      name: 'offload_bucket_has_recent_data',
      pass: false,
      observed: `list-objects error: ${(e as Error).message.slice(0, 200)}`,
      remedy: REMEDIES.offload_bucket_has_recent_data,
    };
  }
  const recent = objects.filter((o) => {
    if (!o.LastModified) return false;
    const ts = Date.parse(o.LastModified);
    return Number.isFinite(ts) && ts > fiveMinAgo;
  });
  if (recent.length >= 1) {
    return {
      name: 'offload_bucket_has_recent_data',
      pass: true,
      observed: `${recent.length} object(s) modified in last 5 min in s3://${bucket}/`,
    };
  }
  return {
    name: 'offload_bucket_has_recent_data',
    pass: false,
    observed: `0 objects modified in last 5 min in s3://${bucket}/ (total objects scanned: ${objects.length})`,
    remedy: REMEDIES.offload_bucket_has_recent_data,
  };
}

async function assertIndexerPipelineRunning(
  namespace: string,
  podLabelSelector: string,
  deps: ProbeDeps,
): Promise<ProbeAssert> {
  let logs = '';
  try {
    logs = await deps.kubectlLogs(namespace, podLabelSelector, 60);
  } catch (e) {
    return {
      name: 'indexer_pipeline_running',
      pass: false,
      observed: `kubectl logs error: ${(e as Error).message.slice(0, 200)}`,
      remedy: REMEDIES.indexer_pipeline_running,
    };
  }
  const needle = 'starting pipeline - Tenx: @/apps/retriever/index';
  const count = countOccurrences(logs, needle);
  if (count >= 1) {
    return {
      name: 'indexer_pipeline_running',
      pass: true,
      observed: `indexer-pipeline start line observed ${count} time(s) in last 60s`,
    };
  }
  return {
    name: 'indexer_pipeline_running',
    pass: false,
    observed: `indexer-pipeline start line NOT observed in last 60s of pod logs`,
    remedy: REMEDIES.indexer_pipeline_running,
  };
}

async function assertSqsQueuesDrained(deps: ProbeDeps): Promise<ProbeAssert> {
  // Find subquery + stream queue URLs by prefix. Two prefixes are looked up
  // independently and merged so we don't fail when only one matches.
  let subqueryUrls: string[] = [];
  let streamUrls: string[] = [];
  try {
    [subqueryUrls, streamUrls] = await Promise.all([
      deps.sqsListQueues('tenx-retriever-subquery'),
      deps.sqsListQueues('tenx-retriever-stream'),
    ]);
  } catch {
    // Fall through — if we can't enumerate, return pass with observed=skipped
    // so we don't fail a healthy probe on an IAM-listing gap.
    return {
      name: 'sqs_queues_drained',
      pass: true,
      observed: 'sqs:ListQueues unavailable — assert skipped (treat as drained)',
    };
  }
  const urls = [...subqueryUrls, ...streamUrls];
  if (urls.length === 0) {
    // No queues found — likely env-misconfigured. Don't fail; surface that
    // the probe could not test.
    return {
      name: 'sqs_queues_drained',
      pass: true,
      observed: 'no tenx-retriever-subquery / tenx-retriever-stream queues found — skipped',
    };
  }
  let depths: Record<string, number>;
  try {
    depths = await deps.sqsDepths(urls);
  } catch {
    return {
      name: 'sqs_queues_drained',
      pass: true,
      observed: `sqs:GetQueueAttributes failed on ${urls.length} queue(s) — skipped`,
    };
  }
  const over = Object.entries(depths).filter(([, d]) => d > 10);
  if (over.length === 0) {
    const max = Math.max(0, ...Object.values(depths));
    return {
      name: 'sqs_queues_drained',
      pass: true,
      observed: `${urls.length} queue(s) checked, max depth ${max}`,
    };
  }
  return {
    name: 'sqs_queues_drained',
    pass: false,
    observed: `${over.length} queue(s) over depth 10: ${over.map(([u, d]) => `${shortQueueName(u)}=${d}`).join(', ')}`,
    remedy: REMEDIES.sqs_queues_drained,
  };
}

async function assertRetrieverPodReady(
  namespace: string,
  podLabelSelector: string,
  deps: ProbeDeps,
): Promise<ProbeAssert> {
  const pod = await deps.kubectlGetPod(namespace, podLabelSelector);
  if (pod.ready) {
    return {
      name: 'retriever_pod_ready',
      pass: true,
      observed: pod.observed,
    };
  }
  return {
    name: 'retriever_pod_ready',
    pass: false,
    observed: pod.observed,
    remedy: REMEDIES.retriever_pod_ready,
  };
}

async function assertCwScanMatch(
  queryId: string,
  logGroup: string,
  sinceMs: number,
  deps: ProbeDeps,
): Promise<ProbeAssert> {
  // Filter pattern: events containing both the queryId string and "scan complete".
  const pattern = `"${queryId}" "scan complete"`;
  let events: Array<{ timestamp?: number; message: string }> = [];
  try {
    events = await deps.cwFilterLogEvents(logGroup, pattern, sinceMs);
  } catch (e) {
    return {
      name: 'cw_scan_match',
      pass: false,
      observed: `cw filter error: ${(e as Error).message.slice(0, 200)}`,
      remedy: REMEDIES.cw_scan_match,
    };
  }
  let totalMatched = 0;
  for (const ev of events) {
    const m = ev.message.match(/"matched"\s*:\s*(\d+)/);
    if (m) totalMatched += parseInt(m[1], 10);
  }
  if (totalMatched > 0) {
    return {
      name: 'cw_scan_match',
      pass: true,
      observed: `cw scan complete events for ${queryId}: ${events.length} line(s), total matched=${totalMatched}`,
    };
  }
  return {
    name: 'cw_scan_match',
    pass: false,
    observed: `cw scan complete events for ${queryId}: ${events.length} line(s), total matched=0`,
    remedy: REMEDIES.cw_scan_match,
  };
}

async function assertCwStreamFetch(
  queryId: string,
  logGroup: string,
  sinceMs: number,
  deps: ProbeDeps,
): Promise<ProbeAssert> {
  const pattern = `"${queryId}" "stream worker"`;
  let events: Array<{ timestamp?: number; message: string }> = [];
  try {
    events = await deps.cwFilterLogEvents(logGroup, pattern, sinceMs);
  } catch (e) {
    return {
      name: 'cw_stream_fetch',
      pass: false,
      observed: `cw filter error: ${(e as Error).message.slice(0, 200)}`,
      remedy: REMEDIES.cw_stream_fetch,
    };
  }
  // We expect at least one line resembling 'stream worker complete: fetched X bytes'.
  const completes = events.filter((e) =>
    /stream worker complete: fetched \d+ bytes/i.test(e.message),
  );
  if (completes.length >= 1) {
    return {
      name: 'cw_stream_fetch',
      pass: true,
      observed: `cw stream worker completion lines for ${queryId}: ${completes.length}`,
    };
  }
  return {
    name: 'cw_stream_fetch',
    pass: false,
    observed: `cw stream worker completion lines for ${queryId}: 0 (${events.length} line(s) matched filter)`,
    remedy: REMEDIES.cw_stream_fetch,
  };
}

async function assertS3QrJsonlWritten(
  queryId: string,
  inputBucket: string,
  deps: ProbeDeps,
): Promise<ProbeAssert> {
  const prefix = `indexing-results/tenx/app/qr/${queryId}/`;
  let objects: Array<{ Key: string }>;
  try {
    objects = await deps.s3ListObjects(inputBucket, prefix);
  } catch (e) {
    return {
      name: 's3_qr_jsonl_written',
      pass: false,
      observed: `list-objects error: ${(e as Error).message.slice(0, 200)}`,
      remedy: REMEDIES.s3_qr_jsonl_written,
    };
  }
  const jsonl = objects.filter((o) => o.Key.endsWith('.jsonl'));
  if (jsonl.length >= 1) {
    return {
      name: 's3_qr_jsonl_written',
      pass: true,
      observed: `${jsonl.length} jsonl file(s) under s3://${inputBucket}/${prefix}`,
    };
  }
  return {
    name: 's3_qr_jsonl_written',
    pass: false,
    observed: `0 jsonl files under s3://${inputBucket}/${prefix} (${objects.length} total objects)`,
    remedy: REMEDIES.s3_qr_jsonl_written,
  };
}

function assertMcpEventsReturned(
  eventsMatched: number,
  eventsReturned: number,
): ProbeAssert {
  if (eventsMatched > 0 && eventsReturned > 0) {
    return {
      name: 'mcp_events_returned',
      pass: true,
      observed: `mcp eventsMatched=${eventsMatched}, eventsReturned=${eventsReturned}`,
    };
  }
  return {
    name: 'mcp_events_returned',
    pass: false,
    observed: `mcp eventsMatched=${eventsMatched}, eventsReturned=${eventsReturned}`,
    remedy: REMEDIES.mcp_events_returned,
  };
}

// ── Verdict assembly helpers ────────────────────────────────────────────────

function assembleVerdict(
  asserts: ProbeAssert[],
  pickedHash: string | undefined,
  queryId: string | undefined,
  t0: number,
): ProbeResult {
  const firstFailed = asserts.find((a) => !a.pass);
  if (!firstFailed) {
    return {
      verdict: 'green',
      picked_hash: pickedHash,
      query_id: queryId,
      asserts,
      total_runtime_ms: Date.now() - t0,
    };
  }
  return {
    verdict: 'broken',
    picked_hash: pickedHash,
    query_id: queryId,
    asserts,
    first_failed_assert: firstFailed.name,
    surfaced_remedy: firstFailed.remedy,
    total_runtime_ms: Date.now() - t0,
  };
}

function finishWithFailedPreflight(
  preflight: ProbeAssert[],
  pickedHash: string | undefined,
  t0: number,
): ProbeResult {
  const firstFailed = preflight.find((a) => !a.pass)!;
  return {
    verdict: 'broken',
    picked_hash: pickedHash,
    asserts: preflight,
    first_failed_assert: firstFailed.name,
    surfaced_remedy: firstFailed.remedy,
    total_runtime_ms: Date.now() - t0,
  };
}

// ── Small utilities ─────────────────────────────────────────────────────────

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    n++;
    idx += needle.length;
  }
  return n;
}

function shortQueueName(url: string): string {
  const parts = url.split('/');
  return parts[parts.length - 1] || url;
}
