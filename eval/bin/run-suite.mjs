#!/usr/bin/env node
/**
 * Run every fixture in eval/fixtures (or a filtered subset) and emit a
 * suite-level summary at the end. Exit code 1 if any scenario fails.
 *
 * Usage:
 *   node bin/run-suite.mjs [--filter <glob-substring>]
 *                          [--mode deterministic|autonomous]
 *                          [--no-judge]
 *                          [--reports-dir <path>]
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const evalRoot = resolve(__dirname, '..');

const { loadAllScenarios } = await import(resolve(evalRoot, 'build-eval/fixture-loader.js'));
const { loadEvalEnv } = await import(resolve(evalRoot, 'build-eval/env.js'));
const { runScenario } = await import(resolve(evalRoot, 'build-eval/orchestrator.js'));

function parseArgs(argv) {
  const out = { filter: null, mode: 'deterministic', judge: undefined, reportsDir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--filter') out.filter = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--no-judge') out.judge = false;
    else if (a === '--judge') out.judge = true;
    else if (a === '--reports-dir') out.reportsDir = argv[++i];
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const opts = parseArgs(process.argv);
const judgeEnabled = opts.judge ?? !!process.env.ANTHROPIC_API_KEY;
const reportsRoot = opts.reportsDir ? resolve(opts.reportsDir) : resolve(evalRoot, 'reports');

const fixturesDir = resolve(evalRoot, 'fixtures');
let scenarios = loadAllScenarios(fixturesDir);
if (opts.filter) {
  const f = opts.filter.replace(/\*/g, '');
  scenarios = scenarios.filter((s) => s.id.includes(f));
}
if (scenarios.length === 0) {
  console.error(`No scenarios matched filter=${opts.filter}`);
  process.exit(2);
}

const env = loadEvalEnv();
console.error(
  `[run-suite] env=${env.mode} mode=${opts.mode} judge=${judgeEnabled} scenarios=${scenarios.length}`
);

const results = [];
const t0 = Date.now();
for (const scenario of scenarios) {
  console.error(`\n=== ${scenario.id} ===`);
  try {
    const report = await runScenario({
      mode: opts.mode,
      scenario,
      env,
      reportsRoot,
      judge: judgeEnabled,
    });
    results.push(report);
    console.error(
      `  → ${report.outcome} steps=${report.totalSteps} passed=${report.passedCriteria}`
    );
  } catch (e) {
    console.error(`  → FAILED TO RUN: ${e.message}`);
    results.push({
      scenarioId: scenario.id,
      passedCriteria: false,
      outcome: 'inconclusive',
      totalSteps: 0,
      error: e.message,
    });
  }
}

const totalMs = Date.now() - t0;

// Suite summary
const summary = {
  startedAt: new Date(Date.now() - totalMs).toISOString(),
  endedAt: new Date().toISOString(),
  totalMs,
  envMode: env.mode,
  judgeRan: judgeEnabled,
  mode: opts.mode,
  scenarios: results.map((r) => ({
    id: r.scenarioId,
    outcome: r.outcome,
    totalSteps: r.totalSteps,
    passedCriteria: r.passedCriteria,
    flags: r.flags ?? [],
    scores: r.scores,
  })),
  passed: results.filter((r) => r.passedCriteria).length,
  failed: results.filter((r) => !r.passedCriteria).length,
};

mkdirSync(reportsRoot, { recursive: true });
const summaryPath = join(reportsRoot, `suite-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

console.error(`\n[run-suite] ${summary.passed}/${results.length} passed in ${(totalMs / 1000).toFixed(1)}s`);
console.error(`[run-suite] summary: ${summaryPath}`);
console.log(summaryPath);

process.exit(summary.failed > 0 ? 1 : 0);
