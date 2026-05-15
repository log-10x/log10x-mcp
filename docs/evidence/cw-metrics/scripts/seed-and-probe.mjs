// Hard-data E2E probe of the new CloudWatchMetricsBackend adapter
// against real CloudWatch (account 351939435334, region us-east-1,
// namespace Log10x/E2E that holds the `mcp_adapter_setup_probe` metric
// planted earlier via direct PutMetricData).
import { createMetricsBackend } from './build/lib/metrics-backend.js';

// Plant a NEW metric WITH dimensions so we can exercise listLabelValues
// and the bare-selector queryInstant path.
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
const seedClient = new CloudWatchClient({ region: 'us-east-1' });
const now = Date.now();
const planted = [
  { service: 'cart',    pattern: 'p_cart_ok',   bytes: 1234 },
  { service: 'cart',    pattern: 'p_cart_err',  bytes:  567 },
  { service: 'checkout',pattern: 'p_chk_ok',    bytes: 2345 },
  { service: 'payment', pattern: 'p_pay_warn',  bytes:   89 },
];
console.log('[seed] putting 4 datapoints with (service,pattern) dimensions...');
for (const p of planted) {
  await seedClient.send(new PutMetricDataCommand({
    Namespace: 'Log10x/E2E',
    MetricData: [{
      MetricName: 'all_events_summaryBytes',
      Value: p.bytes,
      Timestamp: new Date(now),
      Unit: 'Bytes',
      Dimensions: [
        { Name: 'tenx_user_service', Value: p.service },
        { Name: 'message_pattern',   Value: p.pattern },
      ],
    }],
  }));
}
console.log('[seed] done. Waiting ~120s for CW to surface the new metrics...');

// Sleep helper — CW takes 60-120s typically before ListMetrics sees new dims.
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function pollUntilListed(needed) {
  const { CloudWatchClient, ListMetricsCommand } = await import('@aws-sdk/client-cloudwatch');
  const c = new CloudWatchClient({ region: 'us-east-1' });
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) {
    const r = await c.send(new ListMetricsCommand({
      Namespace: 'Log10x/E2E',
      MetricName: 'all_events_summaryBytes',
    }));
    const found = (r.Metrics || []).flatMap(m => (m.Dimensions || []).filter(d => d.Name === 'tenx_user_service').map(d => d.Value));
    const ok = needed.every(s => found.includes(s));
    if (ok) {
      console.log(`[poll] all ${needed.length} services surfaced after ${Math.round((Date.now()-t0)/1000)}s: ${[...new Set(found)]}`);
      return;
    }
    await sleep(10_000);
  }
  console.log('[poll] timeout; proceeding anyway with whatever surfaced');
}
await pollUntilListed(['cart','checkout','payment']);

const backend = createMetricsBackend({
  kind: 'cloudwatch_metrics',
  region: 'us-east-1',
  namespace: 'Log10x/E2E',
});

console.log('\n=== backend.kind =', backend.kind);
console.log('=== backend.endpoint =', backend.endpoint);

console.log('\n=== listLabels() ===');
const labels = await backend.listLabels();
console.log(labels);

console.log('\n=== listLabelValues("tenx_user_service") ===');
const vals = await backend.listLabelValues('tenx_user_service');
console.log(vals);

console.log('\n=== queryInstant("count(all_events_summaryBytes)") ===');
const c = await backend.queryInstant('count(all_events_summaryBytes)');
console.log(JSON.stringify(c, null, 2));

console.log('\n=== queryInstant("all_events_summaryBytes{tenx_user_service=\\"cart\\"}") ===');
const r = await backend.queryInstant('all_events_summaryBytes{tenx_user_service="cart"}');
console.log(JSON.stringify(r, null, 2));
