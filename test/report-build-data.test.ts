import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _enrichForEnvelope, type RenderInput } from '../src/lib/poc-report-renderer.js';
import {
  buildReportData,
  ReportRefusal,
  windowLabel,
  type BuildReportOptions,
} from '../src/lib/report/build-report-data.js';
import type { ExtractedPattern, ExtractedPatterns } from '../src/lib/pattern-extraction.js';

const ERR_TPL_A = [
  'Request failed dial tcp lookup opensearch on $ no such host exporter $',
  'stack github.com/open-telemetry/opentelemetry-collector-contrib/exporter/opensearchexporter logger.go:$',
  'stack github.com/opensearch-project/opensearch-go/v4/opensearchtransport transport.go:$',
  'stack extra frame one',
  'stack extra frame two',
].join('\n');
const ERR_TPL_B =
  'Exporting failed dial tcp lookup opensearch on $ no such host exporter rejecting $';

function pattern(over: Partial<ExtractedPattern> & Pick<ExtractedPattern, 'hash' | 'template' | 'count' | 'bytes'>): ExtractedPattern {
  return {
    sampleEvent: 'sample',
    variables: {},
    ...over,
  };
}

function extraction(patterns: ExtractedPattern[], severityCoverage: number): ExtractedPatterns {
  return {
    patterns,
    totalEvents: patterns.reduce((s, p) => s + p.count, 0),
    totalBytes: patterns.reduce((s, p) => s + p.bytes, 0),
    inputLineCount: 100,
    templaterWallTimeMs: 5,
    executionMode: 'local_cli',
    engineBuild: 'tenx test',
    severityCoverage,
    positionalBindingExact: true,
    inputLinesSubmitted: 100,
    inputLinesAccountedFor: 100,
  };
}

function renderInput(ext: ExtractedPatterns): RenderInput {
  return {
    siem: 'cloudwatch',
    window: '1h',
    extraction: ext,
    targetEventCount: ext.totalEvents,
    pullWallTimeMs: 10,
    templateWallTimeMs: 5,
    reasonStopped: 'source_exhausted',
    queryUsed: 'test',
    windowHours: 1,
    analyzerCostPerGb: 0.55,
    snapshotId: 'test',
    startedAt: '2026-08-07T00:00:00.000Z',
    finishedAt: '2026-08-07T01:00:00.000Z',
    mcpVersion: '0.0.0-test',
  };
}

const OPTS: BuildReportOptions = {
  siem: 'cloudwatch',
  siemLabel: 'CloudWatch',
  forwarder: 'fluentd',
  install: 'k8s',
  namespace: 'demo',
  workload: 'tenx-fluentd',
  generatedAtIso: '2026-08-07T01:00:00.000Z',
  mcpVersion: '0.0.0-test',
};

function standardPatterns(): ExtractedPattern[] {
  return [
    pattern({ hash: 'e1', tenxHash: 'qkE1', template: ERR_TPL_A, count: 3000, bytes: 8_000_000, service: 'otelcol', severity: 'ERROR' }),
    pattern({ hash: 'e2', tenxHash: 'qkE2', template: ERR_TPL_B, count: 3000, bytes: 8_000_000, service: 'otelcol', severity: 'ERROR' }),
    pattern({ hash: 'i1', tenxHash: 'qkI1', template: 'Logs exported resource logs $ log records $', count: 2958, bytes: 3_000_000, service: 'otelcol', severity: 'INFO' }),
    pattern({ hash: 'i2', tenxHash: 'qkI2', template: 'cart request handled user $ latency $', count: 900, bytes: 900_000, service: 'cartservice', severity: 'INFO' }),
    pattern({ hash: 'd1', tenxHash: 'qkD1', template: 'debug heartbeat $', count: 50, bytes: 5_000, service: 'cartservice', severity: 'DEBUG' }),
  ];
}

