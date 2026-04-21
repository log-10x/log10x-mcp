#!/usr/bin/env node
// Pod-loss recovery: submit a query, mid-flight delete the stream-worker
// pod, verify the query eventually completes via SQS redelivery.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { execSync } from 'node:child_process';

const STREAMER = 'http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com';

const qid = randomUUID();
const to = Date.now();
const from = to - 60 * 60 * 1000; // wide 60min to ensure many sub-queries
const body = {
  id: qid, name: `pod-loss-${to}`, from, to,
  search: 'severity_level == "ERROR"',
  writeResults: true,
  filters: [], logLevels: 'ERROR,INFO,PERF',
  processingTime: 300_000,
  resultSize: 52428800,
};
await fetch(`${STREAMER}/streamer/query`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
console.log(`submitted qid=${qid}`);

// Wait until stream-worker has dispatched at least a few tasks
await sleep(15_000);
const preStatus = await (await fetch(`${STREAMER}/streamer/query/${qid}/status`)).json();
console.log(`pre-kill: state=${preStatus.state} dispatch=${preStatus.summary?.streamDispatch} wc=${preStatus.summary?.streamWorkerComplete}`);

// Now delete the stream-worker pod
console.log('killing stream-worker pod...');
try {
  const out = execSync('kubectl -n demo delete pod -l cluster=stream-worker --wait=false 2>&1', { encoding: 'utf8' });
  console.log(out.trim());
} catch (e) { console.error('kubectl delete failed:', e.message); }

// Now poll for completion
const deadline = Date.now() + 420_000;
let lastState;
while (Date.now() < deadline) {
  await sleep(6_000);
  const sr = await fetch(`${STREAMER}/streamer/query/${qid}/status`);
  if (sr.status !== 200) continue;
  const j = await sr.json();
  const s = j.summary || {};
  if (j.state !== lastState) {
    console.log(`  state=${j.state} ew=${s.eventsWrittenTotal} dispatch=${s.streamDispatch} wc=${s.streamWorkerComplete}`);
    lastState = j.state;
  }
  if (j.state === 'complete' || j.state === 'complete_no_events') {
    if (s.stackOverflowError > 0) { console.error('FAIL: SOE'); process.exit(3); }
    console.log(`\nPASS: recovered after pod-loss, ew=${s.eventsWrittenTotal}`);
    process.exit(0);
  }
}
console.error('FAIL: timeout without completion');
process.exit(4);
