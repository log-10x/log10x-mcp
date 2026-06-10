#!/usr/bin/env node
/**
 * Two-check product-QA judge runner.
 *
 * Modes:
 *   --calibrate
 *       Judge the seeded cases in fixtures/product-qa-judge-calibration.json
 *       and diff each verdict against the case's `expect` block. Exits 1 on
 *       any miscalibration. Run this after every judge-prompt change.
 *
 *   --answers <answers.jsonl>
 *       Judge real answers. Each line: {"id": "<faq-bank entry id>",
 *       "answer": "<the answer under judgment>"}. Ground truth is joined
 *       from fixtures/faq-bank.json by id; unknown ids are judged as
 *       outside-corpus (the correct answer is a decline).
 *
 * Options:
 *   --limit N          judge only the first N items
 *   --concurrency N    parallel judge calls (default 4)
 *   --out <dir>        report dir (default reports/product-qa/<ts>)
 *
 * Requires ANTHROPIC_API_KEY (same gating as the rest of the harness).
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const evalRoot = resolve(__dirname, '..');

const { judgeProductQa, makeClient } = await import(
  resolve(evalRoot, 'build-eval/product-qa-judge.js')
);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(name);

const rules = readFileSync(join(evalRoot, 'fixtures/on-message-rules.md'), 'utf8');
const limit = arg('--limit') ? Number(arg('--limit')) : Infinity;
const concurrency = arg('--concurrency') ? Number(arg('--concurrency')) : 4;
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = arg('--out') ?? join(evalRoot, 'reports/product-qa', ts);

let cases = [];
let expectations = null;

if (has('--calibrate')) {
  const fix = JSON.parse(
    readFileSync(join(evalRoot, 'fixtures/product-qa-judge-calibration.json'), 'utf8'),
  );
  cases = fix.cases.map((c) => ({
    id: c.id,
    question: c.question,
    answer: c.answer,
    groundTruth: c.ground_truth,
  }));
  expectations = new Map(fix.cases.map((c) => [c.id, c.expect]));
} else if (arg('--answers')) {
  const bank = JSON.parse(readFileSync(join(evalRoot, 'fixtures/faq-bank.json'), 'utf8'));
  const byId = new Map(bank.entries.map((e) => [e.id, e]));
  const lines = readFileSync(resolve(arg('--answers')), 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  cases = lines.map((l) => {
    const a = JSON.parse(l);
    const e = byId.get(a.id);
    return {
      id: a.id,
      question: a.question ?? e?.question ?? a.id,
      answer: a.answer,
      groundTruth: e
        ? { answer_md: e.answer_md, url: e.url, source_file: e.source_file }
        : null,
    };
  });
} else {
  console.error('Pass --calibrate or --answers <file.jsonl>. See header comment.');
  process.exit(2);
}

cases = cases.slice(0, limit);
const client = makeClient();

const verdicts = [];
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = cases[next++];
    try {
      const v = await judgeProductQa(c, client, rules);
      verdicts.push(v);
      const s = v.sourced.score;
      const m = v.on_message.score;
      console.log(
        `${v.pass ? 'PASS' : 'FAIL'}  sourced=${s} on_message=${m}  ${c.id}`,
      );
    } catch (err) {
      verdicts.push({
        id: c.id,
        error: String(err?.message ?? err),
        pass: false,
      });
      console.log(`ERROR ${c.id}: ${err?.message ?? err}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'verdicts.jsonl'),
  verdicts.map((v) => JSON.stringify(v)).join('\n') + '\n',
);

const summary = {
  total: verdicts.length,
  pass: verdicts.filter((v) => v.pass).length,
  errors: verdicts.filter((v) => v.error).length,
  sourced_fail: verdicts.filter((v) => v.sourced && v.sourced.score < 2).length,
  on_message_fail: verdicts.filter((v) => v.on_message && v.on_message.score < 2).length,
};

if (expectations) {
  const mis = [];
  for (const v of verdicts) {
    const exp = expectations.get(v.id);
    if (!exp) continue;
    if (v.error) {
      mis.push({ id: v.id, problem: 'judge errored: ' + v.error });
      continue;
    }
    const sourcedPass = v.sourced.score === 2;
    const onMessagePass = v.on_message.score === 2;
    if (sourcedPass !== exp.sourced_pass) {
      mis.push({
        id: v.id,
        problem: `sourced expected ${exp.sourced_pass ? 'pass' : 'fail'}, got score ${v.sourced.score} (${v.sourced.rationale})`,
      });
    }
    if (onMessagePass !== exp.on_message_pass) {
      mis.push({
        id: v.id,
        problem: `on_message expected ${exp.on_message_pass ? 'pass' : 'fail'}, got score ${v.on_message.score} (${v.on_message.rationale})`,
      });
    }
  }
  summary.miscalibrations = mis;
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
  console.log('\n=== calibration ===');
  console.log(`cases: ${verdicts.length}  miscalibrations: ${mis.length}`);
  for (const m of mis) console.log(`  MISCAL ${m.id}: ${m.problem}`);
  console.log(`report: ${outDir}`);
  process.exit(mis.length ? 1 : 0);
}

writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
console.log('\n=== summary ===');
console.log(JSON.stringify(summary, null, 1));
console.log(`report: ${outDir}`);
