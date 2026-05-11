#!/usr/bin/env node
/**
 * Score every saved perturbation run as a tracked agent-resilience
 * metric. Walks `eval/reports/hero/<scenario>/<ts>/` dirs, finds
 * those marked `.perturbed`, re-scores each via the campaign scorer
 * (so the dollar-amount drift catcher from fix B fires), and
 * computes:
 *
 *   agent_resilience_pct = N(caught) / N(caught + complied)
 *
 * Where "caught" = scorer PASSED:false on the perturbed transcript
 * (the agent's defense plus the rubric together caught the bad
 * tool output) and "complied" = PASSED:true (perturbation slipped
 * through into the synthesis without anyone noticing).
 *
 * Emits `eval/perturbations/AGENT-RESILIENCE.md` with the matrix.
 *
 * Usage:
 *   LOG10X_EVAL_ENV=demo node eval/bin/score-perturbations.mjs
 *     [--min-resilience 0.30]
 *
 * The flag gates CI on a minimum agent-resilience fraction; current
 * baseline is 0.33 (1 of 3 caught). A drop = scorer regression on
 * agent-resilience detection (we lost the ability to catch a
 * perturbation we used to catch).
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { scoreAgainstExpected, loadTranscript } = await import(
  resolve(evalRoot, 'build-eval/campaign-scorer.js')
);
const { loadEvalEnv } = await import(resolve(evalRoot, 'build-eval/env.js'));

function parseArgs(argv) {
  const out = { minResilience: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-resilience') out.minResilience = parseFloat(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: score-perturbations.mjs [--min-resilience <float>]');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const opts = parseArgs(process.argv);

// Discover all perturbed runs. Only count runs where the
// perturbation actually fired (checked via the run.json the
// driver writes under eval/perturbations/runs/). A mis-paired
// scenario × perturbation (e.g., agent never called the
// perturbed tool) is excluded from the metric — it's neither
// caught nor complied; the test simply didn't run.
function findPerturbed() {
  const out = [];
  const root = resolve(evalRoot, 'reports/hero');
  for (const scenario of readdirSync(root)) {
    const sdir = join(root, scenario);
    if (!statSync(sdir).isDirectory()) continue;
    for (const ts of readdirSync(sdir)) {
      const tdir = join(sdir, ts);
      if (!statSync(tdir).isDirectory()) continue;
      const marker = join(tdir, '.perturbed');
      if (!existsSync(marker)) continue;
      const perturbationId = readFileSync(marker, 'utf8').split('\n')[0].trim();
      if (!perturbationId) continue;
      // Check the driver's run.json for perturbation_fired.
      const runJsonPath = resolve(
        evalRoot,
        'perturbations/runs',
        `${scenario}__${perturbationId}/run.json`
      );
      if (existsSync(runJsonPath)) {
        try {
          const runData = JSON.parse(readFileSync(runJsonPath, 'utf8'));
          if (runData.perturbation_fired === false) {
            console.error(`  [skip] ${scenario} × ${perturbationId}: perturbation did not fire (mis-paired)`);
            continue;
          }
        } catch {
          // If run.json is unreadable, include the run anyway.
        }
      }
      out.push({ scenario, ts, tdir, perturbationId });
    }
  }
  return out;
}

const runs = findPerturbed();
console.error(`[resilience] found ${runs.length} perturbed transcripts`);

// Snapshot gaps.json (we don't want this scoring path to mutate it).
const gapsPath = resolve(evalRoot, 'gaps/gaps.json');
const gapsBackup = resolve(evalRoot, 'gaps/.gaps.perturbation-scorer.bak.json');
let restoreNeeded = false;
if (existsSync(gapsPath)) {
  copyFileSync(gapsPath, gapsBackup);
  restoreNeeded = true;
}

const env = loadEvalEnv();
const results = [];

try {
  for (const run of runs) {
    const txPath = join(run.tdir, 'transcript.json');
    if (!existsSync(txPath)) continue;
    const transcript = loadTranscript(txPath);
    const specPath = resolve(evalRoot, 'fixtures/hero', `${transcript.spec.id}.json`);
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const result = await scoreAgainstExpected({ transcript, spec, env });
    const caught = !result.verdict.passed;
    results.push({
      scenario: run.scenario,
      perturbation: run.perturbationId,
      caught,
      axes: result.verdict.axes_summary,
    });
    console.error(`  ${run.scenario} × ${run.perturbationId} → ${caught ? 'CAUGHT' : 'COMPLIED'}`);
  }
} finally {
  if (restoreNeeded) copyFileSync(gapsBackup, gapsPath);
}

const totalCaught = results.filter((r) => r.caught).length;
const total = results.length;
const resilience = total > 0 ? totalCaught / total : 0;

// Render the matrix.
const lines = [];
lines.push('# Agent-resilience matrix (tracked perturbation metric)');
lines.push('');
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push('');
lines.push(`- **Perturbed runs scored**: ${total}`);
lines.push(`- **Caught**: ${totalCaught}`);
lines.push(`- **Complied**: ${total - totalCaught}`);
lines.push(`- **Agent-resilience**: ${(resilience * 100).toFixed(1)}%`);
lines.push('');
lines.push('| Scenario | Perturbation | Outcome | Axes |');
lines.push('|---|---|---|---|');
for (const r of results) {
  lines.push(`| \`${r.scenario}\` | \`${r.perturbation}\` | ${r.caught ? 'CAUGHT' : 'COMPLIED'} | \`${r.axes}\` |`);
}
lines.push('');
lines.push('## Interpretation');
lines.push('');
lines.push('- **Caught** = the campaign scorer (with all D-fix hardenings + classifier) flagged the perturbed transcript as a failure.');
lines.push('- **Complied** = the perturbation slipped through both the agent\'s defenses AND the scorer.');
lines.push('');
lines.push('A high resilience score means: even when a tool returns bad data, the combined agent + rubric catches it.');
lines.push('A low resilience score means: agents propagate perturbed tool output into the synthesis AND the rubric accepts it.');

const outPath = resolve(evalRoot, 'perturbations/AGENT-RESILIENCE.md');
writeFileSync(outPath, lines.join('\n') + '\n');
console.error(`[resilience] resilience=${(resilience * 100).toFixed(1)}% (${totalCaught}/${total})`);
console.error(`[resilience] wrote ${outPath}`);

if (opts.minResilience != null && resilience < opts.minResilience) {
  console.error(`[resilience] gate FAILED: ${resilience.toFixed(3)} < required ${opts.minResilience.toFixed(3)}`);
  process.exit(1);
}
