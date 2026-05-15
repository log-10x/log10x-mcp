// Find a metric in GMP that actually has current data + verify the
// MCP adapter returns it.
import { createMetricsBackend } from '../../../../build/lib/metrics-backend.js';

const backend = createMetricsBackend({
  kind: 'gcp_managed_prom',
  projectId: 'log10x-poc',
  serviceAccountKeyFile: '/tmp/gcp-sa.json',
});

const names = await backend.listLabelValues('__name__');
console.log(`[scan] ${names.length} metric names total`);

// Skip the actions.googleapis.com (Google demos / smarthome) and look for
// ones that this project would actively emit — likely the audit/IAM ones.
const candidates = names.filter(n =>
  n.includes('cloudaudit') ||
  n.includes('iam.googleapis.com') ||
  n.includes('serviceusage.googleapis.com') ||
  n.includes('storage.googleapis.com') ||
  n.includes('logging.googleapis.com/log_entry_count')
).slice(0, 12);
console.log('[scan] checking', candidates.length, 'candidate metrics for non-empty count');

for (const name of candidates) {
  try {
    const r = await backend.queryInstant(`count({__name__="${name}"})`);
    const v = r.data?.result?.[0]?.value?.[1];
    if (v && v !== '0') {
      console.log(`  → ${name}: count=${v}  [HIT]`);
    } else {
      console.log(`  → ${name}: empty`);
    }
  } catch (e) {
    console.log(`  → ${name}: error ${e.message.slice(0,80)}`);
  }
}

// Now do a "guaranteed will return something" query against the
// `up` metric across all jobs (a Prom convention metric that GMP-managed
// agents always emit).
console.log('\n=== series scan: query{__name__=~"up|kubernetes.*"} via query_range ===');
const end = Math.floor(Date.now()/1000);
const start = end - 24*3600;
const range = await backend.queryRange('count({__name__=~"up"})', start, end, 3600);
console.log('queryRange status:', range.status, 'result entries:', range.data?.result?.length ?? 0);
console.log(JSON.stringify(range, null, 2).slice(0, 800));

// Try a much-broader query that should return SOMETHING from this project.
console.log('\n=== sum by job over /logging.googleapis.com/log_entry_count (any time) ===');
const r2 = await backend.queryInstant('group by(log)({__name__="logging.googleapis.com/log_entry_count"})');
console.log(JSON.stringify(r2, null, 2).slice(0, 800));
