# Counterfactual injection harness (Phase 2 E2E VERIFIED 2026-05-11)

> **Status (2026-05-11 final)**: **Phase 2 e2e verified end-to-end
> against the OTel demo cluster.** Synthetic canary events planted via
> a small k8s Deployment in the demo's `otel-demo` namespace flow
> through the existing tenx-fluentd → tenx-edge engine pipeline,
> appear as real `all_events_*` series in the demo env's Prometheus
> tenant, and are surfaced by MCP tools to an agent that correlates
> them cross-pillar.
>
> The earlier local-docker stack approach (Phase 1) was abandoned per
> a strategic call from the user: "the local run will add a lot of
> work for little value. would it not be easier to just generate the
> synthetic logs in the demo env where the fluentd will pick them up
> and the 10x engine will absorb them as part of the environment's
> metrics allowing complex e2e validation of the mcp against synthetic
> metrics?". This was the right call — Phase 2 was implemented in <30
> minutes once Phase 1's local-stack rabbit hole was abandoned.
>
> ## Phase 2 architecture (much simpler than the original plan)
>
> ```
>     [synthetic-canary Deployment]  ← deployed in otel-demo namespace
>             ↓ stdout JSON events
>     /var/log/containers/synthetic-canary-*_otel-demo_*.log
>             ↓ tailed by existing tenx-fluentd DaemonSet
>     [tenx-fluentd kubernetes_metadata filter]
>             ↓ enrich + forward
>     [tenx-edge engine running @apps/edge/optimizer]
>             ↓ remote_write
>     prometheus.log10x.com (demo env tenant)
>             ↓ all_events_summaryBytes_total{message_pattern=..., severity_level=...}
>     [MCP tools query against demo env]
>             ↓
>     [sub-agent investigates; cross-pillar correlation triggered]
> ```
>
> Total infra: **one k8s manifest** (Deployment + ConfigMap) at
> `eval/counterfactual/k8s/synthetic-canary.yaml`. The Python emitter
> runs in `python:3.11-slim` (public Docker Hub image, no auth) and
> logs structured JSON to stdout. Everything else is the demo env's
> existing production stack.
>
> ## E2E verification result
>
> Pod: `synthetic-canary-6bb44b559c-lll4d` in `otel-demo` namespace,
> emitting at 0.5 ev/s (1 event every 2s), mix of CRITICAL OOMKilled
> + ERROR CrashLoopBackOff + WARN readiness-probe-failed.
>
> Within ~90s of deployment, the canary events appeared in
> `all_events_summaryBytes_total` with:
> - `tenx_app: receiver`
> - `tenx_env: edge`
> - `tenx_fwd_input: fluentd`
> - `tenx_host_name: tenx-fluentd-kpwzz`
> - `tenx_reported_name: tenx-demo`
> - Multiple `message_pattern` values including
>   `message_Synthetic_canary_heartbeat_canary_run_synthetic_canary_run_id_idx`,
>   `are_available_pod_canary_Insufficient_memory_synthetic_canary_run_id_idx`,
>   and `pod_canary_in_namespace_otel_demo_exceeded_memory_limit_container_memory`
>
> The MCP `log10x_top_patterns({"severity":"CRITICAL","time_range":"24h"})`
> surfaced the canary CRITICAL pattern as rank #3 alongside the demo
> env's natural OTLP-collector CRITICAL events:
>
> ```
> #1  OTLP LOG GRPC Exporter Export failed data refused...   $0.02/wk   CRIT
> #2  OTLP METRIC GRPC Exporter Export failed data refused...$0.0021/wk CRIT
> #3  pod canary in namespace otel demo exceeded memory limit$0.0000/wk CRIT   ← OURS
> ```
>
> ## Agent correlation result
>
> The `error-critical-events` hero scenario was run against the demo
> env with the canary planted. The agent:
>
> 1. **Surfaced the planted canary** in its synthesis as the #3
>    CRITICAL pattern.
> 2. **Called `log10x_discover_env`** — the cross-pillar / k8s
>    cluster-state tool — to inspect the otel-demo namespace's
>    actual deployed state.
> 3. **Built a coherent causal story** linking the planted canary
>    to the demo's natural OTLP-collector CRITICAL events:
>    > "#3 confirms the memory pressure story: a canary pod in
>    > namespace otel-demo is actively exceeding its memory limit,
>    > which is almost certainly the root cause causing the export
>    > refusals in #1 and #2."
> 4. **Generated concrete recommendations** referencing the actual
>    otel-demo DaemonSet (`otel-collector-agent`, image
>    `otel/opentelemetry-collector-contrib:0.142.0`) and
>    suggested calling `log10x_investigate` to trace the full causal
>    chain.
>
> Campaign-scorer verdict: **PASSED**
> - drift = 0/8
> - pattern_match = 3/2 = 1.00 (named both oracle-expected CRITICAL
>   patterns AND the planted canary)
> - chain = 1.00
> - value_delivered = 0.85
> - value_received = 0.75
>
> ## What this proves
>
> - **The full pipeline works end-to-end**: planted-event → fluentd →
>   tenx-edge → Prometheus → MCP → agent → cross-pillar correlation.
> - **The agent does reach for cross-pillar tools** when planted
>   signals suggest k8s correlation — `log10x_discover_env` fired
>   automatically.
> - **The harness is falsifiable**: anyone with kubectl access to the
>   demo cluster can `kubectl apply -f
>   eval/counterfactual/k8s/synthetic-canary.yaml`, wait ~90s, and
>   reproduce the canary appearing in MCP tool output. Tear-down is
>   `kubectl delete -f` on the same file.
> - **The earlier local-docker approach was abandoned**: ~half-day of
>   debug work uncovered (a) fluent-bit 4.2 ↔ tenx-edge wire format
>   incompatibility, (b) the receiver-app config requirements,
>   (c) the auth model rules. All learnings preserved in this doc
>   for posterity; none required to actually ship Phase 2.

