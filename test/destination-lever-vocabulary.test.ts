/**
 * Destination lever-vocabulary guard.
 *
 * A lever that does not apply to the customer's platform is ABSENT from their
 * plan, not disclaimed in it. A CloudWatch owner does not know what in-place
 * compaction is, does not own Splunk, and gains nothing from being told which
 * lever they are missing: it introduces a term they have no context for and
 * reads as an apology for a limitation they never knew existed.
 *
 * The POC renderer broke that rule in BOTH directions, which is why this guard
 * checks for the WORD rather than for the promise:
 *
 *   - CONFESSION. The recommendation-rules line told every non-compacting
 *     customer "<SIEM> has no in-place compaction, so that lever is not used
 *     here". That introduces a term for a capability they never knew existed
 *     and frames our plan as an apology for it. The comment directly above
 *     that line narrates the earlier version of the same mistake, so the fix
 *     replaced a false promise with a confession and shipped.
 *
 *   - FALSE PROMISE. `losslessClause`'s non-compacting branch offered "moved
 *     to a cheaper retained tier in <SIEM>" on Sumo Logic and GCP Logging,
 *     neither of which has a cheaper tier. The clause was a two-way branch on
 *     `compactsInPlace` modelling a three-lever fact, so every destination
 *     without compaction was assumed to have tiering.
 *
 * Both shapes put a lever in front of a reader whose platform does not have
 * it. Prose review missed both across several rounds, so the check is
 * structural: render the report, then assert no lever name appears in the
 * markdown that is missing from `getAllowedActionsForDestination`.
 *
 * The fixture carries no lever words in its templates, services or sample
 * events, so any match comes from our own prose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAllowedActionsForDestination } from '../src/lib/cost.js';
import {
  renderPocReport,
  renderPocSummary,
  renderPocYaml,
  renderPocConfigs,
  renderPocTop,
  renderPocPattern,
} from '../src/lib/poc-report-renderer.js';
import type { RenderInput } from '../src/lib/poc-report-renderer.js';
import type { ExtractedPatterns } from '../src/lib/pattern-extraction.js';
import type { SiemId } from '../src/lib/siem/pricing.js';

/** Every destination the POC renderer accepts. */
const ALL_SIEMS: SiemId[] = [
  'cloudwatch',
  'datadog',
  'sumo',
  'gcp-logging',
  'elasticsearch',
  'azure-monitor',
  'splunk',
  'clickhouse',
  'coralogix',
  'elastic-serverless',
];

/**
 * How each gated lever surfaces in customer-facing prose.
 *
 * `offload` is deliberately absent: every entry in
 * DEFAULT_ACTION_BY_DESTINATION allows it, so a guard on it can never fire and
 * would read as coverage it does not provide.
 *
 * The tier_down alternates cover the in-platform tier names the renderer
 * reaches for by destination (CloudWatch IA, Datadog Flex, Azure Basic /
 * Auxiliary, Elastic frozen), because naming the tier is the same claim as
 * naming the lever.
 */
const LEVER_VOCABULARY: Record<'compact' | 'tier_down', RegExp> = {
  compact: /\bcompact(?:s|ed|ing|ion)?\b/i,
  tier_down:
    /\btier[ _-]?down\b|\bcheaper (?:retained |in-platform |searchable )?tier\b|\binfrequent access\b|\bflex logs?\b|\bfrozen tier\b|\bauxiliary (?:table|plan|tier)\b/i,
};

