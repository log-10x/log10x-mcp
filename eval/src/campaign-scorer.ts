/**
 * Campaign 5-axis scorer.
 *
 * Reads a saved hero transcript + the spec's expected_answer + the
 * current oracle snapshot, produces a CampaignVerdict, and emits
 * GapRecords for any failing axis.
 *
 * Decoupled from `hero-runner.ts` so we can re-score any saved
 * transcript without re-running the sub-agent. Useful when:
 *   - Tuning the scoring rubric
 *   - Refreshing expected answers after env state changes
 *   - Re-checking a prior run after a fix to confirm it now passes
 */
import { readFileSync } from 'node:fs';
import type {
  CampaignHeroSpec,
  CampaignVerdict,
  ExpectedAnswer,
  GapRecord,
  PatternMatchScore,
  ChainAlignmentScore,
} from './types.js';
import {
  validateClaims,
  extractAgentTopPatterns,
  scoreTopNMatch,
  scoreChainAlignment,
  extractToolChainFromBash,
  type HeroOracleReport,
} from './hero-oracle.js';
import { patternExists } from './prom-oracle.js';
import type { EvalEnv } from './env.js';

export interface SavedTranscript {
  spec: { id: string; title?: string; prompt: string };
  bashCommands: Array<{ cmd: string; stdout: string; stderr: string; exitCode: number; durationMs: number }>;
  finalText: string;
}

export interface CampaignScoringInput {
  transcript: SavedTranscript;
  spec: CampaignHeroSpec;
  env: EvalEnv;
  judgeScores?: { value_delivered: number; value_received: number };
}

export interface CampaignScoringResult {
  verdict: CampaignVerdict;
  oracle: HeroOracleReport;
  patternMatch: PatternMatchScore;
  chainAlignment: ChainAlignmentScore;
  gaps: GapRecord[];
}

const DRIFT_THRESHOLD = 0;
const PATTERN_MATCH_THRESHOLD = 0.7;
const CHAIN_THRESHOLD = 0.7;
const VALUE_THRESHOLD = 0.7;

