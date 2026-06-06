/**
 * product-kb/loader — walks a directory tree of mkdocs markdown files
 * and assembles a Page[] corpus.
 *
 * Derived fields per file:
 *
 *   topic         — path relative to docs root, sans .md
 *   category      — first segment of topic (faq / apps / engine / api / …)
 *   canonical_url — https://docs.log10x.com/<topic>/
 *   summary       — first non-empty prose paragraph from the body
 *   last_reviewed — frontmatter `last_reviewed:` if present, else file mtime
 *   chunks        — chunker output
 *
 * Frontmatter overrides:
 *
 *   mcp_qa: false  → exclude this page from the corpus
 *   mcp_qa: true   → force-include even when outside the default rule
 *
 * The default include rule is "anything under the docs root". The
 * `mcp_qa: true` override exists so a page that sits outside the docs
 * root (e.g. a top-level README copied into a special folder) can still
 * be force-included by the loader.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { chunkMarkdown } from './chunker.js';
import type { Page } from './types.js';

const DOCS_PUBLIC_BASE = 'https://docs.log10x.com';

/**
 * Frontmatter parse result.
 *
 *   raw          — the literal frontmatter block (between the two ---
 *                  lines) for callers that want to keep it verbatim.
 *   parsed       — best-effort key→string map. Only handles the simple
 *                  `key: value` / `key: "value"` shapes that this
 *                  corpus actually uses; complex YAML is left in raw.
 *   bodyStart    — byte offset into the original file where the body
 *                  begins (post-frontmatter).
 */
interface Frontmatter {
  raw: string;
  parsed: Record<string, string | boolean>;
  bodyStart: number;
}

/**
 * Recursively walks `dir` and returns absolute paths for every .md
 * file underneath, excluding `_includes`, `assets`, and other mkdocs
 * machinery directories that shouldn't be searched as content.
 */
function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith('_')) continue; // _includes, _internal
    if (name === 'assets' || name === 'javascripts' || name === 'stylesheets') continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (st.isFile() && name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Parse the leading YAML frontmatter from a markdown file.
 *
 * Only the simple shapes used by this corpus are handled
 * (`key: value`, `key: "value"`, `key: true|false`). Returns
 * { raw: '', parsed: {}, bodyStart: 0 } when no frontmatter is present.
 */
function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { raw: '', parsed: {}, bodyStart: 0 };
  }
  // Look for the closing --- on its own line.
  const closeIdx = text.indexOf('\n---', 4);
  if (closeIdx === -1) {
    return { raw: '', parsed: {}, bodyStart: 0 };
  }
  const raw = text.slice(4, closeIdx);
  // bodyStart is right after the closing "---\n" (or "---\r\n").
  let bodyStart = closeIdx + 4;
  if (text[bodyStart] === '\r') bodyStart += 1;
  if (text[bodyStart] === '\n') bodyStart += 1;

  const parsed: Record<string, string | boolean> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const valRaw = m[2]!.trim();
    // Strip surrounding quotes.
    let val: string | boolean = valRaw.replace(/^["']|["']$/g, '');
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    parsed[key] = val;
  }
  return { raw, parsed, bodyStart };
}

/**
 * Pull the first non-empty prose paragraph from a markdown body.
 *
 * "Non-empty prose" means: not a heading, not a code fence, not a
 * jinja tag, not a div container, not a `??? admonition` opener.
 * The intent is to surface a short human-readable summary the agent
 * can quote to the user when listing search results.
 */
function extractSummary(body: string): string {
  const lines = body.split(/\r?\n/);
  const buf: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (trimmed.length === 0) {
      if (buf.length > 0) break; // end of first paragraph
      continue;
    }
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('???') || trimmed.startsWith('!!!')) continue;
    if (trimmed.startsWith('<') || trimmed.startsWith('{%') || trimmed.startsWith(':')) continue;
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) continue;
    buf.push(trimmed);
    if (buf.join(' ').length > 280) break;
  }
  return buf.join(' ').slice(0, 400);
}

/**
 * Derive the topic slug from a file path relative to the docs root.
 *
 * "apps/dev/index.md"   → "apps/dev"      (index.md collapses to its parent)
 * "faq/security.md"     → "faq/security"
 * "engine/launcher.md"  → "engine/launcher"
 *
 * Windows path separators are normalized to "/".
 */
function deriveTopic(relPath: string): string {
  let topic = relPath.replace(new RegExp(sep.replace(/\\/g, '\\\\'), 'g'), '/');
  topic = topic.replace(/\.md$/i, '');
  topic = topic.replace(/\/index$/i, '');
  return topic;
}

/**
 * Options for loadCorpus().
 *
 *   docsRoot       — absolute path to the mksite/docs root. Walked
 *                    recursively; only .md files are considered.
 *   extraIncludes  — optional absolute paths to .md files OUTSIDE the
 *                    docsRoot that should still be included (frontmatter
 *                    `mcp_qa: true` is the in-file equivalent).
 */
export interface LoadCorpusOptions {
  docsRoot: string;
  extraIncludes?: string[];
}

/**
 * Load and parse every page in the corpus.
 *
 * Pages with `mcp_qa: false` in their frontmatter are silently dropped.
 * Pages with `mcp_qa: true` are force-included even when their file
 * path is outside docsRoot (and so will only be reached via
 * `extraIncludes`).
 */
export function loadCorpus(opts: LoadCorpusOptions): Page[] {
  const files: string[] = [
    ...walkMarkdown(opts.docsRoot),
    ...(opts.extraIncludes ?? []),
  ];
  const seen = new Set<string>();
  const pages: Page[] = [];
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    const page = loadPage(file, opts.docsRoot);
    if (page) pages.push(page);
  }
  return pages;
}

/**
 * Load a single page from disk. Returns null when the page is excluded
 * by `mcp_qa: false` or cannot be read.
 *
 * Exported so callers (and tests) can inspect a single file without
 * walking a tree.
 */
export function loadPage(absPath: string, docsRoot: string): Page | null {
  let text: string;
  let mtime: Date;
  try {
    text = readFileSync(absPath, 'utf8');
    mtime = statSync(absPath).mtime;
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text);
  if (fm.parsed.mcp_qa === false) return null;
  const body = text.slice(fm.bodyStart);

  // For files outside docsRoot, force-include only when mcp_qa: true.
  const rel = relative(docsRoot, absPath);
  const isOutsideRoot = rel.startsWith('..') || rel.startsWith(sep + '..');
  if (isOutsideRoot && fm.parsed.mcp_qa !== true) {
    return null;
  }

  // Topic / category / URL.
  const topic = deriveTopic(isOutsideRoot ? absPath.replace(/^.*\//, '') : rel);
  const category = topic.split('/')[0] ?? 'misc';
  const canonical_url = `${DOCS_PUBLIC_BASE}/${topic}/`;

  // Summary + last_reviewed.
  const summary = extractSummary(body);
  const last_reviewed =
    typeof fm.parsed.last_reviewed === 'string'
      ? fm.parsed.last_reviewed
      : mtime.toISOString();

  return {
    topic,
    category,
    canonical_url,
    summary,
    last_reviewed,
    chunks: chunkMarkdown(body, topic),
  };
}
