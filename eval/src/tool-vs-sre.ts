/**
 * tool-vs-sre — the scripted A/B/grader loop (validation gate #5).
 *
 * For one cross-pillar incident this:
 *   A) calls the log10x tool ONCE (invokeTool) — ~1s, re-runnable.
 *   B) drives a no-log10x SRE sub-agent with a Bash tool over the SAME
 *      window and the SAME question; it correlates by hand against the
 *      raw pillars (Prometheus + CloudWatch + kubectl).
 *   G) asks a fresh, no-stake grader (Sonnet) to score A and B on the
 *      6-axis cross-pillar rubric, 0-10 per axis.
 *
 * This makes repeatable what was a ~12-minute / ~30-query manual run
 * (see eval/cross-pillar-demo/CROSS-PILLAR-DEEP-TEST.md). It is the
 * regression anchor for the cross-pillar engine fixes: compare A's
 * per-axis MOVEMENT across runs, not raw totals — graders are fresh
 * per run and calibrate differently (run-2 grader scored B 41→47 with
 * no change to B).
 *
 * Models, reuse, and provenance:
 *   - A goes through the exact in-process tool path the sub-agent CLI
 *     uses (invokeTool from tool-registry), so what we grade is what a
 *     real MCP host would see.
 *   - B reuses selectAgentClient + the bash-tool loop shape from
 *     hero-runner (NOT its log10x system prompt — B must NOT know about
 *     log10x; that's the whole point of the baseline).
 *   - The grader is a single Sonnet call, same idiom as hero-runner's
 *     judgeHero. Sonnet is the determinism anchor across runs.
 */

import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalEnv } from './env.js';
import { applyEvalEnvToProcess } from './env.js';
import {
  selectAgentClient,
  computeCostUsd,
  type AgentClient,
  type AgentMessage,
} from './agent-clients.js';
// invokeTool is the same surface eval/bin/mcp-call.mjs uses. Imported
// from the compiled eval output at runtime by the .mjs wrapper; here we
// type it loosely to avoid a hard build-graph edge into the MCP build/.
import { invokeTool } from './tool-registry.js';

const GRADER_MODEL = 'claude-sonnet-4-6';
const DEFAULT_SRE_MODEL = 'claude-sonnet-4-6';
const SRE_MAX_TURNS = (() => {
  const raw = process.env.TVS_SRE_MAX_TURNS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 20; // matches hero-runner; forced synthesis on cap
})();
const SRE_MAX_TOKENS = 4000;
const BASH_TIMEOUT_MS = 60_000;

/** The six axes of the cross-pillar rubric, each scored 0-10. */
export interface AxisScores {
  correlation_correctness: number;
  depth: number;
  hallucination_resistance: number;
  time_to_answer: number;
  durability: number;
  signal_to_noise: number;
}

export const AXES: Array<keyof AxisScores> = [
  'correlation_correctness',
  'depth',
  'hallucination_resistance',
  'time_to_answer',
  'durability',
  'signal_to_noise',
];

export interface ToolVsSreSpec {
  /** Stable id for the artifact dir, e.g. "xpillar-cart-load". */
  id: string;
  /** The log10x tool to run as arm A. */
  tool: string;
  /** Args for arm A (anchor_type/anchor/step/etc). `window` is injected. */
  toolArgs: Record<string, unknown>;
  /**
   * Incident start (ISO). The window for BOTH arms spans
   * [incident_start, now] so it covers the ramp at T even when the run
   * happens hours later. Arm A's relative `window` is computed from this.
   */
  incidentStartIso: string;
  /** One-paragraph plain-English incident framing both arms receive. */
  question: string;
  /**
   * What raw access the SRE arm is told it has. Defaults describe the
   * otel-demo test bed (Prometheus via port-forward, CloudWatch log
   * group, kubectl).
   */
  sreAccess?: string;
}

export interface ArmResult {
  output: string;
  durationMs: number;
  /** Arm B only: the by-hand investigation trace. */
  bashCalls?: number;
  cost?: { inputTokens: number; outputTokens: number; apiCalls: number; usd: number };
}

