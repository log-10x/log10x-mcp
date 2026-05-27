/**
 * Shared StructuredOutput builder for the advise_{reporter,receiver,retriever}
 * tools. They all produce an `AdvisePlan` (see ./types.ts) and render it the
 * same way, so the envelope shape is the same too.
 */

import type { AdvisePlan, AdviseAction } from './types.js';
import { renderPlan } from './render.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../output-types.js';

/**
 * Typed summary of an AdvisePlan. Exported so the install wizard
 * (`advise_install`) can mirror this shape on its final `plan` mode —
 * any agent that consumes `advise_reporter` / `advise_receiver` /
 * `advise_retriever` then handles the wizard's plan output via the
 * same code path.
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
  verify_probe_count: number;
  teardown_step_count: number;
  blockers: string[];
  notes: string[];
  has_gitops_section: boolean;
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
  view: 'summary' | 'markdown';
  plan: AdvisePlan;
  action: AdviseAction;
  destinationNote?: string;
}): StructuredOutput {
  const md = renderPlan(args.plan, args.action);
  const finalMd = args.destinationNote ? `_${args.destinationNote}_\n\n${md}` : md;
  if (args.view === 'markdown') {
    return buildMarkdownEnvelope({
      tool: args.tool,
      summary: { headline: planHeadline(args.plan, args.action) },
      markdown: finalMd,
    });
  }
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
    verify_probe_count: plan.verify.length,
    teardown_step_count: plan.teardown.length,
    blockers: plan.blockers,
    notes: plan.notes,
    has_gitops_section: !!plan.gitopsExplainer,
  };
}

function planHeadline(plan: AdvisePlan, action: AdviseAction): string {
  const fwd = plan.forwarder ? ` on ${plan.forwarder}` : '';
  if (plan.blockers.length > 0) {
    return `${plan.app} ${action} plan${fwd}: blocked (${plan.blockers.length} item${plan.blockers.length !== 1 ? 's' : ''}).`;
  }
  return `${plan.app} ${action} plan${fwd}: ${plan.install.length} install step${plan.install.length !== 1 ? 's' : ''}, ${plan.verify.length} verify probe${plan.verify.length !== 1 ? 's' : ''}, ${plan.teardown.length} teardown step${plan.teardown.length !== 1 ? 's' : ''} — release "${plan.releaseName}" in namespace "${plan.namespace}".`;
}
