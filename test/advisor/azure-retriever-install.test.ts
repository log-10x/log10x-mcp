/**
 * The AKS + Azure Blob install plan, against what the published chart and its
 * provisioning script actually do.
 *
 * Every expectation below was read off `retriever-10x` 1.0.24, pulled and
 * untarred:
 *
 *   templates/_helpers.tpl   fullname = fullnameOverride when set, else
 *                            `<release>-<chart>`; the ServiceAccount is named
 *                            after the fullname
 *   templates/deployment.yaml pod labels `app: retriever-10x` and
 *                            `cluster: all-in-one`; container named
 *                            `retriever-10x-all-in-one`; nothing sets
 *                            `app.kubernetes.io/instance`
 *   templates/service.yaml   Service named `<fullname>-all-in-one`, and the
 *                            object itself carries no `app` label
 *   scripts/azure/provision-retriever.sh
 *                            federated subject
 *                            `system:serviceaccount:<ns>:<release>`, default
 *                            node size Standard_D2s_v7, a six-step runbook
 *                            (credentials, install, watch, upload, query,
 *                            read) and `--destroy --resource-group RG`
 *
 * An acceptance test drove the wizard for Azure and ran exactly what it
 * emitted: the install came up 2/2 Running and 401'd on every queue poll with
 * AADSTS700213, while the plan's own probes reported nothing wrong because
 * their selector matched no pod and their storage probes were pointed at an
 * unrelated AWS estate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRetrieverPlan,
  RETRIEVER_POD_SELECTOR,
  RETRIEVER_CONTAINER,
  AKS_NODE_SIZE,
} from '../../src/lib/advisor/retriever.js';
import { buildPlanSummary } from '../../src/lib/advisor/envelope.js';
import { getPackageDefaultTool } from '../../src/lib/manifest.js';
import type { AdvisePlan } from '../../src/lib/advisor/types.js';
import type { DiscoverySnapshot } from '../../src/lib/discovery/types.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../../src/lib/discovery/types.js';

const RELEASE = 'my-retriever';
const NAMESPACE = 'logging';
const ACCOUNT = 'tenxlogs';
const CONTAINER = 'logs';

/**
 * AKS snapshot whose AWS side still carries the demo estate discovery picks
 * up. That is the shape the false pass came from: an SQS URL and an S3 bucket
 * belonging to an account that has nothing to do with this install.
 */
function aksSnapshot(): DiscoverySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'disc-aks-install-1',
    startedAt: '2026-09-13T00:00:00Z',
    finishedAt: '2026-09-13T00:01:00Z',
    kubectl: {
      available: true,
      context: 'tenx-aks',
      namespaces: [NAMESPACE],
      probedNamespaces: [NAMESPACE],
      forwarders: [],
      helmReleases: [],
      log10xApps: [],
      storageClasses: [],
      ingressClasses: [],
      backendAgents: [],
      serviceAccountIrsa: [],
    },
    aws: { available: false, s3Buckets: [], sqsQueues: [], cwLogGroups: [] },
    azure: {
      available: true,
      subscriptionId: 'sub-1',
      tenantId: 'tenant-1',
      functionApps: [],
      containerAppCount: 0,
      eventHubNamespaces: [],
    },
    recommendations: {
      suggestedNamespace: NAMESPACE,
      alreadyInstalled: {},
      retrieverS3Bucket: 'tenx-demo-cloud-retriever-351939435334',
      retrieverSqsUrls: {
        index:
          'https://sqs.us-east-1.amazonaws.com/351939435334/tenx-demo-lambda-retriever-index-queue',
        query: 'https://sqs.us-east-1.amazonaws.com/351939435334/tenx-demo-lambda-retriever-query-queue',
        subquery:
          'https://sqs.us-east-1.amazonaws.com/351939435334/tenx-demo-lambda-retriever-subquery-queue',
        stream:
          'https://sqs.us-east-1.amazonaws.com/351939435334/tenx-demo-lambda-retriever-stream-queue',
      },
      // A Receiver in the cluster: on the AWS path this adds the
      // outputOffload probe, which points at an S3 recipe and so has no
      // Azure counterpart.
      installedComponentsDetail: {
        receiver: {
          installed: true,
          pod: 'tenx-receiver',
          namespace: NAMESPACE,
          image: 'log10x/receiver:1.1.78',
          workload: 'DaemonSet/tenx-receiver',
        },
      },
    },
    probeLog: [],
  };
}

