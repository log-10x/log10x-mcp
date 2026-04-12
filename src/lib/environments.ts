/**
 * Multi-environment configuration.
 *
 * Supports single-env (LOG10X_API_KEY + LOG10X_ENV_ID) or multi-env
 * (LOG10X_ENVS JSON array with nicknames), matching the Slack bot pattern.
 */

export interface EnvConfig {
  nickname: string;
  apiKey: string;
  envId: string;
}

/** Parsed environment list + default. */
export interface Environments {
  all: EnvConfig[];
  byNickname: Map<string, EnvConfig>;
  default: EnvConfig;
}

/**
 * Parses environment configuration from process.env.
 * Throws if no environments are configured.
 */
export function loadEnvironments(): Environments {
  const envsJson = process.env.LOG10X_ENVS;

  let envs: EnvConfig[];

  if (envsJson) {
    const parsed = JSON.parse(envsJson);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('LOG10X_ENVS must be a non-empty JSON array');
    }
    envs = parsed.map((e: Record<string, string>) => {
      if (!e.nickname || !e.apiKey || !e.envId) {
        throw new Error(`Each env entry requires nickname, apiKey, envId. Got: ${JSON.stringify(e)}`);
      }
      return { nickname: e.nickname, apiKey: e.apiKey, envId: e.envId };
    });
  } else {
    const apiKey = process.env.LOG10X_API_KEY;
    const envId = process.env.LOG10X_ENV_ID;
    if (!apiKey || !envId) {
      throw new Error('Set LOG10X_API_KEY + LOG10X_ENV_ID, or LOG10X_ENVS for multi-env');
    }
    envs = [{ nickname: 'default', apiKey, envId }];
  }

  const byNickname = new Map<string, EnvConfig>();
  for (const env of envs) {
    byNickname.set(env.nickname.toLowerCase(), env);
  }

  return { all: envs, byNickname, default: envs[0] };
}

/** Resolves an environment by nickname, or returns the default. */
export function resolveEnv(envs: Environments, nickname?: string): EnvConfig {
  if (!nickname) return envs.default;
  const env = envs.byNickname.get(nickname.toLowerCase());
  if (!env) {
    const available = envs.all.map(e => e.nickname).join(', ');
    throw new Error(`Unknown environment "${nickname}". Available: ${available}`);
  }
  return env;
}
