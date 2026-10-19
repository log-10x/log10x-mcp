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
 *   5b. Else write mute/action-intent files and commit via gh CLI or
 *       direct git push.
 *
 * The runner NEVER directly imports heavy MCP tool modules — it only uses the
 * lower-level libs (cost.ts, mute-csv-writer.ts,
 * action-intent-writer.ts) so it can run as a standalone CLI binary.
 *
 * Prometheus queries go through the existing `customer-metrics.ts` adapter
 * (LOG10X_CUSTOMER_METRICS_URL / LOG10X_CUSTOMER_METRICS_TYPE / …) which is
 * what `log10x_top_patterns` also uses under the hood.
 */

import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

import type { Policy } from './policy-loader.js';
import type { CustomerMetricsBackend } from './customer-metrics.js';
import { emitMuteRows, type MuteCsvRow } from './mute-csv-writer.js';
import {
  writeActionIntent,
  buildActionIntentEntries,
} from './action-intent-writer.js';
import { parseActionIntent } from './action-intent-parser.js';
import { parseCompactCsv } from './compact-csv-parser.js';
import type { Action } from './cost.js';
import {
  discoverInstances,
  planBudget,
  protectedPatterns,
  readBudgetInputs,
  renderBudgetFiles,
  renderBudgetReport,
  type BudgetFiles,
  type DdQuery,
} from './budget-tick.js';
import type { DatadogMetricsCreds } from './datadog-metrics-read.js';
import { inClusterK8sApi, podNamespace, type K8sApi } from './k8s-in-cluster.js';
import { POLICY_CONFIGMAP_NAME, POLICY_GIT_BRANCH_DEFAULT, POLICY_GIT_DIR, REGULATOR_UNIT_KEY } from './advisor/reporter-forwarders.js';

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
  | 'read_failed'  // budget run: a Datadog or cluster read failed; the last files stay in force
  | 'refused'      // budget run: the Receiver is not recorded as counting events; nothing written
  | 'error';       // fatal; message is set

