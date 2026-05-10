# Hero scenario: Stability — what services are emitting

**Scenario:** `stability-services-emitting`
**Status:** PASS
**Env:** demo
**Started:** 2026-05-10T03:30:28.244Z
**Duration:** 48.9s
**Bash calls:** 5

## User question

> Which services are actually emitting logs into our metrics pipeline right now? Tell me the count and name the top contributors by volume. If most volume is untagged service, call that out as a labeling issue.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 8 supported · 10 inconclusive
- **Value delivered:** 0.95 — The synthesis directly answers all three parts of the question (count=4, named top contributors with volumes, and explicitly calls out the (unknown) labeling issue as the dominant problem), with concrete actionable remediation steps an SRE can execute immediately.
- **Value received:** 0.80 — The MCP returned the critical services volume breakdown and label discovery data needed to answer the question, but pattern analysis was unavailable ('No pattern data available') and the cost_drivers call for (unknown) didn't return visible output in the transcript, leaving some depth gaps.

## Sub-agent final synthesis

Here is the complete, tool-grounded picture:

---

## Services Emitting Logs — This Week

**4 services detected** in the metrics pipeline:

| Rank | Service | Volume | Share | Cost/wk |
|------|---------|--------|-------|---------|
| 1 | `(unknown)` ⚠️ | **34.9 GB** | **~100%** | $52 |
| 2 | `email` | 11.8 MB | ~0.0% | $0.02 |
| 3 | `frontend` | 56.6 KB | ~0.0% | $0.0001 |
| 4 | `recommendation` | 3.6 KB | ~0.0% | $0.0000 |

**Total pipeline volume: 34.9 GB · $52/week**

---

## 🚨 Critical Labeling Issue

The `(unknown)` bucket — meaning logs with **no `service` tag set at the emitter level** — accounts for effectively **100% of all log volume and cost**. The `tenx_user_service` label, which is the canonical service identifier in this pipeline, only has **3 distinct values** (`email`, `frontend`, `recommendation`), and together those three contribute less than **12 MB** — a rounding error against 34.9 GB.

**What this means operationally:**
- The vast majority of log-producing workloads are **not setting a service label**, making cost attribution, alerting, and SLO tracking impossible on a per-service basis.
- The only reporter name in the pipeline is `tenx-demo`, confirming data is flowing — it's a **tagging gap, not a missing-data problem**.

**Concrete recommendations:**
1. **Audit every log emitter** sending to this pipeline and enforce the `service` (or `tenx_user_service`) label at the SDK/agent level — this is the highest-leverage fix available.
2. **Add a pipeline enrichment rule** (e.g., in the OTel Collector or Fluent Bit) to infer service name from `k8s_namespace`, `k8s_container`, or `k8s_pod` labels — all three are already present and queryable — so unlabeled logs can be retroactively attributed.
3. **Gate CI/CD**: block deployments that don't declare a `service` resource attribute in their OTel config.
4. Once tagging is fixed, re-run `log10x_services` to validate the `(unknown)` bucket collapses and cost is correctly attributed per service.

## Oracle validation

- Claims found: 18 numeric, 0 pattern names
- Supported by oracle: 8 · Unsupported: 0 · Inconclusive: 10
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [WARN] **$52** — no targeted oracle path for this kind; claim accepted as plausible
    > --|--------|-------|---------| | 1 | `(unknown)` ⚠️ | **34.9 GB** | **~100%** | $52 | | 2 | `email` | 11.8 MB | ~0.0% | $0.02 | | 3 | `frontend` | 56.6 KB | ~0.
- [WARN] **$0.02** — no targeted oracle path for this kind; claim accepted as plausible
    > nknown)` ⚠️ | **34.9 GB** | **~100%** | $52 | | 2 | `email` | 11.8 MB | ~0.0% | $0.02 | | 3 | `frontend` | 56.6 KB | ~0.0% | $0.0001 | | 4 | `recommendation` |
- [WARN] **$0.0001** — no targeted oracle path for this kind; claim accepted as plausible
    > | 2 | `email` | 11.8 MB | ~0.0% | $0.02 | | 3 | `frontend` | 56.6 KB | ~0.0% | $0.0001 | | 4 | `recommendation` | 3.6 KB | ~0.0% | $0.0000 | **Total pipeline
- [WARN] **$0.0000** — no targeted oracle path for this kind; claim accepted as plausible
    > ontend` | 56.6 KB | ~0.0% | $0.0001 | | 4 | `recommendation` | 3.6 KB | ~0.0% | $0.0000 | **Total pipeline volume: 34.9 GB · $52/week** --- ## 🚨 Critical La
