/**
 * Environment / credential configuration.
 *
 * Three credential sources, tried in order:
 *
 *   1. `LOG10X_API_KEY` env var. The MCP calls `GET /api/v1/user`
 *      (a user-scoped endpoint that doesn't need envId) and populates
 *      the env list from the response. Each env carries its name,
 *      owner, default flag, and permission level (OWNER/WRITE/READ).
 *      The user can switch envs at runtime via the `environment` arg
 *      on any tool call — no env-var pinning needed.
 *
 *   2. `~/.log10x/credentials` — persistent file written by
 *      `log10x_signin` after a successful GitHub-device-flow signup
 *      or signin. Loaded the same way as path 1. Living outside the
 *      MCP host's config means a single sign-in works across every
 *      MCP host on the same machine — sign in once per machine, not
 *      once per host.
 *
 *   3. Demo mode. The MCP boots against the public read-only Log10x
 *      demo env using the same key the console.log10x.com demo
 *      experience uses, so a user can play without signing up. The
 *      `log10x_login_status` tool surfaces how to upgrade, and
 *      `log10x_signin` runs the one-click GitHub flow that writes
 *      path 2. We fall back to demo ONLY when no LOG10X_API_KEY is
 *      set and no credentials file exists. If either is set but
 *      invalid, we still fall back to demo but record the failure in
 *      `demoFallbackReason` and surface a loud banner — avoiding the
 *      footgun where a typo'd key silently looks like real-account
 *      data.
 *
 * Multi-account access uses backend-side env sharing: an env owner
 * grants READ/WRITE/OWNER to another user's account, and the
 * recipient's `/api/v1/user` response includes the shared env. No
 * client-side multi-credential juggling.
 *
 * Per-call env resolution (used by every tool that accepts an
 * `environment` arg) follows the chain: explicit-nickname →
 * last-used-this-session → user's default env.
 */

/**
 * The publicly-baked demo API key used by console.log10x.com's "explore
 * without signing up" experience. Hardcoded in the dotcom frontend
 * (dotcom/log10x/js/config.js), the console build (terraform/console),
 * and the demo-stats-cache lambda — so this isn't a secret.
 *
 * Grants READ-only access to the shared "Log10x Demo" env. No writes.
 * Same data every demo user sees on the console.
 */
const DEMO_API_KEY = '4d985100-ee4a-4b6c-b784-a416b8684868';

import { fetchUserProfile, type Permission, type RemoteUserProfile } from './api.js';
import { readCredentials } from './credentials.js';

export interface EnvConfig {
  nickname: string;
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
  /** The user profile backing the env list — every load path goes through GET /api/v1/user now. */
  profile?: RemoteUserProfile;
  /**
   * `true` if the MCP is running against the public demo key (either
   * because nothing was configured, or because the user's own
   * LOG10X_API_KEY failed validation and we fell back). Tools should
   * treat this as a "you're in a demo sandbox" signal and prefer to
   * surface upgrade guidance over silent failures on write attempts.
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
 * Resolve the active credentials and load the env list from
 * `/api/v1/user`. Async because every path hits the Log10x API.
 *
 * Tries `LOG10X_API_KEY` first, then `~/.log10x/credentials` (written
 * by `log10x_signin`), then falls back to the public demo key.
 *
 * Returns demo-mode `Environments` (with `demoFallbackReason` set) on
 * any non-fatal failure of the user-supplied credential — never
 * throws on a typo'd key. Tools surface a loud banner when
 * `demoFallbackReason` is non-empty so the user is told their data is
 * demo, not their own.
 */
export async function loadEnvironments(): Promise<Environments> {
  const apiKey = process.env.LOG10X_API_KEY;

  // Path 1: explicit `LOG10X_API_KEY`.
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

  // Path 2: persistent credentials at ~/.log10x/credentials, written
  // by log10x_signin.
  let creds: Awaited<ReturnType<typeof readCredentials>>;
  try {
    creds = await readCredentials();
  } catch (e) {
    // Malformed file or permission error — distinct from "missing".
    // Fall back to demo with the file failure surfaced so the user
    // can fix it (`log10x_signout` clears the file, then sign in).
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
        `Run \`log10x_signin\` to refresh (\`mode: "github"\` for GitHub Device Flow, ` +
        `or \`mode: "api_key"\` to paste a key from console.log10x.com → Profile → API Settings), ` +
        `or \`log10x_signout\` to clear and use demo. See \`log10x_login_status\` for the full breakdown.`;
      return demoEnvs;
    }
  }

  // Path 3: nothing set — pure demo mode. Public demo key so the
  // user can play without signing up.
  return await loadFromApi(DEMO_API_KEY, /*isDemoMode=*/ true);
}

/**
 * Re-run `loadEnvironments()` from scratch and overwrite the contents
 * of an existing `Environments` object in place. Used by
 * `log10x_signin` and `log10x_signout` to swap credentials without
 * forcing the user to restart the MCP host.
 *
 * In-place mutation matters: every tool callback closes over a
 * reference to the same Environments object via `getEnvs()` in
 * `index.ts`. If we returned a fresh object, we'd have to chase
 * references through the entire codebase to swap them all.
 */
export async function reloadEnvironmentsInPlace(target: Environments): Promise<void> {
  const fresh = await loadEnvironments();
  // Clear the lastUsed pointer — it referenced an EnvConfig from the
  // old set, which is no longer in `target.byNickname`.
  target.lastUsed = undefined;
  target.all = fresh.all;
  target.byNickname = fresh.byNickname;
  target.default = fresh.default;
  target.profile = fresh.profile;
  target.isDemoMode = fresh.isDemoMode;
  target.demoFallbackReason = fresh.demoFallbackReason;
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
          `Bypass demo by signing in to your own account: run \`log10x_signin\` ` +
          `(\`mode: "github"\` for GitHub Device Flow, or \`mode: "api_key"\` to paste ` +
          `an existing key), or set \`LOG10X_API_KEY\` to a key from ` +
          `console.log10x.com → Profile → API Settings.`
      );
    }
    throw new EnvironmentValidationError(
      `LOG10X_API_KEY is set but env autodiscovery via GET /api/v1/user failed: ` +
        `${(e as Error).message}. ` +
        `Verify the key at console.log10x.com → Profile → API Settings, ` +
        `or run \`log10x_signin\` to mint a fresh one (\`mode: "github"\` for GitHub ` +
        `Device Flow, or \`mode: "api_key"\` to paste a key) — it auto-clears the bad ` +
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
