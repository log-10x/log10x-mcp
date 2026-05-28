#!/usr/bin/env node
/**
 * Run a single eval fixture against a built MCP tool, score the
 * output via Grok 4.3 (xAI API). One-shot: invoke tool, capture
 * StructuredOutput, ask Grok to score against expected.
 *
 * Usage:
 *   node eval/bin/run-fixture.mjs eval/fixtures/regression/<id>.json
 *
 * Output to stdout: a single JSON line per-run record
 *   {
 *     fixture_id, tool, args, output_summary_headline,
 *     output_schema_valid: bool, grok_score: 1-5, grok_reason: string,
 *     passed: bool, duration_ms
 *   }
 *
 * Also appended to /tmp/autonomous-run-19ecafa/eval-results.jsonl
 * for the morning aggregator.
 *
 * Fixture shape (eval/fixtures/regression/*.json):
 *   {
 *     "id": "find-skew-otel-dns",
 *     "description": "...",
 *     "tool": "find_skew" | "find_constant_slots" | "find_uuid_in_body" | "find_incident_cluster",
 *     "args": { ... },
 *     "expected": {
 *       "findings_count_min": 1,
 *       "must_include_field_path": ["data.findings[0].skewedSlots[0].slotName"],
 *       "headline_must_match": "skew finding",
 *       "rubric": "Free-text description of correctness for Grok"
 *     }
 *   }
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { StructuredOutputSchema } from '/Users/talweiss/git/l1x-co/log10x-mcp/build/lib/output-types.js';
import { executeFindSkew } from '/Users/talweiss/git/l1x-co/log10x-mcp/build/tools/find-skew.js';
// find_constant_slots / find_uuid_in_body / find_incident_cluster removed pre-launch.

const TOOLS = {
  find_skew: executeFindSkew,
};

const fixturePath = process.argv[2];
if (!fixturePath || !existsSync(fixturePath)) {
  console.error(`Usage: run-fixture.mjs <fixture.json>`);
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
const tool = TOOLS[fixture.tool];
if (!tool) {
  console.error(`Unknown tool: ${fixture.tool}`);
  process.exit(1);
}

const RESULTS_PATH = process.env.EVAL_RESULTS_PATH ?? '/tmp/autonomous-run-19ecafa/eval-results.jsonl';
const started = Date.now();

let output;
try {
  output = await tool(fixture.args);
} catch (e) {
  const rec = { fixture_id: fixture.id, tool: fixture.tool, error: e.message, passed: false, duration_ms: Date.now() - started };
  appendFileSync(RESULTS_PATH, JSON.stringify(rec) + '\n');
  console.log(JSON.stringify(rec));
  process.exit(0);
}

// Schema check.
const parsed = StructuredOutputSchema.safeParse(output);
const schemaValid = parsed.success;

// Ask Grok to score against the expected rubric.
const exp = fixture.expected ?? {};
const grokPrompt = `You are grading a log10x-mcp tool output against an expected rubric.

TOOL: ${fixture.tool}
ARGS: ${JSON.stringify(fixture.args, null, 2)}

EXPECTED RUBRIC:
${exp.rubric ?? '(no rubric)'}

EXPECTED CHECKS:
- Min findings count: ${exp.findings_count_min ?? '(any)'}
- Headline must match (substring, case-insensitive): "${exp.headline_must_match ?? '(any)'}"

ACTUAL TOOL OUTPUT:
${JSON.stringify(output, null, 2)}

Score this on a 1-5 scale:
- 5: matches the rubric exactly, findings as expected, no false positives, no missing detail
- 4: mostly correct, minor issue
- 3: partially correct, missing one expected element
- 2: incorrect in a significant way
- 1: wrong or empty

Reply with EXACTLY this JSON on a single line, no prose around it:
{"score": <1-5>, "reason": "<one-sentence reason>"}`;

writeFileSync('/tmp/grok-prompt.txt', grokPrompt);

const grokResult = spawnSync(
  'zsh',
  ['-c', `source ~/.zshrc; python3 /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/grok-call.py /tmp/grok-prompt.txt`],
  { encoding: 'utf-8', timeout: 120000 }
);

let grokScore = 0;
let grokReason = 'grok call failed';
if (grokResult.status === 0) {
  const stdout = (grokResult.stdout || '').trim();
  // Try to extract JSON from the response (Grok may include some surrounding prose).
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

// Deterministic field checks.
let mustIncludePassed = true;
if (exp.must_include_field_path?.length) {
  for (const path of exp.must_include_field_path) {
    if (!evalPath(output, path)) {
      mustIncludePassed = false;
      break;
    }
  }
}
let headlineMatchPassed = true;
if (exp.headline_must_match) {
  const h = (output?.summary?.headline || '').toLowerCase();
  headlineMatchPassed = h.includes(exp.headline_must_match.toLowerCase());
}
let findingsCountPassed = true;
if (typeof exp.findings_count_min === 'number') {
  const count = (output?.data?.findings ?? output?.data?.clusters ?? []).length;
  findingsCountPassed = count >= exp.findings_count_min;
}

const passed = schemaValid && mustIncludePassed && headlineMatchPassed && findingsCountPassed && grokScore >= 4;

const rec = {
  fixture_id: fixture.id,
  tool: fixture.tool,
  args: fixture.args,
  output_summary_headline: output?.summary?.headline ?? null,
  output_schema_valid: schemaValid,
  output_findings_count: (output?.data?.findings ?? output?.data?.clusters ?? []).length,
  must_include_passed: mustIncludePassed,
  headline_match_passed: headlineMatchPassed,
  findings_count_passed: findingsCountPassed,
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
