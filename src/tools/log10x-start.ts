/**
 * log10x_start — orientation tool.
 *
 * THE tool the agent calls FIRST whenever a user expresses any cost-cutting
 * goal or open-ended platform question (save X%, cut my bill, where do I
 * start, what should I do, how can you help, first session against a fresh
 * MCP install).
 *
 * The orientation envelope returns three explicit compliance levers the
 * agent must obey:
 *
 *   1. must_render_verbatim — pre-rendered markdown the agent MUST surface
 *      to the user as-is (no summarising, no pre-picking, no editorial).
 *   2. must_ask_user        — a structured question + numbered options the
 *      agent MUST ask the user before any follow-up tool call.
 *   3. forbidden_next_actions — tool names the agent MUST NOT call until
 *      the user has answered the must_ask_user question.
 *
 * Capability detection reuses the same three doctor probes (Retriever
 * resolution, gateway auth, Reporter tier metric counts) to place the user
 * on the ladder: Dev CLI → Reporter → Receiver → Retriever. Receiver-tier
 * discrimination from Reporter is best-effort here — doctor.ts collapses
 * both into edge/cloud — so we surface a `receiver_discrimination` hint
 * rather than guessing.
 */

import { z } from 'zod';
import { resolveSiemLens, SIEM_LENS_ENUM, type SiemLensResolution } from '../lib/siem/lens.js';
import { isDemoFallbackActive } from '../lib/demo-env.js';
import { queryInstant } from '../lib/api.js';
import { resolveRetriever } from '../lib/retriever-api.js';
import { discoverAvailable } from '../lib/siem/index.js';
import { loadEnvironments, type Environments, type EnvConfig } from '../lib/environments.js';
import { LABELS } from '../lib/promql.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';

export type Tier = 'dev' | 'reporter' | 'receiver' | 'retriever';

export const IntentHintSchema = z
  .enum(['cost', 'forensic', 'install', 'orient'])
  .optional()
  .describe(
    'Optional hint at what brought the user here. `cost` = wants to cut/save bill; ' +
      '`forensic` = wants to read back the offloaded cohort from the overflow bucket; `install` = wants to deploy; ' +
      '`orient` = first-time session, open-ended. When omitted, the tool treats it as `orient`.'
  );

export const SessionStateSchema = z
  .enum(['fresh', 'midway', 'returning'])
  .optional()
  .describe(
    'Optional caller hint at where the user is in the session. `fresh` (default when omitted) ' +
      '= first message of a new chat, emit the full orientation envelope. `midway` = the agent ' +
      'has already surfaced the orientation envelope this session and the user is mid-flow, ' +
      'emit a short "already oriented, proceeding" envelope. `returning` = treated as `fresh` ' +
      'because the menu / journey phase may have shifted since the last session.'
  );

export const log10xStartSchema = {
  intent_hint: IntentHintSchema,
  session_state: SessionStateSchema,
  siem_lens: z.enum(SIEM_LENS_ENUM).optional().describe(
    'What-if destination lens: orient pricing/applicability for THIS destination while the pipeline keeps its actual one (the user\'s stack differs from the connected demo/env). Carry the same siem_lens onto cost_options / estimate_savings / top_patterns / savings calls that follow.'
  ),
};

export interface CapabilitySummary {
  /** Reporter tier emitting metrics so cost attribution + savings tools work. */
  cost_attribution_available: boolean;
  /** Receiver tier installed (in-path) so compact/sample/drop CAN take effect. */
  compact_installable: boolean;
  /** Receiver tier emits the `isDropped` marker so the SIEM can tier_down by routing rule. */
  tier_down_available: boolean;
  /** Retriever reachable to read the offloaded cohort from the overflow S3 bucket. */
  forensic_query_available: boolean;
  /** Customer-owned offload S3 bucket detected (offload action target). */
  offload_ready: boolean;
  /** Any SIEM connector credentials detected for dependency_check / pattern_examples. */
  siem_query_available: boolean;
  /** True when Retriever vs Receiver could not be discriminated (best-effort). */
  receiver_discrimination_uncertain: boolean;
}

