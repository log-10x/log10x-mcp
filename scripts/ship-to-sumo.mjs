/**
 * Ship the otel-sample-200mb.log into Sumo Logic via an HTTP Source URL.
 *
 * Sumo's HTTP Logs & Metrics source accepts newline-delimited JSON or
 * plain text POSTed to an endpoint URL. No Authorization header needed
 * — the URL path itself carries a per-source random token. Supports
 * 1MB per request; we batch well under that.
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const FILE = process.argv[2] || '/Users/talweiss/eclipse-workspace/l1x-co/config/config/data/otel-sample-200mb.log';
const MAX_EVENTS = Number(process.argv[3] || 30_000);
const SOURCE_URL = process.env.SUMO_HTTP_SOURCE_URL;

if (!SOURCE_URL) {
  console.error('SUMO_HTTP_SOURCE_URL must be set');
  process.exit(2);
}

async function postBatch(lines) {
  const body = lines.join('\n');
  let attempts = 0;
  while (true) {
    attempts++;
    const res = await fetch(SOURCE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (res.ok) return;
    if ((res.status === 429 || res.status >= 500) && attempts < 5) {
      await new Promise((r) => setTimeout(r, Math.min(30_000, 2_000 * attempts)));
      continue;
    }
    const text = await res.text().catch(() => '');
    throw new Error(`sumo-http ${res.status}: ${text.slice(0, 300)}`);
  }
}

async function main() {
  const stream = createReadStream(FILE, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const now = Date.now();
  const windowMs = 23 * 3_600_000;
  const stride = Math.floor(windowMs / MAX_EVENTS);

  let i = 0;
  let batch = [];
  let batchBytes = 0;
  let pushed = 0;
  const FLUSH_BYTES = 512 * 1024; // 512 KB, half of Sumo's 1 MB cap

  async function flush() {
    if (batch.length === 0) return;
    await postBatch(batch);
    pushed += batch.length;
    const pct = ((pushed / MAX_EVENTS) * 100).toFixed(1);
    console.log(`  pushed ${pushed}/${MAX_EVENTS} (${pct}%)`);
    batch = [];
    batchBytes = 0;
  }

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (i >= MAX_EVENTS) break;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = { log: line };
    }
    const tsMs = now - windowMs + i * stride;
    const event = {
      timestamp: new Date(tsMs).toISOString(),
      log: parsed.log || line,
      service: parsed?.kubernetes?.container_name || 'otel-demo',
      namespace: parsed?.kubernetes?.namespace_name,
      pod: parsed?.kubernetes?.pod_name,
      stream: parsed.stream,
    };
    const eventStr = JSON.stringify(event);
    const eventBytes = eventStr.length + 1;
    if (batchBytes + eventBytes > FLUSH_BYTES && batch.length > 0) {
      await flush();
    }
    batch.push(eventStr);
    batchBytes += eventBytes;
    i++;
  }
  await flush();
  console.log(`done: ${pushed} events shipped to Sumo HTTP source`);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
