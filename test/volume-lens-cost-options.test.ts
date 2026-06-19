/**
 * cost_options is THREAD-ONLY for the volume lens: it scales nothing and
 * stamps nothing (a volume stamp on a run that emits no magnitude would be a
 * provenance leak). It must forward monthly_volume_gb verbatim into every
 * mode's routes_to.args so the downstream estimate_savings inherits it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeCostOptions } from '../src/tools/cost-options.js';
import { asRecord } from './volume-lens-tool-harness.js';

type Env = { data: Record<string, unknown>; summary: Record<string, unknown> };

async function run(args: Record<string, unknown>) {
  const out = await executeCostOptions(args);
  return out as unknown as Env;
}
const payload = (o: Env) => asRecord(o.data.payload);
const sd = (o: Env) => asRecord(o.data.source_disclosure);
const hl = (o: Env) => String(asRecord(o.summary).headline ?? '');

test('cost_options: monthly_volume_gb appears verbatim in every mode routes_to.args', async () => {
  // target_percent makes the greedy-solver branch populate routes_to.args.
  const out = await run({ monthly_volume_gb: 2000, target_percent: 50 });
  const modes = payload(out).modes as Array<Record<string, unknown>>;
  assert.ok(modes.length > 0);
  for (const m of modes) {
    const routes = asRecord(m.routes_to);
    // observe_only / install_receiver may route elsewhere; only assert on the
    // estimate_savings routes which carry the projection forward.
    if (routes.tool === 'log10x_estimate_savings') {
      const rargs = asRecord(routes.args);
      assert.equal(rargs.monthly_volume_gb, 2000, `mode ${String(m.id)} forwards monthly_volume_gb`);
    }
  }
});

test('cost_options: NO volume_*_gb stamp and NO [Projected to headline prefix', async () => {
  const out = await run({ monthly_volume_gb: 2000, target_percent: 50 });
  const disc = sd(out);
  assert.equal(disc.volume_actual_gb, undefined);
  assert.equal(disc.volume_projected_gb, undefined);
  assert.equal(disc.volume_scale_factor, undefined);
  assert.equal(disc.volume_projection_note, undefined);
  assert.ok(!hl(out).startsWith('[Projected to '));
});

test('cost_options: absent monthly_volume_gb → not forwarded', async () => {
  const out = await run({ target_percent: 50 });
  const modes = payload(out).modes as Array<Record<string, unknown>>;
  for (const m of modes) {
    const routes = asRecord(m.routes_to);
    if (routes.tool === 'log10x_estimate_savings') {
      assert.equal(asRecord(routes.args).monthly_volume_gb, undefined);
    }
  }
});
