/**
 * Convenience wrapper around `resolveEnvConfig()` for tools that need to read
 * cluster identifiers (offload bucket, SIEM vendor, retriever endpoint, queue
 * URLs) but DON'T already know which env they're talking about.
 *
 * The four tools that historically read these from process.env directly —
 * retriever-probe, configure-engine, doctor, advise-retriever — share the same
 * shape: pick a single resolved env document if one exists, fall through to
 * LOG10X_* env vars if not, and surface any disagreement between the two as
 * a warning the caller can append to envelope.warnings.
 *
 * Precedence chain (per resolver.ts):
 *
 *   explicit-arg > on-prem-store > env-var fallback > fail-loudly
 *
 * StoreKind discovery order:
 *
 *   K8s > AWS SSM > GCP Secret Manager > Azure App Configuration > Local File
 *
 * Each store reports `isAvailable: false` on a host that lacks the underlying
 * cloud, so instantiating all five eagerly is safe.
 */

import { resolveEnvConfig, EnvConfigResolutionError, type ResolveResult } from './resolver.js';
import { envConfigFromEnvVars } from './env-var-bridge.js';
import type { EnvConfigStore } from './store-interface.js';
import type { EnvironmentConfig, OffloadDestination } from './types.js';
import { K8sConfigMapStore } from './store-k8s.js';
import { AwsSsmStore } from './store-aws-ssm.js';
import { GcpSecretManagerStore } from './store-gcp-sm.js';
import { AzureAppConfigStore } from './store-azure-ac.js';
import { LocalFileStore } from './store-local-file.js';

export interface ClusterConfigResolveOptions {
  /**
   * env_id or nickname to resolve. When undefined, tries — in order — the
   * `LOG10X_ENV_ID` env var, `LOG10X_ENV_NICKNAME` env var, and then `default`
   * as the well-known dev fallback. The resolver will throw if none of those
   * match a stored document AND env-var fallback can't satisfy the schema.
   */
  envIdOrNickname?: string;
  /**
   * Explicit document override. When the caller already has a fully-populated
   * EnvironmentConfig (e.g. just wrote it), pass it here to skip lookup.
   */
  explicit?: EnvironmentConfig;
  /**
   * Override the store chain. Used in tests. Production callers should pass
   * undefined to get the default K8s → SSM → GCP SM → Azure AC → Local order.
   */
  stores?: EnvConfigStore[];
}

export interface ClusterConfigResolveSuccess {
  ok: true;
  config: EnvironmentConfig;
  source: ResolveResult['source'];
  source_store_kind?: ResolveResult['source_store_kind'];
  /**
   * One warning per env-var field that disagrees with the on-prem store's
   * value. Callers should append these to envelope.warnings so users see
   * the stale-env-var nudge instead of debugging "but I set the env var".
   */
  stale_env_var_warnings: string[];
  /**
   * One step per store the resolver tried, in order. Useful for surfacing a
   * "I read this env from <store>" line in doctor / debug envelopes.
   */
  resolution_trace: ResolveResult['resolution_trace'];
}

export interface ClusterConfigResolveFailure {
  ok: false;
  error: string;
  resolution_trace: ResolveResult['resolution_trace'];
}

export type ClusterConfigResolveResult =
  | ClusterConfigResolveSuccess
  | ClusterConfigResolveFailure;

/**
 * Default store chain in discovery order. Each store's `isAvailable` cheaply
 * checks for the underlying cloud (kubeconfig, AWS creds, GCP project, Azure
 * connection string, $HOME). The chain falls through on the first available
 * store that has a document for the requested env.
 */
export function defaultClusterConfigStoreChain(): EnvConfigStore[] {
  return [
    new K8sConfigMapStore(),
    new AwsSsmStore(),
    new GcpSecretManagerStore(),
    new AzureAppConfigStore(),
    new LocalFileStore(),
  ];
}

/**
 * Try every reasonable env identifier the caller might mean. Used when the
 * tool doesn't take an env_id arg directly (e.g. retriever_probe, doctor)
 * and we have to guess from environment.
 */
function resolveCandidateIds(envIdOrNickname?: string): string[] {
  const candidates: string[] = [];
  if (envIdOrNickname) candidates.push(envIdOrNickname);
  if (process.env.LOG10X_ENV_ID && !candidates.includes(process.env.LOG10X_ENV_ID)) {
    candidates.push(process.env.LOG10X_ENV_ID);
  }
  if (
    process.env.LOG10X_ENV_NICKNAME &&
    !candidates.includes(process.env.LOG10X_ENV_NICKNAME)
  ) {
    candidates.push(process.env.LOG10X_ENV_NICKNAME);
  }
  // Final well-known fallback — used by the dev/local file store layout.
  if (!candidates.includes('default')) candidates.push('default');
  return candidates;
}

