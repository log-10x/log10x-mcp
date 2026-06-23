/**
 * log10x_configure_engine
 *
 * Converts a `target_percent` (or `budget_usd`) commitment into a per-pattern
 * cap CSV and a `gh` PR command against the customer gitops repo. The engine
 * hot-reloads the CSV on the next gitops poll; no pipeline restart, no event
 * drops.
 *
 * Solver: greedy v1, ordered by (current_bytes_30d * severity_weight) DESC,
 * where severity_weight = audit:1.0, error:0.8, standard:0.5, debug:0.2,
 * synthetic:0.1. Replace with LP only if greedy is materially suboptimal
 * on a representative customer.
 *
 * Per-destination action resolution honors the cost lib's CompactMode:
 *   - splunk           (envelope)         compact ⇒ encode-in-event
 *   - clickhouse       (dict-udf-view)    compact ⇒ dict + UDF + view
 *   - elasticsearch    (index-pruned)     compact ⇒ pruned _source
 *   - datadog/cw/azure/gcp/sumo (no-op)   compact is rejected — solver
 *                                          falls back to drop and warns.
 *
 * Cross-validation: exactly one of target_percent / budget_usd is required;
 * else the tool returns a structured not-configured envelope.
 *
 * Phases (data.phase in the envelope):
 *   - 'target_resolution'  gitops repo / destination could not be resolved
 *   - 'backend'            customer metrics backend not configured
 *   - 'resolution_prompt'  service matched multiple containers — agent re-calls
 *                          with `containers=[...]`
 *   - 'solver_failed'      target unreachable without violating floors
 *   - 'pr_rendered'        success — `pr_command` ready to paste (or null when
 *                          current state already meets target)
 *
 * Zero engine ask: every query runs against existing receive-aggregator
 * metrics (all_events_summaryBytes_total labeled by k8s_container,
 * tenx_hash, severity_level). The PR machinery is the same `gh` pattern
 * configure_regulator already uses.
 *
 * NOTE on graceful not-configured: this branch does not yet have the
 * `NotConfiguredError` framework from `feat/graceful-not-configured`. We
 * keep the existing pattern (CustomerMetricsNotConfiguredError + structured
 * envelopes mirroring configure-regulator); the wrapper rebases trivially
 * onto the framework once it lands.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import { getSnapshot } from '../lib/discovery/snapshot-store.js';
import { _getSnapshot as getPocSnapshot } from './poc-from-siem.js';
import { buildPocEnvelopeV2 } from '../lib/poc-envelope-v2.js';
import { _enrichForEnvelope as enrichForPocEnvelope } from '../lib/poc-report-renderer.js';
import {
  resolveBackend,
  CustomerMetricsNotConfiguredError,
  formatDetectionTrace,
  type CustomerMetricsBackend,
} from '../lib/customer-metrics.js';
import { loadEnvironments } from '../lib/environments.js';
import { computeGeneration, renderGenerationCsv } from '../lib/config-generation.js';
import { LABELS, compressibilityPerContainer } from '../lib/promql.js';
import type { PrometheusResponse } from '../lib/api.js';
import { queryInstant } from '../lib/api.js';
import { resolveRate } from '../lib/rate-resolution.js';
import { parsePrometheusValue } from '../lib/cost.js';
import type { EnvConfig } from '../lib/environments.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import {
  type StructuredOutput,
  type Action as EnvelopeAction,
} from '../lib/output-types.js';
import { buildChassisEnvelope, buildChassisErrorEnvelope, sanitizeHeadline } from '../lib/chassis-envelope.js';
import {
  COST_MODEL_BY_DESTINATION,
  getDestinationCostModel,
  getDefaultActionForDestination,
  getAllowedActionsForDestination,
  projectActionRange,
  type Action,
} from '../lib/cost.js';
import type { SiemId } from '../lib/siem/pricing.js';
import {
  RECEIVER_DEFAULT_RESET_MS,
  scaleObservedToReceiverWindow,
} from '../lib/window-scaling.js';
import { resolveClusterConfig } from '../lib/env-config/resolve-cluster-config.js';
import { requireWriteAccess } from '../lib/read-only-guard.js';
import { putCommitment, type CommitmentRecord } from './commitment-report.js';
import { randomUUID } from 'node:crypto';

// ─── constants ────────────────────────────────────────────────────────
const DEFAULT_LOOKUP_PATH = 'pipelines/run/receive/rate/caps.csv';
// RECEIVER_DEFAULT_RESET_MS (240_000 ms = 4 min) imported from window-scaling.
const RESET_INTERVAL_SEC = RECEIVER_DEFAULT_RESET_MS / 1000;
const WINDOWS_PER_DAY = (24 * 60 * 60) / RESET_INTERVAL_SEC; // = 360
const WINDOWS_PER_MONTH = WINDOWS_PER_DAY * 30; // = 10800
const GB = 1_000_000_000; // decimal GB — matches CloudWatch/Datadog/Splunk billing
const FEASIBILITY_TOLERANCE_PCT = 0.1; // ±10% of target counts as "hit"
const MIN_REPORTER_DAYS = 7;

// ── refresh-mode constants ──────────────────────────────────────────
// Commitment target is stored in the cap-CSV as a `# target_percent=N`
// comment-line preamble. The engine's lookup parser ignores lines that
// don't match `<key>,<value>` so the comment is engine-safe; the MCP-side
// parser tolerates `#` lines explicitly (cap-csv-parser.ts).
const TARGET_PREAMBLE_KEY = 'target_percent';
const TARGET_PREAMBLE_RE = /^#\s*target_percent\s*=\s*(\d+(?:\.\d+)?)\s*$/;
// Default tolerance band for refresh skips: if observed monthly volume is
// within ±DEFAULT_REFRESH_TOLERANCE_PCT of the prior baseline, the refresh
// emits no PR. Caller can override via `tolerance_pct`.
const DEFAULT_REFRESH_TOLERANCE_PCT = 2;

type Tier = 'audit' | 'error' | 'standard' | 'debug' | 'synthetic';

// Severity-weighted ranking for the greedy solver.
const SEVERITY_WEIGHT: Record<Tier, number> = {
  audit: 1.0,
  error: 0.8,
  standard: 0.5,
  debug: 0.2,
  synthetic: 0.1,
};

// Supported destinations (= SiemId from lib/siem/pricing.ts).
const DESTINATION_ENUM = [
  'splunk',
  'datadog',
  'elasticsearch',
  'clickhouse',
  'cloudwatch',
  'azure-monitor',
  'gcp-logging',
  'sumo',
] as const;

// ─── schema ───────────────────────────────────────────────────────────
export const configureEngineSchema = {
  mode: z
    .enum(['configure', 'refresh'])
    .default('configure')
    .describe(
      '`configure` (default) = derive a fresh per-pattern policy and open a PR. `refresh` = re-pull TSDB metrics for an already-deployed policy, compare observed volume to the cap-CSV preamble baseline, and open a delta PR only when the volume has drifted beyond `tolerance_pct`. Use `refresh` from cron/agent loops after the engine is live and 10x metrics are flowing. Requires `current_csv` carrying the prior `# target_percent=N` preamble; if absent, falls back to `target_percent` arg or returns target_resolution.'
    ),
  delivery: z
    .enum(['gitops', 'kubectl_configmap', 'stdout_only'])
    .default('gitops')
    .describe(
      'How the rendered policy is delivered. `gitops` (default) opens a PR against the customer gitops repo (requires `gitops_repo`). `kubectl_configmap` writes the cap-CSV + action-intent.json directly to a k8s ConfigMap on the active cluster (no GitHub needed; the engine\'s ConfigMap pull driver reads from the ConfigMap named via $K8S_CONFIGMAP, default `log10x-action-intent`). `stdout_only` returns the proposed config in the response without writing anywhere.'
    ),
  kubectl_namespace: z
    .string()
    .optional()
    .describe(
      'k8s namespace for the cap-CSV ConfigMap when delivery="kubectl_configmap". Defaults to the env-config doc\'s retriever.helm_release.namespace, then `default`. The engine\'s ConfigMap pull driver reads from this namespace.'
    ),
  kubectl_configmap_name: z
    .string()
    .optional()
    .describe(
      'k8s ConfigMap name when delivery="kubectl_configmap". Defaults to `log10x-action-intent` (matching the engine\'s default $K8S_CONFIGMAP env var). The ConfigMap holds two keys: `caps.csv` (engine\'s safety floor) and `action-intent.json` (per-pattern action mapping).'
    ),
  tolerance_pct: z
    .number()
    .min(0)
    .max(50)
    .optional()
    .describe(
      'Refresh-mode tolerance band. When observed monthly volume drifts less than this percent vs the cap-CSV baseline, no PR is emitted (phase=refresh_skipped). Default 2%. Ignored in `configure` mode.'
    ),
  service: z
    .string()
    .describe(
      'Customer-vocabulary name of the service to configure (e.g., `payment-service`). The tool resolves this to a set of `k8s_container` values via Prometheus and asks the agent to confirm if multiple candidates match.'
    ),
  containers: z
    .array(z.string())
    .optional()
    .describe(
      'Explicit list of k8s_container values to apply the policy to. If omitted, the tool resolves `service` to candidates and presents them; the agent re-calls with this parameter to commit.'
    ),
  target_percent: z
    .number()
    .min(1)
    .max(95)
    .optional()
    .describe(
      'Reduce monthly volume bytes by this percent. Exactly one of `target_percent` or `budget_usd` is required.'
    ),
  budget_usd: z
    .number()
    .positive()
    .optional()
    .describe(
      'Cap monthly destination spend at this dollar amount. Tool back-computes the equivalent `target_percent` from current spend at the destination ingest rate. Exactly one of `target_percent` or `budget_usd` is required.'
    ),
  destination: z
    .enum(DESTINATION_ENUM)
    .optional()
    .describe(
      'Destination log platform. Auto-detect only works when a `snapshot_id` from log10x_discover_env is supplied (the snapshot carries `recommendations.destination`) or when the active env in `~/.log10x/envs.json` explicitly sets a `destination` field. Most active envs do NOT carry that field, so for typical use you should pass `destination` explicitly: `splunk` | `datadog` | `elasticsearch` | `clickhouse` | `cloudwatch` | `azure-monitor` | `gcp-logging` | `sumo`.'
    ),
  es_pruned: z
    .boolean()
    .optional()
    .describe(
      'Elasticsearch only: are compactable fields excluded from `_source` via index template? Default `false` (unpruned). Auto-detection requires reading the customer index template; this knob is the explicit override.'
    ),
  contract_type: z
    .enum(['committed', 'on_demand'])
    .default('on_demand')
    .describe(
      '`committed` = customer is on a committed-volume tier (Splunk, Datadog DPM) where savings count toward renewal forecasting. `on_demand` = pay-as-you-go.'
    ),
  signal_floor: z
    .array(
      z.object({
        pattern_hash: z.string().describe('Stable pattern identity (tenx_hash) to protect from any reduction.'),
        reason: z.string().optional().describe('Human-readable rationale (e.g. `dashboard:payments-overview`).'),
        events_per_min_per_pod: z
          .number()
          .positive()
          .optional()
          .describe('Optional minimum throughput floor; solver will not sample/drop this pattern below this rate.'),
      })
    )
    .default([])
    .describe(
      'Patterns the solver MUST keep above floor (action=pass). First match wins. Use for dashboards, alerts, audit logs.'
    ),
  action_defaults: z
    .object({
      standard: z
        .enum(['pass', 'sample', 'compact', 'tier_down', 'offload', 'drop'])
        .default('compact')
        .describe('Default action for standard-tier patterns (the bulk of volume).'),
      debug: z
        .enum(['pass', 'sample', 'compact', 'tier_down', 'offload', 'drop'])
        .default('drop')
        .describe('Default action for debug-tier patterns.'),
      synthetic: z
        .enum(['pass', 'sample', 'compact', 'tier_down', 'offload', 'drop'])
        .default('drop')
        .describe('Default action for synthetic / load-gen patterns.'),
    })
    .default({})
    .describe('Tier-to-action defaults. Audit-tier is always `pass`; error-tier is always `sample(N=2)`.'),
  respect_default_action: z
    .boolean()
    .default(false)
    .describe(
      'When false (default), the solver shortcuts to `pass` on standard/debug/synthetic rows once `target_percent` is met by error-tier sampling — minimum work, may ignore your configured `action_defaults`. When true, the solver applies `action_defaults` to EVERY non-floor row in the matching tier, even after target is already met. Use when you want a predictable action mix (e.g., "I asked for offload, give me offload") and are OK with the policy overshooting target_percent. Surfaces in `action_default_resolution.respect_default_action` for audit.'
    ),
  reduction: z
    .enum(['soft', 'hard'])
    .default('hard')
    .describe(
      '`soft` = mark for SIEM-side tier-down (lossless, recoverable). `hard` = drop at the receiver (gone). Soft is only meaningful on destinations that support a marker-driven tier (Splunk via `_raw` marker, ES via index-time routing).'
    ),
  observationDays: z
    .number()
    .int()
    .min(1)
    .max(90)
    .default(7)
    .describe(
      'Days of Prometheus history used to compute per-pattern volume. Default 7 (captures a full weekday/weekend cycle).'
    ),
  snapshot_id: z
    .string()
    .optional()
    .describe(
      'ID returned by `log10x_discover_env`. Used to resolve `gitops_repo`, `lookup_path`, and `destination` defaults.'
    ),
  gitops_repo: z
    .string()
    .optional()
    .describe(
      'Owner/name of the customer gitops repo (e.g. `acme/log10x-config`). Falls back to `gitops.repo` in `~/.log10x/envs.json` if omitted.'
    ),
  gitops_branch: z
    .string()
    .default('main')
    .describe('Base branch for the PR. Default `main`.'),
  lookup_path: z
    .string()
    .default(DEFAULT_LOOKUP_PATH)
    .describe(`Repo-relative path to the cap CSV. Default \`${DEFAULT_LOOKUP_PATH}\`.`),
  current_csv: z
    .string()
    .optional()
    .describe(
      'Existing CSV content (header + rows). If omitted, the tool computes the diff against an empty baseline and notes that.'
    ),
  from_poc_id: z
    .string()
    .optional()
    .describe(
      'POC snapshot id returned by `log10x_poc_from_siem_submit` (or the from-local equivalent). When set and the snapshot carries a `cap_csv` (i.e., the POC was run with `target_percent_reduction`), the tool reads that CSV verbatim and renders it as the PR body — no Prometheus pull, no greedy re-derivation. Falls back to the live-Prometheus derivation when the snapshot has no cap_csv (or no `target_percent_reduction` was supplied to the POC).'
    ),
  // ── auto-apply (industry-standard MCP write tool surface) ──
  // GitHub MCP, Linear MCP, Atlassian MCP, Notion MCP and other vendor-shipped
  // MCPs converged on auto-execute as the default for write-capable servers.
  // We follow that convention with two opt-outs:
  //   (1) `auto_apply: false` per-call (e.g. for evaluation customers, dry-run
  //       audits, or running outside an approval-capable MCP client).
  //   (2) `read_only: true` per-call (or the server's --read-only flag, which
  //       skips registration entirely — mirroring github/github-mcp-server).
  // Safety is layered: gh CLI auth (token scoping), MCP client confirmation UX
  // (Claude Desktop, Cursor), and `destructiveHint: true` on the registration.
  auto_apply: z
    .boolean()
    .default(true)
    .describe(
      'When `true` (default), the tool shells out to `gh` to create the PR after rendering. When `false`, returns the gh script verbatim for the agent/user to run. Industry-standard MCPs (GitHub, Linear, Atlassian) auto-execute write tools by default; the safety boundary is the MCP client approval UX plus the gh CLI token. Forced `false` whenever `read_only=true`.'
    ),
  read_only: z
    .boolean()
    .default(false)
    .describe(
      'When `true`, behaves as if `auto_apply=false` regardless of other flags. Use for evaluation, audit, or in MCP contexts without an approval surface (cron, headless agents). Mirrors `github/github-mcp-server --read-only`.'
    ),
  // ── view shape ──
  // The full envelope is ~84KB on a 119-pattern policy: pr_command (28.8KB
  // multi-line gh script with the entire CSV inline), per_pattern_rows
  // (27.3KB — 119 patterns × all numeric fields), csv_diff (5.3KB). The
  // default summary view (~1-2KB) carries the action_mix, totals, the
  // top-5 cost contributors, and a one-paragraph PR-command description.
  // Callers that need the raw gh script or full per-pattern table pass
  // `view='detail'`; `view='pr_command_only'` returns just the gh script.
  view: z
    .enum(['summary', 'detail', 'pr_command_only'])
    .default('summary')
    .describe(
      'Response shape. `summary` (default) returns slim payload: phase, target_percent, action_mix counts, totals (bytes_in / bytes_saved / dollars_saved monthly), top_5_per_pattern, and a short PR-command prose summary. Target: under 8K tokens for a 119-pattern policy. `detail` returns the full envelope with pr_command, per_pattern_rows, and csv_diff included. `pr_command_only` returns ONLY the pr_command string for copy-paste callers.'
    ),
  // ── Phase 2: per-service action advisory ──
  // The env ships to ONE destination, so per-service variation means choosing
  // a different ACTION (within that destination's legal, saving set) per
  // k8s_container, driven by each service's MEASURED compressibility. By
  // default the solver auto-recommends per service (compresses well -> compact
  // and stays queryable; compresses poorly -> offload for the larger cut). A
  // caller can pin a service's action and/or its queryability preference.
  service_policy: z
    .record(
      z.string(),
      z.object({
        standard_action: z
          .enum(['pass', 'sample', 'compact', 'tier_down', 'offload', 'drop'])
          .optional()
          .describe(
            'Pin this service (k8s_container) standard-tier action, overriding the auto-recommendation. An action that is illegal or zero-saving on the env destination (e.g. compact on Datadog, tier_down with no cheaper tier) is rejected with a warning and the service falls back to its normal resolution (the compressibility auto-recommendation, or the global action_defaults.standard when auto_recommend is off).'
          ),
        keep_queryable: z
          .boolean()
          .optional()
          .describe(
            'When true, force the in-platform compact action wherever compact is legal on the destination, keeping this service queryable in the destination rather than offloading to S3, even when its compaction is modest. No effect on destinations where compact is a no-op (Datadog/CloudWatch/Azure/GCP/Sumo); there the queryable lever is tier_down, already preferred when it has a priced cheaper tier.'
          ),
      })
    )
    .optional()
    .describe(
      'Per-service override map keyed by k8s_container name. A service absent from the map is auto-recommended. Pinned actions win unless illegal on the destination.'
    ),
  auto_recommend: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), services without a `service_policy` entry get a per-service auto-recommended standard-tier action (cost-optimal within the destination legal set, compressibility-driven). When false, every service falls back to the single global `action_defaults.standard` (legacy one-size behavior).'
    ),
  compact_worth_it_ratio: z
    .number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe(
      'Compressibility threshold for the compact-vs-offload auto-recommendation: a service whose measured optimized/input ratio (or the destination modeled compaction band when no measured ratio is available) is at or below this keeps `compact` (queryable plus a meaningful cut); above it `offload` is recommended (compact would save little). Default 0.6.'
    ),
  service_compaction: z
    .record(
      z.string(),
      z.object({
        compaction_ratio_x: z
          .number()
          .positive()
          .describe(
            'Measured aggregate compaction (original bytes / encoded bytes) for this service, from `log10x_measure_compaction.data.payload.aggregate_compaction_ratio_x`.'
          ),
      })
    )
    .optional()
    .describe(
      'Per-service measured compaction from `log10x_measure_compaction`, keyed by k8s_container. Grounds the per-service advisory in the real codec BEFORE optimize mode is deployed (the live optimize-mode metric only exists after deployment). Precedence for each service compressibility signal: live production metric (when optimize mode is running) wins, else this on-demand sample, else the static destination band. Run `log10x_measure_compaction` per service first, then pass `{ "<k8s_container>": { compaction_ratio_x: N } }`.'
    ),
};

const schemaObj = z.object(configureEngineSchema);
export type ConfigureEngineArgs = z.infer<typeof schemaObj>;

// ─── output types ─────────────────────────────────────────────────────
export interface PerPatternRow {
  pattern_hash: string;
  /** Human pattern name — renderers lead with this, never the hash. */
  pattern: string;
  current_bytes_30d: number;
  cap_bytes_per_window: number;
  action: Action;
  /** k8s_container this slice belongs to (== the engine's actions.csv key). */
  container?: string;
  // Actual projected reduction for THIS pattern under its assigned action.
  // A `pass` row sheds nothing, so both are 0 — pass is never credited as
  // savings. Summed into the headline totals so they reconcile with the plan.
  saved_bytes_monthly: number;
  saved_dollars_monthly: number;
  projected_monthly_usd_low: number;
  projected_monthly_usd_expected: number;
  projected_monthly_usd_high: number;
  floor_reason?: string;
  reason: string;
}

