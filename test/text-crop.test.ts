/**
 * text-crop.ts — codepoint-safe mid-ellipsis (Layer 1).
 *
 * Covers the two defects of front-crop + trailing '...': surrogate-pair
 * mojibake and tail loss. The headline acceptance is the spec's "zero
 * collisions on the 9 demo names at width 48; rows 8/9 verbatim" — which
 * holds at Layer 1 because the discriminator lives in the TAIL and
 * midEllipsis keeps the tail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { midEllipsis, codepointLength } from '../src/lib/text-crop.js';

// The 9 demo names (OTel-collector-shaped: long shared prefix, differ at END)
// plus two short clean names that must never be harmed.
const DEMO_NAMES = [
  'terror_v_logger_go_failed_t_resource_service_instance_id_service_name_otelcol_contrib_service_version_otelcol_component_id_opensearch',
  'terror_base_exporter_go_failed_Rejecting_data_Try_enabling_sending_queue_to_survive_temporary_failures_t_resource_service_instance',
  'terror_v_logger_go_failed_t_resource_service_instance_id_service_name_otelcol_contrib_service_version_otelcol_component_id_kafkaexporter',
  'terror_v_exporter_go_failed_t_resource_service_instance_id_service_name_otelcol_contrib_service_version_otelcol_component_id_prometheusremotewrite',
  'terror_v_logger_go_failed_t_resource_service_instance_id_service_name_otelcol_contrib_service_version_otelcol_component_id_loadbalancing',
  'v_batch_processor_go_failed_t_resource_service_instance_id_service_name_otelcol_contrib_service_version_otelcol_component_id_batch',
  'v_batch_processor_go_failed_t_resource_service_instance_id_service_name_otelcol_contrib_service_version_otelcol_component_id_traces',
  'Charge_request_received',
  'Transaction_complete',
];

test('returns verbatim when within width (counted in codepoints)', () => {
  assert.equal(midEllipsis('short name', 48), 'short name');
  assert.equal(midEllipsis('Charge request received', 48), 'Charge request received');
  // exactly at width
  assert.equal(midEllipsis('abcde', 5), 'abcde');
});

test('exact width: head + ellipsis + tail === width', () => {
  for (const width of [10, 20, 33, 44, 48, 60]) {
    const s = 'x'.repeat(200);
    const out = midEllipsis(s, width);
    assert.equal(codepointLength(out), width, `width ${width}`);
    assert.ok(out.includes('…'));
  }
});

test('keeps BOTH ends — head and tail survive, middle elided', () => {
  const s = 'HEAD_marker' + '_'.repeat(0) + 'm'.repeat(80) + 'TAIL_marker';
  const out = midEllipsis(s.replace(/_/g, ' '), 30);
  assert.ok(out.startsWith('HEAD'), `head kept: ${out}`);
  assert.ok(out.endsWith('marker'), `tail kept: ${out}`);
  assert.ok(out.includes('…'));
});

test('codepoint-safe: never splits a surrogate pair (no mojibake)', () => {
  // Astral emoji are surrogate pairs in UTF-16. A naive .slice can cut one
  // in half and emit U+FFFD-style garbage. Build a string of emoji and crop
  // it across many widths; every output must be valid (no lone surrogate).
  const emoji = '😀🎉🚀🔥🧪💡🌍🛰️🦊🍕'.normalize();
  const s = emoji.repeat(6);
  for (let width = 3; width <= 30; width++) {
    const out = midEllipsis(s, width);
    // A lone surrogate has code unit in [0xD800, 0xDFFF] that is unpaired.
    for (let i = 0; i < out.length; i++) {
      const c = out.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = out.charCodeAt(i + 1);
        assert.ok(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate @${i} width ${width}`);
      }
      if (c >= 0xdc00 && c <= 0xdfff) {
        const prev = out.charCodeAt(i - 1);
        assert.ok(prev >= 0xd800 && prev <= 0xdbff, `lone low surrogate @${i} width ${width}`);
      }
    }
  }
});

test('SPEC ACCEPTANCE: 9 demo names, zero collisions at width 48', () => {
  const cropped = DEMO_NAMES.map((n) => midEllipsis(n.replace(/_/g, ' '), 48));
  const set = new Set(cropped.map((c) => c.toLowerCase()));
  assert.equal(set.size, DEMO_NAMES.length, `collisions:\n${cropped.join('\n')}`);
  // Every cropped name is within budget.
  for (const c of cropped) assert.ok(codepointLength(c) <= 48);
});

test('SPEC ACCEPTANCE: short clean names (rows 8/9) returned verbatim', () => {
  assert.equal(midEllipsis('Charge request received', 48), 'Charge request received');
  assert.equal(midEllipsis('Transaction complete', 48), 'Transaction complete');
});

test('degenerate widths do not throw', () => {
  assert.equal(midEllipsis('abcdef', 1), 'a');
  assert.equal(midEllipsis('abcdef', 0), '');
  assert.equal(midEllipsis('', 10), '');
});
