import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  detectFlavor,
  assertCloudFlavor,
  NotCloudFlavorError,
  FlavorUndetectedError,
  ALLOW_UNVERIFIED_FLAVOR_ENV,
} from '../src/lib/compile-runner.js';

// The gate the Compiler app runs before it will spawn a local `tenx`. It used to
// read `if (flavor && flavor !== 'cloud') throw`, so every case where the flavor
// could not be READ — a banner in an unknown format, a binary that will not
// execute — skipped the check and the run proceeded as though Cloud had been
// confirmed. These tests pin all four outcomes against real spawned binaries,
// not against a mock of the probe.

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

// ── assertCloudFlavor: the gate itself ───────────────────────────────────

test('assertCloudFlavor passes a confirmed cloud binary', async () => {
  const bin = await fakeTenx(
    'gate-cloud',
    "#!/bin/sh\necho \"10x engine v1.1.32, flavor: 'cloud'\"\n",
  );
  await assertCloudFlavor(bin); // must not throw
});

test('assertCloudFlavor refuses a positively-detected non-cloud flavor', async () => {
  const bin = await fakeTenx('gate-edge', "#!/bin/sh\necho \"10x engine v1.1.32, flavor: 'edge'\"\n");
  await assert.rejects(() => assertCloudFlavor(bin), (e: Error) => {
    assert.ok(e instanceof NotCloudFlavorError);
    assert.match(e.message, /is the 'edge' flavor/);
    return true;
  });
});

// THE REGRESSION. Before the fix both of these resolved, and the Compiler app
// went on to spawn the binary.
test('assertCloudFlavor refuses a binary whose banner carries no flavor token', async () => {
  const bin = await fakeTenx('gate-noflavor', '#!/bin/sh\necho "10x engine v1.1.32"\n');
  await assert.rejects(() => assertCloudFlavor(bin), (e: Error) => {
    assert.ok(e instanceof FlavorUndetectedError, `expected FlavorUndetectedError, got ${e.name}`);
    assert.equal((e as FlavorUndetectedError).outcome, 'unreadable');
    assert.match(e.message, /Cannot determine the flavor/);
    assert.match(e.message, /10x engine v1\.1\.32/); // quotes what it actually saw
    return true;
  });
});

test('assertCloudFlavor refuses a binary that cannot be executed at all', async () => {
  await assert.rejects(
    () => assertCloudFlavor(path.join(dir, 'gate-absent')),
    (e: Error) => {
      assert.ok(e instanceof FlavorUndetectedError);
      assert.equal((e as FlavorUndetectedError).outcome, 'unrunnable');
      return true;
    },
  );
});

test('assertCloudFlavor refuses a binary that dies without printing a banner', async () => {
  const bin = await fakeTenx('gate-crash', '#!/bin/sh\necho "Segmentation fault" >&2\nexit 139\n');
  await assert.rejects(() => assertCloudFlavor(bin), FlavorUndetectedError);
});

test('a non-cloud flavor is refused even with the unverified-flavor opt-out set', async () => {
  const bin = await fakeTenx(
    'gate-edge-optout',
    "#!/bin/sh\necho \"10x engine v1.1.32, flavor: 'edge'\"\n",
  );
  const prev = process.env[ALLOW_UNVERIFIED_FLAVOR_ENV];
  process.env[ALLOW_UNVERIFIED_FLAVOR_ENV] = '1';
  try {
    await assert.rejects(() => assertCloudFlavor(bin), NotCloudFlavorError);
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
    await assertCloudFlavor(bin); // must not throw

    // A truthy-looking but non-'1' value must NOT open the gate: the opt-out is
    // exact, so `=0`, `=false` and `=true` all keep the refusal.
    for (const v of ['0', 'false', 'true', 'yes', '']) {
      process.env[ALLOW_UNVERIFIED_FLAVOR_ENV] = v;
      await assert.rejects(() => assertCloudFlavor(bin), FlavorUndetectedError, `value ${JSON.stringify(v)} should not open the gate`);
    }
  } finally {
    if (prev === undefined) delete process.env[ALLOW_UNVERIFIED_FLAVOR_ENV];
    else process.env[ALLOW_UNVERIFIED_FLAVOR_ENV] = prev;
  }
});

test('the refusal message names the remediation paths, not just the failure', async () => {
  const bin = await fakeTenx('gate-msg', '#!/bin/sh\necho "10x engine v1.1.32"\n');
  const err = await assertCloudFlavor(bin).then(
    () => null,
    (e: Error) => e,
  );
  assert.ok(err, 'gate did not throw');
  assert.match(err.message, /LOG10X_TENX_MODE=docker/);
  assert.match(err.message, new RegExp(ALLOW_UNVERIFIED_FLAVOR_ENV));
  assert.match(err.message, /doc\.log10x\.com\/install/);
});
