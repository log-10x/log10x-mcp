/**
 * LLM-judge — calls Claude Sonnet 4.6 to score reasoning, accuracy, and
 * hallucination on a completed transcript.
 *
 * Why Sonnet, not Opus: structured grading against an explicit rubric is
 * a poor fit for the most expensive model. Sonnet 4.6 is sufficient for
 * 6-axis 0-2 scoring at ~5× the cost savings. If we ever see judge-vs-
 * human-grader divergence, the right answer is to tighten the rubric or
 * recalibrate fixtures, not to upgrade to Opus.
 *
 * What the judge sees: scenario context, expected sequence, ground-truth
 * pass/fail, the actual tool sequence, top-5 result previews (truncated
 * to ~2k chars each), and the agent's final synthesis.
 *
 * What the judge returns: a JSON object with sub-scores 0-2 per
 * dimension and a free-form `flags` list. The autonomy axis is NOT
 * scored here — it's deterministic (autonomy-metrics.ts).
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  JudgeVerdict,
  Scenario,
  GroundTruthResult,
  SequenceDiff,
} from './types.js';
import type { ParsedTranscript } from './transcript-parser.js';

const JUDGE_MODEL = 'claude-sonnet-4-6';
const RESULT_PREVIEW_BYTES = 2000;
// Show every tool call's result preview to the judge. Earlier this was
// capped at 5, which produced false-positive hallucination flags when
// the agent quoted numbers from the 6th-or-later tool call (e.g. a
// pattern_trend result the judge couldn't see). The judge can't grade
// "did the agent fabricate this number" if it can't see the tool that
// produced the number.
const MAX_RESULTS_SHOWN = 20;

export interface JudgeInput {
  scenario: Scenario;
  parsed: ParsedTranscript;
  sequenceDiff: SequenceDiff;
  groundTruth: GroundTruthResult[];
}

const SYSTEM_PROMPT = `You are an expert evaluator for an MCP-driven log/observability agent.

You will see (1) a scenario the agent was asked to handle, (2) the canonical
chain it should have walked, (3) deterministic ground-truth assertions and
whether they passed, (4) the tools the agent actually called and a preview
of each result, and (5) the agent's final synthesis text.

Your job: score the agent on six dimensions, each 0-2 (0 = fails, 1 = partial,
2 = excellent). Hallucination is inverted: 0 = no hallucination (good),
1 = mild fabrication or unsupported numeric claim (bad).

Dimensions:
  - tool_selection: did the agent pick the right tools for the question?
  - parameters: were tool args sensible (right service, time range, ids)?
  - sequencing: did the agent walk a coherent chain (event_lookup →
    investigate → dependency_check, not random one-shots)?
  - accuracy: does the final synthesis match the actual tool outputs?
  - hallucination (0=none, 1=present): did the agent invent numbers,
    pattern names, or claims not present in tool results?
  - follow_through: did the agent answer the user's actual question, not
    a watered-down version, and avoid stalling for clarification when a
    next step was obvious?

Return ONLY a JSON object with this shape:
{
  "scoresRaw": {
    "tool_selection": <0-2>,
    "parameters": <0-2>,
    "sequencing": <0-2>,
    "accuracy": <0-2>,
    "hallucination": <0-1>,
    "follow_through": <0-2>
  },
  "rationale": {
    "tool_selection": "<one sentence>",
    "parameters": "<one sentence>",
    "sequencing": "<one sentence>",
    "accuracy": "<one sentence>",
    "hallucination": "<one sentence>",
    "follow_through": "<one sentence>"
  },
  "flags": ["<short tag>", ...]
}

Common flags: "unsupported_number", "missed_chain_link", "stalled",
"premature_termination", "wrong_tool", "good_alternate_chain". Use
"good_alternate_chain" if the agent took a sensible path that wasn't the
canonical must_include chain — don't penalize it twice for sequencing.

Output JSON ONLY. No prose around it. No markdown fence.`;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated, ${s.length - max} more bytes]`;
}

function buildUserMessage(input: JudgeInput): string {
  const { scenario, parsed, sequenceDiff, groundTruth } = input;

  const previews = parsed.toolCalls.slice(0, MAX_RESULTS_SHOWN).map((c, idx) => {
    const r = parsed.toolResults.find((x) => x.tool_use_id === c.id);
    const text = r ? r.text : '<no result>';
    return [
      `--- Tool call ${idx + 1}: ${c.name} ---`,
      `args: ${JSON.stringify(c.input)}`,
      `result preview:`,
      truncate(text, RESULT_PREVIEW_BYTES),
    ].join('\n');
  }).join('\n\n');

  const gtSummary = groundTruth
    .map((g) => `- [${g.passed ? 'PASS' : 'FAIL'}] ${g.description} — ${g.detail}`)
    .join('\n');

  const seqSummary = [
    `expected (must_include): ${sequenceDiff.expected.join(' → ') || '<none>'}`,
    `actual: ${sequenceDiff.actual.join(' → ') || '<none>'}`,
    `missing: ${sequenceDiff.missing.join(', ') || 'none'}`,
    `must_not_include violations: ${sequenceDiff.mustNotIncludeViolations.join(', ') || 'none'}`,
    `subsequence satisfied: ${sequenceDiff.satisfied}`,
  ].join('\n');

  return [
    `# Scenario\n${scenario.title}\n\n${scenario.description}`,
    `# User prompt\n${scenario.prompt}`,
    `# Expected sequence\n${seqSummary}`,
    `# Ground truth\n${gtSummary || '(none)'}`,
    `# Tool calls + result previews\n${previews || '(none)'}`,
    `# Agent final text\n${truncate(parsed.finalText, 4000) || '(empty)'}`,
  ].join('\n\n');
}

interface AnthropicLike {
  messages: {
    create(opts: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: 'user'; content: string }>;
    }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

/**
 * Call the judge. Throws if ANTHROPIC_API_KEY is not set, or if the
 * response can't be JSON-parsed (rather than silently producing 0
 * scores — flaky judging is far worse than a loud failure).
 */
