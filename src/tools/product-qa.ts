/**
 * log10x_product_qa — answer product questions from the shipped docs corpus.
 *
 * Why this tool exists
 *
 *   Agents constantly hit factual questions about Log10x — "what is the
 *   Receiver", "how does pattern_hash work", "what data leaves my
 *   network" — that should NOT be answered from the model's training
 *   data. The docs corpus under config/mksite/docs/ is the source of
 *   truth, and shipping it inside the MCP build (chunked + indexed)
 *   gives agents a grounded answer in one tool call.
 *
 * Inputs
 *
 *   topic       — exact slug lookup (e.g. "faq/security/data-protection").
 *                 Highest priority; bypasses search.
 *   query       — natural-language query for TF-IDF search.
 *   category    — narrow search to one category (faq / apps / engine /
 *                 api / config / manage). Combines with `query`.
 *   max_results — cap on returned SearchResult[] (default 3).
 *
 * Output (envelope.data.payload)
 *
 *   found           — boolean. True when at least one result was found.
 *   results         — ranked SearchResult[] (capped at max_results).
 *   similar_topics  — when found=false, top-5 nearest topic slugs as a
 *                     "did you mean…" hint.
 *
 * The envelope itself is the standard chassis envelope so agents can
 * branch on status / read scope / cite canonical_url.
 */

import { z } from 'zod';
import { buildChassisEnvelope, newChassisTelemetry } from '../lib/chassis-envelope.js';
import {
  getKnowledgeBase,
  lookupTopic,
  nearestTopics,
  searchIndex,
  type SearchResult,
} from '../lib/product-kb/index.js';
import type { Action, StructuredOutput } from '../lib/output-types.js';

// ── Schema ───────────────────────────────────────────────────────────────────

/**
 * Tool input schema. `topic` / `query` / `category` are all optional
 * but at least one of `topic` / `query` must be present. The handler
 * surfaces an `error` envelope when both are missing.
 */
export const productQaSchema = {
  topic: z
    .string()
    .optional()
    .describe(
      'Exact docs slug to fetch. Example: "faq/security/data-protection" or "apps/receiver". ' +
      'When provided, bypasses search and returns the page directly.',
    ),
  query: z
    .string()
    .optional()
    .describe(
      'Natural-language query. Examples: "what data leaves my network", ' +
      '"how is pattern_hash computed", "does the Reporter modify data". ' +
      'Ignored when `topic` is set.',
    ),
  category: z
    .string()
    .optional()
    .describe(
      'Restrict results to one category. One of: faq, apps, engine, api, ' +
      'config, manage. Combines with `query`.',
    ),
  max_results: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe('Cap on the number of results returned. Default 3.'),
  depth: z
    .enum(['short', 'full'])
    .optional()
    .describe(
      'Response detail. "short" (default) returns a tight grounded answer plus citation metadata ' +
      '(topic + canonical_url, no section bodies) and offers a chained learn_more action per citation. ' +
      '"full" returns the matched section bodies for one specific page and is requested via the ' +
      'learn_more action the short response hands back (pass that action verbatim: `topic` + `depth: "full"`).',
    ),
};

const productQaInputSchema = z.object(productQaSchema);
export type ProductQaInput = z.infer<typeof productQaInputSchema>;

/**
 * Tool payload shape (the value placed at envelope.data.payload).
 * Exported so tests and downstream consumers can type-check the
 * envelope without re-deriving it from the Zod schema.
 */
export interface ProductQaPayload {
  found: boolean;
  // Present in full mode (depth='full') and on no-match (empty). Omitted in
  // the short default, which carries `answer` + `citations` instead.
  results?: SearchResult[];
  answer?: string;
  citations?: ProductQaCitation[];
  similar_topics?: string[];
  resolved_mode: 'topic' | 'query' | 'none';
  corpus_source: string;
}

/**
 * A compact doc citation: metadata only, no section body. Roughly 120
 * bytes each, so several stay well under the short-response budget.
 */
export interface ProductQaCitation {
  topic: string;
  category: string;
  canonical_url: string;
  heading: string;
}

/**
 * Short-mode payload (depth='short', the default). Carries one grounded
 * answer plus citation metadata and ZERO section bodies, which is the
 * size fix: section text is emitted only on depth='full'.
 */
export interface ProductQaShortPayload {
  found: boolean;
  answer: string;
  citations: ProductQaCitation[];
  resolved_mode: 'topic' | 'query';
  corpus_source: string;
}

// Max chars of the top section surfaced as the short grounded answer.
const SHORT_ANSWER_BUDGET = 600;

/**
 * Build a tight, grounded answer from a result's best section. The text
 * is verbatim-derived from a section the tool retrieved (nothing is
 * fabricated): markdown noise is flattened to single spaces and the body
 * is cut at a sentence boundary within SHORT_ANSWER_BUDGET chars. Falls
 * back to the page summary when the result carries no section text.
 */
