/**
 * log10x_advise_receiver
 *
 * Given a DiscoverySnapshot (from `log10x_discover_env`) + a few user
 * choices, produce a forwarder-specific install/verify/teardown plan
 * for the Log10x Receiver (kind=regulate). Same 5 forwarders as the
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
import { resolveAdvisorDestination } from '../lib/advisor/dest-resolve.js';

export const adviseReceiverSchema = {
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
    .describe('Helm release name. Default: `my-reducer`. Must not collide with an existing release.'),
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
      'Output destination for regulated events. When omitted: auto-detects from ambient SIEM credentials (DD_API_KEY → datadog, SPLUNK_HOST+SPLUNK_TOKEN → splunk, ELASTIC_URL → elasticsearch, AWS chain → cloudwatch); single match is used; multiple → ambiguous error; none → falls back to `mock` (writes to pod stdout — ideal for smoke tests + dogfooding).'
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
      'When true, emit events out of the forwarder in compact encoded form (templateHash+vars, ~20-40x volume reduction; see `config/modules/pipelines/run/units/transform/doc.md#compact`). Verified 2026-04-25 on engine 1.0.9 + chart 1.0.8 across all 5 forwarders (otel full payload trace; fluent-bit/fluentd/filebeat/logstash dispatch-confirmed). Plan emits `env: [{name: reducerOptimize, value: "true"}]` — image-version-agnostic (works on engine 1.0.7+ even though chart-native `tenx.optimize: true` only became reliable at engine 1.0.9). Has no effect when `mode=readonly` (no events written back). Default: false.'
    ),
  mode: z
    .enum(['readonly', 'readwrite'])
    .optional()
    .describe(
      'Receiver mode. `readwrite` (default): receive events, regulate them, write them back through the forwarder (with optional compact encoding when `optimize=true`). `readonly`: receive events, emit `emitted_events`/`all_events` TenXSummary metrics, do NOT write events back — passive metrics-only deployment. Plan emits `env: [{name: reducerReadOnly, value: "true"}]` for readonly. The engine flag (`reducerReadOnly`) gates every event-output stream module (forward/unix/socket/stdout) so the return loop to the forwarder is never constructed. For the parallel-DaemonSet observation pattern (separate pod, not in the forwarder pipeline), use `log10x_advise_reporter` with `shape=standalone` instead.'
    ),
  action: z
    .enum(['install', 'verify', 'teardown', 'all'])
    .optional()
    .describe('Which sections to emit. Default: `all`.'),
};

const schemaObj = z.object(adviseReceiverSchema);
export type AdviseReceiverArgs = z.infer<typeof schemaObj>;

export async function executeAdviseReceiver(args: AdviseReceiverArgs): Promise<string> {
  const snapshot = getSnapshot(args.snapshot_id);
  if (!snapshot) {
    return [
      `# Receiver advisor — snapshot not found`,
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
    app: 'reducer',
    forwarder: args.forwarder as ForwarderKind | undefined,
    releaseName: args.release_name,
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

  const planMd = renderPlan(plan, action);
  return destResolution.note ? `_${destResolution.note}_\n\n${planMd}` : planMd;
}
