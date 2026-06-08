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
import {
  resolveClusterConfig,
  pickActiveOffload,
  detectStaleOffloadEnvVar,
  detectMultiActiveOffload,
  detectStaleEnvVarForField,
  type ClusterConfigResolveSuccess,
} from '../lib/env-config/resolve-cluster-config.js';

/**
 * Source-of-truth tag for each resolved field on this tool's source_disclosure.
 *  - explicit_arg  : caller passed the value as an arg
 *  - on_prem_store : value came from the env-config doc (K8s ConfigMap / SSM /
 *                    GCP SM / Azure AC / local file) via resolveClusterConfig()
 *  - env_var       : value came from a LOG10X_* process env var fallback
 *  - none          : value could not be resolved
 */
type ResolvedSource = 'explicit_arg' | 'on_prem_store' | 'env_var' | 'none';

export const retrieverProbeSchema = {
  namespace: z
    .string()
    .default('log10x')
    .describe('Kubernetes namespace where the retriever pod runs. Default: "log10x".'),
  offload_bucket: z
    .string()
    .optional()
    .describe(
      'S3 bucket the receiver offloads data to (the bucket the retriever indexer reads from). Default: pick the `status="active"` entry from the resolved env-config\'s `offload_destinations[]` (walking K8s ConfigMap → AWS SSM → GCP Secret Manager → Azure App Config → local file in that order). Falls back to the LOG10X_STREAMER_BUCKET / LOG10X_OFFLOAD_BUCKET env var when no env-config is reachable. When the env var disagrees with the resolved value, the env var is ignored AND a stale-env-var warning is emitted on `envelope.warnings`.',
    ),
  input_bucket: z
    .string()
    .optional()
    .describe(
      'S3 bucket where the retriever WRITES qr/<id>/*.jsonl result objects. Default: read from the resolved env-config\'s `retriever.input_bucket` (walking K8s ConfigMap → AWS SSM → GCP Secret Manager → Azure App Config → local file in that order). Falls back to LOG10X_RETRIEVER_INPUT_BUCKET / __SAVE_LOG10X_RETRIEVER_BUCKET__ env vars and the helm-release probe when no env-config is reachable.',
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

  // Resolution chain for offload bucket AND retriever state (url/input_bucket):
  //   1. explicit-arg          (args.* — caller knows best)
  //   2. on-prem-store         (env-config doc, K8s CM → SSM → GCP SM → Azure → file)
  //   3. env-var fallback      (LOG10X_STREAMER_BUCKET / LOG10X_OFFLOAD_BUCKET /
  //                             LOG10X_RETRIEVER_INPUT_BUCKET / __SAVE_* via
  //                             getRetrieverState)
  //   4. fail-loudly           (envelope below explaining what to set)
  //
  // Stale-env-var nudge: when the env-config disagrees with the env var, the
  // store wins and the env var becomes a warning rather than a silent
  // override. This is the canonical "but I set the env var" footgun.
  const warnings: string[] = [];

  // Resolve the env-config doc ONCE and reuse it for both the offload bucket
  // (status='active' destination) and the retriever block (input_bucket/url).
  // Before this, only offload_bucket consulted resolveClusterConfig — the
  // input_bucket path skipped straight to getRetrieverState(null), which never
  // reads the env-config ConfigMap. That left the canonical "but I registered
  // the env-config doc" footgun: env-config was authoritative for offload but
  // an ignored sibling for retriever.
  let resolved: ClusterConfigResolveSuccess | undefined;
  if (!args.offload_bucket || !args.input_bucket) {
    const r = await resolveClusterConfig();
    if (r.ok) resolved = r;
  }

  let offloadBucket = args.offload_bucket;
  let offloadBucketSource: ResolvedSource = args.offload_bucket ? 'explicit_arg' : 'none';
  if (!offloadBucket) {
    if (resolved) {
      const active = pickActiveOffload(resolved.config);
      if (active?.bucket) {
        offloadBucket = active.bucket;
        offloadBucketSource = 'on_prem_store';
        const stale = detectStaleOffloadEnvVar(active.bucket);
        if (stale) warnings.push(stale);
      }
      // Multi-active offload: pickActiveOffload silently returns the FIRST
      // status='active' entry. When the env-config has 2+ actives, the
      // probe needs to surface (a) the ambiguous condition, (b) which
      // bucket we ran the probe against, and (c) the array-order pick rule
      // so the user can either re-run with an explicit offload_bucket arg
      // or fix the env-config to leave only one entry active.
      const multi = detectMultiActiveOffload(resolved.config);
      if (multi.multi_active) {
        warnings.push(
          `multi-active offload destinations in resolved env-config ` +
            `(${multi.active_count} entries with status="active": ${multi.active_nicknames.join(', ')}); ` +
            `probe ran against the first one in array order ("${multi.picked}"). ` +
            `Pass offload_bucket explicitly, or update the env-config so only one destination is active, to clear this warning.`,
        );
      }
      for (const w of resolved.stale_env_var_warnings) {
        if (!warnings.includes(w)) warnings.push(w);
      }
    }
    // Env-var fallback only when the store path produced nothing usable.
    if (!offloadBucket) {
      offloadBucket =
        process.env.LOG10X_OFFLOAD_BUCKET || process.env.LOG10X_STREAMER_BUCKET;
      if (offloadBucket) offloadBucketSource = 'env_var';
    }
  }

  let inputBucket = args.input_bucket;
  let retrieverStateSource: ResolvedSource = args.input_bucket ? 'explicit_arg' : 'none';
  if (!inputBucket) {
    // (B.1) Prefer env-config's retriever block over env_var / helm probes.
    // This is the exact gap Fix B closes: input_bucket previously skipped the
    // env-config doc entirely and went straight to getRetrieverState(null),
    // which only walks env vars + helm + kubectl. If a customer registered
    // an env-config (via log10x_env_register / log10x_retriever_register),
    // it must win here just like it does for offload_bucket above.
    if (resolved?.config.retriever.input_bucket) {
      inputBucket = resolved.config.retriever.input_bucket;
      retrieverStateSource = 'on_prem_store';
      const stale = detectStaleEnvVarForField(
        'retriever.input_bucket',
        resolved.config.retriever.input_bucket,
        'LOG10X_RETRIEVER_INPUT_BUCKET',
      );
      if (stale && !warnings.includes(stale)) warnings.push(stale);
    } else {
      // (B.2) Env-config absent — fall back to the legacy resolution chain
      // (env vars → snapshot → helm probe → kubectl probe). All of these
      // collapse to retriever_state_source='env_var' in the disclosure
      // since none of them consult the on-prem env-config doc.
      try {
        const state = await getRetrieverState(null);
        if (state.installed && state.bucket) {
          inputBucket = state.bucket;
          retrieverStateSource = 'env_var';
        }
      } catch {
        // ignore — surfaced below as missing arg
      }
    }
  }
  if (!offloadBucket) {
    // Fall back to the same bucket as input_bucket when only one is known
    // — useful in single-bucket deployments where receive+index share s3.
    offloadBucket = inputBucket;
    if (offloadBucket) offloadBucketSource = retrieverStateSource;
  }

  if (!offloadBucket || !inputBucket) {
    return buildEnvelope({
      tool: 'log10x_retriever_probe',
      view: 'summary',
      summary: {
        headline:
          'Retriever end-to-end health check could not run — the S3 buckets it reads from and writes to could not be resolved. Pass offload_bucket and input_bucket explicitly, register an env-config (log10x_env_register), or set LOG10X_STREAMER_BUCKET and make sure the retriever helm release is reachable.',
      },
      data: {
        verdict: 'unknown',
        reason:
          'I tried to run an end-to-end health check on the retriever pipeline, but I could not figure out which S3 buckets it reads from and writes to. To run the check: pass offload_bucket and input_bucket explicitly, register an env-config document so the active offload bucket is resolved automatically, or set LOG10X_STREAMER_BUCKET and ensure the retriever helm release is reachable so the bucket names can be auto-discovered.',
        asserts: [],
        total_runtime_ms: 0,
        source_disclosure: {
          retriever_state_source: retrieverStateSource,
          offload_bucket_source: offloadBucketSource,
        },
      },
      warnings,
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
  const callerProvidedTargetHash = Boolean(args.target_hash);

  return buildEnvelope({
    tool: 'log10x_retriever_probe',
    view: 'summary',
    summary: {
      headline: buildHeadline(result, callerProvidedTargetHash),
    },
    data: {
      ...result,
      source_disclosure: {
        retriever_state_source: retrieverStateSource,
        offload_bucket_source: offloadBucketSource,
      },
    },
    warnings,
  });
}

function buildHeadline(r: ProbeResult, callerProvidedTargetHash: boolean): string {
  // Fix A: never put the raw tenx_hash (e.g. "4Kjc7PHLWqY") in the
  // user-facing headline — per the no-hash-in-headlines audit AND the
  // smoke-test evidence where the picked hash leaked through as a
  // bare token. The hash stays in `data.picked_hash` so renderers and
  // follow-up tools can still consume it; the prose says what the user
  // can act on ("the highest-volume pattern" / "the requested pattern").
  const pickedPhrase = callerProvidedTargetHash
    ? 'the requested pattern'
    : 'the highest-volume pattern';

  if (r.verdict === 'green') {
    return `Retriever end-to-end health check passed — picked ${pickedPhrase}, ran query ${r.query_id ?? '?'}, all ${r.asserts.length} checks succeeded (${r.total_runtime_ms}ms).`;
  }
  if (r.verdict === 'broken') {
    // Lead with capability + impact in user terms. Distinguish "new logs
    // aren't being archived" (offload_bucket_has_recent_data failure) from
    // "historical search is broken" (indexer/pod/query failures): these are
    // independent. Conflating them overstates impact when only the
    // forward-shipping signal fails.
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
  // Explain WHAT this tool tried (end-to-end retriever pipeline health
  // check), WHY it couldn't (no metrics backend wired up to pick a pattern
  // to test against), and WHAT to do next (pass target_hash, or run
  // top_patterns first so we can pick a pattern automatically).
  const reasonTail = r.reason ?? 'I could not complete the check';
  return (
    `I tried to run an end-to-end health check on the retriever pipeline, ` +
    `but I could not pick a pattern to test against on my own — ${reasonTail}. ` +
    `To run the check, tell me which pattern to test: pass target_hash: "<hash>", ` +
    `or run log10x_top_patterns first so I can pick the top pattern and re-run this check automatically.`
  );
}