export interface GradedAxis {
  a: number;
  b: number;
  /** a - b. Positive = tool ahead on this axis. */
  delta: number;
}

export interface ToolVsSreVerdict {
  spec: ToolVsSreSpec;
  startedAt: string;
  endedAt: string;
  envMode: string;
  graderModel: string;
  sreModel: string;
  window: string;
  a: ArmResult;
  b: ArmResult;
  scores: { A: AxisScores; B: AxisScores };
  perAxis: Record<keyof AxisScores, GradedAxis>;
  totals: { A: number; B: number };
  winner: 'A' | 'B' | 'tie';
  graderRationale: Record<string, string>;
  graderSummary: string;
}

function clampScore(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(10, v));
}

function normalizeAxes(raw: Record<string, unknown> | undefined): AxisScores {
  const r = raw ?? {};
  return {
    correlation_correctness: clampScore(r.correlation_correctness),
    depth: clampScore(r.depth),
    hallucination_resistance: clampScore(r.hallucination_resistance),
    time_to_answer: clampScore(r.time_to_answer),
    durability: clampScore(r.durability),
    signal_to_noise: clampScore(r.signal_to_noise),
  };
}

function total(s: AxisScores): number {
  return AXES.reduce((acc, k) => acc + s[k], 0);
}

async function runBash(
  cmd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], { env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* noop */
      }
    }, BASH_TIMEOUT_MS);
  });
}

/** Compute a PromQL-style relative window covering [incidentStart, now]. */
function windowFromIncident(incidentStartIso: string): string {
  const start = Date.parse(incidentStartIso);
  if (!Number.isFinite(start)) return '1h';
  const minutes = Math.ceil((Date.now() - start) / 60_000) + 5; // +5m lead
  return `${minutes}m`;
}

/** Arm A — call the log10x tool once. */
async function runArmA(
  spec: ToolVsSreSpec,
  window: string,
  env: EvalEnv
): Promise<ArmResult> {
  const t0 = Date.now();
  const args = { ...spec.toolArgs, window };
  const result = (await invokeTool(spec.tool, args, env)) as { text: string; isError?: boolean };
  return { output: result.text, durationMs: Date.now() - t0 };
}

const SRE_SYSTEM_PROMPT = `You are a senior site reliability engineer on call. You have a
Bash tool and raw, read-only access to a production-shape observability
stack. You do NOT have any cost/correlation assistant — you investigate
by hand with the primitives below.

You are answering ONE question: given a known incident on one service,
which metrics in the metric store CO-MOVE with it, in what temporal
direction (leads / trails / concurrent), and how confident are you that
each is causally linked versus coincidental? Rank them.

Method expectations (this is how you earn a high score):
  - Pull the anchor's own time series first; establish WHEN it moved.
  - Probe candidate metrics across the SAME window; compare SHAPE and
    TIMING, not just "it's high".
  - Distinguish a genuine co-mover (moved together, plausible mechanism)
    from a flat/steady metric that merely shares labels.
  - Where you can, state lead/lag with a basis (which moved first).
  - Be explicit about confidence and about what you could NOT verify.

Hard rules:
  - Every number in your final answer must come from a command's stdout.
    Never invent values, metric names, or pod names.
  - If a data source is unreachable, say so and proceed with what you
    have — do not fabricate the missing pillar.
  - Read-only only. Do not scale, edit, deploy, or delete anything.

Final answer: a ranked list of co-moving metrics with direction +
confidence + the mechanism you infer, then a one-line bottom line. Keep
it tight (an on-call hand-off, not an essay).`;

