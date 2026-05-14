/**
 * PromQL → Datadog query language translator.
 *
 * Targets the closed set of query shapes the MCP's tools actually
 * issue, not arbitrary PromQL. The shapes are enumerated in
 * `src/lib/promql.ts`:
 *
 *   - `topk(N, sum by (a,b,c) (increase(M{filters}[range])))`
 *   - `sum by (a,b,c) (increase(M{filters}[range]))`
 *   - `sum by (label) (rate(M{filters}[range]))`
 *   - `sum(increase(M{filters}[range]))`
 *   - `sort_desc(sum by (a) (increase(M{filters}[range])))`
 *   - `count(increase(M{filters}[range]) > 0)`
 *   - `count(count by (svc) (increase(M[range]) > 0))`
 *   - `group by (a,b,c) (M{filters})`
 *
 * Mapping to Datadog's query syntax:
 *
 *   `sum:M{filters} by {labels}`               ← `sum by (labels) (M{filters})`
 *   `sum:M{filters}.as_count() by {labels}`    ← `sum by (labels) (increase(M{filters}[range]))`
 *   `sum:M{filters}.as_rate() by {labels}`     ← `sum by (labels) (rate(M{filters}[range]))`
 *   `top(<query>, N, 'sum', 'desc')`           ← `topk(N, <query>)`
 *   `count_not_null(<query>)`                  ← `count(<query>)`  (when wrapping a counted set)
 *
 * Datadog's range vector handling is implicit: pass the query without
 * `[range]` and DD applies its own rollup window based on the request's
 * `from`/`to`. The PromQL `[15m]` is informational; DD's response
 * granularity is governed by the query window, not the inline range.
 *
 * Vendored PromQL parser: `vendor/promql-parser` (MIT, generated from
 * a PEG.js grammar). Imported via createRequire because the parser is
 * CommonJS and the rest of the MCP is ESM.
 */

import { createRequire } from 'module';
import type {
  Expr,
  AggregateExpr,
  FunctionCall,
  VectorSelector,
  MatrixSelector,
  BinaryExpr,
  LabelMatcher,
} from '../../vendor/promql-parser/index.d.ts';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const parser: { parse: (s: string) => Expr } = require('../../vendor/promql-parser/promql.js');

export class PromQLTranslationError extends Error {
  constructor(message: string, public readonly promql: string) {
    super(message);
    this.name = 'PromQLTranslationError';
  }
}

/**
 * Translate a PromQL query string to a Datadog query string the
 * `/api/v1/query` endpoint accepts. Throws `PromQLTranslationError`
 * when the input shape is outside the supported subset.
 *
 * Pre-processes specific shapes that the vendored PEG.js grammar
 * doesn't parse cleanly:
 *   - `topk(N, INNER)` — grammar fails on multi-arg function calls;
 *     we extract N and INNER, translate INNER recursively, wrap with
 *     Datadog's top(...).
 *   - `bottomk(N, INNER)` — symmetric.
 *   - `sort_desc(INNER)` / `sort(INNER)` — strip the cosmetic wrapper
 *     and translate INNER; Datadog auto-orders.
 *   - `count(INNER > 0)` — collapse the boolean filter; translate
 *     INNER, wrap in count_not_null.
 */
