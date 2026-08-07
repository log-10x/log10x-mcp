/**
 * Regenerates the report.html golden fixtures:
 *   test/fixtures/report-golden/basic.data.json
 *   test/fixtures/report-golden/basic.golden.html
 *
 * Deterministic — fixed timestamps, fixed synthetic pattern set (the
 * same shape as test/report-build-data.test.ts). Run after `npm run
 * build`:
 *   node scripts/gen-report-golden.mjs
 *
 * Regenerate ONLY when a template/builder change is intentional; the
 * golden test's failure diff is the review surface.
 */

import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { _enrichForEnvelope } from '../build/lib/poc-report-renderer.js';
import { buildReportData } from '../build/lib/report/build-report-data.js';
import { renderReportHtml } from '../build/lib/report/html-template-v1.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'test', 'fixtures', 'report-golden');

const ERR_TPL_A = [
  'Request failed dial tcp lookup opensearch on $ no such host exporter $',
  'stack github.com/open-telemetry/opentelemetry-collector-contrib/exporter/opensearchexporter logger.go:$',
  'stack github.com/opensearch-project/opensearch-go/v4/opensearchtransport transport.go:$',
  'stack extra frame one',
  'stack extra frame two',
].join('\n');
const ERR_TPL_B =
  'Exporting failed dial tcp lookup opensearch on $ no such host exporter rejecting $';

const patterns = [
  { hash: 'e1', tenxHash: 'qkE1', template: ERR_TPL_A, count: 3000, bytes: 8_000_000, service: 'otelcol', severity: 'ERROR', sampleEvent: 's', variables: {} },
  { hash: 'e2', tenxHash: 'qkE2', template: ERR_TPL_B, count: 3000, bytes: 8_000_000, service: 'otelcol', severity: 'ERROR', sampleEvent: 's', variables: {} },
  { hash: 'i1', tenxHash: 'qkI1', template: 'Logs exported resource logs $ log records $', count: 2958, bytes: 3_000_000, service: 'otelcol', severity: 'INFO', sampleEvent: 's', variables: {} },
  { hash: 'i2', tenxHash: 'qkI2', template: 'cart request handled user $ latency $', count: 900, bytes: 900_000, service: 'cartservice', severity: 'INFO', sampleEvent: 's', variables: {} },
  { hash: 'd1', tenxHash: 'qkD1', template: 'debug heartbeat $', count: 50, bytes: 5_000, service: 'cartservice', severity: 'DEBUG', sampleEvent: 's', variables: {} },
];

const extraction = {
  patterns,
  totalEvents: patterns.reduce((s, p) => s + p.count, 0),
  totalBytes: patterns.reduce((s, p) => s + p.bytes, 0),
  inputLineCount: 100,
  templaterWallTimeMs: 5,
  executionMode: 'local_cli',
  engineBuild: 'tenx golden',
  severityCoverage: 1,
  positionalBindingExact: true,
  inputLinesSubmitted: 100,
  inputLinesAccountedFor: 100,
};

const input = {
  siem: 'cloudwatch',
  window: '1h',
  extraction,
  targetEventCount: extraction.totalEvents,
  pullWallTimeMs: 10,
  templateWallTimeMs: 5,
  reasonStopped: 'source_exhausted',
  queryUsed: 'golden',
  windowHours: 1,
  analyzerCostPerGb: 0.55,
  snapshotId: 'golden',
  startedAt: '2026-08-07T00:00:00.000Z',
  finishedAt: '2026-08-07T01:00:00.000Z',
  mcpVersion: '0.0.0-golden',
};

const enriched = _enrichForEnvelope(input);
const { data } = buildReportData(
  input,
  { patterns: enriched.patterns, clusters: enriched.clusters },
  {
    siem: 'cloudwatch',
    siemLabel: 'CloudWatch',
    forwarder: 'fluentd',
    install: 'k8s',
    namespace: 'demo',
    workload: 'tenx-fluentd',
    annotations: { qkI1: 'Collector self-telemetry, confirmed with the platform team.' },
    generatedAtIso: '2026-08-07T01:00:00.000Z',
    mcpVersion: '0.0.0-golden',
  },
);

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'basic.data.json'), JSON.stringify(data, null, 2) + '\n');
await writeFile(join(outDir, 'basic.golden.html'), renderReportHtml(data));
console.log(`wrote ${join(outDir, 'basic.data.json')} and basic.golden.html`);
