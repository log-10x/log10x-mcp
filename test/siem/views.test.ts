/**
 * Per-view renderer tests. Each view is deterministic given a
 * RenderInput; we lock down shape + line counts + must-include tokens
 * so future changes that bloat the summary (or accidentally strip the
 * reducer YAML) fail loudly in CI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderPocReport,
  renderPocSummary,
  renderPocYaml,
  renderPocConfigs,
  renderPocTop,
  renderPocPattern,
} from '../../src/lib/poc-report-renderer.js';
import type { ExtractedPatterns } from '../../src/lib/pattern-extraction.js';

function fixture(): ExtractedPatterns {
  return {
    totalEvents: 50_000,
    totalBytes: 80 * 1024 * 1024,
    inputLineCount: 50_000,
    templaterWallTimeMs: 1000,
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
        template: '$(ts) ERROR $ failed to connect to $',
        count: 250,
        bytes: 400_000,
        severity: 'ERROR',
        service: 'payments-svc',
        sampleEvent: '2026-04-13T10:00:00Z ERROR payments-svc failed to connect to db',
        variables: { slot_0: ['payments-svc'], slot_1: ['db', 'cache'] },
      },
      {
        hash: 'h_c',
        template: '$(ts) WARN slow query: $ took $ ms',
        count: 9_750,
        bytes: 18 * 1024 * 1024,
        severity: 'WARN',
        service: 'db-proxy',
        sampleEvent: '2026-04-13T10:00:00Z WARN slow query: select * took 1240 ms',
        variables: { slot_0: ['select *'], slot_1: ['1240'] },
      },
    ],
  };
}

function input() {
  return {
    siem: 'splunk' as const,
    window: '7d',
    scope: 'main',
    query: undefined,
    extraction: fixture(),
    targetEventCount: 50_000,
    pullWallTimeMs: 5000,
    templateWallTimeMs: 1000,
    reasonStopped: 'target_reached' as const,
    queryUsed: 'search index=main',
    windowHours: 168,
    analyzerCostPerGb: 6,
    snapshotId: 'test-snap-1',
    startedAt: '2026-04-19T00:00:00Z',
    finishedAt: '2026-04-19T00:05:00Z',
    mcpVersion: '1.4.0',
    totalDailyGb: 100,
    volumeSource: 'user_arg' as const,
  };
}

test('summary view is under 50 lines and contains top-N + CTA', () => {
  const out = renderPocSummary(input());
  const lines = out.split('\n');
  assert.ok(lines.length < 50, `summary was ${lines.length} lines, expected < 50`);
  assert.ok(out.includes('Top'), 'summary should include the Top wins heading');
  assert.ok(out.includes('view: "full"'), 'summary should advertise the full view');
  assert.ok(out.includes('view: "yaml"'), 'summary should advertise the yaml view');
  assert.ok(out.includes('view: "pattern"'), 'summary should advertise the pattern view');
});

test('summary shows user-supplied volume mode', () => {
  const out = renderPocSummary(input());
  assert.ok(out.includes('user-supplied'), 'user_arg should render "user-supplied"');
  assert.ok(out.includes('Potential savings'), 'summary should show potential savings');
});

test('summary falls back to scenario teaser when no volume', () => {
  const i = { ...input(), totalDailyGb: undefined, volumeSource: 'none' as const };
  const out = renderPocSummary(i);
  assert.ok(out.includes('No volume specified'), 'should mention no volume');
  assert.ok(out.includes('100 GB/day'), 'should include the 100 GB/day teaser');
  assert.ok(out.includes('total_daily_gb'), 'should mention the arg name');
});

test('summary flags WARN/ERROR patterns in top-N with risk banner', () => {
  const out = renderPocSummary(input());
  // Our fixture has an ERROR pattern — should be flagged.
  assert.ok(/⚠/.test(out), 'summary should contain a risk flag emoji');
  assert.ok(out.includes('log10x_dependency_check'), 'should reference the dependency check tool');
});

test('yaml view returns valid YAML fence with reducer entries', () => {
  const out = renderPocYaml(input(), 3);
  assert.ok(out.startsWith('```yaml'), 'yaml view should start with fenced block');
  assert.ok(out.includes('- pattern:'), 'should include pattern key');
  assert.ok(out.includes('action:'), 'should include action key');
  assert.ok(out.includes('untilEpochSec:'), 'should include expiry');
  assert.ok(out.includes('reducer mute file'), 'should have reducer comment');
});

test('yaml view cap respects top_n', () => {
  const three = renderPocYaml(input(), 3).split('- pattern:').length - 1;
  const one = renderPocYaml(input(), 1).split('- pattern:').length - 1;
  // Our fixture has 1 ERROR (kept) + 1 WARN (sampled) + 1 INFO hot (muted) = 2 action≠keep
  assert.ok(three <= 3, `top_n=3 should emit at most 3 patterns; got ${three}`);
  assert.ok(one <= 1, `top_n=1 should emit at most 1 pattern; got ${one}`);
});

test('configs view emits both native + fluent-bit config fences', () => {
  const out = renderPocConfigs(input(), 3);
  assert.ok(out.includes('Splunk'), 'configs should name the SIEM');
  assert.ok(out.includes('Fluent Bit'), 'configs should always include fluent-bit block');
  assert.ok(out.includes('```'), 'configs should have at least one code fence');
});

test('top view emits a drivers table with $/year column', () => {
  const out = renderPocTop(input(), 10);
  assert.ok(out.includes('Top'), 'top view should have a title');
  assert.ok(out.includes('$/year'), 'top view should include annual $ column');
  assert.ok(out.includes('$/week'), 'top view should include weekly $ column');
});

test('pattern view returns detail for a known identity', () => {
  const patterns = renderPocReport(input()).markdown;
  // Pick an identity that should appear in the report: extract from reducer YAML block.
  const m = /- pattern: ([a-z0-9_]+)/.exec(patterns);
  assert.ok(m, 'should find at least one identity in full report');
  const identity = m[1];
  const out = renderPocPattern(input(), identity);
  assert.ok(out.includes('Sample event'), 'pattern view should include sample event');
  assert.ok(out.includes('Template'), 'pattern view should include template');
  assert.ok(out.includes('Recommendation'), 'pattern view should include recommendation');
  assert.ok(out.includes(identity), 'pattern view should echo the identity');
});

test('pattern view 404s gracefully on unknown identity', () => {
  const out = renderPocPattern(input(), 'this_identity_does_not_exist_at_all');
  assert.ok(out.includes('Pattern not found'), 'should return a not-found header');
  assert.ok(out.includes('Top patterns in this snapshot'), 'should list suggestions');
});

test('full view still works (regression)', () => {
  const { markdown, summary } = renderPocReport(input());
  assert.ok(markdown.includes('## 1. Executive Summary'));
  assert.ok(markdown.includes('## 9. Appendix'));
  assert.equal(summary.eventsAnalyzed, 50_000);
  assert.ok(summary.patternsFound > 0);
});

test('heuristic produces readable names without AI sampling', () => {
  // No aiPrettyNames at all — every name must come from the template heuristic.
  const out = renderPocSummary(input());
  // Heartbeat template: "$(ts) INFO heartbeat every $ seconds from $"
  // After stripping $(ts), severity, $ placeholders → "heartbeat every seconds from"
  assert.ok(
    /Heartbeat\s+Every\s+Seconds/.test(out),
    `expected title-cased heartbeat tokens in summary; got:\n${out}`
  );
  // Slow query template: "$(ts) WARN slow query: $ took $ ms"
  assert.ok(/Slow\s+Query/.test(out), `expected title-cased "Slow Query"; got:\n${out}`);
  // None of the raw hashes should leak as the primary display name
  // (they still appear parenthetically as the identity reference).
  assert.ok(!/^\s*\|\s*1\s*\|\s*`h_/.test(out), 'raw identity should not be the leading name');
});

test('heuristic strips literal timestamps baked into templates', () => {
  const i = input();
  // Mutate one template to embed a literal timestamp — simulates a pattern
  // where the templater failed to recognize the timestamp.
  i.extraction.patterns[0].template =
    '2025-10-01T21:25:01.539Z INFO heartbeat every $ seconds from $';
  const out = renderPocSummary(i);
  assert.ok(
    !/2025|10[-\s]01|21:25/.test(out.split('Top')[1] ?? out),
    'literal timestamp tokens must not survive into the pretty name'
  );
  assert.ok(/Heartbeat/.test(out), 'content tokens should still be extracted');
});

test('AI pretty names take priority over heuristic', () => {
  // Identity is derived from toSnakeCase(template, hash) — not the raw hash.
  // For template "$(ts) INFO heartbeat every $ seconds from $" that's
  // "heartbeat_every_seconds_from". We key aiPrettyNames on that.
  const i = {
    ...input(),
    aiPrettyNames: { heartbeat_every_seconds_from: 'Customer Heartbeat' },
  };
  const out = renderPocSummary(i);
  assert.ok(out.includes('Customer Heartbeat'), `AI name should win; got:\n${out}`);
  // And the other patterns still get heuristic names (no AI entry for them).
  assert.ok(
    /Slow\s+Query|Failed\s+To\s+Connect/.test(out),
    'other patterns still get heuristic names'
  );
});
