/**
 * Ship the otel-sample-200mb.log into GCP Cloud Logging via the SDK.
 *
 * Uses `@google-cloud/logging` with the `GOOGLE_APPLICATION_CREDENTIALS`
 * env var pointing at a service-account JSON key. Writes into a
 * user-defined log named `log10x-poc-otel` with resource.type=global.
 *
 * GCP Cloud Logging free tier: 50 GB/month ingestion per project, no
 * credit card charges. 60K events ~= 60 MB — deep inside the free
 * allowance. Indexing latency is typically <30s.
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { Logging } from '@google-cloud/logging';

const FILE = process.argv[2] || '/Users/talweiss/eclipse-workspace/l1x-co/config/config/data/otel-sample-200mb.log';
const MAX_EVENTS = Number(process.argv[3] || 30_000);
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'log10x-poc';
const LOG_NAME = process.env.GCP_LOG_NAME || 'log10x-poc-otel';

const logging = new Logging({ projectId: PROJECT_ID });
const log = logging.log(LOG_NAME);

async function writeBatch(entries) {
  let attempts = 0;
  while (true) {
    attempts++;
    try {
      await log.write(entries);
      return;
    } catch (e) {
      const status = e?.code || 0;
      if ((status === 429 || (status >= 500 && status < 600)) && attempts < 5) {
        await new Promise((r) => setTimeout(r, Math.min(30_000, 2_000 * attempts)));
        continue;
      }
      throw e;
    }
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
  let pushed = 0;
  // GCP Cloud Logging: 1000 entries max per write, 10 MB total.
  const FLUSH_EVENTS = 500;

  async function flush() {
    if (batch.length === 0) return;
    await writeBatch(batch);
    pushed += batch.length;
    const pct = ((pushed / MAX_EVENTS) * 100).toFixed(1);
    console.log(`  pushed ${pushed}/${MAX_EVENTS} (${pct}%)`);
    batch = [];
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
    const metadata = {
      resource: {
        type: 'global',
        labels: { project_id: PROJECT_ID },
      },
      timestamp: new Date(tsMs).toISOString(),
      severity: inferSeverity(parsed.log || line),
      labels: {
        service: parsed?.kubernetes?.container_name || 'otel-demo',
        namespace: parsed?.kubernetes?.namespace_name || '',
        pod: parsed?.kubernetes?.pod_name || '',
      },
    };
    // Prefer structured payload when the source event was JSON; text
    // payload otherwise so the templater has raw log content to work with.
    const entry = log.entry(
      metadata,
      parsed.log
        ? {
            log: parsed.log,
            stream: parsed.stream,
            kubernetes: parsed.kubernetes,
          }
        : line
    );
    batch.push(entry);
    if (batch.length >= FLUSH_EVENTS) await flush();
    i++;
  }
  await flush();
  console.log(`done: ${pushed} entries shipped to gcp log '${LOG_NAME}' in project ${PROJECT_ID}`);
}

/**
 * Quick severity sniff so GCP's `severity` filter is usable. Templater
 * ignores this — it works from log text alone — but it makes the UI
 * side of Cloud Logging cleaner for debugging.
 */
function inferSeverity(s) {
  if (!s) return 'DEFAULT';
  const up = s.toUpperCase();
  if (up.includes('FATAL') || up.includes('CRITICAL')) return 'CRITICAL';
  if (up.includes('ERROR')) return 'ERROR';
  if (up.includes('WARN')) return 'WARNING';
  if (up.includes('INFO')) return 'INFO';
  if (up.includes('DEBUG')) return 'DEBUG';
  if (up.includes('TRACE')) return 'DEBUG';
  return 'DEFAULT';
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
