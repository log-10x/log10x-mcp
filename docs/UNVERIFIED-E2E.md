# Unverified end-to-end claims — work list

What I claimed but did NOT prove with hard data. Working through one
at a time; nothing moves to "verified" until I have a captured artifact
showing the live system doing the thing. If I'm blocked on
creds/auth, the item stays open with the specific block noted.

## Open items

### 1. Grafana Cloud Prom — **CLOSED with FULL ROUNDTRIP against real `*.grafana.net` SaaS**

**Update 2026-05-14**: previous closure (against a local
`nginx-basic-e2e` proxy fronting in-cluster Mimir) only proved the
Basic-auth code path. Re-verified end-to-end against the real
Grafana Cloud SaaS endpoint.

**Setup**:
- Real GC stack `prometheus-prod-56-prod-us-east-2.grafana.net`,
  org `1767547`, stack `1642272`.
- Access policy `claude-claude3` with both `metrics:write` +
  `metrics:read` scopes; token used for both engine write and
  MCP read (one token, both directions).
- Engine `tenx-fluentd` daemonset patched: added `GC_USER` +
  `GC_TOKEN` env vars (from secret `gc-creds-e2e`), receiver
  override configmap `receiver-config-gc` switched to include
  `run/output/metric/prometheus/remote-write` with
  `prometheusRW: [{host: https://…/api/prom/push, user:
  $=TenXEnv.get("GC_USER"), password: $=TenXEnv.get("GC_TOKEN")}]`.

**Engine WRITE — hard data**:
- Engine log line confirms target:
  `📈 Publishing TenXSummary metrics to Prometheus RW host:
   https://prometheus-prod-56-prod-us-east-2.grafana.net/api/prom/push`
- Direct curl to GC read API:
  ```
  GET /api/prom/api/v1/label/__name__/values
  → ["all_events_summaryBytes_total", "all_events_summaryVolume_total",
     "emitted_events_optimized_size_total",
     "emitted_events_summaryBytes_total",
     "emitted_events_summaryVolume_total"]
  GET /api/prom/api/v1/query?query=count(all_events_summaryBytes_total)
  → 133 series
  GET /api/prom/api/v1/query?query=group by(tenx_user_service)(all_events_summaryBytes_total)
  → 16 services (accounting, ad, cart, email, emitter, kafka,
     opentelemetry-collector, payment, product-reviews, ...)
  ```

**MCP READ — hard data via `kind: 'grafana_cloud_prom'`**:
- Direct invocation against the real GC endpoint
  (`https://prometheus-prod-56-prod-us-east-2.grafana.net/api/prom`)
  with `${GC_USER}` + `${GC_TOKEN}` env-var refs.
- `executeServices(15m)`:
  ```
  Monitored Services (last 15m)
    opentelemetry-collector  9.5 MB     86%  $0.0093/15m
    payment                  572.7 KB    5%  $0.0005/15m
    emitter                  399.1 KB    4%  $0.0004/15m
    kafka                    158.1 KB    1%  $0.0002/15m
    cart                     126.4 KB    1%  $0.0001/15m
    … 16 services · 11.1 MB total · $0.01/15m
    Top 3 services = 95% of volume.
  ```
- `executeTopPatterns(15m, limit 10, analyzerCost: 1.0)`:
  ```
  Top 10 patterns — all services (last 15m) · $0.0060/15m total
   #1  service_instance_id_..._otelcol_contrib_..._otelcol $0.0010/15m  ERROR  opentelemetry-collector
   #2  open_telemetry_opentelemetry_collector_contrib_exporter_opensearchexporter $0.0009/15m
   #3  opentelemetry_io_collector_processor_batchprocessor_v_batch_processor_go $0.0009/15m
   #4  (no-symbol)                       $0.0008/15m         opentelemetry-collector
   …
   #9  (no-symbol)                       $0.0003/15m         payment
   Top 10 = 42% of total volume in scope.
   ⚡ Newly-emerged patterns surfaced with rates (4.033 events/s, etc.)
  ```

Wire protocol, auth, write path, read path, MCP rendering — every
hop verified against real Grafana Cloud SaaS. Previous "code-path
only" caveat retired.

Note: a separate `executeTopPatterns` bug surfaced — the tool
doesn't default `args.analyzerCost`, so without an explicit cost
it returns `$NaN/15m`. Not GC-specific; affects every backend.
Tracked separately.

### 2. AMP via MCP's direct `kind: 'amp'` adapter — **CLOSED**

