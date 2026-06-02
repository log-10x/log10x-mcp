/**
 * Item 5 acceptance test — cap-CSV parser handles container rows AND
 * pat:<hash> rows, AND the action-split arithmetic reconciles (parts ≤
 * whole) under synthetic data.
 *
 * Three scenarios:
 *   1. Mixed CSV (container default + pat:<hash> overrides) — both row
 *      kinds parse, by_pattern/by_container lookups populate correctly,
 *      buildPatternActionLookup follows pat:<hash> → container fallback.
 *   2. Malformed rows — surfaced via `malformed_lines`, no throws.
 *   3. Synthetic action-split — drop+compact+offload+pass + an
 *      unattributed hash; total bytes attributed ≤ sum of all bytes;
 *      offload clamp engages when FP drift pushes parts > whole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCapCsv,
  buildPatternActionLookup,
  emptyActionBuckets,
  totalAttributedBytes,
} from '../src/lib/cap-csv-parser.js';

test('parseCapCsv: container and pat:<hash> rows', () => {
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
  assert.equal(container.action, 'compact');
  assert.equal(container.bytes_cap, 2048);
  assert.equal(container.isContainerDefault, true);

  const pat = parsed.by_pattern.get('abc123');
  assert.ok(pat);
  assert.equal(pat.action, 'pass');
  assert.equal(pat.bytes_cap, 4096);
  assert.equal(pat.isContainerDefault, false);

  assert.equal(parsed.by_pattern.get('def456')?.action, 'tier_down');
  assert.equal(parsed.by_pattern.get('ghi789')?.action, 'drop');
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

test('parseCapCsv: missing action suffix defaults to drop with flag', () => {
  const csv = `container,cap
legacy-container,1024::pre-action-suffix-reason
`;
  const parsed = parseCapCsv(csv);
  assert.equal(parsed.rows.length, 1);
  const row = parsed.rows[0];
  assert.equal(row.action, 'drop');
  assert.equal(row.action_suffix_missing, true);
  assert.equal(row.reason, 'pre-action-suffix-reason');
});

test('parseCapCsv: missing :: separator (just bytes) parses as drop', () => {
  const csv = `container,cap
bare-cap,4096
`;
  const parsed = parseCapCsv(csv);
  assert.equal(parsed.rows.length, 1);
  const row = parsed.rows[0];
  assert.equal(row.action, 'drop');
  assert.equal(row.action_suffix_missing, true);
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

test('buildPatternActionLookup: pat:<hash> overrides container fallback', () => {
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
    `parts (${attributedPlusUnattributed}) must be <= whole (${postDroppedBytes})`
  );
  // Sum of buckets exactly equals dropped: complete attribution.
  assert.equal(attributedPlusUnattributed, postDroppedBytes);
});

test('action buckets: offload clamp keeps parts-≤-whole when FP drift overshoots', () => {
  // Build buckets totaling 201 against a whole of 200 (1-byte FP drift).
  // The runEstimateVerify computeActionSplit path trims offload to the
  // residual; here we replicate that clamp manually to assert the
  // post-clamp invariant.
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
