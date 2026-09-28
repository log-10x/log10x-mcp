import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPocReport } from '../src/lib/poc-report-renderer.js';
import type { ExtractedPatterns } from '../src/lib/pattern-extraction.js';

// A known daily volume must give the same daily cost whatever the pull
// window. Before the fix, per-pattern costs were scaled to a full day and then
// projected again from the window, so a 1h pull read 24x high and the 14d
// default read 14x low.
function extraction(): ExtractedPatterns {
  return {
    totalEvents: 10_000, totalBytes: 10 * 1024 * 1024, inputLineCount: 10_000,
    templaterWallTimeMs: 1, executionMode: 'local_cli', severityCoverage: 1,
    positionalBindingExact: true, inputLinesSubmitted: 0, inputLinesAccountedFor: 0,
    patterns: [
      { hash: 'a', template: '$(ts) INFO heartbeat $', count: 8_000, bytes: 8 * 1024 * 1024, severity: 'INFO', service: 's', sampleEvent: 'x', variables: {} },
      { hash: 'b', template: '$(ts) ERROR failed $', count: 2_000, bytes: 2 * 1024 * 1024, severity: 'ERROR', service: 's', sampleEvent: 'y', variables: {} },
    ],
  };
}
function dailyCost(windowHours: number): number {
  const out = renderPocReport({
    siem: 'cloudwatch', window: `${windowHours}h`, extraction: extraction(), targetEventCount: 10_000,
    pullWallTimeMs: 1, templateWallTimeMs: 1, reasonStopped: 'target_reached', queryUsed: 'g',
    windowHours, analyzerCostPerGb: 0.5, snapshotId: 's', startedAt: 'a', finishedAt: 'b', mcpVersion: 't',
    totalDailyGb: 10, volumeSource: 'user_arg',
  } as any);
  const m = out.markdown.match(/\*\*Projected daily cost\*\*: \$([0-9.,]+)/);
  assert.ok(m, 'daily cost line present');
  return Number(m![1].replace(/,/g, ''));
}

test('daily cost equals daily volume x rate for any pull window', () => {
  // 10 GB/day at $0.50/GB = $5/day
  for (const h of [1, 24, 168, 336]) {
    assert.equal(dailyCost(h), 5, `window ${h}h`);
  }
});