Root cause: `awsUriEncode` in `customer-metrics.ts` used
`encodeURIComponent` which doesn't encode `( ) ' * !` — AWS SigV4
requires them encoded. Every PromQL query with parens (i.e. every
real MCP query: `topk(...)`, `sum by (...)`, `increase(...[15m])`)
produced a canonical-string mismatch → 403.

Fix: replace `encodeURIComponent`-based encoder with manual
byte-wise UTF-8 RFC 3986 encoder.

After fix: MCP `kind: 'amp'` with ambient AWS creds returned
populated `top_patterns` (14 services, 18.4 MB total) from the
real AMP workspace, no proxy needed.

### 3. Cortex — full roundtrip — **CLOSED**

Deployed `cortexproject/cortex:v1.18.1` in single-binary mode,
auth_enabled=false (writes land in default tenant `fake`).
- Engine wrote via prom-RW; `count(all_events_summaryBytes_total)`
  returned non-zero in Cortex
- MCP `kind: 'cortex'` with `X-Scope-OrgID: fake` rendered top
  patterns + 7 services from real engine data

### 4. GCP Managed Prom — **PARTIAL: read works, write blocked on engine support**

**IAM unblocked** (user granted `monitoring.viewer` and
`monitoring.metricWriter` to the SA, enabled the Monitoring API on
project `log10x-poc`). Read path verified end-to-end:
- Direct curl with SA's OAuth2 Bearer to
  `monitoring.googleapis.com/v1/projects/log10x-poc/location/global/prometheus/api/v1/labels`
  returned a populated label list.

**Write path: HARD BLOCK at the protocol level, not at auth.**
- Engine `prometheusRW` configured with `host: …/prometheus/api/v1/write`
  and `token: ${GCP_OAUTH_TOKEN}` (1h SA token).
- Engine startup log shows `📈 Publishing TenXSummary metrics to Prometheus RW host: https://monitoring.googleapis.com/…`.
- Every write attempt: **HTTP 404** with Google's generic 404 page.
  Tried four path variants — all 404.

