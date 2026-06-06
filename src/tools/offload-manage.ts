/**
 * log10x_offload_add + log10x_offload_archive — manage the
 * `offload_destinations[]` list inside an environment's env-config document.
 *
 * These two tools are the in-MCP surface for editing the env document the
 * Receiver consults when it routes the `isDropped` slice. They share a single
 * load/mutate/write helper and so live in one file:
 *
 *   - `log10x_offload_add` appends a new destination (s3 / gcs / azure_blob /
 *     file) to the list. Defaults `status` to `active`. A second `active`
 *     destination is allowed — multi-target offload (e.g. draining a legacy
 *     bucket while a new one is primary) is the documented use case the
 *     schema array exists to support.
 *
 *   - `log10x_offload_archive` flips one destination's `status` to `archived`
 *     and stamps `archived_at`. Refuses the operation when the target is the
 *     ONLY remaining active destination — the Receiver requires at least one
 *     active bucket to route the dropped slice to, and archiving the last
 *     active entry would silently strand offload traffic. The user is told
 *     which other destinations need to be activated first.
 *
 * Both tools resolve env-config from the same precedence chain the resolver
 * walks (k8s → AWS SSM → GCP Secret Manager → Azure App Config → local file),
 * and write back to the SAME store the document was read from so a customer's
 * source-of-truth store stays the source of truth.
 */

import { z } from 'zod';
import {
  environmentConfigSchema,
  offloadDestinationSchema,
  type EnvironmentConfig,
  type OffloadDestination,
} from '../lib/env-config/types.js';
import type { EnvConfigStore } from '../lib/env-config/store-interface.js';
import { K8sConfigMapStore } from '../lib/env-config/store-k8s.js';
import { AwsSsmStore } from '../lib/env-config/store-aws-ssm.js';
import { GcpSecretManagerStore } from '../lib/env-config/store-gcp-sm.js';
import { AzureAppConfigStore } from '../lib/env-config/store-azure-ac.js';
import { LocalFileStore } from '../lib/env-config/store-local-file.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const offloadTypeSchema = z.enum(['s3', 'gcs', 'azure_blob', 'file']);
const offloadStatusSchema = z.enum(['active', 'draining', 'archived', 'failed']);
const offloadAuthSchema = z.object({
  method: z.enum([
    'irsa',
    'iam_role',
    'workload_identity',
    'service_principal',
    'access_key',
    'connection_string',
    'none',
  ]),
  role: z.string().optional(),
  sa: z.string().optional(),
  note: z.string().optional(),
});

export const offloadAddSchema = {
  env_id: z
    .string()
    .min(1)
    .describe(
      'env_id (UUID) OR nickname of the environment whose env-config document should be edited. Resolved through the same store chain (k8s ConfigMap → AWS SSM → GCP Secret Manager → Azure App Config → local file) the resolver uses; the write goes back to the same store the document was read from.'
    ),
  nickname: z
    .string()
    .min(1)
    .describe(
      'Human-readable label for this destination (e.g. "primary", "regional_us", "legacy_streamer"). Must be unique within the env\'s offload_destinations list — adding a destination with a nickname already in use is refused (use log10x_offload_archive on the old one first if you want to recycle the label).'
    ),
  type: offloadTypeSchema.describe(
    'Destination kind. `s3` / `gcs` / `azure_blob` are object stores; `file` is a local-path drop used for dev / on-prem appliances.'
  ),
  bucket: z
    .string()
    .optional()
    .describe('Bucket name (required for s3 / gcs / azure_blob).'),
  prefix: z
    .string()
    .optional()
    .describe(
      'Key prefix under the bucket. The Receiver writes objects at `{bucket}/{prefix}/...`; the Retriever\'s S3->SQS notification must fan recursively under this prefix.'
    ),
  region: z
    .string()
    .optional()
    .describe('AWS / Azure region (s3 / azure_blob).'),
  auth: offloadAuthSchema
    .optional()
    .describe(
      'How the Receiver authenticates to the destination. Omit to defer to the cloud-default identity (IRSA on EKS, workload identity on GKE, managed identity on AKS, ambient credentials elsewhere).'
    ),
  status: offloadStatusSchema
    .optional()
    .describe(
      'Initial status. Defaults to `active`. Set `draining` if you are adding a destination that is being read but no longer written to — the Retriever will still scan it but the Receiver will not target new writes there.'
    ),
};

