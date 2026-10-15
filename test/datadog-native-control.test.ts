/**
 * The Datadog POC report's two arms on one pulled sample: the index filters a
 * person writes without 10x against the per-pattern plan, in Datadog's unit
 * (events kept out of the Standard index); the pattern ID counted three ways;
 * and the ingestion line beside the indexing line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeNativeControl,
  filterQuery,
  renderNativeControlSection,
  templatePhrases,
  type ControlPattern,
} from '../src/lib/datadog-native-control.js';

/** One hour of a small estate: web has a plain service filter, kafka splits on logger.name. */
function sample(): ControlPattern[] {
  const cell = (service: string, status: string, count: number, bytes: number, logger?: string) => ({
    service,
    status,
    count,
    bytes,
    ...(logger ? { attribute: { name: 'logger.name', value: logger } } : {}),
  });
  return [
    { identity: 'request_served', template: 'request served in $ ms', sampleEvent: 'request served in 12 ms', tenxHash: 'hA', service: 'web', severity: 'info', count: 1000, bytes: 1_000_000, action: 'tier_down', cells: [cell('web', 'info', 1000, 1_000_000)] },
    { identity: 'cache_warmed', template: 'cache warmed $ entries', sampleEvent: 'cache warmed 5 entries', tenxHash: 'hB', service: 'web', severity: 'info', count: 100, bytes: 100_000, action: 'keep', cells: [cell('web', 'info', 100, 100_000)] },
    { identity: 'request_failed', template: 'request failed $', sampleEvent: 'request failed 500', tenxHash: 'hC', service: 'web', severity: 'error', count: 50, bytes: 50_000, action: 'keep', cells: [cell('web', 'error', 50, 50_000)] },
    { identity: 'segment_rolled', template: 'Rolled new log segment at offset $', sampleEvent: 'Rolled new log segment at offset 42', tenxHash: 'hD', service: 'kafka', severity: 'info', count: 600, bytes: 600_000, action: 'tier_down', cells: [cell('kafka', 'info', 600, 600_000, 'kafka.log.LogSegment')] },
    { identity: 'producer_state', template: 'Loading producer state $', sampleEvent: 'Loading producer state 7', tenxHash: 'hE', service: 'kafka', severity: 'info', count: 300, bytes: 300_000, action: 'keep', cells: [cell('kafka', 'info', 300, 300_000, 'kafka.log.UnifiedLog')] },
    { identity: 'cache_warmed_short', template: 'cache warmed', sampleEvent: 'cache warmed', tenxHash: 'hF', service: 'web', severity: 'info', count: 40, bytes: 40_000, action: 'tier_down', cells: [cell('web', 'info', 40, 40_000)] },
    { identity: 'request_served_short', template: 'request served $', sampleEvent: 'request served 7', tenxHash: 'hG', service: 'web', severity: 'info', count: 20, bytes: 20_000, action: 'tier_down', cells: [cell('web', 'info', 20, 20_000)] },
  ];
}

test('template phrases: the constant runs between slots, without the token a slot touches', () => {
  assert.deepEqual(templatePhrases('request served in $ ms'), [['request', 'served', 'in'], ['ms']]);
  assert.deepEqual(templatePhrases('user=$ did $'), [['user'], ['did']]);
  assert.deepEqual(templatePhrases('at $(yyyy-MM-dd) rolled $1 again'), [['at'], ['rolled'], ['again']]);
});

test('native filters: a service filter, or one per parsed attribute value, largest first until they reach the plan', () => {
  const c = computeNativeControl(sample());
  // The plan moves 1,000 + 600 + 40 + 20 = 1,660 events. web (1,160 without
  // its error pattern) then kafka's largest logger class (600) reach it.
  assert.equal(c.plan.events, 1660);
  assert.deepEqual(c.native.filters.map(filterQuery), [
    'service:web -status:(emergency OR alert OR critical OR error OR warn)',
    'service:kafka @logger.name:kafka.log.LogSegment -status:(emergency OR alert OR critical OR error OR warn)',
  ]);
  assert.equal(c.native.events, 1760);
  assert.equal(c.native.errorsAndWarnings, 0);
  // The web filter moves the 100 events of `cache_warmed`, which the plan keeps.
  assert.equal(c.native.keptPatternEventsMoved, 100);
  assert.equal(c.native.leftThatOtherMoves, 0);
  assert.equal(c.plan.leftThatOtherMoves, 100);
  assert.equal(c.plan.errorsAndWarnings, 0);
  assert.equal(c.plan.tierDownEvents, 1660);
  assert.equal(c.plan.offloadEvents, 0);
  assert.deepEqual(c.services.map((s) => [s.service, s.splitAttribute, s.filters.length]), [
    ['web', undefined, 1],
    ['kafka', 'logger.name', 1],
  ]);
});

test('the pattern ID, counted: isolable alone, only as a group, or not at all', () => {
  const c = computeNativeControl(sample());
  assert.deepEqual(c.id.isolable, ['request_served', 'segment_rolled']);
  assert.deepEqual(c.id.group, ['request_served_short']);
  assert.deepEqual(c.id.notIsolable, [{ identity: 'cache_warmed_short', events: 40, sharedWithKept: ['cache_warmed'] }]);
  assert.deepEqual(c.id.hashes, ['hA', 'hD', 'hF', 'hG']);
  assert.equal(c.id.withoutHash, 0);
});