export function promqlToDatadog(promql: string): string {
  const trimmed = promql.trim();

  // topk(N, INNER)
  const topkMatch = matchOuterCall('topk', trimmed);
  if (topkMatch) {
    const [nStr, inner] = splitFirstArg(topkMatch);
    const n = parseInt(nStr.trim(), 10);
    if (!Number.isFinite(n)) {
      throw new PromQLTranslationError(`topk: first arg not a number: ${nStr}`, promql);
    }
    return `top(${promqlToDatadog(inner)}, ${n}, 'sum', 'desc')`;
  }
  // bottomk(N, INNER)
  const bottomkMatch = matchOuterCall('bottomk', trimmed);
  if (bottomkMatch) {
    const [nStr, inner] = splitFirstArg(bottomkMatch);
    const n = parseInt(nStr.trim(), 10);
    if (!Number.isFinite(n)) {
      throw new PromQLTranslationError(`bottomk: first arg not a number: ${nStr}`, promql);
    }
    return `top(${promqlToDatadog(inner)}, ${n}, 'sum', 'asc')`;
  }
  // sort_desc(INNER) / sort(INNER) — cosmetic; pass inner through.
  const sortDescMatch = matchOuterCall('sort_desc', trimmed);
  if (sortDescMatch) return promqlToDatadog(sortDescMatch);
  const sortMatch = matchOuterCall('sort', trimmed);
  if (sortMatch) return promqlToDatadog(sortMatch);

  // count(INNER > 0) — strip the boolean filter and wrap.
  // Catches: count(rate(M[5m]) > 0), count(increase(M[7d]) > 0), etc.
  const countMatch = matchOuterCall('count', trimmed);
  if (countMatch) {
    const boolStripped = stripTrailingBooleanCompare(countMatch);
    if (boolStripped !== null) {
      return `count_not_null(${promqlToDatadog(boolStripped)})`;
    }
    // Plain count(...) — pass to parser, AST translator handles it.
  }

  // For everything else, hand to the PEG.js parser.
  let ast: Expr;
  try {
    ast = parser.parse(trimmed);
  } catch (e) {
    throw new PromQLTranslationError(
      `Parse failed: ${(e as Error).message.slice(0, 200)}`,
      promql
    );
  }
  return translate(ast, promql);
}

/**
 * If `input` is `<funcName>(...)` at the outer paren level, return the
 * INSIDE of the parens. Otherwise return null. Respects nesting:
 * `topk(5, sum by (a,b) (foo))` returns `5, sum by (a,b) (foo)`.
 */
function matchOuterCall(funcName: string, input: string): string | null {
  const prefix = funcName + '(';
  if (!input.startsWith(prefix)) return null;
  let depth = 1;
  let i = prefix.length;
  while (i < input.length && depth > 0) {
    if (input[i] === '(') depth++;
    else if (input[i] === ')') depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0) return null;
  // The match must consume the entire input (no trailing chars).
  if (i !== input.length - 1) return null;
  return input.slice(prefix.length, i);
}

/**
 * Split the FIRST comma-separated arg from the rest. Respects nesting.
 * For `5, sum by (a, b) (foo)` returns `['5', 'sum by (a, b) (foo)']`.
 */
function splitFirstArg(args: string): [string, string] {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      return [args.slice(0, i), args.slice(i + 1).trim()];
    }
  }
  return [args, ''];
}

/**
 * If `input` ends with `> 0`, `>= 0`, etc. at the outer level, return
 * the expression before the comparison. Otherwise null. Used to
 * collapse `count(... > 0)` to `count_not_null(...)`.
 */
function stripTrailingBooleanCompare(input: string): string | null {
  const trimmed = input.trim();
  // Match the trailing `op num` part respecting outer level.
  // The MCP only emits `> 0`. Other ops left for future.
  const m = trimmed.match(/^(.+?)\s*(>=|>|<=|<|==|!=)\s*([\d.]+)\s*$/);
  if (!m) return null;
  // Ensure the prefix is balanced (i.e. the trailing op isn't inside parens).
  let depth = 0;
  for (const c of m[1]) {
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
  }
  return depth === 0 ? m[1].trim() : null;
}

