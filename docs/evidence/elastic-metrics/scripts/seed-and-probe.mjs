// Hard-data E2E for the new ElasticMetricsBackend adapter.
// Plants 4 docs in the Micrometer-ES schema, then verifies the MCP
// adapter returns them byte-exact.
import { createMetricsBackend } from '../../../../build/lib/metrics-backend.js';

const ES_URL = 'http://localhost:9200';
const INDEX = 'micrometer-metrics-2026-05';

const planted = [
  { service: 'cart',    pattern: 'p_cart_ok',   count: 1234 },
  { service: 'cart',    pattern: 'p_cart_err',  count:  567 },
  { service: 'checkout',pattern: 'p_chk_ok',    count: 2345 },
  { service: 'payment', pattern: 'p_pay_warn',  count:   89 },
];

// Note: seed via raw fetch — bulk indexing was done from shell already,
// but re-seeding here makes the script self-contained for repro.
const now = new Date().toISOString();
const bulkLines = planted.flatMap(p => [
  JSON.stringify({ index: { _index: INDEX } }),
  JSON.stringify({
    '@timestamp': now,
    name: 'all_events_summaryBytes',
    type: 'counter',
    tenx_user_service: p.service,
    message_pattern: p.pattern,
    count: p.count,
  }),
]).join('\n') + '\n';

console.log('[seed] re-indexing 4 docs into', INDEX);
const r = await fetch(`${ES_URL}/_bulk?refresh=wait_for`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-ndjson' },
  body: bulkLines,
});
const seed = await r.json();
console.log('[seed] errors:', seed.errors, 'items:', (seed.items || []).length);

const backend = createMetricsBackend({
  kind: 'elastic_metrics',
  url: ES_URL,
  index: INDEX,
});

console.log('\n=== backend.kind =', backend.kind);
console.log('=== backend.endpoint =', backend.endpoint);

console.log('\n=== listLabels() ===');
console.log(await backend.listLabels());

console.log('\n=== listLabelValues("tenx_user_service") ===');
console.log(await backend.listLabelValues('tenx_user_service'));

console.log('\n=== queryInstant("count(all_events_summaryBytes)") ===');
console.log(JSON.stringify(await backend.queryInstant('count(all_events_summaryBytes)'), null, 2));

console.log('\n=== queryInstant("all_events_summaryBytes{tenx_user_service=\\"cart\\"}") ===');
console.log(JSON.stringify(await backend.queryInstant('all_events_summaryBytes{tenx_user_service="cart"}'), null, 2));

console.log('\n=== queryInstant("all_events_summaryBytes") (no filter) ===');
console.log(JSON.stringify(await backend.queryInstant('all_events_summaryBytes'), null, 2));
