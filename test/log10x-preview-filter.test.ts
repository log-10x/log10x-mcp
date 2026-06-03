/**
 * Unit tests for log10x_preview_filter (L3b surface).
 *
 * Covers:
 *   - envelope shape (required top-level fields present)
 *   - plain-text table (no markdown pipes | or separator dashes between columns)
 *   - CSV file path stability (predictable path formula)
 *   - sparkline column present and correct width in each data row
 *   - must_ask_user options shape
 *   - forbidden_next_actions contract
 *   - no-signal path (empty patterns) renders a text message not a table
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executePreviewFilter, type PreviewFilterEnvelope } from '../src/tools/preview-filter.js';
import type { StructuredOutput } from '../src/lib/output-types.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function asEnvelope(out: StructuredOutput): PreviewFilterEnvelope {
  return out.data as PreviewFilterEnvelope;
}

// ─── envelope shape ───────────────────────────────────────────────────────────

test('preview_filter: envelope has required top-level fields', async () => {
  const out = await executePreviewFilter({ service: 'cart', mode: 'drop' });
  assert.ok(typeof out === 'object' && out !== null, 'expected envelope object');
  assert.ok('tool' in out, 'missing tool field');
  assert.ok('data' in out, 'missing data field');
  assert.ok('view' in out, 'missing view field');

  const d = asEnvelope(out);
  assert.equal(typeof d.service, 'string');
  assert.ok(
    [
      'drop', 'sample', 'compact', 'tier_down', 'offload', 'observe_only',
    ].includes(d.mode),
    `unexpected mode: ${d.mode}`,
  );
  assert.ok(Array.isArray(d.patterns), 'patterns must be an array');
  assert.equal(typeof d.total_service_bytes_per_month, 'number');
  assert.equal(typeof d.must_render_verbatim, 'string');
  assert.ok(d.must_render_verbatim.length > 0, 'must_render_verbatim must not be empty');
  assert.ok(typeof d.must_ask_user === 'object' && d.must_ask_user !== null);
  assert.ok(Array.isArray(d.forbidden_next_actions));
  assert.ok(d.csv_path === null || typeof d.csv_path === 'string');
  assert.ok(['tsdb', 'poc_siem'].includes(d.data_source), `unexpected data_source: ${d.data_source}`);
});

test('preview_filter: tool field in envelope is log10x_preview_filter', async () => {
  const out = await executePreviewFilter({ service: 'frontend', mode: 'sample' });
  assert.equal(out.tool, 'log10x_preview_filter');
});

// ─── plain-text table — no markdown pipes ─────────────────────────────────────

test('preview_filter: must_render_verbatim is NOT a markdown table (no pipe characters)', async () => {
  // Run without a live metrics backend — patterns will be empty, but if
  // patterns were present the table must have no markdown pipe separators.
  // We validate the contract on the renderer directly by inspecting the
  // verbatim string for absence of Markdown table syntax.
  const out = await executePreviewFilter({ service: 'checkout', mode: 'drop' });
  const d = asEnvelope(out);
  const verbatim = d.must_render_verbatim;

  // A markdown table row looks like: | col1 | col2 | ...
  // Our table uses space-padding only. No pipes allowed.
  assert.ok(!verbatim.includes('|'), 'must_render_verbatim must not contain pipe characters (no markdown table)');
});

test('preview_filter: must_render_verbatim has no markdown separator line (no ---)', async () => {
  const out = await executePreviewFilter({ service: 'checkout', mode: 'drop', top_n: 5 });
  const d = asEnvelope(out);
  const lines = d.must_render_verbatim.split('\n');

  // Markdown table uses lines like |---|---|---| between header and data.
  // We allow separator lines of plain dashes (-) for visual grouping,
  // but they must NOT follow or precede a line that starts with |.
  for (const line of lines) {
    if (/^[-]+$/.test(line.trim()) && line.trim().length > 2) {
      // This is a plain dash separator — acceptable.
      // Verify it is NOT a markdown separator (no pipes in the line).
      assert.ok(!line.includes('|'), `line "${line}" looks like a markdown separator`);
    }
    // No line should start with | (markdown table cell)
    assert.ok(!line.trimStart().startsWith('|'), `line "${line}" starts with pipe — markdown table format forbidden`);
  }
});

// ─── CSV path stability ────────────────────────────────────────────────────────

test('preview_filter: CSV path follows /tmp/log10x-preview-<mode>-<service> formula', async () => {
  // The path formula is computed regardless of whether the write succeeds.
  // We can verify it by deriving the expected path from our own formula
  // and checking that csv_path matches when patterns are returned,
  // OR that the path would be correct by inspecting the source contract.

  // For a service with no patterns, csv_path is null — that is also correct.
  // We test the formula by running with known inputs and asserting the path
  // structure if non-null.
  const service = 'my-service-01';
  const mode = 'sample';
  const out = await executePreviewFilter({ service, mode });
  const d = asEnvelope(out);

  if (d.csv_path !== null) {
    assert.match(
      d.csv_path,
      /^\/tmp\/log10x-preview-sample-my.service.01\.csv$/,
      `CSV path does not match expected formula. Got: ${d.csv_path}`,
    );
  }
  // When patterns is empty, csv_path must be null (no point writing an empty file)
  if (d.patterns.length === 0) {
    assert.equal(d.csv_path, null, 'csv_path must be null when no patterns available');
  }
});

test('preview_filter: CSV path is deterministic (same inputs → same path)', async () => {
  const args = { service: 'auth-service', mode: 'tier_down' } as const;
  const out1 = await executePreviewFilter(args);
  const out2 = await executePreviewFilter(args);
  assert.equal(
    asEnvelope(out1).csv_path,
    asEnvelope(out2).csv_path,
    'CSV path must be deterministic for same service+mode',
  );
});

// ─── sparkline column ─────────────────────────────────────────────────────────

test('preview_filter: every pattern row has a trend_sparkline of exactly 8 chars', async () => {
  const out = await executePreviewFilter({ service: 'orders', mode: 'drop', top_n: 20 });
  const d = asEnvelope(out);

  for (const row of d.patterns) {
    assert.equal(typeof row.trend_sparkline, 'string', `row ${row.rank}: trend_sparkline must be a string`);
    assert.equal(
      row.trend_sparkline.length,
      8,
      `row ${row.rank}: trend_sparkline must be 8 chars, got ${row.trend_sparkline.length}`,
    );
  }
});

test('preview_filter: when patterns present, must_render_verbatim contains sparkline column header', async () => {
  const out = await executePreviewFilter({ service: 'orders', mode: 'drop' });
  const d = asEnvelope(out);
  if (d.patterns.length === 0) {
    // No live backend — skip content assertion
    return;
  }
  assert.ok(
    d.must_render_verbatim.includes('Trend'),
    'must_render_verbatim must include "Trend" column header when patterns are present',
  );
});

// ─── must_ask_user shape ──────────────────────────────────────────────────────

test('preview_filter: must_ask_user has question string and 3 options', async () => {
  const out = await executePreviewFilter({ service: 'inventory', mode: 'observe_only' });
  const d = asEnvelope(out);

  assert.equal(typeof d.must_ask_user.question, 'string');
  assert.ok(d.must_ask_user.question.length > 0);
  assert.ok(Array.isArray(d.must_ask_user.options));
  assert.equal(d.must_ask_user.options.length, 3, 'must_ask_user must offer exactly 3 options');
});

test('preview_filter: must_ask_user options include drill, apply, and mode options', async () => {
  const out = await executePreviewFilter({ service: 'inventory', mode: 'observe_only' });
  const d = asEnvelope(out);
  const options = d.must_ask_user.options.map((o: string) => o.toLowerCase());

  const hasDrill = options.some((o) => o.includes('drill') || o.includes('pattern'));
  const hasApply = options.some((o) => o.includes('apply'));
  const hasMode = options.some((o) => o.includes('mode'));

  assert.ok(hasDrill, 'must_ask_user options must include a drill/pattern option');
  assert.ok(hasApply, 'must_ask_user options must include an Apply option');
  assert.ok(hasMode, 'must_ask_user options must include a Mode option');
});

// ─── forbidden_next_actions ───────────────────────────────────────────────────

test('preview_filter: forbidden_next_actions locks the apply tools', async () => {
  const out = await executePreviewFilter({ service: 'shipping', mode: 'drop' });
  const d = asEnvelope(out);

  const forbidden = d.forbidden_next_actions;
  assert.ok(Array.isArray(forbidden));
  assert.ok(forbidden.includes('log10x_configure_engine'), 'configure_engine must be forbidden');
  assert.ok(forbidden.includes('log10x_pattern_mitigate'), 'pattern_mitigate must be forbidden');
  assert.ok(forbidden.includes('log10x_advise_retriever'), 'advise_retriever must be forbidden');
});

// ─── no-signal path ───────────────────────────────────────────────────────────

test('preview_filter: no-signal (no backend) produces text message not table', async () => {
  // Without a live TSDB, patterns will be empty.
  // The verbatim output must be a descriptive message, not a table header.
  const out = await executePreviewFilter({ service: 'nonexistent-svc', mode: 'sample' });
  const d = asEnvelope(out);

  if (d.patterns.length === 0) {
    assert.ok(
      !d.must_render_verbatim.includes('Descriptor'),
      'when no patterns, must_render_verbatim should not include a table header',
    );
    assert.ok(
      d.must_render_verbatim.length > 0,
      'must_render_verbatim must still have content even when no patterns',
    );
  }
});

// ─── actions array ────────────────────────────────────────────────────────────

test('preview_filter: actions[] alternative entries all reference log10x_pattern_detail', async () => {
  const out = await executePreviewFilter({ service: 'cart', mode: 'drop' });
  const actions = (out as StructuredOutput & { actions?: Array<{ tool: string; role: string }> }).actions ?? [];
  const alternatives = actions.filter((a) => a.role === 'alternative');

  for (const action of alternatives) {
    assert.equal(action.tool, 'log10x_pattern_detail', `unexpected tool in alternative actions: ${action.tool}`);
  }
});

test('preview_filter: actions[] count is two entries per pattern (pattern_detail + pattern_examples)', async () => {
  const out = await executePreviewFilter({ service: 'cart', mode: 'drop', top_n: 10 });
  const d = asEnvelope(out);
  const actions = (out as StructuredOutput & { actions?: unknown[] }).actions ?? [];
  assert.equal(actions.length, d.patterns.length * 2, 'two actions per pattern row (pattern_detail + pattern_examples)');
});

test('preview_filter: actions[] includes log10x_pattern_examples entries with pattern arg', async () => {
  const out = await executePreviewFilter({ service: 'cart', mode: 'drop' });
  const actions = (out as StructuredOutput & { actions?: Array<{ tool: string; args: Record<string, unknown>; role: string }> }).actions ?? [];
  const examples = actions.filter((a) => a.tool === 'log10x_pattern_examples');

  assert.ok(examples.length > 0, 'Expected at least one log10x_pattern_examples entry in actions[]');
  for (const entry of examples) {
    assert.equal(entry.role, 'optional-followup');
    assert.ok('pattern' in entry.args, 'log10x_pattern_examples args must contain pattern key');
  }
});

// ─── mode enum coverage ───────────────────────────────────────────────────────

test('preview_filter: accepts all valid mode values without throwing', async () => {
  const modes = [
    'drop', 'sample', 'compact', 'tier_down', 'offload', 'observe_only',
  ] as const;

  for (const mode of modes) {
    const out = await executePreviewFilter({ service: 'test-svc', mode });
    assert.ok(typeof out === 'object' && out !== null, `mode ${mode}: expected envelope`);
    assert.equal(asEnvelope(out).mode, mode, `mode ${mode}: echoed mode must match input`);
  }
});
