/**
 * log10x_discover_env
 *
 * Read-only discovery of the caller's Kubernetes cluster + AWS account.
 * Produces a DiscoverySnapshot (stored in-memory for 30 min) and a
 * terse markdown report of what was found. The advise_{reporter,
 * receiver, retriever} tools consume the snapshot by id.
 *
 * Nothing here mutates state. Every probe is a `kubectl get` or
 * `aws ...describe/list` call. If kubectl or aws isn't configured, the
 * corresponding probe section shows `available: false` and the advise
 * tools fall back to asking the user for the facts.
 */

import { z } from 'zod';
import { runDiscovery } from '../lib/discovery/orchestrate.js';
import type { DiscoverySnapshot, ForwarderKind } from '../lib/discovery/types.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { type StructuredOutput } from '../lib/output-types.js';
import { newChassisTelemetry, recordQuery, buildChassisEnvelope, buildChassisErrorEnvelope } from '../lib/chassis-envelope.js';

export const discoverEnvSchema = {
  namespaces: z
    .array(z.string())
    .optional()
    .describe(
      'Explicit list of Kubernetes namespaces to probe. If omitted, the tool auto-picks up to 5 likely candidates (demo, logging, observability, otel-demo, default) plus kube-system.'
    ),
  region: z
    .string()
    .optional()
    .describe('AWS region to probe. If omitted, uses the region from your AWS CLI profile.'),
  eks_cluster_name: z
    .string()
    .optional()
    .describe(
      'EKS cluster to describe. If omitted and exactly one cluster exists in the account/region, that one is auto-selected.'
    ),
  bucket_hint: z
    .string()
    .optional()
    .describe(
      'Substring to match against S3 bucket names. Defaults to "retriever"; also matches "log10x" and "tenx" out of the box.'
    ),
  forwarder_hint: z
    .enum(['fluentbit', 'fluentd', 'filebeat', 'logstash', 'otel-collector', 'vector'])
    .optional()
    .describe(
      'Override forwarder detection. Use this if multiple forwarders are running and you want the advisor to target a specific one.'
    ),
  namespace_hint: z
    .string()
    .optional()
    .describe('Preferred namespace for new installs. Defaults to "logging" unless an existing forwarder namespace is found.'),
  skip_kubectl: z
    .boolean()
    .optional()
    .describe('Skip all kubectl probes (for AWS-only discovery or when cluster access is restricted).'),
  skip_aws: z.boolean().optional().describe('Skip all AWS probes (for cluster-only discovery).'),
};

const schemaObj = z.object(discoverEnvSchema);
export type DiscoverEnvArgs = z.infer<typeof schemaObj>;

interface InstalledComponentDetailSummary {
  installed: true;
  pod: string;
  namespace: string;
  image: string;
  workload: string;
}

interface DiscoverEnvSummary {
  snapshot_id: string;
  started_at: string;
  finished_at: string;
  kubectl_available: boolean;
  aws_available: boolean;
  forwarder_kind?: string;
  forwarder_namespace?: string;
  installed_components: {
    reporter: boolean;
    receiver: boolean;
    retriever: boolean;
  };
  installed_components_detail?: Partial<Record<'reporter' | 'receiver' | 'retriever', InstalledComponentDetailSummary>>;
  receiver_in_path?: boolean | null;
  receiver_in_path_reason?: string | null;
  namespaces_probed: string[];
  eks_cluster?: string;
  region?: string;
  s3_buckets: string[];
  sqs_queues: string[];
  log_groups_count: number;
  probe_log_entry_count: number;
  human_summary: string;
}