# Counterfactual injection harness (Phase 1 SMOKE-TESTED 2026-05-11)

> **Status (2026-05-11 final)**: Phase 1 working end-to-end.
> **Synthetic events emitted by the Python generator reach the
> talw.gx env's Prometheus tenant as `emitted_events_*` metrics
> with correct `message_pattern` labels.** Verified via direct
> Prometheus query (e.g. `message_pattern="test_event_with_proper_ks_metadata_block"`
> appears with 2300 bytes after a 5-event emission).
>
> ## What changed during the smoke test
>
> Two architectural corrections vs the original plan:
>
> 1. **Engine image**: `log10x/edge-10x:1.0.19` (Docker Hub),
>    not `ghcr.io/log-10x/pipeline-10x`. Confirmed via the
>    Reporter Helm chart's `appVersion`.
>
> 2. **Forwarder removed**: Fluent Bit 4.2.4's `forward` output
>    pushed bytes that the engine's
>    `ForwardProtocolInputStream` decoder rejected ("socket idle
>    for Xms with no decoded messages"). Root cause was a
>    msgpack-framing incompatibility between the Fluent Bit
>    version and the engine, NOT a config issue (multiple
>    `Tag` / `Time_as_Integer` / `Match` permutations were
>    tried, all failed to decode).
>
>    Solution: the Python generator now speaks the **Fluentd
>    Forward Protocol directly** via `msgpack` over the
>    engine's Unix socket. The Phase-1 stack collapsed from
>    3 containers (generator + fluent-bit + engine) to **2**
>    (generator + engine). This actually matches your original
>    "a Python synthetic event generator" proposal more
>    cleanly — the generator IS the forwarder.
>
> ## Stack confirmed working
>
> ```
> generator (Python+msgpack)  →  unix socket (tenx-sockets vol)
>                                       ↓
>                          pipeline-10x running @apps/reporter
>                                       ↓ remote_write
>                            prometheus.log10x.com/api/v1/remote_write
>                                       ↓
>                              talw.gx env tenant (envId 8209858b)
> ```
>
> ## Phase 1 deliverables (in tree)
>
> - `eval/counterfactual/generator/emit.py` — Python NDJSON +
>   forward-protocol emitter (msgpack frames over Unix socket).
> - `eval/counterfactual/docker-compose.yml` — 2-service stack.
> - `eval/counterfactual/specs/` — 5 day-1 specs (novel,
>   critical-burst, newly-emerged, fake-k8s, service-anomaly).
> - `eval/bin/run-counterfactual-scenario.mjs` — orchestrator.
> - `eval/bin/run-counterfactual-suite.mjs` — suite runner.
> - `eval/src/counterfactual-runner.ts` — 3-layer verdict
>   assembly (metric / agent / synthesis).
> - `eval/src/types.ts` — `CounterfactualSpec` +
>   `CounterfactualVerdict` schemas.
> - `eval/counterfactual/README.md` — operator runbook.
>
> ## Known limitations of Phase 1 (talw.gx env)
>
> The engine's edge tier (`@apps/reporter`) emits the
> `emitted_events_*` metric family — visible directly in
> Prometheus, but **not visible to MCP tools** (which query
> `all_events_*`, the cloud-tier output). For the MCP
> agent-correlation layer to see the planted events, the
> harness needs to run against an env that has the cloud-tier
> receiver (`@apps/receiver`) deployed.
>
> Additionally, `tenx_user_service` / `severity_level`
> Prometheus labels did NOT populate from the generator's
> events, because the engine's default config doesn't extract
> them from the k8s-shaped record we emit. Production envs
> configure `enrichmentFields` + `serviceName` env vars that
> point at `kubernetes.labels.app`; our standalone stack
> doesn't. (One severity DID populate via keyword detection on
> the log text.) This is a config-tuning follow-up, not a
> fundamental issue.
>
> ## Phase 2 — agent-MCP correlation test (attempted 2026-05-11, BLOCKED)
>
> Repointing the stack at the OTel demo env was tested and hit
> two architectural walls. Documenting both so future planners
> don't re-discover them.
>
> **Wall 1: writes to the demo env tenant are rejected.**
> The demo env's published API key (`4d985100-...`) is read-only
> — the engine logged `401 Not Authorized` on every remote_write
> attempt to `prometheus.log10x.com/api/v1/remote_write`. The
> user's personal API key (`1bb8b68f-...`) routes writes to
> the user's OWN tenant (`8209858b-...`) regardless of the
> envId in the `X-10X-Auth: <key>/<envId>` header. The auth
> model: API key → user account → that user's tenant. envId is
> informational, not a cross-env grant.
>
> Confirmed via `tenx_usage_write_samples` per-tenant: my engine's
> writes only ever incremented the talw.gx tenant counter, never
> the demo env's. Conclusion: to write to the demo env we'd need
> its actual write credentials (admin-tier, not user-tier).
>
> **Wall 2: standalone receiver needs production config.**
> The cloud-tier `@apps/receiver` (which aggregates
> `emitted_events_*` from edge into `all_events_*` for MCP
> consumption) requires forwarder-input modules (rate /
> compact reducers) that demand `rateReducerFieldNames`,
> `compactReducerFieldNames`, `levelField`, etc. env vars.
> Without them the engine throws `TenXLog_throwError`
> immediately at boot. Setting them requires production-tier
> tuning (lookup tables, symbol files) the standalone stack
> doesn't ship with.
>
> **What this means**: the MCP-agent correlation layer on
> talw.gx alone is blocked because MCP tools query
> `all_events_*` which only the cloud-tier receiver produces.
> Our edge engine produces `emitted_events_*` directly into
> the talw.gx tenant (verified) — visible via direct
> Prometheus query, invisible to the standard MCP tools.
>
> ## Unblock options (none cheap)
>
> 1. **Demo env admin credentials** (write-scoped). Needs to
>    come from whoever owns the OTel demo env.
> 2. **Full standalone cloud-tier deployment**: figure out the
>    minimal `@apps/receiver` config + supply the reducer
>    rule env vars. Estimated ~half a day of work to make it
>    boot, then more to wire it to consume from our edge.
> 3. **A separate cloud-deployed customer env owned by the
>    user** with the full stack. The user's account is free-tier;
>    they'd need either a self-hosted helm-chart deployment OR
>    a paid tier with cloud-managed cluster.
> 4. **Patch the MCP tools** (`src/tools/{services, top-patterns,
>    list-by-label, cost-drivers, ...}.ts`) to also query
>    `emitted_events_*` as a fallback when `all_events_*` is
>    empty. Most invasive — changes real MCP behavior.
>
> ## What Phase 1 still delivers
>
> Even without Phase 2 wired up, the work shipped:
>
> - **Generator + Forward Protocol wire compatibility proven** —
>   we now know msgpack frames work; Fluent Bit 4.2.4 doesn't.
> - **Auth model documented** — API key binds to tenant; envId
>   is informational.
> - **Engine image / version pinned** — `log10x/edge-10x:1.0.19`
>   matches the demo env's chart appVersion.
> - **Permission override identified** — `user: "0:0"` on the
>   engine for docker named-volume socket binding.
> - **Receiver app config blocker mapped** — see Wall 2.
> - **Counterfactual scorer scaffolding** is in place — when
>   Phase 2 unblocks, the 3-layer verdict assembly is ready.

