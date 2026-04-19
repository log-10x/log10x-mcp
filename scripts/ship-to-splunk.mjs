/**
 * Ship the otel sample into a Splunk Docker container via HEC
 * (HTTP Event Collector). Simpler than mounting files into the container.
 *
 * Usage:
 *   node scripts/ship-to-splunk.mjs <HEC_TOKEN> [events=60000] [host=localhost:8088]
 *
 * HEC endpoint: https://<host>:8088/services/collector/event
 * (Splunk Docker image exposes HEC on 8088 by default.)
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import https from 'https';

const FILE = '/Users/talweiss/eclipse-workspace/l1x-co/config/config/data/otel-sample-200mb.log';
const HEC_TOKEN = process.argv[2];
const MAX_EVENTS = Number(process.argv[3] || 60_000);
const HEC_URL = process.argv[4] || 'https://localhost:18088/services/collector/event';

if (!HEC_TOKEN) {
  console.error('Usage: node ship-to-splunk.mjs <HEC_TOKEN> [events] [url]');
  process.exit(2);
}

const agent = new https.Agent({ rejectUnauthorized: false });

async function postBatch(batchBody) {
  const res = await fetch(HEC_URL, {
    method: 'POST',
    headers: {
      Authorization: `Splunk ${HEC_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: batchBody,
    // @ts-ignore — undici dispatcher
    dispatcher: new (await import('undici')).Agent({ connect: { rejectUnauthorized: false } }),
  });
  if (!res.ok) {
    throw new Error(`HEC ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function main() {
  const stream = createReadStream(FILE, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const now = Date.now();
  const windowMs = 23 * 3_600_000;
  const stride = Math.floor(windowMs / MAX_EVENTS);

  let i = 0;
  let batchLines = [];
  let batchBytes = 0;
  let pushed = 0;
  const FLUSH = 512 * 1024; // 512 KB per batch

  async function flush() {
    if (batchLines.length === 0) return;
    await postBatch(batchLines.join(''));
    pushed += batchLines.length;
    const pct = ((pushed / MAX_EVENTS) * 100).toFixed(1);
    console.log(`  pushed ${pushed}/${MAX_EVENTS} (${pct}%)`);
    batchLines = [];
    batchBytes = 0;
  }

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (i >= MAX_EVENTS) break;
    const ts = (now - windowMs + i * stride) / 1000;
    const event = JSON.stringify({
      event: line, // raw line — Splunk sourcetype _json will parse it
      time: ts,
      sourcetype: '_json',
      index: 'main',
    });
    batchLines.push(event + '\n');
    batchBytes += event.length + 1;
    if (batchBytes >= FLUSH) await flush();
    i++;
  }
  await flush();
  console.log(`done: ${pushed} events shipped to Splunk HEC`);
}

main().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
