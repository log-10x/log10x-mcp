/**
 * log10x_pattern_mitigate
 *
 * Single user-facing entry point for "this pattern costs too much, what
 * are my options". Replaces the prior split where the user had to know
 * the difference between an exclusion filter, a forwarder drop, a 10x
 * mute PR, and a 10x compact PR — each exposed via a different tool.
 *
 * The tool:
 *   1. Reads env capability (receiver deployed? retriever deployed?
 *      GitOps repo configured?) from the active env's config + an
 *      optional snapshot.
 *   2. Renders a four-option menu in user terms (drop @ analyzer / drop
 *      @ forwarder / mute @ 10x / compact @ 10x), DIMMING options that
 *      aren't available in this env so the user never picks a path that
 *      requires infra they don't have.
 *   3. Emits structured NEXT_ACTIONS pointing at the right sub-tool for
 *      each option, so the agent can route on the user's choice in one
 *      hop.
 *   4. Always lists log10x_dependency_check as a required pre-action for
 *      the drop/mute options — keeps the deterministic safety gate
 *      enforced.
 *
 * Discoverability surface:
 *   - top_patterns / cost_drivers / event_lookup already point users at
 *     mitigation paths via their agent-only NEXT_ACTIONS. Those routes
 *     get updated to point at THIS tool, not directly at exclusion_filter.
 *   - System-prompt rule (separately): when a cost-bearing tool surfaces
 *     a pattern and the user's framing is cost-related, the agent should
 *     proactively offer "want me to show you options for reducing this?"
 *     — and call this tool when they say yes.
 */

import { z } from 'zod';
import { getSnapshot } from '../lib/discovery/snapshot-store.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { loadEnvironments } from '../lib/environments.js';
import { agentOnly } from '../lib/agent-only.js';
import { fmtPattern, normalizePattern } from '../lib/format.js';
import type { PrimitiveError } from '../lib/primitive-errors.js';
import { resolveSiemSelection } from '../lib/siem/resolve.js';
import { getConnector } from '../lib/siem/index.js';
import { probeReceiverInPath, eventHasTenxHash } from '../lib/receiver-probe.js';

export const patternMitigateSchema = {
  pattern: z
    .string()
    .min(1)
    .describe('The pattern identity to mitigate. Pass the canonical name from a prior log10x_top_patterns / log10x_cost_drivers / log10x_event_lookup row.'),
  service: z
    .string()
    .optional()
    .describe('Optional service scope. When set, options that target a single service (forwarder drop, exclusion filter) are scoped to it.'),
  snapshot_id: z
    .string()
    .optional()
    .describe('Snapshot from log10x_discover_env. Used to detect which 10x components are deployed in the active env (receiver, retriever, GitOps wiring). When passed, the envelope\'s `recommendation_audit.capability_sources` reflects which capabilities came from the snapshot vs envs.json. Without it, the tool still works but may dim PR-based options if the active env\'s envs.json does not list a gitops repo.'),
};

export interface PatternMitigateArgs {
  pattern: string;
  service?: string;
  snapshot_id?: string;
}

/**
 * Top-level call status. Agent branches on this BEFORE reading the menu.
 *   - `success`: ≥1 mitigation option is enabled and routable.
 *   - `no_signal`: pattern is valid but NO option crossed the capability
 *     gate. Setup hint surfaces what's missing.
 *   - `insufficient_data`: pattern arg failed validation.
 *   - `error`: structural failure (env-load crashed, snapshot fetch
 *     errored, etc.).
 */
export type PatternMitigateStatus = 'success' | 'no_signal' | 'insufficient_data' | 'error';

/**
 * Where the capability-detection facts came from. Same role as
 * `threshold_basis` in the cross-pillar tools — surfaces the
 * provenance the agent's decision is downstream of.
 */
export type RecommendationBasis =
  | 'env_config'        // envs.json provided the capabilities
  | 'snapshot'          // a passed snapshot_id provided them
  | 'env_config_plus_snapshot'
  | 'env_vars_only'     // no envs.json, no snapshot — only $LOG10X_* env vars
  | 'unknown';          // no source resolved any capability

interface CapabilitySources {
  gitops: 'envs_json' | 'env_var' | 'snapshot' | 'absent';
  forwarder: 'envs_json' | 'env_var' | 'snapshot' | 'absent';
  analyzer: 'envs_json' | 'env_var' | 'snapshot' | 'siem_probe' | 'absent';
  receiver: 'snapshot' | 'absent';
  retriever: 'snapshot' | 'absent';
  receiver_in_path: 'snapshot' | 'siem_probe' | 'absent';
}

interface RecommendationAudit {
  basis: RecommendationBasis;
  n_options_enabled: number;
  n_options_dimmed: number;
  capability_sources: CapabilitySources;
  snapshot_id?: string;
  snapshot_age_seconds: number | null;
}

