/**
 * log10x_cost_options — the 7-mode action menu.
 *
 * Called after the user picks option 1 ("Show me what cutting costs would
 * look like") from log10x_start. Returns a structured menu of the seven
 * enforcement modes (drop / sample / compact / tier_down / offload /
 * manual / pass), each gated by the customer's detected capabilities.
 *
 * Three compliance levers (same shape as log10x_start):
 *   must_render_verbatim   — pre-rendered markdown the agent surfaces as-is.
 *   must_ask_user          — numbered question the agent MUST ask before routing.
 *   forbidden_next_actions — tools the agent MUST NOT call until the user picks.
 */

import { z } from 'zod';
import { queryInstant } from '../lib/api.js';
import { resolveRetriever } from '../lib/retriever-api.js';
import { discoverAvailable } from '../lib/siem/index.js';
import { loadEnvironments, type EnvConfig, type Environments } from '../lib/environments.js';
import { LABELS } from '../lib/promql.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import type { CapabilitySummary, MustAskUser } from './log10x-start.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

export const costOptionsSchema = {
  target_percent: z
    .number()
    .min(1)
    .max(95)
    .optional()
    .describe(
      '% reduction goal carried from log10x_start pick, pre-filled when the user stated a target.'
    ),
  service: z
    .string()
    .optional()
    .describe(
      'Scope to a service. Passed forward to estimate_savings when the user picks a mode.'
    ),
};

// ─── Output types ─────────────────────────────────────────────────────────────

export type CostOptionId =
  | 'drop'
  | 'sample'
  | 'compact'
  | 'tier_down'
  | 'offload'
  | 'manual'
  | 'pass';

export interface CostOptionItem {
  id: CostOptionId;
  /** Short label rendered to user (one sentence). */
  label: string;
  /** One-line mechanism description. */
  description: string;
  /** Which infrastructure layer enforces the action. */
  who_enforces: 'engine' | 'SIEM' | 'forwarder' | 'customer';
  /** True when the customer's env supports this mode without further setup. */
  applicable: boolean;
  /** When applicable=false, explains what's missing. */
  gated_reason?: string;
  /** What events survive (land in SIEM / archive / nowhere). */
  what_survives: string;
  /** Tool + args to call when user picks this mode. */
  routes_to: { tool: string; args: Record<string, unknown> };
}

export interface CostOptionsEnvelope {
  modes: CostOptionItem[];
  siem_detected: string | null;
  capability_summary: CapabilitySummary;
  must_render_verbatim: string;
  must_ask_user: MustAskUser;
  forbidden_next_actions: string[];
}

// ─── SIEM compact support gate ────────────────────────────────────────────────

const COMPACT_SUPPORTED_SIEM = new Set([
  'splunk',
  'elasticsearch',
  'clickhouse',
  'azure-monitor',
  'gcp-logging',
  'sumo',
]);

function siemSupportsCompact(siem: string | null): boolean {
  if (!siem) return true; // unknown SIEM — don't gate; estimate_savings will error if needed
  return COMPACT_SUPPORTED_SIEM.has(siem);
}

// ─── Probe helpers (mirrors log10x-start.ts) ──────────────────────────────────

function pickDefaultEnv(envs: Environments): EnvConfig | undefined {
  if (envs.all.length === 0) return undefined;
  return envs.default;
}

async function probeReporterTier(env: EnvConfig): Promise<'edge' | 'cloud' | null> {
  try {
    const edge = await queryInstant(
      env,
      `count(all_events_summaryBytes_total{${LABELS.env}="edge"}) > 0`
    );
    if (edge.status === 'success' && edge.data.result.length > 0) return 'edge';
    const cloud = await queryInstant(
      env,
      `count(all_events_summaryBytes_total{${LABELS.env}="cloud"}) > 0`
    );
    if (cloud.status === 'success' && cloud.data.result.length > 0) return 'cloud';
    return null;
  } catch {
    return null;
  }
}

