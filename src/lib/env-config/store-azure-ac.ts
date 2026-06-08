/**
 * Azure App Configuration store for environment config documents.
 *
 * On AKS the natural per-environment config home is Azure App Configuration:
 * it speaks hierarchical keys, supports both connection-string auth (for ops
 * out-of-cluster) and `DefaultAzureCredential` (managed identity / workload
 * identity in-cluster), and exposes a paged list API that lets us enumerate
 * every environment the store knows about without maintaining an external
 * index.
 *
 * Key shape: `log10x/env-config/${env_id}`. Forward-slashes are legal in
 * App Configuration keys and group naturally in the portal UI.
 *
 * Auth precedence (mirrors `siem/azure-monitor.ts`):
 *   1. `LOG10X_AZURE_APP_CONFIG_CONNECTION_STRING` — explicit conn string.
 *   2. `LOG10X_AZURE_APP_CONFIG_ENDPOINT` (or `AZURE_APP_CONFIG_ENDPOINT`) +
 *      `DefaultAzureCredential` — the ambient identity flow.
 *
 * Reads accept either an env_id or a nickname. We look up the env_id-keyed
 * row directly first; on miss we scan the list and match by nickname so the
 * caller never has to know which form they have.
 *
 * isAvailable() never throws — it returns `{ available: false, reason }` so
 * the resolver can fall through to the next store. Read/write/list/delete
 * surface their underlying RestErrors verbatim because at that point the
 * caller has already committed to this store and silent fallback would hide
 * IAM bugs.
 */

import type {
  AppConfigurationClient as AppConfigurationClientType,
  ConfigurationSetting,
} from '@azure/app-configuration';
import { environmentConfigSchema, type EnvironmentConfig } from './types.js';
import type { EnvConfigStore } from './store-interface.js';

const KEY_PREFIX = 'log10x/env-config/';

function keyFor(envId: string): string {
  return `${KEY_PREFIX}${envId}`;
}

interface AzureModule {
  AppConfigurationClient: new (...args: any[]) => AppConfigurationClientType;
}

interface IdentityModule {
  DefaultAzureCredential: new (...args: any[]) => unknown;
}

/**
 * Lazily import @azure/app-configuration so the store can be instantiated in
 * environments that don't have the package installed without crashing at
 * module-load time. `isAvailable()` is what converts an import failure into
 * a structured `{ available: false, reason }`.
 */
async function loadAzureModule(): Promise<AzureModule | null> {
  try {
    return (await import('@azure/app-configuration')) as unknown as AzureModule;
  } catch {
    return null;
  }
}

async function loadIdentityModule(): Promise<IdentityModule | null> {
  try {
    return (await import('@azure/identity')) as unknown as IdentityModule;
  } catch {
    return null;
  }
}

export interface AzureAppConfigStoreOptions {
  /**
   * Optional override for the connection string. Falls back to
   * `LOG10X_AZURE_APP_CONFIG_CONNECTION_STRING` when not supplied.
   */
  connectionString?: string;
  /**
   * Optional override for the endpoint URL when using
   * `DefaultAzureCredential`. Falls back to
   * `LOG10X_AZURE_APP_CONFIG_ENDPOINT` (and `AZURE_APP_CONFIG_ENDPOINT`)
   * when not supplied.
   */
  endpoint?: string;
}

export class AzureAppConfigStore implements EnvConfigStore {
  readonly kind = 'azure_ac' as const;

  private readonly connectionString?: string;
  private readonly endpoint?: string;
  private cachedClient: AppConfigurationClientType | null = null;

  constructor(opts: AzureAppConfigStoreOptions = {}) {
    this.connectionString =
      opts.connectionString ?? process.env.LOG10X_AZURE_APP_CONFIG_CONNECTION_STRING ?? undefined;
    this.endpoint =
      opts.endpoint ??
      process.env.LOG10X_AZURE_APP_CONFIG_ENDPOINT ??
      process.env.AZURE_APP_CONFIG_ENDPOINT ??
      undefined;
  }