function buildDiscoverEnvHumanSummary(d: Omit<DiscoverEnvSummary, 'human_summary'>): string {
  const installed = Object.entries(d.installed_components).filter(([, v]) => v).map(([k]) => k);
  const installedFrag = installed.length > 0 ? installed.join(', ') : 'none';
  const fwd = d.forwarder_kind ?? 'none detected';
  const awsFrag = d.aws_available
    ? ` AWS: region ${d.region ?? 'unknown'}, ${d.s3_buckets.length} matching S3 bucket${d.s3_buckets.length === 1 ? '' : 's'}, ${d.sqs_queues.length} SQS queue${d.sqs_queues.length === 1 ? '' : 's'}.`
    : ' AWS probes were unavailable.';
  let inPathFrag = '';
  if (d.installed_components.receiver && d.receiver_in_path !== undefined && d.receiver_in_path !== null) {
    inPathFrag = d.receiver_in_path ? ', receiver in-path' : ', receiver NOT in-path';
  } else if (d.installed_components.receiver && d.receiver_in_path === null) {
    inPathFrag = ', receiver in-path status unknown';
  }
  return `Discovery snapshot ${d.snapshot_id} done in ${d.namespaces_probed.length} namespace${d.namespaces_probed.length === 1 ? '' : 's'}: forwarder=${fwd}, log10x apps installed=${installedFrag}${inPathFrag}.${awsFrag}`;
}

export async function executeDiscoverEnv(args: DiscoverEnvArgs): Promise<string | StructuredOutput> {
  const telemetry = newChassisTelemetry();
  const snapshot = await runDiscovery({
    kubectl: { namespaces: args.namespaces },
    aws: {
      region: args.region,
      eksClusterName: args.eks_cluster_name,
      bucketHint: args.bucket_hint,
    },
    forwarderHint: args.forwarder_hint as ForwarderKind | undefined,
    namespaceHint: args.namespace_hint,
    skipKubectl: args.skip_kubectl,
    skipAws: args.skip_aws,
  });
  const rec = snapshot.recommendations;
  const installedMap = rec.alreadyInstalled ?? {};
  const topForwarder = snapshot.kubectl?.forwarders?.[0];

  // Compute installed_components: prefer installedComponentsDetail when present
  // (image-probe result), fall back to alreadyInstalled (helm-label result).
  const detail = rec.installedComponentsDetail ?? {};
  const installedComponents = {
    reporter: !!(detail.reporter || (installedMap as Record<string, string | undefined>).reporter),
    receiver: !!(detail.receiver || (installedMap as Record<string, string | undefined>).receiver),
    retriever: !!(detail.retriever || (installedMap as Record<string, string | undefined>).retriever),
  };

  const data: DiscoverEnvSummary = {
    snapshot_id: snapshot.snapshotId,
    started_at: snapshot.startedAt,
    finished_at: snapshot.finishedAt,
    kubectl_available: !!snapshot.kubectl?.available,
    aws_available: !!snapshot.aws?.available,
    forwarder_kind: rec.existingForwarder ?? topForwarder?.kind,
    forwarder_namespace: rec.existingForwarderNamespace ?? topForwarder?.namespace,
    installed_components: installedComponents,
    installed_components_detail: Object.keys(detail).length > 0 ? detail : undefined,
    receiver_in_path: rec.receiverInPath,
    receiver_in_path_reason: rec.receiverInPathReason ?? null,
    namespaces_probed: snapshot.kubectl?.probedNamespaces ?? [],
    eks_cluster: snapshot.aws?.eks?.name,
    region: snapshot.aws?.region,
    s3_buckets: (snapshot.aws?.s3Buckets ?? []).map((b) => b.name),
    sqs_queues: (snapshot.aws?.sqsQueues ?? []).map((q) => q.url),
    log_groups_count: snapshot.aws?.cwLogGroups?.length ?? 0,
    probe_log_entry_count: snapshot.probeLog?.length ?? 0,
    human_summary: '',
  };
  data.human_summary = buildDiscoverEnvHumanSummary(data);
  const installedList = Object.entries(data.installed_components).filter(([, v]) => v).map(([k]) => k);

  // Build the installed fragment for the headline — when receiver is installed
  // but not in-path, surface that state explicitly.
  function installedLabel(k: string): string {
    if (k === 'receiver' && data.receiver_in_path === false) return 'receiver(not in path)';
    if (k === 'receiver' && data.receiver_in_path === null) return 'receiver(in-path unknown)';
    return k;
  }
  const installedHeadlineFrag = installedList.length
    ? installedList.map(installedLabel).join(',')
    : 'none';
  const headline = `Snapshot \`${data.snapshot_id}\`: forwarder=${data.forwarder_kind ?? 'none'}, installed=${installedHeadlineFrag}, kubectl=${data.kubectl_available ? 'ok' : 'unavailable'}, aws=${data.aws_available ? 'ok' : 'unavailable'}.`;
  const actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }> = [];
  if (!data.installed_components.reporter) {
    actions.push({ tool: 'log10x_advise_install', args: { snapshot_id: data.snapshot_id }, reason: 'no Reporter installed — pick the right install path' });
  } else if (!data.installed_components.receiver) {
    actions.push({ tool: 'log10x_advise_install', args: { snapshot_id: data.snapshot_id, app: 'receiver' }, reason: 'Reporter present, no Receiver — install for filter / compact / cap' });
  }
  // When Receiver is installed but bypassed, surface a nudge to fix the forwarder wiring.
  if (data.installed_components.receiver && data.receiver_in_path === false) {
    actions.push({
      tool: 'log10x_advise_install',
      args: { snapshot_id: data.snapshot_id },
      reason: 'Receiver installed but bypassed by forwarder. Verify the forwarder config wires log10x in-path.',
    });
  }
  if (data.aws_available && data.s3_buckets.length > 0 && !data.installed_components.retriever) {
    actions.push({ tool: 'log10x_advise_retriever', args: { snapshot_id: data.snapshot_id }, reason: 'S3 + AWS available — Retriever installable for forensic retrieval' });
  }
  return buildChassisEnvelope({
    tool: 'log10x_discover_env',
    view: 'summary',
    headline,
    status: 'success',
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {},
    scope: {
      window: 'point_in_time',
      window_basis: 'auto_default',
      candidates_count: data.namespaces_probed.length,
      candidates_usable: data.kubectl_available ? data.namespaces_probed.length : 0,
    },
    payload: data,
    human_summary: data.human_summary,
    actions,
    telemetry,
  });
}

