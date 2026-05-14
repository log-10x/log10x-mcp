/**
 * Environment / credential configuration.
 *
 * Resolution chain, tried in order. Each path returns either a fully
 * populated Environments object or undefined (path didn't apply).
 *
 *   1. **`LOG10X_METRICS_BACKEND_KIND` + `LOG10X_METRICS_*` env vars**
 *      (new in phase 3). Single-env mode for laptop-pointing-at-one-
 *      cluster setups. Any backend kind (prometheus, mimir, cortex,
 *      amp, datadog, gcp_managed_prom, grafana_cloud_prom, log10x).
 *      Nickname defaults to `default`. No file required.
 *
 *   2. **`~/.log10x/envs.json`** (new in phase 3). Multi-env file with
 *      per-env backend declarations. Authoritative when present. The
 *      `log10x_configure_env` tool writes this file from a
 *      conversational onboarding flow; users can also hand-edit it.
 *
 *   3. **`LOG10X_API_KEY` env var** (legacy). The MCP calls
 *      `GET /api/v1/user` and populates the env list from the response.
 *      Each env gets `metricsBackend: { kind: 'log10x', apiKey, envId }`
 *      auto-populated. Phase 7 makes this path require an explicit
 *      `LOG10X_METRICS_BACKEND_KIND=log10x` to opt in.
 *
 *   4. **`~/.log10x/credentials`** (legacy). Persistent file written by
 *      `log10x_signin_complete` after Auth0 device flow. Same shape as
 *      path 3 — calls `/api/v1/user` with the cached key.
 *
 *   5. **Demo mode** (legacy, removed in phase 7). Public read-only
 *      log10x demo env so a user can play without signing up.
 *
 * If both path 1 and path 2 produce envs, the MCP refuses to start
 * (loud error — user picks one). Paths 1+2 vs paths 3+4 do NOT
 * collide; the new paths just win.
 *
 * Multi-account access for the log10x backend uses backend-side env
 * sharing: an env owner grants READ/WRITE/OWNER to another user's
 * account, and the recipient's `/api/v1/user` response includes the
 * shared env. No client-side multi-credential juggling.
 *
 * Per-call env resolution (used by every tool that accepts an
 * `environment` arg) follows the chain: explicit-nickname →
 * last-used-this-session → user's default env.
 */

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { fetchUserProfile, type Permission, type RemoteUserProfile } from './api.js';
import { readCredentials } from './credentials.js';
import {
  createMetricsBackend,
  MetricsBackendConfigError,
  type MetricsBackend,
  type MetricsBackendConfig,
  type PromAuth,
} from './metrics-backend.js';
import { DEFAULT_LABELS, type LabelNameMap } from './promql.js';

/**
 * The publicly-baked demo API key used by console.log10x.com's "explore
 * without signing up" experience. Hardcoded in the dotcom frontend
 * (dotcom/log10x/js/config.js), the console build (terraform/console),
 * and the demo-stats-cache lambda — so this isn't a secret.
 *
 * Grants READ-only access to the shared "Log10x Demo" env. No writes.
 * Same data every demo user sees on the console.
 *
 * Phase 7 removes the silent demo-fallback path. The constant remains
 * here as the "if you really want the demo, here's the key" reference
 * but is no longer auto-applied.
 */
const DEMO_API_KEY = '4d985100-ee4a-4b6c-b784-a416b8684868';

export interface EnvConfig {
  nickname: string;
  /**
   * The metrics backend this env queries. Required field — every env
   * has a backend, even legacy log10x ones (auto-populated from
   * apiKey + envId).
   */
  metricsBackend: MetricsBackend;
  /**
   * Per-env label name map. Defaults to `DEFAULT_LABELS`. Customers
   * who renamed the engine's `metricFieldNames` set this to match.
   */
  labels: LabelNameMap;
  /**
   * Legacy fields, only meaningful for `kind: 'log10x'` envs.
   * Auto-populated when the env came from a log10x backend; left as
   * empty strings for other backends. Phase 4 swaps tools to use
   * `env.metricsBackend` directly, after which these fields become
   * informational only.
   */
  apiKey: string;
  envId: string;
  /** Present when env was loaded via `/api/v1/user` autodiscovery. */
  owner?: string;
  /** Present when env was loaded via `/api/v1/user` autodiscovery. */
  permissions?: Permission;
  /** True if the backend marked this env as the user's default. */
  isDefault?: boolean;
}

