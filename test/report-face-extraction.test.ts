import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentLine, buildFace, MAX_FACE_LINES } from '../src/lib/report/face-extraction.js';
import type { ExtractedPattern } from '../src/lib/pattern-extraction.js';

function pattern(overrides: Partial<ExtractedPattern>): ExtractedPattern {
  return {
    hash: 'tpl123',
    template: 'Request failed $',
    count: 10,
    bytes: 1000,
    sampleEvent: 'Request failed x',
    variables: {},
    ...overrides,
  };
}

test('segmentLine: bare $ becomes a val chip', () => {
  const segs = segmentLine('user $ logged in');
  assert.deepEqual(segs, [
    { t: 'text', s: 'user ' },
    { t: 'val' },
    { t: 'text', s: ' logged in' },
  ]);
});

test('segmentLine: typed slot keeps its format hint as text after the chip', () => {
  const segs = segmentLine("$(yyyy-MM-dd) done");
  assert.deepEqual(segs, [
    { t: 'val' },
    { t: 'text', s: '(yyyy-MM-dd)' },
    { t: 'text', s: ' done' },
  ]);
});

test('segmentLine: tabs become tab segments', () => {
  const segs = segmentLine('a\tb');
  assert.deepEqual(segs, [
    { t: 'text', s: 'a' },
    { t: 'tab' },
    { t: 'text', s: 'b' },
  ]);
});

test('buildFace: no intra-line truncation, ever — a very long line survives whole', () => {
  const long = 'x'.repeat(5000) + ' $ ' + 'y'.repeat(5000);
  const f = buildFace(pattern({ template: long }));
  const text = f.lines[0].segs
    .map((s) => (s.t === 'text' ? s.s : s.t === 'val' ? '$' : '\t'))
    .join('');
  assert.equal(text, long);
  assert.ok(!text.includes('…'));
});

test('buildFace: welded lines beyond the cap elide by COUNT', () => {
  const template = ['head $', 'stack line 1', 'stack line 2', 'stack line 3', 'stack line 4'].join('\n');
  const f = buildFace(pattern({ template }));
  assert.equal(f.lines.length, MAX_FACE_LINES);
  assert.equal(f.elidedLineCount, 5 - MAX_FACE_LINES);
  assert.equal(f.lines[0].cont, false);
  assert.equal(f.lines[1].cont, true);
});

test('buildFace: hash prefers tenxHash (the query key) over templateHash', () => {
  const f = buildFace(pattern({ tenxHash: 'qk_abc' }));
  assert.equal(f.hash, 'qk_abc');
  const f2 = buildFace(pattern({}));
  assert.equal(f2.hash, 'tpl123');
});

test('buildFace: bytesEach is window arithmetic', () => {
  const f = buildFace(pattern({ count: 4, bytes: 1000 }));
  assert.equal(f.bytesEach, 250);
});

test('buildFace: opaque template falls back to the readable sample line (F10)', () => {
  // The engine occasionally emits a symbol-code body a prospect cannot read
  // ("-.ExmX.eKQs"). The deliverable must show the real log line instead.
  const f = buildFace(
    pattern({
      template: '-.ExmX.eKQs',
      sampleEvent: 'oteldemo.AdService no baggage found in context trace_id=abc',
    }),
  );
  const rendered = f.lines.map((l) => l.segs.map((seg) => (seg.t === 'text' ? seg.s : seg.t === 'val' ? '$' : '\t')).join('')).join('\n');
  assert.ok(
    /no baggage found in context/.test(rendered),
    `expected the sample line, got: ${rendered}`,
  );
  assert.ok(!/ExmX/.test(rendered), 'opaque template must not render');
});

test('buildFace: a readable template is NOT replaced by the sample', () => {
  // CamelCase words and space-separated phrases are readable; keep the
  // abstracted template (with $ markers) rather than the concrete sample.
  const f = buildFace(
    pattern({
      template: 'GetCartAsync called with userId=$',
      sampleEvent: 'GetCartAsync called with userId=1557e8a2',
    }),
  );
  const rendered = f.lines.map((l) => l.segs.map((seg) => (seg.t === 'text' ? seg.s : seg.t === 'val' ? '$' : '\t')).join('')).join('\n');
  assert.ok(/userId=/.test(rendered));
  assert.ok(/\$/.test(rendered), 'the $ marker from the template should survive');
});
