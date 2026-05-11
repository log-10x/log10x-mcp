#!/usr/bin/env node
/**
 * Run every counterfactual spec under eval/counterfactual/specs/
 * sequentially. Emits eval/counterfactual/COUNTERFACTUAL-PROOF.md.
 *
 * Sequential by design — the engine + forwarder stack is shared, so
 * parallel runs would mix events and confuse the metric-delta math.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=customer LOG10X_API_KEY=<talw.gx> \
 *     node eval/bin/run-counterfactual-suite.mjs [--filter <substring>]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { filter: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--filter') out.filter = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: run-counterfactual-suite.mjs [--filter <substr>]');
      process.exit(0);
    }
  }
  return out;
}

const opts = parseArgs(process.argv);
const specsDir = resolve(evalRoot, 'counterfactual/specs');
const specFiles = readdirSync(specsDir)
  .filter((f) => f.endsWith('.json'))
  .filter((f) => !opts.filter || f.includes(opts.filter))
  .sort()
  .map((f) => join(specsDir, f));

console.error(`[suite] running ${specFiles.length} counterfactual spec(s)`);

const results = [];
for (const specPath of specFiles) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  console.error(`\n=== ${spec.id} ===`);
  const r = spawnSync(
    'node',
    [resolve(evalRoot, 'bin/run-counterfactual-scenario.mjs'), '--spec', specPath],
    { cwd: dirname(evalRoot), stdio: 'inherit' }
  );
  // Find the latest verdict files this run produced.
  const runsRoot = resolve(evalRoot, 'counterfactual/runs');
  const runDirs = readdirSync(runsRoot)
    .filter((d) => d.startsWith(spec.id + '-'))
    .sort();
  const latestRun = runDirs[runDirs.length - 1];
  if (!latestRun) {
    results.push({ spec_id: spec.id, error: 'no run dir found', exit_code: r.status });
    continue;
  }
  const runDir = join(runsRoot, latestRun);
  const verdictFiles = readdirSync(runDir).filter(
    (f) => f.startsWith('verdict-') && f.endsWith('.json')
  );
  for (const vf of verdictFiles) {
    const v = JSON.parse(readFileSync(join(runDir, vf), 'utf8'));
    results.push({ spec_id: spec.id, ...v });
  }
}

// ── Compose the proof markdown ───────────────────────────────────────
const lines = [];
lines.push('# Counterfactual injection harness — proof');
lines.push('');
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push('');
lines.push(`- **Specs run**: ${specFiles.length}`);
lines.push(`- **Scenario verdicts**: ${results.length}`);
const passed = results.filter((r) => r.passed).length;
lines.push(`- **PASS**: ${passed} / ${results.length}`);
lines.push('');
lines.push('## Per-scenario verdicts');
lines.push('');
lines.push('| Spec | Scenario | Overall | Metric | Agent | Synthesis |');
lines.push('|---|---|---|---|---|---|');
for (const r of results) {
  const m = r.metric_layer?.predicted_satisfied;
  const a = r.agent_layer?.predicted_satisfied;
  const s = r.synthesis_layer?.passed;
  lines.push(
    `| \`${r.spec_id}\` | \`${r.scenario_id ?? '?'}\` | ${r.passed ? 'PASS' : 'FAIL'} | ${m ? '✓' : '✗'} | ${a ? '✓' : '✗'} | ${s ? '✓' : '✗'} |`
  );
}
lines.push('');
lines.push('## Layer breakdown');
lines.push('');
for (const r of results) {
  if (r.error) {
    lines.push(`### \`${r.spec_id}\` — ERROR`);
    lines.push(`- ${r.error}`);
    lines.push('');
    continue;
  }
  lines.push(`### \`${r.spec_id}\` × \`${r.scenario_id}\``);
  lines.push(
    `- **metric**: ${r.metric_layer.predicted_satisfied ? '✓' : '✗'}${
      r.metric_layer.notes.length ? '  — ' + r.metric_layer.notes.join('; ') : ''
    }`
  );
  lines.push(
    `- **agent**: ${r.agent_layer.predicted_satisfied ? '✓' : '✗'} ` +
      `(tools: ${r.agent_layer.tools_called.join(', ') || '(none)'})${
        r.agent_layer.notes.length ? '  — ' + r.agent_layer.notes.join('; ') : ''
      }`
  );
  lines.push(
    `- **synthesis**: ${r.synthesis_layer.passed ? '✓' : '✗'} ` +
      `\`${r.synthesis_layer.axes_summary}\``
  );
  lines.push('');
}

const proofPath = resolve(evalRoot, 'counterfactual/COUNTERFACTUAL-PROOF.md');
writeFileSync(proofPath, lines.join('\n') + '\n');
console.error(`\n[suite] ${passed}/${results.length} PASS`);
console.error(`[suite] proof: ${proofPath}`);
process.exit(results.every((r) => r.passed) ? 0 : 1);