/** Parsed environment list + default + mutable last-used slot. */
export interface Environments {
  all: EnvConfig[];
  byNickname: Map<string, EnvConfig>;
  default: EnvConfig;
  /** Set by `resolveEnv` each time a caller names an env explicitly. */
  lastUsed?: EnvConfig;
  /** The user profile backing the env list — populated only for log10x-backed envs. */
  profile?: RemoteUserProfile;
  /**
   * `true` if the MCP is running against the public demo key (either
   * because nothing was configured, or because the user's own
   * LOG10X_API_KEY failed validation and we fell back). Tools should
   * treat this as a "you're in a demo sandbox" signal and prefer to
   * surface upgrade guidance over silent failures on write attempts.
   *
   * Phase 7 removes the silent fallback path; this field stays true
   * only when the user explicitly opts into the demo env.
   */
  isDemoMode: boolean;
  /**
   * When set, the MCP fell back to demo mode because the user's
   * configured API key did NOT work. The string is the underlying
   * failure (HTTP status, validation error, network reason). Surfaced
   * in doctor and prepended to every API-hitting tool result so the
   * user knows the data is demo, not their own.
   *
   * Distinguished from "pure demo" (no key set, demoFallbackReason
   * undefined) because the user's intent matters: a typo'd key
   * silently downgrading to demo is a footgun; flagging it loudly is
   * the fix.
   */
  demoFallbackReason?: string;
}

/**
 * Resolved at call time, not module-load time, so test fixtures can
 * point `HOME` at a tempdir without `homedir()`'s cache holding the
 * old path. Production calls hit this once per `loadEnvironments`.
 */
function envsJsonPath(): string {
  return join(process.env.HOME || homedir(), '.log10x', 'envs.json');
}

/**
 * Resolve the active credentials and load the env list. Async because
 * the legacy log10x paths hit the log10x API for env autodiscovery.
 *
 * Returns demo-mode `Environments` (with `demoFallbackReason` set) on
 * any non-fatal failure of the user-supplied credential — never
 * throws on a typo'd key. Tools surface a loud banner when
 * `demoFallbackReason` is non-empty so the user is told their data is
 * demo, not their own.
 */
export async function loadEnvironments(): Promise<Environments> {
  // Path 1 + 2: new-style configuration.
  const fromMetricsEnvVars = tryBuildFromMetricsEnvVars();
  const fromEnvsFile = await tryReadEnvsJson();

  if (fromMetricsEnvVars && fromEnvsFile) {
    throw new EnvironmentValidationError(
      `Both LOG10X_METRICS_* env vars AND ${envsJsonPath()} are set. ` +
        `Pick one — env vars are for single-env setups; the file is for multi-env. ` +
        `Either unset the env vars (\`unset LOG10X_METRICS_BACKEND_KIND ...\`) or ` +
        `move/remove the file.`
    );
  }
  if (fromMetricsEnvVars) {
    return buildEnvironments([fromMetricsEnvVars]);
  }
  if (fromEnvsFile) {
    return buildEnvironments(fromEnvsFile);
  }

  // Path 3 + 4 + 5: legacy log10x-account paths.
  return loadLegacyLog10x();
}

// ── New-style loaders ────────────────────────────────────────────────────

/**
 * Parse `LOG10X_METRICS_*` environment variables into a single
 * EnvConfig. Returns undefined when `LOG10X_METRICS_BACKEND_KIND` is
 * unset (the trigger for single-env mode). Throws on partial/invalid
 * config so the user gets a clear setup error.
 */
function tryBuildFromMetricsEnvVars(): EnvConfig | undefined {
  const kind = process.env.LOG10X_METRICS_BACKEND_KIND?.trim() as
    | MetricsBackendConfig['kind']
    | undefined;
  if (!kind) return undefined;

  const config = parseMetricsBackendFromEnv(kind);
  try {
    return {
      nickname: process.env.LOG10X_METRICS_NICKNAME?.trim() || 'default',
      metricsBackend: createMetricsBackend(config),
      labels: parseLabelMapFromEnv(),
      apiKey: kind === 'log10x' ? config.kind === 'log10x' ? config.apiKey : '' : '',
      envId: kind === 'log10x' ? config.kind === 'log10x' ? config.envId : '' : '',
      isDefault: true,
    };
  } catch (e) {
    if (e instanceof MetricsBackendConfigError) {
      throw new EnvironmentValidationError(`Invalid LOG10X_METRICS_* config: ${e.message}`);
    }
    throw e;
  }
}

