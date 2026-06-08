/**
 * AWS SSM Parameter Store backend for env-config documents.
 *
 * Layout:
 *   /log10x/env-config/{env_id}   →  JSON-serialised EnvironmentConfig
 *
 * One parameter per environment. The id under the `/log10x/env-config/`
 * prefix is the canonical `env_id` (UUID); nickname lookups are resolved by
 * listing the prefix and matching the parsed document's `nickname` field.
 *
 * Parameter type is `String` today. Promoting to `SecureString` is a one-line
 * change once customers wire a KMS key — see the `kmsKeyId` option on
 * `PutParameter`. We avoid SecureString by default so callers without a
 * configured KMS key still get a working store.
 *
 * Availability is reported defensively:
 *   - if `@aws-sdk/client-ssm` is not installed at all we return
 *     `{ available: false, reason: ... }` with a clear hint, never throw.
 *     This lets the resolver fall through to the next store (k8s ConfigMap,
 *     local file) on a stripped-down install.
 *   - if no AWS region is resolvable (no AWS_REGION / AWS_DEFAULT_REGION and
 *     no constructor arg) we report unavailable rather than letting the SDK
 *     throw at first call.
 *   - if credentials don't resolve via the default provider chain we report
 *     unavailable; the resolver moves on.
 *
 * Throwing is reserved for "the store IS available, but this op failed" —
 * malformed JSON in a parameter value, a parameter not found mid-write, etc.
 */

import type { EnvConfigStore, StoreKind } from './store-interface.js';
import { environmentConfigSchema, type EnvironmentConfig } from './types.js';

/**
 * Constructor options. All optional — defaults read from AWS_REGION /
 * AWS_DEFAULT_REGION and the default credential provider chain.
 */
export interface AwsSsmStoreOptions {
  /** AWS region. Falls back to AWS_REGION / AWS_DEFAULT_REGION. */
  region?: string;
  /**
   * Optional KMS key id/arn/alias. When set we promote the parameter type
   * to `SecureString` on write so SSM encrypts at rest with the named key.
   * When unset we write plain `String` parameters.
   */
  kmsKeyId?: string;
  /**
   * Override the prefix. Defaults to `/log10x/env-config/`. Trailing slash
   * is normalised either way.
   */
  prefix?: string;
}

const DEFAULT_PREFIX = '/log10x/env-config/';

