# Hero scenario: Hero — cost breakdown

**Scenario:** `hero-cost-breakdown`
**Status:** PASS
**Env:** demo
**Bash calls:** 12

## User question

> Our log bill jumped this week. What's driving it and what's the safest pattern to mute? Give me concrete dollar figures and a specific recommendation.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 2 supported · 22 inconclusive
- **Value delivered:** 0.85 — The synthesis provides concrete dollar figures, identifies the dominant cost source, names the safest pattern to mute with a specific regex and $2.1/wk savings, and gives an actionable 4-step recommendation an SRE could execute immediately, though it slightly overstates certainty about a 'bill jump' when tools found no week-over-week growth.
- **Value received:** 0.72 — MCP returned useful cost rankings, trend data, exclusion filter regexes, and service breakdowns, but pattern_examples failed due to missing scope, the (unknown) service drill-down returned no data, and the savings output was truncated, leaving meaningful gaps in root-cause evidence.

## Sub-agent final synthesis

Here is the full picture, every number sourced directly from tool output:

---

## What's Driving Your Log Bill

### The Macro View
- **Total log spend this week: $52/wk** across 34.9 GB of ingestion.
- One service — tagged **`(unknown)`** — accounts for **34.9 GB / 100% of all volume** at **$52/wk**. The other three services (`email`, `frontend`, `recommendation`) are negligible (<$0.02/wk combined).
- **No week-over-week growth spike was detected** (`log10x_cost_drivers` found all 1,204 patterns within normal range). The bill "jump" you're feeling is the steady-state run-rate of this one dominant, untagged service — it was already this expensive last week.

### Top Cost Patterns (Current Week, Ranked by $)
| # | Pattern | $/wk | Severity |
|---|---------|------|----------|
| 1 | *(unknown)* | $4.2 | — |
| 2 | `open telemetry opentelemetry collector contrib exporter opensearchexporter` | $3.8 | — |
| 3 | `opentelemetry io collector processor batchprocessor v batch processor go` | $3.7 | — |
| 4 | `service instance id service name otelcol contrib service version otelcol` | $3.6 | **ERROR** |
| 5 | `service instance id service name otelcol contrib service version otelcol` | $2.1 | **DEBUG** |
| 6–10 | Various OTel internal goroutine traces | ~$1.2–$1.8 each | — |

Top 10 = **47% of total volume**; top 20 = **70%**.

### The Safest Pattern to Mute
**Pattern #5: `service instance id service name otelcol contrib service version otelcol` at DEBUG level — $2.1/wk.**

This is an OTel Collector internal debug trace (stack frames, goroutine paths). It carries zero customer-facing signal, is already tagged `DEBUG`, and is stable (trend confirmed flat). Muting it is zero operational risk.

**Pattern #4 (same template, ERROR severity) at $3.6/wk** should be reviewed before muting — ERRORs from the exporter *could* indicate real export failures to OpenSearch. Confirm they are noisy retries before suppressing.

### Concrete Recommendation

1. **Immediately drop** the `DEBUG`-severity OTel collector pattern — saves **$2.1/wk ($109/yr)**. CloudWatch Lambda subscription filter regex (tool-generated):
   ```
   (?:service.*?instance.*?id.*?service.*?name.*?otelcol.*?contrib.*?service.*?version.*?otelcol|\bservice_instance_id_service_name_otelcol_contrib_service_version_otelcol\b)
   ```
2. **Investigate and likely drop** the `opensearchexporter` trace pattern ($3.8/wk) — it's pure OTel SDK internal logging with no customer context; confirm with the team, then add a matching filter.
3. **Fix the `(unknown)` service tag** — 100% of volume is unattributed, making cost ownership impossible. Instrument the OTel Collector's `service.name` resource attribute immediately.
4. **Current pipeline savings are only $0.08/wk ($4/yr projected)** — the existing filtering is nearly untouched. Addressing items 1–2 above would 10× the savings immediately.

## Oracle validation

- Claims found: 24 numeric, 0 pattern names
- Supported: 2 · Unsupported: 0 · Inconclusive: 22

### Per-claim detail

- [WARN] **$52** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$52** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$0.02** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$4.2** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$3.8** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$3.7** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$3.6** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$2.1** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$1.2** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$1.8** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$2.1** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$3.6** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$2.1** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$109** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$3.8** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$0.08** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$4** — no targeted oracle path for this kind; claim accepted as plausible
- [OK] **34.9 GB** — env total ~5.38GB/24h; claim plausible at 0.93× of some {1d,7d,30d} window
- [OK] **34.9 GB** — env total ~5.38GB/24h; claim plausible at 0.93× of some {1d,7d,30d} window
- [WARN] **204 patterns** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **100%** — percentages are derived; oracle does not gate them
- [WARN] **47%** — percentages are derived; oracle does not gate them
- [WARN] **70%** — percentages are derived; oracle does not gate them
- [WARN] **100%** — percentages are derived; oracle does not gate them