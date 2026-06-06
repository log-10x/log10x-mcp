/**
 * product-kb/search — in-memory TF-IDF search over a Page[] corpus.
 *
 * Design notes
 *
 *   - The corpus is small (~135 pages, ~1500 chunks). A full in-memory
 *     inverted index fits in well under 5 MB and rebuilds at startup
 *     in <100ms. No persistence needed.
 *
 *   - Tokenisation: lowercase, split on whitespace + punctuation, drop
 *     short-stopwords. The corpus is technical English; aggressive
 *     stemming would hurt precision (collapse "patterns" → "pattern"
 *     is fine, but "metric" → "metr" is not).
 *
 *   - Scoring: classic TF-IDF on the chunk level. Per-document (page)
 *     score is the max over its chunks — the user wants to find the
 *     ONE chunk that answers their question, not an average over
 *     unrelated sections.
 *
 *   - Boosts:
 *       topic-slug exact match  → +50 (huge, dominates everything else)
 *       topic-slug token match  → +5 per token (smaller, additive)
 *       heading token match     → +2 per token (small, additive)
 *
 *   - SearchResult.matched_chunks contains ONLY the top-scoring chunks
 *     per page (max 3), not the whole page. Keeps the envelope small.
 */

import type { Chunk, Page, SearchResult } from './types.js';

/** Stopwords — very common English filler that adds noise to TF-IDF. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'does',
  'for', 'from', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'so', 's', 't',
  'that', 'the', 'this', 'to', 'too', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);

/**
 * Tokenise a string for indexing or query parsing. Lowercase, split on
 * any non-alphanumeric character, drop stopwords and single chars.
 *
 * Preserves "pattern_hash" and similar underscore-joined identifiers
 * because they are user-facing field names in this product.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((tok) => tok.length > 1 && !STOPWORDS.has(tok));
}

/** A flattened chunk reference into the corpus, used by the indexer. */
interface ChunkRef {
  pageIdx: number;
  chunkIdx: number;
}

/** The inverted index produced by buildIndex(). */
export interface SearchIndex {
  pages: Page[];
  /** token → list of (page, chunk) refs that contain it, with TF. */
  postings: Map<string, Array<{ ref: ChunkRef; tf: number }>>;
  /** token → number of distinct chunks that contain it (for IDF). */
  df: Map<string, number>;
  /** Total chunk count across the corpus (for IDF denominator). */
  totalChunks: number;
}

/**
 * Build an inverted index from a loaded corpus. Run once at startup,
 * pass the resulting SearchIndex to `searchIndex()` for each query.
 */
export function buildIndex(pages: Page[]): SearchIndex {
  const postings = new Map<string, Array<{ ref: ChunkRef; tf: number }>>();
  const df = new Map<string, number>();
  let totalChunks = 0;
  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx]!;
    for (let chunkIdx = 0; chunkIdx < page.chunks.length; chunkIdx++) {
      const chunk = page.chunks[chunkIdx]!;
      totalChunks += 1;
      const tf = new Map<string, number>();
      // Index chunk body + heading.
      for (const tok of tokenize(chunk.text)) {
        tf.set(tok, (tf.get(tok) ?? 0) + 1);
      }
      for (const tok of tokenize(chunk.heading)) {
        // Boost heading tokens by counting them 3x in TF.
        tf.set(tok, (tf.get(tok) ?? 0) + 3);
      }
      for (const [tok, count] of tf) {
        let list = postings.get(tok);
        if (!list) {
          list = [];
          postings.set(tok, list);
        }
        list.push({ ref: { pageIdx, chunkIdx }, tf: count });
        df.set(tok, (df.get(tok) ?? 0) + 1);
      }
    }
  }
  return { pages, postings, df, totalChunks };
}

/** Score one chunk against a tokenised query using TF-IDF. */
function scoreChunk(
  index: SearchIndex,
  ref: ChunkRef,
  queryTokens: string[],
): number {
  const page = index.pages[ref.pageIdx]!;
  const chunk = page.chunks[ref.chunkIdx]!;
  let score = 0;
  for (const qt of queryTokens) {
    const postingList = index.postings.get(qt);
    if (!postingList) continue;
    const hit = postingList.find(
      (p) => p.ref.pageIdx === ref.pageIdx && p.ref.chunkIdx === ref.chunkIdx,
    );
    if (!hit) continue;
    const docFreq = index.df.get(qt) ?? 1;
    const idf = Math.log((index.totalChunks + 1) / (docFreq + 1)) + 1;
    score += hit.tf * idf;
  }
  // Heading boost — independent of TF.
  const headingTokens = new Set(tokenize(chunk.heading));
  for (const qt of queryTokens) {
    if (headingTokens.has(qt)) score += 2;
  }
  return score;
}

