/**
 * E83: every cap the MCP writes is in the Receiver's unit, the bytes its
 * regulator counts: each record as the forwarder sends it, metadata
 * included, continuation lines joined into the head record, at the busiest
 * 240-second window of the statement's counter (its message pattern in its
 * container). The fixture is the containment demo's quiet capture
 * (benchmarks datadog-containment, 9,054 forwarder records) as the MCP
 * extracted it on edge-10x 1.1.141; the solver and the fleet default run on
 * it here without an engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ASSUMED_RECORD_OVERHEAD_BYTES,
  RECEIVER_WINDOW_SECONDS,
  compactRecordBytes,
  jsonStringBodyBytes,
  receiverBytesStatement,
} from '../src/lib/receiver-bytes.js';
import { eventReceiverSize, slidingWindowPeak, type ExtractedPattern } from '../src/lib/pattern-extraction.js';
import { containerOrder, receiverExtractionInputs, resolveFileSpan } from '../src/lib/local-file-source.js';
import { solvePlan } from '../src/lib/plan-solver.js';
import { fleetDefaultFromPatterns } from '../src/lib/report/build-report-data.js';

test('one event as the Receiver counts it: the head record, then each continuation payload joined', () => {
  const head = { log: '2026-10-14T20:49:23.859Z\terror\tError scraping metrics', kubernetes: { container_name: 'otel-collector' } };
  const headBytes = compactRecordBytes(head);
  assert.equal(headBytes, Buffer.byteLength(JSON.stringify(head)));
  const cont = 'go.opentelemetry.io/collector/scraper.ScrapeMetricsFunc.ScrapeMetrics';
  const size = eventReceiverSize([
    { line: head.log, recordBytes: headBytes, payloadJsonBytes: jsonStringBodyBytes(head.log) },
    { line: cont, recordBytes: 999, payloadJsonBytes: jsonStringBodyBytes(cont) },
  ]);
  // The joined record: the head's envelope once, the continuation as "\n" + its text.
  const joined = { ...head, log: `${head.log}\n${cont}` };
  assert.equal(size, compactRecordBytes(joined));
  // Text only: the assumed metadata on the head, escaping counted.
  assert.equal(eventReceiverSize([{ line: 'say "hi"\tnow' }]), ASSUMED_RECORD_OVERHEAD_BYTES + Buffer.byteLength('say \\"hi\\"\\tnow'));
  assert.equal(eventReceiverSize([{ line: 'a' }, { line: 'b' }], 100), 100 + 1 + 2 + 1);
});

test('the busiest window is any 240 seconds, whatever its alignment', () => {
  const s = 1000;
  assert.equal(slidingWindowPeak([]), undefined);
  assert.equal(slidingWindowPeak([[0, 100], [100 * s, 100], [300 * s, 100]]), 200);
  // Half-open: an event exactly 240 s after another is in the next window.
  assert.equal(slidingWindowPeak([[0, 100], [240 * s, 100]]), 100);
  // Two aligned windows would each see 150; the 240 s across their boundary sees 300.
  assert.equal(slidingWindowPeak([[200 * s, 150], [280 * s, 150]]), 300);
  assert.equal(RECEIVER_WINDOW_SECONDS, 240);
});

test('forwarder records are measured, a CloudWatch export is unwrapped to the forwarder\'s record, text lines are not', () => {
  const fb = { log: 'GET /x 200', stream: 'stdout', kubernetes: { container_name: 'web', pod_name: 'web-1' } };
  const cwInner = { log: 'order placed', stream: 'stdout', kubernetes: { container_name: 'checkout' } };
  const cw = { timestamp: 1792010957000, message: JSON.stringify(cwInner) };
  const r = receiverExtractionInputs([fb, JSON.stringify(fb), cw, '2026-10-14T20:49:17Z plain text line', 'continuation']);
  assert.deepEqual(r.lineRecordBytes, [compactRecordBytes(fb), compactRecordBytes(fb), compactRecordBytes(cwInner), undefined, undefined]);
  assert.deepEqual(r.linePayloadJsonBytes, [jsonStringBodyBytes(fb.log), jsonStringBodyBytes(fb.log), jsonStringBodyBytes('order placed'), undefined, undefined]);
  // A line with no time takes the previous record's, in arrival order.
  assert.equal(r.lineTimesMs[2], 1792010957000);
  assert.equal(r.lineTimesMs[3], Date.parse('2026-10-14T20:49:17Z'));
  assert.equal(r.lineTimesMs[4], Date.parse('2026-10-14T20:49:17Z'));
});

test('times are read from coloured lines and from a JSON log line\'s own time field', () => {
  const ansi = { log: '\u001b[2m2026-10-14T20:49:33.550482Z\u001b[0m \u001b[32m INFO\u001b[0m shipping: Requesting quote', kubernetes: { container_name: 'shipping' } };
  const pino = { log: '{"level":"info","time":1792010973657,"msg":"Transaction complete."}', kubernetes: { container_name: 'payment' } };
  const r = receiverExtractionInputs([ansi, pino]);
  assert.equal(r.lineTimesMs[0], Date.parse('2026-10-14T20:49:33.550Z'));
  assert.equal(r.lineTimesMs[1], 1792010973657);
  assert.equal(resolveFileSpan([ansi, pino], undefined).recordsWithTimestamp, 2);
});

test('the templater gets the records grouped by container, file order kept within each', () => {
  const rec = (c: string, log: string) => ({ log, kubernetes: { container_name: c } });
  const records = [rec('a', 'a1'), rec('b', 'b1'), rec('a', 'a2'), rec('c', 'c1'), rec('b', 'b2')];
  assert.deepEqual(containerOrder(records), [0, 2, 1, 4, 3]);
});

test('the plan states how the caps\' unit was reached', () => {
  assert.ok(receiverBytesStatement('records').startsWith('Limits are in the Receiver\'s unit, measured on the forwarder\'s records'));
  const assumed = receiverBytesStatement('assumed_overhead', 760);
  assert.ok(assumed.includes('plus 760 bytes of forwarder metadata'));
  assert.ok(receiverBytesStatement('assumed_overhead', 1200).includes('plus 1,200 bytes'));
  for (const s of [receiverBytesStatement('records'), assumed]) assert.ok(!s.includes('\u2014') && !/240|window/i.test(s));
});

// ── The quiet capture ───────────────────────────────────────────────────

interface Fixture {
  receiverBytesBasis: string;
  receiverTimedSpanSeconds: number;
  patterns: ExtractedPattern[];
}
const fx = JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'containment-quiet-patterns.json'), 'utf8')) as Fixture;
const SPAN = fx.receiverTimedSpanSeconds;
const perWindow = (bytesOverSpan: number): number => (bytesOverSpan * RECEIVER_WINDOW_SECONDS) / SPAN;

function solve(capUnit: 'receiver' | 'payload') {
  return solvePlan(
    fx.patterns.map((p) => ({
      hash: p.tenxHash ?? p.hash,
      name: p.symbolMessage ?? p.hash,
      services: { [p.service ?? '(unattributed)']: p.rawBytes ?? p.bytes },
      severity: p.severity ?? '',
      bytes: p.rawBytes ?? p.bytes,
      ...(p.count > 0 ? { avgEventBytes: (p.rawBytes ?? p.bytes) / p.count } : {}),
      ...(capUnit === 'receiver' ? { capBytes: p.receiverCapBytes } : { capBytes: p.bytes }),
    })),
    { destination: 'datadog', retrieverInstalled: false, target: { kind: 'percent', value: 70 }, scope: 'all', allowLossy: false, exceptionServices: [], spanSeconds: SPAN },
  );
}

/** Each counter (message pattern in its container) the plan keeps, at its busiest window in record bytes. */
function keptCounters(plan: ReturnType<typeof solve>) {
  const moved = new Set(plan.planned.filter((r) => r.action !== 'pass').map((r) => r.hash));
  const counters = new Map<string, { service: string; name: string; peak: number; kept: boolean }>();
  for (const p of fx.patterns) {
    const key = `${p.symbolMessage ?? p.hash}\u0000${p.service ?? ''}`;
    const c = counters.get(key) ?? { service: p.service ?? '', name: p.symbolMessage ?? p.hash, peak: 0, kept: true };
    c.peak = Math.max(c.peak, p.receiverPeakWindowBytes ?? 0);
    if (moved.has(p.tenxHash ?? p.hash)) c.kept = false;
    counters.set(key, c);
  }
  return [...counters.values()].filter((c) => c.kept);
}

