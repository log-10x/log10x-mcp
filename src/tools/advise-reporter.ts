/**
 * log10x_advise_reporter
 *
 * Given a DiscoverySnapshot (from `log10x_discover_env`) + a few user
 * choices, produce a forwarder-specific install/verify/teardown plan
 * rendered as markdown. No writes, no kubectl mutation — the plan is
 * a checklist the user (or a subagent) executes themselves.
 */

import { z } from 'zod';
import { getSnapshot } from '../lib/discovery/snapshot-store.js';
import { buildReporterPlan } from '../lib/advisor/reporter.js';
import { renderPlan } from '../lib/advisor/render.js';
import type { ForwarderKind } from '../lib/discovery/types.js';
import type { OutputDestination } from '../lib/advisor/reporter-forwarders.js';
import { resolveAdvisorDestination } from '../lib/advisor/dest-resolve.js';

export const adviseReporterSchema = {
  snapshot_id: z
    .string()
    .describe('ID returned by `log10x_discover_env`. The snapshot is cached for 30 min.'),
  forwarder: z
    .enum(['fluentbit', 'fluentd', 'filebeat', 'logstash', 'otel-collector', 'vector'])
    .optional()
    .describe(
      'Existing forwarder kind, kept in the plan as detected context only — Reporter is a standalone dedicated fluent-bit DaemonSet that runs alongside any forwarder (or none). If omitted, uses the forwarder detected in the snapshot.'
    ),
  release_name: z
    .string()
    .optional()
    .describe('Helm release name. Default: `my-reporter`. Must not collide with an existing release.'),
  namespace: z
    .string()
    .optional()
    .describe(
      'Target namespace. Default: snapshot.recommendations.suggestedNamespace (usually `logging` or an existing forwarder namespace).'
    ),
  license_jwt: z
    .string()
    .optional()
    .describe('Log10x license JWT — mints from `POST /api/v1/license/demo` (anonymous) or `POST /api/v1/license` (Auth0-authed). Maps to the chart\'s `log10xLicenseJwt` value. Required for a complete install plan; verify/teardown plans work without it.'),
  destination: z
    .enum(['mock', 'elasticsearch', 'splunk', 'datadog', 'cloudwatch'])
    .optional()
    .describe(
      'Output destination for forwarded events. When omitted: auto-detects from ambient SIEM credentials (DD_API_KEY → datadog, SPLUNK_HOST+SPLUNK_TOKEN → splunk, ELASTIC_URL → elasticsearch, AWS chain → cloudwatch); single match is used; multiple → ambiguous error; none → falls back to `mock` (writes to pod stdout — ideal for smoke tests + dogfooding).'
    ),
  output_host: z
    .string()
    .optional()
    .describe('Host for non-mock destinations (ES endpoint, Splunk HEC host, etc.). Ignored when destination=mock.'),
  splunk_hec_token: z.string().optional().describe('Required when destination=splunk.'),
  action: z
    .enum(['install', 'verify', 'teardown', 'all'])
    .optional()
    .describe('Which sections to emit. Default: `all`.'),
};

const schemaObj = z.object(adviseReporterSchema);
export type AdviseReporterArgs = z.infer<typeof schemaObj>;

export async function executeAdviseReporter(args: AdviseReporterArgs): Promise<string> {
  const snapshot = getSnapshot(args.snapshot_id);
  if (!snapshot) {
    return [
      `# Reporter advisor — snapshot not found`,
      ``,
      `Snapshot \`${args.snapshot_id}\` is missing or expired (snapshots live 30 min).`,
      ``,
      `Run \`log10x_discover_env\` again and pass the new snapshot_id.`,
    ].join('\n');
  }

  const action = args.action ?? 'all';

  const destResolution = await resolveAdvisorDestination(args.destination);
  if (destResolution.kind === 'ambiguous') return destResolution.markdown;
  const destination = destResolution.destination;

  const plan = await buildReporterPlan({
    snapshot,
    forwarder: args.forwarder as ForwarderKind | undefined,
    releaseName: args.release_name,
    namespace: args.namespace,
    licenseJwt: args.license_jwt,
    destination: destination as OutputDestination,
    outputHost: args.output_host,
    splunkHecToken: args.splunk_hec_token,
    skipInstall: action === 'verify' || action === 'teardown',
    skipVerify: action === 'install' || action === 'teardown',
    skipTeardown: action === 'install' || action === 'verify',
  });

  const planMd = renderPlan(plan, action);
  return destResolution.note ? `_${destResolution.note}_\n\n${planMd}` : planMd;
}