interface Capabilities {
  /** Receiver pod was discovered (snapshot has a receiver app) OR the active env has a gitops repo. Either way, the mute/compact PR options are reachable. */
  canMute: boolean;
  canCompact: boolean;
  /**
   * Whether the Receiver is confirmed to be in-path (stamping tenx_hash on every event).
   * Options 1 (drop at analyzer) and 2 (drop at forwarder) key on tenx_hash — they are
   * silently ineffective without the Receiver. When false, those options are dimmed.
   */
  receiverInPath: boolean;
  /**
   * When true, receiver_in_path could not be confirmed from any available
   * source (no snapshot passed, SIEM probe unavailable or failed). Used to
   * distinguish "confirmed absent" from "unconfirmed" so disabled_reason
   * copy gives the right instruction.
   */
  receiverInPathUnknown: boolean;
  /** Retriever was discovered — muted events would land in S3 archive recoverably. */
  hasRetrieverArchive: boolean;
  /** Source of the gitops_repo, if any. Used in the rendered explanation so the user understands where the PR will be opened. */
  gitopsRepo?: string;
  gitopsSource?: 'envs.json' | 'snapshot' | 'env-var';
  /**
   * Detected forwarder kind from the snapshot's `existingForwarder` (set by
   * `classifyForwarderImage` against the cluster's running pods). When set,
   * option 2's vendor is pre-filled. When undefined, the menu acknowledges
   * the gap explicitly so the agent asks rather than guessing fluent-bit.
   */
  forwarderKind?: 'fluentbit' | 'fluentd' | 'filebeat' | 'logstash' | 'otel-collector' | 'vector' | 'unknown';
  /**
   * Detected analyzer vendor — from envs.json, LOG10X_ANALYZER env var,
   * or the user profile's `metadata.analyzer_vendor`. Used to render
   * option 1 with the actual analyzer name and to pre-fill the
   * exclusion_filter `vendor` arg. Loose string because the mitigate
   * menu must support analyzers that exclusion_filter doesn't yet
   * generate native configs for (NewRelic, Dynatrace, etc.); the agent
   * tells the user to apply manually in that case.
   */
  analyzerVendor?: string;
  /** Setup hint text when canMute/canCompact are false, explaining what's missing. */
  setupHint?: string;
  /** Per-field provenance, populated as capabilities are resolved. */
  sources: CapabilitySources;
  /** Snapshot ID used (if any) and its observed age in seconds at lookup. */
  snapshotIdUsed?: string;
  snapshotAgeSeconds: number | null;
}

/**
 * Returns the disabled-reason copy for options that require the Receiver
 * in-path. Two states:
 *   - unknown: no snapshot was passed and the SIEM probe was unavailable
 *     or inconclusive — the Receiver may be deployed but we could not
 *     confirm. The instruction is to run discover_env or set the flag.
 *   - confirmed-absent: all available detection paths returned false.
 *     The instruction is to install the Receiver first.
 */
function receiverRequiredProse(unknown: boolean): string {
  if (unknown) {
    return (
      'Receiver not detected in-path. Drop rules key on the tenx_hash field, which the ' +
      'Receiver stamps on events flowing to the log analyzer. Run log10x_discover_env to confirm ' +
      'the Receiver pod is present, or set receiver_in_path=true in your envs.json entry if you ' +
      'know it is deployed.'
    );
  }
  return (
    'Receiver not detected in-path. Drop rules key on the tenx_hash field, which the ' +
    'Receiver stamps on events flowing to the log analyzer. Run log10x_discover_env to confirm ' +
    'the Receiver pod is present, or set receiver_in_path=true in your envs.json entry if you ' +
    'know it is deployed.'
  );
}

// detectReceiverViaSampleEvent and eventHasTenxHash have been extracted to
// src/lib/receiver-probe.ts so discover_env can reuse the same probe logic.
// The aliases below keep the call sites in detectCapabilities unchanged.
const detectReceiverViaSampleEvent = probeReceiverInPath;
// eventHasTenxHash is re-exported from receiver-probe and imported above.

/**
 * SIEM vendors the exclusion_filter tool can generate native configs for.
 * Anything outside this set still gets named in option 1's prose but is
 * flagged as "apply manually via the analyzer UI".
 */
const NATIVE_EXCLUSION_VENDORS = new Set(['datadog', 'splunk', 'elasticsearch', 'cloudwatch']);

const ANALYZER_DISPLAY: Record<string, string> = {
  datadog: 'Datadog',
  splunk: 'Splunk',
  'splunk-obs': 'Splunk Observability',
  elasticsearch: 'Elasticsearch',
  opensearch: 'OpenSearch',
  cloudwatch: 'AWS CloudWatch',
  'azure-monitor': 'Azure Monitor / Log Analytics',
  'new-relic': 'New Relic',
  'gcp-logging': 'Google Cloud Logging',
  dynatrace: 'Dynatrace',
  sumo: 'Sumo Logic',
  'grafana-loki': 'Grafana Loki',
  coralogix: 'Coralogix',
  logzio: 'Logz.io',
  crowdstrike: 'CrowdStrike Falcon LogScale',
  victorialogs: 'VictoriaLogs',
};

function analyzerLabel(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return ANALYZER_DISPLAY[token] ?? token;
}