test('quiet capture: measured on the forwarder\'s records, every statement\'s busiest window in record bytes', () => {
  assert.equal(fx.receiverBytesBasis, 'records');
  const fatal = fx.patterns.find((p) => p.symbolMessage === 'role_root_does_not_exist' && p.service === 'astronomy-db')!;
  // 48 lines of 250 bytes in its busiest 240 s, against a 69-byte payload a line.
  assert.equal(fatal.receiverPeakWindowBytes, 12_000);
  assert.ok(fatal.bytes / fatal.count < 70);
  const scrape = fx.patterns.find((p) => p.symbolMessage === 'error_Error_scraping_metrics')!;
  // The stack-trace lines joined into each record: 9,347 bytes in its busiest 240 s.
  assert.equal(scrape.receiverPeakWindowBytes, 9_347);
});

test('quiet capture: every statement the plan keeps sits under its container\'s cap in record bytes', () => {
  const plan = solve('receiver');
  const over: string[] = [];
  for (const c of keptCounters(plan)) {
    const cap = plan.containerCaps[c.service];
    if (!cap || cap.action !== 'tier_down' || !(cap.capBytesMonthly > 0)) continue;
    if (c.peak > Math.ceil(perWindow(cap.capBytesMonthly))) over.push(`${c.service}/${c.name} ${c.peak} > ${Math.ceil(perWindow(cap.capBytesMonthly))}`);
  }
  assert.deepEqual(over, []);
});

