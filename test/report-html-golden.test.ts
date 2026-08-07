import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderReportHtml, escapeHtml } from '../src/lib/report/html-template-v1.js';
import type { ReportData } from '../src/lib/report/report-data.js';

const FIXTURE_DIR = join(process.cwd(), 'test', 'fixtures', 'report-golden');

function loadFixture(): ReportData {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'basic.data.json'), 'utf8')) as ReportData;
}

test('golden: template_v1 renders the fixture byte-identically', () => {
  const data = loadFixture();
  const html = renderReportHtml(data);
  const golden = readFileSync(join(FIXTURE_DIR, 'basic.golden.html'), 'utf8');
  assert.equal(html, golden,
    'renderer output drifted from the golden. If the change is intentional, regenerate with: node scripts/gen-report-golden.mjs');
});

test('determinism: same data renders byte-identically twice', () => {
  const data = loadFixture();
  assert.equal(renderReportHtml(data), renderReportHtml(loadFixture()));
});

test('rule: no ellipsis truncation anywhere in the output', () => {
  const html = renderReportHtml(loadFixture());
  assert.ok(!html.includes('…'));
  assert.ok(!html.includes('&hellip;'));
});

test('rule: no dollar amounts — the report leads with volume', () => {
  const html = renderReportHtml(loadFixture());
  // masked-value chips render `$` alone inside <i class="v">; a dollar
  // AMOUNT would be $ followed by a digit.
  assert.ok(!/\$\d/.test(html));
});

test('rule: statement identifiers appear in evidence metadata, never in headings', () => {
  const data = loadFixture();
  const html = renderReportHtml(data);
  const headings = [...html.matchAll(/<h[123][^>]*>(.*?)<\/h[123]>/gs)].map((m) => m[1]).join('\n');
  for (const a of data.actions) {
    for (const f of a.evidence) {
      assert.ok(!headings.includes(f.hash), `hash ${f.hash} leaked into a heading`);
    }
  }
});

test('rule: agent annotation is HTML-escaped', () => {
  const data = loadFixture();
  data.actions[0].annotation = `<script>alert(1)</script> & "quotes"`;
  const html = renderReportHtml(data);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;'));
});

test('rule: self-contained page — no external URLs fetched', () => {
  const html = renderReportHtml(loadFixture());
  assert.ok(!/src\s*=\s*["']https?:/.test(html));
  assert.ok(!/link[^>]+href\s*=\s*["']https?:/.test(html));
  assert.ok(!/@import/.test(html));
});

test('escapeHtml covers the five metacharacters', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});
