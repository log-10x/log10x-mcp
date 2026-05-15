// Re-test bare-selector queryInstant after CW propagation settled.
import { createMetricsBackend } from './build/lib/metrics-backend.js';

const backend = createMetricsBackend({
  kind: 'cloudwatch_metrics',
  region: 'us-east-1',
  namespace: 'Log10x/E2E',
});

console.log('=== queryInstant("all_events_summaryBytes{tenx_user_service=\\"cart\\"}") ===');
const r1 = await backend.queryInstant('all_events_summaryBytes{tenx_user_service="cart"}');
console.log(JSON.stringify(r1, null, 2));

console.log('\n=== queryInstant("all_events_summaryBytes") (no filter) ===');
const r2 = await backend.queryInstant('all_events_summaryBytes');
console.log(JSON.stringify(r2, null, 2));
