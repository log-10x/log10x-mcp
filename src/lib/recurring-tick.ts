/**
 * Recurring tick runner — one deterministic execution of the cost-reduction
 * policy loop.
 *
 * Called by `bin/tenx-recur.ts` (CLI) once per invocation.
 *
 * Five-step flow:
 *   1. Load policy (already parsed by caller and passed in).
 *   2. For each scoped service, query Prometheus for top patterns over the
 *      policy lookback window.
 *   3. Rank patterns by bytes; walk top-N applying severity + threshold rules.
 *   4. Compute delta vs. current applied state (read existing CSVs / action-intent).
 *   5a. If delta < min_delta_pp → exit 0 with "no change needed".
 *   5b. Else write mute/compact/action-intent files and commit via gh CLI or
 *       direct git push.
 *
 * The runner NEVER directly imports heavy MCP tool modules — it only uses the
 * lower-level libs (cost.ts, compact-csv-writer.ts, mute-csv-writer.ts,
 * action-intent-writer.ts) so it can run as a standalone CLI binary.
 *
 * Prometheus queries go through the existing `customer-metrics.ts` adapter
 * (LOG10X_CUSTOMER_METRICS_URL / LOG10X_CUSTOMER_METRICS_TYPE / …) which is
 * what `log10x_top_patterns` also uses under the hood.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

import type { Policy } from './policy-loader.js';
import { emitCompactRows, type CompactCsvRow } from './compact-csv-writer.js';
import { emitMuteRows, type MuteCsvRow } from './mute-csv-writer.js';
import {
  writeActionIntent,
  buildActionIntentEntries,
} from './action-intent-writer.js';
import { parseActionIntent } from './action-intent-parser.js';
import { parseCompactCsv } from './compact-csv-parser.js';
import { parseCapCsv } from './cap-csv-parser.js';
import type { Action } from './cost.js';

const execFileP = promisify(execFile);

// ─── public types ──────────────────────────────────────────────────────────

export interface TickOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

export type TickStatus =
  | 'no_change'    // delta < min_delta_pp — no CSV written
  | 'applied'      // new CSVs committed to config plane
  | 'dry_run'      // would have applied but --dry-run was set
  | 'error';       // fatal; message is set

export interface PatternDecision {
  pattern_hash: string;
  service: string;
  severity: string;
  bytes: number;
  share_pct: number;
  action: Action;
  reason: string;
}

export interface TickResult {
  status: TickStatus;
  message: string;
  /** Cumulative projected savings as a % of total observed bytes. */
  projected_savings_pct: number;
  /** All per-pattern decisions the tick made (including 'pass'). */
  applied_changes: PatternDecision[];
  /** How many patterns changed vs. the prior state. */
  delta_patterns: number;
  /** Delta in savings percentage points vs. prior state. */
  delta_pp: number;
  /** Path to the appended run-history JSONL line (when not dry-run). */
  history_path?: string;
}

// ─── Prometheus row shape returned by a bytesPerPattern query ──────────────

interface PromRow {
  metric: Record<string, string>;
  value: [number, string];
}

// ─── constants ─────────────────────────────────────────────────────────────

const HISTORY_FILE = pathJoin(tmpdir(), 'log10x-recur-history.jsonl');

// Default threshold: patterns over this byte count per lookback window are
// eligible for cost reduction when severity_rules says 'auto'.
// 50 MB over the window is a reasonable default.  Policy can override via
// threshold_bytes (reserved field — not yet in schema v1.0 but forward-safe).
const DEFAULT_THRESHOLD_BYTES = 50 * 1024 * 1024;

// ─── Prometheus query ───────────────────────────────────────────────────────