export const offloadArchiveSchema = {
  env_id: z
    .string()
    .min(1)
    .describe(
      'env_id (UUID) OR nickname of the environment whose env-config document should be edited.'
    ),
  nickname: z
    .string()
    .min(1)
    .describe(
      'Nickname of the offload destination to archive. Must match exactly (case-sensitive). The destination is flipped to `status: "archived"` with `archived_at` stamped; the entry is NOT deleted so it stays available as a historical reference (e.g. for retroactive Retriever scans).'
    ),
  archived_at: z
    .string()
    .optional()
    .describe(
      'ISO-8601 timestamp to record. Defaults to the current time (`new Date().toISOString()`). Pass an explicit value when you are backfilling the field after an out-of-band archive happened earlier.'
    ),
  note: z
    .string()
    .optional()
    .describe(
      'Free-form note appended to the destination (e.g. "rotated to primary-us-east-2 2026-06-04"). Stored verbatim on the destination entry; surfaced in subsequent reads of the env document.'
    ),
};

// ── Tool argument types ────────────────────────────────────────────────────

interface OffloadAddArgs {
  env_id: string;
  nickname: string;
  type: 's3' | 'gcs' | 'azure_blob' | 'file';
  bucket?: string;
  prefix?: string;
  region?: string;
  auth?: z.infer<typeof offloadAuthSchema>;
  status?: 'active' | 'draining' | 'archived' | 'failed';
}

interface OffloadArchiveArgs {
  env_id: string;
  nickname: string;
  archived_at?: string;
  note?: string;
}

// ── Store-chain helpers ────────────────────────────────────────────────────

/**
 * Build the default store chain in resolver-order: k8s → AWS SSM → GCP SM →
 * Azure AC → local file. Each store reports `isAvailable: false` on a host
 * that doesn't have the underlying cloud, so the chain is safe to instantiate
 * eagerly — the local file store always wins on a dev laptop.
 */
function defaultStoreChain(): EnvConfigStore[] {
  return [
    new K8sConfigMapStore(),
    new AwsSsmStore(),
    new GcpSecretManagerStore(),
    new AzureAppConfigStore(),
    new LocalFileStore(),
  ];
}

/**
 * Walk the store chain, return the first store that BOTH reports
 * `isAvailable: true` AND has a document for the supplied env_id/nickname.
 * Returns the parsed document and the store it came from so the caller can
 * write back to the same place.
 *
 * Throws a tagged Error with `code` set to one of:
 *   - 'no_stores_available' — every store reported unavailable.
 *   - 'env_not_found'       — at least one store was available but no
 *                             document matched the supplied id/nickname.
 */