function build(severityCoverage = 1, opts: Partial<BuildReportOptions> = {}) {
  const ext = extraction(standardPatterns(), severityCoverage);
  const input = renderInput(ext);
  const enriched = _enrichForEnvelope(input);
  return buildReportData(input, { patterns: enriched.patterns, clusters: enriched.clusters }, { ...OPTS, ...opts });
}

test('volume action: reducible statements only, container-keyed change rows in the engine grammar', () => {
  const { data, capsCsv, actionsCsv } = build();
  const tier = data.actions.find((a) => a.kind === 'tier_down');
  assert.ok(tier, 'expected a tier_down action');
  // impact counts INFO/DEBUG bytes only — never the ERROR family
  assert.ok(tier!.impactBytes! <= 3_900_005);
  assert.ok(tier!.impactBytes! >= 3_000_000);
  // rows are `<container>,<bytes>::<reason>`: the grammar the engine reads,
  // the empty middle field being the expiry slot; the action is never in
  // this file. No per-pattern `pat:` rows, no head_only, no placeholder key.
  for (const row of tier!.change!.rows) {
    assert.match(row, /^[^,<>]+,\d+::[^,:]+$/);
    assert.ok(!row.includes('head_only'));
    assert.ok(!row.startsWith('pat:'));
  }
  // the reason column is the service's sentence in user units, commas and colons removed
  const otelRow = tier!.change!.rows.find((r) => r.startsWith('otelcol,'))!;
  assert.match(otelRow, /::otelcol any statement above 72000 lines a day goes to Infrequent Access\. Today that is this one statement about \$[\d.]+ a month\.$/);
  // THE CHANGE reads in lines a day and dollars a month. A limit sits between the
  // largest statement the container keeps and the smallest it moves, at their
  // geometric mean: cartservice keeps its heartbeat (5,000 bytes, 1,200 lines a
  // day) and moves 900,000 bytes, a margin of sqrt(180) = 13.4 each side, so
  // 1,200 x 13.4 = 16,100 lines a day. otelcol moves a statement smaller than
  // the ERROR one it keeps (3,000 lines an hour), so nothing separates them and
  // its limit stays at the kept one. Then the margins, the fleet line and the
  // always-pass sample.
  const lines = tier!.change!.commentLines;
  assert.match(lines[0], /^cartservice: any statement above 16,100 lines a day goes to Infrequent Access\. Today that is this one statement, about \$[\d.]+ a month\.$/);
  assert.match(lines[1], /^otelcol: any statement above 72,000 lines a day goes to Infrequent Access\. Today that is this one statement, about \$[\d.]+ a month\.$/);
  assert.equal(lines[2], 'cartservice: the largest kept statement can grow 13.4x before it is held; the smallest moved one is 13.4x above the limit.');
  assert.equal(
    lines[3],
    'otelcol: no limit separates the statements, because the smallest one moved is no busier than the largest one kept; the limit stays at the largest kept statement, and a moved statement under it stays in Standard.',
  );
  assert.equal(lines[4], 'Any service not listed keeps every statement in Standard. Up to 1,800 lines a day of every statement always reach Standard on each node.');
  for (const l of [...lines, tier!.change!.engineGapNote!]) {
    assert.ok(!/240|regulator|severity floor|bytes per window/i.test(l), `engine units leaked into a user line: ${l}`);
  }
  assert.ok(tier!.change!.engineGapNote!.includes('per container'));
  // caps.csv mirrors the change rows; actions.csv names the same containers
  assert.ok(capsCsv!.startsWith('container,cap\n'));
  for (const row of tier!.change!.rows) assert.ok(capsCsv!.includes(row));
  assert.ok(actionsCsv!.startsWith('container,action\n'));
  for (const row of tier!.change!.rows) {
    const container = row.split(',')[0];
    assert.ok(actionsCsv!.includes(`${container},tier_down::`), `${container} missing from actions.csv`);
  }
  // the cap sits between the largest pattern the container keeps and the smallest it moves
  assert.ok(tier!.change!.commentLines.join(' ').includes('between the largest statement the container keeps and the smallest it moves'));
  // verified commands resolved from the matrix cell: both files into the
  // ConfigMap the engine reads
  const cmds = tier!.apply!.commands.join('\n');
  assert.ok(cmds.includes('kubectl -n demo'));
  assert.ok(cmds.includes('log10x-action-intent'));
  assert.ok(cmds.includes('--from-file=caps.csv=') && cmds.includes('--from-file=actions.csv='));
});