- [WARN] **$52** — no targeted oracle path for this kind; claim accepted as plausible
    > ecommendation` | 3.6 KB | ~0.0% | $0.0000 | **Total pipeline volume: 34.9 GB · $52/week** --- ## 🚨 Critical Labeling Issue The `(unknown)` bucket — meaning
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > ost/wk | |------|---------|--------|-------|---------| | 1 | `(unknown)` ⚠️ | **34.9 GB** | **~100%** | $52 | | 2 | `email` | 11.8 MB | ~0.0% | $0.02 | | 3 | `f
- [OK] **11.8 MB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > -------| | 1 | `(unknown)` ⚠️ | **34.9 GB** | **~100%** | $52 | | 2 | `email` | 11.8 MB | ~0.0% | $0.02 | | 3 | `frontend` | 56.6 KB | ~0.0% | $0.0001 | | 4 | `
- [OK] **56.6 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > **~100%** | $52 | | 2 | `email` | 11.8 MB | ~0.0% | $0.02 | | 3 | `frontend` | 56.6 KB | ~0.0% | $0.0001 | | 4 | `recommendation` | 3.6 KB | ~0.0% | $0.0000 |
- [OK] **3.6 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > $0.02 | | 3 | `frontend` | 56.6 KB | ~0.0% | $0.0001 | | 4 | `recommendation` | 3.6 KB | ~0.0% | $0.0000 | **Total pipeline volume: 34.9 GB · $52/week** ---
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > | | 4 | `recommendation` | 3.6 KB | ~0.0% | $0.0000 | **Total pipeline volume: 34.9 GB · $52/week** --- ## 🚨 Critical Labeling Issue The `(unknown)` bucket
- [OK] **12 MB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > `frontend`, `recommendation`), and together those three contribute less than **12 MB** — a rounding error against 34.9 GB. **What this means operationally:**
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > together those three contribute less than **12 MB** — a rounding error against 34.9 GB. **What this means operationally:** - The vast majority of log-producin
- [OK] **4 services** — oracle reports 1 services
    > complete, tool-grounded picture: --- ## Services Emitting Logs — This Week **4 services detected** in the metrics pipeline: | Rank | Service | Volume | Shar
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > -|---------|--------|-------|---------| | 1 | `(unknown)` ⚠️ | **34.9 GB** | **~100%** | $52 | | 2 | `email` | 11.8 MB | ~0.0% | $0.02 | | 3 | `frontend` | 56.6
- [WARN] **0.0%** — percentages are derived; oracle does not gate them
    > 1 | `(unknown)` ⚠️ | **34.9 GB** | **~100%** | $52 | | 2 | `email` | 11.8 MB | ~0.0% | $0.02 | | 3 | `frontend` | 56.6 KB | ~0.0% | $0.0001 | | 4 | `recommendat
- [WARN] **0.0%** — percentages are derived; oracle does not gate them
    > | $52 | | 2 | `email` | 11.8 MB | ~0.0% | $0.02 | | 3 | `frontend` | 56.6 KB | ~0.0% | $0.0001 | | 4 | `recommendation` | 3.6 KB | ~0.0% | $0.0000 | **Total pi
- [WARN] **0.0%** — percentages are derived; oracle does not gate them
    > 3 | `frontend` | 56.6 KB | ~0.0% | $0.0001 | | 4 | `recommendation` | 3.6 KB | ~0.0% | $0.0000 | **Total pipeline volume: 34.9 GB · $52/week** --- ## 🚨 Crit
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > with **no `service` tag set at the emitter level** — accounts for effectively **100% of all log volume and cost**. The `tenx_user_service` label, which is the c

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 2744ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 4003ms, stdout=1009B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_labels --arg...
exit=0, 3530ms, stdout=927B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_labels --arg...
exit=0, 3140ms, stdout=83B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 3338ms, stdout=142B, stderr=0B
