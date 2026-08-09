/**
 * CDK output for the serverless (Lambda + OTel extension) estate.
 *
 * Emits a single self-contained TypeScript construct file the customer
 * drops into their own CDK repository — reviewable, forkable, owned by
 * them. Nothing here executes CDK; this module is a code EMITTER, the
 * same shape as `forwarderWriteTerraform()` on the Terraform side. The
 * Terraform path stays; this adds the CDK one.
 *
 * Three concerns, one construct file:
 *   1. The engine in the execution environment — a LayerVersion reference
 *      plus a per-function attach helper (layer + env vars).
 *   2. The Coralogix TCO policy — a Lambda-backed custom resource doing
 *      READ-MODIFY-WRITE against the real (recovered-from-the-wire) API:
 *      `PUT https://api.<region>.coralogix.com/mgmt/openapi/5/dataplans/log-policies/v1`
 *      on the REGIONAL host, which is an ATOMIC WHOLE-LIST OVERWRITE. A
 *      blind PUT clobbers policies the customer created by hand, so the
 *      resource merges by policy name. See `coralogixTcoApiContract()`.
 *   3. The CloudWatch remainder — SubscriptionFilter per named log group
 *      targeting the receive-role Lambda, plus an EventBridge rule on
 *      `CreateLogGroup` driving a small subscriber function so NEW log
 *      groups are covered by rule, not by remembering.
 */

export interface LambdaEstateCdkParams {
  /** AWS region of the estate (used in comments/defaults only). */
  region: string;
  /** Coralogix regional API host segment, e.g. `us2` -> api.us2.coralogix.com. */
  coralogixRegion?: string;
  /** ARN of the engine extension layer once published. Placeholder until then. */
  engineLayerArn?: string;
  /** Log-group name prefix that the auto-subscription rule covers. */
  logGroupPrefix?: string;
  /** subsystem/routeState value the TCO policy tiers down. Default `tier_down`. */
  tierDownRoute?: string;
}

export interface CdkRecipe {
  language: 'typescript';
  /** The construct file, ready to drop into the customer's CDK repo. */
  body: string;
  note: string;
  prerequisites: string[];
}

