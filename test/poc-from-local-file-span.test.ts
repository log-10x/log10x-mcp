/**
 * The span a file plan's caps are written against.
 *
 * A cap row is bytes per 240 s regulator window, scaled from the span the
 * plan's bytes cover. For `source: file` that span is the files' own first
 * to last record timestamp; with no timestamps it is the `window` argument;
 * with neither the run refuses. A ten-hour file planned as one hour writes
 * caps ten times too lenient.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveFileSpan, FileSpanRefusal, _internals } from '../src/lib/local-file-source.js';
import { executePocFromLocal } from '../src/tools/poc-from-local.js';

const TEN_HOURS_MS = 10 * 3600 * 1000;
const START_MS = Date.parse('2026-10-11T00:00:00Z');

/** Plain lines, each opening with its ISO-8601 time, spread evenly over ten hours. */
function plainTenHourLines(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(START_MS + Math.round((TEN_HOURS_MS * i) / (n - 1))).toISOString();
    const k = i % 10;
    const body =
      k < 5
        ? `INFO service=checkout order placed id=${i} amount=${i % 97} currency=USD region=us-east-1 channel=web basket=${i % 13}`
        : k === 5
          ? `WARN service=checkout payment retry id=${i}`
          : k < 9
            ? `DEBUG service=cart cart updated user=${i % 50} items=${i % 7} total=${i % 300}`
            : `ERROR service=cart cart lookup failed user=${i % 50}`;
    out.push(`${t} ${body}`);
  }
  return out;
}

/** Wrapped JSONL records with container attribution and no timestamp field. */
function wrappedUntimedLines(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = i % 10;
    const svc = k < 6 ? 'checkout' : 'cart';
    const log =
      k < 5
        ? `INFO order placed id=${i} amount=${i % 97} currency=USD region=us-east-1 channel=web basket=${i % 13}`
        : k === 5
          ? `WARN payment retry id=${i}`
          : k < 9
            ? `DEBUG cart updated user=${i % 50} items=${i % 7} total=${i % 300}`
            : `ERROR cart lookup failed user=${i % 50}`;
    out.push(JSON.stringify({ log, stream: 'stdout', kubernetes: { container_name: svc, pod_name: `${svc}-abc`, namespace_name: 'default' } }));
  }
  return out;
}

test('resolveFileSpan: plain lines spanning ten hours give 36,000 s from the timestamps', () => {
  const span = resolveFileSpan(plainTenHourLines(500), undefined);
  assert.equal(span.source, 'timestamps');
  assert.equal(span.seconds, 36_000);
  assert.equal(span.firstIso, '2026-10-11T00:00:00.000Z');
  assert.equal(span.lastIso, '2026-10-11T10:00:00.000Z');
  assert.equal(span.recordsWithTimestamp, 500);
});

test('resolveFileSpan: envelope timestamps win over a window that disagrees', () => {
  const recs = [
    { log: 'a', timestamp: '2026-10-11T00:00:00Z' },
    { log: 'b', '@timestamp': '2026-10-11T02:30:00Z' },
    { log: 'c' },
  ];
  const span = resolveFileSpan(recs, '1h');
  assert.equal(span.source, 'timestamps');
  assert.equal(span.seconds, 9_000);
  assert.equal(span.recordsWithTimestamp, 2);
  assert.equal(span.records, 3);
});

test('resolveFileSpan: a docker wrapper reads its `time`, or the time leading the wrapped `log` payload', () => {
  const wrapped = [
    JSON.stringify({ stream: 'stderr', log: '2026-08-08T20:00:00.000Z\tinfo\tLogs\t{"records": 34}', kubernetes: { container_name: 'otelcol' } }),
    JSON.stringify({ stream: 'stdout', log: 'Accounting service started', time: '2026-08-08T22:00:00Z', kubernetes: { container_name: 'accounting' } }),
    JSON.stringify({ stream: 'stdout', log: 'no time anywhere' }),
  ];
  const span = resolveFileSpan(wrapped, undefined);
  assert.equal(span.source, 'timestamps');
  assert.equal(span.seconds, 7_200);
  assert.equal(span.recordsWithTimestamp, 2);
  assert.equal(resolveFileSpan(wrapped.map((l) => JSON.parse(l) as Record<string, unknown>), undefined).seconds, 7_200);
});

test('resolveFileSpan: no timestamps reads `window` as the span', () => {
  const recs = wrappedUntimedLines(50).map((l) => JSON.parse(l) as Record<string, unknown>);
  const span = resolveFileSpan(recs, '10h');
  assert.equal(span.source, 'window');
  assert.equal(span.seconds, 36_000);
});

test('resolveFileSpan: no timestamps and no window refuses, naming both', () => {
  assert.throws(
    () => resolveFileSpan(['GET /cart 200', 'GET /cart 404'], undefined),
    (e: unknown) =>
      e instanceof FileSpanRefusal &&
      /none of the 2 sampled records carries a timestamp/.test(e.message) &&
      /`timestamp`, `@timestamp`, `_time`/.test(e.message) &&
      /Pass `window`/.test(e.message),
  );
});

