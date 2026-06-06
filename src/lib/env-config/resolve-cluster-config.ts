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
  /**
   * The envIdOrNickname the caller originally asked for (if any), preserved
   * so callers can compare against the resolved config.env_id and surface
   * "you asked for X, we resolved Y" when they disagree. Undefined when no
   * explicit id was passed (i.e. the caller wanted whatever was discoverable).
   */
  requested_env_id_or_nickname?: string;
  /**
   * Soft warnings about the resolution itself (e.g. on-prem doc existed for
   * the requested id but was corrupt and we fell through to env-var fallback).
   * Distinct from `stale_env_var_warnings`, which is per-field disagreement.
   */
  resolution_warnings: string[];
}

export interface ClusterConfigResolveFailure {
  ok: false;
  error: string;
  resolution_trace: ResolveResult['resolution_trace'];
  /**
   * The envIdOrNickname the caller originally asked for, so a failure can
   * say "you asked for X" rather than dumping the (possibly synthetic)
   * candidate chain.
   */
  requested_env_id_or_nickname?: string;
  /**
   * Soft warnings about the resolution attempt (e.g. on-prem doc was present
   * but unparseable for the requested id). These name the failure mode so
   * callers don't have to grep the trace.
   */
  resolution_warnings: string[];
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
  // ONLY when the caller (a) passed no explicit envIdOrNickname AND (b) has
  // no LOG10X_ENV_ID / LOG10X_ENV_NICKNAME set. Unconditionally pushing
  // 'default' caused silent substitution: an explicit "give me env X" that
  // didn't match would fall through to ~/.log10x/envs/default.json and the
  // resolver would report ok=true under source='on_prem_store' for a
  // completely different env — looks legit, isn't.
  if (candidates.length === 0) candidates.push('default');
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
  // Soft warnings accumulated across candidate attempts — e.g. an on-prem
  // doc existed for the requested id but failed to parse. We must surface
  // these whether we ultimately succeed (via env-var fallback) or fail.
  const resolutionWarnings: string[] = [];

  for (const candidate of candidates) {
    try {
      const res = await resolveEnvConfig({
        envIdOrNickname: candidate,
        stores,
        explicit: opts.explicit,
        envVarFallback,
      });
      // F8: even on success, surface any corrupt-doc warnings collected from
      // prior candidates so callers (and users) see "we used env-var
      // fallback because env X's on-prem doc was unparseable".
      extractCorruptDocWarnings(res.resolution_trace, resolutionWarnings);
      return {
        ok: true,
        config: res.config,
        source: res.source,
        source_store_kind: res.source_store_kind,
        stale_env_var_warnings: res.stale_env_var_warnings,
        resolution_trace: res.resolution_trace,
        requested_env_id_or_nickname: opts.envIdOrNickname,
        resolution_warnings: resolutionWarnings,
      };
    } catch (err) {
      if (err instanceof EnvConfigResolutionError) {
        lastTrace = err.trace;
        lastError = err.message;
        extractCorruptDocWarnings(err.trace, resolutionWarnings);
        // Try the next candidate id — a different name may match.
        continue;
      }
      // Non-resolution errors (store auth, parse failure on a hand-edited
      // doc) should surface immediately rather than be swallowed by the
      // candidate loop. F8: name the corrupt-doc scenario explicitly so
      // callers reading the failure don't have to guess from the message.
      const errMsg = err instanceof Error ? err.message : String(err);
      const warning =
        `doc exists for "${candidate}" but could not be parsed ` +
        `(reason: ${errMsg}). Resolver did not fall through to env-var fallback for ` +
        `this candidate — fix or remove the corrupt doc.`;
      resolutionWarnings.push(warning);
      return {
        ok: false,
        error: errMsg,
        resolution_trace: lastTrace,
        requested_env_id_or_nickname: opts.envIdOrNickname,
        resolution_warnings: resolutionWarnings,
      };
    }
  }

  return {
    ok: false,
    error:
      lastError ??
      `Could not resolve any env-config document (tried candidates: ${candidates.join(', ') || '<none>'}).`,
    resolution_trace: lastTrace,
    requested_env_id_or_nickname: opts.envIdOrNickname,
    resolution_warnings: resolutionWarnings,
  };
}

/**
 * Walk a resolution trace and lift any `status: 'failed'` store steps into
 * human-readable corrupt-doc warnings. The resolver's per-store contract is
 * that `failed` means "store was available AND we tried to read the doc
 * AND something went wrong" — which is exactly the corrupt-doc / hand-edited
 * / wrong-encoding case F8 cares about. `skipped` is benign (store
 * unavailable, or no doc present), so we ignore it.
 *
 * Dedupes against the already-collected list so re-walking traces across
 * candidate attempts doesn't double-report.
 */
function extractCorruptDocWarnings(
  trace: ResolveResult['resolution_trace'],
  out: string[],
): void {
  for (const step of trace) {
    if (step.status !== 'failed') continue;
    if (!step.source.startsWith('store:')) continue;
    // F8 text refinement: arc-v9 live test showed doctor saying "No env-config
    // document resolved" / "no document for X" when the k8s ConfigMap had been
    // malformed-JSON-patched. That conflates "store had nothing" (skipped /
    // benign) with "store had a doc but we couldn't parse it" (failed / the
    // user must act). A `failed` step on a `store:*` source means the doc DID
    // exist at that store — the resolver just couldn't deserialize it. Lead
    // with that fact so the user knows where to look.
    const warning =
      `doc exists at store ${step.source} but could not be parsed ` +
      `(reason: ${step.reason}). Resolver fell through to the next candidate / store; ` +
      `fix or remove the corrupt doc to make this env resolvable from its intended source.`;
    if (!out.includes(warning)) out.push(warning);
  }
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
 * Structured signal about whether multiple offload destinations are marked
 * `status: 'active'`. Consumers like retriever_probe call this to surface a
 * warning when the caller's intent (which active bucket?) is ambiguous: the
 * runtime picker (`pickActiveOffload`) silently picks the first match, which
 * is fine for the receiver but surprising for tools that print "the offload
 * bucket" in their envelope.
 *
 * Shape contract:
 *   - `multi_active` is true iff `active_count >= 2`.
 *   - `active_nicknames` is in array order (the same order `pickActiveOffload`
 *     walks), so `picked` is always `active_nicknames[0]` when non-empty.
 *   - `picked` is the empty string when zero destinations are active — callers
 *     that want a typed optional should branch on `active_count === 0`.
 *
 * Does NOT change `pickActiveOffload`'s behavior; this is a read-only
 * diagnostic over the same array.
 */
export interface MultiActiveOffloadSignal {
  multi_active: boolean;
  active_count: number;
  active_nicknames: string[];
  picked: string;
}

export function detectMultiActiveOffload(
  config: EnvironmentConfig,
): MultiActiveOffloadSignal {
  const active = config.offload_destinations.filter(d => d.status === 'active');
  const nicknames = active.map(d => d.nickname);
  return {
    multi_active: active.length >= 2,
    active_count: active.length,
    active_nicknames: nicknames,
    picked: nicknames[0] ?? '',
  };
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
