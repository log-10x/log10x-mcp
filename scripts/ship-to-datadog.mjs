/**
 * Ship the otel-sample-200mb.log into Datadog Logs via the HTTP intake API.
 *
 * Works on any site — we pull DD_SITE from env (default: `datadoghq.com`),
 * then hit `https://http-intake.logs.<DD_SITE>/api/v2/logs` with DD-API-KEY.
 *
 * Each batch is up to 5 MB / 1000 events (Datadog intake limits). We
 * synthesize timestamps spread across the query window so `window: 24h`
 * pulls them back.
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const FILE = process.argv[2] || '/Users/talweiss/eclipse-workspace/l1x-co/config/config/data/otel-sample-200mb.log';
const MAX_EVENTS = Number(process.argv[3] || 60_000);
const DD_API_KEY = process.env.DD_API_KEY;
const DD_SITE = process.env.DD_SITE || 'datadoghq.com';
const DD_SOURCE = process.env.DD_SOURCE || 'log10x-poc-otel';

if (!DD_API_KEY) {
  console.error('DD_API_KEY must be set');
  process.exit(2);
}

const url = `https://http-intake.logs.${DD_SITE}/api/v2/logs`;
console.log(`[shipper] POST ${url}`);

async function postBatch(events) {
  const body = JSON.stringify(events);
  let attempts = 0;
  while (true) {
    attempts++;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': DD_API_KEY,
      },
      body,
    });
    if (res.ok || res.status === 202) return;
    if (res.status === 429 && attempts < 5) {
      const retryAfter = parseFloat(res.headers.get('retry-after') || '1');
      await new Promise((r) => setTimeout(r, Math.min(30000, retryAfter * 1000)));
      continue;
    }
    const text = await res.text().catch(() => '');
    throw new Error(`intake ${res.status}: ${text.slice(0, 200)}`);
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
  const FLUSH_EVENTS = 500; // well under the 1000 cap; good safety for byte limit
  const FLUSH_BYTES = 4 * 1024 * 1024; // 4 MB, under 5 MB intake cap

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
    // Parse the fluent-bit envelope so we can extract service tags for
    // Datadog's facets. If parsing fails, fall back to raw.
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = { log: line };
    }
    const ts = now - windowMs + i * stride;
    const service = parsed?.kubernetes?.container_name || 'otel-demo';
    const event = {
      message: parsed.log || line,
      ddsource: DD_SOURCE,
      service,
      ddtags: `env:poc,source:${DD_SOURCE},pod:${parsed?.kubernetes?.pod_name || 'n/a'}`,
      hostname: parsed?.kubernetes?.host || 'localhost',
      timestamp: ts,
      // Keep the structured fields so Datadog parses them as attributes.
      kubernetes: parsed.kubernetes,
      stream: parsed.stream,
    };
    const eventStr = JSON.stringify(event);
    const eventBytes = eventStr.length + 2;
    if (batch.length >= FLUSH_EVENTS || batchBytes + eventBytes > FLUSH_BYTES) {
      await flush();
    }
    batch.push(event);
    batchBytes += eventBytes;
    i++;
  }
  await flush();
  console.log(`done: ${pushed} events shipped to Datadog (${DD_SITE})`);
}

main().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
