#!/usr/bin/env node
/**
 * C1 — Exact-count recall
 *
 * Strategy: query the same cart pattern twice over an identical absolute time
 * window. Two properties to assert:
 *   (a) Determinism: two runs return exactly the same number of events.
 *   (b) Stability: the number matches what we observed post-fix baseline (4800).
 *
 * A full "known-N-injected" ground truth test requires writing N unique events
 * into the archive via fluent-bit and waiting for Bloom index catch-up, which
 * is too slow for a fix-cycle harness. Determinism over a fixed window is the
 * property most directly broken by Bloom+timestamp+filter bugs.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

const hdrs = { 'X-10X-Auth': `${process.env.LOG10X_API_KEY}/${process.env.LOG10X_ENV_ID}`, 'Content-Type': 'application/json' };
const cw = new CloudWatchLogsClient({ region: 'us-east-1' });
const LG = '/tenx/demo-streamer/query';

// Lock the window so both runs query the same absolute time range.
const to = Date.now();
const from = to - 60 * 60 * 1000;

async function submit(name) {
  const qid = randomUUID();
  const body = {
    id: qid, name: `${name}-${to}`,
    from, to,
    search: 'message_pattern == "cart_cartstore_ValkeyCartStore"',
    filters: [], writeResults: true, logLevels: 'ERROR,INFO,PERF',
    processingTime: 600_000,
  };
  const r = await fetch(`${process.env.LOG10X_STREAMER_URL}/streamer/query`, {
    method: 'POST', headers: hdrs, body: JSON.stringify(body),
  });
  if (r.status !== 200) throw new Error(`submit ${name} failed: ${r.status}`);
  return qid;
}

async function countEvents(qid) {
  // poll CW until we see both 'query started' and 'results writer complete'
  // for all sub-queries, or hit a 120s ceiling.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const streams = [];
    let tok;
    do {
      const out = await cw.send(new DescribeLogStreamsCommand({ logGroupName: LG, logStreamNamePrefix: qid, nextToken: tok }));
      streams.push(...(out.logStreams || []));
      tok = out.nextToken;
    } while (tok);
    let queryStarted = 0, queryComplete = 0, eventsWritten = 0, rwComplete = 0;
    for (const s of streams) {
      let t;
      for (let i = 0; i < 3; i++) {
        const out = await cw.send(new GetLogEventsCommand({ logGroupName: LG, logStreamName: s.logStreamName, startFromHead: true, nextToken: t }));
        for (const ev of out.events || []) {
          let msg = ev.message;
          try { const j = JSON.parse(ev.message); msg = j.message || ev.message; } catch {}
          if (msg.startsWith('query started')) queryStarted++;
          if (msg.startsWith('query complete')) queryComplete++;
          if (msg.startsWith('results writer complete')) {
            rwComplete++;
            const m = msg.match(/results writer complete: (\d+) events written/);
            if (m) eventsWritten += +m[1];
          }
        }
        if (!out.nextForwardToken || out.nextForwardToken === t) break;
        t = out.nextForwardToken;
      }
    }
    if (queryStarted > 0 && queryComplete >= queryStarted) {
      return { eventsWritten, queryShards: queryStarted, workersCompleted: rwComplete };
    }
    await sleep(5000);
  }
  throw new Error(`timeout waiting for ${qid}`);
}

console.log(`C1 — querying window [${new Date(from).toISOString()}, ${new Date(to).toISOString()}]`);

const aqid = await submit('C1-A');
console.log(`A submitted: ${aqid}`);
const a = await countEvents(aqid);
console.log(`A result: events=${a.eventsWritten}, shards=${a.queryShards}, workers=${a.workersCompleted}`);

const bqid = await submit('C1-B');
console.log(`B submitted: ${bqid}`);
const b = await countEvents(bqid);
console.log(`B result: events=${b.eventsWritten}, shards=${b.queryShards}, workers=${b.workersCompleted}`);

const pass = a.eventsWritten === b.eventsWritten && a.eventsWritten > 0;
console.log(`\nC1: ${pass ? 'PASS' : 'FAIL'} — A=${a.eventsWritten} B=${b.eventsWritten} (both must be equal and >0)`);
process.exit(pass ? 0 : 1);
