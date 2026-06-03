#!/usr/bin/env node
/**
 * tenx-recur — deterministic recurring cost-reduction tick runner.
 *
 * Usage:
 *   tenx-recur --policy <path-to-policy.yaml> [--dry-run] [--verbose]
 *
 * Exit codes:
 *   0  success (applied) or no-op (delta below threshold)
 *   1  policy error (bad YAML, missing required field)
 *   2  Prometheus unreachable
 *   3  commit failed (git / gh error)
 *
 * One invocation runs one tick.  The external scheduler (k8s CronJob,
 * GitHub Actions, crontab) is responsible for calling this on schedule.
 *
 * Environment variables consumed:
 *   LOG10X_ENV_ID              — 10x environment ID (overrides policy config_plane.env_id)
 *   LOG10X_API_KEY             — API key for hosted log10x Prometheus backend
 *   LOG10X_CUSTOMER_METRICS_URL  — Prometheus/Mimir/… base URL (customer self-hosted)
 *   LOG10X_CUSTOMER_METRICS_TYPE — backend type (see customer-metrics.ts)
 *   LOG10X_CUSTOMER_METRICS_AUTH — auth credential
 *   LOG10X_GITOPS_REPO_PATH    — local path to the cloned gitops repo
 *   LOG10X_RETRY_BASE_MS       — retry base delay in ms (default 250)
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import process from 'node:process';

import { parsePolicyYaml, PolicyLoadError } from '../lib/policy-loader.js';
import { runTick, PromUnreachableError } from '../lib/recurring-tick.js';

// ─── arg parsing ──────────────────────────────────────────────────────────

interface CliArgs {
  policyPath: string;
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  // argv[0] = node, argv[1] = script path
  const args = argv.slice(2);

  let policyPath = '';
  let dryRun = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--policy' || arg === '-p') {
      policyPath = args[++i] ?? '';
    } else if (arg.startsWith('--policy=')) {
      policyPath = arg.slice('--policy='.length);
    } else if (arg === '--dry-run' || arg === '--dryRun') {
      dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      printError(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  if (!policyPath) {
    printError('--policy <path> is required');
    printUsage();
    process.exit(1);
  }

  return { policyPath, dryRun, verbose };
}

function printUsage(): void {
  process.stderr.write(
    [
      'Usage: tenx-recur --policy <path-to-policy.yaml> [--dry-run] [--verbose]',
      '',
      'Options:',
      '  --policy <path>   Path to the policy.yaml file (required)',
      '  --dry-run         Print what would change without writing or committing',
      '  --verbose         Print PromQL queries and decision details',
      '  --help            Print this message',
      '',
      'Exit codes:',
      '  0  success (applied or no-op)',
      '  1  policy error',
      '  2  Prometheus unreachable',
      '  3  commit failed',
      '',
    ].join('\n')
  );
}

function printError(msg: string): void {
  process.stderr.write(`[tenx-recur] error: ${msg}\n`);
}

function printInfo(msg: string): void {
  process.stderr.write(`[tenx-recur] ${msg}\n`);
}

// ─── structured run log ───────────────────────────────────────────────────

function printRunSummary(result: Awaited<ReturnType<typeof runTick>>): void {
  const summary = {
    ts: new Date().toISOString(),
    status: result.status,
    projected_savings_pct: parseFloat(result.projected_savings_pct.toFixed(2)),
    delta_patterns: result.delta_patterns,
    delta_pp: parseFloat(result.delta_pp.toFixed(2)),
    message: result.message,
    ...(result.history_path ? { history_path: result.history_path } : {}),
  };
  // Structured one-line JSON to stdout — parseable by log aggregators.
  process.stdout.write(JSON.stringify(summary) + '\n');
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { policyPath, dryRun, verbose } = parseArgs(process.argv);

  // ── load policy ──────────────────────────────────────────────────────────
  let policyText: string;
  try {
    policyText = readFileSync(resolvePath(policyPath), 'utf8');
  } catch (err) {
    printError(`cannot read policy file "${policyPath}": ${String(err)}`);
    process.exit(1);
  }

  let policy;
  try {
    policy = parsePolicyYaml(policyText);
  } catch (err) {
    if (err instanceof PolicyLoadError) {
      printError(`policy parse error: ${err.message}`);
    } else {
      printError(`unexpected error loading policy: ${String(err)}`);
    }
    process.exit(1);
  }

  if (verbose) {
    printInfo(
      `policy loaded: target=${policy.target_percent}% ` +
      `services=${policy.target_services.length === 0 ? 'all' : policy.target_services.join(',')} ` +
      `lookback=${policy.lookback_window} ` +
      `min_delta=${policy.min_delta_pp}pp ` +
      (dryRun ? '[DRY RUN]' : '')
    );
  }

  // ── run tick ─────────────────────────────────────────────────────────────
  let result;
  try {
    result = await runTick(policy, { dryRun, verbose });
  } catch (err) {
    if (err instanceof PromUnreachableError) {
      printError(`prometheus unreachable: ${err.message}`);
      process.exit(2);
    }
    printError(`unexpected error: ${String(err)}`);
    if (verbose && err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
    process.exit(1);
  }

  printRunSummary(result);

  if (verbose) {
    const actionCounts: Record<string, number> = {};
    for (const d of result.applied_changes) {
      actionCounts[d.action] = (actionCounts[d.action] ?? 0) + 1;
    }
    printInfo(
      `actions: ${Object.entries(actionCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([a, n]) => `${a}=${n}`)
        .join(' ')}`
    );
  }

  if (result.status === 'error') {
    printError(result.message);
    process.exit(3);
  }

  // status 'no_change', 'applied', 'dry_run' → exit 0
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`[tenx-recur] fatal: ${String(err)}\n`);
  process.exit(1);
});
