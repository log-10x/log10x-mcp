/**
 * Hosted demo (mcp.log10x.com) end-to-end fixes, 2026-11-13.
 *
 * A scripted pass over all 36 demo tools (build 1.30.101) found 14 wrong
 * answers, 15 errors and one 203 s hang. These tests pin the fixes that do
 * not need a backend: input aliases, engine heap, the exposed-tool registry,
 * the demo-unavailable line, the demo instructions, product_qa's answer text
 * and identity routing, and the engine pin in the demo image.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { coerceEnumValue, durationMinutes, makeShapeCoercive } from '../src/lib/input-coerce.js';
import { engineHeapArgs } from '../src/lib/dev-cli.js';
import {
  setExposedTools,
  resetExposedToolsForTest,
  isToolExposed,
  stripStartRouting,
  filterExposedActions,
} from '../src/lib/exposed-tools.js';
import { demoUnavailableLine, demoUnavailableEnvelope } from '../src/lib/demo-unavailable.js';
import { DEMO_SERVER_INSTRUCTIONS } from '../src/lib/demo-instructions.js';
import { flattenMarkdown } from '../src/tools/product-qa.js';
import { EDGE_MANIFEST_IMAGE } from '../src/lib/runtime-image.js';
import { clientInfoFields } from '../src/lib/client-info.js';

function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src'))) return readFileSync(join(dir, rel), 'utf8');
    dir = dirname(dir);
  }
  throw new Error(`repo root not found from ${process.cwd()}`);
}

const SAVED_ENV = { ...process.env };
afterEach(() => {
  resetExposedToolsForTest();
  process.env = { ...SAVED_ENV };
});

test('a time window an enum does not list maps to the listed one of equal length', () => {
  const days = ['1d', '7d', '30d'];
  assert.equal(coerceEnumValue('24h', days), '1d');
  assert.equal(coerceEnumValue('1w', days), '7d');
  assert.equal(coerceEnumValue('168h', days), '7d');
  assert.equal(coerceEnumValue('7D', days), '7d');
  assert.equal(coerceEnumValue('2d', days), '2d'); // no equal option: the enum reports it
  assert.equal(coerceEnumValue('Summary', ['summary', 'markdown']), 'summary');
  assert.equal(durationMinutes('90m'), 90);
  assert.equal(durationMinutes('soon'), null);
});

test('whats_changing and pattern_diff accept "24h" through the registration coercer', () => {
  const shape = makeShapeCoercive({ timeRange: z.enum(['1d', '7d', '30d']).default('7d') });
  assert.deepEqual(z.object(shape).parse({ timeRange: '24h' }), { timeRange: '1d' });
  // The advertised schema is unchanged.
  assert.deepEqual((z.toJSONSchema(z.object(shape)) as { properties: Record<string, { enum?: string[] }> }).properties.timeRange.enum, ['1d', '7d', '30d']);
});

test('the engine heap is passed as -Xmx only for a plain size', () => {
  delete process.env.LOG10X_TENX_MAX_HEAP;
  assert.deepEqual(engineHeapArgs(), []);
  process.env.LOG10X_TENX_MAX_HEAP = '256m';
  assert.deepEqual(engineHeapArgs(), ['-Xmx256m']);
  process.env.LOG10X_TENX_MAX_HEAP = '256m -XX:+Evil';
  assert.deepEqual(engineHeapArgs(), []);
});

test('descriptions and actions never name a tool the server does not register', () => {
  const desc = '[FRESH-SESSION ROUTING: if this is the first cost question, call log10x_start first.] Rank services by cost.';
  assert.equal(stripStartRouting(desc), desc); // registry unset: unchanged
  setExposedTools(['log10x_services', 'log10x_top_patterns']);
  assert.equal(isToolExposed('log10x_start'), false);
  assert.equal(stripStartRouting(desc), 'Rank services by cost.');
  assert.deepEqual(
    filterExposedActions([{ tool: 'log10x_top_patterns' }, { tool: 'log10x_configure_engine' }, { reason: 'no tool' }]),
    [{ tool: 'log10x_top_patterns' }, { reason: 'no tool' }],
  );
});

test('tools the demo cannot serve say so in one line, only in the demo playground', () => {
  delete process.env.LOG10X_MCP_DEMO_PLAYGROUND;
  assert.equal(demoUnavailableEnvelope('log10x_datadog_spike_audit'), null);
  process.env.LOG10X_MCP_DEMO_PLAYGROUND = '1';
  const env = demoUnavailableEnvelope('log10x_datadog_spike_audit');
  assert.ok(env);
  assert.match(env!.summary.headline, /^Not available in the hosted demo/);
  assert.doesNotMatch(env!.summary.headline, /DD_API_KEY|set /);
  assert.equal(demoUnavailableEnvelope('log10x_services'), null);
  assert.equal(demoUnavailableLine('log10x_top_patterns'), null);
});

// The demo's tool set: manifest categories the demo enables, write tools off
// (backend terraform/public-demo-mcp: LOG10X_MCP_ENABLED_CATEGORIES,
// LOG10X_MCP_DISABLE_WRITE). verify-demo-mcp.py derives the same set.
function demoToolSet(): Set<string> {
  const manifest = JSON.parse(repoFile('default-manifest.json')) as {
    tools: Record<string, { category?: string; annotations?: { readOnlyHint?: boolean } }> | Array<{ name: string; category?: string; annotations?: { readOnlyHint?: boolean } }>;
  };
  const entries = Array.isArray(manifest.tools)
    ? manifest.tools.map((t) => [t.name, t] as const)
    : Object.entries(manifest.tools);
  const enabled = new Set(['cost', 'investigate', 'identify', 'drop', 'detect', 'retrieve']);
  return new Set(
    entries
      .filter(([, t]) => enabled.has((t.category ?? '').toLowerCase()) && t.annotations?.readOnlyHint !== false)
      .map(([n]) => n),
  );
}

test('the demo instructions name only tools the demo registers, and are short', () => {
  const demo = demoToolSet();
  const named = new Set(DEMO_SERVER_INSTRUCTIONS.match(/log10x_[a-z_]+/g) ?? []);
  assert.ok(named.size > 5);
  for (const n of named) assert.ok(demo.has(n), `${n} is named in the demo instructions but not registered on the demo`);
  assert.ok(DEMO_SERVER_INSTRUCTIONS.length < 4000, `${DEMO_SERVER_INSTRUCTIONS.length} chars`);
  assert.doesNotMatch(DEMO_SERVER_INSTRUCTIONS, /log10x_start|poc_from_local/);
});

test('every tool on the demo-unavailable list is a demo tool', () => {
  const demo = demoToolSet();
  for (const n of [
    'log10x_datadog_change_report', 'log10x_datadog_spike_audit', 'log10x_clickhouse_census',
    'log10x_customer_metrics_query', 'log10x_discover_join', 'log10x_metrics_that_moved',
    'log10x_rank_by_shape_similarity', 'log10x_metric_overlay', 'log10x_commitment_report',
    'log10x_retriever_probe', 'log10x_find_skew',
  ]) {
    assert.ok(demo.has(n), n);
    assert.ok(demoUnavailableLine(n), n);
  }
});

test('a FAQ admonition never becomes the answer text', () => {
  const chunk = [
    '??? tenx-compat "What log forwarders does log10x support"',
    '',
    '    **All major log forwarders are supported.**',
    '',
    '    - [Fluent Bit](https://doc.log10x.com/run/input/forwarder/fluentbit/){target="_blank"} / Fluentd',
  ].join('\n');
  const flat = flattenMarkdown(chunk);
  assert.doesNotMatch(flat, /\?\?\?|tenx-compat|\{target|\*\*/);
  assert.match(flat, /^All major log forwarders are supported\. Fluent Bit \/ Fluentd$/);
});

