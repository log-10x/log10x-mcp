/**
 * Retriever install/verify/teardown plan builder.
 *
 * Unlike Reporter/Reducer (which ride on top of a forwarder), the
 * Retriever is a standalone set of workloads (indexer + query-handler
 * + stream-worker + filter CronJobs) that read from S3 via SQS and
 * serve an HTTP query endpoint. No forwarder choice — just one chart
 * (`log10x/retriever` or the log10x-hosted variant) with AWS infra
 * pointers.
 *
 * The advisor's job is to:
 *   - Surface the AWS infra the Retriever expects (S3 input bucket,
 *     index bucket, 4 SQS queues, IRSA role).
 *   - Preflight-fail if any of the required AWS resources is missing
 *     from the discovery snapshot.
 *   - Emit a values.yaml that wires the infra into the chart.
 *   - Provide verify probes that prove indexing + querying work.
 *   - Provide teardown (helm uninstall only — leaves AWS infra alone;
 *     infra lifecycle is a Terraform concern).
 */

import type { DiscoverySnapshot } from '../discovery/types.js';
import type { AdvisePlan, PlanStep, VerifyProbe, PreflightCheck } from './types.js';
import { run } from '../discovery/shell.js';

export interface RetrieverAdviseArgs {
  snapshot: DiscoverySnapshot;
  /** Helm release name. Default: `my-retriever`. */
  releaseName?: string;
  /** Target namespace. Default: snapshot's suggestedNamespace. */
  namespace?: string;
  /** Log10x license key. Required for a complete install plan. */
  apiKey?: string;
  /** Override: input S3 bucket name. Default: from snapshot. */
  inputBucket?: string;
  /** Override: index bucket (with prefix). Default: `<inputBucket>/indexing-results/`. */
  indexBucket?: string;
  /** Override: IRSA role ARN for the retriever SA. Default: from snapshot. */
  irsaRoleArn?: string;
  /** Override: SQS queue URLs. Default: from snapshot.recommendations.retrieverSqsUrls. */
  sqsUrls?: {
    index?: string;
    query?: string;
    subquery?: string;
    stream?: string;
  };
  /** Skip install. */
  skipInstall?: boolean;
  /** Skip teardown. */
  skipTeardown?: boolean;
  /** Skip verify. */
  skipVerify?: boolean;
}

const RETRIEVER_CHART_REPO = 'https://log-10x.github.io/helm-charts';
const RETRIEVER_CHART_ALIAS = 'log10x';
const RETRIEVER_CHART_REF = 'log10x/retriever';

