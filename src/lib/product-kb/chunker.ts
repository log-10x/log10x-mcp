/**
 * product-kb/chunker — H2-section-aware markdown chunker.
 *
 * Why this exists
 *
 * The corpus is mkdocs Material markdown. The dominant structure is:
 *   ### :material-info: Overview
 *
 *   ??? tenx-overview "What is X"
 *
 *       <body>
 *
 *   ### :material-cog: Capabilities
 *   ...
 *
 * Naive line-based chunking breaks this in three ways:
 *
 *   1. The `??? tenx-overview "..."` admonition opens an indented block.
 *      A naive splitter would cut the heading away from its body.
 *   2. Mermaid fences (```mermaid ... ```) carry headings inside the diagram
 *      that look like prose H3 headings to a regex.
 *   3. Jinja includes ({% include "_partial.md" %}) are opaque — we never
 *      want to split mid-tag.
 *
 * The chunker splits on H2 (## ) AND H3 (### ) when they appear at column 0
 * AND are NOT inside a fenced code block / admonition body / jinja include.
 * H3 is treated as a sub-section split because the mkdocs Material pages
 * in this corpus dominantly use ### as the top-level user-visible heading
 * (the H1 lives in frontmatter `title:`).
 *
 * Each emitted chunk also carries a brief overlap tail from the next
 * section (~200 chars max, trimmed at the next paragraph or sentence
 * boundary). The overlap reduces "phrase straddles a section break"
 * recall misses without inflating the chunk count.
 */

import type { Chunk } from './types.js';

/** Cap on the overlap tail length in characters. */
const OVERLAP_MAX_CHARS = 200;

/**
 * Returns true when `line` opens or closes a fenced code block
 * (``` or ~~~). The chunker tracks fence depth to avoid mistaking
 * "## " inside a code sample for a heading.
 */
function isCodeFence(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('```') || trimmed.startsWith('~~~');
}

/**
 * Returns true when `line` opens a jinja include tag like
 * `{% include "..." %}`. These are opaque to the chunker; we treat
 * them as part of whatever section they appear in.
 *
 * Jinja tags are typically single-line in this corpus, so we don't need
 * to track open/close depth — but we still skip heading detection inside
 * the tag itself to be safe.
 */
function isJinjaTag(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('{%') && trimmed.endsWith('%}');
}

/**
 * Returns the heading text if `line` is an H2 or H3 heading that we
 * should split on, else null. Strips the `## ` / `### ` marker and any
 * mkdocs-Material icon prefix (`:material-foo:`) for cleaner display.
 */
