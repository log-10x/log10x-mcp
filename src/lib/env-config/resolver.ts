/**
 * Environment config resolution.
 *
 * Precedence chain (first match wins):
 *
 *   1. **explicit_arg** — the caller already handed us a fully-populated
 *      EnvironmentConfig (e.g. tool argument override). Always wins.
 *   2. **on_prem_store** — walk the supplied list of stores in order, pick the
 *      first that reports `isAvailable` AND has a document for the requested
 *      env_id/nickname. This is the production path.
 *   3. **env_var_fallback** — a partial config built from LOG10X_* env vars.
 *      Only used when no store has the env. Must (a) name the requested env
 *      via `env_id` or `nickname` AND (b) satisfy the schema, or we fail
 *      loudly (no silent partials, and no silently substituting a
 *      different env's partial when the requested name typos through).
 *
 * Stale-env-var detection: if an on-prem store returned the config AND
 * LOG10X_* env vars are also set, we compare the overlapping fields and emit
 * a warning per disagreement. Users get noisy reminders to remove stale env
 * vars rather than silent "wait, which value won?" debugging.
 *
 * `resolution_trace` is returned for every call so tools can surface "I read
 * this env from <store kind>" in their envelope without re-running discovery.
 */

import { environmentConfigSchema, type EnvironmentConfig } from './types.js';
import type { EnvConfigStore, StoreKind } from './store-interface.js';

export interface ResolveOptions {
  envIdOrNickname: string;
  stores: EnvConfigStore[];
  /**
   * Pre-supplied config that bypasses store lookup entirely. Used when a
   * tool already has the full document in hand (e.g. just wrote it).
   */
  explicit?: EnvironmentConfig;
  /**
   * Partial document constructed from LOG10X_* env vars. Tried only when no
   * store yields a match.
   */
  envVarFallback?: Partial<EnvironmentConfig>;
}

export interface ResolutionTraceStep {
  source: string;
  status: 'matched' | 'skipped' | 'failed';
  reason: string;
}

export interface ResolveResult {
  config: EnvironmentConfig;
  source: 'explicit_arg' | 'on_prem_store' | 'env_var_fallback';
  source_store_kind?: StoreKind;
  stale_env_var_warnings: string[];
  resolution_trace: ResolutionTraceStep[];
}

export class EnvConfigResolutionError extends Error {
  constructor(message: string, public readonly trace: ResolutionTraceStep[]) {
    super(message);
    this.name = 'EnvConfigResolutionError';
  }
}

/**
 * Resolve an environment by id or nickname, walking the precedence chain.
 * Throws `EnvConfigResolutionError` (with the trace attached) when nothing
 * matches — never returns a partial.
 */
