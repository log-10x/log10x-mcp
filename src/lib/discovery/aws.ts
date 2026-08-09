/**
 * Read-only AWS probes for the install advisor.
 *
 * Shells out to `aws` CLI — no SDK dependency. Customers with AWS
 * configured already have the CLI; the ones that don't will see
 * `aws.available = false` and the advisor will fall back to asking
 * them for the facts by hand.
 *
 * Probe budget is tight: we call roughly 6 read APIs per run. No
 * pagination — big accounts may get truncated, and that's fine for
 * an advisor (we just say "and N more..." in the output).
 */

import { runJson, type ShellResult } from './shell.js';
import type {
  AwsProbes,
  CwLogGroup,
  EksCluster,
  LambdaFunctionInfo,
  LambdaProbes,
  ProbeLogEntry,
  S3Bucket,
  SqsQueue,
} from './types.js';

export interface AwsProbeOpts {
  /** AWS region. If absent, we pick it up from the CLI config. */
  region?: string;
  /** Substring hint for finding the retriever bucket. Default: 'retriever'. */
  bucketHint?: string;
  /** EKS cluster name to describe, if known. */
  eksClusterName?: string;
  /** Per-call timeout. Default 10_000ms. */
  timeoutMs?: number;
  /**
   * Probe the serverless estate (Lambda functions, OTel-extension layers,
   * log-group subscription filters). Default true; one list-functions call
   * when the account has no functions, up to ~22 calls when it does.
   */
  includeLambda?: boolean;
}

/** Layer/env markers that identify an OTel collector Lambda extension.
 * Covers ADOT (`aws-otel-*`), upstream community layers
 * (`opentelemetry-collector*`), and vendor distributions built on the
 * collector (Coralogix telemetry exporter). */
const OTEL_LAYER_RX = /otel|opentelemetry|adot|coralogix/i;

/** Env vars whose VALUES are safe and useful to capture (OTel wiring). */
const OTEL_ENV_ALLOWLIST = [
  'AWS_LAMBDA_EXEC_WRAPPER',
  'OPENTELEMETRY_COLLECTOR_CONFIG_FILE',
  'OPENTELEMETRY_COLLECTOR_CONFIG_URI',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
];

/** Probe budget: functions listed, and log groups checked for filters. */
const LAMBDA_LIST_CAP = 200;
const SUBSCRIPTION_PROBE_CAP = 20;

