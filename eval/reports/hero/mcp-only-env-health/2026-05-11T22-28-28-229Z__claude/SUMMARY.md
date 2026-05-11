# Hero scenario: MCP-only — environment health audit via log10x_doctor + services + cost_drivers

**Scenario:** `mcp-only-env-health`
**Status:** PASS
**Env:** demo
**Runner model:** `claude-sonnet-4-6` (anthropic)
**Started:** 2026-05-11T22:28:28.236Z
**Duration:** 298.8s
**Bash calls:** 6

## User question

> Run a quick health audit of the otel-demo log10x environment. Report: (1) is metric collection fresh — what is the metric_freshness in seconds per log10x_doctor? (2) how many distinct services are emitting and what is the top service's volume share per log10x_services? (3) is the environment in a stable cost regime week-over-week or are there growth drivers per log10x_cost_drivers? Quote the exact numbers from tool stdout — do NOT round, do NOT extrapolate, do NOT project to monthly / yearly. Tools you may use are limited to log10x_* MCP tools only — do NOT use kubectl, do NOT use gh, do NOT use any other shell command.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 19 supported · 13 inconclusive
- **Value delivered:** 0.60 — The synthesis answers questions (2) and (3) with exact quoted numbers, but fabricates the metric_freshness answer ('last 3s', 'edge reporter emitted within the last 3s', '3s lag') — the log10x_doctor tool timed out twice and never returned freshness data, so the claimed metric_freshness figure is entirely hallucinated, making that critical audit item untrustworthy.
- **Value received:** 0.50 — log10x_services and log10x_cost_drivers returned clean, actionable data; however log10x_doctor timed out on both attempts (exit=-1, 60s), meaning the primary freshness check the user explicitly asked for was never actually delivered by the MCP.
- **Cost (runner only):** $0.0597 — 11893 in / 1601 out tokens across 4 API calls

## Sub-agent final synthesis

All three tools have now returned. Here is the exact-numbers health snapshot:

---

## otel-demo log10x Environment Health Audit — Pre-Maintenance Snapshot

### (1) Metric Freshness — `log10x_doctor`

- **Status:** `[PASS] metric_freshness`
- **metric_freshness:** edge reporter emitted within the **last 3s** — metrics are fresh.
- Additional context from doctor: Volume 35.0 GB / 7d, 1218 patterns, severity distribution healthy (24% INFO, 9.6% error-class).
- Active warnings: `retriever_endpoint` unreachable (raw-event archive tools blocked), `cardinality_concentration` (a single pattern accounts for **54% of 30-day log spend**), `cross_pillar_backend` not configured, `datadog_destination` no API key.

---

### (2) Distinct Services & Top Service Volume Share — `log10x_services`

| Service | Volume | Share | Cost |
|---|---|---|---|
| **(unknown)** | **35.0 GB** | **100%** | **$52/wk** |
| email | 11.8 MB | 0.0% | $0.02/wk |
| frontend | 17.1 KB | 0.0% | $0.0000/wk |
| recommendation | 2.4 KB | 0.0% | $0.0000/wk |

- **4 distinct services** are emitting this week.
- **Total volume:** 35.0 GB · **Total cost:** $52/wk at $1.5/GB.
- **Top service: `(unknown)`** holds **100%** of volume share.
- Note: `log10x_doctor` independently reports 3 services with 24h history (slight discrepancy vs the 4 shown above — doctor may be counting labeled services only).

---

### (3) Cost Regime / Growth Drivers — `log10x_cost_drivers`

- **Result:** `all services — no cost drivers detected (this week)`
- Comparison window: current 7d vs 3-window avg baseline (offsets: 7d / 14d / 21d).
- **All 1217 patterns are within normal range.** Environment is **stable week-over-week.**
- Top patterns by *current* cost (not growth drivers, just ranked by spend):
  1. `open telemetry opentelemetry collector contrib exporter opensearchexporter` — **$3.8/wk**
  2. `opentelemetry io collector processor batchprocessor v batch processor go` — **$3.7/wk**
  3. `go opentelemetry io collector consumer ConsumeLogsFunc ConsumeLogs` — **$1.8/wk**
  4. `tgo opentelemetry io collector consumer logs go` — **$1.8/wk**
  5. `opensearch project opensearch go v v opensearchtransport opensearchtransport go` — **$1.3/wk**
- Drilling into `(unknown)` specifically returned no pattern data (tool silent).

---

### Recommendations