/**
 * One row of the Phase-2 per-service advisory. The engine ships every service
 * to the env's single destination, so the advisory varies the ACTION per
 * k8s_container, not the destination. `chosen_action` is the standard-tier
 * action this service was advised; the per-pattern audit/error/floor rows keep
 * their own actions in action-intent.json.
 */
interface PerServiceSummaryRow {
  /** k8s_container (== the engine's actions.csv key). */
  service: string;
  chosen_action: Action;
  /** Where the action came from. */
  source: 'user_pinned' | 'auto' | 'global_default';
  bytes_in_monthly: number;
  bytes_share_pct: number;
  saved_bytes_monthly: number;
  saved_dollars_monthly: number;
  /** Measured compaction (1 - optimized/input) as a percent, or null when no measurement was available and the static band was used. */
  measured_compression_pct: number | null;
  ratio_source: 'measured_live' | 'measured_sample' | 'static_band';
  keep_queryable: boolean;
  reason: string;
}

interface ConfigureEngineData {
  ok: boolean;
  phase:
    | 'target_resolution'
    | 'backend'
    | 'resolution_prompt'
    | 'solver_failed'
    | 'pr_rendered'
    | 'refresh_skipped';
  service: string;
  containers: string[];
  destination?: SiemId;
  target_percent?: number;
  /**
   * When phase='resolution_prompt' the tool now discovers candidate
   * containers from the metrics backend and surfaces them here so the
   * agent can re-call without an external label-discovery hop.
   */
  container_candidates?: Array<{
    k8s_container: string;
    bytes_in_window: number;
    share_of_service_pct: number;
  }>;
  derivation?: {
    current_monthly_bytes: number;
    current_monthly_usd: number;
    target_monthly_bytes: number;
    target_monthly_usd: number;
    floor_count: number;
    actions_used: Partial<Record<Action, number>>;
  };
  per_pattern_rows?: PerPatternRow[];
  /** Phase-2 per-service advisory: one entry per k8s_container, sorted DESC by volume. */
  per_service_summary?: PerServiceSummaryRow[];
  checks?: {
    coverage_pct: number;
    feasible: boolean;
    infeasible_reason?: string;
    blocking: string[];
    warnings: string[];
  };
  csv_diff?: string;
  pr_command?: string | null;
  /**
   * Refresh-mode delta diagnostics. Populated when `mode='refresh'` and the
   * tool successfully read a prior baseline from the cap-CSV preamble.
   * `skipped=true` means the volume drift was within tolerance and no PR
   * was emitted; `skipped=false` means caps were recomputed and a PR
   * rendered with the new policy.
   */
  refresh?: {
    skipped: boolean;
    prior_monthly_bytes?: number;
    current_monthly_bytes: number;
    drift_pct: number;
    tolerance_pct: number;
    committed_target_percent: number;
    reason: string;
  };
  /**
   * Auto-apply outcome. Set only when the tool actually executed the gh
   * script (auto_apply=true, read_only=false, feasible plan, prCommand
   * resolved). Surfaces the PR URL so the agent can chain a follow-up
   * tool (e.g., comment, link to Slack, etc) without re-running configure_
   * engine. When unset, the agent/user is expected to run pr_command
   * themselves.
   */
  applied?: {
    ok: boolean;
    pr_url?: string;
    branch?: string;
    error?: string;
    /** Delivery mode actually exercised. Distinguishes the gh path from kubectl_configmap. */
    delivery?: 'gitops' | 'kubectl_configmap';
    /** kubectl_configmap path only: the ConfigMap apply landed at this namespace/name. */
    configmap_location?: { namespace: string; name: string; keys: string[] };
  };
  /**
   * Commitment record id, set when apply succeeds (gitops PR-open OR
   * kubectl_configmap write). The id keys the on-disk record at
   * $LOG10X_ADVISOR_STATE_DIR/commitments/<id>.json that commitment_report
   * reads to compute realized savings.
   */
  commitment_id?: string;
  next_actions?: Array<{ tool: string; args: unknown; why: string }>;
  error?: string;
  /**
   * Diagnostic record of how the caller's `action_defaults` mapped onto the
   * actual tier distribution of the candidate patterns. Audit and error tiers
   * carry hardcoded actions (`pass` and `sample(N=2)`), so a caller's
   * `action_defaults.standard`/`debug`/`synthetic` only fires when at least
   * one pattern is classified into that tier. When a requested default does
   * not fire (e.g. caller asked for standard=`tier_down` but 0 patterns
   * landed in the standard tier), the unused defaults are surfaced here so
   * the agent can branch deterministically without parsing prose warnings.
   */
  action_default_resolution?: {
    requested: {
      standard: Action;
      debug: Action;
      synthetic: Action;
    };
    /**
     * Per-tier default that ended up on at least one row. `null` when the
     * caller's requested default never made it onto a row — either the tier
     * had zero patterns (`unused_defaults`) or the tier had patterns but the
     * solver bypassed the default (floor pin / hardcoded tier action /
     * target-met downgrade — `defined_but_unused_defaults`). Reading
     * `effective.standard` as the value the caller asked for when the action
     * mix proves zero rows took it is a false positive — this field reflects
     * what was actually applied.
     */
    effective: {
      standard: Action | null;
      debug: Action | null;
      synthetic: Action | null;
    };
    /**
     * Count of candidate patterns classified into each tier (pre-solver).
     * Same denominator that `unused_defaults` reasons against. For the
     * count of rows that actually TOOK the configured default, read
     * `applied_default_count_by_tier` instead.
     */
    classified_count_by_tier: Record<Tier, number>;
    /**
     * Count of rows whose final action came from the tier's caller-configured
     * default (standard/debug/synthetic) and survived the target-met
     * downgrade. Distinguishes "default actually drove output" from "patterns
     * landed in this tier but the default was bypassed".
     */
    applied_default_count_by_tier: {
      standard: number;
      debug: number;
      synthetic: number;
    };
    /** Tiers with zero candidate patterns — the requested default never had
     * a row to apply to. */
    unused_defaults: Array<{
      tier: Tier;
      requested: Action;
      reason: string;
    }>;
    /**
     * Tiers that DID have candidate patterns but where the requested default
     * never made it onto a final row. Common causes: every pattern in the
     * tier was floor-pinned (`pass`), the target was met by higher-priority
     * tiers (error sampling) before standard rows ran and they got
     * downgraded, or `effectiveStandardAction` overrode a compact request on
     * a destination where compact is a no-op. The reason names which.
     */
    defined_but_unused_defaults: Array<{
      tier: Tier;
      requested: Action;
      classified_count: number;
      reason: string;
    }>;
    /**
     * Mirror of the `respect_default_action` arg the solver ran under.
     * When true, the target-met downgrade was skipped and configured
     * defaults applied to every non-floor row in the tier. Lets the
     * agent reason about why the action mix may overshoot target_percent.
     */
    respect_default_action: boolean;
  };
  /**
   * One-paragraph plain-prose distillation of the structured data.
   * Agents quote this directly; dollars omitted unless feasible derivation ran.
   */
  human_summary: string;
}