function parseMetricsBackendFromEnv(kind: MetricsBackendConfig['kind']): MetricsBackendConfig {
  /**
   * Require the env var to be set, but return a `${VAR}` REFERENCE
   * string (not the raw value). The reference goes through
   * `resolveVarReference` in `createMetricsBackend`, which resolves
   * it from process.env at backend-construction time AND bypasses the
   * literal-secret guard (the guard only fires on FILE-stored
   * values without a ${VAR} wrapper). This way the env-var path
   * accepts long random-looking values (DD_API_KEY, etc.) without
   * tripping the guard.
   */
  const refEnv = (name: string): string => {
    if (!process.env[name]) {
      throw new EnvironmentValidationError(`Required env var ${name} is unset for backend kind '${kind}'.`);
    }
    return `\${${name}}`;
  };
  switch (kind) {
    case 'log10x':
      return {
        kind: 'log10x',
        apiKey: refEnv('LOG10X_API_KEY'),
        envId: refEnv('LOG10X_ENV_ID'),
      };
    case 'prometheus':
      return { kind: 'prometheus', url: refEnv('LOG10X_METRICS_URL'), auth: parseAuthFromEnv() };
    case 'mimir': {
      const cfg: Extract<MetricsBackendConfig, { kind: 'mimir' }> = {
        kind: 'mimir',
        url: refEnv('LOG10X_METRICS_URL'),
        auth: parseAuthFromEnv(),
      };
      const orgId = process.env.LOG10X_METRICS_MIMIR_ORG_ID;
      if (orgId) cfg.orgId = orgId;
      return cfg;
    }
    case 'cortex':
      return {
        kind: 'cortex',
        url: refEnv('LOG10X_METRICS_URL'),
        auth: parseAuthFromEnv(),
        orgId: refEnv('LOG10X_METRICS_CORTEX_ORG_ID'),
      };
    case 'amp':
      return {
        kind: 'amp',
        url: refEnv('LOG10X_METRICS_URL'),
        region: refEnv('LOG10X_METRICS_AMP_REGION'),
      };
    case 'datadog':
      return {
        kind: 'datadog',
        site: process.env.LOG10X_METRICS_DATADOG_SITE || process.env.DD_SITE || 'datadoghq.com',
        apiKey: refEnv('DD_API_KEY'),
        appKey: refEnv('DD_APP_KEY'),
      };
    case 'grafana_cloud_prom':
      return {
        kind: 'grafana_cloud_prom',
        url: refEnv('LOG10X_METRICS_URL'),
        user: refEnv('LOG10X_METRICS_GRAFANA_USER'),
        apiKey: refEnv('GRAFANA_CLOUD_API_KEY'),
      };
    case 'gcp_managed_prom':
      return {
        kind: 'gcp_managed_prom',
        url: refEnv('LOG10X_METRICS_URL'),
        projectId: refEnv('LOG10X_METRICS_GCP_PROJECT_ID'),
      };
    default: {
      // Exhaustiveness — TS narrows kind to never if we hit this.
      const _exhaustive: never = kind;
      throw new EnvironmentValidationError(`Unknown LOG10X_METRICS_BACKEND_KIND=${String(_exhaustive)}`);
    }
  }
}

function parseAuthFromEnv(): PromAuth {
  const type = (process.env.LOG10X_METRICS_AUTH_TYPE || 'none').trim().toLowerCase();
  // Same pattern as parseMetricsBackendFromEnv: validate env-var
  // presence, but pass `${VAR}` reference so secret-detection guard
  // bypasses for resolved values.
  switch (type) {
    case 'none':
      return { type: 'none' };
    case 'bearer': {
      if (!process.env.LOG10X_METRICS_AUTH_VALUE) throw new EnvironmentValidationError(`LOG10X_METRICS_AUTH_TYPE=bearer requires LOG10X_METRICS_AUTH_VALUE.`);
      return { type: 'bearer', token: '${LOG10X_METRICS_AUTH_VALUE}' };
    }
    case 'basic': {
      const user = process.env.LOG10X_METRICS_AUTH_USER;
      const password = process.env.LOG10X_METRICS_AUTH_VALUE;
      if (!user || !password) {
        throw new EnvironmentValidationError(
          `LOG10X_METRICS_AUTH_TYPE=basic requires both LOG10X_METRICS_AUTH_USER and LOG10X_METRICS_AUTH_VALUE.`
        );
      }
      return { type: 'basic', user: '${LOG10X_METRICS_AUTH_USER}', password: '${LOG10X_METRICS_AUTH_VALUE}' };
    }
    case 'header': {
      const name = process.env.LOG10X_METRICS_AUTH_HEADER_NAME;
      const value = process.env.LOG10X_METRICS_AUTH_VALUE;
      if (!name || !value) {
        throw new EnvironmentValidationError(
          `LOG10X_METRICS_AUTH_TYPE=header requires both LOG10X_METRICS_AUTH_HEADER_NAME and LOG10X_METRICS_AUTH_VALUE.`
        );
      }
      return { type: 'header', name, value: '${LOG10X_METRICS_AUTH_VALUE}' };
    }
    default:
      throw new EnvironmentValidationError(
        `Unknown LOG10X_METRICS_AUTH_TYPE=${type}. Valid: none, bearer, basic, header.`
      );
  }
}

