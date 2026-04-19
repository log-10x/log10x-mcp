/**
 * Generates docs/poc-sample-report-synthetic.md from a fixed synthetic
 * pattern set — no SIEM credentials required, deterministic output for
 * PR review. Run: `node --experimental-vm-modules scripts/gen-sample-report.mjs`.
 */

import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { renderPocReport } from '../build/lib/poc-report-renderer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');

const extraction = {
  totalEvents: 250_000,
  totalBytes: 125 * 1024 * 1024, // 125 MB
  inputLineCount: 250_000,
  templaterWallTimeMs: 95_000,
  executionMode: 'paste_lambda',
  patterns: [
    {
      hash: 'h_heartbeat',
      template: '$(yyyy-MM-dd\'T\'HH:mm:ss\'Z\') INFO checkout-svc heartbeat pod=$ uptime=$s',
      count: 140_000,
      bytes: 64 * 1024 * 1024,
      severity: 'INFO',
      service: 'checkout-svc',
      sampleEvent: '2026-04-13T10:00:00Z INFO checkout-svc heartbeat pod=checkout-7f9b uptime=124s',
      variables: {
        slot_0: ['checkout-7f9b', 'checkout-9d2a', 'checkout-1c8e'],
        slot_1: ['124', '183', '62'],
      },
    },
    {
      hash: 'h_cache_lookup',
      template: '$(ts) DEBUG cache-svc cache lookup key=$ hit=$',
      count: 48_000,
      bytes: 24 * 1024 * 1024,
      severity: 'DEBUG',
      service: 'cache-svc',
      sampleEvent: '2026-04-13T10:00:00Z DEBUG cache-svc cache lookup key=user:1234 hit=true',
      variables: {
        slot_0: ['user:1234', 'user:5678', 'order:999'],
        slot_1: ['true', 'false'],
      },
    },
    {
      hash: 'h_slow_query',
      template: '$(ts) WARN db-proxy slow query: $ took $ ms (target 500ms)',
      count: 9_200,
      bytes: 15 * 1024 * 1024,
      severity: 'WARN',
      service: 'db-proxy',
      sampleEvent: '2026-04-13T10:00:00Z WARN db-proxy slow query: select * from orders took 1240 ms (target 500ms)',
      variables: {
        slot_0: ['select * from orders', 'insert into payments', 'update carts'],
        slot_1: ['1240', '980', '1820', '650'],
      },
    },
    {
      hash: 'h_request_end',
      template: '$(ts) INFO checkout-svc request end rid=$ status=$ took=$ms',
      count: 35_000,
      bytes: 12 * 1024 * 1024,
      severity: 'INFO',
      service: 'checkout-svc',
      sampleEvent: '2026-04-13T10:00:00Z INFO checkout-svc request end rid=a7f status=200 took=42ms',
      variables: {
        slot_0: ['a7f', '3c2', '9e1'],
        slot_1: ['200', '200', '500', '404'],
        slot_2: ['42', '18', '121'],
      },
    },
    {
      hash: 'h_payment_timeout',
      template: '$(ts) ERROR payments-svc payment_gateway_timeout customer=$ amount=$ provider=$',
      count: 412,
      bytes: 450_000,
      severity: 'ERROR',
      service: 'payments-svc',
      sampleEvent: '2026-04-13T10:00:00Z ERROR payments-svc payment_gateway_timeout customer=acme-corp amount=149.99 provider=stripe',
      variables: {
        slot_0: ['acme-corp', 'globex', 'initech'],
        slot_1: ['149.99', '29.00', '2499.50'],
        slot_2: ['stripe', 'paypal'],
      },
    },
    {
      hash: 'h_conn_refused',
      template: '$(ts) ERROR inventory-svc upstream connection refused host=$ port=$',
      count: 87,
      bytes: 95_000,
      severity: 'ERROR',
      service: 'inventory-svc',
      sampleEvent: '2026-04-13T10:00:00Z ERROR inventory-svc upstream connection refused host=redis-01 port=6379',
      variables: {
        slot_0: ['redis-01', 'redis-02'],
        slot_1: ['6379'],
      },
    },
    {
      hash: 'h_health_ok',
      template: '$(ts) INFO ingress-gw /healthz 200 took=$ms client=$',
      count: 14_500,
      bytes: 6 * 1024 * 1024,
      severity: 'INFO',
      service: 'ingress-gw',
      sampleEvent: '2026-04-13T10:00:00Z INFO ingress-gw /healthz 200 took=3ms client=kube-probe',
      variables: {
        slot_0: ['3', '2', '1'],
        slot_1: ['kube-probe', '10.0.0.1'],
      },
    },
    {
      hash: 'h_auth_expired',
      template: '$(ts) INFO auth-svc token refresh tenant=$ ttl=$s',
      count: 2_600,
      bytes: 1.1 * 1024 * 1024,
      severity: 'INFO',
      service: 'auth-svc',
      sampleEvent: '2026-04-13T10:00:00Z INFO auth-svc token refresh tenant=acme ttl=3600s',
      variables: {
        slot_0: ['acme', 'globex'],
        slot_1: ['3600'],
      },
    },
    {
      hash: 'h_otel_export',
      template: '$(ts) INFO otel-collector exported $ spans batch=$',
      count: 170,
      bytes: 95_000,
      severity: 'INFO',
      service: 'otel-collector',
      sampleEvent: '2026-04-13T10:00:00Z INFO otel-collector exported 500 spans batch=20f',
      variables: {
        slot_0: ['500', '100', '250'],
        slot_1: ['20f', '31a'],
      },
    },
  ],
};

const render = renderPocReport({
  siem: 'splunk',
  window: '7d',
  scope: 'main',
  query: undefined,
  extraction,
  targetEventCount: 250_000,
  pullWallTimeMs: 180_000,
  templateWallTimeMs: 95_000,
  reasonStopped: 'target_reached',
  queryUsed: 'search index=main',
  windowHours: 168,
  analyzerCostPerGb: 6, // Splunk
  snapshotId: 'sample-synthetic-000',
  startedAt: '2026-04-19T00:00:00Z',
  finishedAt: '2026-04-19T00:04:35Z',
  mcpVersion: '1.4.0',
});

const banner = [
  '<!-- SYNTHETIC FIXTURE — numbers below are derived from a deterministic pattern set, NOT a real SIEM pull. -->',
  '<!-- For a real sample, set credentials and run log10x_poc_from_siem_submit against your stack. -->',
  '',
].join('\n');

const outPath = join(repoRoot, 'docs', 'poc-sample-report.md');
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, banner + render.markdown, 'utf8');
console.log(`wrote ${outPath} (${render.markdown.length} bytes)`);
