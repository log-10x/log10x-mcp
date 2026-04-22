import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStreamer, clearStreamerResolutionCacheForTest } from '../src/lib/streamer-api.js';

const SAVED_ENV = { ...process.env };

const KEYS = [
  'LOG10X_STREAMER_URL',
  'LOG10X_STREAMER_BUCKET',
  'LOG10X_STREAMER_TARGET',
  'LOG10X_TERRAFORM_STATE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'HOME',
];

beforeEach(() => {
  clearStreamerResolutionCacheForTest();
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  clearStreamerResolutionCacheForTest();
  for (const k of KEYS) delete process.env[k];
  for (const k of KEYS) {
    if (SAVED_ENV[k] !== undefined) process.env[k] = SAVED_ENV[k] as string;
  }
});

// Gap 3: detection cascade for streamer URL + bucket.

test('resolveStreamer: empty env returns no backend with trace', async () => {
  // Point HOME somewhere empty so the terraform-state path can't match
  // against a real ~/.log10x/ on the developer box.
  process.env.HOME = '/tmp/nonexistent-streamer-autodetect-test';
  const res = await resolveStreamer();
  assert.equal(res.url, undefined);
  assert.equal(res.bucket, undefined);
  const paths = res.trace.map((t) => t.path);
  assert.ok(paths.includes('explicit_env'));
  assert.ok(paths.includes('terraform_state'));
});

test('resolveStreamer: explicit LOG10X_STREAMER_URL + BUCKET wins', async () => {
  process.env.LOG10X_STREAMER_URL = 'https://streamer.example.com/';
  process.env.LOG10X_STREAMER_BUCKET = 'my-archive-bucket';
  process.env.LOG10X_STREAMER_TARGET = 'my-target';
  const res = await resolveStreamer();
  assert.equal(res.detectionPath, 'explicit_env');
  assert.equal(res.url, 'https://streamer.example.com');
  assert.equal(res.bucket, 'my-archive-bucket');
  assert.equal(res.target, 'my-target');
});

test('resolveStreamer: half-configured explicit env reports skipped', async () => {
  process.env.LOG10X_STREAMER_URL = 'https://streamer.example.com';
  process.env.HOME = '/tmp/nonexistent-streamer-autodetect-test';
  const res = await resolveStreamer();
  const explicit = res.trace.find((t) => t.path === 'explicit_env');
  assert.ok(explicit);
  assert.equal(explicit!.status, 'skipped');
  assert.match(explicit!.reason, /only one of/);
});

test('resolveStreamer: terraform state produces url + bucket', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tempHome = mkdtempSync(join(tmpdir(), 'streamer-autodetect-'));
  const cfgDir = join(tempHome, '.log10x');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'streamer.tfstate'),
    JSON.stringify({
      outputs: {
        streamer_url: { value: 'https://tf.streamer.example.com/' },
        streamer_bucket: { value: 'tf-archive-bucket' },
        streamer_target: { value: 'tf-target' },
      },
    }),
  );
  process.env.HOME = tempHome;
  const res = await resolveStreamer();
  assert.equal(res.detectionPath, 'terraform_state');
  assert.equal(res.url, 'https://tf.streamer.example.com');
  assert.equal(res.bucket, 'tf-archive-bucket');
  assert.equal(res.target, 'tf-target');
});

test('resolveStreamer: LOG10X_TERRAFORM_STATE override is honored', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'streamer-tfs-'));
  const path = join(dir, 'custom.tfstate');
  writeFileSync(
    path,
    JSON.stringify({
      outputs: {
        query_handler_url: { value: 'https://qh.example.com' },
        archive_bucket: { value: 'override-bucket' },
      },
    }),
  );
  process.env.LOG10X_TERRAFORM_STATE = path;
  process.env.HOME = '/tmp/nonexistent';
  const res = await resolveStreamer();
  assert.equal(res.detectionPath, 'terraform_state');
  assert.equal(res.url, 'https://qh.example.com');
  assert.equal(res.bucket, 'override-bucket');
});