**Root cause** (from Google's own docs):

> "For the fully Prometheus-compatible binary that writes ingested
>  data into GMP/GCM, see GoogleCloudPlatform/prometheus."
>
> "Google Cloud never directly accesses your cluster to pull or
>  scrape metric data; your collectors push to Google Cloud."

GMP does NOT accept standard Prometheus remote_write. Google
maintains a Prometheus FORK
(`GoogleCloudPlatform/prometheus`) that translates from standard
remote_write to GMP's proprietary Monarch ingestion protocol. The
public-facing `/api/v1/write` URL on `monitoring.googleapis.com`
simply doesn't exist.

**Closing this requires real engine-side work**:
- Option A: deploy Google's prometheus fork as an in-cluster relay
  (engine→fork→GMP)
- Option B: add a GMP-specific output module to the 10x engine
  using Monarch's `CreateTimeSeries` API
- Option C: route via OTel Collector with the GCP exporter

Same architectural shape as the Datadog gap (Item 5): MCP read is
straightforward (Prometheus-compatible API + OAuth2 Bearer);
engine WRITE requires a custom translator/relay. Not the simple
"OAuth2 sidecar" I initially assumed.

**Hard evidence captured**:
- SA can read GMP: `curl ... /labels` returned populated list
- Engine's prom-RW config + token integration WORKS — the 404 is
  on the GMP side, not the engine side
- Confirmed 4 URL variants all return 404
- Google docs explicitly say standard remote_write isn't supported

### 5. Datadog MCP read path — **CLOSED with FULL ROUNDTRIP**

**Update** (after closing the "no PromQL endpoint" finding):
implemented PromQL→Datadog query translator using vendored
`guychouk/promql-parser` (MIT) and now have end-to-end working
Datadog reads with real engine data.

What ships:
- `vendor/promql-parser/` — vendored PEG.js parser (90KB) + grammar
- `src/lib/promql-to-datadog.ts` — translator targeting the closed
  set of query shapes the MCP issues (~10 distinct templates).
  Handles: `topk(N, INNER)`, `sort_desc/sort(INNER)`,
  `count(INNER > 0)`, `sum/avg/min/max by (labels) (func(M[range]))`,
  `group by (labels) (M{filters})`, bare metric/matrix selectors.
- `DatadogBackend` rewired: translates PromQL via the translator,
  POSTs to `/api/v1/query` with native DD syntax, reshapes
  Datadog's time-series response back into Prometheus envelope
  (sums pointlist values to recover `increase()` semantics).

Key translator details:
- Pre-processes `topk(N, ...)` before the parser (the vendored
  PEG.js grammar can't parse multi-arg function calls reliably)
- Strips `_total` suffix from metric names (Datadog convention —
  `all_events_summaryBytes_total` → `all_events_summaryBytes`)
- `by {labels}` clause goes BEFORE `.as_count()` suffix (Datadog
  syntax requirement; opposite of intuitive ordering)
- Implements `count(EXPR > 0)` → `count_not_null(EXPR)` collapse

Hard evidence:
- Live MCP `kind: 'datadog'` against us5 with engine writes:
  ```
  Top 5 patterns — all services (last 15m) · $0.0047/15m total
  #1  service_instance_id_..._otelcol_..._version_otelcol  $0.0011/15m  ERROR  opentelemetry-collector
  #2  open_telemetry_opentelemetry_collector_contrib_exporter_opensearchexporter  $0.0011/15m
  #3  opentelemetry_io_collector_processor_batchprocessor_v_batch_processor_go  $0.0010/15m
  …
  ```
- `log10x_services` against DD: 17 services, 16.2 MB total
- Translator unit tests: 6/6 query templates pass byte-exact

Limitations documented:
- `customer_metrics_query` user-supplied PromQL would need full
  PromQL coverage — the translator targets the MCP's specific
  shapes only. The escape-hatch tool needs explicit "PromQL subset"
  caveat in its docstring.
- `count_values`, `quantile`, `histogram_quantile`, `without` clause —
  not supported; surface translation errors.

Previously documented Datadog gap is now resolved. The
`DatadogPromBackend` in `customer-metrics.ts` (cross-pillar layer)
is still using the old "send raw PromQL to /api/v1/query" approach
that doesn't work — needs the same translator wired in.

---

### 5a. Datadog — original investigation (kept for context)

**Endpoints probed** (all with real DD_API_KEY + DD_APP_KEY against
`api.us5.datadoghq.com`):

| Endpoint | PromQL result | Native DD syntax result |
|---|---|---|
| `GET /api/v1/query` | parse error: `Rule 'scope_expr' didn't match` | works |
| `POST /api/v2/query/scalar` | same parse error | works (returned 3,616,687) |
| `POST /api/v2/query/timeseries` | same parse error | works (returned populated top-N) |
| `GET /api/beta/scalar` | 404 | n/a |
| `GET /api/v1/prom` | 404 | n/a |
| `GET /api/v1/prometheus/query` | 404 | n/a |
| `GET /api/v1/query/prometheus` | 404 | n/a |
| `GET /api/v2/series` | 404 | n/a |
| `GET /api/v2/prom/query` | 404 | n/a |

**Conclusion**: Datadog has no PromQL-accepting read endpoint
today. The "Prometheus compatibility" feature in Datadog docs
refers to **ingest** (their Agent scraping Prom endpoints, and
remote_write into DD's metrics submission API) — not to a
PromQL-compatible read API.

**Bug in existing code**: `DatadogPromBackend` in
`src/lib/customer-metrics.ts` claims to query at `/api/v1/query`
with PromQL. It does not work against real Datadog. The class
needs to be either deleted or rewritten as a PromQL→DD-syntax
translator. Same issue applies to my new
`DatadogBackend` in `src/lib/metrics-backend.ts`.

**Path forward**: implement a PromQL→DD translator (Tier 3) OR
remove `kind: 'datadog'` from the supported list with explicit
docs. Engine WRITE to Datadog works (verified earlier — 5 metric
names ingested), so customers can still write metrics there; they
just can't use MCP to read them.

### 6. `(no-symbol)` provenance — **CLOSED**

Engine config (verified in pod):
- `apps/receiver/config.yaml` includes `run/initialize/message`
- `pipelines/run/initialize/message/config.yaml` sets
  `messageField: message_pattern`, `contexts: log,exec`

Live cluster Prom (in-cluster Cortex with 3 empty-message_pattern
series): `payment`, `valkey-cart`, `opentelemetry-collector`.

Raw container logs for each (read via `kubectl exec`):
- `payment` — multi-line JSON debug output starting with bare `{` lines (no symbol context)
- `valkey-cart` — Valkey banner like `1:M 13 May 2026 ... oO0OoO0OoO0Oo Valkey is starting` (no package paths)
- `opentelemetry-collector` — events without `go-package/file.go:line` structure (events WITH that pattern get populated)

Negative control: `cart` raw logs (`info: cart.cartstore.ValkeyCartStore[0]`) DO contain a recognizable class path → cart has populated `message_pattern` (verified via separate query).

Chain confirmed: `(no-symbol)` = engine's symbol-lookup found no match in the log text. Not assumed; verified per-service.

## Status
Last updated: starting work-through now. Each item gets its own
section update with the captured evidence (or block reason) before
moving to the next.

---

## Phase-1 expansion: 4 new metric-side adapters built + E2E'd (2026-05-14)

After Items 1–6 closed, the user mandated expanding TSDB coverage
beyond the original 6 backends. Per `docs/BACKEND-COVERAGE-PLAN.md`,
Phase 1 added four more MCP read adapters, each E2E'd with hard
data and verified by an independent sub-agent auditor.

### 7. CloudWatch Metrics — `kind: 'cloudwatch_metrics'` — **CLOSED (read)**

- Adapter: wraps `@aws-sdk/client-cloudwatch` `GetMetricData` + `ListMetrics`. Accepts a closed PromQL subset (`count(metric)`, bare selectors with `=` filters); throws on unsupported shapes.
- Hard data: planted 4 dim combos in real AWS account `351939435334` namespace `Log10x/E2E` via PutMetricData; MCP adapter returned all 4 byte-exact (1234, 567, 2345, 89). Plus listLabels/listLabelValues working on real CW state.
- Evidence: `docs/evidence/cw-metrics/`
- **Engine→CW write GAP**: the dev image `ghcr.io/log-10x/pipeline-10x-dev:fluentd-tmp-k8` fails to bind `$cloudwatchNamespace` from the `cloudwatch[]` YAML override. Three YAML variants tried; all hit the same error. Captured in `06-engine-failure-prev.txt`.

### 8. Elasticsearch Metrics — `kind: 'elastic_metrics'` — **CLOSED (read)**

- Adapter: reads docs in the Micrometer-ES schema (`@timestamp` + `name` + `type` + tag fields + `count|value`) from rolling `micrometer-metrics-YYYY-MM` indices. Basic + ApiKey auth.
- Hard data: Docker ES 9.1.0 single-node; bulk-indexed 4 docs in the Micrometer-ES shape; MCP adapter returned all 4 byte-exact (1234, 567, 2345, 89). count() = "8" (4 docs × 2 seedings) matches direct ES `match_all` total.
- Evidence: `docs/evidence/elastic-metrics/`
- Engine→ES write untested.

### 9. OpenSearch Metrics — `kind: 'opensearch_metrics'` — **CLOSED (read)**

- Adapter: subclasses `ElasticMetricsBackend` (OS shares the `_search` + `_bulk` wire protocol). Separate kind discriminator so logs/config say "opensearch" instead of "elastic".
- Hard data: Docker OS 2.19.5 (port 9201 to avoid ES conflict); same 4 docs planted; MCP adapter returned byte-exact.
- Evidence: `docs/evidence/opensearch-metrics/`

### 10. GCP Managed Prometheus — `kind: 'gcp_managed_prom'` — **CLOSED (read; Phase-1 stub now real)**

- Adapter: replaces the previous stub that threw on every call. OAuth2 Bearer auth via JWT-bearer flow using Node `crypto.createSign('RSA-SHA256')` (no external Google SDK dep). Token cached with 60s refresh-before-expiry margin. Standard Prometheus PromQL API proxied to GMP's `monitoring.googleapis.com/v1/projects/.../prometheus` endpoint.
- Hard data: real GCP project `log10x-poc` + SA `log10x-poc-reader`. Baseline 2727 labels / 17428 names. Planted a CUMULATIVE metric `prometheus.googleapis.com/log10x_test_planted/counter` with labels `{tenx_user_service: cart, message_pattern: p_planted_ok}` via Cloud Monitoring v3 timeSeries API. Adapter post-plant returned 2729 labels / 17429 names — delta +2 labels / +1 metric name matches what was planted exactly.
- GMP-specific behavior surfaces correctly: `=~` on `__name__` errors out with real GMP error message.
- Evidence: `docs/evidence/gmp-metrics/`
- **Engine→GMP write remains blocked at Item 4** (this entry covers READ only).

---

## Adapter coverage summary as of 2026-05-14

**Marketplace vendors with full hard-data roundtrip via MCP**:
1. Datadog (real us5; Item 5)
2. Grafana Cloud Prom (real `*.grafana.net`; Item 1)
3. CloudWatch Metrics (real AWS; Item 7, read-side only)
4. Elasticsearch (Docker; Item 8, read-side only)
5. OpenSearch (Docker; Item 9, read-side only)
6. GCP Managed Prometheus (real `log10x-poc`; Item 10, read-side only)

**Non-marketplace TSDBs proven (prom-RW family)**:
- Prometheus, Mimir, Cortex, AMP (Items 2, 3, and the earlier evidence doc)

**Engine-side gaps logged for follow-up**:
- Engine→CW Micrometer module config-binding (Item 7 details)
- Engine→GMP protocol gap (Item 4 details)
- Engine→ES/OS Micrometer module status untested

**Marketplace vendors awaiting trial creds** (Phase 2):
- Splunk Observability (SignalFx)
- New Relic
- Dynatrace
- Coralogix
- Logz.io

**Marketplace vendor with siem-poc creds but TSDB-side deferred**:
- Azure (5-day SP clock; LogAnalytics scope verified; engine has no Azure Monitor output module so TSDB-side is engine-blocked even with scope)
- Sumo Logic (creds live; collector may need rebuild)

---

## Phase-1.6: log-side POC E2E against 8 SIEMs (2026-05-14 / 02:23–02:47 UTC)

The `log10x_poc_from_siem` tool already had per-SIEM connectors in
`src/lib/siem/*.ts` from PR #41. This phase verified each connector
end-to-end against the live infrastructure listed in
`~/siem-poc-credentials.md`. For each SIEM: re-shipped 5000 events
from `config/data/otel-sample-200mb.log` (where data had aged
out), ran `scripts/run-poc.mjs`, captured the report. Evidence
lives in `docs/evidence/log-poc-<siem>/`.

Driver bug fixed mid-flight: `scripts/run-poc.mjs` never broke out
of its polling loop when the status emitted `## POC — done.` (the
loop only matched two older heading formats). One commit adds the
missing match.

### Result matrix

| SIEM | events analyzed | annual cost (extrapolated to 100 GB/day) | annual savings | notes |
|---|---:|---:|---:|---|
| Datadog us5 | 5 | $2.2M | 100% | data trial-aged-out; re-ship + scope='*' surfaces real events |
| ClickHouse Cloud | 5000 | $183 | 91% ($166) | service `dpq5h4e2b4` alive; needed `--ch-msg body --ch-ts timestamp` |
| Sumo Logic | 0 | n/a | n/a | **connector requires `_sourceCategory` filter**; HTTP source has none — see below |
| Azure Monitor / Log Analytics | 5000 | $2.8K | 91% ($2.5K) | workspace `38093120-…` + table `log10xPoc_CL` |
| GCP Cloud Logging | 217 | $438K | 58% ($256K) | log10x-poc-otel log in `log10x-poc` |
| CloudWatch Logs | 53 | $438K | 97% ($426K) | recreated log group `/log10x/poc-test-otel` |
| Elasticsearch (Docker 9.1.0) | 55 | $876K | 97% ($849K) | local container `log10x-poc-es` |
| Splunk (Docker `splunk/splunk:latest`) | 55 | $5.3M | 97% ($5.1M) | container `log10x-poc-splunk` |

**7 of 8 SIEMs produced rendered reports with hard data.** Every "events analyzed > 0" run also produced a top-N pattern table with per-pattern projected savings.

### Sumo connector gap (documented, not closed)

`src/lib/siem/sumo.ts:106` composes the query as `_sourceCategory=<scope>` plus any `--query` filter. The HTTP source used in this POC has no source category attached (the credentials file even notes this: "Sumo assigned default; our Source Category field was empty on the HTTP source"). Result: queries return 0 events even though direct search-job API confirms 394 messages indexed in the last 2h.

Not a tool bug — the connector design assumes Sumo HTTP sources have a populated `_sourceCategory`. Fix path is either: (a) attach `X-Sumo-Category` header in the ship-to-sumo.mjs script, or (b) widen the connector to fall back to `query=*` when scope is omitted. Tracked here for follow-up.

### MCP-tool versus connector layering

This phase confirms the LOG-SIDE adapters (`src/lib/siem/*.ts`) are healthy. The METRIC-SIDE adapters (`src/lib/metrics-backend.ts`) closed in Items 7–10 are a separate layer. Both layers now have hard-data E2E evidence; both share the same authentication codebase for the SIEMs that overlap (Azure, GCP, AWS, ES/OS, Splunk-via-Docker).
