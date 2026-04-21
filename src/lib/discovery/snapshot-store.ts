/**
 * Snapshot store with in-memory + on-disk tiers.
 *
 * Rationale: an MCP server runs as a long-lived process, so in-memory
 * is enough for normal use. But during dogfooding + CLI shim usage,
 * each invocation is a new process and needs to read snapshots written
 * by a prior invocation. The disk tier handles that case.
 *
 * Disk path: `$LOG10X_ADVISOR_STATE_DIR` or `$TMPDIR/log10x-advisor-snapshots`.
 * Files are `disc-<uuid>.json`. Snapshots older than the TTL are
 * removed on every put.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoverySnapshot } from './types.js';

interface Entry {
  snapshot: DiscoverySnapshot;
  expiresAt: number;
}

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 32;
const store = new Map<string, Entry>();

function diskDir(): string {
  const dir = process.env.LOG10X_ADVISOR_STATE_DIR ?? join(tmpdir(), 'log10x-advisor-snapshots');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore — if we can't create the dir, disk tier just becomes a no-op
  }
  return dir;
}

function evictExpired(now: number): void {
  for (const [id, entry] of store.entries()) {
    if (entry.expiresAt <= now) store.delete(id);
  }
  if (store.size > MAX_ENTRIES) {
    const keys = Array.from(store.keys());
    for (let i = 0; i < keys.length - MAX_ENTRIES; i++) store.delete(keys[i]);
  }
  // Also sweep the disk tier.
  try {
    const dir = diskDir();
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('disc-') || !name.endsWith('.json')) continue;
      const p = join(dir, name);
      try {
        const mtime = statSync(p).mtimeMs;
        if (now - mtime > TTL_MS) unlinkSync(p);
      } catch {
        // ignore per-file errors
      }
    }
  } catch {
    // ignore disk errors entirely — disk tier is best-effort
  }
}

/** Generate a fresh snapshot id. Exported for the probe orchestrator. */
export function newSnapshotId(): string {
  return `disc-${randomUUID()}`;
}

/** Put a finished snapshot in memory AND on disk. */
export function putSnapshot(snapshot: DiscoverySnapshot): string {
  const now = Date.now();
  evictExpired(now);
  store.set(snapshot.snapshotId, {
    snapshot,
    expiresAt: now + TTL_MS,
  });
  try {
    const dir = diskDir();
    writeFileSync(join(dir, `${snapshot.snapshotId}.json`), JSON.stringify(snapshot));
  } catch {
    // disk write failure is non-fatal
  }
  return snapshot.snapshotId;
}

/** Retrieve a snapshot, preferring memory. Falls through to disk on miss. */
export function getSnapshot(id: string): DiscoverySnapshot | undefined {
  const now = Date.now();
  const entry = store.get(id);
  if (entry) {
    if (entry.expiresAt <= now) {
      store.delete(id);
    } else {
      return entry.snapshot;
    }
  }
  // Disk fallback.
  try {
    const p = join(diskDir(), `${id}.json`);
    const mtime = statSync(p).mtimeMs;
    if (now - mtime > TTL_MS) {
      unlinkSync(p);
      return undefined;
    }
    const raw = readFileSync(p, 'utf8');
    const snap = JSON.parse(raw) as DiscoverySnapshot;
    store.set(id, { snapshot: snap, expiresAt: mtime + TTL_MS });
    return snap;
  } catch {
    return undefined;
  }
}

/** For tests. Does NOT wipe the disk tier — tests use process.env to redirect it. */
export function _clearSnapshotStore(): void {
  store.clear();
}
