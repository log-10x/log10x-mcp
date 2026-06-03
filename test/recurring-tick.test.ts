/**
 * recurring-tick.ts tests.
 *
 * Tests use a mock Prometheus backend injected via the
 * LOG10X_CUSTOMER_METRICS_URL + LOG10X_CUSTOMER_METRICS_TYPE env vars and a
 * custom module mock pattern.  Because Node test runner doesn't have built-in
 * module mocking we patch the `loadBackendFromEnv` function by setting env
 * vars that route to the mock backend registered in customer-metrics.ts.
 *
 * Covers:
 *   1. Decision: ERROR severity → always 'pass' (floor)
 *   2. Decision: INFO over threshold → 'drop' / 'sample' / 'compact'
 *   3. Decision: excepted service → always 'pass'
 *   4. Delta gate: delta < min_delta_pp → status 'no_change'
 *   5. Dry-run flag: status 'dry_run', no files written
 *   6. Idempotency: same input → same output (deterministic)
 *   7. Target met early: remaining patterns pass once cumulative target reached
 *   8. Missing envId → throws Error (not PromUnreachableError)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

import { parsePolicyYaml } from '../src/lib/policy-loader.js';
import { runTick, PromUnreachableError } from '../src/lib/recurring-tick.js';
import type { Policy } from '../src/lib/policy-loader.js';

// ─── mock Prometheus backend ──────────────────────────────────────────────────

/**
 * Build a fake PrometheusResponse carrying the given pattern rows.
 */
function mockPromResponse(
  rows: Array<{ pattern: string; service: string; severity: string; bytes: number }>
): object {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: rows.map((r) => ({
        metric: {
          message_pattern: r.pattern,
          tenx_user_service: r.service,
          severity_level: r.severity,
        },
        value: [Date.now() / 1000, String(r.bytes)],
      })),
    },
  };
}

/**
 * Override the customer-metrics loadBackendFromEnv to return a mock backend
 * that serves the given rows.
 *
 * We monkey-patch the module export table.  This works in Node ESM because
 * the module namespace is live-bound.
 */
