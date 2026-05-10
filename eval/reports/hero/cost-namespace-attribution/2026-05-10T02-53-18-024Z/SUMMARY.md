# Hero scenario: Cost — attribute by namespace

**Scenario:** `cost-namespace-attribution`
**Status:** PASS
**Env:** demo
**Started:** 2026-05-10T02:53:18.029Z
**Duration:** 73.9s
**Bash calls:** 8

## User question

> Which Kubernetes namespace is generating the most log volume? Break down the top 3 namespaces by 24h volume. Be honest about labeling quality if it's a problem.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 11 supported · 9 inconclusive
- **Value delivered:** 0.85 — The agent honestly reported the labeling problem, provided all available namespace data, cross-referenced with tenx_app to give partial volume breakdown, and gave concrete actionable remediation steps—an SRE can act on this immediately.
- **Value received:** 0.70 — MCP returned real volume numbers and label breakdowns, but the k8s_namespace dimension was nearly entirely empty (100% unlabeled), limiting the tool's ability to answer the actual question; the tenx_app and tenx_user_service data partially compensated.

## Sub-agent final synthesis

Here is a rigorous, tool-grounded answer:

---

## Kubernetes Namespace Volume Breakdown — Last 24h

### 🚨 Labeling Quality Is the Real Story

| `k8s_namespace` | 24h Volume | Share | Cost/wk |
|---|---|---|---|
| **(empty — no label)** | ~34.9 GB | **~100%** | $52/wk |
| `otel-demo` | 11.8 MB | ~0.03% | $0.02/wk |

There is **no meaningful top-3 namespace breakdown to give you.** The data returned only 2 distinct values for `k8s_namespace`, and **virtually all volume (~34.9 GB / ~100%) carries an empty namespace label**. Only a tiny sliver — 11.8 MB — is properly tagged as `otel-demo`.

---

### What's Actually Happening Under the Hood

Even though `k8s_namespace` is enriched and queryable, the enrichment is not firing for the bulk of traffic. Cross-referencing with `tenx_app`, the unlabeled volume breaks down as:

| `tenx_app` | Volume | Cost/wk |
|---|---|---|
| `receiver` | 18.2 GB | $27/wk |
| `reducer` | 16.7 GB | $25/wk |

And by `tenx_user_service`, only `email` (11.8 MB), `frontend` (56.6 KB), and `recommendation` (3.6 KB) have service labels — together they are a rounding error against the 34.9 GB unlabeled mass.

The top cost patterns are all **OTel Collector internals** (opensearch exporter, batch processor, ConsumeLogsFunc) — collector self-telemetry flowing through the `receiver` and `reducer` pipeline apps, with no pod/namespace context attached.

---

### Concrete Recommendations

1. **Fix k8s_namespace enrichment immediately.** ~100% of volume is untagged. Without this, namespace-based cost attribution is impossible. Verify the OTel Collector's `k8sattributes` processor is deployed and has RBAC access to list pods.
2. **Investigate the `(empty)` service bucket** — 34.9 GB/week ($52/wk) of OTel Collector self-telemetry (opensearch exporter, batch processor, consumer loops) has no team ownership. Run `log10x_investigate` on the unlabeled bucket to confirm the source.
3. **Tag at the collector level** if pod enrichment can't be fixed quickly: add static resource attributes (`k8s.namespace.name`, `service.name`) to the collector's own telemetry config as a stopgap.
4. Once labels are fixed, re-run this query — the `receiver` and `reducer` apps (the two pipeline stages) will likely surface as the dominant cost namespaces.

## Oracle validation

- Claims found: 20 numeric, 0 pattern names
- Supported by oracle: 11 · Unsupported: 0 · Inconclusive: 9
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [WARN] **$52** — no targeted oracle path for this kind; claim accepted as plausible
    > | Cost/wk | |---|---|---|---| | **(empty — no label)** | ~34.9 GB | **~100%** | $52/wk | | `otel-demo` | 11.8 MB | ~0.03% | $0.02/wk | There is **no meaningful
- [WARN] **$0.02** — no targeted oracle path for this kind; claim accepted as plausible
    > o label)** | ~34.9 GB | **~100%** | $52/wk | | `otel-demo` | 11.8 MB | ~0.03% | $0.02/wk | There is **no meaningful top-3 namespace breakdown to give you.** Th
