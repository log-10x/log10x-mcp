/**
 * Ship the otel-sample-200mb.log file into a CloudWatch log group.
 *
 * Batched PutLogEvents: CloudWatch caps each call at 10k events or 1 MB
 * payload (whichever hits first). Events need monotonic timestamps, which
 * we synthesize by spreading the sample across the last ~23h so it lands
 * inside a `window: 24h` pull.
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import {
  CloudWatchLogsClient,
  PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

const FILE = process.argv[2] || '/Users/talweiss/eclipse-workspace/l1x-co/config/config/data/otel-sample-200mb.log';
const GROUP = process.argv[3] || '/log10x/poc-test-otel';
const STREAM = process.argv[4] || 'otel-sample';
const MAX_EVENTS = Number(process.argv[5] || 60_000); // cap for smoke test

const REGION = process.env.AWS_REGION || 'us-east-1';
const client = new CloudWatchLogsClient({ region: REGION, maxAttempts: 5 });

// CloudWatch constraints
const MAX_BATCH_EVENTS = 10_000;
const MAX_BATCH_BYTES = 900 * 1024; // keep a safety margin under 1 MB
const PER_EVENT_OVERHEAD = 26;

async function main() {
  const now = Date.now();
  const windowMs = 23 * 3_600_000; // spread across 23h so `window: 24h` catches all
  const startTs = now - windowMs;

  // Count events first to compute a per-event stride
  const stream = createReadStream(FILE, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const events = [];
  let lineIdx = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (events.length >= MAX_EVENTS) break;
    events.push(line);
    lineIdx++;
  }
  console.log(`read ${events.length} lines (line ${lineIdx})`);

  const stride = Math.max(1, Math.floor(windowMs / events.length));
  let pushed = 0;
  let batch = [];
  let batchBytes = 0;

  async function flush() {
    if (batch.length === 0) return;
    await client.send(
      new PutLogEventsCommand({
        logGroupName: GROUP,
        logStreamName: STREAM,
        logEvents: batch,
      })
    );
    pushed += batch.length;
    const pct = ((pushed / events.length) * 100).toFixed(1);
    console.log(`  pushed ${pushed}/${events.length} (${pct}%)`);
    batch = [];
    batchBytes = 0;
  }

  for (let i = 0; i < events.length; i++) {
    const msg = events[i];
    const bytes = Buffer.byteLength(msg, 'utf8') + PER_EVENT_OVERHEAD;
    // Timestamp must be monotonically non-decreasing within a batch.
    const ts = startTs + i * stride;
    if (batch.length >= MAX_BATCH_EVENTS || batchBytes + bytes > MAX_BATCH_BYTES) {
      await flush();
    }
    batch.push({ timestamp: ts, message: msg });
    batchBytes += bytes;
  }
  await flush();
  console.log(`done: ${pushed} events pushed to ${GROUP}/${STREAM}`);
  client.destroy();
}

main().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
