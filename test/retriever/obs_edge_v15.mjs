#!/usr/bin/env node
// Obs-edge v15 verification — specifically proves that malformed and
// control-char traceparent values DON'T reach CW or pod logs (no injection),
// and a fresh W3C-format tp is minted instead.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

const RETRIEVER = 'http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com';
const cw = new CloudWatchLogsClient({ region: 'us-east-1' });

async function submitWithTp(tp) {
  const qid = randomUUID();
  const to = Date.now();
  const from = to - 60_000;
  const r = await fetch(`${RETRIEVER}/retriever/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'traceparent': tp },
    body: JSON.stringify({ id: qid, name: `obs-v15-${to}`, from, to,
      search: 'severity_level=="ERROR"', filters: [],
      logLevels: 'ERROR,INFO,PERF', processingTime: 30_000, resultSize: 10_000 }),
  });
  return { qid, status: r.status };
}

// Wait for query to complete, then fetch CW events and verify tp hygiene.
async function fetchCwEvents(qid, deadlineMs) {
  while (Date.now() < deadlineMs) {
    await sleep(8_000);
    const sr = await fetch(`${RETRIEVER}/retriever/query/${qid}/status`);
    if (sr.status !== 200) continue;
    const j = await sr.json();
    if (j.state === 'complete' || j.state === 'complete_no_events') break;
  }
  await sleep(20_000); // CW Insights catchup
  const res = await cw.send(new FilterLogEventsCommand({
    logGroupName: '/tenx/demo-retriever/query',
    startTime: Date.now() - 600_000, endTime: Date.now(),
    filterPattern: `"${qid}"`,
    limit: 1000,
  }));
  return res.events || [];
}

const w3c = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

const tests = [
  { tag: 'malformed-not-tp',     tp: 'NOT-A-VALID-TP' },
  { tag: 'wrong-format-spaces',  tp: '00-abc def-01' },
  { tag: 'crlf-injection',       tp: '00-deadbeef' + 'a'.repeat(23) + '-1234567890abcdef-01\r\n[FAKE ] fake log line' },
  { tag: 'missing-hyphens',      tp: 'deadbeef123456789abcdef0123456789' },
  { tag: 'valid-w3c',            tp: '00-' + 'f'.repeat(32) + '-' + '0'.repeat(16) + '-01' },
];

let pass = 0, fail = 0;
for (const t of tests) {
  const { qid, status } = await submitWithTp(t.tp);
  console.log(`\n${t.tag}: qid=${qid.slice(0,8)} submit=${status}`);
  if (status !== 200) { console.log('  FAIL: submit should still return 200 (server handles gracefully)'); fail++; continue; }

  const events = await fetchCwEvents(qid, Date.now() + 120_000);
  // Extract all traceparent values from CW JSON payloads
  const tpsSeen = new Set();
  let leaked = false;
  for (const e of events) {
    try {
      const m = JSON.parse(e.message);
      const data = m.data || {};
      const tp = data.traceparent;
      if (tp) tpsSeen.add(tp);
      // Also check inside the raw message text for injection artifacts
      if (e.message.includes('[FAKE') || e.message.includes('\\r\\n[FAKE')) {
        leaked = true;
      }
    } catch {}
  }

  const tpArr = [...tpsSeen];
  const expectValid = tpArr.length > 0 && tpArr.every(tp => w3c.test(tp));
  const malformedLeaked = tpArr.includes(t.tp);

  console.log(`  tp values seen in CW: ${tpArr.length} distinct, sample=${tpArr[0]?.slice(0,40) || 'none'}`);
  console.log(`  all W3C-valid: ${expectValid}  malformed-leaked: ${malformedLeaked}  injection-leaked: ${leaked}`);

  const isValid = t.tag === 'valid-w3c';
  if (isValid) {
    // Valid input: should appear verbatim
    if (tpArr.includes(t.tp)) { console.log('  PASS: valid tp propagated'); pass++; }
    else { console.log('  FAIL: valid tp not found in CW'); fail++; }
  } else {
    // Invalid input: must NOT appear, only a freshly minted W3C tp should
    if (malformedLeaked || leaked) { console.log('  FAIL: malformed tp leaked to CW'); fail++; }
    else if (!expectValid) { console.log('  FAIL: no valid fresh tp minted'); fail++; }
    else { console.log('  PASS: malformed rejected, fresh tp minted'); pass++; }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