async function queryTopPatternsFromPrometheus(
  envId: string,
  lookback: string,
  serviceFilter: string | undefined,
  limit: number,
  verbose: boolean
): Promise<PromRow[]> {
  // Resolve the metrics backend exactly as the MCP tools do.
  const { loadBackendFromEnv } = await import('./customer-metrics.js');
  const backend = await loadBackendFromEnv();
  if (!backend) {
    throw new PromUnreachableError(
      'Prometheus backend not configured. Set LOG10X_CUSTOMER_METRICS_URL (or LOG10X_API_KEY + LOG10X_ENV_ID for hosted log10x).'
    );
  }

  // Build the PromQL query.  We intentionally inline a simple variant of the
  // pql.topPatternsFull builder to avoid dragging in the full top-patterns
  // tool stack.
  const envLabel = `tenx_env="${envId}"`;
  const svcLabel = serviceFilter ? `,tenx_user_service="${serviceFilter}"` : '';
  const query =
    `topk(${limit}, sum by (message_pattern, tenx_user_service, severity_level) ` +
    `(increase(all_events_summaryBytes_total{${envLabel}${svcLabel}}[${lookback}])))`;

  if (verbose) {
    process.stderr.write(`[tenx-recur] PromQL: ${query}\n`);
  }

  let resp;
  try {
    resp = await backend.queryInstant(query);
  } catch (err) {
    throw new PromUnreachableError(`Prometheus query failed: ${String(err)}`);
  }

  if (resp.status !== 'success') {
    throw new PromUnreachableError(
      `Prometheus returned status=${resp.status}`
    );
  }

  return (resp.data?.result ?? []) as PromRow[];
}

export class PromUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromUnreachableError';
  }
}

// ─── current applied state ─────────────────────────────────────────────────

/**
 * Read the current applied action-intent from the local gitops clone.
 * Returns an empty set when no file exists yet.
 */
function readCurrentActionIntent(
  repoPath: string
): Map<string, Action> {
  const intentPath = pathJoin(repoPath, 'data', 'action-intent.json');
  if (!existsSync(intentPath)) return new Map();
  try {
    const content = readFileSync(intentPath, 'utf8');
    const parsed = parseActionIntent(content);
    return parsed.by_pattern;
  } catch {
    return new Map();
  }
}

/**
 * Derive the current realised savings percentage from the existing compact
 * and mute CSVs.  We count patterns that have encode=true or sample_rate<1
 * and treat them as "reduced".  This is a rough proxy — good enough for
 * the delta gate.
 *
 * Returns a value 0-100.
 */
function readCurrentSavingsPct(
  repoPath: string,
  totalBytes: number
): number {
  if (totalBytes <= 0) return 0;

  let savedBytes = 0;

  // Compact CSV
  const compactPath = pathJoin(
    repoPath,
    'pipelines',
    'run',
    'receive',
    'compact',
    'compact-cap.csv'
  );
  if (existsSync(compactPath)) {
    const text = readFileSync(compactPath, 'utf8');
    const parsed = parseCompactCsv(text);
    // We don't know per-pattern bytes from the CSV alone — use the count
    // as a proxy scaled against totalBytes.  The delta gate only needs
    // to be directionally correct.
    savedBytes += parsed.rows.filter((r) => r.encode).length * (totalBytes / 1000);
  }

  // Mute / rate CSV
  const mutePath = pathJoin(
    repoPath,
    'pipelines',
    'run',
    'receive',
    'rate',
    'caps.csv'
  );
  if (existsSync(mutePath)) {
    const text = readFileSync(mutePath, 'utf8');
    const parsed = parseCapCsv(text);
    // Count field-set rows that have bytes_cap near zero as dropped.
    savedBytes += parsed.rows.filter((r) => !r.isContainerDefault && r.bytes_cap < 1024)
      .length * (totalBytes / 1000);
  }

  return Math.min(100, (savedBytes / totalBytes) * 100);
}

// ─── per-pattern decision engine ──────────────────────────────────────────

/**
 * Determine the action for one pattern given the policy rules.
 *
 * Decision tree:
 *   1. Service is in exceptions → 'pass' (skip entirely)
 *   2. Severity rule is 'keep'  → 'pass' (floor: never reduce)
 *   3. Severity rule specifies a concrete action → use it
 *   4. Severity rule is 'auto' or unset → look at bytes vs threshold
 *      - below threshold → 'pass'
 *      - at or above threshold → choose based on bytes magnitude:
 *          very high (>= 500 MB)  → 'drop'
 *          high      (>= 50 MB)   → 'sample'
 *          moderate  (>= 5 MB)    → 'compact'
 *          low                    → 'pass'
 */
