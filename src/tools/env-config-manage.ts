/**
 * Three env-config management tools, all reading/writing the same
 * EnvironmentConfig document (src/lib/env-config/types.ts):
 *
 *   log10x_dest_set            — mutate the SIEM destination block on an
 *                                env doc (siem_vendor, region,
 *                                log_group_prefix, ingest_url).
 *   log10x_env_validate        — schema-parse the stored doc and run
 *                                cross-field sanity checks (e.g., does
 *                                the streamer's region match the SIEM's
 *                                region, are required vendor-specific
 *                                fields present, do offload destinations
 *                                align with the cluster's cloud).
 *   log10x_env_diff_vs_envvars — compare the stored doc against the
 *                                LOG10X_* env vars the bridge would have
 *                                produced, and report each disagreement
 *                                with a remediation recommendation.
 *
 * Why grouped: all three operate on the env-config document (env_id keyed),
 * not on the legacy `~/.log10x/envs.json` metrics-backend list. They share
 * the LocalFileStore resolution path and the same EnvironmentConfig zod
 * schema so a single file keeps the contract obvious.
 *
 * Store choice: these tools default to LocalFileStore (`~/.log10x/envs/<env_id>.json`).
 * The resolver chain (k8s/SSM/GCP-SM/Azure-AC) is plumbed in tools that
 * already wire credentials for those clouds; this set sticks to the
 * always-available local fallback so the file builds clean without pulling
 * cloud SDKs at import time.
 */

import { z } from 'zod';
import {
  environmentConfigSchema,
  type EnvironmentConfig,
  type SiemDestination,
} from '../lib/env-config/types.js';
import { LocalFileStore } from '../lib/env-config/store-local-file.js';
import { envConfigFromEnvVars } from '../lib/env-config/env-var-bridge.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';

// ── shared store helpers ────────────────────────────────────────────────────

/**
 * Resolve the env doc for the given env_id (or nickname — LocalFileStore
 * supports both) using the local-file store. Returns null when the doc
 * is absent so callers can render a clean "no such env" envelope without
 * crashing.
 */
async function readEnvDoc(envIdOrNickname: string): Promise<EnvironmentConfig | null> {
  const store = new LocalFileStore();
  return store.read(envIdOrNickname);
}

async function writeEnvDoc(config: EnvironmentConfig): Promise<void> {
  const store = new LocalFileStore();
  await store.write(config);
}

/**
 * Standard "not found" envelope shared by all three tools so the agent
 * sees the same shape regardless of which entry point hit the missing-doc
 * branch.
 */