/** Arm B — drive a no-log10x SRE sub-agent by hand. */
async function runArmB(
  spec: ToolVsSreSpec,
  window: string,
  sreModel: string
): Promise<ArmResult> {
  const t0 = Date.now();
  const client: AgentClient = selectAgentClient(sreModel);
  const access =
    spec.sreAccess ??
    `  - Metric store: Prometheus at $PROMETHEUS_URL (default http://localhost:9090).
    Query with: curl -s --data-urlencode 'query=...' --data-urlencode 'start=...' \\
      --data-urlencode 'end=...' --data-urlencode 'step=60' "$PROMETHEUS_URL/api/v1/query_range"
    List metric names: curl -s "$PROMETHEUS_URL/api/v1/label/__name__/values"
  - Logs: AWS CloudWatch Logs group /log10x/otel-demo (if AWS creds present):
    aws logs filter-log-events --log-group-name /log10x/otel-demo --start-time <ms> --end-time <ms> --filter-pattern '...'
  - Cluster: kubectl -n otel-demo get/describe (read-only).`;

  const userPrompt = [
    `# Incident`,
    spec.question,
    ``,
    `# Window`,
    `Analyze the absolute window starting at ${spec.incidentStartIso} through now`,
    `(equivalent to the last ${window}). The incident ramp is near the START`,
    `of this window, not at "now" — the load has been sustained since, so a`,
    `"last 15 minutes" probe will miss the ramp. Query the full window.`,
    ``,
    `# Raw access available to you`,
    access,
    ``,
    `Begin. Investigate, then give the ranked co-mover answer.`,
  ].join('\n');

  const messages: AgentMessage[] = [{ role: 'user', content: userPrompt }];
  const tools = [
    {
      name: 'bash',
      description:
        'Run a Bash command, get stdout/stderr/exit code back. Use it to query Prometheus, CloudWatch, and kubectl.',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Bash command to execute.' } },
        required: ['command'],
      },
    },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  let apiCalls = 0;
  let bashCalls = 0;
  let finalText = '';
  let turn = 0;
  while (turn < SRE_MAX_TURNS) {
    turn++;
    const resp = await client.call({
      system: SRE_SYSTEM_PROMPT,
      tools,
      messages,
      maxTokens: SRE_MAX_TOKENS,
    });
    inputTokens += resp.usage.inputTokens;
    outputTokens += resp.usage.outputTokens;
    apiCalls++;
    messages.push({ role: 'assistant', content: resp.content });

    const toolUses = resp.content.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        b.type === 'tool_use'
    );
    const textBlocks = resp.content.filter(
      (b): b is { type: 'text'; text: string } => b.type === 'text'
    );
    if (resp.stopReason === 'end_turn' || toolUses.length === 0) {
      finalText = textBlocks.map((b) => b.text).join('\n');
      break;
    }

    const results: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];
    for (const tu of toolUses) {
      if (tu.name !== 'bash') {
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `Unknown tool ${tu.name}. Only bash is available.`,
          is_error: true,
        });
        continue;
      }
      bashCalls++;
      const cmd = String(tu.input.command ?? '');
      const { stdout, stderr, exitCode } = await runBash(cmd);
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: `exit=${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`.slice(0, 30000),
        is_error: exitCode !== 0,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  // If the SRE used its entire investigation budget without committing to a
  // final synthesis (hit the turn cap mid-dig), force ONE no-tools call so it
  // delivers a ranked answer from what it gathered. Without this the arm can
  // score ~0 purely for running out of turns — an unfair baseline (the first
  // scripted run scored B 1/60 for exactly this).
  if (!finalText.trim()) {
    messages.push({
      role: 'user',
      content:
        'You are out of investigation budget. Do NOT call any more tools. Give your ' +
        'final ranked co-mover answer NOW from what you already gathered: the metrics ' +
        'that co-move with the incident, each one\'s direction (leads/trails/concurrent), ' +
        'your confidence, and the mechanism. If a point is unverified, say so explicitly.',
    });
    const resp = await client.call({ system: SRE_SYSTEM_PROMPT, tools: [], messages, maxTokens: SRE_MAX_TOKENS });
    inputTokens += resp.usage.inputTokens;
    outputTokens += resp.usage.outputTokens;
    apiCalls++;
    finalText = resp.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }

  const cost = computeCostUsd(client.modelId, inputTokens, outputTokens);
  return {
    output: finalText,
    durationMs: Date.now() - t0,
    bashCalls,
    cost: { inputTokens, outputTokens, apiCalls, usd: cost.usd },
  };
}