/**
 * Render a terse markdown report. Designed for agent consumption:
 *   - Lead with snapshot_id so the next tool call knows what to quote.
 *   - Summarize findings per-section in <= 10 lines.
 *   - List "what to do next" tool calls at the bottom.
 */
export function renderDiscoverReport(s: DiscoverySnapshot): string {
  const lines: string[] = [];
  lines.push(`# Discovery snapshot \`${s.snapshotId}\``);
  lines.push('');
  lines.push(`- **schema**: v${s.schemaVersion}`);
  lines.push(`- **started**: ${s.startedAt}`);
  lines.push(`- **finished**: ${s.finishedAt}`);
  const hints = s.hints ?? {};
  if (hints.namespace || hints.region || hints.forwarderHint) {
    lines.push(
      `- **hints**: ${[
        hints.namespace ? `namespace=${hints.namespace}` : null,
        hints.region ? `region=${hints.region}` : null,
        hints.forwarderHint ? `forwarder=${hints.forwarderHint}` : null,
      ]
        .filter(Boolean)
        .join(', ')}`
    );
  }
  lines.push('');

  // ── Kubernetes ──
  lines.push('## Kubernetes');
  if (!s.kubectl.available) {
    lines.push(`- **status**: unavailable — ${s.kubectl.error ?? 'unknown error'}`);
  } else {
    lines.push(`- **context**: \`${s.kubectl.context ?? 'unknown'}\``);
    lines.push(
      `- **probed namespaces** (${s.kubectl.probedNamespaces.length}): ${s.kubectl.probedNamespaces.join(', ') || 'none'}`
    );

    if (s.kubectl.forwarders.length === 0) {
      lines.push('- **forwarders detected**: none');
    } else {
      lines.push(`- **forwarders detected** (${s.kubectl.forwarders.length}):`);
      for (const f of s.kubectl.forwarders) {
        lines.push(
          `  - \`${f.kind}\` — ${f.workloadKind}/${f.workloadName} in \`${f.namespace}\` (image: \`${f.image}\`, ready: ${f.readyReplicas})`
        );
      }
    }

    if (s.kubectl.log10xApps.length === 0) {
      lines.push('- **log10x apps installed**: none');
    } else {
      lines.push(`- **log10x apps installed** (${s.kubectl.log10xApps.length}):`);
      for (const a of s.kubectl.log10xApps) {
        const hr = a.helmRelease ? ` (helm: \`${a.helmRelease}\`)` : '';
        lines.push(`  - \`${a.kind}\` — ${a.workloadKind}/${a.workloadName} in \`${a.namespace}\`${hr}`);
      }
    }

    if (s.kubectl.helmReleases.length > 0) {
      lines.push(`- **helm releases** (${s.kubectl.helmReleases.length}):`);
      for (const h of s.kubectl.helmReleases.slice(0, 12)) {
        lines.push(`  - \`${h.name}\` in \`${h.namespace}\` — chart \`${h.chart}\` (${h.status})`);
      }
      if (s.kubectl.helmReleases.length > 12) {
        lines.push(`  - … and ${s.kubectl.helmReleases.length - 12} more`);
      }
    }

    if (s.kubectl.serviceAccountIrsa.length > 0) {
      lines.push(`- **IRSA service accounts** (${s.kubectl.serviceAccountIrsa.length}):`);
      for (const sa of s.kubectl.serviceAccountIrsa.slice(0, 6)) {
        lines.push(`  - \`${sa.namespace}/${sa.name}\` → \`${sa.roleArn}\``);
      }
    }

    if (s.kubectl.backendAgents.length === 0) {
      lines.push('- **metrics-backend agents detected**: none');
    } else {
      lines.push(`- **metrics-backend agents detected** (${s.kubectl.backendAgents.length}):`);
      for (const b of s.kubectl.backendAgents) {
        lines.push(`  - **${b.kind}** (${b.confidence}) — ${b.evidence}`);
      }
    }
  }
  lines.push('');

  // ── AWS ──
  lines.push('## AWS');
  if (!s.aws.available) {
    lines.push(`- **status**: unavailable — ${s.aws.error ?? 'unknown error'}`);
  } else {
    const id = s.aws.callerIdentity;
    lines.push(`- **account**: \`${id?.account ?? '?'}\` (\`${id?.arn ?? '?'}\`)`);
    lines.push(`- **region**: \`${s.aws.region ?? '?'}\``);
    if (s.aws.eks) {
      lines.push(
        `- **EKS cluster**: \`${s.aws.eks.name}\` (v${s.aws.eks.version ?? '?'}), node groups: ${s.aws.eks.nodeGroups.join(', ') || 'none'}`
      );
    } else {
      lines.push('- **EKS cluster**: not auto-detected (pass `eks_cluster_name` to describe a specific one)');
    }

    if (s.aws.s3Buckets.length === 0) {
      lines.push('- **S3 buckets** matching hint: none');
    } else {
      lines.push(`- **S3 buckets** matching hint (${s.aws.s3Buckets.length}):`);
      for (const b of s.aws.s3Buckets.slice(0, 6)) {
        const ip = b.hasIndexingPrefix ? ' (has `indexing-results/` prefix)' : '';
        lines.push(`  - \`${b.name}\`${ip}`);
      }
    }

    if (s.aws.sqsQueues.length === 0) {
      lines.push('- **SQS queues** matching hint: none');
    } else {
      lines.push(`- **SQS queues** (${s.aws.sqsQueues.length}):`);
      for (const q of s.aws.sqsQueues.slice(0, 12)) {
        lines.push(`  - \`${q.name}\` (role: ${q.role})`);
      }
    }

    if (s.aws.cwLogGroups.length > 0) {
      lines.push(`- **CloudWatch log groups** (${s.aws.cwLogGroups.length}):`);
      for (const g of s.aws.cwLogGroups.slice(0, 6)) lines.push(`  - \`${g.name}\``);
    }
  }
  lines.push('');

  // ── Recommendations ──
  lines.push('## Recommendations');
  const r = s.recommendations;
  lines.push(`- **suggested namespace**: \`${r.suggestedNamespace}\``);
  if (r.existingForwarder) {
    lines.push(
      `- **existing forwarder**: \`${r.existingForwarder}\` in \`${r.existingForwarderNamespace ?? '?'}\` — advisor will target this unless you override`
    );
  } else {
    lines.push('- **existing forwarder**: none — advisor will ask which one you want to install');
  }
  const installed = Object.entries(r.alreadyInstalled);
  if (installed.length > 0) {
    lines.push(`- **already installed**: ${installed.map(([k, v]) => `${k} (in \`${v}\`)`).join(', ')}`);
  }
  if (r.retrieverS3Bucket) {
    lines.push(`- **retriever S3 bucket candidate**: \`${r.retrieverS3Bucket}\``);
  }
  if (r.retrieverSqsUrls) {
    lines.push(`- **retriever SQS roles detected**: ${Object.keys(r.retrieverSqsUrls).join(', ')}`);
  }
  lines.push('');

  // ── Next steps ──
  lines.push('## Next steps');
  lines.push('Pass this snapshot id to an advisor:');
  lines.push('');
  lines.push('```');
  lines.push(`log10x_advise_install({ snapshot_id: "${s.snapshotId}" })     # wizard for Reporter / Receiver`);
  lines.push(`log10x_advise_retriever({ snapshot_id: "${s.snapshotId}" })   # archive install (S3 + SQS)`);
  lines.push('```');
  lines.push('');
  lines.push(
    `_Snapshot is cached in-memory for 30 min. Re-run \`log10x_discover_env\` for a fresh probe._`
  );

  // Structured chain hint: advise_install is the install wizard for the
  // Reporter and Receiver; advise_retriever is the archive install (its
  // inputs are AWS-only — S3 buckets, SQS URLs, IRSA — so it stays a
  // separate tool).
  const nextActions: NextAction[] = [
    {
      tool: 'log10x_advise_install',
      args: { snapshot_id: s.snapshotId },
      reason: 'install wizard: walks through app (Reporter / Receiver), forwarder, backends, airgapped, license — emits a helm plan',
    },
    {
      tool: 'log10x_advise_retriever',
      args: { snapshot_id: s.snapshotId },
      reason: 'Retriever (S3 archive) install plan',
    },
  ];
  // Compact configuration hint: scoped on the snapshot. When GitOps is wired
  // (receiverGitopsRepo present) the tool can emit a real per-container cap-file
  // PR; otherwise it returns a coherent "GitOps not configured" markdown.
  // Either path is a productive chain hop — leaving this off means autonomous
  // chains asking "would compact mode save us money?" dead-end after install
  // advice. The tool also handles the service → containers resolution step,
  // so we hint at it without a specific service (the agent picks one).
  nextActions.push({
    tool: 'log10x_configure_engine',
    args: { snapshot_id: s.snapshotId },
    reason: s.recommendations.receiverGitopsRepo
      ? 'snapshot detected receiver with GitOps wired up — author a per-pattern action-plan PR'
      : 'configure_engine will return a truthful negative if GitOps is not yet wired (chain handoff is still informative)',
  });
  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);

  return lines.join('\n');
}