test('dominant ERROR cluster becomes an operational action, never a volume action', () => {
  const { data } = build();
  const op = data.actions.find((a) => a.kind === 'operational');
  assert.ok(op, 'expected an operational action from the dominant cluster');
  assert.equal(op!.impactBytes, undefined);
  assert.ok(op!.check, 'dns-like cluster tokens should attach a check block');
  // verdict names the failure share
  assert.match(data.verdict.headline, /\d+% of this window/);
  // protected events counted and kept
  assert.equal(data.kept.protectedEvents, 6000);
});

test('severity gate: below the floor, no volume action and an honest verdict', () => {
  const { data, capsCsv } = build(0.2);
  assert.equal(data.actions.filter((a) => a.kind !== 'operational').length, 0);
  assert.equal(capsCsv, null);
  assert.equal(data.kept.protectedEvents, null);
  const sevCheck = data.verify.find((c) => c.id === 'severity_attribution');
  assert.equal(sevCheck!.state, 'warn');
});

test('unknown forwarder: commands honestly unavailable, plan still renders', () => {
  const { data } = build(1, { forwarder: null });
  const tier = data.actions.find((a) => a.kind === 'tier_down');
  assert.ok(tier);
  assert.equal(tier!.apply!.commands.length, 0);
  assert.ok(tier!.apply!.unavailableNote!.includes('advise_install'));
});

test('annotations: over-cap refuses, unknown hash refuses, valid attaches', () => {
  assert.throws(() => build(1, { annotations: { qkI1: 'x'.repeat(141) } }), ReportRefusal);
  assert.throws(() => build(1, { annotations: { nope: 'hello' } }), ReportRefusal);
  const { data } = build(1, { annotations: { qkI1: 'Collector self-telemetry, confirmed with the platform team.' } });
  const tier = data.actions.find((a) => a.kind === 'tier_down');
  assert.equal(tier!.annotation, 'Collector self-telemetry, confirmed with the platform team.');
});

test('verify panel: tier delivery is an honest not_configured with an upsell arrow', () => {
  const { data } = build();
  const tierIdx = data.actions.findIndex((a) => a.kind === 'tier_down');
  const chk = data.verify.find((c) => c.id === 'tier_delivery');
  assert.equal(chk!.state, 'not_configured');
  assert.equal(chk!.enabledByAction, tierIdx + 1);
  const doctor = data.verify.find((c) => c.id === 'doctor');
  assert.equal(doctor!.state, 'not_run');
});

test('windowLabel wording', () => {
  assert.equal(windowLabel(1), 'one hour');
  assert.equal(windowLabel(24), '24 hours');
  assert.equal(windowLabel(0.5), '30 minutes');
  assert.equal(windowLabel(6), '6 hours');
  // A file source has no time window — the label must not fabricate an hour count.
  assert.equal(windowLabel(1, 'file'), 'this log sample');
  assert.equal(windowLabel(6, 'file'), 'this log sample');
});

test('tier_down says the lines stay in the SIEM on its cheaper tier, never in a bucket', () => {
  for (const [siem, label, short, stays] of [
    ['datadog', 'Datadog', 'Flex Logs', 'stay searchable in Datadog'],
    ['cloudwatch', 'CloudWatch', 'Infrequent Access', 'stay in CloudWatch Logs'],
  ] as const) {
    const { data } = build(1, { siem, siemLabel: label });
    const tier = data.actions.find((a) => a.kind === 'tier_down');
    assert.ok(tier, `${siem}: expected a tier_down action`);
    assert.match(tier!.title, new RegExp(`to ${short}$`));
    assert.match(tier!.note!, new RegExp(stays));
    const text = JSON.stringify(data);
    assert.doesNotMatch(text, /own bucket|retrievable on demand|retrievable tier/, `${siem}: tier_down described as offload`);
  }
});