/** Build `/log10x/env-config/{id}` regardless of caller's slash habits. */
function paramName(prefix: string, envId: string): string {
  const normPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${normPrefix}${envId}`;
}

/** True iff the value looks like an `@aws-sdk/client-ssm` module load error. */
function isSdkMissing(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? '';
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' ||
    /Cannot find (?:module|package)\s+'@aws-sdk\/client-ssm'/.test(message);
}

export class AwsSsmStore implements EnvConfigStore {
  readonly kind: StoreKind = 'aws_ssm';

  private readonly region: string | undefined;
  private readonly kmsKeyId: string | undefined;
  private readonly prefix: string;

  // Lazily loaded so a missing SDK only matters at the first call, not at
  // module-load time (the resolver constructs stores eagerly to query
  // isAvailable on each).
  private sdkPromise: Promise<typeof import('@aws-sdk/client-ssm')> | null = null;
  private clientPromise: Promise<import('@aws-sdk/client-ssm').SSMClient> | null = null;

  constructor(opts: AwsSsmStoreOptions = {}) {
    this.region = opts.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    this.kmsKeyId = opts.kmsKeyId;
    this.prefix = opts.prefix || DEFAULT_PREFIX;
  }

  /** Lazy import wrapper; cached so we only pay the import cost once. */
  private loadSdk(): Promise<typeof import('@aws-sdk/client-ssm')> {
    if (!this.sdkPromise) {
      this.sdkPromise = import('@aws-sdk/client-ssm');
    }
    return this.sdkPromise;
  }

  /** Lazy client; one per store instance. */
  private async getClient(): Promise<import('@aws-sdk/client-ssm').SSMClient> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const sdk = await this.loadSdk();
        return new sdk.SSMClient({
          ...(this.region ? { region: this.region } : {}),
          maxAttempts: 3,
        });
      })();
    }
    return this.clientPromise;
  }

  /**
   * Soft reachability check. Never throws.
   *
   * Order of checks (cheapest first):
   *   1. SDK is importable
   *   2. region is resolvable
   *   3. credentials resolve via the default provider chain
   */
  async isAvailable(): Promise<{ available: boolean; reason: string }> {
    // 1. SDK present?
    try {
      await this.loadSdk();
    } catch (err) {
      if (isSdkMissing(err)) {
        return {
          available: false,
          reason:
            '@aws-sdk/client-ssm is not installed. Run `npm install @aws-sdk/client-ssm` ' +
            'or remove the aws_ssm store from the resolver chain.',
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, reason: `failed to load @aws-sdk/client-ssm: ${msg}` };
    }

    // 2. Region resolvable?
    if (!this.region) {
      return {
        available: false,
        reason: 'no AWS region resolved (set AWS_REGION, AWS_DEFAULT_REGION, or pass { region }).',
      };
    }

    // 3. Credentials resolvable via the default provider chain.
    try {
      const credModule = await import('@aws-sdk/credential-providers');
      const provider = credModule.fromNodeProviderChain();
      const creds = await Promise.race([
        provider(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('credential resolution timeout')), 1500),
        ),
      ]);
      if (!creds || typeof creds !== 'object' || !('accessKeyId' in creds)) {
        return { available: false, reason: 'AWS credentials did not resolve.' };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, reason: `AWS credential resolution failed: ${msg}` };
    }

    return { available: true, reason: `SSM reachable in ${this.region} under ${this.prefix}` };
  }

  /**
   * Resolve a single document by env_id or nickname. Tries direct GetParameter
   * first (cheap when caller passes env_id), then falls back to a list+match
   * scan for nicknames.
   */
  async read(envIdOrNickname: string): Promise<EnvironmentConfig | null> {
    const sdk = await this.loadSdk();
    const client = await this.getClient();

    // Fast path: treat the input as an env_id and try a direct fetch.
    const direct = await this.getParameter(sdk, client, paramName(this.prefix, envIdOrNickname));
    if (direct) {
      const parsed = parseConfig(direct, envIdOrNickname);
      // If the caller asked for an env_id, the document's env_id should match;
      // if it doesn't we still return it (the store said this was the doc at
      // that path) — the schema's env_id is authoritative for downstream.
      if (parsed.env_id === envIdOrNickname || parsed.nickname === envIdOrNickname) {
        return parsed;
      }
      return parsed;
    }

    // Fallback: list + match on nickname.
    const all = await this.list();
    for (const doc of all) {
      if (doc.env_id === envIdOrNickname || doc.nickname === envIdOrNickname) {
        return doc;
      }
    }
    return null;
  }

  async write(config: EnvironmentConfig): Promise<void> {
    const sdk = await this.loadSdk();
    const client = await this.getClient();

    // Stamp updated_at if the caller didn't, per store-interface contract.
    const stamped: EnvironmentConfig = {
      ...config,
      updated_at: config.updated_at || new Date().toISOString(),
    };

    const body = JSON.stringify(stamped);
    const useSecureString = Boolean(this.kmsKeyId);

    await client.send(
      new sdk.PutParameterCommand({
        Name: paramName(this.prefix, stamped.env_id),
        Value: body,
        Type: useSecureString ? 'SecureString' : 'String',
        Overwrite: true,
        ...(useSecureString ? { KeyId: this.kmsKeyId } : {}),
      }),
    );
  }

  async list(): Promise<EnvironmentConfig[]> {
    const sdk = await this.loadSdk();
    const client = await this.getClient();

    const results: EnvironmentConfig[] = [];
    const normPrefix = this.prefix.endsWith('/') ? this.prefix : `${this.prefix}/`;
    let nextToken: string | undefined = undefined;

    do {
      const resp: import('@aws-sdk/client-ssm').GetParametersByPathCommandOutput = await client.send(
        new sdk.GetParametersByPathCommand({
          Path: normPrefix,
          Recursive: true,
          WithDecryption: true,
          MaxResults: 10,
          ...(nextToken ? { NextToken: nextToken } : {}),
        }),
      );

      for (const p of resp.Parameters ?? []) {
        if (!p.Value) continue;
        const idFromName = (p.Name ?? '').slice(normPrefix.length);
        try {
          results.push(parseConfig(p.Value, idFromName || '<unknown>'));
        } catch (err) {
          // A single malformed parameter shouldn't poison the list — surface
          // via console.warn and skip. Resolver users see a partial list and
          // can investigate the offending env_id.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[aws_ssm] skipping malformed parameter ${p.Name}: ${msg}`);
        }
      }

      nextToken = resp.NextToken;
    } while (nextToken);

    return results;
  }

  async delete(envId: string): Promise<void> {
    const sdk = await this.loadSdk();
    const client = await this.getClient();
    try {
      await client.send(
        new sdk.DeleteParameterCommand({ Name: paramName(this.prefix, envId) }),
      );
    } catch (err) {
      // ParameterNotFound is treated as a no-op — delete is idempotent from the
      // caller's view, "the parameter is gone" is the same observable state
      // whether we just deleted it or it never existed.
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'ParameterNotFound') {
        return;
      }
      throw err;
    }
  }

  /**
   * Single GetParameter wrapped to return null on ParameterNotFound rather
   * than throwing. WithDecryption: true so SecureString upgrades work
   * transparently.
   */
  private async getParameter(
    sdk: typeof import('@aws-sdk/client-ssm'),
    client: import('@aws-sdk/client-ssm').SSMClient,
    name: string,
  ): Promise<string | null> {
    try {
      const resp = await client.send(
        new sdk.GetParameterCommand({ Name: name, WithDecryption: true }),
      );
      return resp.Parameter?.Value ?? null;
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'ParameterNotFound') {
        return null;
      }
      throw err;
    }
  }
}

/**
 * Parse + validate. Throws with the env_id context attached so list() warnings
 * and read() errors point the operator at the offending document.
 */
function parseConfig(raw: string, envIdHint: string): EnvironmentConfig {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`env-config "${envIdHint}" is not valid JSON: ${msg}`);
  }
  const parsed = environmentConfigSchema.safeParse(json);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .slice(0, 5)
      .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`env-config "${envIdHint}" failed schema validation: ${summary}`);
  }
  return parsed.data;
}
