/**
 * log10x_siem_connector — emit the SIEM <- S3 connector config (Datadog
 * Forwarder Lambda / Splunk Add-on SQS-based S3 input) for a log10x offload
 * bucket. The destination/ingest side of the offload story: log10x lands NDJSON
 * in the customer's bucket; this tells the customer exactly how to make their
 * SIEM pull it. See src/lib/siem-s3-connector.ts for the verified contracts.
 */

import { z } from 'zod';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import {
  siemS3ConnectorRecipe,
  type SiemTarget,
  type SiemConnectorRecipe,
} from '../lib/siem-s3-connector.js';

export const siemConnectorSchema = {
  siem: z
    .enum(['datadog', 'splunk', 'both'])
    .describe('Which SIEM should pull the offload: datadog (Forwarder Lambda), splunk (Add-on SQS-based S3 input), or both.'),
  bucket: z.string().min(1).describe('The offload bucket the SIEM should read (where 10x writes the NDJSON).'),
  region: z.string().default('us-east-1').describe('AWS region of the bucket.'),
  account_id: z.string().min(1).describe('AWS account ID that owns the bucket (same account the SIEM connector runs in).'),
  prefix: z.string().optional().describe('Offload key prefix the SIEM should watch. Default "app/".'),
  datadog_forwarder_arn: z
    .string()
    .optional()
    .describe('ARN of an already-deployed Datadog Forwarder Lambda (datadog only). Omit to leave a placeholder.'),
  sqs_queue_name: z.string().optional().describe('Name for the SQS queue the Splunk input drains (splunk only).'),
  sourcetype: z.string().optional().describe('Splunk sourcetype for the input. Default "log10x:offload".'),
  index: z.string().optional().describe('Splunk index for the input. Default "main".'),
};

export interface SiemConnectorArgs {
  siem: 'datadog' | 'splunk' | 'both';
  bucket: string;
  region?: string;
  account_id: string;
  prefix?: string;
  datadog_forwarder_arn?: string;
  sqs_queue_name?: string;
  sourcetype?: string;
  index?: string;
}

function humanSummary(recipes: SiemConnectorRecipe[], bucket: string): string {
  const lines = [
    `10x never pushes to a SIEM — it lands NDJSON in s3://${bucket}/ and the SIEM PULLS it. Apply the connector below in your own account.`,
  ];
  for (const r of recipes) {
    lines.push('');
    lines.push(`## ${r.target.toUpperCase()} — ${r.summary}`);
    lines.push(`Discovery: ${r.discovery}`);
    lines.push('Steps:');
    r.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
    lines.push(`⚠ Notification fan-out: ${r.notificationNote}`);
    lines.push('Caveats:');
    r.caveats.forEach((c) => lines.push(`  - ${c}`));
  }
  return lines.join('\n');
}

export async function executeSiemConnector(args: SiemConnectorArgs): Promise<string | StructuredOutput> {
  const targets: SiemTarget[] = args.siem === 'both' ? ['datadog', 'splunk'] : [args.siem];
  const recipes = targets.map((t) =>
    siemS3ConnectorRecipe(t, {
      bucket: args.bucket,
      region: args.region ?? 'us-east-1',
      accountId: args.account_id,
      prefix: args.prefix,
      datadogForwarderArn: args.datadog_forwarder_arn,
      sqsQueueName: args.sqs_queue_name,
      sourcetype: args.sourcetype,
      splunkIndex: args.index,
    }),
  );

  return buildEnvelope({
    tool: 'log10x_siem_connector',
    view: 'summary',
    summary: {
      headline: `${targets.map((t) => t.toUpperCase()).join(' + ')} connector for s3://${args.bucket}/${(args.prefix ?? 'app/').replace(/^\/+/, '')} — config + IAM + caveats (customer applies; 10x does not push).`,
    },
    data: {
      bucket: args.bucket,
      region: args.region ?? 'us-east-1',
      targets,
      recipes,
      human_summary: humanSummary(recipes, args.bucket),
    },
  });
}
