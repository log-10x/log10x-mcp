/**
 * Shared StructuredOutput builder for the advise_{reporter,receiver,retriever}
 * tools. They all produce an `AdvisePlan` (see ./types.ts) and render it the
 * same way, so the envelope shape is the same too.
 */

import type { AdvisePlan, AdviseAction } from './types.js';
import { renderPlan } from './render.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../output-types.js';

interface AdvisePlanSummary {
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
  verify_probe_count: number;
  teardown_step_count: number;
  blockers: string[];
  notes: string[];
  has_gitops_section: boolean;
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
