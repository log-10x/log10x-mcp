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
  KubectlProbes,
  AwsProbes,
  Recommendations,
  Log10xAppKind,
} from './types.js';
import { SNAPSHOT_SCHEMA_VERSION } from './types.js';

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

  const recommendations = deriveRecommendations(k.probes, a.probes, opts);
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
  opts: DiscoverOpts
): Recommendations {
  const alreadyInstalled: Partial<Record<Log10xAppKind, string>> = {};
  for (const app of kubectl.log10xApps) {
    // First wins — multiple components of the same app share a namespace.
    if (!alreadyInstalled[app.kind]) alreadyInstalled[app.kind] = app.namespace;
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
    (alreadyInstalled.reporter ?? alreadyInstalled.regulator ?? alreadyInstalled.retriever) ??
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

  // Pull GitOps + compactRegulator wiring from any running regulator pod.
  // Multiple regulators in the cluster (e.g., dev + prod) is rare;
  // first-wins matches the alreadyInstalled iteration above. Only record
  // GH_REPO if GH_ENABLED is also literally "true" — a repo set with the
  // master switch off would mislead the compact advisor.
  let regulatorGitopsRepo: string | undefined;
  let regulatorCompactLookupFile: string | undefined;
  for (const app of kubectl.log10xApps) {
    if (app.kind !== 'regulator') continue;
    const env = app.env ?? {};
    if (env.GH_ENABLED === 'true' && env.GH_REPO) {
      regulatorGitopsRepo = env.GH_REPO;
    }
    if (env.compactRegulatorLookupFile) {
      regulatorCompactLookupFile = env.compactRegulatorLookupFile;
    }
    if (regulatorGitopsRepo || regulatorCompactLookupFile) break;
  }

  return {
    suggestedNamespace,
    existingForwarder,
    existingForwarderNamespace,
    retrieverS3Bucket: retrieverBucket,
    regulatorGitopsRepo,
    regulatorCompactLookupFile,
    retrieverSqsUrls: Object.keys(retrieverSqsUrls).length > 0 ? retrieverSqsUrls : undefined,
    alreadyInstalled,
  };
}
