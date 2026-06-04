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
import type { DiscoverySnapshot, WizardSession } from './types.js';

interface Entry {
  snapshot: DiscoverySnapshot;
  /** Optional wizard session — accumulated user answers across turns. */
  session?: WizardSession;
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
  // Also sweep the disk tier. Catches both snapshot files (`<id>.json`)
  // and their paired session files (`<id>.session.json`).
  try {
    const dir = diskDir();
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('disc-')) continue;
      if (!name.endsWith('.json') && !name.endsWith('.session.json')) continue;
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
    // Also try to load any wizard session that was persisted alongside.
    let session: WizardSession | undefined;
    try {
      const sp = join(diskDir(), `${id}.session.json`);
      const sraw = readFileSync(sp, 'utf8');
      session = JSON.parse(sraw) as WizardSession;
    } catch {
      // No session file is the common case for snapshots that never
      // entered the wizard flow.
    }
    store.set(id, { snapshot: snap, session, expiresAt: mtime + TTL_MS });
    return snap;
  } catch {
    return undefined;
  }
}

/**
 * Get the wizard session attached to a snapshot, or undefined if no
 * session has been started yet. The session shares the snapshot's TTL.
 */
export function getWizardSession(id: string): WizardSession | undefined {
  // Touch via getSnapshot to refresh the memory cache from disk if needed,
  // then read the session field from the entry.
  const snap = getSnapshot(id);
  if (!snap) return undefined;
  return store.get(id)?.session;
}

/**
 * Merge a partial answer into the wizard session for a snapshot. Creates
 * the session on first call. Returns the merged session, or undefined if
 * the snapshot is missing/expired (caller should re-run discovery).
 *
 * Merge semantics: shallow per-key. Keys whose value is `undefined` in
 * `partial` are SKIPPED (they do not clear the existing value) — the
 * wizard's `next_question` actions carry only the field being answered
 * this turn, with every other field implicitly absent; a naive spread
 * would wipe previously-collected answers and trap the wizard in a loop
 * re-asking Q1.
 */
export function updateWizardSession(
  snapshotId: string,
  partial: Partial<Omit<WizardSession, 'snapshotId' | 'updatedAt'>>
): WizardSession | undefined {
  const snap = getSnapshot(snapshotId);
  if (!snap) return undefined;
  const entry = store.get(snapshotId);
  if (!entry) return undefined;
  const definedPartial: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) definedPartial[k] = v;
  }
  const merged: WizardSession = {
    ...(entry.session ?? { snapshotId, updatedAt: new Date().toISOString() }),
    ...(definedPartial as Partial<WizardSession>),
    snapshotId,
    updatedAt: new Date().toISOString(),
  };
  entry.session = merged;
  // Persist alongside the snapshot on disk so a CLI shim invocation can
  // resume the session. Best-effort — disk failures don't break the
  // in-memory flow.
  try {
    const dir = diskDir();
    writeFileSync(join(dir, `${snapshotId}.session.json`), JSON.stringify(merged));
  } catch {
    // disk write failure is non-fatal
  }
  return merged;
}

/**
 * Return the most recent non-expired snapshot from the in-memory store,
 * or undefined when the store is empty or all entries have expired.
 *
 * Used by tools that can benefit from a cached discover_env result without
 * requiring the caller to thread a snapshot_id explicitly.
 *
 * @param maxAgeSeconds - upper bound on snapshot age; defaults to 1800 (30 min,
 *   matching TTL_MS). Callers that need fresher data can pass a smaller value.
 */
export function getMostRecentSnapshot(maxAgeSeconds = 1800): DiscoverySnapshot | undefined {
  const now = Date.now();
  const cutoff = now - maxAgeSeconds * 1000;
  let best: { snapshot: DiscoverySnapshot; expiresAt: number } | undefined;
  for (const entry of store.values()) {
    if (entry.expiresAt <= now) continue;
    // expiresAt = createdAt + TTL_MS, so createdAt = expiresAt - TTL_MS.
    const createdAt = entry.expiresAt - TTL_MS;
    if (createdAt < cutoff) continue;
    if (!best || entry.expiresAt > best.expiresAt) {
      best = entry;
    }
  }
  return best?.snapshot;
}

/** For tests. Does NOT wipe the disk tier — tests use process.env to redirect it. */
export function _clearSnapshotStore(): void {
  store.clear();
}