function decideAction(
  service: string,
  severity: string,
  bytes: number,
  policy: Policy
): { action: Action; reason: string } {
  if (policy.exceptions.includes(service)) {
    return { action: 'pass', reason: 'service is in exceptions list' };
  }

  const sevKey = severity.toUpperCase() as keyof typeof policy.severity_rules;
  const sevRule = policy.severity_rules[sevKey] ?? 'auto';

  if (sevRule === 'keep') {
    return { action: 'pass', reason: `severity ${severity} is kept at floor by policy` };
  }
  if (sevRule !== 'auto') {
    return {
      action: sevRule as Action,
      reason: `severity ${severity} rule → ${sevRule}`,
    };
  }

  // auto mode: threshold-based
  const threshold = DEFAULT_THRESHOLD_BYTES;
  if (bytes < threshold) {
    return { action: 'pass', reason: `bytes ${bytes} below auto threshold ${threshold}` };
  }

  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  if (bytes >= 0.5 * GB) {
    return { action: 'drop', reason: `high volume ${fmtBytes(bytes)} over lookback window` };
  }
  if (bytes >= 50 * MB) {
    return { action: 'sample', reason: `moderate volume ${fmtBytes(bytes)}; sampling to 10%` };
  }
  return { action: 'compact', reason: `low-moderate volume ${fmtBytes(bytes)}; compacting` };
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(0)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

// ─── savings calculation ───────────────────────────────────────────────────

function projectedSavingsBytes(decisions: PatternDecision[]): number {
  let saved = 0;
  for (const d of decisions) {
    switch (d.action) {
      case 'drop':
      case 'offload':
        saved += d.bytes;
        break;
      case 'sample':
        saved += d.bytes * 0.9; // keep 10%
        break;
      case 'compact':
        saved += d.bytes * 0.75; // rough 75% compact savings
        break;
      default:
        break;
    }
  }
  return saved;
}

// ─── CSV writing ──────────────────────────────────────────────────────────

function writeOutputFiles(
  repoPath: string,
  decisions: PatternDecision[],
  verbose: boolean
): void {
  const now = new Date().toISOString();
  const nowEpoch = Math.floor(Date.now() / 1000);
  const expiryEpoch = nowEpoch + 30 * 24 * 3600; // 30 days from now

  // Compact CSV rows (encode=true for compact action)
  const compactRows: CompactCsvRow[] = decisions
    .filter((d) => d.action === 'compact')
    .map((d) => ({
      pattern_hash: d.pattern_hash,
      encode: true,
      untilEpoch: expiryEpoch,
      reason: d.reason,
    }));

  // Mute CSV rows (drop → sample_rate=0, sample → sample_rate=0.1)
  const muteRows: MuteCsvRow[] = decisions
    .filter((d) => d.action === 'drop' || d.action === 'sample')
    .map((d) => ({
      pattern_hash: d.pattern_hash,
      sample_rate: d.action === 'drop' ? 0 : 0.1,
      untilEpoch: expiryEpoch,
      reason: d.reason,
    }));

  // Action intent
  const intentEntries = buildActionIntentEntries(
    decisions
      .filter((d) => d.action !== 'pass')
      .map((d) => ({
        pattern_hash: d.pattern_hash,
        service: d.service,
        action: d.action,
        reason: d.reason,
      })),
    { set_at_iso: now }
  );

  // Write compact CSV
  const compactDir = pathJoin(repoPath, 'pipelines', 'run', 'receive', 'compact');
  mkdirSync(compactDir, { recursive: true });
  writeFileSync(pathJoin(compactDir, 'compact-cap.csv'), emitCompactRows(compactRows));

  // Write mute CSV
  const rateDir = pathJoin(repoPath, 'pipelines', 'run', 'receive', 'rate');
  mkdirSync(rateDir, { recursive: true });
  writeFileSync(pathJoin(rateDir, 'caps.csv'), emitMuteRows(muteRows));

  // Write action intent JSON
  const dataDir = pathJoin(repoPath, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    pathJoin(dataDir, 'action-intent.json'),
    writeActionIntent(intentEntries, { updated_at_iso: now })
  );

  if (verbose) {
    process.stderr.write(
      `[tenx-recur] wrote ${compactRows.length} compact rows, ` +
      `${muteRows.length} mute rows, ${intentEntries.length} intent entries\n`
    );
  }
}

// ─── git commit ────────────────────────────────────────────────────────────

async function commitToConfigPlane(
  repoPath: string,
  policy: Policy,
  decisions: PatternDecision[],
  projectedPct: number,
  opts: TickOptions
): Promise<void> {
  const strategy = policy.config_plane.commit_strategy ?? 'pr';
  const base = policy.config_plane.base_branch ?? 'main';
  const branchName = `log10x-recur-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

  const reducedCount = decisions.filter((d) => d.action !== 'pass').length;
  const commitMsg = `chore(log10x): recurring tick — ${reducedCount} patterns, ~${projectedPct.toFixed(1)}% projected savings`;

  // Stage the three changed paths.
  const filesToAdd = [
    'pipelines/run/receive/compact/compact-cap.csv',
    'pipelines/run/receive/rate/caps.csv',
    'data/action-intent.json',
  ];

  // git add
  await execFileP('git', ['-C', repoPath, 'add', ...filesToAdd], {
    timeout: 15_000,
  });

  // Check if there's anything to commit (diff --cached --quiet exits 0 = no diff).
  try {
    await execFileP('git', ['-C', repoPath, 'diff', '--cached', '--quiet'], {
      timeout: 5_000,
    });
    // If we reach here — no staged changes, nothing to commit.
    return;
  } catch {
    // Non-zero exit = there are staged changes — proceed.
  }

  if (strategy === 'direct_push') {
    await execFileP(
      'git',
      ['-C', repoPath, 'commit', '-m', commitMsg],
      { timeout: 15_000 }
    );
    await execFileP(
      'git',
      ['-C', repoPath, 'push', 'origin', `HEAD:${base}`],
      { timeout: 30_000 }
    );
  } else {
    // PR strategy: create a new branch and open a PR.
    await execFileP(
      'git',
      ['-C', repoPath, 'checkout', '-b', branchName],
      { timeout: 10_000 }
    );
    await execFileP(
      'git',
      ['-C', repoPath, 'commit', '-m', commitMsg],
      { timeout: 15_000 }
    );
    await execFileP(
      'git',
      ['-C', repoPath, 'push', 'origin', branchName],
      { timeout: 30_000 }
    );

    const repo = policy.config_plane.repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
    if (repo.includes('/')) {
      await execFileP(
        'gh',
        [
          'pr',
          'create',
          '--repo', repo,
          '--base', base,
          '--head', branchName,
          '--title', commitMsg,
          '--body',
          `Automated recurring cost-reduction tick.\n\n` +
          `Reduced patterns: ${reducedCount}\nProjected savings: ~${projectedPct.toFixed(1)}%\n`,
        ],
        { timeout: 30_000 }
      );
    }
  }
}

// ─── history logging ───────────────────────────────────────────────────────

function appendHistory(result: TickResult): void {
  const entry = {
    ts: new Date().toISOString(),
    status: result.status,
    projected_savings_pct: result.projected_savings_pct,
    delta_patterns: result.delta_patterns,
    delta_pp: result.delta_pp,
    message: result.message,
  };
  try {
    const line = JSON.stringify(entry) + '\n';
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(HISTORY_FILE, line, 'utf8');
  } catch {
    // history append failure is non-fatal
  }
}

// ─── main tick runner ──────────────────────────────────────────────────────

/**
 * Run one tick of the recurring cost-reduction policy.
 *
 * @param policy  Parsed and validated policy (from parsePolicyYaml).
 * @param opts    Runtime options (dryRun, verbose).
 * @returns       TickResult with status, projected savings, decisions made.
 *
 * @throws PromUnreachableError (exit code 2) when Prometheus cannot be reached.
 */
export async function runTick(policy: Policy, opts: TickOptions = {}): Promise<TickResult> {
  const { dryRun = false, verbose = false } = opts;

  // Resolve env ID — policy takes priority, then env var.
  const envId =
    policy.config_plane.env_id ||
    process.env.LOG10X_ENV_ID ||
    '';

  if (!envId) {
    throw new Error(
      'No environment ID found. Set config_plane.env_id in policy.yaml or LOG10X_ENV_ID env var.'
    );
  }

  // ── step 1: query Prometheus ─────────────────────────────────────────────

  // When target_services is empty we run a single global query.
  // When it's populated we run one query per service and merge.
  const servicesToQuery =
    policy.target_services.length > 0 ? policy.target_services : [undefined];

  const LIMIT_PER_SERVICE = 50;
  const allRows: PromRow[] = [];

  for (const svc of servicesToQuery) {
    const rows = await queryTopPatternsFromPrometheus(
      envId,
      policy.lookback_window,
      svc,
      LIMIT_PER_SERVICE,
      verbose
    );
    allRows.push(...rows);
  }

  if (verbose) {
    process.stderr.write(`[tenx-recur] received ${allRows.length} pattern rows from Prometheus\n`);
  }

  // ── step 2: deduplicate + rank by bytes ──────────────────────────────────

  // Dedup by (pattern_hash, service, severity) — keep the highest-bytes row.
  const seenKey = new Map<string, number>(); // key → index in deduped
  const deduped: Array<{
    pattern: string;
    service: string;
    severity: string;
    bytes: number;
  }> = [];

  for (const row of allRows) {
    const pattern = row.metric['message_pattern'] ?? '';
    const service = row.metric['tenx_user_service'] ?? '';
    const severity = row.metric['severity_level'] ?? '';
    const bytes = parseFloat(row.value[1] ?? '0') || 0;
    const key = `${pattern}|${service}|${severity}`;

    const existing = seenKey.get(key);
    if (existing !== undefined) {
      if (bytes > deduped[existing].bytes) {
        deduped[existing].bytes = bytes;
      }
    } else {
      seenKey.set(key, deduped.length);
      deduped.push({ pattern, service, severity, bytes });
    }
  }

  // Sort descending by bytes.
  deduped.sort((a, b) => b.bytes - a.bytes);

  const totalBytes = deduped.reduce((sum, r) => sum + r.bytes, 0);

  // ── step 3: walk top-N applying policy rules ─────────────────────────────

  const decisions: PatternDecision[] = [];
  let cumulativeSavedBytes = 0;
  const targetSavedBytes = totalBytes * (policy.target_percent / 100);

  for (const row of deduped) {
    const sharePct = totalBytes > 0 ? (row.bytes / totalBytes) * 100 : 0;
    const alreadyMet = cumulativeSavedBytes >= targetSavedBytes;

    let action: Action;
    let reason: string;

    if (alreadyMet) {
      // Target already met — pass remaining patterns.
      action = 'pass';
      reason = `target already met (${policy.target_percent}% reached)`;
    } else {
      const decided = decideAction(row.service, row.severity, row.bytes, policy);
      action = decided.action;
      reason = decided.reason;
    }

    // Accumulate saved bytes.
    if (!alreadyMet) {
      switch (action) {
        case 'drop':
        case 'offload':
          cumulativeSavedBytes += row.bytes;
          break;
        case 'sample':
          cumulativeSavedBytes += row.bytes * 0.9;
          break;
        case 'compact':
          cumulativeSavedBytes += row.bytes * 0.75;
          break;
      }
    }

    decisions.push({
      pattern_hash: row.pattern,
      service: row.service,
      severity: row.severity,
      bytes: row.bytes,
      share_pct: sharePct,
      action,
      reason,
    });
  }

  const projectedSavedBytes = projectedSavingsBytes(decisions);
  const projectedSavingsPct =
    totalBytes > 0 ? (projectedSavedBytes / totalBytes) * 100 : 0;

  // ── step 4: compute delta vs. current applied state ──────────────────────

  // Resolve repo path for reading current state.
  // For a local path: use as-is.  For a URL: assume the caller has cloned it
  // somewhere — we look for LOG10X_GITOPS_REPO_PATH or fall back to a temp
  // clone path under /tmp/log10x-recur-repo.
  const repoPath = resolveRepoPath(policy.config_plane.repo);

  const priorIntent = readCurrentActionIntent(repoPath);
  const priorSavingsPct = readCurrentSavingsPct(repoPath, totalBytes);

  // Count patterns that changed action vs. prior state.
  let deltaPatterns = 0;
  for (const d of decisions) {
    const prior = priorIntent.get(d.pattern_hash);
    if (prior !== d.action) deltaPatterns++;
  }

  const deltaPp = projectedSavingsPct - priorSavingsPct;

  if (verbose) {
    process.stderr.write(
      `[tenx-recur] prior_savings=${priorSavingsPct.toFixed(1)}% ` +
      `projected=${projectedSavingsPct.toFixed(1)}% ` +
      `delta=${deltaPp.toFixed(1)}pp ` +
      `min_delta=${policy.min_delta_pp}pp\n`
    );
  }

  // ── step 5: apply or no-op ───────────────────────────────────────────────

  if (Math.abs(deltaPp) < policy.min_delta_pp) {
    const result: TickResult = {
      status: 'no_change',
      message: `delta ${deltaPp.toFixed(1)}pp is below min_delta_pp=${policy.min_delta_pp} — no change needed`,
      projected_savings_pct: projectedSavingsPct,
      applied_changes: decisions,
      delta_patterns: deltaPatterns,
      delta_pp: deltaPp,
    };
    appendHistory(result);
    return result;
  }

  if (dryRun) {
    const result: TickResult = {
      status: 'dry_run',
      message:
        `dry-run: would apply ${deltaPatterns} pattern change(s), ` +
        `projected savings ${projectedSavingsPct.toFixed(1)}%`,
      projected_savings_pct: projectedSavingsPct,
      applied_changes: decisions,
      delta_patterns: deltaPatterns,
      delta_pp: deltaPp,
    };
    appendHistory(result);
    return result;
  }

  // Write output files.
  writeOutputFiles(repoPath, decisions, verbose);

  // Commit to the config plane.
  try {
    await commitToConfigPlane(repoPath, policy, decisions, projectedSavingsPct, opts);
  } catch (err) {
    const result: TickResult = {
      status: 'error',
      message: `commit failed: ${String(err)}`,
      projected_savings_pct: projectedSavingsPct,
      applied_changes: decisions,
      delta_patterns: deltaPatterns,
      delta_pp: deltaPp,
    };
    appendHistory(result);
    return result;
  }

  const result: TickResult = {
    status: 'applied',
    message:
      `applied ${deltaPatterns} pattern change(s), ` +
      `projected savings ${projectedSavingsPct.toFixed(1)}%`,
    projected_savings_pct: projectedSavingsPct,
    applied_changes: decisions,
    delta_patterns: deltaPatterns,
    delta_pp: deltaPp,
    history_path: HISTORY_FILE,
  };
  appendHistory(result);
  return result;
}

// ─── repo path resolution ──────────────────────────────────────────────────

/**
 * Resolve the local filesystem path to the gitops repo.
 *
 * Priority:
 *   1. LOG10X_GITOPS_REPO_PATH env var (explicit override)
 *   2. If config_plane.repo is already a local path — use it directly
 *   3. Derive a stable temp path from the repo URL: /tmp/log10x-recur-repo/<hash>
 *      (the caller or scheduler must have done `git clone` beforehand)
 */
function resolveRepoPath(repo: string): string {
  if (process.env.LOG10X_GITOPS_REPO_PATH) {
    return process.env.LOG10X_GITOPS_REPO_PATH;
  }
  // Local path?
  if (!repo.startsWith('http://') && !repo.startsWith('https://') && !repo.startsWith('git@')) {
    return repo;
  }
  // URL — derive stable temp path.
  const slug = repo.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(-40);
  return pathJoin(tmpdir(), 'log10x-recur-repo', slug);
}
