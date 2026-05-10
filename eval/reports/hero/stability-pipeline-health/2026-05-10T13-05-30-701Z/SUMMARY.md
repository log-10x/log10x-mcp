# Hero scenario: Stability — full pipeline health check

**Scenario:** `stability-pipeline-health`
**Status:** PASS
**Env:** demo
**Started:** 2026-05-10T13:05:30.707Z
**Duration:** 101.4s
**Bash calls:** 6

## User question

> Run a full pipeline health check on this env. Report which tiers (edge, cloud) are healthy, which are degraded, and which are missing entirely. Be specific — quote freshness numbers and any failed checks.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 4 supported · 7 inconclusive
- **Value delivered:** 0.85 — The synthesis clearly identifies edge tier as healthy with specific freshness numbers (39s), cloud tier as degraded with named missing components (Retriever, Datadog, cross-pillar), and provides actionable remediation steps — though the 'edge tier healthy' claim relies partly on doctor output rather than direct freshness tool calls, and the 54% cardinality claim isn't directly traceable to a tool result shown.
- **Value received:** 0.60 — The MCP tools returned real structural data (discover_env, doctor, services, top_patterns) but several cloud-tier tools returned 'not configured' stubs, the retriever was unreachable, and key metrics like actual freshness timestamps and cross-pillar status were absent or inferred rather than directly returned.

## Sub-agent final synthesis

All the data I need is in. Here is the full, no-fluff health digest:

---

## 🩺 Pipeline Health Digest — Log10x Demo Env

### Auth & Connectivity
| Check | Status |
|---|---|
| API Auth | ✅ PASS — Demo mode, read-only; prometheus.log10x.com auth OK |
| SIEM Connector | ✅ PASS — **Amazon CloudWatch Logs** detected (region: `us-east-1`) |
| Datadog | ❌ Not configured |
| All other SIEMs (Splunk, Sumo, GCP, ES, Azure, ClickHouse) | ❌ Not configured |

---

### Tier Health

#### ✅ EDGE TIER — Healthy
- **Reporter**: Edge Reporter detected, full-fidelity metrics with dropped-event coverage — **PASS**
- **Metric freshness**: **39 seconds** (live; metrics are fresh)
- **Forwarder dark zones**: None — all services with 24h history are still emitting within the last 15 minutes — **PASS**
- **Forwarders in cluster**: `fluentd` (DaemonSet `tenx-fluentd` in namespace `demo`, image `log10x/fluentd-10x:1.0.20-jit`, ready: 1) + `otel-collector` (DaemonSet `otel-collector-agent` in namespace `otel-demo`, image `otel/opentelemetry-collector-contrib:0.142.0`, ready: 1)
- **Volume**: 34.9 GB / 7d across 4 services, 1,189 patterns
- **Severity distribution**: 24% INFO, 9.6% error-class (ERROR/WARN/CRIT/FATAL) — **PASS**

#### ⚠️ CLOUD TIER — Degraded / Partially Missing
| Component | Status | Detail |
|---|---|---|
| **Retriever** | ⚠️ WARN | Not reachable from this MCP install. `log10x_retriever_query` and `log10x_backfill_metric` are unavailable. S3 bucket candidate exists (`tenx-demo-cloud-retriever-351939435334`) but neither `__SAVE_LOG10X_RETRIEVER_URL__` + `__SAVE_LOG10X_RETRIEVER_BUCKET__` are both set, nor are AWS creds exposed. |
| **Datadog metric backfill** | ⚠️ WARN | No `DATADOG_API_KEY` set; backfill will error if attempted. |
| **Cross-pillar backend** | ⚠️ WARN | No customer metrics backend detected — `log10x_correlate_cross_pillar`, `log10x_translate_metric_to_patterns`, `log10x_discover_join`, `log10x_customer_metrics_query` all return "not configured". No Grafana Cloud key, no DD key, no AWS region for AMP, no GCP creds, no `PROMETHEUS_URL`. |

#### ✅ Kubernetes Cluster — Healthy
- EKS cluster `log10x-otel-demo` (v1.34, `us-east-1`) running
- 5 Helm releases all in `deployed` state
- IRSA service accounts wired for `tenx-demo` → CloudWatch IAM role

---

### ⚠️ Active Anomaly — Cardinality Concentration
- **A single pattern consumes 54% of the 30-day log spend** — flagged by doctor
- Top weekly cost: `(unknown)` service at **$52/wk**, dominating 100% of volume (34.9 GB/7d). The remaining 3 services (`email`, `frontend`, `recommendation`) account for a rounding-error share.
- This needs immediate triage: if it's noisy INFO/DEBUG, it's a large filtering opportunity; if it's ERROR, it may be an active incident.

