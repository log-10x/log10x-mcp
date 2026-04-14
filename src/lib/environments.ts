/**
 * Multi-environment configuration.
 *
 * Supports single-env (LOG10X_API_KEY + LOG10X_ENV_ID) or multi-env
 * (LOG10X_ENVS JSON array with nicknames), matching the Slack bot pattern.
 *
 * Validation runs at startup with structured errors that name the
 * specific env var or JSON path that failed, so a misconfigured Claude
 * Desktop install fails fast at boot instead of crashing on first tool call.
 */

import { z } from 'zod';

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

const EnvEntrySchema = z.object({
  nickname: z.string().min(1, 'nickname is required and cannot be empty'),
  apiKey: z.string().min(1, 'apiKey is required and cannot be empty'),
  envId: z.string().min(1, 'envId is required and cannot be empty'),
});

const EnvsArraySchema = z.array(EnvEntrySchema).min(1, 'LOG10X_ENVS must contain at least one environment');

/**
 * Parses environment configuration from process.env.
 * Throws a structured EnvironmentValidationError on misconfiguration.
 */
export function loadEnvironments(): Environments {
  const envsJson = process.env.LOG10X_ENVS;

  let envs: EnvConfig[];

  if (envsJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(envsJson);
    } catch (e) {
      throw new EnvironmentValidationError(
        `LOG10X_ENVS is not valid JSON: ${(e as Error).message}. ` +
          `Expected a JSON array like '[{"nickname":"prod","apiKey":"...","envId":"..."}]'.`
      );
    }
    const result = EnvsArraySchema.safeParse(parsed);
    if (!result.success) {
      throw new EnvironmentValidationError(
        `LOG10X_ENVS failed validation:\n` +
          result.error.issues.map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`).join('\n')
      );
    }
    envs = result.data;
  } else {
    const apiKey = process.env.LOG10X_API_KEY;
    const envId = process.env.LOG10X_ENV_ID;
    if (!apiKey || !envId) {
      throw new EnvironmentValidationError(
        'Set LOG10X_API_KEY + LOG10X_ENV_ID for single-environment mode, ' +
          'or LOG10X_ENVS for multi-environment mode. Get credentials from console.log10x.com → Profile → API Settings.'
      );
    }
    envs = [{ nickname: 'default', apiKey, envId }];
  }

  const byNickname = new Map<string, EnvConfig>();
  for (const env of envs) {
    const key = env.nickname.toLowerCase();
    if (byNickname.has(key)) {
      throw new EnvironmentValidationError(
        `Duplicate environment nickname "${env.nickname}" in LOG10X_ENVS. Each nickname must be unique.`
      );
    }
    byNickname.set(key, env);
  }

  return { all: envs, byNickname, default: envs[0] };
}

export class EnvironmentValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'EnvironmentValidationError';
  }
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
