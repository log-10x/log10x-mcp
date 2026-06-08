/**
 * Single source of truth for $/GB rate resolution across cost-emitting tools.
 *
 * Background
 * ----------
 * The five dollar-emitting tools (services, top_patterns, event_lookup,
 * explain_mode, estimate_savings) could label the *same* env / window / pattern
 * with *different* `rate_source` tags:
 *   - services / top_patterns: customer_supplied ($1.50/GB from somewhere)
 *   - event_lookup / explain_mode / estimate_savings: list_price
 *     (destination-specific $0.50/GB CloudWatch list)
 * The absolute dollars agreed; the provenance did not, which undermines
 * trust in the numbers.
 *
 * Fix: every cost-emitting tool consults `resolveRate(...)` below and uses
 * the SAME priority chain (highest wins):
 *
 *   1. Caller's explicit `effective_ingest_per_gb` arg ........ customer_supplied
 *   2. Env's envs.json `analyzerCost` field ................... customer_supplied
 *   3. LOG10X_ANALYZER_COST env var .......................... customer_supplied
 *   4. Destination list price (COST_MODEL_BY_DESTINATION) ..... list_price
 *   5. None ................................................... unset
 *
 * On 'unset', callers MUST collapse dollar fields to null per the existing
 * "no $1/GB lie" convention — no fictional fallback rate.
 */

import type { EnvConfig } from './environments.js';
import { COST_MODEL_BY_DESTINATION } from './cost.js';
import {
  SIEM_DISPLAY_NAMES,
  type SiemId,
} from './siem/pricing.js';

/** Provenance tag returned for every resolution. */
export type RateSource = 'customer_supplied' | 'list_price' | 'unset';

/**
 * Result of `resolveRate(...)`. `rate_per_gb` is null iff source==='unset' —
 * the only signal callers need to switch dollar fields to null.
 *
 * `disclosure` is a plain-English caveat suitable for rendering verbatim:
 *  - customer_supplied → null (no caveat needed; caller owns the rate)
 *  - list_price        → "(at <SIEM> list price $X.XX/GB — your actual bill
 *                         may differ depending on discounts, commits, or
 *                         contract tier. To use your real rate, set
 *                         analyzerCost in your env config or pass
 *                         effective_ingest_per_gb.)"
 *  - unset             → "(no $/GB rate configured — pass
 *                         effective_ingest_per_gb, set envs.json
 *                         analyzerCost, or export LOG10X_ANALYZER_COST)"
 */
export interface ResolvedRate {
  rate_per_gb: number | null;
  source: RateSource;
  disclosure: string | null;
  /** Which rung of the priority chain produced the value. Aids debugging. */
  origin: 'arg' | 'envs_json' | 'env_var' | 'destination_list' | 'none';
}

/**
 * Read the customer-supplied analyzer rate from the resolved env (rung 2
 * of the priority chain). EnvConfig declares `analyzerCost?: number`
 * (sourced from `envs.json` by tryReadEnvsJson); we keep a string-tolerant
 * fall-through so hand-edited entries with `"analyzerCost": "1.50"` parse
 * cleanly instead of silently falling through to rung 3.
 */