function translate(expr: Expr, sourcePromql: string): string {
  if (typeof expr === 'number') return String(expr);
  if (typeof expr === 'string') return JSON.stringify(expr);

  // Aggregator with possible nested function (the most common MCP shape).
  if (isAggregate(expr)) {
    return translateAggregate(expr, sourcePromql);
  }
  // Bare function call (e.g., topk at the top with no outer agg — rare;
  // MCP doesn't issue this shape, but it would parse as FunctionCall).
  if (isFunctionCall(expr)) {
    return translateFunctionCall(expr, sourcePromql);
  }
  // Bare vector selector — `M{f}` alone.
  if (isVectorSelector(expr)) {
    return `sum:${expr.metric}${ddSelectorString(expr.selectors)}`;
  }
  // Bare matrix selector — `M{f}[range]`. Datadog ignores the range;
  // we treat as a sum-as-count over the metric.
  if (isMatrixSelector(expr)) {
    return `sum:${expr.metric}${ddSelectorString(expr.selectors)}.as_count()`;
  }
  // BinaryExpr — currently NOT supported. The MCP issues only
  // `(increase(M[range]) > 0)` inside a `count()` wrapper, which we
  // collapse via `count_not_null` (no need to actually evaluate the
  // comparison). Surface the unsupported case explicitly.
  if (isBinaryExpr(expr)) {
    throw new PromQLTranslationError(
      `Binary expressions (${expr.op}) are not yet supported in the PromQL→Datadog translator. ` +
      `MCP queries use them only inside count() — file an issue with the query.`,
      sourcePromql
    );
  }
  throw new PromQLTranslationError(
    `Unsupported expression shape: ${JSON.stringify(expr).slice(0, 200)}`,
    sourcePromql
  );
}

/** Aggregator translation: handles `sum by`, `count`, `topk`, `sort_desc`-like. */
function translateAggregate(expr: AggregateExpr, sourcePromql: string): string {
  const { aggregator, body: rawBody, labels = [], aggregate_modifier } = expr;
  // Body is array-of-Expr when grammar matched (Expr ","? _)*, but
  // single-Expr when grammar matched the FunctionCall alt directly.
  // Normalize to array.
  const body = Array.isArray(rawBody) ? rawBody : [rawBody as unknown as Expr];

  // topk(N, inner) — body is [number, inner-expression].
  if (aggregator === 'topk') {
    const [nArg, inner] = body;
    if (typeof nArg !== 'number') {
      throw new PromQLTranslationError(
        `topk requires a numeric first argument; got ${JSON.stringify(nArg)}`,
        sourcePromql
      );
    }
    if (!inner) {
      throw new PromQLTranslationError(`topk requires an inner expression`, sourcePromql);
    }
    const innerQuery = translate(inner, sourcePromql);
    return `top(${innerQuery}, ${nArg}, 'sum', 'desc')`;
  }

  // bottomk(N, inner) — symmetric with topk
  if (aggregator === 'bottomk') {
    const [nArg, inner] = body;
    if (typeof nArg !== 'number') {
      throw new PromQLTranslationError(
        `bottomk requires a numeric first argument`, sourcePromql
      );
    }
    if (!inner) {
      throw new PromQLTranslationError(`bottomk requires an inner expression`, sourcePromql);
    }
    const innerQuery = translate(inner, sourcePromql);
    return `top(${innerQuery}, ${nArg}, 'sum', 'asc')`;
  }

  // `count(...)` aggregator — wraps the inner in count.
  // The MCP uses this for `count(metric)` (series count) AND
  // `count(rate(...) > 0)` (count-with-filter). We collapse the
  // boolean filter by counting non-null values.
  if (aggregator === 'count') {
    const inner = body[0];
    if (!inner) throw new PromQLTranslationError(`count requires inner expression`, sourcePromql);
    // For `count(BinaryExpr > 0)` we strip the comparison
    if (isBinaryExpr(inner) && (inner.op === '>' || inner.op === '>=')) {
      const innerLeft = translate(inner.left, sourcePromql);
      return `count_not_null(${innerLeft})`;
    }
    const innerQuery = translate(inner, sourcePromql);
    return `count_not_null(${innerQuery})`;
  }

  // `group by (labels) (M{f})` — Prometheus's group-aggregator with no
  // implicit math (just emit a series per unique label combo).
  // Datadog's closest match: `avg:M{f} by {labels}` returns one series
  // per group with the avg of values. We use `min` to closely match
  // group's "1 per combo" semantics without aggregating values too
  // aggressively.
  if (aggregator === 'group') {
    const inner = body[0];
    if (!inner) throw new PromQLTranslationError(`group requires inner expression`, sourcePromql);
    const baseSelector = extractBaseSelector(inner, sourcePromql);
    const byClause = labels.length > 0 && aggregate_modifier === 'by'
      ? ` by {${labels.join(',')}}`
      : '';
    return `min:${baseSelector}${byClause}`;
  }

  // Standard aggregators: sum, avg, min, max
  if (['sum', 'avg', 'min', 'max'].includes(aggregator)) {
    const inner = body[0];
    if (!inner) throw new PromQLTranslationError(`${aggregator} requires inner expression`, sourcePromql);

    if (aggregate_modifier === 'without') {
      throw new PromQLTranslationError(
        `'without' aggregation modifier is not supported in Datadog; queries must use 'by (...)' instead`,
        sourcePromql
      );
    }
    // Datadog syntax: `aggregator:metric{filters} by {labels}.suffix()`.
    // The `by {...}` clause goes BEFORE the `.as_count()` / `.as_rate()`
    // suffix, not after — Datadog's parser rejects suffix-then-by.
    const byClause = aggregate_modifier === 'by' && labels.length > 0
      ? ` by {${labels.join(',')}}`
      : '';

    // Inner is a function call wrapping a matrix selector?
    if (isFunctionCall(inner)) {
      const fnRawBody = inner.body;
      const fnBody = Array.isArray(fnRawBody) ? fnRawBody[0] : (fnRawBody as unknown as Expr);
      if (!fnBody) {
        throw new PromQLTranslationError(`${inner.func} called with no body`, sourcePromql);
      }
      const baseSelector = extractBaseSelector(fnBody, sourcePromql);
      const suffix = ddFunctionSuffix(inner.func);
      return `${aggregator}:${baseSelector}${byClause}${suffix}`;
    }

    // Inner is a vector/matrix selector directly (no function wrapper).
    if (isVectorSelector(inner) || isMatrixSelector(inner)) {
      const baseSelector = extractBaseSelector(inner, sourcePromql);
      // Matrix selector implies as_count semantics by default
      const suffix = isMatrixSelector(inner) ? '.as_count()' : '';
      return `${aggregator}:${baseSelector}${byClause}${suffix}`;
    }

    // Inner is itself an aggregate (e.g., `count(count by (svc) (...))`).
    // Translate inner first, then wrap.
    if (isAggregate(inner)) {
      const innerQuery = translate(inner, sourcePromql);
      const byClause = aggregate_modifier === 'by' && labels.length > 0
        ? ` by {${labels.join(',')}}`
        : '';
      return `${aggregator}:(${innerQuery})${byClause}`;
    }

    throw new PromQLTranslationError(
      `Unsupported inner shape for ${aggregator}: ${JSON.stringify(inner).slice(0, 200)}`,
      sourcePromql
    );
  }

  throw new PromQLTranslationError(
    `Aggregator '${aggregator}' is not yet supported`,
    sourcePromql
  );
}