// ─── main entry ───────────────────────────────────────────────────────
export async function executeConfigureEngine(
  args: ConfigureEngineArgs,
  env?: EnvConfig
): Promise<string | StructuredOutput> {
  // ── Aggregated preflight ──
  // Surface ALL missing required-for-this-mode args in one envelope
  // instead of bouncing the caller back per-arg (the prior behavior cost
  // 3-4 round-trips before the first useful response). The detailed
  // single-arg messages stay in place below as a safety net for partial
  // calls; the preflight just shortcuts the common "first attempt with
  // no scoping" case.
  if (args.mode !== 'refresh') {
    const missing: string[] = [];
    if (args.target_percent === undefined && args.budget_usd === undefined) {
      missing.push('`target_percent: 30` (or `budget_usd: 1500`) — exactly one is required');
    }
    if (!args.destination && !args.snapshot_id) {
      missing.push('`destination: "cloudwatch"` (or splunk/datadog/elasticsearch/clickhouse/azure-monitor/gcp-logging/sumo)');
    }
    if (!args.containers || args.containers.length === 0) {
      missing.push('`containers: ["<container_name>"]` — Phase 1 needs at least one. If you do not know the container, omit it and the tool will list candidates after this preflight clears.');
    }
    if (missing.length >= 2) {
      return notConfiguredEnvelope(
        'target_resolution',
        `configure_engine needs ${missing.length} more args to derive a policy. Pass these in one call instead of bouncing back per-arg:\n\n` +
          missing.map((m, i) => `${i + 1}. ${m}`).join('\n') +
          `\n\nExample full call: configure_engine({ service: "${args.service}", containers: ["${args.service}"], target_percent: 30, destination: "cloudwatch", delivery: "stdout_only", read_only: true })`,
        args.service
      );
    }
  }

  // ── Refresh-mode preamble resolution ──
  // In refresh mode, the committed target lives in the cap-CSV preamble.
  // Pull it out before cross-validating target_percent so that a refresh
  // call without an explicit target_percent still works (the common case
  // — cron-driven re-tune of a deployed policy).
  let refreshState: RefreshState | undefined;
  if (args.mode === 'refresh') {
    const parsed = parsePreamble(args.current_csv);
    if (parsed.target_percent === undefined && args.target_percent === undefined) {
      return notConfiguredEnvelope(
        'target_resolution',
        'Refresh mode: no `# target_percent=N` preamble found in `current_csv`, and no `target_percent` arg supplied. Either pass `current_csv` from the gitops cap-CSV (preferred — it carries the originally committed target), or pass `target_percent` explicitly to seed a fresh baseline.',
        args.service
      );
    }
    refreshState = {
      committedTargetPercent: parsed.target_percent ?? args.target_percent!,
      priorBaselineMonthlyBytes: parsed.baseline_monthly_bytes,
      tolerancePct: args.tolerance_pct ?? DEFAULT_REFRESH_TOLERANCE_PCT,
    };
    // Synthesize target_percent from the preamble so the rest of the
    // pipeline (solver, feasibility, projection) runs unchanged.
    if (args.target_percent === undefined && args.budget_usd === undefined) {
      args = { ...args, target_percent: refreshState.committedTargetPercent };
    }
  }

  // Cross-validation: exactly one of target_percent / budget_usd.
  if (args.target_percent === undefined && args.budget_usd === undefined) {
    return notConfiguredEnvelope(
      'target_resolution',
      'Specify either `target_percent` or `budget_usd` — one is required.',
      args.service
    );
  }
  if (args.target_percent !== undefined && args.budget_usd !== undefined) {
    return notConfiguredEnvelope(
      'target_resolution',
      'Pass exactly one of `target_percent` or `budget_usd`, not both.',
      args.service
    );
  }

  // Resolve gitops + destination.
  const target = await resolveTarget(args);
  if ('error' in target) {
    // Strip any `# configure_engine — ` heading prefix that renderError()
    // may have prepended before we attach "configure_engine refused: ".
    // Without this, the hint bleeds a markdown H1 into the chassis headline.
    const targetErrHint = sanitizeHeadline(firstLine(target.error));
    // Nudge log10x_set_gitops_repo when the hint signals a missing gitops
    // repo. log10x_set_gitops_repo writes gitops.repo to envs.json;
    // log10x_configure_env only handles metricsBackend and cannot write
    // that field.
    const targetActions: import('../lib/output-types.js').Action[] =
      isGitopsHint(targetErrHint)
        ? [
            {
              // The actionable unblock for inspection: re-run with
              // delivery="stdout_only" — returns the proposed per-pattern plan
              // inline, no gitops repo and no write required. Carries the
              // caller's full original intent (budget_usd, action_defaults, …)
              // forward via the args spread. Previously the only offered action
              // was set_gitops_repo with empty args, a dead-end for anyone who
              // just wanted to see the plan.
              tool: 'log10x_configure_engine',
              args: { ...args, delivery: 'stdout_only' },
              reason:
                'Inspect the proposed policy without a gitops repo: re-run with delivery="stdout_only" to get the per-pattern plan inline (no PR, no write).',
              role: 'recommended-next',
            },
            {
              tool: 'log10x_set_gitops_repo',
              args: {},
              reason:
                'Or, to deliver as a PR: write gitops.repo to envs.json so configure_engine knows which GitHub repo to open the cap-CSV PR against. After running, restart the MCP server and retry.',
              role: 'alternative',
            },
          ]
        : [];
    return buildChassisErrorEnvelope({
      tool: 'log10x_configure_engine',
      err: {
        error_type: 'config_missing',
        retryable: false,
        suggested_backoff_ms: null,
        hint: `configure_engine refused: ${targetErrHint}`,
      },
      contextPayload: {
        ok: false, phase: 'target_resolution', service: args.service,
        containers: args.containers ?? [], error: targetErrHint,
      },
      source_disclosure: {},
      actions: targetActions,
    });
  }

  // ── from_poc_id consumer path ──
  // When the caller threads a POC snapshot id through, the policy is
  // already decided (the POC ran with `target_percent_reduction` and
  // emitted a `cap_csv` in the 6-action vocab). Read that CSV verbatim,
  // render it as the PR body, skip the Prometheus pull + greedy solver
  // entirely. The re-derivation path remains the fallback (no
  // cap_csv on the snapshot → POC ran in recommendation-only mode →
  // configure_engine still needs to derive from live metrics).
  if (args.from_poc_id) {
    const pocConsumed = await tryConsumePocSnapshot(args, target.resolved);
    if (pocConsumed) return pocConsumed;
    // Fall through to live-derivation if the snapshot is absent /
    // expired / has no cap_csv — surfaced as a warning in the envelope
    // returned by the live path below.
  }

  // configure_engine queries the LOG10X metrics backend (where the engine's
  // per-pattern emit `all_events_summaryBytes_total` lives), not the customer
  // metrics backend. fetchPerPatternBytes uses `queryInstant(env, ...)` from
  // src/lib/api.ts which routes to env.metricsBackend (Log10xBackend or the
  // configured equivalent). The customer backend (LOG10X_CUSTOMER_METRICS_URL)
  // is for cross-pillar tools that join log patterns to infrastructure metrics
  // — not relevant here. Prior version mistakenly resolved the customer
  // backend and queried `all_events_summaryBytes_total` against it, which
  // returned empty (metric doesn't exist there) or timed out (URL unreachable).
  if (!env) {
    return buildChassisErrorEnvelope({
      tool: 'log10x_configure_engine',
      err: {
        error_type: 'no_environment',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'configure_engine refused: no active environment resolved. Pass `environment` arg or configure ~/.log10x/envs.json.',
      },
      contextPayload: { ok: false, phase: 'backend', service: args.service, containers: args.containers ?? [] },
      source_disclosure: { bytes_source: 'tsdb' },
    });
  }

  // Phase 1: container resolution.
  if (!args.containers || args.containers.length === 0) {
    // Prior code returned containers:[] + actions:[], a dead-end
    // envelope that told the agent "pick containers" but gave it
    // nothing to pick from.
    // Discover the candidate containers from the metrics backend so
    // the agent can re-call with a concrete list (or, when the env
    // has a single container, suggest it directly in the headline).
    const observationDays = args.observationDays ?? 7;
    const metricsEnv = await resolveMetricsEnv(env);
    const envClause = metricsEnv ? `${LABELS.env}="${promEscape(metricsEnv)}",` : '';
    const containerQ = `sum by (k8s_container)(increase(all_events_summaryBytes_total{${envClause}${LABELS.service}="${promEscape(args.service)}"}[${observationDays}d]))`;
    let candidateContainers: Array<{ name: string; bytes: number }> = [];
    try {
      const res = await queryInstant(env, containerQ);
      for (const r of res.data.result) {
        const name = r.metric.k8s_container;
        if (!name) continue;
        const bytes = parsePrometheusValue(r);
        if (Number.isFinite(bytes) && bytes > 0) {
          candidateContainers.push({ name, bytes });
        }
      }
      candidateContainers.sort((a, b) => b.bytes - a.bytes);
    } catch {
      candidateContainers = [];
    }
    const totalBytes = candidateContainers.reduce((s, c) => s + c.bytes, 0);
    const containerLabels = candidateContainers.map((c) => c.name);
    const hint = candidateContainers.length === 0
      ? `No k8s_container labels found for service "${args.service}" in the last ${observationDays}d. The service name may be misspelled, or no bytes were emitted in the window.`
      : candidateContainers.length === 1
        ? `One container found: ["${containerLabels[0]}"]. Re-call with containers: ["${containerLabels[0]}"] to derive the policy.`
        : `${candidateContainers.length} containers found. Re-call with containers: [${containerLabels.slice(0, 5).map((n) => `"${n}"`).join(', ')}${candidateContainers.length > 5 ? `, ...` : ''}] to derive the policy.`;
    const resPromptHeadline = `Phase 1: pick containers for service "${args.service}" — ${hint}`;
    return buildChassisEnvelope({
      tool: 'log10x_configure_engine',
      view: 'summary',
      headline: resPromptHeadline,
      status: 'partial',
      decisions: { threshold_used: args.target_percent ?? null, threshold_basis: args.target_percent != null ? 'customer_supplied' : 'default' },
      source_disclosure: { bytes_source: 'tsdb', siem_vendor: target.resolved.destination },
      scope: { window: `${observationDays}d`, window_basis: args.observationDays != null ? 'explicit' : 'auto_default' },
      payload: {
        ok: true, phase: 'resolution_prompt', service: args.service,
        containers: containerLabels, destination: target.resolved.destination,
        container_candidates: candidateContainers.map((c) => ({
          k8s_container: c.name,
          bytes_in_window: c.bytes,
          share_of_service_pct: totalBytes > 0 ? (c.bytes / totalBytes) * 100 : 0,
        })),
        human_summary: hint,
      } satisfies ConfigureEngineData,
      human_summary: hint,
      actions: candidateContainers.length > 0
        ? [{
            tool: 'log10x_configure_engine',
            // Propagate the caller's FULL original intent, overriding only the
            // two fields this resolution step actually resolves: destination
            // (to the resolved value) and containers (to the discovered set).
            // The prior allow-list (service/destination/containers/target_percent/
            // auto_apply/delivery) silently DROPPED budget_usd, action_defaults,
            // es_pruned, signal_floor, read_only, reduction, tier_overrides, etc.
            // So an agent that re-called with this action verbatim lost the cost
            // model entirely — e.g. budget_usd=3000 gone, hitting the
            // cross-validation refusal "specify target_percent or budget_usd".
            // Spreading args preserves every caller-supplied knob.
            args: {
              ...args,
              destination: target.resolved.destination,
              containers: containerLabels,
            },
            reason: candidateContainers.length === 1
              ? `Re-call configure_engine with the single discovered container "${containerLabels[0]}".`
              : `Re-call configure_engine with the ${candidateContainers.length} discovered containers (or a subset).`,
            role: 'recommended-next',
          }]
        : [],
    });
  }

  // Phase 2: solve + render.
  const destination = target.resolved.destination;
  const observationDays = args.observationDays ?? 7;

  // Resolve the actual tenx_env label value used by log10x metrics ('edge'
  // or 'cloud'), not the env UUID. Matches what top_patterns / trend / etc.
  // use in their selectors.
  const metricsEnv = await resolveMetricsEnv(env);
  const perPattern = await fetchPerPatternBytes(
    env,
    args.containers,
    observationDays,
    metricsEnv
  );

  // Phase 2: measure each container's realized compaction (best-effort; a
  // container with no optimized-size series falls back to the static band).
  const compressByContainer = await fetchCompressibilityPerContainer(
    env,
    args.containers,
    observationDays,
    metricsEnv
  );

  // Phase 2: overlay caller-supplied log10x_measure_compaction results onto any
  // container the live optimize-mode metric did not cover with a usable ratio.
  // This is what grounds the advisory in the real codec BEFORE optimize mode is
  // deployed (the live metric only exists post-deploy, a chicken-and-egg the
  // on-demand sample breaks). Live production ratio always wins; the sample
  // fills the gap; the static band is the last resort.
  if (args.service_compaction) {
    for (const [svc, m] of Object.entries(args.service_compaction)) {
      const live = compressByContainer.get(svc);
      if (live && live.ratio !== null) continue; // realized production metric wins
      const frac = m.compaction_ratio_x > 0 ? 1 / m.compaction_ratio_x : NaN;
      const ratio = frac >= 0.02 && frac <= 1.0 ? frac : null;
      compressByContainer.set(svc, {
        ratio,
        input_bytes: 0,
        optimized_bytes: 0,
        source: 'sample',
      });
    }
  }

  // Monthly projection from observation window.
  const scaleToMonth = 30 / observationDays;
  const totalObservedBytes = perPattern.reduce((s, p) => s + p.bytes, 0);
  const currentMonthlyBytes = totalObservedBytes * scaleToMonth;
  const model = getDestinationCostModel(destination, { esPruned: args.es_pruned });
  // budget_usd is a DOLLAR promise → convert to bytes at the customer's real
  // $/GB, not the destination list price. Resolve the ingest rate locally via
  // the shared chain (caller arg → envs.json analyzerCost → LOG10X_ANALYZER_COST
  // → destination list); NO log10x account-API call. Storage stays at list (no
  // per-customer storage rate), matching baseline. When no customer rate is
  // configured this is identical to the prior model.ingest_per_gb behavior.
  const resolvedIngest = resolveRate({}, env, destination);
  const ingestPerGb =
    resolvedIngest.source === 'customer_supplied'
      ? (resolvedIngest.rate_per_gb as number)
      : model.ingest_per_gb;
  // Thread the SAME resolved rate into projectActionRange so per-pattern dollar
  // projections match current_monthly_usd (which uses ingestPerGb). Without it,
  // projections fall back to destination LIST price while current uses the
  // customer rate, so dollars% and bytes% diverge (a 56-point gap on the demo).
  // estimate_savings already does this; configure_engine did not.
  const customerRate =
    resolvedIngest.source === 'customer_supplied'
      ? { ingest_per_gb_override: resolvedIngest.rate_per_gb as number }
      : undefined;

  // ── Refresh-mode tolerance check ──
  // If the observed volume hasn't drifted enough vs the prior baseline to
  // matter, skip emitting a PR. The engine is already serving the target;
  // re-tuning would be churn without economic benefit.
  if (refreshState && refreshState.priorBaselineMonthlyBytes !== undefined) {
    const prior = refreshState.priorBaselineMonthlyBytes;
    const driftPct = prior > 0
      ? Math.abs(currentMonthlyBytes - prior) / prior * 100
      : 0;
    if (driftPct < refreshState.tolerancePct) {
      const data: ConfigureEngineData = {
        ok: true,
        phase: 'refresh_skipped',
        service: args.service,
        containers: args.containers,
        destination,
        target_percent: refreshState.committedTargetPercent,
        refresh: {
          skipped: true,
          prior_monthly_bytes: Math.round(prior),
          current_monthly_bytes: Math.round(currentMonthlyBytes),
          drift_pct: roundOne(driftPct),
          tolerance_pct: refreshState.tolerancePct,
          committed_target_percent: refreshState.committedTargetPercent,
          reason: `Observed volume drift ${driftPct.toFixed(1)}% < tolerance ${refreshState.tolerancePct}%; current caps still deliver the ${refreshState.committedTargetPercent}% commitment.`,
        },
        human_summary: `configure_engine refresh skipped on ${args.service}: observed volume drift ${driftPct.toFixed(1)}% (${humanBytes(prior)} → ${humanBytes(currentMonthlyBytes)}/mo) is within the ${refreshState.tolerancePct}% tolerance band. No PR opened; current caps still deliver the committed ${refreshState.committedTargetPercent}% reduction.`,
      };
      return buildChassisEnvelope({
        tool: 'log10x_configure_engine',
        view: 'summary',
        headline: `Refresh skipped on ${args.service}: drift ${driftPct.toFixed(1)}% within tolerance ${refreshState.tolerancePct}%.`,
        status: 'success',
        decisions: { threshold_used: refreshState.committedTargetPercent, threshold_basis: 'snapshot' },
        source_disclosure: { bytes_source: 'tsdb', siem_vendor: destination },
        scope: { window: `${args.observationDays ?? 7}d`, window_basis: 'explicit' },
        payload: data,
        human_summary: data.human_summary ?? `Refresh skipped — drift ${driftPct.toFixed(1)}% within tolerance.`,
      });
    }
  }
  const currentMonthlyUsd =
    (currentMonthlyBytes / GB) *
    (ingestPerGb + model.storage_per_gb_month);

  // Resolve target bytes.
  let targetPercent: number;
  let targetMonthlyBytes: number;
  if (args.budget_usd !== undefined) {
    const effectivePerGb =
      ingestPerGb + model.storage_per_gb_month;
    if (effectivePerGb <= 0) {
      // ClickHouse self-hosted has ingest_per_gb = 0 and tiny storage; bail.
      return notConfiguredEnvelope(
        'target_resolution',
        `budget_usd cannot be used on ${destination}: effective $/GB is 0. Pass target_percent instead.`,
        args.service
      );
    }
    targetMonthlyBytes = (args.budget_usd / effectivePerGb) * GB;
    targetPercent = currentMonthlyBytes > 0
      ? Math.max(0, 1 - targetMonthlyBytes / currentMonthlyBytes) * 100
      : 0;
  } else {
    targetPercent = args.target_percent!;
    targetMonthlyBytes = currentMonthlyBytes * (1 - targetPercent / 100);
  }

  // Build the greedy solver input. Order DESC by (bytes * severity_weight).
  const floorSet = new Map<string, string>();
  for (const f of args.signal_floor ?? []) {
    floorSet.set(f.pattern_hash, f.reason ?? 'signal_floor');
  }

  const candidates = perPattern
    .map((p) => ({
      ...p,
      tier: inferTier(p.severity),
      score: p.bytes * SEVERITY_WEIGHT[inferTier(p.severity)],
    }))
    .sort((a, b) => b.score - a.score);

  const standardAction = args.action_defaults?.standard ?? 'compact';
  const debugAction = args.action_defaults?.debug ?? 'drop';
  const syntheticAction = args.action_defaults?.synthetic ?? 'drop';

  const warnings: string[] = [];
  const blocking: string[] = [];

  // If destination is no-op for compact and standard default is compact, fall
  // back to the destination's preferred level-1 action (per
  // DEFAULT_ACTION_BY_DESTINATION) rather than the historical `drop`. This
  // gives Datadog → tier_down, Splunk-no-app → offload, etc. Drop is only
  // chosen when the destination table explicitly lists it (none currently
  // do — drop remains an explicit user override).
  //
  // Bug A: the "fell back to X" warning is NOT pushed here — at this point
  // we only know the mapping was proposed, not that any row survived the
  // greedy target-met downgrade carrying that action. The warning is
  // pushed after the solver loop, gated on standardFallbackSurvivors > 0.
  let effectiveStandardAction: Action = standardAction;
  const standardCompactNoOpFallbackFired =
    standardAction === 'compact' && model.compact_mode === 'no-op';
  if (standardCompactNoOpFallbackFired) {
    effectiveStandardAction = getDefaultActionForDestination(destination, 1);
  }

  // ── Phase 2: per-service action advisory ──
  // Resolve a standard-tier action per k8s_container under the env's single
  // destination. A `service_policy` pin wins when legal; otherwise each
  // service is auto-recommended from its measured compressibility (compact
  // when it compresses well and stays queryable, offload when it does not).
  // Any container without a resolution falls back to effectiveStandardAction.
  const autoRecommend = args.auto_recommend ?? true;
  const compactWorthItRatio = args.compact_worth_it_ratio ?? 0.6;
  const serviceActionByContainer = new Map<string, ServiceActionDecision>();
  for (const container of new Set(perPattern.map((p) => p.container))) {
    serviceActionByContainer.set(
      container,
      _resolveServiceAction({
        container,
        destination,
        model,
        compressibility: compressByContainer.get(container),
        policy: args.service_policy?.[container],
        autoRecommend,
        globalStandardAction: standardAction,
        compactWorthItRatio,
        warnings,
      })
    );
  }

  // Run the greedy solver.
  const rows: PerPatternRow[] = [];
  const actionsUsed: Partial<Record<Action, number>> = {};
  // Track per-tier classification counts so we can diagnose unused
  // `action_defaults` after the loop. A caller-supplied default that
  // maps onto a tier with zero patterns silently no-ops unless we
  // surface it.
  const patternsByTier: Record<Tier, number> = {
    audit: 0,
    error: 0,
    standard: 0,
    debug: 0,
    synthetic: 0,
  };
  // Track per-tier "default actually applied" count: rows whose final action
  // came from the caller-configurable default (standard/debug/synthetic) and
  // survived all subsequent overrides (floor pin pre-empts; target-met
  // downgrade demotes to pass). Used by action_default_resolution to
  // distinguish "default fired" from "tier had patterns but default never
  // reached output" (the misleading effective field).
  const appliedDefaultByTier: { standard: number; debug: number; synthetic: number } = {
    standard: 0,
    debug: 0,
    synthetic: 0,
  };
  const targetShedBytes = Math.max(0, currentMonthlyBytes - targetMonthlyBytes);
  let remainingBytesToShed = targetShedBytes;
  let floorCount = 0;
  let coveredBytes = 0;
  // Bug A counter: standard-tier rows whose final action is the
  // destination-compat fallback (effectiveStandardAction) AND survived
  // the target-met downgrade. Drives the bypassHint phrasing below.
  let standardFallbackSurvivors = 0;

  for (const c of candidates) {
    const monthlyBytes = c.bytes * scaleToMonth;
    coveredBytes += c.bytes;
    patternsByTier[c.tier] += 1;

    // Resolve the action for this row.
    let action: Action;
    let reason: string;
    let floorReason: string | undefined;
    // Provenance: which caller-configurable default (if any) was chosen
    // pre-downgrade. After the target-met downgrade fires we check if
    // `action` still equals this default: if yes, the default actually
    // drove output for this row.
    let defaultTier: 'standard' | 'debug' | 'synthetic' | null = null;

    const floorHit = floorSet.get(c.pattern_hash);
    if (floorHit !== undefined) {
      action = 'pass';
      reason = 'floor';
      floorReason = `signal_floor: ${floorHit}`;
      floorCount++;
    } else if (c.tier === 'audit') {
      action = 'pass';
      reason = 'tier=audit';
    } else if (c.tier === 'error') {
      action = 'sample';
      reason = 'tier=error';
    } else if (c.tier === 'standard') {
      // Phase 2: the standard-tier action is the service's resolved
      // recommendation (per-container), falling back to the env-wide default.
      const decision = serviceActionByContainer.get(c.container);
      action = decision ? decision.action : effectiveStandardAction;
      reason = 'tier=standard';
      defaultTier = 'standard';
    } else if (c.tier === 'debug') {
      action = debugAction;
      reason = 'tier=debug';
      defaultTier = 'debug';
    } else {
      action = syntheticAction;
      reason = 'tier=synthetic';
      defaultTier = 'synthetic';
    }

    // If target already met, downgrade further standard rows to pass.
    // Suppressed when respect_default_action=true so the configured
    // defaults fire on every matching row regardless of target.
    if (
      action !== 'pass' &&
      action !== 'sample' &&
      floorHit === undefined &&
      c.tier !== 'audit' &&
      c.tier !== 'error' &&
      remainingBytesToShed <= 0 &&
      !args.respect_default_action
    ) {
      action = 'pass';
      reason = `${reason} (target met)`;
      // Downgrade clobbers the default — no longer counts as applied.
      defaultTier = null;
    }

    // Tally per-tier "default actually applied" only when the final action
    // still matches the configured default for the row's tier.
    if (defaultTier !== null) {
      const configuredDefault =
        defaultTier === 'standard'
          ? effectiveStandardAction
          : defaultTier === 'debug'
            ? debugAction
            : syntheticAction;
      if (action === configuredDefault) {
        appliedDefaultByTier[defaultTier] += 1;
      }
    }

    // Bug A: track standard-tier survivors whose final action is the
    // destination-compat fallback (`effectiveStandardAction`). When the
    // requested standard action is a no-op on this destination (e.g.
    // compact on cloudwatch → tier_down), the fallback mapping fires
    // before the target-met downgrade. If ALL of those rows then get
    // downgraded to pass (zero survivors), the bypassHint must NOT
    // claim "rows took tier_down" — it has to say "rows were initially
    // mapped to tier_down then downgraded to pass". The hint logic
    // below uses this counter to pick the right phrasing.
    if (
      c.tier === 'standard' &&
      action === effectiveStandardAction &&
      effectiveStandardAction !== standardAction
    ) {
      standardFallbackSurvivors += 1;
    }

    // Project savings range using the cost lib. For a compact row, thread the
    // service's measured compaction ratio (cost.ts honors it for compact only
    // on envelope destinations, where the on-wire size IS the billed size).
    const range = projectActionRange({
      action,
      bytes_in: monthlyBytes,
      avg_event_size_bytes: c.events > 0 ? c.bytes / c.events : undefined,
      sample_n: 10,
      destination,
      retention_months: 1,
      esPruned: args.es_pruned,
      customer_rate: customerRate,
      compact_ratio_override:
        action === 'compact'
          ? serviceActionByContainer.get(c.container)?.compact_ratio_override
          : undefined,
    });

    // Track shed bytes.
    const shed = monthlyBytes - range.expected.bytes_out;
    if (
      action !== 'pass' &&
      floorHit === undefined &&
      c.tier !== 'audit'
    ) {
      remainingBytesToShed -= shed;
    }

    actionsUsed[action] = (actionsUsed[action] ?? 0) + 1;

    const capBytesPerWindow = computeCapBytesPerWindow(action, monthlyBytes);

    // Baseline (no-action) cost in the SAME projection model as `range`, so the
    // per-pattern dollar saving is internally consistent: dollars% tracks
    // bytes% for byte-reducing actions, and tier_down's rate delta is still
    // captured. pass → baseline == projected → 0.
    const baselineExpectedUsd =
      action === 'pass'
        ? (range.expected.total_dollars ?? 0)
        : (projectActionRange({
            action: 'pass',
            bytes_in: monthlyBytes,
            avg_event_size_bytes: c.events > 0 ? c.bytes / c.events : undefined,
            sample_n: 10,
            destination,
            retention_months: 1,
            esPruned: args.es_pruned,
            customer_rate: customerRate,
          }).expected.total_dollars ?? 0);

    rows.push({
      pattern_hash: c.pattern_hash,
      pattern: c.pattern,
      container: c.container,
      current_bytes_30d: Math.round(monthlyBytes),
      cap_bytes_per_window: Math.round(capBytesPerWindow),
      action,
      // Actual per-pattern shed. 0 bytes for pass / tier_down (no on-wire
      // reduction); tier_down's saving shows up in dollars via the rate delta.
      saved_bytes_monthly: Math.round(Math.max(0, monthlyBytes - range.expected.bytes_out)),
      saved_dollars_monthly: roundCents(
        Math.max(0, baselineExpectedUsd - (range.expected.total_dollars ?? 0))
      ),
      // total_dollars is now nullable on SavingsProjection — null means the
      // destination has no list rate and no customer override. Current
      // surface still emits a number; full rate_source propagation lands in
      // the configure-engine patch.
      projected_monthly_usd_low: roundCents(range.low.total_dollars ?? 0),
      projected_monthly_usd_expected: roundCents(range.expected.total_dollars ?? 0),
      projected_monthly_usd_high: roundCents(range.high.total_dollars ?? 0),
      floor_reason: floorReason,
      reason,
    });

    if (range.expected.notes) {
      for (const n of range.expected.notes) {
        if (!warnings.includes(n)) warnings.push(n);
      }
    }
  }

  // Bug A: now that the solver has run, emit the destination-compat
  // fallback warning IF and only IF rows actually survived carrying the
  // fallback action. When zero rows survived (every standard-tier row
  // was demoted to pass by the target-met downgrade), we say so —
  // claiming the fallback fired without survivors gives the agent a
  // misleading mental model of the policy actually deployed.
  //
  // Phase 2: under auto-recommend the per-service resolver already chose each
  // container's no-op-compact fallback and explains it in per_service_summary,
  // so this env-wide warning would double-report. Only fire it on the legacy
  // single-action path (auto_recommend=false).
  if (standardCompactNoOpFallbackFired && !autoRecommend) {
    if (standardFallbackSurvivors > 0) {
      warnings.push(
        `\`compact\` is a no-op on ${destination}; ${standardFallbackSurvivors} standard-tier row${standardFallbackSurvivors === 1 ? '' : 's'} took \`${effectiveStandardAction}\` (destination's preferred level-1 action). Override via \`action_defaults.standard\`.`
      );
    } else if (patternsByTier.standard > 0) {
      warnings.push(
        `\`compact\` is a no-op on ${destination}; the destination-compat fallback would map standard-tier rows to \`${effectiveStandardAction}\`, but all ${patternsByTier.standard} standard-tier row${patternsByTier.standard === 1 ? '' : 's'} were downgraded to \`pass\` because the target was already met by error-tier sampling. No fallback action survived in the final policy.`
      );
    }
    // (No warning when patternsByTier.standard === 0 — the
    // unused-default block below already covers it.)
  }

  // ── action_defaults resolution diagnostic ──
  // Build a structured record of which caller-requested defaults actually
  // drove row output vs were swallowed. Two failure modes:
  //   1. Tier had zero candidate patterns → `unused_defaults`.
  //   2. Tier had patterns but every row that would have taken the default
  //      was overridden (floor pin, target-met downgrade, or the
  //      destination-compat fallback for the standard tier) →
  //      `defined_but_unused_defaults`. Without this, `effective.standard`
  //      reads as `offload` even when zero rows took it (the action_mix
  //      proves the contradiction) — a false positive the agent can't
  //      detect structurally. We also null out the corresponding
  //      `effective` field in that case.
  // Audit and error tiers carry hardcoded actions; only standard/debug/
  // synthetic are caller-configurable, so those are the only tiers we
  // surface as potentially-unused. Prose warnings still fire so non-
  // structured consumers see the signal.
  const totalPatternsClassified =
    patternsByTier.audit +
    patternsByTier.error +
    patternsByTier.standard +
    patternsByTier.debug +
    patternsByTier.synthetic;
  const classificationSummary =
    `audit=${patternsByTier.audit}, error=${patternsByTier.error}, ` +
    `standard=${patternsByTier.standard}, debug=${patternsByTier.debug}, ` +
    `synthetic=${patternsByTier.synthetic}`;
  const unusedDefaults: Array<{ tier: Tier; requested: Action; reason: string }> = [];
  const definedButUnusedDefaults: Array<{
    tier: Tier;
    requested: Action;
    classified_count: number;
    reason: string;
  }> = [];
  type ConfigurableTier = 'standard' | 'debug' | 'synthetic';
  const configurableTiers: Array<{
    tier: ConfigurableTier;
    requested: Action;
    effective: Action;
    bypassHint: string;
  }> = [
    {
      tier: 'standard',
      requested: standardAction,
      effective: effectiveStandardAction,
      // Bug A: the bypassHint must reflect what the solver ACTUALLY did,
      // not what the destination-compat fallback initially proposed. Four
      // cases, narrowed by (fallback fired?) × (any survivor?):
      bypassHint:
        effectiveStandardAction !== standardAction
          ? standardFallbackSurvivors > 0
            ? `standard-tier rows took \`${effectiveStandardAction}\` (destination-compat fallback) instead of your requested \`${standardAction}\` (${standardFallbackSurvivors} survived target-met downgrade)`
            : `standard-tier rows were initially mapped to \`${effectiveStandardAction}\` (destination-compat fallback for \`${standardAction}\` on \`${destination}\`), then ALL downgraded to \`pass\` because the target was already met by error-tier sampling`
          : 'every standard-tier row was floor-pinned or downgraded to `pass` because the target was already met by error-tier sampling',
    },
    {
      tier: 'debug',
      requested: debugAction,
      effective: debugAction,
      bypassHint:
        'every debug-tier row was floor-pinned or downgraded to `pass` because the target was already met by error-tier sampling',
    },
    {
      tier: 'synthetic',
      requested: syntheticAction,
      effective: syntheticAction,
      bypassHint:
        'every synthetic-tier row was floor-pinned or downgraded to `pass` because the target was already met by error-tier sampling',
    },
  ];
  for (const { tier, requested, bypassHint } of configurableTiers) {
    // Phase 2: under auto-recommend the standard-tier action is chosen
    // per-service (compressibility-driven), NOT from the global compact
    // default, so "default never applied" does not apply to the standard tier.
    // A correct plan that auto-diverts every service to offload would otherwise
    // fire a false "downgraded to pass" warning. per_service_summary is the
    // surface that explains each service's chosen standard-tier action.
    if (tier === 'standard' && autoRecommend) continue;
    if (patternsByTier[tier] === 0) {
      const reason =
        `0 of ${totalPatternsClassified} patterns classified as ${tier}-tier; ` +
        `your ${tier}='${requested}' default did not apply. ` +
        `Patterns classified: ${classificationSummary}.`;
      unusedDefaults.push({ tier, requested, reason });
      warnings.push(
        `action_defaults.${tier}='${requested}' did not fire: ${reason}`
      );
    } else if (appliedDefaultByTier[tier] === 0) {
      const reason =
        `${patternsByTier[tier]} pattern${patternsByTier[tier] === 1 ? '' : 's'} ` +
        `classified as ${tier}-tier but 0 took your ${tier}='${requested}' default; ` +
        `${bypassHint}. Reading effective.${tier} as '${requested}' is a false ` +
        `positive — the action_mix carries the truth.`;
      definedButUnusedDefaults.push({
        tier,
        requested,
        classified_count: patternsByTier[tier],
        reason,
      });
      warnings.push(
        `action_defaults.${tier}='${requested}' was defined but never applied: ${reason}`
      );
    }
  }
  const actionDefaultResolution: ConfigureEngineData['action_default_resolution'] = {
    requested: {
      standard: standardAction,
      debug: debugAction,
      synthetic: syntheticAction,
    },
    effective: {
      // Null when zero rows took the default (either tier was empty or every
      // candidate row was overridden by a floor / target-met downgrade / the
      // destination-compat fallback). Reading the requested action here when
      // nothing actually applied it was the Fix-A false positive.
      standard: appliedDefaultByTier.standard > 0 ? effectiveStandardAction : null,
      debug: appliedDefaultByTier.debug > 0 ? debugAction : null,
      synthetic: appliedDefaultByTier.synthetic > 0 ? syntheticAction : null,
    },
    classified_count_by_tier: patternsByTier,
    applied_default_count_by_tier: appliedDefaultByTier,
    unused_defaults: unusedDefaults,
    defined_but_unused_defaults: definedButUnusedDefaults,
    respect_default_action: args.respect_default_action ?? false,
  };

  const coveragePct = totalObservedBytes > 0
    ? coveredBytes / totalObservedBytes
    : 0;

  // Feasibility: did greedy hit the target within tolerance?
  const achievedShedBytes = targetShedBytes - Math.max(0, remainingBytesToShed);
  const feasible =
    targetShedBytes === 0 ||
    Math.abs(achievedShedBytes - targetShedBytes) / Math.max(1, targetShedBytes) <=
      FEASIBILITY_TOLERANCE_PCT;

  let infeasibleReason: string | undefined;
  if (!feasible && remainingBytesToShed > 0) {
    infeasibleReason = `Cannot hit ${targetPercent.toFixed(1)}% target without violating floors / tier defaults. Short by ~${humanBytes(remainingBytesToShed)}/mo. Lower target_percent, relax signal_floor, or change action_defaults.standard (currently \`${effectiveStandardAction}\`).`;
    blocking.push(infeasibleReason);
  }

  // Zero-change PR: target already met by current config.
  const targetMetByCurrent = targetShedBytes <= 0;

  // CSV diff. Preamble captures the committed target + observed baseline so
  // a later `mode='refresh'` call can compute volume drift without
  // re-running the SIEM / live-Prometheus path against the original window.
  const csvDiff = renderCsvDiff(
    args.containers,
    args.current_csv,
    rows,
    effectiveStandardAction,
    new Map([...serviceActionByContainer].map(([k, v]) => [k, v.action] as const)),
    args.reduction ?? 'hard',
    { targetPercent, baselineMonthlyBytes: currentMonthlyBytes }
  );

  // The cap CSV is now the single engine-fed file: each cap row carries the
  // action folded into the value (`container,<bytes>:<action>`), so the
  // gitops PR and the kubectl ConfigMap both deliver only caps.csv. The
  // legacy action-intent.json / actions.csv side-files are no longer written.

  const prCommand =
    !feasible || targetMetByCurrent
      ? null
      : renderPrCommand(args, target.resolved, csvDiff);

  // ── Auto-apply (industry-standard MCP write-tool behavior) ──
  // Convention: write-capable MCPs auto-execute by default; safety lives in
  // the gh CLI token scope and the MCP client's approval UX. Per-call
  // opt-outs: auto_apply=false or read_only=true. Falls through silently
  // (no change in behavior) when prCommand is null (infeasible plan or
  // zero-change PR). The branch on args.delivery picks the actual writer:
  // gitops → gh PR; kubectl_configmap → kubectl apply -f -.
  let applied: ConfigureEngineData['applied'];
  let commitmentId: string | undefined;
  const shouldApply =
    (args.auto_apply ?? true) &&
    !(args.read_only ?? false) &&
    feasible &&
    !targetMetByCurrent;
  if (shouldApply && args.delivery === 'kubectl_configmap') {
    requireWriteAccess(
      'writes the cap-CSV + action-intent.json to a k8s ConfigMap (kubectl apply); engine\'s ConfigMap pull driver picks it up on next poll'
    );
    const newCsv = reconstructAfterCsv(csvDiff, args.current_csv);
    const cmName = args.kubectl_configmap_name ?? 'log10x-action-intent';
    // Namespace resolution: explicit arg → 'default'. Receiver pod's
    // K8S_CONFIGMAP env var picks the ConfigMap name; the kubeconfig
    // context picks the cluster. Operator supplies namespace when not
    // 'default' (otel-demo uses 'demo' for its receiver DS).
    const ns = args.kubectl_namespace ?? 'default';
    const result = await applyViaKubectlConfigMap(newCsv, cmName, ns);
    applied = { ...result, delivery: 'kubectl_configmap' };
    if (result.ok) {
      commitmentId = persistCommitmentOnApply({
        service: args.service,
        envNickname: env.nickname,
        destination,
        targetPercent,
        contractType: args.contract_type ?? 'on_demand',
        baselineMonthlyBytes: currentMonthlyBytes,
        baselineMonthlyUsd: currentMonthlyUsd,
        observationDays: args.observationDays ?? 7,
        deliveryTarget: { kind: 'configmap', namespace: ns, name: cmName },
      });
    }
  } else if (shouldApply && prCommand) {
    requireWriteAccess(
      'opens a GitHub PR against the gitops repo (gh CLI) to modify the cap-CSV at pipelines/run/receive/rate/caps.csv'
    );
    const result = await applyViaGh(prCommand);
    applied = { ...result, delivery: 'gitops' };
    if (result.ok) {
      commitmentId = persistCommitmentOnApply({
        service: args.service,
        envNickname: env.nickname,
        destination,
        targetPercent,
        contractType: args.contract_type ?? 'on_demand',
        baselineMonthlyBytes: currentMonthlyBytes,
        baselineMonthlyUsd: currentMonthlyUsd,
        observationDays: args.observationDays ?? 7,
        deliveryTarget: { kind: 'gitops', repo: env.gitops?.repo },
      });
    }
  }

  const nextActions: Array<{ tool: string; args: unknown; why: string }> = [
    {
      tool: 'log10x_estimate_savings',
      args: {
        mode: 'forecast',
        proposed_config: rows.map((r) => ({
          pattern_hash: r.pattern_hash,
          action: r.action,
          cap_bytes_per_window: r.cap_bytes_per_window,
        })),
        destination,
        es_pruned: args.es_pruned,
        service: args.service,
      },
      why: 'Independent forecast confirmation of the proposed policy.',
    },
  ];

  if (!feasible) {
    nextActions.push({
      tool: 'log10x_baseline',
      args: { horizon: '30d', destination },
      why: 'Establish whether a less aggressive target is achievable given current volume + growth.',
    });
  }

  // Phase 2 discoverability: when the per-service advisory had no measured
  // ratio at all (no live optimize-mode metric, no service_compaction passed)
  // on a destination where compaction matters, point the agent at the real
  // measurement so the next call is grounded in the codec instead of the band.
  if (
    autoRecommend &&
    model.compact_mode !== 'no-op' &&
    !args.service_compaction &&
    ![...serviceActionByContainer.values()].some((d) => d.ratio_source !== 'static_band')
  ) {
    nextActions.push({
      tool: 'log10x_measure_compaction',
      args: { service: args.containers?.[0] ?? args.service, sample_size: 500, timeRange: '24h' },
      why: `Per-service compaction is currently the modeled ${destination} band (no live optimize-mode metric, no service_compaction supplied). Run measure_compaction per service (real codec on a real sample), then re-call configure_engine with service_compaction={ "<container>": { compaction_ratio_x } } to ground each compact-vs-offload decision in the measured ratio.`,
    });
  }

  // Phase 2: offer a "pin these" affordance so the user can lock the
  // auto-recommended per-service actions into a service_policy for future
  // refresh runs (otherwise each run re-derives from live compressibility).
  const autoPicked = [...serviceActionByContainer.entries()].filter(
    ([, d]) => d.source === 'auto'
  );
  if (feasible && autoPicked.length > 0) {
    const pinPolicy: Record<string, { standard_action: Action }> = {};
    for (const [container, d] of autoPicked) {
      pinPolicy[container] = { standard_action: d.action };
    }
    nextActions.push({
      tool: 'log10x_configure_engine',
      args: {
        ...args,
        service_policy: { ...(args.service_policy ?? {}), ...pinPolicy },
      },
      why: `Pin the ${autoPicked.length} auto-recommended per-service action${autoPicked.length === 1 ? '' : 's'} so future refresh runs keep them instead of re-deriving from live compressibility.`,
    });
  }

  // ── Phase 2: per-service advisory summary ──
  // Fold the plan by k8s_container: each service's chosen standard-tier action,
  // its share of volume, and the savings its rows delivered. Sorted DESC by
  // volume (lead with GB, not dollars).
  const perServiceAgg = new Map<string, { bytesIn: number; savedBytes: number; savedDollars: number }>();
  for (const r of rows) {
    const c = r.container ?? args.service;
    const agg = perServiceAgg.get(c) ?? { bytesIn: 0, savedBytes: 0, savedDollars: 0 };
    agg.bytesIn += r.current_bytes_30d;
    agg.savedBytes += r.saved_bytes_monthly;
    agg.savedDollars += r.saved_dollars_monthly;
    perServiceAgg.set(c, agg);
  }
  const perServiceSummary: PerServiceSummaryRow[] = [...perServiceAgg.entries()]
    .map(([service, agg]): PerServiceSummaryRow => {
      const decision = serviceActionByContainer.get(service);
      return {
        service,
        chosen_action: decision?.action ?? effectiveStandardAction,
        source: decision?.source ?? 'global_default',
        bytes_in_monthly: Math.round(agg.bytesIn),
        bytes_share_pct:
          currentMonthlyBytes > 0 ? roundOne((agg.bytesIn / currentMonthlyBytes) * 100) : 0,
        saved_bytes_monthly: Math.round(agg.savedBytes),
        saved_dollars_monthly: roundCents(agg.savedDollars),
        measured_compression_pct: decision?.measured_compression_pct ?? null,
        ratio_source: decision?.ratio_source ?? 'static_band',
        keep_queryable: decision?.keep_queryable ?? false,
        reason: decision?.reason ?? 'global default',
      };
    })
    .sort((a, b) => b.bytes_in_monthly - a.bytes_in_monthly);

  const phase: ConfigureEngineData['phase'] = !feasible
    ? 'solver_failed'
    : 'pr_rendered';

  const data: ConfigureEngineData = {
    ok: phase === 'pr_rendered',
    phase,
    service: args.service,
    containers: args.containers,
    destination,
    target_percent: roundOne(targetPercent),
    derivation: {
      current_monthly_bytes: Math.round(currentMonthlyBytes),
      current_monthly_usd: roundCents(currentMonthlyUsd),
      target_monthly_bytes: Math.round(targetMonthlyBytes),
      target_monthly_usd: roundCents(
        (targetMonthlyBytes / GB) *
          (ingestPerGb + model.storage_per_gb_month)
      ),
      floor_count: floorCount,
      actions_used: actionsUsed,
    },
    per_pattern_rows: rows,
    per_service_summary: perServiceSummary,
    checks: {
      coverage_pct: roundPct(coveragePct),
      feasible,
      infeasible_reason: infeasibleReason,
      blocking,
      warnings,
    },
    csv_diff: csvDiff,
    pr_command: prCommand,
    applied,
    commitment_id: commitmentId,
    action_default_resolution: actionDefaultResolution,
    refresh: refreshState
      ? {
          skipped: false,
          prior_monthly_bytes: refreshState.priorBaselineMonthlyBytes !== undefined
            ? Math.round(refreshState.priorBaselineMonthlyBytes)
            : undefined,
          current_monthly_bytes: Math.round(currentMonthlyBytes),
          drift_pct: refreshState.priorBaselineMonthlyBytes !== undefined &&
            refreshState.priorBaselineMonthlyBytes > 0
            ? roundOne(
                Math.abs(
                  currentMonthlyBytes - refreshState.priorBaselineMonthlyBytes
                ) /
                  refreshState.priorBaselineMonthlyBytes *
                  100
              )
            : 100,
          tolerance_pct: refreshState.tolerancePct,
          committed_target_percent: refreshState.committedTargetPercent,
          reason: refreshState.priorBaselineMonthlyBytes !== undefined
            ? `Volume drifted beyond ${refreshState.tolerancePct}% tolerance; re-tuned caps to keep delivering the ${refreshState.committedTargetPercent}% commitment.`
            : `No prior baseline in cap-CSV preamble; recomputed caps from scratch against the ${refreshState.committedTargetPercent}% commitment.`,
        }
      : undefined,
    next_actions: nextActions,
    human_summary: buildConfigureEngineHumanSummary({
      feasible,
      targetPercent,
      service: args.service,
      containerCount: args.containers.length,
      patternCount: rows.length,
      destination,
      remainingBytesToShed,
      applied,
      refreshMode: !!refreshState,
    }),
  };

  const configHeadline = feasible
    ? `${targetPercent.toFixed(1)}% reduction policy derived for ${args.service} (${rows.length} patterns, ${args.containers.length} container${args.containers.length === 1 ? '' : 's'}).`
    : `Cannot hit ${targetPercent.toFixed(1)}% target on ${args.service} without violating floors.`;

  // ── View projection ───────────────────────────────────────────────
  // Default `view='summary'` strips the three big payload offenders
  // (pr_command ~28.8KB, per_pattern_rows ~27.3KB, csv_diff ~5.3KB) and
  // emits the slim shape: action_mix counts + totals + top-5 cost
  // contributors + PR-command prose. `view='detail'` keeps the full
  // envelope. `view='pr_command_only'` returns just the gh script for
  // copy-paste callers that don't render markdown. action_default_
  // resolution stays in the summary view — it's a small structured
  // field that helps the agent branch deterministically.
  const view = args.view ?? 'summary';
  const viewWarnings: string[] = [...warnings];
  let payload: unknown;

  if (view === 'pr_command_only') {
    payload = { pr_command: prCommand };
  } else if (view === 'detail') {
    payload = data;
  } else {
    payload = buildSummaryPayload({
      data,
      rows,
      prCommand,
      target: target.resolved,
      args,
      currentMonthlyBytes,
      targetMonthlyBytes,
      currentMonthlyUsd,
      model,
      ingestPerGb,
      csvDiff,
    });
  }

  // Token-budget warning. Estimate bytes/4 ≈ tokens; warn the agent if
  // even the slim summary blew the 8K target so it can decide whether
  // to narrow scope (smaller containers list, lower target_percent).
  const estimatedTokens = Math.ceil(JSON.stringify(payload).length / 4);
  if (view === 'summary' && estimatedTokens > 8000) {
    viewWarnings.push(
      `response payload ~${estimatedTokens} tokens, exceeds the 8K target for view='summary'. ` +
        "Try a tighter containers scope or call view='pr_command_only' for just the gh script.",
    );
  }

  return buildChassisEnvelope({
    tool: 'log10x_configure_engine',
    view: 'summary',
    headline: configHeadline,
    status: feasible ? 'success' : 'partial',
    decisions: {
      threshold_used: targetPercent,
      threshold_basis: args.target_percent != null ? 'customer_supplied' : 'default',
    },
    source_disclosure: {
      bytes_source: 'tsdb',
      siem_vendor: destination,
      // C-policy: disclose whether the dollar projections used the customer's
      // contracted rate or the SIEM vendor list rate. When list, the chassis
      // attaches a calibration callout so the dollar is never quoted as the
      // customer's real number; the headline already leads with the exact
      // percent + GB volume.
      rate_source:
        resolvedIngest.source === 'customer_supplied'
          ? 'customer_supplied'
          : resolvedIngest.source === 'list_price'
            ? 'list_price'
            : 'none',
      pattern_count_source: {
        kind: 'scoped_total_above_threshold',
        count: rows.length,
        denominator_meaning: `Patterns above floor for service "${args.service}" over ${args.observationDays ?? 7}d`,
      },
    },
    scope: {
      window: `${args.observationDays ?? 7}d`,
      window_basis: 'explicit',
      candidates_count: rows.length,
      candidates_usable: rows.length,
    },
    payload,
    human_summary: data.human_summary ?? configHeadline,
    actions: toEnvelopeActions(nextActions),
    warnings: viewWarnings,
  });
}

