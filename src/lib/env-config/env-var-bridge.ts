/**
 * Back-compat bridge: build a Partial<EnvironmentConfig> from the LOG10X_*
 * env-var vocabulary that pre-dates the env.json document.
 *
 * This is intentionally best-effort. The resolver decides whether the
 * resulting partial is complete enough to be accepted as a standalone fallback
 * (when no on-prem store has the env) — this file just packages the env vars
 * into the modern shape. Missing fields stay missing; nothing is fabricated.
 *
 * The recognized variables (each optional):
 *
 *   LOG10X_ENV_ID                — env_id
 *   LOG10X_ENV_NICKNAME          — nickname
 *
 *   LOG10X_CLUSTER_TYPE          — cluster.type
 *   LOG10X_CLUSTER_REGION        — cluster.region
 *   LOG10X_CLUSTER_ACCOUNT       — cluster.account
 *   LOG10X_CLUSTER_PROJECT_ID    — cluster.project_id
 *   LOG10X_CLUSTER_SUBSCRIPTION  — cluster.subscription
 *   LOG10X_CLUSTER_CONTEXT       — cluster.context_name
 *
 *   LOG10X_SIEM_VENDOR           — destination.siem_vendor
 *   LOG10X_SIEM_REGION           — destination.region
 *   LOG10X_SIEM_LOG_GROUP_PREFIX — destination.log_group_prefix
 *   LOG10X_SIEM_INGEST_URL       — destination.ingest_url
 *
 *   LOG10X_OFFLOAD_TYPE          — offload_destinations[0].type
 *   LOG10X_OFFLOAD_NICKNAME      — offload_destinations[0].nickname  (default "primary")
 *   LOG10X_OFFLOAD_BUCKET / LOG10X_STREAMER_BUCKET — offload_destinations[0].bucket
 *   LOG10X_OFFLOAD_PREFIX        — offload_destinations[0].prefix
 *   LOG10X_OFFLOAD_REGION        — offload_destinations[0].region
 *   LOG10X_OFFLOAD_PROJECT_ID    — offload_destinations[0].project_id
 *   LOG10X_OFFLOAD_STORAGE_ACCOUNT — offload_destinations[0].storage_account
 *   LOG10X_OFFLOAD_PATH          — offload_destinations[0].path
 *
 *   LOG10X_STREAMER_URL          — streamer.url
 *   LOG10X_STREAMER_TARGET_PATH  — streamer.target_path
 *
 *   LOG10X_RETRIEVER_URL         — retriever.url
 *   LOG10X_RETRIEVER_INPUT_BUCKET — retriever.input_bucket
 *   LOG10X_RETRIEVER_INPUT_PREFIX — retriever.input_prefix
 *   LOG10X_RETRIEVER_Q_INDEX     — retriever.query_queues.index
 *   LOG10X_RETRIEVER_Q_SUBQUERY  — retriever.query_queues.subquery
 *   LOG10X_RETRIEVER_Q_STREAM    — retriever.query_queues.stream
 *   LOG10X_RETRIEVER_Q_QUERY     — retriever.query_queues.query
 *   LOG10X_RETRIEVER_LOG_GROUP   — retriever.query_log_group
 *
 * Returns `null` when zero LOG10X_* variables are set — that signals the
 * resolver to skip the env-var path entirely rather than churn through an
 * empty partial.
 */

import type {
  EnvironmentConfig,
  OffloadDestination,
  ClusterIdentity,
  SiemDestination,
  StreamerConfig,
  RetrieverConfig,
} from './types.js';

type ClusterType = ClusterIdentity['type'];
type SiemVendor = SiemDestination['siem_vendor'];
type OffloadType = OffloadDestination['type'];

const CLUSTER_TYPES: readonly ClusterType[] = ['eks', 'gke', 'aks', 'kind', 'minikube', 'bare_metal', 'other'];
const SIEM_VENDORS: readonly SiemVendor[] = [
  'splunk', 'datadog', 'elasticsearch', 'clickhouse', 'cloudwatch',
  'azure-monitor', 'gcp-logging', 'sumo', 'other',
];
const OFFLOAD_TYPES: readonly OffloadType[] = ['s3', 'gcs', 'azure_blob', 'file'];

export function envConfigFromEnvVars(
  env: NodeJS.ProcessEnv = process.env,
): Partial<EnvironmentConfig> | null {
  // Quick reject: if no LOG10X_* var is set, return null so the resolver
  // doesn't bother validating an empty object.
  const anySet = Object.keys(env).some(k => k.startsWith('LOG10X_'));
  if (!anySet) return null;

  const partial: Partial<EnvironmentConfig> = { schema_version: '1.0' };

  if (env.LOG10X_ENV_ID) partial.env_id = env.LOG10X_ENV_ID;
  if (env.LOG10X_ENV_NICKNAME) partial.nickname = env.LOG10X_ENV_NICKNAME;

  const cluster = buildCluster(env);
  if (cluster) partial.cluster = cluster;

  const destination = buildDestination(env);
  if (destination) partial.destination = destination;

  const offload = buildOffload(env);
  if (offload) partial.offload_destinations = [offload];

  const streamer = buildStreamer(env);
  if (streamer) partial.streamer = streamer;

  const retriever = buildRetriever(env);
  if (retriever) partial.retriever = retriever;

  return partial;
}

