/**
 * Ship the otel-sample-200mb.log into Azure Log Analytics via the
 * HTTP Data Collector API (legacy but works on any workspace).
 *
 * Authentication uses HMAC-SHA256 over a canonicalized request string
 * signed with the workspace's primary key (NOT the service principal).
 * See: https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-collector-api
 *
 * The workspace will auto-create a custom table `<Log-Type>_CL` with
 * columns derived from our JSON fields. First arrivals take 5-10 min
 * to appear in queries; subsequent events <1 min.
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { createHmac } from 'crypto';

const FILE = process.argv[2] || '/Users/talweiss/eclipse-workspace/l1x-co/config/config/data/otel-sample-200mb.log';
const MAX_EVENTS = Number(process.argv[3] || 60_000);
const WORKSPACE_ID = process.env.AZURE_LOG_ANALYTICS_WORKSPACE_ID;
const WORKSPACE_KEY = process.env.AZURE_WORKSPACE_KEY;
const LOG_TYPE = process.env.AZURE_LOG_TYPE || 'log10xPoc'; // Azure will create table 'log10xPoc_CL'

if (!WORKSPACE_ID || !WORKSPACE_KEY) {
  console.error('AZURE_LOG_ANALYTICS_WORKSPACE_ID and AZURE_WORKSPACE_KEY must be set');
  process.exit(2);
}

const url = `https://${WORKSPACE_ID}.ods.opinsights.azure.com/api/logs?api-version=2016-04-01`;

// Build the HMAC-SHA256 signature per the HTTP Data Collector API spec.
function buildSignature(contentLength, method, contentType, date, resource) {
  const stringToSign = `${method}\n${contentLength}\n${contentType}\nx-ms-date:${date}\n${resource}`;
  const decodedKey = Buffer.from(WORKSPACE_KEY, 'base64');
  const sig = createHmac('sha256', decodedKey).update(stringToSign, 'utf8').digest('base64');
  return `SharedKey ${WORKSPACE_ID}:${sig}`;
}

async function postBatch(events) {
  const body = JSON.stringify(events);
  const contentLength = Buffer.byteLength(body, 'utf8');
  const date = new Date().toUTCString();
  const signature = buildSignature(contentLength, 'POST', 'application/json', date, '/api/logs');

  let attempts = 0;
  while (true) {
    attempts++;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Log-Type': LOG_TYPE,
        'x-ms-date': date,
        'Authorization': signature,
        'time-generated-field': 'timestamp',
      },
      body,
    });
    if (res.ok || res.status === 200) return;
    if (res.status === 429 && attempts < 6) {
      await new Promise((r) => setTimeout(r, Math.min(30_000, 2_000 * attempts)));
      continue;
    }
    const text = await res.text().catch(() => '');
    throw new Error(`azure-intake ${res.status}: ${text.slice(0, 400)}`);
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
  // Azure HTTP Data Collector limits: 30MB per request, 32KB per field.
  // Use 5MB batches to give headroom for JSON overhead + signatures.
  const FLUSH_BYTES = 5 * 1024 * 1024;

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
    const ts = new Date(now - windowMs + i * stride).toISOString();
    const event = {
      timestamp: ts,
      // Flatten what LA can handle at the top level; the `log` field
      // carries the actual log text that our templater cares about.
      log: parsed.log || line,
      stream: parsed.stream,
      container_name: parsed?.kubernetes?.container_name,
      namespace_name: parsed?.kubernetes?.namespace_name,
      pod_name: parsed?.kubernetes?.pod_name,
      host: parsed?.kubernetes?.host,
    };
    const eventStr = JSON.stringify(event);
    const eventBytes = eventStr.length + 2;
    if (batchBytes + eventBytes > FLUSH_BYTES && batch.length > 0) {
      await flush();
    }
    batch.push(event);
    batchBytes += eventBytes;
    i++;
  }
  await flush();
  console.log(`done: ${pushed} events shipped to Azure LA workspace ${WORKSPACE_ID} (table: ${LOG_TYPE}_CL)`);
}

main().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
