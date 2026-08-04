/**
 * Image selection for the two engine flavors.
 *
 * The gate these tests defend: `LOG10X_TENX_IMAGE` is shared between the run
 * path and (as a fallback) the compile path, so a user who points it at the
 * native runtime to speed up the run path silently aims the compiler at an
 * engine with no `discoverSources` factory. Verified against the real images on
 * 1.1.38 before the guard was written: `log10x/edge-10x:latest` on the compile
 * path exits 1 after ~4s with a Jackson mapping error and produces no library.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RUNTIME_IMAGE,
  NATIVE_RUNTIME_IMAGE,
  RuntimeImageOnCompilerPathError,
  isKnownRuntimeImage,
  resolveRuntimeImage,
} from '../src/lib/runtime-image.js';
import { resolveCompilerImage } from '../src/lib/compile-runner.js';

/** Run `fn`, returning whatever it threw (typed as unknown, not `void`). */
function catchThrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to throw, it returned normally');
}

// ── run path ───────────────────────────────────────────────────────────────

test('run path defaults to the compiler-flavor pipeline image (unchanged)', () => {
  assert.equal(resolveRuntimeImage({}), DEFAULT_RUNTIME_IMAGE);
});

test('run path still honours the shared LOG10X_TENX_IMAGE', () => {
  assert.equal(
    resolveRuntimeImage({ LOG10X_TENX_IMAGE: 'registry.corp/mirror/pipeline-10x:1.1.38' }),
    'registry.corp/mirror/pipeline-10x:1.1.38',
  );
});

test('LOG10X_RUNTIME_IMAGE wins over the shared var', () => {
  assert.equal(
    resolveRuntimeImage({
      LOG10X_RUNTIME_IMAGE: 'registry.corp/edge:9',
      LOG10X_TENX_IMAGE: 'log10x/pipeline-10x:latest',
    }),
    'registry.corp/edge:9',
  );
});

test('the `native` alias resolves to the GraalVM runtime image', () => {
  for (const alias of ['native', 'NATIVE', 'runtime', 'edge']) {
    assert.equal(resolveRuntimeImage({ LOG10X_RUNTIME_IMAGE: alias }), NATIVE_RUNTIME_IMAGE);
  }
});

test('an empty/whitespace LOG10X_RUNTIME_IMAGE falls through rather than yielding ""', () => {
  assert.equal(resolveRuntimeImage({ LOG10X_RUNTIME_IMAGE: '   ' }), DEFAULT_RUNTIME_IMAGE);
});

// ── compile path ───────────────────────────────────────────────────────────

test('compile path defaults to the compiler image, at a PINNED tag', () => {
  const image = resolveCompilerImage({});
  assert.equal(image, 'log10x/compiler-10x:1.1.39');

  // The pin is the point, not the particular version. A symbol library built
  // from a mutable tag is not reproducible: nothing in the emitted .10x.json
  // units records which image produced them, so two compiles of the same
  // sources can silently go through two different engines. Bumping the version
  // above is expected; reverting to `:latest` is the regression this guards.
  assert.doesNotMatch(image, /:latest$/, 'the default compiler image must not be a mutable tag');
  assert.match(image, /^log10x\/compiler-10x:\d+\.\d+\.\d+$/);
});

test('compile path keeps the LOG10X_TENX_IMAGE fallback for non-runtime images', () => {
  assert.equal(
    resolveCompilerImage({ LOG10X_TENX_IMAGE: 'registry.corp/mirror/compiler-10x:1.1.38' }),
    'registry.corp/mirror/compiler-10x:1.1.38',
  );
});

test('compile path refuses a runtime image inherited from the shared var, and names it', () => {
  const err = catchThrown(() => resolveCompilerImage({ LOG10X_TENX_IMAGE: 'log10x/edge-10x:latest' }));
  assert.ok(err instanceof RuntimeImageOnCompilerPathError, `expected refusal, got ${err}`);
  assert.equal(err.image, 'log10x/edge-10x:latest');
  assert.match(err.message, /discoverSources/);
  assert.match(err.message, /LOG10X_TENX_IMAGE/);
  assert.match(err.message, /LOG10X_RUNTIME_IMAGE=native/);
});

test('compile path refuses a runtime image set directly on LOG10X_COMPILER_IMAGE', () => {
  const err = catchThrown(() => resolveCompilerImage({ LOG10X_COMPILER_IMAGE: 'log10x/edge-10x:1.1.38' }));
  assert.ok(err instanceof RuntimeImageOnCompilerPathError, `expected refusal, got ${err}`);
  assert.match(err.message, /LOG10X_COMPILER_IMAGE/);
});

test('runtime-image detection matches repo, not substring', () => {
  assert.equal(isKnownRuntimeImage('log10x/edge-10x:latest'), true);
  assert.equal(isKnownRuntimeImage('log10x/edge-10x'), true);
  assert.equal(isKnownRuntimeImage('ghcr.io/log-10x/edge-10x:1.1.38'), true);
  assert.equal(isKnownRuntimeImage('log10x/lambda-10x:1.1.38-native'), true);
  // The compiler and pipeline images must NOT trip it.
  assert.equal(isKnownRuntimeImage('log10x/compiler-10x:latest'), false);
  assert.equal(isKnownRuntimeImage('log10x/pipeline-10x:latest'), false);
  // A tag that merely mentions edge is not a runtime repo.
  assert.equal(isKnownRuntimeImage('log10x/compiler-10x:edge-10x'), false);
});
