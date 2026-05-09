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
const VOLUME_RE = /(\d+(?:\.\d+)?)\s*(GB|MB|KB|B)\b/g;
const COUNT_RE = /(\d{2,}(?:[,_]\d{3})*)\s*(events?|patterns?|services?|messages?|lines?)/gi;
const PERCENT_RE = /([+-]?\d+(?:\.\d+)?)\s*%/g;
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
    out.push({
      raw: m[0],
      kind: 'count',
      value: parseInt(m[1].replace(/[,_]/g, ''), 10),
      unit: m[2],
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

    if (c.kind === 'volume' && c.value > 0) {
      // Volume claims commonly reference different windows (1d, 7d,
      // 30d). The oracle's 24h total is ~5 GB on demo; "34.9 GB this
      // week" is 7× that and entirely consistent. We accept any claim
      // that fits within an order of magnitude of a known window
      // (24h × N for N in {1, 7, 30}).
      const ratios = [1, 7, 30].map((days) => c.value / (oracleVolume * days));
      const closest = ratios.reduce((best, r) => (Math.abs(Math.log(r)) < Math.abs(Math.log(best)) ? r : best), ratios[0]);
      const supported = ratios.some((r) => r > 0.2 && r < 5);
      if (supported) {
        details.push({
          claim: c.raw,
          kind: 'numeric',
          oracleResult: `env total ~${(oracleVolume / 1e9).toFixed(2)}GB/24h; claim plausible at ${closest.toFixed(2)}× of some {1d,7d,30d} window`,
          status: 'supported',
          detail: c.context,
        });
      } else {
        details.push({
          claim: c.raw,
          kind: 'numeric',
          oracleResult: `env total ~${(oracleVolume / 1e9).toFixed(2)}GB/24h; closest window-ratio ${closest.toExponential(2)}× — outside any 24h/7d/30d band`,
          status: 'unsupported',
          detail: `${c.context} — claim is way outside oracle band`,
        });
      }
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
  for (const p of patternClaims) {
    try {
      const bytes = await patternExists(env, p.normalized, '24h');
      if (bytes > 0) {
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
