/**
 * log10x_advise_receiver
 *
 * Given a DiscoverySnapshot (from `log10x_discover_env`) + a few user
 * choices, produce a forwarder-specific install/verify/teardown plan
 * for the Log10x Receiver. Same 5 forwarders as the Reporter, same
 * charts, same preflight checks — the only difference is which feature
 * flags are toggled in the chart values (`optimize`, `readOnly` on
 * fluent-bit / fluentd / otel-collector; `kind` on filebeat / logstash,
 * mapped from the same booleans).
 */

import { z } from 'zod';
import { getSnapshot } from '../lib/discovery/snapshot-store.js';
import { buildReporterPlan } from '../lib/advisor/reporter.js';
import { renderPlan } from '../lib/advisor/render.js';
import type { ForwarderKind } from '../lib/discovery/types.js';
import type { OutputDestination } from '../lib/advisor/reporter-forwarders.js';
import { resolveAdvisorDestination } from '../lib/advisor/dest-resolve.js';
import { buildAdvisePlanEnvelope } from '../lib/advisor/envelope.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';

export const adviseReceiverSchema = {
  snapshot_id: z
    .string()
    .describe('ID returned by `log10x_discover_env`. The snapshot is cached for 30 min.'),
  forwarder: z
    .enum(['fluentbit', 'fluentd', 'filebeat', 'logstash', 'otel-collector'])
    .optional()
    .describe(
      'Forwarder to target. If omitted, uses the forwarder detected in the snapshot (falls back to fluentbit when none is detected).'
    ),
  release_name: z
    .string()
    .optional()
    .describe('Helm release name. Default: `my-receiver`. Must not collide with an existing release.'),
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
      'Output destination for filtered events. When omitted: auto-detects from ambient SIEM credentials (DD_API_KEY → datadog, SPLUNK_HOST+SPLUNK_TOKEN → splunk, ELASTIC_URL → elasticsearch, AWS chain → cloudwatch); single match is used; multiple → ambiguous error; none → falls back to `mock` (writes to pod stdout — ideal for smoke tests + dogfooding).'
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
      'When true, emit events out of the forwarder in compact encoded form (templateHash+vars, ~20-40x volume reduction; see `config/modules/pipelines/run/units/transform/doc.md#compact`). Supported on all 5 forwarders via `tenx.optimize: true` in the chart values. Mutually exclusive with `mode=readonly` (chart fails install if both are set). Default: false.'
    ),
  mode: z
    .enum(['readonly', 'readwrite'])
    .optional()
    .describe(
      'Receiver mode. `readwrite` (default): receive events, filter them, write them back through the forwarder (with optional compact encoding when `optimize=true`). `readonly`: receive events, emit `emitted_events`/`all_events` TenXSummary metrics, do NOT write events back — passive metrics-only deployment. Maps to `tenx.readOnly: true` in the chart values. The chart wires the engine flag that gates every event-output stream module (forward/unix/socket/stdout) so the return loop to the forwarder is never constructed. Mutually exclusive with `optimize=true`. For the parallel-DaemonSet observation pattern (separate pod, not in the forwarder pipeline), use `log10x_advise_reporter` with `shape=standalone` instead.'
    ),
  action: z
    .enum(['install', 'verify', 'teardown', 'all'])
    .optional()
    .describe('Which sections to emit. Default: `all`.'),
  view: z.enum(['summary', 'markdown']).default('summary').describe('summary returns the typed envelope (data.app, data.preflight[], data.install_step_count, data.blockers[]). markdown wraps the rendered plan in data.markdown.'),
};

const schemaObj = z.object(adviseReceiverSchema);
export type AdviseReceiverArgs = z.infer<typeof schemaObj>;

export async function executeAdviseReceiver(args: AdviseReceiverArgs): Promise<string | StructuredOutput> {
  const view = args.view ?? 'summary';
  const snapshot = getSnapshot(args.snapshot_id);
  if (!snapshot) {
    const md = [
      `# Receiver advisor — snapshot not found`,
      ``,
      `Snapshot \`${args.snapshot_id}\` is missing or expired (snapshots live 30 min).`,
      ``,
      `Run \`log10x_discover_env\` again and pass the new snapshot_id.`,
    ].join('\n');
    if (view === 'markdown') {
      return buildMarkdownEnvelope({ tool: 'log10x_advise_receiver', summary: { headline: 'Receiver advisor: snapshot not found' }, markdown: md });
    }
    return buildEnvelope({ tool: 'log10x_advise_receiver', view: 'summary', summary: { headline: `Receiver advisor refused: snapshot ${args.snapshot_id} not found.` }, data: { ok: false, app: 'receiver', snapshot_id: args.snapshot_id, error: 'snapshot not found' } });
  }

  const action = args.action ?? 'all';

  const destResolution = await resolveAdvisorDestination(args.destination);
  if (destResolution.kind === 'ambiguous') {
    if (view === 'markdown') {
      return buildMarkdownEnvelope({ tool: 'log10x_advise_receiver', summary: { headline: 'Receiver advisor: destination ambiguous' }, markdown: destResolution.markdown });
    }
    return buildEnvelope({ tool: 'log10x_advise_receiver', view: 'summary', summary: { headline: 'Receiver advisor refused: destination ambiguous.' }, data: { ok: false, app: 'receiver', snapshot_id: args.snapshot_id, error: 'destination ambiguous' } });
  }
  const destination = destResolution.destination;

  const plan = await buildReporterPlan({
    snapshot,
    app: 'receiver',
    forwarder: args.forwarder as ForwarderKind | undefined,
    releaseName: args.release_name ?? 'my-receiver',
    namespace: args.namespace,
    apiKey: args.api_key,
    destination: destination as OutputDestination,
    outputHost: args.output_host,
    splunkHecToken: args.splunk_hec_token,
    optimize: args.optimize,
    readOnly: args.mode === 'readonly',
    skipInstall: action === 'verify' || action === 'teardown',
    skipVerify: action === 'install' || action === 'teardown',
    skipTeardown: action === 'install' || action === 'verify',
  });

  return buildAdvisePlanEnvelope({ tool: 'log10x_advise_receiver', view, plan, action, destinationNote: destResolution.note });
}