const AZURE_ARGS = {
  snapshot: aksSnapshot(),
  storageProvider: 'azure' as const,
  storageAccount: ACCOUNT,
  inputBucket: CONTAINER,
  resourceGroup: 'tenx-rg',
  location: 'eastus',
  aksCluster: 'tenx-aks',
  azureClientId: 'client-1',
  azureTenantId: 'tenant-1',
  releaseName: RELEASE,
  namespace: NAMESPACE,
};

/** A licence the wizard minted, which is not the caller's to write to disk. */
const MINTED_ARGS = { ...AZURE_ARGS, licenseJwt: 'eyJ-minted-by-the-wizard', licenseSupplied: false };
/** A licence the caller pasted in. */
const PASTED_ARGS = { ...AZURE_ARGS, licenseJwt: 'eyJ-pasted-by-the-caller', licenseSupplied: true };

function azurePlan(overrides: Record<string, unknown> = {}): Promise<AdvisePlan> {
  return buildRetrieverPlan({ ...MINTED_ARGS, ...overrides });
}

/** Every command string in a plan, across install, verify and teardown. */
function allCommands(plan: AdvisePlan): string[] {
  return [
    ...plan.install.flatMap((s) => s.commands),
    ...plan.verify.flatMap((p) => p.commands),
    ...plan.teardown.flatMap((s) => s.commands),
  ];
}

/** Everything a reader sees, commands and prose alike. */
function planText(plan: AdvisePlan): string {
  return JSON.stringify({
    install: plan.install,
    verify: plan.verify,
    teardown: plan.teardown,
    notes: plan.notes,
    preflight: plan.preflight,
    blockers: plan.blockers,
    offload: plan.offloadMarkdown ?? '',
    access: plan.retrieverAccessMarkdown ?? '',
  });
}

function valuesFiles(plan: AdvisePlan): Array<{ path: string; contents: string }> {
  return plan.install
    .filter((s) => s.file)
    .map((s) => ({ path: s.file!.path, contents: s.file!.contents }));
}

// ── B1: the ServiceAccount name is the federated credential subject ─────────

test('azure values set fullnameOverride to the release name', async () => {
  const plan = await azurePlan();
  const [values] = valuesFiles(plan);
  assert.ok(values, 'the plan writes a values file');
  assert.ok(
    values.contents.includes(`fullnameOverride: "${RELEASE}"`),
    `fullnameOverride missing; got:\n${values.contents}`,
  );
});

test('the ServiceAccount the chart names equals the subject the script binds', async () => {
  const plan = await azurePlan();
  const [values] = valuesFiles(plan);
  // chart: serviceAccountName = fullname = fullnameOverride
  const match = /fullnameOverride: "([^"]+)"/.exec(values!.contents);
  assert.ok(match, 'fullnameOverride is set');
  const serviceAccountName = match![1];
  // script: FEDERATED_SUBJECT="system:serviceaccount:${NAMESPACE}:${RELEASE}"
  assert.equal(serviceAccountName, RELEASE);
  assert.ok(
    planText(plan).includes(`system:serviceaccount:${NAMESPACE}:${RELEASE}`),
    'the plan states the subject the ServiceAccount name has to match',
  );
});

// ── B2: selectors and container match the chart ─────────────────────────────

test('azure kubectl commands select on the label the chart sets', async () => {
  const plan = await azurePlan();
  const kubectlCommands = allCommands(plan).filter((c) => c.includes('kubectl'));
  assert.ok(kubectlCommands.length >= 4, 'the azure plan runs kubectl');
  for (const cmd of kubectlCommands) {
    assert.ok(
      !cmd.includes('app.kubernetes.io/instance'),
      `no chart object carries app.kubernetes.io/instance; got: ${cmd}`,
    );
    if (cmd.includes(' -l ')) {
      assert.ok(
        cmd.includes(`-l ${RETRIEVER_POD_SELECTOR}`),
        `selector should be ${RETRIEVER_POD_SELECTOR}; got: ${cmd}`,
      );
    }
  }
  assert.equal(RETRIEVER_POD_SELECTOR, 'app=retriever-10x');
  assert.equal(RETRIEVER_CONTAINER, 'retriever-10x-all-in-one');
});

test('azure log commands name the container the chart creates', async () => {
  const plan = await azurePlan();
  const logCommands = allCommands(plan).filter((c) => c.includes('kubectl') && c.includes(' logs '));
  assert.ok(logCommands.length >= 2, 'the plan reads pod logs');
  for (const cmd of logCommands) {
    assert.ok(cmd.includes(`-c ${RETRIEVER_CONTAINER}`), `container flag missing; got: ${cmd}`);
  }
});

