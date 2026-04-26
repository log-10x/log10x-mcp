import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ANALYZER_COST_PER_GB,
  SIEM_DISPLAY_NAMES,
  getAnalyzerCostForSiem,
} from '../../src/lib/siem/pricing.js';

test('all 8 SIEMs have pricing defined', () => {
  const ids = Object.keys(DEFAULT_ANALYZER_COST_PER_GB).sort();
  assert.deepEqual(ids, [
    'azure-monitor',
    'clickhouse',
    'cloudwatch',
    'datadog',
    'elasticsearch',
    'gcp-logging',
    'splunk',
    'sumo',
  ]);
});

test('pricing matches vendors.json values for the primary SIEMs', () => {
  // From /Users/talweiss/git/l1x-co/backend/terraform/console/ui/src/vendors.json
  assert.equal(DEFAULT_ANALYZER_COST_PER_GB.splunk, 6);
  assert.equal(DEFAULT_ANALYZER_COST_PER_GB.datadog, 2.5);
  assert.equal(DEFAULT_ANALYZER_COST_PER_GB.elasticsearch, 1);
  assert.equal(DEFAULT_ANALYZER_COST_PER_GB.cloudwatch, 0.5);
  assert.equal(DEFAULT_ANALYZER_COST_PER_GB['azure-monitor'], 2.3);
  assert.equal(DEFAULT_ANALYZER_COST_PER_GB['gcp-logging'], 0.5);
  assert.equal(DEFAULT_ANALYZER_COST_PER_GB.sumo, 0.25);
});

test('every SIEM has a human-readable display name', () => {
  for (const id of Object.keys(DEFAULT_ANALYZER_COST_PER_GB)) {
    assert.ok(
      SIEM_DISPLAY_NAMES[id as keyof typeof SIEM_DISPLAY_NAMES]?.length > 0,
      `${id} missing display name`
    );
  }
});

test('getAnalyzerCostForSiem respects override', () => {
  assert.equal(getAnalyzerCostForSiem('splunk'), 6);
  assert.equal(getAnalyzerCostForSiem('splunk', 12.5), 12.5);
});

test('getAnalyzerCostForSiem falls back to default for invalid override', () => {
  assert.equal(getAnalyzerCostForSiem('datadog', 0), 2.5);
  assert.equal(getAnalyzerCostForSiem('datadog', -1), 2.5);
  assert.equal(getAnalyzerCostForSiem('datadog', NaN), 2.5);
});
