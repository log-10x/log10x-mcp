/**
 * Retriever install/verify/teardown plan builder.
 *
 * Unlike Reporter/Receiver (which ride on top of a forwarder), the
 * Retriever is a standalone set of workloads (indexer + query-handler
 * + stream-worker + filter CronJobs) that read from S3 via SQS and
 * serve an HTTP query endpoint. No forwarder choice — just one chart
 * (`log10x/retriever-10x` or the log10x-hosted variant) with AWS infra
 * pointers.
 *
 * The advisor's job is to:
 *   - Surface the AWS infra the Retriever expects (S3 input bucket,
 *     index bucket, 4 SQS queues, IRSA role).
 *   - List in `blockers` every input a complete plan is still missing,
 *     and emit no steps while that list is non-empty. The preflight
 *     table is the state report beside it: a `fail` row there is
 *     reported (and counted in the envelope's `preflight_summary`),
 *     not a gate, because the conditions it reads (kubectl unusable,
 *     a release already installed) are not answered by re-invoking
 *     with a different argument.
 *   - Emit a values.yaml that wires the infra into the chart.
 *   - Provide verify probes that prove indexing + querying work,
 *     each gated on the storage provider they belong to.
 *   - Provide teardown. On AWS, helm uninstall only: infra lifecycle is
 *     a Terraform concern. On Azure, the provisioning script's own
 *     `--destroy`, which deletes the resource group it created.
 *
 * Two storage providers. `aws` is the historical path: S3 buckets, four SQS
 * queues, an IRSA role. `azure` targets AKS with Azure Blob Storage and Azure
 * Storage Queues behind the chart's `storage.provider: azure` block, with AKS
 * workload identity in place of IRSA. The Azure path is read and index side
 * only: the Retriever indexes and queries blobs already in the container, and
 * the forwarder offload recipes stay S3-shaped, so the offload markdown says
 * so rather than emitting a sink that writes elsewhere.
 */

import type { DiscoverySnapshot } from '../discovery/types.js';
import type { ForwarderKind } from '../discovery/types.js';
import type { AdvisePlan, PlanStep, VerifyProbe, PreflightCheck } from './types.js';
import { renderOffloadSection, type OffloadForwarderId } from '../offload-recipes.js';
import { run } from '../discovery/shell.js';

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
   * NOTE: the retriever helm chart uses a different value-key naming
   * convention from the Reporter chart's `log10xLicenseJwt` (top-level
   * `apiKeySecret`, with the secret data under `apiKey`), so the retriever
   * install plan renders the JWT into the `apiKey` slot.
   */
  licenseJwt?: string;
  /**
   * Whether `licenseJwt` came from the caller. A JWT the wizard minted on the
   * caller's behalf is used for nothing that lands on disk: `false` keeps the
   * key out of every emitted values file. Defaults to `true`, so a direct
   * caller that passes `licenseJwt` still gets it wired.
   */
  licenseSupplied?: boolean;
  /** Override: input S3 bucket name. Default: from snapshot. */
  inputBucket?: string;
  /** Override: index bucket (with prefix). Default: `<inputBucket>/indexing-results/`. */
  indexBucket?: string;
  /** Override: IRSA role ARN for the retriever SA. Default: from snapshot. */
  irsaRoleArn?: string;
  /**
   * Which object store the Retriever reads. `aws` (default) is S3 + SQS +
   * IRSA; `azure` is Azure Blob + Azure Storage Queues + AKS workload
   * identity, behind the chart's `storage.provider` key.
   */
  storageProvider?: RetrieverStorageProvider;
  /** Azure storage account holding the containers. Required when storageProvider is `azure`. */
  storageAccount?: string;
  /** Azure resource group, for the provisioning command and the teardown in the plan. */
  resourceGroup?: string;
  /**
   * AKS cluster the release installs into. Used both by the provisioning
   * command and by the `az aks get-credentials` step that points kubectl at
   * the cluster before any kubectl command runs.
   */
  aksCluster?: string;
  /** Azure region for the provisioning command (e.g. `eastus`). */
  location?: string;
  /** Client id of the user-assigned managed identity federated to the release ServiceAccount. */
  azureClientId?: string;
  /** Entra tenant id. */
  azureTenantId?: string;
  /** Azure Storage Queue names, in place of the four SQS URLs. */
  azureQueues?: {
    index?: string;
    query?: string;
    subquery?: string;
    stream?: string;
  };
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
  /**
   * Destination SIEM the customer routes the kept slice to. Used to gate
   * the SIEM down-tier sub-sections in the offload markdown
   * (Datadog Flex only for `datadog`, CloudWatch IA only for `cloudwatch`,
   * etc., per `DEFAULT_ACTION_BY_DESTINATION`). When omitted, the offload
   * section shows both leads.
   */
  destination?: string;
}

/** Object store behind the Retriever. */
export type RetrieverStorageProvider = 'aws' | 'azure';

/** Default Azure Storage Queue names, matching the provisioning script's own. */
const AZURE_DEFAULT_QUEUES = {
  index: 'tenx-index',
  query: 'tenx-query',
  subquery: 'tenx-subquery',
  stream: 'tenx-stream',
} as const;

const RETRIEVER_CHART_REPO = 'https://log-10x.github.io/helm-charts';
const RETRIEVER_CHART_ALIAS = 'log10x';
/** Chart name as published in the Helm repo index. There is no `log10x/retriever`. */
const RETRIEVER_CHART_NAME = 'retriever-10x';
const RETRIEVER_CHART_REF = `${RETRIEVER_CHART_ALIAS}/${RETRIEVER_CHART_NAME}`;

/** Chart version carrying the Azure provisioning script this advisor quotes. */
export const RETRIEVER_CHART_VERSION = '1.0.24';

/** Engine image the Azure path documents and the provisioning script pins. */
export const RETRIEVER_IMAGE_TAG = '1.1.78';

/**
 * Node size for a cluster the script creates. The Azure CLI default
 * (`Standard_D4d_v4`) is refused on subscriptions that do not carry that
 * family, which stops a first install dead, so the size is always passed.
 *
 * The value matches the provisioning script's own default. `Standard_D2s_v5`
 * was refused on the subscription the Azure path was proved against, and the
 * script moved to v7; an advisor that keeps passing v5 overrides the working
 * default with the refused one.
 */
export const AKS_NODE_SIZE = 'Standard_D2s_v7';

/**
 * What the chart labels a retriever pod, and what it names the container.
 *
 * From `retriever-10x` 1.0.24: `templates/deployment.yaml` stamps
 * `app: {{ chart name }}` and `cluster: {{ cluster.name }}` on the pod, and
 * names the container `{{ chart name }}-{{ cluster.name }}`. The default
 * cluster in `values.yaml` is `all-in-one`. Nothing in the chart sets
 * `app.kubernetes.io/instance`, so a selector on that key matches no pod and
 * every probe built on it reports "No resources found" instead of the state
 * it was asked about.
 */
export const RETRIEVER_POD_SELECTOR = 'app=retriever-10x';
export const RETRIEVER_CONTAINER = 'retriever-10x-all-in-one';
/** Cluster entry the chart ships, and the suffix on every per-cluster object. */
export const RETRIEVER_CLUSTER_NAME = 'all-in-one';

/**
 * The provisioning script that ships with the retriever chart. One run creates
 * the account, the two containers, the four queues, the managed identity and
 * its two blob/queue data roles, the Event Grid system topic and its
 * BlobCreated subscription onto the index queue, and the federated credential
 * binding the identity to the release ServiceAccount, then writes a values
 * file.
 *
 * The path is the one inside the untarred chart tarball, which is the only
 * copy a customer has. `charts/retriever/scripts/azure/...` is a path in the
 * chart source repo and exists in nothing a customer downloads.
 */
export const AZURE_PROVISION_SCRIPT = `${RETRIEVER_CHART_NAME}/scripts/azure/provision-retriever.sh`;

/**
 * Where a query's results land, and the shape of the path. `<index-path>` is
 * the script's `--index-path` (default `tenx`); the literal `tenx` segment
 * after it is the engine's own, and `<app>` is the first path segment of the
 * indexed blob, which is also what the query's `name` field must equal.
 *
 * One level below the queryId comes a slice segment, `<sliceFromMs>_<sliceToMs>`,
 * because each scan task writes under the time slice it was dispatched for
 * (`IndexObjectQueryResultsWriter`: `{queryId}/{sliceFrom}_{sliceTo}/{worker}.jsonl`).
 * A listing that stops at the queryId prefix sees folders rather than objects,
 * so every list in this plan is recursive.
 */
export const AZURE_RESULT_PATH =
  '<index-container>/<index-path>/tenx/<app>/qr/<queryId>/<sliceFromMs>_<sliceToMs>/<hash>.jsonl';