export interface PatternDecision {
  /**
   * The pattern's message_pattern NAME (the engine's mute-file key —
   * rateReceiver fieldNames joins to message_pattern), NOT an 11-char
   * tenx_hash. The field name predates that distinction.
   */
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
  /**
   * Set when the projection leans on an assumption rather than a measurement:
   * the assumption, stated. Every place the percentage renders carries it.
   */
  projected_savings_basis?: string;
  /** All per-pattern decisions the tick made (including 'pass'). */
  applied_changes: PatternDecision[];
  /** How many patterns changed vs. the prior state. */
  delta_patterns: number;
  /** Delta in savings percentage points vs. prior state. */
  delta_pp: number;
  /** Path to the appended run-history JSONL line (when not dry-run). */
  history_path?: string;
  /** Budget run only: the report, in Markdown. */
  budget_report?: string;
  /** Budget run only: the files written, or that would be. */
  budget_files?: BudgetFiles;
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

// ─── backend loader seam (dependency injection) ─────────────────────────────

/**
 * How the runner resolves its metrics backend. Defaults to the same
 * ambient-env resolution the MCP tools use (`loadBackendFromEnv`).
 *
 * Tests inject a deterministic mock via `_setBackendLoader()` instead of
 * monkey-patching the frozen `customer-metrics` ESM namespace (which throws
 * under strict ESM). Mirrors the `_set*` runner-injection seam used by other
 * libs in this package.
 */
type BackendLoader = () => Promise<CustomerMetricsBackend | undefined>;

let backendLoader: BackendLoader = async () => {
  // Resolve the metrics backend exactly as the MCP tools do.
  const { loadBackendFromEnv } = await import('./customer-metrics.js');
  return loadBackendFromEnv();
};

/** Test seam: override how the runner resolves its metrics backend. */
export function _setBackendLoader(loader: BackendLoader): void {
  backendLoader = loader;
}

/** Test seam: restore the default ambient-env backend loader. */
export function _resetBackendLoader(): void {
  backendLoader = async () => {
    const { loadBackendFromEnv } = await import('./customer-metrics.js');
    return loadBackendFromEnv();
  };
}

// ─── Prometheus query ───────────────────────────────────────────────────────

async function queryTopPatternsFromPrometheus(
  envId: string,
  lookback: string,
  serviceFilter: string | undefined,
  limit: number,
  verbose: boolean
): Promise<PromRow[]> {
  // Resolve the metrics backend through the (overridable) loader seam.
  const backend = await backendLoader();
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

  // Mute CSV — the engine's per-pattern mute file (rateReceiverLookupFile),
  // keyed by message_pattern, sibling of caps.csv. Count sampled/dropped
  // rows: value grammar `<sampleRate>:<untilEpoch>[:<reason>]`, so a rate
  // below 1.0 is a thinning decision.
  const mutePath = pathJoin(
    repoPath,
    'pipelines',
    'run',
    'receive',
    'rate',
    'mutes.csv'
  );
  if (existsSync(mutePath)) {
    const text = readFileSync(mutePath, 'utf8');
    const muteRowCount = text
      .split(/\r?\n/)
      .slice(1) // header
      .filter((l) => {
        const c = l.indexOf(',');
        if (c < 0) return false;
        const rate = parseFloat(l.substring(c + 1));
        return Number.isFinite(rate) && rate < 1;
      }).length;
    savedBytes += muteRowCount * (totalBytes / 1000);
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
 *   4. Severity rule is 'auto', unset or unknown → look at bytes vs threshold
 *      - below threshold → 'pass'
 *      - at or above threshold → choose based on bytes magnitude:
 *          very high (>= 500 MB)  → 'drop'
 *          otherwise              → 'sample'
 *
 * Compaction is not a tick decision. It is a per-source switch, the
 * sidecar's `optimize` flag, set at install from the ratio
 * log10x_measure_compaction reads off the stream; a per-pattern row cannot
 * trade saving for anything, so the tick writes none.
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
  if (sevRule === 'drop' || sevRule === 'sample') {
    return {
      action: sevRule,
      reason: `severity ${severity} rule → ${sevRule}`,
    };
  }
  if (sevRule !== 'auto') {
    // A rule the tick does not know (a stale `compact`) never makes the
    // severity lossy: it is kept, as a `keep` rule would be.
    return { action: 'pass', reason: `severity ${severity} rule "${String(sevRule)}" is not a tick action; kept` };
  }

  // auto mode: threshold-based
  const threshold = DEFAULT_THRESHOLD_BYTES;
  if (bytes < threshold) {
    return { action: 'pass', reason: `bytes ${bytes} below auto threshold ${threshold}` };
  }

  const GB = 1024 * 1024 * 1024;
  if (bytes >= 0.5 * GB) {
    return { action: 'drop', reason: `high volume ${fmtBytes(bytes)} over lookback window` };
  }
  return { action: 'sample', reason: `moderate volume ${fmtBytes(bytes)}; sampling to 10%` };
}

/** PromQL range string -> hours ("24h" -> 24, "7d" -> 168, "30m" -> 0.5). 24h fallback. */
function lookbackHours(window: string): number {
  const m = /^(\d+(?:\.\d+)?)([smhdw])$/.exec(window.trim());
  if (!m) return 24;
  const v = parseFloat(m[1]);
  switch (m[2]) {
    case 's': return v / 3600;
    case 'm': return v / 60;
    case 'h': return v;
    case 'd': return v * 24;
    case 'w': return v * 168;
    default: return 24;
  }
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(0)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

// ─── savings calculation ───────────────────────────────────────────────────

/**
 * The assumption behind a projection. The tick plans drop and sample only,
 * whose savings are arithmetic on the bytes it read, so there is none.
 */
function savingsBasis(_decisions: PatternDecision[]): string | undefined {
  return undefined;
}

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
      default:
        break;
    }
  }
  return saved;
}

// ─── CSV writing ──────────────────────────────────────────────────────────

