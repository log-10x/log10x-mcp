/**
 * log10x_advise_retriever
 *
 * Given a DiscoverySnapshot (from `log10x_discover_env`), produce an
 * install/verify/teardown plan for the Log10x Retriever. Unlike
 * Reporter + Receiver, the Retriever has no forwarder choice — just
 * AWS infra pointers (S3 buckets, SQS queues, IRSA role).
 */

import { z } from 'zod';
import { getSnapshot } from '../lib/discovery/snapshot-store.js';
import { buildRetrieverPlan } from '../lib/advisor/retriever.js';
import { buildAdvisePlanEnvelope } from '../lib/advisor/envelope.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';

export const adviseRetrieverSchema = {
  snapshot_id: z
    .string()
    .describe('ID returned by `log10x_discover_env`. The snapshot is cached for 30 min.'),
  release_name: z.string().optional().describe('Helm release name. Default: `my-retriever`.'),
  namespace: z.string().optional().describe('Target namespace. Default: snapshot.recommendations.suggestedNamespace.'),
  license_jwt: z.string().optional().describe('Log10x license JWT — mints from `POST /api/v1/license/demo` (anonymous) or `POST /api/v1/license` (Auth0-authed).'),
  input_bucket: z
    .string()
    .optional()
    .describe(
      'S3 bucket for source logs. Default: snapshot.recommendations.retrieverS3Bucket (auto-detected).'
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
      'IAM role ARN for the Retriever ServiceAccount (IRSA). Default: auto-detected from snapshot.'
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
  destination: z
    .string()
    .optional()
    .describe(
      'Destination SIEM the kept slice routes to (e.g. `datadog`, `cloudwatch`, `splunk`, `elasticsearch_self`, `clickhouse`, `sumo`). Gates which down-tier sub-section renders in the offload markdown per `DEFAULT_ACTION_BY_DESTINATION` (Datadog Flex only for `datadog`, CloudWatch IA only for `cloudwatch`). When omitted, both leads are shown.'
    ),
};

const schemaObj = z.object(adviseRetrieverSchema);
export type AdviseRetrieverArgs = z.infer<typeof schemaObj>;

export async function executeAdviseRetriever(args: AdviseRetrieverArgs): Promise<StructuredOutput> {
  const snapshot = getSnapshot(args.snapshot_id);
  if (!snapshot) {
    const human_summary = `Retriever advisor refused: snapshot ${args.snapshot_id} is missing or expired (snapshots live 30 minutes). Run log10x_discover_env again and pass the new snapshot_id.`;
    return buildEnvelope({
      tool: 'log10x_advise_retriever',
      view: 'summary',
      summary: { headline: `Retriever advisor refused: snapshot ${args.snapshot_id} not found.` },
      data: {
        ok: false,
        app: 'retriever',
        snapshot_id: args.snapshot_id,
        error: 'snapshot not found',
        human_summary,
      },
    });
  }

  const action = args.action ?? 'all';
  const plan = await buildRetrieverPlan({
    snapshot,
    releaseName: args.release_name,
    namespace: args.namespace,
    licenseJwt: args.license_jwt,
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
    destination: args.destination,
  });

  return buildAdvisePlanEnvelope({ tool: 'log10x_advise_retriever', plan, action });
}
