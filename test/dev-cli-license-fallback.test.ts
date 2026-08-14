/**
 * Forwarding TENX_LICENSE_KEY to the docker run path is only safe if a bad key
 * cannot take away a call that worked without it.
 *
  * The runtime images carry a built-in limited license, so an unforwarded
  * stale `TENX_LICENSE_KEY` sitting in the environment is ignored and the
  * run succeeds. On engine 1.1.39, `log10x/edge-10x`, the same two events:
  *
  *   no forward                -> STATUS success, "2 events → 2 patterns"
  *   forward, no fallback      -> STATUS error, backend_unavailable,
  *                                "license verification failed: MALFORMED"
  *
  * Docker mode is not opt-in either: a host with no `tenx` on PATH resolves
  * to it on its own, so nobody has to ask for the forward to be hit by it.
  *
 *
  * Also pinned: the hint must not tell a docker-mode caller
 * to "Set LOG10X_TENX_MODE=docker … (no license needed)" — the mode they were
 * already in, and a license claim made in the same breath as their license
 * refusing the run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DevCliRunError,
  describeDevCliFailure,
  dockerLicenseArgs,
  isEngineLicenseRejection,
  withDockerLicenseFallback,
} from '../src/lib/dev-cli.js';

/** Verbatim stderr from `log10x/edge-10x:1.1.39` with a non-JWT key forwarded. */
const MALFORMED_STDERR = [
  "could not launch pipeline: 'run'",
  'Invalid serialized unsecured/JWS/JWE object: Missing part delimiters',
  '',
  'details:',
  'error initializating engine environment',
  'license verification failed: MALFORMED — license token is not a parseable JWT',
  'LicenseException: license token is not a parseable JWT',
  'ParseException: Invalid serialized unsecured/JWS/JWE object: Missing part delimiters',
].join('\n');

/** The engine refusing to start because it was handed NO license at all. */
const NO_LICENSE_STDERR =
  'license required: set --licenseFile, --licenseKey, the TENX_LICENSE_KEY/TENX_LICENSE_FILE env var, ' +
  'or a licenseKey/licenseFile entry in your bootstrap .yaml. Get a free license at https://console.log10x.com';

/** Run `fn` with console.error captured, so the downgrade notice is assertable. */
async function capturingStderr<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = original;
  }
}

// ── isEngineLicenseRejection ──

test('isEngineLicenseRejection matches the engine refusing a license it was handed', () => {
  assert.equal(isEngineLicenseRejection(MALFORMED_STDERR), true);
});

test('isEngineLicenseRejection does not match the engine refusing because it was handed none', () => {
  // Withholding a key we never forwarded cannot fix this one, so a retry would
  // just double the wall time and change nothing.
  assert.equal(isEngineLicenseRejection(NO_LICENSE_STDERR), false);
});

test('isEngineLicenseRejection does not match an unrelated engine failure', () => {
  assert.equal(isEngineLicenseRejection('could not resolve include path /etc/tenx/config'), false);
});

// ── dockerLicenseArgs ──

test('dockerLicenseArgs forwards the key bare, so the value never lands in argv', () => {
  assert.deepEqual(dockerLicenseArgs({ TENX_LICENSE_KEY: 'SECRET' }), ['-e', 'TENX_LICENSE_KEY']);
});

test('dockerLicenseArgs forwards nothing when no key is set', () => {
  assert.deepEqual(dockerLicenseArgs({}), []);
});

// ── withDockerLicenseFallback ──

test('withDockerLicenseFallback retries without the key when the engine rejects the forwarded one', async () => {
  const seen: string[][] = [];
  const { result } = await capturingStderr(() =>
    withDockerLicenseFallback(async (licenseArgs) => {
      seen.push(licenseArgs);
      if (licenseArgs.length > 0) {
        throw new DevCliRunError(1, MALFORMED_STDERR, '', '@apps/mcp', 'docker');
      }
      return 'encoded=,~abc,1,2,3,4,pattern=,host_app_user_logged_in_from';
    }, { TENX_LICENSE_KEY: 'stale-key' })
  );
  assert.match(result, /host_app_user_logged_in_from/);
  assert.deepEqual(seen, [['-e', 'TENX_LICENSE_KEY'], []]);
});