function parseLabelMapFromEnv(): LabelNameMap {
  return {
    pattern: process.env.LOG10X_METRICS_LABEL_PATTERN || DEFAULT_LABELS.pattern,
    service: process.env.LOG10X_METRICS_LABEL_SERVICE || DEFAULT_LABELS.service,
    severity: process.env.LOG10X_METRICS_LABEL_SEVERITY || DEFAULT_LABELS.severity,
    env: process.env.LOG10X_METRICS_LABEL_ENV || DEFAULT_LABELS.env,
  };
}

/**
 * Shape stored in `~/.log10x/envs.json`: array of objects each
 * carrying its own `metricsBackend` config + optional `labels` map.
 */
interface EnvsJsonEntry {
  nickname: string;
  metricsBackend: MetricsBackendConfig;
  labels?: Partial<LabelNameMap>;
  isDefault?: boolean;
}

/**
 * Read `~/.log10x/envs.json` if it exists. Returns undefined when the
 * file is absent (the normal case during the transition). Throws on
 * parse errors or invalid backend configs.
 */
async function tryReadEnvsJson(): Promise<EnvConfig[] | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(envsJsonPath(), 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new EnvironmentValidationError(
      `Could not read ${envsJsonPath()}: ${(e as Error).message}.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new EnvironmentValidationError(
      `${envsJsonPath()} is not valid JSON: ${(e as Error).message}.`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new EnvironmentValidationError(
      `${envsJsonPath()} must be a JSON array of env entries; got ${typeof parsed}.`
    );
  }
  const entries = parsed as EnvsJsonEntry[];
  if (entries.length === 0) {
    throw new EnvironmentValidationError(
      `${envsJsonPath()} is empty. Either remove it (to fall back to env vars or legacy) or add at least one env entry.`
    );
  }
  return entries.map((entry, i) => {
    if (!entry.nickname || !entry.metricsBackend) {
      throw new EnvironmentValidationError(
        `${envsJsonPath()} entry #${i} is missing required field 'nickname' or 'metricsBackend'.`
      );
    }
    try {
      const backend = createMetricsBackend(entry.metricsBackend);
      const labels: LabelNameMap = {
        pattern: entry.labels?.pattern ?? DEFAULT_LABELS.pattern,
        service: entry.labels?.service ?? DEFAULT_LABELS.service,
        severity: entry.labels?.severity ?? DEFAULT_LABELS.severity,
        env: entry.labels?.env ?? DEFAULT_LABELS.env,
      };
      const apiKey =
        entry.metricsBackend.kind === 'log10x' ? entry.metricsBackend.apiKey : '';
      const envId =
        entry.metricsBackend.kind === 'log10x' ? entry.metricsBackend.envId : '';
      return {
        nickname: entry.nickname,
        metricsBackend: backend,
        labels,
        apiKey,
        envId,
        isDefault: entry.isDefault,
      };
    } catch (e) {
      if (e instanceof MetricsBackendConfigError) {
        throw new EnvironmentValidationError(
          `${envsJsonPath()} entry #${i} (${entry.nickname}): ${e.message}`
        );
      }
      throw e;
    }
  });
}

// ── Legacy log10x paths (unchanged behavior — phase 7 tightens) ──────────