/**
 * Build the slim default-view payload. Drops the three dominant token
 * offenders (pr_command, per_pattern_rows, csv_diff — all behind
 * `view='detail'`) and emits a compact summary: action_mix counts,
 * totals (bytes_in / bytes_saved / dollars_saved), top-5 cost
 * contributors, and a PR-command prose summary that names the repo +
 * branch + addition/change counts without inlining the gh script.
 */
function buildSummaryPayload(params: {
  data: ConfigureEngineData;
  rows: PerPatternRow[];
  prCommand: string | null;
  target: ResolvedTarget;
  args: ConfigureEngineArgs;
  currentMonthlyBytes: number;
  targetMonthlyBytes: number;
  currentMonthlyUsd: number;
  model: ReturnType<typeof getDestinationCostModel>;
  ingestPerGb: number;
  csvDiff: string;
}): Record<string, unknown> {
  const { data, rows, prCommand, target, args, currentMonthlyBytes, targetMonthlyBytes, currentMonthlyUsd, model, ingestPerGb, csvDiff } = params;

  // Action mix: count of patterns per action.
  const actionMix: Partial<Record<Action, number>> = {};
  for (const r of rows) {
    actionMix[r.action] = (actionMix[r.action] ?? 0) + 1;
  }

  // Totals: report the solver's ACTUAL projected shed (the sum of the
  // per-pattern plan), not the flat `current - target` budget. A `pass`
  // row sheds nothing, so it contributes zero: pass is no longer credited as
  // savings, and the headline reconciles with the per-pattern breakdown by
  // construction. The flat target still appears as derivation.target_monthly_*,
  // clearly labelled as the GOAL, distinct from what the plan delivers.
  const bytesSavedMonthly = rows.reduce((s, r) => s + r.saved_bytes_monthly, 0);
  const dollarsSavedMonthly = rows.reduce((s, r) => s + r.saved_dollars_monthly, 0);
  void targetMonthlyBytes;

  // Top-5 cost contributors (DESC by current_bytes_30d). Descriptor
  // truncated to 60 chars per spec — uses the row's `reason` field as
  // the most-informative short label (e.g. "tier=standard",
  // "tier=debug", "signal_floor: dashboard:payments-overview").
  const top5 = [...rows]
    .sort((a, b) => b.current_bytes_30d - a.current_bytes_30d)
    .slice(0, 5)
    .map((r) => ({
      pattern_hash: r.pattern_hash,
      descriptor: truncate(r.floor_reason ?? r.reason, 60),
      action: r.action,
      bytes_share_pct: currentMonthlyBytes > 0
        ? roundOne((r.current_bytes_30d / currentMonthlyBytes) * 100)
        : 0,
    }));

  // PR-command prose summary. Names the repo + branch + addition /
  // change counts so the agent can describe what would happen without
  // copy-pasting the 28.8KB gh script. `+ N` lines come from the
  // unified diff (lines starting with `+` that aren't the header).
  // When the gitops repo is not configured (kubectl_configmap /
  // stdout_only delivery, or unset `gitops.repo` in envs.json) the
  // resolved repo is an empty string — falling through to the unguarded
  // template produced "Opens a PR against  on branch main", a literal
  // double-space gap. We now surface the not-configured signal instead
  // of pretending a PR will open. checks.warnings[] still
  // carries the structured signal.
  let prCommandSummary: string;
  if (!prCommand) {
    prCommandSummary = data.checks?.feasible === false
      ? 'Plan is infeasible at the requested target; no PR command rendered. See checks.infeasible_reason.'
      : 'Target already met by current config; no PR command rendered (zero-change PR).';
  } else if (!target.gitops_repo) {
    prCommandSummary =
      'gitops not configured — set `gitops.repo` in `~/.log10x/envs.json` ' +
      '(or pass `gitops_repo` on this call) to enable PR creation. ' +
      `Delivery mode \`${args.delivery ?? 'gitops'}\` does not require it; ` +
      'the rendered policy is still available via `view=\'detail\'`.';
  } else {
    const additions = csvDiff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const removals = csvDiff
      .split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    const changeNote = removals > 0 ? `${additions} additions and ${removals} changes` : `${additions} additions`;
    prCommandSummary =
      `Opens a PR against ${target.gitops_repo} on branch ${target.gitops_branch} modifying ` +
      `${target.lookup_path} with ${changeNote}.` +
      (data.applied?.ok && data.applied.pr_url
        ? ` PR already auto-applied: ${data.applied.pr_url}.`
        : '');
  }

  // Strip the proposed_config row dump out of next_actions for the slim
  // view (119 patterns × {pattern_hash, action, cap_bytes_per_window} =
  // ~9.5KB of args). Replace it with a hint that the agent can re-run
  // configure_engine view='detail' to recover the verbatim proposed_config
  // for estimate_savings. Other next_actions (no proposed_config) pass
  // through unchanged.
  const slimNextActions = (data.next_actions ?? []).map((na) => {
    if (
      na.tool === 'log10x_estimate_savings' &&
      typeof na.args === 'object' &&
      na.args !== null &&
      'proposed_config' in (na.args as Record<string, unknown>)
    ) {
      const { proposed_config: _omit, ...rest } = na.args as Record<string, unknown>;
      void _omit;
      return {
        ...na,
        args: {
          ...rest,
          proposed_config_hint: `Re-call log10x_configure_engine with view='detail' to recover the ${rows.length}-row proposed_config for estimate_savings.`,
        },
      };
    }
    return na;
  });

  return {
    ok: data.ok,
    phase: data.phase,
    target_percent: data.target_percent,
    destination: data.destination,
    containers: data.containers,
    service: data.service,
    action_mix: actionMix,
    totals: {
      bytes_in_monthly: Math.round(currentMonthlyBytes),
      bytes_saved_monthly: Math.round(bytesSavedMonthly),
      dollars_saved_monthly: roundCents(dollarsSavedMonthly),
    },
    top_5_per_pattern: top5,
    // Phase 2: per-service advisory, capped to the top services by volume so
    // the slim view stays within budget (services << patterns; full list is
    // in view='detail'). Each entry leads with volume, then the chosen action.
    per_service_summary: (data.per_service_summary ?? []).slice(0, 12),
    pr_command_summary: prCommandSummary,
    derivation: data.derivation,
    checks: data.checks,
    applied: data.applied,
    commitment_id: data.commitment_id,
    action_default_resolution: data.action_default_resolution,
    refresh: data.refresh,
    next_actions: slimNextActions,
    human_summary: data.human_summary,
    details_available: {
      pr_command_via: "arg view='detail' (or view='pr_command_only' for just the gh script)",
      per_pattern_rows_via: "arg view='detail'",
      csv_diff_via: "arg view='detail'",
      pattern_count: rows.length,
      service_count: (data.per_service_summary ?? []).length,
      // Summary view shows the top 12 services by volume; the rest are in
      // view='detail'. action_mix/totals always reflect ALL services.
      per_service_summary_truncated: (data.per_service_summary ?? []).length > 12,
      per_service_summary_via:
        (data.per_service_summary ?? []).length > 12
          ? `arg view='detail' for all ${(data.per_service_summary ?? []).length} services`
          : undefined,
    },
  };
}