/**
 * `sort_desc(query)` is a cosmetic wrapper in PromQL (Datadog auto-orders
 * series in many display contexts). Pass through the inner. Pure
 * `func(...)` calls at the top level (rare in MCP usage) handled here.
 */
function translateFunctionCall(expr: FunctionCall, sourcePromql: string): string {
  const { func, body: rawBody } = expr;
  const body = Array.isArray(rawBody) ? rawBody : [rawBody as unknown as Expr];
  if (func === 'sort_desc' || func === 'sort') {
    const inner = body[0];
    if (!inner) throw new PromQLTranslationError(`${func} requires inner`, sourcePromql);
    return translate(inner, sourcePromql);
  }
  // Function around a matrix selector at top level (e.g., bare `increase(M[5m])`).
  if (func === 'increase' || func === 'rate') {
    const fnBody = body[0];
    if (!fnBody) throw new PromQLTranslationError(`${func} requires body`, sourcePromql);
    const baseSelector = extractBaseSelector(fnBody, sourcePromql);
    return `sum:${baseSelector}${ddFunctionSuffix(func)}`;
  }
  throw new PromQLTranslationError(
    `Top-level function '${func}' not supported in this translator`,
    sourcePromql
  );
}

/**
 * Extract the Datadog metric+selector portion (e.g. `metric{tag:val}`)
 * from any inner expression. Handles VectorSelector, MatrixSelector,
 * and matrix-wrapped-in-function (which the caller is responsible for
 * unwrapping first).
 */