export interface ActionMenuItem {
  /** Stable action identifier the user picks by number. */
  action: 'estimate_savings' | 'investigate_spike' | 'forensic_query' | 'install_receiver' | 'install_retriever' | 'explore_receiver' | 'explore_overflow' | 'orient_only';
  /** Short label rendered to the user in the menu. */
  label: string;
  /** Whether the user's current tier supports this action without further setup. */
  applicable: boolean;
  /** When `applicable=false`, the reason — e.g. "requires Receiver, you are at Reporter". */
  gated_reason?: string;
  /** Tool the agent should call once the user picks this menu item. */
  routes_to: string;
}

export interface JourneyPhase {
  /** Phase ordinal 1..5. */
  phase: number;
  /** Short name rendered in the user-facing markdown. */
  name: string;
  /** One-line description of what this phase delivers. */
  description: string;
  /** Where the user is right now relative to this phase. */
  current_status: 'complete' | 'in_progress' | 'not_started' | 'blocked_by_prior_phase';
}

export interface MustAskUser {
  question: string;
  options: string[];
}

export interface Log10xStartEnvelope {
  tier: Tier;
  siem_detected: string | null;
  capability_summary: CapabilitySummary;
  action_menu: ActionMenuItem[];
  journey_phases: JourneyPhase[];
  must_render_verbatim: string;
  must_ask_user: MustAskUser;
  forbidden_next_actions: string[];
  /** Intent hint as resolved (`orient` when caller passed undefined). */
  intent_hint: 'cost' | 'forensic' | 'install' | 'orient';
  /** Present when a what-if destination lens is in effect (siem_lens arg). */
  siem_lens?: string;
  /** Actual destination, canonical form, when a lens is in effect. */
  siem_actual?: string | null;
  /** How the effective destination was chosen, when a lens is in effect. */
  siem_lens_basis?: 'requested' | 'detected' | 'none';
}

/** Pick the default env (the one resolveEnv would land on with no arg). */
function pickDefaultEnv(envs: Environments): EnvConfig | undefined {
  if (envs.all.length === 0) return undefined;
  return envs.default;
}

/**
 * Probe Reporter tier (edge first, cloud fallback). Mirrors the
 * doctor.ts probe at :298 / :313 so the orientation tool reads the
 * same signal the doctor uses.
 */