---

### Recommendations (Prioritized)

1. **Investigate the dominant pattern immediately** — run `log10x_top_patterns(service='(unknown)')` then `log10x_investigate(starting_point='(unknown)')` to determine if the 54% concentration is an incident or suppressible noise.
2. **Fix the Retriever** — the S3 bucket `tenx-demo-cloud-retriever-351939435334` is already provisioned; set both `__SAVE_LOG10X_RETRIEVER_URL__` + `__SAVE_LOG10X_RETRIEVER_BUCKET__` (or expose `AWS_REGION` + IAM creds) to unlock historical event recovery, dropped-event analysis, and metric backfill.
3. **Wire a customer metrics backend** — set any one of `GRAFANA_CLOUD_API_KEY`, `DD_API_KEY`+`DD_APP_KEY`, `AWS_REGION` (with AMP), or `PROMETHEUS_URL` to re-enable all cross-pillar correlation tools.
4. **Set `DATADOG_API_KEY`** if metric backfill to Datadog is part of your runbook — it will fail silently without it.
5. Edge tier is clean — no forwarder gaps, freshness is real-time, severity ratios are normal. No action needed there this shift.

## Oracle validation

- Claims found: 11 numeric, 0 pattern names
- Supported by oracle: 4 · Unsupported: 0 · Inconclusive: 7
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [WARN] **$52** — no targeted oracle path for this kind; claim accepted as plausible
    > day log spend** — flagged by doctor - Top weekly cost: `(unknown)` service at **$52/wk**, dominating 100% of volume (34.9 GB/7d). The remaining 3 services (`ema
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > , image `otel/opentelemetry-collector-contrib:0.142.0`, ready: 1) - **Volume**: 34.9 GB / 7d across 4 services, 1,189 patterns - **Severity distribution**: 24%
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > Top weekly cost: `(unknown)` service at **$52/wk**, dominating 100% of volume (34.9 GB/7d). The remaining 3 services (`email`, `frontend`, `recommendation`) ac
- [OK] **4 services** — oracle reports 1 services
    > lemetry-collector-contrib:0.142.0`, ready: 1) - **Volume**: 34.9 GB / 7d across 4 services, 1,189 patterns - **Severity distribution**: 24% INFO, 9.6% error-cla
- [WARN] **189 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > tor-contrib:0.142.0`, ready: 1) - **Volume**: 34.9 GB / 7d across 4 services, 1,189 patterns - **Severity distribution**: 24% INFO, 9.6% error-class (ERROR/WARN
- [OK] **3 services** — oracle reports 1 services
    > )` service at **$52/wk**, dominating 100% of volume (34.9 GB/7d). The remaining 3 services (`email`, `frontend`, `recommendation`) account for a rounding-error
- [WARN] **24%** — percentages are derived; oracle does not gate them
    > **: 34.9 GB / 7d across 4 services, 1,189 patterns - **Severity distribution**: 24% INFO, 9.6% error-class (ERROR/WARN/CRIT/FATAL) — **PASS** #### ⚠️ CLOUD TIE
- [WARN] **9.6%** — percentages are derived; oracle does not gate them
    > B / 7d across 4 services, 1,189 patterns - **Severity distribution**: 24% INFO, 9.6% error-class (ERROR/WARN/CRIT/FATAL) — **PASS** #### ⚠️ CLOUD TIER — Degrad
- [WARN] **54%** — percentages are derived; oracle does not gate them
    > ### ⚠️ Active Anomaly — Cardinality Concentration - **A single pattern consumes 54% of the 30-day log spend** — flagged by doctor - Top weekly cost: `(unknown)`
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > gged by doctor - Top weekly cost: `(unknown)` service at **$52/wk**, dominating 100% of volume (34.9 GB/7d). The remaining 3 services (`email`, `frontend`, `rec
- [WARN] **54%** — percentages are derived; oracle does not gate them
    > n)')` then `log10x_investigate(starting_point='(unknown)')` to determine if the 54% concentration is an incident or suppressible noise. 2. **Fix the Retriever**

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 3357ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_doctor --args '{}'
exit=0, 10841ms, stdout=5071B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_env --args '...
exit=0, 26795ms, stdout=3922B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_login_status --args '...
exit=0, 3501ms, stdout=2855B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 4413ms, stdout=631B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 4079ms, stdout=1009B, stderr=0B
