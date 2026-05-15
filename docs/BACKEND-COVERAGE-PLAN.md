# Backend coverage plan — ground-truth E2E for every TSDB + log-store path

**Status**: drafted 2026-05-14. Source-of-truth doc for the work
described in PR feat/eval-harness commits `df16cd6` → present.

## Why this doc exists

The user explicitly asked for **zero assumptions, zero hallucinations**.
Past sessions overclaimed coverage in two ways:

1. Code-path proven against a *local nginx proxy* labeled as "Grafana
   Cloud SaaS roundtrip"
2. Stubs labeled "implemented" when they `throw` on first call

This doc lists every backend in the marketplace, every adapter that
exists vs is missing on each side, every credential status, and a
**ground-truth gate** that every step must pass before being marked
done. The gate is verbatim evidence — HTTP code + response body +
separate-channel cross-check — captured in a per-step artifact file.

## The ground-truth gate

After each non-trivial step the protocol is:

1. **Capture verbatim evidence** to `docs/evidence/<step>.txt`
   (HTTP code, response body excerpt, command, timestamp)
2. **Self-audit, verbatim quote test** — do not write a closure
   sentence unless I can quote the supporting line from the artifact
   above. If I find myself paraphrasing, the step is not done.
3. **Independent cross-check** — for every claim of the shape
   "engine wrote X to backend Y", verify via a *second* read path that
   isn't the same code I just wrote. Examples:
   - For Datadog: engine wrote → curl DD's `/api/v1/metrics` (not
     through the translator) confirms the metric names landed
   - For Grafana Cloud: engine wrote → direct `curl /api/prom/api/v1/...`
     confirms series count, then MCP `kind: 'grafana_cloud_prom'` is
     the dependent reader
4. **(Optional) sub-agent verification** — spawn an agent with the
   evidence file and the claim, instruct it to flag any mismatch.
   Use for high-stakes closures (any "Item N: closed").

## Backend universe + status

