#!/usr/bin/env node
// Complex-query E2E — edge cases, adversarial shapes, and deep fan-outs that
// exercise beyond the happy path.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const RETRIEVER = 'http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com';

const tests = [
  { tag: 'nested-AND-OR-NOT',     search: '((severity_level=="ERROR" || severity_level=="FATAL") && k8s_namespace=="otel-demo") || (http_code=="500")',
                                  expectPass: true },
  { tag: 'always-false',          search: 'severity_level == "DEFINITELY_NOT_A_VALUE"', expectPass: true, expectZero: true },
  { tag: 'empty-search',          search: '', expectPass: true },
  { tag: 'wide-OR-10-codes',      search: 'http_code=="500" || http_code=="501" || http_code=="502" || http_code=="503" || http_code=="504" || http_code=="505" || http_code=="506" || http_code=="507" || http_code=="508" || http_code=="509"',
                                  expectPass: true },
  { tag: 'substring-long',        search: 'includes(text, "Lorem ipsum dolor sit amet non existent marker 12345")',
                                  expectPass: true, expectZero: true },
  { tag: 'processing-time-1ms',   search: 'severity_level=="ERROR"', extra: { processingTime: 1 }, expectPass: true /* must not hang */ },
  { tag: 'resultSize-zero',       search: 'severity_level=="ERROR"', extra: { resultSize: 0 }, expectPass: true },
  { tag: 'reversed-time',         search: 'severity_level=="ERROR"', extra: { reverseTime: true }, expectPass: true /* must reject or return zero */ },
  { tag: 'deep-fanout-60min-5s',  search: 'severity_level=="ERROR"', window: 60*60*1000, timesliceOverride: 5, expectPass: true },
  { tag: 'sql-injection-ish',     search: 'severity_level == "ERROR"; DROP TABLE users;--"', expectPass: false /* must 400 */ },
];

async function run(t) {
  const qid = randomUUID();
  const to = Date.now();
  const from = to - (t.window || 10*60*1000);
  const effectiveFrom = t.extra?.reverseTime ? to : from;
  const effectiveTo   = t.extra?.reverseTime ? from : to;
  const body = {
    id: qid, name: `cx-${t.tag}-${to}`,
    from: effectiveFrom, to: effectiveTo,
    search: t.search, filters: [],
    logLevels: 'ERROR,INFO,PERF',
    processingTime: t.extra?.processingTime ?? 120_000,
    resultSize: t.extra?.resultSize ?? 1048576,
  };
  const t0 = Date.now();
  const r = await fetch(`${RETRIEVER}/retriever/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const submitLatency = Date.now() - t0;
  const submitBody = await r.text().catch(()=>'');

  if (r.status !== 200) {
    return { qid, tag: t.tag, submitStatus: r.status, submitBody: submitBody.slice(0,120), submitLatencyMs: submitLatency };
  }

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await sleep(5_000);
    const sr = await fetch(`${RETRIEVER}/retriever/query/${qid}/status`);
    if (sr.status !== 200) continue;
    const j = await sr.json();
    const s = j.summary || {};
    if (s.stackOverflowError > 0) return { qid, tag: t.tag, err: 'SOE', summary: s };
    if (j.state === 'complete' || j.state === 'complete_no_events') {
      return { qid, tag: t.tag, submitStatus: 200, submitLatencyMs: submitLatency,
               totalMs: Date.now() - t0, state: j.state, summary: s };
    }
  }
  return { qid, tag: t.tag, err: 'timeout', totalMs: Date.now() - t0 };
}

let passCount = 0, failCount = 0;
for (const t of tests) {
  const r = await run(t);
  let verdict = 'FAIL';
  let why = '';
  if (r.err === 'SOE') why = 'StackOverflowError';
  else if (r.err === 'timeout') why = 'timeout';
  else if (t.expectPass && r.submitStatus === 200) {
    verdict = 'PASS';
    if (t.expectZero && r.summary?.eventsWrittenTotal > 0) { verdict = 'FAIL'; why = `expected zero got ${r.summary.eventsWrittenTotal}`; }
  } else if (!t.expectPass && r.submitStatus !== 200) {
    verdict = 'PASS'; why = `rejected as expected ${r.submitStatus}`;
  } else if (!t.expectPass && r.submitStatus === 200) {
    verdict = 'WARN'; why = 'expected rejection, got 200';
  }
  if (verdict === 'PASS') passCount++; else failCount++;
  const ew = r.summary?.eventsWrittenTotal ?? '-';
  console.log(`${verdict.padEnd(5)}  ${t.tag.padEnd(26)} submit=${r.submitStatus ?? 'N/A'}  ${r.state || r.err || ''}  ew=${ew}  t=${r.totalMs}ms  ${why}`);
}
console.log(`\n${passCount} passed, ${failCount} not-pass, ${tests.length} total`);
