#!/usr/bin/env node
// Ground-truth correctness using R18 status endpoint.
// Relies on GET /retriever/query/{qid}/status which runs CW Logs Insights to
// aggregate eventsWrittenTotal from "results writer complete: N events" lines.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const RETRIEVER_URL = 'http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com';
const BUCKET = 'tenx-demo-cloud-retriever-351939435334';
const s3 = new S3Client({ region: 'us-east-1' });
const hdrs = { 'Content-Type': 'application/json' };

const PATTERN_TEXT = 'cart.cartstore.ValkeyCartStore';
const PATTERN_NAME = 'cart_cartstore_ValkeyCartStore';

async function countInOneFile() {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'app/', MaxKeys: 5 }));
  const key = list.Contents[0].Key;
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = []; for await (const c of obj.Body) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  let count = 0, idx = 0;
  while ((idx = body.indexOf(PATTERN_TEXT, idx)) !== -1) { count++; idx += PATTERN_TEXT.length; }
  return { key, perFile: count, bytes: body.length };
}

async function submit() {
  const to = Date.now();
  const from = to - 60 * 60 * 1000;
  const qid = randomUUID();
  const body = {
    id: qid, name: `ground-truth-${to}`, from, to,
    search: `message_pattern == "${PATTERN_NAME}"`,
    filters: [], writeResults: true, logLevels: 'ERROR,INFO,PERF',
    processingTime: 600_000,
    // Default resultSize in config.yaml is 10MB; 60 files × 1159 events each
    // at ~2.5KB/event = ~170MB. Raise to 500MB so the ratio measurement
    // isn't capped by the byte budget.
    resultSize: 524288000,
  };
  const r = await fetch(`${RETRIEVER_URL}/retriever/query`, {
    method: 'POST', headers: hdrs, body: JSON.stringify(body),
  });
  if (r.status !== 200) throw new Error(`submit failed: ${r.status}`);
  return qid;
}

async function pollStatus(qid, deadlineMs) {
  let stableCount = 0;
  let lastEw = -1;
  while (Date.now() < deadlineMs) {
    await sleep(10_000);
    const r = await fetch(`${RETRIEVER_URL}/retriever/query/${qid}/status`);
    if (r.status !== 200) { console.log(`  http ${r.status}`); continue; }
    const j = await r.json();
    const s = j.summary || {};
    console.log(`  state=${j.state} qs=${s.queryStarted} qc=${s.queryComplete} sd=${s.streamDispatch} wc=${s.streamWorkerComplete} rwc=${s.resultsWriterComplete} ew=${s.eventsWrittenTotal} soe=${s.stackOverflowError}`);
    if (s.stackOverflowError > 0) throw new Error('StackOverflowError during query');
    // Settle: once eventsWrittenTotal stabilises across 2 consecutive polls
    // AND streamDispatch > 0 AND resultsWriterComplete >= streamDispatch,
    // consider the query fully resolved. Covers the case where no more work
    // is being dispatched even if queryComplete doesn't exactly match queryStarted.
    if (s.streamDispatch > 0 && s.resultsWriterComplete >= s.streamDispatch) {
      if (s.eventsWrittenTotal === lastEw) {
        stableCount++;
        if (stableCount >= 1) return { ...j, ...s };
      } else {
        stableCount = 0;
        lastEw = s.eventsWrittenTotal;
      }
    }
  }
  throw new Error('timeout waiting for completion');
}

const { key, perFile, bytes } = await countInOneFile();
console.log(`raw sample: ${key} (${bytes} B)`);
console.log(`  '${PATTERN_TEXT}' occurs ${perFile} times per file`);
console.log(`  expected over 60min: ~${perFile * 60} (60 files of identical content)`);

const qid = await submit();
console.log(`submitted qid=${qid}`);

const status = await pollStatus(qid, Date.now() + 240_000);

const expected = perFile * 60;
const actual = status.eventsWrittenTotal;
const ratio = actual / expected;
console.log(`retriever=${actual}, expected=${expected}, ratio=${ratio.toFixed(3)}`);
if (ratio < 0.9 || ratio > 1.1) {
  console.log(`  WARN: off-target by >10%`);
  process.exit(3);
}
console.log('PASS: within 10% of ground truth');
