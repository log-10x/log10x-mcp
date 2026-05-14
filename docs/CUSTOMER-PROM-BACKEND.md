# MCP runs 100% local — no log10x backend dependency

**Status**: design draft. No code changes yet.
**Strategic position (pre-launch)**: the MCP must be CAPABLE of operating
with zero outbound network traffic to `log10x.com`. Customers who need a
fully-disconnected install must be able to get one. Customers who DON'T
need that can still use the log10x hosted backend if they prefer the easier
setup. The disconnect promise is capability, not mandate.

What this rules out:
- A silent fallback path that takes the MCP to `prometheus.log10x.com` when
  nothing is configured. Today that path exists (the `DEMO_API_KEY` in
  `environments.ts`); it has to go.
- Any phone-home behavior unrelated to the user's chosen backend (anonymous
  usage stats, version checks, telemetry) running by default.

What stays:
- `kind: 'log10x'` is a first-class option in the backend union. A customer
  who chooses it gets today's behavior: queries against
  `prometheus.log10x.com`, env enumeration via `/api/v1/user`, the full
  account-management tool set (`signin_*`, `login_status`, `rotate_api_key`,
  `create_env`, etc.).
- The MCP just refuses to PICK that backend silently. Selection is always
  explicit — env config or env var.

Why pre-launch is the right moment: backward compatibility costs nothing
yet. We can decide which paths exist on principle, not on
who-might-break-if-we-change-it.

## What this means concretely

1. **Each env declares its own metrics backend** in local config. Options:
   `log10x` (hosted) | `prometheus` | `mimir` | `cortex` | `amp` |
   `grafana_cloud_prom` | `gcp_managed_prom`. The customer's 10x engine
   writes to that backend via the engine's existing output modules; the
   MCP reads from the same store. For non-log10x backends, both endpoints
   stay inside the customer's perimeter.

2. **Env metadata can be read entirely from a local file**
   (`~/.log10x/envs.json` or env vars). Calling `/api/v1/user` to enumerate
   envs only happens when at least one configured env has `kind: 'log10x'`
   AND the user has explicitly opted into log10x-account-discovery. Local
   config is authoritative; the log10x API never silently adds or
   overrides envs.

3. **No silent fallback to log10x's hosted Prometheus.** Today, when no
   `LOG10X_API_KEY` is set, the MCP silently falls back to a public demo
   key pointing at `prometheus.log10x.com`. That path is removed. If no
   backend is configured, the MCP starts in an explicit "not configured"
   state and every metric tool returns a structured "configure a backend"
   message pointing at the setup doc. To USE the log10x hosted backend,
   the user picks it explicitly (env var or config file).

4. **No phone-home of any kind.** No anonymous usage stats, no version
   check, no telemetry. If we want any of those later, they go behind
   explicit opt-in and remain off by default.

5. **Doctor inventories network egress per env.** A new
   `network_egress_inventory` check lists every host the MCP could reach
   for the current configuration, grouped by env. For an env using
   `kind: 'log10x'` it explicitly enumerates `prometheus.log10x.com` and
   the `/api/v1/user` path. For other envs it lists their backend URL only.
   This is the artifact a customer's CISO gets when they ask "what does
   this tool talk to."

## Scope

In scope:
- Local-only env config (file + env vars). Remove `/api/v1/user` call.
- Backend pluggability for Prometheus-compatible TSDBs (Prom, Mimir, Cortex,
  AMP, Grafana Cloud Prom, GCP Managed Prom, generic Prom).
- Auth pluggability with ambient-credential auto-detection (kubectl, AWS
  chain, GOOGLE_APPLICATION_CREDENTIALS, env vars).
