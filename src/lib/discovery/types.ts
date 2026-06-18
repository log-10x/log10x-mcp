/**
 * Shared types for the install-advisor discovery + advise tools.
 *
 * The snapshot is the *only* contract between `discover_env` and
 * `advise_{reporter,receiver,retriever}`. Adding a field here is a
 * wire-format change — bump `SNAPSHOT_SCHEMA_VERSION` below.
 */

export const SNAPSHOT_SCHEMA_VERSION = 3;

/** Which forwarder the customer is running. `unknown` = detection gave up. */
export type ForwarderKind =
  | 'fluentbit'
  | 'fluentd'
  | 'filebeat'
  | 'logstash'
  | 'otel-collector'
  | 'vector'
  | 'unknown';

/** Log10x apps we look for already being installed. */
export type Log10xAppKind = 'reporter' | 'receiver' | 'retriever' | 'compiler' | 'unknown';

/**
 * Metrics backends the engine can emit TenXSummary to.
 * Mirrors the modules in `config/pipelines/run/output/metric/`.
 * - `log10x` is the SaaS Prometheus default (requires online egress)
 * - `prometheus` covers all three sub-flavors (remote-write, push-gateway,
 *   scrape); the wizard picks the sub-flavor at install time
 */
export type MetricsBackendKind =
  | 'log10x'
  | 'datadog'
  | 'elastic'
  | 'cloudwatch'
  | 'signalfx'
  | 'prometheus';

/**
 * A metrics-backend agent we detected running in the cluster. The wizard
 * surfaces these as the "where should metrics go" pre-filled options:
 * picking a detected backend means TenXSummary metrics ride alongside
 * the user's existing logs/metrics on the same SIEM.
 */
export interface DetectedMetricsBackend {
  kind: MetricsBackendKind;
  /** Confidence of the detection — higher = more reliable. */
  confidence: 'helm-release' | 'workload-match' | 'crd-only' | 'namespace-only';
  /** Where the match came from. Free-form for diagnostic transparency. */
  evidence: string;
  /** Namespace the agent lives in (when applicable). */
  namespace?: string;
}

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

/**
 * Detail for a single installed log10x component, captured from the
 * container-image probe (not just the helm-label path). Used by
 * discover_env to populate `installed_components_detail`.
 */
export interface InstalledComponentDetail {
  installed: true;
  /** Pod name from the workload (workload name, not individual pod). */
  pod: string;
  namespace: string;
  image: string;
  /** Workload kind and name, e.g. "DaemonSet/tenx-fluentd". */
  workload: string;
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
   * like `log10x_configure_engine` can default `gitops_repo` from the
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
  /**
   * OIDC provider URL without the https:// scheme prefix.
   * e.g. "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE"
   * Extracted from cluster.identity.oidc.issuer in describe-cluster JSON.
   */
  oidcIssuer?: string;
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
  /**
   * Metrics-backend agents detected in the cluster (Datadog Agent, Splunk
   * OTel Collector, Elastic Agent, Prometheus Operator, CloudWatch Agent,
   * etc.). The wizard uses this to pre-fill "where should metrics go".
   * Empty list = no agents detected; the wizard falls back to log10x SaaS.
   */
  backendAgents: DetectedMetricsBackend[];
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
   * `GH_REPO` from a running receiver pod, if detected. Used by the
   * MCP's compactReceiver advisor to default the GitOps target repo.
   */
  receiverGitopsRepo?: string;
  /**
   * `compactReceiverLookupFile` from a running receiver pod, if set.
   * Used by the MCP's compactReceiver advisor to default the lookup
   * path inside the GitOps repo.
   */
  receiverCompactLookupFile?: string;
  /**
   * Detailed component detection from the image-pattern probe.
   * Keyed by component kind (reporter/receiver/retriever). Present only
   * for components that were positively matched by image name heuristics.
   * Supersedes the simpler `alreadyInstalled` boolean map when richer
   * context is needed (pod name, image, workload reference).
   */
  installedComponentsDetail?: Partial<Record<'reporter' | 'receiver' | 'retriever', InstalledComponentDetail>>;
  /**
   * Whether the Receiver is actively stamping events flowing to the log
   * analyzer (SIEM). Determined by probing recent events for tenx_hash.
   *
   * - true  → tenx_hash found in a recent sample event (Receiver in-path)
   * - false → No hash in recent sample (Receiver deployed but bypassed, or not deployed)
   * - null  → Probe inconclusive (no events in window, or SIEM credentials unavailable)
   *
   * Only populated when at least one SIEM credential set is available.
   */
  receiverInPath?: boolean | null;
  /**
   * Human-readable explanation of why receiverInPath is false when the
   * Receiver appears to be installed. Only set when
   * installedComponentsDetail.receiver is present AND receiverInPath === false.
   */
  receiverInPathReason?: string;
}