/** Truncate a string to maxLen chars; appends "..." when cut. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

// ─── from_poc_id consumer path ────────────────────────────────────────
/**
 * When `from_poc_id` is set, attempt to read the POC snapshot's
 * `cap_csv` field directly and render the PR around it — no
 * Prometheus pull, no greedy re-derivation. Returns the wrapped
 * envelope when successful, `undefined` when the snapshot is absent
 * / expired / has no `cap_csv`, signalling the caller to fall through
 * to the live-Prometheus path.
 *
 * The POC's `cap_csv` is composed in `poc-envelope-v2.ts:buildCapCsv`
 * from the per-pattern 6-action recommendations the renderer emitted.
 * We re-build the envelope here (cheap — patterns are already
 * templatized and stored on the snapshot) so the cap_csv reflects the
 * latest action mapping rules, not whatever the snapshot was
 * serialized with.
 */
async function tryConsumePocSnapshot(
  args: ConfigureEngineArgs,
  resolved: ResolvedTarget,
): Promise<StructuredOutput | undefined> {
  if (!args.from_poc_id) return undefined;
  const snap = getPocSnapshot(args.from_poc_id);
  if (!snap || snap.status !== 'complete' || !snap.renderInput) return undefined;
  if (snap.targetPercentReduction === undefined) return undefined;

  // Rebuild the envelope so cap_csv reflects current action mapping.
  let capCsv: string | undefined;
  let feasibility: { feasible: boolean; max_achievable_percent: number; target_percent_reduction: number } | undefined;
  try {
    const { patterns, clusters, redundancyPairs } = enrichForPocEnvelope(snap.renderInput);
    const envelope = buildPocEnvelopeV2(
      snap.renderInput,
      patterns as unknown as Parameters<typeof buildPocEnvelopeV2>[1],
      clusters,
      redundancyPairs,
      50,
      {
        targetPercentReduction: snap.targetPercentReduction,
        exceptionServices: snap.exceptionServices,
      },
    );
    capCsv = envelope.output.cap_csv;
    feasibility = envelope.output.feasibility;
  } catch {
    return undefined;
  }
  if (!capCsv) return undefined;

  // Render the PR diff: the new CSV is the POC's cap_csv body, the
  // baseline is whatever the caller passed in `current_csv` (or empty).
  const baselineCsv = args.current_csv ?? '';
  const diff = renderUnifiedDiff(baselineCsv, capCsv);

  // The PR script writes the cap CSV only (action is folded into each cap
  // row); no sibling action-intent.json / actions.csv.
  const prCommand = feasibility && feasibility.feasible
    ? renderPrCommand(args, resolved, diff)
    : null;

  let applied: ConfigureEngineData['applied'];
  let commitmentId: string | undefined;
  const shouldApply =
    (args.auto_apply ?? true) &&
    !(args.read_only ?? false) &&
    feasibility?.feasible === true;
  if (shouldApply && args.delivery === 'kubectl_configmap') {
    requireWriteAccess(
      'writes the cap-CSV to a k8s ConfigMap (kubectl apply) from the POC snapshot; engine\'s ConfigMap pull driver picks it up on next poll'
    );
    const newCsv = reconstructAfterCsv(diff, args.current_csv);
    const cmName = args.kubectl_configmap_name ?? 'log10x-action-intent';
    const ns = args.kubectl_namespace ?? 'default';
    const result = await applyViaKubectlConfigMap(newCsv, cmName, ns);
    applied = { ...result, delivery: 'kubectl_configmap' };
    // POC path: commitment persistence skipped here. The POC's renderInput
    // doesn't carry baseline_monthly_bytes/_usd in the format the
    // CommitmentRecord requires; wiring this end-to-end is a follow-on
    // once the POC envelope surfaces the same baseline fields.
  } else if (shouldApply && prCommand) {
    requireWriteAccess(
      'opens a GitHub PR against the gitops repo (gh CLI) to modify the cap-CSV at pipelines/run/receive/rate/caps.csv'
    );
    const result = await applyViaGh(prCommand);
    applied = { ...result, delivery: 'gitops' };
    // Same POC-path constraint as above — commitment persistence requires
    // baseline data the snap doesn't carry today.
  }

  const warnings: string[] = [];
  if (!feasibility || !feasibility.feasible) {
    warnings.push(
      `POC snapshot \`${args.from_poc_id}\` reported feasibility=${feasibility?.feasible ?? 'unknown'} ` +
        `(max_achievable=${feasibility?.max_achievable_percent?.toFixed(1) ?? '?'}% vs target ` +
        `${feasibility?.target_percent_reduction ?? '?'}%). PR not auto-applied.`,
    );
  }
  if (snap.exceptionServices?.length) {
    warnings.push(
      `${snap.exceptionServices.length} exception service(s) pinned to action=pass from the POC submit: ${snap.exceptionServices.join(', ')}.`,
    );
  }

  const targetPct = snap.targetPercentReduction;
  const headline = feasibility?.feasible
    ? `Wrote ${targetPct.toFixed(1)}% reduction policy from POC snapshot \`${args.from_poc_id}\` (${args.service}).`
    : `POC snapshot \`${args.from_poc_id}\` infeasible at ${targetPct.toFixed(1)}%; PR not auto-applied.`;

  const data: ConfigureEngineData = {
    ok: feasibility?.feasible ?? false,
    phase: feasibility?.feasible ? 'pr_rendered' : 'solver_failed',
    service: args.service,
    containers: args.containers ?? [],
    destination: resolved.destination,
    target_percent: targetPct,
    csv_diff: diff,
    pr_command: prCommand,
    applied,
    next_actions: [
      {
        tool: 'log10x_estimate_savings',
        args: { mode: 'verify', service: args.service, destination: resolved.destination },
        why: 'Verify the POC-derived policy against live receiver telemetry once the PR merges.',
      },
    ],
    checks: {
      coverage_pct: 1,
      feasible: feasibility?.feasible ?? false,
      blocking: feasibility?.feasible ? [] : ['poc_feasibility_short'],
      warnings,
    },
    human_summary: feasibility?.feasible
      ? `POC snapshot \`${args.from_poc_id}\` already decided the policy; configure_engine wrote ${capCsv.split('\n').length - 1} rows to the cap CSV at ${targetPct.toFixed(1)}% reduction without re-pulling Prometheus.`
      : `POC snapshot \`${args.from_poc_id}\` reported feasibility short of target; PR rendered but not applied. Lower target or widen exceptions, then re-run the POC.`,
  };

  // ── View projection ─────────────────────────────────────────────
  // POC consumer path emits csv_diff + pr_command (the two biggest
  // POC-side offenders). Apply the same summary-first projection so
  // the response stays under 8K tokens by default. POC path has no
  // per_pattern_rows of its own, so top_5_per_pattern is sourced from
  // the POC's cap_csv rows; we leave that to view='detail' to avoid a
  // second cap_csv parse here.
  const pocView = args.view ?? 'summary';
  const pocWarnings: string[] = [...warnings];
  let pocPayload: unknown;
  if (pocView === 'pr_command_only') {
    pocPayload = { pr_command: prCommand };
  } else if (pocView === 'detail') {
    pocPayload = data;
  } else {
    const additions = diff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const removals = diff
      .split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    const changeNote = removals > 0 ? `${additions} additions and ${removals} changes` : `${additions} additions`;
    // Guard the unguarded template: when the gitops repo is not
    // configured (kubectl_configmap / stdout_only delivery, or unset
    // `gitops.repo` in envs.json) `resolved.gitops_repo` is the
    // back-compat empty-string fallback from resolveTarget, which used to
    // render as "Opens a PR against  on branch main" (two-space gap).
    let prCommandSummary: string;
    if (!prCommand) {
      prCommandSummary = 'POC snapshot reported feasibility short of target; no PR command rendered.';
    } else if (!resolved.gitops_repo) {
      prCommandSummary =
        'gitops not configured — set `gitops.repo` in `~/.log10x/envs.json` ' +
        '(or pass `gitops_repo` on this call) to enable PR creation. ' +
        `Delivery mode \`${args.delivery ?? 'gitops'}\` does not require it; ` +
        'the rendered policy is still available via `view=\'detail\'`.';
    } else {
      prCommandSummary =
        `Opens a PR against ${resolved.gitops_repo} on branch ${resolved.gitops_branch} modifying ${resolved.lookup_path} with ${changeNote}.` +
        (data.applied?.ok && data.applied.pr_url ? ` PR already auto-applied: ${data.applied.pr_url}.` : '');
    }
    pocPayload = {
      ok: data.ok,
      phase: data.phase,
      target_percent: data.target_percent,
      destination: data.destination,
      containers: data.containers,
      service: data.service,
      pr_command_summary: prCommandSummary,
      applied: data.applied,
      commitment_id: data.commitment_id,
      checks: data.checks,
      next_actions: data.next_actions,
      human_summary: data.human_summary,
      source: 'poc_snapshot',
      details_available: {
        pr_command_via: "arg view='detail' (or view='pr_command_only' for just the gh script)",
        csv_diff_via: "arg view='detail'",
      },
    };
  }
  const pocEstTokens = Math.ceil(JSON.stringify(pocPayload).length / 4);
  if (pocView === 'summary' && pocEstTokens > 8000) {
    pocWarnings.push(
      `response payload ~${pocEstTokens} tokens, exceeds the 8K target for view='summary'.`,
    );
  }

  return buildChassisEnvelope({
    tool: 'log10x_configure_engine',
    view: 'summary',
    headline,
    status: feasibility?.feasible ? 'success' : 'partial',
    decisions: {
      threshold_used: targetPct,
      threshold_basis: 'snapshot',
    },
    source_disclosure: { bytes_source: 'engine_aggregated_csv', siem_vendor: resolved.destination },
    scope: { window: 'poc_snapshot', window_basis: 'auto_default' },
    payload: pocPayload,
    human_summary: data.human_summary ?? headline,
    actions: toEnvelopeActions(data.next_actions ?? []),
    warnings: pocWarnings,
  });
}

