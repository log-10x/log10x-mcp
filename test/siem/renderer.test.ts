import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderPocReport } from '../../src/lib/poc-report-renderer.js';
import type { ExtractedPatterns } from '../../src/lib/pattern-extraction.js';

function fixture(): ExtractedPatterns {
  return {
    totalEvents: 50_000,
    totalBytes: 80 * 1024 * 1024, // 80 MB
    inputLineCount: 50_000,
    templaterWallTimeMs: 1200,
    executionMode: 'paste_lambda',
    patterns: [
      {
        hash: 'h_a',
        template: '$(ts) INFO heartbeat every $ seconds from $',
        count: 40_000,
        bytes: 60 * 1024 * 1024,
        severity: 'INFO',
        service: 'checkout-svc',
        sampleEvent: '2026-04-13T10:00:00Z INFO heartbeat every 30 seconds from pod-123',
        variables: { slot_0: ['30'], slot_1: ['pod-123', 'pod-124'] },
      },
      {
        hash: 'h_b',
        template: '$(ts) ERROR $ failed to connect to $: $',
        count: 250,
        bytes: 400_000,
        severity: 'ERROR',
        service: 'payments-svc',
        sampleEvent: '2026-04-13T10:00:00Z ERROR payments-svc failed to connect to db: timeout',
        variables: { slot_0: ['payments-svc'], slot_1: ['db'], slot_2: ['timeout', 'conn refused'] },
      },
      {
        hash: 'h_c',
        template: '$(ts) WARN slow query: $ took $ ms',
        count: 9_750,
        bytes: 18 * 1024 * 1024,
        severity: 'WARN',
        service: 'db-proxy',
        sampleEvent: '2026-04-13T10:00:00Z WARN slow query: select * took 1200 ms',
        variables: { slot_0: ['select *', 'insert'], slot_1: ['1200', '1800'] },
      },
    ],
  };
}

test('renderPocReport emits all 9 sections', () => {
  const out = renderPocReport({
    siem: 'splunk',
    window: '7d',
    scope: 'main',
    query: undefined,
    extraction: fixture(),
    targetEventCount: 100_000,
    pullWallTimeMs: 5_000,
    templateWallTimeMs: 1_200,
    reasonStopped: 'target_reached',
    queryUsed: 'search index=main',
    windowHours: 168,
    analyzerCostPerGb: 6,
    snapshotId: 'test-snap',
    startedAt: '2026-04-19T00:00:00Z',
    finishedAt: '2026-04-19T00:00:05Z',
    mcpVersion: '1.4.0',
  });

  // Structural sections
  for (const heading of [
    '## 1. Executive Summary',
    '## 2. Top Cost Drivers',
    '## 3. Service-Level Breakdown',
    '## 4. Reducer Recommendations',
    '## 5. Native SIEM Exclusion Configs',
    '## 6. Compaction Potential', // Splunk → present
    '## 7. Risk / Dependency Check',
    '## 8. Deployment Paths',
    '## 9. Appendix',
  ]) {
    assert.ok(out.markdown.includes(heading), `missing ${heading}`);
  }

  // Summary shape
  assert.equal(out.summary.eventsAnalyzed, 50_000);
  assert.equal(out.summary.patternsFound, 3);
  assert.ok(out.summary.totalCostAnalyzed > 0);
  assert.ok(out.summary.top3Actions.length > 0);
});

test('renderPocReport omits compaction section for non-compacting SIEMs', () => {
  const out = renderPocReport({
    siem: 'datadog',
    window: '7d',
    extraction: fixture(),
    targetEventCount: 100_000,
    pullWallTimeMs: 5_000,
    templateWallTimeMs: 1_200,
    reasonStopped: 'target_reached',
    queryUsed: 'service:checkout',
    windowHours: 168,
    analyzerCostPerGb: 2.5,
    snapshotId: 'test-dd',
    startedAt: '2026-04-19T00:00:00Z',
    finishedAt: '2026-04-19T00:00:05Z',
    mcpVersion: '1.4.0',
  });
  assert.ok(!out.markdown.includes('## 6. Compaction Potential'));
  // Native config block should render Datadog-specific exclusion JSON.
  assert.ok(out.markdown.includes('### Datadog'));
});

test('renderPocReport flags low-confidence when <10k events pulled', () => {
  const small: ExtractedPatterns = {
    totalEvents: 500,
    totalBytes: 250_000,
    inputLineCount: 500,
    templaterWallTimeMs: 50,
    executionMode: 'paste_lambda',
    patterns: [
      {
        hash: 'h',
        template: 'INFO hello $',
        count: 500,
        bytes: 250_000,
        severity: 'INFO',
        service: 'svc',
        sampleEvent: 'INFO hello world',
        variables: {},
      },
    ],
  };
  const out = renderPocReport({
    siem: 'cloudwatch',
    window: '1h',
    extraction: small,
    targetEventCount: 100_000,
    pullWallTimeMs: 1_000,
    templateWallTimeMs: 50,
    reasonStopped: 'source_exhausted',
    queryUsed: '/aws/my-svc',
    windowHours: 1,
    analyzerCostPerGb: 0.5,
    snapshotId: 'test-small',
    startedAt: '2026-04-19T00:00:00Z',
    finishedAt: '2026-04-19T00:00:01Z',
    mcpVersion: '1.4.0',
  });
  assert.ok(out.markdown.includes('Low-confidence mode'));
});

