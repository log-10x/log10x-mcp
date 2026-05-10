/**
 * Hero-runner: drives a Claude sub-agent through a hero-question
 * scenario. The sub-agent uses Bash to call the per-tool MCP CLI
 * (eval/bin/mcp-call.mjs) — it has NO direct access to the harness's
 * in-process tool registry, no shared context with this planner.
 *
 * Why through Bash, not the in-process autonomous-runner: Bash forces
 * the sub-agent to face the same surface area a real MCP-host-driven
 * agent would face — JSON args, markdown responses, exit codes,
 * stderr noise. The in-process autonomous-runner short-circuits all
 * of that.
 *
 * After the sub-agent finishes, we score on three axes:
 *   1. Hallucination — drift score from hero-oracle (PromQL ground
 *      truth)
 *   2. Value delivered — Sonnet-judged: does the synthesis answer
 *      the user's actual question?
 *   3. Value received — did the MCP give the agent useful data, or
 *      mostly stub responses / errors?
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalEnv } from './env.js';
import { applyEvalEnvToProcess } from './env.js';
import { validateClaims, renderOracleReport, type HeroOracleReport } from './hero-oracle.js';

const RUNNER_MODEL = 'claude-sonnet-4-6';
const JUDGE_MODEL = 'claude-sonnet-4-6';
const MAX_AGENT_TURNS = 20;
const MAX_TOKENS = 4000;

export interface HeroSpec {
  id: string;
  title: string;
  prompt: string;
  /** Persona prefix prepended to the sub-agent's system prompt. */
  persona?: string;
  /** Time-budget hint for the sub-agent (controls verbosity). */
  budget_hint?: string;
}

export interface HeroRunReport {
  spec: HeroSpec;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  envMode: string;
  bashCommands: Array<{ cmd: string; stdout: string; stderr: string; exitCode: number; durationMs: number }>;
  finalSynthesis: string;
  hallucination: HeroOracleReport;
  valueDelivered: { score: number; rationale: string };
  valueReceived: { score: number; rationale: string };
  status: 'pass' | 'partial' | 'fail';
  flags: string[];
}

// The CLI binary the agent is told to invoke. Default points at the
// real per-tool wrapper. Override via MCP_CALL_BIN to swap in a
// perturbation interposer (Step 3 of the deeper-harness plan): the
// interposer wraps mcp-call.mjs and mutates one tool response per
// scenario so we can probe the agent's anti-hallucination defenses.
const MCP_CALL_BIN =
  process.env.MCP_CALL_BIN ?? '/Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs';