async function detectCapabilities(snapshotId?: string): Promise<Capabilities> {
  const out: Capabilities = {
    canMute: false,
    canCompact: false,
    receiverInPath: false,
    receiverInPathUnknown: false,
    hasRetrieverArchive: false,
    sources: {
      gitops: 'absent',
      forwarder: 'absent',
      analyzer: 'absent',
      receiver: 'absent',
      retriever: 'absent',
      receiver_in_path: 'absent',
    },
    snapshotAgeSeconds: null,
  };

  // Source 1: active env's gitops field + forwarder field (envs.json).
  // Wins over later sources because envs.json is user-declared per-env config.
  try {
    const envs = await loadEnvironments();
    const active = envs.lastUsed ?? envs.default;
    if (active?.gitops?.repo) {
      out.gitopsRepo = active.gitops.repo;
      out.gitopsSource = 'envs.json';
      out.sources.gitops = 'envs_json';
      out.canMute = true;
      out.canCompact = true;
    }
    if (active?.forwarder && active.forwarder !== 'unknown') {
      out.forwarderKind = active.forwarder;
      out.sources.forwarder = 'envs_json';
    }
    if (active?.analyzer) {
      out.analyzerVendor = active.analyzer;
      out.sources.analyzer = 'envs_json';
    }
  } catch {
    // ignore; fall through to env-var / snapshot
  }

  // Source 2: env-var fallbacks. Read directly because in demo-mode or
  // when no LOG10X_METRICS_* is set, env vars don't propagate through
  // `loadEnvironments` to an EnvConfig. This direct read is the
  // "no-other-config" path that still lets the user supply config.
  if (!out.gitopsRepo && process.env.LOG10X_GH_REPO) {
    out.gitopsRepo = process.env.LOG10X_GH_REPO;
    out.gitopsSource = 'env-var';
    out.sources.gitops = 'env_var';
    out.canMute = true;
    out.canCompact = true;
  }
  if (!out.forwarderKind && process.env.LOG10X_FORWARDER) {
    // Reuse the same parser the env-loader uses so aliases like
    // "fluent-bit", "otel", "beats" normalize identically.
    const raw = process.env.LOG10X_FORWARDER.trim().toLowerCase();
    const map: Record<string, Capabilities['forwarderKind']> = {
      'fluent-bit': 'fluentbit', fluentbit: 'fluentbit', fluent_bit: 'fluentbit',
      fluentd: 'fluentd', 'fluent-d': 'fluentd',
      filebeat: 'filebeat', beats: 'filebeat',
      logstash: 'logstash',
      otel: 'otel-collector', otelcol: 'otel-collector',
      'otel-collector': 'otel-collector', 'opentelemetry-collector': 'otel-collector',
      vector: 'vector',
    };
    if (map[raw]) {
      out.forwarderKind = map[raw];
      out.sources.forwarder = 'env_var';
    }
  }
  if (!out.analyzerVendor && process.env.LOG10X_ANALYZER) {
    // Same alias normalization as env-loader's parseAnalyzerEnv. Inline
    // copy keeps the file self-contained without a cross-module import.
    const s = process.env.LOG10X_ANALYZER.trim().toLowerCase();
    const aliases: Record<string, string> = {
      datadog: 'datadog', dd: 'datadog',
      splunk: 'splunk', 'splunk enterprise': 'splunk',
      'splunk observability': 'splunk-obs', 'splunk-obs': 'splunk-obs', signalfx: 'splunk-obs',
      elasticsearch: 'elasticsearch', elastic: 'elasticsearch', kibana: 'elasticsearch', elk: 'elasticsearch',
      opensearch: 'opensearch',
      cloudwatch: 'cloudwatch', cw: 'cloudwatch', 'aws cloudwatch': 'cloudwatch', 'cloudwatch logs': 'cloudwatch',
      azure: 'azure-monitor', 'azure monitor': 'azure-monitor', 'azure-monitor': 'azure-monitor', 'log analytics': 'azure-monitor', sentinel: 'azure-monitor',
      'new relic': 'new-relic', newrelic: 'new-relic', nr: 'new-relic',
      gcp: 'gcp-logging', 'gcp logging': 'gcp-logging', 'google cloud': 'gcp-logging', 'google cloud logging': 'gcp-logging', stackdriver: 'gcp-logging',
      dynatrace: 'dynatrace', dt: 'dynatrace',
      sumo: 'sumo', 'sumo logic': 'sumo', sumologic: 'sumo',
      grafana: 'grafana-loki', loki: 'grafana-loki', 'grafana loki': 'grafana-loki',
      coralogix: 'coralogix',
      logzio: 'logzio', 'logz.io': 'logzio', logz: 'logzio',
      crowdstrike: 'crowdstrike', 'crowdstrike falcon': 'crowdstrike', 'falcon logscale': 'crowdstrike', humio: 'crowdstrike',
      victorialogs: 'victorialogs', 'victoria logs': 'victorialogs', vlog: 'victorialogs', vlogs: 'victorialogs',
    };
    out.analyzerVendor = aliases[s] ?? process.env.LOG10X_ANALYZER.trim();
    out.sources.analyzer = 'env_var';
  }

  // Source 3: snapshot from kubectl discovery. Fills in retriever-archive
  // detection always; only sets gitopsRepo if the env-side sources above
  // didn't already provide one.
  if (snapshotId) {
    const snap = getSnapshot(snapshotId);
    if (snap) {
      out.snapshotIdUsed = snapshotId;
      // Compute snapshot age if the snapshot carries a createdAt timestamp.
      const createdAt = (snap as { createdAt?: number; created_at?: number }).createdAt
        ?? (snap as { createdAt?: number; created_at?: number }).created_at;
      if (typeof createdAt === 'number' && Number.isFinite(createdAt)) {
        out.snapshotAgeSeconds = Math.max(0, Math.floor(Date.now() / 1000 - createdAt));
      }
      if (!out.gitopsRepo && snap.recommendations.receiverGitopsRepo) {
        out.gitopsRepo = snap.recommendations.receiverGitopsRepo;
        out.gitopsSource = 'snapshot';
        out.sources.gitops = 'snapshot';
        out.canMute = true;
        out.canCompact = true;
      }
      // Receiver presence: a snapshot with a receiverGitopsRepo means
      // there's a receiver pod the GitOps PR will target.
      if (snap.recommendations.receiverGitopsRepo) {
        out.sources.receiver = 'snapshot';
        // Receiver is in-path when the snapshot discovered it as a running pod.
        out.receiverInPath = true;
        out.sources.receiver_in_path = 'snapshot';
      }
      // Retriever presence: a snapshot retains the bucket name when a
      // retriever app was discovered with an S3-target env var.
      if (snap.recommendations.retrieverS3Bucket) {
        out.hasRetrieverArchive = true;
        out.sources.retriever = 'snapshot';
      }
      // Forwarder kind. `existingForwarder` is set by the discovery code's
      // `classifyForwarderImage` against running pods in the cluster.
      // Possible values: fluentbit / fluentd / filebeat / logstash /
      // otel-collector / unknown. Only fill in if a higher-priority
      // source (envs.json or env-var) didn't already declare one — those
      // are user-explicit and should win.
      if (!out.forwarderKind && snap.recommendations.existingForwarder) {
        out.forwarderKind = snap.recommendations.existingForwarder;
        out.sources.forwarder = 'snapshot';
      }
    }
  }

  // Source 4: SIEM credential probe.
  // (a) Fix C — reconcile analyzerVendor against what connector actually has
  //     credentials, because the config stack (envs.json / env-var / profile
  //     metadata) may be stale (e.g. still says 'splunk' when CloudWatch is
  //     now the live destination).
  // (b) Fix A — probe 1–3 recent events for tenx_hash presence. A hit is
  //     direct evidence the Receiver is in-path and stamping events.
  //     Only run when receiverInPath is still false (no snapshot or env
  //     evidence already confirmed it).
  try {
    const PROBE_VENDORS = ['datadog', 'splunk', 'elasticsearch', 'cloudwatch'] as const;
    const siemResolution = await resolveSiemSelection({
      restrictTo: [...PROBE_VENDORS],
    });
    if (siemResolution.kind === 'resolved') {
      const resolvedVendor = siemResolution.id;

      // Fix C: if config stack says one vendor but credentials only exist for
      // another, prefer the connector result (it reflects what's actually
      // being queried right now).
      if (out.analyzerVendor && out.analyzerVendor !== resolvedVendor) {
        // Config-stack vendor differs from what has live credentials. Override
        // with the live-credential vendor so option-1 prose and disabled_reason
        // copy name the correct analyzer.
        out.analyzerVendor = resolvedVendor;
        out.sources.analyzer = 'siem_probe';
      } else if (!out.analyzerVendor) {
        out.analyzerVendor = resolvedVendor;
        out.sources.analyzer = 'siem_probe';
      }

      // Fix A: probe for tenx_hash in recent events when receiver_in_path is
      // still undetermined from config / snapshot.
      if (!out.receiverInPath) {
        const connector = getConnector(resolvedVendor);
        const probeResult = await detectReceiverViaSampleEvent(resolvedVendor, connector);
        if (probeResult === true) {
          out.receiverInPath = true;
          out.receiverInPathUnknown = false;
          out.sources.receiver_in_path = 'siem_probe';
        } else if (probeResult === null) {
          // SIEM probe was inconclusive — no events in window or connector
          // error. Mark as unknown so disabled_reason copy gives the right
          // instruction (run discover_env) rather than "install first".
          out.receiverInPathUnknown = true;
        }
        // probeResult === false: no hash in sample, leave receiverInPath=false
        // and receiverInPathUnknown=false (confirmed absent).
      }
    } else if (siemResolution.kind === 'none') {
      // No SIEM credentials at all — receiver_in_path cannot be determined.
      if (!out.receiverInPath) {
        out.receiverInPathUnknown = true;
      }
    }
    // 'ambiguous': multiple SIEMs with credentials — don't guess which to probe.
    // Leave receiverInPathUnknown=false and receiverInPath=false (conservative).
  } catch {
    // SIEM probe failure — unknown, not absent.
    if (!out.receiverInPath) {
      out.receiverInPathUnknown = true;
    }
  }

  if (!out.canMute && !out.canCompact) {
    out.setupHint =
      'To enable mute/compact at the 10x engine, set `gitops.repo` (owner/name) in your `~/.log10x/envs.json` entry — or export `LOG10X_GH_REPO=<owner/name>` — or pass a `snapshot_id` from `log10x_discover_env` against a cluster with a receiver pod that has `GH_ENABLED=true` + `GH_REPO=<owner/name>` set.';
  }

  return out;
}