test('renderPocReport emits time-exhaustion banner when reason=time_exhausted', () => {
  const out = renderPocReport({
    siem: 'elasticsearch',
    window: '7d',
    extraction: fixture(),
    targetEventCount: 500_000,
    pullWallTimeMs: 300_000,
    templateWallTimeMs: 1_200,
    reasonStopped: 'time_exhausted',
    queryUsed: 'logs-*',
    windowHours: 168,
    analyzerCostPerGb: 1,
    snapshotId: 'test-es',
    startedAt: '2026-04-19T00:00:00Z',
    finishedAt: '2026-04-19T00:05:00Z',
    mcpVersion: '1.4.0',
  });
  assert.ok(out.markdown.includes('time budget reached'));
});

test('renderPocReport classifies actions: mute for hot INFO, keep for ERROR, sample for warn-hotloop', () => {
  const out = renderPocReport({
    siem: 'datadog',
    window: '7d',
    extraction: fixture(),
    targetEventCount: 100_000,
    pullWallTimeMs: 5_000,
    templateWallTimeMs: 1_200,
    reasonStopped: 'target_reached',
    queryUsed: '*',
    windowHours: 168,
    analyzerCostPerGb: 2.5,
    snapshotId: 'test-actions',
    startedAt: '2026-04-19T00:00:00Z',
    finishedAt: '2026-04-19T00:00:05Z',
    mcpVersion: '1.4.0',
  });
  // INFO heartbeat (hot, 80% of volume) → mute
  assert.ok(/mute \(drop all events\)/.test(out.markdown));
  // ERROR pattern → keep
  assert.ok(/severity=ERROR/i.test(out.markdown));
  // WARN pattern (slow query, 19.5% of volume → hotloop) → sample
  assert.ok(/sample 1\/(10|20)/.test(out.markdown));
});

test('renderPocReport native exclusion configs include the chosen SIEM', () => {
  for (const siem of ['datadog', 'splunk', 'elasticsearch', 'cloudwatch', 'azure-monitor', 'gcp-logging', 'sumo', 'clickhouse'] as const) {
    const out = renderPocReport({
      siem,
      window: '7d',
      extraction: fixture(),
      targetEventCount: 100_000,
      pullWallTimeMs: 5_000,
      templateWallTimeMs: 1_200,
      reasonStopped: 'target_reached',
      queryUsed: '*',
      windowHours: 168,
      analyzerCostPerGb: 1,
      snapshotId: `test-${siem}`,
      startedAt: '2026-04-19T00:00:00Z',
      finishedAt: '2026-04-19T00:00:05Z',
      mcpVersion: '1.4.0',
    });
    assert.ok(out.markdown.includes('Fluent Bit (universal forwarder)'), `${siem}: missing fluent-bit block`);
  }
});

test('renderPocReport reducer YAML has an untilEpochSec', () => {
  const out = renderPocReport({
    siem: 'datadog',
    window: '7d',
    extraction: fixture(),
    targetEventCount: 100_000,
    pullWallTimeMs: 5_000,
    templateWallTimeMs: 1_200,
    reasonStopped: 'target_reached',
    queryUsed: '*',
    windowHours: 168,
    analyzerCostPerGb: 2.5,
    snapshotId: 'test-yaml',
    startedAt: '2026-04-19T00:00:00Z',
    finishedAt: '2026-04-19T00:00:05Z',
    mcpVersion: '1.4.0',
  });
  assert.ok(/untilEpochSec: \d+/.test(out.markdown));
});

test('renderPocReport handles zero patterns gracefully', () => {
  const empty: ExtractedPatterns = {
    totalEvents: 0,
    totalBytes: 0,
    inputLineCount: 0,
    templaterWallTimeMs: 0,
    executionMode: 'paste_lambda',
    patterns: [],
  };
  const out = renderPocReport({
    siem: 'splunk',
    window: '7d',
    extraction: empty,
    targetEventCount: 100_000,
    pullWallTimeMs: 1_000,
    templateWallTimeMs: 0,
    reasonStopped: 'source_exhausted',
    queryUsed: 'search index=main',
    windowHours: 168,
    analyzerCostPerGb: 6,
    snapshotId: 'test-empty',
    startedAt: '2026-04-19T00:00:00Z',
    finishedAt: '2026-04-19T00:00:01Z',
    mcpVersion: '1.4.0',
  });
  assert.equal(out.summary.patternsFound, 0);
  // Should not throw, but should note zero patterns.
  assert.ok(out.markdown.includes('No patterns resolved') || out.markdown.includes('_No patterns._'));
});