// ─── refresh-mode helpers ─────────────────────────────────────────────
interface RefreshState {
  /** Target percent the customer originally committed to. */
  committedTargetPercent: number;
  /**
   * The monthly-bytes baseline captured at the original
   * configure-mode run. Undefined when the cap-CSV is missing the
   * `# baseline_monthly_bytes=N` preamble (first refresh, or hand-edited
   * CSV); in that case the drift check is skipped and the refresh
   * unconditionally re-derives + emits a PR.
   */
  priorBaselineMonthlyBytes?: number;
  /** Tolerance band (percent). Drift below this skips the PR. */
  tolerancePct: number;
}

interface PreambleData {
  target_percent?: number;
  baseline_monthly_bytes?: number;
}

/**
 * Extract `# target_percent=N` and `# baseline_monthly_bytes=N` preamble
 * lines from a cap-CSV. Order- and whitespace-tolerant; ignores any
 * other `#` comment lines.
 */
function parsePreamble(csv: string | undefined): PreambleData {
  const out: PreambleData = {};
  if (!csv) return out;
  const lines = csv.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('#')) {
      // The preamble is at the top of the file. Once we hit a non-comment
      // non-blank line, stop scanning.
      if (line.length > 0) break;
      continue;
    }
    const tgt = TARGET_PREAMBLE_RE.exec(line);
    if (tgt) {
      const n = Number(tgt[1]);
      if (Number.isFinite(n)) out.target_percent = n;
      continue;
    }
    const m = /^#\s*baseline_monthly_bytes\s*=\s*(\d+(?:\.\d+)?)\s*$/.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) out.baseline_monthly_bytes = n;
    }
  }
  return out;
}

/**
 * Build the preamble lines for the cap-CSV. Engine-safe: the engine's
 * lookup parser ignores rows that don't match `<key>,<value>`.
 */
function renderPreamble(targetPercent: number, baselineMonthlyBytes: number): string[] {
  return [
    `# ${TARGET_PREAMBLE_KEY}=${roundOne(targetPercent)}`,
    `# baseline_monthly_bytes=${Math.round(baselineMonthlyBytes)}`,
    `# generated_by=log10x_configure_engine`,
  ];
}

// ─── target resolution ────────────────────────────────────────────────
interface ResolvedTarget {
  gitops_repo: string;
  lookup_path: string;
  gitops_branch: string;
  destination: SiemId;
  /**
   * Active env id resolved from envs.json / env vars (LOG10X_ENV_ID). Used
   * to anchor Prometheus selectors with `tenx_env="<envId>"` so per-pattern
   * scans don't fan out across every tenant on the shared prom backend.
   * Undefined for single-tenant prom backends (back-compat fallback).
   */
  envId?: string;
}

async function resolveTarget(
  args: ConfigureEngineArgs
): Promise<{ resolved: ResolvedTarget } | { error: string }> {
  let repo: string | undefined = args.gitops_repo;
  let lookupPath: string | undefined = args.lookup_path;
  let destination: SiemId | undefined = args.destination;
  let envId: string | undefined;

  // 1. Active env from envs.json. Surface the env id alongside gitops/destination
  //    so Prometheus selectors downstream can anchor with `tenx_env="<envId>"`
  //    on shared backends (prometheus.log10x.com). Without this anchor the
  //    per-pattern bytes scan fans out across every tenant whose containers
  //    share the supplied name, which can push past the 30s backend timeout.
  try {
    const envs = await loadEnvironments();
    const active = (envs as any)?.activeEnv;
    if (!repo && active?.gitops?.repo) {
      repo = active.gitops.repo;
    }
    if (!lookupPath && active?.gitops?.lookupPath) {
      lookupPath = active.gitops.lookupPath;
    }
    if (!destination && active?.destination) {
      destination = active.destination as SiemId;
    }
    if (typeof active?.envId === 'string' && active.envId) {
      envId = active.envId;
    }
  } catch {
    // non-fatal — fall through to snapshot / explicit args / env var
  }
  if (!envId && typeof process.env.LOG10X_ENV_ID === 'string' && process.env.LOG10X_ENV_ID) {
    envId = process.env.LOG10X_ENV_ID;
  }

  // 1b. Env-config doc destination (closes the auto-detect bug — most active
  //     envs in `~/.log10x/envs.json` do NOT carry a `destination` field, but
  //     the env-config document persisted to the on-prem store ALWAYS does,
  //     because the schema requires it). Resolution chain matches every other
  //     env-config-aware tool: explicit-arg > on-prem-store > env-var fallback.
  //     We've already honored the explicit arg above; here we consult the
  //     store before giving up on auto-detect.
  if (!destination) {
    try {
      const resolved = await resolveClusterConfig({ envIdOrNickname: envId });
      if (resolved.ok && resolved.config.destination?.siem_vendor) {
        const vendor = resolved.config.destination.siem_vendor;
        // env-config siem_vendor enum is a superset of the SiemId enum
        // (`azure-monitor` / `gcp-logging` are in both; `other` is not a
        // valid SiemId so it stays unresolved and we fall through to the
        // "destination not resolved" error below).
        if (vendor !== 'other') {
          destination = vendor as SiemId;
        }
      }
    } catch {
      // non-fatal — fall through to snapshot / explicit args / "not resolved"
    }
  }

  // 2. Snapshot fallback.
  if (args.snapshot_id) {
    const snapshot = getSnapshot(args.snapshot_id);
    if (!snapshot) {
      return {
        error: renderError(
          'snapshot not found',
          `Snapshot \`${args.snapshot_id}\` is missing or expired (snapshots live 30 min). Run \`log10x_discover_env\` again, or pass \`gitops_repo\` + \`destination\` directly.`
        ),
      };
    }
    const recs = (snapshot as any)?.recommendations;
    if (!repo && recs?.gitopsRepo) repo = recs.gitopsRepo;
    if (!destination && recs?.destination) destination = recs.destination as SiemId;
  }

  // Gate the GitOps repo check on delivery mode. `kubectl_configmap` writes
  // directly to a k8s ConfigMap on the active cluster and `stdout_only` just
  // returns the proposed config — neither needs a GitHub repo. Only `gitops`
  // delivery (the default) requires a resolved `gitops_repo`.
  if (args.delivery === 'gitops' && !repo) {
    return {
      error: renderError(
        'gitops repo not resolved',
        '`configure_engine` was called with `delivery=gitops` (the default), which opens a PR against a GitHub repository — and no `gitops_repo` is resolved. Three ways forward: ' +
        '(1) Switch delivery mode — `delivery="kubectl_configmap"` writes the policy directly to a k8s ConfigMap on the active cluster (no GitHub needed), or `delivery="stdout_only"` returns the proposed config in the response without writing anywhere. ' +
        '(2) Stay on gitops and pass `gitops_repo` directly on this call (owner/name, e.g. `acme/log10x-config`). ' +
        '(3) Stay on gitops and run `log10x_set_gitops_repo` to write it to `~/.log10x/envs.json` — then restart the MCP server (`log10x_dev_restart`) and retry. The `LOG10X_GH_REPO` env var on the MCP server process is also honored.'
      ),
    };
  }

  if (!destination) {
    return {
      error: renderError(
        'destination not resolved',
        'Pass `destination=` explicitly (`splunk` | `datadog` | `elasticsearch` | `clickhouse` | `cloudwatch` | `azure-monitor` | `gcp-logging` | `sumo`). Auto-detect from active env / snapshot failed.'
      ),
    };
  }

  return {
    resolved: {
      // For non-gitops delivery (`kubectl_configmap` / `stdout_only`) the
      // repo may legitimately be unresolved — the gate above only requires
      // it for `delivery === 'gitops'`. Fall back to an empty string so the
      // resolved struct stays typed; downstream `renderPrCommand` is only
      // invoked on the gitops path where `repo` was guaranteed to resolve.
      gitops_repo: repo ?? '',
      lookup_path: lookupPath ?? args.lookup_path ?? DEFAULT_LOOKUP_PATH,
      gitops_branch: args.gitops_branch ?? 'main',
      destination,
      envId,
    },
  };
}

// ─── per-pattern fetch ────────────────────────────────────────────────
interface PerPattern {
  pattern_hash: string;
  /** Human pattern name (TSDB pattern label); falls back to the hash. */
  pattern: string;
  /** k8s_container this slice belongs to (== the engine's actions.csv key). */
  container: string;
  bytes: number;
  events: number;
  severity: string;
}

// Server-side cap on the number of patterns returned. The greedy solver
// processes candidates DESC by bytes; the long tail past this cut contributes
// well under 1% of total volume and is handled by the container-level cap row.
// Bounded N keeps the Prometheus payload + per-attempt cost predictable so the
// 30s backend-fetch ceiling doesn't fire on high-cardinality envs (1k+ patterns).
const PER_PATTERN_TOPK = parseInt(process.env.LOG10X_CONFIGURE_ENGINE_TOPK || '500', 10) || 500;

async function fetchPerPatternBytes(
  env: EnvConfig,
  containers: string[],
  observationDays: number,
  envId: string | undefined
): Promise<PerPattern[]> {
  const containerRegex = containers.map(promEscape).join('|');
  // Anchor with `tenx_env="<envId>"` so Prometheus scans only the active
  // tenant's series. On shared backends (prometheus.log10x.com) skipping
  // this clause means the inner `sum by (...) (increase(...))` materializes
  // every tenant whose containers happen to share the supplied name; the
  // outer topk(500) can't slice until that inner result is fully built,
  // which is what pushes per-attempt fetches past the 30s ceiling. Other
  // tools (investigate, pattern-examples, doctor) all anchor on LABELS.env;
  // this matches that canonical pattern.
  if (!envId) {
    console.warn(
      '[configure_engine] No envId resolved (envs.json `activeEnv.envId` / LOG10X_ENV_ID); ' +
      'per-pattern bytes query will scan all tenants on shared Prom backends — ' +
      'consider setting LOG10X_ENV_ID or running log10x_discover_env first.'
    );
  }
  const envClause = envId ? `${LABELS.env}="${promEscape(envId)}",` : '';
  const filter = `${envClause}k8s_container=~"${containerRegex}"`;
  const window = `${observationDays}d`;

  // Pattern bytes (grouped by tenx_hash + severity_level to drive tier
  // inference). The aggregator's severity_level label is the engine's
  // default; per-env relabels are handled by the env's LabelNameMap, but
  // configure_engine intentionally uses the default for now — relabeled
  // envs will hit the missing-label warning path below.
  //
  // topk(N) caps both response size and Prometheus' streaming cost: the
  // engine stops materializing series past rank N. For the greedy solver
  // this is loss-free at the budget level because the cut-off patterns
  // contribute negligibly to total bytes and are absorbed by the
  // container-default cap row in the rendered CSV. Note topk is an OUTER
  // operator — Prom must fully evaluate the inner increase() before
  // slicing — so the tenx_env anchor above is the real cardinality cut.
  // Phase 2: group by k8s_container as well, so each (pattern, container)
  // slice is a distinct candidate the solver can route per service. The
  // container label IS the engine's actions.csv key (rateReceiverContainerField
  // defaults to k8s_container), so segmenting here is what makes per-service
  // action advice land on the right row. Single-container calls collapse to
  // exactly today's behavior (one container per hash).
  const bytesQ = `topk(${PER_PATTERN_TOPK}, sum by (${LABELS.hash}, ${LABELS.pattern}, ${LABELS.severity}, k8s_container)(increase(all_events_summaryBytes_total{${filter}}[${window}])))`;
  const eventsQ = `topk(${PER_PATTERN_TOPK}, sum by (${LABELS.hash}, k8s_container)(increase(all_events_summaryVolume_total{${filter}}[${window}])))`;

  const [bytesRes, eventsRes] = await Promise.all([
    queryInstant(env, bytesQ),
    queryInstant(env, eventsQ),
  ]);

  // Key events by hash+container so avg-event-size resolves per slice. A
  // missing k8s_container label degrades to "__node__" (matches the engine's
  // own fallback when the container field is absent on an event).
  const containerOf = (m: Record<string, string>): string =>
    m.k8s_container || '__node__';
  const sliceKey = (h: string, c: string): string => `${h} ${c}`;

  const eventsByKey = new Map<string, number>();
  for (const r of eventsRes.data.result) {
    const h = r.metric[LABELS.hash];
    if (!h) continue;
    eventsByKey.set(sliceKey(h, containerOf(r.metric)), parseFloat(r.value?.[1] ?? '0'));
  }

  const byKey = new Map<string, PerPattern>();
  for (const r of bytesRes.data.result) {
    const h = r.metric[LABELS.hash];
    if (!h) continue;
    const container = containerOf(r.metric);
    const key = sliceKey(h, container);
    const bytes = parseFloat(r.value?.[1] ?? '0');
    const severity = r.metric[LABELS.severity] ?? '';
    const existing = byKey.get(key);
    if (existing) {
      existing.bytes += bytes;
      if (!existing.severity && severity) existing.severity = severity;
    } else {
      byKey.set(key, {
        pattern_hash: h,
        pattern: r.metric[LABELS.pattern] || h,
        container,
        bytes,
        events: eventsByKey.get(key) ?? 0,
        severity,
      });
    }
  }

  return [...byKey.values()];
}

// ─── Phase 2: per-service compressibility + action advisory ───────────
interface ServiceCompressibility {
  /** optimized/input, clamped to [0.02, 1.0]; null when unmeasurable. */
  ratio: number | null;
  input_bytes: number;
  optimized_bytes: number;
  /**
   * Where the ratio came from. `live` = the engine's realized optimize-mode
   * output (Prometheus, full production volume). `sample` = an on-demand
   * log10x_measure_compaction run (real codec on a sampled batch), used before
   * optimize mode is deployed. Live wins when both exist. Absent is treated as
   * `live` (the historical default).
   */
  source?: 'live' | 'sample';
}

/**
 * Measure each k8s_container's realized compaction from the engine's own
 * `emitted_events_optimized_size_total` vs `all_events_summaryBytes_total`.
 * Best-effort: a query error or a container with no optimized series (receiver
 * not in optimize mode for it) yields ratio=null, and the caller falls back to
 * the static destination band. An out-of-range ratio (>1 pass-through, or
 * implausibly <0.02) is also treated as unmeasured.
 */