export function writeOutputFiles(
  repoPath: string,
  decisions: PatternDecision[],
  verbose: boolean
): void {
  const now = new Date().toISOString();
  const nowEpoch = Math.floor(Date.now() / 1000);
  const expiryEpoch = nowEpoch + 30 * 24 * 3600; // 30 days from now

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
  // Compaction is a per-source switch, never a per-pattern row: a compact
  // decision handed in from elsewhere is written nowhere.
  const intentEntries = buildActionIntentEntries(
    decisions
      .filter((d) => d.action !== 'pass' && d.action !== 'compact')
      .map((d) => ({
        pattern_hash: d.pattern_hash,
        service: d.service,
        action: d.action,
        reason: d.reason,
      })),
    { set_at_iso: now }
  );

  // Write mute CSV — the ENGINE's per-pattern mute file
  // (rateReceiverLookupFile), keyed by message_pattern. NEVER caps.csv:
  // that is the container-keyed BYTE-CAP file with a different value
  // grammar; mute rows written there are dead on both axes (wrong key
  // space, and a sub-1 "cap" is a per-container regulator opt-out).
  const rateDir = pathJoin(repoPath, 'pipelines', 'run', 'receive', 'rate');
  mkdirSync(rateDir, { recursive: true });
  writeFileSync(pathJoin(rateDir, 'mutes.csv'), emitMuteRows(muteRows));

  // Write action intent JSON
  const dataDir = pathJoin(repoPath, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    pathJoin(dataDir, 'action-intent.json'),
    writeActionIntent(intentEntries, { updated_at_iso: now })
  );

  if (verbose) {
    process.stderr.write(
      `[tenx-recur] wrote ${muteRows.length} mute rows, ${intentEntries.length} intent entries\n`
    );
  }
}

// ─── run report ────────────────────────────────────────────────────────────

/**
 * The thermostat's audit trail: one markdown report per APPLIED tick, written
 * into the config repo so it rides the same commit as the CSVs it describes.
 * "When a scheduled run cuts something on a Tuesday, where do I see what it
 * did" — here, in the artifact the change-control process already reviews.
 * noop ticks write nothing (a daily no-change commit would be churn); they
 * land in the local history file instead.
 */
