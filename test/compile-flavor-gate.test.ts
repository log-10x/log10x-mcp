import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  detectFlavor,
  assertCompilerFlavor,
  isCompilerFlavor,
  isCompilerFlavorOutput,
  parseFlavor,
  COMPILER_FLAVORS,
  RUNTIME_FLAVORS,
  NATIVE_RUNTIME_FLAVORS,
  JVM_RUNTIME_FLAVORS,
  NotCompilerFlavorError,
  FlavorUndetectedError,
  ALLOW_UNVERIFIED_FLAVOR_ENV,
} from '../src/lib/compile-runner.js';

// The gate the Compiler app runs before it will spawn a local `tenx`. It used to
// read `if (flavor && flavor !== 'cloud') throw`, so every case where the flavor
// could not be READ — a banner in an unknown format, a binary that will not
// execute — skipped the check and the run proceeded as though a compiler build
// had been confirmed. It then required the token to be exactly `cloud`, which
// hard-refuses the renamed compiler binary that reports `compiler`.
//
// These tests pin every outcome against real spawned binaries, not against a
// mock of the probe: both accepted spellings, both rejected runtime spellings,
// and the three "cannot tell" cases.

let dir: string;

/** Write an executable stand-in for `tenx` and return its absolute path. */
async function fakeTenx(name: string, script: string): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, script, { mode: 0o755 });
  return p;
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'log10x-flavor-gate-'));
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// ── detectFlavor reports WHY it came back empty ──────────────────────────

test('detectFlavor parses the flavor token off a real binary banner', async () => {
  const bin = await fakeTenx('tenx-cloud', "#!/bin/sh\necho \"10x engine v1.1.32, flavor: 'cloud'\"\n");
  const probe = await detectFlavor(bin);
  assert.equal(probe.outcome, 'parsed');
  assert.equal(probe.flavor, 'cloud');
});

test('detectFlavor distinguishes a banner it cannot read from a binary it cannot run', async () => {
  const noBanner = await fakeTenx('tenx-noflavor', '#!/bin/sh\necho "10x engine v1.1.32"\n');
  const unreadable = await detectFlavor(noBanner);
  assert.equal(unreadable.outcome, 'unreadable');
  assert.equal(unreadable.flavor, null);
  assert.match(unreadable.raw, /10x engine v1\.1\.32/);

  const unrunnable = await detectFlavor(path.join(dir, 'does-not-exist'));
  assert.equal(unrunnable.outcome, 'unrunnable');
  assert.equal(unrunnable.flavor, null);
});

test('detectFlavor falls through to --help when --version prints no banner', async () => {
  const bin = await fakeTenx(
    'tenx-help-only',
    '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "10x engine v1.1.32, flavor: \'cloud\'"; else echo "usage"; fi\n',
  );
  const probe = await detectFlavor(bin);
  assert.equal(probe.outcome, 'parsed');
  assert.equal(probe.flavor, 'cloud');
});

test('detectFlavor reads a banner printed on stderr', async () => {
  const bin = await fakeTenx(
    'tenx-stderr',
    '#!/bin/sh\necho "10x engine v1.1.32, flavor: \'cloud\'" >&2\n',
  );
  assert.equal((await detectFlavor(bin)).flavor, 'cloud');
});

// ── assertCompilerFlavor: the gate itself ───────────────────────────────────

// THE RENAME. log-10x/engine#94 changes CloudPipelineFactory.name() from
// 'cloud' to 'compiler' and EdgePipelineFactory.name() from 'edge' to
// 'runtime'. A gate that demands exactly 'cloud' hard-refuses the renamed
// compiler binary, so BOTH spellings must be accepted — and permanently, not as
// a transition shim: a binary already installed keeps printing 'cloud' until
// its owner upgrades.
test('assertCompilerFlavor accepts a binary that reports the RENAMED compiler flavor', async () => {
  const bin = await fakeTenx(
    'gate-compiler',
    "#!/bin/sh\necho \"10x engine v1.2.0, flavor: 'compiler'\"\n",
  );
  const probe = await assertCompilerFlavor(bin); // must not throw
  assert.equal(probe.outcome, 'parsed');
  assert.equal(probe.flavor, 'compiler');
});

test('assertCompilerFlavor still accepts the pre-rename cloud spelling', async () => {
  const bin = await fakeTenx(
    'gate-cloud',
    "#!/bin/sh\necho \"10x engine v1.1.32, flavor: 'cloud'\"\n",
  );
  const probe = await assertCompilerFlavor(bin); // must not throw
  assert.equal(probe.flavor, 'cloud');
});

test('assertCompilerFlavor refuses a binary that reports the RENAMED runtime flavor', async () => {
  const bin = await fakeTenx(
    'gate-runtime',
    "#!/bin/sh\necho \"10x engine v1.2.0, flavor: 'runtime'\"\n",
  );
  await assert.rejects(() => assertCompilerFlavor(bin), (e: Error) => {
    assert.ok(e instanceof NotCompilerFlavorError, `expected NotCompilerFlavorError, got ${e.name}`);
    assert.equal((e as NotCompilerFlavorError).flavor, 'runtime');
    assert.match(e.message, /native runtime build/);
    assert.match(e.message, /reports flavor 'runtime'/);
    return true;
  });
});

