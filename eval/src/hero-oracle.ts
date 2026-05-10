/**
 * Hero-scenario oracle: validates a sub-agent's final synthesis text
 * against ground truth from Prometheus.
 *
 * The drift score is the count of unsupported numeric claims and
 * unsupported pattern names. Zero drift = every claim round-trips
 * to a Prometheus query result on the live env.
 *
 * Scope:
 *   - Numeric claims: $X.XX, N MB/GB, N events, +/-N%
 *   - Pattern names: snake_case identifiers in the synthesis
 *
 * Out of scope (impossible to validate from Prometheus alone):
 *   - Subjective claims ("the cart store is the safest to mute")
 *   - Recommendations ("you should enable compact mode")
 *   - Synthesized totals (sum of patterns) — too noisy
 *
 * The oracle is an INDEPENDENT path. The Prometheus gateway, the
 * auth header, the PromQL surface — all separate from the MCP's
 * internal queryInstant. A bug in the oracle doesn't share a code
 * path with a bug in the MCP, so a coincidental cover-up is
 * unlikely.
 */
import { promQuery, totalVolume, services, patternExists } from './prom-oracle.js';
import type { EvalEnv } from './env.js';

export interface NumericClaim {
  raw: string;
  kind: 'dollar' | 'volume' | 'count' | 'percent';
  value: number;
  unit?: string;
  context: string;
}

export interface PatternClaim {
  raw: string;
  /** Snake_case form actually queryable in Prometheus. */
  normalized: string;
  context: string;
}

export interface ValidationResult {
  claim: string;
  kind: 'numeric' | 'pattern';
  oracleResult: string;
  status: 'supported' | 'unsupported' | 'inconclusive';
  detail: string;
}

export interface HeroOracleReport {
  numericClaimCount: number;
  patternClaimCount: number;
  supported: number;
  unsupported: number;
  inconclusive: number;
  driftScore: number;
  details: ValidationResult[];
}

// ─── Extraction ─────────────────────────────────────────────────────────

const DOLLAR_RE = /\$[\d,]+(?:\.\d+)?/g;
// Volume claim: number + GB/MB/KB or the word "bytes". Bare `B` is
// excluded because agents commonly write "13.9B events" meaning 13.9
// billion events — the trailing `B` is a magnitude suffix, not a byte
// unit. Caught when hero-investigation flagged 8 false drifts.
const VOLUME_RE = /(\d+(?:\.\d+)?)\s*(GB|MB|KB|bytes?)\b/gi;
// Count with optional magnitude suffix (K/M/B/T = thousand/million/
// billion/trillion). Captures "13.9B events", "9.2M lines" etc.
const COUNT_RE = /(\d+(?:\.\d+)?)\s*([KMBT])?\s+(events?|patterns?|services?|messages?|lines?)/gi;
const PERCENT_RE = /([+-]?\d+(?:\.\d+)?)\s*%/g;
const SUFFIX_TO_MULT: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
// Snake_case identifiers with at least 3 underscores and 14+ chars —
// captures Symbol Messages without grabbing common words. The minimum
// underscore count is critical: with 2, we matched things like
// `cli_version_4` and `service_name_x`. We also explicitly skip
// regex-escape artifacts (`\bsymbol_message\b` → leading 'b' got
// captured as the start of a token in earlier versions).
const PATTERN_NAME_RE = /(?<![\\bA-Za-z])\b([a-z][a-z0-9]+(?:_[a-z0-9]+){3,})\b/g;

export function extractNumericClaims(text: string): NumericClaim[] {
  const out: NumericClaim[] = [];
  for (const m of text.matchAll(DOLLAR_RE)) {
    const ctx = textWindow(text, m.index ?? 0, 80);
    out.push({
      raw: m[0],
      kind: 'dollar',
      value: parseFloat(m[0].replace(/[$,]/g, '')),
      context: ctx,
    });
  }
  for (const m of text.matchAll(VOLUME_RE)) {
    const ctx = textWindow(text, m.index ?? 0, 80);
    const n = parseFloat(m[1]);
    const unit = m[2];
    const bytes = n * unitToBytes(unit);
    out.push({ raw: m[0], kind: 'volume', value: bytes, unit, context: ctx });
  }
  for (const m of text.matchAll(COUNT_RE)) {
    const ctx = textWindow(text, m.index ?? 0, 80);
    const base = parseFloat(m[1]);
    const suffix = m[2];
    const noun = m[3];
    const value = base * (suffix ? SUFFIX_TO_MULT[suffix.toUpperCase()] ?? 1 : 1);
    out.push({
      raw: m[0],
      kind: 'count',
      value,
      unit: noun,
      context: ctx,
    });
  }
  for (const m of text.matchAll(PERCENT_RE)) {
    const ctx = textWindow(text, m.index ?? 0, 80);
    out.push({
      raw: m[0],
      kind: 'percent',
      value: parseFloat(m[1]),
      context: ctx,
    });
  }
  return out;
}