function readAnalyzerCostFromEnvConfig(env: EnvConfig | undefined): number | undefined {
  if (!env) return undefined;
  const candidate = (env as unknown as { analyzerCost?: unknown }).analyzerCost;
  if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
    return candidate;
  }
  if (typeof candidate === 'string') {
    const parsed = parseFloat(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function readAnalyzerCostFromEnvVar(): number | undefined {
  const raw = process.env.LOG10X_ANALYZER_COST;
  if (raw == null || raw === '') return undefined;
  const parsed = parseFloat(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return undefined;
}

/**
 * Look up destination list-price ingest rate. Returns `null` when the
 * destination is unknown or carries no list (e.g. ClickHouse self-hosted
 * which has $0 ingest by design).
 *
 * Note: $0 is treated as a valid list rate when the destination model
 * declares it explicitly (Datadog storage, ClickHouse ingest). Callers
 * relying on this for the dollar overlay get 0 + 'list_price' rather than
 * 'unset' — consistent with how projectAction handles the same case.
 */
function readDestinationListRate(destination: string | undefined | null): {
  rate: number | null;
  siem: SiemId | null;
} {
  if (!destination) return { rate: null, siem: null };
  const key = destination.toLowerCase() as SiemId;
  const model = COST_MODEL_BY_DESTINATION[key];
  if (!model) return { rate: null, siem: null };
  if (!Number.isFinite(model.ingest_per_gb)) return { rate: null, siem: key };
  // ClickHouse self-hosted: ingest_per_gb === 0 is a true zero, not "unknown".
  // We still treat 0 as a valid list rate so callers can render "$0/GB ingest"
  // honestly rather than collapsing to unset.
  return { rate: model.ingest_per_gb, siem: key };
}

/**
 * Arguments the caller passes through from its own tool args. The two
 * accepted alias keys are kept for back-compat with tools that historically
 * exposed only `analyzerCost` (event_lookup, services, savings).
 */
export interface RateArgs {
  effective_ingest_per_gb?: number | null;
  /** Deprecated alias of effective_ingest_per_gb; same provenance semantics. */
  analyzerCost?: number | null;
}

/**
 * Resolve the effective $/GB rate + provenance for a tool's dollar surface.
 *
 * Every cost-emitting tool MUST call this rather than computing its own rate.
 * Callers pass:
 *  - their explicit args (effective_ingest_per_gb / analyzerCost)
 *  - the resolved env (for envs.json analyzerCost)
 *  - the destination SIEM id (for destination list fallback)
 *
 * The function consults the env-var LOG10X_ANALYZER_COST itself — callers
 * do not need to read it.
 *
 * Returns a structured result; callers gate dollar fields on
 * `result.source === 'unset'` and render `result.disclosure` verbatim.
 */
export function resolveRate(
  args: RateArgs | undefined,
  env: EnvConfig | undefined,
  destination: string | undefined | null,
): ResolvedRate {
  // Rung 1: explicit caller arg. Either alias is valid; effective_ingest_per_gb
  // wins when both are passed (the deprecated alias is for back-compat only).
  const argRate =
    args?.effective_ingest_per_gb != null
      ? args.effective_ingest_per_gb
      : args?.analyzerCost != null
        ? args.analyzerCost
        : null;
  if (argRate != null && Number.isFinite(argRate) && argRate > 0) {
    return {
      rate_per_gb: argRate,
      source: 'customer_supplied',
      disclosure: null,
      origin: 'arg',
    };
  }

  // Rung 2: envs.json analyzerCost on the resolved env.
  const envsJsonRate = readAnalyzerCostFromEnvConfig(env);
  if (envsJsonRate != null) {
    return {
      rate_per_gb: envsJsonRate,
      source: 'customer_supplied',
      disclosure: null,
      origin: 'envs_json',
    };
  }

  // Rung 3: LOG10X_ANALYZER_COST env var.
  const envVarRate = readAnalyzerCostFromEnvVar();
  if (envVarRate != null) {
    return {
      rate_per_gb: envVarRate,
      source: 'customer_supplied',
      disclosure: null,
      origin: 'env_var',
    };
  }

  // Rung 4: destination list price. `destination` may come from a tool arg
  // or from env.analyzer (envs.json) — caller resolves this before calling
  // us. We do NOT silently fall back to env.analyzer here; that's policy
  // each tool owns separately.
  const { rate: listRate, siem } = readDestinationListRate(destination);
  if (listRate != null) {
    const siemLabel = siem ? SIEM_DISPLAY_NAMES[siem] ?? siem : (destination ?? 'SIEM');
    return {
      rate_per_gb: listRate,
      source: 'list_price',
      // No SIEM exposes a negotiated $/GB via API (confirmed: usage bytes yes,
      // rate no, for every vendor), so list price is the honest default. The
      // disclosure both states that AND tells the reader how to supply their
      // real rate — the override the agent should relay when a user asks why
      // the dollars look off.
      disclosure: `(at ${siemLabel} list price $${listRate.toFixed(2)}/GB — your actual bill may differ depending on discounts, commits, or contract tier. To use your real rate, set \`analyzerCost\` in your env config or pass \`effective_ingest_per_gb\`.)`,
      origin: 'destination_list',
    };
  }

  // Rung 5: nothing known. Caller must collapse dollar fields to null.
  return {
    rate_per_gb: null,
    source: 'unset',
    disclosure:
      '(no $/GB rate configured — pass effective_ingest_per_gb, set envs.json analyzerCost, or export LOG10X_ANALYZER_COST)',
    origin: 'none',
  };
}

/**
 * Narrow a string analyzer field (as found on EnvConfig.analyzer) to a
 * destination key the rate resolver understands. Returns undefined when the
 * field is missing or names a destination outside COST_MODEL_BY_DESTINATION.
 *
 * Exposed so callers can take the same "destination from env.analyzer when
 * the tool's own `destination` arg is omitted" decision uniformly.
 */
export function destinationFromEnvAnalyzer(env: EnvConfig | undefined): string | undefined {
  const a = env?.analyzer;
  if (!a) return undefined;
  const key = a.toLowerCase();
  return key in COST_MODEL_BY_DESTINATION ? key : undefined;
}