// THE THIRD FLAVOR. `runtime-jvm` is the JVM-packaged runtime — not a new
// build, those .deb/.rpm/.msi/.dmg artifacts ship in every release, and on
// Windows they are the ONLY runtime because no native Windows binary is built.
// It must still be REFUSED by the compile gate: the JVM/native axis is not the
// axis that decides who can compile. And the refusal has to say that, because a
// user who just installed a JVM package has every reason to assume otherwise.
test('assertCompilerFlavor refuses runtime-jvm, and says WHY a JVM build still cannot compile', async () => {
  const bin = await fakeTenx(
    'gate-runtime-jvm',
    "#!/bin/sh\necho \"10x engine v1.1.38, flavor: 'runtime-jvm'\"\n",
  );
  await assert.rejects(() => assertCompilerFlavor(bin), (e: Error) => {
    assert.ok(e instanceof NotCompilerFlavorError, `expected NotCompilerFlavorError, got ${e.name}`);
    assert.equal((e as NotCompilerFlavorError).flavor, 'runtime-jvm');
    // Names the build it actually is...
    assert.match(e.message, /JVM runtime build/);
    assert.match(e.message, /reports flavor 'runtime-jvm'/);
    // ...and the specific reason, not the generic "not a compiler build".
    assert.match(e.message, /Running on a JVM is not what makes a build a compiler/);
    assert.match(e.message, /no `generate` pipeline unit/);
    assert.doesNotMatch(e.message, /is the native runtime build/);
    assert.doesNotMatch(e.message, /which is not a compiler build/);
    return true;
  });
});

test('the runtime-jvm refusal enumerates all three flavors', async () => {
  const bin = await fakeTenx(
    'gate-runtime-jvm-enum',
    "#!/bin/sh\necho \"10x engine v1.1.38, flavor: 'runtime-jvm'\"\n",
  );
  const err = await assertCompilerFlavor(bin).then(() => null, (e: Error) => e);
  assert.ok(err, 'gate did not throw');
  for (const flavor of ['compiler', 'runtime', 'runtime-jvm']) {
    assert.match(err.message, new RegExp(`\\b${flavor}\\b`), `refusal must name the ${flavor} flavor`);
  }
  assert.match(err.message, /only runtime available on Windows/);
});

test('runtime-jvm is refused even with the unverified-flavor opt-out set', async () => {
  const bin = await fakeTenx(
    'gate-runtime-jvm-optout',
    "#!/bin/sh\necho \"10x engine v1.1.38, flavor: 'runtime-jvm'\"\n",
  );
  const prev = process.env[ALLOW_UNVERIFIED_FLAVOR_ENV];
  process.env[ALLOW_UNVERIFIED_FLAVOR_ENV] = '1';
  try {
    await assert.rejects(() => assertCompilerFlavor(bin), NotCompilerFlavorError);
  } finally {
    if (prev === undefined) delete process.env[ALLOW_UNVERIFIED_FLAVOR_ENV];
    else process.env[ALLOW_UNVERIFIED_FLAVOR_ENV] = prev;
  }
});

test('runtime-jvm is a runtime flavor, and is not a compiler flavor', () => {
  assert.equal(JVM_RUNTIME_FLAVORS.has('runtime-jvm'), true);
  assert.equal(RUNTIME_FLAVORS.has('runtime-jvm'), true);
  assert.equal(NATIVE_RUNTIME_FLAVORS.has('runtime-jvm'), false);
  assert.equal(COMPILER_FLAVORS.has('runtime-jvm'), false);
  assert.equal(isCompilerFlavor('runtime-jvm'), false);
  assert.equal(isCompilerFlavorOutput("10x engine v1.1.38, flavor: 'runtime-jvm'"), false);
  assert.equal(parseFlavor("10x engine v1.1.38, flavor: 'runtime-jvm'"), 'runtime-jvm');
  // The hyphen must survive the parser — a token clipped to 'runtime' would
  // still be refused, but the refusal would name the wrong build.
  assert.equal(parseFlavor("10x engine v1.1.38, flavor: 'RUNTIME-JVM'"), 'runtime-jvm');
});

test('assertCompilerFlavor refuses the pre-rename runtime spellings too', async () => {
  for (const flavor of ['edge', 'native']) {
    const bin = await fakeTenx(
      `gate-${flavor}`,
      `#!/bin/sh\necho "10x engine v1.1.32, flavor: '${flavor}'"\n`,
    );
    await assert.rejects(() => assertCompilerFlavor(bin), (e: Error) => {
      assert.ok(e instanceof NotCompilerFlavorError);
      assert.match(e.message, new RegExp(`reports flavor '${flavor}'`));
      return true;
    }, `flavor '${flavor}' must not open the gate`);
  }
});

