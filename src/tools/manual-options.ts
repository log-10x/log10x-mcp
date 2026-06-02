/**
 * log10x_manual_options
 *
 * Sub-menu shown when the customer picks `manual` from log10x_cost_options.
 * Returns three enforcement sub-paths, each gated by the customer's
 * detected capabilities:
 *
 *   1. report_only      — engine marks patterns in metrics; agent shows
 *                         savings potential; no enforcement applied.
 *   2. forwarder_config — agent generates drop config for the detected
 *                         forwarder (fluent-bit / fluentd / otel / vector /
 *                         logstash) for the top N cost patterns; user applies.
 *   3. siem_exclusion   — agent generates native SIEM exclusion configs
 *                         (Splunk props/transforms, Datadog log exclusion
 *                         filter, Elastic ingest pipeline, CloudWatch
 *                         subscription filter); user applies in SIEM UI/API.
 *
 * Gating:
 *   - report_only:      always applicable.
 *   - forwarder_config: requires a detected forwarder (from envs.json,
 *                       LOG10X_FORWARDER env var, or snapshot); gated false
 *                       with a "run log10x_discover_env" hint when absent.
 *   - siem_exclusion:   requires detected SIEM credentials (siem_query_available
 *                       from the capability probes); gated false with a
 *                       "set credentials" hint when absent.
 *
 * forbidden_next_actions: log10x_configure_engine — manual mode means external
 * enforcement; the engine PR path is not applicable here.
 *
 * estimate_savings and pattern_mitigate are NOT forbidden — report_only routes
 * to estimate_savings, and forwarder_config / siem_exclusion route through
 * pattern_mitigate per pattern.
 */

import { z } from 'zod';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { loadEnvironments } from '../lib/environments.js';
import { discoverAvailable } from '../lib/siem/index.js';

// ── Schema ────────────────────────────────────────────────────────────────────

export const manualOptionsSchema = {
  service: z
    .string()
    .optional()
    .describe('Optional service scope. Passed forward to estimate_savings or pattern_mitigate when the user picks a sub-path.'),
  target_percent: z
    .number()
    .min(1)
    .max(95)
    .optional()
    .describe('% reduction goal carried from log10x_cost_options. Pre-filled when the user stated a target.'),
};

// ── Output types ──────────────────────────────────────────────────────────────

export type ManualOptionId = 'report_only' | 'forwarder_config' | 'siem_exclusion';

export interface ManualOptionItem {
  id: ManualOptionId;
  /** Short label rendered to the user. */
  label: string;
  /** One-line mechanism description. */
  description: string;
  /** True when the env supports this sub-path without further setup. */
  applicable: boolean;
  /** When applicable=false, explains what's missing. */
  gated_reason?: string;
  /**
   * Tool + args to call when the user picks this sub-path.
   * null when the routing requires an iteration step that the agent must
   * orchestrate (see routing_instruction for those cases).
   */
  routes_to: { tool: string; args: Record<string, unknown> } | null;
  /**
   * Present when the routing requires multi-step agent orchestration
   * (e.g. call top_patterns first, then iterate pattern_mitigate per row).
   * The agent follows this instruction when routes_to is null.
   */
  routing_instruction?: string;
}

export interface ManualOptionsEnvelope {
  sub_paths: ManualOptionItem[];
  siem_detected: string | null;
  forwarder_detected: string | null;
  must_render_verbatim: string;
  must_ask_user: { question: string; options: string[] };
  forbidden_next_actions: string[];
}

// ── Capability detection ──────────────────────────────────────────────────────

type ForwarderKind =
  | 'fluentbit'
  | 'fluentd'
  | 'filebeat'
  | 'logstash'
  | 'otel-collector'
  | 'vector'
  | 'unknown';

interface ManualCapabilities {
  forwarderKind: ForwarderKind | null;
  siemDetected: string | null;
}