const HERO_SYSTEM_PROMPT_BASE = `You are an experienced site reliability engineer (SRE)
investigating a question on a real production-shape log analytics
environment. You have a Bash tool that lets you invoke individual
log10x MCP tools by name.

Tool invocation contract:

  bash> node ${MCP_CALL_BIN} --list
       # prints every tool name available
  bash> node ${MCP_CALL_BIN} --tool <name> --args '<json>'
       # invokes one tool, prints markdown response to stdout
  bash> node ${MCP_CALL_BIN} --help
       # prints usage

The env is set: LOG10X_EVAL_ENV=demo points at a public, read-only
demo OTel cluster.

Required behavior:

  - Investigate the user's question by calling tools. NEVER speculate
    about numbers — every figure in your final answer must trace to
    a tool's stdout.
  - After each tool result, look at the markdown for a
    "<!-- NEXT_ACTIONS: [...] -->" comment block at the bottom. These
    are structured chain hints. Walk them when relevant; don't ask
    the user for permission to take an obvious next step.
  - Stay under ${MAX_AGENT_TURNS} tool turns. Most hero questions
    resolve in 4-8 calls.
  - Final answer: 6-12 line synthesis ending with concrete
    recommendations. State what you observed, what it means, and
    what to do — in that order. If a number wasn't returned by a
    tool, say "not reported".
  - Do NOT invent pattern names or services. Only quote names that
    appeared verbatim in tool stdout.

ANTI-HALLUCINATION RULES (HARD — agents that violate these get
flagged as drift by the oracle and the run is recorded as a fail):

  - Do NOT extrapolate or aggregate numbers across windows. If
    cost_drivers reports "$3.6/wk for pattern X", do NOT write
    "$15/mo" or "$180/yr" unless a tool emitted those projections.
    Report values exactly as the tool printed them.
  - Do NOT sum figures across patterns to make a "combined" total
    unless the tool already aggregated them. Each value is a
    separate observation.
  - Do NOT cite freshness / timestamps / "N seconds ago" unless a
    tool returned that exact phrase. ONLY log10x_doctor reports
    metric_freshness in seconds. If a tool didn't return a
    freshness number, write "freshness not reported in this tool
    output".
  - Demo env scale check: total volume is ~5 GB/day. ANY single
    claim above 150 GB / month or 5 TB / year is almost certainly
    a fabrication. Sanity-check before quoting big numbers.
  - When a tool returns "no movement detected" or "no cost drivers
    detected", that IS the answer — do NOT switch windows and
    fabricate growth. If you switch windows, say so explicitly:
    "Switching from 7d to 30d window per the tool's hint, the
    longer baseline shows…"
  - Pattern names must appear verbatim in some tool's stdout. Do
    NOT typo or abbreviate them; copy exactly.

Out of scope: do not edit files, do not push commits, do not
exfiltrate data. Read-only investigation only.`;

interface AnthropicLike {
  messages: {
    create(opts: {
      model: string;
      max_tokens: number;
      system: string;
      tools?: Array<{ name: string; description: string; input_schema: object }>;
      messages: Array<{
        role: 'user' | 'assistant';
        content:
          | string
          | Array<
              | { type: 'text'; text: string }
              | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
              | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
            >;
      }>;
    }): Promise<{
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      >;
      stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
    }>;
  };
}

