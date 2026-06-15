/**
 * Two-check product-QA judge — grades an answer to a docs-FAQ question on
 * two INDEPENDENT axes, each its own LLM call so neither check anchors
 * the other:
 *
 *   1. SOURCED — is every factual claim in the answer supported by the
 *      ground-truth doc excerpt (the faq-bank entry for that question)?
 *      Catches fabrication and training-data leakage.
 *   2. ON-MESSAGE — does the answer respect the positioning rules
 *      (eval/fixtures/on-message-rules.md)? Catches claims that may even
 *      appear in stale docs but are off-message (universal lossless,
 *      per-GB pricing, archive framing, invented identifiers...).
 *
 * Ground truth comes from eval/fixtures/faq-bank.json, which is DERIVED
 * from the mksite docs corpus (the same corpus product_qa serves), so the
 * judge can never drift from what the tool actually grounds on.
 *
 * Same model policy as judge.ts: Sonnet — structured grading against an
 * explicit rubric does not need the most expensive model.
 */
import Anthropic from '@anthropic-ai/sdk';

export const PRODUCT_QA_JUDGE_MODEL = 'claude-sonnet-4-6';

export interface ProductQaCase {
  id: string;
  question: string;
  /** The agent/tool answer under judgment. */
  answer: string;
  /** Ground truth from the faq-bank entry; null when the question is
   *  intentionally outside the corpus (the correct answer is a decline). */
  groundTruth: {
    answer_md: string;
    url: string;
    source_file: string;
  } | null;
}

export interface SourcedVerdict {
  /** 2 = every claim supported (or correct decline); 1 = minor unsupported
   *  additions; 0 = fabricated or contradicting claims. */
  score: 0 | 1 | 2;
  unsupported_claims: string[];
  rationale: string;
}

export interface OnMessageVerdict {
  /** 2 = no violations; 1 = borderline phrasing; 0 = clear violation(s). */
  score: 0 | 1 | 2;
  violations: Array<{ rule: string; claim: string }>;
  rationale: string;
}

export interface ProductQaVerdict {
  id: string;
  sourced: SourcedVerdict;
  on_message: OnMessageVerdict;
  /** Both checks at full marks. */
  pass: boolean;
}

const SOURCED_SYSTEM = `You are a strict grounding auditor for a product
documentation Q&A system. You will see a user question, the GROUND-TRUTH
documentation excerpt that answers it (or a note that the question is
outside the documentation), and an answer produced by an AI agent.

Your single job: decide whether every factual claim in the answer is
supported by the ground-truth excerpt. You are NOT grading style,
completeness, or helpfulness — only grounding.

Rules:
- A claim is supported if the excerpt states it or it is a faithful
  paraphrase. Reasonable rewording, reordering, and omission are fine.
- A claim is UNSUPPORTED if it adds facts the excerpt does not contain
  (numbers, names, capabilities, limits, endpoints, prices), even when the
  claim happens to be plausible or true elsewhere.
- A claim CONTRADICTING the excerpt is fabrication.
- If the ground truth is OUTSIDE-CORPUS: the correct answer declines or
  says the docs do not cover it. A decline scores 2. Any substantive
  answer scores 0 (it cannot be grounded).
- If ground truth exists but the answer declines anyway, score 1 (honest
  but a retrieval miss).

Scoring: 2 = all claims supported, or correct decline; 1 = supported core
with minor unsupported additions, or an unnecessary decline; 0 = any
fabricated/contradicting claim, or a substantive answer to an
outside-corpus question.

Return ONLY a JSON object:
{"score": <0|1|2>, "unsupported_claims": ["<claim>", ...], "rationale": "<one or two sentences>"}`;

const ON_MESSAGE_SYSTEM = `You are a positioning compliance auditor for a
product called 10x (company: log10x). You will see a numbered rule set,
a user question (context only), and an answer produced by an AI agent.

Your single job: find violations of the rules in the ANSWER. You are NOT
grading grounding, accuracy, style, or completeness — only rule
compliance. Judge only what the answer asserts; do not invent violations
from what it omits.

Scoring: 2 = no violations; 1 = borderline phrasing that skirts a rule
without clearly breaking it; 0 = one or more clear violations.

Return ONLY a JSON object:
{"score": <0|1|2>, "violations": [{"rule": "<rule id>", "claim": "<the offending text>"}, ...], "rationale": "<one or two sentences>"}`;

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('judge returned no JSON object: ' + text.slice(0, 200));
  }
  return JSON.parse(text.slice(start, end + 1));
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

async function call(
  client: AnthropicLike,
  system: string,
  user: string,
): Promise<unknown> {
  const res = await client.messages.create({
    model: PRODUCT_QA_JUDGE_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  return extractJson(text);
}

function clampScore(v: unknown): 0 | 1 | 2 {
  const n = Number(v);
  if (n <= 0) return 0;
  if (n >= 2) return 2;
  return 1;
}

export async function judgeSourced(
  c: ProductQaCase,
  client: AnthropicLike,
): Promise<SourcedVerdict> {
  const gt = c.groundTruth
    ? [
        `# Ground-truth excerpt (from ${c.groundTruth.source_file}, ${c.groundTruth.url})`,
        c.groundTruth.answer_md,
      ].join('\n')
    : '# Ground truth\nOUTSIDE-CORPUS: the documentation does not cover this question. The correct answer is a decline.';
  const user = [
    `# Question\n${c.question}`,
    gt,
    `# Answer under judgment\n${c.answer}`,
  ].join('\n\n');
  const raw = (await call(client, SOURCED_SYSTEM, user)) as Record<string, unknown>;
  return {
    score: clampScore(raw.score),
    unsupported_claims: Array.isArray(raw.unsupported_claims)
      ? raw.unsupported_claims.map(String)
      : [],
    rationale: String(raw.rationale ?? ''),
  };
}

export async function judgeOnMessage(
  c: ProductQaCase,
  client: AnthropicLike,
  rules: string,
): Promise<OnMessageVerdict> {
  const user = [
    `# Rules\n${rules}`,
    `# Question (context only)\n${c.question}`,
    `# Answer under judgment\n${c.answer}`,
  ].join('\n\n');
  const raw = (await call(client, ON_MESSAGE_SYSTEM, user)) as Record<string, unknown>;
  const violations = Array.isArray(raw.violations)
    ? raw.violations.map((v) => {
        const o = v as Record<string, unknown>;
        return { rule: String(o.rule ?? '?'), claim: String(o.claim ?? '') };
      })
    : [];
  return {
    score: clampScore(raw.score),
    violations,
    rationale: String(raw.rationale ?? ''),
  };
}

export async function judgeProductQa(
  c: ProductQaCase,
  client: AnthropicLike,
  rules: string,
): Promise<ProductQaVerdict> {
  const [sourced, onMessage] = await Promise.all([
    judgeSourced(c, client),
    judgeOnMessage(c, client, rules),
  ]);
  return {
    id: c.id,
    sourced,
    on_message: onMessage,
    pass: sourced.score === 2 && onMessage.score === 2,
  };
}

export function makeClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is required to run the product-QA judge');
  }
  return new Anthropic({ apiKey: key });
}
