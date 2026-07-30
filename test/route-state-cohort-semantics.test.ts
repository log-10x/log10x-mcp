/**
 * Route-state cohort SEMANTICS.
 *
 * The suite already had ~1,534 tests and not one of them asserted what a
 * cohort MEANS. Every cohort test matched on literal PromQL text, so they all
 * passed while `kept` and `dropped` were both wrong:
 *
 *     kept    -> routeState != "drop"    // counted offloaded bytes as delivered
 *     dropped -> routeState  = "drop"    // blind to the offload cohort entirely
 *
 * A cohort is a SET of route states; `=`/`!=` can only name one. The engine
 * stamps six (pass | offload | compact | tier_down | sample | drop). Only
 * `services` read all of them, which is why only `services` was right.
 *
 * That gap let an 8x error reach a buyer demo: `services` reported cart 88%
 * offloaded while `event_lookup`, `top_patterns` and `pattern_trend` reported
 * cart 0% reduced / 100% kept, on the same window.
 *
 * These tests assert MEANING, not query text. They fail on the old selectors
 * regardless of how the query happens to be spelled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  includeToSelector,
  KEPT_STATES_RE,
  ACTED_STATES_RE,
  type RouteStateAction,
} from '../src/lib/promql.js';

/** Every state the engine can stamp. */
const ALL_STATES: RouteStateAction[] = [
  'pass',
  'sample',
  'compact',
  'tier_down',
  'offload',
  'drop',
];

/**
 * Does a PromQL alternation match a label value? `''` models the absent
 * label, which PromQL treats as the empty string.
 */
function matches(alternation: string, value: string): boolean {
  return new RegExp(`^(?:${alternation})$`).test(value);
}

test('KEPT means reached the destination: pass, plus label-absent', () => {
  assert.equal(matches(KEPT_STATES_RE, 'pass'), true);
  // Absence-tolerant: series predating routeState stamping must still count
  // as delivered, or every legacy environment reports zero traffic.
  assert.equal(matches(KEPT_STATES_RE, ''), true);
});

test('KEPT excludes every state the receiver acted on', () => {
  for (const state of ['offload', 'compact', 'tier_down', 'drop', 'sample']) {
    assert.equal(
      matches(KEPT_STATES_RE, state),
      false,
      `${state} bytes never reached the destination and must not count as kept`
    );
  }
});

test('ACTED covers every non-pass state, not just drop', () => {
  for (const state of ['offload', 'compact', 'tier_down', 'drop', 'sample']) {
    assert.equal(
      matches(ACTED_STATES_RE, state),
      true,
      `${state} is a receiver action and must be in the acted cohort`
    );
  }
  // The specific regression: offload was invisible because the selector was
  // the literal `drop`.
  assert.equal(matches(ACTED_STATES_RE, 'offload'), true);
});

test('ACTED excludes pass and label-absent', () => {
  assert.equal(matches(ACTED_STATES_RE, 'pass'), false);
  assert.equal(matches(ACTED_STATES_RE, ''), false);
});

test('the two cohorts PARTITION the state space: no overlap, no gap', () => {
  for (const state of [...ALL_STATES, '']) {
    const kept = matches(KEPT_STATES_RE, state);
    const acted = matches(ACTED_STATES_RE, state);
    assert.notEqual(
      kept,
      acted,
      `"${state || '<absent>'}" must be in exactly one cohort (kept=${kept}, acted=${acted})`
    );
  }
});

test('includeToSelector emits set selectors for kept and dropped', () => {
  const kept = includeToSelector('kept');
  const dropped = includeToSelector('dropped');

  assert.deepEqual(kept, {
    droppedFilter: { op: '=~', val: KEPT_STATES_RE },
    runBoth: false,
  });
  assert.deepEqual(dropped, {
    droppedFilter: { op: '=~', val: ACTED_STATES_RE },
    runBoth: false,
  });
});

test('dropped is NOT an alias of the literal drop action', () => {
  const dropped = includeToSelector('dropped');
  const literalDrop = includeToSelector('drop');

  assert.notDeepEqual(
    dropped,
    literalDrop,
    'conflating them is the original bug: it hides offload/compact/tier_down/sample'
  );
  // `drop` stays available for callers that genuinely want hard-drops alone.
  assert.deepEqual(literalDrop, {
    droppedFilter: { op: '=', val: 'drop' },
    runBoth: false,
  });
});

test('a single action name still selects that action exactly', () => {
  for (const state of ALL_STATES) {
    const { droppedFilter, runBoth } = includeToSelector(state);
    assert.deepEqual(droppedFilter, { op: '=', val: state });
    assert.equal(runBoth, false);
  }
});

test('both runs the dual query with no primary selector', () => {
  assert.deepEqual(includeToSelector('both'), {
    droppedFilter: null,
    runBoth: true,
  });
});

test('an offload-only environment is not reported as untouched', () => {
  // The demo: cart is 88% offload and 0% drop. Under the old selectors the
  // acted cohort was empty, so `top_patterns(include:"dropped")` returned
  // no_signal with a FALSE "routeState enrichment is not wired" diagnostic,
  // and cost_options / log10x_start answered "no receiver action here" while
  // 362 GB/week was being offloaded.
  const offloadOnly = ['offload'];
  const acted = offloadOnly.filter((s) => matches(ACTED_STATES_RE, s));
  assert.equal(acted.length, 1, 'offload-only env must register as acted-on');

  const keptSide = offloadOnly.filter((s) => matches(KEPT_STATES_RE, s));
  assert.equal(keptSide.length, 0, 'offloaded bytes must not count as delivered');
});

test('cohort arithmetic reconciles: kept + acted == total', () => {
  // Live figures, demo env, cart, last 24h (GB). Verified against
  // prometheus.log10x.com at the time of the fix.
  const byState: Record<string, number> = {
    pass: 4.99,
    offload: 37.27,
    compact: 0,
    tier_down: 0,
    sample: 0,
    drop: 0,
  };
  const total = Object.values(byState).reduce((a, b) => a + b, 0);

  const sumWhere = (re: string) =>
    Object.entries(byState)
      .filter(([state]) => matches(re, state))
      .reduce((acc, [, bytes]) => acc + bytes, 0);

  const kept = sumWhere(KEPT_STATES_RE);
  const acted = sumWhere(ACTED_STATES_RE);

  assert.equal(kept, 4.99, 'kept is what actually reached CloudWatch');
  assert.equal(acted, 37.27, 'acted is what the destination never received');
  assert.ok(
    Math.abs(kept + acted - total) < 1e-9,
    `cohorts must partition the bytes (kept ${kept} + acted ${acted} != total ${total})`
  );

  // The buyer-visible number.
  const offloadSharePct = (acted / total) * 100;
  assert.ok(
    Math.abs(offloadSharePct - 88.2) < 0.1,
    `cart offload share should be ~88.2%, got ${offloadSharePct.toFixed(1)}%`
  );
});