export function writeRunReport(
  repoPath: string,
  policy: Policy,
  decisions: PatternDecision[],
  totalBytes: number,
  projectedSavingsPct: number,
  deltaPatterns: number,
  deltaPp: number,
  basis?: string
): void {
  const now = new Date().toISOString();
  const goal =
    policy.budget_gb_monthly !== undefined
      ? `keep ingest under ${policy.budget_gb_monthly} GB/mo (standing line)`
      : `cut ${policy.target_percent}% of lookback volume`;
  const scope =
    policy.target_services.length > 0 ? policy.target_services.join(', ') : 'all services';
  const acted = decisions.filter((d) => d.action !== 'pass');
  const byAction = new Map<string, number>();
  for (const d of acted) byAction.set(d.action, (byAction.get(d.action) ?? 0) + 1);
  const actionMix = [...byAction.entries()].map(([a, n]) => `${n} ${a}`).join(', ') || 'none';
  const lines: string[] = [
    `# Recurring tick: ${now}`,
    ``,
    `- **Goal**: ${goal}`,
    `- **Scope**: ${scope} · lookback ${policy.lookback_window}`,
    `- **Observed**: ${fmtBytes(totalBytes)} across ${decisions.length} pattern rows`,
    `- **Acted on**: ${acted.length} rows (${actionMix}) · projected ${projectedSavingsPct.toFixed(1)}% of lookback volume${basis ? ` (${basis})` : ''}`,
    `- **Delta vs previous applied state**: ${deltaPatterns} pattern change(s), ${deltaPp.toFixed(1)}pp`,
    `- **Severity floor**: every ERROR/CRITICAL row passed untouched`,
    ``,
    `## Largest actions`,
    ``,
  ];
  const top = [...acted].sort((a, b) => b.bytes - a.bytes).slice(0, 10);
  if (top.length === 0) {
    lines.push('(none: every row passed)');
  } else {
    for (const d of top) {
      lines.push(
        `1. \`${d.pattern_hash}\` · ${d.service || '(no service)'} · ${d.severity || '(no severity)'}: ` +
          `${fmtBytes(d.bytes)} (${d.share_pct.toFixed(1)}%) → **${d.action}** (${d.reason})`
      );
    }
  }
  lines.push('', `Rollback: revert this commit; the engine re-reads policy on its refresh cycle, the same path an apply takes.`, '');

  const reportsDir = pathJoin(repoPath, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = now.slice(0, 19).replace(/[:T]/g, '-');
  writeFileSync(pathJoin(reportsDir, `tick-${stamp}.md`), lines.join('\n'));
  writeFileSync(pathJoin(reportsDir, 'latest.md'), lines.join('\n'));
}

// ─── git commit ────────────────────────────────────────────────────────────

async function commitToConfigPlane(
  repoPath: string,
  policy: Policy,
  decisions: PatternDecision[],
  projectedPct: number,
  opts: TickOptions,
  basis?: string
): Promise<void> {
  const reducedCount = decisions.filter((d) => d.action !== 'pass').length;
  const commitMsg = `chore(log10x): recurring tick, ${reducedCount} patterns, ~${projectedPct.toFixed(1)}% projected savings${basis ? ` (${basis})` : ''}`;
  await commitFiles(
    repoPath,
    policy,
    ['pipelines/run/receive/compact/compact-cap.csv', 'pipelines/run/receive/rate/mutes.csv', 'data/action-intent.json'],
    commitMsg,
    `Automated recurring cost-reduction tick.\n\nReduced patterns: ${reducedCount}\nProjected savings: ~${projectedPct.toFixed(1)}%\n`,
  );
}

async function commitFiles(
  repoPath: string,
  policy: Policy,
  filesToAdd: string[],
  commitMsg: string,
  prBody: string,
): Promise<void> {
  const strategy = policy.config_plane.commit_strategy ?? 'pr';
  const base = policy.config_plane.base_branch ?? 'main';
  const branchName = `log10x-recur-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

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
          '--body', prBody,
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
    ...(result.projected_savings_basis ? { projected_savings_basis: result.projected_savings_basis } : {}),
    delta_patterns: result.delta_patterns,
    delta_pp: result.delta_pp,
    message: result.message,
  };
  try {
    appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
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
  if (policy.budget_usd) return runBudgetTick(policy, opts);
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
  // Volume budget (thermostat): scale the monthly line down to this tick's
  // lookback window and cut only the overage. Already under budget -> target
  // 0 bytes -> every pattern passes. Otherwise: the classic percent goal.
  const targetSavedBytes =
    policy.budget_gb_monthly !== undefined
      ? Math.max(
          0,
          totalBytes -
            policy.budget_gb_monthly * 1_000_000_000 * (lookbackHours(policy.lookback_window) / 720),
        )
      : totalBytes * (policy.target_percent / 100);
  const goalLabel =
    policy.budget_gb_monthly !== undefined
      ? `${policy.budget_gb_monthly} GB/mo budget`
      : `${policy.target_percent}%`;

  for (const row of deduped) {
    const sharePct = totalBytes > 0 ? (row.bytes / totalBytes) * 100 : 0;
    const alreadyMet = cumulativeSavedBytes >= targetSavedBytes;

    let action: Action;
    let reason: string;

    if (alreadyMet) {
      // Target already met — pass remaining patterns.
      action = 'pass';
      reason = `target already met (${goalLabel} reached)`;
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
  const basis = savingsBasis(decisions);
  const basisNote = basis ? ` (${basis})` : '';
  const basisField = basis ? { projected_savings_basis: basis } : {};

  // ── step 4: compute delta vs. current applied state ──────────────────────

  // Resolve repo path for reading current state.
  // For a local path: use as-is.  For a URL: assume the caller has cloned it
  // somewhere — we look for LOG10X_GITOPS_REPO_PATH or fall back to a temp
  // clone path under /tmp/log10x-recur-repo.
  const repoPath = resolveRepoPath(policy.config_plane.repo);

  if (isS3ConfigPlane(policy.config_plane.repo)) {
    await pullStateFromS3(policy.config_plane.repo, repoPath, verbose);
  }

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
      `projected=${projectedSavingsPct.toFixed(1)}%${basisNote} ` +
      `delta=${deltaPp.toFixed(1)}pp ` +
      `min_delta=${policy.min_delta_pp}pp\n`
    );
  }

  // ── step 5: apply or no-op ───────────────────────────────────────────────

  if (Math.abs(deltaPp) < policy.min_delta_pp) {
    const result: TickResult = {
      status: 'no_change',
      message: `delta ${deltaPp.toFixed(1)}pp is below min_delta_pp=${policy.min_delta_pp}: no change needed`,
      projected_savings_pct: projectedSavingsPct,
      ...basisField,
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
        `projected savings ${projectedSavingsPct.toFixed(1)}%${basisNote}`,
      projected_savings_pct: projectedSavingsPct,
      ...basisField,
      applied_changes: decisions,
      delta_patterns: deltaPatterns,
      delta_pp: deltaPp,
    };
    appendHistory(result);
    return result;
  }

  // Write output files.
  writeOutputFiles(repoPath, decisions, verbose);
  writeRunReport(repoPath, policy, decisions, totalBytes, projectedSavingsPct, deltaPatterns, deltaPp, basis);

  // Commit to the config plane — git for a repo plane, object puts for S3.
  try {
    if (isS3ConfigPlane(policy.config_plane.repo)) {
      await pushStateToS3(policy.config_plane.repo, repoPath);
    } else {
      await commitToConfigPlane(repoPath, policy, decisions, projectedSavingsPct, opts, basis);
    }
  } catch (err) {
    const result: TickResult = {
      status: 'error',
      message: `commit failed: ${String(err)}`,
      projected_savings_pct: projectedSavingsPct,
      ...basisField,
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
      `projected savings ${projectedSavingsPct.toFixed(1)}%${basisNote}`,
    projected_savings_pct: projectedSavingsPct,
    ...basisField,
    applied_changes: decisions,
    delta_patterns: deltaPatterns,
    delta_pp: deltaPp,
    history_path: HISTORY_FILE,
  };
  appendHistory(result);
  return result;
}

// ─── budget run ────────────────────────────────────────────────────────────

/** Where the budget run's files sit on the policy branch: the folder the engine's git pull reads (GH_ENABLED). */
export const BUDGET_FILE_DIR = POLICY_GIT_DIR;
const BUDGET_FILE_NAMES = ['caps.csv', 'actions.csv', 'totals.csv', 'config-generation.csv'] as const;
export const BUDGET_REPORT_KEY = 'budget-report.md';
/** The branch the engine's gitops pull reads the budget run's files from (GH_BRANCH). */
export const POLICY_BRANCH_DEFAULT = POLICY_GIT_BRANCH_DEFAULT;

interface BudgetDeps {
  creds?: DatadogMetricsCreds | null;
  query?: DdQuery;
  /** null: no cluster API (the run reports a read failure on configmap delivery). */
  k8s?: K8sApi | null;
  nowMs?: () => number;
}

let budgetDeps: BudgetDeps = {};

/** Test seam: the Datadog reads, the cluster API and the clock for the budget run. */
export function _setBudgetDeps(deps: BudgetDeps): void {
  budgetDeps = deps;
}

/** Test seam: restore the ambient Datadog keys, in-cluster API and clock. */
export function _resetBudgetDeps(): void {
  budgetDeps = {};
}

function budgetResult(status: TickStatus, message: string, extra: Partial<TickResult> = {}): TickResult {
  return { status, message, projected_savings_pct: 0, applied_changes: [], delta_patterns: 0, delta_pp: 0, ...extra };
}

/**
 * The unit the Receiver counts in, as its install recorded it: the
 * `regulator-unit` key of the policy ConfigMap (seeded by log10x_advise_install),
 * or the `regulator-unit` file beside the policy files in the gitops repo.
 * The budget run writes limits in events and refuses anything else.
 */
function unitRefusal(unit: string | undefined, where: string): string | undefined {
  if ((unit ?? '').trim() === 'events') return undefined;
  return (
    `The budget run writes limits in events, and ${where} does not say the Receiver counts events ` +
    `(found ${unit === undefined ? 'nothing' : `"${unit.trim()}"`}). A Receiver counting bytes would read every limit as bytes. ` +
    'Re-install the Receiver with log10x_advise_install (engine 1.1.146 or later, regulator_unit "events", the default for Datadog), ' +
    'which records the unit, then run again. Nothing was written.'
  );
}

async function git(repoPath: string, args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', repoPath, ...args], { timeout });
  return stdout;
}

/** A file on the remote policy branch, or undefined when the branch or the file is absent. */
async function readPolicyBranchFile(repoPath: string, branch: string, rel: string): Promise<string | undefined> {
  try {
    return await git(repoPath, ['show', `refs/remotes/origin/${branch}:${rel}`]);
  } catch {
    return undefined;
  }
}

/**
 * Commit the files DIRECTLY to the policy branch the engine's gitops pull
 * reads, never a PR: nothing would merge it. Works in a temporary worktree so
 * the checkout the scheduler made is left as it was.
 */
async function commitToPolicyBranch(repoPath: string, branch: string, files: Record<string, string>, message: string): Promise<void> {
  const scratch = mkdtempSync(pathJoin(tmpdir(), 'log10x-policy-'));
  const tmp = pathJoin(scratch, 'worktree');
  let hasRemote = true;
  try {
    await git(repoPath, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`]);
  } catch {
    hasRemote = false;
  }
  await git(repoPath, ['worktree', 'add', '-B', branch, tmp, hasRemote ? `refs/remotes/origin/${branch}` : 'HEAD']);
  try {
    for (const [rel, body] of Object.entries(files)) {
      const p = pathJoin(tmp, ...rel.split('/'));
      mkdirSync(pathJoin(p, '..'), { recursive: true });
      writeFileSync(p, body);
    }
    await git(tmp, ['add', ...Object.keys(files)]);
    try {
      await git(tmp, ['diff', '--cached', '--quiet']);
      return;
    } catch {
      // staged changes: commit them
    }
    await git(tmp, ['commit', '-m', message]);
    await git(tmp, ['push', 'origin', `${branch}:${branch}`]);
  } finally {
    await git(repoPath, ['worktree', 'remove', '--force', tmp]).catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * One budget run (`reduction.budget_usd_monthly`). Reads month-to-date
 * Standard usage and the Receiver's series from Datadog, discovers or reads
 * the node counts, re-derives every row, and writes the four files to the
 * policy ConfigMap or the gitops policy branch. On a failed read nothing is
 * written; on a Receiver not recorded as counting events nothing is written.
 */
export async function runBudgetTick(policy: Policy, opts: TickOptions = {}): Promise<TickResult> {
  const budget = policy.budget_usd!;
  const { dryRun = false, verbose = false } = opts;
  const deps = budgetDeps;
  const nowSec = Math.floor((deps.nowMs ? deps.nowMs() : Date.now()) / 1000);
  const delivery = policy.config_plane.delivery ?? 'gitops';
  const envId = policy.config_plane.env_id || process.env.LOG10X_ENV_ID || undefined;
  const k8s = deps.k8s === undefined ? inClusterK8sApi() : deps.k8s ?? undefined;
  const keep = 'The files from the last run stay in force.';

  const namespace = policy.config_plane.namespace ?? podNamespace() ?? 'log10x';
  const cmName = policy.config_plane.configmap ?? POLICY_CONFIGMAP_NAME;
  const branch = policy.config_plane.policy_branch ?? POLICY_BRANCH_DEFAULT;
  const repoPath = delivery === 'gitops' ? resolveRepoPath(policy.config_plane.repo) : '';
  const rel = (f: string): string => `${BUDGET_FILE_DIR}/${f}`;
  let reads;
  let nodes: { instances: Record<string, number>; nodesTotal: number };
  let cm: { data: Record<string, string>; resourceVersion: string } | undefined;
  let mutesCsv: string | undefined;
  let unit: string | undefined;
  const current: Record<string, string | undefined> = {};
  try {
    reads = await readBudgetInputs(nowSec, lookbackHours(policy.lookback_window), envId, { creds: deps.creds, query: deps.query });
    if (delivery === 'configmap') {
      if (!k8s) throw new Error('no Kubernetes API in this process (KUBERNETES_SERVICE_HOST and the service-account token), so the node count cannot be discovered.');
      nodes = await discoverInstances(k8s, namespace, cmName);
      cm = await k8s.getConfigMap(namespace, cmName);
      mutesCsv = cm.data['mutes.csv'];
      unit = cm.data[REGULATOR_UNIT_KEY];
      for (const f of BUDGET_FILE_NAMES) current[f] = cm.data[f];
    } else {
      const counts = budget.nodes_by_container;
      const max = Object.values(counts).reduce((a, n) => Math.max(a, n), 1);
      nodes = { instances: counts, nodesTotal: budget.nodes_total ?? max };
      await git(repoPath, ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]).catch(() => undefined);
      mutesCsv = await readPolicyBranchFile(repoPath, branch, rel('mutes.csv'));
      const local = pathJoin(repoPath, ...rel(REGULATOR_UNIT_KEY).split('/'));
      unit = (await readPolicyBranchFile(repoPath, branch, rel(REGULATOR_UNIT_KEY))) ?? (existsSync(local) ? readFileSync(local, 'utf8') : undefined);
      for (const f of BUDGET_FILE_NAMES) current[f] = await readPolicyBranchFile(repoPath, branch, rel(f));
    }
  } catch (err) {
    const result = budgetResult('read_failed', `budget run read failed: ${err instanceof Error ? err.message : String(err)} ${keep}`);
    appendHistory(result);
    return result;
  }
  const refusal = unitRefusal(
    unit,
    delivery === 'configmap'
      ? `the ConfigMap ${namespace}/${cmName} (key ${REGULATOR_UNIT_KEY})`
      : `the gitops repo (${rel(REGULATOR_UNIT_KEY)} on ${branch} or the checkout)`,
  );
  if (refusal) {
    const result = budgetResult('refused', refusal);
    appendHistory(result);
    return result;
  }

  const plan = planBudget({
    budget,
    nowSec,
    usage: reads.usage,
    routes: reads.routes,
    patterns: reads.patterns,
    ...(mutesCsv !== undefined ? { protectedPatterns: protectedPatterns(mutesCsv, nowSec) } : {}),
    instances: nodes.instances,
    nodesTotal: nodes.nodesTotal,
    instanceBasis: delivery === 'configmap' ? 'discovery' : 'policy',
    exceptions: policy.exceptions,
    targetServices: policy.target_services,
  });
  const files = renderBudgetFiles(plan);
  const report = renderBudgetReport(plan, budget, nowSec);
  if (verbose) process.stderr.write(`[tenx-recur] ${plan.lines.join('\n[tenx-recur] ')}\n`);
  const summary = plan.lines[plan.lines.length > 2 ? 2 : plan.lines.length - 1];
  const extra = { budget_report: report, budget_files: files };

  if (dryRun) {
    const result = budgetResult('dry_run', `dry-run: ${summary}`, extra);
    appendHistory(result);
    return result;
  }
  if (BUDGET_FILE_NAMES.every((f) => current[f] === files[f])) {
    const result = budgetResult('no_change', `no change: ${summary}`, extra);
    appendHistory(result);
    return result;
  }

  try {
    if (delivery === 'configmap' && cm) {
      await k8s!.replaceConfigMap(namespace, cmName, { ...cm.data, ...files, [BUDGET_REPORT_KEY]: report }, cm.resourceVersion);
    } else {
      await commitToPolicyBranch(
        repoPath,
        branch,
        { ...Object.fromEntries(BUDGET_FILE_NAMES.map((f) => [rel(f), files[f]])), 'reports/latest.md': report },
        `chore(log10x): budget run, ${budget.usd_monthly} USD a month on Standard`,
      );
    }
  } catch (err) {
    const result = budgetResult('error', `write failed: ${err instanceof Error ? err.message : String(err)} ${keep}`, extra);
    appendHistory(result);
    return result;
  }

  const result = budgetResult('applied', `applied: ${summary}`, { ...extra, history_path: HISTORY_FILE });
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
  // An older manifest names the checkout in LOG10X_GITOPS_REPO; a local path there is the checkout.
  const named = process.env.LOG10X_GITOPS_REPO;
  if (named && existsSync(named)) return named;
  // S3 config plane — stage under a stable temp path; state is pulled from
  // and pushed to the prefix around the tick.
  if (isS3ConfigPlane(repo)) {
    const slug = repo.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(-40);
    return pathJoin(tmpdir(), 'log10x-recur-s3', slug);
  }
  // Local path?
  if (!repo.startsWith('http://') && !repo.startsWith('https://') && !repo.startsWith('git@')) {
    return repo;
  }
  // URL — derive stable temp path.
  const slug = repo.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(-40);
  return pathJoin(tmpdir(), 'log10x-recur-repo', slug);
}

