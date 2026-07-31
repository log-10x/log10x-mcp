/**
 * Guards that `elastic-serverless` is reachable through the TOOL SURFACE and
 * priced as its own product.
 *
 * The defect this fixes: a single `elasticsearch` entry, explicitly commented
 * as a self-hosted assumption, was applied to Elastic Cloud Serverless tenants
 * too. Self-hosted is modelled at $1/GB (a blended infrastructure figure from
 * vendors.json); Serverless publishes $0.07/GB ingested. Billing a Serverless
 * tenant against the self-hosted rate overstates their spend ~14x and inflates
 * every savings number in proportion.
 *
 * The roster tests mirror the coralogix ones because the same six zod/array
 * enumerations are invisible to `tsc` and shipped broken last time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { estimateSavingsSchema } from '../src/tools/estimate-savings.js';
import { baselineSchema } from '../src/tools/baseline.js';
import { destSetSchema } from '../src/tools/env-config-manage.js';
import { costOptionsSchema } from '../src/tools/cost-options.js';
import { envConfigFromEnvVars } from '../src/lib/env-config/env-var-bridge.js';
import { siemDestinationSchema } from '../src/lib/env-config/types.js';
import { DEFAULT_ANALYZER_COST_PER_GB } from '../src/lib/siem/pricing.js';
import { COST_MODEL_BY_DESTINATION, getAllowedActionsForDestination } from '../src/lib/cost.js';

function parseField(shape: Record<string, unknown>, field: string, value: unknown) {
  const s = shape[field];
  assert.ok(s, `schema has no field '${field}'`);
  return (s as z.ZodTypeAny).parse(value);
}

test('elastic-serverless is priced as its own product, not as self-hosted', () => {
  const ss = DEFAULT_ANALYZER_COST_PER_GB['elastic-serverless'];
  const self = DEFAULT_ANALYZER_COST_PER_GB.elasticsearch;
  assert.ok(ss > 0, 'no rate');
  assert.notEqual(ss, self, 'serverless must not inherit the self-hosted blended rate');
  assert.ok(ss < self, 'serverless ingest is far cheaper than the self-hosted infra blend');
  // Pin the published floor. If someone "rounds" this, the diff should show it.
  assert.equal(ss, 0.07, 'Elastic publishes "as low as $0.07/GB ingested" (Logs Essentials)');
  assert.equal(
    COST_MODEL_BY_DESTINATION['elastic-serverless'].storage_per_gb_month,
    0.017,
    'Elastic publishes "as low as $0.017/GB retained per month"'
  );
});

test('elastic-serverless bills on ingest, self-hosted on indexed volume', () => {
  assert.equal(COST_MODEL_BY_DESTINATION['elastic-serverless'].billing_basis, 'uncompressed-ingest');
  assert.equal(COST_MODEL_BY_DESTINATION.elasticsearch.billing_basis, 'indexed-uncompressed');
});

test('compact is offered on serverless; tier_down is NOT', () => {
  const actions = getAllowedActionsForDestination('elastic-serverless');
  assert.ok(actions.includes('compact'), 'index-pruned compact is real here and lands on the ingest line');
  assert.ok(
    !actions.includes('tier_down'),
    'serverless retention is already near object-storage cost — there is no premium tier to escape, ' +
      'and the frozen-tier lever has not been proven on a live deployment'
  );
});

test('estimate_savings accepts destination=elastic-serverless', () => {
  assert.equal(parseField(estimateSavingsSchema, 'destination', 'elastic-serverless'), 'elastic-serverless');
});

test('cost_options -> estimate_savings handoff is not a guaranteed failure', () => {
  const accepted = parseField(costOptionsSchema, 'destination', 'elastic-serverless');
  assert.doesNotThrow(() => parseField(estimateSavingsSchema, 'destination', accepted));
});

test('baseline and dest_set accept elastic-serverless', () => {
  assert.equal(parseField(baselineSchema, 'destination', 'elastic-serverless'), 'elastic-serverless');
  assert.equal(parseField(destSetSchema, 'siem_vendor', 'elastic-serverless'), 'elastic-serverless');
  assert.doesNotThrow(() => siemDestinationSchema.parse({ siem_vendor: 'elastic-serverless' }));
});

test('LOG10X_SIEM_VENDOR=elastic-serverless reaches the stored config', () => {
  const cfg = envConfigFromEnvVars({ LOG10X_SIEM_VENDOR: 'elastic-serverless' } as NodeJS.ProcessEnv);
  assert.equal(
    (cfg as { destination?: { siem_vendor?: string } })?.destination?.siem_vendor,
    'elastic-serverless',
    'env var silently dropped'
  );
});

test('analyzer sniffing puts serverless BEFORE the bare elastic match', async () => {
  const { _internals } = await import('../src/tools/baseline.js');
  const detect = (analyzer: string) =>
    _internals.autoDetectDestination({ analyzer } as unknown as Parameters<typeof _internals.autoDetectDestination>[0]);

  // The ordering bug: `elastic` matches "elastic serverless" too, so a later
  // serverless clause never fires and the tenant is billed at $1/GB.
  for (const s of ['elastic serverless', 'Elastic Cloud Serverless', 'elasticsearch-serverless']) {
    assert.equal(detect(s), 'elastic-serverless', `"${s}" misdetected`);
  }
  // Self-hosted spellings must be untouched.
  for (const s of ['elasticsearch', 'elastic', 'es', 'opensearch']) {
    assert.equal(detect(s), 'elasticsearch', `"${s}" should stay self-hosted`);
  }
});