async function fetchCompressibilityPerContainer(
  env: EnvConfig,
  containers: string[],
  observationDays: number,
  envId: string | undefined
): Promise<Map<string, ServiceCompressibility>> {
  const out = new Map<string, ServiceCompressibility>();
  if (containers.length === 0) return out;
  // No env anchor would sum all_events across every tenant on a shared backend,
  // yielding a meaningless cross-tenant ratio. Skip and fall back to the static
  // band (mirrors fetchPerPatternBytes, which warns in the same situation).
  if (!envId) return out;
  const containerRegex = containers.map(promEscape).join('|');
  const { inputQ, optimizedQ } = compressibilityPerContainer(
    envId,
    `${observationDays}d`,
    containerRegex
  );
  let inputRes: PrometheusResponse;
  let optRes: PrometheusResponse;
  try {
    [inputRes, optRes] = await Promise.all([
      queryInstant(env, inputQ),
      queryInstant(env, optimizedQ),
    ]);
  } catch {
    return out; // best-effort; every service falls back to the static band
  }
  const optBy = new Map<string, number>();
  for (const r of optRes.data.result) {
    const c = r.metric.k8s_container || '__node__';
    optBy.set(c, parseFloat(r.value?.[1] ?? '0'));
  }
  for (const r of inputRes.data.result) {
    const c = r.metric.k8s_container || '__node__';
    const input = parseFloat(r.value?.[1] ?? '0');
    const opt = optBy.get(c) ?? 0;
    let ratio: number | null = null;
    if (input > 0 && opt > 0) {
      const raw = opt / input;
      ratio = raw >= 0.02 && raw <= 1.0 ? raw : null;
    }
    out.set(c, { ratio, input_bytes: input, optimized_bytes: opt, source: 'live' });
  }
  return out;
}

interface ServiceActionDecision {
  action: Action;
  source: 'user_pinned' | 'auto' | 'global_default';
  reason: string;
  ratio_source: 'measured_live' | 'measured_sample' | 'static_band';
  measured_compression_pct: number | null;
  keep_queryable: boolean;
  /** Measured ratio threaded into projectActionRange; cost.ts honors it for compact only on envelope destinations. */
  compact_ratio_override?: number;
}

/**
 * Resolve the standard-tier action for one service (k8s_container) under the
 * env's single destination. Precedence: explicit pin (validated legal) ->
 * the global non-compact action_defaults.standard or auto-off legacy fallback
 * -> compressibility-driven auto-recommendation (compact when it compresses
 * well and stays queryable; offload when it compresses poorly). Never emits an
 * action that is illegal or zero-saving on the destination.
 */
export function _resolveServiceAction(params: {
  container: string;
  destination: SiemId;
  model: ReturnType<typeof getDestinationCostModel>;
  compressibility?: ServiceCompressibility;
  policy?: { standard_action?: Action; keep_queryable?: boolean };
  autoRecommend: boolean;
  globalStandardAction: Action;
  compactWorthItRatio: number;
  warnings: string[];
}): ServiceActionDecision {
  const {
    container, destination, model, compressibility, policy,
    autoRecommend, globalStandardAction, compactWorthItRatio, warnings,
  } = params;
  const allowed = getAllowedActionsForDestination(destination);
  const keepQueryable = policy?.keep_queryable ?? false;
  const measuredRatio = compressibility?.ratio ?? null;
  const measuredPct = measuredRatio !== null ? roundOne((1 - measuredRatio) * 100) : null;
  const ratioSource: ServiceActionDecision['ratio_source'] =
    measuredRatio === null
      ? 'static_band'
      : compressibility?.source === 'sample'
        ? 'measured_sample'
        : 'measured_live';

  // An action is "legal" if the destination + forwarder can honor it AND it
  // actually saves: compact only where compaction is not a no-op, tier_down
  // only where the cost model has a cheaper target tier (cloudwatch today;
  // datadog Flex is unpriced so tier_down there is handled by the level-1
  // fallback, matching Phase 1, with its zero-saving surfaced by the
  // projection notes rather than swapped here).
  const isLegal = (a: Action): boolean => {
    if (a === 'pass' || a === 'sample' || a === 'drop') return true;
    if (a === 'compact') return model.compact_mode !== 'no-op' && allowed.includes('compact');
    if (a === 'tier_down') return !!model.tier_down_target_tier;
    if (a === 'offload') return allowed.includes('offload');
    return false;
  };
  // Thread the measured ratio into the dollar projection only on the auto path.
  // Under auto_recommend=false the legacy run must stay dollar-identical to the
  // pre-Phase-2 static band, so no override there even if a measured series
  // exists.
  const overrideFor = (a: Action): number | undefined =>
    autoRecommend && a === 'compact' ? measuredRatio ?? undefined : undefined;
  const mk = (
    action: Action,
    source: ServiceActionDecision['source'],
    reason: string
  ): ServiceActionDecision => ({
    action, source, reason,
    ratio_source: ratioSource,
    measured_compression_pct: measuredPct,
    keep_queryable: keepQueryable,
    compact_ratio_override: overrideFor(action),
  });

  // The destination's first legal+saving lever, in the allow-list's own order:
  // cloudwatch -> tier_down (has a cheaper IA tier); datadog -> offload (its
  // tier_down/Flex is unpriced, so tier_down is NOT legal here); offload-only
  // destinations -> offload. offload is the universal safety net (legal on
  // every destination). This never returns a zero-saving action the engine
  // would route to the SIEM at full price.
  const firstLegalLever = (): Action => allowed.find(isLegal) ?? 'offload';

  // 1. Explicit pin wins when legal; otherwise warn and fall through to auto.
  if (policy?.standard_action) {
    const pin = policy.standard_action;
    if (isLegal(pin)) return mk(pin, 'user_pinned', 'pinned via service_policy');
    const why = pin === 'compact'
      ? `a no-op on ${destination}`
      : pin === 'tier_down'
        ? `unpriced on ${destination} (no cheaper tier modeled)`
        : `illegal on ${destination}`;
    // Name the path the rejected service actually falls through to: the
    // compressibility auto-recommender only runs when auto_recommend is on AND
    // the global standard is the implicit compact; otherwise it lands on the
    // global default action.
    const fellBackTo =
      autoRecommend && globalStandardAction === 'compact'
        ? 'auto-recommended instead'
        : 'fell back to the global default action instead';
    warnings.push(
      `service_policy["${container}"].standard_action="${pin}" is ${why}; ${fellBackTo}.`
    );
  }

  // 2. Legacy / explicit-non-compact path: honor the global action verbatim
  // (with the destination-compat fallback) for every service. This is the
  // one-size behavior and keeps single-action callers byte-identical.
  if (!autoRecommend || globalStandardAction !== 'compact') {
    // Match Phase 1 exactly: ONLY the compact-on-no-op-destination case is
    // remapped (to the destination's first legal lever). Every other explicit
    // action passes through verbatim, so an explicit illegal non-compact action
    // keeps its Phase-1 zero-saving projection note instead of being silently
    // rewritten. This preserves byte-identical auto_recommend=false behavior.
    let a = globalStandardAction;
    if (a === 'compact' && model.compact_mode === 'no-op') a = firstLegalLever();
    return mk(a, 'global_default', `global action_defaults.standard=${globalStandardAction}`);
  }

  // 3. Auto-recommend (globalStandardAction === 'compact' && autoRecommend):
  // compressibility decides compact-vs-offload within the legal set.
  const compactLegal = isLegal('compact');
  const offloadLegal = isLegal('offload');
  const effectiveRatio = measuredRatio ?? (model.compact_ratio_low + model.compact_ratio_high) / 2;
  const savedPct = Math.round((1 - effectiveRatio) * 100);
  const measured = ratioSource === 'static_band' ? 'modeled' : 'measured';

  if (compactLegal && (effectiveRatio <= compactWorthItRatio || keepQueryable)) {
    const why = effectiveRatio <= compactWorthItRatio
      ? `${measured} ${savedPct}% compaction, stays queryable in ${destination}`
      : `keep_queryable set; compact stays in ${destination} at ${savedPct}% compaction`;
    return mk('compact', 'auto', `auto: compact (${why})`);
  }
  if (compactLegal && offloadLegal) {
    return mk('offload', 'auto', `auto: offload (only ${measured} ${savedPct}% compaction; S3 takes the larger cut)`);
  }
  // compact illegal on this destination -> its first legal+saving lever
  // (cloudwatch -> tier_down; datadog -> offload, since Flex tier_down is
  // unpriced; offload-only destinations -> offload). Never emits a zero-saving
  // action the engine would route to the SIEM at full price.
  const lever = firstLegalLever();
  const why = model.compact_mode === 'no-op'
    ? `compact is a no-op on ${destination}; ${lever} is its first saving lever`
    : `${lever} for ${destination}`;
  return mk(lever, 'auto', `auto: ${lever} (${why})`);
}

// ─── tier inference ──────────────────────────────────────────────────
function inferTier(severity: string): Tier {
  const s = (severity ?? '').toLowerCase();
  if (s === 'audit' || s === 'critical' || s === 'fatal') return 'audit';
  if (s === 'error' || s === 'warn' || s === 'warning') return 'error';
  if (s === 'debug' || s === 'trace') return 'debug';
  if (s === 'synthetic' || s === 'loadgen' || s === 'noise') return 'synthetic';
  // default: info / unknown / empty → standard
  return 'standard';
}

// ─── cap-per-window math ──────────────────────────────────────────────
// monthlyBytes is a 30-day projection. Convert to bytes-per-receiver-reset-
// window via window-scaling: scaleObservedToReceiverWindow(monthlyBytes, '30d').
// The inline WINDOWS_PER_MONTH division is preserved as a cross-check comment.
function computeCapBytesPerWindow(action: Action, monthlyBytes: number): number {
  // scaleObservedToReceiverWindow('30d') = monthlyBytes * (240_000ms / 2_592_000_000ms)
  //   = monthlyBytes / 10800  (matches WINDOWS_PER_MONTH = 10800)
  const perWindow = scaleObservedToReceiverWindow(monthlyBytes, '30d');
  switch (action) {
    case 'pass':
      // Generous cap (= full monthly throughput evenly distributed).
      return Math.max(1, perWindow);
    case 'sample':
      // ~1/10 of bytes get through.
      return Math.max(1, perWindow / 10);
    case 'compact':
      // After compact, ~10-15% of bytes remain on the wire (envelope mid).
      return Math.max(1, perWindow * 0.15);
    case 'tier_down':
      // No on-wire change; cap = full throughput.
      return Math.max(1, perWindow);
    case 'offload':
    case 'drop':
    default:
      return 0;
  }
}

// ─── CSV rendering ────────────────────────────────────────────────────
interface CsvData {
  header: string[];
  rows: Map<string, string>;
}
function parseCsv(content?: string): CsvData {
  if (!content) return { header: ['container', 'cap'], rows: new Map() };
  // Strip preamble (`#`-prefixed) and blank lines BEFORE picking a header.
  // Preamble lines carry refresh-mode commitment metadata; they must not
  // be confused with data rows.
  const lines = content
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0 && !l.trim().startsWith('#'));
  if (lines.length === 0) return { header: ['container', 'cap'], rows: new Map() };
  const header = lines[0].split(',');
  const rows = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(',');
    if (idx < 0) continue;
    const k = lines[i].substring(0, idx).trim();
    const v = lines[i].substring(idx + 1);
    if (k) rows.set(k, v);
  }
  return { header, rows };
}

function renderCsv(rows: Map<string, string>, preamble?: string[]): string {
  const out: string[] = [];
  if (preamble && preamble.length > 0) {
    for (const p of preamble) out.push(p);
  }
  out.push('container,cap');
  for (const [k, v] of [...rows.entries()].sort()) out.push(`${k},${v}`);
  return out.join('\n') + '\n';
}

export function renderCsvDiff(
  containers: string[],
  currentCsv: string | undefined,
  rows: PerPatternRow[],
  defaultAction: Action,
  actionByContainer: ReadonlyMap<string, Action>,
  reduction: 'soft' | 'hard',
  commitment?: { targetPercent: number; baselineMonthlyBytes: number }
): string {
  const baseline = parseCsv(currentCsv);
  const merged = new Map(baseline.rows);
  // ONE entry per service: `<bytes>:<action>:<reason>`. The cap (bytes) is the
  // trigger; the action (folded in) is the disposition of the over-budget
  // slice. The engine reads BOTH from this single file — there is no sibling
  // actions.csv / action-intent.json to desync, go missing (a missing action
  // file crashed the receiver at init), or lag (silently defaulting to drop).
  //
  // KEY BINDING: The engine's rate module reads caps.csv keyed by the
  // value of `rateReceiverContainerField` (defaults to `k8s_container`).
  // Each row's key MUST equal the actual container value that flows on
  // the wire for the service being configured. The `containers` argument
  // here is the resolved list of container values (caller passes either
  // the explicit `args.containers` list, or — when a snapshot resolves
  // service→container — the mapped containers; in the common case of
  // service-name==container-name, both are identical). Anything else is
  // a dead row that the engine cannot match against any event.
  //
  // Cap semantics: offload/drop act on the WHOLE service (cap 0 = everything
  // overflows). compact/sample/tier_down/pass act on the slice past the
  // budget-derived cap.
  // Per-container cap = the SUM of that container's OWN per-pattern caps
  // (each from computeCapBytesPerWindow under its pattern's action), NOT a
  // mean across every container's patterns. Averaging produced a number that
  // matched no real budget (a pass-heavy service got a near-full cap, an
  // offload-heavy one ~0). Build the per-container sums once.
  const capSumByContainer = new Map<string, number>();
  for (const r of rows) {
    if (!r.container) continue;
    capSumByContainer.set(
      r.container,
      (capSumByContainer.get(r.container) ?? 0) + r.cap_bytes_per_window
    );
  }
  const reason = `MCP configure_engine (${reduction})`;
  for (const c of containers) {
    // Each container gets ITS OWN resolved standard-tier action (the Phase-2
    // per-service advisory), falling back to defaultAction only when a
    // container has no decision. offload/drop keep cap 0 (the whole container
    // overflows); every other action gets the container's own budget sum.
    const action = actionByContainer.get(c) ?? defaultAction;
    const cap =
      action === 'offload' || action === 'drop'
        ? 0
        : Math.round(capSumByContainer.get(c) ?? 0);
    // Strip ',' (CSV delim) and ':' (field delim) from the reason so it can
    // never break the `<bytes>:<action>:<reason>` parse.
    const value = `${cap}:${action}:${reason.replace(/[,:]/g, ';')}`;
    merged.set(c, value);
  }
  // Preserve any existing preamble from the baseline (so refresh PRs
  // round-trip the original `target_percent` without re-writing it). When
  // `commitment` is provided (configure mode, fresh policy), the new
  // preamble overrides whatever the baseline carried — that's how a
  // user can re-anchor the target by re-running configure.
  const baselinePre = parsePreamble(currentCsv);
  const beforePre = renderPreambleFromParsed(baselinePre);
  const afterPre = commitment
    ? renderPreamble(commitment.targetPercent, commitment.baselineMonthlyBytes)
    : beforePre;
  const before = renderCsv(baseline.rows, beforePre);
  const after = renderCsv(merged, afterPre);
  return renderUnifiedDiff(before, after);
}

/**
 * Re-render a PreambleData back into preamble lines. Used to round-trip
 * the original `target_percent` across refresh PRs when the caller didn't
 * supply a new commitment block.
 */
function renderPreambleFromParsed(p: PreambleData): string[] {
  if (p.target_percent === undefined) return [];
  return renderPreamble(p.target_percent, p.baseline_monthly_bytes ?? 0);
}

function renderUnifiedDiff(before: string, after: string): string {
  // Minimal line-level unified diff. No need for a diff library — the agent
  // consumes this as a human-readable hint, not a patch.
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const out: string[] = ['--- a/caps.csv', '+++ b/caps.csv'];
  for (const l of beforeLines) {
    if (!afterSet.has(l) && l.length > 0) out.push(`-${l}`);
  }
  for (const l of afterLines) {
    if (!beforeSet.has(l) && l.length > 0) out.push(`+${l}`);
  }
  return out.join('\n');
}

// ─── PR command rendering ─────────────────────────────────────────────
function renderPrCommand(
  args: ConfigureEngineArgs,
  resolved: ResolvedTarget,
  csvDiff: string
): string {
  const repo = resolved.gitops_repo;
  const branch = resolved.gitops_branch;
  const lookupPath = resolved.lookup_path;
  const prBranch = `mcp/engine-policy-${slug(args.service)}-${Date.now()}`;
  const prTitle = `engine-policy: configure ${args.service} (${args.containers!.length} container${args.containers!.length === 1 ? '' : 's'})`;

  // Reconstruct post-merge CSV from the diff additions.
  const newCsv = reconstructAfterCsv(csvDiff, args.current_csv);

  const out: string[] = [];
  out.push('```bash');
  out.push('set -euo pipefail');
  out.push(`REPO=${shellQuote(repo)}`);
  out.push(`BASE=${shellQuote(branch)}`);
  out.push(`LOOKUP_PATH=${shellQuote(lookupPath)}`);
  out.push(`BRANCH=${shellQuote(prBranch)}`);
  out.push(`PR_TITLE=${shellQuote(prTitle)}`);
  out.push('');
  out.push('TMPFILE=$(mktemp)');
  out.push("cat > \"$TMPFILE\" <<'CSV_EOF'");
  out.push(newCsv.trimEnd());
  out.push('CSV_EOF');
  out.push('');

  out.push('# Resolve current file SHA (empty if the file does not exist yet).');
  out.push(
    'CUR_SHA=$(gh api "/repos/$REPO/contents/$LOOKUP_PATH?ref=$BASE" --jq .sha 2>/dev/null || true)'
  );
  out.push('');
  out.push('# Create the working branch from BASE.');
  out.push(
    'BASE_SHA=$(gh api "/repos/$REPO/git/refs/heads/$BASE" --jq .object.sha)'
  );
  out.push('gh api -X POST "/repos/$REPO/git/refs" \\');
  out.push('  -f ref="refs/heads/$BRANCH" \\');
  out.push('  -f sha="$BASE_SHA" >/dev/null 2>&1 || true');
  out.push('');

  out.push('# Commit cap CSV via the contents API.');
  out.push('CONTENT_B64=$(base64 < "$TMPFILE" | tr -d "\\n")');
  out.push('PUT_ARGS=( -X PUT "/repos/$REPO/contents/$LOOKUP_PATH"');
  out.push('  -f branch="$BRANCH"');
  out.push('  -f message="$PR_TITLE"');
  out.push('  -f content="$CONTENT_B64" )');
  out.push('[ -n "$CUR_SHA" ] && PUT_ARGS+=( -f sha="$CUR_SHA" )');
  out.push('gh api "${PUT_ARGS[@]}"');
  out.push('');
  out.push('# Open PR.');
  out.push('gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" \\');
  out.push('  --title "$PR_TITLE" \\');
  const body =
    `MCP-derived engine policy for service \`${args.service}\`.\n\n` +
    `- Containers (${args.containers!.length}): ${args.containers!.map((c) => `\`${c}\``).join(', ')}\n` +
    `- Destination: ${resolved.destination}\n` +
    `- Target: ${args.target_percent !== undefined ? `${args.target_percent}% reduction` : `$${args.budget_usd}/month budget`}\n` +
    `- Reduction mode: ${args.reduction ?? 'hard'}\n\n` +
    `Derived via log10x_configure_engine.`;
  out.push(`  --body ${shellQuote(body)}`);
  out.push('```');

  return out.join('\n');
}