async function probeReceiverInPath(
  env: EnvConfig,
  reporterTier: 'edge' | 'cloud'
): Promise<{ detected: boolean; uncertain: boolean }> {
  try {
    const res = await queryInstant(
      env,
      `count(all_events_summaryBytes_total{${LABELS.env}="${reporterTier}",isDropped="true"}) > 0`
    );
    if (res.status === 'success' && res.data.result.length > 0) {
      return { detected: true, uncertain: false };
    }
    return { detected: false, uncertain: true };
  } catch {
    return { detected: false, uncertain: true };
  }
}

async function probeGateway(env: EnvConfig): Promise<boolean> {
  try {
    const res = await queryInstant(env, `count(up{${LABELS.env}=~"edge|cloud"}) or vector(0)`);
    return res.status === 'success';
  } catch {
    return false;
  }
}

async function probeSiem(): Promise<string | null> {
  try {
    const results = await discoverAvailable();
    const hit = results.find((r) => r.detection.available);
    return hit ? hit.id : null;
  } catch {
    return null;
  }
}

async function probeRetriever(): Promise<boolean> {
  try {
    const r = await resolveRetriever();
    return !!(r.url && r.bucket && r.detectionPath);
  } catch {
    return false;
  }
}

function buildCapabilities(args: {
  gatewayOk: boolean;
  reporterTier: 'edge' | 'cloud' | null;
  receiverInPath: boolean;
  receiverUncertain: boolean;
  retrieverOk: boolean;
  siemDetected: string | null;
}): CapabilitySummary {
  const tier =
    args.retrieverOk
      ? 'retriever'
      : args.receiverInPath
        ? 'receiver'
        : args.gatewayOk && args.reporterTier
          ? 'reporter'
          : 'dev';

  return {
    cost_attribution_available: args.gatewayOk && args.reporterTier !== null,
    compact_installable:
      tier === 'receiver' || tier === 'retriever' || tier === 'reporter',
    tier_down_available: tier === 'receiver' || tier === 'retriever',
    forensic_query_available: args.retrieverOk,
    offload_ready: args.retrieverOk && args.receiverInPath,
    siem_query_available: args.siemDetected !== null,
    receiver_discrimination_uncertain:
      args.receiverUncertain && tier !== 'dev',
  };
}

// ─── Mode builder ──────────────────────────────────────────────────────────────

