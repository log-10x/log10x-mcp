/**
 * In-memory snapshot store for the discover_env tool.
 *
 * Same pattern as the POC-from-SIEM store: discovery is expensive
 * (kubectl+aws round-trips), so we return a snapshot_id the advise
 * tools can dereference without re-probing. Snapshots live 30 minutes
 * and then age out. If the user wants fresher data, they re-run
 * `log10x_discover_env`.
 */

import { randomUUID } from 'node:crypto';
import type { DiscoverySnapshot } from './types.js';

interface Entry {
  snapshot: DiscoverySnapshot;
  expiresAt: number;
}

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 32;
const store = new Map<string, Entry>();

function evictExpired(now: number): void {
  for (const [id, entry] of store.entries()) {
    if (entry.expiresAt <= now) store.delete(id);
  }
  if (store.size > MAX_ENTRIES) {
    // Evict oldest by insertion order (Map preserves it).
    const keys = Array.from(store.keys());
    for (let i = 0; i < keys.length - MAX_ENTRIES; i++) store.delete(keys[i]);
  }
}

/** Generate a fresh snapshot id. Exported for the probe orchestrator. */
export function newSnapshotId(): string {
  return `disc-${randomUUID()}`;
}

/** Put a finished snapshot in the store. Returns the id it was stored under. */
export function putSnapshot(snapshot: DiscoverySnapshot): string {
  const now = Date.now();
  evictExpired(now);
  store.set(snapshot.snapshotId, {
    snapshot,
    expiresAt: now + TTL_MS,
  });
  return snapshot.snapshotId;
}

/** Retrieve a snapshot. Returns undefined if missing or expired. */
export function getSnapshot(id: string): DiscoverySnapshot | undefined {
  const now = Date.now();
  const entry = store.get(id);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    store.delete(id);
    return undefined;
  }
  return entry.snapshot;
}

/** For tests. Not exported publicly beyond the discovery module. */
export function _clearSnapshotStore(): void {
  store.clear();
}
