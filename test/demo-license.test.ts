import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readDemoLicense,
  writeDemoLicense,
  clearDemoLicense,
  isDemoLicenseExpired,
} from '../src/lib/demo-license.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-lic-'));
  process.env.LOG10X_DEMO_LICENSE_PATH = path.join(tmpDir, 'demo-license.json');
});

afterEach(async () => {
  delete process.env.LOG10X_DEMO_LICENSE_PATH;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('readDemoLicense: returns null when the file is missing', async () => {
  assert.equal(await readDemoLicense(), null);
});

test('writeDemoLicense then readDemoLicense round-trips the JWT + metadata', async () => {
  await writeDemoLicense({ jwt: 'jwt-abc', expiresAtEpochSec: 12345, licenseId: 'lic_1' });
  const got = await readDemoLicense();
  assert.equal(got?.jwt, 'jwt-abc');
  assert.equal(got?.expiresAtEpochSec, 12345);
  assert.equal(got?.licenseId, 'lic_1');
  assert.ok(got?.mintedAt, 'mintedAt should be stamped on write');
});

test('writeDemoLicense uses 0600 file mode', async () => {
  await writeDemoLicense({ jwt: 'jwt-abc' });
  const st = await fs.stat(process.env.LOG10X_DEMO_LICENSE_PATH!);
  assert.equal(st.mode & 0o777, 0o600);
});

test('readDemoLicense: returns null on a file with no usable jwt', async () => {
  await fs.writeFile(process.env.LOG10X_DEMO_LICENSE_PATH!, JSON.stringify({ foo: 'bar' }));
  assert.equal(await readDemoLicense(), null);
});

test('readDemoLicense: throws on malformed JSON (fail loud, not silent)', async () => {
  await fs.writeFile(process.env.LOG10X_DEMO_LICENSE_PATH!, '{ not json');
  await assert.rejects(() => readDemoLicense(), /not valid JSON/);
});

test('clearDemoLicense: removes the file and is idempotent', async () => {
  await writeDemoLicense({ jwt: 'jwt-abc' });
  assert.equal(await clearDemoLicense(), true);
  assert.equal(await clearDemoLicense(), false);
  assert.equal(await readDemoLicense(), null);
});

test('isDemoLicenseExpired: true when past expiry (with skew), false when fresh', () => {
  const now = 1_000_000;
  assert.equal(isDemoLicenseExpired({ expiresAtEpochSec: now - 1 }, now), true);
  assert.equal(isDemoLicenseExpired({ expiresAtEpochSec: now + 3600 }, now), false);
  // Within the 5-min skew counts as expired.
  assert.equal(isDemoLicenseExpired({ expiresAtEpochSec: now + 60 }, now), true);
});

test('isDemoLicenseExpired: unknown expiry is treated as usable', () => {
  assert.equal(isDemoLicenseExpired({}, 1_000_000), false);
});
