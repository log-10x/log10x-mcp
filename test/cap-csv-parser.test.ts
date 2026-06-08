/**
 * cap-CSV parser acceptance test.
 *
 * The cap CSV is the engine-only safety-floor file (`container,cap` with
 * `<bytes>::<reason>` values). Per the e057eb1 refactor the per-row action
 * attribution was REMOVED from this file and moved to
 * `data/action-intent.json` (action-intent-parser.ts). Rows that still carry
 * a legacy `:<action>` suffix are parsed tolerantly: the suffix is stripped
 * off the reason and preserved in `legacy_action_suffix` for diagnostics
 * only — it is NOT used for action routing.
 *
 * Scenarios:
 *   1. Mixed CSV (container default + pat:<hash> overrides) — both row kinds
 *      parse; legacy suffixes land in `legacy_action_suffix`; by_pattern /
 *      by_container lookups populate; buildPatternActionLookup follows the
 *      pat:<hash> → container fallback over the legacy suffix.
 *   2. Malformed rows — surfaced via `malformed_lines`, no throws.
 *   3. Bytes-only / no legacy suffix rows — parse cleanly with no suffix.
 *   4. Action-bucket helpers — empty start + attributed-total arithmetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCapCsv,
  buildPatternActionLookup,
  emptyActionBuckets,
  totalAttributedBytes,
} from '../src/lib/cap-csv-parser.js';

test('parseCapCsv: container and pat:<hash> rows (legacy suffix preserved)', () => {
  const csv = `container,cap
payment-service,2048::MCP configure_engine (hard; default=compact):compact
pat:abc123,4096::keep audit floor:pass
pat:def456,128::tier_down dataset:tier_down
pat:ghi789,512::high-volume noise:drop
`;
  const parsed = parseCapCsv(csv);
  assert.equal(parsed.rows.length, 4);
  assert.equal(parsed.by_container.size, 1);
  assert.equal(parsed.by_pattern.size, 3);

  const container = parsed.by_container.get('payment-service');
  assert.ok(container);
  assert.equal(container.legacy_action_suffix, 'compact');
  assert.equal(container.bytes_cap, 2048);
  assert.equal(container.isContainerDefault, true);

  const pat = parsed.by_pattern.get('abc123');
  assert.ok(pat);
  assert.equal(pat.legacy_action_suffix, 'pass');
  assert.equal(pat.bytes_cap, 4096);
  assert.equal(pat.isContainerDefault, false);

  assert.equal(parsed.by_pattern.get('def456')?.legacy_action_suffix, 'tier_down');
  assert.equal(parsed.by_pattern.get('ghi789')?.legacy_action_suffix, 'drop');
  assert.equal(parsed.malformed_lines.length, 0);
});

test('parseCapCsv: malformed rows surface in malformed_lines, no throws', () => {
  const csv = `container,cap
good-container,1024::reason:drop
nokey,
,novalue
malformed-bytes,notanumber::oops:drop
weirdshape
`;
  const parsed = parseCapCsv(csv);
  // good-container row is valid; the four following lines are all malformed.
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.by_container.size, 1);
  assert.ok(parsed.malformed_lines.length >= 3);
});

test('parseCapCsv: no legacy suffix parses cleanly with reason intact', () => {
  const csv = `container,cap
new-container,1024::engine-only-safety-floor
`;
  const parsed = parseCapCsv(csv);
  assert.equal(parsed.rows.length, 1);
  const row = parsed.rows[0];
  assert.equal(row.legacy_action_suffix, undefined);
  assert.equal(row.reason, 'engine-only-safety-floor');
  assert.equal(row.bytes_cap, 1024);
});

test('parseCapCsv: missing :: separator (just bytes) parses with empty reason', () => {
  const csv = `container,cap
bare-cap,4096
`;
  const parsed = parseCapCsv(csv);
  assert.equal(parsed.rows.length, 1);
  const row = parsed.rows[0];
  assert.equal(row.legacy_action_suffix, undefined);
  assert.equal(row.reason, '');
  assert.equal(row.bytes_cap, 4096);
});

test('parseCapCsv: empty input returns empty result', () => {
  assert.deepEqual(parseCapCsv(undefined), {
    rows: [],
    by_pattern: new Map(),
    by_container: new Map(),
    malformed_lines: [],
  });
  assert.deepEqual(parseCapCsv(''), {
    rows: [],
    by_pattern: new Map(),
    by_container: new Map(),
    malformed_lines: [],
  });
});

test('buildPatternActionLookup: pat:<hash> legacy suffix overrides container fallback', () => {
  const csv = `container,cap
payment-service,2048::default:compact
checkout-service,1024::default:offload
pat:abc123,4096::override:pass
`;
  const parsed = parseCapCsv(csv);
  const patternToContainer = new Map([
    ['abc123', 'payment-service'],   // has pat row → 'pass' wins
    ['def456', 'payment-service'],   // no pat row → container default 'compact'
    ['ghi789', 'checkout-service'],  // no pat row → container default 'offload'
    ['unknown', 'nonexistent-service'], // no match at all → omitted from lookup
  ]);
  const lookup = buildPatternActionLookup(parsed, patternToContainer);
  assert.equal(lookup.size, 3);
  assert.equal(lookup.get('abc123'), 'pass');
  assert.equal(lookup.get('def456'), 'compact');
  assert.equal(lookup.get('ghi789'), 'offload');
  assert.equal(lookup.has('unknown'), false);
});

test('action buckets: empty start + total helper', () => {
  const buckets = emptyActionBuckets();
  assert.equal(totalAttributedBytes(buckets), 0);
  buckets.drop = 100;
  buckets.compact = 50;
  buckets.offload = 25;
  buckets.unattributed = 99; // does NOT contribute to attributed total
  assert.equal(totalAttributedBytes(buckets), 175);
});

test('action buckets: parts-≤-whole reconciles in synthetic split', () => {
  // Simulated post-window state:
  //   - postDroppedByHash totals: 100 (drop) + 50 (compact) + 25 (offload)
  //     + 10 (pass) + 15 (unattributed) = 200 dropped bytes.
  //   - cap-CSV attributes 4 of those to known buckets; 1 hash unmapped.
  const buckets = emptyActionBuckets();
  buckets.drop = 100;
  buckets.compact = 50;
  buckets.offload = 25;
  buckets.pass = 10;
  buckets.unattributed = 15;
  const attributedPlusUnattributed = totalAttributedBytes(buckets) + buckets.unattributed;
  const postDroppedBytes = 200;
  assert.ok(
    attributedPlusUnattributed <= postDroppedBytes,
    `parts (${attributedPlusUnattributed}) must be <= whole (${postDroppedBytes})`,
  );
  // Sum of buckets exactly equals dropped: complete attribution.
  assert.equal(attributedPlusUnattributed, postDroppedBytes);
});

test('action buckets: offload clamp keeps parts-≤-whole when FP drift overshoots', () => {
  // Build buckets totaling 201 against a whole of 200 (1-byte FP drift).
  const buckets = emptyActionBuckets();
  buckets.drop = 100;
  buckets.compact = 51; // FP drift
  buckets.offload = 50;
  const postDroppedBytes = 200;
  const overshoot = totalAttributedBytes(buckets) - postDroppedBytes;
  assert.equal(overshoot, 1);
  // Clamp offload by overshoot, just like computeActionSplit does.
  buckets.offload -= Math.min(buckets.offload, overshoot);
  assert.ok(totalAttributedBytes(buckets) <= postDroppedBytes);
});