  async isAvailable(): Promise<{ available: boolean; reason: string }> {
    const mod = await loadAzureModule();
    if (!mod) {
      return {
        available: false,
        reason: '@azure/app-configuration not importable (package not installed?)',
      };
    }
    if (this.connectionString) {
      return { available: true, reason: 'connection string configured' };
    }
    if (this.endpoint) {
      const identity = await loadIdentityModule();
      if (!identity) {
        return {
          available: false,
          reason: 'endpoint URL set but @azure/identity not importable for DefaultAzureCredential',
        };
      }
      return { available: true, reason: 'endpoint + DefaultAzureCredential configured' };
    }
    return {
      available: false,
      reason:
        'neither LOG10X_AZURE_APP_CONFIG_CONNECTION_STRING nor LOG10X_AZURE_APP_CONFIG_ENDPOINT is set',
    };
  }

  async read(envIdOrNickname: string): Promise<EnvironmentConfig | null> {
    const client = await this.getClient();

    // 1. Try the env_id keyed row directly.
    const direct = await this.tryGet(client, keyFor(envIdOrNickname));
    if (direct) {
      return direct;
    }

    // 2. Fall back to scanning by nickname. List is paged, so we iterate
    //    until we find a match or exhaust the prefix.
    for await (const setting of client.listConfigurationSettings({
      keyFilter: `${KEY_PREFIX}*`,
    })) {
      const parsed = this.parseSetting(setting);
      if (parsed && parsed.nickname === envIdOrNickname) {
        return parsed;
      }
    }

    return null;
  }

  async write(config: EnvironmentConfig): Promise<void> {
    const client = await this.getClient();
    const value = JSON.stringify(config);
    await client.setConfigurationSetting({
      key: keyFor(config.env_id),
      value,
      contentType: 'application/json',
    });
  }

  async list(): Promise<EnvironmentConfig[]> {
    const client = await this.getClient();
    const out: EnvironmentConfig[] = [];
    for await (const setting of client.listConfigurationSettings({
      keyFilter: `${KEY_PREFIX}*`,
    })) {
      const parsed = this.parseSetting(setting);
      if (parsed) {
        out.push(parsed);
      }
    }
    return out;
  }

  async delete(envId: string): Promise<void> {
    const client = await this.getClient();
    await client.deleteConfigurationSetting({ key: keyFor(envId) });
  }

  // --- internals -----------------------------------------------------------

  private async getClient(): Promise<AppConfigurationClientType> {
    if (this.cachedClient) {
      return this.cachedClient;
    }
    const mod = await loadAzureModule();
    if (!mod) {
      throw new Error(
        'AzureAppConfigStore: @azure/app-configuration is not installed; cannot instantiate client',
      );
    }
    if (this.connectionString) {
      this.cachedClient = new mod.AppConfigurationClient(this.connectionString);
      return this.cachedClient;
    }
    if (this.endpoint) {
      const identity = await loadIdentityModule();
      if (!identity) {
        throw new Error(
          'AzureAppConfigStore: endpoint URL configured but @azure/identity is not installed',
        );
      }
      this.cachedClient = new mod.AppConfigurationClient(
        this.endpoint,
        new identity.DefaultAzureCredential() as any,
      );
      return this.cachedClient;
    }
    throw new Error(
      'AzureAppConfigStore: no connection string or endpoint configured (set LOG10X_AZURE_APP_CONFIG_CONNECTION_STRING or LOG10X_AZURE_APP_CONFIG_ENDPOINT)',
    );
  }

  private async tryGet(
    client: AppConfigurationClientType,
    key: string,
  ): Promise<EnvironmentConfig | null> {
    try {
      const setting = await client.getConfigurationSetting({ key });
      return this.parseSetting(setting);
    } catch (err) {
      // 404 → not found; surface every other error so auth/IAM bugs aren't
      // swallowed.
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  private parseSetting(setting: ConfigurationSetting): EnvironmentConfig | null {
    if (!setting.value) {
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(setting.value);
    } catch (err) {
      throw new Error(
        `AzureAppConfigStore: value at "${setting.key}" is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const parsed = environmentConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `AzureAppConfigStore: value at "${setting.key}" does not satisfy environmentConfigSchema: ${parsed.error.issues
          .slice(0, 3)
          .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as { statusCode?: number; code?: string; name?: string };
  if (e.statusCode === 404) {
    return true;
  }
  // RestError surfaces a `code` of 'ResourceNotFound' / 'KeyNotFound' on
  // some service versions; treat them as not-found.
  if (e.code === 'ResourceNotFound' || e.code === 'KeyNotFound') {
    return true;
  }
  return false;
}
