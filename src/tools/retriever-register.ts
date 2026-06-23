/**
 * log10x_retriever_register — write the Retriever endpoint + queue
 * coordinates onto an existing environment-config document.
 *
 * The env document is the single source of truth for everything tools
 * need to act on a given Log10x environment: cluster identity, SIEM
 * destination, offload destinations, streamer endpoint, and (this
 * tool's responsibility) the Retriever block: query URL, offload
 * bucket, and the four SQS queues the Retriever coordinates on.
 *
 * Precondition: the environment must already exist in the env-config
 * store (created by `log10x_env_register`). This tool refuses to
 * conjure a partial document — without the cluster + destination
 * fields a freshly-stamped retriever block would orphan the rest of
 * the schema. Surface the missing-env error verbatim so the agent
 * knows to call `log10x_env_register` first.
 *
 * Storage: walks the SAME store chain `log10x_env_register` writes to —
 * k8s ConfigMap → AWS SSM → GCP Secret Manager → Azure App Configuration
 * → local file. Read finds the store that holds the env doc; write goes
 * back to the SAME store so the merged document overlays the original
 * (writing to a lower-precedence backend would silently shadow the source
 * of truth — the resolver would still pick the k8s ConfigMap on the next
 * read and ignore the local-file edit).
 *
 * Idempotent: calling twice with the same args replaces the retriever
 * block in place. `updated_at` is refreshed on every write so the
 * resolver's stale-env-var detection can spot drift.
 */

import { z } from 'zod';
import {
  environmentConfigSchema,
  type EnvironmentConfig,
  type RetrieverConfig,
} from '../lib/env-config/types.js';
import type { EnvConfigStore } from '../lib/env-config/store-interface.js';
import { defaultClusterConfigStoreChain } from '../lib/env-config/resolve-cluster-config.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { requireWriteAccess } from '../lib/read-only-guard.js';

export const retrieverRegisterSchema = {
  env_id: z
    .string()
    .min(1)
    .describe(
      'Stable identifier (env_id or nickname) of the environment to attach the Retriever to. Must already exist in the env-config store — call `log10x_env_register` first if it does not.'
    ),
  url: z
    .string()
    .min(1)
    .describe(
      'Retriever query endpoint — the in-cluster service URL the MCP calls for `retriever_query` / `retriever_series` / `retriever_query_status`. Example: `https://retriever.acme-prod.svc.cluster.local:8443`.'
    ),
  input_bucket: z
    .string()
    .min(1)
    .describe(
      'S3 bucket holding the offloaded events + byte-range index. Example: `acme-prod-retriever-offload`.'
    ),
  input_prefix: z
    .string()
    .optional()
    .describe('Optional prefix inside `input_bucket` (e.g. `cluster-a/`) when the bucket is shared across environments.'),
  query_queues: z
    .object({
      index: z.string().min(1).describe('SQS queue URL for index-build coordination.'),
      subquery: z.string().min(1).describe('SQS queue URL for subquery dispatch.'),
      stream: z.string().min(1).describe('SQS queue URL for streaming-result delivery.'),
      query: z.string().min(1).describe('SQS queue URL for top-level query lifecycle.'),
    })
    .describe('The four SQS queues the Retriever coordinates on. All four are required — partial queue sets break the dispatch graph.'),
  query_log_group: z
    .string()
    .optional()
    .describe('Optional CloudWatch log group the MCP tails when investigating Retriever failures (e.g. `/aws/retriever/acme-prod`).'),
  helm_release: z
    .object({
      name: z.string().min(1).describe('Helm release name, e.g. `tenx-retriever`.'),
      namespace: z.string().min(1).describe('Kubernetes namespace, e.g. `log10x`.'),
      chart_version: z.string().optional().describe('Pinned chart version, e.g. `1.0.6`. Omit to leave unpinned.'),
    })
    .optional()
    .describe('Optional Helm release identity for the deployed Retriever — used by the install advisor to suggest `helm upgrade` plans.'),
};

interface RetrieverRegisterArgs {
  env_id: string;
  url: string;
  input_bucket: string;
  input_prefix?: string;
  query_queues: {
    index: string;
    subquery: string;
    stream: string;
    query: string;
  };
  query_log_group?: string;
  helm_release?: {
    name: string;
    namespace: string;
    chart_version?: string;
  };
}

interface RetrieverRegisterInner {
  ok: boolean;
  env_id: string;
  nickname?: string;
  action?: 'added' | 'updated';
  retriever_url?: string;
  input_bucket?: string;
  error?: string;
  error_type?: 'env_not_found' | 'invalid_config' | 'store_write_failed';
}

function buildHumanSummary(inner: RetrieverRegisterInner): string {
  if (!inner.ok) {
    if (inner.error_type === 'env_not_found') {
      return `retriever_register refused: env "${inner.env_id}" not found in the env-config store. Run log10x_env_register first to create the environment, then call retriever_register again.`;
    }
    return `retriever_register failed: ${inner.error ?? 'unknown error'}.`;
  }
  return `Retriever block ${inner.action} on env "${inner.nickname ?? inner.env_id}" — url=${inner.retriever_url}, input_bucket=${inner.input_bucket}.`;
}

