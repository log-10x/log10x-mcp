/**
 * log10x_env_register — persist a full EnvironmentConfig document to an
 * on-prem env-config store (k8s ConfigMap, AWS SSM, GCP Secret Manager,
 * Azure App Configuration, or local file).
 *
 * Companion to `log10x_create_env`. Where create_env mints a new env on
 * the Log10x account (account-level identity + apiKey), env_register
 * writes the **cluster-side** descriptor that other tools resolve: where
 * the streamer is, where the retriever is, which SIEM the logs land in,
 * which offload destinations the Receiver may write to. The two tools
 * are independent — register can run against an env_id that originated
 * outside the Log10x account API, e.g. an on-prem-only customer who
 * never calls the SaaS backend.
 *
 * Behaviour:
 *
 *   1. Build the EnvironmentConfig from args (caller may pass
 *      `offload_destinations`; absent → defaults to a single
 *      `nickname: "primary"` placeholder so the document satisfies the
 *      `min(1)` schema rule).
 *   2. Validate against `environmentConfigSchema` (zod). Validation
 *      failures return BEFORE any store side effect — partial writes
 *      are not allowed.
 *   3. Pick a store:
 *        - if `target_store` is supplied, instantiate exactly that
 *          backend and refuse if it's unavailable (no silent fallback —
 *          if the caller asked for SSM, write to SSM or fail).
 *        - otherwise probe the chain (k8s → aws_ssm → gcp_sm → azure_ac
 *          → local) and use the first that reports `isAvailable: true`.
 *          Local file is the dev fallback so the chain always terminates
 *          on a writeable store.
 *   4. Call `store.write(config)`. Stamp `updated_at` to now if the
 *      caller didn't supply one.
 *   5. Return the canonical persisted document + which store_kind we
 *      wrote to + the availability probe trace so the agent can show
 *      "wrote to k8s ConfigMap in namespace log10x".
 *
 * Idempotent: re-running with the same `env_id` overwrites in place
 * (k8s server-side-apply, SSM PutParameter, local file rewrite). The
 * tool DOES NOT diff against an existing document — callers who want
 * partial updates should read + merge + register again.
 */

import { z } from 'zod';
import {
  clusterIdentitySchema,
  siemDestinationSchema,
  streamerConfigSchema,
  retrieverConfigSchema,
  offloadDestinationSchema,
  environmentConfigSchema,
  type EnvironmentConfig,
  type OffloadDestination,
} from '../lib/env-config/types.js';
import type { EnvConfigStore, StoreKind } from '../lib/env-config/store-interface.js';
import { buildStore, buildDefaultStoreChain } from '../lib/env-config/stores.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { requireWriteAccess } from '../lib/read-only-guard.js';

/** The store kinds a caller may pin via `target_store`. Mirrors `StoreKind`. */
const targetStoreEnum = z.enum(['k8s', 'aws_ssm', 'gcp_sm', 'azure_ac', 'local']);

export const envRegisterSchema = {
  env_id: z
    .string()
    .min(1)
    .describe(
      'Stable UUID identifying this environment. Used as the document key in every backend (k8s ConfigMap name, SSM parameter id, file name).'
    ),
  nickname: z
    .string()
    .min(1)
    .describe(
      'Human-friendly label (e.g. "acme-prod", "staging-us-east"). Used by tools when the user types a name instead of the env_id.'
    ),
  cluster: clusterIdentitySchema.describe(
    'Cluster identity: type (eks/gke/aks/...) + cloud locators (region, account, project_id, subscription).'
  ),
  destination: siemDestinationSchema.describe(
    'SIEM the logs ultimately land in. Drives action eligibility (e.g. tier_down is Datadog/CloudWatch/Azure-only) and explainer copy.'
  ),
  streamer: streamerConfigSchema.describe(
    'Streamer endpoint — the in-cluster service that fronts the Receiver. `url` is required; `target_path` is the optional sub-path under a shared ingress.'
  ),
  retriever: retrieverConfigSchema.describe(
    'Retriever endpoint + the four SQS queues (index/subquery/stream/query) it coordinates on. `input_bucket` is the archive the Retriever reads from.'
  ),
  offload_destinations: z
    .array(offloadDestinationSchema)
    .optional()
    .describe(
      'Where the Receiver may write objects when a pattern is tagged `offload`. Omit for a default single-destination placeholder (nickname "primary", type "s3", status "active") — the agent can update it later with the real bucket via a follow-up register call.'
    ),
  target_store: targetStoreEnum
    .optional()
    .describe(
      'Pin the persistence backend. Omit to auto-pick the first available in chain (k8s → aws_ssm → gcp_sm → azure_ac → local). When set, the tool refuses if the named store is unavailable rather than silently falling back — "I asked for SSM" must mean SSM.'
    ),
};

export type EnvRegisterArgs = {
  env_id: string;
  nickname: string;
  cluster: z.infer<typeof clusterIdentitySchema>;
  destination: z.infer<typeof siemDestinationSchema>;
  streamer: z.infer<typeof streamerConfigSchema>;
  retriever: z.infer<typeof retrieverConfigSchema>;
  offload_destinations?: OffloadDestination[];
  target_store?: StoreKind;
};

interface AvailabilityProbeStep {
  store_kind: StoreKind;
  available: boolean;
  reason: string;
}