test('quiet capture: each separated cap leaves the same margin to the largest kept and the smallest moved statement', () => {
  const plan = solve('receiver');
  const moved = new Set(plan.planned.filter((r) => r.action !== 'pass').map((r) => r.hash));
  let separated = 0;
  for (const [service, cap] of Object.entries(plan.containerCaps)) {
    if (cap.action !== 'tier_down' || !cap.separated) continue;
    separated++;
    const capWindow = perWindow(cap.capBytesMonthly);
    const keptPeak = Math.max(
      ...fx.patterns.filter((p) => p.service === service && !moved.has(p.tenxHash ?? p.hash)).map((p) => p.receiverPeakWindowBytes ?? 0),
    );
    const movedPeak = Math.min(
      ...fx.patterns.filter((p) => p.service === service && moved.has(p.tenxHash ?? p.hash)).map((p) => p.receiverPeakWindowBytes ?? Infinity),
    );
    assert.ok(Math.abs(capWindow / keptPeak - cap.margin!) < 1e-6, `${service}: kept side`);
    assert.ok(Math.abs(movedPeak / capWindow - cap.margin!) < 1e-6, `${service}: moved side`);
    assert.ok(cap.margin! > 1);
  }
  assert.ok(separated > 0);
});

test('quiet capture, the defect: caps in payload bytes leave kept statements above their caps', () => {
  const plan = solve('payload');
  const over = keptCounters(plan).filter((c) => {
    const cap = plan.containerCaps[c.service];
    return cap && cap.action === 'tier_down' && cap.capBytesMonthly > 0 && c.peak > perWindow(cap.capBytesMonthly);
  });
  assert.ok(over.length > 0, 'the payload unit must fail this check, or the check proves nothing');
});

test('quiet capture: the fleet default\'s baseline is in record bytes, and astronomy-db\'s FATAL line sits under its cap', () => {
  const plan = solve('receiver');
  const moved = new Set(plan.planned.filter((r) => r.action !== 'pass').map((r) => r.hash));
  const fd = fleetDefaultFromPatterns(
    fx.patterns,
    (p) => moved.has(p.tenxHash ?? p.hash),
    SPAN,
    undefined,
    { action: 'offload', errorFloor: 0.5 },
    'datadog',
    (p) => p.symbolMessage ?? p.hash,
  );
  assert.equal(fd.computed, true);
  assert.equal(fd.baseline_statement, 'role_root_does_not_exist');
  assert.equal(fd.baseline_container, 'astronomy-db');
  assert.equal(Math.round(fd.baseline_bytes_per_window_per_node!), 12_000);
  assert.equal(fd.cap_bytes_per_window_per_node, 24_000);
  const fatal = fx.patterns.find((p) => p.symbolMessage === 'role_root_does_not_exist')!;
  assert.ok(fatal.receiverPeakWindowBytes! < fd.cap_bytes_per_window_per_node!);
});
