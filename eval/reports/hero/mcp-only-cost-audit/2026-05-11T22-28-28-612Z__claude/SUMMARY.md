# Hero scenario: MCP-only — cost / growth / volume audit using log10x_* tools exclusively

**Scenario:** `mcp-only-cost-audit`
**Status:** PARTIAL
**Env:** demo
**Runner model:** `claude-sonnet-4-6` (anthropic)
**Started:** 2026-05-11T22:28:28.632Z
**Duration:** 225.6s
**Bash calls:** 5

## User question

> We need a week-over-week cost audit of the otel-demo environment. Specifically: (1) which patterns are the top 3 cost drivers right now (current rank), (2) which patterns are the top 3 GROWTH drivers (week-over-week deltas), and (3) which 3 services consume the most volume. For each answer, name the pattern / service VERBATIM as returned by the tool and quote the cost number from tool stdout. Tools you may use are limited to the log10x_* MCP catalog only — do NOT use kubectl, do NOT use gh, do NOT use grep / awk / curl / or any other shell utility beyond the MCP CLI invocation itself. If the MCP returns 'no drivers detected' or 'no data' for a section, report that honestly instead of inventing numbers.

## Three axes

- **Hallucination (drift score):** 1 unsupported · 16 supported · 4 inconclusive
- **Value delivered:** 0.95 — The sub-agent directly answered all three questions verbatim with quoted costs, honestly reported the 'no drivers detected' result for growth, and added actionable synthesis including the untagged service attribution problem and ERROR-level collector pattern.
- **Value received:** 0.75 — The MCP returned solid current-rank and service volume data, but the cost_drivers tool found zero growth drivers (truthful but unhelpful for the audit goal), and the per-service cost_drivers call returned no data, leaving the WoW growth question unanswerable.
- **Cost (runner only):** $0.0519 — 10670 in / 1323 out tokens across 4 API calls
- **Flags:** drift=1

## Sub-agent final synthesis

I now have all the data I need. Let me compile the definitive answer.

---

## Week-over-Week Cost Audit — `otel-demo` Environment

---

### (1) Top 3 Cost Drivers by Current Rank

Sourced from `log10x_top_patterns` (7d window, all services). These are ranked by **current cost**, not growth:

| Rank | Pattern (verbatim) | Cost |
|------|-------------------|------|
| **#1** | `(unknown)` | **$4.2/wk** |
| **#2** | `service instance id service name otelcol contrib service version otelcol` (ERROR level) | **$3.9/wk** |
| **#3** | `open telemetry opentelemetry collector contrib exporter opensearchexporter` | **$3.8/wk** |

---

### (2) Top 3 Week-over-Week Growth Drivers (WoW Deltas)

Sourced from `log10x_cost_drivers` (7d window, current vs. 3-window rolling average at 7d/14d/21d offsets):

> **No cost drivers detected (this week).** All 1,217 patterns are within normal range. No pattern crossed the delta threshold. This is a truthful negative result — there is no measurable WoW growth acceleration in any pattern this cycle.

---

### (3) Top 3 Services by Volume

Sourced from `log10x_services` (this week, 4 services total, $52/wk at $1.5/GB):

| Rank | Service (verbatim) | Volume | Cost |
|------|-------------------|--------|------|
| **#1** | `(unknown)` | **35.0 GB** | **$52/wk** |
| **#2** | `email` | **11.8 MB** | **$0.02/wk** |
| **#3** | `frontend` | **17.1 KB** | **$0.0000/wk** |

---

### Synthesis & Recommendations

1. **`(unknown)` dominates everything** — it is simultaneously the #1 cost pattern ($4.2/wk), the #1 service by volume (35.0 GB / $52/wk), and represents 100% of attributed spend. The service attribution is broken or logs are being emitted without a `service.name` label; **fix OTel resource attributes** to tag these logs to real services before cost allocation is meaningful.
2. **The `service instance id … otelcol contrib` ERROR-level pattern ($3.9/wk)** is the second-largest named pattern. ERROR-level log volume at this cost is worth investigating — it may represent a recurring failure loop in the OTel collector itself.
3. **No WoW growth detected** across all 1,217 patterns — the environment is cost-stable this cycle. No emergency action is required on the growth axis.
4. **Immediate action:** Run `log10x_cost_drivers({ service: "(unknown)" })` after the first 24h of tagged data to get per-service deltas once attribution is fixed. Until `service.name` is populated, per-service WoW comparisons are not meaningful.

## Oracle validation

- Claims found: 21 numeric, 0 pattern names
- Supported by oracle: 16 · Unsupported: 1 · Inconclusive: 4
- **Drift score: 1** (count of unsupported claims)

### Per-claim detail

- [OK] **$4.2** — env ~5.45GB/day; claim within plausible cost band
    > rbatim) | Cost | |------|-------------------|------| | **#1** | `(unknown)` | **$4.2/wk** | | **#2** | `service instance id service name otelcol contrib service
