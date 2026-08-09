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

    // a.log (2 lines) + tail-5 of svc/b.log
    assert.equal(res.failedSources.length, 0);
    assert.equal(res.composition.length, 2);
    assert.equal(res.events.length, 2 + 5);
    // tail keeps the LAST lines
    assert.ok(res.events.includes('svc-line-19'));
    assert.ok(!res.events.includes('svc-line-0'));
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