/**
 * How long a bounded poll of the results prefix runs before the answer comes
 * from `_DONE.json` instead. Ten polls fifteen seconds apart is two and a half
 * minutes, which covers a one-hour window sliced a minute at a time on a
 * single-node cluster.
 */
export const AZURE_RESULT_POLL_ATTEMPTS = 10;
export const AZURE_RESULT_POLL_INTERVAL_SEC = 15;

/**
 * Two facts a first install needs and neither the chart nor the script states:
 * the operator's own data-plane access, and what `_DONE.json` is not.
 */
export const AZURE_OPERATOR_ROLES_NOTE =
  'The script grants "Storage Blob Data Contributor" and "Storage Queue Data Contributor" to the managed ' +
  'identity AND to the operator running it, so `az storage blob upload` and `az storage message put` work ' +
  'with `--auth-mode login` from the same shell. On a subscription where role assignment is not yours to ' +
  'make, pass `--account-key` on those commands instead.';

export const AZURE_RESULTS_NOTE =
  `Results land as JSONL under \`${AZURE_RESULT_PATH}\`. Poll the \`qr/<queryId>/\` prefix at most ` +
  `${AZURE_RESULT_POLL_ATTEMPTS} times, ${AZURE_RESULT_POLL_INTERVAL_SEC} seconds apart, and then stop. ` +
  'A prefix still empty at the end of those polls is answered by `_DONE.json` under that same prefix, which ' +
  'the coordinator writes seconds after the query message is picked up, once every scan task has gone out. ' +
  'Its fields are `queryId`, `completedAt`, `elapsedMs`, `reason`, `scanned`, `matched`, `skippedSearch`, ' +
  '`skippedTemplate`, `streamRequests`, `streamBlobs`, `submittedTasks` and `expectedMarkers`. ' +
  '`reason: "empty-range"` with `submittedTasks: 0` says the coordinator saw no index objects in the window ' +
  'and dispatched nothing. `reason: "dispatched"` with `submittedTasks` above zero says that many scan tasks ' +
  'reached the queue, so an empty prefix at the end of the polls above is this dispatch reporting no matches. ' +
  'A marker that is still absent puts the question on the query handler and the query queue rather than on ' +
  'the result: the message has yet to be picked up. ' +
  'The `scanned`, `matched`, `streamRequests` and `expectedMarkers` counters read 0 in the marker on this ' +
  'path whatever the workers go on to write, because the scan and stream workers run in processes of their ' +
  'own and the coordinator exits after dispatch. The `.jsonl` objects under the prefix are what carry the ' +
  'matches. ' +
  'Running the query again mints a NEW queryId and a new prefix. The first prefix stays as it was, so a ' +
  'second attempt means listing the new id.';

/**
 * P1 from the second acceptance round. Indexing keys on the timestamp parsed
 * out of the event, and the sample query asks for `now("-1h")` to `now()`, so
 * a sample line stamped with a fixed hour matches its own query only during
 * that hour. The line is therefore generated by the command, at the moment the
 * operator runs it.
 */
export const AZURE_SAMPLE_LOG_COMMAND =
  `printf '%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR checkout failed for order ORD-DEMO-1" > ./test.log`;

export const AZURE_EVENT_TIME_NOTE =
  'The query window is evaluated against the timestamp parsed out of the log line rather than the time the ' +
  'blob was written, so the sample line the upload step writes carries the current time at the moment the ' +
  'command runs. A line stamped with a fixed hour falls outside the `now("-1h")` window the sample query ' +
  'asks for once that hour has passed, and the query then dispatches its scan tasks and writes no results.';

/**
 * P7 from the second acceptance round. Every index run logs a 403 that reads
 * as a failure and is the expected state on this path.
 */
export const AZURE_FLAT_NAMESPACE_403_NOTE =
  'Every index run logs `could not read account information for <account>, status 403; assuming a flat ' +
  'namespace`. The managed identity holds the two data-plane roles and no management-plane read, so the ' +
  'engine has no way to ask the account whether hierarchical namespace is on and falls back to the ' +
  'flat-namespace assumption. The provisioning script creates flat-namespace accounts, so the assumption ' +
  'holds and the line belongs to a healthy install.';

/**
 * P6 from the second acceptance round. Storage account names live in one
 * global namespace, which neither the question nor its example said.
 */
export const AZURE_STORAGE_ACCOUNT_UNIQUE_NOTE =
  'Storage account names are globally unique across Azure, so a short generic name is usually taken by ' +
  'another subscription already and account creation stops with a name-unavailable error. Pick one carrying ' +
  'a suffix of this tenant\'s own, such as `tenxlogs7f3a`, and test a candidate first with ' +
  '`az storage account check-name --name <name>`. 3 to 24 characters, lowercase letters and digits only.';

/**
 * P5 from the second acceptance round. `log10x_discover_env` probes kubectl
 * and AWS. On the machine the acceptance run used it enumerated an unrelated
 * AWS estate and stamped `estate=serverless` into a snapshot that then backed
 * an Azure plan.
 */
export const AZURE_SNAPSHOT_SCOPE_NOTE =
  'The discovery snapshot behind this plan covers kubectl and AWS. `log10x_discover_env` runs no Azure ' +
  'probes today, so its buckets, queues, roles and estate verdict describe an AWS account reachable from ' +
  'the machine that ran discovery and say nothing about the Azure subscription this plan installs into. ' +
  'Every Azure value below came from the wizard answers or from the provisioning script, and no ' +
  'AWS-derived snapshot field is read on this path.';

export const AZURE_API_KEY_NOTE =
  '`log10xApiKey` is optional. Left empty, the engine runs on its built-in evaluation licence and says so in ' +
  'the pod log. Set it only when you hold a Log10x licence key.';

/**
 * A licence the caller did not hand over is never written into an emitted
 * values file. The file stays on the operator's disk and the plan tells them
 * to keep it, so a key put there without being asked for is a key leaked into
 * a file nobody agreed to hold.
 */
export function licenseNotEmittedNote(storageProvider: RetrieverStorageProvider): string {
  // The two paths write the key into different value slots, so the flag that
  // replaces it differs as well.
  const flag =
    storageProvider === 'azure'
      ? '`--set-string log10xApiKey="$LOG10X_API_KEY"`'
      : '`--set-string tenx.apiKey="$LOG10X_API_KEY"`';
  return (
    'No licence key is written into the values file. The engine runs on its built-in evaluation licence until ' +
    `a key is supplied, and a key is supplied at install time with ${flag} so it stays out of any file on disk.`
  );
}

/** Node-size refusals stop a first install dead, so the retry path is stated up front. */
export const AZURE_NODE_SIZE_NOTE =
  `The provisioning command passes \`--node-size ${AKS_NODE_SIZE}\`. Subscriptions differ in which VM sizes they ` +
  'allow. On a refusal the script prints the query that lists the sizes this subscription and region do allow ' +
  '(`az vm list-skus --location <location> --resource-type virtualMachines`) and the exact re-run carrying ' +
  '`--node-size <SIZE>`. Nothing is left half created: the re-run converges on what already exists.';

/**
 * Azure teardown. The resource group holds the storage account, the queues,
 * the managed identity, the Event Grid subscription and the AKS cluster, and
 * the script's `--destroy` deletes the group and everything in it. No
 * Terraform state exists on this path.
 */
export function buildAzureTeardownCommand(resourceGroup: string): string {
  return `bash ${AZURE_PROVISION_SCRIPT} --destroy --resource-group ${resourceGroup}`;
}

/**
 * The query body the provisioning script prints in its own runbook. `name`
 * has to equal the first path segment of the uploaded blob, which the upload
 * step below makes `app`.
 */
export const AZURE_SAMPLE_QUERY_BODY =
  '{"name":"app","from":"now(\\"-1h\\")","to":"now()","search":"severity_level==\\"ERROR\\"","writeResults":true}';

/**
 * The provisioning commands, in the order a customer runs them: add the repo,
 * pull and untar the chart, then run the script from the untarred directory.
 * `helm repo add` on a repo that is already present skips without refreshing
 * the index, so `helm repo update` runs before the pull or `--version` can
 * miss a freshly published chart.
 *
 * The script is invoked through `bash`. `helm package` writes every file in a
 * chart tarball as mode 0644 whatever its mode in git, so the copy that comes
 * out of `helm pull --untar` carries no exec bit and a direct invocation is
 * refused with "permission denied".
 */
export function buildAzureProvisionCommands(opts: {
  resourceGroup: string;
  location: string;
  account: string;
  aksCluster: string;
  namespace: string;
  releaseName: string;
  valuesOut: string;
}): string[] {
  return [
    `helm repo add ${RETRIEVER_CHART_ALIAS} ${RETRIEVER_CHART_REPO}`,
    'helm repo update',
    `helm pull ${RETRIEVER_CHART_REF} --version ${RETRIEVER_CHART_VERSION} --untar`,
    [
      `bash ${AZURE_PROVISION_SCRIPT} \\`,
      `  --resource-group ${opts.resourceGroup} \\`,
      `  --location ${opts.location} \\`,
      `  --account ${opts.account} \\`,
      `  --create-aks ${opts.aksCluster} \\`,
      `  --node-size ${AKS_NODE_SIZE} \\`,
      `  --namespace ${opts.namespace} \\`,
      `  --release ${opts.releaseName} \\`,
      `  --values-out ${opts.valuesOut}`,
    ].join('\n'),
  ];
}

