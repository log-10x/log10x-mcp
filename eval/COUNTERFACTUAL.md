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
> ## Phase 2 — agent-MCP correlation test
>
> Repoint the stack at the OTel demo env (`TENX_API_KEY` +
> `TENX_ENV_ID` env vars in `eval/counterfactual/.env`). The
> demo env runs the full edge + cloud + reporter stack, so:
> - `emitted_events_*` from our generator → cloud receiver
>   → `all_events_*` (visible to MCP)
> - Agent runs via existing hero-runner; MCP tools surface
>   the canary signal
> - The **kubectl-correlation key test** becomes meaningful:
>   does the agent reach for `log10x_correlate_cross_pillar`
>   when it sees synthetic OOMKilled patterns?
>
> Phase 2 implementation: same `docker-compose.yml`, different
> `.env` vars. Plus the agent-layer scoring logic in
> `eval/src/counterfactual-runner.ts` already accepts both
> `must_call_tool` AND `must_mention_correlation`. Ready when
> demo env write-access is confirmed.

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
