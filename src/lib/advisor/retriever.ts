/**
 * Retriever install/verify/teardown plan builder.
 *
 * Unlike Reporter/Receiver (which ride on top of a forwarder), the
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
import type { ForwarderKind } from '../discovery/types.js';
import type { AdvisePlan, PlanStep, VerifyProbe, PreflightCheck } from './types.js';
import { renderOffloadSection, type OffloadForwarderId } from '../offload-recipes.js';

/** Map a detected forwarder kind to the offload-capable recipe set. filebeat
 * has no native S3 output (it ships via logstash/ES) and `unknown` is a
 * non-match, so both map to null — the section then shows the verified leads. */
function mapForwarderToOffload(forwarders: { kind: ForwarderKind }[]): OffloadForwarderId | null {
  const byKind: Partial<Record<ForwarderKind, OffloadForwarderId>> = {
    fluentbit: 'fluent-bit',
    fluentd: 'fluentd',
    logstash: 'logstash',
    'otel-collector': 'otel-collector',
    vector: 'vector',
  };
  for (const f of forwarders) {
    const id = byKind[f.kind];
    if (id) return id;
  }
  return null;
}

export interface RetrieverAdviseArgs {
  snapshot: DiscoverySnapshot;
  /** Helm release name. Default: `my-retriever`. */
  releaseName?: string;
  /** Target namespace. Default: snapshot's suggestedNamespace. */
  namespace?: string;
  /**
   * Log10x license JWT — mints from `POST /api/v1/license/demo` (anonymous)
   * or `POST /api/v1/license` (Auth0-authed). Required for a complete
   * install plan.
   *
   * NOTE: the retriever helm chart is on an older value-key naming
   * convention (top-level `apiKeySecret` and the secret data is `apiKey`).
   * The chart will be aligned with the Reporter chart's `log10xLicenseJwt`
   * convention as part of the same engine-team migration — until then the
   * retriever install plan renders the JWT into the old `apiKey` slot.
   */
  licenseJwt?: string;
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
  if (!args.licenseJwt && !args.skipInstall) {
    blockers.push(
      'Log10x license JWT is required for an install plan. Pass `license_jwt` (fetch one from `POST /api/v1/license/demo` for anonymous demo, or `POST /api/v1/license` with an Auth0 access token). Verify and teardown plans work without it.'
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
        licenseJwt: args.licenseJwt!,
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

  // Forwarder offload section: how to route the isDropped slice to the
  // customer's own S3 (the bucket the Retriever reads) + SIEM down-tier
  // alternatives. Only when we know the bucket + region to fill in.
  const region = snapshot.aws?.region;
  const offloadMarkdown =
    inputBucket && region
      ? renderOffloadSection(
          { bucket: inputBucket, region, prefix: 'app' },
          mapForwarderToOffload(snapshot.kubectl.forwarders)
        )
      : undefined;

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
    offloadMarkdown,
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

  // Chart availability used to LIVE-probe `helm search repo` here too.
  // Removed for the same reason as the receiver path: retriever-10x is
  // a chart WE publish under a name we control, so verifying it exists
  // on every plan emit just added a slow side effect (mutates the
  // user's helm config; blocks up to 30s when helm is offline). If the
  // chart ref ever drifts, `helm install` surfaces it meaningfully.

  return checks;
}

function buildInstallSteps(opts: {
  releaseName: string;
  namespace: string;
  licenseJwt: string;
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
  licenseJwt: string;
  inputBucket: string;
  indexBucket: string;
  irsaRoleArn: string;
  sqsUrls: Record<'index' | 'query' | 'subquery' | 'stream', string>;
}): string {
  // NOTE: the retriever chart's values.yaml still uses the older
  // `apiKeySecret` / nested `tenx.apiKey` slot. We pass the license JWT
  // into that slot until the chart is aligned with the Reporter chart's
  // `log10xLicenseJwt` convention. Engine-team migration tracked
  // separately; the engine itself already validates the JWT regardless
  // of which value-key it arrives through.
  return `tenx:
  enabled: true
  apiKey: "${opts.licenseJwt}"
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
    // Write side of the loop, checked FIRST: is the forwarder actually
    // offloading the dropped slice into the source bucket? Without this, an
    // empty `indexing-results` reads as "retriever broken" when the real
    // cause is "no input data — forwarder offload not wired". This probe
    // disambiguates and points at the Forwarder offload section.
    probes.push({
      name: 's3-offload-input',
      question: 'Is the forwarder offloading the dropped slice into the source bucket?',
      commands: [
        `aws s3 ls s3://${inputBucket}/app/ --recursive --summarize 2>/dev/null | tail -5 || echo "no objects under app/ yet — if this stays empty the forwarder offload is NOT wired. See the 'Forwarder offload' section: the receiver needs outputOffload=true, the per-forwarder recipe applied, and the forwarder-write IRSA (s3:PutObject to this bucket/app/)."`,
      ],
    });
    probes.push({
      name: 's3-indexing-results',
      question: 'Is the indexer writing to the index bucket?',
      commands: [
        `aws s3 ls s3://${inputBucket}/indexing-results/ --summarize 2>/dev/null | tail -5 || echo "no index results yet (may take a few minutes after first index run). If s3-offload-input is also empty, fix the forwarder offload first — the indexer has nothing to index."`,
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
