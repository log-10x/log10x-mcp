/**
 * s3-read: the aws CLI when it is on PATH, the SDK when it is not.
 *
 * The public demo MCP image carries no CLI, so the retriever poll used to die
 * on ENOENT after the query had been submitted. These tests drive both sides
 * through a fake `aws` on PATH and a stand-in SDK client, and the fall-through
 * between them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  s3GetObjectText,
  s3ListBuckets,
  s3ListObjects,
  setS3ClientFactoryForTests,
} from '../src/lib/s3-read.js';

/** A PATH holding only `dir`, so `aws` resolves to what the test put there or to nothing. */
function withPath(dir: string, fn: () => Promise<void>): Promise<void> {
  const saved = process.env.PATH;
  process.env.PATH = dir;
  return fn().finally(() => {
    process.env.PATH = saved;
  });
}

function withEnv(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return fn().finally(() => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  });
}

/** A stand-in SDK client that answers ListObjectsV2 in two pages and GetObject with text. */
function fakeSdk(calls: string[]) {
  return {
    async send(command: unknown): Promise<unknown> {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      calls.push(name);
      if (name === 'ListObjectsV2Command') {
        if (!input.ContinuationToken) {
          return {
            Contents: [{ Key: 'qr/a.jsonl', Size: 10, LastModified: new Date('2026-09-28T00:00:00Z') }],
            IsTruncated: true,
            NextContinuationToken: 'p2',
          };
        }
        return { Contents: [{ Key: 'qr/b.jsonl', Size: 20 }], IsTruncated: false };
      }
      if (name === 'GetObjectCommand') {
        return { Body: { transformToString: async () => `body of ${String(input.Key)}` } };
      }
      if (name === 'ListBucketsCommand') {
        return { Buckets: [{ Name: 'log10x-retriever-x' }, { Name: 'other' }] };
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
}

test('s3-read: with no aws on PATH the SDK answers, following the continuation token', async () => {
  const empty = mkdtempSync(join(tmpdir(), 's3-read-nocli-'));
  const calls: string[] = [];
  setS3ClientFactoryForTests(() => fakeSdk(calls));
  try {
    await withEnv('LOG10X_S3_CLIENT', undefined, () =>
      withPath(empty, async () => {
        const listed = await s3ListObjects('bkt', 'qr/');
        assert.deepEqual(listed, [
          { Key: 'qr/a.jsonl', Size: 10, LastModified: '2026-09-28T00:00:00.000Z' },
          { Key: 'qr/b.jsonl', Size: 20 },
        ]);
        assert.equal(await s3GetObjectText('bkt', 'qr/a.jsonl'), 'body of qr/a.jsonl');
        assert.deepEqual(await s3ListBuckets(), ['log10x-retriever-x', 'other']);
      }),
    );
    assert.deepEqual(calls, [
      'ListObjectsV2Command',
      'ListObjectsV2Command',
      'GetObjectCommand',
      'ListBucketsCommand',
    ]);
  } finally {
    setS3ClientFactoryForTests(null);
    rmSync(empty, { recursive: true, force: true });
  }
});

test('s3-read: an aws on PATH is preferred and the SDK is never touched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's3-read-cli-'));
  const fake = join(dir, 'aws');
  writeFileSync(
    fake,
    [
      '#!/bin/sh',
      // list-objects-v2 -> two keys; s3 cp -> the key name; list-buckets -> one bucket
      'case "$1 $2" in',
      '  "s3api list-objects-v2") echo \'{"Contents":[{"Key":"qr/c.jsonl","Size":3},{"Key":"qr/d.jsonl","Size":4}]}\' ;;',
      '  "s3 cp") printf "cli body of %s" "$3" ;;',
      '  "s3api list-buckets") echo \'{"Buckets":[{"Name":"from-cli"}]}\' ;;',
      '  *) echo "unexpected: $*" >&2; exit 2 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(fake, 0o755);
  const calls: string[] = [];
  setS3ClientFactoryForTests(() => fakeSdk(calls));
  try {
    await withEnv('LOG10X_S3_CLIENT', undefined, () =>
      withPath(dir, async () => {
        assert.deepEqual(await s3ListObjects('bkt', 'qr/'), [
          { Key: 'qr/c.jsonl', Size: 3 },
          { Key: 'qr/d.jsonl', Size: 4 },
        ]);
        assert.equal(await s3GetObjectText('bkt', 'qr/c.jsonl'), 'cli body of s3://bkt/qr/c.jsonl');
        assert.deepEqual(await s3ListBuckets(), ['from-cli']);
      }),
    );
    assert.deepEqual(calls, [], 'the SDK stand-in must not be called while the CLI is present');
  } finally {
    setS3ClientFactoryForTests(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('s3-read: a CLI that is present and fails is not retried through the SDK', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's3-read-clifail-'));
  const fake = join(dir, 'aws');
  writeFileSync(fake, '#!/bin/sh\necho "An error occurred (NoSuchBucket) when calling the ListObjectsV2 operation" >&2\nexit 254\n');
  chmodSync(fake, 0o755);
  const calls: string[] = [];
  setS3ClientFactoryForTests(() => fakeSdk(calls));
  try {
    await withEnv('LOG10X_S3_CLIENT', undefined, () =>
      withPath(dir, async () => {
        await assert.rejects(
          () => s3ListObjects('missing', 'qr/'),
          (e: unknown) => /NoSuchBucket/.test(String((e as { stderr?: string }).stderr ?? (e as Error).message)),
        );
      }),
    );
    assert.deepEqual(calls, []);
  } finally {
    setS3ClientFactoryForTests(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('s3-read: LOG10X_S3_CLIENT=sdk skips a CLI that is present, and an SDK failure carries the code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's3-read-force-'));
  const fake = join(dir, 'aws');
  writeFileSync(fake, '#!/bin/sh\necho "{\\"Contents\\":[]}"\n');
  chmodSync(fake, 0o755);
  const calls: string[] = [];
  setS3ClientFactoryForTests(() => ({
    async send(command: unknown): Promise<unknown> {
      calls.push((command as { constructor: { name: string } }).constructor.name);
      const err = new Error('The specified bucket does not exist');
      err.name = 'NoSuchBucket';
      throw err;
    },
  }));
  try {
    await withEnv('LOG10X_S3_CLIENT', 'sdk', () =>
      withPath(dir, async () => {
        await assert.rejects(
          () => s3ListObjects('missing', 'qr/'),
          (e: unknown) => /NoSuchBucket/.test(String((e as { stderr?: string }).stderr)),
        );
      }),
    );
    assert.deepEqual(calls, ['ListObjectsV2Command']);
  } finally {
    setS3ClientFactoryForTests(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