function buildModes(
  caps: CapabilitySummary,
  siemDetected: string | null,
  args: { target_percent?: number; service?: string }
): CostOptionItem[] {
  const { target_percent, service } = args;

  const sharedArgs = (defaultAction: string): Record<string, unknown> => {
    const out: Record<string, unknown> = { default_action: defaultAction };
    if (target_percent !== undefined) out.target_percent = target_percent;
    if (service !== undefined) out.service = service;
    return out;
  };

  const compactApplicable =
    caps.compact_installable && siemSupportsCompact(siemDetected);
  const compactGatedReason = !caps.compact_installable
    ? 'Requires Receiver tier (in-path forwarder sidecar). Install via log10x_advise_install.'
    : !siemSupportsCompact(siemDetected)
      ? `compact mode is a no-op on ${siemDetected} — it does not reduce ingest cost on that destination.`
      : undefined;

  const tierDownApplicable =
    caps.tier_down_available &&
    (siemDetected === 'cloudwatch' || siemDetected === 'datadog');
  const tierDownGatedReason = !caps.tier_down_available
    ? 'Requires Receiver tier (in-path) for the engine to stamp the tenx_action marker the SIEM reads.'
    : siemDetected !== 'cloudwatch' && siemDetected !== 'datadog'
      ? `tier_down maps to a concrete billing reduction only on Datadog (Flex Logs) and CloudWatch (Infrequent Access). Detected SIEM: ${siemDetected ?? 'unknown'}.`
      : undefined;

  const manualArgs: Record<string, unknown> = {};
  if (service !== undefined) manualArgs.service = service;
  if (target_percent !== undefined) manualArgs.target_percent = target_percent;

  return [
    {
      id: 'drop',
      label: 'Drop — stop events at the forwarder. Nothing reaches the SIEM.',
      description:
        'Engine caps the pattern at 0 bytes/s. Events are discarded at the Receiver before reaching the SIEM.',
      who_enforces: 'engine',
      applicable: true,
      what_survives:
        'No events reach the SIEM. Events are gone (or offloaded to S3 if offload action used instead).',
      routes_to: { tool: 'log10x_estimate_savings', args: sharedArgs('drop') },
    },
    {
      id: 'sample',
      label: 'Sample — keep 1 in N events. Trends stay valid.',
      description:
        'Engine passes 1 in N events (default 1 in 10) through to the SIEM. Aggregate alerting remains valid.',
      who_enforces: 'engine',
      applicable: true,
      what_survives:
        '1 in N events reach the SIEM (default 1 in 10). Trend and alerting remain valid at reduced volume.',
      routes_to: { tool: 'log10x_estimate_savings', args: sharedArgs('sample') },
    },
    {
      id: 'compact',
      label: 'Compact — compress events ~5–10x. All events still land in the SIEM.',
      description:
        'Engine encodes events into the 10x compact wire format (~5–10x smaller). All events arrive in the SIEM; fields stay searchable.',
      who_enforces: 'engine',
      applicable: compactApplicable,
      gated_reason: compactGatedReason,
      what_survives:
        'All events reach the SIEM, each compressed by 5–10x. Fully searchable.',
      routes_to: { tool: 'log10x_estimate_savings', args: sharedArgs('compact') },
    },
    {
      id: 'tier_down',
      label: 'Tier-down — SIEM stores events at a cheaper storage tier.',
      description:
        'Engine stamps events with a tenx_action marker; the SIEM routes them to a cheaper tier (Flex Logs on Datadog, Infrequent Access on CloudWatch).',
      who_enforces: 'SIEM',
      applicable: tierDownApplicable,
      gated_reason: tierDownGatedReason,
      what_survives:
        'Events reach the SIEM at a cheaper storage tier (e.g. Flex Logs / Standard Tier). Indexed fields preserved.',
      routes_to: { tool: 'log10x_estimate_savings', args: sharedArgs('tier_down') },
    },
    {
      id: 'offload',
      label: 'Offload — events route to your S3 bucket instead of the SIEM.',
      description:
        'Engine diverts engine-marked events to a customer-owned S3 bucket. Events stay recoverable on demand via log10x_retriever_query.',
      who_enforces: 'engine',
      applicable: caps.offload_ready,
      gated_reason: caps.offload_ready
        ? undefined
        : !caps.forensic_query_available
          ? 'Requires the overflow bucket (Retriever) set up. Install via log10x_advise_retriever.'
          : 'Requires Receiver tier in-path so the engine can route events to S3. Install via log10x_advise_install.',
      what_survives:
        'Events route to your S3 bucket instead of the SIEM. Recoverable via log10x_retriever_query on demand.',
      routes_to: { tool: 'log10x_estimate_savings', args: sharedArgs('offload') },
    },
    {
      id: 'manual',
      label: 'Manual — engine marks patterns; you or your forwarder/SIEM applies the decision.',
      description:
        'Engine marks patterns with isDropped in metrics but does not enforce. You apply the exclusion or config on your own schedule.',
      who_enforces: 'customer',
      applicable: true,
      what_survives:
        'Up to you — engine marks patterns but does not enforce. Your forwarder or SIEM applies the decision.',
      routes_to: { tool: 'log10x_manual_options', args: manualArgs },
    },
    {
      id: 'pass',
      label: 'Pass — no action. Useful to get the savings estimate as a null baseline.',
      description:
        'All events pass unchanged. Run this to get the baseline volume before committing to any mode.',
      who_enforces: 'engine',
      applicable: true,
      what_survives:
        'All events pass unchanged. Useful as a null baseline or to explicitly exempt a pattern.',
      routes_to: { tool: 'log10x_estimate_savings', args: sharedArgs('pass') },
    },
  ];
}