export async function runHero(spec: HeroSpec, env: EvalEnv, outDir: string): Promise<HeroRunReport> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('runHero requires ANTHROPIC_API_KEY');
  }
  applyEvalEnvToProcess(env);
  mkdirSync(outDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const bashCommands: HeroRunReport['bashCommands'] = [];

  const systemPrompt = (spec.persona ? spec.persona + '\n\n' : '') + HERO_SYSTEM_PROMPT_BASE;

  const client = new Anthropic() as unknown as AnthropicLike;
  // Single-tool surface: a Bash tool. The sub-agent must shell out.
  const tools = [
    {
      name: 'bash',
      description:
        'Run a Bash command, get stdout/stderr/exit code back. Use this to invoke MCP tools via the mcp-call.mjs CLI.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Bash command to execute.' },
        },
        required: ['command'],
      },
    },
  ];

  const messages: Parameters<typeof client.messages.create>[0]['messages'] = [
    { role: 'user', content: spec.prompt },
  ];

  let finalText = '';
  let turn = 0;
  while (turn < MAX_AGENT_TURNS) {
    turn++;
    const resp = await client.messages.create({
      model: RUNNER_MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools,
      messages,
    });
    messages.push({ role: 'assistant', content: resp.content });

    const toolUses = resp.content.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        b.type === 'tool_use'
    );
    const textBlocks = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text');

    if (resp.stop_reason === 'end_turn' || toolUses.length === 0) {
      finalText = textBlocks.map((b) => b.text).join('\n');
      break;
    }

    const results: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }> = [];
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
      const cmd = String(tu.input.command ?? '');
      const tCmd = Date.now();
      const { stdout, stderr, exitCode } = await runBash(cmd);
      const durationMs = Date.now() - tCmd;
      bashCommands.push({ cmd, stdout, stderr, exitCode, durationMs });
      const contentBack =
        `exit=${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`.slice(0, 30000);
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: contentBack,
        is_error: exitCode !== 0,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  // Persist the conversation transcript verbatim. This is the
  // ground-truth artifact — anything that fails downstream (oracle,
  // judge) can be re-run against this without losing the agent's work.
  writeFileSync(
    join(outDir, 'transcript.json'),
    JSON.stringify({ spec, messages, bashCommands, finalText }, null, 2)
  );

  // ── Score: hallucination via oracle ──
  // Wrapped because the demo env's Prometheus occasionally 500s on
  // aggregation queries, and we'd rather record "oracle errored" than
  // lose the whole run.
  let hallucination: HeroOracleReport;
  try {
    hallucination = await validateClaims(finalText, env);
  } catch (e) {
    hallucination = {
      numericClaimCount: 0,
      patternClaimCount: 0,
      supported: 0,
      unsupported: 0,
      inconclusive: 0,
      driftScore: -1,
      details: [
        {
          claim: '<oracle errored>',
          kind: 'numeric',
          oracleResult: (e as Error).message.slice(0, 300),
          status: 'inconclusive',
          detail: 'oracle path threw — re-run via bin/run-hero.mjs --revalidate <transcript.json>',
        },
      ],
    };
  }

  // ── Score: value-delivered + value-received via Sonnet judge ──
  let judgeReport: JudgeReport;
  try {
    judgeReport = await judgeHero(spec, finalText, bashCommands, client);
  } catch (e) {
    judgeReport = {
      valueDelivered: { score: -1, rationale: `judge path threw: ${(e as Error).message.slice(0, 200)}` },
      valueReceived: { score: -1, rationale: 'judge path threw' },
    };
  }

  const status: 'pass' | 'partial' | 'fail' =
    hallucination.driftScore === 0 && judgeReport.valueDelivered.score >= 0.6
      ? 'pass'
      : hallucination.driftScore <= 1
        ? 'partial'
        : 'fail';

  const flags: string[] = [];
  if (hallucination.driftScore > 0) flags.push(`drift=${hallucination.driftScore}`);
  if (judgeReport.valueDelivered.score < 0.5) flags.push('low_value_delivered');
  if (judgeReport.valueReceived.score < 0.5) flags.push('low_value_received');

  const report: HeroRunReport = {
    spec,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    envMode: env.mode,
    bashCommands,
    finalSynthesis: finalText,
    hallucination,
    valueDelivered: judgeReport.valueDelivered,
    valueReceived: judgeReport.valueReceived,
    status,
    flags,
  };

  writeFileSync(join(outDir, 'verdict.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, 'SUMMARY.md'), renderHeroSummary(report));

  return report;
}

async function runBash(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], {
      env: { ...process.env, LOG10X_EVAL_ENV: process.env.LOG10X_EVAL_ENV ?? 'demo' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
    // hard 60s cap per command
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* noop */
      }
    }, 60_000);
  });
}

interface JudgeReport {
  valueDelivered: { score: number; rationale: string };
  valueReceived: { score: number; rationale: string };
}

