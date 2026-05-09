#!/usr/bin/env node
/**
 * Re-score an existing transcript without re-running the agent. Useful
 * for prompt-engineering the judge or replaying a flake.
 *
 * Usage:
 *   node bin/judge-only.mjs <reports-run-dir> <fixture.json>
 *
 * <reports-run-dir> points at a directory containing transcript.jsonl
 * (typically eval/reports/<scenario-id>/<timestamp>/).
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const evalRoot = resolve(__dirname, '..');

const { loadScenario } = await import(resolve(evalRoot, 'build-eval/fixture-loader.js'));
const { parseTranscript } = await import(resolve(evalRoot, 'build-eval/transcript-parser.js'));
const { runJudge, normalizeJudgeScores } = await import(resolve(evalRoot, 'build-eval/judge.js'));
const { computeSequenceDiff, evaluateGroundTruth } = await import(
  resolve(evalRoot, 'build-eval/scenario-validator.js')
);

const [, , runDir, fixturePath] = process.argv;
if (!runDir || !fixturePath) {
  console.error('Usage: judge-only.mjs <reports-run-dir> <fixture.json>');
  process.exit(2);
}

const scenario = loadScenario(resolve(fixturePath));
const parsed = parseTranscript(join(resolve(runDir), 'transcript.jsonl'));

const sequenceDiff = computeSequenceDiff(scenario, parsed);
const groundTruth = evaluateGroundTruth(scenario, parsed);

const verdict = await runJudge({ scenario, parsed, sequenceDiff, groundTruth });
const norm = normalizeJudgeScores(verdict);

const out = {
  scenarioId: scenario.id,
  reasoning: norm.reasoning,
  value: norm.value,
  hallucination: norm.hallucination,
  verdict,
};
const outPath = join(resolve(runDir), 'judge-rerun.json');
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.error(`[judge-only] wrote ${outPath}`);
console.log(JSON.stringify(out, null, 2));
