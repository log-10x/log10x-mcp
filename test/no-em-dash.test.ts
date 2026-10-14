/**
 * No em dash in anything the MCP says: every string and template literal in
 * src (tool output, tool descriptions, server instructions, rendered
 * reports and recipes) and every string in the tool manifest and server.json.
 * Comments are not output and are not scanned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
const EM_DASH = '\u2014';
const ROOT = process.cwd();

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function literalsWithEmDash(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  if (!text.includes(EM_DASH) && !text.includes('\\u2014')) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (n: import('typescript').Node): void => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      const cooked = (n as import('typescript').LiteralLikeNode).text;
      if (cooked.includes(EM_DASH)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        const i = cooked.indexOf(EM_DASH);
        hits.push(`${relative(ROOT, file)}:${line}: ...${cooked.slice(Math.max(0, i - 40), i + 20)}...`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

function jsonStringsWithEmDash(file: string): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      if (v.includes(EM_DASH)) hits.push(`${relative(ROOT, file)} ${path}`);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    }
  };
  walk(JSON.parse(readFileSync(file, 'utf8')), '$');
  return hits;
}

test('no string or template literal in src carries an em dash', () => {
  const hits = tsFiles(join(ROOT, 'src')).flatMap(literalsWithEmDash);
  assert.deepEqual(hits, [], `em dashes in user-facing text:\n${hits.join('\n')}`);
});

test('no string in the tool manifest or server.json carries an em dash', () => {
  const hits = ['default-manifest.json', 'server.json'].flatMap((f) => jsonStringsWithEmDash(join(ROOT, f)));
  assert.deepEqual(hits, [], hits.join('\n'));
});

test('the scan finds an em dash when one is there', () => {
  const sf = ts.createSourceFile('x.ts', "const a = 'one \u2014 two'; // a comment \u2014 ignored\n", ts.ScriptTarget.Latest, true);
  let found = 0;
  const visit = (n: import('typescript').Node): void => {
    if (ts.isStringLiteral(n) && n.text.includes(EM_DASH)) found++;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.equal(found, 1);
});