const GRADER_SYSTEM_PROMPT = `You are a fresh, no-stake evaluator comparing two answers to the
SAME cross-pillar correlation question. One (A) is from an automated
log10x tool; the other (B) is from a senior SRE working by hand. You
do not know or care which is "supposed" to win.

Score EACH answer on six axes, 0-10 (0 = useless, 5 = adequate,
10 = excellent):

  - correlation_correctness: are the claimed co-movers actually the
    right ones for this incident, and are non-movers correctly NOT
    promoted? This is the central axis.
  - depth: lead/lag direction, mechanism, the app request-path — not
    just "CPU is high". Reward identifying the causal chain.
  - hallucination_resistance: every claim traceable to evidence; no
    invented numbers, metric names, or unfounded certainty. Penalize
    confident-but-unprovable verdicts.
  - time_to_answer: how fast / few steps to a usable answer. A tool
    that answers in ~1 call scores high here; a 30-query manual dig
    scores lower.
  - durability: does the answer leave re-runnable artifacts (PromQL,
    stable join provenance, exact metric names) the next on-call can
    re-use, or is it a one-off narrative?
  - signal_to_noise: is the ranked output crisp, or padded with
    near-duplicate / irrelevant entries?

Be specific and strict. Redundant near-duplicate metric families
(e.g. four representations of CPU) hurt signal_to_noise AND depth (they
crowd out the real app-path). Promoting a flat/steady metric to a
"confirmed co-mover" hurts correlation_correctness AND
hallucination_resistance.

Return ONLY this JSON (no prose, no markdown fence):
{
  "A": {"correlation_correctness":0-10,"depth":0-10,"hallucination_resistance":0-10,"time_to_answer":0-10,"durability":0-10,"signal_to_noise":0-10},
  "B": {"correlation_correctness":0-10,"depth":0-10,"hallucination_resistance":0-10,"time_to_answer":0-10,"durability":0-10,"signal_to_noise":0-10},
  "rationale": {"correlation_correctness":"<one sentence comparing A vs B>","depth":"...","hallucination_resistance":"...","time_to_answer":"...","durability":"...","signal_to_noise":"..."},
  "summary": "<two sentences: who wins overall and the single most important reason>"
}`;

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

async function runGrader(
  spec: ToolVsSreSpec,
  window: string,
  a: ArmResult,
  b: ArmResult
): Promise<{ scores: { A: AxisScores; B: AxisScores }; rationale: Record<string, string>; summary: string }> {
  const client = new Anthropic() as unknown as AnthropicLike;
  const userMsg = [
    `# Question both answers address`,
    spec.question,
    `Window: ${spec.incidentStartIso} → now (~${window}).`,
    ``,
    `# Answer A — log10x tool (${a.durationMs}ms, single tool call)`,
    a.output.slice(0, 12000),
    ``,
    `# Answer B — SRE by hand (${b.durationMs}ms, ${b.bashCalls ?? 0} bash queries)`,
    b.output.slice(0, 12000),
    ``,
    `# Task`,
    `Score A and B on all six axes per the rubric. JSON only.`,
  ].join('\n');

  const resp = await client.messages.create({
    model: GRADER_MODEL,
    max_tokens: 1500,
    system: GRADER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMsg }],
  });
  const text = resp.content.find((b) => b.type === 'text')?.text ?? '';
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  let parsed: {
    A?: Record<string, unknown>;
    B?: Record<string, unknown>;
    rationale?: Record<string, string>;
    summary?: string;
  };
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`grader returned non-JSON: ${(e as Error).message}\nRaw: ${cleaned.slice(0, 600)}`);
  }
  return {
    scores: { A: normalizeAxes(parsed.A), B: normalizeAxes(parsed.B) },
    rationale: parsed.rationale ?? {},
    summary: parsed.summary ?? '',
  };
}

