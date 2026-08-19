/**
 * Coverage for the file/glob local-source sampler (serverless-estate POC path).
 *
 * Asserts:
 *   1. globSegmentsMatch semantics: `*` within a segment, `**` spanning
 *      zero or more segments, literals.
 *   2. sampleFromFiles reads literal files and glob matches, builds the
 *      composition table, and never throws on unmatched patterns.
 *   3. Tail behavior: perFileLimit keeps the LAST lines of a file.
 *   4. Missing paths land in failedSources / notes, not exceptions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { globSegmentsMatch, sampleFromFiles } from '../src/lib/local-source.js';

test('globSegmentsMatch: * stays within a segment', () => {
  assert.equal(globSegmentsMatch(['*.log'], ['app.log']), true);
  assert.equal(globSegmentsMatch(['*.log'], ['nested', 'app.log']), false);
  assert.equal(globSegmentsMatch(['app-?.log'], ['app-1.log']), true);
  assert.equal(globSegmentsMatch(['app-?.log'], ['app-12.log']), false);
});

test('globSegmentsMatch: ** spans zero or more segments', () => {
  assert.equal(globSegmentsMatch(['**', '*.log'], ['app.log']), true);
  assert.equal(globSegmentsMatch(['**', '*.log'], ['a', 'b', 'app.log']), true);
  assert.equal(globSegmentsMatch(['svc', '**'], ['svc', 'x', 'y.txt']), true);
  assert.equal(globSegmentsMatch(['svc', '**'], ['other', 'y.txt']), false);
});

test('sampleFromFiles: literal file + glob + composition + tail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'l10x-files-'));
  try {
    await writeFile(join(dir, 'a.log'), 'a-line-1\na-line-2\n');
    await mkdir(join(dir, 'svc'));
    const manyLines = Array.from({ length: 20 }, (_, i) => `svc-line-${i}`).join('\n') + '\n';
    await writeFile(join(dir, 'svc', 'b.log'), manyLines);
    await writeFile(join(dir, 'svc', 'ignore.txt'), 'not-a-log\n');

    const res = await sampleFromFiles({
      paths: [join(dir, 'a.log'), join(dir, '**', '*.log')],
      perFileLimit: 5,
    });

    // a.log (2 lines) + an even 5-line subsample of svc/b.log (F15: sampling
    // spans the file for representativeness rather than keeping only the tail).
    assert.equal(res.failedSources.length, 0);
    assert.equal(res.composition.length, 2);
    assert.equal(res.events.length, 2 + 5);
    // the subsample spans the file: an early line and a late line are present,
    // not one contiguous end.
    const svcLines = res.events.filter((e) => e.startsWith('svc-line-'));
    const idxs = svcLines.map((e) => Number(e.split('-')[2])).sort((a, b) => a - b);
    assert.equal(idxs.length, 5);
    assert.ok(idxs[0] <= 4, `first sampled index ${idxs[0]} should be near the start`);
    assert.ok(idxs[idxs.length - 1] >= 15, `last sampled index should be near the end`);
    // ignore.txt not matched by *.log
    assert.ok(!res.events.includes('not-a-log'));
    // composition percentages sum to ~100
    const pctSum = res.composition.reduce((s, c) => s + c.pct, 0);
    assert.ok(Math.abs(pctSum - 100) < 0.01);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sampleFromFiles: unmatched glob is a note, missing literal is a failedSource', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'l10x-files-'));
  try {
    const res = await sampleFromFiles({
      paths: [join(dir, 'nothing-*.log'), join(dir, 'does-not-exist.log')],
    });
    assert.equal(res.events.length, 0);
    assert.ok(res.notes.some((n) => n.includes('nothing-*.log')));
    assert.equal(res.failedSources.length, 1);
    assert.ok(res.failedSources[0].includes('does-not-exist.log'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sampleFromFiles: no paths is a note, not a throw', async () => {
  const res = await sampleFromFiles({ paths: [] });
  assert.equal(res.events.length, 0);
  assert.ok(res.notes.length > 0);
});

test('readStridedFileLines: large file is sampled across its length, not just the tail', async () => {
  const { readStridedFileLines } = await import('../src/lib/local-source.js');
  const dir = await mkdtemp(join(tmpdir(), 'l10x-stride-'));
  try {
    // 200k lines, each tagged with its index; the tail-only reader would only
    // ever see the last window, missing the early indices entirely (F15).
    const N = 200_000;
    const lines = Array.from({ length: N }, (_, i) => `line-${i}-${'x'.repeat(40)}`);
    const file = join(dir, 'big.log');
    await writeFile(file, lines.join('\n') + '\n');
    // small byte budget so striding actually kicks in
    const sampled = await readStridedFileLines(file, 4000, 1_000_000);
    assert.ok(sampled.length > 0 && sampled.length <= 4000);
    const idxs = sampled.map((l) => Number(l.split('-')[1])).filter((n) => Number.isFinite(n));
    const min = Math.min(...idxs);
    const max = Math.max(...idxs);
    // coverage spans the file: an early line (< 10% in) and a late line (> 90% in).
    assert.ok(min < N * 0.1, `earliest sampled index ${min} should be in the first 10%`);
    assert.ok(max > N * 0.9, `latest sampled index ${max} should be in the last 10%`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
