/**
 * LLM mini-classifier for shapes that deterministic checks miss.
 *
 * One Sonnet call per scenario, ~$0.05. Returns structured booleans /
 * enums the scorer can compare against the spec's expected fields.
 * Opt-in per spec via `enable_llm_classifier_axes`.
 *
 * Closes (or partially closes) these shapes:
 *   - direction-inversion: when oracle says FLAT but the agent says UP/DOWN
 *   - window-confusion: when the agent answers about a different window
 *   - rearrangement: facts correct, narrative framing wrong
 *   - citation-drift: source attribution to the wrong tool
 *
 * Returns minimal structured output; if Sonnet returns anything other
 * than well-formed JSON, the scorer treats the axis as inconclusive
 * (does not gate).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { CampaignHeroSpec, ExpectedAnswer } from './types.js';
import type { SavedTranscript } from './campaign-scorer.js';

export interface ClassifierResult {
  direction?: 'UP' | 'FLAT' | 'DOWN' | 'UNCLEAR';
  window_answered?: string | 'UNCLEAR';
  narrative_frame_correct?: boolean;
  citation_correct?: boolean;
  refused?: boolean;
  notes: string[];
}

export interface ClassifierViolations {
  direction?: { expected: string; actual: string };
  window?: { expected: string; actual: string };
  narrative_frame?: string;
  citation?: string;
  refusal?: string;
}

const CLASSIFIER_MODEL = 'claude-sonnet-4-6';

function buildPrompt(spec: CampaignHeroSpec, transcript: SavedTranscript, axes: string[]): string {
  const ea = spec.expected_answer ?? {};
  const questions: string[] = [];
  if (axes.includes('direction')) {
    questions.push(
      `- "direction": one of UP / FLAT / DOWN / UNCLEAR. Read the agent's synthesis. What direction does it claim for the time-series the question asked about?`
    );
  }
  if (axes.includes('window')) {
    questions.push(
      `- "window_answered": which time window does the agent's synthesis primarily report on? (e.g., "1h", "24h", "7d", "30d", "UNCLEAR"). Be literal — quote what the agent's headline reports, not what the question asked.`
    );
  }
  if (axes.includes('narrative_frame')) {
    questions.push(
      `- "narrative_frame_correct": boolean. Are the facts in the synthesis framed correctly relative to the oracle's expected_answer summary? Specifically: does the synthesis present CURRENT-RANK numbers as GROWTH/CHANGE numbers, or vice versa? false = rearrangement.`
    );
  }
  if (axes.includes('citation')) {
    questions.push(
      `- "citation_correct": boolean. When the agent attributes a number or finding to a specific tool ("according to X", "X confirmed"), is that attribution correct? You don't need to verify every claim, just flag whether ANY attribution is to the WRONG tool. true = OK; false = citation drift.`
    );
  }
  if (axes.includes('refusal')) {
    questions.push(
      `- "refused": boolean. The question is INTENTIONALLY out-of-scope for the available MCP tools. Did the agent's final synthesis acknowledge that it cannot answer / refuse / scope-out — OR did it fabricate an answer? true = agent refused (correct); false = agent fabricated.`
    );
  }
  return `You are grading one focused aspect of an agent's final answer. You'll get the question, the oracle's ground-truth summary, the agent's final synthesis, and a list of axes to classify.

QUESTION ASKED:
${spec.prompt}

ORACLE GROUND TRUTH:
${JSON.stringify(ea, null, 2)}

AGENT'S FINAL SYNTHESIS:
${transcript.finalText.slice(0, 6000)}

Classify the following axes. Return ONLY a JSON object with these keys (no prose, no markdown fence):

${questions.join('\n')}
- "notes": short array of strings, each a one-sentence explanation of any axis you flagged.

JSON only.`;
}

export async function classifyShapes(
  spec: CampaignHeroSpec,
  transcript: SavedTranscript
): Promise<ClassifierResult | null> {
  const ea = spec.expected_answer;
  const axes = ea?.enable_llm_classifier_axes ?? [];
  if (axes.length === 0) return null;

  const client = new Anthropic();
  try {
    const r = await client.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: buildPrompt(spec, transcript, axes) }],
    });
    const text = r.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('')
      .trim();
    const parsed = parseJsonObject(text);
    return {
      direction: clampDirection(parsed.direction),
      window_answered: typeof parsed.window_answered === 'string' ? parsed.window_answered : undefined,
      narrative_frame_correct:
        typeof parsed.narrative_frame_correct === 'boolean' ? parsed.narrative_frame_correct : undefined,
      citation_correct: typeof parsed.citation_correct === 'boolean' ? parsed.citation_correct : undefined,
      refused: typeof parsed.refused === 'boolean' ? parsed.refused : undefined,
      notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [],
    };
  } catch (e) {
    // Classifier errored — treat axis as inconclusive (does not gate).
    return null;
  }
}

export function detectViolations(
  ea: ExpectedAnswer | undefined,
  cl: ClassifierResult | null
): ClassifierViolations {
  if (!ea || !cl) return {};
  const v: ClassifierViolations = {};
  const axes = ea.enable_llm_classifier_axes ?? [];
  if (axes.includes('direction') && ea.expected_direction && cl.direction && cl.direction !== 'UNCLEAR') {
    if (cl.direction !== ea.expected_direction) {
      v.direction = { expected: ea.expected_direction, actual: cl.direction };
    }
  }
  if (axes.includes('window') && ea.expected_window && cl.window_answered && cl.window_answered !== 'UNCLEAR') {
    // Normalize ("1 hour" -> "1h", etc.) by stripping spaces / words.
    const norm = (s: string) => s.toLowerCase().replace(/[^0-9a-z]/g, '').replace(/(hour|hr|hours)/g, 'h').replace(/(day|days|d)/g, 'd');
    if (norm(cl.window_answered) !== norm(ea.expected_window)) {
      v.window = { expected: ea.expected_window, actual: cl.window_answered };
    }
  }
  if (axes.includes('narrative_frame') && cl.narrative_frame_correct === false) {
    v.narrative_frame = (cl.notes ?? []).find((n) => /frame|rearrang/i.test(n)) ?? 'narrative frame mismatch';
  }
  if (axes.includes('citation') && cl.citation_correct === false) {
    v.citation = (cl.notes ?? []).find((n) => /citat|attribut|source/i.test(n)) ?? 'citation drift';
  }
  if (axes.includes('refusal') && cl.refused === false) {
    v.refusal = (cl.notes ?? []).find((n) => /refus|fabricat|out.of.scope/i.test(n)) ?? 'agent fabricated instead of refusing';
  }
  return v;
}

function clampDirection(v: unknown): ClassifierResult['direction'] {
  if (v === 'UP' || v === 'FLAT' || v === 'DOWN' || v === 'UNCLEAR') return v;
  return undefined;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error('classifier returned non-JSON');
  }
}