async function judgeHero(
  spec: HeroSpec,
  synthesis: string,
  bashCommands: HeroRunReport['bashCommands'],
  client: AnthropicLike
): Promise<JudgeReport> {
  const previews = bashCommands
    .slice(0, 12)
    .map((c, i) => {
      const cmd = c.cmd.length > 200 ? c.cmd.slice(0, 200) + '...' : c.cmd;
      const out =
        c.stdout.length > 1500 ? c.stdout.slice(0, 1500) + `... [${c.stdout.length - 1500} more bytes]` : c.stdout;
      return `## Bash call ${i + 1} (exit=${c.exitCode}, ${c.durationMs}ms)\n\n\`\`\`\n${cmd}\n\`\`\`\n\nstdout:\n\`\`\`\n${out}\n\`\`\``;
    })
    .join('\n\n');

  const userMsg = [
    `# User question`,
    spec.prompt,
    ``,
    `# Sub-agent's tool calls`,
    previews,
    ``,
    `# Sub-agent's final synthesis`,
    synthesis,
    ``,
    `# Your task`,
    `Score on TWO axes, each 0.0-1.0. Return JSON only.`,
    ``,
    `1. value_delivered: did the synthesis answer the user's actual`,
    `   question? Could an SRE act on it? 0.0 = irrelevant or punted;`,
    `   0.5 = partial; 1.0 = directly actionable answer to the asked`,
    `   question.`,
    `2. value_received: did the MCP give the sub-agent useful data,`,
    `   or did it return mostly stubs / errors / "not configured" /`,
    `   "no patterns resolved"? 0.0 = MCP returned nothing useful;`,
    `   0.5 = partial coverage with gaps; 1.0 = MCP returned the data`,
    `   the sub-agent needed.`,
    ``,
    `Output: {`,
    `  "value_delivered": {"score": 0.0-1.0, "rationale": "<one sentence>"},`,
    `  "value_received": {"score": 0.0-1.0, "rationale": "<one sentence>"}`,
    `}`,
    ``,
    `Output JSON ONLY. No markdown fence.`,
  ].join('\n');

  const resp = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 800,
    system:
      'You are an evaluator scoring an autonomous SRE assistant. Be strict, concise, and specific. Output JSON only.',
    messages: [{ role: 'user', content: userMsg }],
  });
  const text =
    resp.content.find((b): b is { type: 'text'; text: string } => b.type === 'text')?.text ?? '';
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  let parsed: { value_delivered: { score: number; rationale: string }; value_received: { score: number; rationale: string } };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      valueDelivered: { score: 0.5, rationale: `judge JSON parse failed: ${cleaned.slice(0, 200)}` },
      valueReceived: { score: 0.5, rationale: 'judge JSON parse failed' },
    };
  }
  return {
    valueDelivered: parsed.value_delivered,
    valueReceived: parsed.value_received,
  };
}

function renderHeroSummary(r: HeroRunReport): string {
  const lines: string[] = [];
  lines.push(`# Hero scenario: ${r.spec.title}`);
  lines.push('');
  lines.push(`**Scenario:** \`${r.spec.id}\``);
  lines.push(`**Status:** ${r.status.toUpperCase()}`);
  lines.push(`**Env:** ${r.envMode}`);
  lines.push(`**Started:** ${r.startedAt}`);
  lines.push(`**Duration:** ${(r.durationMs / 1000).toFixed(1)}s`);
  lines.push(`**Bash calls:** ${r.bashCommands.length}`);
  lines.push('');
  lines.push('## User question');
  lines.push('');
  lines.push('> ' + r.spec.prompt.replace(/\n/g, '\n> '));
  lines.push('');
  lines.push('## Three axes');
  lines.push('');
  lines.push(`- **Hallucination (drift score):** ${r.hallucination.driftScore} unsupported · ${r.hallucination.supported} supported · ${r.hallucination.inconclusive} inconclusive`);
  lines.push(`- **Value delivered:** ${r.valueDelivered.score.toFixed(2)} — ${r.valueDelivered.rationale}`);
  lines.push(`- **Value received:** ${r.valueReceived.score.toFixed(2)} — ${r.valueReceived.rationale}`);
  if (r.flags.length > 0) {
    lines.push(`- **Flags:** ${r.flags.join(', ')}`);
  }
  lines.push('');
  lines.push('## Sub-agent final synthesis');
  lines.push('');
  lines.push(r.finalSynthesis);
  lines.push('');
  lines.push(renderOracleReport(r.hallucination));
  lines.push('');
  lines.push('## Bash command trace');
  lines.push('');
  for (let i = 0; i < r.bashCommands.length; i++) {
    const c = r.bashCommands[i];
    lines.push(`### ${i + 1}. ${c.cmd.split('\n')[0].slice(0, 100)}${c.cmd.length > 100 ? '...' : ''}`);
    lines.push(`exit=${c.exitCode}, ${c.durationMs}ms, stdout=${c.stdout.length}B, stderr=${c.stderr.length}B`);
    lines.push('');
  }
  return lines.join('\n');
}