/**
 * Resolve an env-config document by walking the precedence chain. Returns a
 * tagged result so callers can attach the trace and warnings to their own
 * envelope without an exception-driven control flow.
 *
 * Note: only the FIRST candidate id that successfully resolves wins. We don't
 * union across stores or candidates — config is authoritative per env_id.
 */
export async function resolveClusterConfig(
  opts: ClusterConfigResolveOptions = {}
): Promise<ClusterConfigResolveResult> {
  const stores = opts.stores ?? defaultClusterConfigStoreChain();
  const envVarFallback = envConfigFromEnvVars() ?? undefined;
  const candidates = opts.explicit
    ? [opts.explicit.env_id]
    : resolveCandidateIds(opts.envIdOrNickname);

  let lastTrace: ResolveResult['resolution_trace'] = [];
  let lastError: string | undefined;

  for (const candidate of candidates) {
    try {
      const res = await resolveEnvConfig({
        envIdOrNickname: candidate,
        stores,
        explicit: opts.explicit,
        envVarFallback,
      });
      return {
        ok: true,
        config: res.config,
        source: res.source,
        source_store_kind: res.source_store_kind,
        stale_env_var_warnings: res.stale_env_var_warnings,
        resolution_trace: res.resolution_trace,
      };
    } catch (err) {
      if (err instanceof EnvConfigResolutionError) {
        lastTrace = err.trace;
        lastError = err.message;
        // Try the next candidate id — a different name may match.
        continue;
      }
      // Non-resolution errors (store auth, parse failure on a hand-edited
      // doc) should surface immediately rather than be swallowed by the
      // candidate loop.
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        resolution_trace: lastTrace,
      };
    }
  }

  return {
    ok: false,
    error:
      lastError ??
      `Could not resolve any env-config document (tried candidates: ${candidates.join(', ') || '<none>'}).`,
    resolution_trace: lastTrace,
  };
}

/**
 * Pick the single active offload destination from a resolved env-config.
 * The schema allows multiple — `status: "active"` is the runtime selector;
 * `draining` / `archived` / `failed` are bookkeeping states the Receiver
 * does NOT route new writes to.
 *
 * Returns the first active entry. Multi-active is a documented (multi-target
 * offload) use case; callers that care about all of them should iterate
 * `config.offload_destinations` directly.
 */
export function pickActiveOffload(config: EnvironmentConfig): OffloadDestination | undefined {
  return config.offload_destinations.find(d => d.status === 'active');
}

/**
 * Compare a resolved env-config's offload bucket to `process.env.LOG10X_STREAMER_BUCKET`
 * / `process.env.LOG10X_OFFLOAD_BUCKET` and return a warning when they
 * disagree. Tools that fall back to env vars (retriever_probe, advise_retriever,
 * doctor) should append this to envelope.warnings so the user sees the stale
 * env var instead of silently going with the store value.
 */
export function detectStaleOffloadEnvVar(
  resolvedBucket: string | undefined,
): string | undefined {
  if (!resolvedBucket) return undefined;
  const envBucket =
    process.env.LOG10X_OFFLOAD_BUCKET || process.env.LOG10X_STREAMER_BUCKET;
  if (!envBucket) return undefined;
  if (envBucket === resolvedBucket) return undefined;
  return (
    `env var ${process.env.LOG10X_OFFLOAD_BUCKET ? 'LOG10X_OFFLOAD_BUCKET' : 'LOG10X_STREAMER_BUCKET'}` +
    `="${envBucket}" disagrees with the active offload bucket "${resolvedBucket}" in the resolved env-config; ` +
    `the env var is being ignored. Unset it (or update the env-config) to clear this warning.`
  );
}

/**
 * Same idea as detectStaleOffloadEnvVar, generalised over arbitrary
 * (label, resolved, envVar) triples. Returns one warning per disagreeing
 * pair; empty array when everything agrees or nothing is set.
 */
export function detectStaleEnvVarForField(
  label: string,
  resolvedValue: string | undefined,
  envVarName: string,
): string | undefined {
  if (!resolvedValue) return undefined;
  const envValue = process.env[envVarName];
  if (!envValue) return undefined;
  if (envValue === resolvedValue) return undefined;
  return (
    `env var ${envVarName}="${envValue}" disagrees with the resolved ${label} "${resolvedValue}"; ` +
    `the env var is being ignored. Unset it (or update the env-config) to clear this warning.`
  );
}
