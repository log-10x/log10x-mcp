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