async function detectManualCapabilities(): Promise<ManualCapabilities> {
  let forwarderKind: ForwarderKind | null = null;
  let siemDetected: string | null = null;

  // Source 1: active env (envs.json)
  try {
    const envs = await loadEnvironments();
    const active = envs.lastUsed ?? envs.default;
    if (active?.forwarder && active.forwarder !== 'unknown') {
      forwarderKind = active.forwarder as ForwarderKind;
    }
    if (active?.analyzer) {
      // Treat a known analyzer as SIEM query available even without live cred
      // probe — same heuristic as pattern-mitigate's source 1 path.
    }
  } catch {
    // fall through
  }

  // Source 2: env-var fallback for forwarder
  if (!forwarderKind && process.env.LOG10X_FORWARDER) {
    const raw = process.env.LOG10X_FORWARDER.trim().toLowerCase();
    const map: Record<string, ForwarderKind> = {
      'fluent-bit': 'fluentbit',
      fluentbit: 'fluentbit',
      fluent_bit: 'fluentbit',
      fluentd: 'fluentd',
      'fluent-d': 'fluentd',
      filebeat: 'filebeat',
      beats: 'filebeat',
      logstash: 'logstash',
      otel: 'otel-collector',
      otelcol: 'otel-collector',
      'otel-collector': 'otel-collector',
      'opentelemetry-collector': 'otel-collector',
      vector: 'vector',
    };
    if (map[raw]) {
      forwarderKind = map[raw];
    }
  }

  // Source 3: SIEM probe (live credential detection)
  try {
    const results = await discoverAvailable();
    const hit = results.find((r) => r.detection.available);
    siemDetected = hit ? hit.id : null;
  } catch {
    siemDetected = null;
  }

  return { forwarderKind, siemDetected };
}

// ── Sub-path builders ─────────────────────────────────────────────────────────

function buildReportOnly(
  service: string | undefined,
  targetPercent: number | undefined
): ManualOptionItem {
  return {
    id: 'report_only',
    label: 'Report only',
    description:
      'Engine marks patterns with isDropped=true in metrics but does not enforce any drop. ' +
      'Agent shows what savings would be if you enforced externally.',
    applicable: true,
    routes_to: {
      tool: 'log10x_estimate_savings',
      args: {
        default_action: 'drop',
        enforcement_mode: 'manual_report',
        ...(service !== undefined ? { service } : {}),
        ...(targetPercent !== undefined ? { target_percent: targetPercent } : {}),
      },
    },
  };
}

function buildForwarderConfig(
  caps: ManualCapabilities,
  service: string | undefined
): ManualOptionItem {
  const applicable = caps.forwarderKind !== null;
  const forwarderLabel = caps.forwarderKind
    ? forwarderDisplayName(caps.forwarderKind)
    : '(unknown)';

  return {
    id: 'forwarder_config',
    label: 'Forwarder config',
    description:
      'Agent generates a ready-to-paste drop config for your forwarder ' +
      `(${applicable ? forwarderLabel : 'fluent-bit / fluentd / otel / vector / logstash'}) ` +
      'for the top N cost patterns. You apply it on your own schedule.',
    applicable,
    gated_reason: applicable
      ? undefined
      : 'No forwarder detected. Run log10x_discover_env to detect it, or set LOG10X_FORWARDER env var (fluent-bit, fluentd, otel-collector, vector, logstash, filebeat).',
    routes_to: null,
    routing_instruction: applicable
      ? `Call log10x_top_patterns${service ? ` with service=${service}` : ''} to get the top N cost patterns, then iterate log10x_pattern_mitigate for each pattern${service ? ` (with service=${service})` : ''} to generate the drop config for the detected forwarder (${forwarderLabel}).`
      : undefined,
  };
}

