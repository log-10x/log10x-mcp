#!/usr/bin/env node
/**
 * Env-mode fixture runner. Like run-fixture.mjs but for tools that
 * need a live env (Prometheus query, SIEM connector). Loads the demo
 * env via the standard cascade (LOG10X_API_KEY in env), calls the
 * tool with `env` argument, validates envelope + asks Grok to grade.
 *
 * Usage:
 *   node eval/bin/run-env-fixture.mjs <fixture.json>
 *
 * Demo creds must be set in env BEFORE invocation:
 *   LOG10X_API_KEY=<demo>
 *   LOG10X_CUSTOMER_METRICS_URL=https://prometheus.log10x.com
 *   LOG10X_CUSTOMER_METRICS_TYPE=log10x
 *   LOG10X_CUSTOMER_METRICS_AUTH=<demo_api_key>/<demo_env_id>
 */

import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { StructuredOutputSchema } from '/Users/talweiss/git/l1x-co/log10x-mcp/build/lib/output-types.js';
import { loadEnvironments, resolveEnv } from '/Users/talweiss/git/l1x-co/log10x-mcp/build/lib/environments.js';
import { executeTopPatterns } from '/Users/talweiss/git/l1x-co/log10x-mcp/build/tools/top-patterns.js';
import { executeEventLookup } from '/Users/talweiss/git/l1x-co/log10x-mcp/build/tools/event-lookup.js';
import { executeTrend } from '/Users/talweiss/git/l1x-co/log10x-mcp/build/tools/trend.js';
import { executeDependencyCheck } from '/Users/talweiss/git/l1x-co/log10x-mcp/build/tools/dependency-check.js';
import { executePatternMitigate } from '/Users/talweiss/git/l1x-co/log10x-mcp/build/tools/pattern-mitigate.js';

const TOOLS = {
  top_patterns: { fn: executeTopPatterns, needsEnv: true },
  event_lookup: { fn: executeEventLookup, needsEnv: true },
  pattern_trend: { fn: executeTrend, needsEnv: true },
  dependency_check: { fn: executeDependencyCheck, needsEnv: false },
  pattern_mitigate: { fn: executePatternMitigate, needsEnv: false },
};

const fixturePath = process.argv[2];
if (!fixturePath || !existsSync(fixturePath)) {
  console.error(`Usage: run-env-fixture.mjs <fixture.json>`);
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
const toolEntry = TOOLS[fixture.tool];
if (!toolEntry) {
  console.error(`Unknown tool: ${fixture.tool}`);
  process.exit(1);
}

const envs = await loadEnvironments();
const env = resolveEnv(envs, undefined);

const RESULTS_PATH = process.env.EVAL_RESULTS_PATH ?? '/tmp/autonomous-run-19ecafa/eval-results.jsonl';
const started = Date.now();

let output;
try {
  output = toolEntry.needsEnv
    ? await toolEntry.fn(fixture.args, env)
    : await toolEntry.fn(fixture.args);
} catch (e) {
  const rec = { fixture_id: fixture.id, tool: fixture.tool, mode: 'env', error: e.message, passed: false, duration_ms: Date.now() - started };
  appendFileSync(RESULTS_PATH, JSON.stringify(rec) + '\n');
  console.log(JSON.stringify(rec));
  process.exit(0);
}

let outputStruct = null;
let outputString = null;
if (typeof output === 'string') {
  outputString = output;
} else {
  const parsed = StructuredOutputSchema.safeParse(output);
  outputStruct = parsed.success ? output : null;
}

const exp = fixture.expected ?? {};

// Deterministic field checks against typed envelope when available.
let mustIncludePassed = true;
if (exp.must_include_field_path?.length && outputStruct) {
  for (const path of exp.must_include_field_path) {
    if (!evalPath(outputStruct, path)) {
      mustIncludePassed = false;
      break;
    }
  }
}

let headlineMatchPassed = true;
const headline = outputStruct?.summary?.headline ?? '';
if (exp.headline_must_match) {
  headlineMatchPassed = headline.toLowerCase().includes(exp.headline_must_match.toLowerCase());
}

let dataContainsPassed = true;
if (exp.data_contains_string?.length && outputStruct) {
  const dataStr = JSON.stringify(outputStruct.data);
  for (const needle of exp.data_contains_string) {
    if (!dataStr.toLowerCase().includes(needle.toLowerCase())) {
      dataContainsPassed = false;
      break;
    }
  }
}

// Grok judge.
const grokPrompt = `You are grading a log10x-mcp tool output against an expected rubric.

TOOL: ${fixture.tool} (env mode against live demo TSDB)
ARGS: ${JSON.stringify(fixture.args, null, 2)}

EXPECTED RUBRIC:
${exp.rubric ?? '(no rubric)'}

EXPECTED CHECKS:
- Headline must contain (case-insensitive): "${exp.headline_must_match ?? '(any)'}"
- data must contain (case-insensitive): ${JSON.stringify(exp.data_contains_string ?? [])}

ACTUAL TOOL OUTPUT:
${JSON.stringify(output, null, 2).slice(0, 8000)}

Score 1-5:
- 5: matches rubric exactly, all expected data present, no false claims
- 4: mostly correct, minor issue
- 3: partial, missing one element
- 2: significantly incorrect
- 1: wrong or empty

Reply with EXACTLY this JSON on one line, no prose:
{"score": <1-5>, "reason": "<one sentence>"}`;

writeFileSync('/tmp/grok-prompt.txt', grokPrompt);
const grokResult = spawnSync(
  'zsh',
  ['-c', `source ~/.zshrc; python3 /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/grok-call.py /tmp/grok-prompt.txt`],
  { encoding: 'utf-8', timeout: 180000 }
);

let grokScore = 0;
let grokReason = 'grok call failed';
if (grokResult.status === 0) {
  const stdout = (grokResult.stdout || '').trim();
  const m = stdout.match(/\{[^{}]*"score"[^{}]*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      grokScore = Number(parsed.score) || 0;
      grokReason = String(parsed.reason || '').slice(0, 240);
    } catch {
      grokReason = `parse error: ${stdout.slice(0, 120)}`;
    }
  } else {
    grokReason = `no JSON in: ${stdout.slice(0, 120)}`;
  }
} else {
  grokReason = `exit ${grokResult.status}: ${(grokResult.stderr || '').slice(0, 240)}`;
}

const passed =
  (outputStruct !== null || outputString !== null) &&
  mustIncludePassed &&
  headlineMatchPassed &&
  dataContainsPassed &&
  grokScore >= 4;

const rec = {
  fixture_id: fixture.id,
  tool: fixture.tool,
  mode: 'env',
  args: fixture.args,
  output_summary_headline: headline,
  output_schema_valid: outputStruct !== null,
  must_include_passed: mustIncludePassed,
  headline_match_passed: headlineMatchPassed,
  data_contains_passed: dataContainsPassed,
  grok_score: grokScore,
  grok_reason: grokReason,
  passed,
  duration_ms: Date.now() - started,
};
appendFileSync(RESULTS_PATH, JSON.stringify(rec) + '\n');
console.log(JSON.stringify(rec));

function evalPath(obj, path) {
  try {
    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return false;
      cur = cur[p];
    }
    return cur != null;
  } catch {
    return false;
  }
}