async function probeReporterTier(env: EnvConfig): Promise<'edge' | 'cloud' | null> {
  try {
    const edge = await queryInstant(
      env,
      `count(all_events_summaryBytes_total{${LABELS.env}="edge"}) > 0`
    );
    if (edge.status === 'success' && edge.data.result.length > 0) {
      return 'edge';
    }
    const cloud = await queryInstant(
      env,
      `count(all_events_summaryBytes_total{${LABELS.env}="cloud"}) > 0`
    );
    if (cloud.status === 'success' && cloud.data.result.length > 0) {
      return 'cloud';
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Probe Receiver tier — distinct from Reporter. Receiver flips the
 * `isDropped` label on at least some events (compact / sample / drop
 * happens in-path), so a non-zero `isDropped="true"` series is the
 * tell. This is best-effort; absence does not prove Receiver is
 * uninstalled (could be installed in pass-only mode).
 */
async function probeReceiverInPath(env: EnvConfig, reporterTier: 'edge' | 'cloud'): Promise<{ detected: boolean; uncertain: boolean }> {
  try {
    const res = await queryInstant(
      env,
      `count(all_events_summaryBytes_total{${LABELS.env}="${reporterTier}",isDropped="true"}) > 0`
    );
    if (res.status === 'success' && res.data.result.length > 0) {
      return { detected: true, uncertain: false };
    }
    // Reporter present but no dropped events => Receiver may be installed
    // in pass-only mode OR Receiver not installed at all. Cannot tell.
    return { detected: false, uncertain: true };
  } catch {
    return { detected: false, uncertain: true };
  }
}

/** Probe gateway reachability + auth. Returns true if at least one query succeeds. */
async function probeGateway(env: EnvConfig): Promise<boolean> {
  try {
    const res = await queryInstant(env, `count(up{${LABELS.env}=~"edge|cloud"}) or vector(0)`);
    return res.status === 'success';
  } catch {
    return false;
  }
}

/** Best-effort SIEM detection. Returns the first connector id that reports available. */
async function probeSiem(): Promise<string | null> {
  try {
    const results = await discoverAvailable();
    const hit = results.find((r) => r.detection.available);
    return hit ? hit.id : null;
  } catch {
    return null;
  }
}

/** Probe Retriever reachability via the same helper doctor.ts uses. */
async function probeRetriever(): Promise<boolean> {
  try {
    const r = await resolveRetriever();
    return !!(r.url && r.bucket && r.detectionPath);
  } catch {
    return false;
  }
}

/** Resolve the customer's tier from the three probes. */
function resolveTier(args: {
  gatewayOk: boolean;
  reporterTier: 'edge' | 'cloud' | null;
  receiverInPath: boolean;
  retrieverOk: boolean;
}): Tier {
  // Order matters: a customer with Retriever + Receiver is "retriever" tier
  // because the topmost rung dominates the available-tools surface.
  if (args.retrieverOk) return 'retriever';
  if (args.receiverInPath) return 'receiver';
  if (args.gatewayOk && args.reporterTier) return 'reporter';
  return 'dev';
}

/** Build the capability summary from the probes. */
function buildCapabilities(args: {
  tier: Tier;
  gatewayOk: boolean;
  reporterTier: 'edge' | 'cloud' | null;
  receiverInPath: boolean;
  receiverUncertain: boolean;
  retrieverOk: boolean;
  siemDetected: string | null;
}): CapabilitySummary {
  return {
    cost_attribution_available: args.gatewayOk && args.reporterTier !== null,
    compact_installable: args.tier === 'receiver' || args.tier === 'retriever' || args.tier === 'reporter',
    tier_down_available: args.tier === 'receiver' || args.tier === 'retriever',
    forensic_query_available: args.retrieverOk,
    // Offload requires a customer-owned S3 bucket. Retriever's presence is
    // a positive signal (same AWS account) but not proof; we mark ready
    // only when Retriever resolved and Receiver is in-path.
    offload_ready: args.retrieverOk && args.receiverInPath,
    siem_query_available: args.siemDetected !== null,
    receiver_discrimination_uncertain: args.receiverUncertain && args.tier !== 'dev',
  };
}

/** Build the action menu, gated by current capabilities. */
function buildActionMenu(caps: CapabilitySummary, tier: Tier): ActionMenuItem[] {
  return [
    {
      action: 'estimate_savings',
      label: 'Show me what cutting costs would look like (estimate before action)',
      applicable: caps.cost_attribution_available,
      gated_reason: caps.cost_attribution_available
        ? undefined
        : `Requires Reporter tier (cost attribution). You are at tier "${tier}". The Reporter is a zero-touch DaemonSet — install it via log10x_advise_install.`,
      routes_to: 'log10x_cost_options',
    },
    {
      action: 'investigate_spike',
      label: 'Investigate a specific cost spike or top-N pattern right now',
      applicable: caps.cost_attribution_available,
      gated_reason: caps.cost_attribution_available
        ? undefined
        : `Requires Reporter tier. You are at tier "${tier}".`,
      routes_to: 'log10x_top_patterns',
    },
    {
      action: 'forensic_query',
      label: 'Fetch back events from your overflow bucket (incident / audit / debugging)',
      applicable: caps.forensic_query_available,
      gated_reason: caps.forensic_query_available
        ? undefined
        : 'Requires the overflow bucket to be set up. Install via log10x_advise_retriever.',
      routes_to: 'log10x_retriever_query',
    },
    // Receiver slot: an INSTALLED capability is an invitation to explore it,
    // not a grayed-out install. Status is not a feature; the next action is.
    tier === 'receiver' || tier === 'retriever'
      ? {
          action: 'explore_receiver',
          label: 'Explore the Receiver: compact, sample, drop, tier down, offload',
          applicable: true,
          routes_to: 'log10x_explain_mode',
        }
      : {
          action: 'install_receiver',
          label: 'Deploy the Receiver so 10x can compact / sample / drop in-flight',
          applicable: tier === 'reporter',
          gated_reason:
            tier === 'reporter'
              ? undefined
              : 'Install Reporter first (zero-touch DaemonSet) before adding the Receiver sidecar.',
          routes_to: 'log10x_advise_install',
        },
    // Overflow-bucket slot: same rule as the Receiver slot above.
    caps.forensic_query_available
      ? {
          action: 'explore_overflow',
          label: 'Explore the overflow bucket: contents, fetch-back, controls',
          applicable: true,
          routes_to: 'log10x_overflow_contents',
        }
      : {
          action: 'install_retriever',
          label: 'Set up the overflow bucket (your own S3) — diverts noisy patterns out of the SIEM for cost savings; events stay recoverable',
          applicable: true,
          routes_to: 'log10x_advise_retriever',
        },
    {
      action: 'orient_only',
      label: 'Just orient me — explain what 10x does and what I should ask next',
      applicable: true,
      routes_to: 'log10x_doctor',
    },
  ];
}

/** Build the 5-phase journey based on current tier. */
function buildJourneyPhases(tier: Tier, caps: CapabilitySummary): JourneyPhase[] {
  // Phase ordering:
  //   1. Visibility   (Reporter installed, metrics flowing)
  //   2. Attribution  (top patterns + savings estimable)
  //   3. Mitigation   (Receiver installed, can act in-path)
  //   4. Overflow     (Retriever installed, overflow bucket reader)
  //   5. Commitment   (commitment report + maintenance loop)
  const reporterComplete = caps.cost_attribution_available;
  const attributionComplete = caps.cost_attribution_available && caps.siem_query_available;
  const receiverComplete = caps.compact_installable && (tier === 'receiver' || tier === 'retriever');
  const retrieverComplete = caps.forensic_query_available;
  const commitmentComplete = receiverComplete && retrieverComplete;

  function statusFor(complete: boolean, priorComplete: boolean): JourneyPhase['current_status'] {
    if (complete) return 'complete';
    if (!priorComplete) return 'blocked_by_prior_phase';
    return 'not_started';
  }

  return [
    {
      phase: 1,
      name: 'Visibility',
      description: 'Reporter installed — every pattern fingerprinted with cost attribution metrics flowing.',
      current_status: reporterComplete ? 'complete' : 'not_started',
    },
    {
      phase: 2,
      name: 'Attribution',
      description: 'Top patterns and savings are queryable; dependency_check can reach the SIEM.',
      current_status: statusFor(attributionComplete, reporterComplete),
    },
    {
      phase: 3,
      name: 'Mitigation',
      description: 'Receiver in-path so compact / sample / drop actually take effect on the forwarder.',
      current_status: statusFor(receiverComplete, reporterComplete),
    },
    {
      phase: 4,
      name: 'Overflow',
      description: 'Overflow bucket (your own S3) sits between the forwarder and the SIEM — engine-marked noisy patterns route here instead of paying SIEM ingest. Events stay recoverable via fetch-back on demand (incident / audit).',
      current_status: statusFor(retrieverComplete, reporterComplete),
    },
    {
      phase: 5,
      name: 'Commitment',
      description: 'Weekly commitment report + maintenance loop on overflow contents.',
      current_status: statusFor(commitmentComplete, receiverComplete && retrieverComplete),
    },
  ];
}

/** Render the must_render_verbatim markdown. */
function renderVerbatim(args: {
  tier: Tier;
  siemDetected: string | null;
  caps: CapabilitySummary;
  menu: ActionMenuItem[];
  phases: JourneyPhase[];
  intent: 'cost' | 'forensic' | 'install' | 'orient';
  lens?: SiemLensResolution;
}): string {
  const tierLine = {
    dev: 'Dev CLI — local binary only. No pipeline infrastructure detected.',
    reporter: 'Reporter — cost attribution metrics flowing; in-path actions not yet wired.',
    receiver: 'Receiver — in-path; compact / sample / drop are deployable as cap-CSV plans.',
    retriever: 'Retriever — full stack. Overflow bucket is wired between forwarder and SIEM; fetch-back available on demand.',
  }[args.tier];

  const phaseLines = args.phases
    .map((p) => {
      const mark = p.current_status === 'complete' ? '[x]' : p.current_status === 'in_progress' ? '[~]' : '[ ]';
      return `  ${mark} ${p.phase}. ${p.name} — ${p.description}`;
    })
    .join('\n');

  const menuLines = args.menu
    .map((m, i) => {
      const gate = m.applicable ? '' : `  _(not available: ${m.gated_reason})_`;
      return `  ${i + 1}. ${m.label}${gate}`;
    })
    .join('\n');

  // Under a lens, the user's selected stack LEADS and the pipeline's actual
  // destination is the parenthetical. Two separate lines (detected: X, then
  // lens: Y) read as the product ignoring the user's selection.
  const siemLine = args.lens?.lensed && args.lens.display
    ? `Stack: ${args.lens.display} (selected) · pipeline destination: \`${args.siemDetected ?? 'unknown'}\`. Volumes are real; pricing follows ${args.lens.display} list rates.`
    : args.siemDetected
      ? `SIEM credentials detected: \`${args.siemDetected}\`.`
      : 'No SIEM credentials detected — dependency_check will return paste-ready commands instead of executed scans.';

  const demoLine = isDemoFallbackActive()
    ? `_Demo dataset (read-only) — the public 10x pipeline, same data as the website console. Sign in to connect your own environment._`
    : null;

  return [
    `### Log10x orientation`,
    ``,
    `**Tier:** ${tierLine}`,
    `**${siemLine}**`,
    ...(demoLine ? [demoLine] : []),
    ``,
    `**Journey:**`,
    phaseLines,
    ``,
    `**What would you like to do?** Pick a number:`,
    menuLines,
    ``,
    `_(Pick a number before I run any other tool. Numbers map to the action menu in this orientation; the agent will not estimate savings, configure the engine, or query patterns until you choose.)_`,
  ].join('\n');
}

/** Tools the agent MUST NOT call until the user answers must_ask_user. */
function buildForbiddenNextActions(): string[] {
  return [
    'log10x_estimate_savings',
    'log10x_configure_engine',
    'log10x_pattern_mitigate',
    'log10x_services',
  ];
}

export async function executeLog10xStart(
  args: {
    intent_hint?: 'cost' | 'forensic' | 'install' | 'orient';
    session_state?: 'fresh' | 'midway' | 'returning';
    siem_lens?: string;
  }
): Promise<StructuredOutput> {
  const intent = args.intent_hint ?? 'orient';
  const sessionState: 'fresh' | 'midway' | 'returning' = args.session_state ?? 'fresh';

  // Midway short-circuit: the agent has already surfaced the orientation
  // envelope this session and the user is mid-flow. We still return a
  // structured envelope (so the routing rule keeps firing on subsequent
  // turns), but the must_render_verbatim is a one-liner acknowledging the
  // prior orientation and pointing at the next step. No probes run.
  if (sessionState === 'midway') {
    const shortVerbatim = [
      `### Log10x orientation (already surfaced)`,
      ``,
      `You already saw the orientation envelope earlier in this session — proceeding to the next step.`,
      ``,
      `_(If you want to re-see the full menu, ask "show me the orientation again" and the agent will re-call log10x_start with session_state=fresh.)_`,
    ].join('\n');

    // Midway mode: omit capability fields entirely rather than lying with
    // all-false values. Downstream tools that read capability_summary would
    // incorrectly block actions for a real Edge Reporter + CloudWatch env.
    // Callers that need fresh capability state should pass session_state=fresh.
    // Partial envelope: only emit fields that are honest in midway mode.
    // Capability state is intentionally omitted — re-probing is skipped
    // here, and fabricating all-false values would break downstream tools
    // that read capability_summary for real Edge Reporter + CloudWatch envs.
    const envelope = {
      must_render_verbatim: shortVerbatim,
      must_ask_user: {
        question: 'Already oriented — proceeding to the next step the user picked earlier.',
        options: [],
      },
      forbidden_next_actions: [] as string[],
      intent_hint: intent,
      note: 'Capability state not re-probed in midway mode. Call with session_state=fresh to refresh.',
    };

    return buildEnvelope({
      tool: 'log10x_start',
      view: 'summary',
      summary: {
        headline: 'Already oriented this session — short envelope returned, no probes run.',
      },
      data: envelope,
      actions: [],
    });
  }

  // Load envs lazily so this tool is safe to call from any boot state.
  let env: EnvConfig | undefined;
  try {
    const envs = await loadEnvironments();
    env = pickDefaultEnv(envs);
  } catch {
    env = undefined;
  }

  // Run the three probes in parallel when we have an env.
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
    // No env at all — still try Retriever + SIEM probes (env-independent).
    const [ret, siem] = await Promise.all([probeRetriever(), probeSiem()]);
    retrieverOk = ret;
    siemDetected = siem;
  }

  const tier = resolveTier({
    gatewayOk,
    reporterTier,
    receiverInPath: receiverProbe.detected,
    retrieverOk,
  });

  const caps = buildCapabilities({
    tier,
    gatewayOk,
    reporterTier,
    receiverInPath: receiverProbe.detected,
    receiverUncertain: receiverProbe.uncertain,
    retrieverOk,
    siemDetected,
  });

  const menu = buildActionMenu(caps, tier);
  const phases = buildJourneyPhases(tier, caps);
  const lensRes: SiemLensResolution = resolveSiemLens(args.siem_lens, siemDetected);
  const mustRenderVerbatim = renderVerbatim({
    tier,
    siemDetected,
    caps,
    menu,
    phases,
    intent,
    lens: lensRes,
  });

  const mustAskUser: MustAskUser = {
    question:
      'Before I run any other tool, pick the path that matches what you want — answer with the number from the menu above.',
    options: menu.map((m, i) => `${i + 1}. ${m.label}${m.applicable ? '' : ` _(not available: ${m.gated_reason})_`}`),
  };

  const forbiddenNextActions = buildForbiddenNextActions();

  const envelope: Log10xStartEnvelope = {
    tier,
    siem_detected: siemDetected,
    capability_summary: caps,
    action_menu: menu,
    journey_phases: phases,
    must_render_verbatim: mustRenderVerbatim,
    must_ask_user: mustAskUser,
    forbidden_next_actions: forbiddenNextActions,
    intent_hint: intent,
    ...(lensRes.lensed ? { siem_lens: lensRes.effective ?? undefined, siem_actual: lensRes.actual, siem_lens_basis: lensRes.basis } : {}),
  };

  const headline = `${lensRes.lensed && lensRes.display ? `[lens: ${lensRes.display}] ` : ''}Tier "${tier}". ${menu.filter((m) => m.applicable).length} of ${menu.length} action paths available. Awaiting user pick before any further tool call.`;

  return buildEnvelope({
    tool: 'log10x_start',
    view: 'summary',
    summary: { headline },
    data: envelope,
    actions: [],
  });
}

/** Export so log10x-start.test.ts can call buildActionMenu / buildCapabilities directly. */
export const _internals = {
  resolveTier,
  buildCapabilities,
  buildActionMenu,
  buildJourneyPhases,
  renderVerbatim,
  buildForbiddenNextActions,
};
