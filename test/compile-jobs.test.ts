import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, tailLines, parseCompileResults } from '../src/lib/compile-jobs.js';

// ── redactSecrets ────────────────────────────────────────────────────────

test('redactSecrets masks credential values by key, independent of the value', () => {
  const dump = [
    'githubPullToken=ghp_supersecretvalue',
    'dockerPassword: s3cr3t-pw',
    'ARTIFACTORY_TOKEN=art_abc123',
    'apiKey = live_key_999',
    'Authorization: Bearer eyJhbGciOi',
  ].join('\n');
  const out = redactSecrets(dump);
  assert.ok(!out.includes('ghp_supersecretvalue'));
  assert.ok(!out.includes('s3cr3t-pw'));
  assert.ok(!out.includes('art_abc123'));
  assert.ok(!out.includes('live_key_999'));
  assert.ok(!out.includes('eyJhbGciOi'));
  assert.match(out, /githubPullToken=\*\*\*/);
  assert.match(out, /dockerPassword: \*\*\*/);
  assert.match(out, /ARTIFACTORY_TOKEN=\*\*\*/);
  assert.match(out, /Authorization\s*:\s*\*\*\*/);
});

test('redactSecrets leaves non-secret lines untouched', () => {
  const text = 'scanned 1000 files, 18 failed\nmerging into mylib.10x.tar';
  assert.equal(redactSecrets(text), text);
});

// ── tailLines ────────────────────────────────────────────────────────────

test('tailLines returns the last n non-empty lines, trimmed', () => {
  const text = 'a\n\nb   \nc\n\n\nd\n';
  assert.deepEqual(tailLines(text, 2), ['c', 'd']);
  assert.deepEqual(tailLines(text, 10), ['a', 'b', 'c', 'd']);
});

// ── parseCompileResults ──────────────────────────────────────────────────

const RESULTS_DOC = {
  inputPathsSet: ['/src'],
  outputPathsSet: ['/work/symbols/mylib.10x.tar'],
  success: true,
  phases: [
    {
      operation: 'scanToFolder',
      status: 'Completed',
      traversedFiles: 1000,
      scannedFiles: 980,
      outputFiles: 980,
      warns: 12,
      errors: 18,
      scanHealth: {
        filesFailed: 18,
        failedByLanguage: { cpp: 12, cs: 6 },
        failureSamples: [
          { name: 'widget.cpp', language: 'cpp', reason: 'parser errors found in AST, retrying' },
        ],
      },
    },
    {
      operation: 'linkToFile',
      status: 'Completed',
      traversedFiles: 980,
      outputFiles: 1,
      linkReport: {
        mergedFilesSize: 950,
        skippedFilesSize: 30,
        excludedByFolder: 20,
        excludedByFileName: 10,
        mergedRepos: ['repoA'],
        nonMergedRepos: [],
        symbolsByType: { class: 5000, enum: 400, log: 1200, exec: 50 },
        symbolsExcludedByType: 300,
      },
    },
  ],
};

test('parseCompileResults extracts the printResults doc from a noisy console log', () => {
  // The console appender prefixes the opening brace's line, and the engine keeps
  // logging progress AFTER the report — both must not defeat extraction.
  const pretty = JSON.stringify(RESULTS_DOC, null, 2);
  const log = [
    '12:00:01 INFO  Compiler - starting compile',
    '12:30:00 INFO  PipelineScanObserver - ' + pretty,
    '12:30:01 INFO  monitor - flushing metrics',
    '12:30:01 INFO  done',
  ].join('\n');

  const doc = parseCompileResults(log);
  assert.ok(doc, 'expected a parsed results doc');
  assert.equal(doc!.success, true);
  assert.equal(doc!.phases!.length, 2);
  assert.equal(doc!.phases![0].scanHealth!.filesFailed, 18);
  assert.deepEqual(doc!.phases![0].scanHealth!.failedByLanguage, { cpp: 12, cs: 6 });
  assert.equal(doc!.phases![1].linkReport!.symbolsByType.class, 5000);
  assert.equal(doc!.phases![1].linkReport!.mergedFilesSize, 950);
});

test('parseCompileResults returns null when no results block has been printed yet', () => {
  const log = ['12:00:01 INFO starting', '12:01:00 INFO scanned 200 files', 'progress 40%'].join(
    '\n',
  );
  assert.equal(parseCompileResults(log), null);
});

test('parseCompileResults takes the LAST results doc when more than one is present', () => {
  const first = JSON.stringify({ ...RESULTS_DOC, success: false }, null, 2);
  const second = JSON.stringify(RESULTS_DOC, null, 2);
  const log = `INFO - ${first}\nINFO - more\nINFO - ${second}\nINFO - tail`;
  const doc = parseCompileResults(log);
  assert.equal(doc!.success, true);
});

test('parseCompileResults tolerates a brace inside a string value', () => {
  const doc = {
    success: true,
    phases: [{ operation: 'scan', status: 'Completed', note: 'has a } brace in it' }],
  };
  const log = `INFO - ${JSON.stringify(doc, null, 2)}`;
  const parsed = parseCompileResults(log);
  assert.ok(parsed);
  assert.equal(parsed!.phases!.length, 1);
});
