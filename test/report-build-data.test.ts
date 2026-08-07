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

test('volume action: reducible statements only, container-keyed change rows in the configure_engine grammar', () => {
  const { data, capsCsv } = build();
  const tier = data.actions.find((a) => a.kind === 'tier_down');
  assert.ok(tier, 'expected a tier_down action');
  // impact counts INFO/DEBUG bytes only — never the ERROR family
  assert.ok(tier!.impactBytes! <= 3_900_005);
  assert.ok(tier!.impactBytes! >= 3_000_000);
  // rows are `<container>,<cap>:<action>:<reason>` — the grammar the
  // engine truly consumes; no per-pattern `pat:` rows, no head_only
  for (const row of tier!.change!.rows) {
    assert.match(row, /^[^,]+,\d+:tier_down:MCP poc_from_local soft$/);
    assert.ok(!row.includes('head_only'));
    assert.ok(!row.startsWith('pat:'));
  }
  assert.ok(tier!.change!.engineGapNote!.includes('per container'));
  // caps.csv mirrors the change rows
  assert.ok(capsCsv!.startsWith('container,cap\n'));
  for (const row of tier!.change!.rows) assert.ok(capsCsv!.includes(row));
  // verified commands resolved from the matrix cell
  assert.ok(tier!.apply!.commands.join('\n').includes('kubectl -n demo'));
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
});
