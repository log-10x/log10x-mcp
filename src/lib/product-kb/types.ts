/**
 * product-kb/types — shared TypeScript types for the product knowledge-base
 * corpus loader, H2-section chunker, and search.
 *
 * The corpus is a tree of markdown files under config/mksite/docs/. Each
 * file becomes a Page. Each H2 (or H3) section of a page becomes a Chunk.
 * Search returns SearchResult[] with the relevant chunks attached.
 */

/**
 * A single H2/H3-bounded section of a documentation page.
 *
 *   heading       — the literal heading text (e.g. "Capabilities", "Use Cases")
 *                   or the empty string for the prologue / pre-first-heading
 *                   chunk.
 *   text          — the full markdown body of the section, including a brief
 *                   overlap tail from the next section (~200 chars max) to
 *                   preserve cross-section context for search.
 *   chunk_id      — stable identifier "<topic>#<section_index>". Useful for
 *                   debugging and for the agent to cite a specific section
 *                   back to the user.
 *   section_index — 0-based index of this section within the page. The
 *                   prologue (if any) is index 0; the first H2 is 1, etc.
 */
export interface Chunk {
  heading: string;
  text: string;
  chunk_id: string;
  section_index: number;
}

/**
 * A single markdown page in the corpus.
 *
 *   topic         — file path relative to mksite/docs root, sans .md.
 *                   Example: "faq/security/data-protection". The path
 *                   separator is preserved as "/".
 *   category      — first segment of the topic. One of:
 *                   faq | apps | manage | engine | api | config | etc.
 *   canonical_url — public docs URL the agent can cite to the user.
 *   summary       — first non-empty paragraph from the body (frontmatter
 *                   stripped, headings stripped).
 *   last_reviewed — ISO timestamp. From frontmatter `last_reviewed:` if
 *                   present, else falls back to the file mtime.
 *   chunks        — H2-section-aware chunk list.
 */
export interface Page {
  topic: string;
  category: string;
  canonical_url: string;
  summary: string;
  last_reviewed: string;
  chunks: Chunk[];
}

/**
 * A ranked search hit.
 *
 *   matched_chunks — ONLY the chunks that contributed to the score. This
 *                    keeps response size bounded and lets the agent quote
 *                    the exact relevant section, not the whole page.
 *   score          — TF-IDF score (higher = better match). Topic-slug
 *                    exact-match boost is folded in.
 */
export interface SearchResult {
  topic: string;
  category: string;
  canonical_url: string;
  summary: string;
  matched_chunks: Chunk[];
  score: number;
}
