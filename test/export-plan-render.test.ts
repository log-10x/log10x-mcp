/**
 * Export-plan emitters: golden rendering, sampling parity with the live
 * connectors, and the two refusals the fenced profile rests on.
 *
 * The golden files are the review surface. These scripts are what a
 * customer's security reviewer reads before pointing anything at their own
 * logs, so a change to what we ask them to run should show up as a diff a
 * human looks at, not as a test that quietly still passes.
 *
 * Regenerate deliberately, after reading the diff:
 *   UPDATE_EXPORT_PLAN_GOLDEN=1 npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  emitSamplePlan,
  hasExportPlan,
  UnsupportedExportSiemError,
  EXPORT_PLAN_SIEMS,
  DEFAULT_TARGET_EVENT_COUNT,
  type SamplePlanOptions,
} from '../src/lib/siem/export-plan/index.js';
import { perBucketCap, randomTimeBuckets } from '../src/lib/siem/_sampling.js';
import { CLOUDWATCH_BUCKET_COUNT } from '../src/lib/siem/cloudwatch.js';
import { SPLUNK_BUCKET_COUNT } from '../src/lib/siem/splunk.js';
import { ELASTICSEARCH_BUCKET_COUNT } from '../src/lib/siem/elasticsearch.js';
import { DATADOG_BUCKET_COUNT } from '../src/lib/siem/datadog.js';
import { assertNoVendorHost, shQuote } from '../src/lib/siem/export-plan/_shared.js';

const FIXTURE_DIR = join(process.cwd(), 'test', 'fixtures', 'export-plan');
const UPDATE = process.env.UPDATE_EXPORT_PLAN_GOLDEN === '1';

/** Fixed clock: 2026-08-27T12:00:00Z. */
const NOW_MS = Date.parse('2026-08-27T12:00:00.000Z');

/**
 * Seeded linear-congruential RNG. `randomTimeBuckets` takes an injectable
 * `rng` precisely so bucket offsets can be pinned here; production callers
 * leave it unset and get `Math.random`, which is what makes two POC runs over
 * the same window read different slices of the customer's logs.
 */
function seededRng(): () => number {
  let seed = 42;
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

interface GoldenCase {
  name: string;
  options: Omit<SamplePlanOptions, 'nowMs' | 'rng'>;
}

const CASES: GoldenCase[] = [
  {
    name: 'cloudwatch',
    options: { siem: 'cloudwatch', window: '14d', targetEventCount: 1_000_000, scope: '/aws/ecs/*' },
  },
  {
    name: 'cloudwatch-unscoped',
    options: { siem: 'cloudwatch', window: '24h', targetEventCount: 50_000 },
  },
  {
    name: 'splunk',
    options: {
      siem: 'splunk',
      window: '14d',
      targetEventCount: 1_000_000,
      scope: 'main',
      query: 'sourcetype=access_combined',
    },
  },
  {
    name: 'elasticsearch',
    options: { siem: 'elasticsearch', window: '7d', targetEventCount: 500_000, scope: 'logs-*' },
  },
  {
    name: 'opensearch',
    options: {
      siem: 'opensearch',
      window: '7d',
      targetEventCount: 500_000,
      scope: 'app-logs-*',
      query: 'service:checkout',
    },
  },
  {
    name: 'datadog',
    options: { siem: 'datadog', window: '14d', targetEventCount: 1_000_000, scope: 'main' },
  },
];

function render(c: GoldenCase) {
  return emitSamplePlan({ ...c.options, nowMs: NOW_MS, rng: seededRng() });
}

// ── Golden rendering ──

for (const c of CASES) {
  test(`golden: ${c.name} renders byte-identically`, () => {
    const script = render(c).script;
    const file = join(FIXTURE_DIR, `${c.name}.golden.sh`);
    if (UPDATE) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(file, script);
      return;
    }
    assert.ok(existsSync(file), `missing golden ${file}; create it with UPDATE_EXPORT_PLAN_GOLDEN=1 npm test`);
    assert.equal(
      script,
      readFileSync(file, 'utf8'),
      `${c.name} export script drifted from its golden. This is the text a customer's security ` +
        `reviewer reads before running it against their own logs — read the diff, then regenerate ` +
        `with UPDATE_EXPORT_PLAN_GOLDEN=1 npm test.`,
    );
  });
}

// ── No vendor host, per SIEM ──