function buildCluster(env: NodeJS.ProcessEnv): ClusterIdentity | undefined {
  const type = env.LOG10X_CLUSTER_TYPE as ClusterType | undefined;
  // type is required by the cluster sub-schema; without it, skip the block
  // entirely rather than emit an invalid partial.
  if (!type || !CLUSTER_TYPES.includes(type)) return undefined;
  const cluster: ClusterIdentity = { type };
  if (env.LOG10X_CLUSTER_REGION) cluster.region = env.LOG10X_CLUSTER_REGION;
  if (env.LOG10X_CLUSTER_ACCOUNT) cluster.account = env.LOG10X_CLUSTER_ACCOUNT;
  if (env.LOG10X_CLUSTER_PROJECT_ID) cluster.project_id = env.LOG10X_CLUSTER_PROJECT_ID;
  if (env.LOG10X_CLUSTER_SUBSCRIPTION) cluster.subscription = env.LOG10X_CLUSTER_SUBSCRIPTION;
  if (env.LOG10X_CLUSTER_CONTEXT) cluster.context_name = env.LOG10X_CLUSTER_CONTEXT;
  return cluster;
}

function buildDestination(env: NodeJS.ProcessEnv): SiemDestination | undefined {
  const vendor = env.LOG10X_SIEM_VENDOR as SiemVendor | undefined;
  if (!vendor || !SIEM_VENDORS.includes(vendor)) return undefined;
  const dest: SiemDestination = { siem_vendor: vendor };
  if (env.LOG10X_SIEM_REGION) dest.region = env.LOG10X_SIEM_REGION;
  if (env.LOG10X_SIEM_LOG_GROUP_PREFIX) dest.log_group_prefix = env.LOG10X_SIEM_LOG_GROUP_PREFIX;
  if (env.LOG10X_SIEM_INGEST_URL) dest.ingest_url = env.LOG10X_SIEM_INGEST_URL;
  return dest;
}

function buildOffload(env: NodeJS.ProcessEnv): OffloadDestination | undefined {
  const type = env.LOG10X_OFFLOAD_TYPE as OffloadType | undefined;
  if (!type || !OFFLOAD_TYPES.includes(type)) return undefined;
  const offload: OffloadDestination = {
    nickname: env.LOG10X_OFFLOAD_NICKNAME || 'primary',
    type,
    status: 'active',
  };
  const bucket = env.LOG10X_OFFLOAD_BUCKET || env.LOG10X_STREAMER_BUCKET;
  if (bucket) offload.bucket = bucket;
  if (env.LOG10X_OFFLOAD_PREFIX) offload.prefix = env.LOG10X_OFFLOAD_PREFIX;
  if (env.LOG10X_OFFLOAD_REGION) offload.region = env.LOG10X_OFFLOAD_REGION;
  if (env.LOG10X_OFFLOAD_PROJECT_ID) offload.project_id = env.LOG10X_OFFLOAD_PROJECT_ID;
  if (env.LOG10X_OFFLOAD_STORAGE_ACCOUNT) offload.storage_account = env.LOG10X_OFFLOAD_STORAGE_ACCOUNT;
  if (env.LOG10X_OFFLOAD_PATH) offload.path = env.LOG10X_OFFLOAD_PATH;
  return offload;
}

function buildStreamer(env: NodeJS.ProcessEnv): StreamerConfig | undefined {
  if (!env.LOG10X_STREAMER_URL) return undefined;
  const streamer: StreamerConfig = { url: env.LOG10X_STREAMER_URL };
  if (env.LOG10X_STREAMER_TARGET_PATH) streamer.target_path = env.LOG10X_STREAMER_TARGET_PATH;
  return streamer;
}

function buildRetriever(env: NodeJS.ProcessEnv): RetrieverConfig | undefined {
  if (!env.LOG10X_RETRIEVER_URL || !env.LOG10X_RETRIEVER_INPUT_BUCKET) return undefined;
  const queues = {
    index: env.LOG10X_RETRIEVER_Q_INDEX,
    subquery: env.LOG10X_RETRIEVER_Q_SUBQUERY,
    stream: env.LOG10X_RETRIEVER_Q_STREAM,
    query: env.LOG10X_RETRIEVER_Q_QUERY,
  };
  // All four queues are required by the sub-schema. If any are missing,
  // bail out rather than emit an invalid retriever block.
  if (!queues.index || !queues.subquery || !queues.stream || !queues.query) {
    return undefined;
  }
  const retriever: RetrieverConfig = {
    url: env.LOG10X_RETRIEVER_URL,
    input_bucket: env.LOG10X_RETRIEVER_INPUT_BUCKET,
    query_queues: {
      index: queues.index,
      subquery: queues.subquery,
      stream: queues.stream,
      query: queues.query,
    },
  };
  if (env.LOG10X_RETRIEVER_INPUT_PREFIX) retriever.input_prefix = env.LOG10X_RETRIEVER_INPUT_PREFIX;
  if (env.LOG10X_RETRIEVER_LOG_GROUP) retriever.query_log_group = env.LOG10X_RETRIEVER_LOG_GROUP;
  return retriever;
}
