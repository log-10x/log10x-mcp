/**
 * The native-filter arm on a local capture (poc_from_local, Datadog): which
 * events the capture holds, the plan's actions on the patterns, and a raw
 * forwarder record's missing Datadog status read from the engine's severity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { captureEventSource, captureEventSourceSentence } from '../src/lib/local-file-source.js';
import { pipelineSplitAttribute } from '../src/lib/pattern-extraction.js';
import { computeNativeControl, controlPatterns, type ControlSource } from '../src/lib/datadog-native-control.js';

const fb = (container: string, log: string) => ({ log, stream: 'stdout', kubernetes: { container_name: container } });

test('a capture says which events it holds: forwarder output, a Datadog archive, the pods, or plain lines', () => {
  assert.equal(captureEventSource([fb('web', 'GET / 200'), JSON.stringify(fb('api', 'ok'))]), 'forwarder');
  const cw = { timestamp: 1792010957000, message: JSON.stringify(fb('checkout', 'order placed')) };
  assert.equal(captureEventSource([cw, cw]), 'forwarder');
  const archive = { date: '2026-10-14T00:00:00Z', service: 'web', status: 'info', message: 'GET / 200', attributes: { http: { status_code: 200 } } };
  assert.equal(captureEventSource([archive, JSON.stringify(archive)]), 'archive');
  assert.equal(captureEventSource(['2026-10-14T00:00:00Z plain line', 'another line']), 'lines');
  assert.equal(captureEventSource(['anything'], true), 'pods');
  for (const k of ['forwarder', 'archive', 'pods'] as const) {
    const s = captureEventSourceSentence(k);
    assert.ok(s.includes('the ones a Datadog index exclusion filter drops as well as the ones it indexes'), s);
    assert.ok(s.includes('A sample read back from Datadog holds indexed events only.'), s);
  }
  assert.match(captureEventSourceSentence('lines'), /when the file is the forwarder's output or a Datadog archive, and not when it was read back from Datadog/);
  for (const k of ['forwarder', 'pods', 'lines'] as const) {
    assert.match(captureEventSourceSentence(k), /no Datadog status, its status here is the severity the engine reads from its text\.$/);
  }
  assert.doesNotMatch(captureEventSourceSentence('archive'), /severity the engine reads/);
});

function sources(): ControlSource[] {
  const p = (identity: string, hash: string, service: string, severity: string, count: number, recommendedAction: string): ControlSource => ({
    identity,
    template: `${identity} $`,
    sampleEvent: identity,
    tenxHash: hash,
    hash: `t-${hash}`,
    service,
    severity,
    count,
    bytes: count * 100,
    // A forwarder's raw record: service and count, no Datadog status.
    cells: [{ service, count, bytes: count * 100 }],
    recommendedAction,
  });
  return [
    p('traces exported', 'hT', 'collector', 'INFO', 1000, 'tier_down'),
    p('metrics exported', 'hM', 'collector', 'INFO', 400, 'keep'),
    p('export failed', 'hE', 'collector', 'ERROR', 50, 'keep'),
    p('cart read', 'hC', 'cart', 'INFO', 300, 'keep'),
  ];
}

test('the plan\'s actions set each pattern; a cell with no status takes the pattern\'s severity', () => {
  const planned = new Map([['hT', 'tier_down'], ['hC', 'tier_down']]);
  const cp = controlPatterns(sources(), planned);
  assert.deepEqual(cp.map((p) => [p.identity, p.action]), [
    ['traces exported', 'tier_down'],
    ['metrics exported', 'keep'],
    ['export failed', 'keep'],
    ['cart read', 'tier_down'],
  ]);
  assert.equal(cp[2].cells![0].status, 'ERROR');
  // No plan: the recommended action stands.
  assert.deepEqual(controlPatterns(sources()).map((p) => p.action), ['tier_down', 'keep', 'keep', 'keep']);
});

test('on raw forwarder records the status clause still keeps the error lines in Standard', () => {
  const c = computeNativeControl(controlPatterns(sources(), new Map([['hT', 'tier_down'], ['hC', 'tier_down']])));
  // The plan moves 1,300 events (traces 1,000 and cart 300). The collector's filter moves its
  // 1,400 INFO events, enough: largest first, so cart is not named.
  assert.equal(c.plan.events, 1300);
  assert.deepEqual(c.native.filters.map((f) => [f.service, f.events]), [['collector', 1400]]);
  assert.equal(c.native.events, 1400);
  assert.equal(c.native.errorsAndWarnings, 0, 'the ERROR pattern stays in Standard under the status clause');
  assert.equal(c.native.keptPatternEventsMoved, 400);
  assert.equal(c.native.leftThatOtherMoves, 300);
});

test('the Kafka pipeline reads the log4j class that ends a line into logger.name', () => {
  assert.deepEqual(
    pipelineSplitAttribute('kafka', ['[2026-08-08 20:34:11,186] INFO [LocalLog partition=__cluster_metadata-0] Rolled new log segment at offset 422 in 1 ms. (kafka.log.LocalLog)']),
    { name: 'logger.name', value: 'kafka.log.LocalLog' },
  );
  assert.deepEqual(
    pipelineSplitAttribute('kafka', ['[2026-08-08 20:34:11,186] INFO Loaded producer state (kafka.log.UnifiedLog$) ']),
    { name: 'logger.name', value: 'kafka.log.UnifiedLog$' },
  );
});

test('a multi-line Kafka event takes the first of its lines that ends with a class', () => {
  assert.deepEqual(
    pipelineSplitAttribute('kafka', ['[2026-08-08 20:34:11,186] INFO KafkaConfig values:', '\tadvertised.listeners = PLAINTEXT://kafka:9092', '\tzookeeper.connect = null (kafka.server.KafkaConfig)']),
    { name: 'logger.name', value: 'kafka.server.KafkaConfig' },
  );
  assert.deepEqual(
    pipelineSplitAttribute('kafka', ['[2026-08-08 20:34:11,186] ERROR Failed (kafka.server.ReplicaManager)\njava.io.IOException: boom (detail)\n\tat kafka.log.LocalLog.roll(LocalLog.scala:1)']),
    { name: 'logger.name', value: 'kafka.server.ReplicaManager' },
  );
});

test('other services and lines without a class get no logger.name', () => {
  assert.equal(pipelineSplitAttribute('cart', ['Fetched cart (oteldemo.CartService)']), undefined);
  assert.equal(pipelineSplitAttribute(undefined, ['x (a.b)']), undefined);
  assert.equal(pipelineSplitAttribute('kafka', ['===> Launching kafka ...']), undefined);
  assert.equal(pipelineSplitAttribute('kafka', ['ends in a word (notaclass)']), undefined);
});

test('no native filter moves an event of status warn or above: critical, alert, emergency and a FATAL level stay in Standard', () => {
  const p = (hash: string, service: string, severity: string, count: number): ControlSource => ({
    identity: hash, template: hash, sampleEvent: '', hash, service, severity, count, bytes: count * 100,
    cells: [{ service, status: severity, count, bytes: count * 100 }], recommendedAction: 'keep',
  });
  const c = computeNativeControl(controlPatterns(
    [p('c1', 'collector', 'info', 1000), p('f1', 'frontend', 'info', 100), p('f2', 'frontend', 'CRITICAL', 300),
      p('f3', 'frontend', 'FATAL', 50), p('f4', 'frontend', 'alert', 20), p('f5', 'frontend', 'emergency', 10), p('f6', 'frontend', 'warn', 5)],
    new Map([['c1', 'tier_down'], ['f1', 'tier_down']]),
  ));
  assert.deepEqual(c.native.filters.map((f) => [f.service, f.events]), [['collector', 1000], ['frontend', 100]]);
  assert.equal(c.native.events, 1100);
  assert.equal(c.native.errorsAndWarnings, 0);
});
