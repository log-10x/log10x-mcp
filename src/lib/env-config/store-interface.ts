/**
 * Abstract store for environment config documents.
 *
 * Implementations live alongside this file (k8s ConfigMap, AWS SSM parameter,
 * GCP Secret Manager, Azure App Configuration, local file). The resolver walks
 * a list of configured stores and picks the first one that reports
 * `isAvailable: true`. Stores never throw on transient unavailability — they
 * return `{ available: false, reason }` so the resolver can fall through to
 * the next candidate without aborting the whole MCP boot.
 *
 * Reads accept either an env_id or a nickname; implementations are responsible
 * for resolving both. Writes always carry the canonical document with both
 * fields populated.
 */

import type { EnvironmentConfig } from './types.js';

export type StoreKind = 'k8s' | 'aws_ssm' | 'gcp_sm' | 'azure_ac' | 'local';

export interface EnvConfigStore {
  readonly kind: StoreKind;

  /**
   * Cheap reachability check. Should NOT throw — return
   * `{ available: false, reason }` for missing creds, missing namespace,
   * missing region, etc., so the resolver can try the next store.
   */
  isAvailable(): Promise<{ available: boolean; reason: string }>;

  /**
   * Returns the config for the given env_id OR nickname, or `null` if not
   * found. Throws only for store-level errors (auth failure mid-read,
   * malformed payload that doesn't parse against the schema).
   */
  read(envIdOrNickname: string): Promise<EnvironmentConfig | null>;

  /**
   * Persists the full config document. Implementations are expected to write
   * atomically (e.g. SSM overwrite, ConfigMap replace) and to update
   * `updated_at` themselves if the caller didn't.
   */
  write(config: EnvironmentConfig): Promise<void>;

  /**
   * Lists every environment this store knows about. Used by
   * `log10x_discover_env` and the on-boarding flow.
   */
  list(): Promise<EnvironmentConfig[]>;

  /**
   * Hard delete by env_id. Implementations may refuse if the store is
   * read-only (return a thrown error rather than silently no-op).
   */
  delete(envId: string): Promise<void>;
}
