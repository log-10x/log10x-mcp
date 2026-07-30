/**
 * Guards that `coralogix` is reachable through the TOOL SURFACE, not just
 * present in the cost model.
 *
 * These exist because a review caught the opposite shipping: the cost model
 * entry was added and the type-level `Record`s updated (so `tsc` was clean and
 * 1574 tests passed), while six zod/array rosters still listed eight
 * destinations. `estimate_savings` rejected `destination: 'coralogix'` before
 * its handler ran, and `cost_options` emitted a `routes_to` handoff into it
 * that was guaranteed to fail. Type-level exhaustiveness cannot catch that;
 * only parsing the actual schemas can.
 *
 * Every test here fails if its roster regresses.
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
import { renderOffloadSection } from '../src/lib/offload-recipes.js';
import { DEFAULT_ANALYZER_COST_PER_GB } from '../src/lib/siem/pricing.js';
import { COST_MODEL_BY_DESTINATION } from '../src/lib/cost.js';


const PARAMS = { bucket: 'tenx-demo-cloud-retriever-351939435334', region: 'us-east-1' };

/** Parse just one field of a tool's raw-shape schema. */
function parseField(shape: Record<string, unknown>, field: string, value: unknown) {
  const s = shape[field];
  assert.ok(s, `schema has no field '${field}'`);
  return (s as z.ZodTypeAny).parse(value);
}

test('estimate_savings accepts destination=coralogix (the headline path)', () => {
  // Was rejected by DEST_ENUM before the handler ever ran.
  assert.equal(parseField(estimateSavingsSchema, 'destination', 'coralogix'), 'coralogix');
});

test('estimate_savings accepts siem_lens=coralogix', () => {
  assert.equal(parseField(estimateSavingsSchema, 'siem_lens', 'coralogix'), 'coralogix');
});

test('cost_options -> estimate_savings handoff is not a guaranteed failure', () => {
  // cost_options advertises a routes_to hop carrying `destination` into
  // estimate_savings. If cost_options accepts a destination that
  // estimate_savings rejects, the advertised chain dead-ends at zod.
  const accepted = parseField(costOptionsSchema, 'destination', 'coralogix');
  assert.doesNotThrow(
    () => parseField(estimateSavingsSchema, 'destination', accepted),
    'cost_options accepts a destination estimate_savings refuses — broken handoff'
  );
});

test('baseline accepts destination=coralogix (funnel entry tool)', () => {
  assert.equal(parseField(baselineSchema, 'destination', 'coralogix'), 'coralogix');
});

test('dest_set accepts siem_vendor=coralogix', () => {
  // Without this, the only way to record a Coralogix tenant is `other`, which
  // maps to the generic action table and has no tier_down.
  assert.equal(parseField(destSetSchema, 'siem_vendor', 'coralogix'), 'coralogix');
});

test('the stored-config schema and dest_set agree on coralogix', () => {
  // env-config-manage's SIEM_VENDOR_ENUM claims to mirror siemDestinationSchema.
  assert.doesNotThrow(() => siemDestinationSchema.parse({ siem_vendor: 'coralogix' }));
});

test('LOG10X_SIEM_VENDOR=coralogix reaches the stored config', () => {
  // The env-var bridge validated against its own vendor list; an unlisted
  // vendor was dropped with no diagnostic, making the widened schema
  // unreachable from this write path.
  const cfg = envConfigFromEnvVars({ LOG10X_SIEM_VENDOR: 'coralogix' } as NodeJS.ProcessEnv);
  assert.equal(
    (cfg as { destination?: { siem_vendor?: string } })?.destination?.siem_vendor,
    'coralogix',
    'env var silently dropped'
  );
});

test('coralogix is priced and modelled consistently across both tables', () => {
  assert.ok(DEFAULT_ANALYZER_COST_PER_GB.coralogix > 0, 'no rate');
  const m = COST_MODEL_BY_DESTINATION.coralogix;
  assert.equal(m.ingest_per_gb, DEFAULT_ANALYZER_COST_PER_GB.coralogix, 'rate tables disagree');
  const tier = m.tier_down_target_tier;
  assert.ok(tier, 'no tier_down target — estimate_savings would return no delta');
  assert.ok(
    tier.ingest_rate_usd_per_gb < m.ingest_per_gb,
    'target tier must be cheaper than the baseline or tier_down saves nothing'
  );
});

test('the advisor never hands a Coralogix operator a marker-stripping config', () => {
  // This is the failure the whole recipe exists to prevent: strip routeState
  // and the TCO policy has nothing to match, so nothing tiers — with HTTP 200
  // and no error anywhere.
  const md = renderOffloadSection(PARAMS, 'fluent-bit', 'coralogix');
  // Assert on the SCOPE of every routeState strip: each one must be matched to
  // tenx.offload. A `Match tenx.*` strip would also take the marker off the
  // Coralogix path (tenx.app) and silently disable all tiering.
  const strips = [...md.matchAll(/Match\s+(\S+)\s*\n\s*Remove_key\s+routeState/g)].map(m => m[1]);
  assert.ok(strips.length > 0, 'expected at least the offload-path strip');
  for (const tag of strips) {
    assert.equal(tag, 'tenx.offload', `routeState stripped on '${tag}' — the marker must survive to Coralogix`);
  }
  assert.match(md, /Coralogix build/, 'must render the Coralogix shipper, not the generic one');
});

test('the coralogix S3 slice is stripped, the Coralogix slice is not', () => {
  const md = renderOffloadSection(PARAMS, 'fluent-bit', 'coralogix');
  // Narrow strip on the offload tag only.
  assert.match(
    md,
    /Match\s+tenx\.offload\s*\n\s*Remove_key\s+routeState\s*\n\s*Remove_key\s+_route/,
    'offload objects would carry routeState/_route into the customer bucket'
  );
});

test('other destinations still get the generic recipe unchanged', () => {
  for (const dest of ['datadog', 'cloudwatch', 'azure-monitor', undefined]) {
    const md = renderOffloadSection(PARAMS, 'fluent-bit', dest as string | undefined);
    assert.ok(!/Coralogix build/.test(md), `destination=${dest} leaked the coralogix shipper`);
    assert.match(md, /Remove_key\s+routeState/, `destination=${dest} lost its marker strip`);
  }
});

test('the advisor gate normalises free-form destination text', () => {
  // advise_retriever takes `destination` as an unconstrained z.string(), so an
  // agent passing "Coralogix" or " CX " would miss an exact-match gate and be
  // handed the generic marker-stripping recipe with no warning at all.
  for (const variant of ['Coralogix', ' coralogix ', 'CORALOGIX', 'cx']) {
    const md = renderOffloadSection(PARAMS, 'fluent-bit', variant);
    assert.match(md, /Coralogix build/, `"${variant}" did not resolve to the coralogix path`);
  }
});

test('normalisation does not misroute other destinations', () => {
  for (const [variant, expect] of [['Datadog', /Datadog Flex/], ['DD', /Datadog Flex/], ['CloudWatch', /CloudWatch Infrequent/]] as const) {
    const md = renderOffloadSection(PARAMS, 'fluent-bit', variant);
    assert.match(md, expect, `"${variant}" did not resolve correctly`);
    assert.ok(!/Coralogix build/.test(md), `"${variant}" leaked the coralogix shipper`);
  }
});
