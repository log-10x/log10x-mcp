import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The engine groups multi-line events from consecutive records, so every
// generated Collector exporter that hands records to the engine must send them
// with one consumer: the Collector's default of ten sends batches concurrently
// and the engine receives them out of order.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sources = ['src/lib/advisor/reporter-forwarders.ts', 'src/lib/offload-recipes.ts'];

test('every generated exporter to the engine sends with one consumer', () => {
  let blocks = 0;
  for (const rel of sources) {
    const lines = readFileSync(join(root, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const name = line.trim();
      if (name !== 'otlp/tenx:' && name !== 'otlp/engine:') return;
      if (!/endpoint: (127\.0\.0\.1:4317|\$\{engine\})/.test(lines[i + 1] ?? '')) return;
      const indent = line.length - line.trimStart().length;
      const block: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() !== '' && l.length - l.trimStart().length <= indent) break;
        block.push(l.trim());
      }
      blocks++;
      assert.ok(block.includes('num_consumers: 1'), `${rel}:${i + 1} ${name} has no num_consumers: 1`);
    });
  }
  assert.equal(blocks, 4);
});

// The Receiver answers an export only once its lines are done and refuses with
// UNAVAILABLE when its queue is full, so the exporter into it carries the
// settings the custody run gave it (benchmarks clickstack-e2e-gaps,
// gap4_durable_handoff.sh, contrib 0.160.0): a 30 s timeout, retries without a
// deadline, and a queue that blocks on overflow with one consumer.
test('the sidecar overlay and the ClickStack recipe carry the custody run\'s exporter settings', async () => {
  const { buildReporterPlan } = await import('../src/lib/advisor/reporter.js');
  const { SNAPSHOT_SCHEMA_VERSION } = await import('../src/lib/discovery/types.js');
  const { clickhouseOffloadRecipe } = await import('../src/lib/offload-recipes.js');
  const plan = await buildReporterPlan({
    snapshot: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      snapshotId: 'custody-exporter',
      startedAt: '2026-10-25T00:00:00Z',
      finishedAt: '2026-10-25T00:01:00Z',
      kubectl: {
        available: true, namespaces: ['logging'], probedNamespaces: ['logging'], forwarders: [], helmReleases: [],
        log10xApps: [], storageClasses: [], ingressClasses: [], backendAgents: [], serviceAccountIrsa: [],
      },
      aws: { available: false, s3Buckets: [], sqsQueues: [], cwLogGroups: [] },
      recommendations: { suggestedNamespace: 'logging', alreadyInstalled: {} },
      probeLog: [],
    } as never,
    app: 'receiver',
    forwarder: 'otel-collector',
    licenseJwt: 'test',
  });
  const values = plan.install
    .flatMap((s: { file?: { path: string; contents: string }; files?: Array<{ path: string; contents: string }> }) => [s.file, ...(s.files ?? [])])
    .find((f: { path: string } | undefined) => f?.path.endsWith('-values.yaml'))?.contents ?? '';
  const sidecar = values.slice(values.indexOf('    otlp/tenx:\n      endpoint: 127.0.0.1:4317'));
  assert.ok(sidecar.length > 0, 'the overlay has no otlp/tenx exporter');
  assert.match(
    sidecar,
    /^ {6}timeout: 30s\n(?: {6}#.*\n)* {6}retry_on_failure:\n {8}enabled: true\n {8}max_elapsed_time: 0\n {6}sending_queue:\n {8}enabled: true\n(?: {8}#.*\n)* {8}num_consumers: 1\n(?: {8}#.*\n)* {8}block_on_overflow: true\n/m,
  );

  const body = clickhouseOffloadRecipe({ bucket: 'b', region: 'us-east-1' }, 'otel-collector').collector.body;
  const engine = body.slice(body.indexOf('  otlp/engine:\n'), body.indexOf('  otlp/clickstack:\n'));
  assert.match(
    engine,
    /^ {4}timeout: 30s\n(?: {4}#.*\n)* {4}retry_on_failure:\n {6}enabled: true\n {6}max_elapsed_time: 0\n {4}sending_queue:\n {6}enabled: true\n(?: {6}#.*\n)* {6}num_consumers: 1\n(?: {6}#.*\n)* {6}block_on_overflow: true\n/m,
  );
  // The header names where the added settings come from.
  assert.ok(body.includes('gap4_durable_handoff.sh'));
});
