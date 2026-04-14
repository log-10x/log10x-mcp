import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTemplates,
  parseEncoded,
  parseAggregated,
} from '../src/lib/cli-output-parser.js';

const SAMPLE_TEMPLATES_JSON = `{"templateHash":"@[I !@j+lo","template":"$(yyyy-MM-dd'T'HH:mm:ss'Z') INFO checkout-svc tenant=acme-corp order=$ status=success latency_ms=$"}
{"templateHash":"Qf7d.0a:QS","template":"$(yyyy-MM-dd'T'HH:mm:ss'Z') INFO checkout-svc tenant=foo-inc order=$ status=success latency_ms=$"}
{"templateHash":"-.gLkh]de/2","template":"$(yyyy-MM-dd'T'HH:mm:ss'Z') ERROR checkout-svc tenant=acme-corp order=$ status=failed reason=payment_gateway_timeout"}`;

const SAMPLE_ENCODED_LOG = `~@[I !@j+lo,1776067921000,12345,45
~Qf7d.0a:QS,1776067922000,12346,51
~-.gLkh]de/2,1776067923000,12347`;

const SAMPLE_AGGREGATED_CSV = `severity_level,message_pattern,http_code,http_message,k8s_pod,k8s_container,k8s_namespace,tenx_user_service,tenx_user_process,summaryVolume,summaryBytes,summaryTotals
INFO,checkout_svc_tenant_acme_corp_order_status_success_latency_ms,45,,,,,,,1,96,
INFO,checkout_svc_tenant_foo_inc_order_status_success_latency_ms,51,,,,,,,1,94,
ERROR,checkout_svc_tenant_acme_corp_order_status_failed_reason_payment_gateway_timeout,,,,,,,,1,112,`;

test('parseTemplates strips `~` prefix from hashes and keys by normalized hash', () => {
  const map = parseTemplates(SAMPLE_TEMPLATES_JSON);
  assert.equal(map.size, 3);
  // Hash in templates.json is "@[I !@j+lo" (no ~); the map is keyed by this exact string.
  assert.ok(map.has('@[I !@j+lo'));
  assert.ok(map.has('Qf7d.0a:QS'));
  assert.ok(map.has('-.gLkh]de/2'));
});

test('parseTemplates extracts slot preceding tokens from bare `$` markers', () => {
  const map = parseTemplates(SAMPLE_TEMPLATES_JSON);
  const tpl = map.get('@[I !@j+lo');
  assert.ok(tpl);
  assert.ok(tpl.variableSlots);
  // 3 slots: timestamp ($(...)), order ($), latency_ms ($)
  assert.equal(tpl.variableSlots.length, 3);
  // Slot 0 = timestamp from the $(yyyy-MM-dd...) format spec
  assert.equal(tpl.variableSlots[0].name, 'timestamp');
  // Slot 1 preceding token ends with `order=`
  assert.ok(tpl.variableSlots[1].precedingToken);
  assert.match(tpl.variableSlots[1].precedingToken!, /order=$/);
  // Slot 2 preceding token ends with `latency_ms=`
  assert.match(tpl.variableSlots[2].precedingToken!, /latency_ms=$/);
});

test('parseEncoded strips `~` prefix to match templates.json hash keys', () => {
  const events = parseEncoded(SAMPLE_ENCODED_LOG);
  assert.equal(events.length, 3);
  assert.equal(events[0].templateHash, '@[I !@j+lo');
  assert.deepEqual(events[0].values, ['1776067921000', '12345', '45']);
  assert.equal(events[1].templateHash, 'Qf7d.0a:QS');
  assert.equal(events[2].templateHash, '-.gLkh]de/2');
});

test('parseEncoded handles missing trailing values gracefully', () => {
  // Real-world: some lines have fewer values than the template slot count.
  const events = parseEncoded(`~abc,1,2
~def`);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].values, ['1', '2']);
  assert.deepEqual(events[1].values, []);
});

test('parseAggregated reads header columns by name, not position', () => {
  const rows = parseAggregated(SAMPLE_AGGREGATED_CSV);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].severity, 'INFO');
  assert.equal(rows[0].pattern, 'checkout_svc_tenant_acme_corp_order_status_success_latency_ms');
  assert.equal(rows[2].severity, 'ERROR');
});

test('parseAggregated returns empty array when header is missing', () => {
  assert.deepEqual(parseAggregated(''), []);
  assert.deepEqual(parseAggregated('only one line'), []);
});
