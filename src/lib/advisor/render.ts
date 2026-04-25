/**
 * Markdown rendering for an AdvisePlan. Produces a single document the
 * agent can hand the user verbatim — or a subagent can follow
 * step-by-step.
 *
 * Keep this file dumb: it only transforms the structured plan into
 * human-readable text. Decisions (what to include, which forwarder to
 * target) live in the per-app advisor files.
 */

import type { AdvisePlan, GitopsExplainer } from './types.js';

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

  // ── GitOps explainer ──
  // Renders between Install and Verify so the user sees it after the
  // pod is up but before they exercise it. Only emitted for plans
  // whose app supports MCP-managed runtime config updates (today:
  // reducer + compactReducer).
  if ((action === 'install' || action === 'all') && plan.gitopsExplainer) {
    renderGitopsExplainer(lines, plan.gitopsExplainer);
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

function renderGitopsExplainer(lines: string[], g: GitopsExplainer): void {
  lines.push('## GitOps — MCP-managed runtime config (optional)');
  lines.push('');
  lines.push(g.headline);
  lines.push('');

  if (g.whenToEnable.length > 0) {
    lines.push('**Enable this if:**');
    for (const w of g.whenToEnable) lines.push(`- ${w}`);
    lines.push('');
  }
  if (g.whenToSkip.length > 0) {
    lines.push('**Skip this if:**');
    for (const w of g.whenToSkip) lines.push(`- ${w}`);
    lines.push('');
  }

  lines.push('### Repo layout');
  lines.push('');
  lines.push('Mirror this in your GitOps config repo (the engine pulls it on each poll):');
  lines.push('');
  lines.push('```');
  for (const r of g.repoLayout) {
    const padding = ' '.repeat(Math.max(1, 44 - r.path.length));
    lines.push(`${r.path}${padding}# ${r.comment}`);
  }
  lines.push('```');
  lines.push('');

  lines.push('### Pod env vars');
  lines.push('');
  lines.push('Set these on the reducer pod (helm `--set env.<NAME>=<value>` or the chart\'s env block):');
  lines.push('');
  lines.push('| Env | Required | Default | Note |');
  lines.push('|---|---|---|---|');
  for (const e of g.envVars) {
    lines.push(
      `| \`${e.name}\` | ${e.required ? '**yes**' : 'optional'} | \`${e.value}\` | ${e.note ? e.note.replace(/\|/g, '\\|') : '—'} |`
    );
  }
  lines.push('');

  lines.push('### Once wired, author entries via the MCP');
  lines.push('');
  lines.push(`Run \`${g.mcpHandoff.tool}\` to compose the per-pattern compact decisions and emit a literal \`gh\` PR command. Example:`);
  lines.push('');
  lines.push('```');
  lines.push(g.mcpHandoff.example);
  lines.push('```');
  lines.push('');

  if (g.caveats.length > 0) {
    lines.push('### Caveats');
    for (const c of g.caveats) lines.push(`- ${c}`);
    lines.push('');
  }
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