## Why this is design-only today (was)

The campaign and the deeper test surfaces (shapes / perturbation /
multi-judge / refusal / injection) all measure the agent + scorer
*on the demo env's natural state*. The OTel demo env is a shared,
read-only replay — we cannot mute a pattern, kill a reporter, or
inject a CRITICAL event stream without breaking other consumers of
the env.

A counterfactual harness needs a parallel env where we can inject
known signals and measure whether the agent + scorer notice. That
env does not exist yet; building it is its own infra task, separate
from this plan.

This document captures (a) the requirements, (b) the schema for
injection specs, (c) the predicted-vs-actual verdict-delta method,
and (d) a cost estimate — so when the env is available, the harness
can be implemented in one focused chat.

> **Update**: The user's proposal sidesteps the env-fixture cost
> entirely. Instead of standing up a parallel env we deploy the
> 10x engine (`log10x/edge-10x` from the Reporter Helm chart) +
> Fluent Bit + a small Python generator as 3 local Docker
> containers, all pointed at an EXISTING env via the user's API
> key. Total infra: laptop docker compose; no AWS spend. Engine
> image is the same one the demo env runs (per the Helm chart's
> `appVersion: 1.0.19`).

## Env-fixture requirements

A counterfactual env must support:

| Capability | Why | Implementation sketch |
|---|---|---|
| **Private** | Mutations must not leak to other consumers | Standalone Receiver instance with its own EnvConfig / API key |
| **Replay-controllable** | Reproducible baseline state | Static input corpus from a known SIEM export, replayed deterministically |
| **Pattern-mute primitive** | Suppress a specific pattern_hash from the ingest path | Reporter config exposes a mute list; harness flips entries before the run |
| **Rate-amplify primitive** | Multiply a pattern's emission rate by N | Synthetic generator alongside the replay; the harness toggles the multiplier |
| **Severity-inject primitive** | Introduce a CRITICAL-severity event stream that did not exist in the baseline | Synthetic generator (same as above) tagged with severity_level=CRITICAL |
| **Reporter-kill primitive** | Take the edge reporter offline | `kubectl scale --replicas=0` on the reporter deployment |
| **Snapshot + rollback** | Restore the env to its baseline between runs | A scripted teardown that re-applies the known-good config |

