#!/usr/bin/env node
/**
 * Drive a hero scenario through the perturbation interposer.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=demo \
 *     node eval/bin/run-perturbed-scenario.mjs \
 *       --scenario eval/fixtures/hero/cost-week-over-week.json \
 *       --perturbation eval/perturbations/top-patterns-fake-row.json
 *
 * The perturbed CLI replaces mcp-call.mjs for the duration of the
 * run (via MCP_CALL_BIN env var the hero-runner now respects). One
 * tool call gets mutated per scenario (PERTURBATION_MARKER tracks
 * which tool already fired). After the run, manual + judge inspection
 * decides: caught | repeated | partial.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { scenario: null, perturbation: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scenario') out.scenario = argv[++i];
    else if (a === '--perturbation') out.perturbation = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: run-perturbed-scenario.mjs --scenario <path> --perturbation <path>');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!out.scenario || !out.perturbation) {
    console.error('--scenario and --perturbation are required.');
    process.exit(2);
  }
  return out;
}

const opts = parseArgs(process.argv);
const scenarioPath = resolve(opts.scenario);
const perturbPath = resolve(opts.perturbation);
const perturbSpec = JSON.parse(readFileSync(perturbPath, 'utf8'));
const scenarioId = JSON.parse(readFileSync(scenarioPath, 'utf8')).id;

// One marker per run so perturbations fire only once per process invocation.
const marker = `/tmp/log10x-perturb-${perturbSpec.id}-${scenarioId}-${Date.now()}.fired`;
if (existsSync(marker)) rmSync(marker);

const perturbedBin = resolve(evalRoot, 'bin/mcp-call-perturbed.mjs');

const runHero = resolve(evalRoot, 'bin/run-hero.mjs');
console.error(`[perturbed] scenario=${scenarioId} perturbation=${perturbSpec.id}`);
console.error(`[perturbed] MCP_CALL_BIN=${perturbedBin}`);
console.error(`[perturbed] PERTURBATION_SPEC=${perturbPath}`);

// Marker so the campaign re-score path can skip this run. Without
// this, perturbation transcripts (which we EXPECT to fail because
// the agent is reading mutated tool output) get picked up as the
// most-recent transcript per scenario and pollute the campaign
// verdict.
const _markerHook = () => {
  // Find the run-hero outDir from the latest reports/hero/<id>/*/
  // dir created during this run and drop a `.perturbed` file.
  const reportsDir = resolve(evalRoot, 'reports/hero', scenarioId);
  if (!existsSync(reportsDir)) return;
  const fsm = readdirSync(reportsDir).filter((d) => /^\d{4}-/.test(d)).sort();
  if (fsm.length === 0) return;
  const latest = resolve(reportsDir, fsm[fsm.length - 1]);
  writeFileSync(resolve(latest, '.perturbed'), `${perturbSpec.id}\n`);
};

const r = spawnSync(
  'node',
  [runHero, scenarioPath],
  {
    env: {
      ...process.env,
      MCP_CALL_BIN: perturbedBin,
      PERTURBATION_SPEC: perturbPath,
      PERTURBATION_MARKER: marker,
    },
    stdio: 'inherit',
  }
);

// Mark the latest reports/hero/<id>/<ts>/ dir as perturbed so the
// campaign re-score skips it.
_markerHook();

// Record outcome regardless of the run exit code so we can inspect.
const resultsDir = resolve(evalRoot, 'perturbations/runs', `${scenarioId}__${perturbSpec.id}`);
mkdirSync(resultsDir, { recursive: true });
writeFileSync(
  resolve(resultsDir, 'run.json'),
  JSON.stringify(
    {
      scenario: scenarioId,
      perturbation: perturbSpec.id,
      expected_agent_behavior: perturbSpec.expected_agent_behavior,
      perturbation_fired: existsSync(marker),
      exit_code: r.status ?? -1,
      timestamp: new Date().toISOString(),
    },
    null,
    2
  ) + '\n'
);

console.error(`[perturbed] outcome → ${resultsDir}/run.json`);
console.error(`[perturbed] perturbation_fired=${existsSync(marker)}`);

// Leave the marker on disk for post-mortem inspection. The next run uses a
// fresh marker (timestamp in filename).

process.exit(r.status ?? 1);
