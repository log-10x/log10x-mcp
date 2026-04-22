/**
 * log10x_advise_regulator
 *
 * Given a DiscoverySnapshot (from `log10x_discover_env`) + a few user
 * choices, produce a forwarder-specific install/verify/teardown plan
 * for the Log10x Regulator (kind=regulate). Same 5 forwarders as the
 * Reporter, same charts, same preflight checks — the only difference
 * is the tenx `kind` value, which the chart templates route to a
 * different launch arg (`@run/input/forwarder/<fw>/regulate`).
 */

import { z } from 'zod';
import { getSnapshot } from '../lib/discovery/snapshot-store.js';
import { buildReporterPlan } from '../lib/advisor/reporter.js';
import { renderPlan } from '../lib/advisor/render.js';
import type { ForwarderKind } from '../lib/discovery/types.js';
import type { OutputDestination } from '../lib/advisor/reporter-forwarders.js';

export const adviseRegulatorSchema = {
  snapshot_id: z
    .string()
    .describe('ID returned by `log10x_discover_env`. The snapshot is cached for 30 min.'),
  forwarder: z
    .enum(['fluent-bit', 'fluentd', 'filebeat', 'logstash', 'otel-collector'])
    .optional()
    .describe(
      'Forwarder to target. If omitted, uses the forwarder detected in the snapshot (falls back to fluent-bit when none is detected).'
    ),
  release_name: z
    .string()
    .optional()
    .describe('Helm release name. Default: `my-regulator`. Must not collide with an existing release.'),
  namespace: z
    .string()
    .optional()
    .describe(
      'Target namespace. Default: snapshot.recommendations.suggestedNamespace (usually `logging` or an existing forwarder namespace).'
    ),
  api_key: z
    .string()
    .optional()
    .describe('Log10x license key. Required for a complete install plan; verify/teardown plans work without it.'),
  destination: z
    .enum(['mock', 'elasticsearch', 'splunk', 'datadog', 'cloudwatch'])
    .optional()
    .describe(
      'Output destination for regulated events. Default: `mock` (writes to pod stdout — ideal for smoke tests + dogfooding).'
    ),
  output_host: z
    .string()
    .optional()
    .describe('Host for non-mock destinations (ES endpoint, Splunk HEC host, etc.). Ignored when destination=mock.'),
  splunk_hec_token: z.string().optional().describe('Required when destination=splunk.'),
  optimize: z
    .boolean()
    .optional()
    .describe(
      'When true, emit events out of the forwarder in compact encoded form (templateHash+vars, ~20-40x volume reduction; see `config/modules/pipelines/run/units/transform/doc.md#compact`). Verified working on fluent-bit@1.0.7 + fluentd@1.0.7 via an env-var workaround (the chart\'s own `tenx.optimize: true` field is chart-broken — do NOT use it directly). Refused on filebeat/logstash/otel-collector (charts still at 1.0.6 with unverified optimize wiring). Default: false.'
    ),
  action: z
    .enum(['install', 'verify', 'teardown', 'all'])
    .optional()
    .describe('Which sections to emit. Default: `all`.'),
};

const schemaObj = z.object(adviseRegulatorSchema);
export type AdviseRegulatorArgs = z.infer<typeof schemaObj>;

export async function executeAdviseRegulator(args: AdviseRegulatorArgs): Promise<string> {
  const snapshot = getSnapshot(args.snapshot_id);
  if (!snapshot) {
    return [
      `# Regulator advisor — snapshot not found`,
      ``,
      `Snapshot \`${args.snapshot_id}\` is missing or expired (snapshots live 30 min).`,
      ``,
      `Run \`log10x_discover_env\` again and pass the new snapshot_id.`,
    ].join('\n');
  }

  const action = args.action ?? 'all';
  const plan = await buildReporterPlan({
    snapshot,
    app: 'regulator',
    forwarder: args.forwarder as ForwarderKind | undefined,
    releaseName: args.release_name,
    namespace: args.namespace,
    apiKey: args.api_key,
    destination: args.destination as OutputDestination | undefined,
    outputHost: args.output_host,
    splunkHecToken: args.splunk_hec_token,
    optimize: args.optimize,
    skipInstall: action === 'verify' || action === 'teardown',
    skipVerify: action === 'install' || action === 'teardown',
    skipTeardown: action === 'install' || action === 'verify',
  });

  return renderPlan(plan, action);
}
