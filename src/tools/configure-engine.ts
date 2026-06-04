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
 * on a representative customer. (See OPEN Q 5 in 14d-24 spec.)
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
 *                          current state already meets target, OPEN Q 8)
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
import type { PrometheusResponse } from '../lib/api.js';
import {
  type StructuredOutput,
  type Action as EnvelopeAction,
} from '../lib/output-types.js';
import { buildChassisEnvelope, buildChassisErrorEnvelope } from '../lib/chassis-envelope.js';
import {
  COST_MODEL_BY_DESTINATION,
  getDestinationCostModel,
  getDefaultActionForDestination,
  projectActionRange,
  type Action,
} from '../lib/cost.js';
import type { SiemId } from '../lib/siem/pricing.js';
import {
  RECEIVER_DEFAULT_RESET_MS,
  scaleObservedToReceiverWindow,
} from '../lib/window-scaling.js';
import {
  writeActionIntent,
  buildActionIntentEntries,
  type ActionIntentEntry,
} from '../lib/action-intent-writer.js';

// ─── constants ────────────────────────────────────────────────────────
const DEFAULT_LOOKUP_PATH = 'pipelines/run/receive/rate/caps.csv';
// RECEIVER_DEFAULT_RESET_MS (240_000 ms = 4 min) imported from window-scaling.
const RESET_INTERVAL_SEC = RECEIVER_DEFAULT_RESET_MS / 1000;
const WINDOWS_PER_DAY = (24 * 60 * 60) / RESET_INTERVAL_SEC; // = 360
const WINDOWS_PER_MONTH = WINDOWS_PER_DAY * 30; // = 10800
const GB = 1024 * 1024 * 1024;
const FEASIBILITY_TOLERANCE_PCT = 0.1; // ±10% of target counts as "hit"
const MIN_REPORTER_DAYS = 7;

// ── refresh-mode constants (Item 7) ─────────────────────────────────
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

// Severity-weighted ranking for the greedy solver (OPEN Q 5 default).
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
      'Destination SIEM. Auto-detected from active env / snapshot recommendations when omitted; if auto-detect fails the tool returns a structured not-configured envelope.'
    ),
  es_pruned: z
    .boolean()
    .optional()
    .describe(
      'Elasticsearch only: are compactable fields excluded from `_source` via index template? Default `false` (unpruned). Auto-detection requires reading the customer index template; this knob is the explicit override. See OPEN Q 2 in the 14d-24 spec.'
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
  // Verdict from /tmp/poc-comparison/14d-26-mcp-config-write-pattern-research.md:
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
};

const schemaObj = z.object(configureEngineSchema);
export type ConfigureEngineArgs = z.infer<typeof schemaObj>;

// ─── output types ─────────────────────────────────────────────────────
interface PerPatternRow {
  pattern_hash: string;
  current_bytes_30d: number;
  cap_bytes_per_window: number;
  action: Action;
  projected_monthly_usd_low: number;
  projected_monthly_usd_expected: number;
  projected_monthly_usd_high: number;
  floor_reason?: string;
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
  derivation?: {
    current_monthly_bytes: number;
    current_monthly_usd: number;
    target_monthly_bytes: number;
    target_monthly_usd: number;
    floor_count: number;
    actions_used: Partial<Record<Action, number>>;
  };
  per_pattern_rows?: PerPatternRow[];
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
  };
  next_actions?: Array<{ tool: string; args: unknown; why: string }>;
  error?: string;
  /**
   * One-paragraph plain-prose distillation of the structured data.
   * Agents quote this directly; dollars omitted unless feasible derivation ran.
   */
  human_summary: string;
}

