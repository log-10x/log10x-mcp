#!/usr/bin/env node
// Observability edge cases — adversarial inputs, malformed headers/payloads,
// orphan/ghost qids, verify logs and CW structured payloads stay intact and
// error responses are clean.
import { randomUUID } from 'node:crypto';

const RETRIEVER = 'http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com';

async function submit(body, headers = {}) {
  const r = await fetch(`${RETRIEVER}/retriever/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text().catch(()=>'');
  return { status: r.status, body: text.slice(0, 200) };
}

async function status(qid) {
  const r = await fetch(`${RETRIEVER}/retriever/query/${qid}/status`);
  const t = await r.text().catch(()=>'');
  return { status: r.status, body: t.slice(0, 400) };
}

console.log('=== malformed JSON body ===');
let r = await submit('{not json');
console.log(`  status=${r.status}  body=${r.body}`);

console.log('\n=== empty body ===');
r = await submit('');
console.log(`  status=${r.status}  body=${r.body}`);

console.log('\n=== missing required fields (no from/to/search) ===');
r = await submit({ id: randomUUID(), name: 'missing' });
console.log(`  status=${r.status}  body=${r.body}`);

console.log('\n=== huge json body (50KB search string) ===');
const longSearch = 'severity_level == "ERROR" || ' + Array(2000).fill(`severity_level == "X"`).join(' || ');
r = await submit({ id: randomUUID(), name: 'huge', from: Date.now()-60000, to: Date.now(), search: longSearch });
console.log(`  status=${r.status}  search-len=${longSearch.length}  body=${r.body}`);

console.log('\n=== malformed traceparent header ===');
r = await submit({ id: randomUUID(), name: 'bad-tp', from: Date.now()-60000, to: Date.now(), search: 'severity_level=="ERROR"', logLevels: 'ERROR,INFO,PERF', processingTime: 5000 },
                 { traceparent: 'NOT-A-VALID-TP' });
console.log(`  status=${r.status}  body=${r.body}`);

console.log('\n=== traceparent with control chars ===');
r = await submit({ id: randomUUID(), name: 'ctrl-tp', from: Date.now()-60000, to: Date.now(), search: 'severity_level=="ERROR"', logLevels: 'ERROR,INFO,PERF', processingTime: 5000 },
                 { traceparent: '00-\\x00abc\\r\\n-01' });
console.log(`  status=${r.status}  body=${r.body}`);

console.log('\n=== status for never-submitted qid ===');
const ghostQid = randomUUID();
r = await status(ghostQid);
console.log(`  status=${r.status}  body=${r.body.slice(0,240)}`);

console.log('\n=== status for malformed qid (non-uuid) ===');
r = await status('not-a-valid-qid-../../etc/passwd');
console.log(`  status=${r.status}  body=${r.body.slice(0,200)}`);

console.log('\n=== double-submit with same qid ===');
const dupQid = randomUUID();
const body = { id: dupQid, name: 'dup', from: Date.now()-60000, to: Date.now(), search: 'severity_level=="ERROR"', logLevels: 'ERROR,INFO,PERF', processingTime: 5000 };
const [r1, r2] = await Promise.all([submit(body), submit(body)]);
console.log(`  submit1=${r1.status} submit2=${r2.status}`);

console.log('\n=== content-type: text/plain (wrong) ===');
const r3 = await fetch(`${RETRIEVER}/retriever/query`, {
  method: 'POST', headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify({ id: randomUUID(), from: Date.now()-60000, to: Date.now(), search: '' }),
});
console.log(`  status=${r3.status}`);

console.log('\n=== PASS criteria: no 500 Internal Server Error; no crash ===');