test('the demo image runs the engine the MCP pins', () => {
  const dockerfile = repoFile('Dockerfile');
  const m = dockerfile.match(/^ARG ENGINE_IMAGE=(\S+)$/m);
  assert.ok(m, 'Dockerfile has no ENGINE_IMAGE arg');
  assert.equal(m![1], EDGE_MANIFEST_IMAGE);
  assert.match(dockerfile, /LOG10X_TENX_MODE=local/);
  assert.match(dockerfile, /LOG10X_TENX_MAX_HEAP=\d+m/);
});

test('session-open logs only the client name and version, each at most 64 characters', () => {
  const body = {
    method: 'initialize',
    params: {
      clientInfo: { name: 'claude-code', version: '2.1.322', title: 'Claude Code', websiteUrl: 'https://x', icons: [{}] },
      capabilities: { roots: {} },
    },
  };
  assert.deepEqual(clientInfoFields(body), { client_name: 'claude-code', client_version: '2.1.322' });
  assert.deepEqual(clientInfoFields({ params: { clientInfo: { name: 'x'.repeat(200) } } }), { client_name: 'x'.repeat(64) });
  assert.deepEqual(clientInfoFields({ params: { clientInfo: { name: 7, version: null } } }), {});
  assert.deepEqual(clientInfoFields({ params: {} }), {});
  assert.deepEqual(clientInfoFields(null), {});
});