interface PatternMitigateSummary {
  status: PatternMitigateStatus;
  recommendation_basis: RecommendationBasis;
  recommendation_audit: RecommendationAudit;
  pattern_ref: string;
  query_count: 0;
  total_latency_ms: number;
  backend_pressure_hint: null;
  human_summary: string;
  pattern: string;
  scope_service?: string;
  options: Array<{
    id: 'drop_at_analyzer' | 'drop_at_forwarder' | 'mute_at_10x' | 'compact_at_10x';
    enabled: boolean;
    disabled_reason?: string;
    label: string;
  }>;
  env_capabilities: {
    can_mute: boolean;
    can_compact: boolean;
    receiver_in_path: boolean;
    /** True when receiver_in_path=false but could not be confirmed absent (no snapshot, SIEM probe inconclusive). */
    receiver_in_path_unknown: boolean;
    has_retriever_archive: boolean;
    forwarder_kind?: string;
    analyzer_vendor?: string;
    gitops_repo?: string;
  };
  /** Populated only when `status === 'error'`. */
  error?: PrimitiveError;
}

/**
 * Derive the recommendation_basis from per-capability sources. Reflects
 * the dominant source: snapshot if any capability came from it, else
 * env_config if any came from envs.json, else env_vars_only, else unknown.
 */
