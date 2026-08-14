/**
 * Document-frequency discriminator-first pattern naming (Layer 2 of the
 * pattern-name display work) — RENDER-ONLY.
 *
 * THE PROBLEM: a 10x pattern name is the `symbolMessage` — a selection of
 * tokens the engine picked, joined by '_'. On real environments many names
 * share a long common boilerplate PREFIX (e.g. the OTel-collector resource
 * envelope) and differ only at the END, so a front-crop renders rows 1/2/6
 * identically. A hardcoded OTel denylist (`PREFIX_SKIP`) does not fix it:
 * that is vendor-specific and silently wrong for Java/MDC, k8s, Datadog,
 * or arbitrary apps.
 *
 * THE GENERAL FIX: boilerplate is whatever is COMMON across the env's
 * patterns, learned from the data itself — no vendor strip-lists. For each
 * token compute its document frequency df(tok) = the number of DISTINCT
 * patterns whose token-set contains it. Tokens with high df are boilerplate
 * (they appear everywhere, so they don't tell patterns apart); tokens with
 * low df are discriminators. We surface the discriminators, re-emitted in
 * the name's ORIGINAL order so tail tokens like `opensearch`/`batch` — the
 * very ones a front-crop drops — lead the visible name.
 *
 * IDENTITY IS UNTOUCHED. Nothing here reads or writes `pattern_hash`,
 * `templateChars`, `symbol_message`, or any identity field. The output is
 * purely additive render fields: `display_name` (a cropped string) and
 * `display_tokens` (the original tokens, each flagged distinctive or not).
 *
 * Out of scope (durable follow-up in the ENGINE repo): an engine-stamped
 * projection that computes this label ONCE after templateChars/templateHash
 * are frozen, with compile-phase frequency tracking. That is additive and
 * identity-safe but net-new engine work. This module builds the algorithm
 * at the MCP, over the live metric label set, now.
 */

import { midEllipsis, codepointLength } from './text-crop.js';
import { fetchActiveLabelValues } from './api.js';
import { LABELS } from './promql.js';
import type { EnvConfig } from './environments.js';

/** Default column budget for a display_name (MCP list / console surface). */
export const DEFAULT_NAME_WIDTH = 44;
/**
 * Below this many distinct patterns the df signal is too thin to trust —
 * one boilerplate run can look as rare as a real discriminator — so we
 * degrade to Layer 1 (plain mid-ellipsis) rather than collapse on noise.
 */
export const MIN_CORPUS = 20;
/** Discriminator tokens surfaced before packing to width. */
export const MAX_DISCRIMINATORS = 5;

/**
 * Leading tokens always kept, regardless of document frequency, so a name
 * says WHAT the statement is and not merely which variant it is. Without
 * this, a set of patterns sharing a long lead-in loses every shared word to
 * the boilerplate cutoff and renders as its statistical tail.
 */
export const ANCHOR_TOKENS = 3;

/**
 * How far into a name to look for the start of the human sentence. Sized to
 * the longest logger preamble observed in a real capture: Kafka's
 * `INFO_UnifiedLog_partition_cluster_metadata_dir_tmp_kafka_logs_` is 12
 * tokens before the message begins.
 */
const SENTENCE_SCAN_LIMIT = 14;

/**
 * Tokens that mark the end of a source-location / logger preamble. Their
 * presence is what licenses skipping ahead to the message; without one, the
 * name is assumed to open with its own message already.
 *
 * WHOLE-TOKEN match, deliberately. Matching any token ENDING in an
 * extension also matches `results`, `events`, `requests`,
 * `errors`, `limits` and `counts` as TypeScript files, plus `cargo`, `ago`,
 * `logo`, `copy` and `entropy`. Those are among the commonest words in a log
 * message, so the loose form would have skipped past real message text on any
 * data that happened to contain them. It did not bite on the capture this was
 * developed against, which is exactly why it is worth stating.
 *
 * `symbolMessage` tokens are already split on separators, so a path like
 * `internal/base_exporter.go` arrives as `... base exporter go` and the
 * extension is a token of its own. That is what makes a whole-token match
 * both possible and sufficient.
 */
const PREAMBLE_MARKER = /^(?:go|py|java|rb|ts|js|cc|cpp|rs|php|v\d+|\d+)$/i;

