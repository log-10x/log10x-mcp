# E2E evidence — engine writes, MCP reads, MCP reasons

Per-backend hard evidence captured 2026-05-14 using the **otel-demo
EKS cluster's deployed 10x forwarder** (daemonset `tenx-fluentd` in
namespace `demo`, image `ghcr.io/log-10x/pipeline-10x-dev:fluentd-tmp-k8`,
engine v1.0.23) modified to publish metrics to multiple TSDB
backends simultaneously, with the MCP querying each backend via its
new `MetricsBackend` adapter.

## Setup

Daemonset patched to add metric outputs alongside the original
`log10x` output. Receiver app `include:` list amended via configmap
overlay:

```yaml
include:
  - run/output/metric/log10x
  - run/output/metric/datadog          # NEW
  - run/output/metric/prometheus/remote-write  # NEW (3 targets)
```

The engine's startup line confirms five metric registries active:

```
metricOutput(Log10xMetricRegistryFactory) =>
metricOutput(DataDogMetricRegistryFactory) =>
metricOutput(PrometheusRWMetricRegistryFactory) =>      # → in-cluster Prom
metricOutput(PrometheusRWMetricRegistryFactory) =>      # → in-cluster Mimir
metricOutput(PrometheusRWMetricRegistryFactory)         # → AMP via sigv4-proxy
```

```
📈 Publishing TenXSummary metrics to the log10x backend
📈 Publishing TenXSummary metrics to Datadog: https://us5.datadoghq.com
📈 Publishing TenXSummary metrics to Prometheus RW host: http://prom-e2e.demo.svc.cluster.local:9090/api/v1/write
📈 Publishing TenXSummary metrics to Prometheus RW host: http://mimir-e2e.demo.svc.cluster.local:9009/api/v1/push
📈 Publishing TenXSummary metrics to Prometheus RW host: http://sigv4-proxy-e2e.demo.svc.cluster.local:8080/workspaces/ws-fcd1adc8-…/api/v1/remote_write
```

## Per-backend results

### `prometheus` — full roundtrip ✓

- **Backend instance**: in-cluster Prom deployment `prom-e2e` (image
  `prom/prometheus:v2.55.0`, remote-write receiver enabled).
- **Engine wrote**: confirmed via direct API query:
  ```
  $ curl ".../api/v1/query?query=count(all_events_summaryBytes_total)"
  → series count: 90
  $ curl ".../group by(tenx_user_service)(all_events_summaryBytes_total)"
  → 8 services: ad, cart, emitter, kafka, llm, opentelemetry-collector,
    product-reviews, recommendation
  ```
- **MCP read + reason**: `LOG10X_METRICS_BACKEND_KIND=prometheus`,
  `LOG10X_METRICS_URL=http://localhost:19090` (port-forwarded).
  `executeTopPatterns({ timeRange: '15m', limit: 10 })` returned a
  fully-populated table with the OTel collector patterns at the top,
  severity_level=ERROR/DEBUG visible, newly-emerged probe firing at
  ~1 event/s, `(no-symbol)` guardrail rendered with the
  "don't speculate" footer, and Next-actions correctly picked the top
  ACTIVE row (not stale, not no-symbol).
- **`executeServices`** returned 8 services with byte volumes,
  percentages, and dollar costs summing to 3.7 MB at $1/GB =
  $0.0036/15m.

### `mimir` — full roundtrip ✓

- **Backend instance**: in-cluster Mimir deployment `mimir-e2e`
  (image `grafana/mimir:2.13.0`, single-tenant, filesystem storage).
- **Engine wrote**: a second `prometheusRW` entry on the daemonset
  with `host: http://mimir-e2e.demo.svc.cluster.local:9009/api/v1/push`.
  Confirmed in Mimir's read endpoint:
  ```
  group by(tenx_user_service) → 4 services then growing to 10
  ```
