/**
 * Orchestrator — wires runner output through validators, judge, and the
 * report writer. The bin/ scripts are thin shells; all the cross-cutting
 * logic lives here so deterministic and autonomous modes share it.
 *
 * Flow:
 *   1. Run the chosen mode → produces transcript + step log on disk.
 *   2. Parse transcript back from disk (canonical artifact).
 *   3. Compute sequence diff + ground-truth + autonomy metrics.
 *   4. (optional) Call the LLM judge for reasoning/value/hallucination.
 *   5. Aggregate scores, decide passedCriteria, write report.md +
 *      verdict.json.
 *
 * The pass/fail gate for `passedCriteria` combines deterministic signals
 * (sequence subsequence satisfied, ground truth all-pass, no
 * unknown_tool, autonomy >= threshold) and judge signals (reasoning,
 * value above threshold, hallucination below threshold). When --no-judge
 * is set, only deterministic signals are evaluated.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Scenario, RunReport, JudgeVerdict } from './types.js';
import { type EvalEnv, applyEvalEnvToProcess } from './env.js';
import { TranscriptWriter, StepLogWriter } from './transcript-writer.js';
import { parseTranscript } from './transcript-parser.js';
import { runDeterministic } from './deterministic-runner.js';
import { runAutonomous } from './autonomous-runner.js';
import { computeSequenceDiff, evaluateGroundTruth } from './scenario-validator.js';
import { computeAutonomy } from './autonomy-metrics.js';
import { runJudge, normalizeJudgeScores } from './judge.js';
import { writeRunReport } from './report-writer.js';
import { buildToolHarness, type TransportKind } from './tool-harness.js';

export interface RunOptions {
  mode: 'deterministic' | 'autonomous';
  scenario: Scenario;
  env: EvalEnv;
  reportsRoot: string;
  /** When false, skip the LLM-judge call (deterministic-only scoring). */
  judge: boolean;
  /** Optional model override for the autonomous runner. */
  model?: string;
  /**
   * Tool transport for autonomous mode:
   *   - 'in-process' (default): tool fns are imported and called directly.
   *     Fastest path; skips the MCP wire format.
   *   - 'stdio': spawn build/index.js as a child process, talk over the
   *     real MCP stdio + JSON-RPC transport. Mirrors what Claude Desktop
   *     and Cursor actually do.
   *
   * Deterministic mode ignores this — no model talks to the server.
   */
  transport?: TransportKind;
  /** Optional path to the MCP server's entry point for stdio mode. */
  serverEntryPath?: string;
}

