/**
 * Shared types for the install-advisor discovery + advise tools.
 *
 * The snapshot is the *only* contract between `discover_env` and
 * `advise_{reporter,reducer,retriever}`. Adding a field here is a
 * wire-format change — bump `SNAPSHOT_SCHEMA_VERSION` below.
 */

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Which forwarder the customer is running. `unknown` = detection gave up. */
export type ForwarderKind =
  | 'fluentbit'
  | 'fluentd'
  | 'filebeat'
  | 'logstash'
  | 'otel-collector'
  | 'unknown';

/** Log10x apps we look for already being installed. */
export type Log10xAppKind = 'reporter' | 'reducer' | 'retriever' | 'compiler' | 'unknown';

/**
 * A workload (DaemonSet/Deployment/StatefulSet) we classified as a
 * forwarder. Keep the raw image around for transparency — the tool
 * output should show exactly what was matched so a human can override
 * the classification.
 */
export interface DetectedForwarder {
  kind: ForwarderKind;
  namespace: string;
  workloadKind: 'DaemonSet' | 'Deployment' | 'StatefulSet';
  workloadName: string;
  image: string;
  containerName: string;
  /** Labels on the pod template that hint at helm provenance. */
  labels: Record<string, string>;
  /** Number of ready replicas at probe time. Not authoritative, just a hint. */
  readyReplicas: number;
}

/** A log10x app already running in the cluster. */
export interface DetectedLog10xApp {
  kind: Log10xAppKind;
  namespace: string;
  workloadKind: 'CronJob' | 'DaemonSet' | 'Deployment' | 'StatefulSet';
  workloadName: string;
  image: string;
  helmRelease?: string;
  labels: Record<string, string>;
  /**
   * Literal-valued environment variables on the matching container.
   * Only `value`-form entries are captured (entries using `valueFrom`
   * are dropped — exposing secret refs would be unsafe and the
   * downstream consumers don't need them). The advisor uses this to
   * extract things like `GH_REPO` (gitops target repo) so MCP tools
   * like `log10x_advise_compact` can default `gitops_repo` from the
   * running pod.
   */
  env?: Record<string, string>;
}

/** A Helm release in the cluster (what `helm list -A` returns). */
export interface HelmRelease {
  name: string;
  namespace: string;
  chart: string;
  appVersion: string;
  status: string;
  revision: number;
}

/** An S3 bucket we think could be a log10x retriever target. */
export interface S3Bucket {
  name: string;
  region?: string;
  /** Why we flagged it: name match, tag match, or an IAM policy references it. */
  matchReason: 'name_match' | 'tag_match' | 'iam_reference' | 'listed';
  hasIndexingPrefix?: boolean;
}

/** An SQS queue we think belongs to a retriever install. */
export interface SqsQueue {
  url: string;
  name: string;
  /** Classified role inferred from name suffix: index/query/subquery/stream/dlq. */
  role: 'index' | 'query' | 'subquery' | 'stream' | 'dlq' | 'unknown';
}

/** A CloudWatch log group we think the retriever uses. */
export interface CwLogGroup {
  name: string;
  /** Size in bytes at probe time, if returned by DescribeLogGroups. */
  storedBytes?: number;
}

/** EKS cluster metadata. */
export interface EksCluster {
  name: string;
  endpoint: string;
  version?: string;
  nodeGroups: string[];
}

/** One shell command we ran, for audit + troubleshooting. */
export interface ProbeLogEntry {
  cmd: string;
  exitCode: number;
  ms: number;
  /** Present only on failure — stderr snippet, truncated to 400 chars. */
  stderrSnippet?: string;
}

/** kubectl-side probe results. `available=false` means we couldn't talk to the cluster. */
export interface KubectlProbes {
  available: boolean;
  error?: string;
  context?: string;
  currentNamespace?: string | null;
  namespaces: string[];
  probedNamespaces: string[];
  forwarders: DetectedForwarder[];
  helmReleases: HelmRelease[];
  log10xApps: DetectedLog10xApp[];
  storageClasses: string[];
  ingressClasses: string[];
  /** Service-account annotations per SA in probed namespaces, for IRSA detection. */
  serviceAccountIrsa: Array<{ namespace: string; name: string; roleArn: string }>;
}

/** AWS-side probe results. `available=false` means AWS CLI not configured. */
export interface AwsProbes {
  available: boolean;
  error?: string;
  callerIdentity?: { account: string; arn: string; userId: string };
  region?: string;
  eks?: EksCluster;
  s3Buckets: S3Bucket[];
  sqsQueues: SqsQueue[];
  cwLogGroups: CwLogGroup[];
}

/**
 * Derived hints the advisor tools use to fill in placeholders.
 * Everything here is a best-effort inference — the advise tools
 * should surface the reasoning, not present these as facts.
 */
export interface Recommendations {
  suggestedNamespace: string;
  existingForwarder?: ForwarderKind;
  existingForwarderNamespace?: string;
  retrieverS3Bucket?: string;
  retrieverSqsUrls?: Partial<Record<'index' | 'query' | 'subquery' | 'stream', string>>;
  alreadyInstalled: Partial<Record<Log10xAppKind, string>>;
  /**
   * `GH_REPO` from a running reducer pod, if detected. Used by the
   * MCP's compactReceiver advisor to default the GitOps target repo.
   */
  reducerGitopsRepo?: string;
  /**
   * `compactReceiverLookupFile` from a running reducer pod, if set.
   * Used by the MCP's compactReceiver advisor to default the lookup
   * path inside the GitOps repo.
   */
  reducerCompactLookupFile?: string;
}

/** The complete discovery snapshot. Immutable once emitted. */
export interface DiscoverySnapshot {
  schemaVersion: number;
  snapshotId: string;
  startedAt: string;
  finishedAt: string;
  /** If the caller supplied hints (e.g., explicit region), we record them here. */
  hints?: {
    namespace?: string;
    region?: string;
    forwarderHint?: ForwarderKind;
  };
  kubectl: KubectlProbes;
  aws: AwsProbes;
  recommendations: Recommendations;
  /** Every shell call we made. Truncated to the last 200 entries. */
  probeLog: ProbeLogEntry[];
}
