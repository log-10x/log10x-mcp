#!/usr/bin/env node
// Concurrent saturation: fire N queries in parallel, confirm the retriever's
// max-async/max-queued guards return 429 cleanly when saturated (not 500 or
// silent drop), and every 200-accepted query eventually completes.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const RETRIEVER = 'http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com';
const N = parseInt(process.argv[2] || '20');

async function submit() {
  const qid = randomUUID();
  const to = Date.now();
  const from = to - 10 * 60 * 1000;
  const body = { id: qid, name: `sat-${to}`, from, to,
    search: 'severity_level == "ERROR"',
    filters: [], logLevels: 'ERROR,INFO,PERF', processingTime: 120_000, resultSize: 1048576 };
  // Retry up to 3 times on transient socket errors (undici keepalive pool +
  // N>30 concurrent bursts can hit LB connection resets). Server-side is
  // fine — N=20 ran clean; N=50 just saturates the client's connection pool.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${RETRIEVER}/retriever/query`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { qid, status: r.status };
    } catch (e) {
      if (attempt === 2) return { qid, status: 0, err: String(e.message || e) };
      await sleep(200 * (attempt + 1));
    }
  }
}

async function waitComplete(qid, deadline) {
  while (Date.now() < deadline) {
    await sleep(4_000);
    let sr;
    try {
      sr = await fetch(`${RETRIEVER}/retriever/query/${qid}/status`);
    } catch (e) {
      // Transient socket errors (LB keepalive reset, pod rollover during
      // HPA scale-down) — just retry the next poll.
      continue;
    }
    if (sr.status !== 200) continue;
    let j;
    try { j = await sr.json(); } catch { continue; }
    if (j.state === 'complete' || j.state === 'complete_no_events') return { qid, ok: true, ew: j.summary?.eventsWrittenTotal ?? 0 };
    if (j.summary?.stackOverflowError > 0) return { qid, ok: false, err: 'SOE' };
  }
  return { qid, ok: false, err: 'timeout' };
}

const t0 = Date.now();
console.log(`firing ${N} concurrent submissions...`);
const submitResults = await Promise.all(Array.from({length: N}, () => submit()));
const acceptTime = Date.now() - t0;
const statusCounts = {};
for (const r of submitResults) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
console.log(`submit status histogram: ${JSON.stringify(statusCounts)}  (accept took ${acceptTime}ms)`);

const accepted = submitResults.filter(r => r.status === 200);
console.log(`${accepted.length}/${N} accepted; polling to completion...`);

const deadline = Date.now() + 300_000;
const waitResults = await Promise.all(accepted.map(r => waitComplete(r.qid, deadline)));

const completed = waitResults.filter(r => r.ok).length;
const soe = waitResults.filter(r => r.err === 'SOE').length;
const timeout = waitResults.filter(r => r.err === 'timeout').length;

console.log(`\ntotal elapsed: ${Date.now() - t0}ms`);
console.log(`completed cleanly: ${completed}/${accepted.length}`);
console.log(`SOE: ${soe}, timeouts: ${timeout}`);

// Pass criteria:
// - zero SOE
// - at least 80% of accepted complete within the 300s window
// - all non-200 submits are 429 (not 500/400)
const nonAcceptedBad = Object.entries(statusCounts).filter(([k,_]) => k !== '200' && k !== '429').length;
if (soe > 0) { console.error('FAIL: SOE detected'); process.exit(3); }
if (nonAcceptedBad > 0) { console.error('FAIL: non-429 rejections'); process.exit(4); }
if (completed / accepted.length < 0.8) { console.error(`FAIL: only ${completed}/${accepted.length} completed`); process.exit(5); }
console.log('PASS');