/**
 * Patterns with no lever vocabulary anywhere in their own text. A fixture that
 * said "compact" in a template would make every assertion below unfalsifiable.
 */
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
        severity: 'INFO',
        service: 'checkout-svc',
        sampleEvent: '2026-04-13T10:00:00Z INFO heartbeat every 30 seconds from pod-123',
        variables: { slot_0: ['30'], slot_1: ['pod-123', 'pod-124'] },
      },
      {
        hash: 'h_debug',
        template: '$(ts) DEBUG cache lookup for key $ returned $',
        count: 12_000,
        bytes: 14 * 1024 * 1024,
        severity: 'DEBUG',
        service: 'catalog-svc',
        sampleEvent: '2026-04-13T10:00:00Z DEBUG cache lookup for key sku-9 returned hit',
        variables: { slot_0: ['sku-9', 'sku-10'], slot_1: ['hit', 'miss'] },
      },
      {
        hash: 'h_error',
        template: '$(ts) ERROR $ failed to authenticate user $: $',
        count: 8_000,
        bytes: 12 * 1024 * 1024,
        severity: 'ERROR',
        service: 'auth-svc',
        sampleEvent: '2026-04-13T10:00:00Z ERROR auth-svc failed to authenticate user u-42: bad token',
        variables: { slot_0: ['auth-svc'], slot_1: ['u-42'], slot_2: ['bad token'] },
      },
    ],
  };
}

function renderInput(siem: SiemId): RenderInput {
  return {
    siem,
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
    analyzerCostPerGb: 2.5,
    snapshotId: 'test-lever-vocabulary',
    startedAt: '2026-04-19T00:00:00Z',
    finishedAt: '2026-04-19T00:00:05Z',
    mcpVersion: '1.4.0',
  };
}

/** Rendered lines that name `lever`, with 1-based line numbers for the failure message. */
function linesNaming(markdown: string, lever: 'compact' | 'tier_down'): string[] {
  const re = LEVER_VOCABULARY[lever];
  return markdown
    .split('\n')
    .map((text, i) => ({ text, n: i + 1 }))
    .filter(({ text }) => re.test(text))
    .map(({ text, n }) => `  line ${n}: ${text.trim().slice(0, 160)}`);
}

/**
 * Every customer-facing render surface, not just the full report. The summary
 * is what a prospect sees first and the yaml view is what they paste, so
 * checking `renderPocReport` alone would leave the two most-read surfaces
 * unguarded.
 */
const SURFACES: Array<{ name: string; render: (input: RenderInput) => string }> = [
  { name: 'report', render: (i) => renderPocReport(i).markdown },
  { name: 'summary', render: (i) => renderPocSummary(i) },
  { name: 'yaml', render: (i) => renderPocYaml(i) },
  { name: 'configs', render: (i) => renderPocConfigs(i) },
  { name: 'top', render: (i) => renderPocTop(i) },
  { name: 'pattern', render: (i) => renderPocPattern(i, 'h_info') },
];

for (const siem of ALL_SIEMS) {
  const allowed = new Set(getAllowedActionsForDestination(siem));
  const gated = (['compact', 'tier_down'] as const).filter((l) => !allowed.has(l));
  if (gated.length === 0) continue;

  test(`${siem}: no surface names a lever the destination lacks`, () => {
    for (const surface of SURFACES) {
      const md = surface.render(renderInput(siem));
      for (const lever of gated) {
        const hits = linesNaming(md, lever);
        assert.equal(
          hits.length,
          0,
          `${siem} allows [${[...allowed].join(', ')}] but the "${surface.name}" surface names ` +
            `"${lever}" on ${hits.length} line(s). A lever the platform lacks belongs nowhere in ` +
            `the plan, neither as an offer nor as an apology:\n${hits.join('\n')}`,
        );
      }
    }
  });
}

/**
 * Positive control. Without this the suite above passes on a renderer that
 * emits no lever vocabulary at all, which would be a different defect wearing
 * the same green tick.
 */
test('the vocabulary matches where the lever IS allowed', () => {
  const compactHome = renderPocReport(renderInput('clickhouse')).markdown;
  assert.ok(
    LEVER_VOCABULARY.compact.test(compactHome),
    'clickhouse allows compact, so the report should name it; the regex or the renderer is wrong',
  );

  const tierHome = renderPocReport(renderInput('cloudwatch')).markdown;
  assert.ok(
    LEVER_VOCABULARY.tier_down.test(tierHome),
    'cloudwatch allows tier_down, so the report should name it; the regex or the renderer is wrong',
  );
});
