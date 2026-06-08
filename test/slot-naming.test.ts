import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferSlotName, detectCohorts } from '../src/lib/slot-naming.js';

// ── inferSlotName: Layer 1 JSON-key (with parent walking) ─────────────────

test('inferSlotName: JSON-key context with parent → full path / high', () => {
  const r = inferSlotName('.\t{"resource": {"service.instance.id": "', ['1aab212a']);
  assert.equal(r?.name, 'resource.service.instance.id');
  assert.equal(r?.confidence, 'high');
  assert.equal(r?.source, 'json_key');
});

test('inferSlotName: JSON-key at root (no parent) → leaf only / high', () => {
  const r = inferSlotName('"auditID":', ['abc-def']);
  assert.equal(r?.name, 'auditID');
  assert.equal(r?.confidence, 'high');
  assert.equal(r?.source, 'json_key');
});

test('inferSlotName: JSON-key with sibling pollution → siblings skipped', () => {
  // Siblings at same depth (`,"key":"val"` pairs) must be skipped when
  // walking parents. Only true parents (one scope up via `{`) count.
  const r = inferSlotName('{"a": "x", "b": "y", "c": "', ['z']);
  assert.equal(r?.name, 'c');
  assert.equal(r?.confidence, 'high');
});

test('inferSlotName: multi-level nesting → full dotted path', () => {
  const r = inferSlotName('{"a": {"b": {"c": "', ['z']);
  assert.equal(r?.name, 'a.b.c');
  assert.equal(r?.confidence, 'high');
});

test('inferSlotName: sibling + parent mix → only parent in path', () => {
  // `user` is the parent; `audit` is a sibling of `user`, NOT a parent of `id`.
  const r = inferSlotName('{"audit": {...}, "user": {"id": "', ['42']);
  assert.equal(r?.name, 'user.id');
});

test('inferSlotName: JSON-key with dotted key preserves dots', () => {
  const r = inferSlotName('"service.version": "', ['0.142.0']);
  assert.equal(r?.name, 'service.version');
  assert.equal(r?.confidence, 'high');
});

test('inferSlotName: JSON-key with spaces → spaces collapsed to underscore', () => {
  const r = inferSlotName('"resource logs": ', ['2']);
  assert.equal(r?.name, 'resource_logs');
  assert.equal(r?.confidence, 'high');
});

test('inferSlotName: JSON-key with spaces inside object → parent path joined with dots', () => {
  const r = inferSlotName('{"outer": {"log records": ', ['5']);
  assert.equal(r?.name, 'outer.log_records');
  assert.equal(r?.confidence, 'high');
});

test('inferSlotName: quoted phrase inside log message (no `,` or `{` before) → no false match', () => {
  // A log message body like `Got error "ERROR: failed":` should NOT be
  // mistaken for a JSON key — there's no `{` or `,` before the opening
  // quote, just plain text.
  const r = inferSlotName('Got error "ERROR: failed": ', ['x']);
  assert.equal(r, undefined);
});

// ── inferSlotName: composite-value back-references ────────────────────────

test('inferSlotName: composite back-ref `$7.` suffix → part2 / medium', () => {
  // The real slot_9 case from otel-demo: `"duration": $7.<slot>` means
  // the slot is the trailing fractional fragment of `duration`; $7 is
  // the integer fragment. Name: `duration_part2`.
  const r = inferSlotName('..., "method": "POST", "duration": $7.', ['003354365']);
  assert.equal(r?.name, 'duration_part2');
  assert.equal(r?.confidence, 'medium');
  assert.equal(r?.source, 'json_key_composite');
});

test('inferSlotName: composite back-ref `$7.$8.` → part3', () => {
  const r = inferSlotName('"foo": $7.$8.', ['x']);
  assert.equal(r?.name, 'foo_part3');
  assert.equal(r?.confidence, 'medium');
  assert.equal(r?.source, 'json_key_composite');
});

test('inferSlotName: composite with parent → parent path preserved', () => {
  const r = inferSlotName('{"outer": {"foo": $7.', ['x']);
  assert.equal(r?.name, 'outer.foo_part2');
  assert.equal(r?.confidence, 'medium');
  assert.equal(r?.source, 'json_key_composite');
});