test('assertCompilerFlavor refuses a flavor it has never heard of', async () => {
  const bin = await fakeTenx(
    'gate-unknown',
    "#!/bin/sh\necho \"10x engine v9.9.9, flavor: 'lambda'\"\n",
  );
  await assert.rejects(() => assertCompilerFlavor(bin), (e: Error) => {
    assert.ok(e instanceof NotCompilerFlavorError);
    assert.match(e.message, /reports the 'lambda' flavor, which is not a compiler build/);
    return true;
  });
});

test('the gate is case-insensitive on the token, both spellings', async () => {
  for (const banner of ["flavor: 'Compiler'", "flavor: 'CLOUD'"]) {
    const bin = await fakeTenx(
      `gate-case-${banner.replace(/\W/g, '')}`,
      `#!/bin/sh\necho "10x engine v1.2.0, ${banner}"\n`,
    );
    await assertCompilerFlavor(bin); // must not throw
  }
});

// THE REGRESSION. Before the fix both of these resolved, and the Compiler app
// went on to spawn the binary.
test('assertCompilerFlavor refuses a binary whose banner carries no flavor token', async () => {
  const bin = await fakeTenx('gate-noflavor', '#!/bin/sh\necho "10x engine v1.1.32"\n');
  await assert.rejects(() => assertCompilerFlavor(bin), (e: Error) => {
    assert.ok(e instanceof FlavorUndetectedError, `expected FlavorUndetectedError, got ${e.name}`);
    assert.equal((e as FlavorUndetectedError).outcome, 'unreadable');
    assert.match(e.message, /Cannot determine the flavor/);
    assert.match(e.message, /10x engine v1\.1\.32/); // quotes what it actually saw
    return true;
  });
});

test('assertCompilerFlavor refuses a binary that cannot be executed at all', async () => {
  await assert.rejects(
    () => assertCompilerFlavor(path.join(dir, 'gate-absent')),
    (e: Error) => {
      assert.ok(e instanceof FlavorUndetectedError);
      assert.equal((e as FlavorUndetectedError).outcome, 'unrunnable');
      return true;
    },
  );
});

test('assertCompilerFlavor refuses a binary that dies without printing a banner', async () => {
  const bin = await fakeTenx('gate-crash', '#!/bin/sh\necho "Segmentation fault" >&2\nexit 139\n');
  await assert.rejects(() => assertCompilerFlavor(bin), FlavorUndetectedError);
});

test('a runtime flavor is refused even with the unverified-flavor opt-out set', async () => {
  const bin = await fakeTenx(
    'gate-runtime-optout',
    "#!/bin/sh\necho \"10x engine v1.2.0, flavor: 'runtime'\"\n",
  );
  const prev = process.env[ALLOW_UNVERIFIED_FLAVOR_ENV];
  process.env[ALLOW_UNVERIFIED_FLAVOR_ENV] = '1';
  try {
    await assert.rejects(() => assertCompilerFlavor(bin), NotCompilerFlavorError);
  } finally {
    if (prev === undefined) delete process.env[ALLOW_UNVERIFIED_FLAVOR_ENV];
    else process.env[ALLOW_UNVERIFIED_FLAVOR_ENV] = prev;
  }
});

test(`${ALLOW_UNVERIFIED_FLAVOR_ENV}=1 lets an unreadable banner through, and only that value does`, async () => {
  const bin = await fakeTenx('gate-optout', '#!/bin/sh\necho "10x engine v1.1.32"\n');
  const prev = process.env[ALLOW_UNVERIFIED_FLAVOR_ENV];
  try {
    process.env[ALLOW_UNVERIFIED_FLAVOR_ENV] = '1';
    await assertCompilerFlavor(bin); // must not throw

    // A truthy-looking but non-'1' value must NOT open the gate: the opt-out is
    // exact, so `=0`, `=false` and `=true` all keep the refusal.
    for (const v of ['0', 'false', 'true', 'yes', '']) {
      process.env[ALLOW_UNVERIFIED_FLAVOR_ENV] = v;
      await assert.rejects(() => assertCompilerFlavor(bin), FlavorUndetectedError, `value ${JSON.stringify(v)} should not open the gate`);
    }
  } finally {
    if (prev === undefined) delete process.env[ALLOW_UNVERIFIED_FLAVOR_ENV];
    else process.env[ALLOW_UNVERIFIED_FLAVOR_ENV] = prev;
  }
});

test('the refusal message names the remediation paths, not just the failure', async () => {
  const bin = await fakeTenx('gate-msg', '#!/bin/sh\necho "10x engine v1.1.32"\n');
  const err = await assertCompilerFlavor(bin).then(
    () => null,
    (e: Error) => e,
  );
  assert.ok(err, 'gate did not throw');
  assert.match(err.message, /LOG10X_TENX_MODE=docker/);
  assert.match(err.message, new RegExp(ALLOW_UNVERIFIED_FLAVOR_ENV));
  assert.match(err.message, /doc\.log10x\.com\/install/);
});