export async function buildRetrieverPlan(args: RetrieverAdviseArgs): Promise<AdvisePlan> {
  const snapshot = args.snapshot;
  const releaseName = args.releaseName ?? 'my-retriever';

  // Fix 81: for verify (and teardown) actions, prefer the actual installed
  // namespace from installedComponentsDetail.retriever over suggestedNamespace,
  // which is the forwarder namespace and may be wrong.
  const installedDetail = snapshot.recommendations.installedComponentsDetail?.retriever;
  const installedNamespace = installedDetail?.namespace;
  const namespace =
    args.namespace ??
    (installedNamespace
      ? installedNamespace   // actual pod namespace from discover_env
      : snapshot.recommendations.suggestedNamespace ?? 'logging');

  const storageProvider: RetrieverStorageProvider = args.storageProvider ?? 'aws';
  const isAzure = storageProvider === 'azure';

  // Infra: prefer caller-supplied values; fall back to snapshot-derived.
  // Fix 82: for verify, also try to resolve the bucket from the installed
  // Helm release values if installedComponentsDetail.retriever is present.
  //
  // P5, second acceptance round: `log10x_discover_env` probes kubectl and AWS
  // and has no Azure side. On the acceptance machine it enumerated an
  // unrelated AWS account's S3 buckets and SQS queues and stamped
  // `estate=serverless` into the snapshot an Azure plan was then built from.
  // Every snapshot field below that describes AWS resources is therefore read
  // only on an AWS plan; an Azure plan takes its values from the wizard
  // answers and from the provisioning script, and says so in its notes.
  const installedBucket =
    !isAzure && installedNamespace
      ? await resolveInstalledBucket(releaseName, installedNamespace)
      : undefined;
  // `snapshot.recommendations.retrieverS3Bucket` is an S3 bucket name that
  // discovery pattern-matched out of the AWS estate. On an Azure plan it is
  // not a blob container and never belongs in one: pasted into `az storage
  // blob list -c`, it points every storage probe at a name that does not
  // exist on the account. Only what the caller passed is used there.
  const inputBucket = isAzure
    ? args.inputBucket
    : args.inputBucket ?? installedBucket ?? snapshot.recommendations.retrieverS3Bucket;
  const indexBucket =
    args.indexBucket ??
    (isAzure
      ? args.storageAccount
        ? `${args.storageAccount}/tenx-index/tenx`
        : undefined
      : inputBucket
        ? `${inputBucket}/indexing-results/`
        : undefined);
  const irsaRoleArn = isAzure
    ? undefined
    : args.irsaRoleArn ??
      snapshot.kubectl.serviceAccountIrsa.find((sa) =>
        sa.name.toLowerCase().includes('retriever') || sa.name.toLowerCase().includes('tenx-retriever')
      )?.roleArn;

  // An AKS install has no SQS queue. Reading the four detected URLs on an
  // Azure plan put an unrelated account's queue behind a "pass" in round one.
  const detectedQueues = isAzure ? {} : snapshot.recommendations.retrieverSqsUrls ?? {};
  const sqsUrls = isAzure
    ? { index: undefined, query: undefined, subquery: undefined, stream: undefined }
    : {
        index: args.sqsUrls?.index ?? detectedQueues.index,
        query: args.sqsUrls?.query ?? detectedQueues.query,
        subquery: args.sqsUrls?.subquery ?? detectedQueues.subquery,
        stream: args.sqsUrls?.stream ?? detectedQueues.stream,
      };

  const azureQueues = {
    index: args.azureQueues?.index ?? AZURE_DEFAULT_QUEUES.index,
    query: args.azureQueues?.query ?? AZURE_DEFAULT_QUEUES.query,
    subquery: args.azureQueues?.subquery ?? AZURE_DEFAULT_QUEUES.subquery,
    stream: args.azureQueues?.stream ?? AZURE_DEFAULT_QUEUES.stream,
  };

  const blockers: string[] = [];
  if (!args.licenseJwt && !args.skipInstall) {
    blockers.push(
      'Log10x license JWT is required for an install plan. Pass `license_jwt` (fetch one from `POST /api/v1/license/demo` for anonymous demo, or `POST /api/v1/license` with an Auth0 access token). Verify and teardown plans work without it.'
    );
  }
  if (isAzure && !args.skipInstall) {
    if (!inputBucket) {
      blockers.push(
        'No input blob container supplied. The Retriever reads source logs from an Azure Blob container. Pass `input_container`.'
      );
    }
    if (!args.storageAccount) {
      blockers.push(
        'No Azure storage account supplied. Pass `storage_account` (the account name holding the input and index containers).'
      );
    }
    if (!args.azureClientId || !args.azureTenantId) {
      blockers.push(
        'AKS workload identity needs both `azure_client_id` (the user-assigned managed identity federated to the release ServiceAccount) and `azure_tenant_id`. Run the provisioning script below to create them, then re-run with the values it prints.'
      );
    }
  } else if (!args.skipInstall) {
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
    // `args.skipInstall` alone. An earlier `|| isAzure` here flipped the
    // release check on EVERY azure plan, so a first install rendered
    // "release exists: FAIL - install first before running verify or
    // teardown" directly above its own install steps. Seen live.
    skipInstall: args.skipInstall,
    storageProvider,
    ...(args.storageAccount !== undefined ? { storageAccount: args.storageAccount } : {}),
    ...(args.azureClientId !== undefined ? { azureClientId: args.azureClientId } : {}),
    ...(args.azureTenantId !== undefined ? { azureTenantId: args.azureTenantId } : {}),
    azureQueues,
  });

  const notes: string[] = [];
  if (snapshot.recommendations.alreadyInstalled.retriever) {
    notes.push(
      isAzure
        ? `A Retriever is already installed in namespace \`${snapshot.recommendations.alreadyInstalled.retriever}\`. A second release needs its own four Storage Queues and its own managed identity: two releases polling one set of queues race each other for every message.`
        : `A Retriever is already installed in namespace \`${snapshot.recommendations.alreadyInstalled.retriever}\`. Installing a second release requires a separate set of SQS queues + IRSA role, since running two retrievers against the same queues will race.`
    );
  }
  // Fix 81/82: audit trail for namespace + bucket resolution source.
  if (installedNamespace && !isAzure) {
    const bucketSource = args.inputBucket
      ? 'caller-supplied'
      : installedBucket
        ? `helm get values (installed release in ${installedNamespace})`
        : 'snapshot pattern-match (helm values not available)';
    notes.push(
      `Verify namespace \`${namespace}\` resolved from installed component detail (actual pod namespace). ` +
      `Input bucket resolved via: ${bucketSource}.`
    );
  }
  notes.push(
    isAzure
      ? `Retriever infra on Azure (storage account, blob containers, Storage Queues, managed identity and its blob/queue data roles, the Event Grid BlobCreated subscription, and the federated credential) is provisioned by the chart's own script, NOT by this advisor. The script ships inside the chart tarball at \`${AZURE_PROVISION_SCRIPT}\`, reached with \`helm pull ${RETRIEVER_CHART_REF} --version ${RETRIEVER_CHART_VERSION} --untar\`. Step 1 below does both.`
      : 'Retriever infra (S3 buckets, SQS queues, IAM role + IRSA binding, CloudWatch log groups) is provisioned via the Terraform module, NOT by this advisor. The plan below assumes infra already exists.'
  );
  if (isAzure) {
    notes.push(AZURE_SNAPSHOT_SCOPE_NOTE);
    notes.push(AZURE_RESULTS_NOTE);
    notes.push(AZURE_EVENT_TIME_NOTE);
    notes.push(AZURE_FLAT_NAMESPACE_403_NOTE);
    notes.push(AZURE_STORAGE_ACCOUNT_UNIQUE_NOTE);
    notes.push(AZURE_OPERATOR_ROLES_NOTE);
    notes.push(AZURE_API_KEY_NOTE);
    notes.push(
      `The plan pins engine image tag \`${RETRIEVER_IMAGE_TAG}\`. The chart's own appVersion trails the released engine, so an unpinned install runs an older image than the one this path is tested against.`
    );
    notes.push(
      'Azure support is read and index side. The Retriever indexes and queries blobs in the input container, and hierarchical-namespace accounts are refused at construction, so the account must be flat namespace. Writing the offload slice into Blob is a separate feature: log10x emits forwarder offload recipes for S3 and S3-compatible buckets. A diagnostic export that already lands in the container is queryable as soon as the indexer is up.'
    );
  }

  // Fix 88 — surface Receiver outputOffload requirement proactively.
  // If the Receiver is installed, warn that the rate-only regulator config
  // does NOT route bytes to S3 — the outputOffload module must be included.
  // Without this, the S3 input bucket stays empty and the Retriever has
  // nothing to index. The note appears above the preflight table so users
  // see it before running any commands. The verify probe (receiver-offload-
  // capability) will confirm the state after the Receiver config is updated.
  // Gated off the Azure path: the recipe routes bytes to S3, and log10x
  // emits no forwarder offload recipe for Blob today. The Azure note above
  // states that instead.
  const receiverDetail = isAzure
    ? undefined
    : snapshot.recommendations.installedComponentsDetail?.receiver;
  if (receiverDetail) {
    notes.push(
      `**Receiver config update required for S3 offload.** ` +
      `The Receiver is installed in namespace \`${receiverDetail.namespace}\` but may be ` +
      `running in rate-only mode (soft-drop / sample). To route bytes to S3 so the Retriever ` +
      `can index them, the Receiver's regulator config must include the outputOffload module. ` +
      `Update the Receiver helm values:\n\n` +
      `\`\`\`yaml\ntenx:\n  receiver:\n    regulator:\n      includeOffload: true  # adds run/modules/receive/offload\n` +
      `      capLookup:\n        file: /etc/tenx/config/pipelines/run/regulate/rate/caps.csv\n\`\`\`\n\n` +
      `Hot-reload requires the cap-CSV at a gitops-managed path (not a static ConfigMap mount). ` +
      `See https://doc.log10x.com/run/regulate for the full config. ` +
      `After updating, re-run log10x_advise_retriever with action: "verify" to confirm.`
    );
  }

  const install: PlanStep[] = [];
  const verify: VerifyProbe[] = [];
  const teardown: PlanStep[] = [];

  // A licence the caller handed over is wired into the values file. One the
  // wizard minted on their behalf is not: see LICENSE_NOT_EMITTED_NOTE.
  const licenseSupplied = args.licenseSupplied !== false && !!args.licenseJwt;
  if (!args.skipInstall && blockers.length === 0) {
    install.push(
      ...(isAzure
        ? buildAzureInstallSteps({
            releaseName,
            namespace,
            licenseSupplied,
            ...(licenseSupplied ? { licenseJwt: args.licenseJwt! } : {}),
            storageAccount: args.storageAccount!,
            inputContainer: inputBucket!,
            indexContainer: indexBucket!,
            clientId: args.azureClientId!,
            tenantId: args.azureTenantId!,
            queues: azureQueues,
            ...(args.resourceGroup !== undefined ? { resourceGroup: args.resourceGroup } : {}),
            ...(args.location !== undefined ? { location: args.location } : {}),
            ...(args.aksCluster !== undefined ? { aksCluster: args.aksCluster } : {}),
          })
        : buildInstallSteps({
            releaseName,
            namespace,
            licenseSupplied,
            ...(licenseSupplied ? { licenseJwt: args.licenseJwt! } : {}),
            inputBucket: inputBucket!,
            indexBucket: indexBucket!,
            irsaRoleArn: irsaRoleArn!,
            sqsUrls: sqsUrls as Record<'index' | 'query' | 'subquery' | 'stream', string>,
          }))
    );
  }
  if (!args.skipInstall && blockers.length === 0 && !licenseSupplied) {
    notes.push(licenseNotEmittedNote(storageProvider));
  }
  if (!args.skipVerify) {
    // Pass the Receiver namespace so the offload-capability probe can inspect
    // whether the Receiver ConfigMap has outputOffload wired (Fix 88).
    const receiverNamespace = isAzure
      ? undefined
      : snapshot.recommendations.installedComponentsDetail?.receiver?.namespace;
    verify.push(
      ...buildVerifyProbes({
        releaseName,
        namespace,
        storageProvider,
        ...(inputBucket !== undefined ? { inputBucket } : {}),
        ...(sqsUrls.index !== undefined ? { indexQueueUrl: sqsUrls.index } : {}),
        ...(receiverNamespace !== undefined ? { receiverNamespace } : {}),
        ...(args.storageAccount !== undefined ? { storageAccount: args.storageAccount } : {}),
        ...(indexBucket !== undefined ? { indexContainer: indexBucket } : {}),
        azureQueues,
      })
    );
  }
  if (!args.skipTeardown) {
    teardown.push(
      ...buildTeardownSteps(releaseName, namespace, storageProvider, args.resourceGroup)
    );
  }

  // Forwarder offload section: how to route the routeState="drop" slice to the
  // customer's own S3 (the bucket the Retriever reads) + SIEM down-tier
  // alternatives. Emitted only when the bucket + region are known.
  const region = snapshot.aws?.region;
  // On Azure the section states that offload delivery to Blob has no recipe,
  // and it renders without an AWS region because there is none to print.
  const offloadMarkdown = isAzure
    ? inputBucket
      ? renderOffloadSection(
          {
            bucket: inputBucket,
            region: args.location ?? '',
            prefix: 'app',
            destinationType: 'azure_blob',
            ...(args.storageAccount !== undefined ? { storageAccount: args.storageAccount } : {}),
          },
          mapForwarderToOffload(snapshot.kubectl.forwarders),
          args.destination
        )
      : undefined
    : inputBucket && region
      ? renderOffloadSection(
          { bucket: inputBucket, region, prefix: 'app' },
          mapForwarderToOffload(snapshot.kubectl.forwarders),
          args.destination
        )
      : undefined;

  // External-access guidance when the MCP runs outside the cluster.
  // The helm chart defaults to ClusterIP, which is unreachable from a laptop.
  // KUBERNETES_SERVICE_HOST is injected by k8s into every in-cluster pod; its
  // absence is a reliable signal of running outside the cluster.
  const runningInsideCluster = process.env['KUBERNETES_SERVICE_HOST'] !== undefined;
  const retrieverAccessMarkdown = !runningInsideCluster
    ? buildRetrieverExternalAccessMarkdown(releaseName, namespace, storageProvider)
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
    retrieverAccessMarkdown,
    blockers,
  };
}