// ── inferSlotName: Layer 2 KV-pair ────────────────────────────────────────

test('inferSlotName: KV-pair context → high confidence', () => {
  const r = inferSlotName(' userId=', ['user-42']);
  assert.equal(r?.name, 'user_id');
  assert.equal(r?.confidence, 'high');
  assert.equal(r?.source, 'kv_pair');
});

// ── inferSlotName: Layer 2 verb-preposition compound ──────────────────────

test('inferSlotName: KV-pair preposition `on` with verb `decided` → decided_on', () => {
  const r = inferSlotName('decided on: ', ['50']);
  assert.equal(r?.name, 'decided_on');
  assert.equal(r?.confidence, 'medium');
  assert.equal(r?.source, 'kv_pair_compound');
});

test('inferSlotName: KV-pair preposition `to` with verb `routed` → routed_to', () => {
  const r = inferSlotName('routed to: ', ['backend-3']);
  assert.equal(r?.name, 'routed_to');
  assert.equal(r?.confidence, 'medium');
  assert.equal(r?.source, 'kv_pair_compound');
});

test('inferSlotName: KV-pair preposition `from` with verb `migrated` → migrated_from', () => {
  const r = inferSlotName('migrated from: ', ['us-east-1']);
  assert.equal(r?.name, 'migrated_from');
  assert.equal(r?.confidence, 'medium');
  assert.equal(r?.source, 'kv_pair_compound');
});

test('inferSlotName: KV-pair stopword `as` alone → null (no useful compound)', () => {
  const r = inferSlotName('as: ', ['x']);
  assert.equal(r, undefined);
});

test('inferSlotName: KV-pair stopword preceded by another stopword → null', () => {
  const r = inferSlotName('to from: ', ['x']);
  assert.equal(r, undefined);
});

// ── inferSlotName: Layer 2.5 noun-prefix ─────────────────────────────────

test('inferSlotName: noun prefix `port` → name port / medium', () => {
  const r = inferSlotName('port ', ['22']);
  assert.equal(r?.name, 'port');
  assert.equal(r?.confidence, 'medium');
  assert.equal(r?.source, 'noun_prefix');
});

test('inferSlotName: noun prefix `pid` → name pid / medium', () => {
  const r = inferSlotName('pid ', ['12453']);
  assert.equal(r?.name, 'pid');
  assert.equal(r?.confidence, 'medium');
  assert.equal(r?.source, 'noun_prefix');
});

test('inferSlotName: noun prefix `user` in phrase `for user` → user', () => {
  const r = inferSlotName('Accepted password for user ', ['alice']);
  assert.equal(r?.name, 'user');
  assert.equal(r?.confidence, 'medium');
  assert.equal(r?.source, 'noun_prefix');
});

test('inferSlotName: non-vocabulary word `decided` → null', () => {
  const r = inferSlotName('decided ', ['x']);
  assert.equal(r, undefined);
});

test('inferSlotName: preposition `for ` alone → null', () => {
  const r = inferSlotName('for ', ['x']);
  assert.equal(r, undefined);
});

// ── inferSlotName: Layer 3 delimiter heuristic ────────────────────────────

test('inferSlotName: filename:line context → line / medium', () => {
  const r = inferSlotName('//logger.go:', ['36']);
  assert.equal(r?.name, 'line');
  assert.equal(r?.confidence, 'medium');
  assert.equal(r?.source, 'delimiter_heuristic');
});

// ── inferSlotName: no-match cases ─────────────────────────────────────────

test('inferSlotName: pure-punctuation token → no name', () => {
  const r = inferSlotName('.', ['0']);
  assert.equal(r, undefined);
});

test('inferSlotName: undefined preceding token → no name', () => {
  const r = inferSlotName(undefined, ['x']);
  assert.equal(r, undefined);
});

test('inferSlotName: token like @v0. (version sigil) → no name', () => {
  const r = inferSlotName('\terror\topensearchexporter@v0.', ['142']);
  assert.equal(r, undefined);
});

// ── detectCohorts: UUID ───────────────────────────────────────────────────

