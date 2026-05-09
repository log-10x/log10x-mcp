#!/usr/bin/env node
/**
 * Run a hero scenario: load a hero spec, drive a sub-agent, score on
 * the three axes (hallucination/value-delivered/value-received).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=demo node bin/run-hero.mjs <spec.json>
 *
 * Writes everything to eval/reports/hero/<id>/<ts>/{transcript.json,
 * verdict.json, SUMMARY.md}. The SUMMARY.md path is the stage's
 * "done marker" per AUTONOMOUS_HERO_PLAN.md.
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEvalEnv } = await import(resolve(evalRoot, 'build-eval/env.js'));
const { runHero } = await import(resolve(evalRoot, 'build-eval/hero-runner.js'));

const specPath = process.argv[2];
if (!specPath) {
  console.error('Usage: run-hero.mjs <spec.json>');
  process.exit(2);
}

const spec = JSON.parse(readFileSync(resolve(specPath), 'utf8'));
const env = loadEvalEnv();
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(evalRoot, 'reports', 'hero', spec.id, ts);

console.error(`[run-hero] spec=${spec.id} env=${env.mode} outDir=${outDir}`);

const report = await runHero(spec, env, outDir);

// Also drop a stable SUMMARY.md at the scenario root (not just the
// timestamped subdir) so the plan's done-marker path is predictable.
import('node:fs').then(({ copyFileSync }) => {
  copyFileSync(join(outDir, 'SUMMARY.md'), join(evalRoot, 'reports', 'hero', spec.id, 'SUMMARY.md'));
});

console.error('');
console.error(`[run-hero] status=${report.status}`);
console.error(`  hallucination drift=${report.hallucination.driftScore}`);
console.error(`  value_delivered=${report.valueDelivered.score.toFixed(2)}`);
console.error(`  value_received=${report.valueReceived.score.toFixed(2)}`);
console.error(`  bash calls=${report.bashCommands.length}, duration=${(report.durationMs / 1000).toFixed(1)}s`);
console.error('');
console.error(`[run-hero] artifacts: ${outDir}`);

process.exit(report.status === 'fail' ? 1 : 0);