/**
 * Fix 89 — "How to query the Retriever from outside the cluster" section.
 *
 * The helm chart defaults Service spec.type to ClusterIP. The MCP server
 * (and CLI) run on the user's laptop, not inside the cluster — the
 * *.svc.cluster.local DNS does not resolve there. This function builds a
 * reference markdown block covering the three options: kubectl port-forward
 * (ephemeral dev/test), Service type LoadBalancer (persistent prod), and
 * deploying the MCP server inside the cluster (cleanest for shared teams).
 */
function buildRetrieverExternalAccessMarkdown(
  releaseName: string,
  namespace: string,
  storageProvider: RetrieverStorageProvider = 'aws'
): string {
  const isAzure = storageProvider === 'azure';
  // The chart names every per-cluster object `<fullname>-<cluster>`. The Azure
  // values file sets `fullnameOverride: <release>` so the ServiceAccount name
  // matches the federated credential subject, which also shortens the Service
  // to `<release>-all-in-one`. Without the override the fullname is
  // `<release>-retriever-10x`, which is what the AWS path still gets.
  const svcName = isAzure
    ? `${releaseName}-${RETRIEVER_CLUSTER_NAME}`
    : `${releaseName}-${RETRIEVER_CHART_NAME}-${RETRIEVER_CLUSTER_NAME}`;
  const loadBalancerValues = isAzure
    ? [
        '```yaml',
        '# retriever-values-lb.yaml',
        'service:',
        '  type: LoadBalancer',
        '```',
      ]
    : [
        '```yaml',
        '# retriever-values-lb.yaml',
        'retriever:',
        '  service:',
        '    type: LoadBalancer',
        '    annotations:',
        '      service.beta.kubernetes.io/aws-load-balancer-type: "nlb"',
        '```',
      ];
  const loadBalancerIntro = isAzure
    ? 'Add to the values file and upgrade:'
    : 'Add to your Terraform module call or values file:';
  return [
    '## How to query the Retriever from outside the cluster',
    '',
    'The Retriever Service defaults to **ClusterIP** (cluster-internal only). ' +
    '`log10x_retriever_query` and `log10x_retriever_series` send HTTP requests to the ' +
    'Retriever — from your laptop the cluster-internal URL will fail with ENOTFOUND or ECONNREFUSED.',
    '',
    'Pick one option:',
    '',
    '### Option A — kubectl port-forward (dev/test, ephemeral)',
    '',
    '```bash',
    `kubectl port-forward -n ${namespace} svc/${svcName} 18080:80`,
    '```',
    '',
    'Then set the Retriever URL so the MCP server can reach it:',
    '',
    '```bash',
    'export __SAVE_LOG10X_RETRIEVER_URL__=http://localhost:18080',
    '```',
    '',
    'The port-forward is ephemeral — it stops when the terminal session ends. ' +
    'Restart it whenever you need to run retriever queries.',
    '',
    '### Option B — Migrate the Service to LoadBalancer (persistent)',
    '',
    loadBalancerIntro,
    '',
    ...loadBalancerValues,
    '',
    'Apply with:',
    '',
    '```bash',
    isAzure
      ? `helm upgrade ${releaseName} ${RETRIEVER_CHART_REF} --version ${RETRIEVER_CHART_VERSION} \\\n  -n ${namespace} \\\n  -f ${releaseName}-azure-values.yaml \\\n  -f ${releaseName}-azure-provisioned.yaml \\\n  -f retriever-values-lb.yaml`
      : `helm upgrade ${releaseName} ${RETRIEVER_CHART_REF} -n ${namespace} -f retriever-values-lb.yaml`,
    '```',
    '',
    'After the LoadBalancer is provisioned, run `kubectl -n ' +
    `${namespace} get svc ${svcName}` +
    '` to get the external hostname, then:',
    '',
    '```bash',
    'export __SAVE_LOG10X_RETRIEVER_URL__=http://<external-hostname>',
    '```',
    '',
    '### Option C — Deploy the MCP server inside the cluster',
    '',
    'When the MCP server runs as a pod in the same cluster, the chart-default ' +
    'ClusterIP URL (`http://' + svcName + '.' + namespace + '.svc.cluster.local:80`) ' +
    'resolves correctly with no additional configuration. ' +
    'This is the cleanest path for shared teams and CI pipelines.',
  ].join('\n');
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
    /**
     * Fix 92 — when true, the release-collision check logic is inverted:
     * an existing release is expected (verify/teardown) rather than a
     * blocker (install). Derived from `args.skipInstall` in the caller.
     */
    skipInstall?: boolean;
    /**
     * Which object store this plan targets. The cloud-specific rows below
     * branch on it: an Azure operator has no IRSA role, no SQS queue and no
     * `aws` CLI, so naming them is a control they cannot act on. Default
     * `aws` keeps every existing caller unchanged.
     */
    storageProvider?: RetrieverStorageProvider;
    storageAccount?: string;
    azureClientId?: string;
    azureTenantId?: string;
    azureQueues?: Record<'index' | 'query' | 'subquery' | 'stream', string>;
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
  // Fix 92 — action-aware collision check.
  // install / all: an existing release is a blocker (collision).
  // verify / teardown (skipInstall=true): the release MUST exist — its
  // absence is the failure case. A collision false-positive in verify
  // mode was confusing users who ran verify immediately after install.
  if (infra.skipInstall) {
    checks.push({
      name: 'release exists',
      status: releaseCollision ? 'ok' : 'fail',
      detail: releaseCollision
        ? `release \`${releaseName}\` found in \`${namespace}\` — verify targets it`
        : `no \`${releaseName}\` release found in \`${namespace}\` — install first before running verify or teardown`,
    });
  } else {
    checks.push({
      name: 'release collision',
      status: releaseCollision ? 'fail' : 'ok',
      detail: releaseCollision
        ? `a Helm release named \`${releaseName}\` already exists in \`${namespace}\` — pick a different release_name or uninstall the existing one first`
        : `no \`${releaseName}\` release in \`${namespace}\` — clear to install`,
    });
  }

  const isAzurePlan = infra.storageProvider === 'azure';

  if (isAzurePlan) {
    checks.push({
      name: 'Azure CLI access',
      status: snapshot.azure?.available ? 'ok' : 'warn',
      detail: snapshot.azure?.available
        ? `subscription \`${snapshot.azure.subscriptionId ?? '?'}\``
        : 'az CLI not usable; you must pass the account, containers and identity ids explicitly',
    });

    checks.push({
      name: 'storage account',
      status: infra.storageAccount ? 'ok' : 'fail',
      detail: infra.storageAccount
        ? `\`${infra.storageAccount}\` (flat namespace only; a hierarchical-namespace account is refused at construction)`
        : 'no storage account supplied. Pass `storage_account` explicitly',
    });

    checks.push({
      name: 'input blob container',
      status: infra.inputBucket ? 'ok' : 'fail',
      detail: infra.inputBucket
        ? `\`${infra.inputBucket}\``
        : 'no input container supplied. Pass `input_container` explicitly',
    });

    checks.push({
      name: 'index blob container',
      status: infra.indexBucket ? 'ok' : 'warn',
      detail: infra.indexBucket ?? 'no index container supplied. Defaults to `tenx-index`',
    });

    checks.push({
      name: 'workload identity',
      status: infra.azureClientId && infra.azureTenantId ? 'ok' : 'fail',
      detail:
        infra.azureClientId && infra.azureTenantId
          ? `client id \`${infra.azureClientId}\`, tenant \`${infra.azureTenantId}\``
          : 'no federated managed identity supplied. Run the provisioning script in step 1, then pass `azure_client_id` and `azure_tenant_id` from what it prints',
    });

    for (const key of ['index', 'query', 'subquery', 'stream'] as const) {
      const name = infra.azureQueues?.[key];
      checks.push({
        name: `Storage Queue ${key}`,
        status: name ? 'ok' : 'fail',
        detail: name ? `\`${name}\`` : `missing. Pass \`azure_queues.${key}\` explicitly`,
      });
    }
  } else {
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
  }

  // Chart availability is NOT live-probed with `helm search repo` here
  // either, for the same reason as the receiver path: retriever-10x is a
  // Log10x-published chart under a name Log10x controls, so verifying it
  // on every plan emit only adds a slow side effect (mutates the user's
  // helm config; blocks up to 30s when helm is offline). If the chart ref
  // drifts, `helm install` surfaces it meaningfully.

  // queryLogGroup preflight: per-query CW observability.
  // This is a warn (not fail) so install paths don't block on it.
  // Skipped on an azure plan: `queryLogGroup` names a CloudWatch log group
  // and the remedy grants `logs:*` on an IRSA role, neither of which an AKS
  // operator has. There is no Azure equivalent wired today, so the honest
  // rendering is no row rather than an AWS row.
  if (!isAzurePlan) {
    let queryLogGroup: string | undefined;
    try {
      const helmResult = await run(
        'helm',
        ['get', 'values', releaseName, '-n', namespace, '-o', 'json'],
        { timeoutMs: 8_000 }
      );
      if (helmResult.exitCode === 0) {
        const parsed = JSON.parse(helmResult.stdout) as Record<string, unknown>;
        const qlg = parsed['queryLogGroup'];
        if (typeof qlg === 'string' && qlg.trim()) {
          queryLogGroup = qlg.trim();
        } else {
          // Also check tenx.queryLogGroup nested form
          const tenx = parsed['tenx'];
          if (tenx && typeof tenx === 'object') {
            const nested = (tenx as Record<string, unknown>)['queryLogGroup'];
            if (typeof nested === 'string' && nested.trim()) {
              queryLogGroup = nested.trim();
            }
          }
        }
      }
    } catch {
    // best-effort; helm may not be installed in all environments
    }

    if (queryLogGroup) {
      checks.push({
        name: 'queryLogGroup configured',
        status: 'ok',
        detail: `queryLogGroup = \`${queryLogGroup}\`. Per-query CloudWatch observability is enabled; log10x_retriever_query_status can fetch execution events for any queryId.`,
      });
    } else {
      checks.push({
        name: 'queryLogGroup configured',
        status: 'warn',
        detail: [
          'queryLogGroup is empty in helm values. Per-query CloudWatch observability disabled; queryEventLog calls early-return without writing.',
          'To enable, set:',
          '  queryLogGroup: log10x-retriever-query-events  # CW log group (pre-create via Terraform or aws logs create-log-group)',
          infra.irsaRoleArn
            ? `AND ensure the retriever IRSA role (${infra.irsaRoleArn}) has logs:CreateLogStream and logs:PutLogEvents on arn:aws:logs:{region}:{account}:log-group:{logGroup}:*`
            : 'AND ensure the retriever IRSA role has logs:CreateLogStream and logs:PutLogEvents on the log group ARN.',
        ].join('\n'),
      });
    }
  }

  return checks;
}

