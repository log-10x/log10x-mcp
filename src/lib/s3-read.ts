/**
 * S3 reads for the retriever poller and the offload verifiers: the `aws` CLI
 * when it is on PATH, the SDK when it is not.
 *
 * Every read path shelled out to `aws s3api list-objects-v2` and `aws s3 cp`.
 * That is right on an operator's machine, where the CLI already holds the
 * profile, the SSO session and the region, and wrong in a container built
 * without it: the public demo MCP image is deliberately minimal, so on ECS a
 * query submitted (the Function URL is signed in-process) and the poll for
 * its results died on ENOENT. A missing binary now falls through to
 * `@aws-sdk/client-s3` on the default credential chain (task role, instance
 * profile, environment), the same chain the URL signer uses.
 *
 * Only a missing binary falls through. A CLI that is present and fails
 * (denied, no such bucket, expired session) reports its own error, because
 * the SDK would fail the same way with less to say. `LOG10X_S3_CLIENT=sdk`
 * or `=cli` forces one side.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

const execFileP = promisify(execFile);

/** One listed object, in the shape the CLI's JSON gives and the callers read. */
export interface S3ObjectMeta {
  Key: string;
  Size?: number;
  LastModified?: string;
}

/** The subset of S3Client the reads use, so a test can stand one in. */
export interface S3SendClient {
  send(command: unknown): Promise<unknown>;
}

type ClientFactory = (region: string | undefined) => S3SendClient;

let clientFactory: ClientFactory = (region) => new S3Client(region ? { region } : {});
let cachedClient: { region: string | undefined; client: S3SendClient } | null = null;

/** Test seam: replace the SDK client. Pass null to restore the real one. */
export function setS3ClientFactoryForTests(factory: ClientFactory | null): void {
  clientFactory = factory ?? ((region) => new S3Client(region ? { region } : {}));
  cachedClient = null;
}

function sdkClient(): S3SendClient {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined;
  if (!cachedClient || cachedClient.region !== region) {
    cachedClient = { region, client: clientFactory(region) };
  }
  return cachedClient.client;
}

type Side = 'cli' | 'sdk';

function forcedSide(): Side | null {
  const v = (process.env.LOG10X_S3_CLIENT || '').trim().toLowerCase();
  return v === 'sdk' || v === 'cli' ? v : null;
}

/** True when the CLI could not be started at all, as opposed to having run and failed. */
function cliAbsent(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Runs the CLI form, or the SDK form when the CLI is absent or forced off.
 * `cliArgs` is the full argument list after `aws`.
 */
async function viaCliOrSdk<T>(
  cliArgs: string[],
  cliOpts: { maxBuffer: number; timeout?: number },
  parseCli: (stdout: string) => T,
  viaSdk: () => Promise<T>,
): Promise<T> {
  const forced = forcedSide();
  if (forced === 'sdk') return viaSdk();
  try {
    const { stdout } = await execFileP('aws', cliArgs, cliOpts);
    return parseCli(stdout);
  } catch (e) {
    if (forced !== 'cli' && cliAbsent(e)) {
      return viaSdk();
    }
    throw e;
  }
}

/**
 * List every object under `prefix`. The CLI auto-paginates; the SDK path
 * follows ContinuationToken itself. A bucket that does not exist throws an
 * error whose message carries `NoSuchBucket`, whichever side ran, so callers
 * that match on that text keep working.
 */
export async function s3ListObjects(
  bucket: string,
  prefix: string,
  opts: { maxBuffer?: number; timeout?: number } = {},
): Promise<S3ObjectMeta[]> {
  return viaCliOrSdk(
    ['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix, '--output', 'json'],
    { maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024, ...(opts.timeout ? { timeout: opts.timeout } : {}) },
    (stdout) => {
      // Empty stdout is the CLI's answer for a prefix with no keys.
      if (!stdout.trim()) return [];
      const parsed = JSON.parse(stdout) as { Contents?: S3ObjectMeta[] };
      return parsed.Contents ?? [];
    },
    async () => {
      const out: S3ObjectMeta[] = [];
      let token: string | undefined;
      do {
        let page: {
          Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }>;
          NextContinuationToken?: string;
          IsTruncated?: boolean;
        };
        try {
          page = (await sdkClient().send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
          )) as typeof page;
        } catch (e) {
          throw sdkError(e, `list-objects-v2 s3://${bucket}/${prefix}`);
        }
        for (const c of page.Contents ?? []) {
          if (typeof c.Key !== 'string') continue;
          out.push({
            Key: c.Key,
            ...(typeof c.Size === 'number' ? { Size: c.Size } : {}),
            ...(c.LastModified instanceof Date ? { LastModified: c.LastModified.toISOString() } : {}),
          });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
  );
}

/** One object's body as text (`aws s3 cp s3://bucket/key -`). */
export async function s3GetObjectText(
  bucket: string,
  key: string,
  opts: { maxBuffer?: number; timeout?: number } = {},
): Promise<string> {
  return viaCliOrSdk(
    ['s3', 'cp', `s3://${bucket}/${key}`, '-'],
    { maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, ...(opts.timeout ? { timeout: opts.timeout } : {}) },
    (stdout) => stdout,
    async () => {
      let res: { Body?: { transformToString(): Promise<string> } };
      try {
        res = (await sdkClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }))) as typeof res;
      } catch (e) {
        throw sdkError(e, `get-object s3://${bucket}/${key}`);
      }
      return res.Body ? res.Body.transformToString() : '';
    },
  );
}

/** Names of the buckets the credentials can list (`aws s3api list-buckets`). */
export async function s3ListBuckets(opts: { timeout?: number } = {}): Promise<string[]> {
  return viaCliOrSdk(
    ['s3api', 'list-buckets', '--output', 'json'],
    { maxBuffer: 8 * 1024 * 1024, ...(opts.timeout ? { timeout: opts.timeout } : {}) },
    (stdout) => {
      const parsed = JSON.parse(stdout) as { Buckets?: Array<{ Name: string }> };
      return (parsed.Buckets ?? []).map((b) => b.Name);
    },
    async () => {
      let res: { Buckets?: Array<{ Name?: string }> };
      try {
        res = (await sdkClient().send(new ListBucketsCommand({}))) as typeof res;
      } catch (e) {
        throw sdkError(e, 'list-buckets');
      }
      return (res.Buckets ?? []).map((b) => b.Name).filter((n): n is string => typeof n === 'string');
    },
  );
}

/**
 * An SDK failure in the shape the CLI callers already parse: the service's
 * error code (`NoSuchBucket`, `AccessDenied`) leads the message, and the
 * `stderr` field carries it too, since the callers read `err.stderr` first.
 */
function sdkError(e: unknown, what: string): Error {
  const err = e as { name?: string; message?: string };
  const code = err?.name && err.name !== 'Error' ? err.name : '';
  const text = `${code ? code + ': ' : ''}${err?.message ?? String(e)}`;
  const out = new Error(`aws sdk ${what} failed: ${text}`) as Error & { stderr?: string };
  out.stderr = text;
  return out;
}
