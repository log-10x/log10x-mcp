# Hero scenario: Errors — severity distribution

**Scenario:** `error-severity-distribution`
**Status:** PASS
**Env:** demo
**Started:** 2026-05-10T03:13:20.700Z
**Duration:** 59.8s
**Bash calls:** 6

## User question

> Break down our 24h log volume by severity level. Show me the percentages — what fraction is INFO vs WARN vs ERROR vs CRITICAL etc. If some volume has no severity tag, call that out specifically.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 16 supported · 20 inconclusive
- **Value delivered:** 0.97 — The synthesis directly answered the question with a clear percentage table for all severity levels, explicitly called out the 83% untagged volume as requested, and provided actionable remediation steps an SRE could act on immediately.
- **Value received:** 0.95 — The log10x_list_by_label tool returned exactly the needed breakdown with volume, percentages, and cost per severity level including the unlabeled bucket, giving the sub-agent all the data required to answer the question.

## Sub-agent final synthesis

Here is the full severity breakdown report:

---

## 24h Log Volume by Severity Level

| Severity | Volume | Share |
|---|---|---|
| 🔴 **(empty — no tag)** | **28.9 GB** | **83%** |
| ERROR | 3.0 GB | 9% |
| DEBUG | 1.5 GB | 4% |
| INFO | 838.9 MB | 2% |
| TRACE | 646.7 MB | 2% |
| CRITICAL | 14.7 MB | <1% |
| WARN | 49.5 KB | <1% |
| **Total** | **34.9 GB** | 100% |

---

### 🚨 Label-Quality Finding: 83% of Volume Is Untagged

The single most important finding is not which severity level dominates — **it's that 83% of your log volume (28.9 GB out of 34.9 GB) carries no `severity_level` tag at all** (shown as `empty` in the breakdown). This is a serious observability hygiene issue: the majority of your logs are invisible to any severity-based alert, filter, or cost policy.

### What the tagged 17% tells us

Among logs that *are* tagged, the distribution is heavily skewed toward high-noise, low-signal levels:
- **ERROR (9%)** is the largest tagged tier — healthy to have, but at 3 GB it warrants cost scrutiny.
- **DEBUG (4%)** shipping to production at 1.5 GB/week is a common cost leak; debug logs typically should be suppressed or sampled before ingestion.
- **INFO (2%)**, **TRACE (2%)** are small but present.
- **CRITICAL (<1%) and WARN (<1%)** are nearly invisible — 14.7 MB and 49.5 KB respectively — which is suspiciously low and may indicate missing severity enrichment on important alert-worthy events.

### Recommendations

1. **Fix the untagged 83% first.** Audit your OTel collector pipeline and instrumentation to ensure `severity_level` (or `SeverityText` in OTel spec) is populated on emission. The top patterns ranked by `(unknown)` severity in the pattern view confirm these originate from collector-internal logs lacking enrichment.
2. **Suppress or sample DEBUG in production.** 1.5 GB/week of DEBUG-tagged logs is a controllable cost lever — apply an exclusion filter or a tail-sampling processor at the collector.
3. **Investigate the near-zero WARN volume.** Only 49.5 KB of WARN over 24h across the entire environment is almost certainly a labeling gap, not a genuinely quiet system — those events are likely landing in `empty`.
4. **Set a label-quality SLO**: target ≥95% of log volume carrying a valid `severity_level` tag; currently you are at ~17%.

## Oracle validation

