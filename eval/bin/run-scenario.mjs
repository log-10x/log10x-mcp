#!/usr/bin/env node
/**
 * Run a single scenario fixture in deterministic or autonomous mode.
 *
 * Usage:
 *   node bin/run-scenario.mjs <fixture.json> [--mode deterministic|autonomous]
 *                                              [--no-judge]
 *                                              [--reports-dir <path>]
 *                                              [--model <claude-model-id>]
 *
 * Defaults: --mode deterministic, judge ON if ANTHROPIC_API_KEY is set,
 * --reports-dir eval/reports.
 *
 * Exits 0 if passedCriteria=true, 1 otherwise. flags=upstream_rate_limit
 * still exits 0 (covered in orchestrator.decidePassed).
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const evalRoot = resolve(__dirname, '..');

const { loadScenario } = await import(resolve(evalRoot, 'build-eval/fixture-loader.js'));
const { loadEvalEnv } = await import(resolve(evalRoot, 'build-eval/env.js'));
const { runScenario } = await import(resolve(evalRoot, 'build-eval/orchestrator.js'));

function parseArgs(argv) {
  const out = { mode: 'deterministic', judge: undefined, reportsDir: null, model: null, fixture: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') out.mode = argv[++i];
    else if (a === '--no-judge') out.judge = false;
    else if (a === '--judge') out.judge = true;
    else if (a === '--reports-dir') out.reportsDir = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (!a.startsWith('--') && !out.fixture) out.fixture = a;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!out.fixture) {
    console.error('Usage: run-scenario.mjs <fixture.json> [--mode deterministic|autonomous] [--no-judge]');
    process.exit(2);
  }
  if (!['deterministic', 'autonomous'].includes(out.mode)) {
    console.error(`--mode must be deterministic or autonomous, got: ${out.mode}`);
    process.exit(2);
  }
  return out;
}

const opts = parseArgs(process.argv);
const judgeEnabled = opts.judge ?? !!process.env.ANTHROPIC_API_KEY;
const reportsRoot = opts.reportsDir ? resolve(opts.reportsDir) : resolve(evalRoot, 'reports');

const scenario = loadScenario(resolve(opts.fixture));
const env = loadEvalEnv();

console.error(`[run-scenario] ${scenario.id} mode=${opts.mode} judge=${judgeEnabled} env=${env.mode}`);
const report = await runScenario({
  mode: opts.mode,
  scenario,
  env,
  reportsRoot,
  judge: judgeEnabled,
  model: opts.model || undefined,
});

console.error(
  `[run-scenario] ${scenario.id} → ${report.outcome} steps=${report.totalSteps} ` +
    `passed=${report.passedCriteria} reasoning=${report.scores.reasoning.toFixed(2)} ` +
    `value=${report.scores.value.toFixed(2)} autonomy=${report.scores.autonomy.toFixed(2)} ` +
    `hallucination=${report.scores.hallucination.toFixed(2)}`
);
console.log(report.transcriptPath.replace(/\/transcript\.jsonl$/, ''));

process.exit(report.passedCriteria ? 0 : 1);
