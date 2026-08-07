import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleFromFile, _internals } from '../src/lib/local-file-source.js';

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'l10x-file-src-'));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

const wrapped = (container: string, log: string): string =>
  JSON.stringify({
    log,
    stream: 'stdout',
    kubernetes: { container_name: container, pod_name: `${container}-abc12`, namespace_name: 'demo' },
  });

test('wrapped JSONL is detected and normalized: payload bytes, container attribution', async () => {
  const lines = [
    wrapped('cartservice', 'GET /cart 200 uid=1'),
    wrapped('cartservice', 'GET /cart 200 uid=2'),
    wrapped('adservice', 'ad served id=9'),
  ];
  const path = tmpFile('wrapped.jsonl', lines.join('\n') + '\n');
  const r = await sampleFromFile(path);
  assert.equal(r.normalized, true);
  // events are the UNWRAPPED payloads — the templater never sees the wrapper
  assert.deepEqual(r.events, ['GET /cart 200 uid=1', 'GET /cart 200 uid=2', 'ad served id=9']);
  // records are objects, so envelope enrichment can keep attribution
  assert.equal(typeof r.records[0], 'object');
  // composition is keyed by container, bytes count the payload only
  assert.deepEqual(
    r.composition.map((c) => c.source),
    ['cartservice', 'adservice'],
  );
  assert.equal(r.totalBytes, Buffer.byteLength(r.events.join(''), 'utf8'));
  // raw (billable) size is the on-disk wrapped size, strictly larger
  assert.ok(r.rawBytes > r.totalBytes);
});

test('plain log lines pass through untouched', async () => {
  const path = tmpFile('plain.log', 'line one\nline two\n');
  const r = await sampleFromFile(path);
  assert.equal(r.normalized, false);
  assert.deepEqual(r.events, ['line one', 'line two']);
  assert.deepEqual(r.records, r.events);
});

test('unparseable lines inside a wrapped file are kept as-is and counted, never dropped', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => wrapped('svc', `msg ${i}`));
  lines.push('this is not json');
  const path = tmpFile('mixed.jsonl', lines.join('\n') + '\n');
  const r = await sampleFromFile(path);
  assert.equal(r.normalized, true);
  assert.equal(r.events.length, 11);
  assert.ok(r.events.includes('this is not json'));
  assert.ok(r.notes.some((n) => n.includes('1 line(s) did not parse')));
});

test('docker json-file records without k8s metadata get an honest no-attribution key', () => {
  const rec = _internals.isWrappedLine(JSON.stringify({ log: 'hello', stream: 'stdout', time: 'x' }));
  assert.ok(rec);
  assert.equal(_internals.containerOf(rec!), '(no container attribution)');
});
