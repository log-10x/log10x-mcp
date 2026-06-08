import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRetriever, clearRetrieverResolutionCacheForTest } from '../src/lib/retriever-api.js';

const SAVED_ENV = { ...process.env };

const KEYS = [
  '__SAVE_LOG10X_RETRIEVER_URL__',
  '__SAVE_LOG10X_RETRIEVER_BUCKET__',
  '__SAVE_LOG10X_RETRIEVER_TARGET__',
  'LOG10X_TERRAFORM_STATE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'HOME',
];

beforeEach(() => {
  clearRetrieverResolutionCacheForTest();
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  clearRetrieverResolutionCacheForTest();
  for (const k of KEYS) delete process.env[k];
  for (const k of KEYS) {
    if (SAVED_ENV[k] !== undefined) process.env[k] = SAVED_ENV[k] as string;
  }
});

// Gap 3: detection cascade for retriever URL + bucket.

test('resolveRetriever: empty env returns no backend with trace', async () => {
  // Point HOME somewhere empty so the terraform-state path can't match
  // against a real ~/.log10x/ on the developer box.
  process.env.HOME = '/tmp/nonexistent-retriever-autodetect-test';
  const res = await resolveRetriever();
  assert.equal(res.url, undefined);
  assert.equal(res.bucket, undefined);
  const paths = res.trace.map((t) => t.path);
  assert.ok(paths.includes('explicit_env'));
  assert.ok(paths.includes('terraform_state'));
});

test('resolveRetriever: explicit __SAVE_LOG10X_RETRIEVER_URL__ + BUCKET wins', async () => {
  process.env.__SAVE_LOG10X_RETRIEVER_URL__ = 'https://retriever.example.com/';
  process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__ = 'my-archive-bucket';
  process.env.__SAVE_LOG10X_RETRIEVER_TARGET__ = 'my-target';
  const res = await resolveRetriever();
  assert.equal(res.detectionPath, 'explicit_env');
  assert.equal(res.url, 'https://retriever.example.com');
  assert.equal(res.bucket, 'my-archive-bucket');
  assert.equal(res.target, 'my-target');
});

test('resolveRetriever: half-configured explicit env reports skipped', async () => {
  process.env.__SAVE_LOG10X_RETRIEVER_URL__ = 'https://retriever.example.com';
  process.env.HOME = '/tmp/nonexistent-retriever-autodetect-test';
  const res = await resolveRetriever();
  const explicit = res.trace.find((t) => t.path === 'explicit_env');
  assert.ok(explicit);
  assert.equal(explicit!.status, 'skipped');
  assert.match(explicit!.reason, /only one of/);
});

test('resolveRetriever: terraform state produces url + bucket', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tempHome = mkdtempSync(join(tmpdir(), 'retriever-autodetect-'));
  const cfgDir = join(tempHome, '.log10x');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'retriever.tfstate'),
    JSON.stringify({
      outputs: {
        retriever_url: { value: 'https://tf.retriever.example.com/' },
        retriever_bucket: { value: 'tf-archive-bucket' },
        retriever_target: { value: 'tf-target' },
      },
    }),
  );
  process.env.HOME = tempHome;
  const res = await resolveRetriever();
  assert.equal(res.detectionPath, 'terraform_state');
  assert.equal(res.url, 'https://tf.retriever.example.com');
  assert.equal(res.bucket, 'tf-archive-bucket');
  assert.equal(res.target, 'tf-target');
});

test('resolveRetriever: LOG10X_TERRAFORM_STATE override is honored', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'retriever-tfs-'));
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
  const res = await resolveRetriever();
  assert.equal(res.detectionPath, 'terraform_state');
  assert.equal(res.url, 'https://qh.example.com');
  assert.equal(res.bucket, 'override-bucket');
});