/** Carry no information once inside a name; skipped when COLLECTING the anchor. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'this', 'that',
  'these', 'those', 'it', 'its', 'to', 'of', 'in', 'on', 'at', 'by', 'for',
  'and', 'or', 'as', 'with', 'from',
]);

/**
 * Anchor size scales with the column budget. A fixed constant cannot serve
 * three different widths: the report has 56 codepoints and can afford three
 * subject tokens, while the 40-44 surfaces cannot, and spending their budget
 * on an anchor pushes discriminators past the ellipsis and mints collisions
 * that did not exist. Across 164 real patterns, at width 40 an anchor of
 * 3 produces a four-row collision and an anchor of 2 does not.
 */
function anchorBudget(width: number): number {
  return width >= 56 ? ANCHOR_TOKENS : 2;
}

/**
 * Severity words are skipped in the anchor whatever the row's severity label
 * says. The label is the ENGINE's classification (`TRACE`) while the token
 * inside the message is whatever the application printed (`INFO`), so keying
 * the skip off the label alone lets the mismatch through and the anchor leads
 * with a severity the table already shows, sometimes contradicting it.
 */
const SEVERITY_WORDS = new Set([
  'fatal', 'critical', 'crit', 'error', 'err', 'warn', 'warning',
  'info', 'information', 'debug', 'trace', 'notice',
]);

/** One render token: the verbatim text + whether df marked it a discriminator. */
export interface DisplayToken {
  text: string;
  distinctive: boolean;
}

/** Render-only naming result. `symbol_message` / `pattern_hash` stay separate + unchanged. */
export interface DisplayName {
  display_name: string;
  display_tokens: DisplayToken[];
}

/**
 * Document-frequency context for one environment's pattern set. Built once
 * and shared across BOTH top_patterns and pattern_detail so the same
 * pattern renders the SAME display_name on every surface.
 */
export interface DfContext {
  /** token -> number of DISTINCT patterns whose token-set contains it. */
  dfMap: Map<string, number>;
  /** N — number of distinct patterns the df-map was built over. */
  patternCount: number;
}

/**
 * Split a symbol_message into tokens on '_'. Empty segments (leading,
 * trailing, or doubled underscores) are dropped. camelCase inside a token
 * is preserved verbatim — we never Title-case or otherwise mangle
 * `ValkeyCartStore` / `GET`.
 */
export function tokenizePattern(symbolMessage: string): string[] {
  if (!symbolMessage) return [];
  return symbolMessage.split('_').filter((t) => t.length > 0);
}

/**
 * Build a df-map from an iterable of symbol_messages. df counts DISTINCT
 * patterns (a token repeated within one name counts once for that name).
 */
export function buildDfContext(symbolMessages: Iterable<string>): DfContext {
  const dfMap = new Map<string, number>();
  let patternCount = 0;
  for (const sm of symbolMessages) {
    const tokens = tokenizePattern(sm);
    if (tokens.length === 0) continue;
    patternCount += 1;
    // De-dupe within the pattern: df is per-DISTINCT-pattern, not per-token.
    const seen = new Set<string>();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      dfMap.set(t, (dfMap.get(t) ?? 0) + 1);
    }
  }
  return { dfMap, patternCount };
}

// ── Per-env df-context cache ────────────────────────────────────────────────
// ONE df-map per env, fetched from the live metric label set and reused by
// every render path for a short TTL. The TTL keeps the same df-map (hence the
// same labels) stable across the top_patterns -> pattern_detail drill-in a
// user does in one sitting, while still refreshing as the env gains patterns.

interface CacheEntry {
  ctx: DfContext;
  expiresAt: number;
}
const DF_CACHE = new Map<string, CacheEntry>();
const DF_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch (or reuse) the env's df-context. The pattern set is the distinct
 * values of the `message_pattern` label active in the window — i.e. every
 * pattern the env is currently emitting. Cached per `cacheKey` for a short
 * TTL so both surfaces share one df-map.
 *
 * `nowMs` is injectable for tests; production passes Date.now().
 * Returns a zero-corpus context (patternCount 0) on any backend failure, so
 * callers degrade to Layer 1 rather than throw.
 */
export async function getEnvDfContext(
  env: EnvConfig,
  cacheKey: string,
  opts: { windowSeconds?: number; nowMs?: number } = {},
): Promise<DfContext> {
  const now = opts.nowMs ?? Date.now();
  const windowSeconds = opts.windowSeconds ?? 86400; // 24h: the env's live pattern set
  const hit = DF_CACHE.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.ctx;
  let symbolMessages: string[] = [];
  try {
    symbolMessages = await fetchActiveLabelValues(env, LABELS.pattern, windowSeconds);
  } catch {
    symbolMessages = [];
  }
  const ctx = buildDfContext(symbolMessages);
  DF_CACHE.set(cacheKey, { ctx, expiresAt: now + DF_TTL_MS });
  return ctx;
}