- Label-name remapping per env (so customers who rename `tenx_user_service`
  → `service` in their engine output config don't break MCP queries).
- Doctor's egress-inventory check.

Out of scope (defer):
- CloudWatch Metrics, Elastic, SignalFx — non-Prometheus query languages,
  real translation needed, separate adapter project.
- The existing `CustomerMetricsBackend` in `src/lib/customer-metrics.ts`
  (used for cross-pillar APM queries) stays as-is. Same auth shapes, kept
  as a separate interface. We mirror the pattern, not merge.

Note: Datadog IS in scope. Datadog exposes a Prometheus-compatible read
API (`/api/v1/query`, `/query_range`, `/labels`, `/label/{name}/values`)
that accepts PromQL and returns Prometheus-shaped responses. Auth is
`DD-API-KEY` + `DD-APPLICATION-KEY` headers and a site-specific endpoint
(e.g., `https://api.us5.datadoghq.com`). The existing
`DatadogPromBackend` class in `customer-metrics.ts` is the reference
implementation. One caveat: Datadog's Prom-compat endpoint supports a
subset of PromQL; common queries (`topk`, `sum by`, `increase`, `rate`)
work, but edge cases may not. Phase-2 testing verifies every MCP tool's
queries against a live Datadog account.

## Today's state (verified)

- `src/lib/api.ts` hardcodes `DEFAULT_BASE = 'https://prometheus.log10x.com'`
  and sends `X-10X-Auth: <apiKey>/<envId>` on every call to `/api/v1/query`,
  `/query_range`, `/labels`, `/label/{name}/values`, `/query_ai`.
- `src/lib/environments.ts` calls `/api/v1/user` to enumerate envs and
  falls back to a hardcoded demo key (`DEMO_API_KEY` constant) pointing at
  `prometheus.log10x.com`. The fallback is silent — typo'd keys land here.
- `src/lib/promql.ts` has hardcoded `LABELS = { pattern: 'message_pattern',
  service: 'tenx_user_service', severity: 'severity_level', env: 'tenx_env' }`.
- Auto-detection of ambient creds already exists for cross-pillar
  (Grafana Cloud, AMP, Datadog, GCP, generic Prom) in `customer-metrics.ts`.
  Same pattern is reused here.

## Proposed `EnvConfig` shape

```ts
export interface EnvConfig {
  nickname: string;
  /**
   * Metrics backend the MCP queries for this env. The 10x engine in the
   * customer's pipeline writes to a configured target (via the engine's
   * `prometheus/remote-write`, `amp`, etc. output modules); this field
   * tells the MCP where to READ. The two must point at the same store.
   *
   * `kind: 'log10x'` is supported as one option — current behavior
   * against prometheus.log10x.com using X-10X-Auth from apiKey + envId.
   * Picking it triggers the legacy account-aware code path (env
   * enumeration via /api/v1/user, signin/signout/rotate-key tools, etc.).
   * It must be selected explicitly; the MCP never falls back to it.
   */
  metricsBackend: MetricsBackend;

  /**
   * Override the metric label names per env. The engine's
   * `metricFieldNames` config (output/metric/{backend}/config.yaml)
   * lets a customer rename `tenx_user_service` → `service`,
   * `message_pattern` → `pattern_hash`, etc. The MCP must read with
   * the same names the engine writes.
   *
   * Missing keys fall back to the default below.
   */
  labelNames?: Partial<LabelNameMap>;

  isDefault?: boolean;
}

export type MetricsBackend =
  | { kind: 'log10x';       apiKey: string; envId: string }      // hosted, opt-in
  | { kind: 'prometheus';   url: string; auth: PromAuth }
  | { kind: 'mimir';        url: string; auth: PromAuth; orgId?: string }
  | { kind: 'cortex';       url: string; auth: PromAuth; orgId: string }
  | { kind: 'amp';          url: string; region: string }
  | { kind: 'datadog';      site: string; apiKey: string; appKey: string }
  | { kind: 'grafana_cloud_prom'; url: string; user: string; apiKey: string }
  | { kind: 'gcp_managed_prom';   url: string; projectId: string };

export type PromAuth =
  | { type: 'none' }
  | { type: 'bearer';  token: string }
  | { type: 'basic';   user: string; password: string }
  | { type: 'header';  name: string; value: string };

export interface LabelNameMap {
  pattern:   string;  // default 'message_pattern'
  service:   string;  // default 'tenx_user_service'
  severity:  string;  // default 'severity_level'
  env:       string;  // default 'tenx_env'
  pod:       string;  // default 'k8s_pod'
  container: string;  // default 'k8s_container'
  namespace: string;  // default 'k8s_namespace'
}
```

Note: `apiKey` / `envId` live INSIDE the `MetricsBackend` discriminated
union only on the `log10x` variant. They're not top-level fields on
`EnvConfig`. An env using `kind: 'prometheus'` doesn't carry those at all —
they're meaningless for that backend.

`owner` / `permissions` / log10x-account-derived fields are populated only
when the env's backend is `kind: 'log10x'` and the user has opted into
account discovery. For other backends those fields are absent and any
tool that depended on them gates on backend kind.

## Where the config lives

1. **`~/.log10x/envs.json`** for multi-env setups. JSON file holding a list
   of `EnvConfig`. The user (or an installer / IDE plugin) writes this
   once.

2. **Env vars** for single-env setups:
   - `LOG10X_METRICS_BACKEND_KIND` — `prometheus` | `mimir` | `cortex` | `amp` | `grafana_cloud_prom` | `gcp_managed_prom`
   - `LOG10X_METRICS_URL`
   - `LOG10X_METRICS_AUTH_TYPE` — `none` | `bearer` | `basic` | `header`
   - `LOG10X_METRICS_AUTH_VALUE` (token / password / header value)
   - `LOG10X_METRICS_AUTH_USER` (basic only)
   - `LOG10X_METRICS_AUTH_HEADER_NAME` (header only)
   - `LOG10X_METRICS_AMP_REGION`, `LOG10X_METRICS_GRAFANA_USER`,
     `LOG10X_METRICS_GCP_PROJECT_ID`, `LOG10X_METRICS_MIMIR_ORG_ID`, etc.
   - `LOG10X_METRICS_LABEL_<NAME>` for each label override.

3. **Ambient auto-detect** (lowest precedence, opt-in via `LOG10X_METRICS_BACKEND_KIND=auto`):
   - `kubectl config current-context` resolves → look for a Prometheus
     service in the cluster (configurable name). If found, surface as a
     candidate; do NOT auto-port-forward without explicit user consent.
   - `AWS_REGION` + ambient IAM → AMP candidate when the URL looks like
     `aps-workspaces.<region>.amazonaws.com`.
   - `GOOGLE_APPLICATION_CREDENTIALS` → GCP Managed Prom candidate.
   - `GRAFANA_CLOUD_API_KEY` → Grafana Cloud Prom candidate.

   Auto-detect produces a CANDIDATE list, never an authoritative choice.
   The MCP refuses to start when multiple candidates resolve and no
   explicit `LOG10X_METRICS_BACKEND_KIND` is set. Forces the user to
   declare intent.

## Example configs

### Self-hosted Prometheus, no auth

```json
{
  "nickname": "acme-prod",
  "isDefault": true,
  "metricsBackend": {
    "kind": "prometheus",
    "url":  "http://prom.acme.internal:9090",
    "auth": { "type": "none" }
  }
}
```

### Mimir behind a Bearer-authed gateway

```json
{
  "nickname": "acme-platform",
  "metricsBackend": {
    "kind":  "mimir",
    "url":   "https://mimir.acme.internal/prometheus",
    "orgId": "platform-team",
    "auth":  { "type": "bearer", "token": "${MIMIR_TOKEN}" }
  }
}
```

`${VAR}` references resolve from `process.env` at load time.

### AMP via ambient AWS IAM

```json
{
  "nickname": "acme-amp",
  "metricsBackend": {
    "kind":   "amp",
    "url":    "https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-abc123/",
    "region": "us-east-1"
  }
}
```

No credentials in the file — the AWS SDK chain resolves them from
the ambient environment (env vars / `AWS_PROFILE` / IRSA / SSO).

### Customer who renamed labels

```json
{
  "nickname": "acme-prod",
  "metricsBackend": {
    "kind": "prometheus",
    "url":  "http://prom.acme.internal:9090",
    "auth": { "type": "none" }
  },
  "labelNames": {
    "service": "service",
    "pattern": "pattern_hash",
    "env":     "tier"
  }
}
```

## Code changes downstream of the schema

1. **`src/lib/api.ts`** — collapse into a `MetricsBackend` interface
   parallel to `customer-metrics.ts`'s `CustomerMetricsBackend`. Concrete
   classes per `kind`. Calls go through the env's backend instance, no
   global base URL.

2. **`src/lib/promql.ts`** — `LABELS` becomes a function:
   `getLabels(env): LabelNameMap`. Every query builder takes the env's
   label map.

3. **`src/lib/environments.ts`** — rewrite. Reads env list from
   `~/.log10x/envs.json` or env vars. No call to `/api/v1/user`. No
   demo fallback. If nothing's configured, return a single "unconfigured"
   pseudo-env; every tool checks for this state and returns the
   structured "configure your backend" message.

4. **`src/lib/credentials.ts`** — repurposed. Today it stores the log10x
   Auth0 token from `log10x_signin_complete`. With no log10x backend,
   this file becomes the env list itself.

5. **`src/tools/*.ts`** — each tool's PromQL caller gets the env's label
   map. Mechanical change across ~15 files.

6. **`src/tools/login-status.ts` / `signin-start.ts` / `signin-complete.ts`
   / `signout.ts` / `rotate-api-key.ts` / `create-env.ts` / `update-env.ts`
   / `delete-env.ts`** — these are log10x-account tools. They STAY,
   unchanged in semantics, BUT they only work when at least one env in
   the local config uses `kind: 'log10x'`. If a user has no log10x-backed
   envs, these tools return a clear "no log10x account in use — these
   tools manage your hosted log10x account; configure a `kind: 'log10x'`
   backend first" message. No log10x API calls happen for users who
   aren't using the log10x backend.

7. **`src/tools/doctor.ts`** — new `network_egress_inventory` check.
   Resolves every backend URL across all configured envs, asserts none
   hit `*.log10x.com`. New `metrics_backend_reachable` check per env.
   New `expected_engine_labels_present` check (catches the otel-demo
   silent-empty failure from this session — assert
   `all_events_summaryBytes_total` exists and has the expected label
   names).

8. **A new `log10x_configure_env` tool** — local-config editor. Takes a
   backend kind + URL + auth + label map and writes/updates an entry in
   `~/.log10x/envs.json`. This is the onboarding path for non-log10x
   backends. The existing `create-env` tool only handles log10x-hosted
   account env creation, which is a different operation.

## What goes away

- The **silent fallback path** from `environments.ts` that takes the MCP
  to `prometheus.log10x.com` via `DEMO_API_KEY` when nothing is
  configured. The MCP starts unconfigured in that case instead.
- `isDemoMode` / `demoFallbackReason` / "we silently downgraded your
  typo'd key to the demo env" behavior.
- The hardcoded `DEFAULT_BASE = 'https://prometheus.log10x.com'` in
  `api.ts` — replaced with the per-env backend instance.
- The hardcoded `LABELS` constants in `promql.ts` — replaced with
  per-env label map.

## What STAYS

- `LOG10X_API_KEY` env var (still valid for the log10x backend; just
  not the implicit default).
- `prometheus.log10x.com` as a destination — used when at least one env
  has `kind: 'log10x'`.
- `/api/v1/user` and the rest of the log10x account API — called only
  when a log10x-backed env is in play.
- All `signin_*` / `login_status` / `rotate_api_key` /
  `create_env` / `update_env` / `delete_env` tools — gated on having
  at least one log10x-backed env configured.
- The full hosted-log10x experience for customers who choose it.

## Failure modes & guardrails

- **No backend configured**: MCP starts, but every metric-fetching tool
  returns a structured "metrics backend not configured for env X"
  response with a one-paragraph setup recipe. No silent egress. No
  empty result that looks like a tool failure.
- **Backend reachable but no `all_events_*` metrics present**: doctor
  reports "backend reachable but no log10x engine metrics found — verify
  the engine's metric output module points at this URL." Catches the
  read/write URL mismatch.
- **Backend reachable but expected labels missing**: doctor reports
  the actual labels present on `all_events_summaryBytes_total` and
  suggests `labelNames` overrides. Catches the rename mismatch and the
  "engine config dropped `runtimeAttributes: env:edge`" failure mode
  from the otel-demo trace.
- **Multiple backends auto-detected with no explicit choice**: MCP
  refuses to start; doctor lists the candidates. No silent picking.

## Resolved design decisions

1. **`MetricsBackend` shape: discriminated union.** Compile-time guarantee
   that AMP envs have `region`, Cortex envs have `orgId`, log10x envs have
   `apiKey + envId`. Matches the existing `CustomerMetricsBackend` adapter
   pattern in `customer-metrics.ts`.

2. **kubectl: print, don't manage.** Doctor surfaces a kubectl port-forward
   command when it detects a kubectl context and no `LOG10X_METRICS_URL`
   set. For users who need persistence (kubectl-only clusters), doctor's
   output includes a launchd plist (macOS) / systemd user unit (Linux)
   template. The MCP never spawns or holds subprocesses for kubectl.

3. **Single-env vs multi-env config: clean split.**
   - Single-env mode: `LOG10X_METRICS_*` env vars. No file. Nickname
     defaults to `default`.
   - Multi-env mode: `~/.log10x/envs.json`. Authoritative when present.
   - Both set simultaneously: MCP refuses to start with a loud error.
     User picks one.
   - `LOG10X_API_KEY` alone is no longer enough; users wanting the log10x
     backend must set `LOG10X_METRICS_BACKEND_KIND=log10x` explicitly.

4. **Configuration UX: conversational, tool-driven.**
   - Every metric tool, when no env is configured for the call, returns
     a structured `not_configured` response that names the supported
     backend kinds (one-line gloss each), lists what info each kind
     needs, and instructs the agent to ask the user where their 10x
     engine ships metrics, then call `log10x_configure_env`.
   - `log10x_configure_env` takes the discriminated-union args
     (`{ nickname, metricsBackend, labelNames? }`), runs validation
     (HTTP reachable → `up` probe → `all_events_summaryBytes_total`
     exists → expected labels present), and persists only on success.
   - Validation logic is shared with `doctor` — same code, two surfaces.
   - For `kind: 'log10x'`, `configure_env` can accept an apiKey directly
     OR delegate to the existing `signin_start` Auth0 device flow.
   - `signin_*`, `login_status`, `rotate_api_key`, `create_env`,
     `update_env`, `delete_env` stay as-is — gated on having at least
     one `kind: 'log10x'` env configured.

5. **Cross-pillar `CustomerMetricsBackend`: share primary backend by
   default, override available.**
   - Cross-pillar layer is already disconnect-compliant (no log10x-hosted
     default). No removals needed there.
   - When no explicit cross-pillar config exists (no `LOG10X_CUSTOMER_METRICS_*`
     env vars, no ambient credentials detected), cross-pillar resolution
     falls back to the env's primary `MetricsBackend`. Same URL + auth
     used for both log10x engine metrics and customer APM queries.
   - Customer with split deployments (engine metrics in Prom, APM in
     Datadog) sets `LOG10X_CUSTOMER_METRICS_*` explicitly to override.
   - `CustomerMetricsBackend` and `MetricsBackend` remain separate
     interfaces. The sharing is at the resolution layer, not the type
     layer.
   - Doctor reports whether cross-pillar resolved independently or via
     primary-backend fallback.

## Credential storage principle

**`~/.log10x/envs.json` holds backend metadata and references to
credentials. It never holds plaintext secrets directly.** Credentials
resolve from one of:

1. The backend's native credential chain (AWS SDK chain, GCP SDK chain,
   kubectl context). For these backends — `amp`, `gcp_managed_prom` —
   the file carries no auth fields at all. Example: an `amp` entry is
   `{ kind: 'amp', url, region }`; AWS credentials come from
   `AWS_PROFILE` / IAM role / SSO at query time.
2. `${VAR}` references in the file, resolved from `process.env` at load
   time. Example: `{ auth: { type: 'bearer', token: "${PROM_TOKEN}" } }`.
   The literal token lives in the user's shell or password manager, not
   the file.
3. Direct env vars for single-env mode (`LOG10X_METRICS_AUTH_VALUE` etc.).

The MCP refuses to start if it detects what looks like a literal
credential in the file (long random-looking string in an auth field).
The error tells the user to move the secret into `${VAR}` form. This
prevents copy-paste-once-then-forget situations from leaking secrets
into committed dotfiles or backups.

`kind: 'log10x'`'s `apiKey` field is the awkward exception — today's
flow writes it literally. Tightening it to require `"${LOG10X_API_KEY}"`
form is consistent but a small UX cost for the most common existing
case. Acceptable tradeoff for pre-launch.