export async function buildRetrieverPlan(args: RetrieverAdviseArgs): Promise<AdvisePlan> {
  const snapshot = args.snapshot;
  const releaseName = args.releaseName ?? 'my-retriever';
  const namespace = args.namespace ?? snapshot.recommendations.suggestedNamespace ?? 'logging';

  // Infra: prefer caller-supplied values; fall back to snapshot-derived.
  const inputBucket = args.inputBucket ?? snapshot.recommendations.retrieverS3Bucket;
  const indexBucket = args.indexBucket ?? (inputBucket ? `${inputBucket}/indexing-results/` : undefined);
  const irsaRoleArn =
    args.irsaRoleArn ??
    snapshot.kubectl.serviceAccountIrsa.find((sa) =>
      sa.name.toLowerCase().includes('retriever') || sa.name.toLowerCase().includes('tenx-retriever')
    )?.roleArn;

  const detectedQueues = snapshot.recommendations.retrieverSqsUrls ?? {};
  const sqsUrls = {
    index: args.sqsUrls?.index ?? detectedQueues.index,
    query: args.sqsUrls?.query ?? detectedQueues.query,
    subquery: args.sqsUrls?.subquery ?? detectedQueues.subquery,
    stream: args.sqsUrls?.stream ?? detectedQueues.stream,
  };

  const blockers: string[] = [];
  if (!args.apiKey && !args.skipInstall) {
    blockers.push(
      'Log10x license key is required for an install plan. Pass `api_key` (verify + teardown plans work without it).'
    );
  }
  if (!args.skipInstall) {
    if (!inputBucket) {
      blockers.push(
        'No input S3 bucket detected in the discovery snapshot and none supplied via `input_bucket`. The Retriever reads source logs from S3 — provide a bucket.'
      );
    }
    if (!irsaRoleArn) {
      blockers.push(
        'No retriever IRSA role detected in the discovery snapshot and none supplied via `irsa_role_arn`. The Retriever needs a ServiceAccount annotated with an IAM role that can read from the input bucket, write to the index bucket, and consume from the SQS queues.'
      );
    }
    const missingQueues = (['index', 'query', 'subquery', 'stream'] as const).filter((k) => !sqsUrls[k]);
    if (missingQueues.length > 0) {
      blockers.push(
        `Missing SQS queue URL(s): ${missingQueues.join(', ')}. All four queues (index, query, subquery, stream) are required. Pass via \`sqs_urls\` or provision with the Terraform module first.`
      );
    }
  }

  const preflight = await runPreflight(snapshot, releaseName, namespace, {
    inputBucket,
    indexBucket,
    irsaRoleArn,
    sqsUrls,
  });

  const notes: string[] = [];
  if (snapshot.recommendations.alreadyInstalled.retriever) {
    notes.push(
      `A Retriever is already installed in namespace \`${snapshot.recommendations.alreadyInstalled.retriever}\`. Installing a second release requires a separate set of SQS queues + IRSA role — running two retrievers against the same queues will race.`
    );
  }
  notes.push(
    'Retriever infra (S3 buckets, SQS queues, IAM role + IRSA binding, CloudWatch log groups) is provisioned via the Terraform module, NOT by this advisor. The plan below assumes infra already exists.'
  );

  const install: PlanStep[] = [];
  const verify: VerifyProbe[] = [];
  const teardown: PlanStep[] = [];

  if (!args.skipInstall && blockers.length === 0) {
    install.push(
      ...buildInstallSteps({
        releaseName,
        namespace,
        apiKey: args.apiKey!,
        inputBucket: inputBucket!,
        indexBucket: indexBucket!,
        irsaRoleArn: irsaRoleArn!,
        sqsUrls: sqsUrls as Record<'index' | 'query' | 'subquery' | 'stream', string>,
      })
    );
  }
  if (!args.skipVerify) {
    verify.push(...buildVerifyProbes(releaseName, namespace, inputBucket, sqsUrls.index));
  }
  if (!args.skipTeardown) {
    teardown.push(...buildTeardownSteps(releaseName, namespace));
  }

  return {
    app: 'retriever',
    snapshotId: snapshot.snapshotId,
    releaseName,
    namespace,
    context: snapshot.kubectl.context,
    preflight,
    install,
    verify,
    teardown,
    notes,
    blockers,
  };
}

