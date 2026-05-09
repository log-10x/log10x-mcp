/**
 * Eval-env resolver. Sets up credentials and endpoints for either the
 * log10x demo OTel env, a customer prod env (via ~/.log10x/credentials),
 * or a CI-secrets-based env.
 *
 * All harness components read env via this single resolver — never via
 * direct process.env access for log10x-specific values.
 */

import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface EvalEnv {
  mode: 'demo' | 'customer' | 'ci';
  envId: string;
  apiKey: string;
  apiBase: string;
  retrieverUrl?: string;
  region: string;
  notes: string[];
}

/**
 * Resolution order:
 *   LOG10X_EVAL_ENV=demo (default) → hardcoded otel-demo creds
 *   LOG10X_EVAL_ENV=customer → ~/.log10x/credentials, falls back to LOG10X_API_KEY
 *   LOG10X_EVAL_ENV=ci → LOG10X_API_KEY env var only; aborts if missing
 */
export function loadEvalEnv(): EvalEnv {
  const mode = (process.env.LOG10X_EVAL_ENV || 'demo') as EvalEnv['mode'];
  const notes: string[] = [];

  if (mode === 'demo') {
    return {
      mode,
      envId: '6aa99191-f827-4579-a96a-c0ebdfe73884',
      apiKey: 'd02ad247-1e32-49ee-918d-93467ba8b134',
      apiBase: process.env.LOG10X_API_BASE || 'https://prometheus.log10x.com',
      retrieverUrl:
        process.env.LOG10X_RETRIEVER_URL ||
        'http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com/retriever/query',
      region: 'us-east-1',
      notes: ['demo env: hardcoded creds, public gateway, demo retriever NLB'],
    };
  }

  if (mode === 'customer') {
    const credPath = join(homedir(), '.log10x', 'credentials');
    if (existsSync(credPath)) {
      try {
        const raw = JSON.parse(readFileSync(credPath, 'utf8'));
        const envEntry = raw.envs?.[0] || raw;
        return {
          mode,
          envId: envEntry.envId || envEntry.env_id || '',
          apiKey: envEntry.apiKey || envEntry.api_key || '',
          apiBase: envEntry.apiBase || process.env.LOG10X_API_BASE || 'https://prometheus.log10x.com',
          retrieverUrl: envEntry.retrieverUrl || process.env.LOG10X_RETRIEVER_URL,
          region: envEntry.region || process.env.AWS_REGION || 'us-east-1',
          notes: [`customer env: loaded from ${credPath}`],
        };
      } catch (e) {
        notes.push(`failed to read ${credPath}: ${(e as Error).message}`);
      }
    }
    if (process.env.LOG10X_API_KEY) {
      return {
        mode,
        envId: process.env.LOG10X_ENV_ID || '',
        apiKey: process.env.LOG10X_API_KEY,
        apiBase: process.env.LOG10X_API_BASE || 'https://prometheus.log10x.com',
        retrieverUrl: process.env.LOG10X_RETRIEVER_URL,
        region: process.env.AWS_REGION || 'us-east-1',
        notes: [...notes, 'customer env: from LOG10X_API_KEY env var'],
      };
    }
    throw new Error(
      `LOG10X_EVAL_ENV=customer requires either ~/.log10x/credentials or LOG10X_API_KEY env var. ` +
        notes.join('; ')
    );
  }

  if (mode === 'ci') {
    if (!process.env.LOG10X_API_KEY) {
      throw new Error('LOG10X_EVAL_ENV=ci requires LOG10X_API_KEY env var.');
    }
    return {
      mode,
      envId: process.env.LOG10X_ENV_ID || '',
      apiKey: process.env.LOG10X_API_KEY,
      apiBase: process.env.LOG10X_API_BASE || 'https://prometheus.log10x.com',
      retrieverUrl: process.env.LOG10X_RETRIEVER_URL,
      region: process.env.AWS_REGION || 'us-east-1',
      notes: ['ci env: from LOG10X_API_KEY env var'],
    };
  }

  throw new Error(`Unknown LOG10X_EVAL_ENV=${mode}; expected demo|customer|ci`);
}

/**
 * Apply the env's credentials to process.env so the MCP server (which
 * reads process.env) sees them. Idempotent.
 */
export function applyEvalEnvToProcess(env: EvalEnv): void {
  if (!process.env.LOG10X_API_KEY) {
    process.env.LOG10X_API_KEY = env.apiKey;
  }
  if (!process.env.LOG10X_API_BASE) {
    process.env.LOG10X_API_BASE = env.apiBase;
  }
  if (env.retrieverUrl && !process.env.__SAVE_LOG10X_RETRIEVER_URL__) {
    // The MCP retriever-api uses the __SAVE_*__ prefixed env vars per its
    // own conventions (see log10x-mcp/src/lib/retriever-api.ts:isRetrieverConfigured).
    process.env.__SAVE_LOG10X_RETRIEVER_URL__ = env.retrieverUrl;
  }
  if (env.envId && !process.env.LOG10X_ENV_ID) {
    process.env.LOG10X_ENV_ID = env.envId;
  }
}

/**
 * Substitute {{env.envId}} / {{env.apiKey}} / {{env.region}} in fixture
 * args. Used by tool_arg_defaults so a fixture written against demo
 * automatically retargets when LOG10X_EVAL_ENV=customer.
 */
export function interpolateEnvVars(value: unknown, env: EvalEnv): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/\{\{env\.envId\}\}/g, env.envId)
      .replace(/\{\{env\.apiKey\}\}/g, env.apiKey)
      .replace(/\{\{env\.region\}\}/g, env.region);
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnvVars(v, env));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateEnvVars(v, env);
    }
    return out;
  }
  return value;
}
