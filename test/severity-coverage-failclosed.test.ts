/**
 * The ERROR safety rail has to fail CLOSED when severity attribution is
 * missing.
 *
 * `isReducibleSeverity(undefined)` returns true, which is right per-pattern:
 * one unlabelled INFO line should not veto a recommendation. In aggregate it
 * fails OPEN. On the 2026-08-02 POC dry run the engine ran without its
 * aggregator stage, severity coverage was 0%, every pattern took the "no
 * severity" branch, and three ERROR patterns (`Order parsing failed`,
 * `DbUpdateException`, `base_exporter Exporting failed`) were queued for
 * reduction. Nothing in the report said severity was missing.
 *
 * These tests pin the aggregate behaviour: below the coverage floor the
 * recommender refuses and says why, and above it nothing changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderPocReport, _enrichForEnvelope } from '../src/lib/poc-report-renderer.js';
import type { RenderInput } from '../src/lib/poc-report-renderer.js';
import type { ExtractedPatterns } from '../src/lib/pattern-extraction.js';
import {
  MIN_SEVERITY_COVERAGE,
  severityAttributionSufficient,
} from '../src/lib/severity-policy.js';

function fixture(coverage: number, withSeverity: boolean): ExtractedPatterns {
  return {
    totalEvents: 50_000,
    totalBytes: 80 * 1024 * 1024,
    inputLineCount: 50_000,
    templaterWallTimeMs: 1200,
    executionMode: 'local_cli',
    severityCoverage: coverage,
    patterns: [
      {
        // High-volume, well over the 1% reducible threshold. With severity
        // present this is the canonical reduce candidate.
        hash: 'h_info',
        template: '$(ts) INFO heartbeat every $ seconds from $',
        count: 40_000,
        bytes: 60 * 1024 * 1024,
        severity: withSeverity ? 'INFO' : undefined,
        service: 'checkout-svc',
        sampleEvent: '2026-04-13T10:00:00Z INFO heartbeat every 30 seconds from pod-123',
        variables: { slot_0: ['30'] },
      },
      {
        // The pattern the whole defect is about: an ERROR stream that must
        // never be reduced. When severity is missing it is indistinguishable
        // from the INFO row above.
        hash: 'h_error',
        template: '$(ts) ERROR $ failed to authenticate user $: $',
        count: 10_000,
        bytes: 20 * 1024 * 1024,
        severity: withSeverity ? 'ERROR' : undefined,
        service: 'auth-svc',
        sampleEvent: '2026-04-13T10:00:00Z ERROR auth-svc failed to authenticate user u-42: bad token',
        variables: { slot_0: ['auth-svc'] },
      },
    ],
  };
}

function input(extraction: ExtractedPatterns): RenderInput {
  return {
    siem: 'cloudwatch',
    window: '7d',
    scope: '/aws/main',
    query: undefined,
    extraction,
    targetEventCount: 100_000,
    pullWallTimeMs: 5_000,
    templateWallTimeMs: 1_200,
    reasonStopped: 'target_reached',
    queryUsed: '',
    windowHours: 168,
    analyzerCostPerGb: 2.5,
    snapshotId: 'test-failclosed',
    startedAt: '2026-04-19T00:00:00Z',
    finishedAt: '2026-04-19T00:00:05Z',
    mcpVersion: '1.4.0',
  } as RenderInput;
}

test('the floor is a real threshold, not a zero check', () => {
  assert.ok(MIN_SEVERITY_COVERAGE > 0 && MIN_SEVERITY_COVERAGE <= 1);
  assert.equal(severityAttributionSufficient(0), false);
  assert.equal(severityAttributionSufficient(undefined), false);
  assert.equal(severityAttributionSufficient(MIN_SEVERITY_COVERAGE), true);
  assert.equal(severityAttributionSufficient(MIN_SEVERITY_COVERAGE - 0.01), false);
});

test('zero severity coverage recommends nothing', () => {
  const { patterns } = _enrichForEnvelope(input(fixture(0, false)));
  for (const p of patterns) {
    assert.equal(
      p.recommendedAction,
      'keep',
      `pattern ${p.hash} got action '${p.recommendedAction}' with 0% severity coverage. With no severity ` +
        `the ERROR rail cannot fire, so no lever may be recommended.`,
    );
  }
});

test('the degraded report says why, in the customer-facing prose', () => {
  const md = renderPocReport(input(fixture(0, false))).markdown;
  assert.match(
    md,
    /No recommendations in this report/i,
    'a report that withholds its levers must say so, not just render empty',
  );
  assert.match(md, /severity/i);
  // It must not simultaneously promise savings it is not recommending.
  assert.ok(
    !/Projected annual savings by ingest volume/.test(md),
    'the savings projection must be withheld alongside the recommendations',
  );
});

test('full severity coverage is unaffected', () => {
  const { patterns } = _enrichForEnvelope(input(fixture(1, true)));
  const byHash = new Map(patterns.map((p) => [p.hash, p] as const));
  assert.equal(
    byHash.get('h_error')?.recommendedAction,
    'keep',
    'ERROR patterns stay kept verbatim',
  );
  assert.notEqual(
    byHash.get('h_info')?.recommendedAction,
    'keep',
    'a high-volume INFO pattern should still get a lever when severity is known',
  );
  const md = renderPocReport(input(fixture(1, true))).markdown;
  assert.ok(!/No recommendations in this report/i.test(md));
});
