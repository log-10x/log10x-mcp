// Verify the MCP GMP adapter sees the planted `log10x_test_planted`
// metric in its label-values listing (write→read roundtrip).
import { createMetricsBackend } from '../../../../build/lib/metrics-backend.js';

const backend = createMetricsBackend({
  kind: 'gcp_managed_prom',
  projectId: 'log10x-poc',
  serviceAccountKeyFile: '/tmp/gcp-sa.json',
});

console.log('=== backend.kind =', backend.kind);
console.log('=== backend.endpoint =', backend.endpoint);

// Hard-data check: the metric name we just planted via the Cloud
// Monitoring timeSeries:create API ('log10x_test_planted', under
// 'prometheus.googleapis.com/log10x_test_planted/counter') should be
// present in the adapter's __name__ values list.
const names = await backend.listLabelValues('__name__');
const planted = names.filter(n => n === 'log10x_test_planted');
console.log(`\nTotal metric names: ${names.length}`);
console.log(`Planted matches: ${JSON.stringify(planted)}`);

if (planted.length !== 1) {
  console.error('FAIL: planted metric not found in adapter listing');
  process.exit(1);
}
console.log('PASS: write -> read roundtrip via adapter');

// Sanity check: GMP-specific PromQL behavior preserved
// (=~ regex on __name__ is unsupported per GMP)
console.log('\n=== GMP behavior preserved: =~ on __name__ should error ===');
try {
  await backend.queryInstant('count({__name__=~"up"})');
  console.log('UNEXPECTED: query did not error');
} catch (e) {
  console.log('expected error surfaced:', e.message.slice(0, 200));
}

console.log('\n=== listLabels() also includes tenx_user_service ===');
const labels = await backend.listLabels();
console.log(`Total labels: ${labels.length}`);
console.log('tenx_user_service present?', labels.includes('tenx_user_service'));
console.log('message_pattern present?', labels.includes('message_pattern'));
