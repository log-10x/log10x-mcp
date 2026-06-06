/**
 * product-kb — barrel export + singleton corpus loader.
 *
 * Boot path
 *
 *   1. Server starts. First call to `getKnowledgeBase()` triggers a
 *      one-shot walk + index build. Subsequent calls reuse the cached
 *      handle.
 *
 *   2. Corpus path resolution:
 *        a. LOG10X_PRODUCT_KB_PATH env var, if set
 *        b. default: ../../../../config/mksite/docs relative to the
 *           build directory (covers `npm start` from the build dir
 *           AND `node build/index.js` from elsewhere — we resolve
 *           relative to this module's URL, not cwd)
 *
 *   3. If the resolved path is missing or empty, the loader returns
 *      an empty corpus. The tool surfaces this as a structured
 *      `not_configured` envelope rather than crashing.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadCorpus } from './loader.js';
import { buildIndex, type SearchIndex } from './search.js';
import type { Page } from './types.js';

export type { Chunk, Page, SearchResult } from './types.js';
export { chunkMarkdown } from './chunker.js';
export { loadCorpus, loadPage, type LoadCorpusOptions } from './loader.js';
export {
  buildIndex,
  searchIndex,
  lookupTopic,
  nearestTopics,
  tokenize,
  type SearchIndex,
  type SearchOptions,
} from './search.js';

/**
 * The cached knowledge-base handle. `pages` is the flat corpus;
 * `index` is the inverted index used for search.
 */
export interface KnowledgeBase {
  pages: Page[];
  index: SearchIndex;
  /** Absolute path the corpus was loaded from (for diagnostics). */
  source: string;
}

let cached: KnowledgeBase | null = null;

/**
 * Resolve the docs root directory. Honours LOG10X_PRODUCT_KB_PATH when
 * set, else falls back to a path relative to this module's directory
 * that points at config/mksite/docs in the sibling repo. The fallback
 * is a development-time convenience — production deploys should set
 * LOG10X_PRODUCT_KB_PATH explicitly to a path that travels with the
 * build artefact.
 */
export function resolveCorpusPath(): string {
  const envOverride = process.env.LOG10X_PRODUCT_KB_PATH;
  if (envOverride && envOverride.length > 0) {
    return envOverride;
  }
  // this file: <repo>/build/lib/product-kb/index.js (post-tsc)
  //   or:     <repo>/src/lib/product-kb/index.ts (pre-tsc, ts-node)
  const here = dirname(fileURLToPath(import.meta.url));
  // Default: walk up to <log10x-mcp> parent, then sibling config repo.
  // <here>/../../../../../eclipse-workspace/l1x-co/config/mksite/docs is
  // the dev-machine layout; we also try a build-time copied path.
  const candidates = [
    // Build-time copy (npm run build): cp -r config/mksite/docs build/product-kb/docs
    // From build/lib/product-kb/index.js → build/product-kb/docs
    resolve(here, '../../product-kb/docs'),
    resolve(here, '../../../product-kb/docs'),            // belt-and-suspenders
    resolve(here, '../../product-kb-data'),               // legacy build-time copy name
    resolve(here, '../../../product-kb-data'),            // build/lib/ -> build/
    resolve(here, '../../../../config/mksite/docs'),      // repo sibling
    resolve(here, '../../../../../config/mksite/docs'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall through to the first candidate so the error path surfaces a
  // useful "looked here" string instead of an empty value.
  return candidates[0]!;
}

/**
 * Load the knowledge base once and cache it for the life of the
 * process. Subsequent calls reuse the cached handle.
 */
export function getKnowledgeBase(): KnowledgeBase {
  if (cached) return cached;
  const source = resolveCorpusPath();
  const pages = loadCorpus({ docsRoot: source });
  const index = buildIndex(pages);
  cached = { pages, index, source };
  return cached;
}

/**
 * Reset the cached handle. Test-only — production code should not
 * need to invalidate the cache because the corpus is shipped with
 * the build.
 */
export function _resetKnowledgeBaseCache(): void {
  cached = null;
}
