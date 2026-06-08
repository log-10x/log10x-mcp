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
 *   - Boosts (post 2026-06-06 ranking-weakness fix):
 *       slug-token superset (every query token is a slug segment) → +50
 *       slug-token tail subpath (>=2 contiguous trailing tokens)  → +25
 *       per matched slug token                                    → +10
 *       per matched heading token, focus-scaled                   → +4 * focus
 *
 *   - Per-page scores are length-normalized (raw / sqrt(pageTokens))
 *     before boosts are applied. Without this, long body-heavy pages
 *     win on token-shared queries against focused short pages that
 *     are actually on-topic.
 *
 *   - Rare-token gate: a query token whose page-df is below 2% of the
 *     corpus is "discriminating"; when ANY query token is rare (or
 *     missing entirely) AND no rare token has a hit, the search
 *     returns [] so the caller can surface a found:false envelope
 *     instead of low-quality residual matches.
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
  /**
   * Per-page total token count (sum of TF over all chunks). Used as
   * the document-length denominator in BM25-style length normalization,
   * which prevents long body-heavy pages from outranking focused
   * shorter pages on token-shared queries.
   */
  pageTotalTokens: number[];
  /**
   * token → number of distinct PAGES (not chunks) that contain it.
   * Used as the rare-token denominator: a query token is "discriminating"
   * when (pageDf / pages.length) is below a small fraction. The chunk-
   * level df is too noisy for that decision because one big page can
   * push a token into many chunk postings.
   */
  pageDf: Map<string, number>;
}

/**
 * Build an inverted index from a loaded corpus. Run once at startup,
 * pass the resulting SearchIndex to `searchIndex()` for each query.
 */
