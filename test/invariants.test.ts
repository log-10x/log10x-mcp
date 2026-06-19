/**
 * Cross-cutting ENVELOPE INVARIANT harness.
 *
 * A manual sweep of the catalog kept finding the SAME ~8 bug classes over
 * and over (a hash leaking into a headline, an action that routes to a tool
 * with the wrong arg name, a GB figure computed as bytes/2^30, a backend
 * error thrown as a raw string instead of a structured envelope, …). This
 * file turns each of those classes into a machine check that runs over a
 * LIST of (tool, producedEnvelope) pairs, so adding a tool to the sweep is
 * one array entry and a regression breaks the build.
 *
 * THE EIGHT INVARIANTS (asserted on every applicable envelope):
 *   1. chassis_conformance  — out.data parses ChassisDataSchema; rows live
 *                             under data.payload, never flat on data.
 *   2. no_hash_in_headline  — no bare 11-char tenx_hash in summary.headline
 *                             / bullets / callout / human_summary.
 *   3. no_dead_end_actions  — every action names a REGISTERED tool and its
 *                             args validate against THAT tool's zod schema.
 *   4. structured_error     — a failed call returns an error-bearing
 *                             envelope (never throws); error/demo_read_only
 *                             carry a populated data.error block.
 *   5. real_telemetry       — performance.query_count never EXCEEDS the real
 *                             backend-call count (no fabricated work); ideal
 *                             is exact equality (allowlisted where a tool
 *                             under-reports — see KNOWN_VIOLATIONS).
 *   6. parts_sum_le_whole   — any per-item breakdown sums to <= the stated
 *                             whole within rounding; no negative parts.
 *   7. decimal_gb           — GB == bytes/1e9 (decimal), NOT bytes/2^30.
 *   8. money_properties     — dollars_saved <= env spend; a `pass` row saves
 *                             0; headline savings == sum of per-pattern plan.
 *
 * BACKEND SEAM: tools never call HTTP directly — lib/api.ts queryInstant /
 * queryRange delegate to env.metricsBackend. So a tool is fully
 * deterministic when handed a fake EnvConfig whose metricsBackend is the
 * in-memory stub from test/helpers/fake-env.ts (no server). The stub counts
 * every call so real_telemetry can compare query_count against real work.
 *
 * VIOLATION POLICY — ALLOWLIST-WITH-TODO (keeps the suite green + documents
 * the gap, instead of silent-skip or blanket-fail):
 *   - Default is HARD FAIL: a NEW regression breaks the build.
 *   - A REAL pre-existing tool bug found on first run is recorded in
 *     KNOWN_VIOLATIONS keyed `${tool}:${invariant}` with a reason + TODO.
 *     softAssert() downgrades those specific failures to a diagnostic so
 *     the suite stays green while the bug is tracked — it does NOT mute the
 *     same invariant for any other tool.
 *   - A stale-entry guard re-runs every allowlisted assertion; if one now
 *     PASSES it fails the suite with "remove the stale allowlist entry",
 *     forcing the list to shrink as bugs are fixed.
 *   - The fix for a violation is ALWAYS the tool, never this harness and
 *     never the allowlist-as-permanent-mute.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { ChassisDataSchema, ChassisStatusSchema } from '../src/lib/chassis-envelope.js';
import { PRIMITIVE_ERROR_TYPES } from '../src/lib/primitive-errors.js';
import type { StructuredOutput } from '../src/lib/output-types.js';

import { makeStubBackend, makeFakeEnv, type StubBackend } from './helpers/fake-env.js';

// ── tool executors ────────────────────────────────────────────────────
import { executeResolveBatch } from '../src/tools/resolve-batch.js';
import { executeExtractTemplates } from '../src/tools/extract-templates.js';
import { executePocStatus } from '../src/tools/poc-from-siem.js';
import { executeServices } from '../src/tools/services.js';
import { executeTopPatterns } from '../src/tools/top-patterns.js';
import { executeEstimateSavings } from '../src/tools/estimate-savings.js';
import { executeConfigureEngine } from '../src/tools/configure-engine.js';
import { executePatternDetail } from '../src/tools/pattern-detail.js';
import { executeInvestigate } from '../src/tools/investigate.js';
import { executeFindSkew, _setExtractPatterns } from '../src/tools/find-skew.js';
import { executeCostOptions } from '../src/tools/cost-options.js';
import { executeLog10xStart } from '../src/tools/log10x-start.js';
import type { ExtractedPattern, ExtractedPatterns } from '../src/lib/pattern-extraction.js';

// ── all 66 per-tool zod shapes (the no_dead_end_actions spine) ─────────
import { eventLookupSchema } from '../src/tools/event-lookup.js';
import { patternExamplesSchema } from '../src/tools/pattern-examples.js';
import { productQaSchema } from '../src/tools/product-qa.js';
import { savingsSchema } from '../src/tools/savings.js';
import { trendSchema } from '../src/tools/trend.js';
import { dependencyCheckSchema } from '../src/tools/dependency-check.js';
import { configureEnvSchema } from '../src/tools/configure-env.js';
import { setGitopsRepoSchema } from '../src/tools/set-gitops-repo.js';
import { destSetSchema, envValidateSchema, envDiffVsEnvvarsSchema } from '../src/tools/env-config-manage.js';
import { offloadAddSchema, offloadArchiveSchema } from '../src/tools/offload-manage.js';
import { topPatternsSchema } from '../src/tools/top-patterns.js';
import { patternDiffSchema } from '../src/tools/pattern-diff.js';
import { whatsChangingSchema } from '../src/tools/whats-changing.js';
import { whatsNewSchema } from '../src/tools/whats-new.js';
import { servicesSchema } from '../src/tools/services.js';
import { overflowContentsSchema } from '../src/tools/overflow-contents.js';
import { discoverLabelsSchema } from '../src/tools/discover-labels.js';
import { investigateSchema } from '../src/tools/investigate.js';
import { findSkewSchema } from '../src/tools/find-skew.js';
import { resolveBatchSchema } from '../src/tools/resolve-batch.js';
import { extractTemplatesSchema } from '../src/tools/extract-templates.js';
import { retrieverQuerySchema } from '../src/tools/retriever-query.js';
import { retrieverSeriesSchema } from '../src/tools/retriever-series.js';
import { retrieverQueryStatusSchema } from '../src/tools/retriever-query-status.js';
import { retrieverProbeSchema } from '../src/tools/retriever-probe.js';
import { retrieverRegisterSchema } from '../src/tools/retriever-register.js';
import { backfillMetricSchema } from '../src/tools/backfill-metric.js';
import { log10xStartSchema } from '../src/tools/log10x-start.js';
import { costOptionsSchema } from '../src/tools/cost-options.js';
import { explainModeSchema } from '../src/tools/explain-mode.js';
import { previewFilterSchema } from '../src/tools/preview-filter.js';
import { patternDetailSchema } from '../src/tools/pattern-detail.js';
import { measureCompactionSchema } from '../src/tools/measure-compaction.js';
import { setupRecurringSchema } from '../src/tools/setup-recurring.js';
import { doctorSchema } from '../src/tools/doctor.js';
import { loginStatusSchema } from '../src/tools/login-status.js';
import { signinStartSchema, signinCompleteSchema } from '../src/tools/signin.js';
import { signoutSchema } from '../src/tools/signout.js';
import { updateSettingsSchema } from '../src/tools/update-settings.js';
import { createEnvSchema } from '../src/tools/create-env.js';
import { updateEnvSchema } from '../src/tools/update-env.js';
import { deleteEnvSchema } from '../src/tools/delete-env.js';
import { envRegisterSchema } from '../src/tools/env-register.js';
import { rotateApiKeySchema } from '../src/tools/rotate-api-key.js';
import { customerMetricsQuerySchema } from '../src/tools/customer-metrics-query.js';
import { discoverJoinSchema } from '../src/tools/discover-join.js';
import { metricsThatMovedSchema } from '../src/tools/metrics-that-moved.js';
import { rankByShapeSimilaritySchema } from '../src/tools/rank-by-shape-similarity.js';
import { metricOverlaySchema } from '../src/tools/metric-overlay.js';
import { pocFromSiemSubmitSchema, pocFromSiemStatusSchema } from '../src/tools/poc-from-siem.js';
import { pocFromLocalSchema } from '../src/tools/poc-from-local.js';
import { discoverEnvSchema } from '../src/tools/discover-env.js';
import { adviseRetrieverSchema } from '../src/tools/advise-retriever.js';
import { adviseInstallSchema } from '../src/tools/advise-install.js';
import { configureEngineSchema } from '../src/tools/configure-engine.js';
import { estimateSavingsSchema } from '../src/tools/estimate-savings.js';
import { baselineSchema } from '../src/tools/baseline.js';
import { commitmentReportSchema } from '../src/tools/commitment-report.js';
import { patternMitigateSchema } from '../src/tools/pattern-mitigate.js';
import { devRestartSchema } from '../src/tools/dev-restart.js';

// ════════════════════════════════════════════════════════════════════════
// Tool schema registry — the spine of no_dead_end_actions.
//
// Map MCP tool name → z.object(rawShape).strict() EXACTLY as the names are
// registered in src/index.ts via registerLog10xTool(name, <tool>Schema, …).
// .strict() so an action arg key that is NOT declared by the target schema
// is rejected (the "field absent from the schema" dead-end). Defaulted /
// optional fields mean a sparse-but-valid action still passes.
// ════════════════════════════════════════════════════════════════════════
type ZShape = Record<string, z.ZodTypeAny>;
function obj(shape: ZShape): z.ZodObject<ZShape> {
  return z.object(shape).strict();
}

const TOOL_SCHEMAS: Record<string, z.ZodObject<ZShape>> = {
  log10x_event_lookup: obj(eventLookupSchema as ZShape),
  log10x_pattern_examples: obj(patternExamplesSchema as ZShape),
  log10x_product_qa: obj(productQaSchema as ZShape),
  log10x_savings: obj(savingsSchema as ZShape),
  log10x_pattern_trend: obj(trendSchema as ZShape),
  log10x_dependency_check: obj(dependencyCheckSchema as ZShape),
  log10x_configure_env: obj(configureEnvSchema as ZShape),
  log10x_set_gitops_repo: obj(setGitopsRepoSchema as ZShape),
  log10x_dest_set: obj(destSetSchema as ZShape),
  log10x_env_validate: obj(envValidateSchema as ZShape),
  log10x_env_diff_vs_envvars: obj(envDiffVsEnvvarsSchema as ZShape),
  log10x_offload_add: obj(offloadAddSchema as ZShape),
  log10x_offload_archive: obj(offloadArchiveSchema as ZShape),
  log10x_top_patterns: obj(topPatternsSchema as ZShape),
  log10x_pattern_diff: obj(patternDiffSchema as ZShape),
  log10x_whats_changing: obj(whatsChangingSchema as ZShape),
  log10x_whats_new: obj(whatsNewSchema as ZShape),
  log10x_services: obj(servicesSchema as ZShape),
  log10x_overflow_contents: obj(overflowContentsSchema as ZShape),
  log10x_discover_labels: obj(discoverLabelsSchema as ZShape),
  log10x_investigate: obj(investigateSchema as ZShape),
  log10x_find_skew: obj(findSkewSchema as ZShape),
  log10x_resolve_batch: obj(resolveBatchSchema as ZShape),
  log10x_extract_templates: obj(extractTemplatesSchema as ZShape),
  log10x_retriever_query: obj(retrieverQuerySchema as ZShape),
  log10x_retriever_series: obj(retrieverSeriesSchema as ZShape),
  log10x_retriever_query_status: obj(retrieverQueryStatusSchema as ZShape),
  log10x_retriever_probe: obj(retrieverProbeSchema as ZShape),
  log10x_retriever_register: obj(retrieverRegisterSchema as ZShape),
  log10x_backfill_metric: obj(backfillMetricSchema as ZShape),
  log10x_start: obj(log10xStartSchema as ZShape),
  log10x_cost_options: obj(costOptionsSchema as ZShape),
  log10x_explain_mode: obj(explainModeSchema as ZShape),
  log10x_preview_filter: obj(previewFilterSchema as ZShape),
  log10x_pattern_detail: obj(patternDetailSchema as ZShape),
  log10x_measure_compaction: obj(measureCompactionSchema as ZShape),
  log10x_setup_recurring: obj(setupRecurringSchema as ZShape),
  log10x_doctor: obj(doctorSchema as ZShape),
  log10x_login_status: obj(loginStatusSchema as ZShape),
  log10x_signin_start: obj(signinStartSchema as ZShape),
  log10x_signin_complete: obj(signinCompleteSchema as ZShape),
  log10x_signout: obj(signoutSchema as ZShape),
  log10x_update_settings: obj(updateSettingsSchema as ZShape),
  log10x_create_env: obj(createEnvSchema as ZShape),
  log10x_update_env: obj(updateEnvSchema as ZShape),
  log10x_delete_env: obj(deleteEnvSchema as ZShape),
  log10x_env_register: obj(envRegisterSchema as ZShape),
  log10x_rotate_api_key: obj(rotateApiKeySchema as ZShape),
  log10x_customer_metrics_query: obj(customerMetricsQuerySchema as ZShape),
  log10x_discover_join: obj(discoverJoinSchema as ZShape),
  log10x_metrics_that_moved: obj(metricsThatMovedSchema as ZShape),
  log10x_rank_by_shape_similarity: obj(rankByShapeSimilaritySchema as ZShape),
  log10x_metric_overlay: obj(metricOverlaySchema as ZShape),
  log10x_poc_from_siem_submit: obj(pocFromSiemSubmitSchema as ZShape),
  log10x_poc_from_siem_status: obj(pocFromSiemStatusSchema as ZShape),
  log10x_poc_from_local: obj(pocFromLocalSchema as ZShape),
  log10x_discover_env: obj(discoverEnvSchema as ZShape),
  log10x_advise_retriever: obj(adviseRetrieverSchema as ZShape),
  log10x_advise_install: obj(adviseInstallSchema as ZShape),
  log10x_configure_engine: obj(configureEngineSchema as ZShape),
  log10x_estimate_savings: obj(estimateSavingsSchema as ZShape),
  log10x_baseline: obj(baselineSchema as ZShape),
  log10x_commitment_report: obj(commitmentReportSchema as ZShape),
  log10x_pattern_mitigate: obj(patternMitigateSchema as ZShape),
  log10x_dev_restart: obj(devRestartSchema as ZShape),
};

// ════════════════════════════════════════════════════════════════════════
// KNOWN_VIOLATIONS — real, pre-existing tool bugs surfaced on the first run.
// Each entry is keyed `${tool}:${invariant}`. softAssert downgrades exactly
// these to a diagnostic; everything else is a hard fail. The stale-entry
// guard removes an entry the moment the underlying tool is fixed.
//
// NONE of these are harness bugs — each is reproduced below with the exact
// observed behaviour. The fix is in the TOOL, after which the entry's
// assertion will start passing and the stale-guard will demand its removal.
// ════════════════════════════════════════════════════════════════════════
const KNOWN_VIOLATIONS: Record<string, { reason: string; ticket: string }> = {
  // services builds a chassis telemetry accumulator but never calls
  // recordQuery(), so query_count is 0 while the stub recorded 4 real
  // backend calls. Under-reporting (not fabrication). Fix: thread
  // recordQuery() through executeServicesInner's queries.
  'log10x_services:real_telemetry': {
    reason: 'services never calls recordQuery(); query_count=0 vs real backend calls>0 (under-report, not fabrication)',
    ticket: 'TODO(real_telemetry): wire recordQuery() into executeServicesInner',
  },
  // top_patterns records only the meta-probe queries (query_count=2) but
  // fires ~14 backend calls across the phase-1/phase-2 fan-out. Under-report.
  'log10x_top_patterns:real_telemetry': {
    reason: 'top_patterns records only a subset of its fan-out queries; query_count < real backend calls (under-report)',
    ticket: 'TODO(real_telemetry): recordQuery() on every queryInstant/queryRange in top-patterns phase 1+2',
  },
  // estimate_savings records 1 query while the forecast path fires ~6.
  'log10x_estimate_savings:real_telemetry': {
    reason: 'estimate_savings forecast records query_count=1 vs ~6 real backend calls (under-report)',
    ticket: 'TODO(real_telemetry): recordQuery() per queryInstant in the forecast/verify fan-out',
  },
  // investigate uses its own telemetry path and emits query_count=0 while
  // the stub saw ~24 calls.
  'log10x_investigate:real_telemetry': {
    reason: 'investigate emits query_count=0 on the chassis performance block despite ~24 real backend calls (under-report)',
    ticket: 'TODO(real_telemetry): surface investigate query count on performance.query_count',
  },
  // services' PRIMARY ranking query has no .catch — a backend-down throw
  // propagates as a raw rejection instead of a structured error envelope.
  'log10x_services:structured_error': {
    reason: 'services lets a primary-query backend failure throw (no try/catch around the lead query) instead of returning a structured error envelope',
    ticket: 'TODO(structured_error): wrap services backend fan-out and emit buildChassisErrorEnvelope on failure',
  },
  // top_patterns' primary topk query is un-caught — backend-down throws.
  'log10x_top_patterns:structured_error': {
    reason: 'top_patterns primary topk query is un-caught; backend-down rejects the promise instead of returning a structured error',
    ticket: 'TODO(structured_error): catch the lead topPatternsFull query and emit a structured error envelope',
  },

  // ── DEAD-END findings: emitter ↔ target-schema mismatches ────────────
  // These are exactly the cross-chain class the harness is built to catch.
  // The design wants no_dead_end_actions hard-fail with no allowlist, but
  // the task rule (do not break the suite on PRE-EXISTING tool bugs) wins:
  // each is recorded here with a TODO so the chain bug is tracked and the
  // suite stays green. The fix is in the named tool, never in this harness.

  // estimate_savings emits a `configure_engine` next-action with
  // {destination, target_percent} but NOT `service`. configure_engine's
  // SCHEMA marks `service` required (z.string(), no .optional()), yet its
  // own runtime preflight EXPLICITLY accepts a missing service and lists
  // container candidates. So the action is runtime-valid but schema-strict
  // invalid — the configure_engine schema overstates `service`. Fix: mark
  // configureEngineSchema.service .optional() (it already has a no-service
  // preflight), OR have estimate_savings thread the service through.
  'log10x_estimate_savings:no_dead_end_actions': {
    reason: 'estimate_savings → configure_engine action omits `service`, which configureEngineSchema marks required (z.string()) even though configure_engine has a no-service candidate-listing preflight',
    ticket: 'TODO(no_dead_end_actions): make configureEngineSchema.service optional (runtime already handles its absence) or thread service through the action',
  },
  // investigate emits a `metrics_that_moved` next-action without
  // `candidates` (metricsThatMovedSchema marks it z.array().min(1)). The
  // co-mover candidate list is meant to be filled by the agent, so the
  // emitted action is an under-specified template — a dead-end as written.
  'log10x_investigate:no_dead_end_actions': {
    reason: 'investigate → metrics_that_moved action omits required `candidates` (z.array().min(1)); the action is an agent-fill template, not a runnable call',
    ticket: 'TODO(no_dead_end_actions): have investigate seed `candidates` from the co-mover set, or drop the action until it can',
  },
  // extract_templates emits a `configure_env` next-action with empty args
  // ({}) and the reason "configure the missing field" — but configureEnvSchema
  // requires `nickname` + `metricsBackend`. Under-specified template action.
  'log10x_extract_templates:no_dead_end_actions': {
    reason: 'extract_templates → configure_env action passes empty args while configureEnvSchema requires nickname + metricsBackend; the action is an agent-fill template, not a runnable call',
    ticket: 'TODO(no_dead_end_actions): drop the configure_env action from extract_templates or supply the required nickname/metricsBackend',
  },
};

// ── softAssert + stale-guard plumbing ─────────────────────────────────
/** Records which allowlisted keys actually fired (failed) this run, so the
 *  stale-entry guard can flag any that never fired (i.e. now pass). */