test('the section: both arms in one table, the hash filter, the ingestion line beside indexing', () => {
  const lines = renderNativeControlSection({
    patterns: sample(),
    totalBytes: 2_110_000,
    windowHours: 1,
    window: '1h',
  });
  const text = lines.join('\n');
  assert.match(text, /\| Native index filters \| 2 filters \| 1,760 \(100 more than the plan\) \| 0 \| 100 \| 0 \|/);
  assert.match(text, /\| Per-pattern plan \| 1 filter, 4 values \| 1,660 \| 0 \| 0 \| 100 \|/);
  assert.match(text, /only the `\*:` free-text syntax is barred/);
  assert.match(text, /isolates 2 alone and 1 only together with other patterns the plan also moves; for 1, every such filter also selects a pattern the plan keeps/);
  assert.match(text, /@tenx_hash:\("hA" OR "hD" OR "hF" OR "hG"\)/);
  assert.match(text, /one statement, several hashes/);
  // Ingestion beside indexing: the moved lines still pay ingestion under both
  // arms; only offload avoids it. At this volume the Flex line is Starter.
  assert.match(text, /\| Standard indexing avoided \| Ingestion still paid \| Ingestion avoided \| Flex Starter added \|/);
  assert.match(text, /\| Native index filters, routed to a Flex index \| [^|]+ \| [^|]+ \| \$[\d.,]+ \(list price\) \| \$[\d.,]+ \(list price\) \| none \| \$[\d.,]+ \(list price\) \|/);
  assert.match(text, /\| Per-pattern plan, as written \| [^|]+ \| [^|]+ \| \$[\d.,]+ \(list price\) \| \$[\d.,]+ \(list price\) \| none \| \$[\d.,]+ \(list price\) \|/);
  assert.match(text, /\| The plan's patterns offloaded to S3 instead \| .* \| none \| \$[\d.,]+ \(list price\) \| none \|/);
  assert.match(text, /ingestion \$0\.10 per GB \(list price\)/);
  assert.match(
    text,
    /Flex Starter \$0\.60 per million events stored a month \(list price\), compute bundled for volumes below 2 billion events a month and 10 billion stored, held 3 months/,
  );
  assert.ok(!/%[^.]*\bbill\b/i.test(text), 'no share of the bill');
  assert.ok(!/—/.test(text), 'no em dash');
});

test('with no rate set, the section states counts and withholds dollars', () => {
  const text = renderNativeControlSection({ patterns: sample(), totalBytes: 2_110_000, windowHours: 1, window: '1h', dollarsWithheld: true }).join('\n');
  assert.match(text, /Dollar lines are withheld/);
  assert.ok(!/\$\d/.test(text));
});

test('a plan that keeps everything has nothing to set the filters against', () => {
  const kept = sample().map((p) => ({ ...p, action: 'keep' }));
  const text = renderNativeControlSection({ patterns: kept, totalBytes: 1, windowHours: 1, window: '1h' }).join('\n');
  assert.match(text, /nothing to set the native filters against/);
});

test('the Datadog POC report carries the section; other destinations do not', async () => {
  const { renderPocReport } = await import('../src/lib/poc-report-renderer.js');
  const cells = (service: string, status: string, count: number, bytes: number) => [{ service, status, count, bytes }];
  const patterns = [
    { hash: 'a', tenxHash: 'hA', template: 'request served in $ ms', sampleEvent: 'request served in 12 ms', variables: {}, service: 'web', severity: 'INFO', count: 9000, bytes: 9_000_000, cells: cells('web', 'info', 9000, 9_000_000) },
    { hash: 'b', tenxHash: 'hB', template: 'cache warmed $ entries', sampleEvent: 'cache warmed 5 entries', variables: {}, service: 'web', severity: 'INFO', count: 100, bytes: 100_000, cells: cells('web', 'info', 100, 100_000) },
    { hash: 'c', tenxHash: 'hC', template: 'request failed $', sampleEvent: 'request failed 500', variables: {}, service: 'web', severity: 'ERROR', count: 50, bytes: 50_000, cells: cells('web', 'error', 50, 50_000) },
  ];
  const input = (siem: 'datadog' | 'cloudwatch') => ({
    siem,
    window: '1h',
    extraction: {
      patterns,
      totalEvents: 9150,
      totalBytes: 9_150_000,
      inputLineCount: 9150,
      templaterWallTimeMs: 5,
      executionMode: 'local_cli' as const,
      severityCoverage: 1,
      positionalBindingExact: true,
      inputLinesSubmitted: 9150,
      inputLinesAccountedFor: 9150,
    },
    targetEventCount: 9150,
    pullWallTimeMs: 10,
    templateWallTimeMs: 5,
    reasonStopped: 'source_exhausted' as const,
    queryUsed: 'test',
    windowHours: 1,
    analyzerCostPerGb: 2.5,
    snapshotId: 'test',
    startedAt: '2026-10-13T00:00:00.000Z',
    finishedAt: '2026-10-13T01:00:00.000Z',
    mcpVersion: '0.0.0-test',
  });
  const dd = renderPocReport(input('datadog') as never).markdown;
  assert.match(dd, /Native Index Filters Against the Plan/);
  assert.match(dd, /service:web -status:\(emergency OR alert OR critical OR error OR warn\)/);
  assert.match(dd, /@tenx_hash:\(/);
  const cw = renderPocReport(input('cloudwatch') as never).markdown;
  assert.ok(!/Native Index Filters Against the Plan/.test(cw));
});
