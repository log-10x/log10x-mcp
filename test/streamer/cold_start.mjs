#!/usr/bin/env node
// Cold-start latency — delete all query-handler pods; measure time from
// `kubectl delete` completion to first successful 200 /q/health, then time
// from 200 to a query actually completing.
import { setTimeout as sleep } from 'node:timers/promises';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const STREAMER = 'http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com';

console.log('=== cold start: kill query-handler pods ===');
const killAt = Date.now();
try { execSync('kubectl -n demo delete pod -l cluster=query-handler --wait=false 2>&1', { encoding: 'utf8' }); } catch (e) { console.error(e.message); process.exit(2); }

// Phase 1: wait for /q/health to respond 200
let healthyAt = null;
for (;;) {
  await sleep(500);
  try {
    const r = await fetch(`${STREAMER}/q/health`);
    if (r.status === 200) { healthyAt = Date.now(); break; }
  } catch {}
  if (Date.now() - killAt > 180_000) { console.error('FAIL: health never returned 200 within 3min'); process.exit(3); }
}
console.log(`/q/health 200 after ${healthyAt - killAt}ms`);

// Phase 2: submit a small query immediately and time full round-trip
const qid = randomUUID();
const to = Date.now();
const from = to - 60_000;
const submitAt = Date.now();
const r = await fetch(`${STREAMER}/streamer/query`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: qid, name: `cold-${to}`, from, to,
    search: 'severity_level=="ERROR"', filters: [],
    logLevels: 'ERROR,INFO,PERF', processingTime: 60_000, resultSize: 1048576 }),
});
const submitLatency = Date.now() - submitAt;
console.log(`submit status=${r.status}, submit latency=${submitLatency}ms`);

const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  await sleep(3_000);
  let sr;
  try { sr = await fetch(`${STREAMER}/streamer/query/${qid}/status`); }
  catch { continue; }  // LB keepalive reset / HPA churn — retry
  if (sr.status !== 200) continue;
  let j;
  try { j = await sr.json(); } catch { continue; }
  if (j.state === 'complete' || j.state === 'complete_no_events') {
    const totalMs = Date.now() - submitAt;
    console.log(`query complete after submit in ${totalMs}ms (ew=${j.summary?.eventsWrittenTotal ?? 0})`);
    console.log(`\ncold-start breakdown:`);
    console.log(`  kill -> healthy: ${healthyAt - killAt}ms`);
    console.log(`  healthy -> submit returned: ${submitLatency}ms`);
    console.log(`  submit -> complete: ${totalMs}ms`);
    console.log(`  TOTAL kill -> complete: ${Date.now() - killAt}ms`);
    process.exit(0);
  }
}
console.error('FAIL: query did not complete within 3 min post cold-start');
process.exit(4);