function buildInstallSteps(opts: {
  releaseName: string;
  namespace: string;
  licenseJwt?: string;
  licenseSupplied: boolean;
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
  licenseJwt?: string;
  licenseSupplied: boolean;
  inputBucket: string;
  indexBucket: string;
  irsaRoleArn: string;
  sqsUrls: Record<'index' | 'query' | 'subquery' | 'stream', string>;
}): string {
  // The retriever chart's values.yaml uses the `apiKeySecret` / nested
  // `tenx.apiKey` slot rather than the Reporter chart's `log10xLicenseJwt`
  // convention, so the license JWT goes into that slot. The engine
  // validates the JWT regardless of which value-key it arrives through.
  //
  // The slot is filled only when the caller handed a licence over. Otherwise
  // the line is a comment carrying the install-time flag, so no key lands in
  // a file the plan tells the operator to keep.
  const apiKeyLine =
    opts.licenseSupplied && opts.licenseJwt
      ? `  apiKey: "${opts.licenseJwt}"`
      : '  # apiKey: pass at install time with --set-string tenx.apiKey="$LOG10X_API_KEY"';
  return `tenx:
  enabled: true
${apiKeyLine}
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

/**
 * `indexContainer` arrives as `<account>/<container>/<index-path>`, the shape
 * the chart's `storage.azure.indexContainer` takes and the shape the script
 * writes. The results prefix is the index path, then the engine's own `tenx`
 * segment, then the app.
 */
function splitAzureIndexContainer(indexContainer: string): {
  container: string;
  path: string;
} {
  const parts = indexContainer.split('/');
  return { container: parts[1] ?? 'tenx-index', path: parts[2] ?? 'tenx' };
}

/**
 * AKS + Azure Blob install steps.
 *
 * Step 1 pulls the chart and runs the provisioning script that ships inside
 * it, which creates every Azure resource the Retriever needs and emits a
 * values file. Step 2 points kubectl at the cluster, because every step after
 * it is a kubectl or helm call and a fresh shell has no context for a cluster
 * the script just created. Steps 3 to 6 create the namespace, write the
 * values, install and wait, and steps 7 to 9 are the loop the provisioning
 * script prints in its own runbook: upload a blob, put a query on the query
 * queue, read the JSONL the workers wrote.
 *
 * The values file this step writes and the one the script writes carry
 * different names, so neither overwrites the other. The install passes both,
 * the script's second, so any key the script wrote from what it actually
 * created wins over a default carried here.
 */
function buildAzureInstallSteps(opts: {
  releaseName: string;
  namespace: string;
  licenseJwt?: string;
  licenseSupplied: boolean;
  storageAccount: string;
  inputContainer: string;
  indexContainer: string;
  clientId: string;
  tenantId: string;
  queues: { index: string; query: string; subquery: string; stream: string };
  resourceGroup?: string;
  location?: string;
  aksCluster?: string;
}): PlanStep[] {
  const steps: PlanStep[] = [];
  // Two names, two files. The script owns `<release>-azure-provisioned.yaml`
  // through `--values-out`; this plan owns `<release>-azure-values.yaml`.
  const provisionedValuesFile = `${opts.releaseName}-azure-provisioned.yaml`;
  const valuesFile = `${opts.releaseName}-azure-values.yaml`;
  const rg = opts.resourceGroup ?? '<resource-group>';
  const loc = opts.location ?? '<location>';
  const aks = opts.aksCluster ?? '<aks-cluster-name>';
  const kubeconfigFile = `${aks}.kubeconfig`;
  const { container: indexContainerName, path: indexPath } = splitAzureIndexContainer(
    opts.indexContainer
  );
  const resultsPrefix = `${indexPath}/tenx/app/qr/`;

  steps.push({
    title: 'Pull the chart and provision the Azure resources',
    rationale:
      `The script lives inside the chart tarball, at \`${AZURE_PROVISION_SCRIPT}\`, so the pull comes first. ` +
      'One run creates the storage account (flat namespace), the input and index containers, the four Storage ' +
      'Queues, the user-assigned managed identity with "Storage Blob Data Contributor" and "Storage Queue Data ' +
      'Contributor" on the account, the Event Grid system topic with a BlobCreated subscription onto the index ' +
      'queue, and the federated credential binding the identity to this release\'s ServiceAccount. It ends by ' +
      `writing \`${provisionedValuesFile}\`, pinning image tag \`${RETRIEVER_IMAGE_TAG}\`. ` +
      `${AZURE_OPERATOR_ROLES_NOTE} ${AZURE_NODE_SIZE_NOTE}`,
    commands: buildAzureProvisionCommands({
      resourceGroup: rg,
      location: loc,
      account: opts.storageAccount,
      aksCluster: aks,
      namespace: opts.namespace,
      releaseName: opts.releaseName,
      valuesOut: provisionedValuesFile,
    }),
    expectDurationSec: 900,
  });

  steps.push({
    title: 'Point kubectl at the cluster',
    rationale:
      `Every step below runs kubectl or helm against \`${aks}\`. A shell that has not fetched the credentials ` +
      'has no context for a cluster the previous step just created, and `--overwrite-existing` keeps a stale ' +
      'entry of the same name from winning. The write goes to a file of its own rather than into the default ' +
      'kubeconfig, so nothing already in `~/.kube/config` is touched.',
    commands: [
      `az aks get-credentials --resource-group ${rg} --name ${aks} \\\n  --file ./${kubeconfigFile} --overwrite-existing`,
      `export KUBECONFIG="$PWD/${kubeconfigFile}"`,
      'kubectl get nodes',
    ],
  });

  steps.push({
    title: 'Create target namespace',
    rationale: `The Retriever installs into \`${opts.namespace}\`.`,
    commands: [
      `kubectl create namespace ${opts.namespace} --dry-run=client -o yaml | kubectl apply -f -`,
    ],
  });

  steps.push({
    title: 'Write Helm values',
    rationale:
      'Carries the chart\'s `storage.provider: azure` block: the account, both containers, the four Storage ' +
      'Queue names, and workload-identity auth. `fullnameOverride` is the release name, which is what makes the ' +
      `ServiceAccount \`${opts.releaseName}\` rather than \`${opts.releaseName}-${RETRIEVER_CHART_NAME}\`, the ` +
      `name the federated credential subject \`system:serviceaccount:${opts.namespace}:${opts.releaseName}\` ` +
      'binds to. Without it the pod reaches 2/2 Running and every queue poll comes back AADSTS700213, no ' +
      'matching federated identity record for the presented subject. ' +
      `The file sits beside \`${provisionedValuesFile}\` rather than on top of it.`,
    file: {
      path: valuesFile,
      contents: renderAzureRetrieverValues(opts),
      language: 'yaml',
    },
    commands: [],
  });

  steps.push({
    title: 'Install via Helm',
    rationale:
      'Deploys the indexer, the query handler and the stream worker against Blob and the Storage Queues. ' +
      `Both values files are passed, \`${provisionedValuesFile}\` second, so what the script recorded about ` +
      `what it created wins over any default in \`${valuesFile}\`. ` +
      AZURE_API_KEY_NOTE,
    commands: [
      `helm upgrade --install ${opts.releaseName} ${RETRIEVER_CHART_REF} \\\n  --version ${RETRIEVER_CHART_VERSION} \\\n  -n ${opts.namespace} --create-namespace \\\n  -f ${valuesFile} \\\n  -f ${provisionedValuesFile}`,
    ],
  });

  steps.push({
    title: 'Wait for rollout',
    rationale:
      `The chart labels the pod \`${RETRIEVER_POD_SELECTOR}\` and names the container ` +
      `\`${RETRIEVER_CONTAINER}\`. A selector on \`app.kubernetes.io/instance\` matches nothing here, so it ` +
      'reports "No resources found" whatever the pod is doing.',
    commands: [
      `kubectl -n ${opts.namespace} rollout status deployment/${opts.releaseName}-${RETRIEVER_CLUSTER_NAME} --timeout=10m || true`,
      `kubectl -n ${opts.namespace} logs -l ${RETRIEVER_POD_SELECTOR} -c ${RETRIEVER_CONTAINER} --tail=50`,
    ],
    expectDurationSec: 600,
  });

  steps.push({
    title: 'Upload a log to the input container',
    rationale:
      `The first path segment of the blob name is the application name, so \`app/test.log\` indexes under ` +
      '`app` and the query below has to carry the same name. Event Grid delivers the BlobCreated event to ' +
      `\`${opts.queues.index}\` and the pod writes the index. A query naming anything else returns silence ` +
      `rather than an error. ${AZURE_EVENT_TIME_NOTE}`,
    commands: [
      AZURE_SAMPLE_LOG_COMMAND,
      `az storage blob upload \\\n  --account-name ${opts.storageAccount} \\\n  --auth-mode login \\\n  -c ${opts.inputContainer} \\\n  -n app/test.log \\\n  -f ./test.log \\\n  -o none`,
    ],
  });

  steps.push({
    title: 'Put a query on the query queue',
    rationale:
      `The query body names the app \`app\`, matching the blob uploaded above, and sets \`writeResults\` so the ` +
      `workers write JSONL under \`${indexContainerName}/${resultsPrefix}<queryId>/<sliceFromMs>_<sliceToMs>/\`. ` +
      'The window is `now("-1h")` to `now()`, evaluated against the timestamp inside each indexed line, which ' +
      'is why the step above stamps the sample with the current time. The second command lists the results ' +
      'prefix recursively, which is how the queryId becomes known: the engine mints it, rather than this plan.',
    commands: [
      `az storage message put \\\n  --account-name ${opts.storageAccount} \\\n  --auth-mode login \\\n  --queue-name ${opts.queues.query} \\\n  --content '${AZURE_SAMPLE_QUERY_BODY}' \\\n  -o none`,
      `az storage blob list \\\n  --account-name ${opts.storageAccount} \\\n  --auth-mode login \\\n  -c ${indexContainerName} \\\n  --prefix ${resultsPrefix} \\\n  --query "[].name" -o tsv`,
    ],
  });

  steps.push({
    title: 'Read the results',
    rationale:
      'The first command picks the most recently written `.jsonl` under the results prefix, the second ' +
      `downloads it, the third prints it. One matched event per line. ${AZURE_RESULTS_NOTE}`,
    expectDurationSec:
      AZURE_RESULT_POLL_ATTEMPTS * AZURE_RESULT_POLL_INTERVAL_SEC,
    commands: [
      `blob="$(az storage blob list \\\n  --account-name ${opts.storageAccount} \\\n  --auth-mode login \\\n  -c ${indexContainerName} \\\n  --prefix ${resultsPrefix} \\\n  --query "sort_by([?ends_with(name, '.jsonl')], &properties.lastModified)[-1].name" \\\n  -o tsv)"`,
      `az storage blob download \\\n  --account-name ${opts.storageAccount} \\\n  --auth-mode login \\\n  -c ${indexContainerName} \\\n  -n "$blob" \\\n  -f ./results.jsonl \\\n  -o none`,
      'cat ./results.jsonl',
    ],
  });

  return steps;
}