test('azure service probes address the Service by the name the chart gives it', async () => {
  const plan = await azurePlan();
  const svcCommands = allCommands(plan).filter((c) => c.includes('get svc'));
  assert.ok(svcCommands.length >= 2, 'the plan reads the Service');
  for (const cmd of svcCommands) {
    // Service metadata carries no `app` label, only the pods it selects do.
    assert.ok(
      cmd.includes(`${RELEASE}-all-in-one`),
      `Service should be addressed by name; got: ${cmd}`,
    );
  }
});

// ── B3: kubectl is pointed at the cluster before it is used ─────────────────

test('azure plan fetches cluster credentials before the first kubectl command', async () => {
  const plan = await azurePlan();
  const flat = plan.install.flatMap((s) => s.commands);
  const credsIndex = flat.findIndex((c) => c.includes('az aks get-credentials'));
  const kubectlIndex = flat.findIndex((c) => c.includes('kubectl'));
  assert.ok(credsIndex >= 0, 'a get-credentials step exists');
  assert.ok(kubectlIndex >= 0, 'kubectl is used');
  assert.ok(credsIndex < kubectlIndex, 'credentials are fetched first');
  assert.ok(
    flat[credsIndex].includes('--overwrite-existing'),
    'a stale entry of the same name is overwritten',
  );
  assert.ok(
    flat.some((c) => c.startsWith('export KUBECONFIG=')),
    'KUBECONFIG is exported for the steps that follow',
  );
});

// ── B4: the AKS cluster name is an argument, not a placeholder ──────────────

test('azure plan uses the supplied AKS cluster name in provisioning and credentials', async () => {
  const plan = await azurePlan();
  const text = planText(plan);
  assert.ok(text.includes('--create-aks tenx-aks'), 'the provisioning command names the cluster');
  assert.ok(text.includes('--name tenx-aks'), 'get-credentials names the cluster');
  assert.ok(!text.includes('<aks-cluster-name>'), 'no placeholder is left for the operator to guess');
});

// ── B5 / B6: the loop the provisioning script prints ────────────────────────

test('azure plan carries upload, query and read steps with concrete values', async () => {
  const plan = await azurePlan();
  const titles = plan.install.map((s) => s.title);
  assert.ok(titles.some((t) => /upload/i.test(t)), `no upload step; got: ${titles.join(' | ')}`);
  assert.ok(titles.some((t) => /query/i.test(t)), `no query step; got: ${titles.join(' | ')}`);
  assert.ok(titles.some((t) => /read the results/i.test(t)), `no read step; got: ${titles.join(' | ')}`);

  const commands = plan.install.flatMap((s) => s.commands).join('\n');
  assert.ok(commands.includes('az storage blob upload'), 'the upload command is emitted');
  assert.ok(commands.includes('-n app/test.log'), 'the blob name carries the app segment');
  assert.ok(commands.includes('az storage message put'), 'the query is put on the queue');
  assert.ok(commands.includes('--queue-name tenx-query'), 'the query queue is named');
  assert.ok(commands.includes('"name":"app"'), 'the query name matches the uploaded app');
  assert.ok(commands.includes('"writeResults":true'), 'results are written');
  assert.ok(commands.includes('az storage blob download'), 'the results are downloaded');
  assert.ok(commands.includes('sort_by('), 'the newest result blob is picked');
});

test('azure commands carry no unresolved app or queryId placeholder', async () => {
  const plan = await azurePlan();
  for (const cmd of allCommands(plan)) {
    assert.ok(!cmd.includes('<app>'), `unresolved <app> in: ${cmd}`);
    assert.ok(!cmd.includes('<queryId>'), `unresolved <queryId> in: ${cmd}`);
  }
});

// ── W1 / W2: no AWS probe on an Azure plan ──────────────────────────────────

test('no azure plan string names an AWS resource', async () => {
  const plan = await azurePlan();
  const text = planText(plan);
  for (const forbidden of ['s3://', 'aws s3', 'sqs', 'IRSA', 'terraform']) {
    assert.ok(
      !text.toLowerCase().includes(forbidden.toLowerCase()),
      `azure plan contains "${forbidden}"`,
    );
  }
});

