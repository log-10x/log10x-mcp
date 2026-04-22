/**
 * log10x_advise_streamer
 *
 * Given a DiscoverySnapshot (from `log10x_discover_env`), produce an
 * install/verify/teardown plan for the Log10x Streamer. Unlike
 * Reporter + Regulator, the Streamer has no forwarder choice — just
 * AWS infra pointers (S3 buckets, SQS queues, IRSA role).
 */

import { z } from 'zod';
import { getSnapshot } from '../lib/discovery/snapshot-store.js';
import { buildStreamerPlan } from '../lib/advisor/streamer.js';
import { renderPlan } from '../lib/advisor/render.js';

export const adviseStreamerSchema = {
  snapshot_id: z
    .string()
    .describe('ID returned by `log10x_discover_env`. The snapshot is cached for 30 min.'),
  release_name: z.string().optional().describe('Helm release name. Default: `my-streamer`.'),
  namespace: z.string().optional().describe('Target namespace. Default: snapshot.recommendations.suggestedNamespace.'),
  api_key: z.string().optional().describe('Log10x license key.'),
  input_bucket: z
    .string()
    .optional()
    .describe(
      'S3 bucket for source logs. Default: snapshot.recommendations.streamerS3Bucket (auto-detected).'
    ),
  index_bucket: z
    .string()
    .optional()
    .describe(
      'S3 path for indexed results (include prefix). Default: `<input_bucket>/indexing-results/`.'
    ),
  irsa_role_arn: z
    .string()
    .optional()
    .describe(
      'IAM role ARN for the Streamer ServiceAccount (IRSA). Default: auto-detected from snapshot.'
    ),
  sqs_index_url: z
    .string()
    .optional()
    .describe('SQS URL for index operations. Default: auto-detected from snapshot.'),
  sqs_query_url: z
    .string()
    .optional()
    .describe('SQS URL for query operations. Default: auto-detected from snapshot.'),
  sqs_subquery_url: z
    .string()
    .optional()
    .describe('SQS URL for sub-query operations. Default: auto-detected from snapshot.'),
  sqs_stream_url: z
    .string()
    .optional()
    .describe('SQS URL for stream operations. Default: auto-detected from snapshot.'),
  action: z.enum(['install', 'verify', 'teardown', 'all']).optional().describe('Default: `all`.'),
};

const schemaObj = z.object(adviseStreamerSchema);
export type AdviseStreamerArgs = z.infer<typeof schemaObj>;

export async function executeAdviseStreamer(args: AdviseStreamerArgs): Promise<string> {
  const snapshot = getSnapshot(args.snapshot_id);
  if (!snapshot) {
    return [
      `# Streamer advisor — snapshot not found`,
      ``,
      `Snapshot \`${args.snapshot_id}\` is missing or expired (snapshots live 30 min).`,
      ``,
      `Run \`log10x_discover_env\` again and pass the new snapshot_id.`,
    ].join('\n');
  }

  const action = args.action ?? 'all';
  const plan = await buildStreamerPlan({
    snapshot,
    releaseName: args.release_name,
    namespace: args.namespace,
    apiKey: args.api_key,
    inputBucket: args.input_bucket,
    indexBucket: args.index_bucket,
    irsaRoleArn: args.irsa_role_arn,
    sqsUrls: {
      index: args.sqs_index_url,
      query: args.sqs_query_url,
      subquery: args.sqs_subquery_url,
      stream: args.sqs_stream_url,
    },
    skipInstall: action === 'verify' || action === 'teardown',
    skipVerify: action === 'install' || action === 'teardown',
    skipTeardown: action === 'install' || action === 'verify',
  });

  return renderPlan(plan, action);
}
