/**
 * Bulk-load the otel-sample-200mb.log into a local Elasticsearch index.
 *
 * Elasticsearch _bulk API: each pair of lines is action+source. We stream
 * the source file, line by line, wrap each in an index action, and flush
 * batches of ~5 MB at a time. Adds a synthetic @timestamp so
 * `@timestamp >= since` range queries hit.
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { Client } from '@elastic/elasticsearch';

const FILE = process.argv[2] || '/Users/talweiss/eclipse-workspace/l1x-co/config/config/data/otel-sample-200mb.log';
const INDEX = process.argv[3] || 'otel-logs';
const MAX_EVENTS = Number(process.argv[4] || 60_000);

const client = new Client({ node: 'http://localhost:9200' });

async function main() {
  // Recreate index each run for clean state
  try { await client.indices.delete({ index: INDEX }); } catch {}
  await client.indices.create({
    index: INDEX,
    mappings: {
      properties: {
        '@timestamp': { type: 'date' },
        log: { type: 'text' },
        stream: { type: 'keyword' },
        'kubernetes.namespace_name': { type: 'keyword' },
        'kubernetes.container_name': { type: 'keyword' },
        'kubernetes.pod_name': { type: 'keyword' },
      },
    },
  });

  const now = Date.now();
  const windowMs = 23 * 3_600_000;
  const stride = Math.floor(windowMs / MAX_EVENTS);

  const stream = createReadStream(FILE, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let batch = [];
  let bytes = 0;
  let pushed = 0;
  const FLUSH_BYTES = 4 * 1024 * 1024;

  async function flush() {
    if (batch.length === 0) return;
    const body = batch.join('\n') + '\n';
    const resp = await client.bulk({ body, refresh: false });
    if (resp.errors) {
      const firstErr = resp.items.find((i) => i.index && i.index.error);
      if (firstErr) throw new Error(JSON.stringify(firstErr.index.error).slice(0, 300));
    }
    pushed += batch.length / 2; // 2 lines per doc
    const pct = ((pushed / MAX_EVENTS) * 100).toFixed(1);
    console.log(`  pushed ${pushed}/${MAX_EVENTS} (${pct}%)`);
    batch = [];
    bytes = 0;
  }

  let i = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (i >= MAX_EVENTS) break;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    parsed['@timestamp'] = new Date(now - windowMs + i * stride).toISOString();
    const action = JSON.stringify({ index: { _index: INDEX } });
    const source = JSON.stringify(parsed);
    batch.push(action, source);
    bytes += action.length + source.length + 2;
    if (bytes >= FLUSH_BYTES) await flush();
    i++;
  }
  await flush();
  await client.indices.refresh({ index: INDEX });
  const count = await client.count({ index: INDEX });
  console.log(`done: ${count.count} docs indexed in ${INDEX}`);
  await client.close();
}

main().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