export async function resolveEnvConfig(opts: ResolveOptions): Promise<ResolveResult> {
  const trace: ResolutionTraceStep[] = [];

  // 1. Explicit arg wins outright.
  if (opts.explicit) {
    trace.push({ source: 'explicit_arg', status: 'matched', reason: 'caller supplied config' });
    return {
      config: opts.explicit,
      source: 'explicit_arg',
      stale_env_var_warnings: [],
      resolution_trace: trace,
    };
  }
  trace.push({ source: 'explicit_arg', status: 'skipped', reason: 'no explicit config supplied' });

  // 2. Walk stores in order.
  for (const store of opts.stores) {
    const availability = await store.isAvailable();
    if (!availability.available) {
      trace.push({
        source: `store:${store.kind}`,
        status: 'skipped',
        reason: availability.reason || 'store reported unavailable',
      });
      continue;
    }

    let doc: EnvironmentConfig | null = null;
    try {
      doc = await store.read(opts.envIdOrNickname);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      trace.push({ source: `store:${store.kind}`, status: 'failed', reason });
      continue;
    }

    if (!doc) {
      trace.push({
        source: `store:${store.kind}`,
        status: 'skipped',
        reason: `no document for "${opts.envIdOrNickname}"`,
      });
      continue;
    }

    trace.push({
      source: `store:${store.kind}`,
      status: 'matched',
      reason: `document found for "${opts.envIdOrNickname}"`,
    });

    const stale = opts.envVarFallback ? detectStaleEnvVars(doc, opts.envVarFallback) : [];
    return {
      config: doc,
      source: 'on_prem_store',
      source_store_kind: store.kind,
      stale_env_var_warnings: stale,
      resolution_trace: trace,
    };
  }

  // 3. Env-var fallback. Must satisfy the schema AND name the requested
  //    env (by env_id or nickname). Without the identity check, a typo in
  //    `envIdOrNickname` would silently substitute whichever env happens to
  //    be packaged in LOG10X_* vars (typically demo) — breaking the
  //    docstring's "never returns a partial" promise by returning the WRONG
  //    complete config.
  if (opts.envVarFallback) {
    const partial = opts.envVarFallback;
    const envIdMatches = !!partial.env_id && partial.env_id === opts.envIdOrNickname;
    const nicknameMatches = !!partial.nickname && partial.nickname === opts.envIdOrNickname;

    if (!envIdMatches && !nicknameMatches) {
      // Identity mismatch: the env-var partial describes a different env
      // than the caller asked for. Surface it in the trace so callers can
      // warn about stale/misconfigured env vars, then fall through to the
      // not-found error rather than returning the wrong config.
      trace.push({
        source: 'env_var_fallback',
        status: 'skipped',
        reason:
          `env-var partial env_id "${partial.env_id ?? '<unset>'}" / nickname ` +
          `"${partial.nickname ?? '<unset>'}" does not match requested ` +
          `"${opts.envIdOrNickname}"`,
      });
    } else {
      const parsed = environmentConfigSchema.safeParse(opts.envVarFallback);
      if (parsed.success) {
        trace.push({
          source: 'env_var_fallback',
          status: 'matched',
          reason: 'env vars produced a complete config',
        });
        return {
          config: parsed.data,
          source: 'env_var_fallback',
          stale_env_var_warnings: [],
          resolution_trace: trace,
        };
      }
      trace.push({
        source: 'env_var_fallback',
        status: 'failed',
        reason: `env-var partial did not satisfy schema: ${summarizeZodIssues(parsed.error.issues)}`,
      });
    }
  } else {
    trace.push({ source: 'env_var_fallback', status: 'skipped', reason: 'no env-var partial supplied' });
  }

  throw new EnvConfigResolutionError(
    `Could not resolve environment config for "${opts.envIdOrNickname}". Checked: ${trace
      .map(t => `${t.source}=${t.status}`)
      .join(', ')}.`,
    trace,
  );
}

/**
 * Compare an on-prem-store config against a partial env-var config. Returns
 * one warning string per disagreeing field. Caller is expected to surface
 * these — silently winning would leave users with the "but I set the env var"
 * problem.
 */
function detectStaleEnvVars(
  storeConfig: EnvironmentConfig,
  envVarPartial: Partial<EnvironmentConfig>,
): string[] {
  const warnings: string[] = [];

  if (envVarPartial.env_id && envVarPartial.env_id !== storeConfig.env_id) {
    warnings.push(
      `env-var env_id "${envVarPartial.env_id}" disagrees with on-prem store "${storeConfig.env_id}" — env var is being ignored.`,
    );
  }
  if (envVarPartial.nickname && envVarPartial.nickname !== storeConfig.nickname) {
    warnings.push(
      `env-var nickname "${envVarPartial.nickname}" disagrees with on-prem store "${storeConfig.nickname}" — env var is being ignored.`,
    );
  }
  if (envVarPartial.streamer?.url && envVarPartial.streamer.url !== storeConfig.streamer.url) {
    warnings.push(
      `env-var streamer.url "${envVarPartial.streamer.url}" disagrees with on-prem store "${storeConfig.streamer.url}" — env var is being ignored.`,
    );
  }
  if (envVarPartial.retriever?.url && envVarPartial.retriever.url !== storeConfig.retriever.url) {
    warnings.push(
      `env-var retriever.url "${envVarPartial.retriever.url}" disagrees with on-prem store "${storeConfig.retriever.url}" — env var is being ignored.`,
    );
  }
  if (
    envVarPartial.retriever?.input_bucket &&
    envVarPartial.retriever.input_bucket !== storeConfig.retriever.input_bucket
  ) {
    warnings.push(
      `env-var retriever.input_bucket "${envVarPartial.retriever.input_bucket}" disagrees with on-prem store "${storeConfig.retriever.input_bucket}" — env var is being ignored.`,
    );
  }
  if (envVarPartial.destination?.siem_vendor && envVarPartial.destination.siem_vendor !== storeConfig.destination.siem_vendor) {
    warnings.push(
      `env-var destination.siem_vendor "${envVarPartial.destination.siem_vendor}" disagrees with on-prem store "${storeConfig.destination.siem_vendor}" — env var is being ignored.`,
    );
  }

  return warnings;
}

function summarizeZodIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues
    .slice(0, 5)
    .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}
