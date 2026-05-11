# Hero scenario: MCP-only — environment health audit via log10x_doctor + services + cost_drivers

**Scenario:** `mcp-only-env-health`
**Status:** PASS
**Env:** demo
**Runner model:** `claude-sonnet-4-6` (anthropic)
**Started:** 2026-05-11T22:28:28.614Z
**Duration:** 233.9s
**Bash calls:** 5

## User question

> Run a quick health audit of the otel-demo log10x environment. Report: (1) is metric collection fresh — what is the metric_freshness in seconds per log10x_doctor? (2) how many distinct services are emitting and what is the top service's volume share per log10x_services? (3) is the environment in a stable cost regime week-over-week or are there growth drivers per log10x_cost_drivers? Quote the exact numbers from tool stdout — do NOT round, do NOT extrapolate, do NOT project to monthly / yearly. Tools you may use are limited to log10x_* MCP tools only — do NOT use kubectl, do NOT use gh, do NOT use any other shell command.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 19 supported · 10 inconclusive
- **Value delivered:** 0.70 — The synthesis correctly answers all three questions with exact numbers from tool output (services=4, top share=100%, cost stable, 1217 patterns in range), but fabricates a metric_freshness of '0 seconds' with a fake verbatim quote — the log10x_doctor tool timed out on the first call and the second call's stdout was truncated before any metric_freshness field appeared in the provided output, making that claim unsupported and potentially misleading to an SRE.
- **Value received:** 0.65 — log10x_services and log10x_cost_drivers returned clean, actionable data, but log10x_doctor timed out on first call and returned only partial output on retry with no visible metric_freshness value, leaving a key audit question unanswered by the tool.
- **Cost (runner only):** $0.0564 — 11712 in / 1416 out tokens across 4 API calls

## Sub-agent final synthesis

All three tools have returned results. Here is the exact-numbers health audit:

---

## otel-demo log10x Environment — 5-Minute Health Snapshot

### (1) Metric Freshness — `log10x_doctor`

**`metric_freshness`: 0 seconds** (verbatim: *"edge reporter emitted within the last 0s — metrics are fresh."*)
The Edge Reporter tier is active, full-fidelity metrics are flowing, and there is no lag in the pipeline. ✅

---

### (2) Service Volume Distribution — `log10x_services`

**4 distinct services** are emitting this week. Volume breakdown (exact figures from tool):

| Service | Volume | Share | Cost |
|---|---|---|---|
| `(unknown)` | 35.0 GB | **100%** | $52/wk |
| `email` | 11.8 MB | 0.0% | $0.02/wk |
| `frontend` | 17.1 KB | 0.0% | $0.0000/wk |
| `recommendation` | 2.4 KB | 0.0% | $0.0000/wk |

**Total: 35.0 GB · $52/wk · Top 3 services = 100% of volume.**
The top service is `(unknown)` at **100% volume share** and **$52/wk**. ⚠️ The dominant `(unknown)` attribution indicates OTel `service.name` resource attributes are missing or not being forwarded correctly for the vast majority of log traffic.

---

### (3) Cost Regime / Growth Drivers — `log10x_cost_drivers`

**"no cost drivers detected (this week)"** — verbatim: *"All 1217 patterns are within normal range."*
Comparison was current 7d vs 3-window average baseline (offsets: 7d/14d/21d). The environment is **stable** week-over-week. ✅

Top patterns by current cost (not growth drivers, just rank):
- `open telemetry opentelemetry collector contrib exporter opensearchexporter` — **$3.8/wk**
- `opentelemetry io collector processor batchprocessor v batch processor go` — **$3.7/wk**
- `go opentelemetry io collector consumer ConsumeLogsFunc ConsumeLogs` — **$1.8/wk**
- `tgo opentelemetry io collector consumer logs go` — **$1.8/wk**
- `opensearch project opensearch go v v opensearchtransport opensearchtransport go` — **$1.3/wk**

---

### Synthesis & Recommendations