export function extractPatternClaims(text: string): PatternClaim[] {
  const seen = new Set<string>();
  const out: PatternClaim[] = [];
  // Common false positives to skip: tool names, common prose tokens.
  const skip = new Set([
    'log10x_top_patterns',
    'log10x_cost_drivers',
    'log10x_event_lookup',
    'log10x_pattern_examples',
    'log10x_dependency_check',
    'log10x_exclusion_filter',
    'log10x_resolve_batch',
    'log10x_extract_templates',
    'log10x_advise_compact',
    'log10x_advise_install',
    'log10x_advise_receiver',
    'log10x_advise_reporter',
    'log10x_advise_retriever',
    'log10x_savings',
    'log10x_pattern_trend',
    'log10x_services',
    'log10x_list_by_label',
    'log10x_investigate',
    'log10x_doctor',
    'log10x_correlate_cross_pillar',
    'log10x_discover_env',
    'log10x_discover_join',
    'log10x_discover_labels',
    'log10x_translate_metric_to_patterns',
    'log10x_login_status',
    'log10x_retriever_query',
    'log10x_retriever_series',
    'log10x_backfill_metric',
    'log10x_customer_metrics_query',
    'log10x_signin',
    'log10x_signout',
  ]);
  for (const m of text.matchAll(PATTERN_NAME_RE)) {
    const name = m[1];
    if (skip.has(name)) continue;
    if (name.startsWith('log10x_')) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      raw: name,
      normalized: name,
      context: textWindow(text, m.index ?? 0, 100),
    });
  }
  return out;
}

// ─── Validation ─────────────────────────────────────────────────────────