test('withDockerLicenseFallback announces the downgrade instead of swallowing it', async () => {
  const { logged } = await capturingStderr(() =>
    withDockerLicenseFallback(async (licenseArgs) => {
      if (licenseArgs.length > 0) {
        throw new DevCliRunError(1, MALFORMED_STDERR, '', '@apps/mcp', 'docker');
      }
      return 'ok';
    }, { TENX_LICENSE_KEY: 'stale-key' })
  );
  assert.equal(logged.length, 1);
  assert.match(logged[0], /TENX_LICENSE_KEY/);
});

test('withDockerLicenseFallback makes one attempt only when no key is set', async () => {
  const seen: string[][] = [];
  await withDockerLicenseFallback(async (licenseArgs) => {
    seen.push(licenseArgs);
    return 'ok';
  }, {});
  assert.deepEqual(seen, [[]]);
});

test('withDockerLicenseFallback re-throws a non-license failure without a second run', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withDockerLicenseFallback(async () => {
        calls += 1;
        throw new DevCliRunError(
          1,
          "no such image: log10x/pipeline-10x:latest",
          '',
          '@apps/mcp',
          'docker'
        );
      }, { TENX_LICENSE_KEY: 'good-key' }),
    /no such image/
  );
  assert.equal(calls, 1);
});

test('withDockerLicenseFallback propagates the second failure when withholding the key does not help', async () => {
  let calls = 0;
  const original = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      () =>
        withDockerLicenseFallback(async (licenseArgs) => {
          calls += 1;
          throw new DevCliRunError(
            1,
            licenseArgs.length > 0 ? MALFORMED_STDERR : 'docker daemon is not running',
            '',
            '@apps/mcp',
            'docker'
          );
        }, { TENX_LICENSE_KEY: 'stale-key' }),
      /docker daemon is not running/
    );
  } finally {
    console.error = original;
  }
  assert.equal(calls, 2);
});

// ── describeDevCliFailure ──

test('describeDevCliFailure does not tell a docker-mode caller to switch to docker mode', () => {
  const hint = describeDevCliFailure(1, MALFORMED_STDERR, {
    mode: 'docker',
    licenseKeyForwarded: true,
  });
  assert.equal(hint.includes('Set LOG10X_TENX_MODE=docker'), false);
});

test('describeDevCliFailure does not claim no license is needed when a license refused the run', () => {
  const hint = describeDevCliFailure(1, MALFORMED_STDERR, {
    mode: 'docker',
    licenseKeyForwarded: true,
  });
  assert.equal(hint.toLowerCase().includes('no license needed'), false);
});

test('describeDevCliFailure says the forwarded key was already withheld', () => {
  const hint = describeDevCliFailure(1, MALFORMED_STDERR, {
    mode: 'docker',
    licenseKeyForwarded: true,
  });
  assert.match(hint, /already withheld/);
});

test('describeDevCliFailure promotes the license line over the useless first stderr line', () => {
  const hint = describeDevCliFailure(1, MALFORMED_STDERR, { mode: 'docker' });
  assert.match(hint, /license verification failed: MALFORMED/);
  assert.equal(hint.includes('Engine said: could not launch pipeline'), false);
});

test('describeDevCliFailure still names the docker escape for a local-mode failure', () => {
  const hint = describeDevCliFailure(1, NO_LICENSE_STDERR, { mode: 'local' });
  assert.match(hint, /LOG10X_TENX_MODE=docker/);
  assert.match(hint, /license required:/);
});

test('describeDevCliFailure names neither mode as already-in-use when the mode is unknown', () => {
  const hint = describeDevCliFailure(1, NO_LICENSE_STDERR);
  assert.match(hint, /TENX_LICENSE_KEY/);
  assert.match(hint, /LOG10X_TENX_MODE=docker/);
});