async function runPreflight(
  snapshot: DiscoverySnapshot,
  releaseName: string,
  namespace: string,
  infra: {
    inputBucket?: string;
    indexBucket?: string;
    irsaRoleArn?: string;
    sqsUrls: Record<string, string | undefined>;
  }
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];

  checks.push({
    name: 'kubectl',
    status: snapshot.kubectl.available ? 'ok' : 'fail',
    detail: snapshot.kubectl.available
      ? `context \`${snapshot.kubectl.context}\``
      : snapshot.kubectl.error ?? 'unknown failure',
  });

  const nsExists = snapshot.kubectl.namespaces.includes(namespace);
  checks.push({
    name: 'namespace',
    status: nsExists ? 'ok' : 'warn',
    detail: nsExists
      ? `\`${namespace}\` exists`
      : `\`${namespace}\` does not exist — the install step will create it`,
  });

  const releaseCollision = snapshot.kubectl.helmReleases.some(
    (h) => h.name === releaseName && h.namespace === namespace
  );
  checks.push({
    name: 'release collision',
    status: releaseCollision ? 'fail' : 'ok',
    detail: releaseCollision
      ? `a Helm release named \`${releaseName}\` already exists in \`${namespace}\` — pick a different release_name or uninstall the existing one first`
      : `no \`${releaseName}\` release in \`${namespace}\` — clear to install`,
  });

  checks.push({
    name: 'AWS access',
    status: snapshot.aws.available ? 'ok' : 'warn',
    detail: snapshot.aws.available
      ? `account \`${snapshot.aws.callerIdentity?.account ?? '?'}\`, region \`${snapshot.aws.region ?? '?'}\``
      : 'AWS CLI not usable; you must pass infra params explicitly',
  });

  checks.push({
    name: 'input S3 bucket',
    status: infra.inputBucket ? 'ok' : 'fail',
    detail: infra.inputBucket
      ? `\`${infra.inputBucket}\``
      : 'no input bucket detected — pass `input_bucket` explicitly',
  });

  checks.push({
    name: 'index S3 prefix',
    status: infra.indexBucket ? 'ok' : 'warn',
    detail: infra.indexBucket ?? 'no index prefix — defaults to `<inputBucket>/indexing-results/`',
  });

  checks.push({
    name: 'IRSA role',
    status: infra.irsaRoleArn ? 'ok' : 'fail',
    detail: infra.irsaRoleArn
      ? `\`${infra.irsaRoleArn}\``
      : 'no retriever IRSA role detected — pass `irsa_role_arn` explicitly',
  });

  for (const key of ['index', 'query', 'subquery', 'stream'] as const) {
    checks.push({
      name: `SQS ${key} queue`,
      status: infra.sqsUrls[key] ? 'ok' : 'fail',
      detail: infra.sqsUrls[key] ? `\`${infra.sqsUrls[key]}\`` : `missing — pass \`sqs_urls.${key}\` explicitly`,
    });
  }

  // Live chart availability probe.
  try {
    await run('helm', ['repo', 'add', RETRIEVER_CHART_ALIAS, RETRIEVER_CHART_REPO, '--force-update'], {
      timeoutMs: 10_000,
    });
    await run('helm', ['repo', 'update', RETRIEVER_CHART_ALIAS], { timeoutMs: 10_000 });
    const search = await run('helm', ['search', 'repo', RETRIEVER_CHART_REF, '-o', 'json'], {
      timeoutMs: 10_000,
    });
    const found = search.exitCode === 0 && (search.stdout || '').includes('retriever');
    checks.push({
      name: 'chart availability',
      status: found ? 'ok' : 'warn',
      detail: found ? `\`${RETRIEVER_CHART_REF}\` is live in repo \`${RETRIEVER_CHART_ALIAS}\`` : `\`helm search repo ${RETRIEVER_CHART_REF}\` returned no matches — check repo URL`,
    });
  } catch (e) {
    checks.push({
      name: 'chart availability',
      status: 'unknown',
      detail: `helm CLI not available or probe errored: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  return checks;
}

function buildInstallSteps(opts: {
  releaseName: string;
  namespace: string;
  apiKey: string;
  inputBucket: string;
  indexBucket: string;
  irsaRoleArn: string;
  sqsUrls: Record<'index' | 'query' | 'subquery' | 'stream', string>;
}): PlanStep[] {
  const steps: PlanStep[] = [];

  steps.push({
    title: 'Add Retriever Helm repo',
    rationale: `Makes the ${RETRIEVER_CHART_REF} chart available to \`helm install\`.`,
    commands: [
      `helm repo add ${RETRIEVER_CHART_ALIAS} ${RETRIEVER_CHART_REPO}`,
      `helm repo update`,
      `helm search repo ${RETRIEVER_CHART_REF}`,
    ],
  });

  steps.push({
    title: 'Create target namespace',
    rationale: `The Retriever installs into \`${opts.namespace}\`.`,
    commands: [
      `kubectl create namespace ${opts.namespace} --dry-run=client -o yaml | kubectl apply -f -`,
    ],
  });

  const valuesFile = `${opts.releaseName}-values.yaml`;
  steps.push({
    title: 'Write Helm values',
    rationale: 'Wires the tenx block, IRSA ServiceAccount, S3 buckets, and all four SQS queue URLs into the chart.',
    file: {
      path: valuesFile,
      contents: renderRetrieverValues(opts),
      language: 'yaml',
    },
    commands: [],
  });

  steps.push({
    title: 'Install via Helm',
    rationale: 'Deploys the indexer + query-handler + stream-worker + filter CronJobs.',
    commands: [
      `helm upgrade --install ${opts.releaseName} ${RETRIEVER_CHART_REF} \\\n  -n ${opts.namespace} --create-namespace \\\n  -f ${valuesFile}`,
    ],
  });

  steps.push({
    title: 'Wait for rollout',
    rationale: 'Blocks until indexer + query-handler + stream-worker report Ready.',
    commands: [
      `kubectl -n ${opts.namespace} rollout status deployment -l app.kubernetes.io/instance=${opts.releaseName} --timeout=10m || true`,
    ],
    expectDurationSec: 600,
  });

  return steps;
}