function shortAnswer(result: SearchResult): string {
  const top = result.matched_chunks[0];
  const flat = (top?.text ?? result.summary ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= SHORT_ANSWER_BUDGET) return flat;
  const window = flat.slice(0, SHORT_ANSWER_BUDGET);
  const cut = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  );
  return cut > 0 ? window.slice(0, cut + 1) : window.trimEnd();
}

/** Reduce a result to citation metadata only (no section body). */
function toCitation(result: SearchResult): ProductQaCitation {
  return {
    topic: result.topic,
    category: result.category,
    canonical_url: result.canonical_url,
    heading: result.matched_chunks[0]?.heading ?? '',
  };
}

/**
 * The chained learn_more action. Carries the exact slug the tool just
 * returned plus depth='full', so the agent re-fires it with no blanks
 * and lands on exactly one page's full sections.
 */
function learnMoreAction(result: SearchResult): Action {
  return {
    tool: 'log10x_product_qa',
    args: { topic: result.topic, depth: 'full' },
    reason: `Read the full matched sections of "${result.topic}" (cite ${result.canonical_url}).`,
    role: 'recommended-next',
  };
}

/**
 * Assemble the short-default envelope shared by the topic-exact and query
 * branches: a grounded answer + citation metadata + one learn_more action
 * per citation. Emits no section bodies.
 */
function buildShortEnvelope(opts: {
  results: SearchResult[];
  mode: 'topic' | 'query';
  corpusSource: string;
  candidatesCount: number;
  telemetry: ReturnType<typeof newChassisTelemetry>;
}): StructuredOutput {
  const { results, mode, corpusSource, candidatesCount, telemetry } = opts;
  const top = results[0]!;
  const citations = results.map(toCitation);
  const topHeading = citations[0]!.heading;
  return buildChassisEnvelope({
    tool: 'log10x_product_qa',
    view: 'summary',
    headline: topHeading ? `${top.topic}: ${topHeading}` : `${top.topic}`,
    status: 'success',
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {},
    scope: {
      window: 'point_in_time',
      window_basis: 'auto_default',
      candidates_count: candidatesCount,
      candidates_evaluated: results.length,
    },
    payload: {
      found: true,
      answer: shortAnswer(top),
      citations,
      resolved_mode: mode,
      corpus_source: corpusSource,
    } satisfies ProductQaShortPayload,
    human_summary:
      'Answer the user from `answer` and cite the citation canonical_urls. ' +
      'Lead with the plain-language benefit (for example, "10x groups your logs by message type ' +
      'so you can see what is driving cost and cut it"); do not open with internal jargon like ' +
      '"stable pattern identity", "fingerprint", or "hash". ' +
      'For the full section bodies of one page, follow the matching learn_more action in actions[] ' +
      '(it carries the exact `topic` and `depth: "full"`).',
    actions: citations.map((_c, i) => learnMoreAction(results[i]!)),
    telemetry,
  });
}

// ── Handler ──────────────────────────────────────────────────────────────────

/**
 * Execute the product_qa tool. Returns a standard chassis envelope
 * with the payload described above.
 *
 * Exported for direct invocation from tests; the index.ts registration
 * wraps this in the standard chassis `wrap()` like other tools.
 */