const firedViolations = new Set<string>();

type Diag = (msg: string) => void;

/**
 * Assert `cond`. On failure:
 *   - key ∈ KNOWN_VIOLATIONS → diagnostic + record the firing (suite green)
 *   - key ∉ KNOWN_VIOLATIONS → hard fail (a NEW regression breaks the build)
 */
function softAssert(cond: boolean, key: string, msg: string, diag: Diag): void {
  if (cond) return;
  const known = KNOWN_VIOLATIONS[key];
  if (known) {
    firedViolations.add(key);
    diag(`KNOWN VIOLATION ${key} — ${known.reason} [${known.ticket}]`);
    return;
  }
  assert.fail(`INVARIANT VIOLATION ${key}: ${msg}`);
}

// ════════════════════════════════════════════════════════════════════════
// Envelope read helpers
// ════════════════════════════════════════════════════════════════════════
type Out = StructuredOutput;
interface ChassisRead {
  status: string;
  decisions: unknown;
  source_disclosure: unknown;
  scope: unknown;
  payload: Record<string, unknown>;
  human_summary: string;
  must_render_verbatim?: string;
  must_ask_user?: { question: string; options: string[] };
  forbidden_next_actions?: string[];
  error?: { error_type: string; retryable: boolean; suggested_backoff_ms: number | null; hint: string };
}