function deriveBasis(sources: CapabilitySources): RecommendationBasis {
  const hasEnvJson = Object.values(sources).some((s) => s === 'envs_json');
  const hasSnapshot = Object.values(sources).some((s) => s === 'snapshot');
  const hasEnvVar = Object.values(sources).some((s) => s === 'env_var');
  if (hasEnvJson && hasSnapshot) return 'env_config_plus_snapshot';
  if (hasEnvJson) return 'env_config';
  if (hasSnapshot) return 'snapshot';
  if (hasEnvVar) return 'env_vars_only';
  return 'unknown';
}

export async function executePatternMitigate(args: PatternMitigateArgs): Promise<import('../lib/output-types.js').StructuredOutput> {
  const startedAt = Date.now();
  const { buildEnvelope } = await import('../lib/output-types.js');

  // ── Input validation ───────────────────────────────────────────────
  if (!args.pattern || args.pattern.trim().length === 0) {
    return await errorEnvelope({
      startedAt,
      pattern: (args.pattern ?? '').trim(),
      err: {
        error_type: 'input_invalid',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'pattern argument required (canonical pattern name from a prior cost / triage tool).',
      },
    });
  }

  const sumOut: { data?: PatternMitigateSummary } = {};
  try {
    await executePatternMitigateInner(args, sumOut, startedAt);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return await errorEnvelope({
      startedAt,
      pattern: args.pattern,
      err: {
        error_type: 'local_processing_failed',
        retryable: false,
        suggested_backoff_ms: null,
        hint: msg.slice(0, 300),
      },
    });
  }

  if (!sumOut.data) {
    return await errorEnvelope({
      startedAt,
      pattern: args.pattern,
      err: {
        error_type: 'local_processing_failed',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'pattern_mitigate inner pass produced no structured data.',
      },
    });
  }
  const d = sumOut.data;
  const enabledCount = d.options.filter((o) => o.enabled).length;
  const dimmedCount = d.options.length - enabledCount;
  const headline =
    d.status === 'no_signal'
      ? `\`${d.pattern}\`: NO mitigation options available — ${dimmedCount} dimmed. Setup hint surfaces what's missing.`
      : `\`${d.pattern}\`: ${enabledCount} of ${d.options.length} mitigation options enabled (${d.options.filter((o) => o.enabled).map((o) => o.id).join(', ')}).`;

  // Fix D: populate actions[] with structured follow-up nudges so agent
  // chains can pick them up without parsing human_summary text.
  const envelopeActions: import('../lib/output-types.js').Action[] = [];

  // When gitops_repo is not set, mute/compact are disabled — nudge configure_env.
  if (!d.env_capabilities.gitops_repo) {
    envelopeActions.push({
      tool: 'log10x_configure_env',
      args: {},
      role: 'recommended-next',
      reason: 'Set gitops.repo to enable mute/compact at the 10x engine.',
    });
  }

  // When receiver_in_path is false and either unknown or unconfirmed,
  // nudge discover_env so it can probe the cluster and resolve the gap.
  // When gitops_repo is already set (canMute=true), treat discover_env as
  // optional-followup (the user can mute already). Otherwise recommend-next
  // so chains know to run discovery before concluding options 1 and 2 are
  // blocked.
  if (!d.env_capabilities.receiver_in_path) {
    envelopeActions.push({
      tool: 'log10x_discover_env',
      args: {},
      role: d.env_capabilities.gitops_repo ? 'optional-followup' : 'recommended-next',
      reason: d.env_capabilities.receiver_in_path_unknown
        ? 'Receiver in-path status is unconfirmed. Run discover_env to probe the cluster and confirm Receiver pod presence.'
        : 'Receiver not detected. Run discover_env to check whether a Receiver pod is deployed and in-path.',
    });
  }

  // When at least one mitigation option is enabled, surface the cost_options
  // action menu so agent chains can proceed to configure an action without
  // parsing the human_summary text.
  const anyEnabled = d.options.some((o) => o.enabled);
  if (anyEnabled) {
    envelopeActions.push({
      tool: 'log10x_cost_options',
      args: { pattern: d.pattern },
      reason: 'One or more mitigation tiers are reachable. cost_options surfaces the WHAT-action menu (drop/sample/compact/tier_down/offload/observe_only).',
      role: 'recommended-next',
    });
  }

  return buildEnvelope({
    tool: 'log10x_pattern_mitigate',
    view: 'summary',
    summary: { headline },
    data: d,
    actions: envelopeActions.length > 0 ? envelopeActions : undefined,
  });
}

