/**
 * Ship the otel-sample-200mb.log into ClickHouse using a SigNoz-shaped
 * schema so the connector's schema auto-detection path runs.
 *
 * The SigNoz schema has these canonical columns:
 *   timestamp (DateTime64)
 *   body (String) — the raw log text
 *   severity_text (String)
 *   resources_string_key (Array(String))
 *   resources_string_value (Array(String))
 *
 * Our connector detects this layout via `body + severity_text` presence
 * and auto-maps `body → message`, `timestamp → timestamp`.
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { createClient } from '@clickhouse/client';

const FILE = process.argv[2] || '/Users/talweiss/eclipse-workspace/l1x-co/config/config/data/otel-sample-200mb.log';
const MAX_EVENTS = Number(process.argv[3] || 30_000);

const client = createClient({
  url: process.env.CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_USER || 'default',
  password: process.env.CLICKHOUSE_PASSWORD,
  database: process.env.CLICKHOUSE_DATABASE || 'default',
});

const TABLE = process.env.CLICKHOUSE_TABLE || 'logs';

async function main() {
  // Recreate table each run for clean state.
  await client.command({ query: `DROP TABLE IF EXISTS ${TABLE}` });
  await client.command({
    query: `CREATE TABLE ${TABLE} (
      timestamp DateTime64(9),
      body String,
      severity_text String,
      severity_number UInt8,
      resources_string_key Array(String),
      resources_string_value Array(String)
    ) ENGINE = MergeTree ORDER BY timestamp`,
  });
  console.log(`created SigNoz-shaped table: ${TABLE}`);

  const now = Date.now();
  const windowMs = 23 * 3_600_000;
  const stride = Math.floor(windowMs / MAX_EVENTS);

  const stream = createReadStream(FILE, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let i = 0;
  let batch = [];
  let pushed = 0;
  const FLUSH_EVENTS = 5000;

  async function flush() {
    if (batch.length === 0) return;
    await client.insert({ table: TABLE, values: batch, format: 'JSONEachRow' });
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
    // Convert to DateTime64(9) format: seconds.nanos
    const secs = Math.floor(tsMs / 1000);
    const nanos = (tsMs % 1000) * 1_000_000;
    const tsStr = `${secs}.${String(nanos).padStart(9, '0')}`;
    const body = parsed.log || line;
    const sev = inferSeverity(body);
    const k = parsed?.kubernetes || {};
    batch.push({
      timestamp: tsStr,
      body,
      severity_text: sev,
      severity_number: severityNumber(sev),
      resources_string_key: ['service', 'namespace', 'pod', 'stream'],
      resources_string_value: [
        k.container_name || 'otel-demo',
        k.namespace_name || '',
        k.pod_name || '',
        parsed.stream || '',
      ],
    });
    if (batch.length >= FLUSH_EVENTS) await flush();
    i++;
  }
  await flush();
  console.log(`done: ${pushed} rows inserted into ${TABLE}`);
  await client.close();
}

function inferSeverity(s) {
  const up = (s || '').toUpperCase();
  if (up.includes('FATAL') || up.includes('CRITICAL')) return 'FATAL';
  if (up.includes('ERROR')) return 'ERROR';
  if (up.includes('WARN')) return 'WARN';
  if (up.includes('INFO')) return 'INFO';
  if (up.includes('DEBUG')) return 'DEBUG';
  if (up.includes('TRACE')) return 'TRACE';
  return 'UNSPECIFIED';
}
function severityNumber(s) {
  switch (s) {
    case 'FATAL': return 21;
    case 'ERROR': return 17;
    case 'WARN': return 13;
    case 'INFO': return 9;
    case 'DEBUG': return 5;
    case 'TRACE': return 1;
    default: return 0;
  }
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