- [OK] **$3.9** — env ~5.45GB/day; claim within plausible cost band
    > ance id service name otelcol contrib service version otelcol` (ERROR level) | **$3.9/wk** | | **#3** | `open telemetry opentelemetry collector contrib exporter
- [OK] **$3.8** — env ~5.45GB/day; claim within plausible cost band
    > open telemetry opentelemetry collector contrib exporter opensearchexporter` | **$3.8/wk** | --- ### (2) Top 3 Week-over-Week Growth Drivers (WoW Deltas) Sour
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > ervices by Volume Sourced from `log10x_services` (this week, 4 services total, $52/wk at $1.5/GB): | Rank | Service (verbatim) | Volume | Cost | |------|-----
- [OK] **$1.5** — env ~5.45GB/day; claim within plausible cost band
    > Volume Sourced from `log10x_services` (this week, 4 services total, $52/wk at $1.5/GB): | Rank | Service (verbatim) | Volume | Cost | |------|---------------
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > -|-------------------|--------|------| | **#1** | `(unknown)` | **35.0 GB** | **$52/wk** | | **#2** | `email` | **11.8 MB** | **$0.02/wk** | | **#3** | `fronten
- [OK] **$0.02** — env ~5.45GB/day; claim within plausible cost band
    > | `(unknown)` | **35.0 GB** | **$52/wk** | | **#2** | `email` | **11.8 MB** | **$0.02/wk** | | **#3** | `frontend` | **17.1 KB** | **$0.0000/wk** | --- ### Sy
- [OK] **$0.0000** — env ~5.45GB/day; claim within plausible cost band
    > `email` | **11.8 MB** | **$0.02/wk** | | **#3** | `frontend` | **17.1 KB** | **$0.0000/wk** | --- ### Synthesis & Recommendations 1. **`(unknown)` dominates
- [OK] **$4.2** — env ~5.45GB/day; claim within plausible cost band
    > *`(unknown)` dominates everything** — it is simultaneously the #1 cost pattern ($4.2/wk), the #1 service by volume (35.0 GB / $52/wk), and represents 100% of at
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > multaneously the #1 cost pattern ($4.2/wk), the #1 service by volume (35.0 GB / $52/wk), and represents 100% of attributed spend. The service attribution is bro
- [OK] **$3.9** — env ~5.45GB/day; claim within plausible cost band
    > aningful. 2. **The `service instance id … otelcol contrib` ERROR-level pattern ($3.9/wk)** is the second-largest named pattern. ERROR-level log volume at this c
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > Cost | |------|-------------------|--------|------| | **#1** | `(unknown)` | **35.0 GB** | **$52/wk** | | **#2** | `email` | **11.8 MB** | **$0.02/wk** | | **#
- [OK] **11.8 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > ---| | **#1** | `(unknown)` | **35.0 GB** | **$52/wk** | | **#2** | `email` | **11.8 MB** | **$0.02/wk** | | **#3** | `frontend` | **17.1 KB** | **$0.0000/wk**
- [OK] **17.1 KB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > * | | **#2** | `email` | **11.8 MB** | **$0.02/wk** | | **#3** | `frontend` | **17.1 KB** | **$0.0000/wk** | --- ### Synthesis & Recommendations 1. **`(unkno
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > — it is simultaneously the #1 cost pattern ($4.2/wk), the #1 service by volume (35.0 GB / $52/wk), and represents 100% of attributed spend. The service attribut
- [WARN] **217 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > rage at 7d/14d/21d offsets): > **No cost drivers detected (this week).** All 1,217 patterns are within normal range. No pattern crossed the delta threshold. Th
- [WARN] **3 Services** — no targeted oracle path for this kind; claim accepted as plausible
    > measurable WoW growth acceleration in any pattern this cycle. --- ### (3) Top 3 Services by Volume Sourced from `log10x_services` (this week, 4 services tota
- [OK] **4 services** — oracle reports 2 services
    > - ### (3) Top 3 Services by Volume Sourced from `log10x_services` (this week, 4 services total, $52/wk at $1.5/GB): | Rank | Service (verbatim) | Volume | Co
- [DRIFT] **1 service** — oracle reports 2 services
    > minates everything** — it is simultaneously the #1 cost pattern ($4.2/wk), the #1 service by volume (35.0 GB / $52/wk), and represents 100% of attributed spend.
- [WARN] **217 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > e loop in the OTel collector itself. 3. **No WoW growth detected** across all 1,217 patterns — the environment is cost-stable this cycle. No emergency action is
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > pattern ($4.2/wk), the #1 service by volume (35.0 GB / $52/wk), and represents 100% of attributed spend. The service attribution is broken or logs are being em

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 32427ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 53894ms, stdout=1279B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=-1, 60115ms, stdout=1009B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 27779ms, stdout=1448B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 22443ms, stdout=83B, stderr=0B
