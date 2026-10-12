/**
 * Every per-GB default is labelled for what it is wherever it is printed: a
 * list price only where the vendor sells logs per GB, and a default rate
 * everywhere else. Datadog's default also states Datadog's own units.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ANALYZER_COST_PER_GB,
  DEFAULT_RATE_BASIS,
  defaultRateLabel,
  describeDefaultRate,
  siemIdOf,
} from '../src/lib/siem/pricing.js';
import { buildDisclosedDollarValue } from '../src/lib/cost.js';
import { INDUSTRY_PRICING } from '../src/tools/poc-from-local.js';
import { SERVER_INSTRUCTIONS } from '../src/lib/server-instructions.js';
import { solvePlan } from '../src/lib/plan-solver.js';

test('every destination has a rate basis', () => {
  assert.deepEqual(Object.keys(DEFAULT_RATE_BASIS).sort(), Object.keys(DEFAULT_ANALYZER_COST_PER_GB).sort());
});

test('Datadog and Splunk defaults are default rates; per-GB vendors keep list price', () => {
  for (const d of ['datadog', 'splunk', 'elasticsearch', 'sumo', 'clickhouse']) assert.equal(defaultRateLabel(d), 'default rate', d);
  for (const d of ['cloudwatch', 'gcp-logging', 'azure-monitor']) assert.equal(defaultRateLabel(d), 'list price', d);
  assert.equal(siemIdOf('Datadog'), 'datadog');
  assert.equal(defaultRateLabel('Amazon CloudWatch Logs'), 'list price');
  assert.equal(defaultRateLabel('somewhere-unknown'), 'default rate');
});

test('the Datadog default states Datadog list prices in Datadog units', () => {
  const t = describeDefaultRate('datadog');
  assert.match(t, /^the Datadog default rate \$2\.50\/GB, a per-GB default, not a Datadog list price/);
  assert.match(t, /\$0\.10 per GB ingested/);
  assert.match(t, /\$2\.50 per million events indexed at 30-day retention, billed annually/);
  assert.equal(describeDefaultRate('splunk'), 'the Splunk default rate $6/GB, a per-GB default, not a Splunk list price');
  assert.equal(describeDefaultRate('cloudwatch'), 'Amazon CloudWatch Logs list price $0.50/GB');
});

test('a disclosed dollar never calls the Datadog or Splunk default a list price', () => {
  for (const [label, rate] of [['Datadog', 2.5], ['Splunk', 6]] as const) {
    const d = buildDisclosedDollarValue(100, 'list_price', label, rate).disclosure ?? '';
    assert.match(d, new RegExp(`the ${label} default rate`));
    assert.ok(!new RegExp(`at ${label} list price`).test(d), d);
  }
  const cw = buildDisclosedDollarValue(100, 'list_price', 'Amazon CloudWatch Logs', 0.5).disclosure ?? '';
  assert.match(cw, /Amazon CloudWatch Logs list price \$0\.50\/GB/);
});

test('poc_from_local: no default-rate vendor row says list price, and Datadog shows its units', () => {
  const byVendor = Object.fromEntries(INDUSTRY_PRICING.map((r) => [r.vendor, r.note]));
  for (const v of ['Datadog', 'Splunk', 'Sumo Logic', 'Elasticsearch']) {
    assert.match(byVendor[v], /^default rate/, v);
    assert.ok(!/(^|, )list price/.test(byVendor[v]), `${v}: ${byVendor[v]}`);
  }
  assert.match(byVendor.Datadog, /\$0\.10 per GB ingested and \$2\.50 per million events indexed at 30-day retention/);
});

test('the agent rate card labels each default', () => {
  assert.match(SERVER_INSTRUCTIONS, /Splunk \$6\/GB \(default rate\)/);
  assert.match(SERVER_INSTRUCTIONS, /Datadog \$2\.50\/GB \(default rate\)/);
  assert.match(SERVER_INSTRUCTIONS, /CloudWatch \$0\.50\/GB \(list price\)/);
  assert.ok(!/Typical rates if unspecified/.test(SERVER_INSTRUCTIONS));
});

test('a plan on Datadog names its basis as the default rate', () => {
  const pl = solvePlan(
    [{ hash: 'a', name: 'noisy', services: { api: 1e11 }, severity: 'INFO', bytes: 1e11, avgEventBytes: 1000 }],
    { destination: 'datadog', retrieverInstalled: false, targetPct: 30 },
  );
  assert.match(pl.rateBasis, /^datadog default rate: all-in \$2\.5\/GB/);
  assert.ok(!/datadog list price/.test(pl.rateBasis), pl.rateBasis);
});
