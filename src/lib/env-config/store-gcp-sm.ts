/**
 * GCP Secret Manager implementation of EnvConfigStore.
 *
 * Each environment is persisted as its own secret resource:
 *
 *     projects/${project}/secrets/log10x-env-config-${env_id}
 *
 * Secret Manager does not allow in-place mutation — writes always create a
 * new SecretVersion under the secret. Reads always access `/versions/latest`,
 * so the most recent write wins. The first write for a given env_id creates
 * the secret itself (idempotently — an existing secret is reused).
 *
 * Discovery (`list`) uses `listSecrets` with a `name~` regex filter so we
 * only walk our own resources, not every secret in the project.
 *
 * Auth is ambient: the `@google-cloud/secret-manager` SDK picks up
 * `GOOGLE_APPLICATION_CREDENTIALS` (service-account key file) or workload
 * identity in-cluster. The project is read from `LOG10X_GCP_PROJECT` first
 * (so a customer can pin a non-default project) and falls back to
 * `GOOGLE_CLOUD_PROJECT`.
 *
 * `isAvailable` is intentionally cheap: it only checks that the SDK is
 * importable and that the basic credential + project signals are present.
 * It does NOT issue an API call — the resolver tries every store on every
 * read, so an RPC on each availability check would be a per-tool tax.
 */

import type { EnvConfigStore, StoreKind } from './store-interface.js';
import { environmentConfigSchema, type EnvironmentConfig } from './types.js';

const SECRET_NAME_PREFIX = 'log10x-env-config-';

function secretId(envId: string): string {
  return `${SECRET_NAME_PREFIX}${envId}`;
}

function secretResourceName(project: string, envId: string): string {
  return `projects/${project}/secrets/${secretId(envId)}`;
}

function projectParent(project: string): string {
  return `projects/${project}`;
}

function resolveProject(): string | null {
  return (
    process.env.LOG10X_GCP_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    null
  );
}

function hasAmbientCredentials(): boolean {
  // Workload identity / GCE metadata server: no env var is required at the
  // process level — the SDK reaches the metadata endpoint on first call.
  // We treat the presence of GOOGLE_CLOUD_PROJECT (or LOG10X_GCP_PROJECT)
  // plus the absence of an explicit credentials file as "workload identity
  // is likely available." If it isn't, the first RPC will fail loudly and
  // the resolver will record it.
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return true;
  if (process.env.GCE_METADATA_HOST) return true;
  // K8s workload identity hints — these are set by the GKE node agent.
  if (process.env.GKE_METADATA_SERVER) return true;
  // Fall back to "assume workload identity" when running in-cluster with a
  // project pinned. Cheaper than a metadata probe on every availability check.
  return Boolean(resolveProject());
}

export class GcpSecretManagerStore implements EnvConfigStore {
  public readonly kind: StoreKind = 'gcp_sm';