export async function probeAws(
  opts: AwsProbeOpts = {}
): Promise<{ probes: AwsProbes; log: ProbeLogEntry[] }> {
  const log: ProbeLogEntry[] = [];
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const record = (r: ShellResult): void => {
    log.push({
      cmd: r.cmd,
      exitCode: r.exitCode,
      ms: r.ms,
      stderrSnippet: r.exitCode === 0 ? undefined : r.stderr.slice(0, 400) || undefined,
    });
  };

  // Step 1: is AWS CLI configured at all?
  const ident = await runJson<{ Account: string; Arn: string; UserId: string }>(
    'aws',
    ['sts', 'get-caller-identity', '--output', 'json'],
    { timeoutMs }
  );
  record(ident.result);
  if (!ident.parsed) {
    return {
      probes: {
        available: false,
        error: ident.result.stderr.slice(0, 400) || 'aws sts get-caller-identity failed',
        s3Buckets: [],
        sqsQueues: [],
        cwLogGroups: [],
      },
      log,
    };
  }

  // Step 2: region. CLI default if not supplied.
  let region = opts.region;
  if (!region) {
    const reg = await runJson<string>('aws', ['configure', 'get', 'region'], { timeoutMs: 3_000 });
    record(reg.result);
    region = reg.result.stdout.trim() || 'us-east-1';
  }

  // Step 3: EKS cluster describe (only if name hint provided, otherwise list).
  let eks: EksCluster | undefined;
  if (opts.eksClusterName) {
    const d = await runJson<{
      cluster: { name: string; endpoint: string; version: string; identity?: { oidc?: { issuer?: string } } };
    }>(
      'aws',
      ['eks', 'describe-cluster', '--name', opts.eksClusterName, '--region', region, '--output', 'json'],
      { timeoutMs }
    );
    record(d.result);
    if (d.parsed?.cluster) {
      const ng = await runJson<{ nodegroups: string[] }>(
        'aws',
        [
          'eks',
          'list-nodegroups',
          '--cluster-name',
          opts.eksClusterName,
          '--region',
          region,
          '--output',
          'json',
        ],
        { timeoutMs }
      );
      record(ng.result);
      const rawIssuer = d.parsed.cluster.identity?.oidc?.issuer;
      // Strip the https:// prefix — the module input (oidc_provider) expects no scheme.
      const oidcIssuer = rawIssuer ? rawIssuer.replace(/^https?:\/\//, '') : undefined;
      eks = {
        name: d.parsed.cluster.name,
        endpoint: d.parsed.cluster.endpoint,
        version: d.parsed.cluster.version,
        nodeGroups: ng.parsed?.nodegroups ?? [],
        oidcIssuer,
      };
    }
  } else {
    // List clusters so the advisor can tell the user "you have N EKS clusters, pick one."
    const list = await runJson<{ clusters: string[] }>(
      'aws',
      ['eks', 'list-clusters', '--region', region, '--output', 'json'],
      { timeoutMs }
    );
    record(list.result);
    // Best guess: if there's exactly one cluster, describe it.
    if (list.parsed?.clusters?.length === 1) {
      const only = list.parsed.clusters[0];
      const d = await runJson<{ cluster: { name: string; endpoint: string; version: string; identity?: { oidc?: { issuer?: string } } } }>(
        'aws',
        ['eks', 'describe-cluster', '--name', only, '--region', region, '--output', 'json'],
        { timeoutMs }
      );
      record(d.result);
      if (d.parsed?.cluster) {
        const ng = await runJson<{ nodegroups: string[] }>(
          'aws',
          ['eks', 'list-nodegroups', '--cluster-name', only, '--region', region, '--output', 'json'],
          { timeoutMs }
        );
        record(ng.result);
        const rawIssuer = d.parsed.cluster.identity?.oidc?.issuer;
        const oidcIssuer = rawIssuer ? rawIssuer.replace(/^https?:\/\//, '') : undefined;
        eks = {
          name: d.parsed.cluster.name,
          endpoint: d.parsed.cluster.endpoint,
          version: d.parsed.cluster.version,
          nodeGroups: ng.parsed?.nodegroups ?? [],
          oidcIssuer,
        };
      }
    }
  }

  // Step 4: S3 buckets matching the hint (default: "retriever").
  // Ranking is specificity-first so the most-likely retriever bucket
  // surfaces at the top of the list even on accounts with dozens of
  // log10x/tenx buckets.
  const hint = (opts.bucketHint ?? 'retriever').toLowerCase();
  const buckets = await runJson<{ Buckets: Array<{ Name: string }> }>(
    'aws',
    ['s3api', 'list-buckets', '--output', 'json'],
    { timeoutMs }
  );
  record(buckets.result);
  const allBuckets = buckets.parsed?.Buckets?.map((b) => b.Name) ?? [];

  function rank(name: string): number {
    const lc = name.toLowerCase();
    // Tight match: name contains hint AND looks account-scoped (has digits or acct id).
    if (lc.includes(hint) && /\d{6,}/.test(lc)) return 0;
    if (lc.includes(hint)) return 1;
    if (lc.includes('log10x') || lc.includes('tenx')) return 2;
    return 99;
  }
  const candidates = allBuckets
    .filter((n) => rank(n) < 99)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  const s3Buckets: S3Bucket[] = candidates.map((n) => ({
    name: n,
    matchReason: 'name_match',
  }));

  // Peek inside the top-ranked candidates for an indexing-results prefix.
  // Limit to the 3 most specific to keep the probe cheap on accounts
  // with many matches.
  for (const bucket of s3Buckets.slice(0, 3)) {
    const list = await runJson<{ Contents?: Array<{ Key: string }> }>(
      'aws',
      [
        's3api',
        'list-objects-v2',
        '--bucket',
        bucket.name,
        '--max-keys',
        '10',
        '--prefix',
        'indexing-results/',
        '--output',
        'json',
      ],
      { timeoutMs: 8_000 }
    );
    record(list.result);
    if ((list.parsed?.Contents?.length ?? 0) > 0) bucket.hasIndexingPrefix = true;
  }

  // Step 5: SQS queues matching the hint.
  const sqsList = await runJson<{ QueueUrls?: string[] }>(
    'aws',
    ['sqs', 'list-queues', '--queue-name-prefix', 'tenx', '--region', region, '--output', 'json'],
    { timeoutMs }
  );
  record(sqsList.result);
  // Fall back to hint if the prefix filter is empty.
  const sqsUrls: string[] = [...(sqsList.parsed?.QueueUrls ?? [])];
  if (sqsUrls.length === 0) {
    const alt = await runJson<{ QueueUrls?: string[] }>(
      'aws',
      ['sqs', 'list-queues', '--queue-name-prefix', hint, '--region', region, '--output', 'json'],
      { timeoutMs }
    );
    record(alt.result);
    sqsUrls.push(...(alt.parsed?.QueueUrls ?? []));
  }
  const sqsQueues: SqsQueue[] = sqsUrls.map((u) => {
    const name = u.split('/').pop() ?? u;
    const lc = name.toLowerCase();
    let role: SqsQueue['role'] = 'unknown';
    if (lc.endsWith('-dlq')) role = 'dlq';
    else if (lc.includes('subquery')) role = 'subquery';
    else if (lc.includes('index')) role = 'index';
    else if (lc.includes('query')) role = 'query';
    else if (lc.includes('stream')) role = 'stream';
    return { url: u, name, role };
  });

  // Step 6: CloudWatch log groups that look retriever-related.
  const cw = await runJson<{ logGroups?: Array<{ logGroupName: string; storedBytes?: number }> }>(
    'aws',
    [
      'logs',
      'describe-log-groups',
      '--log-group-name-prefix',
      '/tenx',
      '--region',
      region,
      '--output',
      'json',
    ],
    { timeoutMs }
  );
  record(cw.result);
  const cwLogGroups: CwLogGroup[] = (cw.parsed?.logGroups ?? []).map((g) => ({
    name: g.logGroupName,
    storedBytes: g.storedBytes,
  }));

  // Step 7: serverless estate — Lambda functions, OTel-extension detection,
  // and subscription-filter coverage of the function log groups.
  let lambda: LambdaProbes | undefined;
  if (opts.includeLambda !== false) {
    lambda = await probeLambdaEstate(region, timeoutMs, record, cwLogGroups);
  }

  return {
    probes: {
      available: true,
      callerIdentity: {
        account: ident.parsed.Account,
        arn: ident.parsed.Arn,
        userId: ident.parsed.UserId,
      },
      region,
      eks,
      s3Buckets,
      sqsQueues,
      cwLogGroups,
      lambda,
    },
    log,
  };
}

/**
 * Enumerate Lambda functions and their OTel wiring, then check the
 * function log groups for existing subscription filters. Read-only, same
 * budget discipline as the rest of the probes. Log groups found here are
 * APPENDED to `cwLogGroups` (with `subscriptionFilters` populated) so the
 * snapshot carries the estate's real groups, not just `/tenx*` ones.
 */
async function probeLambdaEstate(
  region: string,
  timeoutMs: number,
  record: (r: ShellResult) => void,
  cwLogGroups: CwLogGroup[]
): Promise<LambdaProbes> {
  interface RawFn {
    FunctionName: string;
    Runtime?: string;
    MemorySize?: number;
    Architectures?: string[];
    Layers?: Array<{ Arn: string }>;
    Environment?: { Variables?: Record<string, string> };
  }
  const list = await runJson<{ Functions?: RawFn[] }>(
    'aws',
    [
      'lambda',
      'list-functions',
      '--region',
      region,
      '--max-items',
      String(LAMBDA_LIST_CAP),
      '--output',
      'json',
    ],
    { timeoutMs }
  );
  record(list.result);
  if (!list.parsed) {
    return {
      available: false,
      error: list.result.stderr.slice(0, 400) || 'aws lambda list-functions failed',
      functions: [],
      truncated: false,
      functionsWithOtelExtension: 0,
    };
  }

  const raw = list.parsed.Functions ?? [];
  const functions: LambdaFunctionInfo[] = raw.map((f) => {
    const layers = (f.Layers ?? []).map((l) => l.Arn);
    const envVars = f.Environment?.Variables ?? {};
    const otelEnv: Record<string, string> = {};
    for (const k of OTEL_ENV_ALLOWLIST) {
      if (envVars[k] !== undefined) otelEnv[k] = envVars[k];
    }
    const otelLayer = layers.find((a) => OTEL_LAYER_RX.test(a));
    const wrapperIsOtel = /otel/i.test(envVars['AWS_LAMBDA_EXEC_WRAPPER'] ?? '');
    const hasCollectorConfig =
      envVars['OPENTELEMETRY_COLLECTOR_CONFIG_FILE'] !== undefined ||
      envVars['OPENTELEMETRY_COLLECTOR_CONFIG_URI'] !== undefined;
    return {
      name: f.FunctionName,
      runtime: f.Runtime,
      memoryMb: f.MemorySize,
      architectures: f.Architectures ?? ['x86_64'],
      layers,
      envKeys: Object.keys(envVars).sort(),
      otelEnv,
      hasOtelCollectorExtension: Boolean(otelLayer || wrapperIsOtel || hasCollectorConfig),
      otelExtensionLayer: otelLayer,
    };
  });

  // Subscription-filter coverage: check the /aws/lambda/<fn> groups (capped).
  if (functions.length > 0) {
    const lg = await runJson<{ logGroups?: Array<{ logGroupName: string; storedBytes?: number }> }>(
      'aws',
      [
        'logs',
        'describe-log-groups',
        '--log-group-name-prefix',
        '/aws/lambda/',
        '--limit',
        '50',
        '--region',
        region,
        '--output',
        'json',
      ],
      { timeoutMs }
    );
    record(lg.result);
    const groups = lg.parsed?.logGroups ?? [];
    for (const g of groups.slice(0, SUBSCRIPTION_PROBE_CAP)) {
      const sf = await runJson<{
        subscriptionFilters?: Array<{
          filterName: string;
          destinationArn: string;
          filterPattern: string;
        }>;
      }>(
        'aws',
        [
          'logs',
          'describe-subscription-filters',
          '--log-group-name',
          g.logGroupName,
          '--region',
          region,
          '--output',
          'json',
        ],
        { timeoutMs: 8_000 }
      );
      record(sf.result);
      cwLogGroups.push({
        name: g.logGroupName,
        storedBytes: g.storedBytes,
        subscriptionFilters: (sf.parsed?.subscriptionFilters ?? []).map((s) => ({
          name: s.filterName,
          destinationArn: s.destinationArn,
          filterPattern: s.filterPattern,
        })),
      });
    }
  }

  return {
    available: true,
    functions,
    truncated: raw.length >= LAMBDA_LIST_CAP,
    functionsWithOtelExtension: functions.filter((f) => f.hasOtelCollectorExtension).length,
  };
}