test('azure verify probes read Blob and the Storage Queues', async () => {
  const plan = await azurePlan();
  const names = plan.verify.map((p) => p.name);
  assert.ok(names.includes('blob-input'), `no blob input probe; got: ${names.join(', ')}`);
  assert.ok(names.includes('blob-index-written'), `no blob index probe; got: ${names.join(', ')}`);
  assert.ok(
    names.includes('storage-queue-drainage'),
    `no queue depth probe; got: ${names.join(', ')}`,
  );
  assert.ok(
    names.includes('workload-identity-binding'),
    `no probe for the binding that failed live; got: ${names.join(', ')}`,
  );
  const queueProbe = plan.verify.find((p) => p.name === 'storage-queue-drainage')!;
  assert.ok(
    queueProbe.commands.join('\n').includes('--queue-name tenx-index'),
    'the queue probe peeks the index queue on this account',
  );
});

// ── W3: teardown is the script, not Terraform ───────────────────────────────

test('azure teardown deletes the resource group through the provisioning script', async () => {
  const plan = await azurePlan();
  const commands = plan.teardown.flatMap((s) => s.commands).join('\n');
  assert.ok(
    commands.includes(
      'bash retriever-10x/scripts/azure/provision-retriever.sh --destroy --resource-group tenx-rg',
    ),
    `teardown command missing; got:\n${commands}`,
  );
  assert.ok(!commands.includes('terraform'), 'no Terraform on this path');
});

// ── W4: a licence the caller did not supply is never written to a file ──────

test('a wizard-minted licence reaches no values file', async () => {
  const plan = await azurePlan();
  for (const file of valuesFiles(plan)) {
    assert.ok(
      !file.contents.includes(MINTED_ARGS.licenseJwt),
      `licence key written into ${file.path}`,
    );
  }
  assert.ok(
    plan.notes.some((n) => n.includes('--set-string log10xApiKey')),
    'the plan says how to supply a key at install time instead',
  );
});

test('a caller-supplied licence is wired into the values file once', async () => {
  const plan = await buildRetrieverPlan(PASTED_ARGS);
  const [values] = valuesFiles(plan);
  const occurrences = values!.contents.split(PASTED_ARGS.licenseJwt).length - 1;
  assert.equal(occurrences, 1, 'the key appears once, in log10xApiKey');
  assert.ok(
    values!.contents.includes(`log10xApiKey: "${PASTED_ARGS.licenseJwt}"`),
    'the key goes into the chart key that reads it',
  );
});

test('the aws values file also withholds a licence the caller did not supply', async () => {
  const plan = await buildRetrieverPlan({
    snapshot: aksSnapshot(),
    licenseJwt: 'eyJ-minted-by-the-wizard',
    licenseSupplied: false,
    inputBucket: 'tenx-bucket',
    irsaRoleArn: 'arn:aws:iam::111:role/tenx',
    sqsUrls: { index: 'i', query: 'q', subquery: 's', stream: 'st' },
  });
  const values = plan.install.find((s) => s.file)?.file?.contents ?? '';
  assert.ok(!values.includes('eyJ-minted-by-the-wizard'), 'no key in the aws values file either');
  assert.ok(values.includes('--set-string tenx.apiKey'), 'the install-time flag is stated instead');
});

// ── W5: the two values files have different names ───────────────────────────

test('the plan does not overwrite the file the provisioning script writes', async () => {
  const plan = await azurePlan();
  const provisionStep = plan.install[0]!;
  const valuesOut = /--values-out (\S+)/.exec(provisionStep.commands.join('\n'));
  assert.ok(valuesOut, 'the provisioning command names its output file');
  const written = valuesFiles(plan).map((f) => f.path);
  assert.ok(
    !written.includes(valuesOut![1]),
    `step 3 writes over the script's file (${valuesOut![1]})`,
  );
  const install = plan.install.find((s) => s.commands.some((c) => c.includes('helm upgrade')))!;
  const helm = install.commands.join('\n');
  assert.ok(helm.includes(`-f ${written[0]}`), 'the install passes the plan values file');
  assert.ok(helm.includes(`-f ${valuesOut![1]}`), 'and the script values file');
  assert.ok(
    helm.indexOf(written[0]) < helm.indexOf(valuesOut![1]),
    "the script's file comes second so what it recorded wins",
  );
});

// ── W7: the Service name after the fullnameOverride fix ─────────────────────