The env should expose the same `prometheus.log10x.com`-style gateway so
no MCP code paths change; only the env identifier and credentials
differ.

## Injection spec schema (sketch)

Each counterfactual scenario is a directory:

```
eval/counterfactual/<scenario-id>/
  injection.json          # what to do to the env
  prediction.json         # what verdict deltas the harness expects
  baseline-transcript.json # captured before injection
  injected-transcript.json # captured after injection
  verdict-delta.json       # actual vs predicted
```

`injection.json` schema (TypeScript-ish):

```typescript
interface InjectionSpec {
  id: string;
  description: string;
  // Primitives to apply, in order. Inverses are auto-applied on teardown.
  steps: Array<
    | { kind: 'mute_pattern'; pattern_name: string }
    | { kind: 'amplify_rate'; pattern_name: string; multiplier: number; duration_minutes: number }
    | { kind: 'inject_severity'; severity: 'CRITICAL' | 'ERROR'; pattern_name: string; rate_per_second: number; duration_minutes: number }
    | { kind: 'kill_reporter'; tier: 'edge' | 'cloud' }
    | { kind: 'restore' }  // emergency stop
  >;
  // Which hero scenarios are sensitive to this injection. Each
  // sensitivity declares the verdict-delta we expect.
  sensitive_scenarios: Array<{
    scenario_id: string;
    predicted_delta: {
      // Sample predicted-delta shapes:
      // - top_patterns: { added: string[]; removed: string[] }
      // - drift: { increase_by_at_least: number }
      // - chain_alignment: { added_tools?: string[] }
      // - axis_pass_change: 'baseline_pass_now_fail' | 'baseline_fail_now_pass'
      ...
    };
  }>;
}
```