test('resolveFileSpan: one shared timestamp is no span; an unreadable window refuses too', () => {
  const same = ['2026-10-11T00:00:00Z a', '2026-10-11T00:00:00Z b'];
  assert.throws(() => resolveFileSpan(same, undefined), /all carry the same time/);
  assert.equal(resolveFileSpan(same, '90m').seconds, 5_400);
  assert.throws(() => resolveFileSpan(['x'], 'ten hours'), /is not a duration/);
});

test('lineTimestampMs: zones, brackets and comma fractions', () => {
  const t = _internals.lineTimestampMs;
  assert.equal(t('2026-10-11T02:00:00+02:00 x'), Date.parse('2026-10-11T00:00:00Z'));
  assert.equal(t('[2026-10-11 00:00:01,250] x'), Date.parse('2026-10-11T00:00:01.250Z'));
  assert.equal(t('INFO 2026-10-11T00:00:00Z x'), undefined);
});

let tmpDir: string;
let cwd: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'file-span-'));
  cwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(cwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('poc_from_local: a file with no timestamps and no window refuses before the engine runs', async () => {
  const file = join(tmpDir, 'untimed.jsonl');
  await fs.writeFile(file, wrappedUntimedLines(200).join('\n') + '\n');
  const out = await executePocFromLocal({ source: 'file', path: file, siem: 'cloudwatch', target_percent_reduction: 40 });
  const data = out.data as { status: string; error?: { error_type: string; hint: string } };
  assert.equal(data.status, 'error');
  assert.equal(data.error?.error_type, 'missing_input');
  assert.match(data.error?.hint ?? '', /none of the 200 sampled records carries a timestamp/);
  assert.match(data.error?.hint ?? '', /Pass `window` with the span the files cover/);
});

const engineAvailable =
  Boolean(process.env.LOG10X_TENX_PATH) || process.env.LOG10X_INTEGRATION_TESTS === '1';
const skip = engineAvailable ? false : 'no local engine (set LOG10X_TENX_PATH or LOG10X_INTEGRATION_TESTS=1)';

type PlanEnvelope = {
  data: {
    span?: { seconds: number; source: string; statement: string };
    engine_policy?: { caps_csv: string; actions_csv: string; span_seconds: number; span_source: string };
    plan?: { containerCaps: Record<string, { action: string; capBytesMonthly: number }> };
    markdown: string;
  };
};

/** Every tier_down row's cap equals the plan's bytes per 240 s over `spanSeconds`. */
function assertCapsOverSpan(env: PlanEnvelope, spanSeconds: number): void {
  const policy = env.data.engine_policy;
  assert.ok(policy, 'no engine_policy');
  const caps = env.data.plan?.containerCaps ?? {};
  const rows = policy.caps_csv.trim().split('\n').slice(1);
  let checked = 0;
  for (const row of rows) {
    const [container, rest] = row.split(',');
    const cap = Number(rest.split('::')[0]);
    const planned = caps[container];
    if (!planned || planned.action !== 'tier_down') continue;
    assert.equal(cap, Math.max(1, Math.round((planned.capBytesMonthly * 240) / spanSeconds)), `cap for ${container}`);
    assert.notEqual(cap, Math.max(1, Math.round((planned.capBytesMonthly * 240) / 3600)), `cap for ${container} is per hour`);
    checked += 1;
  }
  assert.ok(checked > 0, `no tier_down cap rows to check in:\n${policy.caps_csv}`);
}

test('poc_from_local: a file whose lines span ten hours writes caps over 36,000 s', { skip }, async () => {
  const file = join(tmpDir, 'ten-hours.log');
  await fs.writeFile(file, plainTenHourLines(3000).join('\n') + '\n');
  const env = (await executePocFromLocal({
    source: 'file',
    path: file,
    siem: 'cloudwatch',
    target_percent_reduction: 40,
  })) as unknown as PlanEnvelope;
  assert.equal(env.data.span?.source, 'timestamps');
  assert.equal(env.data.span?.seconds, 36_000);
  assert.equal(env.data.engine_policy?.span_seconds, 36_000);
  assert.equal(env.data.engine_policy?.span_source, 'timestamps');
  assert.match(env.data.markdown, /Span: 10 hours \(36,000 s\), from the first to the last record timestamp/);
  assertCapsOverSpan(env, 36_000);
});

test('poc_from_local: a file with no timestamps uses `window` as the span', { skip }, async () => {
  const file = join(tmpDir, 'untimed.jsonl');
  await fs.writeFile(file, wrappedUntimedLines(3000).join('\n') + '\n');
  const env = (await executePocFromLocal({
    source: 'file',
    path: file,
    siem: 'cloudwatch',
    window: '10h',
    target_percent_reduction: 40,
  })) as unknown as PlanEnvelope;
  assert.equal(env.data.span?.source, 'window');
  assert.equal(env.data.engine_policy?.span_seconds, 36_000);
  assert.equal(env.data.engine_policy?.span_source, 'window');
  assert.match(env.data.markdown, /Span: 10 hours \(36,000 s\), from the `window` argument/);
  assertCapsOverSpan(env, 36_000);
});