function envNotFoundEnvelope(tool: string, envId: string): StructuredOutput {
  return buildEnvelope({
    tool,
    view: 'summary',
    summary: { headline: `${tool}: no env doc found for "${envId}".` },
    data: {
      ok: false,
      error: `No env-config document found for "${envId}" in the local file store. ` +
        `Check ~/.log10x/envs/ for the canonical filename or call log10x_discover_env to list known envs.`,
      env_id: envId,
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// log10x_dest_set
// ───────────────────────────────────────────────────────────────────────────

/**
 * SIEM vendor enum mirrors `siemDestinationSchema` so the agent gets the
 * full canonical list at registration time rather than discovering it via
 * error messages.
 */
const SIEM_VENDOR_ENUM = [
  'splunk',
  'datadog',
  'elasticsearch',
  'clickhouse',
  'cloudwatch',
  'azure-monitor',
  'gcp-logging',
  'sumo',
  'other',
] as const;

export const destSetSchema = {
  env_id: z
    .string()
    .min(1)
    .describe(
      'Env identifier — either the `env_id` UUID or the `nickname` from the env-config document. Resolves via the local-file store (~/.log10x/envs/<env_id>.json).'
    ),
  siem_vendor: z
    .enum(SIEM_VENDOR_ENUM)
    .describe(
      'The SIEM this environment ships logs to. Drives action eligibility downstream — e.g., `tier_down` only applies to datadog / cloudwatch / azure-monitor; `offload` requires a coherent vendor for the recipe emitter.'
    ),
  region: z
    .string()
    .optional()
    .describe(
      'Cloud region the SIEM lives in (e.g., `us-east-1` for Datadog/CloudWatch, `westus2` for azure-monitor). Optional but recommended — `log10x_env_validate` flags an empty region for vendors that require one.'
    ),
  log_group_prefix: z
    .string()
    .optional()
    .describe(
      'Log-group / index / source prefix the customer routes 10x output to (e.g., `/aws/lambda/log10x-` for cloudwatch, `log10x_*` for splunk). Used by `log10x_dependency_check` and the offload-recipe emitter.'
    ),
  ingest_url: z
    .string()
    .optional()
    .describe(
      'Full ingest endpoint when the SIEM is self-hosted or non-default region (e.g., `https://splunk.acme.internal:8088/services/collector`). Optional — vendor defaults apply when absent.'
    ),
};

interface DestSetArgs {
  env_id: string;
  siem_vendor: SiemDestination['siem_vendor'];
  region?: string;
  log_group_prefix?: string;
  ingest_url?: string;
}

export async function executeDestSet(args: DestSetArgs): Promise<StructuredOutput> {
  const doc = await readEnvDoc(args.env_id);
  if (!doc) return envNotFoundEnvelope('log10x_dest_set', args.env_id);

  const before: SiemDestination = doc.destination;
  const after: SiemDestination = {
    siem_vendor: args.siem_vendor,
    ...(args.region !== undefined ? { region: args.region } : {}),
    ...(args.log_group_prefix !== undefined ? { log_group_prefix: args.log_group_prefix } : {}),
    ...(args.ingest_url !== undefined ? { ingest_url: args.ingest_url } : {}),
  };

  // Build the changeset before writing so the envelope reports exactly
  // which fields moved (the user pastes this back to confirm).
  const changes: string[] = [];
  if (before.siem_vendor !== after.siem_vendor) {
    changes.push(`siem_vendor: ${before.siem_vendor} -> ${after.siem_vendor}`);
  }
  if (before.region !== after.region) {
    changes.push(`region: ${before.region ?? '<unset>'} -> ${after.region ?? '<unset>'}`);
  }
  if (before.log_group_prefix !== after.log_group_prefix) {
    changes.push(
      `log_group_prefix: ${before.log_group_prefix ?? '<unset>'} -> ${after.log_group_prefix ?? '<unset>'}`
    );
  }
  if (before.ingest_url !== after.ingest_url) {
    changes.push(`ingest_url: ${before.ingest_url ?? '<unset>'} -> ${after.ingest_url ?? '<unset>'}`);
  }

  const updated: EnvironmentConfig = {
    ...doc,
    destination: after,
    updated_at: new Date().toISOString(),
  };

  // Validate against the canonical schema before write so a future schema
  // tightening can't be silently bypassed via this entry point.
  const parsed = environmentConfigSchema.safeParse(updated);
  if (!parsed.success) {
    return buildEnvelope({
      tool: 'log10x_dest_set',
      view: 'summary',
      summary: { headline: `log10x_dest_set refused: updated doc fails schema validation.` },
      data: {
        ok: false,
        env_id: args.env_id,
        error: 'updated doc fails schema validation — destination edit not persisted.',
        zod_issues: parsed.error.issues.slice(0, 10).map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
    });
  }

  try {
    await writeEnvDoc(parsed.data);
  } catch (e) {
    const msg = (e as Error).message;
    return buildEnvelope({
      tool: 'log10x_dest_set',
      view: 'summary',
      summary: { headline: `log10x_dest_set failed: could not persist updated doc.` },
      data: { ok: false, env_id: args.env_id, error: `write env doc: ${msg}` },
    });
  }

  const headline =
    changes.length === 0
      ? `log10x_dest_set: no-op on env "${doc.nickname}" (destination already matches).`
      : `Updated destination on env "${doc.nickname}": ${changes.join(', ')}.`;

  return buildEnvelope({
    tool: 'log10x_dest_set',
    view: 'summary',
    summary: { headline },
    data: {
      ok: true,
      env_id: doc.env_id,
      nickname: doc.nickname,
      before,
      after,
      changes,
      human_summary: headline,
    },
    actions: [
      {
        tool: 'log10x_env_validate',
        args: { env_id: doc.env_id },
        reason:
          'Run cross-field sanity checks against the new destination (region/vendor alignment, ingest-url shape).',
      },
    ],
  });
}

// ───────────────────────────────────────────────────────────────────────────
// log10x_env_validate
// ───────────────────────────────────────────────────────────────────────────

export const envValidateSchema = {
  env_id: z
    .string()
    .min(1)
    .describe(
      'Env identifier — either the `env_id` UUID or the `nickname` from the env-config document. Resolves via the local-file store.'
    ),
};

interface EnvValidateArgs {
  env_id: string;
}

interface SanityFinding {
  severity: 'error' | 'warning' | 'info';
  field: string;
  message: string;
  recommendation?: string;
}

/**
 * Cross-field sanity checks beyond what the zod schema enforces. Each
 * finding has a severity so the agent can decide whether to surface
 * (warnings/info) or refuse to proceed (errors). The list grows as
 * downstream tools surface new "would have caught this earlier" cases.
 */
function runCrossFieldSanity(doc: EnvironmentConfig): SanityFinding[] {
  const findings: SanityFinding[] = [];

  // ── SIEM vendor / region pairing ──
  const vendor = doc.destination.siem_vendor;
  const region = doc.destination.region;
  if (
    (vendor === 'datadog' ||
      vendor === 'cloudwatch' ||
      vendor === 'azure-monitor' ||
      vendor === 'gcp-logging') &&
    !region
  ) {
    findings.push({
      severity: 'warning',
      field: 'destination.region',
      message: `siem_vendor=${vendor} typically requires destination.region (us-east-1 / westus2 / etc.).`,
      recommendation:
        `Call log10x_dest_set with the env_id and the correct region (omit other fields to keep them).`,
    });
  }

  // ── Cross-cloud: streamer.url region vs SIEM region (best-effort string check) ──
  // We don't have a structured region on streamer/retriever URLs, but the
  // bucket region is a reasonable proxy for "where the customer's pipeline
  // lives". If the SIEM region disagrees with EVERY offload destination's
  // region, flag the mismatch — egress costs explode otherwise.
  if (region) {
    const offloadRegions = new Set(
      doc.offload_destinations
        .map((d) => d.region)
        .filter((r): r is string => Boolean(r))
    );
    if (offloadRegions.size > 0 && !offloadRegions.has(region)) {
      findings.push({
        severity: 'warning',
        field: 'destination.region vs offload_destinations[].region',
        message:
          `SIEM region "${region}" does not match any offload destination region (${Array.from(offloadRegions).join(', ')}). Egress costs apply on cross-region SIEM ingest.`,
        recommendation:
          `Confirm intentional. If unintentional, either move the offload bucket(s) into ${region} or update destination.region to match.`,
      });
    }
  }

  // ── Cluster cloud / offload type sanity ──
  // EKS naturally pairs with S3, GKE with GCS, AKS with azure_blob. Any
  // other pairing is legal (multi-cloud is allowed) but worth surfacing.
  const cloudExpectation: Record<EnvironmentConfig['cluster']['type'], string | undefined> = {
    eks: 's3',
    gke: 'gcs',
    aks: 'azure_blob',
    kind: undefined,
    minikube: undefined,
    bare_metal: undefined,
    other: undefined,
  };
  const expected = cloudExpectation[doc.cluster.type];
  if (expected) {
    for (const dest of doc.offload_destinations) {
      if (dest.status !== 'active') continue;
      if (dest.type !== expected) {
        findings.push({
          severity: 'info',
          field: `offload_destinations[nickname=${dest.nickname}].type`,
          message:
            `cluster.type=${doc.cluster.type} typically pairs with offload type "${expected}", got "${dest.type}". Cross-cloud writes may incur extra egress.`,
        });
      }
    }
  }

  // ── ingest_url shape vs vendor ──
  const ingest = doc.destination.ingest_url;
  if (ingest) {
    if (!/^https?:\/\//i.test(ingest)) {
      findings.push({
        severity: 'error',
        field: 'destination.ingest_url',
        message: `ingest_url must start with http:// or https://, got "${ingest}".`,
        recommendation:
          `Call log10x_dest_set with a fully-qualified URL or omit ingest_url to use the vendor default.`,
      });
    }
    if (vendor === 'splunk' && !/\/services\/collector(\/|$)/.test(ingest)) {
      findings.push({
        severity: 'warning',
        field: 'destination.ingest_url',
        message:
          `siem_vendor=splunk ingest_url usually ends with /services/collector; got "${ingest}".`,
      });
    }
  }

  // ── retriever URL / input_bucket sanity ──
  if (!/^https?:\/\//i.test(doc.retriever.url)) {
    findings.push({
      severity: 'error',
      field: 'retriever.url',
      message: `retriever.url must start with http:// or https://, got "${doc.retriever.url}".`,
    });
  }
  if (!/^https?:\/\//i.test(doc.streamer.url)) {
    findings.push({
      severity: 'error',
      field: 'streamer.url',
      message: `streamer.url must start with http:// or https://, got "${doc.streamer.url}".`,
    });
  }

  // ── At-least-one active offload destination ──
  const activeOffloads = doc.offload_destinations.filter((d) => d.status === 'active');
  if (activeOffloads.length === 0) {
    findings.push({
      severity: 'warning',
      field: 'offload_destinations[].status',
      message:
        'No offload_destinations have status=active. Offload-mode actions will refuse until one is promoted.',
      recommendation: 'Flip the primary destination back to status=active in the env doc.',
    });
  }

  return findings;
}

export async function executeEnvValidate(args: EnvValidateArgs): Promise<StructuredOutput> {
  const doc = await readEnvDoc(args.env_id);
  if (!doc) return envNotFoundEnvelope('log10x_env_validate', args.env_id);

  // 1) Schema parse — re-runs the canonical zod schema so an
  //    out-of-band edit to the file is caught here even though
  //    LocalFileStore.read already parses on the way out.
  const parsed = environmentConfigSchema.safeParse(doc);
  const schemaIssues = parsed.success
    ? []
    : parsed.error.issues.map((i) => ({
        path: i.path.join('.') || '<root>',
        message: i.message,
        code: i.code,
      }));

  // 2) Cross-field sanity (only meaningful if the schema parsed —
  //    a broken doc can't be reasoned about field-by-field).
  const findings: SanityFinding[] = parsed.success ? runCrossFieldSanity(parsed.data) : [];

  const errorCount = findings.filter((f) => f.severity === 'error').length + schemaIssues.length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const infoCount = findings.filter((f) => f.severity === 'info').length;

  const ok = errorCount === 0;
  const headline = ok
    ? `Env "${doc.nickname}" passes schema + sanity checks (${warningCount} warning${warningCount === 1 ? '' : 's'}, ${infoCount} info).`
    : `Env "${doc.nickname}" has ${errorCount} error${errorCount === 1 ? '' : 's'} — fix before proceeding.`;

  return buildEnvelope({
    tool: 'log10x_env_validate',
    view: 'summary',
    summary: { headline },
    data: {
      ok,
      env_id: doc.env_id,
      nickname: doc.nickname,
      schema_passed: parsed.success,
      schema_issues: schemaIssues,
      findings,
      counts: { error: errorCount, warning: warningCount, info: infoCount },
      human_summary: headline,
    },
    actions: ok
      ? []
      : [
          {
            tool: 'log10x_dest_set',
            args: { env_id: doc.env_id },
            reason:
              'Fix destination-related findings (vendor / region / ingest_url) via the targeted setter.',
          },
        ],
  });
}

// ───────────────────────────────────────────────────────────────────────────
// log10x_env_diff_vs_envvars
// ───────────────────────────────────────────────────────────────────────────

export const envDiffVsEnvvarsSchema = {
  env_id: z
    .string()
    .min(1)
    .describe(
      'Env identifier — either the `env_id` UUID or the `nickname` from the env-config document. Resolves via the local-file store.'
    ),
};

interface EnvDiffArgs {
  env_id: string;
}

interface FieldDiff {
  field: string;
  stored: unknown;
  envvar: unknown;
  recommendation: string;
}

/**
 * Walk the bridged env-var partial and compare each field to its stored
 * counterpart. We accept the bridge as the source of truth for "what the
 * env vars are saying"; the resolver's tie-breaker rule is that the
 * on-prem store wins, so every disagreement is reported with a
 * "remove the env var" recommendation by default.
 */
function buildFieldDiffs(
  stored: EnvironmentConfig,
  envvar: Partial<EnvironmentConfig>
): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  const recommendRemoveEnvVar = (envVarName: string) =>
    `Unset ${envVarName} in the MCP host environment — the on-prem store value wins and the env var is silently ignored.`;
  const recommendUpdateStored = (envVarName: string, field: string) =>
    `If the env var is correct, call the matching setter (e.g., log10x_dest_set for destination.*) to update the stored doc; otherwise unset ${envVarName} so future readers stop seeing the disagreement on ${field}.`;

  // env_id / nickname — top-level identity
  if (envvar.env_id !== undefined && envvar.env_id !== stored.env_id) {
    diffs.push({
      field: 'env_id',
      stored: stored.env_id,
      envvar: envvar.env_id,
      recommendation: recommendRemoveEnvVar('LOG10X_ENV_ID'),
    });
  }
  if (envvar.nickname !== undefined && envvar.nickname !== stored.nickname) {
    diffs.push({
      field: 'nickname',
      stored: stored.nickname,
      envvar: envvar.nickname,
      recommendation: recommendRemoveEnvVar('LOG10X_ENV_NICKNAME'),
    });
  }

  // cluster.*
  if (envvar.cluster) {
    if (envvar.cluster.type && envvar.cluster.type !== stored.cluster.type) {
      diffs.push({
        field: 'cluster.type',
        stored: stored.cluster.type,
        envvar: envvar.cluster.type,
        recommendation: recommendUpdateStored('LOG10X_CLUSTER_TYPE', 'cluster.type'),
      });
    }
    if (envvar.cluster.region && envvar.cluster.region !== stored.cluster.region) {
      diffs.push({
        field: 'cluster.region',
        stored: stored.cluster.region ?? '<unset>',
        envvar: envvar.cluster.region,
        recommendation: recommendUpdateStored('LOG10X_CLUSTER_REGION', 'cluster.region'),
      });
    }
    if (envvar.cluster.account && envvar.cluster.account !== stored.cluster.account) {
      diffs.push({
        field: 'cluster.account',
        stored: stored.cluster.account ?? '<unset>',
        envvar: envvar.cluster.account,
        recommendation: recommendUpdateStored('LOG10X_CLUSTER_ACCOUNT', 'cluster.account'),
      });
    }
    if (envvar.cluster.project_id && envvar.cluster.project_id !== stored.cluster.project_id) {
      diffs.push({
        field: 'cluster.project_id',
        stored: stored.cluster.project_id ?? '<unset>',
        envvar: envvar.cluster.project_id,
        recommendation: recommendUpdateStored('LOG10X_CLUSTER_PROJECT_ID', 'cluster.project_id'),
      });
    }
  }

  // destination.*
  if (envvar.destination) {
    if (
      envvar.destination.siem_vendor &&
      envvar.destination.siem_vendor !== stored.destination.siem_vendor
    ) {
      diffs.push({
        field: 'destination.siem_vendor',
        stored: stored.destination.siem_vendor,
        envvar: envvar.destination.siem_vendor,
        recommendation:
          `Pick the source of truth: if the env var is right, call log10x_dest_set { env_id, siem_vendor: "${envvar.destination.siem_vendor}" }; otherwise unset LOG10X_SIEM_VENDOR.`,
      });
    }
    if (envvar.destination.region && envvar.destination.region !== stored.destination.region) {
      diffs.push({
        field: 'destination.region',
        stored: stored.destination.region ?? '<unset>',
        envvar: envvar.destination.region,
        recommendation:
          `If the env var is right, call log10x_dest_set { env_id, siem_vendor, region: "${envvar.destination.region}" }; otherwise unset LOG10X_SIEM_REGION.`,
      });
    }
    if (
      envvar.destination.log_group_prefix &&
      envvar.destination.log_group_prefix !== stored.destination.log_group_prefix
    ) {
      diffs.push({
        field: 'destination.log_group_prefix',
        stored: stored.destination.log_group_prefix ?? '<unset>',
        envvar: envvar.destination.log_group_prefix,
        recommendation:
          `If the env var is right, call log10x_dest_set with the new log_group_prefix; otherwise unset LOG10X_SIEM_LOG_GROUP_PREFIX.`,
      });
    }
    if (
      envvar.destination.ingest_url &&
      envvar.destination.ingest_url !== stored.destination.ingest_url
    ) {
      diffs.push({
        field: 'destination.ingest_url',
        stored: stored.destination.ingest_url ?? '<unset>',
        envvar: envvar.destination.ingest_url,
        recommendation:
          `If the env var is right, call log10x_dest_set with the new ingest_url; otherwise unset LOG10X_SIEM_INGEST_URL.`,
      });
    }
  }

  // streamer.*
  if (envvar.streamer) {
    if (envvar.streamer.url && envvar.streamer.url !== stored.streamer.url) {
      diffs.push({
        field: 'streamer.url',
        stored: stored.streamer.url,
        envvar: envvar.streamer.url,
        recommendation: recommendRemoveEnvVar('LOG10X_STREAMER_URL'),
      });
    }
    if (
      envvar.streamer.target_path &&
      envvar.streamer.target_path !== stored.streamer.target_path
    ) {
      diffs.push({
        field: 'streamer.target_path',
        stored: stored.streamer.target_path ?? '<unset>',
        envvar: envvar.streamer.target_path,
        recommendation: recommendRemoveEnvVar('LOG10X_STREAMER_TARGET_PATH'),
      });
    }
  }

  // retriever.*
  if (envvar.retriever) {
    if (envvar.retriever.url && envvar.retriever.url !== stored.retriever.url) {
      diffs.push({
        field: 'retriever.url',
        stored: stored.retriever.url,
        envvar: envvar.retriever.url,
        recommendation: recommendRemoveEnvVar('LOG10X_RETRIEVER_URL'),
      });
    }
    if (
      envvar.retriever.input_bucket &&
      envvar.retriever.input_bucket !== stored.retriever.input_bucket
    ) {
      diffs.push({
        field: 'retriever.input_bucket',
        stored: stored.retriever.input_bucket,
        envvar: envvar.retriever.input_bucket,
        recommendation: recommendRemoveEnvVar('LOG10X_RETRIEVER_INPUT_BUCKET'),
      });
    }
    if (
      envvar.retriever.input_prefix &&
      envvar.retriever.input_prefix !== stored.retriever.input_prefix
    ) {
      diffs.push({
        field: 'retriever.input_prefix',
        stored: stored.retriever.input_prefix ?? '<unset>',
        envvar: envvar.retriever.input_prefix,
        recommendation: recommendRemoveEnvVar('LOG10X_RETRIEVER_INPUT_PREFIX'),
      });
    }
    if (envvar.retriever.query_queues) {
      const q = envvar.retriever.query_queues;
      const s = stored.retriever.query_queues;
      const queues: Array<{ key: keyof typeof q; var: string }> = [
        { key: 'index', var: 'LOG10X_RETRIEVER_Q_INDEX' },
        { key: 'subquery', var: 'LOG10X_RETRIEVER_Q_SUBQUERY' },
        { key: 'stream', var: 'LOG10X_RETRIEVER_Q_STREAM' },
        { key: 'query', var: 'LOG10X_RETRIEVER_Q_QUERY' },
      ];
      for (const item of queues) {
        const eVal = q[item.key];
        const sVal = s[item.key];
        if (eVal && eVal !== sVal) {
          diffs.push({
            field: `retriever.query_queues.${String(item.key)}`,
            stored: sVal,
            envvar: eVal,
            recommendation: recommendRemoveEnvVar(item.var),
          });
        }
      }
    }
  }

  // offload_destinations[0].* — bridge only builds one entry from env vars
  if (envvar.offload_destinations && envvar.offload_destinations.length > 0) {
    const e = envvar.offload_destinations[0];
    // Match by nickname when possible; otherwise treat the first stored
    // entry as the comparable peer (mirrors what the bridge would have
    // produced).
    const s =
      stored.offload_destinations.find((d) => d.nickname === e.nickname) ??
      stored.offload_destinations[0];
    if (e.type && s.type !== e.type) {
      diffs.push({
        field: `offload_destinations[${s.nickname}].type`,
        stored: s.type,
        envvar: e.type,
        recommendation: recommendRemoveEnvVar('LOG10X_OFFLOAD_TYPE'),
      });
    }
    if (e.bucket && s.bucket !== e.bucket) {
      diffs.push({
        field: `offload_destinations[${s.nickname}].bucket`,
        stored: s.bucket ?? '<unset>',
        envvar: e.bucket,
        recommendation: recommendRemoveEnvVar('LOG10X_OFFLOAD_BUCKET / LOG10X_STREAMER_BUCKET'),
      });
    }
    if (e.region && s.region !== e.region) {
      diffs.push({
        field: `offload_destinations[${s.nickname}].region`,
        stored: s.region ?? '<unset>',
        envvar: e.region,
        recommendation: recommendRemoveEnvVar('LOG10X_OFFLOAD_REGION'),
      });
    }
    if (e.prefix && s.prefix !== e.prefix) {
      diffs.push({
        field: `offload_destinations[${s.nickname}].prefix`,
        stored: s.prefix ?? '<unset>',
        envvar: e.prefix,
        recommendation: recommendRemoveEnvVar('LOG10X_OFFLOAD_PREFIX'),
      });
    }
  }

  return diffs;
}

export async function executeEnvDiffVsEnvvars(args: EnvDiffArgs): Promise<StructuredOutput> {
  const doc = await readEnvDoc(args.env_id);
  if (!doc) return envNotFoundEnvelope('log10x_env_diff_vs_envvars', args.env_id);

  const envvarPartial = envConfigFromEnvVars(process.env);

  if (!envvarPartial) {
    const headline = `No LOG10X_* env vars set — nothing to diff against stored env "${doc.nickname}".`;
    return buildEnvelope({
      tool: 'log10x_env_diff_vs_envvars',
      view: 'summary',
      summary: { headline },
      data: {
        ok: true,
        env_id: doc.env_id,
        nickname: doc.nickname,
        any_envvars_set: false,
        diffs: [],
        recommendation:
          'Pure on-prem-store configuration. The resolver will read the stored doc on every call; no env-var ambiguity.',
        human_summary: headline,
      },
    });
  }

  const diffs = buildFieldDiffs(doc, envvarPartial);

  const ok = diffs.length === 0;
  const headline = ok
    ? `Stored env "${doc.nickname}" matches LOG10X_* env vars on every overlapping field.`
    : `Stored env "${doc.nickname}" disagrees with LOG10X_* env vars on ${diffs.length} field${diffs.length === 1 ? '' : 's'}. The stored doc wins; env vars are ignored.`;

  // Generate one overall recommendation so the agent has a single
  // sentence to surface even when individual diffs each carry their own.
  const overallRecommendation = ok
    ? 'No action needed — stored doc and env vars agree.'
    : 'Per the resolver precedence, the on-prem store wins; each LOG10X_* env var that disagrees is silently ignored. Either unset the disagreeing env vars (recommended) or update the stored doc via log10x_dest_set / the matching setter so the two sources stop drifting.';

  return buildEnvelope({
    tool: 'log10x_env_diff_vs_envvars',
    view: 'summary',
    summary: { headline },
    data: {
      ok,
      env_id: doc.env_id,
      nickname: doc.nickname,
      any_envvars_set: true,
      diffs,
      recommendation: overallRecommendation,
      human_summary: headline,
    },
    actions: ok
      ? []
      : [
          {
            tool: 'log10x_env_validate',
            args: { env_id: doc.env_id },
            reason: 'Re-run cross-field sanity once the diff is resolved.',
          },
        ],
  });
}
