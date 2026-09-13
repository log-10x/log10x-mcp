/**
 * Offload object-store dispatch — one lister, two backends.
 *
 * The read side of the offload loop (retriever probe, offload-delivery
 * verifier, doctor) has always shelled out to `aws s3api`. An env-config
 * destination of `type: "azure_blob"` therefore surfaced as an AWS CLI
 * failure, with a remedy telling the operator to fix IAM on a bucket that
 * does not exist. That is the defect this module closes: callers name the
 * store by its destination type and get the matching CLI, the matching URI
 * in every message, and a remedy phrased in that store's own vocabulary.
 *
 * Convention mirrors the AWS side deliberately: `execFile` on the vendor CLI
 * with a JSON output flag, a bounded `maxBuffer`, and a bounded timeout. No
 * SDK is added — `@azure/storage-blob` is not a dependency of this package,
 * and the probe/verifier/doctor paths already assume a CLI on PATH.
 *
 * Azure authentication follows the accessor's own order of preference. The
 * first call runs `--auth-mode login`, which uses whatever the `az` CLI is
 * already signed in as: an interactive login, an AKS workload identity, or a
 * service principal from `az login --service-principal`. When that call fails
 * and the environment carries an explicit storage credential
 * (`AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_KEY`,
 * `AZURE_STORAGE_SAS_TOKEN`), the call is retried once with it. An
 * environment holding only an account key therefore still works, and a signed
 * in operator is never forced to export one.
 *
 * Write support is out of scope here: the offload WRITE path for Azure Blob
 * does not exist (`offload-recipes.ts` emits S3 sinks only). This module is
 * the read side.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** The offload destination types this module can read. */
export type ObjectStoreKind = 's3' | 'azure_blob';

/**
 * Where offloaded objects live. `container` is the S3 bucket name or the
 * Azure Blob container name; `storageAccount` names the Azure account that
 * holds the container and is required when `kind` is `azure_blob`.
 */
export interface ObjectStoreTarget {
  kind: ObjectStoreKind;
  container: string;
  storageAccount?: string;
}

/** One listed object. Field names match the S3 shape the callers already read. */
export interface StoreObjectMeta {
  Key: string;
  Size?: number;
  LastModified?: string;
}

/** The env vars carrying an explicit Azure storage credential, in preference order. */
const AZURE_CREDENTIAL_ENV = [
  'AZURE_STORAGE_CONNECTION_STRING',
  'AZURE_STORAGE_KEY',
  'AZURE_STORAGE_SAS_TOKEN',
] as const;

/**
 * Build a target from an env-config offload destination. `gcs` and `file`
 * destinations have no lister here and return undefined, so a caller can skip
 * rather than read them through the wrong CLI.
 */
export function objectStoreTargetFrom(dest: {
  type?: string;
  bucket?: string;
  storage_account?: string;
} | undefined, fallbackContainer?: string): ObjectStoreTarget | undefined {
  const container = dest?.bucket ?? fallbackContainer;
  if (!container) return undefined;
  const type = dest?.type ?? 's3';
  if (type === 'azure_blob') {
    return { kind: 'azure_blob', container, storageAccount: dest?.storage_account };
  }
  if (type === 's3') return { kind: 's3', container };
  return undefined;
}

/** The address an operator can paste into their own CLI. */
export function storeUri(target: ObjectStoreTarget, prefix = ''): string {
  if (target.kind === 'azure_blob') {
    const account = target.storageAccount ?? '<storage-account>';
    return `https://${account}.blob.core.windows.net/${target.container}/${prefix}`;
  }
  return `s3://${target.container}/${prefix}`;
}

/** The CLI the caller would run by hand to see the same listing. */
export function storeListCommand(target: ObjectStoreTarget, prefix = ''): string {
  if (target.kind === 'azure_blob') {
    return (
      `az storage blob list --account-name ${target.storageAccount ?? '<storage-account>'} ` +
      `--container-name ${target.container} --prefix '${prefix}' --auth-mode login -o table`
    );
  }
  return `aws s3 ls s3://${target.container}/${prefix}`;
}

/**
 * The remedy for a failed read, in the store's own vocabulary. The Azure
 * branch names data-plane blob roles, never IAM: an Azure operator has no IAM
 * to grant, and an IAM remedy sends them looking for a control that does not
 * exist on their account.
 */
export function storeReadAccessRemedy(target: ObjectStoreTarget): string {
  if (target.kind === 'azure_blob') {
    return (
      `Give the identity the reader role on the blob data plane ` +
      `("Storage Blob Data Reader" on the storage account or the container), sign the CLI in with ` +
      `\`az login\` (AKS workload identity and \`az login --service-principal\` both satisfy ` +
      `\`--auth-mode login\`), or export AZURE_STORAGE_KEY / AZURE_STORAGE_CONNECTION_STRING / ` +
      `AZURE_STORAGE_SAS_TOKEN. Check by hand with \`${storeListCommand(target)}\`.`
    );
  }
  return (
    `Grant AWS credentials with s3:ListBucket + s3:GetObject on the bucket, or verify manually ` +
    `with \`${storeListCommand(target)}\`.`
  );
}