/** Test-only: clear the per-env df cache. */
export function __clearDfCache(): void {
  DF_CACHE.clear();
}

// ── The discriminator-first naming algorithm ────────────────────────────────

export interface BuildDisplayNameOpts {
  /** Shared env df-context. Absent/thin corpus => Layer 1 (mid-ellipsis). */
  df?: DfContext | null;
  /** Top service name — its tokens are treated as head/boilerplate. */
  service?: string | null;
  /** Severity (ERROR/INFO/…) — its tokens are treated as head/boilerplate. */
  severity?: string | null;
  /** Column budget (codepoints). Default DEFAULT_NAME_WIDTH (44). */
  width?: number;
  /** Discriminators surfaced before packing. Default MAX_DISCRIMINATORS (5). */
  maxDiscriminators?: number;
}

/** Lowercased token set drawn from service + severity, treated as head boilerplate. */
function headTokenSet(service?: string | null, severity?: string | null): Set<string> {
  const out = new Set<string>();
  for (const src of [service, severity]) {
    if (!src) continue;
    // Split on hyphens too: services are routinely hyphenated
    // (`product-reviews`, `opentelemetry-collector`), and without this the
    // head-skip never matches their own tokens, so the anchor spends its
    // budget re-printing the service column.
    for (const t of src.split(/[-_\s]+/)) {
      const k = t.trim().toLowerCase();
      if (k) out.add(k);
    }
  }
  return out;
}

/**
 * Compute the discriminator-first display_name + per-token classification
 * for one symbol_message. RENDER-ONLY.
 *
 * Guards (all mandatory):
 *   (a) never blank a name — zero distinctive tokens => mid-ellipsis of the
 *       raw '_'->space name;
 *   (b) length-gate — a name already within the column budget is returned
 *       verbatim (no collapse), which protects short clean names by
 *       construction (`Charge_request_received` is never harmed);
 *   (c) min-corpus floor — no df, or fewer than MIN_CORPUS patterns,
 *       degrades to Layer 1.
 * Guard (d) (render-time uniqueness across the visible page) is a separate
 * pass — see `dedupeVisibleNames`.
 */