- Claims found: 36 numeric, 0 pattern names
- Supported by oracle: 16 · Unsupported: 0 · Inconclusive: 20
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **28.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > evel | Severity | Volume | Share | |---|---|---| | 🔴 **(empty — no tag)** | **28.9 GB** | **83%** | | ERROR | 3.0 GB | 9% | | DEBUG | 1.5 GB | 4% | | INFO | 8
- [OK] **3.0 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > e | |---|---|---| | 🔴 **(empty — no tag)** | **28.9 GB** | **83%** | | ERROR | 3.0 GB | 9% | | DEBUG | 1.5 GB | 4% | | INFO | 838.9 MB | 2% | | TRACE | 646.7 M
- [OK] **1.5 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > *(empty — no tag)** | **28.9 GB** | **83%** | | ERROR | 3.0 GB | 9% | | DEBUG | 1.5 GB | 4% | | INFO | 838.9 MB | 2% | | TRACE | 646.7 MB | 2% | | CRITICAL | 14
- [OK] **838.9 MB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > *28.9 GB** | **83%** | | ERROR | 3.0 GB | 9% | | DEBUG | 1.5 GB | 4% | | INFO | 838.9 MB | 2% | | TRACE | 646.7 MB | 2% | | CRITICAL | 14.7 MB | <1% | | WARN |
- [OK] **646.7 MB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > RROR | 3.0 GB | 9% | | DEBUG | 1.5 GB | 4% | | INFO | 838.9 MB | 2% | | TRACE | 646.7 MB | 2% | | CRITICAL | 14.7 MB | <1% | | WARN | 49.5 KB | <1% | | **Total*
- [OK] **14.7 MB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > | 1.5 GB | 4% | | INFO | 838.9 MB | 2% | | TRACE | 646.7 MB | 2% | | CRITICAL | 14.7 MB | <1% | | WARN | 49.5 KB | <1% | | **Total** | **34.9 GB** | 100% | ---
- [OK] **49.5 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > 838.9 MB | 2% | | TRACE | 646.7 MB | 2% | | CRITICAL | 14.7 MB | <1% | | WARN | 49.5 KB | <1% | | **Total** | **34.9 GB** | 100% | --- ### 🚨 Label-Quality Fi
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > MB | 2% | | CRITICAL | 14.7 MB | <1% | | WARN | 49.5 KB | <1% | | **Total** | **34.9 GB** | 100% | --- ### 🚨 Label-Quality Finding: 83% of Volume Is Untagged
- [OK] **28.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > ing is not which severity level dominates — **it's that 83% of your log volume (28.9 GB out of 34.9 GB) carries no `severity_level` tag at all** (shown as `empt
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > h severity level dominates — **it's that 83% of your log volume (28.9 GB out of 34.9 GB) carries no `severity_level` tag at all** (shown as `empty` in the break
- [OK] **3 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > l levels: - **ERROR (9%)** is the largest tagged tier — healthy to have, but at 3 GB it warrants cost scrutiny. - **DEBUG (4%)** shipping to production at 1.5 G
- [OK] **1.5 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > t at 3 GB it warrants cost scrutiny. - **DEBUG (4%)** shipping to production at 1.5 GB/week is a common cost leak; debug logs typically should be suppressed or
- [OK] **14.7 MB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > e small but present. - **CRITICAL (<1%) and WARN (<1%)** are nearly invisible — 14.7 MB and 49.5 KB respectively — which is suspiciously low and may indicate mi
- [OK] **49.5 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > present. - **CRITICAL (<1%) and WARN (<1%)** are nearly invisible — 14.7 MB and 49.5 KB respectively — which is suspiciously low and may indicate missing severi
- [OK] **1.5 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > nternal logs lacking enrichment. 2. **Suppress or sample DEBUG in production.** 1.5 GB/week of DEBUG-tagged logs is a controllable cost lever — apply an exclusi
- [OK] **49.5 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > processor at the collector. 3. **Investigate the near-zero WARN volume.** Only 49.5 KB of WARN over 24h across the entire environment is almost certainly a lab
- [WARN] **83%** — percentages are derived; oracle does not gate them
    > ty | Volume | Share | |---|---|---| | 🔴 **(empty — no tag)** | **28.9 GB** | **83%** | | ERROR | 3.0 GB | 9% | | DEBUG | 1.5 GB | 4% | | INFO | 838.9 MB | 2% |
- [WARN] **9%** — percentages are derived; oracle does not gate them
    > ---|---| | 🔴 **(empty — no tag)** | **28.9 GB** | **83%** | | ERROR | 3.0 GB | 9% | | DEBUG | 1.5 GB | 4% | | INFO | 838.9 MB | 2% | | TRACE | 646.7 MB | 2% |
- [WARN] **4%** — percentages are derived; oracle does not gate them
    > no tag)** | **28.9 GB** | **83%** | | ERROR | 3.0 GB | 9% | | DEBUG | 1.5 GB | 4% | | INFO | 838.9 MB | 2% | | TRACE | 646.7 MB | 2% | | CRITICAL | 14.7 MB | <
- [WARN] **2%** — percentages are derived; oracle does not gate them
    > | **83%** | | ERROR | 3.0 GB | 9% | | DEBUG | 1.5 GB | 4% | | INFO | 838.9 MB | 2% | | TRACE | 646.7 MB | 2% | | CRITICAL | 14.7 MB | <1% | | WARN | 49.5 KB | <
