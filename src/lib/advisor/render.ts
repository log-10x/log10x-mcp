/**
 * Markdown rendering for an AdvisePlan. Produces a single document the
 * agent can hand the user verbatim — or a subagent can follow
 * step-by-step.
 *
 * Keep this file dumb: it only transforms the structured plan into
 * human-readable text. Decisions (what to include, which forwarder to
 * target) live in the per-app advisor files.
 */

import type { AdvisePlan } from './types.js';

export function renderPlan(plan: AdvisePlan, action: 'install' | 'verify' | 'teardown' | 'all'): string {
  const lines: string[] = [];

  const actionLabel =
    action === 'all'
      ? 'install + verify + teardown'
      : action === 'install'
      ? 'install'
      : action === 'verify'
      ? 'verify'
      : 'teardown';

  lines.push(`# ${titleCase(plan.app)} advisor — ${actionLabel}`);
  lines.push('');

  // ── Target ──
  lines.push('## Target');
  lines.push(`- **app**: ${plan.app}`);
  if (plan.forwarder) lines.push(`- **forwarder**: ${plan.forwarder}`);
  lines.push(`- **release**: \`${plan.releaseName}\``);
  lines.push(`- **namespace**: \`${plan.namespace}\``);
  if (plan.context) lines.push(`- **context**: \`${plan.context}\``);
  lines.push(`- **snapshot**: \`${plan.snapshotId}\``);
  lines.push('');

  if (plan.blockers.length > 0) {
    lines.push('## Blockers');
    lines.push('The advisor cannot produce a complete plan until these are resolved:');
    lines.push('');
    for (const b of plan.blockers) lines.push(`- ${b}`);
    lines.push('');
    lines.push('Once resolved, re-run the advise call with the updated arguments.');
    lines.push('');
    return lines.join('\n');
  }

  if (plan.notes.length > 0) {
    lines.push('## Notes');
    for (const n of plan.notes) lines.push(`- ${n}`);
    lines.push('');
  }

  // ── Preflight ──
  if (plan.preflight.length > 0) {
    lines.push('## Preflight');
    lines.push('| Check | Status | Detail |');
    lines.push('|---|---|---|');
    for (const p of plan.preflight) {
      const badge = p.status === 'ok' ? '`ok`' : p.status === 'warn' ? '**warn**' : p.status === 'fail' ? '**FAIL**' : '`?`';
      lines.push(`| ${p.name} | ${badge} | ${p.detail.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }

  // ── Install ──
  if ((action === 'install' || action === 'all') && plan.install.length > 0) {
    lines.push('## Install');
    renderSteps(lines, plan.install);
  }

  // ── Verify ──
  if ((action === 'verify' || action === 'all') && plan.verify.length > 0) {
    lines.push('## Verify');
    lines.push('Each probe below answers one specific question — run them in order. A probe passes when its commands exit 0 and (optionally) match the `expectOutput` regex.');
    lines.push('');
    for (let i = 0; i < plan.verify.length; i++) {
      const v = plan.verify[i];
      lines.push(`### ${i + 1}. ${v.name} — ${v.question}`);
      if (v.timeoutSec) lines.push(`_Expect to pass within ${v.timeoutSec}s._`);
      lines.push('');
      lines.push('```bash');
      for (const c of v.commands) lines.push(c);
      lines.push('```');
      if (v.expectOutput) {
        lines.push('');
        lines.push(`Expect output matching: \`${v.expectOutput}\``);
      }
      lines.push('');
    }
  }

  // ── Teardown ──
  if ((action === 'teardown' || action === 'all') && plan.teardown.length > 0) {
    lines.push('## Teardown');
    renderSteps(lines, plan.teardown);
  }

  // ── Footer ──
  lines.push('---');
  lines.push(`_Plan built from snapshot \`${plan.snapshotId}\`._`);

  return lines.join('\n');
}

function renderSteps(lines: string[], steps: AdvisePlan['install']): void {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    lines.push(`### ${i + 1}. ${s.title}`);
    lines.push(`_${s.rationale}_`);
    lines.push('');
    if (s.file) {
      lines.push(`Write \`${s.file.path}\`:`);
      lines.push('');
      lines.push('```' + s.file.language);
      lines.push(s.file.contents.trimEnd());
      lines.push('```');
      lines.push('');
    }
    if (s.commands.length > 0) {
      lines.push('```bash');
      for (const c of s.commands) lines.push(c);
      lines.push('```');
      lines.push('');
    }
  }
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
