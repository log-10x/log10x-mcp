/**
 * log10x_cost_options — the outcome-first action menu.
 *
 * Called after the user picks option 1 ("Show me what cutting costs would
 * look like") from log10x_start. Returns a structured menu of the six
 * enforcement modes (drop / sample / compact / tier_down / offload /
 * observe_only), each gated by the customer's detected capabilities.
 *
 * At Receiver tier: 6 modes.
 * At Reporter-only or Dev tier: 2-item collapsed menu (observe_only +
 * install_receiver placeholder) with prose explaining that the full
 * 6-mode menu requires the Receiver in-path.
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
import { type StructuredOutput } from '../lib/output-types.js';
import {
  buildChassisEnvelope,
  newChassisTelemetry,
  recordQuery,
} from '../lib/chassis-envelope.js';
import type { CapabilitySummary, MustAskUser } from './log10x-start.js';
import type { Action } from '../lib/cost.js';

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
  pattern_hash: z
    .string()
    .optional()
    .describe(
      'Optional pattern hash to scope the cost option menu to a single pattern. When present, routes_to.args will include a proposed_config row for this hash.'
    ),
};

// ─── Output types ─────────────────────────────────────────────────────────────

export type CostOptionId =
  | 'drop'
  | 'sample'
  | 'compact'
  | 'tier_down'
  | 'offload'
  | 'observe_only'
  | 'install_receiver';

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

export type CustomerTier = 'dev' | 'reporter' | 'receiver' | 'retriever';

function buildCapabilities(args: {
  gatewayOk: boolean;
  reporterTier: 'edge' | 'cloud' | null;
  receiverInPath: boolean;
  receiverUncertain: boolean;
  retrieverOk: boolean;
  siemDetected: string | null;
}): CapabilitySummary & { _tier: CustomerTier } {
  const tier: CustomerTier =
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
    _tier: tier,
  };
}

// ─── Mode builder ──────────────────────────────────────────────────────────────

function buildModes(
  caps: CapabilitySummary & { _tier?: CustomerTier },
  siemDetected: string | null,
  args: { target_percent?: number; service?: string; pattern_hash?: string }
): CostOptionItem[] {
  const { target_percent, service, pattern_hash } = args;
  const tier: CustomerTier = caps._tier ?? 'dev';

  /**
   * Build the routes_to.args for a given action.
   *
   * When pattern_hash is known:
   *   - Always uses proposed_config so estimate_savings can honour the
   *     explicit per-pattern action without needing target_percent.
   * When pattern_hash is absent but target_percent was supplied:
   *   - Uses target_percent + the destination-appropriate default_action
   *     (resolved from DEFAULT_ACTION_BY_DESTINATION) so the greedy solver
   *     picks actions that are valid for the destination.
   * When neither is available:
   *   - routes_to still carries destination + service; the agent must supply
   *     either proposed_config or target_percent before calling estimate_savings.
   */
  const sharedArgs = (action: Action): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (siemDetected) out.destination = siemDetected;
    if (service !== undefined) out.service = service;
    if (pattern_hash) {
      // Explicit single-pattern route: use proposed_config so estimate_savings
      // doesn't need target_percent.
      out.proposed_config = [{ pattern_hash, action }];
    } else if (target_percent !== undefined) {
      // Greedy solver route: pass target_percent + the canonical action for
      // the destination so the solver doesn't pick compact on a no-op dest.
      out.target_percent = target_percent;
      out.default_action = action;
    }
    // When neither pattern_hash nor target_percent is known, the agent must
    // add proposed_config or target_percent before calling estimate_savings.
    return out;
  };

  // At dev / reporter tier, collapse to 2-item menu.
  if (tier === 'dev' || tier === 'reporter') {
    return [
      {
        id: 'observe_only',
        label: 'Observe only — 10x marks patterns in metrics; nothing is dropped. Use this to baseline volume before committing to a mode.',
        description:
          'All events pass unchanged. Pattern metrics flow to TSDB so cost attribution is visible.',
        who_enforces: 'engine',
        applicable: true,
        what_survives: 'All events pass unchanged; pattern metrics flow to TSDB.',
        routes_to: { tool: 'log10x_estimate_savings', args: sharedArgs('pass') },
      },
      {
        id: 'install_receiver',
        label: 'Install the 10x Receiver — unlocks drop / sample / compact / tier_down / offload.',
        description:
          'Drop / sample / compact / tier_down / offload require the Receiver in-path. Install it first to unlock the rest.',
        who_enforces: 'engine',
        applicable: true,
        what_survives: 'N/A — this option routes to the install wizard.',
        routes_to: { tool: 'log10x_advise_install', args: {} },
      },
    ];
  }

  // Receiver / Retriever tier — full 6-mode menu.
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
      id: 'observe_only',
      label: 'Observe only — 10x marks patterns in metrics; nothing is dropped. Use this to baseline volume before committing to a mode.',
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
  siemDetected: string | null,
  tier?: CustomerTier
): string {
  const siemLine = siemDetected
    ? `SIEM detected: \`${siemDetected}\`.`
    : 'No SIEM credentials detected — destinations will need to be specified when you pick a mode.';

  const isCollapsed = tier === 'dev' || tier === 'reporter';

  const modeLines = modes
    .map((m, i) => {
      const gate = m.applicable ? '' : `  _(not available: ${m.gated_reason})_`;
      return `  ${i + 1}. **${m.id}** — ${m.label}${gate}`;
    })
    .join('\n');

  if (isCollapsed) {
    return [
      `### How do you want to handle the cost?`,
      ``,
      `**${siemLine}**`,
      ``,
      `Drop / sample / tier_down / offload / compact require the Receiver in-path. Install it first to unlock the rest.`,
      ``,
      modeLines,
      ``,
      `_(Pick a number.)_`,
    ].join('\n');
  }

  return [
    `### How do you want to handle the cost?`,
    ``,
    `**${siemLine}**`,
    ``,
    `Pick a mode. Each trades off where the enforcement happens and what happens to the data.`,
    ``,
    modeLines,
    ``,
    `_(Pick a number. After you pick, I'll run the savings estimate.)_`,
  ].join('\n');
}

