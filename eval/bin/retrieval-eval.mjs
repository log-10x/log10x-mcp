#!/usr/bin/env node
/**
 * Deterministic retrieval eval for product_qa search — no LLM involved.
 *
 * For every demo-shaped faq-bank question (in_faq && is_question), run
 * the real search and check whether the question's OWN source page
 * appears in the top-3 results. The bank guarantees the answer exists
 * on that page, so a miss is a pure search-ranking failure.
 *
 * Usage:
 *   node eval/bin/retrieval-eval.mjs [--verbose] [--out <json path>]
 *
 * Prints hit@1 / hit@3 and the miss list. Run before and after any
 * change to product-kb chunking or scoring.
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const evalRoot = resolve(__dirname, '..');
const repoRoot = resolve(evalRoot, '..');

const { executeProductQa } = await import(resolve(repoRoot, 'build/tools/product-qa.js'));

const verbose = process.argv.includes('--verbose');
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null;

const bank = JSON.parse(readFileSync(join(evalRoot, 'fixtures/faq-bank.json'), 'utf8'));
const cases = bank.entries.filter((e) => e.in_faq && e.is_question);

function slugOf(sourceFile) {
  let s = sourceFile.replace(/\.md$/, '');
  if (s.endsWith('/index')) s = s.slice(0, -'/index'.length);
  return s;
}

let hit1 = 0;
let hit3 = 0;
const misses = [];
for (const e of cases) {
  const want = slugOf(e.source_file);
  let topics = [];
  try {
    const env = executeProductQa({ query: e.question, max_results: 3, depth: 'full' });
    const results = env?.data?.payload?.results ?? [];
    topics = results.map((r) => r.topic);
  } catch {
    topics = [];
  }
  const rank = topics.indexOf(want) + 1;
  if (rank === 1) hit1++;
  if (rank >= 1 && rank <= 3) hit3++;
  else misses.push({ id: e.id, want, got: topics });
  if (verbose) {
    console.log(`${rank > 0 ? 'rank ' + rank : 'MISS '}  ${e.id}`);
  }
}

const summary = {
  cases: cases.length,
  hit_at_1: hit1,
  hit_at_3: hit3,
  hit_at_1_pct: Math.round((hit1 / cases.length) * 1000) / 10,
  hit_at_3_pct: Math.round((hit3 / cases.length) * 1000) / 10,
  misses: misses.length,
};
console.log(JSON.stringify(summary, null, 1));
console.log('\nMISSES:');
for (const m of misses) {
  console.log(`  ${m.id}\n    wanted ${m.want}  got [${m.got.join(', ')}]`);
}
if (outPath) {
  writeFileSync(outPath, JSON.stringify({ summary, misses }, null, 1) + '\n');
  console.log('\nwrote ' + outPath);
}
