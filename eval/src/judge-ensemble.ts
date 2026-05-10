/**
 * Multi-judge ensemble — re-scores a hero transcript across multiple
 * judge models in parallel, computes σ per axis, surfaces
 * disagreements > 0.2 as calibration issues.
 *
 * Distinct from src/judge.ts (which scores the original Scenario
 * shape used by the deterministic/autonomous runners): the campaign
 * uses HeroSpec + expected_answer, so this ensemble grades the same
 * inputs the campaign scorer uses.
 *
 * Default: Sonnet 4.6 + Opus 4.7 (both via Anthropic SDK; one API
 * key, two model strings). Optional: Grok-4 via xAI API when
 * XAI_API_KEY is set.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { CampaignHeroSpec } from './types.js';
import type { SavedTranscript } from './campaign-scorer.js';

// Alias so the export surface reads naturally for callers.
export type HeroTranscript = SavedTranscript;

export interface EnsembleScore {
  model: string;
  value_delivered: number; // 0..1
  value_received: number;  // 0..1
  rationale: string;
  flags: string[];
}

export interface EnsembleResult {
  scenario_id: string;
  scores: EnsembleScore[];
  // σ across all judges per axis
  value_delivered_sigma: number;
  value_received_sigma: number;
  // pairwise diffs (model_a vs model_b)
  pairwise: Array<{ a: string; b: string; vd_diff: number; vr_diff: number }>;
  // Are any axes flagged as disagreement?
  any_disagreement: boolean;
}

const ENSEMBLE_PROMPT = (spec: CampaignHeroSpec, transcript: SavedTranscript) => `You are grading the answer an autonomous agent gave to an SRE question. Score the agent's final synthesis on two axes:

- value_delivered (0.0 to 1.0): did the synthesis answer the user's actual question with traceable, oracle-consistent facts?
- value_received (0.0 to 1.0): did the agent get useful data back from the MCP tools it called (or was the chain thin / stub-data)?

QUESTION ASKED:
${spec.prompt}

EXPECTED ANSWER (independently computed from oracle BEFORE the agent ran):
${JSON.stringify(spec.expected_answer ?? {}, null, 2)}

AGENT'S FINAL SYNTHESIS:
${transcript.finalText.slice(0, 6000)}

Return ONLY this JSON, no prose:
{
  "value_delivered": <0.0-1.0>,
  "value_received": <0.0-1.0>,
  "rationale": "<2-3 sentences>",
  "flags": ["<short-tag>", ...]
}`;

async function callAnthropicModel(modelId: string, prompt: string): Promise<EnsembleScore> {
  const client = new Anthropic();
  const r = await client.messages.create({
    model: modelId,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('');
  const parsed = parseJsonObject(text);
  return {
    model: modelId,
    value_delivered: clamp01(parsed.value_delivered),
    value_received: clamp01(parsed.value_received),
    rationale: String(parsed.rationale ?? ''),
    flags: Array.isArray(parsed.flags) ? parsed.flags.map(String) : [],
  };
}

async function callGrokModel(prompt: string): Promise<EnsembleScore> {
  // xAI's API is OpenAI-compatible; use plain fetch to avoid a new SDK.
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not set');
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-4-latest',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Grok API ${r.status}: ${body.slice(0, 300)}`);
  }
  const j = (await r.json()) as { choices: Array<{ message: { content: string } }> };
  const text = j.choices?.[0]?.message?.content ?? '';
  const parsed = parseJsonObject(text);
  return {
    model: 'grok-4',
    value_delivered: clamp01(parsed.value_delivered),
    value_received: clamp01(parsed.value_received),
    rationale: String(parsed.rationale ?? ''),
    flags: Array.isArray(parsed.flags) ? parsed.flags.map(String) : [],
  };
}

export async function judgeEnsemble(
  spec: CampaignHeroSpec,
  transcript: SavedTranscript
): Promise<EnsembleResult> {
  const prompt = ENSEMBLE_PROMPT(spec, transcript);

  const tasks: Array<Promise<EnsembleScore>> = [
    callAnthropicModel('claude-sonnet-4-6', prompt),
    callAnthropicModel('claude-opus-4-7', prompt),
  ];
  if (process.env.XAI_API_KEY) {
    tasks.push(callGrokModel(prompt));
  }

  const results = await Promise.allSettled(tasks);
  const scores: EnsembleScore[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') scores.push(r.value);
    else {
      console.error(`[ensemble] judge failed: ${r.reason}`);
    }
  }

  if (scores.length === 0) {
    throw new Error('all judges failed; see stderr for details');
  }

  const vds = scores.map((s) => s.value_delivered);
  const vrs = scores.map((s) => s.value_received);
  const vd_sigma = stddev(vds);
  const vr_sigma = stddev(vrs);

  const pairwise: EnsembleResult['pairwise'] = [];
  for (let i = 0; i < scores.length; i++) {
    for (let j = i + 1; j < scores.length; j++) {
      pairwise.push({
        a: scores[i].model,
        b: scores[j].model,
        vd_diff: Math.abs(scores[i].value_delivered - scores[j].value_delivered),
        vr_diff: Math.abs(scores[i].value_received - scores[j].value_received),
      });
    }
  }

  const anyDisagreement = pairwise.some((p) => p.vd_diff > 0.2 || p.vr_diff > 0.2);

  return {
    scenario_id: spec.id,
    scores,
    value_delivered_sigma: vd_sigma,
    value_received_sigma: vr_sigma,
    pairwise,
    any_disagreement: anyDisagreement,
  };
}

function clamp01(n: unknown): number {
  const x = typeof n === 'number' ? n : parseFloat(String(n));
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  // Try direct parse first.
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall back: find first { and last } and try the substring.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new Error(`judge returned non-JSON output: ${trimmed.slice(0, 200)}`);
  }
}

export function renderEnsembleMarkdown(results: EnsembleResult[]): string {
  const lines: string[] = [];
  lines.push('# Multi-judge ensemble');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Per-scenario scores');
  lines.push('');
  const judges = new Set<string>();
  for (const r of results) for (const s of r.scores) judges.add(s.model);
  const judgeList = [...judges];

  const headerCols = ['Scenario'];
  for (const m of judgeList) headerCols.push(`${m} vd`, `${m} vr`);
  headerCols.push('vd σ', 'vr σ', 'disagreement?');
  lines.push('| ' + headerCols.join(' | ') + ' |');
  lines.push('|' + headerCols.map(() => '---').join('|') + '|');

  for (const r of results) {
    const row: string[] = [`\`${r.scenario_id}\``];
    for (const m of judgeList) {
      const s = r.scores.find((x) => x.model === m);
      row.push(s ? s.value_delivered.toFixed(2) : '—', s ? s.value_received.toFixed(2) : '—');
    }
    row.push(r.value_delivered_sigma.toFixed(3), r.value_received_sigma.toFixed(3), r.any_disagreement ? 'YES' : 'no');
    lines.push('| ' + row.join(' | ') + ' |');
  }

  lines.push('');
  lines.push('## Pairwise diffs (max |Δ| across all scenarios)');
  lines.push('');
  const pairs: Record<string, { vd: number; vr: number }> = {};
  for (const r of results) {
    for (const p of r.pairwise) {
      const key = `${p.a} vs ${p.b}`;
      if (!pairs[key]) pairs[key] = { vd: 0, vr: 0 };
      pairs[key].vd = Math.max(pairs[key].vd, p.vd_diff);
      pairs[key].vr = Math.max(pairs[key].vr, p.vr_diff);
    }
  }
  lines.push('| Pair | max vd diff | max vr diff |');
  lines.push('|---|---|---|');
  for (const [key, v] of Object.entries(pairs)) {
    lines.push(`| ${key} | ${v.vd.toFixed(2)} | ${v.vr.toFixed(2)} |`);
  }
  lines.push('');
  lines.push('## Calibration flags');
  lines.push('');
  for (const r of results) {
    if (!r.any_disagreement) continue;
    lines.push(`- \`${r.scenario_id}\`: σ(vd)=${r.value_delivered_sigma.toFixed(3)}, σ(vr)=${r.value_received_sigma.toFixed(3)}`);
    for (const s of r.scores) {
      lines.push(`  - ${s.model}: vd=${s.value_delivered.toFixed(2)} vr=${s.value_received.toFixed(2)} — ${s.rationale.slice(0, 200)}`);
    }
  }
  if (!results.some((r) => r.any_disagreement)) {
    lines.push('(none — all judges within 0.2 on every axis)');
  }
  return lines.join('\n') + '\n';
}