async function loadEnvAndStore(
  envIdOrNickname: string,
  stores: EnvConfigStore[] = defaultStoreChain()
): Promise<{ config: EnvironmentConfig; store: EnvConfigStore }> {
  const trace: string[] = [];
  let anyAvailable = false;

  for (const store of stores) {
    const availability = await store.isAvailable();
    if (!availability.available) {
      trace.push(`${store.kind}: skipped (${availability.reason || 'unavailable'})`);
      continue;
    }
    anyAvailable = true;
    let doc: EnvironmentConfig | null = null;
    try {
      doc = await store.read(envIdOrNickname);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      trace.push(`${store.kind}: read failed (${reason})`);
      continue;
    }
    if (!doc) {
      trace.push(`${store.kind}: no document for "${envIdOrNickname}"`);
      continue;
    }
    trace.push(`${store.kind}: matched`);
    return { config: doc, store };
  }

  const traceStr = trace.join('; ');
  if (!anyAvailable) {
    const err = new Error(
      `No env-config store was available (k8s, AWS SSM, GCP Secret Manager, Azure App Config, local file all reported unavailable). Trace: ${traceStr}`
    );
    (err as Error & { code: string }).code = 'no_stores_available';
    throw err;
  }
  const err = new Error(
    `No env-config document found for "${envIdOrNickname}". Trace: ${traceStr}`
  );
  (err as Error & { code: string }).code = 'env_not_found';
  throw err;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Re-validate the mutated document AND persist it. Two passes through the
 * schema guarantees a bug here can't write a partial: the in-memory object is
 * checked first, then `store.write()` parses again on the way to disk.
 */
async function persist(store: EnvConfigStore, config: EnvironmentConfig): Promise<EnvironmentConfig> {
  const stamped: EnvironmentConfig = {
    ...config,
    updated_at: nowIso(),
  };
  const validated = environmentConfigSchema.parse(stamped);
  await store.write(validated);
  return validated;
}

// ── log10x_offload_add ──────────────────────────────────────────────────────

interface AddInner {
  ok: boolean;
  env_id?: string;
  nickname?: string;
  store_kind?: string;
  destination?: OffloadDestination;
  total_destinations?: number;
  active_destinations?: number;
  error?: string;
  error_code?: string;
}

function buildAddHumanSummary(inner: AddInner): string {
  if (!inner.ok) {
    return `offload_add refused: ${inner.error ?? 'unknown reason'}.`;
  }
  const status = inner.destination?.status ?? 'active';
  return (
    `Offload destination "${inner.nickname}" (${inner.destination?.type}) added to env "${inner.env_id}" ` +
    `with status=${status}; ${inner.total_destinations} destination${inner.total_destinations === 1 ? '' : 's'} ` +
    `now configured (${inner.active_destinations} active). Written to ${inner.store_kind} store.`
  );
}

export async function executeOffloadAdd(
  args: OffloadAddArgs,
  storeOverride?: EnvConfigStore[]
): Promise<string | StructuredOutput> {
  const inner = await executeOffloadAddInner(args, storeOverride);
  return buildEnvelope({
    tool: 'log10x_offload_add',
    view: 'summary',
    summary: {
      headline: inner.ok
        ? `Added offload destination "${inner.nickname}" to env "${inner.env_id}" (${inner.total_destinations} total, ${inner.active_destinations} active).`
        : `offload_add refused: ${inner.error ?? 'unknown'}.`,
    },
    data: {
      ok: inner.ok,
      env_id: inner.env_id,
      nickname: inner.nickname,
      store_kind: inner.store_kind,
      destination: inner.destination,
      total_destinations: inner.total_destinations,
      active_destinations: inner.active_destinations,
      error: inner.error,
      error_code: inner.error_code,
      human_summary: buildAddHumanSummary(inner),
    },
  });
}

async function executeOffloadAddInner(
  args: OffloadAddArgs,
  storeOverride?: EnvConfigStore[]
): Promise<AddInner> {
  let loaded: { config: EnvironmentConfig; store: EnvConfigStore };
  try {
    loaded = await loadEnvAndStore(args.env_id, storeOverride);
  } catch (err) {
    const code = (err as Error & { code?: string }).code ?? 'load_failed';
    return { ok: false, error: (err as Error).message, error_code: code };
  }
  const { config, store } = loaded;

  // Nickname collision check — the array is order-sensitive but nicknames
  // must be unique so callers (and the Receiver) can address destinations by
  // label rather than position.
  const collision = config.offload_destinations.find(d => d.nickname === args.nickname);
  if (collision) {
    return {
      ok: false,
      env_id: config.env_id,
      nickname: args.nickname,
      store_kind: store.kind,
      error: `An offload destination named "${args.nickname}" already exists on env "${config.env_id}" (type=${collision.type}, status=${collision.status}). Pick a different nickname, or archive the existing one with log10x_offload_archive first.`,
      error_code: 'nickname_in_use',
    };
  }

  // Build the new destination, default status=active so the Receiver picks
  // it up on the next config refresh.
  const draft: OffloadDestination = {
    nickname: args.nickname,
    type: args.type,
    status: args.status ?? 'active',
    ...(args.bucket !== undefined ? { bucket: args.bucket } : {}),
    ...(args.prefix !== undefined ? { prefix: args.prefix } : {}),
    ...(args.region !== undefined ? { region: args.region } : {}),
    ...(args.auth ? { auth: args.auth } : {}),
    first_used_at: nowIso(),
  };

  // Validate the destination shape early — schema-level type rules (e.g.
  // bucket required for s3/gcs/azure_blob? — not enforced by zod today, but
  // the parse still catches enum / type errors).
  const parsedDest = offloadDestinationSchema.safeParse(draft);
  if (!parsedDest.success) {
    return {
      ok: false,
      env_id: config.env_id,
      nickname: args.nickname,
      store_kind: store.kind,
      error: `Offload destination payload failed schema validation: ${parsedDest.error.issues
        .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
      error_code: 'invalid_destination',
    };
  }

  const mutated: EnvironmentConfig = {
    ...config,
    offload_destinations: [...config.offload_destinations, parsedDest.data],
  };

  let written: EnvironmentConfig;
  try {
    written = await persist(store, mutated);
  } catch (err) {
    return {
      ok: false,
      env_id: config.env_id,
      nickname: args.nickname,
      store_kind: store.kind,
      error: `Failed to persist env-config to ${store.kind} store: ${(err as Error).message}`,
      error_code: 'write_failed',
    };
  }

  const activeCount = written.offload_destinations.filter(d => d.status === 'active').length;
  return {
    ok: true,
    env_id: written.env_id,
    nickname: args.nickname,
    store_kind: store.kind,
    destination: parsedDest.data,
    total_destinations: written.offload_destinations.length,
    active_destinations: activeCount,
  };
}

// ── log10x_offload_archive ──────────────────────────────────────────────────

interface ArchiveInner {
  ok: boolean;
  env_id?: string;
  nickname?: string;
  store_kind?: string;
  destination?: OffloadDestination;
  total_destinations?: number;
  active_destinations?: number;
  archived_at?: string;
  active_destinations_remaining?: string[];
  error?: string;
  error_code?: string;
}

function buildArchiveHumanSummary(inner: ArchiveInner): string {
  if (!inner.ok) {
    return `offload_archive refused: ${inner.error ?? 'unknown reason'}.`;
  }
  return (
    `Offload destination "${inner.nickname}" on env "${inner.env_id}" archived at ${inner.archived_at}; ` +
    `${inner.active_destinations} active destination${inner.active_destinations === 1 ? '' : 's'} ` +
    `remain (${(inner.active_destinations_remaining ?? []).join(', ') || 'none'}). Written to ${inner.store_kind} store.`
  );
}

export async function executeOffloadArchive(
  args: OffloadArchiveArgs,
  storeOverride?: EnvConfigStore[]
): Promise<string | StructuredOutput> {
  const inner = await executeOffloadArchiveInner(args, storeOverride);
  return buildEnvelope({
    tool: 'log10x_offload_archive',
    view: 'summary',
    summary: {
      headline: inner.ok
        ? `Archived offload destination "${inner.nickname}" on env "${inner.env_id}" (${inner.active_destinations} active remain).`
        : `offload_archive refused: ${inner.error ?? 'unknown'}.`,
    },
    data: {
      ok: inner.ok,
      env_id: inner.env_id,
      nickname: inner.nickname,
      store_kind: inner.store_kind,
      destination: inner.destination,
      total_destinations: inner.total_destinations,
      active_destinations: inner.active_destinations,
      active_destinations_remaining: inner.active_destinations_remaining,
      archived_at: inner.archived_at,
      error: inner.error,
      error_code: inner.error_code,
      human_summary: buildArchiveHumanSummary(inner),
    },
  });
}

async function executeOffloadArchiveInner(
  args: OffloadArchiveArgs,
  storeOverride?: EnvConfigStore[]
): Promise<ArchiveInner> {
  let loaded: { config: EnvironmentConfig; store: EnvConfigStore };
  try {
    loaded = await loadEnvAndStore(args.env_id, storeOverride);
  } catch (err) {
    const code = (err as Error & { code?: string }).code ?? 'load_failed';
    return { ok: false, error: (err as Error).message, error_code: code };
  }
  const { config, store } = loaded;

  const idx = config.offload_destinations.findIndex(d => d.nickname === args.nickname);
  if (idx < 0) {
    const known = config.offload_destinations
      .map(d => `${d.nickname} (status=${d.status})`)
      .join(', ');
    return {
      ok: false,
      env_id: config.env_id,
      nickname: args.nickname,
      store_kind: store.kind,
      error: `No offload destination named "${args.nickname}" on env "${config.env_id}". Known: ${known || 'none'}.`,
      error_code: 'destination_not_found',
    };
  }

  const target = config.offload_destinations[idx];
  if (target.status === 'archived') {
    return {
      ok: false,
      env_id: config.env_id,
      nickname: args.nickname,
      store_kind: store.kind,
      destination: target,
      error: `Offload destination "${args.nickname}" on env "${config.env_id}" is already archived (archived_at=${target.archived_at ?? 'unknown'}). No-op.`,
      error_code: 'already_archived',
    };
  }

  // The Receiver requires at least one active destination to route the
  // dropped slice to. Archiving the only active entry would silently strand
  // offload traffic, so refuse with a clear remediation: activate another
  // destination first.
  const activeDestinations = config.offload_destinations.filter(d => d.status === 'active');
  const targetIsActive = target.status === 'active';
  if (targetIsActive && activeDestinations.length <= 1) {
    const nonActive = config.offload_destinations
      .filter(d => d.status !== 'active')
      .map(d => `${d.nickname} (status=${d.status})`)
      .join(', ');
    return {
      ok: false,
      env_id: config.env_id,
      nickname: args.nickname,
      store_kind: store.kind,
      destination: target,
      error:
        `Cannot archive "${args.nickname}" — it is the only active offload destination on env "${config.env_id}". ` +
        `The Receiver requires at least one active destination to route the dropped slice to. ` +
        `Add or re-activate another destination first (current non-active: ${nonActive || 'none'}), then retry.`,
      error_code: 'last_active_destination',
    };
  }

  const archivedAt = args.archived_at ?? nowIso();
  const updated: OffloadDestination = {
    ...target,
    status: 'archived',
    archived_at: archivedAt,
    ...(args.note !== undefined ? { note: args.note } : {}),
  };

  const newDestinations = [...config.offload_destinations];
  newDestinations[idx] = updated;
  const mutated: EnvironmentConfig = {
    ...config,
    offload_destinations: newDestinations,
  };

  let written: EnvironmentConfig;
  try {
    written = await persist(store, mutated);
  } catch (err) {
    return {
      ok: false,
      env_id: config.env_id,
      nickname: args.nickname,
      store_kind: store.kind,
      destination: target,
      error: `Failed to persist env-config to ${store.kind} store: ${(err as Error).message}`,
      error_code: 'write_failed',
    };
  }

  const active = written.offload_destinations.filter(d => d.status === 'active');
  return {
    ok: true,
    env_id: written.env_id,
    nickname: args.nickname,
    store_kind: store.kind,
    destination: updated,
    total_destinations: written.offload_destinations.length,
    active_destinations: active.length,
    active_destinations_remaining: active.map(d => d.nickname),
    archived_at: archivedAt,
  };
}