function renderAzureRetrieverValues(opts: {
  releaseName: string;
  licenseJwt?: string;
  licenseSupplied: boolean;
  storageAccount: string;
  inputContainer: string;
  indexContainer: string;
  clientId: string;
  tenantId: string;
  queues: { index: string; query: string; subquery: string; stream: string };
}): string {
  // `invoke: queue` is the Azure equivalent of the AWS `sqs` fan-out: the
  // pipeline hands the next stage to an Azure Storage Queue. `scheduledQueries`
  // is off because the CronJob shells an aws-cli image, which has no Azure
  // equivalent in the chart today.
  //
  // `image.tag` is pinned rather than left to the chart's appVersion, which
  // trails the released engine.
  //
  // `fullnameOverride` is the release name. The chart names the ServiceAccount
  // after the fullname, and the federated credential the provisioning script
  // creates binds `system:serviceaccount:<namespace>:<release>`. Left out, the
  // chart names it `<release>-retriever-10x`, the subject no longer matches,
  // and every queue poll returns AADSTS700213 from a pod that is otherwise
  // healthy.
  //
  // No `tenx:` block: the published chart carries no such key, so everything
  // under it configures nothing. Its `apiKey` slot was the second copy of the
  // licence in this file.
  const apiKeyLines =
    opts.licenseSupplied && opts.licenseJwt
      ? [`log10xApiKey: "${opts.licenseJwt}"`]
      : [
          '# Supplied at install time so no key lands in this file:',
          '#   --set-string log10xApiKey="$LOG10X_API_KEY"',
        ];
  return `# log10xApiKey is optional: empty means the built-in evaluation licence.
${apiKeyLines.join('\n')}

fullnameOverride: "${opts.releaseName}"

image:
  tag: "${RETRIEVER_IMAGE_TAG}"

storage:
  provider: azure
  azure:
    account: "${opts.storageAccount}"
    indexContainer: "${opts.indexContainer}"
    inputContainer: "${opts.inputContainer}"
    invoke: queue

    queues:
      index: "${opts.queues.index}"
      query: "${opts.queues.query}"
      subquery: "${opts.queues.subquery}"
      stream: "${opts.queues.stream}"

    auth:
      method: workloadIdentity
      clientId: "${opts.clientId}"
      tenantId: "${opts.tenantId}"

scheduledQueries:
  enabled: false
`;
}