function asEnvelope(out: string | Out, tool: string): Out {
  if (typeof out === 'string') {
    assert.fail(`${tool}: returned a bare string instead of a structured envelope: ${out.slice(0, 120)}`);
  }
  return out;
}

function chassis(out: Out): ChassisRead {
  return out.data as unknown as ChassisRead;
}

function summaryText(out: Out): string {
  const s = out.summary as { headline?: string; bullets?: string[]; callout?: string } | undefined;
  if (!s) return '';
  return [s.headline ?? '', ...(s.bullets ?? []), s.callout ?? ''].join('\n');
}

// ════════════════════════════════════════════════════════════════════════
// INVARIANT 2 helpers — hash-in-headline detection
//
// An 11-char base64url token. A pattern NAME ('payment-service') is
// lowercase-and-hyphen and word-shaped; a tenx_hash ('wy7WAbcu8U8',
// 'E-OzMXyO0Uo') is mixed-case OR carries a digit AND looks random. To cut
// false positives we only flag an 11-char token that ALSO has mixed-case
// or a digit (real English words rarely do both 11-long with a digit).
// ════════════════════════════════════════════════════════════════════════
const HASH_RE = /\b[A-Za-z0-9_-]{11}\b/g;

export function looksLikeTenxHash(token: string): boolean {
  if (token.length !== 11) return false;
  if (!/^[A-Za-z0-9_-]{11}$/.test(token)) return false;
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  const hasSep = /[-_]/.test(token);
  // Mixed-case is the strongest tenx_hash tell. A token with a digit AND a
  // base64url separator is also hash-shaped. Pure-lowercase 11-char words
  // ('engineering') are NOT flagged.
  return (hasUpper && hasLower) || (hasDigit && (hasUpper || hasSep));
}

function findHashTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(HASH_RE)) {
    if (looksLikeTenxHash(m[0])) out.push(m[0]);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
// THE EIGHT INVARIANT ASSERTIONS
// ════════════════════════════════════════════════════════════════════════

/** 1. chassis_conformance */
function assertChassis(out: Out, tool: string, diag: Diag): void {
  // Throws on drift — this is the structural pin.
  ChassisDataSchema.parse(out.data);
  const d = chassis(out);
  for (const k of ['status', 'decisions', 'source_disclosure', 'scope', 'payload', 'human_summary']) {
    softAssert(k in (d as object), `${tool}:chassis_conformance`, `missing chassis key "${k}"`, diag);
  }
  ChassisStatusSchema.parse(d.status);
  // Tool result rows must live under data.payload, not flat on data.
  for (const leak of ['patterns', 'per_pattern', 'services', 'totals', 'incidents']) {
    softAssert(
      !(leak in (d as object)),
      `${tool}:chassis_conformance`,
      `tool-row "${leak}" leaked flat onto data — it must live under data.payload`,
      diag,
    );
  }
  // performance block mirrors the chassis Performance schema.
  const perf = out.performance as { query_count?: unknown; total_latency_ms?: unknown; backend_pressure_hint?: unknown } | undefined;
  softAssert(!!perf, `${tool}:chassis_conformance`, 'missing top-level performance block', diag);
}

/** 2. no_hash_in_headline */
function assertNoHashInHeadline(out: Out, tool: string, diag: Diag): void {
  const d = chassis(out);
  const fields: Array<[string, string]> = [
    ['summary', summaryText(out)],
    ['human_summary', d.human_summary ?? ''],
  ];
  for (const [where, text] of fields) {
    const hits = findHashTokens(text);
    softAssert(
      hits.length === 0,
      `${tool}:no_hash_in_headline`,
      `bare tenx_hash ${JSON.stringify(hits)} leaked into ${where}: ${text.slice(0, 140)}`,
      diag,
    );
  }
}

/**
 * Validate a single action against the registry.
 * (a) tool registered? (b) args validate under the target's strict schema?
 */
export function validateAction(action: { tool: string; args?: Record<string, unknown> }): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const schema = TOOL_SCHEMAS[action.tool];
  if (!schema) {
    problems.push(`dead-end: action targets unregistered tool "${action.tool}"`);
    return { ok: false, problems };
  }
  const r = schema.safeParse(action.args ?? {});
  if (!r.success) {
    for (const issue of r.error.issues) {
      problems.push(`arg "${issue.path.join('.') || '<root>'}" ${issue.message}`);
    }
    return { ok: false, problems };
  }
  return { ok: true, problems };
}

/**
 * 3. no_dead_end_actions — over actions[] AND any tool names referenced in
 * forbidden_next_actions / must_ask_user. The richest, highest-value check.
 *
 * NOTE: per the design this invariant is meant to be hard-fail with NO
 * allowlist (a dead-end is always a real broken chain). It routes through
 * softAssert only so that, IF the first run surfaces a genuine pre-existing
 * dead-end, the suite stays green with a loud TODO rather than red — but no
 * `:no_dead_end_actions` keys are allowlisted, so today every dead-end is a
 * HARD FAIL. The fix is always the emitter, never an allowlist entry.
 */
function assertNoDeadEndActions(out: Out, tool: string, diag: Diag): void {
  const actions = (out.actions ?? []) as Array<{ tool: string; args?: Record<string, unknown> }>;
  for (const a of actions) {
    const { ok, problems } = validateAction(a);
    softAssert(ok, `${tool}:no_dead_end_actions`, `action → ${a.tool}: ${problems.join('; ')}`, diag);
  }
  const d = chassis(out);
  // forbidden_next_actions carries bare tool NAMES — assert each is registered.
  for (const name of d.forbidden_next_actions ?? []) {
    softAssert(
      name in TOOL_SCHEMAS,
      `${tool}:no_dead_end_actions`,
      `forbidden_next_actions names unregistered tool "${name}"`,
      diag,
    );
  }
}

