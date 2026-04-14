/**
 * In-memory LRU + TTL cache of recent investigations.
 *
 * log10x_investigate writes a record per call; log10x_investigation_get
 * reads by id. The cache lets follow-up turns reference a prior report
 * without re-running the correlation, and lets the model cross-reference
 * pattern lists across investigations in the same session.
 *
 * Capped at 50 entries (LRU eviction) and 30 minutes per entry (TTL).
 * Long-running Claude Desktop sessions used to accumulate multi-hour-old
 * investigations forever; the TTL now expires them so a model citing
 * "investigation abc123 from earlier" gets a clean "expired" response
 * rather than stale data.
 *
 * Not persistent — state dies with the process. That's fine: MCP
 * conversations are per-process and this is session-local memory.
 */

export interface InvestigationRecord {
  investigationId: string;
  createdAt: number; // ms since epoch
  startingPoint: string;
  environment: string;
  reporterTier: string;
  shape: 'acute' | 'drift' | 'flat' | 'environment' | 'unresolved';
  /** The full markdown report returned to the caller. */
  report: string;
  /** Flattened list of pattern identities touched by this investigation. */
  patternsReferenced: string[];
}

const MAX_ENTRIES = 50;
/** TTL: 30 minutes. Override via LOG10X_INVESTIGATION_TTL_MS for ops/tests. */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function ttlMs(): number {
  const raw = process.env.LOG10X_INVESTIGATION_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

const entries = new Map<string, InvestigationRecord>();

export function recordInvestigation(rec: InvestigationRecord): void {
  evictExpired();
  // LRU: delete + re-insert to move to end.
  if (entries.has(rec.investigationId)) entries.delete(rec.investigationId);
  entries.set(rec.investigationId, rec);
  while (entries.size > MAX_ENTRIES) {
    const firstKey = entries.keys().next().value;
    if (firstKey) entries.delete(firstKey);
  }
}

export function getInvestigation(investigationId: string): InvestigationRecord | undefined {
  evictExpired();
  return entries.get(investigationId);
}

export function listInvestigations(limit = 10): InvestigationRecord[] {
  evictExpired();
  return Array.from(entries.values()).slice(-limit).reverse();
}

/** Drop any entries older than the TTL. Called lazily on every read/write. */
function evictExpired(): void {
  const cutoff = Date.now() - ttlMs();
  for (const [id, rec] of entries) {
    if (rec.createdAt < cutoff) entries.delete(id);
  }
}

/** Clear the cache — exposed for tests. */
export function clearInvestigationsForTest(): void {
  entries.clear();
}