test('detectCohorts: 5 consecutive hex slots separated by `-` → UUID cohort', () => {
  const template = '"id": "$-$-$-$-$"';
  const slots = [
    { slot: 'slot_0', sampleValues: ['1aab212a'], precedingToken: '"id": "' },
    { slot: 'slot_1', sampleValues: ['1c9e'], precedingToken: '-' },
    { slot: 'slot_2', sampleValues: ['423a'], precedingToken: '-' },
    { slot: 'slot_3', sampleValues: ['9b98'], precedingToken: '-' },
    { slot: 'slot_4', sampleValues: ['cc7cd26c17ae'], precedingToken: '-' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'uuid');
  assert.deepEqual(out[0]!.member_slots, ['slot_0', 'slot_1', 'slot_2', 'slot_3', 'slot_4']);
  assert.equal(out[0]!.inferred_name, 'id');
  assert.equal(out[0]!.cardinality, 1);
  assert.deepEqual(out[0]!.sample_values, ['1aab212a-1c9e-423a-9b98-cc7cd26c17ae']);
});

test('detectCohorts: UUID with parent path → cohort name inherits full path', () => {
  const template = 'a=$ b=$ c=$ d=$ {"resource": {"service.instance.id": "$-$-$-$-$"}}';
  const slots = [
    { slot: 'slot_0', sampleValues: ['1'], precedingToken: 'a=' },
    { slot: 'slot_1', sampleValues: ['2'], precedingToken: 'b=' },
    { slot: 'slot_2', sampleValues: ['3'], precedingToken: 'c=' },
    { slot: 'slot_3', sampleValues: ['4'], precedingToken: 'd=' },
    { slot: 'slot_4', sampleValues: ['1aab212a'], precedingToken: '{"resource": {"service.instance.id": "' },
    { slot: 'slot_5', sampleValues: ['1c9e'], precedingToken: '-' },
    { slot: 'slot_6', sampleValues: ['423a'], precedingToken: '-' },
    { slot: 'slot_7', sampleValues: ['9b98'], precedingToken: '-' },
    { slot: 'slot_8', sampleValues: ['cc7cd26c17ae'], precedingToken: '-' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.inferred_name, 'resource.service.instance.id');
  assert.equal(out[0]!.naming_confidence, 'high');
});

test('detectCohorts: incomplete UUID (4 hex slots) → no cohort', () => {
  const template = '$-$-$-$';
  const slots = [
    { slot: 'slot_0', sampleValues: ['1aab212a'], precedingToken: undefined },
    { slot: 'slot_1', sampleValues: ['1c9e'], precedingToken: '-' },
    { slot: 'slot_2', sampleValues: ['423a'], precedingToken: '-' },
    { slot: 'slot_3', sampleValues: ['9b98'], precedingToken: '-' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 0);
});

test('detectCohorts: 5 hex slots with WRONG segment lengths → no UUID cohort', () => {
  const template = '$-$-$-$-$';
  const slots = [
    { slot: 'slot_0', sampleValues: ['aa'], precedingToken: undefined }, // wrong: needs 8
    { slot: 'slot_1', sampleValues: ['1c9e'], precedingToken: '-' },
    { slot: 'slot_2', sampleValues: ['423a'], precedingToken: '-' },
    { slot: 'slot_3', sampleValues: ['9b98'], precedingToken: '-' },
    { slot: 'slot_4', sampleValues: ['cc7cd26c17ae'], precedingToken: '-' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 0);
});

test('detectCohorts: distinct UUIDs across events → cardinality > 1', () => {
  const template = '"id": "$-$-$-$-$"';
  const slots = [
    { slot: 'slot_0', sampleValues: ['1aab212a', 'deadbeef'], precedingToken: '"id": "' },
    { slot: 'slot_1', sampleValues: ['1c9e', '2222'], precedingToken: '-' },
    { slot: 'slot_2', sampleValues: ['423a', '3333'], precedingToken: '-' },
    { slot: 'slot_3', sampleValues: ['9b98', '4444'], precedingToken: '-' },
    { slot: 'slot_4', sampleValues: ['cc7cd26c17ae', '555566667777'], precedingToken: '-' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.cardinality, 2);
});

// ── detectCohorts: IPv4 ───────────────────────────────────────────────────

// ── detectCohorts: MAC ───────────────────────────────────────────────────

test('detectCohorts: 6 hex-pair slots separated by `:` → MAC cohort', () => {
  const template = '"mac": "$:$:$:$:$:$"';
  const slots = [
    { slot: 'slot_0', sampleValues: ['aa'], precedingToken: '"mac": "' },
    { slot: 'slot_1', sampleValues: ['bb'], precedingToken: ':' },
    { slot: 'slot_2', sampleValues: ['cc'], precedingToken: ':' },
    { slot: 'slot_3', sampleValues: ['dd'], precedingToken: ':' },
    { slot: 'slot_4', sampleValues: ['ee'], precedingToken: ':' },
    { slot: 'slot_5', sampleValues: ['ff'], precedingToken: ':' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'mac');
  assert.equal(out[0]!.inferred_name, 'mac');
  assert.deepEqual(out[0]!.sample_values, ['aa:bb:cc:dd:ee:ff']);
});

test('detectCohorts: 6 hex-pair slots separated by `-` → MAC cohort (Cisco style)', () => {
  const template = '$-$-$-$-$-$';
  const slots = [
    { slot: 'slot_0', sampleValues: ['aa'], precedingToken: undefined },
    { slot: 'slot_1', sampleValues: ['bb'], precedingToken: '-' },
    { slot: 'slot_2', sampleValues: ['cc'], precedingToken: '-' },
    { slot: 'slot_3', sampleValues: ['dd'], precedingToken: '-' },
    { slot: 'slot_4', sampleValues: ['ee'], precedingToken: '-' },
    { slot: 'slot_5', sampleValues: ['ff'], precedingToken: '-' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'mac');
  assert.deepEqual(out[0]!.sample_values, ['aa-bb-cc-dd-ee-ff']);
});

test('detectCohorts: 5 hex-pair slots → no MAC cohort (need 6)', () => {
  const template = '$:$:$:$:$';
  const slots = [
    { slot: 'slot_0', sampleValues: ['aa'], precedingToken: undefined },
    { slot: 'slot_1', sampleValues: ['bb'], precedingToken: ':' },
    { slot: 'slot_2', sampleValues: ['cc'], precedingToken: ':' },
    { slot: 'slot_3', sampleValues: ['dd'], precedingToken: ':' },
    { slot: 'slot_4', sampleValues: ['ee'], precedingToken: ':' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 0);
});

test('detectCohorts: 4 octet slots separated by `.` → IPv4 cohort', () => {
  const template = '"ip": "$.$.$.$"';
  const slots = [
    { slot: 'slot_0', sampleValues: ['172'], precedingToken: '"ip": "' },
    { slot: 'slot_1', sampleValues: ['20'], precedingToken: '.' },
    { slot: 'slot_2', sampleValues: ['0'], precedingToken: '.' },
    { slot: 'slot_3', sampleValues: ['10'], precedingToken: '.' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'ipv4');
  assert.equal(out[0]!.inferred_name, 'ip');
  assert.equal(out[0]!.cardinality, 1);
  assert.deepEqual(out[0]!.sample_values, ['172.20.0.10']);
});

test('detectCohorts: octet > 255 → no IPv4 cohort', () => {
  const template = '$.$.$.$';
  const slots = [
    { slot: 'slot_0', sampleValues: ['999'], precedingToken: undefined },
    { slot: 'slot_1', sampleValues: ['20'], precedingToken: '.' },
    { slot: 'slot_2', sampleValues: ['0'], precedingToken: '.' },
    { slot: 'slot_3', sampleValues: ['10'], precedingToken: '.' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 0);
});

// ── detectCohorts: back-reference robustness ──────────────────────────────

test('detectCohorts: $N back-references are NOT counted as slots', () => {
  const template = '"service.version": "$7.$8.$7", "duration": $7.$';
  const slots = [
    { slot: 'slot_0', sampleValues: ['003354365'], precedingToken: '"duration": 0.' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 0);
});

test('detectCohorts: $N back-references do not insert phantom separators', () => {
  const template = '"old": "$7.$8.$7", "id": "$-$-$-$-$"';
  const slots = [
    { slot: 'slot_0', sampleValues: ['aaaaaaaa'], precedingToken: '"id": "' },
    { slot: 'slot_1', sampleValues: ['bbbb'], precedingToken: '-' },
    { slot: 'slot_2', sampleValues: ['cccc'], precedingToken: '-' },
    { slot: 'slot_3', sampleValues: ['dddd'], precedingToken: '-' },
    { slot: 'slot_4', sampleValues: ['eeeeeeeeeeee'], precedingToken: '-' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'uuid');
});

// ── detectCohorts: format_spec slots don't participate ────────────────────

test('detectCohorts: same-value IPv4 cohort repeated in template (e.g. error msg repeats) → merged', () => {
  // Mirrors the real otel case: `dial tcp: lookup opensearch on $.$.$.$:$`
  // substring repeats inside one "reason" message body — each instance
  // is a distinct slot range but holds the same IP, and the preceding
  // token is the same non-JSON-key text, so both cohorts get the same
  // fallback name (`ipv4`) and identical samples → they dedupe.
  const template = 'lookup x on $.$.$.$:$. lookup x on $.$.$.$:$';
  const slots = [
    { slot: 'slot_0', sampleValues: ['172'], precedingToken: 'lookup x on ' },
    { slot: 'slot_1', sampleValues: ['20'], precedingToken: '.' },
    { slot: 'slot_2', sampleValues: ['0'], precedingToken: '.' },
    { slot: 'slot_3', sampleValues: ['10'], precedingToken: '.' },
    { slot: 'slot_5', sampleValues: ['172'], precedingToken: 'lookup x on ' },
    { slot: 'slot_6', sampleValues: ['20'], precedingToken: '.' },
    { slot: 'slot_7', sampleValues: ['0'], precedingToken: '.' },
    { slot: 'slot_8', sampleValues: ['10'], precedingToken: '.' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 1, 'duplicate cohorts should merge');
  assert.equal(out[0]!.kind, 'ipv4');
  assert.equal(out[0]!.inferred_name, 'ipv4');
  assert.deepEqual(out[0]!.sample_values, ['172.20.0.10']);
  assert.equal(out[0]!.member_slots.length, 8);
});

test('detectCohorts: different IPv4 values at two positions → kept separate', () => {
  // Same shape but different values — these are genuinely two distinct
  // IPs and shouldn't merge.
  const template = '"a": $.$.$.$, "b": $.$.$.$';
  const slots = [
    { slot: 'slot_0', sampleValues: ['10'], precedingToken: '"a": ' },
    { slot: 'slot_1', sampleValues: ['1'], precedingToken: '.' },
    { slot: 'slot_2', sampleValues: ['2'], precedingToken: '.' },
    { slot: 'slot_3', sampleValues: ['3'], precedingToken: '.' },
    { slot: 'slot_4', sampleValues: ['172'], precedingToken: ', "b": ' },
    { slot: 'slot_5', sampleValues: ['20'], precedingToken: '.' },
    { slot: 'slot_6', sampleValues: ['0'], precedingToken: '.' },
    { slot: 'slot_7', sampleValues: ['10'], precedingToken: '.' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 2, 'different IPs should stay as two cohorts');
});

test('detectCohorts: non-numeric slot id (e.g. `timestamp`) is ignored', () => {
  const template = '$(yyyy-MM-...)\t$-$-$-$-$';
  const slots = [
    { slot: 'timestamp', sampleValues: ['1779829887643'], precedingToken: undefined },
    { slot: 'slot_1', sampleValues: ['1aab212a'], precedingToken: '\t' },
    { slot: 'slot_2', sampleValues: ['1c9e'], precedingToken: '-' },
    { slot: 'slot_3', sampleValues: ['423a'], precedingToken: '-' },
    { slot: 'slot_4', sampleValues: ['9b98'], precedingToken: '-' },
    { slot: 'slot_5', sampleValues: ['cc7cd26c17ae'], precedingToken: '-' },
  ];
  const out = detectCohorts(slots, template);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'uuid');
  assert.deepEqual(out[0]!.member_slots, ['slot_1', 'slot_2', 'slot_3', 'slot_4', 'slot_5']);
});
