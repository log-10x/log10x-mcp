/**
 * recur-history-reader — reads the JSONL audit trail written by
 * `recurring-tick.ts` (appendHistory) and returns structured run records.
 *
 * The history file location is resolved in the same priority order that
 * recurring-tick.ts uses so the two stay in sync:
 *   1. LOG10X_RECUR_HISTORY_PATH env var (explicit override)
 *   2. /tmp/log10x-recur-history.jsonl (recurring-tick.ts default)
 *
 * One JSONL line per tick.  Each line is a JSON object whose shape mirrors
 * the summary object emitted by `printRunSummary` in `bin/tenx-recur.ts`
 * PLUS the history-entry shape written by `appendHistory` in
 * `recurring-tick.ts`.  The union of both is:
 *
 *   { ts, status, projected_savings_pct, delta_patterns, delta_pp, message,
 *     history_path? }
 *
 * `readHistorySince` is the primary consumer interface for the
 * `weekly-digest` mode of `commitment-report.ts`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

// ─── default history file path ───────────────────────────────────────────────

/**
 * Resolve the history-file path using the same override ladder as
 * `recurring-tick.ts`:
 *   LOG10X_RECUR_HISTORY_PATH → /tmp/log10x-recur-history.jsonl
 */
export function resolveHistoryPath(): string {
  return (
    process.env['LOG10X_RECUR_HISTORY_PATH'] ??
    pathJoin(tmpdir(), 'log10x-recur-history.jsonl')
  );
}

// ─── types ───────────────────────────────────────────────────────────────────

/**
 * One tick run as parsed from the JSONL audit trail.
 */
export interface RecurRun {
  /** ISO-8601 timestamp of when the tick ran. */
  ts: string;
  /** Epoch ms derived from `ts` for easier range comparisons. */
  ts_ms: number;
  /** Tick outcome. */
  status: 'no_change' | 'applied' | 'dry_run' | 'error';
  /** Projected savings percentage at tick time. */
  projected_savings_pct: number;
  /** Number of patterns whose action changed vs. prior state. */
  delta_patterns: number;
  /** Change in savings percentage points vs. prior state. */
  delta_pp: number;
  /** Human-readable message from the tick. */
  message: string;
  /** Path to the history file (set when status==='applied'). */
  history_path?: string;
}

// ─── parser ──────────────────────────────────────────────────────────────────

/**
 * Parse one JSONL line.  Returns undefined when the line is blank, a JSON
 * parse error, or missing mandatory fields.
 */
function parseLine(raw: string): RecurRun | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;

  const ts = typeof obj['ts'] === 'string' ? obj['ts'] : '';
  if (!ts) return undefined;

  const ts_ms = Date.parse(ts);
  if (isNaN(ts_ms)) return undefined;

  const status = obj['status'];
  if (
    status !== 'no_change' &&
    status !== 'applied' &&
    status !== 'dry_run' &&
    status !== 'error'
  ) {
    return undefined;
  }

  return {
    ts,
    ts_ms,
    status: status as RecurRun['status'],
    projected_savings_pct:
      typeof obj['projected_savings_pct'] === 'number'
        ? obj['projected_savings_pct']
        : 0,
    delta_patterns:
      typeof obj['delta_patterns'] === 'number' ? obj['delta_patterns'] : 0,
    delta_pp: typeof obj['delta_pp'] === 'number' ? obj['delta_pp'] : 0,
    message: typeof obj['message'] === 'string' ? obj['message'] : '',
    history_path:
      typeof obj['history_path'] === 'string' ? obj['history_path'] : undefined,
  };
}

// ─── reader ───────────────────────────────────────────────────────────────────

/**
 * Read all tick runs since `sinceMs` (epoch ms, inclusive) from the JSONL
 * audit trail.
 *
 * @param sinceMs   Epoch ms lower bound (inclusive).  Pass `0` to read all.
 * @param histPath  Override the file path (defaults to `resolveHistoryPath()`).
 * @returns         Parsed runs in chronological order (oldest first).
 */
export function readHistorySince(
  sinceMs: number,
  histPath?: string
): RecurRun[] {
  const filePath = histPath ?? resolveHistoryPath();
  if (!existsSync(filePath)) return [];

  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const runs: RecurRun[] = [];

  for (const line of lines) {
    const run = parseLine(line);
    if (!run) continue;
    if (run.ts_ms >= sinceMs) runs.push(run);
  }

  // Ensure chronological order (file should already be appended in order,
  // but guard against out-of-order lines from concurrent writes or manual edits).
  runs.sort((a, b) => a.ts_ms - b.ts_ms);
  return runs;
}

/**
 * Read the N most recent ticks regardless of age.
 *
 * @param limit   Maximum number of runs to return (newest first when
 *                `newestFirst=true`, oldest first otherwise).
 * @param histPath Override the file path.
 */
export function readRecentHistory(
  limit: number,
  histPath?: string
): RecurRun[] {
  const all = readHistorySince(0, histPath);
  return all.slice(-limit);
}
