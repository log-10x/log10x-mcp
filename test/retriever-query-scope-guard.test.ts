/**
 * Unscoped-query guard.
 *
 * The engine's IndexQueryWriter rejects a blank search:
 *
 *   could not launch pipeline: 'run'  /  search cannot be blank
 *   error initializing pipeline unit #7: 'streamOutput(IndexQueryWriter)'
 *
 * That failure arrives ~12s in, before any worker runs, so no _DONE marker is
 * ever written. The caller then waited out the marker timeout (380s measured
 * against the demo environment) and reported NO_MARKER with a diagnostic blaming
 * a stale S3 index and the index-inducer CronJob. The index was current to
 * within four minutes.
 *
 * Two things went wrong and both are pinned here: the tool advertised an
 * unscoped full-window scan the engine cannot serve, and `doctor` hardcoded
 * `search: ''` into its own health probe, so the product told every user their
 * index was stale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assertScopedQuery, UNSCOPED_QUERY_PREFIX } from '../src/tools/retriever-query.js';

/**
 * Read a file from the package's `src/`, regardless of where the test runs from.
 *
 * `npm test` compiles into `test-build/` and runs `node --test
 * test-build/test/*.js`, so a path relative to `import.meta.url` resolves to
 * `test-build/src/...` and the .ts source is not there. Resolving from the
 * package root works under both that layout and a direct `tsx --test` run
 * against `test/`.
 */
function readSource(relPath: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src'))) {
      return readFileSync(join(dir, relPath), 'utf8');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the package root from ${resolve(process.cwd())}`);
}

test('a query with no scope at all is rejected', () => {
  assert.throws(() => assertScopedQuery({}), (err: Error) => {
    assert.ok(
      err.message.startsWith(UNSCOPED_QUERY_PREFIX),
      'must carry the schema_invalid marker prefix so it is not retried as a backend fault'
    );
    return true;
  });
});

test('the rejection names the three ways to scope, not just one', () => {
  try {
    assertScopedQuery({});
    assert.fail('expected a throw');
  } catch (err) {
    const msg = (err as Error).message;
    for (const field of ['search', 'pattern', 'pattern_hash']) {
      assert.ok(msg.includes(field), `remediation must mention \`${field}\``);
    }
  }
});

test('blank and whitespace-only scopes do not count as scoped', () => {
  // `search: ''` is what doctor shipped. It reads as "provided" to a truthiness
  // check on some paths, so the guard tests emptiness explicitly.
  for (const args of [
    { search: '' },
    { search: '   ' },
    { pattern: '' },
    { pattern_hash: '' },
    { pattern_hash: '  ' },
  ]) {
    assert.throws(
      () => assertScopedQuery(args),
      new RegExp(UNSCOPED_QUERY_PREFIX),
      `${JSON.stringify(args)} must be treated as unscoped`
    );
  }
});

test('any one real scope is sufficient', () => {
  assertScopedQuery({ search: 'severity_level=="ERROR"' });
  assertScopedQuery({ pattern: 'Payment_Gateway_Timeout' });
  assertScopedQuery({ pattern_hash: 'FU1__vh8hbY' });
});

test('doctor does not probe the retriever with a blank search', () => {
  // Source-level assertion on purpose. The failure mode is a literal `search: ''`
  // in the probe call, it costs 380s per doctor run, and it is the kind of thing
  // that gets reintroduced by someone simplifying the call site.
  const src = readSource('src/tools/doctor.ts');
  // Window the assertion around the probe call, including the lines just above it
  // where the search expression is bound to a local.
  const callAt = src.indexOf('runRetrieverQuery(env, {');
  assert.ok(callAt > 0, 'expected to find the doctor retriever probe');
  const probeRegion = src.slice(Math.max(0, callAt - 1500), callAt + 500);

  assert.ok(
    !/search:\s*''/.test(probeRegion) && !/search:\s*""/.test(probeRegion),
    "doctor's retriever probe must not pass a blank search: the engine rejects it, " +
      'the probe then burns the full marker timeout and reports a false "index is stale"'
  );
  assert.ok(
    /severity_level==/.test(probeRegion),
    'the probe should scope on severity_level, which the Reporter stamps on every ' +
      'event regardless of source format'
  );
});

test('doctor no longer asserts a stale index as the sole explanation', () => {
  const src = readSource('src/tools/doctor.ts');
  const idx = src.indexOf('retriever_overflow_health');
  assert.ok(idx > 0, 'expected the retriever_overflow_health check');
  const region = src.slice(idx, idx + 4000);

  assert.ok(
    !/This may indicate the S3 index is stale/.test(region),
    'a quiet window is the common case and must not be reported as a stale index'
  );
});
