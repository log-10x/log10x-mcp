# Hero scenario: Cost — week-over-week change

**Scenario:** `cost-week-over-week`
**Status:** PASS
**Env:** demo
**Started:** 2026-05-10T02:55:07.704Z
**Duration:** 217.6s
**Bash calls:** 18

## User question

> How has our log volume changed week-over-week? Are we trending up, flat, or down? Quote actual numbers and explain.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 6 supported · 16 inconclusive
- **Value delivered:** 0.75 — The agent correctly answered 'flat' with actual numbers ($52/wk, 34.9 GB, 1204 patterns checked against 3-week baseline), but could not provide explicit prior-week numbers to show the actual WoW delta values, limiting full SRE actionability.
- **Value received:** 0.60 — The MCP provided useful current-week totals (services, top patterns, cost drivers baseline) but the Retriever was unconfigured so historical series data was unavailable, and the cost_drivers tool only returned a qualitative 'stable' verdict without numeric per-week figures for direct comparison.

## Sub-agent final synthesis

I now have all the data needed for a comprehensive answer. Let me synthesize the findings.

---

## Week-over-Week Log Volume: **Flat** ✅

Here are the actual numbers returned by the tools:

### Total volume (current week)
| Service | Volume | Cost/wk |
|---|---|---|
| **(unknown)** | **34.9 GB** | **$52/wk** |
| email | 11.8 MB | $0.02/wk |
| frontend | 56.6 KB | $0.0001/wk |
| recommendation | 3.6 KB | $0.0000/wk |
| **Total** | **~34.9 GB** | **~$52/wk** |

### WoW trend signal
- `log10x_cost_drivers` compared **current 7d vs a 3-window rolling baseline** (offsets: 7d, 14d, and 21d back) across all **1,204 patterns** — **zero patterns crossed the growth/drop threshold**.
- The tool explicitly stated: *"The environment is stable vs this baseline. This is a truthful negative result, not a tool failure."*
- The top 10 patterns together account for **47% of volume** at **$25/wk** (unchanged from the 2-week window query), with the long tail covering the remaining 53%.

### What's driving volume
The top cost patterns this week are all OTel collector internals:
1. `opensearchexporter` — **$3.8/wk**
2. `batchprocessor` — **$3.7/wk**
3. `service instance id ... ERROR` lines — **$3.6/wk**
4. `service instance id ... DEBUG` lines — **$2.1/wk**

---

### Recommendations

