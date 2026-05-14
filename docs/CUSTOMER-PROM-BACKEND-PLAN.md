# Implementation + Test Plan: customer-owned metrics backend

Companion to [CUSTOMER-PROM-BACKEND.md](./CUSTOMER-PROM-BACKEND.md).
This doc covers HOW we build it and HOW we know it works.

## Branch + commits

- **Branch**: `feat/eval-harness` (current). Keeps the design + tests in
  the same branch as the recent guardrail work (no-symbol, freshness,
  free-form timeRange).
- **Commit cadence**: one commit per implementation phase below. Each
  commit passes type-check + the unit-test gate for that phase. No
  squash at the end — phases stay readable in history.
- **PR strategy**: open a draft PR at phase 1, mark ready after the
  end-to-end smoke test in phase 4 passes.

## Test infrastructure

Three layers, ordered by speed:

### Layer 1: unit tests (fast, in-process)

For each `MetricsBackend` adapter (`prometheus`, `mimir`, `cortex`,
`amp`, `grafana_cloud_prom`, `gcp_managed_prom`, `log10x`):

- Mock HTTP (msw or undici test interceptor). Verify:
  - Correct path / headers / auth scheme constructed per kind.
  - `queryInstant` / `queryRange` / `listLabels` / `listLabelValues`
    issue the right URL.
  - `${VAR}` reference resolution from `process.env` at load.
  - "Likely literal secret detected" refusal-to-start.
- Pure logic — no docker, no network. Sub-second.

### Layer 2: integration tests (docker, local)

A `docker-compose.test.yaml` in `log10x-mcp/test/integration/` with:

- **Prometheus** (`prom/prometheus:v2.55`) on `:9090`
- **Mimir** (`grafana/mimir:2.13`) on `:9009` — covers Cortex too since
  they're API-compatible
- **nginx with basic auth** in front of Prom on `:9091` — exercises the
  Basic auth path
- **nginx with bearer auth check** in front of Prom on `:9092` —
  exercises the Bearer auth path

The MCP test runner brings the stack up, runs a tenx dev pipeline that
writes synthetic metrics to each backend (using the existing engine
output modules), then runs each MCP tool against each backend and
asserts:
- The tool returns non-empty data.
- The data shape matches what the engine wrote.
- The label-rename override works (write with `service` instead of
  `tenx_user_service`, configure MCP's `labelNames.service: 'service'`,
  verify query returns).

### Layer 2b: hosted-backend integration tests (real credentials)

Backends that can't be docker-spawned but where we already have
credentials or can provision them today. Same MCP tool surface,
different store + auth:

- **Datadog us5** — DD_API_KEY + DD_APP_KEY in
  `~/siem-poc-credentials.md`. Engine output module
  `run/output/metric/datadog` ships metrics; MCP reads via
  `/api/v1/query` PromQL-compat with `DD-API-KEY` + `DD-APPLICATION-KEY`
  headers.
- **AMP** — provisioned during the test in AWS account
  `351939435334` (ambient SSO creds). Small workspace, torn down at
  end of test run. SigV4 auth via the AWS SDK chain.
- **GCP Managed Prometheus** — existing project `log10x-poc` with
  service account `log10x-poc-reader@log10x-poc.iam.gserviceaccount.com`.
  Requires one-time admin: add `monitoring.metricWriter` +
  `monitoring.viewer` roles to the SA, enable the Managed Prometheus
  API on the project. Same service account JSON then handles both
  write and read.

**Grafana Cloud Prom** remains the only Tier 1 backend without
end-to-end coverage. Mock HTTP (Layer 1) verifies the Basic-auth
construction; live verification waits on either (a) a free-tier
signup, or (b) the first customer trial that uses it.

### Layer 3: end-to-end smoke (the engine + MCP, one box)

Uses the user-provided test harness:
- `TENX_HOME=/Users/talweiss/eclipse-workspace/l1x-co/config`
- Sample log file in `$TENX_HOME/config/data/sample/input/`
- `apps/dev/config.yaml` with the matching metric output uncommented
- Run `tenx dev` — metrics flow to a docker TSDB
- Configure MCP to query the same TSDB
- Run the full MCP tool surface against it (`top_patterns`,
  `cost_drivers`, `event_lookup`, `discover_labels`, `list_by_label`,
  `pattern_trend`, `services`, `savings`, `doctor`)