export async function runJudge(input: JudgeInput): Promise<JudgeVerdict> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'runJudge requires ANTHROPIC_API_KEY env var. ' +
        'Set it to skip-or-run the LLM-judge phase explicitly via --no-judge.'
    );
  }
  const client = new Anthropic() as unknown as AnthropicLike;
  const resp = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(input) }],
  });
  const block = resp.content.find((b) => b.type === 'text');
  if (!block || !block.text) {
    throw new Error('Judge returned no text block');
  }
  // Strip optional markdown fence if Sonnet adds one despite instructions.
  const cleaned = block.text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  let parsed: Partial<JudgeVerdict>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(
      `Judge returned non-JSON: ${(e as Error).message}\nRaw: ${cleaned.slice(0, 500)}`
    );
  }
  if (!parsed.scoresRaw || !parsed.rationale) {
    throw new Error(`Judge response missing scoresRaw/rationale: ${JSON.stringify(parsed)}`);
  }
  return {
    model: JUDGE_MODEL,
    scoresRaw: parsed.scoresRaw,
    rationale: parsed.rationale,
    flags: parsed.flags ?? [],
  };
}

/**
 * Convert raw 0-2 sub-scores into the report's normalized 0..1 axes.
 *
 *   reasoning = avg(tool_selection, parameters, sequencing) / 2
 *   value     = avg(accuracy, follow_through) / 2
 *   hallucination is already 0..1
 */
export function normalizeJudgeScores(verdict: JudgeVerdict): {
  reasoning: number;
  value: number;
  hallucination: number;
} {
  const s = verdict.scoresRaw;
  return {
    reasoning: (s.tool_selection + s.parameters + s.sequencing) / 6,
    value: (s.accuracy + s.follow_through) / 4,
    hallucination: s.hallucination,
  };
}
