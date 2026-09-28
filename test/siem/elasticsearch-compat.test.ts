/**
 * The Elasticsearch connector must be readable by an 8.x cluster.
 *
 * Measured 2026-09-28 against elasticsearch:8.17.0: the v9 client sends
 * `compatible-with=9`, the cluster answers 400 media_type_header_exception
 * ("Accept version must be either version 8 or 7, but found 9"), and the POC
 * pulled 0 events from every bucket. `compatible-with=8` reads 8.17 and, through
 * REST API compatibility, 9.1.5 (both checked live the same night).
 *
 * The stub answers like an 8.x cluster: it refuses a 9 accept header.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { elasticsearchConnector } from '../../src/lib/siem/elasticsearch.js';

test('elasticsearch pull speaks compatible-with=8, which an 8.x cluster accepts', async () => {
  const accepts: string[] = [];
  let served = 0;
  const server = http.createServer((req, res) => {
    const accept = String(req.headers['accept'] ?? '');
    accepts.push(accept);
    res.setHeader('X-Elastic-Product', 'Elasticsearch');
    res.setHeader('Content-Type', 'application/json');
    if (accept.includes('compatible-with=9')) {
      res.statusCode = 400;
      res.end(JSON.stringify({
        error: { type: 'media_type_header_exception', reason: 'Accept version must be either version 8 or 7, but found 9.' },
        status: 400,
      }));
      return;
    }
    req.resume();
    req.on('end', () => {
      const hits = served++ === 0
        ? [{ _index: 'logs', _id: '1', _source: { '@timestamp': new Date().toISOString(), message: 'hello' }, sort: [1] }]
        : [];
      res.end(JSON.stringify({ took: 1, timed_out: false, hits: { total: { value: hits.length, relation: 'eq' }, hits } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const prev = process.env.ELASTICSEARCH_URL;
  process.env.ELASTICSEARCH_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const result = await elasticsearchConnector.pullEvents({
      window: '1h',
      targetEventCount: 5,
      maxPullMinutes: 1,
      buckets: 1,
      onProgress: () => {},
    });
    assert.ok(accepts.length > 0, 'the connector reached the stub');
    assert.ok(accepts.every((a) => a.includes('compatible-with=8')), `accept headers: ${accepts.join(' | ')}`);
    assert.ok(result.events.length > 0, `notes: ${JSON.stringify(result.metadata?.notes ?? [])}`);
  } finally {
    if (prev === undefined) delete process.env.ELASTICSEARCH_URL; else process.env.ELASTICSEARCH_URL = prev;
    server.closeAllConnections();
    server.close();
  }
});