/**
 * Verify probes.
 *
 * Every AWS probe is gated on `storageProvider === 'aws'`. An Azure install
 * has no S3 bucket and no SQS queue, and the AWS-shaped probes did not fail
 * loudly on one: probe 5 pasted the blob container name into an `s3://` URL
 * and returned AccessDenied, and the queue-depth probe polled an SQS URL
 * scraped from an unrelated AWS estate and reported zero messages, which
 * reads as a pass.
 */
function buildVerifyProbes(opts: {
  releaseName: string;
  namespace: string;
  storageProvider: RetrieverStorageProvider;
  inputBucket?: string;
  indexQueueUrl?: string;
  /** Namespace where the Receiver DaemonSet runs (if installed). Used to probe outputOffload config. */
  receiverNamespace?: string;
  /** Azure storage account holding both containers. */
  storageAccount?: string;
  /** Azure index container, as `<account>/<container>/<path>`. */
  indexContainer?: string;
  /** Azure Storage Queue names. */
  azureQueues?: { index: string; query: string; subquery: string; stream: string };
}): VerifyProbe[] {
  const { releaseName, namespace, storageProvider } = opts;
  const isAzure = storageProvider === 'azure';
  const probes: VerifyProbe[] = [];
  // On Azure the values file sets `fullnameOverride`, so the per-cluster
  // objects are `<release>-all-in-one`. On AWS the chart derives the fullname
  // and they are `<release>-retriever-10x-all-in-one`.
  const workloadName = isAzure
    ? `${releaseName}-${RETRIEVER_CLUSTER_NAME}`
    : `${releaseName}-${RETRIEVER_CHART_NAME}-${RETRIEVER_CLUSTER_NAME}`;
  // `app.kubernetes.io/instance` is set by nothing in the chart. The pod
  // labels are `app=retriever-10x` and `cluster=all-in-one`.
  const podSelector = isAzure ? RETRIEVER_POD_SELECTOR : `app.kubernetes.io/instance=${releaseName}`;
  const containerFlag = isAzure ? ` -c ${RETRIEVER_CONTAINER}` : '';

  probes.push({
    name: 'pods-ready',
    question: 'Are indexer + query-handler + stream-worker pods Ready?',
    commands: [
      `kubectl -n ${namespace} wait --for=condition=Ready pod -l ${podSelector} --timeout=10m`,
    ],
    expectOutput: 'condition met',
    timeoutSec: 600,
  });

  probes.push({
    name: 'indexer-healthy',
    question: isAzure
      ? 'Has the indexer written an index object? A healthy run prints one `index written` line per index ' +
        'object and no AADSTS token refusal. Empty output means nothing has been indexed yet.'
      : 'Is the indexer processing messages from the index queue?',
    // `grep -iE 'index'` matched class names such as `IndexQueryWriter`, so
    // the probe printed lines whether or not a single blob had been indexed.
    // `index written` is the line the indexer logs per index object.
    commands: isAzure
      ? [
          `kubectl -n ${namespace} logs -l ${podSelector}${containerFlag} --tail=200 | grep -E 'index written|AADSTS' | head -20`,
        ]
      : [
          `kubectl -n ${namespace} logs -l ${podSelector},app.kubernetes.io/component=indexer --tail=200 | grep -iE 'index|processed|bloom' | head -20`,
        ],
    timeoutSec: 120,
  });

  if (isAzure) {
    // The failure this probe exists for: the ServiceAccount name has to equal
    // the subject of the federated credential, or the pod runs and every call
    // to Blob and the queues comes back AADSTS700213.
    probes.push({
      name: 'workload-identity-binding',
      question:
        `Does the ServiceAccount \`${releaseName}\` carry the managed-identity client id, and is the pod log ` +
        'free of AADSTS700213? The first command prints the client id, the second counts the token refusals, ' +
        'and a healthy install answers with an id and a zero.',
      commands: [
        `kubectl -n ${namespace} get sa ${releaseName} -o jsonpath='{.metadata.annotations.azure\\.workload\\.identity/client-id}{"\\n"}'`,
        `kubectl -n ${namespace} logs -l ${podSelector}${containerFlag} --tail=200 | grep -c AADSTS700213 || true`,
      ],
    });
  }

  probes.push({
    name: 'query-endpoint-healthy',
    question: 'Is the query endpoint responding?',
    commands: isAzure
      ? [`kubectl -n ${namespace} get svc ${workloadName}`]
      : [`kubectl -n ${namespace} get ingress,svc -l app.kubernetes.io/instance=${releaseName}`],
  });

  // Retriever Service external-access probe.
  // The helm chart defaults to ClusterIP. The MCP server (and CLI) run on
  // the user's laptop, not inside the cluster, so *.svc.cluster.local DNS
  // never resolves. This probe surfaces the spec.type and explains the
  // options when it is ClusterIP.
  //
  // Detection: no /var/run/secrets/kubernetes.io mount → running outside
  // the cluster. KUBERNETES_SERVICE_HOST, injected by the pod
  // infrastructure into every in-cluster container, is the secondary signal.
  const runningInsideCluster =
    process.env['KUBERNETES_SERVICE_HOST'] !== undefined;

  // Probe question varies by whether the MCP is inside or outside the cluster.
  const accessQuestion = runningInsideCluster
    ? 'Is the Retriever Service reachable from outside the cluster?'
    : 'Is the Retriever Service reachable from outside the cluster? If type=ClusterIP, use port-forward, LoadBalancer, or deploy the MCP server inside the cluster.';

  probes.push({
    name: 'retriever-service-accessibility',
    question: accessQuestion,
    commands: isAzure
      ? [
          // The chart puts no `app` label on the Service object itself, only
          // on the pods the Service selects, so the Service is addressed by
          // name here rather than by label.
          `kubectl -n ${namespace} get svc ${workloadName} -o json 2>/dev/null` +
            ` | jq -r '"Service \\(.metadata.name): type=\\(.spec.type) port=\\(.spec.ports[0].port // "?")"'` +
            ` 2>/dev/null` +
            ` || kubectl -n ${namespace} get svc ${workloadName} -o wide`,
        ]
      : [
          // Use jq when available; fall back to plain kubectl wide output.
          // The agent reads the type= field from the output to determine if
          // external access guidance applies.
          `kubectl -n ${namespace} get svc -l app.kubernetes.io/instance=${releaseName} -o json 2>/dev/null` +
            ` | jq -r '.items[] | "Service \\(.metadata.name): type=\\(.spec.type) port=\\(.spec.ports[0].port // "?")"'` +
            ` 2>/dev/null` +
            ` || kubectl -n ${namespace} get svc -l app.kubernetes.io/instance=${releaseName} -o wide`,
        ],
  });

  if (isAzure) {
    const account = opts.storageAccount ?? '<storage-account>';
    const { container: indexContainerName, path: indexPath } = splitAzureIndexContainer(
      opts.indexContainer ?? `${account}/tenx-index/tenx`
    );
    if (opts.inputBucket) {
      probes.push({
        name: 'blob-input',
        question: 'Does the input container hold blobs under the app prefix?',
        commands: [
          `az storage blob list \\\n  --account-name ${account} \\\n  --auth-mode login \\\n  -c ${opts.inputBucket} \\\n  --prefix app/ \\\n  --query "[].name" -o tsv | head -5`,
        ],
      });
    }
    probes.push({
      name: 'blob-index-written',
      question: 'Is the indexer writing the index into the index container?',
      commands: [
        `az storage blob list \\\n  --account-name ${account} \\\n  --auth-mode login \\\n  -c ${indexContainerName} \\\n  --prefix ${indexPath}/ \\\n  --query "[].name" -o tsv | head -5`,
      ],
    });
    if (opts.azureQueues) {
      probes.push({
        name: 'storage-queue-drainage',
        question: 'Is the index queue being drained (messages not piling up)?',
        commands: [
          `az storage message peek \\\n  --account-name ${account} \\\n  --auth-mode login \\\n  --queue-name ${opts.azureQueues.index} \\\n  --num-messages 32 \\\n  --query "length(@)" -o tsv`,
        ],
      });
    }
  }

  const inputBucket = isAzure ? undefined : opts.inputBucket;
  const indexQueueUrl = isAzure ? undefined : opts.indexQueueUrl;
  const receiverNamespace = isAzure ? undefined : opts.receiverNamespace;

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

  // Fix 88 — Receiver outputOffload capability probe. AWS only: the recipe it
  // points at writes to S3, and offload delivery into Blob has no recipe, so
  // on Azure the probe would ask for a state no config can reach.
  // If a Receiver is installed, the user may be running it with the rate
  // regulator only (soft-drop / sample) rather than the outputOffload mode
  // that actually routes bytes to S3 for the Retriever to index. Without
  // outputOffload the S3 bucket stays empty and the Retriever has nothing
  // to index. This probe reads the Receiver's ConfigMap to detect the gap
  // proactively, before the user discovers it via an empty s3-offload-input.
  if (receiverNamespace) {
    probes.push({
      name: 'receiver-offload-capability',
      question:
        'Is the Receiver configured for outputOffload mode (required to route bytes to S3)?',
      commands: [
        `kubectl -n ${receiverNamespace} get configmap -o yaml 2>/dev/null | grep -A5 "outputOffload\\|offload\\|run/modules/receive/offload" || echo "outputOffload config not found — the Receiver may be running rate-only (soft-drop). To route bytes to S3, the Receiver config must include the offload module. See: https://doc.log10x.com/run/regulate"`,
      ],
    });
  }

  return probes;
}

