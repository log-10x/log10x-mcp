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
          'Retriever end-to-end health check could not run — the S3 buckets it reads from and writes to could not be resolved. Pass offload_bucket and input_bucket explicitly, or set LOG10X_STREAMER_BUCKET and make sure the retriever helm release is reachable.',
      },
      data: {
        verdict: 'unknown',
        reason:
          'I tried to run an end-to-end health check on the retriever pipeline, but I could not figure out which S3 buckets it reads from and writes to. To run the check: pass offload_bucket and input_bucket explicitly, or set LOG10X_STREAMER_BUCKET and ensure the retriever helm release is reachable so the bucket names can be auto-discovered.',
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
    return `Retriever end-to-end health check passed — picked pattern ${r.picked_hash ?? '?'}, ran query ${r.query_id ?? '?'}, all ${r.asserts.length} checks succeeded (${r.total_runtime_ms}ms).`;
  }
  if (r.verdict === 'broken') {
    // Note 32 + 39: lead with capability + impact in user terms. Distinguish
    // "new logs aren't being archived" (offload_bucket_has_recent_data failure)
    // from "historical search is broken" (indexer/pod/query failures) —
    // these are independent. Conflating them overstates impact when only
    // the forward-shipping signal fails.
    const remedy = r.surfaced_remedy ?? '';
    const failed = r.first_failed_assert ?? '?';
    const passedCount = r.asserts.filter((a) => a.pass).length;
    const totalCount = r.asserts.length;

    // Forward-shipping failure: archive isn't getting new logs, but existing
    // indexed data is still queryable.
    if (failed === 'offload_bucket_has_recent_data') {
      return (
        `Long-term log archiving has stalled — no new logs have landed in cold storage recently ` +
        `(${passedCount} of ${totalCount} health checks passed; the failed one was the new-arrivals check). ` +
        `What this means: searching events from BEFORE the stall still works, but events FROM NOW are not being archived for later retrieval. ` +
        (remedy ? `Likely cause: ${remedy} ` : '') +
        `Try log10x_advise_retriever for setup guidance.`
      );
    }

    // Backward / query-path failure: historical search is the affected capability.
    return (
      `Long-term log search isn't working right now ` +
      `(${passedCount} of ${totalCount} health checks passed; the failed one was "${failed}"). ` +
      `What this means: any log10x_retriever_query or log10x_retriever_series call will return empty until this is fixed. ` +
      (remedy ? `Likely cause: ${remedy} ` : '') +
      `Try log10x_advise_retriever for setup guidance.`
    );
  }
  // Note 14: explain WHAT this tool tried (end-to-end retriever pipeline
  // health check), WHY it couldn't (no metrics backend wired up to pick a
  // pattern to test against), and WHAT to do next (pass target_hash, or
  // run top_patterns first so we can pick a pattern automatically).
  const reasonTail = r.reason ?? 'I could not complete the check';
  return (
    `I tried to run an end-to-end health check on the retriever pipeline, ` +
    `but I could not pick a pattern to test against on my own — ${reasonTail}. ` +
    `To run the check, tell me which pattern to test: pass target_hash: "<hash>", ` +
    `or run log10x_top_patterns first so I can pick the top pattern and re-run this check automatically.`
  );
}