- [WARN] **2%** — percentages are derived; oracle does not gate them
    > GB | 9% | | DEBUG | 1.5 GB | 4% | | INFO | 838.9 MB | 2% | | TRACE | 646.7 MB | 2% | | CRITICAL | 14.7 MB | <1% | | WARN | 49.5 KB | <1% | | **Total** | **34.9
- [WARN] **1%** — percentages are derived; oracle does not gate them
    > 4% | | INFO | 838.9 MB | 2% | | TRACE | 646.7 MB | 2% | | CRITICAL | 14.7 MB | <1% | | WARN | 49.5 KB | <1% | | **Total** | **34.9 GB** | 100% | --- ### 🚨 La
- [WARN] **1%** — percentages are derived; oracle does not gate them
    > 2% | | TRACE | 646.7 MB | 2% | | CRITICAL | 14.7 MB | <1% | | WARN | 49.5 KB | <1% | | **Total** | **34.9 GB** | 100% | --- ### 🚨 Label-Quality Finding: 83%
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > CRITICAL | 14.7 MB | <1% | | WARN | 49.5 KB | <1% | | **Total** | **34.9 GB** | 100% | --- ### 🚨 Label-Quality Finding: 83% of Volume Is Untagged The single
- [WARN] **83%** — percentages are derived; oracle does not gate them
    > | <1% | | **Total** | **34.9 GB** | 100% | --- ### 🚨 Label-Quality Finding: 83% of Volume Is Untagged The single most important finding is not which severi
- [WARN] **83%** — percentages are derived; oracle does not gate them
    > ngle most important finding is not which severity level dominates — **it's that 83% of your log volume (28.9 GB out of 34.9 GB) carries no `severity_level` tag
- [WARN] **17%** — percentages are derived; oracle does not gate them
    > sible to any severity-based alert, filter, or cost policy. ### What the tagged 17% tells us Among logs that *are* tagged, the distribution is heavily skewed t
- [WARN] **9%** — percentages are derived; oracle does not gate them
    > distribution is heavily skewed toward high-noise, low-signal levels: - **ERROR (9%)** is the largest tagged tier — healthy to have, but at 3 GB it warrants cost
- [WARN] **4%** — percentages are derived; oracle does not gate them
    > agged tier — healthy to have, but at 3 GB it warrants cost scrutiny. - **DEBUG (4%)** shipping to production at 1.5 GB/week is a common cost leak; debug logs ty
- [WARN] **2%** — percentages are derived; oracle does not gate them
    > ebug logs typically should be suppressed or sampled before ingestion. - **INFO (2%)**, **TRACE (2%)** are small but present. - **CRITICAL (<1%) and WARN (<1%)**
- [WARN] **2%** — percentages are derived; oracle does not gate them
    > lly should be suppressed or sampled before ingestion. - **INFO (2%)**, **TRACE (2%)** are small but present. - **CRITICAL (<1%) and WARN (<1%)** are nearly invi
- [WARN] **1%** — percentages are derived; oracle does not gate them
    > ngestion. - **INFO (2%)**, **TRACE (2%)** are small but present. - **CRITICAL (<1%) and WARN (<1%)** are nearly invisible — 14.7 MB and 49.5 KB respectively — w
- [WARN] **1%** — percentages are derived; oracle does not gate them
    > NFO (2%)**, **TRACE (2%)** are small but present. - **CRITICAL (<1%) and WARN (<1%)** are nearly invisible — 14.7 MB and 49.5 KB respectively — which is suspici
- [WARN] **83%** — percentages are derived; oracle does not gate them
    > t on important alert-worthy events. ### Recommendations 1. **Fix the untagged 83% first.** Audit your OTel collector pipeline and instrumentation to ensure `s
- [WARN] **95%** — percentages are derived; oracle does not gate them
    > e events are likely landing in `empty`. 4. **Set a label-quality SLO**: target ≥95% of log volume carrying a valid `severity_level` tag; currently you are at ~1
- [WARN] **17%** — percentages are derived; oracle does not gate them
    > ≥95% of log volume carrying a valid `severity_level` tag; currently you are at ~17%.

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 2719ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_labels --arg...
exit=0, 3387ms, stdout=844B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_labels --arg...
exit=0, 3352ms, stdout=93B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 7149ms, stdout=1279B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_list_by_label --args ...
exit=0, 3998ms, stdout=920B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 4356ms, stdout=1448B, stderr=0B