// ─── forbidden_next_actions ───────────────────────────────────────────────────

function buildCostOptionsForbidden(): string[] {
  return [
    'log10x_estimate_savings',
    'log10x_configure_engine',
    'log10x_pattern_mitigate',
  ];
}

// ─── Entry function ───────────────────────────────────────────────────────────

export async function executeCostOptions(args: {
  target_percent?: number;
  service?: string;
  pattern_hash?: string;
}): Promise<StructuredOutput> {
  const telemetry = newChassisTelemetry();

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
    recordQuery(telemetry);
    gatewayOk = g;
    reporterTier = r;
    retrieverOk = ret;
    siemDetected = siem;
    if (reporterTier) {
      receiverProbe = await probeReceiverInPath(env, reporterTier);
      recordQuery(telemetry);
    }
  } else {
    const [ret, siem] = await Promise.all([probeRetriever(), probeSiem()]);
    recordQuery(telemetry);
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

  const tier: CustomerTier = caps._tier;
  const modes = buildModes(caps, siemDetected, args);
  const verbatim = renderVerbatim(modes, siemDetected, tier);

  const mustAskUser: MustAskUser = {
    question:
      'Pick the enforcement mode that matches what you want — answer with the number from the menu above.',
    options: modes.map((m, i) => `${i + 1}. ${m.id} — ${m.label}`),
  };

  const forbidden = buildCostOptionsForbidden();

  // Strip the internal _tier field before exposing in the envelope.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _tier: _strippedTier, ...capsSummary } = caps;
  const envelope: CostOptionsEnvelope = {
    modes,
    siem_detected: siemDetected,
    capability_summary: capsSummary,
    must_render_verbatim: verbatim,
    must_ask_user: mustAskUser,
    forbidden_next_actions: forbidden,
  };

  const applicableCount = modes.filter((m) => m.applicable).length;
  const headline = `Cost options (${tier} tier): ${applicableCount} of ${modes.length} modes available. Awaiting user pick before routing.`;
  const human_summary = siemDetected
    ? `${applicableCount} of ${modes.length} modes available on ${siemDetected} (${tier} tier). Pick a mode.`
    : `${applicableCount} of ${modes.length} modes available (${tier} tier, no SIEM detected). Pick a mode.`;

  return buildChassisEnvelope({
    tool: 'log10x_cost_options',
    view: 'summary',
    headline,
    status: 'success',
    decisions: {
      threshold_used: null,
      threshold_basis: 'default',
    },
    source_disclosure: {
      siem_vendor: siemDetected ?? undefined,
    },
    scope: {
      window: 'n/a',
      window_basis: 'auto_default',
    },
    payload: envelope,
    human_summary,
    must_render_verbatim: verbatim,
    must_ask_user: mustAskUser,
    forbidden_next_actions: forbidden,
    actions: [
      {
        tool: 'log10x_estimate_savings',
        args: {},
        role: 'recommended-next',
        reason: 'After user picks a mode, route here with destination + action to forecast savings.',
      },
    ],
    legacyCompat: true,
    legacyExtraFields: {
      modes,
      siem_detected: siemDetected,
      capability_summary: capsSummary,
    },
    telemetry,
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