// ─── Verbatim renderer ─────────────────────────────────────────────────────────

function renderVerbatim(
  modes: CostOptionItem[],
  siemDetected: string | null
): string {
  const siemLine = siemDetected
    ? `SIEM detected: \`${siemDetected}\`.`
    : 'No SIEM credentials detected — destinations will need to be specified when you pick a mode.';

  const modeLines = modes
    .map((m, i) => {
      const gate = m.applicable ? '' : `  _(not available: ${m.gated_reason})_`;
      return `  ${i + 1}. **${m.id}** — ${m.label}${gate}`;
    })
    .join('\n');

  return [
    `### How do you want to handle the cost?`,
    ``,
    `**${siemLine}**`,
    ``,
    `Pick a mode. Each trades off where the enforcement happens and what happens to the data.`,
    ``,
    modeLines,
    ``,
    `_(Pick a number. After you pick, I'll run the savings estimate — or show you the manual sub-paths for option 6.)_`,
  ].join('\n');
}

// ─── forbidden_next_actions ───────────────────────────────────────────────────

function buildCostOptionsForbidden(): string[] {
  return [
    'log10x_estimate_savings',
    'log10x_configure_engine',
    'log10x_pattern_mitigate',
    'log10x_manual_options',
  ];
}

// ─── Entry function ───────────────────────────────────────────────────────────

export async function executeCostOptions(args: {
  target_percent?: number;
  service?: string;
}): Promise<StructuredOutput> {
  // Run probes — same pattern as executeLog10xStart.
  let env: EnvConfig | undefined;
  try {
    const envs = await loadEnvironments();
    env = pickDefaultEnv(envs);
  } catch {
    env = undefined;
  }

  let gatewayOk = false;
  let reporterTier: 'edge' | 'cloud' | null = null;
  let receiverProbe = { detected: false, uncertain: true };
  let retrieverOk = false;
  let siemDetected: string | null = null;

  if (env) {
    const [g, r, ret, siem] = await Promise.all([
      probeGateway(env),
      probeReporterTier(env),
      probeRetriever(),
      probeSiem(),
    ]);
    gatewayOk = g;
    reporterTier = r;
    retrieverOk = ret;
    siemDetected = siem;
    if (reporterTier) {
      receiverProbe = await probeReceiverInPath(env, reporterTier);
    }
  } else {
    const [ret, siem] = await Promise.all([probeRetriever(), probeSiem()]);
    retrieverOk = ret;
    siemDetected = siem;
  }

  const caps = buildCapabilities({
    gatewayOk,
    reporterTier,
    receiverInPath: receiverProbe.detected,
    receiverUncertain: receiverProbe.uncertain,
    retrieverOk,
    siemDetected,
  });

  const modes = buildModes(caps, siemDetected, args);
  const verbatim = renderVerbatim(modes, siemDetected);

  const mustAskUser: MustAskUser = {
    question:
      'Pick the enforcement mode that matches what you want — answer with the number from the menu above.',
    options: modes.map((m, i) => `${i + 1}. ${m.id} — ${m.label}`),
  };

  const forbidden = buildCostOptionsForbidden();

  const envelope: CostOptionsEnvelope = {
    modes,
    siem_detected: siemDetected,
    capability_summary: caps,
    must_render_verbatim: verbatim,
    must_ask_user: mustAskUser,
    forbidden_next_actions: forbidden,
  };

  const applicableCount = modes.filter((m) => m.applicable).length;
  const headline = `Cost options: ${applicableCount} of ${modes.length} modes available. Awaiting user pick before routing to estimate_savings or manual_options.`;

  return buildEnvelope({
    tool: 'log10x_cost_options',
    view: 'summary',
    summary: { headline },
    data: envelope,
    actions: [],
  });
}

/** Export internals so tests can call helpers directly. */
export const _internals = {
  buildCapabilities,
  buildModes,
  renderVerbatim,
  buildCostOptionsForbidden,
  siemSupportsCompact,
};
