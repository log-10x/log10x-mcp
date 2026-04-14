/**
 * In-memory LRU cache of recent investigations.
 *
 * log10x_investigate writes a record per call; log10x_investigation_get
 * reads by id. The cache lets follow-up turns reference a prior report
 * without re-running the correlation, and lets the model cross-reference
 * pattern lists across investigations in the same session.
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
const entries = new Map<string, InvestigationRecord>();

export function recordInvestigation(rec: InvestigationRecord): void {
  // LRU: delete + re-insert to move to end.
  if (entries.has(rec.investigationId)) entries.delete(rec.investigationId);
  entries.set(rec.investigationId, rec);
  while (entries.size > MAX_ENTRIES) {
    const firstKey = entries.keys().next().value;
    if (firstKey) entries.delete(firstKey);
  }
}

export function getInvestigation(investigationId: string): InvestigationRecord | undefined {
  return entries.get(investigationId);
}

export function listInvestigations(limit = 10): InvestigationRecord[] {
  return Array.from(entries.values()).slice(-limit).reverse();
}