function parseSplitHeading(line: string): string | null {
  // H2 — split-eligible.
  if (line.startsWith('## ') && !line.startsWith('### ')) {
    return cleanHeadingText(line.slice(3));
  }
  // H3 — split-eligible. mkdocs Material uses ### as the top user-visible
  // heading in this corpus, so we treat it as a section break too.
  if (line.startsWith('### ') && !line.startsWith('#### ')) {
    return cleanHeadingText(line.slice(4));
  }
  // Top-level admonition — split-eligible, heading = the quoted title.
  // FAQ pages are streams of `??? tenx-x "Question"` blocks with NO
  // H2/H3 between them; without this rule a whole FAQ page collapses
  // into one giant heading-less chunk, so (a) the question text never
  // participates in heading-boost ranking and (b) length normalization
  // buries the page. One chunk per question is the natural retrieval
  // unit for this corpus. Column-0 check excludes nested admonitions.
  const adm = line.match(/^\?\?\?\+?\s+[A-Za-z0-9_-]+\s+"(.+)"(?:\s*\{[^}]*\})?\s*$/);
  if (adm) {
    return cleanHeadingText(adm[1]!.replace(/\\"/g, '"'));
  }
  return null;
}

/**
 * Strip mkdocs-Material inline icons (`:material-foo:`) and surrounding
 * whitespace from a heading. The icon is presentation noise for an
 * agent reading the chunk — it carries no semantic value.
 */
function cleanHeadingText(raw: string): string {
  return raw
    .replace(/:[a-z0-9_-]+:/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the overlap tail to append to the previous chunk. Takes the
 * first ~OVERLAP_MAX_CHARS characters of the next chunk's body, trimmed
 * at a paragraph or sentence boundary so we never cut mid-word.
 */
function buildOverlapTail(nextBody: string): string {
  if (nextBody.length === 0) return '';
  // Drop the heading line itself from the overlap so it doesn't confuse
  // search ranking (the heading is already attached to the next chunk).
  const lines = nextBody.split('\n');
  let bodyOnly = nextBody;
  if (lines[0] !== undefined && /^#{2,4}\s/.test(lines[0])) {
    bodyOnly = lines.slice(1).join('\n');
  }
  const trimmed = bodyOnly.trim();
  if (trimmed.length <= OVERLAP_MAX_CHARS) return trimmed;
  const cut = trimmed.slice(0, OVERLAP_MAX_CHARS);
  // Prefer paragraph boundary; then sentence; then last space.
  const para = cut.lastIndexOf('\n\n');
  if (para > OVERLAP_MAX_CHARS * 0.5) return cut.slice(0, para).trim();
  const sent = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sent > OVERLAP_MAX_CHARS * 0.5) return cut.slice(0, sent + 1).trim();
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}

/**
 * Split a markdown body into H2/H3-bounded chunks, with a brief tail
 * overlap from the following section.
 *
 * The body is the post-frontmatter portion of the page. The caller is
 * responsible for stripping the frontmatter before calling this.
 *
 * @param body  Markdown body (no frontmatter).
 * @param topic Page topic slug, used to build chunk_id.
 */
export function chunkMarkdown(body: string, topic: string): Chunk[] {
  // Strip opaque base64 config-schema dumps before chunking. Pages like
  // run/output/metric/cloudwatch and run/input/analyzer/cloudwatchLogs embed a
  // `<template class="tenx-config-schema" data-encoding="base64">...</template>`
  // blob (decoded client-side by the docs site) that is multi-KB of base64 an
  // agent can never read. Carrying it into chunk.text blows the product_qa
  // output token budget (a single CloudWatch query overflowed at ~74K chars,
  // ~23K of it these blobs). Remove the blocks so the answer chunks stay small.
  body = body.replace(
    /<template\b[^>]*\bdata-encoding="base64"[^>]*>[\s\S]*?<\/template>/gi,
    '',
  );
  const lines = body.split('\n');

  // Pass 1 — group lines into sections. Each section is { heading, bodyLines }.
  const sections: Array<{ heading: string; bodyLines: string[] }> = [
    { heading: '', bodyLines: [] }, // prologue (pre-first-heading)
  ];

  let inFence = false;
  for (const line of lines) {
    if (isCodeFence(line)) {
      inFence = !inFence;
      sections[sections.length - 1]!.bodyLines.push(line);
      continue;
    }
    if (inFence) {
      sections[sections.length - 1]!.bodyLines.push(line);
      continue;
    }
    if (isJinjaTag(line)) {
      sections[sections.length - 1]!.bodyLines.push(line);
      continue;
    }
    // Admonition body lines are indented (>=4 spaces) — they are NOT at
    // column 0, so a leading "## " inside an admonition is already
    // protected by the column-0 check on parseSplitHeading. We don't
    // need a separate admonition guard.
    const heading = parseSplitHeading(line);
    if (heading !== null) {
      sections.push({ heading, bodyLines: [line] });
    } else {
      sections[sections.length - 1]!.bodyLines.push(line);
    }
  }

  // Drop the prologue if it is empty whitespace — no need to emit a
  // blank chunk. Keep it when it has real prose (the intro paragraph).
  const filteredSections =
    sections[0] && sections[0].bodyLines.join('\n').trim() === ''
      ? sections.slice(1)
      : sections;

  if (filteredSections.length === 0) return [];

  // Pass 2 — build chunks, attaching overlap tails.
  const chunks: Chunk[] = [];
  for (let i = 0; i < filteredSections.length; i++) {
    const cur = filteredSections[i]!;
    const next = filteredSections[i + 1];
    let body = cur.bodyLines.join('\n').trim();
    if (next) {
      const tail = buildOverlapTail(next.bodyLines.join('\n'));
      if (tail.length > 0) {
        body = body + '\n\n' + tail;
      }
    }
    chunks.push({
      heading: cur.heading,
      text: body,
      chunk_id: `${topic}#${i}`,
      section_index: i,
    });
  }
  return chunks;
}
