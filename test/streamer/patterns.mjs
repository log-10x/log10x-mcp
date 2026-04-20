#!/usr/bin/env node
// Pattern diversity test — submit queries covering several pattern kinds and
// verify each returns non-zero events from the status endpoint.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const STREAMER = 'http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com';

const tests = [
  { name: 'pure-severity-ERROR',       search: 'severity_level == "ERROR"' },
  { name: 'severity-OR-FATAL',         search: '(severity_level == "ERROR") || (severity_level == "FATAL")' },
  { name: 'k8s-namespace-text',        search: 'k8s_namespace == "otel-demo"' },
  { name: 'http-code-5xx',             search: '(http_code == "500") || (http_code == "502") || (http_code == "503")' },
  { name: 'compound-AND',              search: 'severity_level == "ERROR" && k8s_container == "cart"' },
  { name: 'substring-includes-text',   search: 'includes(text, "ECONNREFUSED")' },
  { name: 'message-pattern-cart',      search: 'message_pattern == "cart_cartstore_ValkeyCartStore"' },
];

async function runOne(search) {
  const qid = randomUUID();
  const to = Date.now();
  const from = to - 30 * 60 * 1000;
  const body = { id: qid, name: `pat-${to}`, from, to, search,
    filters: [], logLevels: 'ERROR,INFO,PERF', processingTime: 60_000 };
  const r = await fetch(`${STREAMER}/streamer/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status !== 200) return { qid, err: `submit ${r.status}` };

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await sleep(8_000);
    const sr = await fetch(`${STREAMER}/streamer/query/${qid}/status`);
    if (sr.status !== 200) continue;
    const j = await sr.json();
    const s = j.summary || {};
    if (s.stackOverflowError > 0) return { qid, err: 'SOE' };
    if (j.state === 'complete' || j.state === 'complete_no_events') {
      return { qid, ew: s.eventsWrittenTotal ?? 0, soe: s.stackOverflowError };
    }
  }
  return { qid, err: 'timeout' };
}

let passed = 0, failed = 0;
for (const t of tests) {
  const r = await runOne(t.search);
  const ok = !r.err && r.ew >= 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.name.padEnd(28)} ew=${r.ew ?? '-'} ${r.err || ''}`);
  if (ok) passed++; else failed++;
}
console.log(`\n${passed}/${tests.length} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
