/**
 * Environment configuration schemas and types.
 *
 * The env.json document is the single source of truth for a Log10x environment:
 * cluster identity, SIEM destination, offload destinations (multi-target so we
 * can drain a legacy bucket while a new one is primary), streamer + retriever
 * endpoints. Everything tools need to act on a given environment is described
 * here, validated by zod, and persisted to whichever on-prem store the
 * customer's cloud uses (Kubernetes ConfigMap, AWS SSM, GCP Secret Manager,
 * Azure App Configuration, or a local file for dev).
 *
 * Schema is versioned (`schema_version`) so we can evolve the document without
 * breaking older readers — readers refuse on mismatch rather than guess.
 */

import { z } from 'zod';

/**
 * A single offload destination — where the Receiver can write objects when a
 * pattern is tagged `offload`. The array is non-empty because the resolver
 * needs at least one default to point new offload rules at. `status` lets us
 * keep historical buckets in the document while signalling they're no longer
 * being written to (`draining` = still being read, `archived` = read-only
 * reference, `failed` = quarantined after write errors).
 */
export const offloadDestinationSchema = z.object({
  nickname: z.string().min(1).describe('Human-readable label (e.g. "primary", "regional_us", "legacy_streamer").'),
  type: z.enum(['s3', 'gcs', 'azure_blob', 'file']),
  status: z.enum(['active', 'draining', 'archived', 'failed']).default('active'),
  // type-specific fields
  bucket: z.string().optional(),       // s3 / gcs / azure_blob
  prefix: z.string().optional(),
  region: z.string().optional(),       // s3 / azure_blob
  project_id: z.string().optional(),   // gcs
  storage_account: z.string().optional(), // azure_blob
  path: z.string().optional(),         // file
  auth: z.object({
    method: z.enum(['irsa', 'iam_role', 'workload_identity', 'service_principal', 'access_key', 'connection_string', 'none']),
    role: z.string().optional(),
    sa: z.string().optional(),
    note: z.string().optional(),
  }).optional(),
  archived_at: z.string().optional(),
  first_used_at: z.string().optional(),
  note: z.string().optional(),
});

/**
 * Where this environment lives. `type` is the cluster flavour; the rest are
 * cloud-specific locators that let us emit the right offload-recipe IAM and
 * choose the right on-prem store implementation (EKS → SSM, GKE → GCP SM,
 * AKS → Azure App Config).
 */
export const clusterIdentitySchema = z.object({
  type: z.enum(['eks', 'gke', 'aks', 'kind', 'minikube', 'bare_metal', 'other']),
  region: z.string().optional(),
  account: z.string().optional(),
  project_id: z.string().optional(),
  subscription: z.string().optional(),
  context_name: z.string().optional(),
});

/**
 * The SIEM this environment's logs ultimately land in. Drives action
 * eligibility (e.g. `tier_down` only makes sense for Datadog/CloudWatch/Azure)
 * and the explainer copy on commitment_report.
 */
export const siemDestinationSchema = z.object({
  siem_vendor: z.enum(['splunk', 'datadog', 'elasticsearch', 'clickhouse', 'cloudwatch', 'azure-monitor', 'gcp-logging', 'sumo', 'other']),
  region: z.string().optional(),
  log_group_prefix: z.string().optional(),
  ingest_url: z.string().optional(),
});

/**
 * Streamer endpoint — the in-cluster service that fronts the Receiver's
 * compact/sample/drop/offload decisions. `target_path` is the optional
 * sub-path when the streamer is mounted behind a shared ingress.
 */
export const streamerConfigSchema = z.object({
  url: z.string(),
  target_path: z.string().optional(),
});

/**
 * Retriever endpoint and the queues it owns. The retriever reads from
 * `input_bucket` (the customer-owned overflow bucket), serves queries via `url`, and uses the four
 * SQS queues for index/subquery/stream/query coordination. `query_log_group`
 * is the CloudWatch group we tail when investigating retriever failures.
 */
export const retrieverConfigSchema = z.object({
  url: z.string(),
  input_bucket: z.string(),
  input_prefix: z.string().optional(),
  query_queues: z.object({
    index: z.string(),
    subquery: z.string(),
    stream: z.string(),
    query: z.string(),
  }),
  query_log_group: z.string().optional(),
  helm_release: z.object({
    name: z.string(),
    namespace: z.string(),
    chart_version: z.string().optional(),
  }).optional(),
});

/**
 * The full environment document persisted to the on-prem store. `env_id` is
 * the stable identifier (UUID); `nickname` is the human-friendly key that
 * users type at the prompt. Both must resolve to the same document.
 */
export const environmentConfigSchema = z.object({
  schema_version: z.literal('1.0'),
  env_id: z.string(),
  nickname: z.string(),
  cluster: clusterIdentitySchema,
  destination: siemDestinationSchema,
  offload_destinations: z.array(offloadDestinationSchema).min(1),
  streamer: streamerConfigSchema,
  retriever: retrieverConfigSchema,
  updated_at: z.string().optional(),
  updated_by: z.string().optional(),
});

export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>;
export type OffloadDestination = z.infer<typeof offloadDestinationSchema>;
export type ClusterIdentity = z.infer<typeof clusterIdentitySchema>;
export type SiemDestination = z.infer<typeof siemDestinationSchema>;
export type StreamerConfig = z.infer<typeof streamerConfigSchema>;
export type RetrieverConfig = z.infer<typeof retrieverConfigSchema>;