Three categories: TSDBs (where 10x writes summary metrics for
cost-attribution), log analyzers (where customer log volume goes
after the engine's reduction), and platforms that do both.

### Already proven E2E with hard data (do not redo)

| Backend | Side | Engine WRITE | MCP READ | Evidence |
|---|---|---|---|---|
| Prometheus (in-cluster) | TSDB | `prometheus/remote-write` | `kind: 'prometheus'` | `CUSTOMER-PROM-BACKEND-E2E-EVIDENCE.md` |
| Mimir (in-cluster) | TSDB | `prometheus/remote-write` | `kind: 'mimir'` | same |
| Cortex (local) | TSDB | `prometheus/remote-write` | `kind: 'cortex'` | `UNVERIFIED-E2E.md` Item 3 |
| AMP (real AWS workspace) | TSDB | `prometheus/remote-write` + sigv4-proxy | `kind: 'amp'` (after SigV4 fix in `2f0b178`) | `UNVERIFIED-E2E.md` Item 2 |
| Datadog (real us5) | TSDB + Logs | `datadog` (native) | `kind: 'datadog'` (PromQL→DD translator, `df16cd6`) | `UNVERIFIED-E2E.md` Item 5 |
| Grafana Cloud (real `*.grafana.net`) | TSDB | `prometheus/remote-write` (Basic auth) | `kind: 'grafana_cloud_prom'` (verified `7b9233e`) | `UNVERIFIED-E2E.md` Item 1 |

### Phase 1 — adapters to build with EXISTING creds (zero new signups)

For each: pre-existing engine output module + missing MCP read
adapter + live creds in this account.

| # | Backend | Pre-condition state (verified) | Plan | Ground-truth gate |
|---|---|---|---|---|
| 1 | **CloudWatch Metrics** | engine has `cloudwatch` module; AWS account `351939435334` verified via `sts get-caller-identity` | Add `kind: 'cloudwatch_metrics'` wrapping `@aws-sdk/client-cloudwatch` `GetMetricData`; engine writes counter to namespace `Log10x/E2E`; MCP reads via new adapter | Direct `aws cloudwatch get-metric-data` returns non-zero datapoint set for `all_events_summaryBytes` in namespace `Log10x/E2E`; MCP adapter on same metric returns same non-zero value within 1% |
| 2 | **Elasticsearch metrics** | engine has `elastic` module (Micrometer-ES writes to `micrometer-metrics-YYYY-MM` indices with `@timestamp`); Docker 27.5.1 available | Spin up `elasticsearch:9.1.0` Docker; engine writes via existing module; add `kind: 'elastic_metrics'` MCP adapter wrapping `@elastic/elasticsearch` searching the same index | Direct `GET /micrometer-metrics-*/_search?q=name:all_events_summaryBytes` returns hit count > 0; MCP adapter returns same docs |
| 3 | **OpenSearch metrics** | OS is ES-API-compatible; same engine `elastic` module should work; Docker available | Spin up `opensearchproject/opensearch:2.x`; engine writes via `elastic` module (with proper config); add `kind: 'opensearch_metrics'` thin variant | Same shape as ES: direct `_search` returns hits, adapter returns matching docs |
| 4 | **GMP (read side only)** | GCP project `log10x-poc` verified — SA token mints, `log10x-poc-otel` log present; `monitoring.viewer` role on SA confirmed via earlier session; engine WRITE side stays blocked (Item 4 in UNVERIFIED-E2E.md) | Finish stub `GcpManagedPromBackend`: OAuth2 Bearer via SA JSON → Prometheus API at `monitoring.googleapis.com/v1/projects/log10x-poc/location/global/prometheus/api/v1/...`; verify against whatever metric data is already in the GMP workspace | Direct `curl <gmp-url>/labels` returns non-empty list; MCP `kind: 'gcp_managed_prom'` adapter returns same labels |

### Phase 1.5 — adapters from siem-poc-credentials.md (existing creds, aging)

| # | Backend | Cred status | Side | Plan |
|---|---|---|---|---|
| 5 | **Azure Monitor Metrics** | **SP secret expires 2026-05-19 (5 days)**. SP role is "Log Analytics Reader" — must verify whether this includes Monitor Metrics scope or only Log Analytics queries | Both? | First: verify scope. If metrics included → adapter wrapping `@azure/monitor-query` `MetricsQueryClient`. If logs only → log-side only |
| 6 | **Sumo Logic** | access keys live; original `log10x-poc` collector torn down (only "mcp" remains); needs data path rebuild | Logs primarily; has separate Metrics API | Re-create hosted collector; re-ship sample; build adapter using Sumo Search API (logs) OR Metrics Query API |
| 7 | **ClickHouse** | service `dpq5h4e2b4` responding, version 25.12.1.1497; table `logs` (30K events) likely persists | Logs | Adapter wraps `@clickhouse/client` (already in deps); SQL against `logs` table |

### Phase 2 — adapters needing new trial signups (deferred until user provides)

| Vendor | What's needed | Side(s) | Estimated trial duration |
|---|---|---|---|
| Splunk Observability (SignalFx) | trial account + access token | TSDB | 14 days |
| New Relic | trial account + license + user API key | TSDB + Logs | 30 days |
| Dynatrace | trial tenant + API token | TSDB + Logs | 15 days |
| Coralogix | trial account + API key | Logs primarily | 14 days |
| Logz.io | trial account + API token | Logs + Metrics | 14 days |

### Phase 3 — Splunk Enterprise (separate decision)

Splunk Enterprise (Docker-installable, `splunk/splunk:latest`) is
**different from Splunk Observability** despite the shared brand:

- Splunk Enterprise: logs + metrics indices, queried via SPL
  (`search`, `mstats`); engine would need a new HEC-metrics output
  module
- Splunk Observability: SignalFx ingest + SignalFlow query; engine
  has the `signalFx` module

Marketplace says "Splunk" without disambiguation. The poc-from-siem
work already covers Splunk Enterprise on the LOG side. Adding TSDB
coverage there requires engine-side work I haven't scoped.

Decision pending.

## Execution order

Driven by (a) credential expiry clocks, (b) availability of
pre-conditions, (c) marketplace impact:

1. **Plan doc** ← you are here
2. **Verify Azure SP scope** — 1 curl probe. Outcome decides whether
   Azure metrics path is reachable before the 5-day clock expires
3. **CloudWatch Metrics adapter + E2E** — most reliable account state
4. **Elasticsearch metrics + E2E** — Docker spin-up first, then engine config,
   then adapter
5. **OpenSearch metrics + E2E** — variant of (4)
6. **GMP read adapter + E2E** — Phase-1 stub completion
7. **Azure (if scope allows)** — racing the 5-day clock
8. **Sumo Logic / ClickHouse adapters** — both sides where applicable
9. **Log-side re-runs** — `poc-from-siem` against all live creds
10. **Update UNVERIFIED-E2E.md** — append closures with evidence
    pointers; tear down test infra; commit each phase as it lands

## Ground-truth gate protocol per step

Concrete worked example (CloudWatch, step 3):

```
docs/evidence/cw-metrics/
├── 01-aws-identity.txt        # sts get-caller-identity proves we're in the right account
├── 02-engine-write-config.yaml # the daemonset patch that adds CW output
├── 03-engine-startup-log.txt  # engine log line: "Publishing TenXSummary metrics to CloudWatch namespace: Log10x/E2E"
├── 04-cw-direct-curl.txt      # `aws cloudwatch get-metric-data` shows datapoints
├── 05-mcp-adapter-output.txt  # MCP `kind: 'cloudwatch_metrics'` returns the same values
└── 06-cross-check.txt         # Sub-agent verdict on whether 04 and 05 agree
```

UNVERIFIED-E2E.md gets a new section "CloudWatch Metrics — CLOSED"
linking to that directory.

## Self-audit at every step

Before committing a "closed" claim, answer in writing:

1. Did I quote the verbatim evidence line?
2. Could the result be cached/stubbed/mocked? (If yes — what proves
   it isn't?)
3. Is there a separate-channel cross-check?
4. Have I confused "the adapter ran without error" with "the adapter
   returned data the backend actually has"?
5. Did the engine write actually land at the backend, or did I infer
   it from logs alone?

If any answer is "no" or "unsure", the step is NOT done.
