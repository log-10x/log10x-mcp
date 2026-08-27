/**
 * The fenced profile refuses to mint.
 *
 * This is the load-bearing behaviour of the whole evaluation mode. The
 * container it runs in has `--network none`, so a mint attempt cannot
 * succeed — but "cannot succeed" is not the point. The point is that the
 * process which reads the customer's logs never reaches for a socket at all,
 * because that is the property a security reviewer can check and the property
 * the profile is sold on.
 *
 * So the interesting assertions here are about what does NOT happen: no
 * `fetch`, and a refusal that carries the one command the user runs OUTSIDE
 * the fence instead of a retry hint pointing at a gateway they cannot reach.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isFenced, fencedSignal, assertNotFenced, FencedEgressRefusedError, fencedPreMintInstructions } from '../src/lib/fenced.js';
import { fetchDemoLicense, getOrMintDemoLicense } from '../src/lib/license-api.js';
import { writeDemoLicense } from '../src/lib/demo-license.js';
import { resolveEngineCredentials, DevCliConfigMissingError } from '../src/lib/dev-cli.js';

let tmpDir: string;
let realFetch: typeof globalThis.fetch;
let fetchCalls: string[];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fenced-'));
  process.env.LOG10X_DEMO_LICENSE_PATH = path.join(tmpDir, 'demo-license.json');
  delete process.env.TENX_AIRGAPPED;
  delete process.env.LOG10X_FENCED;
  delete process.env.TENX_LICENSE_KEY;
  // Record every outbound attempt. A fenced path that reaches this at all has
  // already failed, whatever the response would have been.
  fetchCalls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error('test: no network');
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env.LOG10X_DEMO_LICENSE_PATH;
  delete process.env.TENX_AIRGAPPED;
  delete process.env.LOG10X_FENCED;
  delete process.env.TENX_LICENSE_KEY;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Detection ──

test('isFenced: off by default', () => {
  assert.equal(isFenced(), false);
  assert.equal(fencedSignal(), null);
});

test('isFenced: TENX_AIRGAPPED is the engine switch and the MCP reads the same one', () => {
  for (const value of ['true', '1', 'yes', 'on', 'TRUE']) {
    process.env.TENX_AIRGAPPED = value;
    assert.equal(isFenced(), true, `TENX_AIRGAPPED=${value} should fence`);
    assert.equal(fencedSignal(), 'TENX_AIRGAPPED');
  }
  process.env.TENX_AIRGAPPED = 'false';
  assert.equal(isFenced(), false);
});

test('isFenced: LOG10X_FENCED fences without touching the engine variable', () => {
  process.env.LOG10X_FENCED = '1';
  assert.equal(isFenced(), true);
  assert.equal(fencedSignal(), 'LOG10X_FENCED');
});

// ── The refusal ──

test('fenced: fetchDemoLicense refuses without reaching the network', async () => {
  process.env.TENX_AIRGAPPED = 'true';
  await assert.rejects(() => fetchDemoLicense(), FencedEgressRefusedError);
  assert.deepEqual(fetchCalls, [], 'a fenced mint must not attempt a request');
});

test('fenced: getOrMintDemoLicense refuses with the pre-mint command, not a retry hint', async () => {
  process.env.TENX_AIRGAPPED = 'true';
  await assert.rejects(
    () => getOrMintDemoLicense(),
    (e: Error) => {
      assert.ok(e instanceof FencedEgressRefusedError);
      assert.match(e.message, /curl -s https:\/\/api\.log10x\.com\/api\/v1\/license\/demo/);
      assert.match(e.message, /TENX_LICENSE_KEY/);
      return true;
    },
  );
  assert.deepEqual(fetchCalls, []);
});

test('fenced: a cached licence that is still valid is used, not re-fetched', async () => {
  process.env.TENX_AIRGAPPED = 'true';
  const farFuture = Math.floor(Date.now() / 1000) + 86_400;
  await writeDemoLicense({ jwt: 'cached-jwt', expiresAtEpochSec: farFuture, licenseId: 'lic_x' });
  const lic = await getOrMintDemoLicense();
  assert.equal(lic.jwt, 'cached-jwt');
  assert.deepEqual(fetchCalls, []);
});

test('fenced: an EXPIRED cached licence refuses and says so, rather than silently reusing it', async () => {
  process.env.TENX_AIRGAPPED = 'true';
  await writeDemoLicense({ jwt: 'stale-jwt', expiresAtEpochSec: Math.floor(Date.now() / 1000) - 10 });
  await assert.rejects(
    () => getOrMintDemoLicense(),
    (e: Error) => {
      assert.match(e.message, /has expired/);
      return true;
    },
  );
  assert.deepEqual(fetchCalls, []);
});

test('fenced: the engine credential path stops before the mint and hands over the instructions', async () => {
  process.env.TENX_AIRGAPPED = 'true';
  await assert.rejects(
    () => resolveEngineCredentials(),
    (e: Error) => {
      assert.ok(e instanceof DevCliConfigMissingError);
      assert.equal((e as DevCliConfigMissingError).field, 'TENX_LICENSE_KEY');
      assert.match(e.message, /never mints one/);
      assert.match(e.message, /verifies it offline/);
      // The curl and the variable it fills have to survive the chassis
      // envelope's 300-character hint cap, or the refusal names a fix the
      // reader never gets to see.
      const asHint = e.message.slice(0, 300);
      assert.match(asHint, /curl -s https:\/\/api\.log10x\.com\/api\/v1\/license\/demo/);
      assert.match(asHint, /TENX_LICENSE_KEY/);
      // The unfenced message offers "a mint needs one call to the gateway" as
      // the fix, which is exactly the thing this profile forbids.
      assert.doesNotMatch(e.message, /minted automatically/);
      return true;
    },
  );
  assert.deepEqual(fetchCalls, []);
});

test('fenced: an explicit TENX_LICENSE_KEY is honoured and nothing is fetched', async () => {
  process.env.TENX_AIRGAPPED = 'true';
  process.env.TENX_LICENSE_KEY = 'a.real.jwt';
  const creds = await resolveEngineCredentials();
  assert.equal(creds.licenseKey, 'a.real.jwt');
  assert.deepEqual(fetchCalls, []);
});

test('unfenced: the mint path is still tried, so the fence is what changes behaviour', async () => {
  await assert.rejects(() => getOrMintDemoLicense(), /no network/);
  assert.deepEqual(fetchCalls, ['https://api.log10x.com/api/v1/license/demo']);
});

// ── The refusal helper ──

test('assertNotFenced names the operation and the switch that caused the refusal', () => {
  process.env.LOG10X_FENCED = '1';
  assert.throws(
    () => assertNotFenced('fetch the remote manifest'),
    (e: Error) => {
      assert.match(e.message, /fetch the remote manifest/);
      assert.match(e.message, /LOG10X_FENCED/);
      return true;
    },
  );
});

test('assertNotFenced is a no-op when the fence is down', () => {
  assert.doesNotThrow(() => assertNotFenced('anything'));
});

test('the pre-mint instructions carry a command, not a description of one', () => {
  const text = fencedPreMintInstructions('missing');
  assert.match(text, /curl -s https:\/\/api\.log10x\.com\/api\/v1\/license\/demo -d '\{\}'/);
  assert.match(text, /TENX_LICENSE_KEY/);
  // Front-loaded so it survives the 300-character hint cap on a chassis error.
  assert.match(text.slice(0, 300), /curl -s https:/);
});
