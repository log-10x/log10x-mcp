/**
 * Markdown report writer.
 *
 * One report.md per run, plus a structured verdict.json next to it that
 * diff-runs.mjs consumes for regression gating. The markdown is the
 * human-readable summary; verdict.json is the machine-parseable truth.
 */
import { writeFileSync } from 'node:fs';
import type { RunReport } from './types.js';

export function writeRunReport(reportPath: string, jsonPath: string, r: RunReport): void {
  writeFileSync(jsonPath, JSON.stringify(r, null, 2));
  writeFileSync(reportPath, renderMarkdown(r));
}

function renderMarkdown(r: RunReport): string {
  const passEmoji = (p: boolean) => (p ? 'PASS' : 'FAIL');
  const score01 = (n: number) => n.toFixed(2);

  return [
    `# ${r.scenarioTitle}`,
    ``,
    `**Scenario:** \`${r.scenarioId}\``,
    `**Mode:** ${r.mode}`,
    `**Outcome:** ${r.outcome}`,
    `**Steps:** ${r.totalSteps}`,
    `**Duration:** ${(r.durationMs / 1000).toFixed(2)}s`,
    `**Started:** ${r.startedAt}`,
    `**Passed criteria:** ${passEmoji(r.passedCriteria)}`,
    ``,
    `## Scores`,
    ``,
    '| Dimension | 0..1 | Raw |',
    '|-----------|------|-----|',
    `| Reasoning | ${score01(r.scores.reasoning)} | tool_selection=${r.scores.tool_selection} params=${r.scores.parameters} seq=${r.scores.sequencing} |`,
    `| Value | ${score01(r.scores.value)} | accuracy=${r.scores.accuracy} follow_through=${r.scores.follow_through} |`,
    `| Autonomy | ${score01(r.scores.autonomy)} | — |`,
    `| Hallucination | ${score01(r.scores.hallucination)} | (lower = better) |`,
    ``,
    `## Sequence diff`,
    ``,
    '```',
    `expected: ${r.sequenceDiff.expected.join(' -> ') || '(none)'}`,
    `actual:   ${r.sequenceDiff.actual.join(' -> ') || '(none)'}`,
    `missing:  ${r.sequenceDiff.missing.join(', ') || 'none'}`,
    `extra:    ${r.sequenceDiff.extra.join(', ') || 'none'}`,
    `must_not violations: ${r.sequenceDiff.mustNotIncludeViolations.join(', ') || 'none'}`,
    `subsequence satisfied: ${r.sequenceDiff.satisfied}`,
    '```',
    ``,
    `## Ground truth (${r.groundTruth.filter((g) => g.passed).length}/${r.groundTruth.length} passed)`,
    ``,
    ...r.groundTruth.map(
      (g) => `- [${g.passed ? 'PASS' : 'FAIL'}] **${g.description}** — ${g.detail}`
    ),
    ``,
    `## Autonomy metrics`,
    ``,
    `- Tool calls: ${r.autonomyMetrics.toolCallCount} (optimal: ${r.autonomyMetrics.optimalSteps})`,
    `- Stalled (final-text marker): ${r.autonomyMetrics.stalled}`,
    `- Abandoned NEXT_ACTIONS hints: ${r.autonomyMetrics.abandonedNextActions}`,
    `- Score: ${score01(r.autonomyMetrics.score)}`,
    ``,
    `## Judge verdict`,
    ``,
    r.judgeVerdict ? renderJudge(r) : '_(judge not run)_',
    ``,
    `## Flags`,
    ``,
    r.flags.length > 0 ? r.flags.map((f) => `- ${f}`).join('\n') : '_(none)_',
    ``,
    `## Artifacts`,
    ``,
    `- transcript: \`${r.transcriptPath}\``,
    `- step log: \`${r.stepLogPath}\``,
    ``,
  ].join('\n');
}

function renderJudge(r: RunReport): string {
  const j = r.judgeVerdict!;
  return [
    `**Model:** ${j.model}`,
    ``,
    '| Sub-score | Raw | Rationale |',
    '|-----------|-----|-----------|',
    ...(['tool_selection', 'parameters', 'sequencing', 'accuracy', 'hallucination', 'follow_through'] as const).map(
      (k) => `| ${k} | ${j.scoresRaw[k]} | ${j.rationale[k] ?? ''} |`
    ),
    ``,
    j.flags.length > 0 ? `**Judge flags:** ${j.flags.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
