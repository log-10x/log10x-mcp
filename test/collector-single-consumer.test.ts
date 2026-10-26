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

// The OTel Collector sidecar overlay advise_install renders, and the ClickStack
// recipe's collector config: the two configs whose filelog feeds the Receiver.
async function sidecarValues(): Promise<string> {
  const { buildReporterPlan } = await import('../src/lib/advisor/reporter.js');
  const { SNAPSHOT_SCHEMA_VERSION } = await import('../src/lib/discovery/types.js');
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
  return plan.install
    .flatMap((s: { file?: { path: string; contents: string }; files?: Array<{ path: string; contents: string }> }) => [s.file, ...(s.files ?? [])])
    .find((f: { path: string } | undefined) => f?.path.endsWith('-values.yaml'))?.contents ?? '';
}

async function clickstackBody(): Promise<string> {
  const { clickhouseOffloadRecipe } = await import('../src/lib/offload-recipes.js');
  return clickhouseOffloadRecipe({ bucket: 'b', region: 'us-east-1' }, 'otel-collector').collector.body;
}

/** The lines indented under the first line matching `header`, the header excluded. */
function blockUnder(text: string, header: RegExp): string[] {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => header.test(l));
  if (at < 0) return [];
  const indent = lines[at].length - lines[at].trimStart().length;
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== '' && !l.trim().startsWith('#') && l.length - l.trimStart().length <= indent) break;
    out.push(l);
  }
  return out;
}

function bytes(size: string): number {
  const m = /^(\d+)(KiB|MiB)?$/.exec(size.trim());
  assert.ok(m, `not a byte size: ${size}`);
  return Number(m[1]) * (m[2] === 'MiB' ? 1048576 : m[2] === 'KiB' ? 1024 : 1);
}

// The Receiver answers an export only once its lines are done and refuses with
// UNAVAILABLE when its queue is full, so the exporter into it carries the
// settings the custody run gave it (benchmarks clickstack-e2e-gaps,
// gap4_durable_handoff.sh, contrib 0.160.0): a 30 s timeout, retries without a
// deadline, and a queue that blocks on overflow with one consumer.
test('the sidecar overlay and the ClickStack recipe carry the custody run\'s exporter settings', async () => {
  const values = await sidecarValues();
  const sidecar = values.slice(values.indexOf('    otlp/tenx:\n      endpoint: 127.0.0.1:4317'));
  assert.ok(sidecar.length > 0, 'the overlay has no otlp/tenx exporter');
  assert.match(
    sidecar,
    /^ {6}timeout: 30s\n(?: {6}#.*\n)* {6}retry_on_failure:\n {8}enabled: true\n {8}max_elapsed_time: 0\n {6}sending_queue:\n {8}enabled: true\n(?: {8}#.*\n)* {8}num_consumers: 1\n(?: {8}#.*\n)* {8}block_on_overflow: true\n(?: {8}#.*\n)* {8}batch:\n {10}flush_timeout: 1s\n {10}sizer: bytes\n {10}min_size: 1048576\n {10}max_size: 2097152\n/m,
  );

  const body = await clickstackBody();
  const engine = body.slice(body.indexOf('  otlp/engine:\n'), body.indexOf('  otlp/clickstack:\n'));
  assert.match(
    engine,
    /^ {4}timeout: 30s\n(?: {4}#.*\n)* {4}retry_on_failure:\n {6}enabled: true\n {6}max_elapsed_time: 0\n {4}sending_queue:\n {6}enabled: true\n(?: {6}#.*\n)* {6}num_consumers: 1\n(?: {6}#.*\n)* {6}block_on_overflow: true\n(?: {6}#.*\n)* {6}batch:\n {8}flush_timeout: 1s\n {8}sizer: bytes\n {8}min_size: 1048576\n {8}max_size: 2097152\n/m,
  );
  // The header names where the added settings come from.
  assert.ok(body.includes('gap4_durable_handoff.sh'));
});

// On 1.1.150 the Receiver closes a source's open event when its OTLP queue
// drains, so a multi-line event is joined in the collector: every filelog that
// feeds the Receiver runs the container parser, then recombine (the operator
// from the modules OTel Collector recipe), and a combined event stays below the
// batch max_size of the queue into the Receiver, which drops a larger record
// with its request.
test('every rendered filelog toward the Receiver runs container then recombine, capped under the queue batch', async () => {
  const renders = [
    { name: 'sidecar overlay', text: await sidecarValues(), exporter: /^ {4}otlp\/tenx:$/, filelog: /^ {4}filelog:$/ },
    { name: 'ClickStack recipe', text: await clickstackBody(), exporter: /^ {2}otlp\/engine:$/, filelog: /^ {2}filelog:$/ },
  ];
  for (const r of renders) {
    // One filelog receiver per render, and it is the one checked below.
    assert.equal(r.text.split('\n').filter((l) => /^\s*filelog(\/\S+)?:\s*$/.test(l)).length, 1, `${r.name}: filelog receivers`);
    const filelog = blockUnder(r.text, r.filelog);
    const types = filelog.map((l) => /^\s*- type: (\S+)\s*$/.exec(l)?.[1]).filter((x): x is string => !!x);
    assert.deepEqual(types, ['container', 'recombine'], `${r.name}: operators in order`);
    const recombine = filelog.slice(filelog.findIndex((l) => /- type: recombine/.test(l)) + 1).map((l) => l.trim());
    assert.ok(recombine.includes('combine_field: body'), `${r.name}: combine_field`);
    assert.ok(recombine.includes('combine_with: "\\n"'), `${r.name}: combine_with`);
    assert.ok(recombine.includes(`is_first_entry: 'not (body matches "^(\\\\s|at )")'`), `${r.name}: is_first_entry`);
    const maxLog = recombine.find((l) => l.startsWith('max_log_size:'));
    assert.ok(maxLog, `${r.name}: recombine has no max_log_size`);

    // The exporter of that name, not the return-path receiver the overlay names the same.
    const exporter = blockUnder(r.text.slice(r.text.search(/^ *exporters:$/m)), r.exporter).map((l) => l.trim());
    const maxSize = exporter.find((l) => l.startsWith('max_size:'));
    assert.ok(maxSize, `${r.name}: the queue into the Receiver has no batch max_size`);
    assert.ok(
      bytes(maxLog.slice('max_log_size:'.length)) < bytes(maxSize.slice('max_size:'.length)),
      `${r.name}: ${maxLog} is not under ${maxSize}`,
    );
  }
});