export async function scoreAgainstExpected(
  input: CampaignScoringInput
): Promise<CampaignScoringResult> {
  const { transcript, spec, env, judgeScores } = input;
  const expected: ExpectedAnswer | undefined = spec.expected_answer;
  const runTs = new Date().toISOString();

  // ── Axis 1: drift via oracle ───────────────────────────────────────
  const oracle = await validateClaims(transcript.finalText, env);

  // ── Axis 2: top-N pattern match ────────────────────────────────────
  // Two-layer match:
  //   (a) does the agent name patterns in oracle's pre-computed
  //       top-N? (strict)
  //   (b) for any agent pattern NOT in (a), does it actually exist in
  //       Prometheus metrics with positive 24h volume? (loose;
  //       catches fabrications without penalizing legitimate
  //       alternative-window picks)
  // The campaign's purpose is anti-hallucination — a queryable real
  // pattern is a passing answer even if it's not in our specific
  // window's top-N.
  const oracleTop = (expected?.top_patterns ?? []).map((p) => p.name);
  const agentTop = extractAgentTopPatterns(transcript.finalText, Math.max(3, oracleTop.length));
  const tnRaw = scoreTopNMatch(agentTop, oracleTop);

  // For agent patterns that didn't strict-match, verify they exist
  // in metrics. Each existence-check is one Prom query.
  const matchedNames = new Set(tnRaw.matched_names);
  let realButNotTopN = 0;
  for (const agentPat of agentTop) {
    if ([...matchedNames].some((m) => m.toLowerCase() === agentPat.toLowerCase())) continue;
    try {
      const bytes = await patternExists(env, agentPat, '24h');
      if (bytes > 0) realButNotTopN++;
    } catch {
      // ignore; we don't penalize on transient prom errors
    }
  }

  const totalNamed = agentTop.length;
  const realNamed = tnRaw.matched + realButNotTopN;
  // Combined score: how many of the agent's named patterns are real?
  // If the agent named 3 patterns and all 3 are real → 1.0. Even if
  // none matched the strict top-N, queryable real patterns still
  // count.
  const combinedScore =
    totalNamed === 0
      ? oracleTop.length === 0
        ? 1
        : 0
      : realNamed / totalNamed;

  const patternMatch: PatternMatchScore = {
    agent_top_patterns: agentTop,
    oracle_top_patterns: oracleTop,
    matched: realNamed,
    missed: tnRaw.missed,
    extra: totalNamed - realNamed,
    score: combinedScore,
  };

  // ── Axis 3: tool-chain alignment ──────────────────────────────────
  const expectedChain = expected?.expected_tool_chain ?? [];
  const actualChain = extractToolChainFromBash(transcript.bashCommands);
  const chRaw = scoreChainAlignment(expectedChain, actualChain);
  const chainAlignment: ChainAlignmentScore = {
    expected: expectedChain,
    actual: actualChain,
    hits: chRaw.hits,
    misses: chRaw.misses,
    score: chRaw.score,
  };

  // ── Axes 4–5: judge (passed in from caller) ───────────────────────
  const valueDelivered = judgeScores?.value_delivered ?? -1;
  const valueReceived = judgeScores?.value_received ?? -1;

  // ── must_mention / must_not_mention quick checks ──────────────────
  const driftFromMustMention: string[] = [];
  if (expected?.must_mention) {
    for (const phrase of expected.must_mention) {
      if (!transcript.finalText.toLowerCase().includes(phrase.toLowerCase())) {
        driftFromMustMention.push(`missing must-mention "${phrase}"`);
      }
    }
  }
  const driftFromMustNotMention: string[] = [];
  if (expected?.must_not_mention) {
    for (const phrase of expected.must_not_mention) {
      if (transcript.finalText.toLowerCase().includes(phrase.toLowerCase())) {
        driftFromMustNotMention.push(`hit must-not-mention "${phrase}"`);
      }
    }
  }

  // ── PASS gate ─────────────────────────────────────────────────────
  // value_delivered = -1 means judge errored / wasn't run. Treat as
  // unknown — we don't gate on it but we record it.
  const passDrift = oracle.driftScore === DRIFT_THRESHOLD && driftFromMustMention.length === 0 && driftFromMustNotMention.length === 0;
  const passPattern = oracleTop.length === 0 || patternMatch.score >= PATTERN_MATCH_THRESHOLD;
  const passChain = expectedChain.length === 0 || chainAlignment.score >= CHAIN_THRESHOLD;
  const passValue = valueDelivered < 0 || valueDelivered >= VALUE_THRESHOLD;
  const passed = passDrift && passPattern && passChain && passValue;

  const axesSummary =
    `drift=${oracle.driftScore}/${oracle.numericClaimCount + oracle.patternClaimCount} ` +
    `pattern_match=${patternMatch.matched}/${oracleTop.length}=${patternMatch.score.toFixed(2)} ` +
    `chain=${chainAlignment.hits.length}/${expectedChain.length}=${chainAlignment.score.toFixed(2)} ` +
    `value_delivered=${valueDelivered.toFixed(2)} value_received=${valueReceived.toFixed(2)}`;

  const verdict: CampaignVerdict = {
    drift_score: oracle.driftScore + driftFromMustMention.length + driftFromMustNotMention.length,
    drift_supported: oracle.supported,
    drift_inconclusive: oracle.inconclusive,
    pattern_match: patternMatch,
    chain_alignment: chainAlignment,
    value_delivered: valueDelivered,
    value_received: valueReceived,
    passed,
    axes_summary: axesSummary,
  };

  // ── Emit gap records for failing axes ─────────────────────────────
  const gaps: GapRecord[] = [];
  if (!passDrift) {
    gaps.push({
      question_id: spec.id,
      run_timestamp: runTs,
      gap_kind: 'drift',
      gap_description: `Drift on ${oracle.driftScore + driftFromMustMention.length + driftFromMustNotMention.length} claim(s)`,
      expected_answer_excerpt: expected?.summary ?? '(no summary)',
      actual_answer_excerpt: transcript.finalText.slice(0, 400),
      fix_status: 'open',
      notes: [
        ...oracle.details.filter((d) => d.status === 'unsupported').map((d) => `unsupported: ${d.claim} — ${d.oracleResult}`),
        ...driftFromMustMention,
        ...driftFromMustNotMention,
      ],
    });
  }
  if (!passPattern) {
    gaps.push({
      question_id: spec.id,
      run_timestamp: runTs,
      gap_kind: 'pattern_miss',
      gap_description: `Top-N pattern match ${patternMatch.score.toFixed(2)} < ${PATTERN_MATCH_THRESHOLD}; matched ${tnRaw.matched_names.join(', ') || '(none)'}`,
      expected_answer_excerpt: `Oracle top: ${oracleTop.join(', ')}`,
      actual_answer_excerpt: `Agent top: ${agentTop.join(', ')}`,
      fix_status: 'open',
      notes: [`agent_top=${JSON.stringify(agentTop)}`, `oracle_top=${JSON.stringify(oracleTop)}`],
    });
  }
  if (!passChain) {
    gaps.push({
      question_id: spec.id,
      run_timestamp: runTs,
      gap_kind: 'chain_miss',
      gap_description: `Tool-chain alignment ${chainAlignment.score.toFixed(2)} < ${CHAIN_THRESHOLD}; missed ${chainAlignment.misses.join(', ')}`,
      expected_answer_excerpt: `Expected chain: ${expectedChain.join(' → ')}`,
      actual_answer_excerpt: `Actual chain: ${actualChain.join(' → ') || '(none)'}`,
      fix_status: 'open',
      notes: [],
    });
  }
  if (valueDelivered >= 0 && !passValue) {
    gaps.push({
      question_id: spec.id,
      run_timestamp: runTs,
      gap_kind: 'low_value',
      gap_description: `value_delivered ${valueDelivered.toFixed(2)} < ${VALUE_THRESHOLD}`,
      expected_answer_excerpt: expected?.summary ?? '(no summary)',
      actual_answer_excerpt: transcript.finalText.slice(0, 400),
      fix_status: 'open',
      notes: [],
    });
  }
  if (valueReceived >= 0 && valueReceived < VALUE_THRESHOLD) {
    gaps.push({
      question_id: spec.id,
      run_timestamp: runTs,
      gap_kind: 'low_received',
      gap_description: `value_received ${valueReceived.toFixed(2)} < ${VALUE_THRESHOLD} — MCP returned thin/stub data`,
      expected_answer_excerpt: '(MCP-side fix candidate)',
      actual_answer_excerpt: transcript.finalText.slice(0, 400),
      fix_status: 'open',
      notes: [],
    });
  }

  return { verdict, oracle, patternMatch, chainAlignment, gaps };
}

/**
 * Load a transcript (matches the hero-runner's transcript.json
 * structure) from disk.
 */
export function loadTranscript(path: string): SavedTranscript {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    spec: { id: raw.spec.id, title: raw.spec.title, prompt: raw.spec.prompt },
    bashCommands: raw.bashCommands ?? [],
    finalText: raw.finalText ?? '',
  };
}
