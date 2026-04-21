#!/usr/bin/env node
// P95/P99 latency over N serial runs of a small window query.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const STREAMER = 'http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com';
const N = parseInt(process.argv[2] || '10');

async function runOne() {
  const qid = randomUUID();
  const to = Date.now();
  const from = to - 10 * 60 * 1000;
  const body = { id: qid, name: `lat-${to}`, from, to,
    search: 'severity_level=="ERROR"',
    filters: [], logLevels: 'ERROR,INFO,PERF', processingTime: 60_000 };
  const t0 = Date.now();
  const r = await fetch(`${STREAMER}/streamer/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status !== 200) throw new Error(`submit ${r.status}`);
  // poll status until completion
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sleep(3_000);
    const sr = await fetch(`${STREAMER}/streamer/query/${qid}/status`);
    if (sr.status !== 200) continue;
    const j = await sr.json();
    const s = j.summary || {};
    if (j.state === 'complete' || j.state === 'complete_no_events') {
      return { ms: Date.now() - t0, ew: s.eventsWrittenTotal ?? 0 };
    }
  }
  return { ms: Date.now() - t0, ew: -1, timedOut: true };
}

const results = [];
for (let i = 0; i < N; i++) {
  const r = await runOne();
  console.log(`run ${i+1}: ${r.ms}ms, ew=${r.ew}${r.timedOut ? ' (TIMEOUT)' : ''}`);
  results.push(r.ms);
}
results.sort((a,b)=>a-b);
const pct = (p) => results[Math.min(results.length-1, Math.floor(results.length * p))];
console.log(`\nN=${N}  p50=${pct(0.5)}ms  p95=${pct(0.95)}ms  p99=${pct(0.99)}ms  min=${results[0]}ms  max=${results[results.length-1]}ms`);
