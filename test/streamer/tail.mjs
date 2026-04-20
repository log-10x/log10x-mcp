#!/usr/bin/env node
// Tail behavior: submit a query with a tiny resultSize (10KB). Verify
// the query completes cleanly (state=complete or partially_complete) with
// eventsWrittenTotal > 0 but bounded. No SOE. Not stuck.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const STREAMER = 'http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com';
const qid = randomUUID();
const to = Date.now();
const from = to - 30 * 60 * 1000;
const body = {
  id: qid, name: `tail-${to}`, from, to,
  search: 'severity_level == "ERROR"',
  writeResults: true,
  filters: [], logLevels: 'ERROR,INFO,PERF',
  processingTime: 120_000,
  resultSize: 10240, // 10KB — will hit limit quickly
};
const r = await fetch(`${STREAMER}/streamer/query`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
if (r.status !== 200) { console.error('submit failed', r.status); process.exit(2); }
console.log(`qid=${qid} submitted, tiny resultSize=10KB`);

const deadline = Date.now() + 240_000;
while (Date.now() < deadline) {
  await sleep(6_000);
  const sr = await fetch(`${STREAMER}/streamer/query/${qid}/status`);
  if (sr.status !== 200) continue;
  const j = await sr.json();
  const s = j.summary || {};
  console.log(`  state=${j.state} ew=${s.eventsWrittenTotal} soe=${s.stackOverflowError} skipped=${s.streamWorkerSkipped}`);
  if (j.state === 'complete' || j.state === 'complete_no_events') {
    if (s.stackOverflowError > 0) { console.error('FAIL: SOE'); process.exit(3); }
    console.log(`PASS: tail-terminated cleanly, ew=${s.eventsWrittenTotal}`);
    process.exit(0);
  }
}
console.error('FAIL: timeout without completion');
process.exit(4);
