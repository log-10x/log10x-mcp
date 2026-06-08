/**
 * Bridge between SaaS-side envs (envs.json / /api/v1/user — managed by
 * configure_env, signin_*) and on-prem env-config docs (k8s ConfigMap /
 * AWS SSM / GCP Secret Manager / Azure App Config / local file —
 * managed by env_register, offload_add, etc.).
 *
 * Background — arc v9 surfaced the same defect across 4 tools (doctor,
 * pattern_trend, pattern_examples, metric_overlay): a user who typed
 * the on-prem env-config nickname ("otel-demo") got "Unknown
 * environment" because resolveEnv only matches against the SaaS
 * envs.json nickname ("10x Demo"). Same env_id, two identity surfaces,
 * no bridge.
 *
 * This module fixes that by walking the on-prem stores at startup,
 * finding every env-config doc, and aliasing its nickname + env_id
 * into envs.byNickname pointing at the same SaaS EnvConfig (joined
 * via env_id). Also adds the SaaS env_id as an alias so users can
 * type a UUID at any prompt.
 *
 * Idempotent. Conflicts (two on-prem docs claiming the same alias for
 * different SaaS envs) are logged and skipped — first one wins.
 * Failures during on-prem read are NON-FATAL — the boot must succeed
 * for laptop / dev / no-cluster setups where every store reports
 * unavailable.
 */

import type { Environments } from './environments.js';
import type { StoreKind } from './env-config/store-interface.js';
import { buildDefaultStoreChain } from './env-config/stores.js';
import { log } from './log.js';

export interface AliasBridgeResult {
  /** Total aliases added to envs.byNickname across all paths. */
  aliases_added: number;
  /** Per-store breakdown — what was found, what was added, what was skipped. */
  per_store: Array<{
    store_kind: StoreKind;
    available: boolean;
    reason: string;
    docs_found: number;
    aliases_added: number;
    aliases_skipped_conflict: number;
  }>;
  /** SaaS-side env_ids added as aliases (UUID typing path). */
  saas_env_id_aliases: number;
}

/**
 * Walks the on-prem store chain and adds alias entries to
 * envs.byNickname so users can resolve an env by any of:
 *   - its SaaS nickname (already worked)
 *   - its SaaS env_id / UUID
 *   - any on-prem env-config nickname that joins to the same env_id
 *
 * Mutates envs in place. Returns a structured summary for diagnostics.
 *
 * Non-fatal: store failures are caught and reported in per_store, not
 * thrown. Boot continues even if every store is unavailable.
 */
export async function enrichEnvAliasesFromOnPrem(envs: Environments): Promise<AliasBridgeResult> {
  const result: AliasBridgeResult = {
    aliases_added: 0,
    per_store: [],
    saas_env_id_aliases: 0,
  };

  // ── 1. Alias each SaaS env by its env_id (UUID typing). Cheap, sync,
  //    always applies — no store traversal needed.
  for (const env of envs.all) {
    const envId = env.envId?.trim();
    if (!envId) continue;
    const key = envId.toLowerCase();
    if (!envs.byNickname.has(key)) {
      envs.byNickname.set(key, env);
      result.saas_env_id_aliases += 1;
      result.aliases_added += 1;
    }
  }

  // ── 2. Walk the on-prem store chain. Each store independently; one
  //    failing does not block the others. The local store is always
  //    last so a partial-cluster setup still picks up local docs.
  const stores = buildDefaultStoreChain();

  for (const store of stores) {
    const entry = {
      store_kind: store.kind,
      available: false,
      reason: '',
      docs_found: 0,
      aliases_added: 0,
      aliases_skipped_conflict: 0,
    };

    try {
      const avail = await store.isAvailable();
      entry.available = avail.available;
      entry.reason = avail.reason;
      if (!avail.available) {
        result.per_store.push(entry);
        continue;
      }
    } catch (e) {
      entry.reason = `isAvailable threw: ${(e as Error).message}`;
      result.per_store.push(entry);
      continue;
    }

    let docs;
    try {
      docs = await store.list();
    } catch (e) {
      entry.reason = `list() threw: ${(e as Error).message}`;
      result.per_store.push(entry);
      continue;
    }
    entry.docs_found = docs.length;

    for (const doc of docs) {
      const docEnvId = doc.env_id?.trim();
      if (!docEnvId) continue;

      // Find the SaaS env this on-prem doc joins to. Match by env_id —
      // the canonical join key. If no SaaS env has this env_id, the
      // on-prem doc is orphaned (registered without a backing SaaS
      // account); skip it so we don't alias to undefined.
      const saasMatch = envs.all.find((e) => e.envId?.trim() === docEnvId);
      if (!saasMatch) continue;

      // Add the on-prem nickname as an alias if it differs from the
      // SaaS nickname AND doesn't conflict with an existing entry
      // mapping to a different EnvConfig.
      const onPremNick = doc.nickname?.trim();
      if (!onPremNick) continue;
      const aliasKey = onPremNick.toLowerCase();

      const existing = envs.byNickname.get(aliasKey);
      if (existing && existing !== saasMatch) {
        entry.aliases_skipped_conflict += 1;
        log.warn(
          `env-alias-bridge: skipping alias "${onPremNick}" from ${store.kind} — already maps to env "${existing.nickname}", not "${saasMatch.nickname}"`,
        );
        continue;
      }
      if (existing === saasMatch) continue;

      envs.byNickname.set(aliasKey, saasMatch);
      entry.aliases_added += 1;
      result.aliases_added += 1;
    }

    result.per_store.push(entry);
  }

  log.info(
    `env-alias-bridge: added ${result.aliases_added} alias(es) ` +
      `(${result.saas_env_id_aliases} from SaaS env_ids, ` +
      `${result.aliases_added - result.saas_env_id_aliases} from on-prem docs across ${result.per_store.length} store(s))`,
  );

  return result;
}

