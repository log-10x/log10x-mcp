/**
 * SIEM ← S3 connector recipes: how the customer wires Datadog or Splunk to
 * PULL log10x's offload output from their own S3 bucket.
 *
 * This is the destination/ingest side, the mirror of offload-recipes.ts (which
 * generates the forwarder->S3 side). log10x deliberately never pushes to a SIEM
 * — it lands data in the customer's bucket and the SIEM pulls — so "ship my
 * offload to Datadog/Splunk" is a customer-applied connector, not a vendor
 * re-ingest (which would collide with Datadog Rehydration billing, Splunk HEC
 * permissions, Elastic _bulk limits).
 *
 * Contracts are primary-source-verified (Datadog Forwarder Lambda; Splunk
 * Add-on for AWS, SQS-based S3 input) and matched to log10x's actual offload
 * output: uncompressed NDJSON (one event/line), Hive-partitioned keys
 * (<prefix>dt=YYYYMMDD/hr=HH/node/file.txt), same-account customer bucket.
 *
 * KEY GOTCHA baked into every recipe: the offload bucket usually ALREADY has an
 * S3 ObjectCreated notification (the 10x indexer's SQS). S3 allows only ONE
 * notification config per overlapping prefix+suffix, so a second consumer must
 * be fanned out via SNS or EventBridge — never a second raw bucket notification.
 */

export type SiemTarget = 'datadog' | 'splunk';

export interface SiemConnectorParams {
  /** The offload bucket the SIEM should read. */
  bucket: string;
  region: string;
  accountId: string;
  /** Offload prefix (where the NDJSON lands). Default "app/". */
  prefix?: string;
  /** Existing Datadog Forwarder Lambda ARN, if one is already deployed. */
  datadogForwarderArn?: string;
  /** Name for the SQS queue the Splunk input drains. Default derived. */
  sqsQueueName?: string;
  /** Splunk sourcetype / index for the input. */
  sourcetype?: string;
  splunkIndex?: string;
}

export interface SiemConnectorBlock {
  title: string;
  language: 'terraform' | 'ini' | 'json' | 'bash';
  body: string;
}

export interface SiemConnectorRecipe {
  target: SiemTarget;
  summary: string;
  /** How the SIEM discovers new objects (the design fact that drives setup). */
  discovery: string;
  /** Ordered, human-readable setup steps. */
  steps: string[];
  /** Paste-ready config / infra blocks. */
  blocks: SiemConnectorBlock[];
  /** The single biggest footgun for this offload bucket. */
  notificationNote: string;
  /** Verified, honest caveats — what this path does NOT do. */
  caveats: string[];
}

function normPrefix(p?: string): string {
  const v = (p ?? 'app/').replace(/^\/+/, '');
  return v.endsWith('/') ? v : `${v}/`;
}

function arn(region: string, accountId: string, bucket: string): string {
  return `arn:aws:s3:::${bucket}`;
}