function reconstructAfterCsv(diff: string, currentCsv: string | undefined): string {
  const baseline = parseCsv(currentCsv);
  const merged = new Map(baseline.rows);
  // Track preamble changes from the diff so the reconstructed CSV
  // carries the freshly-anchored commitment block forward to the PR.
  const afterPreambleLines: string[] = [];
  const removedPreambleLines = new Set<string>();
  const lines = diff.split('\n');
  for (const l of lines) {
    if (l.startsWith('+') && !l.startsWith('+++')) {
      const body = l.slice(1);
      if (body.trim().startsWith('#')) {
        afterPreambleLines.push(body);
        continue;
      }
      const idx = body.indexOf(',');
      if (idx < 0) continue;
      const k = body.slice(0, idx).trim();
      const v = body.slice(idx + 1);
      if (k && k !== 'container') merged.set(k, v);
    } else if (l.startsWith('-') && !l.startsWith('---')) {
      const body = l.slice(1);
      if (body.trim().startsWith('#')) {
        removedPreambleLines.add(body);
        continue;
      }
      const idx = body.indexOf(',');
      if (idx < 0) continue;
      const k = body.slice(0, idx).trim();
      if (k && k !== 'container') merged.delete(k);
    }
  }
  // Preamble resolution: prefer the diff's new preamble. If the diff
  // didn't touch the preamble, keep whatever the baseline carried.
  let preamble: string[];
  if (afterPreambleLines.length > 0) {
    preamble = afterPreambleLines;
  } else {
    const baselinePreamble = parsePreamble(currentCsv);
    preamble = renderPreambleFromParsed(baselinePreamble).filter(
      (l) => !removedPreambleLines.has(l)
    );
  }
  return renderCsv(merged, preamble);
}

// ─── human_summary builder ────────────────────────────────────────────
function buildConfigureEngineHumanSummary(args: {
  feasible: boolean;
  targetPercent: number;
  service: string;
  containerCount: number;
  patternCount: number;
  destination: SiemId;
  remainingBytesToShed: number;
  applied?: ConfigureEngineData['applied'];
  refreshMode?: boolean;
}): string {
  const containerWord = `${args.containerCount} container${args.containerCount === 1 ? '' : 's'}`;
  const verb = args.refreshMode ? 'refresh re-derived' : 'derived';
  if (!args.feasible) {
    return `configure_engine ${args.refreshMode ? 'refresh' : ''} could not hit ${args.targetPercent.toFixed(1)}% reduction on ${args.service} (${containerWord}, ${args.destination}); short by ${humanBytes(args.remainingBytesToShed)} per month. Adjust target, floors, or action defaults and re-run.`;
  }
  const headline = `configure_engine ${verb} a ${args.targetPercent.toFixed(1)}% reduction policy on ${args.service} across ${containerWord} (${args.destination}); ${args.patternCount} pattern${args.patternCount === 1 ? '' : 's'} capped.`;
  if (args.applied?.ok && args.applied.pr_url) {
    return `${headline} PR opened at ${args.applied.pr_url}; the engine hot-reloads the cap CSV on the next gitops poll, no pipeline restart.`;
  }
  if (args.applied && !args.applied.ok) {
    return `${headline} Auto-apply failed (${args.applied.error ?? 'unknown error'}); run pr_command manually to open the PR.`;
  }
  return `${headline} Run pr_command to open the PR; the engine hot-reloads the cap CSV on the next gitops poll, no pipeline restart.`;
}

// ─── envelope helpers ─────────────────────────────────────────────────
function toEnvelopeActions(
  acts: Array<{ tool: string; args: unknown; why: string }>
): EnvelopeAction[] {
  return acts.map((a) => ({
    tool: a.tool,
    args: typeof a.args === 'object' && a.args !== null ? (a.args as Record<string, unknown>) : {},
    reason: a.why,
    role: 'recommended-next' as const,
  }));
}

function notConfiguredEnvelope(
  phase: ConfigureEngineData['phase'],
  remediation: string,
  service: string,
  extraActions?: import('../lib/output-types.js').Action[]
): StructuredOutput {
  const hint = firstLine(remediation);
  // Auto-derive chain nudges from the hint text so error envelopes always
  // carry an actionable breadcrumb for agent chains.
  const actions: import('../lib/output-types.js').Action[] = [
    ...(extraActions ?? []),
    ...deriveActionsFromHint(hint),
  ];
  return buildChassisErrorEnvelope({
    tool: 'log10x_configure_engine',
    err: {
      error_type: 'config_missing',
      retryable: false,
      suggested_backoff_ms: null,
      hint: `configure_engine refused: ${hint}`,
    },
    contextPayload: {
      ok: false, phase, service, containers: [], error: remediation,
      human_summary: `configure_engine refused: ${hint}`,
    } satisfies ConfigureEngineData,
    source_disclosure: {},
    actions: actions.length > 0 ? actions : undefined,
  });
}

// ─── small utilities ──────────────────────────────────────────────────
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function promEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase();
}
function humanBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024)
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(2)} KB`;
  return `${Math.round(b)} bytes`;
}
function renderError(title: string, body: string): string {
  return `# configure_engine — ${title}\n\n${body}`;
}
function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim().length > 0) ?? s;
}
function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}
function roundOne(n: number): number {
  return Math.round(n * 10) / 10;
}
function roundPct(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ─── error-hint action derivation ────────────────────────────────────────────
/**
 * Returns true when the hint string signals a missing gitops repo —
 * the canonical fix is log10x_configure_env (sets gitops.repo / GH_REPO).
 */
function isGitopsHint(hint: string): boolean {
  return (
    /gitops/i.test(hint) ||
    /GH_REPO/i.test(hint) ||
    /configure_env/i.test(hint)
  );
}

/**
 * Derives structured chain-next nudges from an error hint string.
 *
 * Mapping:
 *   config_missing + gitops/GH_REPO mention  → log10x_set_gitops_repo
 *   schema_invalid / "invalid" / "required"   → log10x_explain_mode + log10x_cost_options
 *
 * backend_unavailable is handled at its call site rather than here because
 * it uses a distinct error_type and the log10x_doctor nudge is always
 * applicable regardless of the hint wording.
 *
 * NOTE: the gitops action used to point to log10x_configure_env, but that
 * tool only handles metricsBackend and cannot write the gitops field.
 * log10x_set_gitops_repo is the correct target for this gap.
 */
function deriveActionsFromHint(
  hint: string
): import('../lib/output-types.js').Action[] {
  const acts: import('../lib/output-types.js').Action[] = [];

  if (isGitopsHint(hint)) {
    acts.push({
      tool: 'log10x_set_gitops_repo',
      args: {},
      reason:
        'Write gitops.repo to envs.json so configure_engine knows which GitHub repo to open the cap-CSV PR against. After running, restart the MCP server and retry.',
      role: 'recommended-next',
    });
    return acts; // gitops gap is the only blocker — don't pile on schema nudges
  }

  // Schema / input errors: surface explain_mode + cost_options so the agent
  // can re-orient before retrying.
  if (
    /schema_invalid/i.test(hint) ||
    /invalid/i.test(hint) ||
    /required/i.test(hint) ||
    /must be/i.test(hint)
  ) {
    acts.push({
      tool: 'log10x_explain_mode',
      args: {},
      reason:
        'Review the available action modes (pass/sample/compact/tier_down/offload/drop) and destination constraints before re-calling configure_engine.',
      role: 'recommended-next',
    });
    acts.push({
      tool: 'log10x_cost_options',
      args: {},
      reason:
        'Inspect cost-option availability for the target destination to choose valid action_defaults.',
      role: 'optional-followup',
    });
  }

  return acts;
}

// Re-exports for sibling tools (estimate-savings, baseline) and tests.
export { COST_MODEL_BY_DESTINATION, MIN_REPORTER_DAYS, WINDOWS_PER_DAY, WINDOWS_PER_MONTH };

// ── auto-apply executor ────────────────────────────────────────────────
/**
 * Shell out to the customer's `gh` CLI to execute the rendered PR script.
 *
 * Auth model (industry standard, mirrors github/github-mcp-server):
 *   - The customer is expected to have `gh auth login` already done.
 *   - We do NOT accept or store a token in the MCP. The token lives where
 *     gh CLI keeps it (keychain / config file).
 *   - Scope of the action is bounded by the gh CLI token's repo scope.
 *
 * Failure modes (all return ok:false, never throw):
 *   - gh missing / not authenticated → error: 'gh not available'
 *   - script exited non-zero → error: stderr tail
 *   - script ran but no PR URL in stdout → error: 'PR URL not detected'
 *   - timeout (60s) → error: 'apply timed out'
 *
 * The script we run was generated by `renderPrCommand` above. It is a
 * heredoc-style bash snippet that resolves the current file SHA, creates a
 * branch, commits the new CSV, and runs `gh pr create`. We pipe it to
 * `bash -s` (NOT `bash -c "<string>"`) so quoting/escaping inside the
 * script does not get mangled by the shell.
 */
/**
 * Apply via kubectl_configmap: write the cap-CSV + action-intent.json
 * directly to a k8s ConfigMap. The engine's ConfigMap pull driver
 * (configured via $K8S_CONFIGMAP env var on the receiver pod, default
 * `log10x-action-intent`) reads from this ConfigMap and hot-reloads the
 * policy without a pipeline restart.
 *
 * The ConfigMap carries THREE keys the engine expects:
 *   - `caps.csv` (engine's safety floor — per-container + per-pattern caps)
 *   - `action-intent.json` (canonical per-pattern action mapping)
 *   - `actions.csv` (per-SERVICE action routing — the receiver reads this
 *     keyed by k8s container == the service and stamps `route(<action>)` on
 *     that service's regulator-excess slice; a service with no row defaults
 *     to `drop`)
 *
 * Uses `kubectl apply -f -` so existing ConfigMaps are updated in place
 * (server-side apply semantics) and new ones are created. The actual
 * cluster + namespace come from the caller's kubeconfig context — the
 * MCP doesn't pick a context, the operator does.
 */
async function applyViaKubectlConfigMap(
  capCsv: string,
  configMapName: string,
  namespace: string
): Promise<{
  ok: boolean;
  configmap_location?: { namespace: string; name: string; keys: string[] };
  error?: string;
}> {
  // MERGE, don't replace. Read the existing ConfigMap so other services' cap
  // rows AND any unrelated keys survive. Single-file design: the action is
  // folded into caps.csv, so drop any legacy actions.csv / action-intent.json
  // keys (the engine no longer reads them).
  const existingData = await readConfigMapData(configMapName, namespace);
  const data: Record<string, string> = { ...existingData };
  delete data['actions.csv'];
  delete data['action-intent.json'];
  data['caps.csv'] = mergeCapsRows(existingData['caps.csv'], capCsv);
  // Stamp the policy generation alongside it: a hash of the merged caps that the
  // engine reads + advertises as the tenx_config_version label, so the MCP can
  // later verify the running engine is executing THIS policy (config-generation
  // closed loop), not just that the ConfigMap was written.
  data['config-generation.csv'] = renderGenerationCsv(computeGeneration(data['caps.csv']));
  const cm = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configMapName,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'log10x-mcp',
        'app.kubernetes.io/component': 'engine-policy',
      },
      annotations: {
        'log10x.com/written-by': 'log10x_configure_engine',
        'log10x.com/written-at': new Date().toISOString(),
      },
    },
    data,
  };
  const yamlOrJson = JSON.stringify(cm);
  return await new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const child = spawn('kubectl', ['apply', '-f', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve({ ok: false, error: 'kubectl apply timed out after 30s' });
      }
    }, 30_000);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `kubectl spawn failed: ${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({
          ok: true,
          configmap_location: {
            namespace,
            name: configMapName,
            keys: Object.keys(data),
          },
        });
      } else {
        resolve({
          ok: false,
          error: `kubectl apply exited ${code}: ${stderr.trim() || 'no stderr'}`,
        });
      }
    });
    child.stdin.end(yamlOrJson);
  });
}

/** Read a ConfigMap's `.data` map. Returns `{}` if it doesn't exist yet (so
 *  the caller creates it fresh) or on any kubectl error. */
async function readConfigMapData(
  name: string,
  namespace: string
): Promise<Record<string, string>> {
  return await new Promise((resolve) => {
    let stdout = '';
    const child = spawn(
      'kubectl',
      ['get', 'configmap', name, '-n', namespace, '-o', 'json'],
      { stdio: ['ignore', 'pipe', 'ignore'], env: process.env }
    );
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve({});
    }, 15_000);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({});
        return;
      }
      try {
        resolve((JSON.parse(stdout).data as Record<string, string>) ?? {});
      } catch {
        resolve({});
      }
    });
  });
}

/** Merge new cap rows into the existing caps.csv: new rows win per container,
 *  every other service's row is preserved, and the new file's preamble (the
 *  latest target/baseline) is carried. */
function mergeCapsRows(existingCsv: string | undefined, newCsv: string): string {
  const merged = new Map(parseCsv(existingCsv).rows);
  for (const [k, v] of parseCsv(newCsv).rows) merged.set(k, v);
  return renderCsv(merged, renderPreambleFromParsed(parsePreamble(newCsv)));
}

/**
 * Persist a commitment record on successful apply (gitops PR-open OR
 * kubectl_configmap write). Builds the record from the args + derivation
 * outputs and writes to $LOG10X_ADVISOR_STATE_DIR/commitments/<id>.json
 * via putCommitment. commitment_report reads from this directory to
 * compute realized savings against the baseline captured at apply time.
 *
 * Returns the commitment id so the apply path can surface it in the
 * response envelope.
 */
function persistCommitmentOnApply(opts: {
  service: string;
  envNickname: string;
  destination: SiemId;
  targetPercent: number;
  contractType: 'committed' | 'on_demand';
  baselineMonthlyBytes: number;
  baselineMonthlyUsd: number;
  observationDays: number;
  deliveryTarget?: CommitmentRecord['delivery_target'];
}): string {
  const id = randomUUID();
  const rec: CommitmentRecord = {
    id,
    env: opts.envNickname,
    service: opts.service,
    destination: opts.destination,
    promised_pct: opts.targetPercent,
    contract_type: opts.contractType,
    started_at: new Date().toISOString(),
    baseline_window: `${opts.observationDays}d`,
    baseline_bytes_30d: opts.baselineMonthlyBytes,
    baseline_usd_monthly: opts.baselineMonthlyUsd,
    delivery_target: opts.deliveryTarget,
  };
  putCommitment(rec);
  return id;
}

async function applyViaGh(prCommand: string): Promise<{
  ok: boolean;
  pr_url?: string;
  branch?: string;
  error?: string;
}> {
  // The rendered prCommand is markdown-wrapped (```bash ... ```). Strip
  // the fences so bash sees only the script body.
  const script = stripMarkdownFences(prCommand);
  if (!script.trim()) {
    return { ok: false, error: 'pr_command was empty after stripping fences' };
  }

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn('bash', ['-s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore — process may already be gone
        }
        resolve({ ok: false, error: 'apply timed out after 60s' });
      }
    }, 60_000);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: `spawn failed: ${err.message}` });
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        // gh failed (missing, unauthenticated, network, repo not found,
        // branch already exists, etc). Surface a trimmed stderr so the
        // agent can decide whether to retry, prompt the user, or fall
        // back to emitting commands.
        const tail = stderr.trim().split('\n').slice(-3).join('\n');
        resolve({
          ok: false,
          error: tail || `bash exited ${code}`,
        });
        return;
      }
      // Parse the PR URL from stdout. `gh pr create` prints the URL on
      // its own line as the last line of successful output. Sometimes
      // earlier `gh api` calls also print JSON, so search bottom-up
      // for an https://github.com or https://gitlab.com URL.
      const prUrl = extractPrUrl(stdout);
      const branch = extractBranchName(script);
      if (!prUrl) {
        resolve({
          ok: false,
          branch,
          error: 'PR URL not detected in gh output',
        });
        return;
      }
      resolve({ ok: true, pr_url: prUrl, branch });
    });

    child.stdin?.write(script);
    child.stdin?.end();
  });
}

function stripMarkdownFences(text: string): string {
  // The pr_command is wrapped as ```bash ... ``` per renderPrCommand.
  // Strip the leading ```bash (or ```sh) line and the trailing ``` line.
  const lines = text.split('\n');
  let start = 0;
  let end = lines.length;
  if (lines[0] !== undefined && /^```(bash|sh|shell)?\s*$/.test(lines[0])) {
    start = 1;
  }
  if (lines[end - 1] !== undefined && /^```\s*$/.test(lines[end - 1])) {
    end = end - 1;
  }
  return lines.slice(start, end).join('\n');
}

function extractPrUrl(stdout: string): string | undefined {
  const matches = stdout.match(
    /https:\/\/(?:github|gitlab|bitbucket)\.com[^\s)]+/g
  );
  return matches ? matches[matches.length - 1] : undefined;
}

function extractBranchName(script: string): string | undefined {
  const m = script.match(/^BRANCH=(.+)$/m);
  if (!m) return undefined;
  // BRANCH=$'...' or BRANCH='...' — strip the shell quoting at a coarse
  // level (full unquoting would mean reimplementing bash; this is good
  // enough for the typical branch names log10x_advise emits).
  return m[1].replace(/^\$?'/, '').replace(/'$/, '').trim();
}

