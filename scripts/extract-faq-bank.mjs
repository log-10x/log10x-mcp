#!/usr/bin/env node
/**
 * extract-faq-bank.mjs — walk the mksite docs tree (the same corpus the MCP
 * build ships to build/product-kb/docs for product_qa) and emit every
 * `??? tenx-*` admonition as a structured Q/A entry.
 *
 * The docs are the single source of truth; this bank is DERIVED. Consumers:
 *   - demo question bank: filter to in_faq && is_question
 *   - answer judge: ground expected content per question (answer_md + url)
 *
 * Usage:
 *   node scripts/extract-faq-bank.mjs [--src <docs dir>] [--out <json path>]
 *
 * Source resolution order: --src, $LOG10X_PRODUCT_KB_SRC, ../mksite/docs,
 * build/product-kb/docs.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const srcCandidates = [
  arg('--src'),
  process.env.LOG10X_PRODUCT_KB_SRC,
  resolve(repoRoot, '../mksite/docs'),
  resolve(repoRoot, 'build/product-kb/docs'),
].filter(Boolean);
const src = srcCandidates.find((p) => existsSync(p));
if (!src) {
  console.error('No docs source found. Tried: ' + srcCandidates.join(', '));
  process.exit(1);
}
const out = arg('--out') ?? resolve(repoRoot, 'eval/fixtures/faq-bank.json');

function* mdFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* mdFiles(p);
    else if (name.endsWith('.md')) yield p;
  }
}

const ADMONITION = /^\?\?\?(\+)?\s+([A-Za-z0-9_-]+)\s+"(.+)"(?:\s*\{[^}]*\})?\s*$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const ICON = /:[a-z][a-z0-9]*(?:[-_/][a-z0-9]+)*:\s*/g;

const QUESTION_WORD =
  /^(what|what's|how|do|does|did|can|could|is|are|will|would|where|who|when|why|should|which|my|i\b|we\b)/i;

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function docUrl(relPath) {
  let p = relPath.replace(/\\/g, '/').replace(/\.md$/, '');
  if (p.endsWith('/index')) p = p.slice(0, -'/index'.length);
  if (p === 'index') p = '';
  return 'https://doc.log10x.com/' + (p ? p + '/' : '');
}

function areaOf(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (p.startsWith('faq/')) return 'faq';
  if (/^apps\/[^/]+\/faq\.md$/.test(p)) return 'app-faq';
  return p.split('/')[0];
}

const entries = [];
let rawMatches = 0;
const perFile = new Map();

for (const file of mdFiles(src)) {
  const rel = relative(src, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  let section = '';
  let fileCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(HEADING);
    if (h) {
      section = h[2]
        .replace(ICON, '')
        .replace(/\s*\{[^}]*\}\s*$/, '')
        .replace(/[*_`]/g, '')
        .trim();
      continue;
    }
    const m = lines[i].match(ADMONITION);
    if (!m) continue;
    rawMatches++;
    const [, , type, title] = m;
    if (!type.startsWith('tenx-')) continue;

    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') {
        body.push('');
        continue;
      }
      if (/^ {4}/.test(line)) {
        body.push(line.slice(4));
        continue;
      }
      if (/^\t/.test(line)) {
        // mkdocs treats one tab as one indent level
        body.push(line.slice(1));
        continue;
      }
      break;
    }
    // trim leading/trailing blank lines
    while (body.length && body[0] === '') body.shift();
    while (body.length && body[body.length - 1] === '') body.pop();

    const question = title.replace(/\\"/g, '"').trim();
    const inFaq = areaOf(rel) === 'faq' || areaOf(rel) === 'app-faq';
    entries.push({
      id: rel.replace(/\\/g, '/').replace(/\.md$/, '') + '#' + slug(question),
      source_file: rel.replace(/\\/g, '/'),
      url: docUrl(rel),
      area: areaOf(rel),
      section,
      admonition_type: type,
      question,
      is_question: QUESTION_WORD.test(question) || question.endsWith('?'),
      in_faq: inFaq,
      answer_md: body.join('\n'),
    });
    fileCount++;
    i = j - 1;
  }
  if (fileCount) perFile.set(rel, fileCount);
}

// de-dupe ids (same question twice in one file)
const seen = new Map();
for (const e of entries) {
  const n = (seen.get(e.id) ?? 0) + 1;
  seen.set(e.id, n);
  if (n > 1) e.id = e.id + '-' + n;
}

// integrity checks
const empty = entries.filter((e) => !e.answer_md.trim());
const tenxMatches = entries.length;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      generated_from: src,
      entry_count: entries.length,
      entries,
    },
    null,
    1,
  ) + '\n',
);

const faq = entries.filter((e) => e.in_faq);
const demo = entries.filter((e) => e.in_faq && e.is_question);
console.log(`source:            ${src}`);
console.log(`admonitions found: ${rawMatches} (tenx-*: ${tenxMatches})`);
console.log(`files with hits:   ${perFile.size}`);
console.log(`faq-area entries:  ${faq.length}`);
console.log(`demo-bank shaped:  ${demo.length} (in_faq && is_question)`);
console.log(`empty answers:     ${empty.length}${empty.length ? '  <-- INSPECT' : ''}`);
for (const e of empty) console.log('  EMPTY: ' + e.id);
console.log(`wrote:             ${out}`);