export async function runScenario(opts: RunOptions): Promise<RunReport> {
  applyEvalEnvToProcess(opts.env);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(opts.reportsRoot, opts.scenario.id, ts);
  mkdirSync(outDir, { recursive: true });

  const transcriptPath = join(outDir, 'transcript.jsonl');
  const stepLogPath = join(outDir, 'step-log.jsonl');
  const reportPath = join(outDir, 'report.md');
  const verdictPath = join(outDir, 'verdict.json');

  const transcript = new TranscriptWriter(transcriptPath);
  const stepLog = new StepLogWriter(stepLogPath);

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  let result;
  if (opts.mode === 'deterministic') {
    result = await runDeterministic(opts.scenario, opts.env, transcript, stepLog);
  } else {
    const transport = opts.transport ?? 'in-process';
    const harness = buildToolHarness(opts.env, transport, {
      ...(opts.serverEntryPath ? { serverEntryPath: opts.serverEntryPath } : {}),
      ...(opts.scenario.wizard_answers ? { wizardAnswers: opts.scenario.wizard_answers } : {}),
    });
    try {
      result = await runAutonomous(opts.scenario, opts.env, transcript, stepLog, harness, opts.model);
    } finally {
      await harness.shutdown();
    }
  }

  await Promise.all([transcript.close(), stepLog.close()]);
  const durationMs = Date.now() - t0;
  const endedAt = new Date().toISOString();

  // Parse the transcript back from disk. This is the canonical
  // artifact — runner-internal state isn't trusted; the file is what
  // the judge sees too.
  const parsed = parseTranscript(transcriptPath);

  const sequenceDiff = computeSequenceDiff(opts.scenario, parsed);
  const groundTruth = evaluateGroundTruth(opts.scenario, parsed);
  const autonomy = computeAutonomy(parsed, opts.scenario.optimal_steps, parsed.toolCalls.length);

  let judgeVerdict: JudgeVerdict | null = null;
  let judgeNorm = { reasoning: 0, value: 0, hallucination: 0 };
  if (opts.judge) {
    try {
      judgeVerdict = await runJudge({
        scenario: opts.scenario,
        parsed,
        sequenceDiff,
        groundTruth,
      });
      judgeNorm = normalizeJudgeScores(judgeVerdict);
    } catch (e) {
      // Judge failures shouldn't tank the run — record as a flag and
      // fall back to deterministic-only scoring.
      judgeVerdict = null;
      console.error(`[judge] failed for ${opts.scenario.id}: ${(e as Error).message}`);
    }
  }

  const flags: string[] = [];
  for (const log of result.stepLogs) {
    if (log.kind === 'tool_call' && log.isError) {
      // Detect upstream rate-limit so diff-runs.mjs doesn't count it as
      // a regression. The error message format comes from the api.js
      // fetchWithRetry path.
      const txt = JSON.stringify(log).toLowerCase();
      if (txt.includes('429') || txt.includes('rate limit')) {
        flags.push('upstream_rate_limit');
      }
    }
  }
  if (judgeVerdict) {
    for (const f of judgeVerdict.flags) flags.push(`judge:${f}`);
  }

  const passedCriteria = decidePassed({
    scenario: opts.scenario,
    sequenceDiff,
    groundTruth,
    autonomy,
    judgeNorm,
    judgeRan: judgeVerdict !== null,
    outcome: result.outcome,
    flags,
  });

  const report: RunReport = {
    scenarioId: opts.scenario.id,
    scenarioTitle: opts.scenario.title,
    mode: opts.mode,
    startedAt,
    endedAt,
    durationMs,
    transcriptPath,
    stepLogPath,
    outcome: result.outcome,
    totalSteps: result.totalSteps,
    scores: {
      tool_selection: judgeVerdict?.scoresRaw.tool_selection ?? 0,
      parameters: judgeVerdict?.scoresRaw.parameters ?? 0,
      sequencing: judgeVerdict?.scoresRaw.sequencing ?? (sequenceDiff.satisfied ? 2 : 1),
      accuracy: judgeVerdict?.scoresRaw.accuracy ?? 0,
      hallucination: judgeNorm.hallucination,
      follow_through: judgeVerdict?.scoresRaw.follow_through ?? 0,
      reasoning: judgeVerdict ? judgeNorm.reasoning : sequenceDiff.satisfied ? 0.7 : 0.3,
      value: judgeVerdict ? judgeNorm.value : 0,
      autonomy: autonomy.score,
    },
    groundTruth,
    sequenceDiff,
    autonomyMetrics: autonomy,
    judgeVerdict,
    passedCriteria,
    flags,
  };

  writeRunReport(reportPath, verdictPath, report);
  return report;
}

interface DecideOpts {
  scenario: Scenario;
  sequenceDiff: ReturnType<typeof computeSequenceDiff>;
  groundTruth: ReturnType<typeof evaluateGroundTruth>;
  autonomy: ReturnType<typeof computeAutonomy>;
  judgeNorm: { reasoning: number; value: number; hallucination: number };
  judgeRan: boolean;
  outcome: string;
  flags: string[];
}

function decidePassed(o: DecideOpts): boolean {
  // Upstream rate-limit gives a free pass — surfaces as a flag for
  // diff-runs.mjs but doesn't fail the gate.
  if (o.flags.includes('upstream_rate_limit')) return true;
  if (o.outcome === 'unknown_tool') return false;
  if (!o.sequenceDiff.satisfied) return false;
  if (o.groundTruth.some((g) => !g.passed)) return false;
  if (o.autonomy.score < o.scenario.quality_criteria.autonomy) return false;
  if (o.judgeRan) {
    if (o.judgeNorm.reasoning < o.scenario.quality_criteria.reasoning) return false;
    if (o.judgeNorm.value < o.scenario.quality_criteria.value) return false;
    if (o.judgeNorm.hallucination > o.scenario.quality_criteria.hallucination_max) return false;
  }
  return true;
}