test('the external-access section names the Service the azure install creates', async () => {
  const plan = await azurePlan();
  const md = plan.retrieverAccessMarkdown ?? '';
  assert.ok(md.includes(`svc/${RELEASE}-all-in-one`), `port-forward names the wrong Service:\n${md}`);
  assert.ok(
    !md.includes(`${RELEASE}-retriever-10x-all-in-one`),
    'the pre-override name is gone from the azure path',
  );
  assert.ok(!md.includes('aws-load-balancer-type'), 'no AWS load-balancer annotation on AKS');
});

// ── S1 / S2: how the script is invoked ──────────────────────────────────────

test('the provisioning script is invoked through bash at the node size it defaults to', async () => {
  const plan = await azurePlan();
  const cmd = plan.install[0]!.commands.join('\n');
  assert.ok(
    cmd.includes('bash retriever-10x/scripts/azure/provision-retriever.sh'),
    // helm package writes 0644, so the untarred copy is never executable.
    `the script needs bash; got:\n${cmd}`,
  );
  assert.equal(AKS_NODE_SIZE, 'Standard_D2s_v7');
  assert.ok(cmd.includes(`--node-size ${AKS_NODE_SIZE}`), 'the node size is passed');
  assert.ok(
    plan.install[0]!.rationale.includes('az vm list-skus'),
    'the refusal path names how to list the allowed sizes',
  );
});

// ── the aws path is untouched ───────────────────────────────────────────────

test('the aws plan keeps its S3, SQS and Terraform shape', async () => {
  const plan = await buildRetrieverPlan({
    snapshot: aksSnapshot(),
    licenseJwt: 'jwt-value',
    inputBucket: 'tenx-bucket',
    irsaRoleArn: 'arn:aws:iam::111:role/tenx',
    sqsUrls: { index: 'i', query: 'q', subquery: 's', stream: 'st' },
  });
  const names = plan.verify.map((p) => p.name);
  assert.ok(names.includes('s3-offload-input'), 'the S3 write-side probe stays');
  assert.ok(names.includes('sqs-drainage'), 'the SQS depth probe stays');
  assert.ok(
    plan.teardown.some((s) => s.commands.some((c) => c.includes('terraform destroy'))),
    'the Terraform teardown note stays on the aws path',
  );
  assert.ok(
    plan.verify.some((p) => p.commands.some((c) => c.includes('app.kubernetes.io/instance'))),
    'the aws selector is left as it was',
  );
});

// ── W6: what the tool says about blockers and preflight ─────────────────────

test('a preflight failure is reported and counted, and blockers stays the input gate', async () => {
  const snapshot = aksSnapshot();
  const plan = await buildRetrieverPlan({
    ...MINTED_ARGS,
    snapshot: {
      ...snapshot,
      kubectl: { ...snapshot.kubectl, available: false, error: 'no kubeconfig (test)' },
    },
  });
  const kubectlRow = plan.preflight.find((c) => c.name === 'kubectl');
  assert.equal(kubectlRow?.status, 'fail');
  // Every input the plan needs was supplied, so nothing gates it. The failing
  // row is a state report: re-invoking with a different argument does not
  // answer it.
  assert.deepEqual(plan.blockers, []);
  assert.ok(plan.install.length > 0, 'the steps that fix the state are still printed');
  const summary = buildPlanSummary(plan, 'all');
  assert.ok(summary.preflight_summary.fail >= 1, 'the envelope carries the failure count');
});

test('the tool description describes the gate the code actually has', () => {
  const description = getPackageDefaultTool('log10x_advise_retriever').description ?? '';
  assert.ok(
    !/preflight fails closed/i.test(description),
    'the description still promises a fail-closed preflight',
  );
  assert.ok(/blockers/.test(description), 'the description names the array that does gate');
  assert.ok(
    /preflight_summary\.fail/.test(description),
    'the description points the reader at the failure count beside it',
  );
});

test('an S3 bucket from discovery never becomes the azure input container', async () => {
  // A verify plan with no container passed. The snapshot carries an S3 bucket
  // name discovery pattern-matched out of an unrelated AWS account.
  const plan = await buildRetrieverPlan({
    ...MINTED_ARGS,
    inputBucket: undefined,
    skipInstall: true,
    skipTeardown: true,
  });
  const commands = plan.verify.flatMap((p) => p.commands).join('\n');
  assert.ok(
    !commands.includes('tenx-demo-cloud-retriever-351939435334'),
    `the AWS bucket name reached an azure probe:\n${commands}`,
  );
  assert.ok(
    !plan.verify.some((p) => p.name === 'blob-input'),
    'with no container supplied there is nothing to list',
  );
});