async function errorEnvelope(args: {
  startedAt: number;
  pattern: string;
  err: PrimitiveError;
}): Promise<import('../lib/output-types.js').StructuredOutput> {
  const { buildEnvelope } = await import('../lib/output-types.js');
  const data: PatternMitigateSummary = {
    status: 'error',
    recommendation_basis: 'unknown',
    recommendation_audit: {
      basis: 'unknown',
      n_options_enabled: 0,
      n_options_dimmed: 0,
      capability_sources: {
        gitops: 'absent',
        forwarder: 'absent',
        analyzer: 'absent',
        receiver: 'absent',
        retriever: 'absent',
        receiver_in_path: 'absent',
      },
      snapshot_age_seconds: null,
    },
    pattern_ref: args.pattern,
    query_count: 0,
    total_latency_ms: Date.now() - args.startedAt,
    backend_pressure_hint: null,
    human_summary: `pattern_mitigate failed: ${args.err.hint}`,
    pattern: args.pattern,
    options: [],
    env_capabilities: {
      can_mute: false,
      can_compact: false,
      receiver_in_path: false,
      receiver_in_path_unknown: false,
      has_retriever_archive: false,
    },
    error: args.err,
  };
  return buildEnvelope({
    tool: 'log10x_pattern_mitigate',
    view: 'summary',
    summary: { headline: `Error (${args.err.error_type}): ${args.err.hint.slice(0, 120)}` },
    data,
  });
}