export function executeProductQa(rawArgs: unknown): StructuredOutput {
  const telemetry = newChassisTelemetry();
  const args = productQaInputSchema.parse(rawArgs ?? {});
  const maxResults = args.max_results ?? 3;
  const depth = args.depth ?? 'short';

  // At least one of topic / query must be present.
  if (!args.topic && !args.query) {
    return buildChassisEnvelope({
      tool: 'log10x_product_qa',
      view: 'summary',
      headline: 'product_qa needs either `topic` or `query`.',
      status: 'error',
      error: {
        error_type: 'input_invalid',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'Pass `topic: "<docs-slug>"` for an exact-page lookup OR `query: "<natural language>"` for a search. Both may be omitted, but not at the same time.',
      },
      decisions: { threshold_used: null, threshold_basis: 'default' },
      source_disclosure: {},
      scope: { window: 'point_in_time', window_basis: 'auto_default' },
      payload: {
        found: false,
        results: [],
        resolved_mode: 'none' as const,
        corpus_source: '',
      } satisfies ProductQaPayload,
      human_summary:
        'Call product_qa with at least one of `topic` or `query`. Use `topic` when you already know the docs slug, `query` for natural-language search.',
      telemetry,
    });
  }

  const kb = getKnowledgeBase();

  // Branch 1 — exact topic lookup.
  if (args.topic) {
    const hit = lookupTopic(kb.index, args.topic);
    if (hit) {
      // Optional category filter on the exact hit.
      if (args.category && hit.category !== args.category) {
        return buildChassisEnvelope({
          tool: 'log10x_product_qa',
          view: 'summary',
          headline: `Topic "${args.topic}" exists but is in category "${hit.category}", not "${args.category}".`,
          status: 'no_signal',
          decisions: { threshold_used: null, threshold_basis: 'default' },
          source_disclosure: {},
          scope: {
            window: 'point_in_time',
            window_basis: 'auto_default',
            candidates_count: kb.pages.length,
          },
          payload: {
            found: false,
            results: [],
            similar_topics: [hit.topic],
            resolved_mode: 'topic' as const,
            corpus_source: kb.source,
          } satisfies ProductQaPayload,
          human_summary: `The page "${hit.topic}" was found, but it lives under category "${hit.category}". Re-call without the category filter to see it.`,
          telemetry,
        });
      }
      // Short (default): grounded answer + one citation + a learn_more chain.
      if (depth !== 'full') {
        return buildShortEnvelope({
          results: [hit],
          mode: 'topic',
          corpusSource: kb.source,
          candidatesCount: kb.pages.length,
          telemetry,
        });
      }
      // Full: the long-form section bodies for this one page (opt-in).
      return buildChassisEnvelope({
        tool: 'log10x_product_qa',
        view: 'summary',
        headline: `Found "${hit.topic}". ${hit.summary.slice(0, 120)}`,
        status: 'success',
        decisions: { threshold_used: null, threshold_basis: 'default' },
        source_disclosure: {},
        scope: {
          window: 'point_in_time',
          window_basis: 'auto_default',
          candidates_count: kb.pages.length,
          candidates_evaluated: 1,
        },
        payload: {
          found: true,
          results: [hit],
          resolved_mode: 'topic' as const,
          corpus_source: kb.source,
        } satisfies ProductQaPayload,
        human_summary: `Full sections of "${hit.topic}". Quote matched_chunks and cite ${hit.canonical_url}.`,
        telemetry,
      });
    }
    // Topic miss — fall through to nearest-slug suggestions.
    const similar = nearestTopics(kb.index, args.topic, 5);
    return buildChassisEnvelope({
      tool: 'log10x_product_qa',
      view: 'summary',
      headline: `No page at "${args.topic}".${similar.length ? ' See similar_topics.' : ''}`,
      status: 'no_signal',
      decisions: { threshold_used: null, threshold_basis: 'default' },
      source_disclosure: {},
      scope: {
        window: 'point_in_time',
        window_basis: 'auto_default',
        candidates_count: kb.pages.length,
      },
      payload: {
        found: false,
        results: [],
        similar_topics: similar,
        resolved_mode: 'topic' as const,
        corpus_source: kb.source,
      } satisfies ProductQaPayload,
      human_summary:
        similar.length > 0
          ? `No page at "${args.topic}". Nearest slugs: ${similar.join(', ')}. Try one of those, or pass a free-text query.`
          : `No page at "${args.topic}" and no near matches. Try a free-text query.`,
      telemetry,
    });
  }

  // Branch 2 — query search.
  const query = args.query!;
  const results = searchIndex(kb.index, {
    query,
    category: args.category,
    maxPages: maxResults,
  });

  if (results.length === 0) {
    const similar = nearestTopics(kb.index, query, 5);
    return buildChassisEnvelope({
      tool: 'log10x_product_qa',
      view: 'summary',
      headline: `No hits for "${query}"${args.category ? ` in category "${args.category}"` : ''}.`,
      status: 'no_signal',
      decisions: { threshold_used: null, threshold_basis: 'default' },
      source_disclosure: {},
      scope: {
        window: 'point_in_time',
        window_basis: 'auto_default',
        candidates_count: kb.pages.length,
      },
      payload: {
        found: false,
        results: [],
        similar_topics: similar,
        resolved_mode: 'query' as const,
        corpus_source: kb.source,
      } satisfies ProductQaPayload,
      human_summary:
        similar.length > 0
          ? `No matches. Nearest topic slugs by name: ${similar.join(', ')}. Try one as the topic arg, or rephrase the query.`
          : `No matches for that query in the docs corpus${args.category ? ` (category="${args.category}")` : ''}. Try a broader query or drop the category filter.`,
      telemetry,
    });
  }

  // Short (default): one grounded answer + citation metadata for the top
  // pages, each with a concrete learn_more chain. No section bodies.
  if (depth !== 'full') {
    return buildShortEnvelope({
      results,
      mode: 'query',
      corpusSource: kb.source,
      candidatesCount: kb.pages.length,
      telemetry,
    });
  }

  // Full: the long-form section bodies (opt-in). The emitted learn_more
  // actions only ever carry a single topic, so the chained path stays
  // one page at a time.
  return buildChassisEnvelope({
    tool: 'log10x_product_qa',
    view: 'summary',
    headline:
      results.length === 1
        ? `1 hit: "${results[0]!.topic}".`
        : `${results.length} hits. Top: "${results[0]!.topic}".`,
    status: 'success',
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {},
    scope: {
      window: 'point_in_time',
      window_basis: 'auto_default',
      candidates_count: kb.pages.length,
      candidates_evaluated: results.length,
    },
    payload: {
      found: true,
      results,
      resolved_mode: 'query' as const,
      corpus_source: kb.source,
    } satisfies ProductQaPayload,
    human_summary: `Top match: "${results[0]!.topic}" (${results[0]!.canonical_url}). Quote the matched_chunks[0].text when answering the user, and cite canonical_url.`,
    telemetry,
  });
}
