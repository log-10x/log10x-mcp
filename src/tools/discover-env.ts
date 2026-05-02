/**
 * log10x_discover_env
 *
 * Read-only discovery of the caller's Kubernetes cluster + AWS account.
 * Produces a DiscoverySnapshot (stored in-memory for 30 min) and a
 * terse markdown report of what was found. The advise_{reporter,
 * reducer, retriever} tools consume the snapshot by id.
 *
 * Nothing here mutates state. Every probe is a `kubectl get` or
 * `aws ...describe/list` call. If kubectl or aws isn't configured, the
 * corresponding probe section shows `available: false` and the advise
 * tools fall back to asking the user for the facts.
 */

import { z } from 'zod';
import { runDiscovery } from '../lib/discovery/orchestrate.js';
import type { DiscoverySnapshot, ForwarderKind } from '../lib/discovery/types.js';

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
    .enum(['fluent-bit', 'fluentd', 'filebeat', 'logstash', 'otel-collector'])
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

export async function executeDiscoverEnv(args: DiscoverEnvArgs): Promise<string> {
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
  return renderDiscoverReport(snapshot);
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
  lines.push(`log10x_advise_reporter({ snapshot_id: "${s.snapshotId}" })`);
  lines.push(`log10x_advise_receiver({ snapshot_id: "${s.snapshotId}" })`);
  lines.push(`log10x_advise_retriever({ snapshot_id: "${s.snapshotId}" })`);
  lines.push('```');
  lines.push('');
  lines.push(
    `_Snapshot is cached in-memory for 30 min. Re-run \`log10x_discover_env\` for a fresh probe._`
  );

  return lines.join('\n');
}
