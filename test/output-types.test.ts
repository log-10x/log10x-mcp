import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StructuredOutputSchema,
  SCHEMA_VERSION,
  SCHEMA_EPOCH,
  buildEnvelope,
  buildMarkdownEnvelope,
  isStructuredOutput,
} from '../src/lib/output-types.js';

test('buildEnvelope produces a schema-valid envelope', () => {
  const env = buildEnvelope({
    tool: 'log10x_top_patterns',
    view: 'summary',
    summary: { headline: 'Top 5 patterns total $4,820/mo' },
    data: { patterns: [] },
  });
  const parsed = StructuredOutputSchema.parse(env);
  assert.equal(parsed.schema_version, SCHEMA_VERSION);
  assert.equal(parsed.schema_epoch, SCHEMA_EPOCH);
  assert.equal(parsed.tool, 'log10x_top_patterns');
  assert.equal(parsed.view, 'summary');
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.actions, []);
});

test('buildMarkdownEnvelope places rendered markdown under data.markdown', () => {
  const env = buildMarkdownEnvelope({
    tool: 'log10x_top_patterns',
    summary: { headline: 'short hed' },
    markdown: '# Some report\n\nblah',
  });
  const parsed = StructuredOutputSchema.parse(env);
  assert.equal(parsed.view, 'markdown');
  assert.equal((parsed.data as { markdown: string }).markdown, '# Some report\n\nblah');
});

test('isStructuredOutput discriminates structured vs string returns', () => {
  const env = buildEnvelope({
    tool: 't',
    view: 'summary',
    summary: { headline: 'h' },
    data: {},
  });
  assert.equal(isStructuredOutput(env), true);
  assert.equal(isStructuredOutput('plain markdown string'), false);
  assert.equal(isStructuredOutput(null), false);
  assert.equal(isStructuredOutput({ random: 'object' }), false);
});

test('StructuredOutputSchema rejects missing required fields', () => {
  assert.throws(
    () =>
      StructuredOutputSchema.parse({
        schema_version: SCHEMA_VERSION,
        schema_epoch: SCHEMA_EPOCH,
        tool: 'x',
        // missing generated_at, view, summary, data
      }),
    /generated_at|view|summary|data/i
  );
});

test('StructuredOutputSchema rejects wrong schema_version', () => {
  assert.throws(
    () =>
      StructuredOutputSchema.parse({
        schema_version: '0.9',
        schema_epoch: SCHEMA_EPOCH,
        tool: 'x',
        generated_at: new Date().toISOString(),
        view: 'summary',
        summary: { headline: 'h' },
        data: {},
        actions: [],
        warnings: [],
      }),
    /1\.0|literal/i
  );
});

test('envelope round-trips through JSON.stringify / JSON.parse', () => {
  const env = buildEnvelope({
    tool: 'log10x_find_skew',
    view: 'summary',
    summary: { headline: '1 finding', bullets: ['slot 3: verb=get 78%'] },
    data: { findings: [{ slot: 3, dominant: 'get', pct: 0.78 }] },
    actions: [
      {
        tool: 'log10x_pattern_mitigate',
        args: { pattern: 'p1' },
        reason: 'sample the dominant case',
      },
    ],
    render_hint: { chart: 'bar', units: '%' },
  });
  const restored = StructuredOutputSchema.parse(JSON.parse(JSON.stringify(env)));
  assert.equal(restored.summary.headline, '1 finding');
  assert.equal(restored.actions[0]!.tool, 'log10x_pattern_mitigate');
  assert.equal(restored.render_hint!.chart, 'bar');
});