/**
 * Options for `searchIndex()`.
 *
 *   query    — natural-language query string.
 *   category — when set, restrict results to pages in this category
 *              (faq / apps / engine / api / config / manage).
 *   maxPages — cap the number of pages returned (default 10).
 *   maxChunksPerPage — cap matched_chunks per page (default 3).
 */
export interface SearchOptions {
  query: string;
  category?: string;
  maxPages?: number;
  maxChunksPerPage?: number;
}

/**
 * Run a TF-IDF search against an in-memory index.
 *
 * Returns the top-N SearchResult[] ordered by score descending. Each
 * result carries only its top-K matched_chunks to keep responses small.
 */
export function searchIndex(index: SearchIndex, opts: SearchOptions): SearchResult[] {
  const queryTokens = tokenize(opts.query);
  if (queryTokens.length === 0) return [];
  const maxPages = opts.maxPages ?? 10;
  const maxChunksPerPage = opts.maxChunksPerPage ?? 3;
  const querySlug = opts.query.toLowerCase().trim();

  // Per-page accumulator: chunkScores[pageIdx] = [{ chunkIdx, score }]
  const perPage = new Map<number, Array<{ chunkIdx: number; score: number }>>();
  const candidateChunks = new Set<string>(); // pageIdx:chunkIdx dedupe

  for (const qt of queryTokens) {
    const postingList = index.postings.get(qt);
    if (!postingList) continue;
    for (const hit of postingList) {
      const key = `${hit.ref.pageIdx}:${hit.ref.chunkIdx}`;
      if (candidateChunks.has(key)) continue;
      candidateChunks.add(key);
      const s = scoreChunk(index, hit.ref, queryTokens);
      if (s <= 0) continue;
      let list = perPage.get(hit.ref.pageIdx);
      if (!list) {
        list = [];
        perPage.set(hit.ref.pageIdx, list);
      }
      list.push({ chunkIdx: hit.ref.chunkIdx, score: s });
    }
  }

  // Build SearchResult[] with topic-slug boosts + category filter.
  const results: SearchResult[] = [];
  for (const [pageIdx, chunkScores] of perPage) {
    const page = index.pages[pageIdx]!;
    if (opts.category && page.category !== opts.category) continue;
    chunkScores.sort((a, b) => b.score - a.score);
    const topChunks = chunkScores.slice(0, maxChunksPerPage);
    const pageScore = topChunks.reduce((a, b) => a + b.score, 0);
    let boost = 0;
    // Topic-slug exact match — huge boost.
    if (page.topic.toLowerCase() === querySlug) boost += 50;
    else if (page.topic.toLowerCase().endsWith('/' + querySlug)) boost += 30;
    // Topic-slug token overlap — small per-token boost.
    const topicTokens = new Set(tokenize(page.topic));
    for (const qt of queryTokens) {
      if (topicTokens.has(qt)) boost += 5;
    }
    const matchedChunks: Chunk[] = topChunks.map((c) => page.chunks[c.chunkIdx]!);
    results.push({
      topic: page.topic,
      category: page.category,
      canonical_url: page.canonical_url,
      summary: page.summary,
      matched_chunks: matchedChunks,
      score: pageScore + boost,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxPages);
}

/**
 * Exact slug lookup. Returns the matching page wrapped as a
 * SearchResult, or null when no page has that topic.
 *
 * Used by the `topic` arg path of the product_qa tool. We carry the
 * first 3 chunks as matched_chunks so the agent has immediate context
 * without a follow-up call.
 */
export function lookupTopic(index: SearchIndex, topic: string): SearchResult | null {
  const norm = topic.toLowerCase().replace(/^\/+|\/+$/g, '');
  const page = index.pages.find((p) => p.topic.toLowerCase() === norm);
  if (!page) return null;
  return {
    topic: page.topic,
    category: page.category,
    canonical_url: page.canonical_url,
    summary: page.summary,
    matched_chunks: page.chunks.slice(0, 3),
    score: 100, // exact-hit sentinel
  };
}

/**
 * Return the N topic slugs that are textually closest to the given
 * query (by token overlap on the slug). Used when an exact-topic
 * lookup misses, so we can suggest "did you mean…" candidates.
 */
export function nearestTopics(index: SearchIndex, query: string, n = 5): string[] {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) {
    // Fall back to substring match.
    const q = query.toLowerCase();
    return index.pages
      .filter((p) => p.topic.toLowerCase().includes(q))
      .slice(0, n)
      .map((p) => p.topic);
  }
  const scored: Array<{ topic: string; score: number }> = [];
  for (const page of index.pages) {
    const pTokens = new Set(tokenize(page.topic));
    let overlap = 0;
    for (const qt of qTokens) if (pTokens.has(qt)) overlap += 1;
    if (overlap > 0) {
      scored.push({ topic: page.topic, score: overlap });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map((s) => s.topic);
}