export function buildDisplayName(
  symbolMessage: string,
  opts: BuildDisplayNameOpts = {},
): DisplayName {
  const width = opts.width ?? DEFAULT_NAME_WIDTH;
  const maxDisc = opts.maxDiscriminators ?? MAX_DISCRIMINATORS;
  const tokens = tokenizePattern(symbolMessage);
  if (tokens.length === 0) {
    return { display_name: '', display_tokens: [] };
  }

  const spaced = tokens.join(' ');
  const N = opts.df?.patternCount ?? 0;
  const haveDf = !!opts.df && N >= MIN_CORPUS;
  const threshold = Math.ceil(N / 2); // ABSOLUTE boilerplate cutoff
  const heads = headTokenSet(opts.service, opts.severity);

  // Per-token distinctiveness — needs df. Without df we cannot tell, so
  // every token is non-distinctive (Layer 1 territory).
  const isDistinctive = (tok: string): boolean => {
    if (!haveDf) return false;
    const lower = tok.toLowerCase();
    if (codepointLength(tok) <= 2) return false;
    if (heads.has(lower)) return false;
    // Severity words are never discriminators. The table renders severity in
    // its own column, and the token inside the message is what the
    // application printed, which routinely disagrees with the engine's
    // classification — so letting it through both wastes the budget and can
    // contradict the severity shown beside it.
    if (SEVERITY_WORDS.has(lower)) return false;
    const df = opts.df!.dfMap.get(tok) ?? 1;
    return df < threshold;
  };

  const display_tokens: DisplayToken[] = tokens.map((t) => ({
    text: t,
    distinctive: isDistinctive(t),
  }));

  // Guard (b): already fits the budget -> return verbatim, never collapse.
  if (codepointLength(spaced) <= width) {
    return { display_name: spaced, display_tokens };
  }
  // Guard (c): no usable df corpus -> Layer 1 mid-ellipsis of the full name.
  if (!haveDf) {
    return { display_name: midEllipsis(spaced, width), display_tokens };
  }

  // Discriminator-first selection. survivors keep original order + repeats.
  const survivors = tokens.filter(isDistinctive);
  // Guard (a): nothing distinctive survived -> Layer 1, never blank.
  if (survivors.length === 0) {
    return { display_name: midEllipsis(spaced, width), display_tokens };
  }

  // ANCHOR. Discriminators alone answer "which one of these" but not "what
  // is this". When many patterns share a long lead-in -- an exporter error
  // storm, a retry loop -- every shared word is boilerplate by df and gets
  // dropped, leaving only the statistical tail: `Try enabling sending
  // survive temporary`. Unique, and unreadable.
  //
  // So reserve the front of the budget for the first few tokens in their
  // original order, whatever their df, and spend the remainder on
  // discriminators. The anchor says what the statement is; the
  // discriminators say which variant. Head tokens (service/severity) are
  // skipped because the report already renders those in their own columns.
  // Anchor at the MESSAGE, not at position. Taking the first few tokens
  // anchors on whatever the logging framework prints first, which for most
  // runtimes is the source location:
  //
  //   error_internal_base_exporter_go_Exporting_failed_Rejecting_data_...
  //          ^--------------------^ Go file path      ^-- the actual message
  //
  // and produced "internal base exporter", which names the file the line was
  // emitted from rather than what happened. Instead, find where the human
  // sentence starts: the first capitalised word of >=3 chars followed by a
  // lowercase word. That lands on "Exporting failed Rejecting data" for the
  // example above, and on "Received chat completion request" for a Python
  // logger that leads with `INFO in app`. Falls back to positional when a
  // symbolMessage carries no sentence-shaped run, which is the common case
  // for already-readable names like `cart cartstore ValkeyCartStore`.
  const anchorTokens: string[] = [];
  const budget = anchorBudget(width);
  const eligible = (t: string): boolean => {
    const lower = t.toLowerCase();
    return codepointLength(t) > 2 && !heads.has(lower) && !SEVERITY_WORDS.has(lower);
  };
  // Only move past the lead-in when it looks like a source location or logger
  // preamble. When the line already OPENS with its message in lowercase
  // (`failed_to_upload_metrics_...`), scanning ahead lands on the first
  // capitalised thing after it -- a gRPC status like `Unavailable` -- and
  // drops the event word. Require evidence of a preamble before skipping.
  let start = 0;
  const preambleEnd = tokens.findIndex((t) => PREAMBLE_MARKER.test(t));
  const scanFrom = preambleEnd >= 0 ? preambleEnd : 0;
  for (let i = scanFrom; i < Math.min(tokens.length, SENTENCE_SCAN_LIMIT); i++) {
    const t = tokens[i];
    if (!eligible(t)) continue;
    // `x !== x.toUpperCase()` is identity for digits and punctuation, so a
    // hex fragment (`7f9c`) or a status code (`404`) passed as a sentence
    // start. Require an actual uppercase LETTER.
    const first = t.charAt(0);
    if (!/\p{Lu}/u.test(first) || t.slice(1) !== t.slice(1).toLowerCase()) continue;
    const next = tokens[i + 1] ?? '';
    // A sentence continues into a lowercase word. Requiring one keeps the
    // anchor off capitalised VALUES (`True`, an enum, a hostname) that happen
    // to sit mid-name and are followed by more capitalised tokens.
    if (next && next.charAt(0) === next.charAt(0).toLowerCase() && /[a-z]/.test(next.charAt(0))) {
      start = i;
      break;
    }
  }
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (anchorTokens.length >= budget) break;
    if (!eligible(t)) continue;
    // Stopwords are load-bearing for DETECTING a sentence (a capitalised word
    // followed by `the` is how we know it is prose) but carry nothing once
    // collected. Spending anchor budget on them just swaps one filler for
    // another.
    if (STOPWORDS.has(t.toLowerCase())) continue;
    if (anchorTokens.includes(t)) continue;
    anchorTokens.push(t);
  }

  // First-occurrence index for a stable tie-break (rarest-first, then
  // original order) so the selection is deterministic.
  const firstIndex = new Map<string, number>();
  tokens.forEach((t, i) => {
    if (!firstIndex.has(t)) firstIndex.set(t, i);
  });
  const distinctSurvivors = [...new Set(survivors)].sort((a, b) => {
    const da = opts.df!.dfMap.get(a) ?? 1;
    const db = opts.df!.dfMap.get(b) ?? 1;
    if (da !== db) return da - db; // rarest (most discriminating) first
    return firstIndex.get(a)! - firstIndex.get(b)!;
  });
  const selected = new Set(distinctSurvivors.slice(0, maxDisc));

  // Ranking SELECTS which tokens; ORIGINAL order RENDERS them (so a tail
  // discriminator surfaces in place). De-dupe repeats, keeping first position.
  // The anchor is unioned in so the name keeps its subject.
  for (const t of anchorTokens) selected.add(t);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const t of tokens) {
    if (!selected.has(t) || seen.has(t)) continue;
    seen.add(t);
    ordered.push(t);
  }

  // Overflow: shed before chopping. Anchoring unions extra tokens in, and
  // mid-ellipsis then cuts a WORD in half -- `Sender failed` renders as
  // `Se…ailed`, which is less readable than the un-anchored name it replaced.
  // Drop the least-discriminating selected tokens (highest df) first, keeping
  // the anchor, until the name fits. Only fall back to mid-ellipsis when even
  // the anchor alone is too long.
  let kept = [...ordered];
  const anchorSet = new Set(anchorTokens);
  while (codepointLength(kept.join(' ')) > width) {
    let victim = -1;
    let victimDf = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (anchorSet.has(kept[i])) continue;
      const d = opts.df!.dfMap.get(kept[i]) ?? 1;
      if (d > victimDf) {
        victimDf = d;
        victim = i;
      }
    }
    if (victim < 0) break;
    kept.splice(victim, 1);
  }
  let name = kept.join(' ');
  if (codepointLength(name) > width) name = midEllipsis(name, width);
  return { display_name: name, display_tokens };
}