interface EnvRegisterInner {
  ok: boolean;
  env_id: string;
  nickname: string;
  config?: EnvironmentConfig;
  store_used?: StoreKind;
  availability_probe: AvailabilityProbeStep[];
  error?: string;
}

export async function executeEnvRegister(
  args: EnvRegisterArgs
): Promise<string | StructuredOutput> {
  requireWriteAccess(
    'writes the env-config document for env_id to the on-prem store (k8s ConfigMap log10x-env-config-{env_id} or equivalent)'
  );
  const inner = await executeEnvRegisterInner(args);

  const headline = inner.ok
    ? `Registered env "${inner.nickname}" (env_id ${inner.env_id}) to ${inner.store_used} store.`
    : `Register env refused: ${inner.error ?? 'unknown reason'}.`;

  const human_summary = inner.ok
    ? `Env "${inner.nickname}" is now persisted in the ${inner.store_used} backend; tools that resolve by env_id or nickname will see it on the next call.`
    : `env_register failed: ${inner.error ?? 'unknown reason'}.`;

  return buildEnvelope({
    tool: 'log10x_env_register',
    view: 'summary',
    summary: { headline },
    data: {
      ok: inner.ok,
      env_id: inner.env_id,
      nickname: inner.nickname,
      config: inner.config,
      store_used: inner.store_used,
      availability_probe: inner.availability_probe,
      error: inner.error,
      human_summary,
    },
    actions: inner.ok
      ? [
          {
            tool: 'log10x_advise_install',
            args: { environment: inner.nickname },
            reason:
              'pick the right Reporter / Receiver / Retriever install path now that the env document is persisted',
          },
        ]
      : [],
  });
}

async function executeEnvRegisterInner(args: EnvRegisterArgs): Promise<EnvRegisterInner> {
  // 1. Default offload_destinations to a single placeholder so the
  //    document satisfies `min(1)` even when the caller hasn't decided
  //    on a bucket yet. Callers wiring up a real Receiver are expected
  //    to overwrite this on the next register call.
  const offload_destinations: OffloadDestination[] =
    args.offload_destinations && args.offload_destinations.length > 0
      ? args.offload_destinations
      : [
          {
            nickname: 'primary',
            type: 's3',
            status: 'active',
            note: 'placeholder — overwrite with the real bucket via a follow-up env_register call',
          },
        ];

  const candidate: EnvironmentConfig = {
    schema_version: '1.0',
    env_id: args.env_id,
    nickname: args.nickname,
    cluster: args.cluster,
    destination: args.destination,
    offload_destinations,
    streamer: args.streamer,
    retriever: args.retriever,
    updated_at: new Date().toISOString(),
  };

  // 2. Validate. zod parse throws on failure — convert to a clean
  //    error message so the envelope renders a one-line "register
  //    refused" instead of a stack trace.
  let validated: EnvironmentConfig;
  try {
    validated = environmentConfigSchema.parse(candidate);
  } catch (err) {
    const summary = summarizeZodError(err);
    return {
      ok: false,
      env_id: args.env_id,
      nickname: args.nickname,
      availability_probe: [],
      error: `EnvironmentConfig failed schema validation: ${summary}`,
    };
  }

  // 3. Build store list. Pinned target → just that one; else the full
  //    chain in resolver order.
  const stores: EnvConfigStore[] = args.target_store
    ? [buildStore(args.target_store)]
    : buildDefaultStoreChain();

  // 4. Probe + pick.
  const probe: AvailabilityProbeStep[] = [];
  let chosen: EnvConfigStore | null = null;
  for (const store of stores) {
    const a = await store.isAvailable();
    probe.push({ store_kind: store.kind, available: a.available, reason: a.reason });
    if (a.available) {
      chosen = store;
      break;
    }
  }

  if (!chosen) {
    if (args.target_store) {
      return {
        ok: false,
        env_id: args.env_id,
        nickname: args.nickname,
        availability_probe: probe,
        error:
          `target_store="${args.target_store}" reported unavailable: ${probe[0]?.reason ?? 'no reason supplied'}. ` +
          `Either fix the backend (creds/region/namespace) or omit target_store to fall through to the next store in the chain.`,
      };
    }
    return {
      ok: false,
      env_id: args.env_id,
      nickname: args.nickname,
      availability_probe: probe,
      error:
        'no env-config store was available — every backend in the chain reported unavailable. ' +
        'Local file store should always be available; this likely means HOME is unwriteable or the chain was overridden.',
    };
  }

  // 5. Write. Store-level errors (auth fail, malformed cluster reply)
  //    surface here as a thrown error → caught + returned as ok:false.
  try {
    await chosen.write(validated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      env_id: args.env_id,
      nickname: args.nickname,
      availability_probe: probe,
      error: `${chosen.kind} store accepted the write request but failed mid-write: ${msg}`,
    };
  }

  return {
    ok: true,
    env_id: validated.env_id,
    nickname: validated.nickname,
    config: validated,
    store_used: chosen.kind,
    availability_probe: probe,
  };
}

/** Instantiate the store for a pinned `target_store` arg. */
/**
 * Compact zod error summary. Surfaces up to the first 5 issues with
 * dotted paths so the agent can fix the offending field without
 * parsing a multi-line ZodError dump.
 */
function summarizeZodError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .slice(0, 5)
      .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}