// ─── main entry ───────────────────────────────────────────────────────
export async function executeConfigureEngine(
  args: ConfigureEngineArgs
): Promise<string | StructuredOutput> {
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
    const targetErrHint = firstLine(target.error);
    // Nudge log10x_set_gitops_repo when the hint signals a missing gitops
    // repo. log10x_set_gitops_repo writes gitops.repo to envs.json;
    // log10x_configure_env only handles metricsBackend and cannot write
    // that field.
    const targetActions: import('../lib/output-types.js').Action[] =
      isGitopsHint(targetErrHint)
        ? [
            {
              tool: 'log10x_set_gitops_repo',
              args: {},
              reason:
                'Write gitops.repo to envs.json so configure_engine knows which GitHub repo to open the cap-CSV PR against. After running, restart the MCP server and retry.',
              role: 'recommended-next',
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

  // Resolve customer metrics backend.
  let backend: CustomerMetricsBackend;
  try {
    const r = await resolveBackend();
    if (!r.backend) {
      throw new CustomerMetricsNotConfiguredError(formatDetectionTrace(r.trace));
    }
    backend = r.backend;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    return buildChassisErrorEnvelope({
      tool: 'log10x_configure_engine',
      err: {
        error_type: 'backend_unavailable',
        retryable: true,
        suggested_backoff_ms: null,
        hint: `configure_engine refused: customer metrics backend not configured. ${firstLine(msg)}`,
      },
      contextPayload: { ok: false, phase: 'backend', service: args.service, containers: args.containers ?? [], error: msg },
      source_disclosure: { bytes_source: 'tsdb' },
      actions: [
        {
          tool: 'log10x_doctor',
          args: {},
          reason:
            'Run a health check to diagnose why the customer metrics backend is unreachable and confirm which components are live.',
          role: 'recommended-next',
        },
      ],
    });
  }

  // Phase 1: container resolution.
  if (!args.containers || args.containers.length === 0) {
    const resPromptHeadline = `Phase 1: pick containers for service "${args.service}" — re-call with containers: ["..."] to derive policy.`;
    return buildChassisEnvelope({
      tool: 'log10x_configure_engine',
      view: 'summary',
      headline: resPromptHeadline,
      status: 'partial',
      decisions: { threshold_used: args.target_percent ?? null, threshold_basis: args.target_percent != null ? 'customer_supplied' : 'default' },
      source_disclosure: { bytes_source: 'tsdb', siem_vendor: target.resolved.destination },
      scope: { window: `${args.observationDays ?? 7}d`, window_basis: 'explicit' },
      payload: {
        ok: true, phase: 'resolution_prompt', service: args.service,
        containers: [], destination: target.resolved.destination,
        human_summary: `Phase 1: configure_engine needs the container list for service "${args.service}" (destination ${target.resolved.destination}). Re-call with containers: [...] to derive the policy.`,
      } satisfies ConfigureEngineData,
      human_summary: `Phase 1: configure_engine needs the container list for service "${args.service}" (destination ${target.resolved.destination}). Re-call with containers: [...] to derive the policy.`,
    });
  }

  // Phase 2: solve + render.
  const destination = target.resolved.destination;
  const observationDays = args.observationDays ?? 7;

  const perPattern = await fetchPerPatternBytes(
    backend,
    args.containers,
    observationDays
  );

  // Monthly projection from observation window.
  const scaleToMonth = 30 / observationDays;
  const totalObservedBytes = perPattern.reduce((s, p) => s + p.bytes, 0);
  const currentMonthlyBytes = totalObservedBytes * scaleToMonth;
  const model = getDestinationCostModel(destination, { esPruned: args.es_pruned });

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
    (model.ingest_per_gb + model.storage_per_gb_month);

  // Resolve target bytes.
  let targetPercent: number;
  let targetMonthlyBytes: number;
  if (args.budget_usd !== undefined) {
    const effectivePerGb =
      model.ingest_per_gb + model.storage_per_gb_month;
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
  let effectiveStandardAction: Action = standardAction;
  if (standardAction === 'compact' && model.compact_mode === 'no-op') {
    effectiveStandardAction = getDefaultActionForDestination(destination, 1);
    warnings.push(
      `\`compact\` is a no-op on ${destination}; standard-tier default fell back to \`${effectiveStandardAction}\` (destination's preferred level-1 action). Override via \`action_defaults.standard\`.`
    );
  }

  // Run the greedy solver.
  const rows: PerPatternRow[] = [];
  const actionsUsed: Partial<Record<Action, number>> = {};
  const targetShedBytes = Math.max(0, currentMonthlyBytes - targetMonthlyBytes);
  let remainingBytesToShed = targetShedBytes;
  let floorCount = 0;
  let coveredBytes = 0;

  for (const c of candidates) {
    const monthlyBytes = c.bytes * scaleToMonth;
    coveredBytes += c.bytes;

    // Resolve the action for this row.
    let action: Action;
    let reason: string;
    let floorReason: string | undefined;

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
      action = effectiveStandardAction;
      reason = 'tier=standard';
    } else if (c.tier === 'debug') {
      action = debugAction;
      reason = 'tier=debug';
    } else {
      action = syntheticAction;
      reason = 'tier=synthetic';
    }

    // If target already met, downgrade further standard rows to pass.
    if (
      action !== 'pass' &&
      action !== 'sample' &&
      floorHit === undefined &&
      c.tier !== 'audit' &&
      c.tier !== 'error' &&
      remainingBytesToShed <= 0
    ) {
      action = 'pass';
      reason = `${reason} (target met)`;
    }

    // Project savings range using the cost lib.
    const range = projectActionRange({
      action,
      bytes_in: monthlyBytes,
      avg_event_size_bytes: c.events > 0 ? c.bytes / c.events : undefined,
      sample_n: 10,
      destination,
      retention_months: 1,
      esPruned: args.es_pruned,
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

    rows.push({
      pattern_hash: c.pattern_hash,
      current_bytes_30d: Math.round(monthlyBytes),
      cap_bytes_per_window: Math.round(capBytesPerWindow),
      action,
      // total_dollars is now nullable on SavingsProjection — null means the
      // destination has no list rate and no customer override. Current
      // surface still emits a number; full rate_source propagation lands in
      // the configure-engine patch (step 8 of the build order).
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

  // Zero-change PR: target already met by current config (OPEN Q 8 default).
  const targetMetByCurrent = targetShedBytes <= 0;

  // CSV diff. Preamble captures the committed target + observed baseline so
  // a later `mode='refresh'` call can compute volume drift without
  // re-running the SIEM / live-Prometheus path against the original window.
  const csvDiff = renderCsvDiff(
    args.containers,
    args.current_csv,
    rows,
    effectiveStandardAction,
    args.reduction ?? 'hard',
    { targetPercent, baselineMonthlyBytes: currentMonthlyBytes }
  );

  // Build action-intent.json alongside the cap CSV. The intent file is the
  // canonical source of pattern→action mapping; the cap CSV is now the
  // engine-only safety-floor file (no `:action` suffix).
  const actionIntentEntries: ActionIntentEntry[] = buildActionIntentEntries(
    rows.map((r) => ({
      pattern_hash: r.pattern_hash,
      action: r.action,
      service: args.service,
      reason: r.floor_reason ?? r.reason,
    }))
  );
  const actionIntentJson = writeActionIntent(actionIntentEntries);

  const prCommand =
    !feasible || targetMetByCurrent
      ? null
      : renderPrCommand(args, target.resolved, csvDiff, actionIntentJson);

  // ── Auto-apply (industry-standard MCP write-tool behavior) ──
  // Convention: write-capable MCPs auto-execute by default; safety lives in
  // the gh CLI token scope and the MCP client's approval UX. Per-call
  // opt-outs: auto_apply=false or read_only=true. Falls through silently
  // (no change in behavior) when prCommand is null (infeasible plan or
  // zero-change PR).
  let applied: ConfigureEngineData['applied'];
  if (prCommand && (args.auto_apply ?? true) && !(args.read_only ?? false)) {
    applied = await applyViaGh(prCommand);
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
          (model.ingest_per_gb + model.storage_per_gb_month)
      ),
      floor_count: floorCount,
      actions_used: actionsUsed,
    },
    per_pattern_rows: rows,
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
    payload: data,
    human_summary: data.human_summary ?? configHeadline,
    actions: toEnvelopeActions(nextActions),
    warnings,
  });
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

  // TODO: build action-intent.json from the POC envelope when poc-envelope-v2
  // exposes per-pattern action entries. Until then pass undefined — the PR
  // script will write the cap CSV only.
  const prCommand = feasibility && feasibility.feasible
    ? renderPrCommand(args, resolved, diff, undefined)
    : null;

  let applied: ConfigureEngineData['applied'];
  if (prCommand && (args.auto_apply ?? true) && !(args.read_only ?? false)) {
    applied = await applyViaGh(prCommand);
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
    payload: data,
    human_summary: data.human_summary ?? headline,
    actions: toEnvelopeActions(data.next_actions ?? []),
    warnings,
  });
}

// ─── refresh-mode helpers (Item 7) ────────────────────────────────────
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
}

async function resolveTarget(
  args: ConfigureEngineArgs
): Promise<{ resolved: ResolvedTarget } | { error: string }> {
  let repo: string | undefined = args.gitops_repo;
  let lookupPath: string | undefined = args.lookup_path;
  let destination: SiemId | undefined = args.destination;

  // 1. Active env from envs.json.
  if (!repo || !destination) {
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
    } catch {
      // non-fatal — fall through to snapshot / explicit args
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

  if (!repo) {
    return {
      error: renderError(
        'gitops repo not resolved',
        'configure_engine needs `gitops_repo` (owner/name) to author the cap-CSV PR. ' +
        'Three options: ' +
        '(1) Pass `gitops_repo` directly on this call. ' +
        '(2) Run `log10x_set_gitops_repo` to write it to `~/.log10x/envs.json` — ' +
        'then restart the MCP server (log10x_dev_restart) and retry. ' +
        '(3) Set the `LOG10X_GH_REPO` environment variable on the MCP server process and restart.'
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
      gitops_repo: repo,
      lookup_path: lookupPath ?? args.lookup_path ?? DEFAULT_LOOKUP_PATH,
      gitops_branch: args.gitops_branch ?? 'main',
      destination,
    },
  };
}

// ─── per-pattern fetch ────────────────────────────────────────────────
interface PerPattern {
  pattern_hash: string;
  bytes: number;
  events: number;
  severity: string;
}

async function fetchPerPatternBytes(
  backend: CustomerMetricsBackend,
  containers: string[],
  observationDays: number
): Promise<PerPattern[]> {
  const containerRegex = containers.map(promEscape).join('|');
  const filter = `k8s_container=~"${containerRegex}"`;
  const window = `${observationDays}d`;

  // Pattern bytes (grouped by tenx_hash + severity_level to drive tier
  // inference). The aggregator's severity_level label is the engine's
  // default; per-env relabels are handled by the env's LabelNameMap, but
  // configure_engine intentionally uses the default for now — relabeled
  // envs will hit the missing-label warning path below.
  const bytesQ = `sum by (tenx_hash, severity_level)(increase(all_events_summaryBytes_total{${filter}}[${window}]))`;
  const eventsQ = `sum by (tenx_hash)(increase(all_events_summaryVolume_total{${filter}}[${window}]))`;

  const [bytesRes, eventsRes] = await Promise.all([
    backend.queryInstant(bytesQ) as Promise<PrometheusResponse>,
    backend.queryInstant(eventsQ) as Promise<PrometheusResponse>,
  ]);

  const eventsByHash = new Map<string, number>();
  for (const r of eventsRes.data.result) {
    const h = r.metric.tenx_hash;
    if (!h) continue;
    eventsByHash.set(h, parseFloat(r.value?.[1] ?? '0'));
  }

  const byHash = new Map<string, PerPattern>();
  for (const r of bytesRes.data.result) {
    const h = r.metric.tenx_hash;
    if (!h) continue;
    const bytes = parseFloat(r.value?.[1] ?? '0');
    const severity = r.metric.severity_level ?? '';
    const existing = byHash.get(h);
    if (existing) {
      existing.bytes += bytes;
      if (!existing.severity && severity) existing.severity = severity;
    } else {
      byHash.set(h, {
        pattern_hash: h,
        bytes,
        events: eventsByHash.get(h) ?? 0,
        severity,
      });
    }
  }

  return [...byHash.values()];
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

function renderCsvDiff(
  containers: string[],
  currentCsv: string | undefined,
  rows: PerPatternRow[],
  defaultAction: Action,
  reduction: 'soft' | 'hard',
  commitment?: { targetPercent: number; baselineMonthlyBytes: number }
): string {
  const baseline = parseCsv(currentCsv);
  const merged = new Map(baseline.rows);
  // Container-level default row per container. Format:
  // `<bytes>::<reason>` (no `:action` suffix — action intent lives in
  // data/action-intent.json, not in the cap CSV).
  const avgCap = rows.length > 0
    ? Math.round(rows.reduce((s, r) => s + r.cap_bytes_per_window, 0) / rows.length)
    : 0;
  const reason = `MCP configure_engine (${reduction}, default=${defaultAction})`;
  for (const c of containers) {
    const value = `${avgCap}::${reason.replace(/,/g, ';')}`;
    merged.set(c, value);
  }
  // Per-pattern overrides land in a sibling file keyed `pat:<hash>` so
  // the engine's lookup chain reads container-default first, then
  // pattern overrides. Spec L280 keys rows by pattern_hash.
  // No `:action` suffix — action intent is in action-intent.json.
  for (const r of rows) {
    if (r.floor_reason) {
      merged.set(
        `pat:${r.pattern_hash}`,
        `${r.cap_bytes_per_window}::${r.floor_reason.replace(/,/g, ';')}`
      );
    } else if (r.action !== defaultAction) {
      merged.set(
        `pat:${r.pattern_hash}`,
        `${r.cap_bytes_per_window}::${r.reason.replace(/,/g, ';')}`
      );
    }
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
  csvDiff: string,
  actionIntentJson?: string
): string {
  const repo = resolved.gitops_repo;
  const branch = resolved.gitops_branch;
  const lookupPath = resolved.lookup_path;
  const actionIntentPath = 'data/action-intent.json';
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
  out.push(`ACTION_INTENT_PATH=${shellQuote(actionIntentPath)}`);
  out.push(`BRANCH=${shellQuote(prBranch)}`);
  out.push(`PR_TITLE=${shellQuote(prTitle)}`);
  out.push('');
  out.push('TMPFILE=$(mktemp)');
  out.push("cat > \"$TMPFILE\" <<'CSV_EOF'");
  out.push(newCsv.trimEnd());
  out.push('CSV_EOF');
  out.push('');

  // action-intent.json block (written atomically before cap CSV so a
  // partial-commit window always has intent available even if the CSV
  // commit fails; the parser treats a missing CSV gracefully).
  if (actionIntentJson) {
    out.push('INTENT_TMPFILE=$(mktemp)');
    out.push("cat > \"$INTENT_TMPFILE\" <<'INTENT_EOF'");
    out.push(actionIntentJson.trimEnd());
    out.push('INTENT_EOF');
    out.push('');
    out.push('# Resolve current action-intent.json SHA (empty if not yet created).');
    out.push(
      'INTENT_SHA=$(gh api "/repos/$REPO/contents/$ACTION_INTENT_PATH?ref=$BASE" --jq .sha 2>/dev/null || true)'
    );
    out.push('');
  }

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

  if (actionIntentJson) {
    // Commit action-intent.json FIRST (write intent before floor).
    out.push('# Commit action-intent.json (written before cap CSV — intent is available even on partial commit).');
    out.push('INTENT_B64=$(base64 < "$INTENT_TMPFILE" | tr -d "\\n")');
    out.push('INTENT_ARGS=( -X PUT "/repos/$REPO/contents/$ACTION_INTENT_PATH"');
    out.push('  -f branch="$BRANCH"');
    out.push('  -f message="$PR_TITLE (action-intent.json)"');
    out.push('  -f content="$INTENT_B64" )');
    out.push('[ -n "$INTENT_SHA" ] && INTENT_ARGS+=( -f sha="$INTENT_SHA" )');
    out.push('gh api "${INTENT_ARGS[@]}"');
    out.push('');
  }

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
 * Mapping (aligned with defect-39 spec):
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