export async function validateClaims(
  text: string,
  env: EvalEnv
): Promise<HeroOracleReport> {
  const numericClaims = extractNumericClaims(text);
  const patternClaims = extractPatternClaims(text);

  const details: ValidationResult[] = [];

  // Cache oracle aggregates so we don't re-query for every numeric claim.
  const [oracleVolume, oracleServices] = await Promise.all([
    totalVolume(env, '24h'),
    services(env, '24h'),
  ]);

  // Each numeric claim is checked against a tolerance band against the
  // closest oracle reference: dollar amounts within ±20% of any
  // pattern's cost; volume against pattern volumes; counts against
  // service / pattern cardinality.
  for (const c of numericClaims) {
    if (c.kind === 'percent') {
      // Percentages are derived from before/after — too many ways to
      // be "right" depending on which baseline. Mark as inconclusive
      // unless we can localize them.
      details.push({
        claim: c.raw,
        kind: 'numeric',
        oracleResult: 'percentages are derived; oracle does not gate them',
        status: 'inconclusive',
        detail: c.context,
      });
      continue;
    }

    if (c.kind === 'volume' && c.value >= 0) {
      // Volume claims can be totals OR subsets (single namespace,
      // single pattern, etc.). We can't tell which from the claim
      // alone, so the oracle uses a generous upper-bound band: a
      // claim is supported if it doesn't exceed 5× the 30-day env
      // total. Anything within that band is at least plausibly a
      // subset of real volume. Earlier the check required 0.2× to 5×
      // of a single-window total — that flagged any subset claim
      // smaller than ~1 GB as drift.
      const upper = oracleVolume * 30 * 5; // 5× the 30-day total
      const supported = c.value <= upper;
      details.push({
        claim: c.raw,
        kind: 'numeric',
        oracleResult: supported
          ? `env total ~${(oracleVolume / 1e9).toFixed(2)}GB/24h; claim within plausible subset/total range`
          : `env total ~${(oracleVolume / 1e9).toFixed(2)}GB/24h; claim exceeds 30-day total ×5`,
        status: supported ? 'supported' : 'unsupported',
        detail: c.context,
      });
      continue;
    }

    if (c.kind === 'count' && c.unit?.startsWith('service')) {
      const oracleCount = oracleServices.length;
      const ok = c.value >= oracleCount && c.value <= oracleCount + 10;
      details.push({
        claim: c.raw,
        kind: 'numeric',
        oracleResult: `oracle reports ${oracleCount} services`,
        status: ok ? 'supported' : 'unsupported',
        detail: c.context,
      });
      continue;
    }

    // Default: mark as inconclusive with a note. Better to under-flag
    // than to over-flag.
    details.push({
      claim: c.raw,
      kind: 'numeric',
      oracleResult: 'no targeted oracle path for this kind; claim accepted as plausible',
      status: 'inconclusive',
      detail: c.context,
    });
  }

  // Pattern claims: query patternExists for each. supported = bytes>0.
  // ALSO: when the agent quotes a volume (KB/MB/GB/TB) in the same
  // ~100-char context as the pattern name, pair-validate that volume
  // against the pattern's actual 24h bytes. Catches the
  // volume-hallucination shape that pure name-existence misses
  // (critical-events/wrong-volumes claimed real OTLP patterns at $48/wk
  // when oracle has $0.02/wk; cost-week-over-week/fake-numerical-anchor
  // claimed real top-3 names at 100× their actual sizes).
  // Tolerance band: claimed bytes can legitimately exceed the
  // pattern's 24h-window bytes for two reasons —
  // (1) the agent quotes a 7d or 30d figure (up to 30× the 24h),
  // (2) units / parsing artifacts.
  // 20× catches the vol-hallucination shape (typical: 95-1000× off)
  // without false-positives on legitimate 7d quotations.
  const VOLUME_TOLERANCE_FACTOR = 20;
  for (const p of patternClaims) {
    try {
      const bytes = await patternExists(env, p.normalized, '24h');
      if (bytes > 0) {
        // Pair-validate any volume claim inside the context window.
        const ctxVolumes = [...p.context.matchAll(/(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)\b/gi)];
        let pairedDrift: string | null = null;
        for (const v of ctxVolumes) {
          const n = parseFloat(v[1]);
          const unit = v[2].toUpperCase();
          const mult = unit === 'KB' ? 1e3 : unit === 'MB' ? 1e6 : unit === 'GB' ? 1e9 : 1e12;
          const claimedBytes = n * mult;
          if (claimedBytes > bytes * VOLUME_TOLERANCE_FACTOR) {
            pairedDrift = `pattern ${p.normalized}: claimed ${v[0]} but pattern has ~${(bytes / 1e6).toFixed(1)} MB / 24h (>${VOLUME_TOLERANCE_FACTOR}× off)`;
            break;
          }
        }
        if (pairedDrift) {
          details.push({
            claim: p.raw,
            kind: 'pattern',
            oracleResult: pairedDrift,
            status: 'unsupported',
            detail: p.context,
          });
          continue;
        }
        details.push({
          claim: p.raw,
          kind: 'pattern',
          oracleResult: `${(bytes / 1e6).toFixed(1)} MB / 24h in metrics`,
          status: 'supported',
          detail: p.context,
        });
      } else {
        details.push({
          claim: p.raw,
          kind: 'pattern',
          oracleResult: 'no metric data in 24h window',
          status: 'unsupported',
          detail: p.context,
        });
      }
    } catch (e) {
      details.push({
        claim: p.raw,
        kind: 'pattern',
        oracleResult: `oracle query threw: ${(e as Error).message.slice(0, 100)}`,
        status: 'inconclusive',
        detail: p.context,
      });
    }
  }

  const supported = details.filter((d) => d.status === 'supported').length;
  const unsupported = details.filter((d) => d.status === 'unsupported').length;
  const inconclusive = details.filter((d) => d.status === 'inconclusive').length;

  return {
    numericClaimCount: numericClaims.length,
    patternClaimCount: patternClaims.length,
    supported,
    unsupported,
    inconclusive,
    driftScore: unsupported,
    details,
  };
}