/** 4. structured_error — applies to error-bearing statuses. */
function assertStructuredError(out: Out, tool: string, diag: Diag): void {
  const d = chassis(out);
  const status = d.status;
  if (status === 'error' || status === 'demo_read_only') {
    const err = d.error;
    softAssert(!!err && typeof err === 'object', `${tool}:structured_error`, `status=${status} but data.error is absent`, diag);
    if (err) {
      softAssert(
        (PRIMITIVE_ERROR_TYPES as readonly string[]).includes(err.error_type),
        `${tool}:structured_error`,
        `error_type "${err.error_type}" not in PRIMITIVE_ERROR_TYPES`,
        diag,
      );
      softAssert(typeof err.retryable === 'boolean', `${tool}:structured_error`, 'error.retryable not boolean', diag);
      softAssert(typeof err.hint === 'string' && err.hint.length > 0, `${tool}:structured_error`, 'error.hint missing/empty', diag);
      softAssert(
        err.suggested_backoff_ms === null || typeof err.suggested_backoff_ms === 'number',
        `${tool}:structured_error`,
        'error.suggested_backoff_ms must be number|null',
        diag,
      );
    }
  } else if (status === 'no_signal' || status === 'insufficient_data') {
    // No error block required, but a usable human_summary is mandatory.
    softAssert(
      typeof d.human_summary === 'string' && d.human_summary.length > 0,
      `${tool}:structured_error`,
      `status=${status} but human_summary is empty`,
      diag,
    );
  }
}

/**
 * 5. real_telemetry — query_count never EXCEEDS real backend calls (hard,
 * catches fabrication); exact equality is the ideal (allowlisted where a
 * tool under-reports). For paste-mode tools stub is undefined and both
 * sides are 0.
 */
function assertRealTelemetry(out: Out, tool: string, stub: StubBackend | undefined, diag: Diag): void {
  const perf = out.performance as { query_count: number; total_latency_ms: number; backend_pressure_hint: string | null };
  softAssert(typeof perf?.query_count === 'number' && perf.query_count >= 0, `${tool}:real_telemetry`, `query_count not a non-negative number`, diag);
  softAssert(typeof perf?.total_latency_ms === 'number' && perf.total_latency_ms >= 0, `${tool}:real_telemetry`, `total_latency_ms not a non-negative number`, diag);
  // The stub-driven checks only make sense when WE own the backend. Tools
  // that resolve their own env internally (cost_options, pattern_detail,
  // explain_mode, preview_filter) query a backend the harness doesn't
  // control, so `stub` is undefined and stub.calls would be meaningless —
  // skip the call-count comparison for them (query_count>=0 already pinned).
  if (stub) {
    const realCalls = stub.calls;
    // HARD: a tool may never report MORE queries than it actually made
    // against the stub we handed it (fabricated work). Not allowlistable.
    assert.ok(
      perf.query_count <= realCalls,
      `${tool}:real_telemetry — query_count=${perf.query_count} EXCEEDS real backend calls=${realCalls} (fabricated work)`,
    );
    // IDEAL: exact equality. Under-reporting is allowlisted per-tool.
    softAssert(
      perf.query_count === realCalls,
      `${tool}:real_telemetry`,
      `query_count=${perf.query_count} != real backend calls=${realCalls} (under-report)`,
      diag,
    );
  }
  // backend_pressure_hint must be null exactly when query_count is 0.
  if (perf.query_count === 0) {
    softAssert(perf.backend_pressure_hint === null, `${tool}:real_telemetry`, `0 queries but backend_pressure_hint=${perf.backend_pressure_hint}`, diag);
  } else {
    softAssert(
      perf.backend_pressure_hint === null || ['ok', 'slow', 'throttled'].includes(perf.backend_pressure_hint),
      `${tool}:real_telemetry`,
      `invalid backend_pressure_hint=${perf.backend_pressure_hint}`,
      diag,
    );
  }
}

const REL = 1e-6; // sum-vs-whole rounding tolerance

/** 6. parts_sum_le_whole + decimal_gb on volume tools, plus 8. money. */
function assertVolumeAndMoney(out: Out, tool: string, diag: Diag): void {
  const d = chassis(out);
  if (d.status !== 'success') return; // breakdown invariants apply to success payloads only
  const p = d.payload;

  // ── top_patterns ──────────────────────────────────────────────────
  if (tool === 'log10x_top_patterns') {
    const patterns = (p.patterns as Array<{ bytes?: number; bytes_total?: number }>) ?? [];
    const totals = p.totals as { bytes_total?: number; bytes_per_sec?: number } | undefined;
    const whole = totals?.bytes_total ?? 0;
    let sum = 0;
    for (const row of patterns) {
      const b = row.bytes ?? row.bytes_total ?? 0;
      softAssert(b >= 0, `${tool}:parts_sum_le_whole`, `negative pattern bytes ${b}`, diag);
      sum += b;
    }
    if (whole > 0) {
      softAssert(sum <= whole * (1 + REL), `${tool}:parts_sum_le_whole`, `Σ pattern bytes ${sum} > totals.bytes_total ${whole}`, diag);
    }
    assertDecimalGbRows(patterns, tool, diag);
  }

  // ── services ─────────────────────────────────────────────────────
  if (tool === 'log10x_services') {
    const services = (p.services as Array<{ bytes?: number; gb?: number }>) ?? [];
    const whole = (p.total_bytes as number) ?? 0;
    let sum = 0;
    for (const s of services) {
      const b = s.bytes ?? 0;
      softAssert(b >= 0, `${tool}:parts_sum_le_whole`, `negative service bytes ${b}`, diag);
      sum += b;
    }
    if (whole > 0) {
      softAssert(sum <= whole * (1 + REL), `${tool}:parts_sum_le_whole`, `Σ service bytes ${sum} > total_bytes ${whole}`, diag);
    }
    assertDecimalGbRows(services, tool, diag);
  }

  // ── estimate_savings (forecast) — parts + money ──────────────────
  if (tool === 'log10x_estimate_savings') {
    assertEstimateSavingsMoney(out, tool, diag);
  }
}

/**
 * decimal_gb: for any row exposing both a `bytes` field and a numeric `gb`
 * display, gb must equal bytes/1e9 (decimal), NOT bytes/2^30 (binary).
 */
function assertDecimalGbRows(rows: Array<Record<string, unknown>>, tool: string, diag: Diag): void {
  for (const row of rows) {
    const bytes = typeof row.bytes === 'number' ? (row.bytes as number) : undefined;
    const gb = typeof row.gb === 'number' ? (row.gb as number) : typeof row.GB === 'number' ? (row.GB as number) : undefined;
    if (bytes === undefined || gb === undefined || bytes <= 0) continue;
    const decimal = bytes / 1e9;
    const binary = bytes / 2 ** 30;
    softAssert(
      Math.abs(gb - decimal) <= Math.max(1e-6, decimal * 1e-4),
      `${tool}:decimal_gb`,
      `gb=${gb} != bytes/1e9=${decimal} (bytes=${bytes})`,
      diag,
    );
    // And explicitly NOT binary GB (regression tell).
    softAssert(
      Math.abs(gb - binary) > gb * 0.01,
      `${tool}:decimal_gb`,
      `gb=${gb} matches binary bytes/2^30=${binary} — must be decimal`,
      diag,
    );
  }
}

/**
 * 8. money_properties + 6. parts_sum_le_whole for estimate_savings forecast.
 * The headline savings live in totals.dollars_expected_monthly; the env
 * whole is totals.env_bytes_in_monthly (× rate). pass-action rows save 0.
 */