function buildSiemExclusion(
  caps: ManualCapabilities,
  service: string | undefined
): ManualOptionItem {
  const applicable = caps.siemDetected !== null;

  return {
    id: 'siem_exclusion',
    label: 'SIEM exclusion',
    description:
      'Agent generates native SIEM exclusion configs ' +
      `(${applicable ? siemExclusionLabel(caps.siemDetected!) : 'Splunk props/transforms, Datadog log exclusion filter, Elastic ingest pipeline, CloudWatch subscription filter'}) ` +
      'for the top N cost patterns. You apply them in your analyzer\'s UI or API.',
    applicable,
    gated_reason: applicable
      ? undefined
      : 'No SIEM credentials detected. Set credentials (DD_API_KEY, SPLUNK_TOKEN, ELASTIC_API_KEY, etc.) so the agent can generate native exclusion configs.',
    routes_to: null,
    routing_instruction: applicable
      ? `Call log10x_top_patterns${service ? ` with service=${service}` : ''} to get the top N cost patterns, then iterate log10x_pattern_mitigate for each pattern${service ? ` (with service=${service})` : ''} to generate native ${siemExclusionLabel(caps.siemDetected!)} exclusion configs.`
      : undefined,
  };
}

function forwarderDisplayName(kind: ForwarderKind): string {
  const map: Record<ForwarderKind, string> = {
    fluentbit: 'fluent-bit',
    fluentd: 'fluentd',
    filebeat: 'filebeat',
    logstash: 'logstash',
    'otel-collector': 'otel-collector',
    vector: 'vector',
    unknown: 'unknown forwarder',
  };
  return map[kind] ?? kind;
}

function siemExclusionLabel(siem: string): string {
  const map: Record<string, string> = {
    splunk: 'Splunk props/transforms',
    datadog: 'Datadog log exclusion filter',
    elasticsearch: 'Elastic ingest pipeline',
    cloudwatch: 'CloudWatch subscription filter',
    'azure-monitor': 'Azure Monitor diagnostic settings',
    'gcp-logging': 'GCP Logging exclusion filter',
    sumo: 'Sumo Logic field extraction rule',
  };
  return map[siem] ?? `${siem} exclusion config`;
}

// ── must_render_verbatim renderer ─────────────────────────────────────────────

function renderManualVerbatim(items: ManualOptionItem[]): string {
  const lines = items.map((item, i) => {
    const gateNote = item.applicable ? '' : `  _(not available: ${item.gated_reason})_`;
    return `  ${i + 1}. **${item.label}** — ${item.description}${gateNote}`;
  });

  return [
    `### Manual mode — three paths`,
    ``,
    `You keep control of enforcement. Pick how you want the agent to help:`,
    ``,
    ...lines,
    ``,
    `_(Pick a number.)_`,
  ].join('\n');
}

// ── Entry function ────────────────────────────────────────────────────────────

export async function executeManualOptions(args: {
  service?: string;
  target_percent?: number;
}): Promise<StructuredOutput> {
  const { service, target_percent } = args;

  const caps = await detectManualCapabilities();

  const subPaths: ManualOptionItem[] = [
    buildReportOnly(service, target_percent),
    buildForwarderConfig(caps, service),
    buildSiemExclusion(caps, service),
  ];

  const mustRenderVerbatim = renderManualVerbatim(subPaths);

  const mustAskUser = {
    question:
      'Which manual path do you want? Pick a number before I call any tool.',
    options: subPaths.map((p, i) => `${i + 1}. ${p.label}`),
  };

  const forbiddenNextActions = ['log10x_configure_engine'];

  const envelope: ManualOptionsEnvelope = {
    sub_paths: subPaths,
    siem_detected: caps.siemDetected,
    forwarder_detected: caps.forwarderKind,
    must_render_verbatim: mustRenderVerbatim,
    must_ask_user: mustAskUser,
    forbidden_next_actions: forbiddenNextActions,
  };

  const applicableCount = subPaths.filter((p) => p.applicable).length;
  const headline = `Manual mode — ${applicableCount} of ${subPaths.length} sub-paths available without further setup. Awaiting user pick before any tool call.`;

  return buildEnvelope({
    tool: 'log10x_manual_options',
    view: 'summary',
    summary: { headline },
    data: envelope,
    actions: [],
  });
}
