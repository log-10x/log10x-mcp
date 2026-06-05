/**
 * log10x_retriever_probe — end-to-end retriever chain verifier.
 *
 * Fires a synthetic query and asserts every stage of the chain (offload-bucket
 * freshness → indexer pipeline running → SQS queues drained → pod ready →
 * query submission → CloudWatch scan match → CloudWatch stream fetch → S3
 * qr/*.jsonl write → MCP-side events returned). Each stage is a named assert
 * with a one-line `observed` summary and a stored remedy keyed on the assert
 * name.
 *
 * Use as a deep doctor diagnostic OR as the post-install verify step.
 */

import { z } from 'zod';
import { runRetrieverProbe, type ProbeArgs, type ProbeResult } from '../lib/retriever-probe.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { validateStrictArgs } from '../lib/strict-args.js';
import { getRetrieverState } from '../lib/retriever-state.js';

export const retrieverProbeSchema = {
  namespace: z
    .string()
    .default('log10x')
    .describe('Kubernetes namespace where the retriever pod runs. Default: "log10x".'),
  offload_bucket: z
    .string()
    .optional()
    .describe(
      'S3 bucket the receiver offloads data to (the bucket the retriever indexer reads from). Default: read from LOG10X_STREAMER_BUCKET env.',
    ),
  input_bucket: z
    .string()
    .optional()
    .describe(
      'S3 bucket where the retriever WRITES qr/<id>/*.jsonl result objects. Default: read from retriever state (helm probe).',
    ),
  query_log_group: z
    .string()
    .default('log10x-retriever-query-events')
    .describe('CloudWatch log group the retriever writes per-query execution events to.'),
  target_hash: z
    .string()
    .optional()
    .describe(
      'Pre-picked tenx_hash to query for. When omitted, the probe queries the metric backend for the top-volume hash over the last 5 min.',
    ),
  window_minutes: z
    .number()
    .default(5)
    .describe('Query window size in minutes. Default: 5.'),
};

export async function executeRetrieverProbe(args: {
  namespace?: string;
  offload_bucket?: string;
  input_bucket?: string;
  query_log_group?: string;
  target_hash?: string;
  window_minutes?: number;
}): Promise<string | StructuredOutput> {
  const strict = validateStrictArgs<typeof args>(
    'log10x_retriever_probe',
    retrieverProbeSchema,
    args,
  );
  if (strict.error) return strict.error;

  // Resolve buckets from defaults / env / retriever state.
  let offloadBucket = args.offload_bucket ?? process.env.LOG10X_STREAMER_BUCKET;
  let inputBucket = args.input_bucket;
  if (!inputBucket) {
    try {
      const state = await getRetrieverState(null);
      if (state.installed && state.bucket) {
        inputBucket = state.bucket;
      }
    } catch {
      // ignore — surfaced below as missing arg
    }
  }
  if (!offloadBucket) {
    // Fall back to the same bucket as input_bucket when only one is known
    // — useful in single-bucket deployments where receive+index share s3.
    offloadBucket = inputBucket;
  }

  if (!offloadBucket || !inputBucket) {
    return buildEnvelope({
      tool: 'log10x_retriever_probe',
      view: 'summary',
      summary: {
        headline:
          'Retriever probe could not run: offload_bucket / input_bucket not resolvable. Pass both explicitly or set LOG10X_STREAMER_BUCKET.',
      },
      data: {
        verdict: 'unknown',
        reason:
          'offload_bucket / input_bucket not resolvable. Pass both args explicitly or set LOG10X_STREAMER_BUCKET and ensure the retriever helm release is reachable.',
        asserts: [],
        total_runtime_ms: 0,
      },
    });
  }

  const probeArgs: ProbeArgs = {
    namespace: args.namespace ?? 'log10x',
    offload_bucket: offloadBucket,
    input_bucket: inputBucket,
    query_log_group: args.query_log_group ?? 'log10x-retriever-query-events',
    target_hash: args.target_hash,
    window_minutes: args.window_minutes ?? 5,
  };
  const result = await runRetrieverProbe(probeArgs);

  return buildEnvelope({
    tool: 'log10x_retriever_probe',
    view: 'summary',
    summary: {
      headline: buildHeadline(result),
    },
    data: result,
  });
}

function buildHeadline(r: ProbeResult): string {
  if (r.verdict === 'green') {
    return `Retriever e2e probe GREEN — picked hash ${r.picked_hash ?? '?'}, query ${r.query_id ?? '?'}, ${r.asserts.length} asserts all passing (${r.total_runtime_ms}ms).`;
  }
  if (r.verdict === 'broken') {
    return `Retriever e2e probe BROKEN — first failed: ${r.first_failed_assert ?? '?'}. ${r.surfaced_remedy ?? ''}`;
  }
  return `Retriever e2e probe UNKNOWN — ${r.reason ?? 'probe could not run to completion'}`;
}