// ── Guard (d): render-time uniqueness across the visible page ────────────────

export interface NameableRow {
  display_name: string;
  display_tokens: DisplayToken[];
  pattern_hash: string;
}

/** First 4 chars of a pattern_hash — the ONLY place a hash touches a label. */
function hash4(pattern_hash: string): string {
  return (pattern_hash || '').slice(0, 4);
}

/**
 * After per-row display_names are computed, guarantee they are distinct
 * across the visible page. For each collision group, append each row's
 * next-rarest not-yet-shown token (by df asc) until the names diverge; last
 * resort append ' #'+first4(pattern_hash) — a 4-char suffix, never a
 * headline. Mutates `display_name` in place. RENDER-ONLY.
 *
 * `df` is the shared context used to rank the tie-break tokens; when absent
 * the tokens are appended in their original order.
 */
export function dedupeVisibleNames(rows: NameableRow[], df?: DfContext | null): void {
  const norm = (s: string) => s.toLowerCase();
  // Group by current display_name.
  const groups = new Map<string, NameableRow[]>();
  for (const r of rows) {
    const k = norm(r.display_name);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // Candidate tie-break tokens per row: tokens NOT already visible in the
    // name, ranked rarest-first (df asc) so the most discriminating differ
    // first. Distinctive tokens lead, then the rest as deeper fallback.
    const candidatesByRow = new Map<NameableRow, string[]>();
    let maxRounds = 0;
    for (const r of group) {
      const shown = new Set(norm(r.display_name).split(/\s+/));
      const rank = (t: DisplayToken) => (df?.dfMap.get(t.text) ?? 1);
      const extra = r.display_tokens
        .filter((t) => !shown.has(t.text.toLowerCase()))
        .sort((a, b) => {
          if (a.distinctive !== b.distinctive) return a.distinctive ? -1 : 1;
          return rank(a) - rank(b);
        })
        .map((t) => t.text);
      // De-dupe while preserving order.
      const deduped = [...new Set(extra)];
      candidatesByRow.set(r, deduped);
      maxRounds = Math.max(maxRounds, deduped.length);
    }

    // Rows currently sharing a name with another group member (snapshot).
    const collidingNow = (): NameableRow[] => {
      const counts = new Map<string, number>();
      for (const r of group) counts.set(norm(r.display_name), (counts.get(norm(r.display_name)) ?? 0) + 1);
      return group.filter((r) => (counts.get(norm(r.display_name)) ?? 0) > 1);
    };

    // Append each colliding row's next candidate token SYMMETRICALLY per
    // round, so the disambiguated names stay parallel ("…kafka" vs "…redis",
    // not "…kafka" vs bare). Stops as soon as the whole group is distinct.
    for (let round = 0; round < maxRounds; round++) {
      const dups = collidingNow();
      if (dups.length === 0) break;
      for (const r of dups) {
        const cand = candidatesByRow.get(r)!;
        if (round < cand.length) r.display_name = `${r.display_name} ${cand[round]}`;
      }
    }
    // Last resort: a 4-char hash suffix guarantees divergence for any rows
    // still colliding after candidate tokens are exhausted.
    for (const r of collidingNow()) {
      r.display_name = `${r.display_name} #${hash4(r.pattern_hash)}`;
    }
  }
}