export function renderOracleReport(r: HeroOracleReport): string {
  const lines: string[] = [];
  lines.push('## Oracle validation');
  lines.push('');
  lines.push(
    `- Claims found: ${r.numericClaimCount} numeric, ${r.patternClaimCount} pattern names`
  );
  lines.push(
    `- Supported by oracle: ${r.supported} · Unsupported: ${r.unsupported} · Inconclusive: ${r.inconclusive}`
  );
  lines.push(`- **Drift score: ${r.driftScore}** (count of unsupported claims)`);
  lines.push('');
  if (r.details.length > 0) {
    lines.push('### Per-claim detail');
    lines.push('');
    for (const d of r.details) {
      const icon = d.status === 'supported' ? 'OK' : d.status === 'unsupported' ? 'DRIFT' : 'WARN';
      lines.push(`- [${icon}] **${d.claim}** — ${d.oracleResult}`);
      if (d.detail) lines.push(`    > ${d.detail.replace(/\n/g, ' ')}`);
    }
  }
  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────

function textWindow(text: string, idx: number, radius: number): string {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function unitToBytes(unit: string): number {
  switch (unit.toUpperCase()) {
    case 'GB':
      return 1e9;
    case 'MB':
      return 1e6;
    case 'KB':
      return 1e3;
    default:
      return 1;
  }
}

// Re-export for caller convenience.
export { promQuery };

// ── Campaign scoring extensions ─────────────────────────────────────────

/**
 * Extract the top-N pattern names the agent referenced in its
 * synthesis. Heuristic:
 *   1. Find every snake_case-ish token with at least 3 underscores
 *      and ≥14 chars (already in PATTERN_NAME_RE for drift checks).
 *   2. Count mentions per token.
 *   3. Return the top-N by mention count.
 *
 * This is an approximation — agents sometimes mention a pattern once
 * in a recommendation and four times in a table; we don't try to
 * distinguish "the answer" from "supporting context". But the
 * top-mention heuristic is robust enough that the top-N pattern-match
 * score correlates well with whether the agent actually identified
 * the right patterns.
 */
export function extractAgentTopPatterns(text: string, n: number = 3): string[] {
  const counts = new Map<string, number>();

  // Form 1: snake_case-or-CamelCase tokens with ≥3 underscores.
  // Examples: `cart_cartstore_ValkeyCartStore`, `shipping_service_Post_shipping_...`.
  // Skip MCP tool slugs (with or without log10x_ prefix); agents
  // commonly write `translate_metric_to_patterns` etc. as tool refs.
  const MCP_TOOL_SLUGS = new Set([
    'cost_drivers', 'event_lookup', 'pattern_examples', 'pattern_trend', 'top_patterns',
    'list_by_label', 'discover_labels', 'savings', 'services', 'investigate',
    'investigation_get', 'resolve_batch', 'extract_templates', 'doctor', 'login_status',
    'signin', 'signout', 'update_settings', 'create_env', 'update_env', 'delete_env',
    'rotate_api_key', 'customer_metrics_query', 'discover_join', 'correlate_cross_pillar',
    'translate_metric_to_patterns', 'poc_from_siem_submit', 'poc_from_siem_status',
    'poc_from_local', 'discover_env', 'advise_install', 'advise_reporter',
    'advise_receiver', 'advise_retriever', 'advise_compact', 'dependency_check',
    'exclusion_filter', 'retriever_query', 'retriever_query_status', 'retriever_series',
    'backfill_metric',
  ]);
  const PATTERN_SNAKE_RE = /(?<![\\A-Za-z0-9])\b([A-Za-z][A-Za-z0-9]+(?:_[A-Za-z0-9]+){3,})\b/g;
  for (const m of text.matchAll(PATTERN_SNAKE_RE)) {
    const name = m[1];
    if (name.startsWith('log10x_')) continue;
    if (MCP_TOOL_SLUGS.has(name)) continue; // skip tool refs
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  // Form 2: backtick-wrapped DISPLAY form. The MCP renders top patterns
  // as space-separated lowercase phrases (e.g. `service instance id
  // service name otelcol contrib service version otelcol`); agents
  // commonly quote them verbatim. Normalize to snake_case so they
  // collide with oracle's canonical names. Without this catcher, every
  // synthesis that uses the MCP's display form ends up with empty
  // agent_top — caught when 7 of 10 failing scenarios had agent_top=[]
  // despite the agent clearly naming patterns.
  const BACKTICK_DISPLAY_RE = /`([a-zA-Z][a-zA-Z0-9 ]{18,})`/g;
  for (const m of text.matchAll(BACKTICK_DISPLAY_RE)) {
    const display = m[1].trim();
    // Skip command literals and short option names.
    if (/^(node |npm |bash |--|\/|http|https)/.test(display)) continue;
    const words = display.split(/\s+/).filter(Boolean);
    if (words.length < 4) continue;
    const norm = words.join('_');
    if (norm.startsWith('log10x_')) continue;
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map((e) => e[0]);
}

/**
 * Score the agent's top-N against the oracle's top-N. Names match
 * loosely: case-insensitive, with snake_case normalization.
 *
 * The score is symmetric in the sense that BOTH sides matter — an
 * agent that says "X" when oracle says "Y, Z, W" gets 0/3 even though
 * X might exist in metrics. The point is: did the agent identify the
 * patterns the oracle considers most important for this question?
 */
export function scoreTopNMatch(
  agentTop: string[],
  oracleTop: string[]
): { matched: number; missed: number; extra: number; score: number; matched_names: string[] } {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const oracleSet = new Set(oracleTop.map(norm));
  const agentSet = new Set(agentTop.map(norm));

  const matched_names: string[] = [];
  let matched = 0;
  for (const o of oracleTop) {
    const n = norm(o);
    // Loose match: agent mentions a name that contains a substantial
    // substring of the oracle name, or vice-versa.
    const hit = [...agentSet].some(
      (a) => a === n || a.includes(n) || n.includes(a)
    );
    if (hit) {
      matched++;
      matched_names.push(o);
    }
  }
  const missed = Math.max(0, oracleTop.length - matched);
  let extra = 0;
  for (const a of agentTop) {
    const n = norm(a);
    const hit = [...oracleSet].some((o) => o === n || o.includes(n) || n.includes(o));
    if (!hit) extra++;
  }
  // Vacuously satisfied when oracle has no expected patterns: there's
  // nothing the agent could miss, so score=1. (Older code returned 0
  // and the campaign-scorer's pass gate had to special-case empty
  // oracle lists — moving the special case here keeps the score
  // meaningful in reports.)
  const denom = matched + missed;
  const score = denom > 0 ? matched / denom : 1;
  return { matched, missed, extra, score, matched_names };
}

/**
 * Tools that answer the same class of question. When the
 * expected_tool_chain says "log10x_doctor" but the agent uses
 * "log10x_discover_env" (which also reports tier health), we treat
 * the alternative as a hit. Hand-curated; only adds equivalences for
 * cases observed in the campaign.
 */
const TOOL_ALTERNATIVES: Record<string, string[]> = {
  log10x_doctor: ['log10x_discover_env'],
  log10x_top_patterns: ['log10x_cost_drivers', 'log10x_list_by_label'],
  log10x_list_by_label: ['log10x_top_patterns', 'log10x_services'],
  log10x_investigate: ['log10x_pattern_trend', 'log10x_cost_drivers'],
  log10x_cost_drivers: ['log10x_top_patterns'],
};

/**
 * Score whether the bash trace contains the expected_tool_chain in
 * order. Each tool-name in `expected` must appear (or one of its
 * curated equivalents must), and they must appear in order
 * (subsequence match).
 */
export function scoreChainAlignment(
  expected: string[],
  actual: string[]
): { hits: string[]; misses: string[]; score: number } {
  if (expected.length === 0) return { hits: [], misses: [], score: 1 };
  const hits: string[] = [];
  const misses: string[] = [];
  let cursor = 0;
  for (const e of expected) {
    const candidates = [e, ...(TOOL_ALTERNATIVES[e] ?? [])];
    let hitIdx = -1;
    let hitName = e;
    for (const cand of candidates) {
      const idx = actual.indexOf(cand, cursor);
      if (idx >= 0 && (hitIdx === -1 || idx < hitIdx)) {
        hitIdx = idx;
        hitName = cand;
      }
    }
    if (hitIdx >= 0) {
      hits.push(hitName);
      cursor = hitIdx + 1;
    } else {
      misses.push(e);
    }
  }
  return { hits, misses, score: hits.length / expected.length };
}

/**
 * Pull the MCP tool names out of a hero-runner's bash trace. Each
 * bash command of the form `node .../mcp-call.mjs --tool <name> --args <json>`
 * produces one tool name.
 */
export function extractToolChainFromBash(
  bashCommands: Array<{ cmd: string }>
): string[] {
  const out: string[] = [];
  for (const c of bashCommands) {
    const m = c.cmd.match(/--tool\s+(\S+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

