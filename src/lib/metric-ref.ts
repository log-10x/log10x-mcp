/**
 * Canonical metric_ref string for cross-pillar primitives.
 *
 * Today's pain (surfaced by the AI-as-user consult, 2026-05-28): a
 * candidate metric flows through the three primitives in different
 * shapes — the raw PromQL string in input, a label dict or a different
 * normalized form in output, sometimes inconsistent across the tools.
 * Agents waste turns reformatting and occasionally lose the metric
 * across a multi-tool chain.
 *
 * Goal: one canonical `metric_ref` string per metric, identical across
 * all three primitives, round-trippable. Pass the metric_ref from one
 * tool's output directly to the next tool's input.
 *
 * Normalization rules (kept minimal so the round-trip is reliable):
 *   - Collapse runs of whitespace inside the expression to a single
 *     space. Different PromQL formatters produce different whitespace.
 *   - Trim leading + trailing whitespace.
 *   - Preserve label order inside `{...}` blocks AS-IS. Re-sorting label
 *     orders breaks round-trips when a backend echoes labels back in a
 *     specific order.
 *   - Preserve all operators, quote styles, escapes. Don't try to be
 *     clever — same input string → same metric_ref every time.
 *
 * What this is NOT: a semantic equivalence check. Two queries that
 * return the same series via different syntax (e.g.
 * `up{job="x"}` vs `up{job=~"x"}`) get different metric_refs. That's
 * by design — we want exact round-trips, not semantic dedup.
 */

/**
 * Normalize a PromQL expression to its canonical metric_ref form.
 *
 * Deterministic: same input always produces the same output. Idempotent:
 * `canonicalMetricRef(canonicalMetricRef(x)) === canonicalMetricRef(x)`.
 */
export function canonicalMetricRef(promql: string): string {
  return promql.replace(/\s+/g, ' ').trim();
}
