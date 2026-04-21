#!/usr/bin/env node
// Latency root-cause — submit a query with deterministic tp, measure stages
// from CW log timestamps: submit, query started, scan dispatched, scan
// complete, stream dispatch, worker start, worker complete, results writer
// complete. Reveals WHICH stage is the tail contributor.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

const STREAMER = 'http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com';
const cw = new CloudWatchLogsClient({ region: 'us-east-1' });

async function one() {
  const qid = randomUUID();
  const to = Date.now();
  const from = to - 10 * 60 * 1000;
  const submitAt = Date.now();
  const tp = `00-${randomUUID().replace(/-/g,'')}-0123456789abcdef-01`;
  const body = { id: qid, name: `diag-${to}`, from, to,
    search: 'severity_level == "ERROR"', filters: [],
    logLevels: 'ERROR,INFO,PERF', processingTime: 120_000, resultSize: 10485760 };
  await fetch(`${STREAMER}/streamer/query`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'traceparent': tp }, body: JSON.stringify(body) });
  // Poll R18 until complete
  let endState;
  for (;;) {
    await sleep(2_000);
    const sr = await fetch(`${STREAMER}/streamer/query/${qid}/status`);
    if (sr.status !== 200) continue;
    const j = await sr.json();
    if (j.state === 'complete' || j.state === 'complete_no_events') { endState = j; break; }
  }
  const completeDetectedAt = Date.now();

  // Pull CW timeline
  await sleep(30_000); // CW Insights lag; give it time
  const res = await cw.send(new FilterLogEventsCommand({
    logGroupName: '/tenx/demo-streamer/query',
    startTime: submitAt - 5000,
    endTime: completeDetectedAt + 15000,
    filterPattern: `"${qid}"`,
    limit: 5000,
  }));
  const events = (res.events || []).map(e => {
    try { return { ts: e.timestamp, ...JSON.parse(e.message) }; } catch { return { ts: e.timestamp, message: e.message }; }
  });
  // Bucketize by stage marker
  const stages = {
    submit:                submitAt,
    firstQueryStarted:     null,
    firstScanDispatched:   null,
    firstScanComplete:     null,
    firstStreamDispatch:   null,
    firstWorkerStarted:    null,
    firstWorkerComplete:   null,
    firstResultsWriterComplete: null,
    lastWorkerComplete:    null,
    lastResultsWriterComplete: null,
    r18DetectedComplete:   completeDetectedAt,
  };
  for (const e of events) {
    const m = e.message || '';
    if (m.includes('query started') && !m.includes('timeslice=0ms')) stages.firstQueryStarted = stages.firstQueryStarted || e.ts;
    if (m.includes('scan dispatched')) stages.firstScanDispatched = stages.firstScanDispatched || e.ts;
    if (m.includes('scan complete')) stages.firstScanComplete = stages.firstScanComplete || e.ts;
    if (m.includes('stream dispatch')) stages.firstStreamDispatch = stages.firstStreamDispatch || e.ts;
    if (m.includes('stream worker started')) stages.firstWorkerStarted = stages.firstWorkerStarted || e.ts;
    if (m.includes('stream worker complete')) {
      stages.firstWorkerComplete = stages.firstWorkerComplete || e.ts;
      stages.lastWorkerComplete = e.ts;
    }
    if (m.includes('results writer complete')) {
      stages.firstResultsWriterComplete = stages.firstResultsWriterComplete || e.ts;
      stages.lastResultsWriterComplete = e.ts;
    }
  }
  return { qid, tp, stages, eventsCount: events.length, endState };
}

const n = parseInt(process.argv[2] || '5');
const results = [];
for (let i = 0; i < n; i++) {
  const r = await one();
  const base = r.stages.submit;
  const offset = (k) => r.stages[k] ? (r.stages[k] - base) + 'ms' : 'NA';
  console.log(`\n=== run ${i+1} qid=${r.qid.slice(0,8)} ===`);
  for (const k of ['submit','firstQueryStarted','firstScanDispatched','firstScanComplete','firstStreamDispatch','firstWorkerStarted','firstWorkerComplete','firstResultsWriterComplete','lastWorkerComplete','lastResultsWriterComplete','r18DetectedComplete']) {
    console.log(`  ${k.padEnd(30)} ${offset(k)}`);
  }
  console.log(`  CW events for qid: ${r.eventsCount}  final state: ${r.endState?.state}  ew: ${r.endState?.summary?.eventsWrittenTotal}`);
  results.push(r);
}
