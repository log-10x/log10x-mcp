# E2E proof — MCP queries a customer-owned Prometheus via the new backend abstraction

Captured during the implementation pass for [CUSTOMER-PROM-BACKEND.md](./CUSTOMER-PROM-BACKEND.md).
Verifies the load-bearing claim of the design — that the MCP can run
end-to-end against a customer's own metrics store with **zero outbound
to log10x.com**.

## Setup

```bash
# Local Prometheus with remote-write receiver enabled
docker run -d --name log10x-e2e-prom -p 9090:9090 \
  prom/prometheus:v2.55.0 \
  --config.file=/etc/prometheus/prometheus.yml \
  --web.enable-remote-write-receiver

# Pushgateway alongside, scraped by Prom every 5s
docker run -d --name log10x-e2e-pushgw -p 9091:9091 prom/pushgateway:v1.10.0

# Inject 5 synthetic 10x-shaped time series with the expected labels
for pattern in "Checkout_validation_failed:checkout:ERROR:1500000" \
               "Payment_gateway_timeout:payment:CRITICAL:800000" \
               "Cart_item_added:cart:INFO:5000000" \
               "User_session_start:frontend:INFO:12000000" \
               "Product_lookup:product-catalog:DEBUG:25000000"; do
  IFS=':' read -r pat svc sev bytes <<< "$pattern"
  curl -sS --data-binary @- "http://localhost:9091/metrics/job/test/instance/${svc}" <<EOF
all_events_summaryBytes_total{message_pattern="$pat",tenx_user_service="$svc",severity_level="$sev",tenx_env="edge"} $bytes
all_events_summaryVolume_total{message_pattern="$pat",tenx_user_service="$svc",severity_level="$sev",tenx_env="edge"} $(($bytes / 1000))
EOF
done
```

## MCP configured against local Prom

```bash
export LOG10X_METRICS_BACKEND_KIND=prometheus
export LOG10X_METRICS_URL=http://localhost:9090
export LOG10X_METRICS_AUTH_TYPE=none
export LOG10X_METRICS_NICKNAME=local-docker-prom
unset LOG10X_API_KEY  # ensure legacy path doesn't trigger
```

## Round-trip via the api.ts wrapper (phase 4 routing)

```
=== Loading environments ===
  total envs: 1
  default env: local-docker-prom
  backend kind: prometheus
  backend endpoint: http://localhost:9090
  isDemoMode: false

=== Querying via env.metricsBackend (through api.ts wrapper) ===
  up query status: success
  up query result count: 1
  first result: {"metric":{...},"value":[1778770772.054,"1"]}

=== fetchLabels through env.metricsBackend ===
  27 labels returned

=== Backend round-trip verified ===
```

The `queryInstant` and `fetchLabels` exports from `api.ts` correctly
delegated to the env's `metricsBackend` adapter. No HTTP call went to
`prometheus.log10x.com`.

## Doctor output — the CISO artifact

```
**[PASS] environment_config**
  1 environment: local-docker-prom ★. Default: local-docker-prom.

**[PASS] network_egress_inventory**
  **1 env configured. ZERO outbound calls to log10x.com — every env
   points at a customer-owned metrics backend.** This is the 100%-
   disconnect state.
  - env `local-docker-prom` (kind=prometheus): http://localhost:9090

### Environment: local-docker-prom

**[PASS] metrics_backend_reachable**
  Backend `prometheus` at http://localhost:9090 reachable, auth OK
  for env local-docker-prom.

**[PASS] reporter_tier**
  Edge Reporter detected — full-fidelity metrics with dropped-event
  coverage.
```

Three things this verifies:

1. **No log10x.com egress**: doctor's new `network_egress_inventory`
   check enumerates every host the MCP could reach. For a
   non-log10x env, that's just the customer's URL. Status `PASS`,
   stated explicitly: "ZERO outbound calls to log10x.com." This is
   the artifact a customer's CISO gets when they ask "what does
   this tool talk to."

2. **Backend kind + endpoint correctly identified**: the renamed
   `metrics_backend_reachable` check (was `prometheus_gateway`,
   hardcoded "prometheus.log10x.com" in the message) now names the
   actual backend in the success line.

3. **Existing per-env probes work over the new abstraction**: the
   legacy `reporter_tier` check issued
   `count(up{tenx_env="edge"})` and got back data — proving the
   PromQL builder + the new `MetricsBackend.queryInstant` path are
   wired correctly.

## What this does NOT yet prove

- **Engine-side write**: the 10x engine has a
  `prometheus/remote-write` output module per the config schema,
  but the local `tenx` CLI distribution doesn't bundle the
  `PrometheusRWMetricRegistryFactory` class (it's an edge-flavored
  module gap, not a design gap). The synthetic metrics above were
  pushed via Pushgateway instead. Confirming the engine-side
  remote_write path end-to-end is a separate exercise once a
  bundled-with-Prom-RW engine flavor exists.
- **AMP, Datadog, Grafana Cloud, GCP Managed Prom**: those backend
  adapters are implemented (in full for Datadog, as phase-1 stubs
  for AMP / Grafana Cloud / GCP). Live verification needs the
  respective credentials provisioned and a test run per backend.

## Tear-down

```bash
docker rm -f log10x-e2e-prom log10x-e2e-pushgw
```