// ─── S3 config plane ───────────────────────────────────────────────────────

/**
 * An S3 prefix can serve as the config plane instead of a git repo — the
 * AWS-native path for estates with no cluster and no GitHub (the Lambda
 * engine polls `TENX_RECEIVE_MUTE_S3_URI` from the same prefix). Requires
 * the aws CLI on PATH; state moves with `aws s3 cp` so no SDK dependency
 * is added.
 */
export function isS3ConfigPlane(repo: string): boolean {
  return repo.startsWith('s3://');
}

/** The state files a tick reads back to compute the delta gate. */
const S3_STATE_FILES = [
  'data/action-intent.json',
  'pipelines/run/receive/compact/compact-cap.csv',
  'pipelines/run/receive/rate/mutes.csv',
];

/**
 * Pull prior state from the S3 prefix into the staging dir. Each object is
 * fetched independently and a miss is ignored — a first tick has no prior
 * state, and the delta gate treats absent files as "nothing applied yet".
 */
async function pullStateFromS3(repo: string, repoPath: string, verbose: boolean): Promise<void> {
  const base = repo.replace(/\/+$/, '');
  for (const rel of S3_STATE_FILES) {
    const dest = pathJoin(repoPath, ...rel.split('/'));
    mkdirSync(pathJoin(repoPath, ...rel.split('/').slice(0, -1)), { recursive: true });
    try {
      await execFileP('aws', ['s3', 'cp', `${base}/${rel}`, dest], { timeout: 30_000 });
    } catch {
      if (verbose) {
        process.stderr.write(`[tenx-recur] no prior ${rel} at the config plane (first tick?)\n`);
      }
    }
  }
}

/**
 * Upload the tick's output files to the S3 prefix. Any failure throws so the
 * caller reports an error status — a partially applied plane is surfaced,
 * never silent.
 */
async function pushStateToS3(repo: string, repoPath: string): Promise<void> {
  const base = repo.replace(/\/+$/, '');
  for (const rel of S3_STATE_FILES) {
    const src = pathJoin(repoPath, ...rel.split('/'));
    if (!existsSync(src)) continue;
    await execFileP('aws', ['s3', 'cp', src, `${base}/${rel}`], { timeout: 30_000 });
  }
}
