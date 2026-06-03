/**
 * Orchestrate the discovery probes and produce a DiscoverySnapshot.
 *
 * Runs kubectl + AWS probes in parallel (they're independent) and
 * derives `Recommendations` from the combined facts.
 */

import { probeKubectl, type KubectlProbeOpts } from './kubectl.js';
import { probeAws, type AwsProbeOpts } from './aws.js';
import { newSnapshotId, putSnapshot } from './snapshot-store.js';
import type {
  DiscoverySnapshot,
  ForwarderKind,
  InstalledComponentDetail,
  KubectlProbes,
  AwsProbes,
  Recommendations,
  Log10xAppKind,
} from './types.js';
import { SNAPSHOT_SCHEMA_VERSION } from './types.js';
import { probeReceiverInPath } from '../receiver-probe.js';
import { resolveSiemSelection } from '../siem/resolve.js';
import { getConnector } from '../siem/index.js';

export interface DiscoverOpts {
  kubectl?: KubectlProbeOpts;
  aws?: AwsProbeOpts;
  /** Skip kubectl probes entirely (e.g., the user has no cluster). */
  skipKubectl?: boolean;
  /** Skip AWS probes entirely. */
  skipAws?: boolean;
  /** User hint that overrides detection. */
  forwarderHint?: ForwarderKind;
  /** User hint for target namespace. Defaults to "logging" if unset. */
  namespaceHint?: string;
}

export async function runDiscovery(opts: DiscoverOpts = {}): Promise<DiscoverySnapshot> {
  const startedAt = new Date().toISOString();
  const snapshotId = newSnapshotId();

  const kubectlP = opts.skipKubectl
    ? Promise.resolve({ probes: emptyKubectl(), log: [] })
    : probeKubectl(opts.kubectl);
  const awsP = opts.skipAws
    ? Promise.resolve({ probes: emptyAws(), log: [] })
    : probeAws(opts.aws);

  const [k, a] = await Promise.all([kubectlP, awsP]);

  // After kubectl probes complete, run the receiver-in-path SIEM probe.
  // Best-effort: failure returns null (inconclusive) and never aborts discovery.
  let receiverInPath: boolean | null = null;
  try {
    const PROBE_VENDORS = ['datadog', 'splunk', 'elasticsearch', 'cloudwatch'] as const;
    const siemResolution = await resolveSiemSelection({ restrictTo: [...PROBE_VENDORS] });
    if (siemResolution.kind === 'resolved') {
      const connector = getConnector(siemResolution.id);
      receiverInPath = await probeReceiverInPath(siemResolution.id, connector);
    }
  } catch {
    // SIEM probe failure is non-fatal — leave receiverInPath as null.
  }

  const recommendations = deriveRecommendations(k.probes, a.probes, opts, receiverInPath);
  const finishedAt = new Date().toISOString();

  const snapshot: DiscoverySnapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    startedAt,
    finishedAt,
    hints: {
      namespace: opts.namespaceHint,
      region: opts.aws?.region,
      forwarderHint: opts.forwarderHint,
    },
    kubectl: k.probes,
    aws: a.probes,
    recommendations,
    probeLog: [...k.log, ...a.log].slice(-200),
  };

  putSnapshot(snapshot);
  return snapshot;
}

function emptyKubectl(): KubectlProbes {
  return {
    available: false,
    error: 'probe skipped',
    namespaces: [],
    probedNamespaces: [],
    forwarders: [],
    helmReleases: [],
    log10xApps: [],
    storageClasses: [],
    ingressClasses: [],
    serviceAccountIrsa: [],
    backendAgents: [],
  };
}

function emptyAws(): AwsProbes {
  return {
    available: false,
    error: 'probe skipped',
    s3Buckets: [],
    sqsQueues: [],
    cwLogGroups: [],
  };
}

/**
 * Turn raw facts into concrete recommendations the advise tools consume.
 * Conservative: if we can't confidently infer, we leave the field unset
 * so the advisor surfaces a "needs user input" placeholder.
 */
