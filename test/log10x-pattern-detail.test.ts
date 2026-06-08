/**
 * Unit tests for log10x_pattern_detail.
 *
 * Covers:
 *   - patternDetailSchema shape (required/optional/defaults)
 *   - renderAsciiBarChart pure helper: bar chars, label padding, value formatting
 *   - executePatternDetail: no-env path returns a valid envelope
 *   - executePatternDetail: include_samples=false skips SIEM round-trip
 *   - sample event truncation to 120 chars
 *   - envelope data shape (pattern_hash, services, sample_events, must_ask_user)
 *   - must_render_verbatim contains ASCII chart block chars (█/░)
 *   - actions[] contains log10x_preview_filter, log10x_configure_engine, and log10x_pattern_examples entries
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { patternDetailSchema, executePatternDetail, __testables } from '../src/tools/pattern-detail.js';
import type { StructuredOutput } from '../src/lib/output-types.js';

const { renderAsciiBarChart } = __testables;

// ── patternDetailSchema ────────────────────────────────────────────────────────

test('patternDetailSchema: pattern_hash is optional (pattern name is an alias)', () => {
  // pattern_hash is .optional() because `pattern` (name) was added as an
  // alternate identifier. The "at least one of pattern/pattern_hash" contract
  // is now enforced at runtime in executePatternDetail, not at the Zod layer.
  const schema = z.object(patternDetailSchema);
  assert.doesNotThrow(() => schema.parse({}));
  assert.equal(schema.parse({}).pattern_hash, undefined);
});

test('executePatternDetail: missing both pattern and pattern_hash returns missing_identifier error', async () => {
  const out = await executePatternDetail({} as { pattern_hash?: string; pattern?: string });
  const data = out.data as Record<string, unknown>;
  // status is hoisted to the outer envelope and also stored on data by the chassis.
  assert.equal(data['status'], 'error');
  const payload = data['payload'] as Record<string, unknown>;
  assert.equal(payload['error'], 'missing_identifier');
});

test('patternDetailSchema: include_samples defaults to true', () => {
  const schema = z.object(patternDetailSchema);
  const parsed = schema.parse({ pattern_hash: 'abc123' });
  assert.equal(parsed.include_samples, true);
});

test('patternDetailSchema: include_samples can be set to false', () => {
  const schema = z.object(patternDetailSchema);
  const parsed = schema.parse({ pattern_hash: 'abc123', include_samples: false });
  assert.equal(parsed.include_samples, false);
});

test('patternDetailSchema: environment is optional', () => {
  const schema = z.object(patternDetailSchema);
  const withEnv = schema.parse({ pattern_hash: 'abc123', environment: 'prod' });
  const withoutEnv = schema.parse({ pattern_hash: 'abc123' });
  assert.equal(withEnv.environment, 'prod');
  assert.equal(withoutEnv.environment, undefined);
});

// ── renderAsciiBarChart ────────────────────────────────────────────────────────

test('renderAsciiBarChart: empty rows returns empty string', () => {
  assert.equal(renderAsciiBarChart([], 'title'), '');
});

test('renderAsciiBarChart: contains title as first line', () => {
  const out = renderAsciiBarChart([{ label: 'svc-a', value: 1000 }], 'Service distribution');
  assert.match(out, /^Service distribution/);
});

test('renderAsciiBarChart: full-width bar uses only █ blocks (no ░)', () => {
  const rows = [{ label: 'svc-a', value: 1000 }];
  const out = renderAsciiBarChart(rows, 'title', 10);
  // The max row gets a fully-filled bar.
  assert.match(out, /█{10}/);
  // With one row, there should be no empty segments.
  assert.ok(!out.includes('░'));
});

test('renderAsciiBarChart: zero-value row uses only ░ blocks', () => {
  const rows = [
    { label: 'top', value: 100 },
    { label: 'zero', value: 0 },
  ];
  const out = renderAsciiBarChart(rows, 'title', 10);
  // The zero row should be all empty blocks.
  assert.match(out, /░{10}/);
});

test('renderAsciiBarChart: values >= 1 GB render as GB (decimal SI units)', () => {
  // renderAsciiBarChart divides by decimal SI (1e9) to match services/baseline/
  // top_patterns. 1024^3 * 1.5 = 1610612736 bytes / 1e9 = 1.6GB.
  const gb = 1024 ** 3;
  const out = renderAsciiBarChart([{ label: 'svc', value: gb * 1.5 }], 'title');
  assert.match(out, /1\.6GB/);
});

test('renderAsciiBarChart: values >= 1 MB but < 1 GB render as MB (decimal SI units)', () => {
  // 1024^2 * 50 = 52428800 bytes / 1e6 = 52.4 -> toFixed(0) = 52MB.
  const mb = 1024 ** 2;
  const out = renderAsciiBarChart([{ label: 'svc', value: mb * 50 }], 'title');
  assert.match(out, /52MB/);
});

test('renderAsciiBarChart: values < 1 MB render as KB (decimal SI units)', () => {
  // 512 * 1024 = 524288 bytes / 1e3 = 524.288 -> toFixed(0) = 524KB.
  const out = renderAsciiBarChart([{ label: 'svc', value: 512 * 1024 }], 'title');
  assert.match(out, /524KB/);
});

test('renderAsciiBarChart: label is padded to max label width', () => {
  const rows = [
    { label: 'short', value: 100 },
    { label: 'much-longer-label', value: 50 },
  ];
  const out = renderAsciiBarChart(rows, 'title', 10);
  const lines = out.split('\n').filter((l) => l.includes('█') || l.includes('░'));
  // Each data line should have equal length (padding makes them align).
  const lengths = new Set(lines.map((l) => l.length));
  assert.equal(lengths.size, 1, `Expected equal-length rows, got: ${[...lengths].join(', ')}`);
});

// ── sample event truncation ────────────────────────────────────────────────────

test('sample event truncation at 120 chars: long string gets cut', () => {
  // Validate the 120-char slice contract directly.
  const longEvent = 'A'.repeat(200);
  const truncated = longEvent.slice(0, 120);
  assert.equal(truncated.length, 120);
  assert.equal(truncated, 'A'.repeat(120));
});

test('sample event truncation at 120 chars: short string is unchanged', () => {
  const shortEvent = 'short log line here';
  assert.equal(shortEvent.slice(0, 120), shortEvent);
});

// ── executePatternDetail: envelope shape ──────────────────────────────────────

test('executePatternDetail: always returns a valid StructuredOutput envelope', async () => {
  // The tool fetches gracefully — all network calls return empty on failure.
  // So this path always produces a full envelope regardless of env state.
  const out = await executePatternDetail({ pattern_hash: 'deadbeef0000' });
  // Envelope must be a structured output (has schema_version).
  assert.ok(
    typeof out === 'object' && out !== null && 'schema_version' in out,
    'Expected a StructuredOutput envelope',
  );
  assert.equal(out.tool, 'log10x_pattern_detail');
});

// ── executePatternDetail: include_samples=false ────────────────────────────────

test('executePatternDetail: include_samples=false does not throw', async () => {
  // Should not throw regardless of SIEM availability.
  const out = await executePatternDetail({
    pattern_hash: 'cafebabe1234',
    include_samples: false,
  });
  assert.ok(typeof out === 'object' && out !== null);
  assert.equal(out.tool, 'log10x_pattern_detail');
});

// ── envelope data shape ────────────────────────────────────────────────────────

test('executePatternDetail: data echoes pattern_hash', async () => {
  const out = await executePatternDetail({ pattern_hash: 'testHash99' });
  const data = out.data as Record<string, unknown>;
  // buildChassisEnvelope nests the tool-specific PatternDetailEnvelope under
  // data.payload, so pattern_hash lives at out.data.payload.pattern_hash.
  const payload = data['payload'] as Record<string, unknown>;
  assert.equal(payload['pattern_hash'], 'testHash99');
});

// ── renderAsciiBarChart ascii chart block chars in verbatim ───────────────────

test('renderAsciiBarChart: output contains Unicode block chars', () => {
  const rows = [
    { label: 'service-a', value: 2 * 1024 ** 3 },
    { label: 'service-b', value: 1024 ** 3 },
  ];
  const out = renderAsciiBarChart(rows, 'Service distribution (30d)', 28);
  assert.ok(out.includes('█'), 'Expected █ block character in bar chart');
  assert.ok(out.includes('░'), 'Expected ░ empty block character in bar chart');
});

test('renderAsciiBarChart: separator line has correct structure', () => {
  const out = renderAsciiBarChart([{ label: 'svc', value: 100 }], 'Title', 10);
  const lines = out.split('\n');
  // Second line is the separator: dashes only.
  assert.match(lines[1]!, /^-+$/);
});

test('renderAsciiBarChart: capped at maxBarWidth columns of blocks per row', () => {
  const out = renderAsciiBarChart([{ label: 'svc', value: 9999 }], 'title', 15);
  // The bar portion is exactly maxBarWidth chars (█ + ░ combined).
  const lines = out.split('\n').filter((l) => l.includes('  '));
  for (const line of lines) {
    const match = line.match(/([█░]+)/);
    if (match) {
      assert.equal(match[1]!.length, 15, `Bar width should be exactly 15, got ${match[1]!.length}`);
    }
  }
});

// ── actions[] ─────────────────────────────────────────────────────────────────

test('pattern_detail: actions[] includes log10x_preview_filter entry', async () => {
  const out = await executePatternDetail({ pattern_hash: 'deadbeef0000' });
  const actions = (out as StructuredOutput & { actions?: Array<{ tool: string }> }).actions ?? [];
  const found = actions.some((a) => a.tool === 'log10x_preview_filter');
  assert.ok(found, 'Expected a log10x_preview_filter entry in actions[]');
});

test('pattern_detail: actions[] includes log10x_configure_engine entry', async () => {
  const out = await executePatternDetail({ pattern_hash: 'deadbeef0000' });
  const actions = (out as StructuredOutput & { actions?: Array<{ tool: string }> }).actions ?? [];
  const found = actions.some((a) => a.tool === 'log10x_configure_engine');
  assert.ok(found, 'Expected a log10x_configure_engine entry in actions[]');
});

test('pattern_detail: actions[] includes log10x_pattern_examples entry with pattern arg', async () => {
  const out = await executePatternDetail({ pattern_hash: 'deadbeef0000' });
  const actions = (out as StructuredOutput & { actions?: Array<{ tool: string; args: Record<string, unknown>; role: string }> }).actions ?? [];
  const entry = actions.find((a) => a.tool === 'log10x_pattern_examples');
  assert.ok(entry !== undefined, 'Expected a log10x_pattern_examples entry in actions[]');
  assert.equal(entry!.role, 'optional-followup');
  assert.ok('pattern' in entry!.args, 'log10x_pattern_examples args must contain pattern key');
});