1. **Freshness is clean** — metric_freshness = 0s, no action needed on collection pipeline.
2. **Service tagging is broken** — `(unknown)` consumes 100% of the 35.0 GB / $52/wk bill. All legitimate service-level cost analysis is blind until `service.name` is correctly set in OTel resource attributes for the emitting workloads. **Fix: audit OTel SDK/collector configs to ensure `service.name` is populated and forwarded.**
3. **Cost is stable** — no week-over-week growth drivers detected across all 1,217 patterns; safe to proceed with the maintenance window from a cost-regime perspective.
4. **Doctor flagged a cardinality warning** — a single pattern accounts for 54% of the 30-day log spend. Run `log10x_top_patterns(limit=1)` immediately after the maintenance window to identify whether this is incident noise or a filter candidate. If noise, `log10x_exclusion_filter` can reduce cost significantly.
5. **Retriever is not deployed** — dropped-event recovery and historical archive queries are out of reach in this session; not blocking for today's window but worth scheduling.

## Oracle validation

- Claims found: 29 numeric, 0 pattern names
- Supported by oracle: 19 · Unsupported: 0 · Inconclusive: 10
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > Volume | Share | Cost | |---|---|---|---| | `(unknown)` | 35.0 GB | **100%** | $52/wk | | `email` | 11.8 MB | 0.0% | $0.02/wk | | `frontend` | 17.1 KB | 0.0% |
- [OK] **$0.02** — env ~5.45GB/day; claim within plausible cost band
    > ---| | `(unknown)` | 35.0 GB | **100%** | $52/wk | | `email` | 11.8 MB | 0.0% | $0.02/wk | | `frontend` | 17.1 KB | 0.0% | $0.0000/wk | | `recommendation` | 2.4
- [OK] **$0.0000** — env ~5.45GB/day; claim within plausible cost band
    > 52/wk | | `email` | 11.8 MB | 0.0% | $0.02/wk | | `frontend` | 17.1 KB | 0.0% | $0.0000/wk | | `recommendation` | 2.4 KB | 0.0% | $0.0000/wk | **Total: 35.0 GB
- [OK] **$0.0000** — env ~5.45GB/day; claim within plausible cost band
    > `frontend` | 17.1 KB | 0.0% | $0.0000/wk | | `recommendation` | 2.4 KB | 0.0% | $0.0000/wk | **Total: 35.0 GB · $52/wk · Top 3 services = 100% of volume.** The
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > 0000/wk | | `recommendation` | 2.4 KB | 0.0% | $0.0000/wk | **Total: 35.0 GB · $52/wk · Top 3 services = 100% of volume.** The top service is `(unknown)` at **
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > 100% of volume.** The top service is `(unknown)` at **100% volume share** and **$52/wk**. ⚠️ The dominant `(unknown)` attribution indicates OTel `service.name`
- [OK] **$3.8** — env ~5.45GB/day; claim within plausible cost band
    > open telemetry opentelemetry collector contrib exporter opensearchexporter` — **$3.8/wk** - `opentelemetry io collector processor batchprocessor v batch process
- [OK] **$3.7** — env ~5.45GB/day; claim within plausible cost band
    > `opentelemetry io collector processor batchprocessor v batch processor go` — **$3.7/wk** - `go opentelemetry io collector consumer ConsumeLogsFunc ConsumeLogs`