async function executePatternMitigateInner(
  args: PatternMitigateArgs,
  sumOut?: { data?: PatternMitigateSummary },
  startedAt: number = Date.now(),
): Promise<string> {
  const pattern = normalizePattern(args.pattern);
  const displayPattern = fmtPattern(pattern);
  const scopeNote = args.service ? ` (service: ${args.service})` : '';

  const caps = await detectCapabilities(args.snapshot_id);

  const lines: string[] = [];
  lines.push(`Mitigation options for \`${displayPattern}\`${scopeNote}`);
  lines.push('');
  lines.push('Pick one. Each option trades off speed-to-effect, where in the pipeline it cuts, and what happens to your data.');
  lines.push('');

  // Option 1 — SIEM-side. Gated on Receiver being in-path (tenx_hash stamp required).
  const analyzerName = analyzerLabel(caps.analyzerVendor);
  const analyzerSupported = caps.analyzerVendor ? NATIVE_EXCLUSION_VENDORS.has(caps.analyzerVendor) : false;
  if (!caps.receiverInPath) {
    lines.push(
      `**1. Drop it at your analyzer.** _Requires Receiver in-path._ ${receiverRequiredProse(caps.receiverInPathUnknown)}`
    );
  } else if (analyzerName && analyzerSupported) {
    lines.push(
      `**1. Drop it at ${analyzerName}.** Fastest. We generate a ready-to-apply ${analyzerName} exclusion config; you paste it (or apply via API) and the cost stops within minutes. Events still flow through your pipeline up to ${analyzerName} — they just don't get indexed or stored. Easy to undo in the same UI.`
    );
  } else if (analyzerName) {
    lines.push(
      `**1. Drop it at ${analyzerName}.** Fastest. Apply an exclusion in ${analyzerName} and the cost stops within minutes. Events still flow through your pipeline up to ${analyzerName} — they just don't get indexed. Note: log10x_exclusion_filter doesn't yet generate native configs for ${analyzerName} (supports Datadog, Splunk, Elasticsearch, AWS CloudWatch); you'd apply this one manually in the ${analyzerName} UI for now.`
    );
  } else {
    lines.push(
      `**1. Drop it at your analyzer.** Fastest. Save a config in your log analyzer and the cost stops within minutes. Events still flow through your pipeline up to the analyzer — they just don't get indexed or stored. We could not auto-detect which analyzer you ship to — log10x_exclusion_filter can generate native configs for Datadog, Splunk, Elasticsearch, and AWS CloudWatch. For any other analyzer the agent should ask the user and either generate the config (when supported) or hand-instruct apply (when not).`
    );
  }
  lines.push('');

  // Option 2 — Forwarder-side. Same Receiver gate as option 1.
  const knownForwarder = caps.forwarderKind && caps.forwarderKind !== 'unknown';
  const forwarderLabel: Record<NonNullable<Capabilities['forwarderKind']>, string> = {
    fluentbit: 'Fluent Bit',
    fluentd: 'Fluentd',
    filebeat: 'Filebeat',
    logstash: 'Logstash',
    'otel-collector': 'OpenTelemetry Collector',
    vector: 'Vector',
    unknown: 'forwarder',
  };
  if (!caps.receiverInPath) {
    lines.push(
      `**2. Drop it at your forwarder.** _Requires Receiver in-path._ ${receiverRequiredProse(caps.receiverInPathUnknown)}`
    );
  } else if (knownForwarder) {
    lines.push(
      `**2. Drop it at your forwarder (${forwarderLabel[caps.forwarderKind!]}).** Same idea as option 1 but one step earlier. The events never even leave your environment, so on top of analyzer savings you also save the bandwidth between your forwarder and your analyzer. Requires editing your ${forwarderLabel[caps.forwarderKind!]} config and reloading it (seconds to minutes).`
    );
  } else {
    lines.push(
      '**2. Drop it at your forwarder.** Same idea as option 1 but one step earlier. The events never even leave your environment, so on top of analyzer savings you also save the bandwidth between your forwarder and your analyzer. We could not auto-detect which forwarder you run (no snapshot or no recognized image) — supported: Fluent Bit, Fluentd, Filebeat, Logstash, OpenTelemetry Collector. If you pick option 2 the agent should ask which one and then generate the right config.'
    );
  }
  lines.push('');

  // Option 3 — Mute at 10x edge. Gated on capability.
  if (caps.canMute) {
    const archiveNote = caps.hasRetrieverArchive
      ? 'Your env has the 10x S3 archive enabled, so the muted events are still saved in your own S3 bucket and you can search them later if you need them.'
      : 'Your env does NOT currently have the 10x S3 archive enabled — once muted, events are gone. Add the archive (Retriever) if recoverable history matters.';
    const sourceTag = caps.gitopsSource ? ` (PR target resolved from ${caps.gitopsSource})` : '';
    lines.push(`**3. Mute it inside the 10x engine.** We open a PR against \`${caps.gitopsRepo}\`${sourceTag}, you merge, and the cost stops within minutes of merge. ${archiveNote}`);
  } else {
    lines.push('**3. Mute it inside the 10x engine.** _Not available in this env._ Requires a configured GitOps target (either `gitops.repo` in your envs.json, `LOG10X_GH_REPO` env var, or a discovered receiver pod with `GH_REPO` set).');
  }
  lines.push('');

  // Option 4 — Compact at 10x edge. Same gating as option 3.
  if (caps.canCompact) {
    const sourceTag = caps.gitopsSource ? ` (PR target resolved from ${caps.gitopsSource})` : '';
    lines.push(`**4. Shrink it instead of dropping it.** Same PR + merge flow as option 3, against \`${caps.gitopsRepo}\`${sourceTag}, but the events keep flowing. The 10x engine compresses each one losslessly so it lands at your analyzer typically 5–10× smaller — still fully searchable. Pick this when you actually need the data (compliance, dashboards rely on the raw fields, etc.).`);
  } else {
    lines.push('**4. Shrink it instead of dropping it.** _Not available in this env — same setup as option 3._');
  }
  lines.push('');

  if (caps.setupHint) {
    lines.push(`_To unlock options 3 and 4: ${caps.setupHint}_`);
    lines.push('');
  }

  lines.push('Before any drop is applied, your dependency check has to pass — it\'s the safety gate that confirms no dashboards or alerts depend on this pattern.');
  lines.push('');
  lines.push('Which option do you want?');

  // Structured next-action hints. Always include dependency_check first so
  // the agent treats it as the required precursor. Then one entry per
  // option that's actually available, so when the user picks a number the
  // agent has the right next call ready.
  const nextActions: NextAction[] = [
    {
      tool: 'log10x_dependency_check',
      args: { pattern },
      reason: 'safety gate — verifies no dashboards/alerts/saved-searches depend on the pattern before any drop is applied',
    },
    {
      tool: 'log10x_exclusion_filter',
      args: {
        pattern,
        vendor: analyzerSupported ? caps.analyzerVendor! : 'datadog',
      },
      reason: analyzerSupported
        ? `option 1 — analyzer-side exclusion (auto-detected analyzer: ${caps.analyzerVendor})`
        : caps.analyzerVendor
          ? `option 1 — analyzer-side exclusion (detected analyzer: ${caps.analyzerVendor}, but log10x_exclusion_filter doesn't generate native configs for it; agent should hand-instruct rather than call this entry blindly)`
          : `option 1 — analyzer-side exclusion (vendor unknown; agent should confirm with user before generating config)`,
    },
    {
      tool: 'log10x_exclusion_filter',
      args: { pattern, vendor: knownForwarder ? caps.forwarderKind! : 'fluentbit' },
      reason: knownForwarder
        ? `option 2 — forwarder-side drop (auto-detected forwarder: ${caps.forwarderKind})`
        : 'option 2 — forwarder-side drop (forwarder unknown; agent should confirm with user before generating config)',
    },
  ];
  if (caps.canMute) {
    nextActions.push({
      tool: 'log10x_advise_install',
      args: { pattern, ...(caps.gitopsRepo ? { gitops_repo: caps.gitopsRepo } : {}) },
      reason: 'option 3 — generate the GitOps PR diff for muting at the 10x receiver',
    });
  }
  if (caps.canCompact) {
    nextActions.push({
      tool: 'log10x_configure_engine',
      args: { service: pattern, ...(caps.gitopsRepo ? { gitops_repo: caps.gitopsRepo } : {}) },
      reason: 'option 4 — author the per-pattern action-plan PR (compact / sample / drop / tier_down) against the gitops repo',
    });
  }

  lines.push('');
  lines.push(agentOnly(
    `Routing constraint: do not call any drop/mute/compact sub-tool until the user picks an option. ` +
    `When they do, route option 1 → log10x_exclusion_filter with their analyzer vendor; option 2 → same tool with their forwarder vendor; ` +
    `option 3 → log10x_advise_install; option 4 → log10x_configure_engine. ` +
    `For options 1 and 3, call log10x_dependency_check first and present its findings before generating the drop config. ` +
    `log10x_exclusion_filter emits an exact tenx_hash drop as the primary config (precise, collision-proof) for structured-field vendors when the env's pipeline carries tenx_hash, with the message-regex form as fallback; the raw-line forwarders rsyslog/syslog-ng/promtail have no structured field so they keep the regex form. For options 1/2 on structured vendors, frame it as a precise drop, not an approximate regex match.` +
    (caps.gitopsRepo ? ` Resolved gitops_repo: ${caps.gitopsRepo} (source: ${caps.gitopsSource}).` : '')
  ));
  lines.push('');
  lines.push(renderNextActions(nextActions));

  // Populate the typed summary the agent reads.
  if (sumOut) {
    const options: PatternMitigateSummary['options'] = [
      {
        id: 'drop_at_analyzer',
        enabled: caps.receiverInPath && analyzerSupported,
        disabled_reason: !caps.receiverInPath
          ? receiverRequiredProse(caps.receiverInPathUnknown)
          : analyzerSupported ? undefined : `Native exclusion config not generated for ${analyzerName ?? 'unknown analyzer'} (manual apply required).`,
        label: `Drop at ${analyzerName ?? 'analyzer'}`,
      },
      {
        id: 'drop_at_forwarder',
        enabled: caps.receiverInPath && Boolean(caps.forwarderKind && caps.forwarderKind !== 'unknown'),
        disabled_reason: !caps.receiverInPath
          ? receiverRequiredProse(caps.receiverInPathUnknown)
          : (caps.forwarderKind && caps.forwarderKind !== 'unknown') ? undefined : 'forwarder not detected from env / snapshot',
        label: `Drop at ${caps.forwarderKind ?? 'forwarder'}`,
      },
      {
        id: 'mute_at_10x',
        enabled: caps.canMute,
        disabled_reason: caps.canMute ? undefined : caps.setupHint ?? 'no 10x receiver detected',
        label: 'Mute at 10x receiver',
      },
      {
        id: 'compact_at_10x',
        enabled: caps.canCompact,
        disabled_reason: caps.canCompact ? undefined : caps.setupHint ?? 'no 10x receiver detected',
        label: 'Compact at 10x receiver',
      },
    ];
    const nEnabled = options.filter((o) => o.enabled).length;
    const nDimmed = options.length - nEnabled;
    const basis = deriveBasis(caps.sources);
    const status: PatternMitigateStatus = nEnabled === 0 ? 'no_signal' : 'success';
    const human_summary = buildHumanSummary({
      pattern: displayPattern,
      status,
      basis,
      nEnabled,
      nDimmed,
      options,
      setupHint: caps.setupHint,
      snapshotAgeSeconds: caps.snapshotAgeSeconds,
    });
    sumOut.data = {
      status,
      recommendation_basis: basis,
      recommendation_audit: {
        basis,
        n_options_enabled: nEnabled,
        n_options_dimmed: nDimmed,
        capability_sources: caps.sources,
        snapshot_id: caps.snapshotIdUsed,
        snapshot_age_seconds: caps.snapshotAgeSeconds,
      },
      pattern_ref: pattern,
      query_count: 0,
      total_latency_ms: Date.now() - startedAt,
      backend_pressure_hint: null,
      human_summary,
      pattern,
      scope_service: args.service,
      options,
      env_capabilities: {
        can_mute: caps.canMute,
        can_compact: caps.canCompact,
        receiver_in_path: caps.receiverInPath,
        receiver_in_path_unknown: caps.receiverInPathUnknown,
        has_retriever_archive: caps.hasRetrieverArchive,
        forwarder_kind: caps.forwarderKind,
        analyzer_vendor: caps.analyzerVendor,
        gitops_repo: caps.gitopsRepo,
      },
    };
  }

  return lines.join('\n');
}