function extractBaseSelector(expr: Expr, sourcePromql: string): string {
  if (isMatrixSelector(expr)) {
    return `${ddMetricName(expr.metric)}${ddSelectorString(expr.selectors)}`;
  }
  if (isVectorSelector(expr)) {
    return `${ddMetricName(expr.metric)}${ddSelectorString(expr.selectors)}`;
  }
  throw new PromQLTranslationError(
    `Expected a metric selector, got: ${JSON.stringify(expr).slice(0, 200)}`,
    sourcePromql
  );
}

/**
 * Datadog convention strips `_total` from Prometheus-style counter
 * metric names on ingest. So the engine's `all_events_summaryBytes_total`
 * lands in Datadog as `all_events_summaryBytes`. We strip on query so
 * the MCP's PromQL works unchanged.
 *
 * Counter metric names ending in `_count`, `_sum`, `_bucket` are NOT
 * stripped (Datadog only strips `_total`).
 */
function ddMetricName(metric: string): string {
  return metric.endsWith('_total') ? metric.slice(0, -'_total'.length) : metric;
}

/**
 * Convert label matchers to Datadog tag selector syntax.
 *
 *   PromQL:   `{key="value", env="edge"}`
 *   Datadog:  `{key:value,env:edge}`
 *
 * For empty selectors, return `{*}` (Datadog's "all" placeholder).
 * Datadog doesn't accept `!=` directly in scope filters; we translate
 * by emitting a negated tag (`!key:value`).
 */
function ddSelectorString(selectors?: LabelMatcher[]): string {
  if (!selectors || selectors.length === 0) return '{*}';
  const parts = selectors.map((m) => {
    if (m.op === '=' || m.op === '==') {
      return `${m.label}:${m.value}`;
    }
    if (m.op === '!=') {
      return `!${m.label}:${m.value}`;
    }
    if (m.op === '=~') {
      // Datadog supports glob-style wildcards in scopes but not arbitrary regex.
      // Convert PromQL regex `.*` and `..` to glob `*` and `?` respectively;
      // pass through alternation `a|b` unchanged (Datadog supports `in` for that
      // but it requires a different syntax we don't emit yet).
      const v = m.value.replace(/\.\*/g, '*').replace(/\./g, '?');
      return `${m.label}:${v}`;
    }
    if (m.op === '!~') {
      const v = m.value.replace(/\.\*/g, '*').replace(/\./g, '?');
      return `!${m.label}:${v}`;
    }
    throw new Error(`Unsupported label match op: ${m.op}`);
  });
  return `{${parts.join(',')}}`;
}

/**
 * Map PromQL function over a matrix selector → Datadog query suffix.
 *
 *   `increase(M[range])` → `.as_count()` (counts the deltas; Datadog
 *      decides the rollup interval based on query window)
 *   `rate(M[range])`     → `.as_rate()` (per-second rate)
 */
function ddFunctionSuffix(func: string): string {
  switch (func) {
    case 'increase':
    case 'delta':
    case 'idelta':
      return '.as_count()';
    case 'rate':
    case 'irate':
    case 'deriv':
      return '.as_rate()';
    default:
      // Pass through unrecognized functions as no-op; the caller will
      // see a parse error from Datadog if the suffix is invalid.
      return '';
  }
}

// ── Type guards ─────────────────────────────────────────────────────

function isAggregate(e: Expr): e is AggregateExpr {
  return typeof e === 'object' && e !== null && 'aggregator' in e;
}
function isFunctionCall(e: Expr): e is FunctionCall {
  return typeof e === 'object' && e !== null && 'func' in e;
}
function isVectorSelector(e: Expr): e is VectorSelector {
  return (
    typeof e === 'object' &&
    e !== null &&
    'metric' in e &&
    !('range' in e) &&
    !('aggregator' in e) &&
    !('func' in e)
  );
}
function isMatrixSelector(e: Expr): e is MatrixSelector {
  return typeof e === 'object' && e !== null && 'metric' in e && 'range' in e;
}
function isBinaryExpr(e: Expr): e is BinaryExpr {
  return typeof e === 'object' && e !== null && 'left' in e && 'op' in e && 'right' in e;
}
