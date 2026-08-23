/**
 * Drift guard: does the report claim in-place compaction only where the
 * destination actually compacts in place?
 *
  * `compact` is a no-op on CloudWatch (cost.ts: `compact_mode: 'no-op'`,
  * ratio 1.0), yet an unguarded report opens with "Every line stays
  * queryable in Amazon CloudWatch Logs (compacted in place)" and repeats
  * the claim in three more places, each interpolating the SIEM's own name
  * so the false statement reads as destination-specific. The section that
  * would show a measured compact ratio is conditional, so it is skipped on
  * exactly those runs and the sections number 1,2,3,4,5,7,8,9 around the
  * hole where the evidence should be. The methodology line hedges correctly
  * with "compact in place when the SIEM supports it"; rival notions of the
 * an allowed-actions lookup). These tests read the RENDERED markdown and
 * assert it agrees with cost.ts's `compact_mode`, which is the one source of
 * truth. A fourth notion fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderPocReport } from '../src/lib/poc-report-renderer.js';
import type { RenderInput } from '../src/lib/poc-report-renderer.js';
import type { ExtractedPatterns } from '../src/lib/pattern-extraction.js';
import { getAllowedActionsForDestination, getDestinationCostModel, compactsInPlace, COST_MODEL_BY_DESTINATION } from '../src/lib/cost.js';
import type { SiemId } from '../src/lib/siem/pricing.js';

/** Destinations where `compact` keeps the line queryable in place. */
const COMPACTING: SiemId[] = ['splunk', 'elasticsearch_self' as SiemId, 'clickhouse'];
/**
 * Mechanism real, AVAILABILITY unknown. Encoded events do shrink the _source
 * footprint Elasticsearch bills on, but the expander is the l1es plugin and
 * only a self-managed deployment can install it. Until the customer says
 * which they run, the report must not claim compaction — the claim follows
 * availability, never the mechanism.
 */
const MECHANISM_ONLY: SiemId[] = ['elasticsearch'];
/** Destinations where `compact` is a no-op and the claim would be false. */
const NO_OP: SiemId[] = ['datadog', 'cloudwatch', 'sumo'];

function fixture(): ExtractedPatterns {
  return {
    totalEvents: 50_000,
    totalBytes: 80 * 1024 * 1024,
    inputLineCount: 50_000,
    templaterWallTimeMs: 1200,
    executionMode: 'local_cli',
    severityCoverage: 1,
    positionalBindingExact: true,
    inputLinesSubmitted: 0,
    inputLinesAccountedFor: 0,
    patterns: [
      {
        hash: 'h_info',
        template: '$(ts) INFO heartbeat every $ seconds from $',
        count: 40_000,
        bytes: 60 * 1024 * 1024,
        encodedBytes: 12 * 1024 * 1024,
        severity: 'INFO',
        service: 'checkout-svc',
        sampleEvent: '2026-04-13T10:00:00Z INFO heartbeat every 30 seconds from pod-123',
        variables: { slot_0: ['30'], slot_1: ['pod-123', 'pod-124'] },
      },
      {
        hash: 'h_error',
        template: '$(ts) ERROR $ failed to authenticate user $: $',
        count: 10_000,
        bytes: 20 * 1024 * 1024,
        encodedBytes: 6 * 1024 * 1024,
        severity: 'ERROR',
        service: 'auth-svc',
        sampleEvent: '2026-04-13T10:00:00Z ERROR auth-svc failed to authenticate user u-42: bad token',
        variables: { slot_0: ['auth-svc'], slot_1: ['u-42'], slot_2: ['bad token'] },
      },
    ],
  };
}

function report(siem: SiemId, extraction: ExtractedPatterns = fixture()): string {
  const input: RenderInput = {
    siem,
    window: '7d',
    scope: 'main',
    query: undefined,
    extraction,
    targetEventCount: 100_000,
    pullWallTimeMs: 5_000,
    templateWallTimeMs: 1_200,
    reasonStopped: 'target_reached',
    queryUsed: 'search index=main',
    windowHours: 168,
    analyzerCostPerGb: 2.5,
    snapshotId: 'test-compaction-drift',
    startedAt: '2026-04-19T00:00:00Z',
    finishedAt: '2026-04-19T00:00:05Z',
    mcpVersion: '1.4.0',
  } as RenderInput;
  return renderPocReport(input).markdown;
}

/**
 * Phrases that assert compaction happens. Deliberately matched
 * case-insensitively and without the SIEM name, so a reworded claim that
 * still promises in-place compaction is caught.
 */
const COMPACTION_CLAIMS = [
  /compacted in place/i,
  /compacts the line in place/i,
  /compact in place/i,
];

test('no-op destinations never claim in-place compaction', () => {
  for (const siem of NO_OP) {
    assert.equal(
      compactsInPlace(siem),
      false,
      `fixture assumption: ${siem} should be a compact no-op in cost.ts`,
    );
    const md = report(siem);
    for (const claim of COMPACTION_CLAIMS) {
      assert.ok(
        !claim.test(md),
        `${siem} report asserts in-place compaction (${claim}) but compact_mode is ` +
          `'${getDestinationCostModel(siem).compact_mode}'. The line stays lossless via ` +
          `tier_down or offload; say that instead.`,
      );
    }
  }
});

test('compacting destinations still make the claim', () => {
  for (const siem of COMPACTING) {
    assert.equal(compactsInPlace(siem), true, `fixture assumption: ${siem} compacts in place`);
    const md = report(siem);
    assert.ok(
      COMPACTION_CLAIMS.some((c) => c.test(md)),
      `${siem} compacts in place (compact_mode='${getDestinationCostModel(siem).compact_mode}') ` +
        `but the report never says so. Gating the prose must not silence the true case.`,
    );
  }
});

test('deployment-unknown destinations claim nothing, though the mechanism is real', () => {
  for (const siem of MECHANISM_ONLY) {
    assert.equal(compactsInPlace(siem), true, `fixture assumption: ${siem} has the mechanism`);
    const md = report(siem);
    for (const claim of COMPACTION_CLAIMS) {
      assert.ok(
        !claim.test(md),
        `${siem} claims in-place compaction, but whether the expander can be installed depends on ` +
          `the deployment. Ask, then use elasticsearch_self.`,
      );
    }
    assert.ok(
      !/## \d+\. Compact-byte Ratio \(Measured\)/.test(md),
      `${siem} prints a measured compact ratio it may not be able to deliver`,
    );
  }
});

test('the measured-ratio section is gated by the same predicate as the prose', () => {
  for (const siem of [...COMPACTING, ...NO_OP]) {
    const md = report(siem);
    const hasSection = /## \d+\. Compact-byte Ratio \(Measured\)/.test(md);
    assert.equal(
      hasSection,
      getAllowedActionsForDestination(siem).includes('compact'),
      `${siem}: measured compact-ratio section rendered=${hasSection} but ` +
        `compactsInPlace=${compactsInPlace(siem)}. The section that proves the claim and the ` +
        `prose that makes it must agree.`,
    );
  }
});

test('section numbering has no holes, on every destination', () => {
  for (const siem of [...COMPACTING, ...NO_OP]) {
    const md = report(siem);
    const nums = [...md.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
    assert.ok(nums.length > 0, `${siem}: report rendered no numbered sections`);
    assert.deepEqual(
      nums,
      nums.map((_, i) => i + 1),
      `${siem}: section numbers are ${nums.join(',')}. Conditional sections must not leave a ` +
        `gap — a reader sees the hole and asks what was hidden.`,
    );
  }
});