/**
 * Per-backend credential configuration the wizard collects from the user
 * and the renderer threads into helm values.
 *
 * `secretName` is the name of a Kubernetes Secret the user creates (or
 * already has) that holds sensitive env vars (`DD_API_KEY`,
 * `AWS_SECRET_ACCESS_KEY`, etc.) for this backend. The wizard emits
 * `valueFrom.secretKeyRef` references; user creates the Secret out-of-band
 * before `helm upgrade`. Default name when unset: `<backend>-credentials`.
 *
 * `plainValues` carries non-sensitive overrides keyed by env var name
 * (e.g., `{ DD_SITE: 'us5.datadoghq.com', CW_NAMESPACE: 'Log10x' }`).
 * Each backend has its own spec of which env vars are sensitive vs plain;
 * see `BACKEND_ENV_SPECS` in `lib/advisor/reporter-forwarders.ts`.
 */
export interface BackendCredentialConfig {
  secretName: string;
  plainValues?: Record<string, string>;
}

/**
 * Wizard session — accumulated user answers across multiple
 * `advise_install` calls against the same snapshot. The MCP is stateless
 * per call, but the wizard is conversational; the session lets each turn
 * merge the user's latest answer with previously-answered questions
 * without re-asking. Attached to a snapshot by id and shares its TTL.
 *
 * All fields optional — the wizard's job is to figure out which are
 * still missing and ask for them. Once `app` is set, the wizard knows
 * which branch to drive (standalone Reporter vs sidecar Receiver).
 */
export interface WizardSession {
  snapshotId: string;
  /**
   * 'reporter' = "deploy a dedicated DaemonSet forwarder" (standalone)
   * 'receiver' = "plug into existing forwarder" (sidecar)
   */
  app?: 'reporter' | 'receiver';
  /** Receiver-only: which forwarder kind to sidecar into. */
  forwarder?: ForwarderKind;
  /**
   * Where TenXSummary metrics go. Multi-destination — a user can report
   * to log10x SaaS AND their own Datadog/Prom/etc. simultaneously. The
   * only mutual exclusion is `airgapped: true` + `'log10x'` in this list
   * (airgapped means the engine sends NOTHING to log10x).
   */
  backends?: MetricsBackendKind[];
  /**
   * Per-backend credential configuration the wizard collected. Indexed
   * by backend kind. Only set for non-`log10x` backends — the `log10x`
   * SaaS path uses the license JWT and needs no extra credentials.
   */
  backendCredentials?: Partial<Record<MetricsBackendKind, BackendCredentialConfig>>;
  /**
   * When true, the engine emits no outbound traffic to log10x.com (no
   * engine telemetry, no online license re-validation, no update probes).
   * `'log10x'` must not be in `backends` when this is true — the wizard
   * surfaces the conflict if both are picked.
   *
   * Demo licenses can't actually run airgapped — the engine downgrades
   * to online mode with a warning. The wizard surfaces this softly.
   */
  airgapped?: boolean;
  /** Helm release name override. */
  releaseName?: string;
  /** Target namespace override. */
  namespace?: string;
  /**
   * License JWT — minted from `/api/v1/license` (signed-in, user-scoped)
   * or `/api/v1/license/demo` (anonymous, 14-day). The wizard fills this
   * in at plan-emission time based on `licenseSource`.
   */
  licenseJwt?: string;
  /**
   * `true` when the JWT was minted from the demo endpoint. The wizard
   * uses this to emit the "demo + airgapped is a no-op" notice.
   */
  isDemoLicense?: boolean;
  /**
   * Why `acquireLicenseForWizard` took the path it did — copied verbatim
   * from `AcquireLicenseResult.reason`. The wizard's demo+airgapped
   * warning branches on this to pick the right "here's why we couldn't
   * mint a user license, and here's what to do" message. Distinguishing
   * "no Auth0 tokens" (sign in via device flow) from "Auth0 tokens
   * present but stale/refused" (retry, or sign in again) avoids
   * misdirecting the user. Absent until the wizard has actually called
   * the license endpoint.
   */
  licenseReason?:
    | 'signed-in-user'
    | 'refreshed-then-user'
    | 'not-signed-in'
    | 'pasted-key-fallback'
    | 'access-token-expired-no-refresh'
    | 'refresh-failed'
    | 'user-license-fetch-failed';
  /**
   * How the user chose to get the license JWT:
   *   - 'signin' — sign in to log10x first, then re-invoke (the
   *     recommended path; produces a real user-scoped license)
   *   - 'demo' — mint an anonymous 14-day demo JWT (transient, can't
   *     run airgapped)
   *   - 'paste' — the user supplied a JWT they already have, via
   *     `license_jwt_paste`
   */
  licenseSource?: 'signin' | 'demo' | 'paste';
  /**
   * `true` once a native elicitation form was dismissed or errored in this
   * session. Some clients (certain Claude Desktop builds) declare the
   * `elicitation` capability but never paint the form, so `elicitInput`
   * resolves as cancelled immediately — retrying just loops on the dead
   * form. Once set, `advise_install` stops trying forms for the rest of
   * this session and asks via markdown questions instead, so the agent can
   * drive the wizard by passing each answer as a tool arg. Clients whose
   * forms render never set this, so their behaviour is unchanged.
   */
  formsDismissed?: boolean;
  /** Last-updated timestamp for diagnostics. */
  updatedAt: string;
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