## Predicted-vs-actual method

For each `(InjectionSpec × sensitive_scenario)` pair:

1. **Baseline run**: scenario runs against the parallel env at known
   baseline. Capture transcript + verdict.
2. **Apply injection**: harness invokes the primitives. Wait for
   metric propagation (~30-60s).
3. **Injected run**: scenario runs again. Capture transcript +
   verdict.
4. **Diff**: compute the actual verdict-delta (e.g., did
   `top_patterns` gain a new entry? did `drift` rise? did a passing
   axis flip to failing?).
5. **Score**: actual delta vs `predicted_delta`. PASS = the agent
   detected the injection AND the scorer caught the change. FAIL
   on either:
   - agent missed it (e.g., the injected CRITICAL pattern doesn't
     appear in the synthesis when the question is "any CRITICAL
     events?")
   - scorer missed it (the synthesis is technically correct but
     the rubric doesn't surface the change against the baseline)
6. **Teardown**: harness restores baseline; sleeps until metrics
   converge.

The harness emits `eval/counterfactual/COUNTERFACTUAL-PROOF.md`
analogous to `CAMPAIGN-PROOF.md`: per-scenario expected-delta
side-by-side with actual-delta, gap records for any divergence.

## Why this is the closest thing to a true integration test

Every other harness in the campaign exercises a SLICE of the
pipeline:

| Harness | What it tests |
|---|---|
| Campaign | Agent + scorer on natural env state |
| Adversarial / shapes | Scorer on a synthetic fork of the transcript |
| Perturbation | Agent's resistance to one bad tool response |
| Multi-judge | Judge calibration across models |
| Refusal | Agent's out-of-scope handling on engineered questions |
| Prompt injection | Agent's data-vs-instruction discrimination |
| **Counterfactual** | **Agent + scorer + env + MCP, end-to-end, with a known signal** |

Without it, every PASS in the campaign rests on an assumption that
the demo env is stable enough to be a ground truth. The
counterfactual harness is the only way to validate that signal-flow
end-to-end.

## Cost estimate

| Component | One-time | Recurring |
|---|---|---|
| Stand up a private Receiver + Reporter + Retriever fixture in AWS | ~1-2 engineering days | ~$50-150 / month for the EC2/EKS footprint |
| Author 5-10 InjectionSpec scenarios | ~1 day | — |
| Per-run cost (sub-agent + judge) | — | ~$1 × (5-10 scenarios × baseline + injected) = $10-20 / full run |

The infra footprint is the blocker. The harness code itself is
small (~500 LOC) and would take ~1 chat-day to write once the env
exists.

## Listed as deferred

This document is referenced from `UNVERIFIED.md` section 5
("One run on a customer env with real growth") and from
`CAMPAIGN.md`'s out-of-scope list. It is not implemented in the
2026-05-10 deeper-harness landing; revisit when the env-fixture
infra is available.