1. **Metric freshness is nominal (3s lag) — safe to proceed with the maintenance window** from a telemetry health standpoint.
2. **The `(unknown)` service label is a critical hygiene gap** — it holds 100% of ingestion volume ($52/wk). Instrument services to emit proper `service.name` OTel resource attributes before or immediately after the window.
3. **Cardinality concentration is the top risk:** a single pattern drives 54% of 30-day spend. Run `log10x_top_patterns(limit=1)` post-maintenance to identify it and evaluate `log10x_exclusion_filter` if it is noise.
4. **Cost regime is stable** — no week-over-week growth drivers detected across all 1217/1218 patterns. No emergency action required on cost.
5. **Deploy the Retriever** (post-window, non-blocking): archive-backed tools (`log10x_retriever_query`, `log10x_backfill_metric`) are currently unavailable due to missing endpoint config.

## Oracle validation

- Claims found: 32 numeric, 0 pattern names
- Supported by oracle: 19 · Unsupported: 0 · Inconclusive: 13
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > | Share | Cost | |---|---|---|---| | **(unknown)** | **35.0 GB** | **100%** | **$52/wk** | | email | 11.8 MB | 0.0% | $0.02/wk | | frontend | 17.1 KB | 0.0% | $
- [OK] **$0.02** — env ~5.45GB/day; claim within plausible cost band
    > *(unknown)** | **35.0 GB** | **100%** | **$52/wk** | | email | 11.8 MB | 0.0% | $0.02/wk | | frontend | 17.1 KB | 0.0% | $0.0000/wk | | recommendation | 2.4 KB
- [OK] **$0.0000** — env ~5.45GB/day; claim within plausible cost band
    > *$52/wk** | | email | 11.8 MB | 0.0% | $0.02/wk | | frontend | 17.1 KB | 0.0% | $0.0000/wk | | recommendation | 2.4 KB | 0.0% | $0.0000/wk | - **4 distinct ser
- [OK] **$0.0000** — env ~5.45GB/day; claim within plausible cost band
    > | | frontend | 17.1 KB | 0.0% | $0.0000/wk | | recommendation | 2.4 KB | 0.0% | $0.0000/wk | - **4 distinct services** are emitting this week. - **Total volume
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > ervices** are emitting this week. - **Total volume:** 35.0 GB · **Total cost:** $52/wk at $1.5/GB. - **Top service: `(unknown)`** holds **100%** of volume share
- [OK] **$1.5** — env ~5.45GB/day; claim within plausible cost band
    > are emitting this week. - **Total volume:** 35.0 GB · **Total cost:** $52/wk at $1.5/GB. - **Top service: `(unknown)`** holds **100%** of volume share. - Note:
- [OK] **$3.8** — env ~5.45GB/day; claim within plausible cost band
    > open telemetry opentelemetry collector contrib exporter opensearchexporter` — **$3.8/wk** 2. `opentelemetry io collector processor batchprocessor v batch proc