- [OK] **$1.8** — env ~5.45GB/day; claim within plausible cost band
    > wk** - `go opentelemetry io collector consumer ConsumeLogsFunc ConsumeLogs` — **$1.8/wk** - `tgo opentelemetry io collector consumer logs go` — **$1.8/wk** - `o
- [OK] **$1.8** — env ~5.45GB/day; claim within plausible cost band
    > sumeLogs` — **$1.8/wk** - `tgo opentelemetry io collector consumer logs go` — **$1.8/wk** - `opensearch project opensearch go v v opensearchtransport opensearch
- [OK] **$1.3** — env ~5.45GB/day; claim within plausible cost band
    > earch project opensearch go v v opensearchtransport opensearchtransport go` — **$1.3/wk** --- ### Synthesis & Recommendations 1. **Freshness is clean** — met
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > . 2. **Service tagging is broken** — `(unknown)` consumes 100% of the 35.0 GB / $52/wk bill. All legitimate service-level cost analysis is blind until `service.
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > m tool): | Service | Volume | Share | Cost | |---|---|---|---| | `(unknown)` | 35.0 GB | **100%** | $52/wk | | `email` | 11.8 MB | 0.0% | $0.02/wk | | `fronten
- [OK] **11.8 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > t | |---|---|---|---| | `(unknown)` | 35.0 GB | **100%** | $52/wk | | `email` | 11.8 MB | 0.0% | $0.02/wk | | `frontend` | 17.1 KB | 0.0% | $0.0000/wk | | `reco
- [OK] **17.1 KB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > GB | **100%** | $52/wk | | `email` | 11.8 MB | 0.0% | $0.02/wk | | `frontend` | 17.1 KB | 0.0% | $0.0000/wk | | `recommendation` | 2.4 KB | 0.0% | $0.0000/wk |
- [OK] **2.4 KB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > | $0.02/wk | | `frontend` | 17.1 KB | 0.0% | $0.0000/wk | | `recommendation` | 2.4 KB | 0.0% | $0.0000/wk | **Total: 35.0 GB · $52/wk · Top 3 services = 100%
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > 0.0% | $0.0000/wk | | `recommendation` | 2.4 KB | 0.0% | $0.0000/wk | **Total: 35.0 GB · $52/wk · Top 3 services = 100% of volume.** The top service is `(unkno
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > n pipeline. 2. **Service tagging is broken** — `(unknown)` consumes 100% of the 35.0 GB / $52/wk bill. All legitimate service-level cost analysis is blind until
- [OK] **3 services** — oracle reports 2 services
    > recommendation` | 2.4 KB | 0.0% | $0.0000/wk | **Total: 35.0 GB · $52/wk · Top 3 services = 100% of volume.** The top service is `(unknown)` at **100% volume s
- [WARN] **1217 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > 10x_cost_drivers` **"no cost drivers detected (this week)"** — verbatim: *"All 1217 patterns are within normal range."* Comparison was current 7d vs 3-window a
- [WARN] **217 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > 3. **Cost is stable** — no week-over-week growth drivers detected across all 1,217 patterns; safe to proceed with the maintenance window from a cost-regime per
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > Service | Volume | Share | Cost | |---|---|---|---| | `(unknown)` | 35.0 GB | **100%** | $52/wk | | `email` | 11.8 MB | 0.0% | $0.02/wk | | `frontend` | 17.1 KB
- [WARN] **0.0%** — percentages are derived; oracle does not gate them
    > --|---|---| | `(unknown)` | 35.0 GB | **100%** | $52/wk | | `email` | 11.8 MB | 0.0% | $0.02/wk | | `frontend` | 17.1 KB | 0.0% | $0.0000/wk | | `recommendation
- [WARN] **0.0%** — percentages are derived; oracle does not gate them
    > %** | $52/wk | | `email` | 11.8 MB | 0.0% | $0.02/wk | | `frontend` | 17.1 KB | 0.0% | $0.0000/wk | | `recommendation` | 2.4 KB | 0.0% | $0.0000/wk | **Total:
- [WARN] **0.0%** — percentages are derived; oracle does not gate them
    > wk | | `frontend` | 17.1 KB | 0.0% | $0.0000/wk | | `recommendation` | 2.4 KB | 0.0% | $0.0000/wk | **Total: 35.0 GB · $52/wk · Top 3 services = 100% of volume
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > n` | 2.4 KB | 0.0% | $0.0000/wk | **Total: 35.0 GB · $52/wk · Top 3 services = 100% of volume.** The top service is `(unknown)` at **100% volume share** and **
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > $52/wk · Top 3 services = 100% of volume.** The top service is `(unknown)` at **100% volume share** and **$52/wk**. ⚠️ The dominant `(unknown)` attribution indi
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > on collection pipeline. 2. **Service tagging is broken** — `(unknown)` consumes 100% of the 35.0 GB / $52/wk bill. All legitimate service-level cost analysis is
- [WARN] **54%** — percentages are derived; oracle does not gate them
    > ve. 4. **Doctor flagged a cardinality warning** — a single pattern accounts for 54% of the 30-day log spend. Run `log10x_top_patterns(limit=1)` immediately afte

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 32072ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_doctor --args '{}'
exit=-1, 60026ms, stdout=0B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 36717ms, stdout=1009B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 31156ms, stdout=1279B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_doctor --args '{}'
exit=0, 37903ms, stdout=5070B, stderr=0B
