/**
 * Shared StructuredOutput builder for the advise tools. `advise_install`
 * (the wizard for Reporter / Receiver) and `advise_retriever` both
 * produce an `AdvisePlan` (see ./types.ts) and render it the same way,
 * so the envelope shape is the same too.
 */

import type { AdvisePlan, AdviseAction, VerifyProbe } from './types.js';
import { renderPlan } from './render.js';
import { buildEnvelope, type StructuredOutput } from '../output-types.js';

/**
 * Typed summary of an AdvisePlan. Exported so both `advise_install` and
 * `advise_retriever` mirror the same shape — any agent that handles one
 * advisor's plan output handles the other through the same code path.
 */
/**
 * What kind of license JWT the plan ships with. Surfaced as a typed
 * field so agents don't have to grep `notes[]` to know whether the
 * install will run with a demo or a real user-scoped license — the
 * difference is structurally meaningful (demo can't run airgapped,
 * expires in 14 days, has rate limits).
 *
 *   - 'user-scoped' — minted from /api/v1/license with Auth0 tokens.
 *     Production-grade. Can run airgapped. No expiry from us.
 *   - 'demo'        — anonymous /api/v1/license/demo. 14-day, no
 *     airgapped, reduced limits.
 *   - 'user-pasted' — the user supplied the JWT via license_jwt_paste;
 *     we don't introspect it.
 *   - 'placeholder' — no real JWT (skipInstall=true, or license fetch
 *     failed and the plan was emitted with REPLACE_WITH_LICENSE_JWT).
 */
export type PlanLicenseKind = 'user-scoped' | 'demo' | 'user-pasted' | 'placeholder';

export interface AdvisePlanSummary {
  ok: boolean;
  app: 'reporter' | 'receiver' | 'retriever';
  snapshot_id: string;
  release_name: string;
  namespace: string;
  forwarder?: string;
  action: AdviseAction;
  preflight: { name: string; status: 'ok' | 'warn' | 'fail' | 'unknown'; detail: string }[];
  preflight_summary: { ok: number; warn: number; fail: number; unknown: number };
  install_step_count: number;
  /**
   * Total number of files the install steps emit (sum of each step's
   * `file` count + `files[]` length). A single overlay can require
   * multiple files — the Fluentd Receiver path emits five (values.yaml
   * + tenx-kustomize/{kustomization, sidecar-patch, post-render.sh,
   * post-render.cmd}). Agents use this to know "the install plan is
   * not a one-file paste".
   */
  install_file_count: number;
  /**
   * When the install plan emits ANY file the user must `chmod +x` (e.g.
   * the kustomize post-render shell shim), `true` so the agent surfaces
   * the chmod ritual to the user even if they only skim the markdown.
   */
  install_requires_chmod: boolean;
  /**
   * License JWT kind baked into the plan. Optional only for
   * back-compat with summaries built before this field existed; new
   * emitters always populate it. Use this instead of grepping `notes`
   * for the substring "demo license".
   */
  license_kind?: PlanLicenseKind;
  /**
   * How the helm command lands. See AdvisePlan.installMode for the
   * full description. Surfaced on the summary so agents can route on
   * it directly.
   *   - 'upgrade-existing' — sidecar goes INTO the user's existing
   *     forwarder release. The wizard does NOT deploy a second one.
   *   - 'fresh-release'   — new release name + namespace.
   * Optional for back-compat with summaries built before the field
   * existed.
   */
  install_mode?: 'upgrade-existing' | 'fresh-release';
  /**
   * When install_mode === 'upgrade-existing', the detected existing
   * release the plan upgrades in-place. Lets agents say "this
   * upgrades release X" without comparing fields.
   */
  existing_helm_release?: { name: string; namespace: string };
  verify_probe_count: number;
  /**
   * Fix 93 — structured verify probe list.
   *
   * Each entry mirrors the `VerifyProbe` shape from types.ts. Exposed
   * as a typed array so agents can iterate probes and execute them
   * autonomously without parsing the markdown blob. `verify_probe_count`
   * is kept for back-compat (equals `verify_probes.length`).
   *
   * Only populated when at least one verify probe was built (i.e. the
   * plan action is `verify` or `all`). Empty array otherwise.
   */
  verify_probes: Pick<VerifyProbe, 'name' | 'question' | 'commands' | 'expectOutput' | 'timeoutSec'>[];
  teardown_step_count: number;
  blockers: string[];
  notes: string[];
  has_gitops_section: boolean;
  human_summary: string;
}

/** Build the typed plan summary. Exported for the install wizard's plan-mode. */
export function buildPlanSummary(plan: AdvisePlan, action: AdviseAction): AdvisePlanSummary {
  return summarize(plan, action);
}

/** Plan-mode headline (sentence the agent can quote cold). Exported. */
export function buildPlanHeadline(plan: AdvisePlan, action: AdviseAction): string {
  return planHeadline(plan, action);
}