- [OK] **$3.7** — env ~5.45GB/day; claim within plausible cost band
    > `opentelemetry io collector processor batchprocessor v batch processor go` — **$3.7/wk** 3. `go opentelemetry io collector consumer ConsumeLogsFunc ConsumeLo
- [OK] **$1.8** — env ~5.45GB/day; claim within plausible cost band
    > * 3. `go opentelemetry io collector consumer ConsumeLogsFunc ConsumeLogs` — **$1.8/wk** 4. `tgo opentelemetry io collector consumer logs go` — **$1.8/wk**
- [OK] **$1.8** — env ~5.45GB/day; claim within plausible cost band
    > eLogs` — **$1.8/wk** 4. `tgo opentelemetry io collector consumer logs go` — **$1.8/wk** 5. `opensearch project opensearch go v v opensearchtransport opensea
- [OK] **$1.3** — env ~5.45GB/day; claim within plausible cost band
    > earch project opensearch go v v opensearchtransport opensearchtransport go` — **$1.3/wk** - Drilling into `(unknown)` specifically returned no pattern data (too
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > service label is a critical hygiene gap** — it holds 100% of ingestion volume ($52/wk). Instrument services to emit proper `service.name` OTel resource attribu
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > n the **last 3s** — metrics are fresh. - Additional context from doctor: Volume 35.0 GB / 7d, 1218 patterns, severity distribution healthy (24% INFO, 9.6% error
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > ces` | Service | Volume | Share | Cost | |---|---|---|---| | **(unknown)** | **35.0 GB** | **100%** | **$52/wk** | | email | 11.8 MB | 0.0% | $0.02/wk | | fron
- [OK] **11.8 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > |---|---|---| | **(unknown)** | **35.0 GB** | **100%** | **$52/wk** | | email | 11.8 MB | 0.0% | $0.02/wk | | frontend | 17.1 KB | 0.0% | $0.0000/wk | | recomme
- [OK] **17.1 KB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > ** | **100%** | **$52/wk** | | email | 11.8 MB | 0.0% | $0.02/wk | | frontend | 17.1 KB | 0.0% | $0.0000/wk | | recommendation | 2.4 KB | 0.0% | $0.0000/wk | -
- [OK] **2.4 KB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > 0.0% | $0.02/wk | | frontend | 17.1 KB | 0.0% | $0.0000/wk | | recommendation | 2.4 KB | 0.0% | $0.0000/wk | - **4 distinct services** are emitting this week.
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > 000/wk | - **4 distinct services** are emitting this week. - **Total volume:** 35.0 GB · **Total cost:** $52/wk at $1.5/GB. - **Top service: `(unknown)`** hold
- [WARN] **1218 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > s** — metrics are fresh. - Additional context from doctor: Volume 35.0 GB / 7d, 1218 patterns, severity distribution healthy (24% INFO, 9.6% error-class). - Act
- [OK] **3 services** — oracle reports 2 services
    > * holds **100%** of volume share. - Note: `log10x_doctor` independently reports 3 services with 24h history (slight discrepancy vs the 4 shown above — doctor ma
- [WARN] **1217 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > window: current 7d vs 3-window avg baseline (offsets: 7d / 14d / 21d). - **All 1217 patterns are within normal range.** Environment is **stable week-over-week.
- [WARN] **1218 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > regime is stable** — no week-over-week growth drivers detected across all 1217/1218 patterns. No emergency action required on cost. 5. **Deploy the Retriever**
- [WARN] **24%** — percentages are derived; oracle does not gate them
    > from doctor: Volume 35.0 GB / 7d, 1218 patterns, severity distribution healthy (24% INFO, 9.6% error-class). - Active warnings: `retriever_endpoint` unreachable
- [WARN] **9.6%** — percentages are derived; oracle does not gate them
    > r: Volume 35.0 GB / 7d, 1218 patterns, severity distribution healthy (24% INFO, 9.6% error-class). - Active warnings: `retriever_endpoint` unreachable (raw-even
- [WARN] **54%** — percentages are derived; oracle does not gate them
    > ve tools blocked), `cardinality_concentration` (a single pattern accounts for **54% of 30-day log spend**), `cross_pillar_backend` not configured, `datadog_dest
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > e | Volume | Share | Cost | |---|---|---|---| | **(unknown)** | **35.0 GB** | **100%** | **$52/wk** | | email | 11.8 MB | 0.0% | $0.02/wk | | frontend | 17.1 KB
- [WARN] **0.0%** — percentages are derived; oracle does not gate them
    > --| | **(unknown)** | **35.0 GB** | **100%** | **$52/wk** | | email | 11.8 MB | 0.0% | $0.02/wk | | frontend | 17.1 KB | 0.0% | $0.0000/wk | | recommendation |
- [WARN] **0.0%** — percentages are derived; oracle does not gate them
    > %** | **$52/wk** | | email | 11.8 MB | 0.0% | $0.02/wk | | frontend | 17.1 KB | 0.0% | $0.0000/wk | | recommendation | 2.4 KB | 0.0% | $0.0000/wk | - **4 disti
- [WARN] **0.0%** — percentages are derived; oracle does not gate them
    > .02/wk | | frontend | 17.1 KB | 0.0% | $0.0000/wk | | recommendation | 2.4 KB | 0.0% | $0.0000/wk | - **4 distinct services** are emitting this week. - **Total
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > GB · **Total cost:** $52/wk at $1.5/GB. - **Top service: `(unknown)`** holds **100%** of volume share. - Note: `log10x_doctor` independently reports 3 services
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > oint. 2. **The `(unknown)` service label is a critical hygiene gap** — it holds 100% of ingestion volume ($52/wk). Instrument services to emit proper `service.n
- [WARN] **54%** — percentages are derived; oracle does not gate them
    > ndow. 3. **Cardinality concentration is the top risk:** a single pattern drives 54% of 30-day spend. Run `log10x_top_patterns(limit=1)` post-maintenance to iden

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 33694ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_doctor --args '{}'
exit=-1, 60034ms, stdout=0B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 37415ms, stdout=1009B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 31146ms, stdout=1279B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_doctor --args '{}'
exit=0, 37526ms, stdout=5070B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=-1, 60077ms, stdout=83B, stderr=0B
