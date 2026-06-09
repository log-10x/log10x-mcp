#!/usr/bin/env node
/**
 * Invoke the REAL product_qa tool from the CLI — the same code path the
 * MCP server registers, over whatever corpus the build shipped to
 * build/product-kb/docs. Used by the answer-generation side of the
 * product-QA eval so the agent under test grounds on actual retrieval,
 * not on free-reading the docs tree.
 *
 * Usage:
 *   node eval/bin/ask-product-qa.mjs --id <faq-bank entry id>
 *   node eval/bin/ask-product-qa.mjs --query "natural language question"
 *
 * --id looks the question text up in eval/fixtures/faq-bank.json and
 * passes it as `query` (it does NOT pass the entry's source page as
 * `topic` — that would bypass search and inflate retrieval quality).
 * Prints: a JSON object {question, envelope} on stdout.
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const evalRoot = resolve(__dirname, '..');
const repoRoot = resolve(evalRoot, '..');

const { executeProductQa } = await import(
  resolve(repoRoot, 'build/tools/product-qa.js')
);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let question = arg('--query');
if (arg('--id')) {
  const bank = JSON.parse(
    readFileSync(join(evalRoot, 'fixtures/faq-bank.json'), 'utf8'),
  );
  const e = bank.entries.find((x) => x.id === arg('--id'));
  if (!e) {
    console.error('unknown bank id: ' + arg('--id'));
    process.exit(2);
  }
  question = e.question;
}
if (!question) {
  console.error('pass --id <bank id> or --query "<question>"');
  process.exit(2);
}

const envelope = executeProductQa({ query: question, max_results: 3, depth: 'full' });
console.log(JSON.stringify({ question, envelope }, null, 1));