  /**
   * Optional injected client (for tests). Production callers leave this
   * undefined; the store lazily constructs a `SecretManagerServiceClient` on
   * first use.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private clientPromise: Promise<any> | null = null;
  private cachedProject: string | null = null;

  constructor(
    private readonly opts: {
      project?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory?: () => Promise<any>;
    } = {},
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        if (this.opts.clientFactory) {
          return this.opts.clientFactory();
        }
        const mod = await import('@google-cloud/secret-manager');
        const Ctor = mod.SecretManagerServiceClient;
        return new Ctor();
      })();
    }
    return this.clientPromise;
  }

  private getProject(): string | null {
    if (this.cachedProject) return this.cachedProject;
    const project = this.opts.project || resolveProject();
    if (project) this.cachedProject = project;
    return project;
  }

  async isAvailable(): Promise<{ available: boolean; reason: string }> {
    // SDK importable?
    try {
      await import('@google-cloud/secret-manager');
    } catch (err) {
      return {
        available: false,
        reason: `@google-cloud/secret-manager not importable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    // Project pinned?
    const project = this.getProject();
    if (!project) {
      return {
        available: false,
        reason:
          'no GCP project: set LOG10X_GCP_PROJECT or GOOGLE_CLOUD_PROJECT (or pass `project` to the store).',
      };
    }

    // Credentials reachable?
    if (!hasAmbientCredentials()) {
      return {
        available: false,
        reason:
          'no GCP credentials: set GOOGLE_APPLICATION_CREDENTIALS or run under workload identity.',
      };
    }

    return { available: true, reason: `gcp_sm ready (project=${project})` };
  }

  async read(envIdOrNickname: string): Promise<EnvironmentConfig | null> {
    const project = this.getProject();
    if (!project) {
      throw new Error('GcpSecretManagerStore.read: no GCP project resolved.');
    }
    const client = await this.getClient();

    // Fast path: treat the argument as an env_id directly.
    const direct = await this.readByEnvId(client, project, envIdOrNickname);
    if (direct) return direct;

    // Slow path: walk secrets to find a matching nickname. `list()` already
    // does the secret discovery + JSON parse; piggy-back on it rather than
    // duplicating the loop.
    const all = await this.list();
    return (
      all.find(
        c => c.env_id === envIdOrNickname || c.nickname === envIdOrNickname,
      ) ?? null
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async readByEnvId(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    project: string,
    envId: string,
  ): Promise<EnvironmentConfig | null> {
    const name = `${secretResourceName(project, envId)}/versions/latest`;
    try {
      const [response] = await client.accessSecretVersion({ name });
      const data = response?.payload?.data;
      if (!data) return null;
      const text =
        typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      const parsed = JSON.parse(text);
      // Validate so we never hand back a half-baked document.
      return environmentConfigSchema.parse(parsed);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async write(config: EnvironmentConfig): Promise<void> {
    const project = this.getProject();
    if (!project) {
      throw new Error('GcpSecretManagerStore.write: no GCP project resolved.');
    }
    const client = await this.getClient();

    // Stamp updated_at if the caller didn't (per interface contract).
    const doc: EnvironmentConfig = {
      ...config,
      updated_at: config.updated_at ?? new Date().toISOString(),
    };
    // Validate before persisting — refuse to write a bad document.
    environmentConfigSchema.parse(doc);

    const parent = secretResourceName(project, doc.env_id);

    // Ensure the secret exists. createSecret throws ALREADY_EXISTS on
    // collision — treat that as success.
    try {
      await client.createSecret({
        parent: projectParent(project),
        secretId: secretId(doc.env_id),
        secret: {
          replication: { automatic: {} },
        },
      });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }

    // Add a new version with the JSON payload. Secret Manager versions are
    // immutable, so a write is always an append.
    await client.addSecretVersion({
      parent,
      payload: {
        data: Buffer.from(JSON.stringify(doc), 'utf8'),
      },
    });
  }

  async list(): Promise<EnvironmentConfig[]> {
    const project = this.getProject();
    if (!project) {
      throw new Error('GcpSecretManagerStore.list: no GCP project resolved.');
    }
    const client = await this.getClient();

    // `name~` is the regex-match operator in Secret Manager's filter syntax.
    // Anchor on the prefix so we don't get incidental matches from other
    // tooling that happens to embed our string mid-name.
    const filter = `name~"${SECRET_NAME_PREFIX}"`;

    const results: EnvironmentConfig[] = [];

    // Prefer the async iterator — it pages internally and avoids a giant
    // single response. Fall back to listSecrets() if the iterator isn't
    // available (older SDK builds).
    const iterable =
      typeof client.listSecretsAsync === 'function'
        ? client.listSecretsAsync({ parent: projectParent(project), filter })
        : null;

    if (iterable) {
      for await (const secret of iterable as AsyncIterable<{ name?: string }>) {
        const envId = extractEnvIdFromSecretName(secret.name);
        if (!envId) continue;
        const doc = await this.readByEnvId(client, project, envId);
        if (doc) results.push(doc);
      }
    } else {
      const [secrets] = await client.listSecrets({
        parent: projectParent(project),
        filter,
      });
      for (const secret of secrets as Array<{ name?: string }>) {
        const envId = extractEnvIdFromSecretName(secret.name);
        if (!envId) continue;
        const doc = await this.readByEnvId(client, project, envId);
        if (doc) results.push(doc);
      }
    }

    return results;
  }

  async delete(envId: string): Promise<void> {
    const project = this.getProject();
    if (!project) {
      throw new Error('GcpSecretManagerStore.delete: no GCP project resolved.');
    }
    const client = await this.getClient();

    try {
      await client.deleteSecret({ name: secretResourceName(project, envId) });
    } catch (err) {
      if (isNotFound(err)) return; // idempotent delete
      throw err;
    }
  }
}

/**
 * Parse the trailing `${env_id}` out of `projects/.../secrets/log10x-env-config-<env_id>`.
 * Returns null when the name doesn't match our naming scheme — defensive against
 * the filter syntax silently widening on an SDK upgrade.
 */
function extractEnvIdFromSecretName(name: string | null | undefined): string | null {
  if (!name) return null;
  const slash = name.lastIndexOf('/');
  const tail = slash >= 0 ? name.slice(slash + 1) : name;
  if (!tail.startsWith(SECRET_NAME_PREFIX)) return null;
  const envId = tail.slice(SECRET_NAME_PREFIX.length);
  return envId.length > 0 ? envId : null;
}

/**
 * gRPC error code 5 = NOT_FOUND. Secret Manager surfaces these as gax errors
 * with a `.code` numeric property; some wrappers also stringify the status
 * onto `.message`. Check both so we degrade gracefully across SDK versions.
 */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  if (e.code === 5) return true;
  if (typeof e.message === 'string' && /NOT_FOUND|not found/i.test(e.message)) {
    return true;
  }
  return false;
}

/**
 * gRPC error code 6 = ALREADY_EXISTS. Used to make createSecret idempotent.
 */
function isAlreadyExists(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  if (e.code === 6) return true;
  if (typeof e.message === 'string' && /ALREADY_EXISTS|already exists/i.test(e.message)) {
    return true;
  }
  return false;
}
