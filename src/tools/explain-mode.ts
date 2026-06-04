/**
 * log10x_explain_mode — L2 surface.
 *
 * Explains ONE enforcement mode to the user in service-level plain
 * language before any action is taken. Called after the user picks a
 * mode from log10x_cost_options (or directly when the agent has already
 * determined the mode from context).
 *
 * Three compliance levers (same shape as log10x_start / log10x_cost_options):
 *   must_render_verbatim   — plain-text (NOT markdown) three-section card
 *                            with no pattern_hash references.
 *   must_ask_user          — "Apply" or "Preview" choice.
 *   forbidden_next_actions — locks apply tools and preview_filter until the
 *                            user explicitly picks one.
 *
 * routes_to:
 *   Apply   → configure_engine  (drop / sample / compact / tier_down / offload)
 *             null              (observe_only — no apply step)
 *   Preview → log10x_preview_filter
 */

import { z } from 'zod';
import { loadEnvironments, type EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import { LABELS } from '../lib/promql.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { parsePrometheusValue, COST_MODEL_BY_DESTINATION } from '../lib/cost.js';
import type { SiemId } from '../lib/siem/pricing.js';
import { type StructuredOutput } from '../lib/output-types.js';
import { newChassisTelemetry, buildChassisEnvelope } from '../lib/chassis-envelope.js';
import { resolveSiemSelection } from '../lib/siem/resolve.js';
import type { MustAskUser } from './log10x-start.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

export const EXPLAIN_MODES = [
  'drop',
  'sample',
  'compact',
  'tier_down',
  'offload',
  'observe_only',
] as const;

export type ExplainMode = typeof EXPLAIN_MODES[number];

export const explainModeSchema = {
  service: z
    .string()
    .describe(
      'Service name to personalize the explanation with service-level volume and cost figures.'
    ),
  mode: z
    .enum(EXPLAIN_MODES)
    .describe(
      'Which enforcement mode to explain. ' +
      '`drop` = engine hard-drops matched patterns at the Receiver before delivery. ' +
      '`sample` = engine passes 1-in-N events through to the SIEM. ' +
      '`compact` = engine compresses events 5-10x losslessly; all events still reach the SIEM. ' +
      '`tier_down` = engine stamps tenx_action marker; SIEM routes to a cheaper storage tier (Datadog Flex / CloudWatch IA). ' +
      '`offload` = engine diverts matched events to a customer-owned S3 bucket; recoverable via log10x_retriever_query. ' +
      '`observe_only` = engine observes and fingerprints but does not act; use to baseline volume before committing.'
    ),
  destination: z
    .string()
    .optional()
    .describe(
      'Auto-detected destination SIEM or forwarder. When omitted the tool infers from envs.json / env vars. ' +
      'Used to name the specific vendor in the explanation ("your Datadog workspace", "your Splunk index", etc.).'
    ),
};

// ─── Output types ─────────────────────────────────────────────────────────────

export interface ExplainModeEnvelope {
  service: string;
  mode: ExplainMode;
  destination: string | null;
  /** Monthly bytes this service emits — null if metrics unavailable. */
  service_bytes_per_month: number | null;
  /** Monthly cost estimate — null if no rate is set. */
  service_cost_per_month_usd: number | null;
  must_render_verbatim: string;
  must_ask_user: MustAskUser;
  forbidden_next_actions: string[];
  routes_to: {
    apply: { tool: string; args: Record<string, unknown> } | null;
    preview: { tool: string; args: Record<string, unknown> };
  };
}

// ─── Mode metadata ─────────────────────────────────────────────────────────────

interface ModeMetadata {
  what_it_does: string;
  what_you_need: string;
  who_enforces: 'engine' | 'SIEM' | 'forwarder';
  apply_tool: string | null;
  apply_args: ((service: string, destination: string | null) => Record<string, unknown>) | null;
  what_survives: string;
}

const MODE_METADATA: Record<ExplainMode, ModeMetadata> = {
  drop: {
    what_it_does:
      'No events reach the SIEM; engine drops at the Receiver. ' +
      'The 10x Receiver sits in-path and hard-drops matched patterns at the forwarder sidecar before delivery. ' +
      'Events are discarded permanently.',
    what_you_need:
      'The 10x Receiver sidecar must be installed alongside your forwarder (in-path). ' +
      'Requires a GitOps repo configured so 10x can open the action-plan PR.',
    who_enforces: 'engine',
    apply_tool: 'log10x_configure_engine',
    apply_args: (service) => ({ service, default_action: 'drop' }),
    what_survives: 'No events reach the SIEM. Events are discarded at the Receiver.',
  },
  sample: {
    what_it_does:
      '1-in-N events reach the SIEM; trend remains valid. ' +
      '10x Receiver passes 1-in-N events through to your analyzer. ' +
      'Aggregate trends and alerting stay valid at a fraction of the ingest cost. ' +
      'Default sample rate is 1 in 10 (configurable).',
    what_you_need:
      'The 10x Receiver sidecar must be installed in-path. ' +
      'GitOps repo configured for the action-plan PR.',
    who_enforces: 'engine',
    apply_tool: 'log10x_configure_engine',
    apply_args: (service) => ({ service, default_action: 'sample' }),
    what_survives: '1-in-N events reach the SIEM (default 1 in 10). Trend and alerting remain valid.',
  },
  compact: {
    what_it_does:
      'All events reach the SIEM, each compressed 5-10x. ' +
      'Engine encodes events into the 10x compact wire format. ' +
      'All events arrive in the SIEM; fields stay searchable.',
    what_you_need:
      'The 10x Receiver sidecar must be installed in-path. ' +
      'Compatible SIEM (Splunk, Elasticsearch, ClickHouse, Azure Monitor, GCP Logging, Sumo Logic). ' +
      'GitOps repo configured for the action-plan PR.',
    who_enforces: 'engine',
    apply_tool: 'log10x_configure_engine',
    apply_args: (service) => ({ service, default_action: 'compact' }),
    what_survives: 'All events reach the SIEM, each compressed by 5-10x. Fully searchable.',
  },
  tier_down: {
    what_it_does:
      'Events reach the SIEM at a cheaper storage tier (Datadog Flex / CloudWatch IA). ' +
      'Engine stamps matched events with a tenx_action marker. ' +
      'Your analyzer routes stamped events to a cheaper storage tier. ' +
      'Events remain searchable at the lower tier; only storage cost drops.',
    what_you_need:
      'The 10x Receiver in-path AND a compatible analyzer (Datadog or CloudWatch). ' +
      'Tier-routing must be configured on the analyzer side once.',
    who_enforces: 'engine',
    apply_tool: 'log10x_configure_engine',
    apply_args: (service) => ({ service, default_action: 'tier_down' }),
    what_survives: 'Events reach the SIEM at a cheaper storage tier. Indexed fields preserved.',
  },
  offload: {
    what_it_does:
      'Events route to your S3 bucket; recoverable via log10x_retriever_query. ' +
      '10x Receiver diverts matched events to a customer-owned S3 bucket instead of the analyzer. ' +
      'Events stay recoverable on demand (incident replay, compliance audit). ' +
      'Nothing is permanently lost.',
    what_you_need:
      'The 10x Receiver sidecar in-path AND the 10x Retriever set up against your S3 bucket. ' +
      'GitOps repo configured for the action-plan PR.',
    who_enforces: 'engine',
    apply_tool: 'log10x_configure_engine',
    apply_args: (service) => ({ service, default_action: 'offload' }),
    what_survives: 'Events route to your S3 bucket instead of the SIEM. Recoverable via log10x_retriever_query.',
  },
  observe_only: {
    what_it_does:
      'All events pass unchanged; pattern metrics flow to TSDB. ' +
      '10x fingerprints every log pattern and publishes cost metrics. Nothing is filtered or suppressed. ' +
      'Use this to see what your pipeline looks like before committing to any reduction.',
    what_you_need:
      'The 10x Reporter DaemonSet must be running alongside your forwarder. No other changes needed.',
    who_enforces: 'engine',
    apply_tool: null,
    apply_args: null,
    what_survives: 'All events pass unchanged. Pattern metrics flow to TSDB.',
  },
};

// ─── Probe helpers ─────────────────────────────────────────────────────────────

/**
 * Best-effort: fetch the service's byte volume over the last 30 days.
 * Returns null on any failure — the tool works without it.
 */
async function fetchServiceBytes(
  env: EnvConfig,
  service: string,
): Promise<number | null> {
  try {
    const metricsEnv = await resolveMetricsEnv(env);
    const q =
      `sum(increase(all_events_summaryBytes_total{` +
      `${LABELS.service}="${service.replace(/"/g, '\\"')}",` +
      `${LABELS.env}="${metricsEnv}"}[30d]))`;
    const res = await queryInstant(env, q);
    if (res.status === 'success' && res.data.result.length > 0) {
      const v = parsePrometheusValue(res.data.result[0]);
      return Number.isFinite(v) && v > 0 ? v : null;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Verbatim renderer (plain-text, NOT markdown) ─────────────────────────────

/**
 * Builds the three-section plain-text card.
 * Contract: no markdown syntax (no #, **, _, `), no pattern_hash references,
 * dollar math shown when bytes + rate are available.
 */
function renderVerbatim(args: {
  service: string;
  mode: ExplainMode;
  destination: string | null;
  meta: ModeMetadata;
  bytesPerMonth: number | null;
  costPerMonth: number | null;
  ratePerGb: number | null;
}): string {
  const { service, mode, destination, meta, bytesPerMonth, costPerMonth } = args;
  const destPhrase = destination ? ` (${destination})` : '';

  // Section 1: What it does — no mechanism jargon, just effect
  const whatItDoes =
    `What it does\n` +
    `  ${meta.what_it_does}`;

  // Section 2: What you need — prerequisites
  const whatYouNeed =
    `What you need\n` +
    `  ${meta.what_you_need}`;

  // Section 3: What it would mean for [service] — service-level numbers
  let volumeLine = '';
  if (bytesPerMonth !== null) {
    const gb = (bytesPerMonth / (1024 ** 3)).toFixed(1);
    volumeLine = `  ${service} sends roughly ${gb} GB per month${destPhrase}.`;
  } else {
    volumeLine = `  Volume data for ${service} is not yet available from metrics.`;
  }
  let savingsLine = '';
  if (costPerMonth !== null && bytesPerMonth !== null && args.ratePerGb !== null) {
    // Rough mode-specific saving estimate — shown with explicit dollar math
    const savingsFrac: Record<ExplainMode, number> = {
      observe_only: 0,
      drop: 1.0,
      sample: 0.9,
      compact: 0.8,
      offload: 1.0,
      tier_down: 0.6,
    };
    const frac = savingsFrac[mode];
    if (frac > 0) {
      const gb = (bytesPerMonth / (1024 ** 3));
      const savingsUsd = costPerMonth * frac;
      const affectedGb = gb * frac;
      savingsLine =
        `  Potential reduction: ${affectedGb.toFixed(1)} GB times $${args.ratePerGb.toFixed(2)}/GB = $${savingsUsd.toFixed(0)}/mo.`;
    } else {
      savingsLine = `  observe_only makes no change to cost — it is an observation-only mode.`;
    }
  }

  const whatItMeans =
    `What it would mean for ${service}\n` +
    volumeLine +
    (savingsLine ? `\n${savingsLine}` : '');

  return [whatItDoes, '', whatYouNeed, '', whatItMeans].join('\n');
}

// ─── Entry function ─────────────────────────────────────────────────────────────

export async function executeExplainMode(args: {
  service: string;
  mode: ExplainMode;
  destination?: string;
}): Promise<StructuredOutput> {
  const telemetry = newChassisTelemetry();
  const meta = MODE_METADATA[args.mode];

  // Resolve destination: caller arg > resolveSiemSelection auto-detect > env.analyzer > null
  let destination: string | null = args.destination ?? null;
  let destinationResolutionSource: 'explicit' | 'auto_detected' | 'env_config' | 'none' = 'none';
  let env: EnvConfig | undefined;

  if (destination) {
    destinationResolutionSource = 'explicit';
  } else {
    try {
      const sel = await resolveSiemSelection({});
      if (sel.kind === 'resolved') {
        destination = sel.id;
        destinationResolutionSource = 'auto_detected';
      }
    } catch {
      // auto-detect best-effort; fall through to env.analyzer
    }
  }

  try {
    const envs = await loadEnvironments();
    env = envs.default;
    if (!destination && env?.analyzer) {
      destination = env.analyzer;
      destinationResolutionSource = 'env_config';
    }
  } catch {
    env = undefined;
  }

  // Probe service volume (best-effort)
  let bytesPerMonth: number | null = null;
  if (env) {
    bytesPerMonth = await fetchServiceBytes(env, args.service);
  }

  // Derive cost rate from COST_MODEL_BY_DESTINATION via the env's analyzer field.
  // Falls back to null when analyzer is not set or not a recognized SiemId.
  let ratePerGb: number | null = null;
  if (destination) {
    const analyzerKey = destination.toLowerCase() as SiemId;
    const model = COST_MODEL_BY_DESTINATION[analyzerKey];
    if (model && Number.isFinite(model.ingest_per_gb) && model.ingest_per_gb > 0) {
      ratePerGb = model.ingest_per_gb;
    }
  }
  let costPerMonth: number | null = null;
  if (bytesPerMonth !== null && ratePerGb !== null) {
    costPerMonth = (bytesPerMonth / (1024 ** 3)) * ratePerGb;
  }

  const verbatim = renderVerbatim({
    service: args.service,
    mode: args.mode,
    destination,
    meta,
    bytesPerMonth,
    costPerMonth,
    ratePerGb,
  });

  // observe_only has no apply step — nothing to enforce.
  const applyRoute = meta.apply_tool && meta.apply_args
    ? { tool: meta.apply_tool, args: meta.apply_args(args.service, destination) }
    : null;

  const mustAskUser: MustAskUser = applyRoute
    ? {
        question: `Do you want to apply ${args.mode} to ${args.service}, or first preview which patterns would be affected?`,
        options: [
          `1. Apply — route to ${meta.apply_tool}`,
          `2. Preview — show me the pattern list first (log10x_preview_filter)`,
        ],
      }
    : {
        question: `${args.mode} is an observe-only mode — no enforcement applied. Do you want to see which patterns would be affected?`,
        options: [
          `1. Preview — show me the pattern list (log10x_preview_filter)`,
        ],
      };

  // routes_to block gives the agent precise next-call args for each branch
  const routesTo = {
    apply: applyRoute,
    preview: {
      tool: 'log10x_preview_filter',
      args: { service: args.service, mode: args.mode },
    },
  };

  const forbiddenNextActions = [
    'log10x_configure_engine',
    'log10x_pattern_mitigate',
    'log10x_advise_retriever',
    'log10x_preview_filter',
  ];

  const headline =
    `explain_mode(${args.mode}) for service "${args.service}". ` +
    (bytesPerMonth !== null
      ? `Service volume: ${(bytesPerMonth / (1024 ** 3)).toFixed(1)} GB/mo. `
      : '') +
    (applyRoute
      ? `Awaiting user choice (Apply or Preview) before routing.`
      : `observe_only mode — no apply step. Awaiting user choice.`);

  const actions = applyRoute
    ? [
        { tool: applyRoute.tool, args: applyRoute.args, reason: 'Apply path — call after user picks Apply', role: 'alternative' as const },
        { tool: 'log10x_preview_filter', args: routesTo.preview.args, reason: 'Preview path — call after user picks Preview', role: 'alternative' as const },
      ]
    : [
        { tool: 'log10x_preview_filter', args: routesTo.preview.args, reason: 'Preview path — call after user picks Preview', role: 'alternative' as const },
      ];

  return buildChassisEnvelope({
    tool: 'log10x_explain_mode',
    view: 'summary',
    headline,
    status: bytesPerMonth !== null ? 'success' : 'insufficient_data',
    decisions: {
      threshold_used: null,
      threshold_basis: 'default',
    },
    source_disclosure: {
      bytes_source: bytesPerMonth !== null ? 'tsdb' : undefined,
      siem_vendor: destination ?? undefined,
      rate_source: ratePerGb !== null ? 'list_price' : 'none',
    },
    scope: {
      window: 'point_in_time',
      window_basis: 'auto_default',
    },
    payload: {
      service: args.service,
      mode: args.mode,
      destination,
      destination_resolution_source: destinationResolutionSource,
      service_bytes_per_month: bytesPerMonth,
      service_cost_per_month_usd: costPerMonth,
      routes_to: routesTo,
    },
    human_summary:
      `Mode ${args.mode} for ${args.service}: ${meta.what_it_does.slice(0, 80)}...` +
      (bytesPerMonth !== null
        ? ` Service volume: ${(bytesPerMonth / (1024 ** 3)).toFixed(1)} GB/mo.`
        : ' Volume data not yet available from metrics.'),
    must_render_verbatim: verbatim,
    must_ask_user: mustAskUser,
    forbidden_next_actions: forbiddenNextActions,
    actions,
    telemetry,
  });
}