- [WARN] **$27** — no targeted oracle path for this kind; claim accepted as plausible
    > n as: | `tenx_app` | Volume | Cost/wk | |---|---|---| | `receiver` | 18.2 GB | $27/wk | | `reducer` | 16.7 GB | $25/wk | And by `tenx_user_service`, only `ema
- [WARN] **$25** — no targeted oracle path for this kind; claim accepted as plausible
    > st/wk | |---|---|---| | `receiver` | 18.2 GB | $27/wk | | `reducer` | 16.7 GB | $25/wk | And by `tenx_user_service`, only `email` (11.8 MB), `frontend` (56.6 K
- [WARN] **$52** — no targeted oracle path for this kind; claim accepted as plausible
    > s to list pods. 2. **Investigate the `(empty)` service bucket** — 34.9 GB/week ($52/wk) of OTel Collector self-telemetry (opensearch exporter, batch processor,
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > | 24h Volume | Share | Cost/wk | |---|---|---|---| | **(empty — no label)** | ~34.9 GB | **~100%** | $52/wk | | `otel-demo` | 11.8 MB | ~0.03% | $0.02/wk | Th
- [OK] **11.8 MB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > ---| | **(empty — no label)** | ~34.9 GB | **~100%** | $52/wk | | `otel-demo` | 11.8 MB | ~0.03% | $0.02/wk | There is **no meaningful top-3 namespace breakdow
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > turned only 2 distinct values for `k8s_namespace`, and **virtually all volume (~34.9 GB / ~100%) carries an empty namespace label**. Only a tiny sliver — 11.8 M
- [OK] **11.8 MB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > ume (~34.9 GB / ~100%) carries an empty namespace label**. Only a tiny sliver — 11.8 MB — is properly tagged as `otel-demo`. --- ### What's Actually Happening
- [OK] **18.2 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > breaks down as: | `tenx_app` | Volume | Cost/wk | |---|---|---| | `receiver` | 18.2 GB | $27/wk | | `reducer` | 16.7 GB | $25/wk | And by `tenx_user_service`,
- [OK] **16.7 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > olume | Cost/wk | |---|---|---| | `receiver` | 18.2 GB | $27/wk | | `reducer` | 16.7 GB | $25/wk | And by `tenx_user_service`, only `email` (11.8 MB), `fronten
- [OK] **11.8 MB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > k | | `reducer` | 16.7 GB | $25/wk | And by `tenx_user_service`, only `email` (11.8 MB), `frontend` (56.6 KB), and `recommendation` (3.6 KB) have service label
- [OK] **56.6 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > GB | $25/wk | And by `tenx_user_service`, only `email` (11.8 MB), `frontend` (56.6 KB), and `recommendation` (3.6 KB) have service labels — together they are
- [OK] **3.6 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > r_service`, only `email` (11.8 MB), `frontend` (56.6 KB), and `recommendation` (3.6 KB) have service labels — together they are a rounding error against the 34.
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > ` (3.6 KB) have service labels — together they are a rounding error against the 34.9 GB unlabeled mass. The top cost patterns are all **OTel Collector internal
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > has RBAC access to list pods. 2. **Investigate the `(empty)` service bucket** — 34.9 GB/week ($52/wk) of OTel Collector self-telemetry (opensearch exporter, bat
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > | Share | Cost/wk | |---|---|---|---| | **(empty — no label)** | ~34.9 GB | **~100%** | $52/wk | | `otel-demo` | 11.8 MB | ~0.03% | $0.02/wk | There is **no m
- [WARN] **0.03%** — percentages are derived; oracle does not gate them
    > mpty — no label)** | ~34.9 GB | **~100%** | $52/wk | | `otel-demo` | 11.8 MB | ~0.03% | $0.02/wk | There is **no meaningful top-3 namespace breakdown to give y
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > 2 distinct values for `k8s_namespace`, and **virtually all volume (~34.9 GB / ~100%) carries an empty namespace label**. Only a tiny sliver — 11.8 MB — is prop
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > ### Concrete Recommendations 1. **Fix k8s_namespace enrichment immediately.** ~100% of volume is untagged. Without this, namespace-based cost attribution is im

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 2773ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_labels --arg...
exit=0, 3073ms, stdout=844B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 6079ms, stdout=1279B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_list_by_label --args ...
exit=0, 3734ms, stdout=643B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_list_by_label --args ...
exit=0, 6906ms, stdout=697B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_list_by_label --args ...
exit=0, 7400ms, stdout=1405B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=1, 2733ms, stdout=343B, stderr=0B

### 8. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 3764ms, stdout=1449B, stderr=0B