async function withMockBackend<T>(
  rows: Array<{ pattern: string; service: string; severity: string; bytes: number }>,
  fn: () => Promise<T>
): Promise<T> {
  // Dynamically import so we can get the live module namespace.
  const cm = await import('../src/lib/customer-metrics.js') as {
    loadBackendFromEnv: () => Promise<unknown>;
  } & Record<string, unknown>;

  const original = cm.loadBackendFromEnv;
  const response = mockPromResponse(rows);

  // Replace with a mock that returns a fake backend.
  (cm as Record<string, unknown>).loadBackendFromEnv = async () => ({
    backendType: 'mock',
    endpoint: 'mock://localhost',
    queryInstant: async (_q: string) => response,
    queryRange: async () => response,
    listLabels: async () => [],
    listLabelValues: async () => [],
  });

  try {
    return await fn();
  } finally {
    (cm as Record<string, unknown>).loadBackendFromEnv = original;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  // Create a temp dir for the gitops repo so file writes don't fail.
  const repoPath = pathJoin(tmpdir(), `log10x-test-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repoPath, { recursive: true });
  // Set the env var so resolveRepoPath picks it up.
  process.env.LOG10X_GITOPS_REPO_PATH = repoPath;

  return {
    schema_version: '1.0',
    target_services: [],
    target_percent: 30,
    exceptions: [],
    min_delta_pp: 2,
    lookback_window: '24h',
    severity_rules: {
      ERROR: 'keep',
      CRITICAL: 'keep',
      WARN: 'auto',
      INFO: 'auto',
      DEBUG: 'auto',
      TRACE: 'auto',
    },
    config_plane: {
      repo: repoPath,
      commit_strategy: 'direct_push',
    },
    ...overrides,
  };
}

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

// ─── tests ────────────────────────────────────────────────────────────────────

test('decision: ERROR severity always produces pass', async () => {
  const policy = makePolicy({ target_percent: 50 });
  process.env.LOG10X_ENV_ID = 'test-env';

  const result = await withMockBackend(
    [
      { pattern: 'hash-err', service: 'api', severity: 'ERROR', bytes: 1 * GB },
    ],
    () => runTick(policy, { dryRun: true })
  );

  const errDecision = result.applied_changes.find((d) => d.pattern_hash === 'hash-err');
  assert.ok(errDecision, 'ERROR pattern must appear in decisions');
  assert.equal(errDecision.action, 'pass', 'ERROR must always pass');
});

test('decision: excepted service always produces pass', async () => {
  const policy = makePolicy({
    exceptions: ['audit-svc'],
    target_percent: 80,
  });
  process.env.LOG10X_ENV_ID = 'test-env';

  const result = await withMockBackend(
    [
      { pattern: 'hash-audit', service: 'audit-svc', severity: 'INFO', bytes: 1 * GB },
      { pattern: 'hash-other', service: 'other-svc', severity: 'INFO', bytes: 500 * MB },
    ],
    () => runTick(policy, { dryRun: true })
  );

  const audit = result.applied_changes.find((d) => d.service === 'audit-svc');
  assert.ok(audit, 'audit-svc must appear in decisions');
  assert.equal(audit.action, 'pass', 'excepted service must pass');
});

test('decision: INFO high volume → drop', async () => {
  const policy = makePolicy({ target_percent: 95 });
  process.env.LOG10X_ENV_ID = 'test-env';

  const result = await withMockBackend(
    [
      { pattern: 'hash-info-big', service: 'worker', severity: 'INFO', bytes: 1 * GB },
    ],
    () => runTick(policy, { dryRun: true })
  );

  const d = result.applied_changes.find((d) => d.pattern_hash === 'hash-info-big');
  assert.ok(d);
  assert.equal(d.action, 'drop', `expected drop for 1GB INFO; got ${d.action}`);
});

test('decision: INFO moderate volume → sample', async () => {
  const policy = makePolicy({ target_percent: 95 });
  process.env.LOG10X_ENV_ID = 'test-env';

  const result = await withMockBackend(
    [
      { pattern: 'hash-info-mid', service: 'worker', severity: 'INFO', bytes: 100 * MB },
    ],
    () => runTick(policy, { dryRun: true })
  );

  const d = result.applied_changes.find((d) => d.pattern_hash === 'hash-info-mid');
  assert.ok(d);
  assert.equal(d.action, 'sample', `expected sample for 100 MB INFO; got ${d.action}`);
});

test('decision: INFO low-moderate volume → compact', async () => {
  const policy = makePolicy({ target_percent: 95 });
  process.env.LOG10X_ENV_ID = 'test-env';

  const result = await withMockBackend(
    [
      { pattern: 'hash-info-compact', service: 'worker', severity: 'INFO', bytes: 60 * MB },
    ],
    () => runTick(policy, { dryRun: true })
  );

  const d = result.applied_changes.find((d) => d.pattern_hash === 'hash-info-compact');
  assert.ok(d);
  assert.equal(d.action, 'compact', `expected compact for 60 MB INFO; got ${d.action}`);
});

test('decision: INFO below threshold → pass', async () => {
  const policy = makePolicy({ target_percent: 95 });
  process.env.LOG10X_ENV_ID = 'test-env';

  // 1 MB is well below the 50 MB default threshold.
  const result = await withMockBackend(
    [
      { pattern: 'hash-tiny', service: 'worker', severity: 'INFO', bytes: 1 * MB },
    ],
    () => runTick(policy, { dryRun: true })
  );

  const d = result.applied_changes.find((d) => d.pattern_hash === 'hash-tiny');
  assert.ok(d);
  assert.equal(d.action, 'pass', 'tiny pattern should pass');
});

test('delta gate: no prior state + small total → no_change when projected < min_delta_pp', async () => {
  // All patterns are tiny → projected_savings_pct ≈ 0, which is < min_delta_pp=2.
  const policy = makePolicy({ target_percent: 30, min_delta_pp: 2 });
  process.env.LOG10X_ENV_ID = 'test-env';

  const result = await withMockBackend(
    [
      { pattern: 'hash-a', service: 'svc', severity: 'INFO', bytes: 100 }, // < threshold
    ],
    () => runTick(policy, { dryRun: false })
  );

  // All bytes below threshold → all pass → 0% savings → delta = 0 < 2 → no_change.
  assert.equal(result.status, 'no_change', `expected no_change; got ${result.status}`);
});

test('dry-run: status is dry_run, no files written', async () => {
  const repoPath = pathJoin(tmpdir(), `log10x-dry-${Date.now()}`);
  mkdirSync(repoPath, { recursive: true });
  process.env.LOG10X_GITOPS_REPO_PATH = repoPath;

  const policy = makePolicy({ target_percent: 95, min_delta_pp: 0 });
  process.env.LOG10X_ENV_ID = 'test-env';

  const result = await withMockBackend(
    [
      { pattern: 'hash-big', service: 'worker', severity: 'INFO', bytes: 1 * GB },
    ],
    () => runTick(policy, { dryRun: true })
  );

  assert.equal(result.status, 'dry_run', `expected dry_run; got ${result.status}`);

  // No files should have been written.
  const intentPath = pathJoin(repoPath, 'data', 'action-intent.json');
  assert.ok(!existsSync(intentPath), 'action-intent.json must NOT be written in dry-run');
});

test('idempotency: same input produces same action set', async () => {
  const policy = makePolicy({ target_percent: 95, min_delta_pp: 0 });
  process.env.LOG10X_ENV_ID = 'test-env';

  const rows = [
    { pattern: 'hash-x', service: 'svc', severity: 'INFO', bytes: 1 * GB },
    { pattern: 'hash-y', service: 'svc', severity: 'DEBUG', bytes: 200 * MB },
    { pattern: 'hash-z', service: 'svc', severity: 'ERROR', bytes: 50 * MB },
  ];

  const r1 = await withMockBackend(rows, () => runTick(policy, { dryRun: true }));
  const r2 = await withMockBackend(rows, () => runTick(policy, { dryRun: true }));

  // Same action for each pattern on both runs.
  for (const d1 of r1.applied_changes) {
    const d2 = r2.applied_changes.find((d) => d.pattern_hash === d1.pattern_hash);
    assert.ok(d2, `pattern ${d1.pattern_hash} missing from second run`);
    assert.equal(d2.action, d1.action, `action mismatch for ${d1.pattern_hash}`);
  }
});

test('target met early: patterns after target met are passed', async () => {
  // Provide enough high-volume INFO patterns to meet 30% target on pattern #1 alone.
  const policy = makePolicy({ target_percent: 30, min_delta_pp: 0 });
  process.env.LOG10X_ENV_ID = 'test-env';

  const result = await withMockBackend(
    [
      // Pattern A: 800 MB — will be dropped → saves 800 MB = 80% of total
      { pattern: 'hash-a', service: 'svc', severity: 'INFO', bytes: 800 * MB },
      // Pattern B: 200 MB — target already met by A
      { pattern: 'hash-b', service: 'svc', severity: 'INFO', bytes: 200 * MB },
    ],
    () => runTick(policy, { dryRun: true })
  );

  const a = result.applied_changes.find((d) => d.pattern_hash === 'hash-a');
  const b = result.applied_changes.find((d) => d.pattern_hash === 'hash-b');
  assert.ok(a && b, 'both patterns must be present');
  // A should be dropped (high volume INFO).
  assert.notEqual(a.action, 'pass', 'pattern A should NOT pass (it drives savings)');
  // B should pass once target is met.
  assert.equal(b.action, 'pass', 'pattern B must pass after target met');
});

test('missing envId → throws Error', async () => {
  // Remove env var to force the missing-envId path.
  const saved = process.env.LOG10X_ENV_ID;
  delete process.env.LOG10X_ENV_ID;

  const policy = makePolicy();
  delete (policy.config_plane as { env_id?: string }).env_id;

  try {
    await assert.rejects(
      () => withMockBackend([], () => runTick(policy, { dryRun: true })),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!/PromUnreachable/.test((err as Error).name));
        return true;
      }
    );
  } finally {
    if (saved !== undefined) process.env.LOG10X_ENV_ID = saved;
  }
});

test('projected_savings_pct is 0..100', async () => {
  const policy = makePolicy({ target_percent: 95, min_delta_pp: 0 });
  process.env.LOG10X_ENV_ID = 'test-env';

  const result = await withMockBackend(
    [
      { pattern: 'h1', service: 's', severity: 'INFO', bytes: 500 * MB },
    ],
    () => runTick(policy, { dryRun: true })
  );

  assert.ok(result.projected_savings_pct >= 0, 'projected_savings_pct must be >= 0');
  assert.ok(result.projected_savings_pct <= 100, 'projected_savings_pct must be <= 100');
});

test('applied_changes always includes all queried patterns', async () => {
  const policy = makePolicy({ target_percent: 50, min_delta_pp: 0 });
  process.env.LOG10X_ENV_ID = 'test-env';

  const rows = [
    { pattern: 'p1', service: 's', severity: 'ERROR', bytes: 1 * GB },
    { pattern: 'p2', service: 's', severity: 'INFO',  bytes: 500 * MB },
    { pattern: 'p3', service: 's', severity: 'DEBUG', bytes: 10 * MB },
  ];

  const result = await withMockBackend(rows, () => runTick(policy, { dryRun: true }));

  assert.equal(result.applied_changes.length, rows.length, 'all rows must appear in applied_changes');
});