for (const c of CASES) {
  test(`${c.name}: the emitted script names no log10x address`, () => {
    const script = render(c).script;
    const hosts = script.match(/(?:https?:\/\/)?(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g) ?? [];
    for (const host of hosts) {
      const labels = host.replace(/^https?:\/\//, '').toLowerCase().split('.');
      for (const label of ['log10x', 'log-10x', 'tenx', '10x']) {
        assert.ok(
          !labels.includes(label),
          `${c.name} script names "${host}" — emitted scripts must reach the user's analyzer and nothing else`,
        );
      }
    }
  });
}

test('assertNoVendorHost refuses a script carrying our address', () => {
  assert.throws(
    () => assertNoVendorHost('curl https://api.log10x.com/api/v1/license/demo', 'test'),
    /naming the host/,
  );
  // The brand in a comment is fine; the check is about addresses, not words.
  assert.doesNotThrow(() => assertNoVendorHost('# log10x fenced POC\ncurl https://api.datadoghq.com', 'test'));
});

// ── Sampling parity with the live connectors ──

const EXPECTED_BUCKETS: Record<string, number> = {
  cloudwatch: CLOUDWATCH_BUCKET_COUNT,
  splunk: SPLUNK_BUCKET_COUNT,
  elasticsearch: ELASTICSEARCH_BUCKET_COUNT,
  opensearch: ELASTICSEARCH_BUCKET_COUNT,
  datadog: DATADOG_BUCKET_COUNT,
};

for (const siem of EXPORT_PLAN_SIEMS) {
  test(`${siem}: bucket count and per-bucket cap come from the connector, not a retyped constant`, () => {
    const plan = emitSamplePlan({
      siem,
      window: '14d',
      targetEventCount: DEFAULT_TARGET_EVENT_COUNT,
      nowMs: NOW_MS,
      rng: seededRng(),
    });
    assert.equal(plan.bucketCount, EXPECTED_BUCKETS[siem]);
    assert.equal(plan.perBucketCap, perBucketCap(DEFAULT_TARGET_EVENT_COUNT, EXPECTED_BUCKETS[siem]));
  });
}

test('the rendered sub-windows are the ones randomTimeBuckets draws', () => {
  const plan = emitSamplePlan({
    siem: 'cloudwatch',
    window: '14d',
    targetEventCount: 1_000_000,
    nowMs: NOW_MS,
    rng: seededRng(),
  });
  const expected = randomTimeBuckets(
    NOW_MS - 14 * 86_400_000,
    NOW_MS,
    CLOUDWATCH_BUCKET_COUNT,
    seededRng(),
  );
  // CloudWatch takes epoch milliseconds, so the array is literal integers.
  const rendered = /BUCKET_FROM=\(([^)]*)\)/.exec(plan.script)?.[1].split(' ').map(Number);
  assert.deepEqual(rendered, expected.map((b) => b.fromMs));
});

test('the default target matches log10x_poc_from_siem so both paths sample the same size', () => {
  assert.equal(DEFAULT_TARGET_EVENT_COUNT, 1_000_000);
});

// ── Argument handling ──

test('shQuote makes a hostile scope inert rather than executable', () => {
  const quoted = shQuote(`'; curl attacker.example; echo '`);
  assert.equal(quoted, `''\\''; curl attacker.example; echo '\\'''`);
});

test('a scope carrying shell metacharacters lands quoted, not interpolated', () => {
  const plan = emitSamplePlan({
    siem: 'splunk',
    window: '1h',
    targetEventCount: 1_000,
    scope: `main"; rm -rf /; echo "`,
    nowMs: NOW_MS,
    rng: seededRng(),
  });
  assert.ok(!/^\s*rm -rf/m.test(plan.script), 'the scope must not reach the script as a command');
  assert.ok(plan.script.includes('SPL='), 'the search still renders');
});

// ── The follow-up analyzers refuse by name ──

test('an analyzer with no emitter refuses and names what does exist', () => {
  assert.equal(hasExportPlan('clickhouse'), false);
  assert.throws(
    () => emitSamplePlan({ siem: 'clickhouse' as never, window: '14d', targetEventCount: 1_000 }),
    (e: Error) => {
      assert.ok(e instanceof UnsupportedExportSiemError);
      assert.match(e.message, /ClickHouse/);
      assert.match(e.message, /cloudwatch/);
      return true;
    },
  );
});

test('every registered SIEM renders, and every script is a bash script that starts with a shebang', () => {
  for (const siem of EXPORT_PLAN_SIEMS) {
    const plan = emitSamplePlan({ siem, window: '7d', targetEventCount: 10_000, nowMs: NOW_MS, rng: seededRng() });
    assert.ok(plan.script.startsWith('#!/usr/bin/env bash\n'), `${siem} has no shebang`);
    assert.ok(plan.script.includes('set -euo pipefail'), `${siem} does not fail fast`);
    assert.ok(plan.script.includes('WHAT THIS READS'), `${siem} has no review header`);
    assert.ok(plan.script.includes('WHAT THIS WRITES'), `${siem} does not say what it writes`);
    assert.ok(plan.script.includes('WHAT ELSE IT DOES'), `${siem} does not say what else it does`);
  }
});