async function loadLegacyLog10x(): Promise<Environments> {
  const apiKey = process.env.LOG10X_API_KEY;

  // Path 3: explicit `LOG10X_API_KEY`.
  if (apiKey) {
    try {
      return await loadFromApi(apiKey, /*isDemoMode=*/ false);
    } catch (e) {
      if (!(e instanceof EnvironmentValidationError)) throw e;
      const reason = (e as Error).message;
      const demoEnvs = await loadFromApi(DEMO_API_KEY, /*isDemoMode=*/ true).catch(() => null);
      if (!demoEnvs) throw e;
      demoEnvs.demoFallbackReason = reason;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[log10x-mcp] WARNING: your LOG10X_API_KEY failed validation — ` +
          `falling back to read-only demo mode.\n` +
          `  Reason: ${reason.slice(0, 400)}\n` +
          `  All tools will return data from the public Log10x demo env, NOT your account. ` +
          `Fix the key (or unset LOG10X_API_KEY entirely) to use your own data.\n`
      );
      return demoEnvs;
    }
  }

  // Path 4: persistent credentials at ~/.log10x/credentials, written
  // by log10x_signin_complete.
  let creds: Awaited<ReturnType<typeof readCredentials>>;
  try {
    creds = await readCredentials();
  } catch (e) {
    // Malformed file or permission error — distinct from "missing".
    // Fall back to demo with the file failure surfaced.
    const reason = (e as Error).message;
    const demoEnvs = await loadFromApi(DEMO_API_KEY, /*isDemoMode=*/ true);
    demoEnvs.demoFallbackReason = reason;
    return demoEnvs;
  }
  if (creds) {
    try {
      return await loadFromApi(creds.apiKey, /*isDemoMode=*/ false);
    } catch (e) {
      if (!(e instanceof EnvironmentValidationError)) throw e;
      const reason = (e as Error).message;
      const demoEnvs = await loadFromApi(DEMO_API_KEY, /*isDemoMode=*/ true).catch(() => null);
      if (!demoEnvs) throw e;
      demoEnvs.demoFallbackReason =
        `~/.log10x/credentials key failed validation: ${reason}. ` +
        `Run \`log10x_signin_start\` to refresh via the Auth0 Device Flow with GitHub or Google ` +
        `(the model chains to \`log10x_signin_complete\` automatically), or call ` +
        `\`log10x_signin_complete\` directly with \`{ api_key: "<key>" }\` to paste a key from ` +
        `console.log10x.com → Profile → API Settings, or \`log10x_signout\` to clear and use demo. ` +
        `See \`log10x_login_status\` for the full breakdown.`;
      return demoEnvs;
    }
  }

  // Path 5: nothing set — pure demo mode. Public demo key so the
  // user can play without signing up. Phase 7 removes this silent
  // fallback in favor of an explicit "not configured" state.
  return await loadFromApi(DEMO_API_KEY, /*isDemoMode=*/ true);
}

/**
 * Re-run `loadEnvironments()` from scratch and overwrite the contents
 * of an existing `Environments` object in place. Used by
 * `log10x_signin_complete` and `log10x_signout` to swap credentials
 * without forcing the user to restart the MCP host.
 *
 * In-place mutation matters: every tool callback closes over a
 * reference to the same Environments object via `getEnvs()` in
 * `index.ts`. If we returned a fresh object, we'd have to chase
 * references through the entire codebase to swap them all.
 */
export async function reloadEnvironmentsInPlace(target: Environments): Promise<void> {
  const fresh = await loadEnvironments();
  // Clear the lastUsed pointer. It referenced an EnvConfig from the
  // old set, which is no longer in `target.byNickname`.
  target.lastUsed = undefined;
  target.all = fresh.all;
  target.byNickname = fresh.byNickname;
  target.default = fresh.default;
  target.profile = fresh.profile;
  target.isDemoMode = fresh.isDemoMode;
  target.demoFallbackReason = fresh.demoFallbackReason;
}

/**
 * Delete `LOG10X_API_KEY` from `process.env` if set. Returns whether
 * a deletion occurred so the caller can mention it in the result.
 */
export function clearOverridingEnvVar(): boolean {
  if (process.env.LOG10X_API_KEY) {
    delete process.env.LOG10X_API_KEY;
    return true;
  }
  return false;
}

/**
 * Force a revalidation of credentials and refresh the in-memory `envs`
 * object so the next tool call sees ground truth instead of cached
 * boot-time state.
 *
 * Always calls `clearOverridingEnvVar` first. Without that, a stale
 * `LOG10X_API_KEY` in `process.env` (from the MCP host config) would
 * keep beating the freshly-written credentials file and reload would
 * just re-fail the same way.
 */
export async function revalidateEnvironments(target: Environments): Promise<{ envVarCleared: boolean }> {
  const envVarCleared = clearOverridingEnvVar();
  await reloadEnvironmentsInPlace(target);
  return { envVarCleared };
}