export function buildIndex(pages: Page[]): SearchIndex {
  const postings = new Map<string, Array<{ ref: ChunkRef; tf: number }>>();
  const df = new Map<string, number>();
  const pageDf = new Map<string, number>();
  const pageTotalTokens: number[] = new Array(pages.length).fill(0);
  let totalChunks = 0;
  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx]!;
    const pageTokensSeen = new Set<string>();
    let pageTokenCount = 0;
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
        pageTokensSeen.add(tok);
        pageTokenCount += count;
      }
    }
    pageTotalTokens[pageIdx] = pageTokenCount;
    for (const tok of pageTokensSeen) {
      pageDf.set(tok, (pageDf.get(tok) ?? 0) + 1);
    }
  }
  return { pages, postings, df, totalChunks, pageTotalTokens, pageDf };
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
  // Heading boost — independent of TF. Two changes vs the old +2/token:
  //   1. Raise the base boost to +4 per matched token (was +2). Short
  //      on-point headings deserve more credit than weak body hits.
  //   2. Scale by (queryTokenCount / headingTokenCount). A 2-word heading
  //      "Splunk Optimization" matched by 2 of 3 query tokens scores
  //      4 * 1.0 = 4. A 15-word heading that incidentally contains the
  //      same tokens scores 4 * (3/15) = 0.8. Short on-point headings
  //      now outrank long incidental ones.
  const headingTokens = tokenize(chunk.heading);
  if (headingTokens.length > 0 && queryTokens.length > 0) {
    const headingSet = new Set(headingTokens);
    let matched = 0;
    for (const qt of queryTokens) if (headingSet.has(qt)) matched += 1;
    if (matched > 0) {
      const focus = queryTokens.length / headingTokens.length;
      score += 4 * matched * focus;
    }
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
 *   minScore — drop results whose final (length-normalized) score is
 *              below this floor. Default 0.5. Without this, queries
 *              whose only matching tokens are common filler words
 *              return junk hits instead of falling through to the
 *              found:false / similar_topics path in product-qa.
 */
export interface SearchOptions {
  query: string;
  category?: string;
  maxPages?: number;
  maxChunksPerPage?: number;
  minScore?: number;
}

/**
 * Token frequency below which a query token is considered "rare" /
 * "discriminating". When ANY query token is rare (or absent from the
 * corpus entirely), at least one rare token must hit a posting list
 * for the search to return results. This prevents low-quality fallback
 * matches when the distinctive token in the query (e.g. a competitor
 * name like "grepr") has df=0 and the score is carried entirely by
 * common residual tokens.
 */
const RARE_TOKEN_PAGE_DF_FRACTION = 0.02;

/** Default minScore floor — see SearchOptions.minScore. */
const DEFAULT_MIN_SCORE = 0.5;

/**
 * Run a TF-IDF search against an in-memory index.
 *
 * Returns the top-N SearchResult[] ordered by score descending. Each
 * result carries only its top-K matched_chunks to keep responses small.
 *
 * Scoring overview (after the 2026-06-06 ranking-weakness fix pass):
 *
 *   1. Per-chunk TF-IDF + heading-focus boost (see `scoreChunk`).
 *   2. Per-page score = sum of top-K chunk scores, then divided by
 *      `sqrt(pageTotalTokens)` so long body-heavy pages cannot drown
 *      focused short FAQ pages on token-shared queries.
 *   3. Slug boosts on the normalized score:
 *        +50 when the slug is a token-superset of the query
 *        +25 when the query tokens match a contiguous tail subpath
 *        +10 per matched slug token otherwise (was +5)
 *      The old "querySlug-as-string" comparison (querySlug retained
 *      whitespace, so it never matched natural-language queries) is gone.
 *   4. Rare-token gate: when any query token has df/totalChunks below
 *      RARE_TOKEN_PAGE_DF_FRACTION (or is absent entirely), at least
 *      one of those rare tokens must hit. Otherwise [] is returned so
 *      the caller's fallback (found:false + similar_topics) fires.
 *   5. minScore floor (default DEFAULT_MIN_SCORE) drops any normalized
 *      result below the threshold.
 */
export function searchIndex(index: SearchIndex, opts: SearchOptions): SearchResult[] {
  const queryTokens = tokenize(opts.query);
  if (queryTokens.length === 0) return [];
  const maxPages = opts.maxPages ?? 10;
  const maxChunksPerPage = opts.maxChunksPerPage ?? 3;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;

  // ── Rare-token gate ────────────────────────────────────────────────
  // Identify the set of "rare" query tokens — those with low corpus
  // page-frequency (or absent altogether). When the query carries any
  // rare token, at least one must hit a posting list. If none do, the
  // residual score comes entirely from common tokens (e.g. "pattern",
  // "hash", "different" minus the absent "grepr") which produces junk
  // hits like docs/run/input/extract. Return [] so product-qa's
  // found:false + similar_topics fallback fires instead.
  const totalPages = Math.max(index.pages.length, 1);
  const rareTokens: string[] = [];
  for (const qt of queryTokens) {
    const pdf = index.pageDf.get(qt) ?? 0;
    if (pdf === 0 || pdf / totalPages < RARE_TOKEN_PAGE_DF_FRACTION) {
      rareTokens.push(qt);
    }
  }
  if (rareTokens.length > 0) {
    const anyRareHit = rareTokens.some((qt) => (index.pageDf.get(qt) ?? 0) > 0);
    if (!anyRareHit) {
      // The distinguishing token(s) are missing from the corpus.
      // Bail out so the caller surfaces "not found" + similar_topics
      // rather than residual common-token noise.
      return [];
    }
  }

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

  // Build SearchResult[] with slug-token boosts + category filter.
  const querySlugTokenSet = new Set(queryTokens);
  const results: SearchResult[] = [];
  for (const [pageIdx, chunkScores] of perPage) {
    const page = index.pages[pageIdx]!;
    if (opts.category && page.category !== opts.category) continue;
    chunkScores.sort((a, b) => b.score - a.score);
    const topChunks = chunkScores.slice(0, maxChunksPerPage);
    const rawPageScore = topChunks.reduce((a, b) => a + b.score, 0);
    // Document-length normalization (BM25-style |d|^0.5). Without this
    // a long body-heavy page like apps/receiver/deploy that mentions
    // many query tokens many times wins over a short focused FAQ page
    // that is actually on-topic. Use a sqrt rather than linear |d| so
    // we still reward pages that carry strong evidence in absolute
    // terms — pure linear normalization over-penalizes legitimately
    // dense pages.
    const totalTokens = index.pageTotalTokens[pageIdx] ?? 1;
    const pageScore = rawPageScore / Math.sqrt(Math.max(totalTokens, 1));

    // ── Slug boosts ──────────────────────────────────────────────────
    // The old code compared a raw query string against the slug. That
    // path was effectively dead for natural-language queries because
    // the raw string never matched a "/"-joined slug. The new path
    // works in slug-token space.
    let boost = 0;
    const slugTokens = tokenize(page.topic);
    const slugTokenSet = new Set(slugTokens);
    // (a) Superset boost: every query token appears as a slug segment.
    let allInSlug = querySlugTokenSet.size > 0;
    for (const qt of querySlugTokenSet) {
      if (!slugTokenSet.has(qt)) {
        allInSlug = false;
        break;
      }
    }
    if (allInSlug) boost += 50;
    // (b) Contiguous-tail boost: >=2 query tokens match a trailing
    // subpath of the slug. Example: query "splunk optimization"
    // tokenises to ["splunk", "optimization"]; slug
    // "faq/stacks/splunk/optimization" tokenises to
    // ["faq","stacks","splunk","optimization"] — tail subpath matches.
    if (!allInSlug && slugTokens.length >= 2 && queryTokens.length >= 2) {
      // For each contiguous tail of slugTokens of length >=2, check
      // whether the trailing tokens of the query (in order) match.
      const overlap = Math.min(slugTokens.length, queryTokens.length);
      for (let k = 2; k <= overlap; k++) {
        const slugTail = slugTokens.slice(slugTokens.length - k);
        const queryTail = queryTokens.slice(queryTokens.length - k);
        let match = true;
        for (let i = 0; i < k; i++) {
          if (slugTail[i] !== queryTail[i]) {
            match = false;
            break;
          }
        }
        if (match) {
          boost += 25;
          break;
        }
      }
    }
    // (c) Per-matched-slug-token boost. Raised from +5 to +10 so a
    // 2-of-3 slug overlap is meaningful even without the superset boost.
    let perTokenBoost = 0;
    for (const qt of queryTokens) {
      if (slugTokenSet.has(qt)) perTokenBoost += 10;
    }
    boost += perTokenBoost;

    const finalScore = pageScore + boost;
    if (finalScore < minScore) continue;

    const matchedChunks: Chunk[] = topChunks.map((c) => page.chunks[c.chunkIdx]!);
    results.push({
      topic: page.topic,
      category: page.category,
      canonical_url: page.canonical_url,
      summary: page.summary,
      matched_chunks: matchedChunks,
      score: finalScore,
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