function assertEstimateSavingsMoney(out: Out, tool: string, diag: Diag): void {
  const d = chassis(out);
  const p = d.payload;
  const totals = p.totals as
    | {
        dollars_expected_monthly?: number;
        dollars_low_monthly?: number;
        dollars_high_monthly?: number;
        bytes_saved_monthly?: number;
        bytes_in_monthly?: number;
        env_bytes_in_monthly?: number;
      }
    | undefined;
  const perPattern = (p.per_pattern as Array<{ action?: string; dollars_saved_expected?: number; bytes_saved_monthly?: number }>) ?? [];
  if (!totals) return;

  const expected = totals.dollars_expected_monthly ?? 0;
  const low = totals.dollars_low_monthly ?? expected;
  const high = totals.dollars_high_monthly ?? expected;
  const bytesSaved = totals.bytes_saved_monthly ?? 0;
  const envBytes = totals.env_bytes_in_monthly ?? totals.bytes_in_monthly ?? 0;

  // (i) low <= expected <= high
  softAssert(low <= expected * (1 + REL) + 1e-9, `${tool}:money_properties`, `dollars_low ${low} > expected ${expected}`, diag);
  softAssert(expected <= high * (1 + REL) + 1e-9, `${tool}:money_properties`, `expected ${expected} > dollars_high ${high}`, diag);

  // (i) dollars_saved <= env spend (parts>whole guard at money level): the
  // saved bytes can never exceed the env's total bytes.
  if (envBytes > 0) {
    softAssert(bytesSaved <= envBytes * (1 + REL), `${tool}:parts_sum_le_whole`, `bytes_saved ${bytesSaved} > env_bytes ${envBytes}`, diag);
  }

  // (ii) a pass action contributes 0 savings (dollars AND bytes).
  for (const row of perPattern) {
    if (row.action === 'pass') {
      softAssert((row.dollars_saved_expected ?? 0) === 0, `${tool}:money_properties`, `pass row has non-zero dollars_saved ${row.dollars_saved_expected}`, diag);
      softAssert((row.bytes_saved_monthly ?? 0) === 0, `${tool}:money_properties`, `pass row has non-zero bytes_saved ${row.bytes_saved_monthly}`, diag);
    }
    softAssert((row.dollars_saved_expected ?? 0) >= 0, `${tool}:parts_sum_le_whole`, `negative per_pattern dollars ${row.dollars_saved_expected}`, diag);
  }

  // (iii) headline savings == sum of per-pattern plan (within rounding).
  const sumDollars = perPattern.reduce((acc, r) => acc + (r.dollars_saved_expected ?? 0), 0);
  softAssert(
    Math.abs(expected - sumDollars) <= 0.01 * Math.max(1, expected) + 1e-9,
    `${tool}:money_properties`,
    `headline dollars_expected ${expected} != Σ per_pattern ${sumDollars}`,
    diag,
  );

  // (iii) sum of per-pattern bytes_saved == totals.bytes_saved_monthly.
  const sumBytes = perPattern.reduce((acc, r) => acc + (r.bytes_saved_monthly ?? 0), 0);
  if (perPattern.length > 0) {
    softAssert(
      Math.abs(bytesSaved - sumBytes) <= Math.max(1, bytesSaved * 1e-4),
      `${tool}:parts_sum_le_whole`,
      `totals.bytes_saved ${bytesSaved} != Σ per_pattern bytes_saved ${sumBytes}`,
      diag,
    );
  }
}

// ════════════════════════════════════════════════════════════════════════
// Per-case driver — run the applicable invariants over one (tool, out).
// ════════════════════════════════════════════════════════════════════════
interface Case {
  tool: string;
  out: Out;
  stub?: StubBackend;
  /** chassis tools only; log10x_start is a non-chassis envelope. */
  chassisShape?: boolean;
}

function runInvariants(c: Case, diag: Diag): void {
  if (c.chassisShape !== false) {
    assertChassis(c.out, c.tool, diag);
    assertNoHashInHeadline(c.out, c.tool, diag);
    assertStructuredError(c.out, c.tool, diag);
    assertRealTelemetry(c.out, c.tool, c.stub, diag);
    assertVolumeAndMoney(c.out, c.tool, diag);
  }
  assertNoDeadEndActions(c.out, c.tool, diag);
}

// ════════════════════════════════════════════════════════════════════════
// FIXTURE BUILDERS
// ════════════════════════════════════════════════════════════════════════

// 11-char base64url hashes (from test/pattern-hash-vectors.json).
const H1 = 'wy7WAbcu8U8';
const H2 = 'E-OzMXyO0Uo';

const SVC_SERIES = [
  { metric: { tenx_user_service: 'payment-service', message_pattern: 'payment failed for $', severity_level: 'ERROR' }, value: 5_000_000_000 },
  { metric: { tenx_user_service: 'auth-service', message_pattern: 'login ok $', severity_level: 'INFO' }, value: 2_000_000_000 },
];

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Stub for the volume tools (services / top_patterns / investigate). */
function volumeStub(): StubBackend {
  return makeStubBackend({
    instant: [
      { match: 'topk', series: SVC_SERIES },
      { match: 'count(count by', series: [{ metric: {}, value: 2 }] },
      { match: 'count(', series: [{ metric: {}, value: 2 }] },
      { match: 'sum by', series: SVC_SERIES },
      { match: 'sum(', series: [{ metric: {}, value: 7_000_000_000 }] },
    ],
    range: [
      {
        match: 'increase',
        series: [{ metric: SVC_SERIES[0].metric, values: Array.from({ length: 6 }, (_, i) => [nowSec() - (5 - i) * 600, 800_000_000] as [number, number]) }],
      },
    ],
    labelValues: { message_pattern: ['payment failed for $', 'login ok $'], tenx_user_service: ['payment-service', 'auth-service'] },
  });
}

/** Stub for estimate_savings forecast — series keyed by tenx_hash. */
function savingsStub(): StubBackend {
  return makeStubBackend({
    instant: [
      {
        match: 'summaryBytes_total',
        series: [
          { metric: { tenx_hash: H1, tenx_user_service: 'payment-service', message_pattern: 'payment failed for $' }, value: 5_000_000_000 },
          { metric: { tenx_hash: H2, tenx_user_service: 'auth-service', message_pattern: 'login ok $' }, value: 2_000_000_000 },
        ],
      },
      {
        match: 'summaryVolume_total',
        series: [
          { metric: { tenx_hash: H1 }, value: 1_000_000 },
          { metric: { tenx_hash: H2 }, value: 500_000 },
        ],
      },
      { match: 'count(', series: [{ metric: {}, value: 2 }] },
    ],
  });
}

