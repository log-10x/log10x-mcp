#!/usr/bin/env node
/**
 * Run a hero scenario: load a hero spec, drive a sub-agent, score on
 * the three axes (hallucination/value-delivered/value-received).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=demo node bin/run-hero.mjs <spec.json>
 *   ANTHROPIC_API_KEY=... GROK_API_KEY=... LOG10X_EVAL_ENV=demo \
 *     node bin/run-hero.mjs <spec.json> --model grok
 *
 * Flags:
 *   --model claude|grok|<model-id>   Runner model. Default: claude (Anthropic).
 *
 * Writes everything to eval/reports/hero/<id>/<ts>[__model]/{transcript.json,
 * verdict.json, SUMMARY.md}. The SUMMARY.md path is the stage's
 * "done marker" per AUTONOMOUS_HERO_PLAN.md.
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEvalEnv } = await import(resolve(evalRoot, 'build-eval/env.js'));
const { runHero } = await import(resolve(evalRoot, 'build-eval/hero-runner.js'));

// Parse args: positional <spec.json> + optional --model <id> + optional --closed-loop
const args = process.argv.slice(2);
let specPath;
let runnerModel;
let closedLoop = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--model') {
    runnerModel = args[++i];
  } else if (a.startsWith('--model=')) {
    runnerModel = a.slice('--model='.length);
  } else if (a === '--closed-loop') {
    closedLoop = true;
  } else if (!specPath) {
    specPath = a;
  }
}
if (!specPath) {
  console.error(
    'Usage: run-hero.mjs <spec.json> [--model claude|grok|<id>] [--closed-loop]\n' +
      '\n' +
      '  --closed-loop  Enable closed-loop action verification (only if the spec has a closed_loop block).\n' +
      '                 The harness will judge the synthesis for the recommended action and, if matched,\n' +
      '                 execute the spec-defined remediation script and verify symptom resolution.\n' +
      '                 Destructive: may push commits / apply k8s manifests. Use deliberately.'
  );
  process.exit(2);
}

const spec = JSON.parse(readFileSync(resolve(specPath), 'utf8'));
const env = loadEvalEnv();
const ts = new Date().toISOString().replace(/[:.]/g, '-');
// Millisecond-precision timestamp alone collides on parallel launches (saw it
// at N=10 Grok where two runs landed in the same ms and the second overwrote
// the first). Append PID + a short random tag so concurrent runs always get
// distinct dirs.
const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const modelTag = runnerModel ? `__${runnerModel.replace(/[^a-zA-Z0-9._-]/g, '_')}` : '';
const outDir = join(evalRoot, 'reports', 'hero', spec.id, `${ts}__${suffix}${modelTag}`);

console.error(
  `[run-hero] spec=${spec.id} env=${env.mode} model=${runnerModel ?? 'claude (default)'}` +
    (closedLoop ? ' closed-loop=ON' : '') +
    ` outDir=${outDir}`
);

const report = await runHero(spec, env, outDir, runnerModel, { closedLoop });

// Also drop a stable SUMMARY.md at the scenario root (not just the
// timestamped subdir) so the plan's done-marker path is predictable.
// AWAITED top-level — earlier this used a fire-and-forget
// `import().then()` which raced with process.exit and lost the file.
const fs = await import('node:fs');
fs.copyFileSync(
  join(outDir, 'SUMMARY.md'),
  join(evalRoot, 'reports', 'hero', spec.id, 'SUMMARY.md')
);

console.error('');
console.error(`[run-hero] status=${report.status}`);
console.error(`  hallucination drift=${report.hallucination.driftScore}`);
console.error(`  value_delivered=${report.valueDelivered.score.toFixed(2)}`);
console.error(`  value_received=${report.valueReceived.score.toFixed(2)}`);
console.error(`  bash calls=${report.bashCommands.length}, duration=${(report.durationMs / 1000).toFixed(1)}s`);
if (report.cost) {
  const c = report.cost;
  console.error(
    `  cost: $${c.costUsd.toFixed(4)} (${c.inputTokens} in / ${c.outputTokens} out, ${c.apiCalls} api calls)`
  );
}
if (report.followUp) {
  console.error(
    `  follow_up: held_ground=${report.followUp.held_ground}` +
      ` bash_calls_during=${report.followUp.bash_calls_during_follow_up}`
  );
}
if (report.causalRating) {
  console.error(
    `  causal_rating: drift=${report.causalRating.rating_drift}` +
      ` (over=${report.causalRating.over_attributions}, under=${report.causalRating.under_attributions})`
  );
}
if (report.closedLoop) {
  const cl = report.closedLoop;
  console.error(
    `  closed_loop: recommended=${cl.agent_recommended_canonical_fix}` +
      ` applied=${cl.remediation_applied}` +
      ` symptom_resolved=${cl.symptom_resolved}`
  );
}
console.error('');
console.error(`[run-hero] artifacts: ${outDir}`);

process.exit(report.status === 'fail' ? 1 : 0);
