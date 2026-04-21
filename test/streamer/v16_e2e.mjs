#!/usr/bin/env node
// v16 E2E — prove both A' (_DONE.json) and C (GetLogEvents-backed R18).
//
// A' test: submit a query with writeResults=true, poll S3 for _DONE.json,
// measure latency from pipeline-complete-log to marker visible.
//
// C test: submit a query, poll R18 /status, measure latency from
// pipeline-complete-log to state=complete|complete_no_events.
//
// Both must beat the v14 baseline (25–30s R18 lag).

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const STREAMER = 'http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com';
const BUCKET = 'tenx-demo-cloud-streamer-351939435334';
const S3_PREFIX = 'indexing-results/tenx/app/qr';
const LOG_GROUP = '/tenx/demo-streamer/query';

const cw = new CloudWatchLogsClient({ region: 'us-east-1' });
const s3 = new S3Client({ region: 'us-east-1' });

async function submit(writeResults) {
  const qid = randomUUID();
  // The otel-demo sample the cron uploads is a STATIC dataset whose events
  // carry historical timestamps (2026-04-19 12:00-20:00 UTC). Indexer keys
  // blobs by event timestamp, not upload time — so current-wall-clock
  // windows return empty-range. Force a window that overlaps the known
  // indexed range to actually exercise scan+stream dispatch.
  const to = 1776659039000;   // 2026-04-19 20:03:59 UTC
  const from = 1776629566000; // 2026-04-19 11:52:46 UTC
  const body = {
    id: qid, name: `v16-${to}`, from, to,
    search: 'severity_level == "ERROR"',
    filters: [], writeResults,
    logLevels: 'ERROR,INFO,PERF',
    processingTime: 180_000, resultSize: 10_485_760,
  };
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${STREAMER}/streamer/query`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 200) return qid;
      if (i === 3) throw new Error(`submit ${r.status}`);
    } catch (e) {
      if (i === 3) throw e;
      await sleep(800 * (i + 1));
    }
  }
  throw new Error('unreachable');
}

async function findCoordinatorCompleteTs(qid, deadlineMs) {
  // Scan CW filter-log-events for the coordinator 'query complete' line;
  // pick the LATEST one (top-level coordinator fires last after all scan
  // subqueries). Returns its timestamp (ms).
  while (Date.now() < deadlineMs) {
    await sleep(3_000);
    const res = await cw.send(new FilterLogEventsCommand({
      logGroupName: LOG_GROUP,
      startTime: Date.now() - 600_000, endTime: Date.now(),
      filterPattern: `"${qid}" "query complete:"`,
      limit: 100,
    }));
    const events = (res.events || []);
    if (events.length > 0) {
      return events.reduce((m, e) => Math.max(m, e.timestamp || 0), 0);
    }
  }
  return null;
}

async function findDoneMarkerTs(qid, deadlineMs) {
  const key = `${S3_PREFIX}/${qid}/_DONE.json`;
  while (Date.now() < deadlineMs) {
    try {
      const r = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      return r.LastModified?.getTime() ?? Date.now();
    } catch {}
    await sleep(500);
  }
  return null;
}

async function pollR18Complete(qid, deadlineMs) {
  while (Date.now() < deadlineMs) {
    try {
      const r = await fetch(`${STREAMER}/streamer/query/${qid}/status`);
      const j = await r.json();
      if (j.state === 'complete' || j.state === 'complete_no_events') return Date.now();
    } catch {}
    await sleep(1_500);
  }
  return null;
}

async function readDone(qid) {
  try {
    const key = `${S3_PREFIX}/${qid}/_DONE.json`;
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const chunks = []; for await (const c of r.Body) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) { return { error: String(e.message || e) }; }
}

// =========== A' TEST: _DONE.json latency ===========
console.log('=== A\' TEST: coordinator _DONE.json marker ===');
{
  const qid = await submit(true);
  console.log(`submitted ${qid}`);
  const [coordTs, markerTs] = await Promise.all([
    findCoordinatorCompleteTs(qid, Date.now() + 120_000),
    findDoneMarkerTs(qid, Date.now() + 120_000),
  ]);
  if (coordTs == null) console.log('FAIL: no coordinator `query complete` found');
  else if (markerTs == null) console.log('FAIL: _DONE.json did not appear within 120s');
  else {
    const lag = markerTs - coordTs;
    console.log(`coordinator complete @ ${new Date(coordTs).toISOString()}`);
    console.log(`_DONE marker @ ${new Date(markerTs).toISOString()}`);
    console.log(`lag = ${lag}ms`);
    const doneBody = await readDone(qid);
    console.log(`body: ${JSON.stringify(doneBody)}`);
    if (lag < 10_000) console.log('PASS: _DONE marker within 10s of coordinator complete');
    else console.log(`WARN: lag >10s (${lag}ms)`);
  }
}

// =========== C TEST: R18 /status latency ===========
console.log('\n=== C TEST: R18 /status with GetLogEvents backend ===');
{
  const qid = await submit(false);
  console.log(`submitted ${qid}`);
  const [coordTs, r18Ts] = await Promise.all([
    findCoordinatorCompleteTs(qid, Date.now() + 180_000),
    pollR18Complete(qid, Date.now() + 180_000),
  ]);
  if (coordTs == null) console.log('FAIL: no coordinator complete found');
  else if (r18Ts == null) console.log('FAIL: R18 never reached complete within 180s');
  else {
    const lag = r18Ts - coordTs;
    console.log(`coordinator complete @ ${new Date(coordTs).toISOString()}`);
    console.log(`R18 state=complete @ ${new Date(r18Ts).toISOString()}`);
    console.log(`lag = ${lag}ms`);
    if (lag < 12_000) console.log('PASS: R18 within 12s of coordinator complete (down from 25s+ on Insights)');
    else console.log(`WARN: lag ${lag}ms > 12s`);
  }
}