function renderRetrieverValues(opts: {
  releaseName: string;
  apiKey: string;
  inputBucket: string;
  indexBucket: string;
  irsaRoleArn: string;
  sqsUrls: Record<'index' | 'query' | 'subquery' | 'stream', string>;
}): string {
  return `tenx:
  enabled: true
  apiKey: "${opts.apiKey}"
  runtimeName: "${opts.releaseName}"
  gitToken: "public-repo-no-token-needed"
  config:
    git:
      enabled: true
      url: "https://github.com/log-10x/config.git"

serviceAccount:
  create: true
  annotations:
    eks.amazonaws.com/role-arn: "${opts.irsaRoleArn}"

inputBucket: "${opts.inputBucket}"
indexBucket: "${opts.indexBucket}"

indexQueueUrl: "${opts.sqsUrls.index}"
queryQueueUrl: "${opts.sqsUrls.query}"
subQueryQueueUrl: "${opts.sqsUrls.subquery}"
streamQueueUrl: "${opts.sqsUrls.stream}"
`;
}

function buildVerifyProbes(
  releaseName: string,
  namespace: string,
  inputBucket: string | undefined,
  indexQueueUrl: string | undefined
): VerifyProbe[] {
  const probes: VerifyProbe[] = [];

  probes.push({
    name: 'pods-ready',
    question: 'Are indexer + query-handler + stream-worker pods Ready?',
    commands: [
      `kubectl -n ${namespace} wait --for=condition=Ready pod -l app.kubernetes.io/instance=${releaseName} --timeout=10m`,
    ],
    expectOutput: 'condition met',
    timeoutSec: 600,
  });

  probes.push({
    name: 'indexer-healthy',
    question: 'Is the indexer processing messages from the index queue?',
    commands: [
      `kubectl -n ${namespace} logs -l app.kubernetes.io/instance=${releaseName},app.kubernetes.io/component=indexer --tail=200 | grep -iE 'index|processed|bloom' | head -20`,
    ],
    timeoutSec: 120,
  });

  probes.push({
    name: 'query-endpoint-healthy',
    question: 'Is the query endpoint responding?',
    commands: [
      `kubectl -n ${namespace} get ingress,svc -l app.kubernetes.io/instance=${releaseName}`,
    ],
  });

  if (inputBucket) {
    probes.push({
      name: 's3-indexing-results',
      question: 'Is the indexer writing to the index bucket?',
      commands: [
        `aws s3 ls s3://${inputBucket}/indexing-results/ --summarize 2>/dev/null | tail -5 || echo "no index results yet (may take a few minutes after first index run)"`,
      ],
    });
  }

  if (indexQueueUrl) {
    probes.push({
      name: 'sqs-drainage',
      question: 'Is the index queue being drained (messages not piling up)?',
      commands: [
        `aws sqs get-queue-attributes --queue-url "${indexQueueUrl}" --attribute-names ApproximateNumberOfMessages --output json`,
      ],
    });
  }

  return probes;
}

function buildTeardownSteps(releaseName: string, namespace: string): PlanStep[] {
  return [
    {
      title: 'Uninstall the Helm release',
      rationale:
        'Removes indexer, query-handler, stream-worker deployments, filter CronJobs, ConfigMaps, and the chart-created ServiceAccount. LEAVES AWS infra (S3, SQS, IAM role) intact — that lifecycle belongs to Terraform.',
      commands: [`helm -n ${namespace} uninstall ${releaseName}`],
    },
    {
      title: 'Clean up derived resources',
      rationale: 'Helm does not reap PVCs or Secrets created outside the release.',
      commands: [
        `kubectl -n ${namespace} delete pvc -l app.kubernetes.io/instance=${releaseName} --ignore-not-found`,
      ],
    },
    {
      title: 'Verify nothing remains',
      rationale: 'Confirm no workloads are lingering under the release label.',
      commands: [
        `kubectl -n ${namespace} get all,configmap,secret,pvc -l app.kubernetes.io/instance=${releaseName}`,
      ],
    },
    {
      title: '(Optional) teardown AWS infra',
      rationale:
        'If you\'re fully removing the Retriever, tear down the Terraform module that created the S3 buckets, SQS queues, and IAM role. Skipping this leaves empty AWS infra behind (zero-cost for SQS idle, pennies for S3 storage).',
      commands: [
        `# From your terraform directory:`,
        `# terraform destroy -target=module.retriever_aws_infra`,
      ],
    },
  ];
}