export async function runToolVsSre(
  spec: ToolVsSreSpec,
  env: EvalEnv,
  outDir: string,
  opts: { sreModel?: string } = {}
): Promise<ToolVsSreVerdict> {
  applyEvalEnvToProcess(env);
  mkdirSync(outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const window = windowFromIncident(spec.incidentStartIso);
  const sreModel = opts.sreModel ?? DEFAULT_SRE_MODEL;

  // A first (fast, no LLM), then B (the slow manual dig), then grade.
  const a = await runArmA(spec, window, env);
  writeFileSync(join(outDir, 'A-log10x.md'), a.output);

  const b = await runArmB(spec, window, sreModel);
  writeFileSync(join(outDir, 'B-sre.md'), b.output);

  const graded = await runGrader(spec, window, a, b);

  const perAxis = {} as Record<keyof AxisScores, GradedAxis>;
  for (const k of AXES) {
    perAxis[k] = { a: graded.scores.A[k], b: graded.scores.B[k], delta: graded.scores.A[k] - graded.scores.B[k] };
  }
  const totals = { A: total(graded.scores.A), B: total(graded.scores.B) };
  const winner: 'A' | 'B' | 'tie' = totals.A > totals.B ? 'A' : totals.B > totals.A ? 'B' : 'tie';

  const verdict: ToolVsSreVerdict = {
    spec,
    startedAt,
    endedAt: new Date().toISOString(),
    envMode: env.mode,
    graderModel: GRADER_MODEL,
    sreModel,
    window,
    a,
    b,
    scores: graded.scores,
    perAxis,
    totals,
    winner,
    graderRationale: graded.rationale,
    graderSummary: graded.summary,
  };

  writeFileSync(join(outDir, 'verdict.json'), JSON.stringify(verdict, null, 2));
  writeFileSync(join(outDir, 'SUMMARY.md'), renderVerdict(verdict));
  return verdict;
}

export function renderVerdict(v: ToolVsSreVerdict): string {
  const L: string[] = [];
  L.push(`# Tool vs SRE — ${v.spec.id}`);
  L.push('');
  L.push(`**Window:** ${v.spec.incidentStartIso} → now (~${v.window})`);
  L.push(`**Env:** ${v.envMode} · **SRE model:** \`${v.sreModel}\` · **Grader:** \`${v.graderModel}\``);
  L.push(`**A (log10x):** ${(v.a.durationMs / 1000).toFixed(1)}s, 1 tool call`);
  L.push(
    `**B (SRE):** ${(v.b.durationMs / 1000).toFixed(1)}s, ${v.b.bashCalls ?? 0} bash queries` +
      (v.b.cost ? `, $${v.b.cost.usd.toFixed(4)}` : '')
  );
  L.push('');
  L.push('## Scores (0-10 per axis)');
  L.push('');
  L.push('| axis | A (log10x) | B (SRE) | Δ (A−B) |');
  L.push('|---|--:|--:|--:|');
  for (const k of AXES) {
    const ax = v.perAxis[k];
    const sign = ax.delta > 0 ? '+' : '';
    L.push(`| ${k.replace(/_/g, '-')} | ${ax.a} | ${ax.b} | ${sign}${ax.delta} |`);
  }
  L.push(`| **TOTAL** | **${v.totals.A}/60** | **${v.totals.B}/60** | **${v.totals.A - v.totals.B >= 0 ? '+' : ''}${v.totals.A - v.totals.B}** |`);
  L.push('');
  L.push(`**Winner:** ${v.winner === 'tie' ? 'tie' : v.winner === 'A' ? 'A (log10x tool)' : 'B (manual SRE)'}`);
  L.push('');
  L.push('## Grader rationale');
  L.push('');
  for (const k of AXES) {
    const r = v.graderRationale[k];
    if (r) L.push(`- **${k.replace(/_/g, '-')}:** ${r}`);
  }
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push(v.graderSummary || '(none)');
  L.push('');
  L.push('---');
  L.push('_Compare A\'s per-axis MOVEMENT across runs, not raw totals — graders are fresh per run._');
  return L.join('\n');
}