/** Datadog Forwarder Lambda — event-driven, logs only, NDJSON drop-in. */
function datadogRecipe(p: SiemConnectorParams): SiemConnectorRecipe {
  const prefix = normPrefix(p.prefix);
  const fwd = p.datadogForwarderArn || '<DATADOG_FORWARDER_LAMBDA_ARN>';
  const topic = `tenx-offload-fanout`;

  return {
    target: 'datadog',
    summary: `Datadog Forwarder Lambda pulls NDJSON from s3://${p.bucket}/${prefix} — event-driven, logs only.`,
    discovery:
      'Event-driven: an S3 ObjectCreated event invokes the Datadog Forwarder Lambda, which GETs the object and ships each line as a log. The Forwarder never polls or lists the bucket.',
    steps: [
      'Deploy (or reuse) the Datadog Forwarder Lambda in THIS account+region — cross-account/region auto-subscription is not supported. (Datadog CloudFormation stack `datadog-forwarder`.)',
      `Fan out the bucket's ObjectCreated event to the Forwarder via SNS (see notificationNote) — do NOT add a second raw bucket notification.`,
      `Grant the Forwarder's execution role s3:GetObject on s3://${p.bucket}/${prefix}* (add the bucket to the Forwarder's DdFetchLambdaTags / S3 read policy).`,
      'Allow S3/SNS to invoke the Forwarder (lambda permission).',
      'Optional: tag the objects (or set DD_SOURCE/DD_SERVICE) so Datadog pipelines parse the NDJSON `log` field and attribute source/service.',
    ],
    blocks: [
      {
        title: 'SNS fan-out + Forwarder subscription + invoke permission (terraform)',
        language: 'terraform',
        body: `# One SNS topic carries the bucket's ObjectCreated events to BOTH the
# 10x indexer SQS and the Datadog Forwarder (S3 -> SNS -> {SQS, Lambda}).
resource "aws_sns_topic" "tenx_offload_fanout" { name = "${topic}" }

resource "aws_s3_bucket_notification" "offload_to_sns" {
  bucket = "${p.bucket}"
  topic {
    topic_arn     = aws_sns_topic.tenx_offload_fanout.arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = "${prefix}"
  }
}

resource "aws_sns_topic_subscription" "to_datadog_forwarder" {
  topic_arn = aws_sns_topic.tenx_offload_fanout.arn
  protocol  = "lambda"
  endpoint  = "${fwd}"
}

resource "aws_lambda_permission" "sns_invoke_forwarder" {
  statement_id  = "AllowSNSInvokeDatadogForwarder"
  action        = "lambda:InvokeFunction"
  function_name = "${fwd}"
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.tenx_offload_fanout.arn
}`,
      },
      {
        title: 'Forwarder S3 read policy (attach to the Forwarder role)',
        language: 'json',
        body: JSON.stringify(
          {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'ReadTenxOffload',
                Effect: 'Allow',
                Action: ['s3:GetObject'],
                Resource: [`${arn(p.region, p.accountId, p.bucket)}/${prefix}*`],
              },
            ],
          },
          null,
          2,
        ),
      },
    ],
    notificationNote:
      `The offload bucket almost certainly already has an ObjectCreated->SQS notification (the 10x indexer). S3 permits only one notification config per overlapping prefix/suffix, so you CANNOT add a second bucket notification for the Forwarder. Route ObjectCreated to an SNS topic (or EventBridge) once, then subscribe BOTH the existing indexer SQS and the Datadog Forwarder Lambda to it. The terraform above replaces the bucket's notification with the SNS fan-out — re-subscribe the indexer SQS to the same topic.`,
    caveats: [
      'Logs only: the Datadog Forwarder derives NO metrics from S3 data. For per-pattern metrics use log10x_backfill_metric (S3 cohort -> Datadog metrics API).',
      'Our output is uncompressed NDJSON (one JSON object per line) — a drop-in: the Forwarder ships each line as one log event. (A single JSON array would become one event; NDJSON avoids that.)',
      'Same-account only for the auto-trigger — the Forwarder must live in the bucket account+region (it does here).',
    ],
  };
}