function deriveRecommendations(
  kubectl: KubectlProbes,
  aws: AwsProbes,
  opts: DiscoverOpts,
  receiverInPath: boolean | null = null
): Recommendations {
  const alreadyInstalled: Partial<Record<Log10xAppKind, string>> = {};
  const installedComponentsDetail: Partial<Record<'reporter' | 'receiver' | 'retriever', InstalledComponentDetail>> = {};

  for (const app of kubectl.log10xApps) {
    // First wins — multiple components of the same app share a namespace.
    if (!alreadyInstalled[app.kind]) alreadyInstalled[app.kind] = app.namespace;

    // Build installedComponentsDetail for concrete (non-unknown) kinds that
    // map to the user-visible component set.
    if (app.kind === 'reporter' || app.kind === 'receiver' || app.kind === 'retriever') {
      if (!installedComponentsDetail[app.kind]) {
        installedComponentsDetail[app.kind] = {
          installed: true,
          pod: app.workloadName,
          namespace: app.namespace,
          image: app.image,
          workload: `${app.workloadKind}/${app.workloadName}`,
        };
      }
    }
  }

  // Forwarder inference: if user supplied a hint, use it. Otherwise pick the
  // most-replica forwarder workload as the "primary."
  let existingForwarder: ForwarderKind | undefined = opts.forwarderHint;
  let existingForwarderNamespace: string | undefined;
  if (!existingForwarder && kubectl.forwarders.length > 0) {
    const sorted = [...kubectl.forwarders].sort((a, b) => b.readyReplicas - a.readyReplicas);
    existingForwarder = sorted[0].kind;
    existingForwarderNamespace = sorted[0].namespace;
  } else if (existingForwarder) {
    const match = kubectl.forwarders.find((f) => f.kind === existingForwarder);
    if (match) existingForwarderNamespace = match.namespace;
  }

  // Namespace suggestion: use the hint if given; else if forwarder exists,
  // use that namespace; else fall back to "logging".
  const suggestedNamespace =
    opts.namespaceHint ??
    existingForwarderNamespace ??
    (alreadyInstalled.reporter ?? alreadyInstalled.receiver ?? alreadyInstalled.retriever) ??
    'logging';

  // Retriever S3 bucket: prefer one with an indexing-results prefix.
  const retrieverBucket =
    aws.s3Buckets.find((b) => b.hasIndexingPrefix)?.name ?? aws.s3Buckets[0]?.name;

  // Retriever SQS URLs: group by role.
  const retrieverSqsUrls: Recommendations['retrieverSqsUrls'] = {};
  for (const q of aws.sqsQueues) {
    if (q.role === 'dlq' || q.role === 'unknown') continue;
    const current = retrieverSqsUrls[q.role];
    // Prefer non-dlq, and first seen.
    if (!current) retrieverSqsUrls[q.role] = q.url;
  }

  // Pull GitOps + compactReceiver wiring from any running receiver pod.
  // Multiple receivers in the cluster (e.g., dev + prod) is rare;
  // first-wins matches the alreadyInstalled iteration above. Only record
  // GH_REPO if GH_ENABLED is also literally "true" — a repo set with the
  // master switch off would mislead the compact advisor.
  let receiverGitopsRepo: string | undefined;
  let receiverCompactLookupFile: string | undefined;
  for (const app of kubectl.log10xApps) {
    if (app.kind !== 'receiver') continue;
    const env = app.env ?? {};
    if (env.GH_ENABLED === 'true' && env.GH_REPO) {
      receiverGitopsRepo = env.GH_REPO;
    }
    if (env.compactReceiverLookupFile) {
      receiverCompactLookupFile = env.compactReceiverLookupFile;
    }
    if (receiverGitopsRepo || receiverCompactLookupFile) break;
  }

  // Build receiverInPathReason: only when receiver is installed but not in-path.
  const receiverDetail = installedComponentsDetail.receiver;
  let receiverInPathReason: string | undefined;
  if (receiverDetail && receiverInPath === false) {
    receiverInPathReason =
      `Receiver pod is deployed but events flowing to the log analyzer` +
      ` do not carry tenx_hash. Possible causes: forwarder bypassing` +
      ` the Receiver (check fluentd/vector/logstash output config), or` +
      ` the Receiver is unhealthy. Inspect: kubectl logs ${receiverDetail.pod} -c log10x.`;
  }

  return {
    suggestedNamespace,
    existingForwarder,
    existingForwarderNamespace,
    retrieverS3Bucket: retrieverBucket,
    receiverGitopsRepo,
    receiverCompactLookupFile,
    retrieverSqsUrls: Object.keys(retrieverSqsUrls).length > 0 ? retrieverSqsUrls : undefined,
    alreadyInstalled,
    installedComponentsDetail: Object.keys(installedComponentsDetail).length > 0
      ? installedComponentsDetail
      : undefined,
    receiverInPath: receiverInPath,
    receiverInPathReason,
  };
}
