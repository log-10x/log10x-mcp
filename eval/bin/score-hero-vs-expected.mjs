#!/usr/bin/env node
/**
 * Score a saved hero transcript against its spec's expected_answer.
 * Emits a CampaignVerdict + appends GapRecords to eval/gaps/gaps.json.
 *
 * Usage:
 *   LOG10X_EVAL_ENV=demo node bin/score-hero-vs-expected.mjs <transcript.json>
 *
 * Re-runnable: scoring is independent of the agent run. Re-running on
 * the same transcript with a refreshed expected_answer / refined
 * scoring rubric produces a new verdict + new gaps without burning
 * tokens.
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadEvalEnv } = await import(resolve(evalRoot, 'build-eval/env.js'));
const { scoreAgainstExpected, loadTranscript } = await import(
  resolve(evalRoot, 'build-eval/campaign-scorer.js')
);
const { appendGap } = await import(resolve(evalRoot, 'build-eval/gap-tracker.js'));

const transcriptPath = process.argv[2];
if (!transcriptPath) {
  console.error('Usage: score-hero-vs-expected.mjs <path/to/transcript.json>');
  process.exit(2);
}

const env = loadEvalEnv();
const transcript = loadTranscript(resolve(transcriptPath));

// Find the spec for this transcript by id.
const fixturesDir = join(evalRoot, 'fixtures', 'hero');
const specPath = join(fixturesDir, `${transcript.spec.id}.json`);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));

// Pull the existing verdict.json to recover prior judge scores (so we
// don't have to re-judge on a no-judge re-score).
const verdictPath = resolve(transcriptPath).replace(/transcript\.json$/, 'verdict.json');
let judgeScores;
try {
  const v = JSON.parse(readFileSync(verdictPath, 'utf8'));
  if (v.valueDelivered?.score !== undefined) {
    judgeScores = {
      value_delivered: v.valueDelivered.score,
      value_received: v.valueReceived?.score ?? -1,
    };
  }
} catch {
  // no prior judge scores; campaign scorer will record value_*=-1
}

const result = await scoreAgainstExpected({ transcript, spec, env, judgeScores });

console.log(`# ${spec.id}`);
console.log(`PASSED: ${result.verdict.passed}`);
console.log(`Axes:   ${result.verdict.axes_summary}`);
console.log('');
if (result.gaps.length > 0) {
  console.log(`Gaps emitted: ${result.gaps.length}`);
  for (const g of result.gaps) {
    console.log(`  - [${g.gap_kind}] ${g.gap_description}`);
  }
} else {
  console.log('No gaps; question PASSES the campaign rubric.');
}

// Append gaps to the persistent record.
const gapsPath = join(evalRoot, 'gaps', 'gaps.json');
for (const g of result.gaps) {
  appendGap(gapsPath, g);
}
if (result.gaps.length > 0) {
  console.log(`Appended ${result.gaps.length} gap record(s) to ${gapsPath}`);
}

// Also write a per-run campaign-verdict.json beside the transcript.
const campaignVerdictPath = resolve(transcriptPath).replace(/transcript\.json$/, 'campaign-verdict.json');
writeFileSync(
  campaignVerdictPath,
  JSON.stringify(
    {
      question_id: spec.id,
      transcript_path: transcriptPath,
      verdict: result.verdict,
      oracle: result.oracle,
      pattern_match: result.patternMatch,
      chain_alignment: result.chainAlignment,
      gaps: result.gaps,
    },
    null,
    2
  ) + '\n'
);
console.log(`Wrote ${campaignVerdictPath}`);

process.exit(result.verdict.passed ? 0 : 1);
