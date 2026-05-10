# Hero scenario: Stability — what services are emitting

**Scenario:** `stability-services-emitting`
**Status:** PASS
**Env:** demo
**Started:** 2026-05-10T12:35:29.452Z
**Duration:** 36.5s
**Bash calls:** 4

## User question

> Which services are actually emitting logs into our metrics pipeline right now? Tell me the count and name the top contributors by volume. If most volume is untagged service, call that out as a labeling issue.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 7 supported · 8 inconclusive
- **Value delivered:** 0.95 — The synthesis directly answers all parts of the user's question: 4 services active, named with volumes, and the (unknown) labeling issue is clearly called out with actionable remediation steps an SRE can immediately act on.
- **Value received:** 0.80 — The services tool returned solid volume/cost data and the discover_labels tool confirmed the tagging gap, but the top_patterns call for (unknown) returned no data, leaving a gap in understanding what logs constitute that 34.9 GB.

## Sub-agent final synthesis

Here is the full picture from the data returned by the tools:

---

## 📊 Services Emitting Logs Into the Metrics Pipeline

**4 distinct service buckets** are active this week, accounting for **34.9 GB total** at **$52/wk**:

| Rank | Service | Volume | % of Total |
|------|---------|--------|------------|
| 1 | **(unknown)** | 34.9 GB | **~100%** |
| 2 | `email` | 11.7 MB | ~0.0% |
| 3 | `frontend` | 54.4 KB | ~0.0% |
| 4 | `recommendation` | 1.2 KB | ~0.0% |

---

## 🚨 Critical Labeling Issue Confirmed

**`(unknown)` dominates at 100% of pipeline volume (34.9 GB / $52/wk)**, yet it does not appear as a named value in the `tenx_user_service` label — that label only lists `email`, `frontend`, and `recommendation`. This means the overwhelming majority of logs are arriving with **no `tenx_user_service` tag set**, falling into the catch-all `(unknown)` bucket.

The three properly-tagged services combined account for **less than 0.1%** of total volume.

---

## Recommendations

1. **Fix service tagging immediately.** Audit your log emitters (agents, SDKs, collectors) for the `tenx_user_service` label. The 34.9 GB `(unknown)` mass must be attributed to real services before any meaningful SLA or cost-per-service analysis is possible.
2. **Identify the source of `(unknown)`.** Run `log10x_cost_drivers({ service: "(unknown)" })` and cross-reference `k8s_namespace` / `k8s_container` labels to reverse-engineer which workloads are sending untagged logs.
3. **Enforce labeling at ingestion.** Add a pipeline validation rule or OTel collector transform that rejects or flags logs missing a `tenx_user_service` value — preventing further unlabeled volume accumulation.
4. **Re-evaluate costs once tagged.** Today's per-service cost breakdown is essentially meaningless; after re-tagging, you'll likely discover one or two dominant noisy services worth targeting for log reduction or exclusion filtering.

## Oracle validation

- Claims found: 15 numeric, 0 pattern names
- Supported by oracle: 7 · Unsupported: 0 · Inconclusive: 8
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [WARN] **$52** — no targeted oracle path for this kind; claim accepted as plausible
    > t service buckets** are active this week, accounting for **34.9 GB total** at **$52/wk**: | Rank | Service | Volume | % of Total | |------|---------|--------|-
- [WARN] **$52** — no targeted oracle path for this kind; claim accepted as plausible
    > Issue Confirmed **`(unknown)` dominates at 100% of pipeline volume (34.9 GB / $52/wk)**, yet it does not appear as a named value in the `tenx_user_service` la
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > Pipeline **4 distinct service buckets** are active this week, accounting for **34.9 GB total** at **$52/wk**: | Rank | Service | Volume | % of Total | |------
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > e | % of Total | |------|---------|--------|------------| | 1 | **(unknown)** | 34.9 GB | **~100%** | | 2 | `email` | 11.7 MB | ~0.0% | | 3 | `frontend` | 54.4
- [OK] **11.7 MB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > -----|------------| | 1 | **(unknown)** | 34.9 GB | **~100%** | | 2 | `email` | 11.7 MB | ~0.0% | | 3 | `frontend` | 54.4 KB | ~0.0% | | 4 | `recommendation` |
- [OK] **54.4 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > ** | 34.9 GB | **~100%** | | 2 | `email` | 11.7 MB | ~0.0% | | 3 | `frontend` | 54.4 KB | ~0.0% | | 4 | `recommendation` | 1.2 KB | ~0.0% | --- ## 🚨 Critical
- [OK] **1.2 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > 11.7 MB | ~0.0% | | 3 | `frontend` | 54.4 KB | ~0.0% | | 4 | `recommendation` | 1.2 KB | ~0.0% | --- ## 🚨 Critical Labeling Issue Confirmed **`(unknown)` do
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > l Labeling Issue Confirmed **`(unknown)` dominates at 100% of pipeline volume (34.9 GB / $52/wk)**, yet it does not appear as a named value in the `tenx_user_s
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > log emitters (agents, SDKs, collectors) for the `tenx_user_service` label. The 34.9 GB `(unknown)` mass must be attributed to real services before any meaningf
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > l | |------|---------|--------|------------| | 1 | **(unknown)** | 34.9 GB | **~100%** | | 2 | `email` | 11.7 MB | ~0.0% | | 3 | `frontend` | 54.4 KB | ~0.0% |
- [WARN] **0.0%** — percentages are derived; oracle does not gate them
    > -------| | 1 | **(unknown)** | 34.9 GB | **~100%** | | 2 | `email` | 11.7 MB | ~0.0% | | 3 | `frontend` | 54.4 KB | ~0.0% | | 4 | `recommendation` | 1.2 KB | ~0
- [WARN] **0.0%** — percentages are derived; oracle does not gate them
    > B | **~100%** | | 2 | `email` | 11.7 MB | ~0.0% | | 3 | `frontend` | 54.4 KB | ~0.0% | | 4 | `recommendation` | 1.2 KB | ~0.0% | --- ## 🚨 Critical Labeling I
- [WARN] **0.0%** — percentages are derived; oracle does not gate them
    > ~0.0% | | 3 | `frontend` | 54.4 KB | ~0.0% | | 4 | `recommendation` | 1.2 KB | ~0.0% | --- ## 🚨 Critical Labeling Issue Confirmed **`(unknown)` dominates at
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > .0% | --- ## 🚨 Critical Labeling Issue Confirmed **`(unknown)` dominates at 100% of pipeline volume (34.9 GB / $52/wk)**, yet it does not appear as a named
- [WARN] **0.1%** — percentages are derived; oracle does not gate them
    > )` bucket. The three properly-tagged services combined account for **less than 0.1%** of total volume. --- ## Recommendations 1. **Fix service tagging immed

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 2769ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 3869ms, stdout=1009B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 3443ms, stdout=927B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_labels --arg...
exit=0, 3085ms, stdout=83B, stderr=0B