/** Azure CLI args for the credential in the environment, or null when none is set. */
function azureCredentialArgs(env: NodeJS.ProcessEnv = process.env): string[] | null {
  for (const name of AZURE_CREDENTIAL_ENV) {
    const value = env[name];
    if (!value) continue;
    if (name === 'AZURE_STORAGE_CONNECTION_STRING') return ['--connection-string', value];
    if (name === 'AZURE_STORAGE_KEY') return ['--account-key', value];
    return ['--sas-token', value];
  }
  return null;
}

function requireAccount(target: ObjectStoreTarget): string {
  if (!target.storageAccount) {
    throw new Error(
      'Azure Blob offload destination has no storage_account. Set it on the env-config destination ' +
        '(log10x_offload_add takes `storage_account`) or export LOG10X_OFFLOAD_STORAGE_ACCOUNT.',
    );
  }
  return target.storageAccount;
}

/** Run `az`, once under `--auth-mode login` and once more with an explicit credential. */
async function runAz(baseArgs: string[], maxBuffer: number, timeout: number): Promise<string> {
  try {
    const { stdout } = await execFileP('az', [...baseArgs, '--auth-mode', 'login'], {
      maxBuffer,
      timeout,
    });
    return stdout;
  } catch (loginErr) {
    const credential = azureCredentialArgs();
    if (!credential) throw loginErr;
    const { stdout } = await execFileP('az', [...baseArgs, ...credential], { maxBuffer, timeout });
    return stdout;
  }
}

function azStderr(e: unknown): string {
  return ((e as { stderr?: string; message?: string }).stderr ?? (e as Error).message ?? '').trim();
}

/** One entry as `az storage blob list --output json` returns it. */
interface AzBlobEntry {
  name?: string;
  properties?: { lastModified?: string; contentLength?: number };
}

async function listAzureBlobs(
  target: ObjectStoreTarget,
  prefix: string,
): Promise<StoreObjectMeta[]> {
  const account = requireAccount(target);
  const args = [
    'storage', 'blob', 'list',
    '--account-name', account,
    '--container-name', target.container,
    '--prefix', prefix,
    // '*' is the CLI's own "no page limit" token; without it the listing
    // stops at 5000 and a busy container reads as smaller than it is.
    '--num-results', '*',
    '--only-show-errors',
    '--output', 'json',
  ];
  let stdout: string;
  try {
    stdout = await runAz(args, 32 * 1024 * 1024, 20_000);
  } catch (e) {
    const stderr = azStderr(e);
    if (/ContainerNotFound|The specified container does not exist/i.test(stderr)) {
      throw new Error(`offload container does not exist: ${storeUri(target)}`);
    }
    throw new Error(`az storage blob list failed: ${stderr.slice(0, 300)}`);
  }
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout) as AzBlobEntry[];
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((b): b is AzBlobEntry & { name: string } => typeof b.name === 'string')
    .map(b => ({
      Key: b.name,
      ...(b.properties?.contentLength !== undefined ? { Size: b.properties.contentLength } : {}),
      ...(b.properties?.lastModified !== undefined
        ? { LastModified: b.properties.lastModified }
        : {}),
    }));
}

async function listS3Objects(
  target: ObjectStoreTarget,
  prefix: string,
): Promise<StoreObjectMeta[]> {
  // `aws s3api list-objects-v2` AUTO-PAGINATES (the CLI follows
  // NextContinuationToken internally and merges all pages). Do NOT add a
  // manual token loop. The ceiling is maxBuffer.
  let stdout: string;
  try {
    const res = await execFileP(
      'aws',
      ['s3api', 'list-objects-v2', '--bucket', target.container, '--prefix', prefix, '--output', 'json'],
      { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 },
    );
    stdout = res.stdout;
  } catch (e) {
    const stderr = azStderr(e);
    if (stderr.includes('NoSuchBucket')) {
      throw new Error(`offload bucket does not exist: ${target.container}`);
    }
    throw new Error(`aws s3api list-objects-v2 failed: ${stderr.slice(0, 300)}`);
  }
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout) as { Contents?: StoreObjectMeta[] };
  return parsed.Contents ?? [];
}

/** List objects under `prefix`. Throws on a store-level error (missing container, denied read). */
export async function listStoreObjects(
  target: ObjectStoreTarget,
  prefix: string,
): Promise<StoreObjectMeta[]> {
  return target.kind === 'azure_blob'
    ? listAzureBlobs(target, prefix)
    : listS3Objects(target, prefix);
}

/** Fetch one object's body as text. */
export async function getStoreObject(target: ObjectStoreTarget, key: string): Promise<string> {
  if (target.kind === 'azure_blob') {
    const account = requireAccount(target);
    // `--output none` keeps the CLI's own property JSON off stdout, so the
    // only bytes on the stream are the blob body.
    return runAz(
      [
        'storage', 'blob', 'download',
        '--account-name', account,
        '--container-name', target.container,
        '--name', key,
        '--file', '/dev/stdout',
        '--no-progress',
        '--only-show-errors',
        '--output', 'none',
      ],
      64 * 1024 * 1024,
      15_000,
    );
  }
  const { stdout } = await execFileP('aws', ['s3', 'cp', `s3://${target.container}/${key}`, '-'], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10_000,
  });
  return stdout;
}