async function loadFromApi(apiKey: string, isDemoMode: boolean): Promise<Environments> {
  let profile: RemoteUserProfile;
  try {
    profile = await fetchUserProfile(apiKey);
  } catch (e) {
    if (isDemoMode) {
      throw new EnvironmentValidationError(
        `Demo-mode boot via GET /api/v1/user failed: ${(e as Error).message}. ` +
          `Either the MCP can't reach prometheus.log10x.com from this network, ` +
          `or the demo key has rotated and the MCP needs a refresh. ` +
          `Bypass demo by signing in to your own account: run \`log10x_signin_start\` ` +
          `for the Auth0 Device Flow with GitHub or Google (the model chains to ` +
          `\`log10x_signin_complete\` automatically), or call \`log10x_signin_complete\` ` +
          `directly with \`{ api_key: "<key>" }\` to paste an existing key, or set ` +
          `\`LOG10X_API_KEY\` to a key from console.log10x.com → Profile → API Settings.`
      );
    }
    throw new EnvironmentValidationError(
      `LOG10X_API_KEY is set but env autodiscovery via GET /api/v1/user failed: ` +
        `${(e as Error).message}. ` +
        `Verify the key at console.log10x.com → Profile → API Settings, ` +
        `or run \`log10x_signin_start\` to mint a fresh one via the Auth0 Device Flow ` +
        `with GitHub or Google (the model chains to \`log10x_signin_complete\` ` +
        `automatically), or call \`log10x_signin_complete\` directly with ` +
        `\`{ api_key: "<key>" }\` to paste a key. Either path auto-clears the bad ` +
        `\`LOG10X_API_KEY\` in-process. Or unset \`LOG10X_API_KEY\` entirely to fall ` +
        `back to read-only demo mode.`
    );
  }
  if (profile.environments.length === 0) {
    throw new EnvironmentValidationError(
      isDemoMode
        ? `Demo profile has no environments attached. The demo key may have rotated.`
        : `API key is valid but the account has no environments attached. ` +
          `Visit console.log10x.com and provision at least one environment.`
    );
  }
  const entries: EnvConfig[] = profile.environments.map((e) => ({
    nickname: e.name,
    apiKey,
    envId: e.envId,
    metricsBackend: createMetricsBackend({ kind: 'log10x', apiKey, envId: e.envId }),
    labels: { ...DEFAULT_LABELS },
    owner: e.owner,
    permissions: e.permissions,
    isDefault: e.isDefault,
  }));
  const envs = buildEnvironments(entries);
  envs.profile = profile;
  envs.isDemoMode = isDemoMode;
  return envs;
}

function buildEnvironments(entries: EnvConfig[]): Environments {
  const byNickname = new Map<string, EnvConfig>();
  for (const env of entries) {
    const key = env.nickname.toLowerCase();
    if (byNickname.has(key)) {
      throw new EnvironmentValidationError(
        `Duplicate environment nickname "${env.nickname}". Each nickname must be unique.`
      );
    }
    byNickname.set(key, env);
  }

  // Prefer the backend-marked default (autodiscovery path), fall back to
  // the first entry otherwise. The backend guarantees at most one default
  // per user but the client should still be robust to the 0-default case.
  const explicitDefault = entries.find((e) => e.isDefault);
  const defaultEnv = explicitDefault ?? entries[0];

  return { all: entries, byNickname, default: defaultEnv, isDemoMode: false };
}

export class EnvironmentValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'EnvironmentValidationError';
  }
}

/**
 * Resolve an environment using the priority chain:
 *   1. Explicit nickname (if passed)
 *   2. Last-used this session
 *   3. User's default env
 *
 * When an explicit nickname is resolved successfully, it's recorded as
 * the new last-used so subsequent unscoped calls stay on the same env.
 */
export function resolveEnv(envs: Environments, nickname?: string): EnvConfig {
  if (nickname) {
    const env = envs.byNickname.get(nickname.toLowerCase());
    if (!env) {
      const available = envs.all.map((e) => e.nickname).join(', ');
      throw new Error(`Unknown environment "${nickname}". Available: ${available}`);
    }
    envs.lastUsed = env;
    return env;
  }
  if (envs.lastUsed) return envs.lastUsed;
  return envs.default;
}

/** Programmatic override for tests or future "stick to this env" features. */
export function setLastUsed(envs: Environments, env: EnvConfig): void {
  envs.lastUsed = env;
}