/**
 * One-paragraph paste-to-user summary. Always names: pattern, enabled
 * count, the recommendation basis, and (when no options enabled) the
 * setup hint. Action-shaped tools surface the basis prominently so the
 * agent knows whether to auto-route or wait for user confirmation.
 */
function buildHumanSummary(args: {
  pattern: string;
  status: PatternMitigateStatus;
  basis: RecommendationBasis;
  nEnabled: number;
  nDimmed: number;
  options: Array<{ id: string; enabled: boolean; label: string }>;
  setupHint?: string;
  snapshotAgeSeconds: number | null;
}): string {
  const basisFragment = (() => {
    switch (args.basis) {
      case 'env_config':
        return 'Capability detection used envs.json only.';
      case 'env_config_plus_snapshot':
        return `Capability detection used envs.json + a discovery snapshot${args.snapshotAgeSeconds !== null ? ` (snapshot is ${args.snapshotAgeSeconds}s old)` : ''}.`;
      case 'snapshot':
        return `Capability detection used a discovery snapshot only${args.snapshotAgeSeconds !== null ? ` (${args.snapshotAgeSeconds}s old)` : ''} — confirm the env hasn't drifted since.`;
      case 'env_vars_only':
        return 'Capability detection used $LOG10X_* env vars only — no envs.json or snapshot. Verify the env vars match the live environment.';
      case 'unknown':
        return 'Capability detection found no source of capability facts (no envs.json, no snapshot, no env vars).';
    }
  })();
  if (args.status === 'no_signal') {
    return `\`${args.pattern}\`: no mitigation options are reachable in this environment. ${basisFragment} ${args.setupHint ?? 'Set up at least one delivery path (gitops repo, forwarder, or analyzer config) to enable options.'}`;
  }
  const enabledList = args.options.filter((o) => o.enabled).map((o) => o.label).join(', ');
  return `\`${args.pattern}\`: ${args.nEnabled} of ${args.options.length} mitigation options available (${enabledList}). ${args.nDimmed > 0 ? `${args.nDimmed} dimmed. ` : ''}${basisFragment} Agent SHOULD wait for the user to pick before routing to the sub-tool.`;
}
