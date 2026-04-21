#!/usr/bin/env node
// Ground-truth correctness: download the raw log, count occurrences of a known
// pattern text over a 60min window, compare to streamer's reported count.
//
// Known fact: indexer cron drops a file every minute containing ~21MB of
// identical otel-sample content, just re-timestamped to "now". That means
// every minute the archive grows by one 21MB file. Over a 60-min window we
// expect ~60 * N matching events for a pattern that appears N times in one
// sample file.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const STREAMER_URL = 'http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com';
const BUCKET = 'tenx-demo-cloud-streamer-351939435334';
const LG = '/tenx/demo-streamer/query';
const hdrs = { 'Content-Type': 'application/json' };
const s3 = new S3Client({ region: 'us-east-1' });
const cw = new CloudWatchLogsClient({ region: 'us-east-1' });

// Pick a pattern string that's common in otel-sample — 'cart_cartstore_ValkeyCartStore'
const PATTERN_TEXT = 'cart.cartstore.ValkeyCartStore';  // literal text in raw logs
const PATTERN_NAME = 'cart_cartstore_ValkeyCartStore';  // normalized identity

// 1) Count pattern occurrences in a single sample file (the 'unit per minute')
async function countPatternInOneFile() {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'app/', MaxKeys: 5 }));
  const key = list.Contents[0].Key;
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const c of obj.Body) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  // Count substring occurrences
  let count = 0, idx = 0;
  while ((idx = body.indexOf(PATTERN_TEXT, idx)) !== -1) { count++; idx += PATTERN_TEXT.length; }
  return { key, perFile: count, bytes: body.length };
}

// 2) Submit a streamer query over 60min and retrieve the count.
async function submitAndCount() {
  const to = Date.now();
  const from = to - 60 * 60 * 1000;
  const qid = randomUUID();
  const body = {
    id: qid, name: `ground-truth-${to}`,
    from, to,
    search: `message_pattern == "${PATTERN_NAME}"`,
    filters: [], writeResults: false, logLevels: 'ERROR,INFO,PERF',
    processingTime: 600_000,
  };
  const r = await fetch(`${STREAMER_URL}/streamer/query`, {
    method: 'POST', headers: hdrs, body: JSON.stringify(body),
  });
  if (r.status !== 200) throw new Error(`submit failed: ${r.status} ${await r.text()}`);

  // Poll CW for completion markers from this qid
  const start = Date.now() - 5000;
  const deadline = Date.now() + 240_000;
  let totalMatched = 0;
  let finished = false;

  while (Date.now() < deadline && !finished) {
    await sleep(8_000);
    const res = await cw.send(new FilterLogEventsCommand({
      logGroupName: LG,
      startTime: start,
      filterPattern: `"${qid}"`,
      limit: 10000,
    }));
    let seenScanComplete = 0, expectedScans = 0;
    totalMatched = 0;
    for (const ev of (res.events || [])) {
      const m = ev.message;
      // Parse JSON payload
      let j; try { j = JSON.parse(m); } catch { continue; }
      const data = j.data;
      if (!data) continue;
      if (data.includes('scan started') && data.includes('tasks')) {
        const match = data.match(/(\d+) tasks/);
        if (match) expectedScans = Math.max(expectedScans, parseInt(match[1]));
      }
      if (data.includes('scan completed') || data.includes('results writer complete')) {
        seenScanComplete++;
      }
      if (data.includes('worker complete') || data.includes('results writer complete')) {
        const match = data.match(/(\d+) events/) || data.match(/events=(\d+)/);
        if (match) totalMatched += parseInt(match[1]);
      }
    }
    if (expectedScans > 0 && seenScanComplete >= expectedScans) finished = true;
  }
  return { qid, totalMatched, finished };
}

const { key, perFile, bytes } = await countPatternInOneFile();
console.log(`raw sample: ${key}`);
console.log(`  ${bytes} bytes, '${PATTERN_TEXT}' occurs ${perFile} times per file`);
console.log(`expected over 60min: ~${perFile * 60} (60 files, identical content)`);

const { qid, totalMatched, finished } = await submitAndCount();
console.log(`streamer qid=${qid} finished=${finished} matched=${totalMatched}`);
const expected = perFile * 60;
const ratio = totalMatched / expected;
console.log(`ratio streamer/expected = ${ratio.toFixed(3)} (1.0 = perfect)`);
if (ratio < 0.8 || ratio > 1.2) {
  console.log(`  WARN: off-target by >20%`);
  process.exit(3);
}
console.log(`PASS: within 20% of ground truth`);