function planFor(destination: 'cloudwatch' | 'datadog', target: Record<string, unknown>, retrieverInstalled = false) {
  return import('../src/lib/plan-solver.js').then(({ solvePlan }) =>
    solvePlan(
      standardPatterns().map((p) => ({
        hash: p.tenxHash ?? p.hash,
        name: p.template,
        services: { [p.service ?? 'svc']: p.bytes },
        severity: p.severity ?? 'INFO',
        bytes: p.bytes,
      })),
      { destination, retrieverInstalled, ...target } as never,
    ),
  );
}

test('with a solved plan, the report states the plan\'s share on its basis and reconciles its statements', async () => {
  const { renderReportHtml } = await import('../src/lib/report/html-template-v1.js');
  const plan = await planFor('cloudwatch', { targetPct: 30 });
  const { data } = build(1, { plan, planSpanSeconds: 3600 });
  assert.equal(data.totals.planPct, plan.achievedPct);
  assert.equal(data.totals.planBasis, 'bill');
  const noCluster = { ...data, achievable: undefined };
  const h1 = /<h1>(.*?)<\/h1>/s.exec(renderReportHtml(noCluster))![1];
  assert.match(h1, new RegExp(`${Math.round(plan.achievedPct)}% off the bill$`));
});

test('a GB budget plan says less volume, never off the bill', async () => {
  const { renderReportHtml } = await import('../src/lib/report/html-template-v1.js');
  const plan = await planFor('cloudwatch', { target: { kind: 'gb_budget', value: 0.001 } });
  const { data } = build(1, { plan, planSpanSeconds: 3600 });
  assert.equal(data.totals.planBasis, 'bytes');
  const h1 = /<h1>(.*?)<\/h1>/s.exec(renderReportHtml({ ...data, achievable: undefined }))![1];
  assert.doesNotMatch(h1, /off the bill/);
});

test('an offload plan names the bucket; a tier_down plan keeps the lines in the SIEM', async () => {
  const offload = await planFor('cloudwatch', { targetPct: 60 }, true);
  const offloads = offload.planned.some((r) => r.action === 'offload');
  const { data } = build(1, { plan: offload, planSpanSeconds: 3600 });
  const tier = data.actions.find((a) => a.kind === 'tier_down');
  assert.ok(tier);
  if (offloads) assert.match(tier!.note!, /own bucket/);
  const tierOnly = await planFor('cloudwatch', { targetPct: 30 });
  const t2 = build(1, { plan: tierOnly, planSpanSeconds: 3600 }).data.actions.find((a) => a.kind === 'tier_down');
  if (tierOnly.planned.every((r) => r.action === 'pass' || r.action === 'tier_down')) assert.doesNotMatch(t2!.note!, /bucket/);
});

test('with too little severity attribution, a plan adds no volume action', async () => {
  const plan = await planFor('cloudwatch', { targetPct: 30 });
  const { data } = build(0, { plan, planSpanSeconds: 3600 });
  assert.equal(data.actions.filter((a) => a.kind === 'tier_down').length, 0);
});

test('the report title carries no em dash', async () => {
  const { renderReportHtml } = await import('../src/lib/report/html-template-v1.js');
  const { data } = build();
  const title = /<title>(.*?)<\/title>/s.exec(renderReportHtml(data))![1];
  assert.doesNotMatch(title, /&mdash;|—/);
});

test('a plan that moves nothing prints no reconciling sentence', async () => {
  const plan = await planFor('cloudwatch', { target: { kind: 'gb_budget', value: 1000 } });
  assert.equal(plan.planned.filter((r) => r.action !== 'pass').length, 0);
  const { data } = build(1, { plan, planSpanSeconds: 3600 });
  const tier = data.actions.find((a) => a.kind === 'tier_down');
  if (tier) assert.doesNotMatch(tier.note!, /whole plan/);
});
