/**
 * Persistent gap-tracking for the anti-hallucination campaign.
 *
 * Gaps are recorded to `eval/gaps/gaps.json` as a JSON array. The file
 * is the canonical persistent state; survives compaction. Loaded at
 * campaign start, appended on every hero run that produces a failure.
 *
 * Gap lifecycle:
 *   open → in_progress → fixed (with fix_commit + fix_verified_run_ts)
 *
 * `pickNextOpenGap()` is deterministic: oldest open gap first. Used by
 * the iteration loop in bin/run-campaign.mjs to drive the fix-and-rerun
 * cycle.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GapRecord } from './types.js';

export function loadGaps(path: string): GapRecord[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`gaps file at ${path} is not a JSON array`);
    }
    return parsed as GapRecord[];
  } catch (e) {
    throw new Error(`gaps file at ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

export function saveGaps(path: string, gaps: GapRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(gaps, null, 2) + '\n');
}

/**
 * Append a gap; do NOT dedup against existing records — the same
 * question can produce different gaps over multiple runs (e.g., first
 * run fails on drift, the fix introduces a chain_miss). Each gap is a
 * point-in-time observation.
 */
export function appendGap(path: string, gap: GapRecord): GapRecord[] {
  const gaps = loadGaps(path);
  gaps.push(gap);
  saveGaps(path, gaps);
  return gaps;
}

/**
 * Mark all open gaps for a question_id as fixed. Used after a fix
 * commit + a re-run that passes — the human (or script) signs off
 * with a commit sha and the verified run timestamp.
 */
export function markFixed(
  path: string,
  question_id: string,
  fix_commit: string,
  fix_verified_run_ts: string,
  note?: string
): GapRecord[] {
  const gaps = loadGaps(path);
  for (const g of gaps) {
    if (g.question_id === question_id && g.fix_status === 'open') {
      g.fix_status = 'fixed';
      g.fix_commit = fix_commit;
      g.fix_verified_run_ts = fix_verified_run_ts;
      if (note) g.notes.push(`fixed: ${note}`);
    }
  }
  saveGaps(path, gaps);
  return gaps;
}

/**
 * Oldest open gap first — used by the iteration loop. Returns null
 * when no open gaps remain (campaign-complete signal).
 */
export function pickNextOpenGap(gaps: GapRecord[]): GapRecord | null {
  const open = gaps.filter((g) => g.fix_status === 'open');
  if (open.length === 0) return null;
  // Stable sort by run_timestamp ascending.
  open.sort((a, b) => a.run_timestamp.localeCompare(b.run_timestamp));
  return open[0];
}

/**
 * Quick stats for the campaign summary — open vs fixed vs total.
 */
export function gapStats(gaps: GapRecord[]): {
  total: number;
  open: number;
  in_progress: number;
  fixed: number;
  wontfix: number;
  per_question: Record<string, { open: number; fixed: number }>;
} {
  const stats = {
    total: gaps.length,
    open: 0,
    in_progress: 0,
    fixed: 0,
    wontfix: 0,
    per_question: {} as Record<string, { open: number; fixed: number }>,
  };
  for (const g of gaps) {
    stats[g.fix_status]++;
    if (!stats.per_question[g.question_id]) {
      stats.per_question[g.question_id] = { open: 0, fixed: 0 };
    }
    if (g.fix_status === 'open' || g.fix_status === 'in_progress') {
      stats.per_question[g.question_id].open++;
    } else if (g.fix_status === 'fixed') {
      stats.per_question[g.question_id].fixed++;
    }
  }
  return stats;
}
