/**
 * The estate-level denominator, pinned at the call site.
 *
 * `totals.compute_saving` is the one place a ClickHouse compute figure comes
 * from, and the whole reason it lives on the totals rather than on a row is
 * that reading rows-kept off one pattern is wrong: a single offloaded pattern
 * resolves to zero rows kept and claims the entire compute bill of a cluster
 * it is a twentieth of. `test/cost.test.ts` pins the arithmetic; this pins
 * what `runEstimateForecast` actually passes in, against a stubbed metrics
 * backend so nothing here touches a network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runEstimateForecast } from '../src/tools/estimate-savings.js';
import { DEFAULT_LABELS } from '../src/lib/promql.js';
import type { EnvConfig } from '../src/lib/environments.js';

const BYTES_METRIC = 'all_events_summaryBytes_total';
const VOLUME_METRIC = 'all_events_summaryVolume_total';

// One noisy pattern and four quiet ones. The noisy one carries a fifth of the
// events, so offloading it alone must leave rows_kept_fraction at 0.8 and
// nowhere near 0.
const NOISY = { hash: 'h_noisy', events: 200_000, bytes: 100_000_000 };
const QUIET = [
  { hash: 'h_q1', events: 200_000, bytes: 100_000_000 },
  { hash: 'h_q2', events: 200_000, bytes: 100_000_000 },
  { hash: 'h_q3', events: 200_000, bytes: 100_000_000 },
  { hash: 'h_q4', events: 200_000, bytes: 100_000_000 },
];
const ALL = [NOISY, ...QUIET];
const TOTAL_EVENTS = ALL.reduce((a, p) => a + p.events, 0);

function series(rows: Array<{ labels: Record<string, string>; value: number }>) {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: rows.map((r) => ({ metric: r.labels, value: [0, String(r.value)] })),
    },
  };
}

function stubEnv(): EnvConfig {
  const backend = {
    // The forecast fires five instant queries in parallel and tolerates a null
    // from any one of them. Answer by inspecting the PromQL, the way the real
    // backend distinguishes them: by which metric and which grouping.
    async queryInstant(promql: string) {
      const byHash = promql.includes(`by (${DEFAULT_LABELS.hash})`);
      if (promql.includes(VOLUME_METRIC) && byHash) {
        return series(ALL.map((p) => ({ labels: { [DEFAULT_LABELS.hash]: p.hash }, value: p.events })));
      }
      if (promql.includes(BYTES_METRIC) && byHash) {
        return series(ALL.map((p) => ({ labels: { [DEFAULT_LABELS.hash]: p.hash }, value: p.bytes })));
      }
      if (promql.includes(`by (${DEFAULT_LABELS.hash},`)) {
        // hash + service + pattern + severity enrichment leg.
        return series(
          ALL.map((p) => ({
            labels: {
              [DEFAULT_LABELS.hash]: p.hash,
              [DEFAULT_LABELS.service]: 'checkout',
              [DEFAULT_LABELS.pattern]: `pattern_${p.hash}`,
              [DEFAULT_LABELS.severity]: 'INFO',
            },
            value: p.bytes,
          })),
        );
      }
      if (promql.includes(BYTES_METRIC)) {
        return series([{ labels: {}, value: ALL.reduce((a, p) => a + p.bytes, 0) }]);
      }
      // distinct pattern count, metrics-env probe, anything else.
      return series([{ labels: {}, value: ALL.length }]);
    },
    async queryRange() {
      return series([]);
    },
  };
  return {
    nickname: 'stub',
    labels: { ...DEFAULT_LABELS },
    metricsBackend: backend,
  } as unknown as EnvConfig;
}

test('offloading one pattern of five leaves four fifths of the rows inserted', async () => {
  const result = await runEstimateForecast(
    {
      destination: 'clickhouse',
      retention_months: 1,
      observation_window: '30d',
      proposed_config: [{ pattern_hash: NOISY.hash, action: 'offload' }],
    },
    stubEnv(),
  );

  const cs = result.totals.compute_saving;
  assert.ok(cs, 'a clickhouse forecast must carry an estate-level compute saving');

  // The defect this pins: reading rows kept off the offloaded pattern alone
  // would give 0 here, and 0 rows kept means the whole compute bill.
  assert.ok(cs.rows_kept_fraction > 0, `rows_kept_fraction was ${cs.rows_kept_fraction}`);

  const expected = 1 - NOISY.events / TOTAL_EVENTS;
  assert.ok(
    Math.abs(cs.rows_kept_fraction - expected) < 1e-9,
    `rows_kept_fraction ${cs.rows_kept_fraction} should be 1 minus this pattern's share of the whole input (${expected})`,
  );

  // Event counts were available, so the fraction is a real row share and not
  // bytes wearing a row's name.
  assert.equal(cs.basis, 'rows-inserted');
  assert.equal(cs.modeled, true);
  assert.equal(result.totals.modeled, true);
});

test('with no unit count the estate compute saving is a fraction, and asks for one', async () => {
  const result = await runEstimateForecast(
    {
      destination: 'clickhouse',
      retention_months: 1,
      observation_window: '30d',
      proposed_config: [{ pattern_hash: NOISY.hash, action: 'offload' }],
    },
    stubEnv(),
  );
  const cs = result.totals.compute_saving!;
  assert.equal(cs.units_before, undefined);
  assert.equal(cs.saving_usd_month, undefined);
  assert.match(cs.note, /supply current compute units or monthly compute spend/);
});

test('a supplied unit count turns the estate compute saving into dollars', async () => {
  const result = await runEstimateForecast(
    {
      destination: 'clickhouse',
      retention_months: 1,
      observation_window: '30d',
      proposed_config: [{ pattern_hash: NOISY.hash, action: 'offload' }],
      current_compute_units: 100,
    },
    stubEnv(),
  );
  const cs = result.totals.compute_saving!;
  assert.equal(cs.units_before, 100);
  assert.ok(cs.units_after! < 100);
  assert.ok(cs.saving_usd_month! > 0);
});

test('a metered destination carries no compute saving on its totals', async () => {
  const result = await runEstimateForecast(
    {
      destination: 'splunk',
      retention_months: 1,
      observation_window: '30d',
      proposed_config: [{ pattern_hash: NOISY.hash, action: 'offload' }],
    },
    stubEnv(),
  );
  assert.equal(result.totals.compute_saving, undefined);
  assert.equal(result.totals.modeled, false);
});