function buildTeardownSteps(
  releaseName: string,
  namespace: string,
  storageProvider: RetrieverStorageProvider = 'aws',
  resourceGroup?: string
): PlanStep[] {
  const isAzure = storageProvider === 'azure';
  const selector = isAzure
    ? RETRIEVER_POD_SELECTOR
    : `app.kubernetes.io/instance=${releaseName}`;
  const workloadName = isAzure
    ? `${releaseName}-${RETRIEVER_CLUSTER_NAME}`
    : `${releaseName}-${RETRIEVER_CHART_NAME}-${RETRIEVER_CLUSTER_NAME}`;
  const steps: PlanStep[] = [
    {
      title: 'Uninstall the Helm release',
      rationale: isAzure
        ? 'Removes the Deployment, the Service, the ConfigMaps and the chart-created ServiceAccount. The ' +
          'storage account, the containers, the queues, the managed identity and the AKS cluster stay: the ' +
          'last step below is what deletes those.'
        : 'Removes indexer, query-handler, stream-worker deployments, filter CronJobs, ConfigMaps, and the chart-created ServiceAccount. LEAVES AWS infra (S3, SQS, IAM role) intact — that lifecycle belongs to Terraform.',
      commands: [`helm -n ${namespace} uninstall ${releaseName}`],
    },
    {
      title: 'Clean up derived resources',
      rationale: 'Helm does not reap PVCs or Secrets created outside the release.',
      commands: [`kubectl -n ${namespace} delete pvc -l ${selector} --ignore-not-found`],
    },
    {
      title: 'Verify nothing remains',
      rationale: isAzure
        ? 'Confirms no workload is lingering. The pod label and the Service name are checked separately: the ' +
          'chart labels the pods and names the Service, and the Service object carries no `app` label.'
        : 'Confirm no workloads are lingering under the release label.',
      commands: isAzure
        ? [
            `kubectl -n ${namespace} get all,configmap,secret,pvc -l ${selector}`,
            `kubectl -n ${namespace} get svc ${workloadName} --ignore-not-found`,
          ]
        : [`kubectl -n ${namespace} get all,configmap,secret,pvc -l ${selector}`],
    },
  ];

  if (isAzure) {
    // No Terraform state exists on this path. The provisioning script created
    // the resource group and its own `--destroy` deletes it, which is the only
    // command that stops the AKS cluster and the storage account billing.
    steps.push({
      title: 'Delete the Azure resources',
      rationale:
        'One command deletes the resource group and everything the provisioning script put in it: the storage ' +
        'account with both containers, the four Storage Queues, the Event Grid subscription, the managed ' +
        'identity and the AKS cluster. Skipping it leaves a running AKS cluster and a storage account billing.',
      commands: [buildAzureTeardownCommand(resourceGroup ?? '<resource-group>')],
      expectDurationSec: 600,
    });
  } else {
    steps.push({
      title: '(Optional) teardown AWS infra',
      rationale:
        'If you\'re fully removing the Retriever, tear down the Terraform module that created the S3 buckets, SQS queues, and IAM role. Skipping this leaves empty AWS infra behind (zero-cost for SQS idle, pennies for S3 storage).',
      commands: [
        `# From your terraform directory:`,
        `# terraform destroy -target=module.retriever_aws_infra`,
      ],
    });
  }

  return steps;
}

// ── Fix 82: resolve the input bucket from the installed Helm release values ──

/**
 * Probe `helm get values` for the installed Retriever release and extract
 * the `inputBucket` value. This gives verify probes the actual bucket the
 * Terraform module created — not a name-pattern guess from the pre-install
 * snapshot.
 *
 * Falls back gracefully to `undefined` when:
 *   - helm is not available
 *   - the release is not found in the namespace
 *   - `inputBucket` is not set in the values (older chart deployments)
 *
 * Source is logged in the preflight detail so the user can audit which
 * resolution path was used.
 */
async function resolveInstalledBucket(
  releaseName: string,
  namespace: string,
): Promise<string | undefined> {
  const result = await run(
    'helm',
    ['get', 'values', '-n', namespace, releaseName, '-o', 'json'],
    { timeoutMs: 10_000 },
  );
  if (result.exitCode !== 0) return undefined;
  try {
    const values = JSON.parse(result.stdout) as Record<string, unknown>;
    const bucket = values['inputBucket'];
    if (typeof bucket === 'string' && bucket.length > 0) return bucket;
  } catch {
  // JSON parse failure — fall through
  }
  return undefined;
}
