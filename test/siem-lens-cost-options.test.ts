/**
 * cost_options must forward the SIEM lens (`siem_lens`) — not just the
 * destination — into every estimate_savings routes_to.args, so the downstream
 * estimate_savings recomputes resolveSiemLens with the REQUESTED lens and skips
 * the env-configured account rate (rungs 2/3), landing on the lens
 * destination's list price.
 *
 * Regression for Bug 2: sharedArgs forwarded `destination` and
 * `monthly_volume_gb` but NOT `siem_lens`, so the hop carried
 * destination=<lens> with siem_lens=undefined. Downstream that resolved
 * lensed:false, letting a stray LOG10X_ANALYZER_COST price the lensed story.
 *
 * Mirrors test/volume-lens-cost-options.test.ts's forwarding assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeCostOptions } from '../src/tools/cost-options.js';
import { asRecord } from './volume-lens-tool-harness.js';

type Env = { data: Record<string, unknown>; summary: Record<string, unknown> };

const payload = (o: Env) => asRecord(o.data.payload);

test('cost_options: siem_lens appears verbatim in every estimate_savings routes_to.args', async () => {
  // target_percent makes the greedy-solver branch populate routes_to.args.
  const out = (await executeCostOptions({ siem_lens: 'splunk', target_percent: 50 })) as unknown as Env;
  const modes = payload(out).modes as Array<Record<string, unknown>>;
  assert.ok(modes.length > 0);
  let sawEstimateRoute = false;
  for (const m of modes) {
    const routes = asRecord(m.routes_to);
    if (routes.tool === 'log10x_estimate_savings') {
      sawEstimateRoute = true;
      const rargs = asRecord(routes.args);
      assert.equal(rargs.siem_lens, 'splunk', `mode ${String(m.id)} forwards siem_lens`);
      // The line-507 alias also fills destination FROM siem_lens; both must ride.
      assert.equal(rargs.destination, 'splunk', `mode ${String(m.id)} forwards destination`);
    }
  }
  assert.ok(sawEstimateRoute, 'expected at least one estimate_savings route to assert on');
});

test('cost_options: absent siem_lens → not forwarded', async () => {
  const out = (await executeCostOptions({ target_percent: 50 })) as unknown as Env;
  const modes = payload(out).modes as Array<Record<string, unknown>>;
  for (const m of modes) {
    const routes = asRecord(m.routes_to);
    if (routes.tool === 'log10x_estimate_savings') {
      assert.equal(asRecord(routes.args).siem_lens, undefined);
    }
  }
});
