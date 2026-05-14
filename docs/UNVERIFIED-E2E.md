# Unverified end-to-end claims — work list

What I claimed but did NOT prove with hard data. Working through one
at a time; nothing moves to "verified" until I have a captured artifact
showing the live system doing the thing. If I'm blocked on
creds/auth, the item stays open with the specific block noted.

## Open items

### 1. Grafana Cloud Prom — engine write via Basic auth — **CLOSED**

Engine wrote via Basic auth to nginx-basic-gated Prom. Verified:
- Engine `prometheusRW` config set with `user: acme, password: trial`
- nginx access log: `acme [...] "POST /api/v1/write HTTP/1.1" 204 0 ... "tenx-pipeline"` — engine authenticated and writes were accepted
- Curl WITHOUT auth → 401; with `-u acme:trial` → 200
- MCP `kind: 'grafana_cloud_prom'` (now a real subclass of
  `PrometheusBackend` instead of a stub) rendered 12 services with
  populated top_patterns

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

### 4. GCP Managed Prom — full roundtrip — **BLOCKED on auth**

**What I did**: installed gcloud, activated the
`log10x-poc-reader@log10x-poc.iam.gserviceaccount.com` SA from
`~/siem-poc-credentials.md`, minted an OAuth2 access token via JWT
exchange (works — confirms the SA + private key are valid), tried
a read against
`https://monitoring.googleapis.com/v1/projects/log10x-poc/location/global/prometheus/api/v1/labels`.

**Result**: HTTP 403:
`Permission 'monitoring.timeSeries.list' denied on resource 'projects/193220918324'`.

The SA in the credentials file has only the **Logs Writer + Logs
Viewer** roles (per the credentials file). For Managed Prometheus
we need `roles/monitoring.viewer` (read) and
`roles/monitoring.metricWriter` (write). The SA cannot grant these
to itself — it lacks `resourcemanager.projects.setIamPolicy`.

**What's needed to unblock**:
- A human GCP account with admin on `log10x-poc` (or a different
  admin SA) — they run:
  ```
  gcloud projects add-iam-policy-binding log10x-poc \
    --member=serviceAccount:log10x-poc-reader@log10x-poc.iam.gserviceaccount.com \
    --role=roles/monitoring.viewer
  gcloud projects add-iam-policy-binding log10x-poc \
    --member=serviceAccount:log10x-poc-reader@log10x-poc.iam.gserviceaccount.com \
    --role=roles/monitoring.metricWriter
  ```
- Confirm Managed Prometheus API enabled:
  `gcloud services enable monitoring.googleapis.com --project=log10x-poc`
- Then I run the roundtrip the same way I did for AMP:
  - Deploy a GCP-auth-proxy sidecar (similar to sigv4-proxy; uses
    the SA to mint Bearer tokens, attaches them to requests)
  - Engine writes via plain-HTTP prom-RW → proxy → GCP MP
  - MCP queries via `kind: 'gcp_managed_prom'` (still a phase-1
    stub — would implement same pattern as AMP)

**Status**: open until IAM unblock. Cannot verify without admin
credentials I don't have.

### 5. Datadog MCP read path — **CLOSED with definitive evidence**

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