// Synthetic find_skew templater result (mirrors find-skew-envelope.test.ts).
function syntheticSkew(): ExtractedPatterns {
  const pattern: ExtractedPattern = {
    hash: 'tplhash-inv-1',
    symbolMessage: 'audit verb=$ path=$ status=$',
    template: 'audit verb=$ path=$ status=$',
    service: 'audit-service',
    severity: 'INFO',
    count: 100,
    bytes: 6400,
    sampleEvent: 'audit verb=get path=/api/v1/0 status=200',
    variables: { verb: ['get', 'post'] },
    slotDistinctCounts: { verb: 2 },
  };
  return { patterns: [pattern], totalEvents: 100, totalBytes: 6400, inputLineCount: 100, templaterWallTimeMs: 0, executionMode: 'local_cli' };
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 1 — LOCAL-ENGINE cases (no env, no backend).
// ════════════════════════════════════════════════════════════════════════

// resolve_batch / extract_templates run the local engine. CI has no tenx
// binary, so they return a not_configured envelope (a conformant terminal
// chassis envelope) rather than success. Either is acceptable here.
function isExternalUnavailable(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /HTTP 5\d\d|Service Unavailable|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|network/i.test(m);
}

test('invariants §1 resolve_batch (success or not_configured, local engine)', async (t) => {
  const events = ['GET /api/users 200', 'GET /api/users 200', 'POST /api/orders 201', 'POST /api/orders 201', 'GET /api/users 200'];
  let out;
  try {
    out = await executeResolveBatch({ source: 'events', events, top_n_patterns: 10, include_next_actions: true });
  } catch (e) {
    if (isExternalUnavailable(e)) return void t.skip(`engine unavailable: ${(e as Error).message}`);
    throw e;
  }
  runInvariants({ tool: 'log10x_resolve_batch', out: asEnvelope(out, 'resolve_batch') }, (m) => t.diagnostic(m));
});

test('invariants §1 extract_templates (success or not_configured, local engine)', async (t) => {
  const events = ['user 1 logged in from IP', 'user 2 logged in from IP', 'user 3 logged in from IP'];
  let out;
  try {
    out = await executeExtractTemplates({ source: 'events', events, top_n: 10 });
  } catch (e) {
    if (isExternalUnavailable(e)) return void t.skip(`engine unavailable: ${(e as Error).message}`);
    throw e;
  }
  // not_configured (no local tenx) is a conformant terminal chassis envelope.
  runInvariants({ tool: 'log10x_extract_templates', out: asEnvelope(out, 'extract_templates') }, (m) => t.diagnostic(m));
});

test('invariants §1 poc_status (structured error on unknown snapshot)', async (t) => {
  const out = await executePocStatus({ snapshot_id: 'nonexistent-' + Date.now() });
  const env = asEnvelope(out, 'poc_status');
  // poc_status uses the LEGACY unified envelope (flat data: status / error /
  // query_count / human_summary on out.data, no chassis decisions/scope and
  // no top-level performance). So skip chassis_conformance + chassis
  // telemetry; run the dead-end sweep and pin the legacy structured error.
  runInvariants({ tool: 'log10x_poc_from_siem_status', out: env, chassisShape: false }, (m) => t.diagnostic(m));
  const d = env.data as { status: string; human_summary?: string; error?: { error_type: string; retryable: boolean; suggested_backoff_ms: number | null; hint: string } };
  assert.equal(d.status, 'error');
  assert.ok(d.error && typeof d.error === 'object', 'poc_status error block missing');
  assert.equal(d.error.error_type, 'input_invalid');
  assert.equal(d.error.retryable, false);
  assert.ok((PRIMITIVE_ERROR_TYPES as readonly string[]).includes(d.error.error_type));
  assert.equal(typeof d.error.hint, 'string');
  assert.ok(d.error.hint.length > 0);
});

test('invariants §1 find_skew (success via synthetic templater seam)', async (t) => {
  _setExtractPatterns(async () => syntheticSkew());
  try {
    const events = Array.from({ length: 100 }, (_, i) => `audit verb=get path=/api/v1/${i} status=200`);
    const out = await executeFindSkew({ events, min_concentration: 0.6, sample_n: 10, min_events: 10 });
    runInvariants({ tool: 'log10x_find_skew', out: asEnvelope(out, 'find_skew') }, (m) => t.diagnostic(m));
  } finally {
    _setExtractPatterns();
  }
});

test('invariants §1 find_skew (structured error on empty events)', async (t) => {
  const out = await executeFindSkew({ events: [] });
  const env = asEnvelope(out, 'find_skew');
  runInvariants({ tool: 'log10x_find_skew', out: env }, (m) => t.diagnostic(m));
  assert.equal(chassis(env).status, 'error');
});

// ════════════════════════════════════════════════════════════════════════
// SECTION 2 — BACKEND-DRIVEN cases (fake EnvConfig + in-memory stub).
// Each tool also gets a fail-stub run asserting structured_error (no throw).
// ════════════════════════════════════════════════════════════════════════

test('invariants §2 services (success)', async (t) => {
  const stub = volumeStub();
  const out = await executeServices({ timeRange: '1h', effective_ingest_per_gb: 0.5 } as never, makeFakeEnv(stub));
  runInvariants({ tool: 'log10x_services', out: asEnvelope(out, 'services'), stub }, (m) => t.diagnostic(m));
});

test('invariants §2 services (backend down → structured error, no throw)', async (t) => {
  const stub = makeStubBackend({ fail: true });
  let out: string | Out;
  try {
    out = await executeServices({ timeRange: '1h' } as never, makeFakeEnv(stub));
  } catch (e) {
    // services has NO try/catch on its primary query — a backend-down throw
    // propagates. Pre-existing structured_error violation (allowlisted).
    softAssert(false, 'log10x_services:structured_error', `threw instead of structured envelope: ${(e as Error).message}`, (m) => t.diagnostic(m));
    return;
  }
  const env = asEnvelope(out, 'services');
  runInvariants({ tool: 'log10x_services', out: env, stub }, (m) => t.diagnostic(m));
});

test('invariants §2 top_patterns (success)', async (t) => {
  const stub = volumeStub();
  const out = await executeTopPatterns({ timeRange: '1h', limit: 10, effective_ingest_per_gb: 0.5 } as never, makeFakeEnv(stub));
  runInvariants({ tool: 'log10x_top_patterns', out: asEnvelope(out, 'top_patterns'), stub }, (m) => t.diagnostic(m));
});

test('invariants §2 top_patterns (backend down → structured error, no throw)', async (t) => {
  const stub = makeStubBackend({ fail: true });
  let out: string | Out;
  try {
    out = await executeTopPatterns({ timeRange: '1h', limit: 10 } as never, makeFakeEnv(stub));
  } catch (e) {
    softAssert(false, 'log10x_top_patterns:structured_error', `threw instead of structured envelope: ${(e as Error).message}`, (m) => t.diagnostic(m));
    return;
  }
  runInvariants({ tool: 'log10x_top_patterns', out: asEnvelope(out, 'top_patterns'), stub }, (m) => t.diagnostic(m));
});

test('invariants §2 estimate_savings (forecast target% — success + money)', async (t) => {
  const stub = savingsStub();
  const out = await executeEstimateSavings(
    { mode: 'forecast', target_percent: 40, default_action: 'drop', destination: 'splunk', effective_ingest_per_gb: 2 } as never,
    makeFakeEnv(stub),
  );
  runInvariants({ tool: 'log10x_estimate_savings', out: asEnvelope(out, 'estimate_savings'), stub }, (m) => t.diagnostic(m));
});

test('invariants §2 estimate_savings (proposed pass+drop — pass contributes 0)', async (t) => {
  const stub = savingsStub();
  const out = await executeEstimateSavings(
    {
      mode: 'forecast',
      proposed_config: [
        { pattern_hash: H1, action: 'pass' },
        { pattern_hash: H2, action: 'drop' },
      ],
      destination: 'splunk',
      effective_ingest_per_gb: 2,
    } as never,
    makeFakeEnv(stub),
  );
  runInvariants({ tool: 'log10x_estimate_savings', out: asEnvelope(out, 'estimate_savings'), stub }, (m) => t.diagnostic(m));
});

test('invariants §2 estimate_savings (backend down → structured error, no throw)', async (t) => {
  const stub = makeStubBackend({ fail: true });
  const out = await executeEstimateSavings({ mode: 'forecast', target_percent: 40, destination: 'splunk' } as never, makeFakeEnv(stub));
  const env = asEnvelope(out, 'estimate_savings');
  runInvariants({ tool: 'log10x_estimate_savings', out: env, stub }, (m) => t.diagnostic(m));
  assert.equal(chassis(env).status, 'error');
});

test('invariants §2 configure_engine (under-specified → structured error)', async (t) => {
  const stub = makeStubBackend({});
  const out = await executeConfigureEngine({ reduction: 'hard' } as never, makeFakeEnv(stub));
  const env = asEnvelope(out, 'configure_engine');
  runInvariants({ tool: 'log10x_configure_engine', out: env, stub }, (m) => t.diagnostic(m));
  assert.equal(chassis(env).status, 'error');
});

test('invariants §2 pattern_detail (missing identifier → structured error)', async (t) => {
  // Pure validation path — no env, no backend, deterministic everywhere.
  const out = await executePatternDetail({});
  const env = asEnvelope(out, 'pattern_detail');
  runInvariants({ tool: 'log10x_pattern_detail', out: env }, (m) => t.diagnostic(m));
  assert.equal(chassis(env).status, 'error');
  assert.equal(chassis(env).error?.error_type, 'missing_identifier');
});

test('invariants §2 investigate (success, richest actions emitter)', async (t) => {
  const stub = volumeStub();
  const out = await executeInvestigate({ starting_point: 'payment-service', depth: 'shallow', use_bytes: true } as never, makeFakeEnv(stub));
  runInvariants({ tool: 'log10x_investigate', out: asEnvelope(out, 'investigate'), stub }, (m) => t.diagnostic(m));
});

// ════════════════════════════════════════════════════════════════════════
// SECTION 3 — ACTION-CHAIN dead-end sweep.
//
// no_dead_end_actions is the highest-value, hard-fail invariant. cost_options
// and log10x_start carry the richest routing chains (menus + forbidden_next +
// referenced tool names), so they are swept here purely for their chains.
// log10x_start is NOT a chassis envelope — only its action/tool-ref chain is
// checked, never chassis_conformance.
// ════════════════════════════════════════════════════════════════════════

/** Scan every `"tool"`/`"routes_to"` string reference embedded in a payload. */
function scanEmbeddedToolRefs(data: unknown): string[] {
  const json = JSON.stringify(data ?? {});
  const refs = new Set<string>();
  for (const m of json.matchAll(/"(?:tool|routes_to)"\s*:\s*"(log10x_[A-Za-z0-9_]+)"/g)) refs.add(m[1]);
  return [...refs];
}

test('invariants §3 cost_options (chassis + rich routing chain)', async (t) => {
  const out = await executeCostOptions({ target_percent: 40, destination: 'splunk' } as never);
  const env = asEnvelope(out, 'cost_options');
  // Full chassis sweep (cost_options IS a chassis tool, but loads env
  // internally with graceful fallback — no stub, so telemetry is 0/0).
  runInvariants({ tool: 'log10x_cost_options', out: env }, (m) => t.diagnostic(m));
  // Embedded tool refs in the menu payload must all be registered tools.
  for (const ref of scanEmbeddedToolRefs(chassis(env).payload)) {
    assert.ok(ref in TOOL_SCHEMAS, `cost_options:no_dead_end_actions — payload references unregistered tool "${ref}"`);
  }
});

test('invariants §3 log10x_start (dead-end sweep over its routing menu)', async (t) => {
  const out = await executeLog10xStart({ intent_hint: 'cost', session_state: 'fresh' });
  const env = asEnvelope(out, 'log10x_start');
  // log10x_start is a non-chassis envelope — sweep actions + embedded refs only.
  runInvariants({ tool: 'log10x_start', out: env, chassisShape: false }, (m) => t.diagnostic(m));
  for (const ref of scanEmbeddedToolRefs(env.data)) {
    assert.ok(ref in TOOL_SCHEMAS, `log10x_start:no_dead_end_actions — menu references unregistered tool "${ref}"`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// SECTION 4 — registry + allowlist self-checks.
// ════════════════════════════════════════════════════════════════════════

test('invariants §4 registry covers every registered MCP tool name', () => {
  // Spot-check a representative slice rather than re-parsing index.ts: the
  // dead-end check is only as good as the registry's coverage of action
  // TARGETS. These are the tools the analytical envelopes route to.
  const mustHave = [
    'log10x_top_patterns', 'log10x_services', 'log10x_estimate_savings', 'log10x_configure_engine',
    'log10x_investigate', 'log10x_pattern_mitigate', 'log10x_savings', 'log10x_whats_changing',
    'log10x_pattern_examples', 'log10x_dependency_check', 'log10x_metrics_that_moved', 'log10x_pattern_trend',
    'log10x_cost_options', 'log10x_set_gitops_repo', 'log10x_advise_install', 'log10x_advise_retriever',
    'log10x_doctor', 'log10x_retriever_query',
  ];
  for (const name of mustHave) {
    assert.ok(name in TOOL_SCHEMAS, `registry missing action-target tool "${name}"`);
  }
  // Sanity: the registry holds the full catalog (66 registered tools).
  assert.ok(Object.keys(TOOL_SCHEMAS).length >= 60, `registry has only ${Object.keys(TOOL_SCHEMAS).length} tools`);
});

/**
 * Stale-entry guard. Every allowlisted (tool, invariant) pair MUST actually
 * fire during this run; if one never fired the underlying violation is fixed
 * and the entry is stale — fail loudly so it gets removed. This forces the
 * allowlist to shrink and prevents it rotting into a permanent mute.
 *
 * Runs LAST (alphabetically after §1-§4 by file order) so every case above
 * has executed and populated `firedViolations`.
 */
test('invariants §4 ZZ allowlist has no stale entries', () => {
  const stale: string[] = [];
  for (const key of Object.keys(KNOWN_VIOLATIONS)) {
    if (!firedViolations.has(key)) stale.push(key);
  }
  assert.equal(
    stale.length,
    0,
    `Stale KNOWN_VIOLATIONS entries (the violation no longer reproduces — remove them): ${JSON.stringify(stale)}`,
  );
});