export async function executeRetrieverRegister(
  args: RetrieverRegisterArgs,
  storesOverride?: EnvConfigStore[],
): Promise<string | StructuredOutput> {
  requireWriteAccess(
    'writes retriever endpoint + 4-queue config to the env-config document'
  );
  const inner = await executeRetrieverRegisterInner(args, storesOverride);
  return buildEnvelope({
    tool: 'log10x_retriever_register',
    view: 'summary',
    summary: {
      headline: inner.ok
        ? `Retriever ${inner.action} on env "${inner.nickname ?? inner.env_id}".`
        : `retriever_register refused: ${inner.error ?? 'unknown error'}.`,
    },
    data: {
      ok: inner.ok,
      env_id: inner.env_id,
      nickname: inner.nickname,
      action: inner.action,
      retriever_url: inner.retriever_url,
      input_bucket: inner.input_bucket,
      error: inner.error,
      error_type: inner.error_type,
      human_summary: buildHumanSummary(inner),
    },
    actions:
      inner.ok && inner.env_id
        ? [
            {
              tool: 'log10x_retriever_probe',
              args: { environment: inner.nickname ?? inner.env_id },
              reason: 'verify the newly-registered Retriever endpoint is reachable and serving queries',
            },
          ]
        : !inner.ok && inner.error_type === 'env_not_found'
          ? [
              {
                tool: 'log10x_env_register',
                args: {},
                reason: 'create the environment first; retriever_register attaches to an existing env',
              },
            ]
          : [],
  });
}

async function executeRetrieverRegisterInner(
  args: RetrieverRegisterArgs,
  storesOverride?: EnvConfigStore[],
): Promise<RetrieverRegisterInner> {
  const stores = storesOverride ?? defaultClusterConfigStoreChain();

  // 1. Walk the chain looking for the env doc. We must read AND write
  //    against the same store — if env_register wrote to a k8s ConfigMap
  //    we have to update the ConfigMap, not the local file. Writing to
  //    a lower-precedence backend would silently shadow the original on
  //    the next read.
  let existing: EnvironmentConfig | null = null;
  let backingStore: EnvConfigStore | null = null;
  for (const store of stores) {
    const a = await store.isAvailable();
    if (!a.available) continue;

    let doc: EnvironmentConfig | null = null;
    try {
      doc = await store.read(args.env_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        env_id: args.env_id,
        error: `failed to read env config from ${store.kind} store: ${msg}`,
        error_type: 'store_write_failed',
      };
    }
    if (doc) {
      existing = doc;
      backingStore = store;
      break;
    }
  }

  if (!existing || !backingStore) {
    return {
      ok: false,
      env_id: args.env_id,
      error: 'run log10x_env_register first',
      error_type: 'env_not_found',
    };
  }

  // 2. Build the new retriever block. Pull through optional fields
  //    only when present so the persisted document doesn't carry
  //    `undefined` keys that read back as `null` from JSON.
  const retriever: RetrieverConfig = {
    url: args.url,
    input_bucket: args.input_bucket,
    query_queues: {
      index: args.query_queues.index,
      subquery: args.query_queues.subquery,
      stream: args.query_queues.stream,
      query: args.query_queues.query,
    },
    ...(args.input_prefix !== undefined ? { input_prefix: args.input_prefix } : {}),
    ...(args.query_log_group !== undefined ? { query_log_group: args.query_log_group } : {}),
    ...(args.helm_release !== undefined
      ? {
          helm_release: {
            name: args.helm_release.name,
            namespace: args.helm_release.namespace,
            ...(args.helm_release.chart_version !== undefined
              ? { chart_version: args.helm_release.chart_version }
              : {}),
          },
        }
      : {}),
  };

  const hadRetriever = !!existing.retriever && !!existing.retriever.url;
  const action: 'added' | 'updated' = hadRetriever ? 'updated' : 'added';

  // 3. Stamp the merged document. `updated_at` is refreshed on every
  //    write so resolver stale-env-var detection can flag drift.
  const merged: EnvironmentConfig = {
    ...existing,
    retriever,
    updated_at: new Date().toISOString(),
  };

  // 4. Validate before writing so a busted schema fails here rather
  //    than at the next read. LocalFileStore.write() re-validates,
  //    but doing it here lets us surface a clean `invalid_config`
  //    error type instead of a store-write error.
  const parsed = environmentConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return {
      ok: false,
      env_id: existing.env_id,
      nickname: existing.nickname,
      error: `merged env config failed schema validation: ${issues}`,
      error_type: 'invalid_config',
    };
  }

  // 5. Persist back to the SAME store the read found the doc in.
  try {
    await backingStore.write(parsed.data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      env_id: existing.env_id,
      nickname: existing.nickname,
      error: `failed to write env config to ${backingStore.kind} store: ${msg}`,
      error_type: 'store_write_failed',
    };
  }

  return {
    ok: true,
    env_id: existing.env_id,
    nickname: existing.nickname,
    action,
    retriever_url: retriever.url,
    input_bucket: retriever.input_bucket,
  };
}