export function buildAdvisePlanEnvelope(args: {
  tool: string;
  plan: AdvisePlan;
  action: AdviseAction;
  destinationNote?: string;
}): StructuredOutput {
  const data = summarize(args.plan, args.action);
  return buildEnvelope({
    tool: args.tool,
    view: 'summary',
    summary: { headline: planHeadline(args.plan, args.action) },
    data,
    warnings: args.plan.blockers.length > 0 ? [`plan has ${args.plan.blockers.length} blocker${args.plan.blockers.length !== 1 ? 's' : ''} — see data.blockers`] : [],
  });
}

function summarize(plan: AdvisePlan, action: AdviseAction): AdvisePlanSummary {
  const ok = plan.preflight.filter((p) => p.status === 'ok').length;
  const warn = plan.preflight.filter((p) => p.status === 'warn').length;
  const fail = plan.preflight.filter((p) => p.status === 'fail').length;
  const unknown = plan.preflight.filter((p) => p.status === 'unknown').length;
  // Each step's file count: 0 (no file), 1 (`file`), or N (`files[]`).
  // `files[]` wins over `file` when both present (matches render.ts).
  let install_file_count = 0;
  let install_requires_chmod = false;
  for (const s of plan.install) {
    const stepFiles = s.files ?? (s.file ? [s.file] : []);
    install_file_count += stepFiles.length;
    if (stepFiles.some((f) => f.executable)) install_requires_chmod = true;
  }
  return {
    ok: plan.blockers.length === 0,
    app: plan.app,
    snapshot_id: plan.snapshotId,
    release_name: plan.releaseName,
    namespace: plan.namespace,
    forwarder: plan.forwarder,
    action,
    preflight: plan.preflight.map((p) => ({ name: p.name, status: p.status, detail: p.detail })),
    preflight_summary: { ok, warn, fail, unknown },
    install_step_count: plan.install.length,
    install_file_count,
    install_requires_chmod,
    license_kind: plan.licenseKind,
    install_mode: plan.installMode,
    existing_helm_release: plan.existingHelmRelease,
    verify_probe_count: plan.verify.length,
    verify_probes: plan.verify.map((p) => ({
      name: p.name,
      question: p.question,
      commands: p.commands,
      ...(p.expectOutput !== undefined ? { expectOutput: p.expectOutput } : {}),
      ...(p.timeoutSec !== undefined ? { timeoutSec: p.timeoutSec } : {}),
    })),
    teardown_step_count: plan.teardown.length,
    blockers: plan.blockers,
    notes: plan.notes,
    has_gitops_section: !!plan.gitopsExplainer,
    human_summary: buildPlanHumanSummary(plan, action, { ok, warn, fail }, install_file_count),
  };
}

// Three sentences max, plain prose, no markdown syntax. What plan was
// produced, what shape (steps / files / preflight verdict), and whether
// it's blocked. No dollar figures — install plans are list-priced.
function buildPlanHumanSummary(
  plan: AdvisePlan,
  action: AdviseAction,
  pre: { ok: number; warn: number; fail: number },
  fileCount: number,
): string {
  const fwd = plan.forwarder ? ` on ${plan.forwarder}` : '';
  const stepCount = plan.install.length;
  const verifyCount = plan.verify.length;
  if (plan.blockers.length > 0) {
    return `Built a ${plan.app} ${action} plan${fwd} for release "${plan.releaseName}" in namespace "${plan.namespace}". The plan is blocked by ${plan.blockers.length} item${plan.blockers.length !== 1 ? 's' : ''}: ${plan.blockers.slice(0, 3).join('; ')}. Resolve the blockers and re-run before applying.`;
  }
  const preflight = `Preflight: ${pre.ok} ok, ${pre.warn} warn, ${pre.fail} fail.`;
  return `Built a ${plan.app} ${action} plan${fwd} for release "${plan.releaseName}" in namespace "${plan.namespace}". ${stepCount} install step${stepCount !== 1 ? 's' : ''} across ${fileCount} file${fileCount !== 1 ? 's' : ''}, ${verifyCount} verify probe${verifyCount !== 1 ? 's' : ''}, ${plan.teardown.length} teardown step${plan.teardown.length !== 1 ? 's' : ''}. ${preflight}`;
}

function planHeadline(plan: AdvisePlan, action: AdviseAction): string {
  const fwd = plan.forwarder ? ` on ${plan.forwarder}` : '';
  if (plan.blockers.length > 0) {
    return `${plan.app} ${action} plan${fwd}: blocked (${plan.blockers.length} item${plan.blockers.length !== 1 ? 's' : ''}).`;
  }
  return `${plan.app} ${action} plan${fwd}: ${plan.install.length} install step${plan.install.length !== 1 ? 's' : ''}, ${plan.verify.length} verify probe${plan.verify.length !== 1 ? 's' : ''}, ${plan.teardown.length} teardown step${plan.teardown.length !== 1 ? 's' : ''} — release "${plan.releaseName}" in namespace "${plan.namespace}".`;
}