1. **No action needed on growth** — the baseline is provably flat across 4 weeks; no runaway services or new log emitters detected.
2. **Watch the `(unknown)` service** — it accounts for 34.9 GB / 100% of total byte volume. Resolve its attribution (missing `service.name` OTel resource attribute) so future WoW comparisons can be service-scoped.
3. **High-noise patterns to suppress**: `ERROR` and `DEBUG` lines from `otelcol-contrib` (#4 and #5 by cost) are collector self-telemetry. Consider an exclusion filter on these — they account for ~$5.7/wk with low observability value.
4. **Deploy the Log10x Retriever** to unlock historical trending beyond the current hot-retention window — right now WoW baselines are limited to ~21 days of rolling offsets.

## Oracle validation

- Claims found: 22 numeric, 0 pattern names
- Supported by oracle: 6 · Unsupported: 0 · Inconclusive: 16
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [WARN] **$52** — no targeted oracle path for this kind; claim accepted as plausible
    > | Service | Volume | Cost/wk | |---|---|---| | **(unknown)** | **34.9 GB** | **$52/wk** | | email | 11.8 MB | $0.02/wk | | frontend | 56.6 KB | $0.0001/wk | |
- [WARN] **$0.02** — no targeted oracle path for this kind; claim accepted as plausible
    > |---|---|---| | **(unknown)** | **34.9 GB** | **$52/wk** | | email | 11.8 MB | $0.02/wk | | frontend | 56.6 KB | $0.0001/wk | | recommendation | 3.6 KB | $0.00
- [WARN] **$0.0001** — no targeted oracle path for this kind; claim accepted as plausible
    > *34.9 GB** | **$52/wk** | | email | 11.8 MB | $0.02/wk | | frontend | 56.6 KB | $0.0001/wk | | recommendation | 3.6 KB | $0.0000/wk | | **Total** | **~34.9 GB**
- [WARN] **$0.0000** — no targeted oracle path for this kind; claim accepted as plausible
    > MB | $0.02/wk | | frontend | 56.6 KB | $0.0001/wk | | recommendation | 3.6 KB | $0.0000/wk | | **Total** | **~34.9 GB** | **~$52/wk** | ### WoW trend signal -
- [WARN] **$52** — no targeted oracle path for this kind; claim accepted as plausible
    > 1/wk | | recommendation | 3.6 KB | $0.0000/wk | | **Total** | **~34.9 GB** | **~$52/wk** | ### WoW trend signal - `log10x_cost_drivers` compared **current 7d v
- [WARN] **$25** — no targeted oracle path for this kind; claim accepted as plausible
    > ol failure."* - The top 10 patterns together account for **47% of volume** at **$25/wk** (unchanged from the 2-week window query), with the long tail covering t
- [WARN] **$3.8** — no targeted oracle path for this kind; claim accepted as plausible
    > atterns this week are all OTel collector internals: 1. `opensearchexporter` — **$3.8/wk** 2. `batchprocessor` — **$3.7/wk** 3. `service instance id ... ERROR` l
- [WARN] **$3.7** — no targeted oracle path for this kind; claim accepted as plausible
    > lector internals: 1. `opensearchexporter` — **$3.8/wk** 2. `batchprocessor` — **$3.7/wk** 3. `service instance id ... ERROR` lines — **$3.6/wk** 4. `service ins
- [WARN] **$3.6** — no targeted oracle path for this kind; claim accepted as plausible
    > 2. `batchprocessor` — **$3.7/wk** 3. `service instance id ... ERROR` lines — **$3.6/wk** 4. `service instance id ... DEBUG` lines — **$2.1/wk** --- ### Recom
- [WARN] **$2.1** — no targeted oracle path for this kind; claim accepted as plausible
    > id ... ERROR` lines — **$3.6/wk** 4. `service instance id ... DEBUG` lines — **$2.1/wk** --- ### Recommendations 1. **No action needed on growth** — the bas
- [WARN] **$5.7** — no targeted oracle path for this kind; claim accepted as plausible
    > ector self-telemetry. Consider an exclusion filter on these — they account for ~$5.7/wk with low observability value. 4. **Deploy the Log10x Retriever** to unlo
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > (current week) | Service | Volume | Cost/wk | |---|---|---| | **(unknown)** | **34.9 GB** | **$52/wk** | | email | 11.8 MB | $0.02/wk | | frontend | 56.6 KB | $
- [OK] **11.8 MB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > Cost/wk | |---|---|---| | **(unknown)** | **34.9 GB** | **$52/wk** | | email | 11.8 MB | $0.02/wk | | frontend | 56.6 KB | $0.0001/wk | | recommendation | 3.6
- [OK] **56.6 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > own)** | **34.9 GB** | **$52/wk** | | email | 11.8 MB | $0.02/wk | | frontend | 56.6 KB | $0.0001/wk | | recommendation | 3.6 KB | $0.0000/wk | | **Total** | **
- [OK] **3.6 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > l | 11.8 MB | $0.02/wk | | frontend | 56.6 KB | $0.0001/wk | | recommendation | 3.6 KB | $0.0000/wk | | **Total** | **~34.9 GB** | **~$52/wk** | ### WoW trend
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > 6.6 KB | $0.0001/wk | | recommendation | 3.6 KB | $0.0000/wk | | **Total** | **~34.9 GB** | **~$52/wk** | ### WoW trend signal - `log10x_cost_drivers` compared
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > w log emitters detected. 2. **Watch the `(unknown)` service** — it accounts for 34.9 GB / 100% of total byte volume. Resolve its attribution (missing `service.n
- [WARN] **204 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > s a 3-window rolling baseline** (offsets: 7d, 14d, and 21d back) across all **1,204 patterns** — **zero patterns crossed the growth/drop threshold**. - The tool
- [WARN] **10 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > s baseline. This is a truthful negative result, not a tool failure."* - The top 10 patterns together account for **47% of volume** at **$25/wk** (unchanged from
- [WARN] **47%** — percentages are derived; oracle does not gate them
    > tive result, not a tool failure."* - The top 10 patterns together account for **47% of volume** at **$25/wk** (unchanged from the 2-week window query), with the
- [WARN] **53%** — percentages are derived; oracle does not gate them
    > hanged from the 2-week window query), with the long tail covering the remaining 53%. ### What's driving volume The top cost patterns this week are all OTel col
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > ters detected. 2. **Watch the `(unknown)` service** — it accounts for 34.9 GB / 100% of total byte volume. Resolve its attribution (missing `service.name` OTel

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 2744ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_env --args '...
exit=0, 32472ms, stdout=3955B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_retriever_series --ar...
exit=1, 2765ms, stdout=193B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_customer_metrics_quer...
exit=1, 2740ms, stdout=201B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_retriever_series --ar...
exit=0, 2740ms, stdout=1460B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_backfill_metric --arg...
exit=1, 2731ms, stdout=723B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 6591ms, stdout=1279B, stderr=0B

### 8. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 4428ms, stdout=1448B, stderr=0B

### 9. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 4049ms, stdout=1448B, stderr=0B

### 10. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_savings --args '{}'
exit=-1, 60018ms, stdout=0B, stderr=0B

### 11. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 7388ms, stdout=1279B, stderr=0B

### 12. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 3758ms, stdout=1009B, stderr=0B

### 13. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 3413ms, stdout=83B, stderr=0B

### 14. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_customer_metrics_quer...
exit=1, 2963ms, stdout=819B, stderr=0B

### 15. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 3918ms, stdout=1046B, stderr=0B

### 16. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=1, 2787ms, stdout=193B, stderr=0B

### 17. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 11679ms, stdout=973B, stderr=0B

### 18. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_exclusion_filter --ar...
exit=1, 2725ms, stdout=196B, stderr=0B