- **MCP read + reason**: `LOG10X_METRICS_BACKEND_KIND=mimir`,
  URL pointing at the Mimir read endpoint (port-forwarded).
  `executeTopPatterns` and `executeServices` rendered populated
  output with the same patterns + 10 distinct services
  (opentelemetry-collector, payment, emitter, product-reviews, cart,
  llm, ad, kafka, accounting, email).

### `grafana_cloud_prom` (Basic-auth shape) — full roundtrip ✓

- **Backend instance**: `nginx-basic-e2e` reverse-proxy in front of
  the same `prom-e2e` Prometheus, configured with bcrypt htpasswd
  (user `acme`, password `trial`).
- **MCP read + reason**: `LOG10X_METRICS_BACKEND_KIND=grafana_cloud_prom`,
  user `acme`, apiKey `trial`. The new `GrafanaCloudBackend` adapter
  was implemented (previously a phase-1 stub) to subclass
  `PrometheusBackend` with Basic auth from user+apiKey. MCP
  successfully authenticated through nginx and rendered top_patterns
  with engine data.
- This verifies the **Basic-auth code path** end-to-end. Real
  Grafana Cloud uses the same wire protocol (Basic auth with
  instance_id:apikey).

### `amp` — full roundtrip ✓

- **Backend instance**: AWS Managed Prometheus workspace
  `ws-fcd1adc8-5528-4898-9858-ca45896d01e2` in account
  `351939435334`, region `us-east-1`.
- **Engine wrote via sigv4-proxy sidecar**: `aws-sigv4-proxy:1.8`
  deployment + service `sigv4-proxy-e2e` in the demo namespace,
  configured with STS session credentials. The engine writes
  unsigned HTTP to the proxy; the proxy adds SigV4 and forwards
  to AMP.
- **Confirmed in AMP** via `awscurl`:
  ```
  $ awscurl --service aps "${WS_URL}api/v1/label/__name__/values"
  → 5 10x metric names: all_events_summaryBytes_total,
    all_events_summaryVolume_total, emitted_events_optimized_size_total,
    emitted_events_summaryBytes_total, emitted_events_summaryVolume_total
  $ awscurl --service aps "${WS_URL}api/v1/query?query=count(all_events_summaryBytes_total)"
  → 209 series
  ```
- **MCP read + reason**: MCP runs `kind: 'prometheus'` against the
  port-forwarded sigv4-proxy (same proxy the engine uses for writes).
  `executeTopPatterns` rendered top patterns with newly-emerged rates
  of ~4.8 events/s. `executeServices` rendered **17 services** with
  byte volumes summing to 21.4 MB.
  *Note*: a direct `kind: 'amp'` adapter is implemented but the
  current sigV4 signing helper in `customer-metrics.ts` has a
  signature-mismatch bug against AMP query endpoints. The
  proxy-mediated path proves the full data path works; the direct
  AmpBackend impl needs a `customer-metrics.ts` fix to reuse properly.

### `datadog` — engine write proven, MCP read deferred

- **Backend instance**: Datadog us5 (credentials in
  `~/siem-poc-credentials.md`).
- **Engine wrote**: confirmed via Datadog query API. Five metric
  names ingested:
  ```
  GET /api/v1/metrics?from=NOW-600
  → all_events_summaryBytes, all_events_summaryVolume,
    emitted_events_optimized_size, emitted_events_summaryBytes,
    emitted_events_summaryVolume
  ```
  With real labels:
  ```
  POST /api/v1/query
    query=top(sum:all_events_summaryBytes{*} by {message_pattern, tenx_user_service, severity_level}, 5, 'sum', 'desc')
  → 5 series with patterns: open_telemetry_opentelemetry_collector_contrib_exporter_opensearchexporter
    @ opentelemetry-collector; service_instance_id_… @ opentelemetry-collector severity_level:error;
    opentelemetry_io_collector_processor_batchprocessor_v_batch_processor_go;
    (empty) @ opentelemetry-collector; (empty) @ payment.
  ```
