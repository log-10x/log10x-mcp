#!/usr/bin/env node
/**
 * Run a single counterfactual scenario end-to-end:
 *   1. Pre-snapshot the oracle on the target env.
 *   2. Spawn the synthetic-event generator via docker compose.
 *      (The fluent-bit + pipeline-10x stack is assumed already up.)
 *   3. Wait for the generator to exit (event emission complete) plus
 *      the spec's propagation_seconds.
 *   4. Post-snapshot the oracle.
 *   5. For each sensitive_scenario in the spec:
 *        a. Compute metric-layer verdict from pre/post snapshots.
 *        b. Run the affected hero scenario via bin/run-hero.mjs.
 *        c. Compute agent-layer + synthesis-layer verdicts from the
 *           resulting transcript.
 *        d. Assemble + persist a CounterfactualVerdict beside the
 *           transcript.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=talw_gx \
 *     node eval/bin/run-counterfactual-scenario.mjs \
 *       --spec eval/counterfactual/specs/inject-critical-burst.json
 *
 * The forwarder + engine must be running:
 *   cd eval/counterfactual && TENX_API_KEY=... docker compose up -d
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEvalEnv } = await import(resolve(evalRoot, 'build-eval/env.js'));
const {
  takeSnapshot,
  computeMetricVerdict,
  computeAgentVerdict,
  computeSynthesisVerdict,
  assembleVerdict,
  renderVerdictMarkdown,
} = await import(resolve(evalRoot, 'build-eval/counterfactual-runner.js'));
const { loadTranscript } = await import(resolve(evalRoot, 'build-eval/campaign-scorer.js'));

function parseArgs(argv) {
  const out = { spec: null, skipGenerator: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spec') out.spec = argv[++i];
    else if (a === '--skip-generator') out.skipGenerator = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: run-counterfactual-scenario.mjs --spec <path> [--skip-generator]'
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!out.spec) {
    console.error('--spec <path> required');
    process.exit(2);
  }
  return out;
}

const opts = parseArgs(process.argv);
const specPath = resolve(opts.spec);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
console.error(`[counterfactual] spec=${spec.id} target_env=${spec.target_env}`);

const env = loadEvalEnv();

// ── Step 1: pre-snapshot
console.error(`[counterfactual] taking pre-snapshot…`);
const pre = await takeSnapshot(env, '15m');
console.error(
  `[counterfactual] pre: ${pre.service_names.length} services, total ${(
    pre.total_volume_bytes / 1e6
  ).toFixed(1)} MB / 15m`
);

// ── Step 2: spawn generator
const runDir = resolve(
  evalRoot,
  'counterfactual/runs',
  `${spec.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`
);
mkdirSync(runDir, { recursive: true });
writeFileSync(join(runDir, 'pre-snapshot.json'), JSON.stringify(pre, null, 2) + '\n');

if (!opts.skipGenerator) {
  console.error(`[counterfactual] spawning generator (docker compose run --rm generator)…`);
  const composeDir = resolve(evalRoot, 'counterfactual');
  // Spec path inside the container; docker-compose mounts ./specs at /specs.
  const specName = specPath.split('/').pop();
  const r = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      join(composeDir, 'docker-compose.yml'),
      'run',
      '--rm',
      'generator',
      '--spec',
      `/specs/${specName}`,
    ],
    {
      cwd: composeDir,
      stdio: 'inherit',
    }
  );
  if (r.status !== 0) {
    console.error(`[counterfactual] generator failed (exit ${r.status})`);
    process.exit(1);
  }
  // Wait propagation
  console.error(`[counterfactual] sleeping ${spec.propagation_seconds}s for propagation…`);
  await new Promise((r) => setTimeout(r, spec.propagation_seconds * 1000));
} else {
  console.error('[counterfactual] --skip-generator: assuming events already planted');
}

// ── Step 3: post-snapshot
console.error(`[counterfactual] taking post-snapshot…`);
const post = await takeSnapshot(env, '15m');
console.error(
  `[counterfactual] post: ${post.service_names.length} services, total ${(
    post.total_volume_bytes / 1e6
  ).toFixed(1)} MB / 15m`
);
writeFileSync(join(runDir, 'post-snapshot.json'), JSON.stringify(post, null, 2) + '\n');

// ── Step 4-5: per scenario, run hero + assemble verdict
const verdicts = [];
for (let i = 0; i < spec.sensitive_scenarios.length; i++) {
  const sens = spec.sensitive_scenarios[i];
  console.error(`\n[counterfactual] scenario ${i + 1}/${spec.sensitive_scenarios.length}: ${sens.scenario_id}`);

  // Metric layer
  const metricLayer = computeMetricVerdict(spec, i, pre, post);
  console.error(`  [metric] satisfied=${metricLayer.predicted_satisfied}`);
  for (const n of metricLayer.notes) console.error(`    - ${n}`);

  // Run hero scenario
  const heroSpecPath = resolve(evalRoot, 'fixtures/hero', `${sens.scenario_id}.json`);
  if (!existsSync(heroSpecPath)) {
    console.error(`  [skip] hero spec not found: ${heroSpecPath}`);
    continue;
  }
  console.error(`  [hero] running ${sens.scenario_id}…`);
  const r = spawnSync('node', [resolve(evalRoot, 'bin/run-hero.mjs'), heroSpecPath], {
    cwd: dirname(evalRoot),
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`  [warn] run-hero exit ${r.status}; will still try to score`);
  }

  // Find the latest transcript for this scenario
  const reportsDir = resolve(evalRoot, 'reports/hero', sens.scenario_id);
  const tsDirs = readdirSync(reportsDir)
    .filter((d) => statSync(join(reportsDir, d)).isDirectory())
    .filter((d) => !existsSync(join(reportsDir, d, '.perturbed')))
    .sort();
  if (tsDirs.length === 0) {
    console.error(`  [error] no transcripts at ${reportsDir}`);
    continue;
  }
  const transcriptPath = join(reportsDir, tsDirs[tsDirs.length - 1], 'transcript.json');
  const transcript = loadTranscript(transcriptPath);

  // Agent layer
  const agentLayer = computeAgentVerdict(spec, i, transcript);
  console.error(
    `  [agent] satisfied=${agentLayer.predicted_satisfied} tools=${agentLayer.tools_called.length} mentions_found=${agentLayer.mentions_found.length}`
  );
  for (const n of agentLayer.notes) console.error(`    - ${n}`);

  // Synthesis layer
  const heroSpec = JSON.parse(readFileSync(heroSpecPath, 'utf8'));
  const synthesisLayer = await computeSynthesisVerdict(transcript, heroSpec, env);
  console.error(`  [synth] passed=${synthesisLayer.passed} axes=${synthesisLayer.axes_summary}`);

  // Mark the transcript as counterfactual-tied so it doesn't pollute campaign re-score
  // (same idiom as .perturbed). The marker name is .counterfactual.
  const transcriptDir = dirname(transcriptPath);
  writeFileSync(join(transcriptDir, '.counterfactual'), `${spec.id}\n${sens.scenario_id}\n`);

  // Assemble verdict
  const verdict = assembleVerdict({
    spec,
    scenarioIdx: i,
    runId: `${spec.id}-${i}-${Date.now()}`,
    metricLayer,
    agentLayer,
    synthesisLayer,
  });
  verdicts.push(verdict);

  const vPath = join(runDir, `verdict-${sens.scenario_id}.json`);
  writeFileSync(vPath, JSON.stringify(verdict, null, 2) + '\n');
  const mdPath = join(runDir, `verdict-${sens.scenario_id}.md`);
  writeFileSync(mdPath, renderVerdictMarkdown(verdict));
  console.error(`  [verdict] OVERALL=${verdict.passed ? 'PASS' : 'FAIL'} → ${vPath}`);
}

console.error(`\n[counterfactual] ${verdicts.filter((v) => v.passed).length}/${verdicts.length} scenarios PASS`);
console.error(`[counterfactual] run dir: ${runDir}`);
process.exit(verdicts.every((v) => v.passed) ? 0 : 1);