- Assert every tool returns sensible output that matches the input

Matrix:

| Engine output module | Backend store | MCP backend kind | Notes |
|---|---|---|---|
| `prometheus/remote-write` | `prom/prometheus` (`--enable-feature=remote-write-receiver`) | `prometheus` | bare case |
| `prometheus/remote-write` | `grafana/mimir` (docker) | `mimir` | `orgId` via `X-Scope-OrgID` |
| `prometheus/remote-write` | Prom behind nginx-bearer | `prometheus` w/ `auth.bearer` | auth path |
| `prometheus/remote-write` | Prom behind nginx-basic | `prometheus` w/ `auth.basic` | auth path |
| `datadog` | Datadog us5 (real account) | `datadog` | DD_API_KEY + DD_APP_KEY; PromQL-compat read |
| `prometheus/remote-write` | AMP workspace (provisioned, torn down after) | `amp` | SigV4 via ambient AWS SSO |
| `prometheus/remote-write` | GCP Managed Prom (project `log10x-poc`) | `gcp_managed_prom` | service-account JSON; one-time admin setup |
| `log10x` | hosted prometheus.log10x.com | `log10x` | regression — current behavior still works |

If all eight rows pass with the same hero scenario (10k sample events
in → expected top-10 patterns out), the refactor is verified.
Grafana Cloud Prom is covered by Layer 1 mock HTTP only (live
verification deferred — no credentials yet).

### Layer 4: validator smoke (re-use existing harness)

Re-run the existing hero scenarios from `eval/` against the
post-refactor MCP, both:
- With `kind: 'log10x'` (regression — same numbers as before the change)
- With `kind: 'prometheus'` pointing at a local Mimir fed the same input

If both produce the same fabrication-detector results, the abstraction
didn't introduce hallucination paths.

Note: this DOES require the engine ingestion bug Dor is fixing (the
otel-demo broken metadata path). For local testing we control the
input, so we can verify the MCP end-to-end against a clean local stack
even while the otel-demo env stays broken.

## Implementation phases

Each phase ends with a passing test gate and a commit. No phase
silently breaks the prior state.

### Phase 1 — `MetricsBackend` interface + adapter classes (no callers yet)

**Goal**: stand up the abstraction parallel to existing `api.ts`. No
behavior change. Existing tools still use `api.ts` directly.

Files added:
- `src/lib/metrics-backend.ts` — discriminated union, interface,
  factory (`createBackend(config): MetricsBackend`), `${VAR}`
  reference resolver, literal-secret detector.
- `src/lib/metrics-backend/log10x.ts` — wraps existing `api.ts` calls
- `src/lib/metrics-backend/prometheus.ts` — generic Prom client
- `src/lib/metrics-backend/mimir.ts` — extends prometheus, adds
  `X-Scope-OrgID`
- `src/lib/metrics-backend/cortex.ts` — same shape as Mimir
- `src/lib/metrics-backend/amp.ts` — SigV4 (reuse `sigV4Sign` from
  `customer-metrics.ts`)
- `src/lib/metrics-backend/grafana-cloud-prom.ts` — Basic auth with
  `user:apiKey`
- `src/lib/metrics-backend/gcp-managed-prom.ts` — GCP SDK auth
- `test/unit/metrics-backend.test.ts` — Layer 1 tests for each

Test gate: `npm test` runs all unit tests, all green.

### Phase 2 — `LabelNameMap` + `promql.ts` parameterization

**Goal**: queries become env-aware. No behavior change for default
labels.

Files modified:
- `src/lib/promql.ts` — `LABELS` becomes a default constant; every
  builder takes a `labels: LabelNameMap` parameter (with a default).
  Existing callers pass the default explicitly.
- `src/lib/format.ts` — verify any label references there also take a
  param.

Test gate: existing tools work unchanged; the default label map IS the
hardcoded constant. Smoke-test top_patterns against the live demo env
— output identical to pre-change.

