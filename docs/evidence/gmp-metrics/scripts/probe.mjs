// Hard-data E2E for the new GcpManagedPromBackend.
// Uses the real `log10x-poc` GCP project + service-account JSON
// (/tmp/gcp-sa.json, written from the credentials file earlier).
import { createMetricsBackend } from '../../../../build/lib/metrics-backend.js';

const backend = createMetricsBackend({
  kind: 'gcp_managed_prom',
  projectId: 'log10x-poc',
  serviceAccountKeyFile: '/tmp/gcp-sa.json',
});

console.log('=== backend.kind =', backend.kind);
console.log('=== backend.endpoint =', backend.endpoint);

console.log('\n=== listLabels() ===');
const labels = await backend.listLabels();
console.log('count:', labels.length);
console.log('first 20:', labels.slice(0, 20));
console.log('includes __name__?', labels.includes('__name__'));

console.log('\n=== listLabelValues("__name__") (i.e. all metric names) ===');
const names = await backend.listLabelValues('__name__');
console.log('count:', names.length);
console.log('first 5:', names.slice(0, 5));

// Pick a metric name we know exists and query it.
console.log('\n=== queryInstant("count(up)") (Prom standard "up" metric) ===');
const upCount = await backend.queryInstant('count(up)');
console.log(JSON.stringify(upCount, null, 2));

// Try a GMP-domain metric that exists.
const sampleMetric = names.find(n => n.startsWith('logging.googleapis.com/')) || names[0];
console.log(`\n=== queryInstant("count(${sampleMetric})") ===`);
const sample = await backend.queryInstant(`count({__name__="${sampleMetric}"})`);
console.log(JSON.stringify(sample, null, 2));