- **MCP read NOT proven**: Datadog's `/api/v1/query` does NOT accept
  PromQL — it uses Datadog's native query language
  (`sum:metric{tag} by {dim}`, not `sum by (dim) (metric{tag})`).
  Sending PromQL returns:
  ```
  Error parsing query: unable to parse topk(5, sum by (message_pattern) (all_events_summaryBytes_total)):
  Rule 'scope_expr' didn't match at 'by (message_pattern)' (line 1, column 13).
  ```
  The MCP's `DatadogBackend` adapter assumed a Prom-compat read
  endpoint at `/api/v1/query`; Datadog actually exposes Prom
  compatibility on the **remote_write ingest** path only, not on
  reads. **Closing this gap is a real PromQL→Datadog query
  translator project** — Tier 3, scoped out of phase 1.

### `gcp_managed_prom` — deferred

- Service account `log10x-poc-reader` exists with Logs roles only.
  Needs `monitoring.metricWriter` + `monitoring.viewer` roles added,
  Managed Prometheus API enabled on project `log10x-poc`, plus a
  sidecar that signs requests with OAuth2 tokens (analogous to the
  sigv4-proxy). Same code path as `prometheus` once the auth
  middleware is in place.

## What's been proven (per the user's "indisputable ground truth" bar)

| Backend | Engine writes | MCP queries via abstraction | MCP renders engine data |
|---|---|---|---|
| `prometheus` (in-cluster) | ✓ 90 series, 8 services | ✓ via `kind: 'prometheus'` | ✓ top_patterns + services populated |
| `mimir` (in-cluster) | ✓ via prom-RW | ✓ via `kind: 'mimir'` | ✓ top_patterns + 10 services populated |
| `grafana_cloud_prom` shape (via nginx-basic) | ✓ via prom-RW | ✓ via `kind: 'grafana_cloud_prom'` | ✓ top_patterns through Basic-auth |
| `amp` (real AWS workspace) | ✓ 209 series via sigv4-proxy | ✓ via prom-shape against the same proxy | ✓ 17 services + top patterns |
| `datadog` | ✓ 5 metrics ingested with real labels | ✗ needs PromQL translator | ✗ deferred to Tier 3 |
| `cortex` | not verified (same code path as Mimir) | — | — |
| `gcp_managed_prom` | not verified (SA needs roles + API enable + OAuth2 sidecar) | — | — |

## Reproduction

1. `kubectl apply -f` for: prom-e2e deployment + service,
   mimir-e2e deployment + service, nginx-basic-e2e proxy +
   htpasswd secret, sigv4-proxy-e2e deployment + service +
   STS-creds secret.
2. ConfigMaps `receiver-config-e2e` (extends receiver app's
   include list) and `prom-rw-config-e2e` (defines 3 prom-RW
   targets).
3. Daemonset `tenx-fluentd` patched to add env vars `DD_API_KEY`,
   `DD_APP_KEY`, mount the override configmaps, and roll out.
4. From the laptop:
   - Port-forward each backend service
   - Run `LOG10X_METRICS_BACKEND_KIND=<kind>` + corresponding env
     vars
   - `node` against the local MCP build invoking `executeTopPatterns`
     and `executeServices`

## What's still on the gap list

1. **`customer-metrics.ts:sigV4Sign` has a signature-mismatch bug**
   against AMP's query endpoints (the proxy-mediated path
   proves the wire protocol works; the bug is in the local signer).
2. **Datadog PromQL translator** is real work — phase-out-of-scope
   for the MCP backend abstraction; deserves its own design pass.
3. **GCP Managed Prom OAuth2 sidecar** is the analogous problem
   for GCP that sigv4-proxy solves for AWS. The MCP read path
   works via `prometheus` kind once the engine can write.
4. **Cortex** code path is identical to Mimir but unverified with
   a live Cortex deployment.

The four proven roundtrips (Prometheus, Mimir, Grafana-Cloud-shape,
AMP) all share the **same MCP read code path** — `PrometheusBackend`
(or a subclass that just adds headers) sending PromQL to
`/api/v1/query`. That's the load-bearing claim of the
`MetricsBackend` design, and it's proven end-to-end with real engine
data on each.