export function lambdaEstateCdkConstruct(p: LambdaEstateCdkParams): CdkRecipe {
  const cxRegion = p.coralogixRegion ?? '<cx-region e.g. us2>';
  const layerArn = p.engineLayerArn ?? 'arn:aws:lambda:REGION:ACCOUNT:layer:tenx-receive:VERSION';
  const lgPrefix = p.logGroupPrefix ?? '/aws/lambda/';
  const route = p.tierDownRoute ?? 'tier_down';

  const body = `// tenx-serverless.ts — Log10x support for a Lambda + OTel-extension estate.
// Owned by YOUR repo: review it, fork it, pin it. Generated as a starting
// point by log10x-mcp; nothing phones home and nothing here is managed
// remotely.

import { Construct } from 'constructs';
import {
  Duration,
  CustomResource,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_logs_destinations as destinations,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  custom_resources as cr,
} from 'aws-cdk-lib';

export interface TenxServerlessProps {
  /**
   * The engine extension layer. Published per region + architecture.
   * NOT YET PUBLISHED at generation time — replace with the real ARN when
   * the layer ships (tracked in the log10x serverless build).
   */
  engineLayerArn?: string;
  /**
   * Full (non-demo, non-limited) license. The engine validates it OFFLINE
   * (ES256, embedded public keys) when TENX_AIRGAPPED=true, which this
   * construct always sets: a Lambda estate must not carry a boot-time
   * dependency on an external licensing endpoint.
   */
  licenseSsmParameterName?: string;
  /** The receive-role Lambda for the CloudWatch remainder (optional). */
  cloudwatchReceiver?: lambda.IFunction;
  /** Named log groups to subscribe to the receiver now. */
  subscribeLogGroups?: string[];
  /** Prefix new log groups must match for auto-subscription. */
  autoSubscribePrefix?: string;
}

export class TenxServerless extends Construct {
  readonly engineLayer?: lambda.ILayerVersion;

  constructor(scope: Construct, id: string, props: TenxServerlessProps = {}) {
    super(scope, id);

    if (props.engineLayerArn) {
      this.engineLayer = lambda.LayerVersion.fromLayerVersionArn(
        this, 'TenxEngineLayer', props.engineLayerArn);
    }

    // ── CloudWatch remainder: explicit subscriptions ──────────────────────
    if (props.cloudwatchReceiver && props.subscribeLogGroups) {
      for (const [i, name] of props.subscribeLogGroups.entries()) {
        new logs.SubscriptionFilter(this, 'TenxSub' + i, {
          logGroup: logs.LogGroup.fromLogGroupName(this, 'TenxSubLg' + i, name),
          destination: new destinations.LambdaDestination(props.cloudwatchReceiver),
          filterPattern: logs.FilterPattern.allEvents(),
        });
      }
    }

    // ── CloudWatch remainder: NEW log groups covered by rule ──────────────
    // CreateLogGroup (via CloudTrail) -> subscriber function -> PutSubscriptionFilter.
    // New groups are covered because a rule fires, not because someone remembers.
    if (props.cloudwatchReceiver) {
      const prefix = props.autoSubscribePrefix ?? '${lgPrefix}';
      const subscriber = new lambda.Function(this, 'TenxAutoSubscriber', {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        timeout: Duration.seconds(30),
        environment: {
          RECEIVER_ARN: props.cloudwatchReceiver.functionArn,
          GROUP_PREFIX: prefix,
        },
        code: lambda.Code.fromInline(
          'const { CloudWatchLogsClient, PutSubscriptionFilterCommand } = require("@aws-sdk/client-cloudwatch-logs");' +
          'exports.handler = async (event) => {' +
          '  const name = event?.detail?.requestParameters?.logGroupName;' +
          '  if (!name || !name.startsWith(process.env.GROUP_PREFIX)) return;' +
          '  const client = new CloudWatchLogsClient({});' +
          '  await client.send(new PutSubscriptionFilterCommand({' +
          '    logGroupName: name,' +
          '    filterName: "tenx-receive",' +
          '    filterPattern: "",' +
          '    destinationArn: process.env.RECEIVER_ARN,' +
          '  }));' +
          '};'
        ),
      });
      subscriber.addToRolePolicy(new iam.PolicyStatement({
        actions: ['logs:PutSubscriptionFilter'],
        resources: ['*'],
      }));
      props.cloudwatchReceiver.addPermission('TenxCwInvoke', {
        principal: new iam.ServicePrincipal('logs.amazonaws.com'),
      });
      new events.Rule(this, 'TenxNewLogGroupRule', {
        eventPattern: {
          source: ['aws.logs'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: { eventSource: ['logs.amazonaws.com'], eventName: ['CreateLogGroup'] },
        },
        targets: [new targets.LambdaFunction(subscriber)],
      });
    }
  }

  /**
   * Wire one function into the engine extension: attach the layer and the
   * engine environment. Call per function (or via an Aspect over the app).
   */
  attach(fn: lambda.Function): void {
    if (this.engineLayer) fn.addLayers(this.engineLayer);
    fn.addEnvironment('outputOffload', 'true');
    fn.addEnvironment('symbolMessageHashField', 'tenx_hash');
    fn.addEnvironment('log10xMetricsEnabled', 'false');
    fn.addEnvironment('TENX_AIRGAPPED', 'true');
    fn.addEnvironment('TENX_LICENSE_FILE', '/opt/tenx/license.jwt');
  }
}

export interface CoralogixTcoPoliciesProps {
  /** Regional API host segment: api.<region>.coralogix.com. */
  coralogixRegion: string;
  /** Secret ARN/name holding a user key with LOGS.TCO:UPDATEPOLICIES. */
  apiKeySecretName: string;
}

/**
 * Read-modify-write manager for ONE Log10x TCO policy entry.
 *
 * THE TRAP THIS EXISTS FOR: the write endpoint is
 *   PUT https://api.<region>.coralogix.com/mgmt/openapi/5/dataplans/log-policies/v1
 * on the REGIONAL host, and it replaces the ENTIRE ordered policy list in
 * one shot. There is no create-one API worth using (the documented POST is
 * wrong in five reproducible ways — see coralogixTcoApiContract() in
 * log10x-mcp). A naive AwsCustomResource doing a blind PUT would silently
 * delete every policy the customer's team created by hand.
 *
 * So the handler: GETs the current list, upserts the entry matching OUR
 * policy name, and PUTs the merged list back. Ownership boundary: this
 * resource owns exactly one entry, identified by name
 * ("10x ${route} -> Monitoring"); everything else round-trips untouched.
 * Policy changes take ~6 minutes to take effect (measured live) — do not
 * treat an immediate non-effect as failure.
 */
export class CoralogixTcoPolicies extends Construct {
  constructor(scope: Construct, id: string, props: CoralogixTcoPoliciesProps) {
    super(scope, id);

    const handler = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.minutes(2),
      environment: {
        CX_HOST: 'api.' + props.coralogixRegion + '.coralogix.com',
        CX_SECRET: props.apiKeySecretName,
        POLICY_NAME: '10x ${route} -> Monitoring',
        ROUTE: '${route}',
      },
      code: lambda.Code.fromInline(
        'const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");' +
        'const BASE = "https://" + process.env.CX_HOST + "/mgmt/openapi";' +
        'async function key() {' +
        '  const c = new SecretsManagerClient({});' +
        '  const r = await c.send(new GetSecretValueCommand({ SecretId: process.env.CX_SECRET }));' +
        '  return r.SecretString;' +
        '}' +
        'async function cx(method, path, bearer, body) {' +
        '  const res = await fetch(BASE + path, { method, headers: {' +
        '    Authorization: "Bearer " + bearer, "Content-Type": "application/json" },' +
        '    body: body ? JSON.stringify(body) : undefined });' +
        '  const text = await res.text();' +
        '  if (!res.ok) throw new Error(method + " " + path + " -> HTTP " + res.status + ": " + text.slice(0, 400));' +
        '  return text ? JSON.parse(text) : {};' +
        '}' +
        'exports.handler = async (event) => {' +
        '  const bearer = await key();' +
        '  const current = await cx("GET", "/5/dataplans/policies/v1?source_type=SOURCE_TYPE_LOGS", bearer);' +
        '  const list = (current.policies || []).filter(p => (p.policy || p).sourceType !== "SOURCE_TYPE_SPANS");' +
        '  const mine = { policy: { name: process.env.POLICY_NAME, priority: "PRIORITY_TYPE_MEDIUM", disabled: false,' +
        '    dpxlExpression: "<v1> $d.routeState == \\'" + process.env.ROUTE + "\\'" } };' +
        '  const others = list.filter(p => (p.policy || p).name !== process.env.POLICY_NAME);' +
        '  const merged = event.RequestType === "Delete" ? others : [mine, ...others];' +
        '  await cx("PUT", "/5/dataplans/log-policies/v1", bearer, { policies: merged });' +
        '  return { PhysicalResourceId: process.env.POLICY_NAME };' +
        '};'
      ),
    });
    handler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: ['*'],   // scope to the specific secret ARN in your repo
    }));

    const provider = new cr.Provider(this, 'Provider', { onEventHandler: handler });
    new CustomResource(this, 'Policy', { serviceToken: provider.serviceToken });
  }
}
`;

  return {
    language: 'typescript',
    body,
    note:
      'Drop the file into the customer-owned CDK repo. TenxServerless.attach(fn) wires each ' +
      'function (layer + env); CoralogixTcoPolicies manages exactly one policy entry by name ' +
      `via read-modify-write on the regional host (api.${cxRegion}.coralogix.com) — never a ` +
      'blind PUT, because the endpoint is an atomic whole-list overwrite. The CloudWatch ' +
      `remainder subscribes named groups now and covers new \`${lgPrefix}*\` groups via a ` +
      'CreateLogGroup rule. The Terraform path (coralogixMonitoringRecipe) remains available.',
    prerequisites: [
      `Engine extension layer is NOT published yet — the construct references ${layerArn} as a placeholder; do not deploy before the layer ships and the placement is confirmed on a real function.`,
      'CreateLogGroup only reaches EventBridge when a CloudTrail trail records management events in the region — most accounts have this; verify before relying on auto-subscription.',
      'The Coralogix upsert merges the 10x entry FIRST in the list (first match wins); reorder in the handler if the customer needs their own catch-alls evaluated first.',
      'The Coralogix API key needs LOGS.TCO:UPDATEPOLICIES and lives in Secrets Manager, never in code.',
      'The read endpoint returns both logs and spans policies; the handler filters to logs before the overwrite PUT (spans policies live on a different endpoint and must not be fed back into the logs list).',
      'This is generated STARTING-POINT code: review IAM scoping (the two `resources: [\'*\']` statements) before use.',
    ],
  };
}