### Phase 3 — `EnvConfig` rewrite + env loading

**Goal**: support both legacy mode (LOG10X_API_KEY → log10x backend)
and new mode (`LOG10X_METRICS_*` env vars + `~/.log10x/envs.json`).
Strict mode behind a flag during the transition.

Files modified:
- `src/lib/environments.ts` — rewrite. New paths: parse env vars,
  parse `~/.log10x/envs.json`, error on both-set, error on
  literal-secret detected.
- `src/lib/credentials.ts` — repurposed. `signin_complete` writes
  envs.json entry with `kind: 'log10x'`.
- `test/unit/environments.test.ts` — covers each load path.

During this phase, legacy behavior (`LOG10X_API_KEY` alone) keeps
working. Strict mode (refuse to start without explicit kind) is gated
on `LOG10X_STRICT_BACKEND=1`. After phase 6 we flip strict-by-default.

Test gate: existing log10x-key users still work. New env-var users
work too. Both-set errors. Literal-secret refuses to start.

### Phase 4 — Thread backend through every tool

**Goal**: every tool calls `env.metricsBackend.queryInstant(q)` instead
of `queryInstant(env, q)`. Every `LABELS.x` reference becomes
`env.labels.x`. Mechanical across ~15 tool files.

Files modified:
- `src/tools/*.ts` — every tool that hits Prometheus.
- `src/lib/api.ts` — keep the function exports but mark deprecated; they
  now route through the env's backend.
- `src/lib/resolve-env.ts` — `resolveMetricsEnv` becomes a method on the
  backend (some backends always return one tier; only `log10x` probes).

Test gate: layer 2 + layer 3 integration tests pass for `kind:
'prometheus'` and `kind: 'mimir'`. Regression: layer 4 hero scenarios
produce same numbers for `kind: 'log10x'`.

### Phase 5 — `log10x_configure_env` + conversational `not_configured`

**Goal**: onboarding flow.

Files added:
- `src/tools/configure-env.ts` — takes `{ nickname, metricsBackend,
  labelNames? }`, runs validator, persists to envs.json.
- `src/lib/backend-validator.ts` — shared between configure-env and
  doctor. Steps: HTTP reachable → `up` query → `all_events_summaryBytes_total`
  exists → expected labels present.
- `src/lib/not-configured-response.ts` — structured response every
  metric tool returns when no env is configured. Names the backend
  kinds, lists required fields per kind, instructs the agent.

Files modified:
- Every metric tool: check env-configured at top; return
  not_configured response if absent.
- `default-manifest.json`: register `log10x_configure_env`.

Test gate: with no env configured, every tool returns the structured
response. With env configured via `configure_env`, every tool works.

### Phase 6 — Doctor: egress inventory + per-env validation

**Goal**: the CISO artifact + the catch-all health check.

Files modified:
- `src/tools/doctor.ts` — new checks:
  - `network_egress_inventory`: lists every host across configured envs
  - `metrics_backend_reachable` per env: connect + `up` probe
  - `expected_engine_labels_present` per env: probe for
    `all_events_summaryBytes_total` and check the label names
  - `kubectl_context_hint`: if kubectl context resolves and no
    `LOG10X_METRICS_URL` set, print the port-forward command + launchd /
    systemd templates
- `default-manifest.json`: updated doctor description

Test gate: doctor against a working env shows green; against a
misconfigured env (wrong URL, wrong labels, kubectl-only) gives
actionable hints.

### Phase 7 — Strict-by-default + remove silent fallback

**Goal**: flip the switch.

Files modified:
- `src/lib/environments.ts` — `LOG10X_API_KEY` alone is no longer
  enough. Requires explicit `LOG10X_METRICS_BACKEND_KIND=log10x`.
- Remove `DEMO_API_KEY` constant + the silent fallback path.
- `isDemoMode` / `demoFallbackReason` / "we silently downgraded" code
  paths removed.

Test gate: a fresh install with no config starts unconfigured. Every
tool returns the conversational not_configured response. Setting
`LOG10X_METRICS_BACKEND_KIND=log10x` + `LOG10X_API_KEY` + `LOG10X_ENV_ID`
restores log10x behavior.