/** Splunk Add-on for AWS — SQS-based S3 input (the recommended-at-scale mode). */
function splunkRecipe(p: SiemConnectorParams): SiemConnectorRecipe {
  const prefix = normPrefix(p.prefix);
  const queue = p.sqsQueueName || `tenx-offload-splunk`;
  const sourcetype = p.sourcetype || 'log10x:offload';
  const index = p.splunkIndex || 'main';
  const topic = `tenx-offload-fanout`;

  return {
    target: 'splunk',
    summary: `Splunk Add-on for AWS, SQS-based S3 input pulls NDJSON from s3://${p.bucket}/${prefix} via a dedicated SQS queue.`,
    discovery:
      'SQS-notification-driven: S3 ObjectCreated -> SQS; the Splunk Add-on polls the SQS queue and GETs each referenced object. Only objects created AFTER the notification is wired are collected.',
    steps: [
      `Create an SQS queue (+ DLQ) for the Splunk input: "${queue}".`,
      `Fan out the bucket's ObjectCreated event to that queue via SNS (see notificationNote).`,
      'Grant the queue policy to accept the S3/SNS notifications.',
      'Grant the Splunk Add-on IAM role: the SQS actions + s3:GetObject(+Version) + kms:Decrypt (policy below).',
      `In the Splunk Add-on for AWS, create an "SQS-based S3" input pointing at "${queue}" with sourcetype="${sourcetype}", index="${index}".`,
    ],
    blocks: [
      {
        title: 'SQS queue + S3->SNS->SQS fan-out (terraform)',
        language: 'terraform',
        body: `resource "aws_sqs_queue" "tenx_offload_splunk_dlq" { name = "${queue}-dlq" }

resource "aws_sqs_queue" "tenx_offload_splunk" {
  name = "${queue}"
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.tenx_offload_splunk_dlq.arn, maxReceiveCount = 5
  })
}

resource "aws_sns_topic" "tenx_offload_fanout" { name = "${topic}" }

resource "aws_s3_bucket_notification" "offload_to_sns" {
  bucket = "${p.bucket}"
  topic { topic_arn = aws_sns_topic.tenx_offload_fanout.arn, events = ["s3:ObjectCreated:*"], filter_prefix = "${prefix}" }
}

resource "aws_sns_topic_subscription" "to_splunk_sqs" {
  topic_arn = aws_sns_topic.tenx_offload_fanout.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.tenx_offload_splunk.arn
}

resource "aws_sqs_queue_policy" "allow_sns" {
  queue_url = aws_sqs_queue.tenx_offload_splunk.id
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Effect = "Allow", Principal = { Service = "sns.amazonaws.com" },
      Action = "sqs:SendMessage", Resource = aws_sqs_queue.tenx_offload_splunk.arn,
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.tenx_offload_fanout.arn } }
    }]
  })
}`,
      },
      {
        title: 'Splunk Add-on IAM policy (attach to the add-on role)',
        language: 'json',
        body: JSON.stringify(
          {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'SplunkSqsBasedS3',
                Effect: 'Allow',
                Action: [
                  'sqs:GetQueueUrl',
                  'sqs:ReceiveMessage',
                  'sqs:SendMessage',
                  'sqs:DeleteMessage',
                  'sqs:ChangeMessageVisibility',
                  'sqs:GetQueueAttributes',
                  'sqs:ListQueues',
                  's3:GetObject',
                  's3:GetObjectVersion',
                  's3:ListBucket',
                  'kms:Decrypt',
                ],
                Resource: '*',
              },
            ],
          },
          null,
          2,
        ),
      },
      {
        title: 'Splunk Add-on input (inputs.conf)',
        language: 'ini',
        body: `[aws_sqs_based_s3://tenx-offload]
aws_account = <splunk_addon_aws_account>
sqs_queue_url = https://sqs.${p.region}.amazonaws.com/${p.accountId}/${queue}
sqs_queue_region = ${p.region}
s3_file_decoder = CustomLogs
sourcetype = ${sourcetype}
index = ${index}
interval = 30`,
      },
    ],
    notificationNote:
      `The offload bucket almost certainly already notifies the 10x indexer SQS on ObjectCreated. S3 allows only one notification config per overlapping prefix, so route ObjectCreated to ONE SNS topic and subscribe BOTH the existing indexer SQS and this new Splunk SQS. The terraform above sets up that fan-out; re-subscribe the indexer SQS to the same topic.`,
    caveats: [
      'Pre-existing objects are NOT collected — the SQS-based input only sees objects created after the notification is wired. Backfill older data with a one-shot Generic S3 input over the same prefix.',
      'Throughput: the add-on is happiest at ~4 SQS-based inputs per forwarder; scale inputs, not a single input.',
      'NDJSON: set s3_file_decoder/sourcetype so Splunk treats each line as a JSON event (one event per line), matching our output.',
    ],
  };
}

export function siemS3ConnectorRecipe(target: SiemTarget, p: SiemConnectorParams): SiemConnectorRecipe {
  return target === 'datadog' ? datadogRecipe(p) : splunkRecipe(p);
}
