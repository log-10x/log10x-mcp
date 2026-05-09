#!/usr/bin/env node
/**
 * Re-score an existing hero transcript without re-running the
 * sub-agent. Used when the oracle/judge path errored mid-run and the
 * transcript is intact. Reads transcript.json, runs oracle +
 * judge, writes verdict.json + SUMMARY.md alongside.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=demo \
 *     node eval/bin/revalidate-hero.mjs <path/to/transcript.json>
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEvalEnv } = await import(resolve(evalRoot, 'build-eval/env.js'));
const { validateClaims } = await import(resolve(evalRoot, 'build-eval/hero-oracle.js'));

const path = process.argv[2];
if (!path) {
  console.error('Usage: revalidate-hero.mjs <path/to/transcript.json>');
  process.exit(2);
}
const transcriptPath = resolve(path);
const dir = dirname(transcriptPath);
const t = JSON.parse(readFileSync(transcriptPath, 'utf8'));
const env = loadEvalEnv();
console.error(`[revalidate-hero] spec=${t.spec.id} env=${env.mode} dir=${dir}`);

// Oracle pass.
const hallucination = await validateClaims(t.finalText, env);
console.error(
  `[revalidate-hero] oracle: drift=${hallucination.driftScore} supported=${hallucination.supported} inconclusive=${hallucination.inconclusive}`
);

// Judge pass — directly call Sonnet with the same prompt the runner
// uses. We duplicate the logic here to keep the script self-contained.
const client = new Anthropic();
const previews = t.bashCommands
  .slice(0, 12)
  .map((c, i) => {
    const cmd = c.cmd.length > 200 ? c.cmd.slice(0, 200) + '...' : c.cmd;
    const out =
      c.stdout.length > 1500
        ? c.stdout.slice(0, 1500) + `... [${c.stdout.length - 1500} more bytes]`
        : c.stdout;
    return `## Bash call ${i + 1} (exit=${c.exitCode}, ${c.durationMs}ms)\n\n\`\`\`\n${cmd}\n\`\`\`\n\nstdout:\n\`\`\`\n${out}\n\`\`\``;
  })
  .join('\n\n');

const userMsg = [
  `# User question`,
  t.spec.prompt,
  ``,
  `# Sub-agent's tool calls`,
  previews,
  ``,
  `# Sub-agent's final synthesis`,
  t.finalText,
  ``,
  `# Your task`,
  `Score on TWO axes, each 0.0-1.0. Return JSON only.`,
  ``,
  `1. value_delivered: did the synthesis answer the user's actual`,
  `   question? Could an SRE act on it? 0.0 = irrelevant or punted;`,
  `   0.5 = partial; 1.0 = directly actionable answer to the asked`,
  `   question.`,
  `2. value_received: did the MCP give the sub-agent useful data,`,
  `   or did it return mostly stubs / errors / "not configured" /`,
  `   "no patterns resolved"? 0.0 = MCP returned nothing useful;`,
  `   0.5 = partial coverage with gaps; 1.0 = MCP returned the data`,
  `   the sub-agent needed.`,
  ``,
  `Output: {`,
  `  "value_delivered": {"score": 0.0-1.0, "rationale": "<one sentence>"},`,
  `  "value_received": {"score": 0.0-1.0, "rationale": "<one sentence>"}`,
  `}`,
  ``,
  `Output JSON ONLY. No markdown fence.`,
].join('\n');

const judgeResp = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 800,
  system:
    'You are an evaluator scoring an autonomous SRE assistant. Be strict, concise, and specific. Output JSON only.',
  messages: [{ role: 'user', content: userMsg }],
});
const judgeText = judgeResp.content.find((b) => b.type === 'text')?.text ?? '';
const cleaned = judgeText
  .trim()
  .replace(/^```(?:json)?\s*/i, '')
  .replace(/\s*```$/i, '');
let judge;
try {
  judge = JSON.parse(cleaned);
} catch (e) {
  console.error(`[revalidate-hero] judge JSON parse failed: ${e.message}`);
  judge = {
    value_delivered: { score: 0.5, rationale: 'judge JSON parse failed' },
    value_received: { score: 0.5, rationale: 'judge JSON parse failed' },
  };
}

const status =
  hallucination.driftScore <= 0 && judge.value_delivered.score >= 0.6
    ? 'pass'
    : hallucination.driftScore <= 1
      ? 'partial'
      : 'fail';

const flags = [];
if (hallucination.driftScore > 0) flags.push(`drift=${hallucination.driftScore}`);
if (judge.value_delivered.score < 0.5) flags.push('low_value_delivered');
if (judge.value_received.score < 0.5) flags.push('low_value_received');

const verdict = {
  spec: t.spec,
  startedAt: t.startedAt ?? '',
  endedAt: new Date().toISOString(),
  durationMs: 0,
  envMode: env.mode,
  bashCommands: t.bashCommands,
  finalSynthesis: t.finalText,
  hallucination,
  valueDelivered: judge.value_delivered,
  valueReceived: judge.value_received,
  status,
  flags,
};
writeFileSync(`${dir}/verdict.json`, JSON.stringify(verdict, null, 2));

const summary = renderSummary(verdict);
writeFileSync(`${dir}/SUMMARY.md`, summary);
copyFileSync(`${dir}/SUMMARY.md`, `${dir}/../SUMMARY.md`);

console.error('');
console.error(`[revalidate-hero] status=${status}`);
console.error(`  hallucination drift=${hallucination.driftScore}`);
console.error(`  value_delivered=${judge.value_delivered.score.toFixed(2)}`);
console.error(`  value_received=${judge.value_received.score.toFixed(2)}`);
console.error(`  artifacts: ${dir}`);

function renderSummary(r) {
  const lines = [];
  lines.push(`# Hero scenario: ${r.spec.title}`);
  lines.push('');
  lines.push(`**Scenario:** \`${r.spec.id}\``);
  lines.push(`**Status:** ${r.status.toUpperCase()}`);
  lines.push(`**Env:** ${r.envMode}`);
  lines.push(`**Bash calls:** ${r.bashCommands.length}`);
  lines.push('');
  lines.push('## User question');
  lines.push('');
  lines.push('> ' + r.spec.prompt.replace(/\n/g, '\n> '));
  lines.push('');
  lines.push('## Three axes');
  lines.push('');
  lines.push(
    `- **Hallucination (drift score):** ${r.hallucination.driftScore} unsupported · ${r.hallucination.supported} supported · ${r.hallucination.inconclusive} inconclusive`
  );
  lines.push(`- **Value delivered:** ${r.valueDelivered.score.toFixed(2)} — ${r.valueDelivered.rationale}`);
  lines.push(`- **Value received:** ${r.valueReceived.score.toFixed(2)} — ${r.valueReceived.rationale}`);
  if (r.flags.length > 0) lines.push(`- **Flags:** ${r.flags.join(', ')}`);
  lines.push('');
  lines.push('## Sub-agent final synthesis');
  lines.push('');
  lines.push(r.finalSynthesis);
  lines.push('');
  lines.push('## Oracle validation');
  lines.push('');
  lines.push(
    `- Claims found: ${r.hallucination.numericClaimCount} numeric, ${r.hallucination.patternClaimCount} pattern names`
  );
  lines.push(
    `- Supported: ${r.hallucination.supported} · Unsupported: ${r.hallucination.unsupported} · Inconclusive: ${r.hallucination.inconclusive}`
  );
  lines.push('');
  lines.push('### Per-claim detail');
  lines.push('');
  for (const d of r.hallucination.details) {
    const icon =
      d.status === 'supported' ? 'OK' : d.status === 'unsupported' ? 'DRIFT' : 'WARN';
    lines.push(`- [${icon}] **${d.claim}** — ${d.oracleResult}`);
  }
  return lines.join('\n');
}