### Phase 8 — Gating account-management tools

**Goal**: `signin_*`, `login_status`, `rotate_api_key`, `create_env`,
`update_env`, `delete_env` work only when at least one env is
`kind: 'log10x'`.

Test gate: with a non-log10x-only configuration, these tools return
clear "no log10x account in use" messages.

### Phase 9 — Cross-pillar fallback sugar

**Goal**: cross-pillar resolution falls back to primary backend.

Files modified:
- `src/lib/customer-metrics.ts` — `resolveBackend()` extended. After
  the existing env-var + ambient-detect paths, fall back to the
  primary `MetricsBackend` if its kind is Prom-compatible.
- Doctor reports resolution path (already shows `cross_pillar_backend`;
  add "resolved via primary fallback" annotation).

Test gate: env configured with only a primary Prom backend — cross-pillar
tools work without separate config. Env with both → cross-pillar uses
its own.

## End-to-end validation criteria

The refactor is verified when:

1. **Layer 2 docker tests all green** across the matrix (Prometheus,
   Mimir, both auth modes, log10x regression).
2. **Layer 3 end-to-end smoke**: sample log in → engine writes to local
   Mimir → MCP tools query Mimir → tool output matches expected for
   the sample. Repeated for each backend kind in scope.
3. **Layer 4 regression**: existing hero scenarios produce
   indistinguishable fabrication-detector results between
   `kind: 'log10x'` (legacy) and `kind: 'prometheus'` (refactored,
   against local Mimir fed the same data).
4. **CISO artifact**: doctor's egress inventory for a
   no-log10x-envs configuration shows zero `*.log10x.com` egress.
5. **No silent fallback**: removing all `LOG10X_*` env vars and the
   envs.json file → every metric tool returns the conversational
   not_configured response. Zero outbound traffic.

## Failure modes I want to specifically test

- Backend reachable, no log10x metrics → "engine isn't writing here yet"
- Backend reachable, metrics present, label rename mismatch → "your
  labels are different; here are the actual labels we see"
- Backend reachable, missing `tenx_env` label → "engine config doesn't
  set `runtimeAttributes: env:edge`; fix that, don't disable the MCP
  filter" (the otel-demo failure mode)
- Auth failure (401/403) → clear error, not "no patterns detected"
- Wrong region for AMP → AWS SigV4 will fail; surface that
- `${VAR}` reference where the var is unset → refuse to start with a
  message naming the var
- Literal-looking secret in the file → refuse to start with a message
  pointing at the `${VAR}` pattern
- Both single-env env vars AND envs.json present → refuse to start

These are the "would silently look like an empty env to a user three
weeks from now" failure modes. Every one needs an explicit error path
with an actionable hint.

## Order I'd start today

Phase 1, step 1: `src/lib/metrics-backend.ts` with the interface +
union type + factory. No adapters yet, just the shape. Type-check it,
commit. Then phase 1 step 2: the `log10x` adapter (thin wrapper around
current api.ts calls — verifies the abstraction fits the current
behavior before we add new backends). Type-check + smoke against the
demo env, commit. Then phase 1 step 3: `prometheus` adapter + unit
tests. The Mimir/Cortex adapters extend prometheus, so they come for
free.

That's the smallest verifiable first commit. After it lands, the
phase 2+ work is mechanical and we can move faster.

## What I'd NOT do

- Don't try to ship the whole thing in one PR. Phases 1-3 are
  abstraction-only (no behavior change); 4-6 are wiring; 7-9 are the
  breaking parts. Land in that order.
- Don't add features beyond Tier 1 (Prom-compatible backends) in this
  pass. Datadog metrics native API, CloudWatch Metrics, Elastic,
  SignalFx are tier-3 — separate adapter project. The hooks are there
  (the `MetricsBackend` union extends naturally) but those queries are
  a different shape.
- Don't pre-emptively refactor the existing `CustomerMetricsBackend` to
  share code with the new layer. Both interfaces sit side-by-side. They
  can converge later if it's clearly worth it; sharing prematurely makes
  the diff hard to review.
