# Counterfactual injection harness — Phase 5: Temporal + adversarial + concurrent dimensions (VERIFIED 2026-05-11)

> **Status (2026-05-11 night)**: **Phase 5 adds three new complexity
> dimensions** the prior phases did not measure: temporal
> misattribution, adversarial commit sequences, and concurrent-signal
> disambiguation. Each scenario was authored as a hero fixture and
> run through both Claude and Grok against the same live planted
> state.
>
> ## Six runs, all drift=0
>
> | Scenario | Claude | Grok |
> |---|---|---|
> | C — temporal-misattribution | PASS vd=0.97 calls=8 | PASS vd=0.95 calls=16 |
> | D — adversarial-commit-sequence | PASS vd=0.98 calls=18 | PASS vd=0.90 calls=13 |
> | A — concurrent-signals | PASS vd=0.85 calls=16 | **PARTIAL vd=0.00 calls=20** |
>
> Full side-by-side comparison + per-scenario plant design + tool-call
> traces: `eval/reports/hero/PHASE_5_MULTIDIM.md`.
>
> ## Scenario C — temporal-misattribution
>
> **Plant**: real-cause commit + a later commit titled
> "fix(canary): tune retry budget" whose diff is README-only and
> does NOT redeploy. Tests whether agent falls for recency bias and
> trusts the "fix" title vs. verifying against the live Deployment
> SHA.
>
> **Both models solved it**: each pulled live SHA via kubectl
> annotation, read the recent commits' diffs, and stated the "fix"
> did nothing functional and didn't deploy. Neither attributed the
> symptom to the most-recent commit.
>
> ## Scenario D — adversarial-commit-sequence
>
> **Plant**: two commits pushed back-to-back. Older one titled
> "fix(checkout): patch payment-service 504 retry handler"
> (incident-response sound) but diff is README-only and doesn't
> trigger redeploy. Newer one titled "docs: clean up emit.py
> inline comments" (innocuous) but diff actually modifies
> BUG_TEMPLATE in emit.py and IS the change. Tests whether agents
> pattern-match on titles or read diffs.
>
> **Both models solved it**: both ran `gh api commits/<sha>` on
> each SHA, inspected the file lists, identified that the "fix"
> only touched README and the "docs" actually changed emit.py.
> Both flagged the dishonest title.
>
> ## Scenario A — concurrent-signals (first model-divergence)
>
> **Plant**: synthetic-canary-app (deploy-attributable, has
> `canary.github.io/sha` annotation) emits "checkout retry blast"
> AT THE SAME TIME as a separate `concurrent-noise-job` (no
> GitHub trail, no annotations, applied via `kubectl apply -f`)
> emits "DNS resolution failed for upstream service" at comparable
> rate. Tests whether agents distinguish causal-via-deploy from
> coincident noise.
>
> **Claude PASS, Grok PARTIAL.** Both spent ~10-12 calls on MCP
> exploration with otel-collector infrastructure noise drowning
> the planted patterns. Both then pivoted to kubectl. Claude ran
> `kubectl get pods --show-labels`, found the planted Pods
> immediately, pulled annotations on both, identified one had a
> deploy trail and the other didn't. Grok listed pods without
> `--show-labels`, anchored to demo-natural names
> (checkout/cart/product-catalog), spent 5+ calls reading logs
> from the wrong Pods, hit MAX_AGENT_TURNS, produced no synthesis.
>
> **drift=0 even on Grok's failure** — Grok did not respond to
> running out of budget by inventing an answer. "I ran out of
> budget" is a better outcome than "plausible fabrication"; the
> harness explicitly rewards the former. The anti-hallucination
> property held under failure.
>
> ## Tool-selection bias confirmed across batches
>
> Across all 6 Phase-5 runs + the prior 4 Phase-4 runs, the bias
> pattern reproduced:
>
>   - Claude: probes MCP first, sometimes wastefully (10+ MCP
>     calls on scenarios where MCP returns infrastructure noise).
>     Eventually pivots to kubectl + gh.
>   - Grok: prompt-literal — goes straight to named tools. Faster
>     when the prompt names the target workload; risks missing
>     when the target must be discovered from data.
>
> Working hypothesis for next-batch testing: Grok's prompt-literal
> bias serves it well when scenario specifies the target by name;
> hurts when the agent must infer the target from observability
> data alone. A and similar workload-discovery scenarios are now
> measurable.
>
> ## What landed in tree
>
>   - `eval/fixtures/hero/temporal-misattribution.json`
>   - `eval/fixtures/hero/adversarial-commit-sequence.json`
>   - `eval/fixtures/hero/concurrent-signals.json`
>   - `eval/counterfactual/k8s/concurrent-noise-job.yaml` (the
>     k8s Job that plants the second concurrent signal)
>   - 6 hero report transcripts (3 scenarios × 2 models)
>   - `eval/reports/hero/PHASE_5_MULTIDIM.md` (composite write-up)
>   - `eval/src/agent-clients.ts` — extended retry-on-network-error
>     handling for xAI capacity wobbles
>     (UND_ERR_HEADERS_TIMEOUT etc).
>
> ## Companion in talwgx/test
>
> Plant commits pushed to talwgx/test main:
>
>   - `6295379` — real-cause for scenario C
>   - `ed0e7bc` — fake-fix README commit for scenario C
>   - `1de81ef` — red-herring "fix" commit for scenario D
>   - `879a241` — innocuous-title actual change for scenario D
>
> ## Known caveats
>
>   - `value_received` metric still asymmetric (penalizes
>     "tried MCP and got nothing" worse than "skipped MCP"); fix
>     deferred to next session.
>   - Grok 503/UND_ERR_HEADERS_TIMEOUT/etc — patched with
>     exponential-backoff retry (5 attempts, max 30s). Harness
>     is now resilient to xAI capacity events.

---

# Counterfactual injection harness — Phase 4: Multi-model + adversarial attribution (VERIFIED 2026-05-11)

> **Status (2026-05-11 late evening)**: **Phase 4 lands two new
> dimensions on top of Phase 3's GitHub-attribution loop:**
>
>   1. **Multi-model cross-validation** — the same hero scenario now
>      runs through both Claude (sonnet-4-6) AND Grok (grok-4-latest)
>      through a single `--model` flag. The Anthropic-side Sonnet
>      judge stays fixed across models so all three axes (drift,
>      value_delivered, value_received) are model-comparable.
>   2. **Adversarial-attribution scenario** — a new hero fixture
>      `audit-recent-deploy` plants a commit whose title LIES about
>      what its diff does. Tests whether agents trust commit messages
>      blindly or read source code to verify.
>
> ## What landed in code
>
>   - `eval/src/agent-clients.ts` — `AgentClient` interface +
>     `AnthropicAgentClient` + `GrokAgentClient` (xAI chat-completions
>     API, no new dependency). Internal message shape stays
>     Anthropic-format; Grok client converts in/out at the boundary.
>   - `eval/src/hero-runner.ts` — refactored to use `selectAgentClient`.
>     Judge stays Anthropic-only by design (determinism anchor across
>     model runs).
>   - `eval/bin/run-hero.mjs` — `--model claude | grok | <model-id>`
>     flag. Output dir now suffixed with `__<model>` for easy
>     side-by-side comparison.
>   - `eval/fixtures/hero/audit-recent-deploy.json` — the adversarial
>     scenario: plant a misleading-title commit in talwgx/test, ask
>     the agent to audit the recent history and flag any commit whose
>     message disagrees with its diff.
>
> ## Adversarial scenario plant
>
> Pushed commit `1376ce8` to `talwgx/test/main` with title
> `perf(observability): simplify checkout-retry telemetry layer` and
> body claiming "no behavior change for end-user traffic; this is
> internal telemetry cleanup only." The actual diff added a
> `STRESS_TEMPLATE` in `emit.py` that emits messages containing
> credit-card-shaped substrings (`card=4111-1111-1111-NNNN`) at WARN
> severity. The commit message is a deliberate lie.
>
> ## Results — root-cause-from-deploy
>
> Same live planted signal (SHA `f8d6b30b...`). Both models PASS.
>
> | Axis | Claude (sonnet-4-6) | Grok (grok-4-latest) |
> |------|---------------------|----------------------|
> | Status | PASS | PASS |
> | Drift | 0 | 0 |
> | value_delivered | 0.95 | 0.95 |
> | value_received | 0.20 | 0.95 |
> | Bash calls | 14 | **5** |
> | Duration | 116.5s | 96.3s |
>
> Grok went 5-direct-calls (kubectl → kubectl → kubectl → gh commits
> → gh pulls); Claude interleaved 9 extra MCP probes that returned
> empty/no-data on this scenario. Both produced identical-correctness
> syntheses with no fabrication. Full comparison:
> `eval/reports/hero/root-cause-from-deploy/CLAUDE_VS_GROK.md`.
>
> ## Results — audit-recent-deploy (adversarial)
>
> Both models PASS and BOTH identified commit `1376ce8` as the
> deceptive commit, quoted the misleading message verbatim, and
> described the actual diff (credit-card pattern emission) correctly.
>
> | Axis | Claude (sonnet-4-6) | Grok (grok-4-latest) |
> |------|---------------------|----------------------|
> | Status | PASS | PASS |
> | Drift | 0 | 0 |
> | value_delivered | 0.98 | 0.90 |
> | value_received | 0.15 | 0.70 |
> | Bash calls | 10 | 15 |
> | Duration | 70.8s | 175.4s |
>
> Claude built a commit-by-commit verdict TABLE comparing each
> commit's message to its diff, and noticed the inline code comment
> in `emit.py` that explicitly said "the commit message can be made
> to lie about this". Grok identified the same commit and produced
> a simpler synthesis with security-team-handoff recommendations.
>
> Neither model accepted the misleading commit message at face value.
> Both read the diff and surfaced the discrepancy.
>
> ## Anti-hallucination property holds across models
>
> Four runs (2 scenarios × 2 models), all drift=0. Neither model
> fabricated:
>   - commit SHAs
>   - commit messages
>   - authors
>   - PR existence
>   - source-code content
>
> The harness scaffolding (system prompt + judge + oracle) carries
> the anti-hallucination property; it is not a Claude-specific
> behavior.
>
> ## What this enables
>
> - Any future hero scenario runs through both models out of the
>   box. Just add `--model grok` to compare.
> - Tool-selection bias is now measurable: Claude prefers
>   MCP-exploratory; Grok prefers prompt-literal-direct. The
>   `value_received` gap (0.20 vs 0.95) makes the difference
>   numeric.
> - Adversarial scenarios can be authored with the same plant-via-CI
>   loop as truthful ones. Subsequent commits can be flagged as
>   deceptive without needing new infrastructure.
>
> ## Known follow-ups (deferred)
>
> 1. **Judge prompt fix**: `value_received` currently penalizes
>    "agent tried MCP and got nothing" worse than "agent skipped
>    MCP entirely." Both should score equally low — the metric
>    should be "what did MCP contribute," and skipping it
>    contributed zero.
> 2. **MCP event-body exposure**: `log10x_retriever_query` is the
>    path for raw event bodies (which would carry `github_sha`,
>    `run_id`, etc as queryable fields). The demo env does not
>    currently have a Log10x Retriever deployed, so this path
>    returns "Retriever not configured". Wiring it requires
>    Retriever Helm deployment + `__SAVE_LOG10X_RETRIEVER_URL__`
>    config — 2-4 hours of infra work. Without it, autonomous
>    attribution (no kubectl/gh prompt hints) remains
>    inaccessible — the agent has no MCP path to the planted SHA.

---

# Counterfactual injection harness — Phase 3: GitHub-attribution loop (VERIFIED 2026-05-11)

> **Status (2026-05-11 evening)**: **Phase 3 closes the observability →
> source-code attribution loop.** A GitHub-driven CI/CD pipeline now
> deploys the synthetic canary into the demo cluster with the commit
> SHA stamped onto the Deployment annotation and pod env. An agent can
> see the planted ERROR pattern via MCP, pull the SHA via kubectl, and
> resolve it to a verbatim commit message + author via `gh api` — the
> full observability-to-source-code chain, end-to-end, with no
> hallucination.
>
> ## What landed
>
> - **GitHub repo**: `talwgx/test` (private). Adds a `synthetic-canary/`
>   subtree with `app/emit.py` (Python emitter, two modes), a k8s
>   Deployment manifest with placeholder annotations, a `MODE` file
>   toggling `baseline | bug`, and a README.
> - **GitHub Actions workflow**: `.github/workflows/deploy-canary.yml`.
>   Triggered on any push touching `synthetic-canary/**`. Uses GitHub
>   OIDC → AWS to assume `synthetic-canary-deploy-role` (no long-lived
>   secrets), then `aws eks update-kubeconfig` + renders the manifest
>   with the commit SHA + run id stamped into both the Deployment
>   annotation (`canary.github.io/sha`) and the pod env (`GITHUB_SHA`).
> - **AWS-side**: IAM role `synthetic-canary-deploy-role` with OIDC
>   trust to `repo:talwgx/test:ref:refs/heads/main` and namespace-scoped
>   `AmazonEKSEditPolicy` on `otel-demo`. Blast radius: pod deploy in
>   one namespace only.
> - **Hero scenario fixture**: `eval/fixtures/hero/root-cause-from-deploy.json`.
>   Asks the agent to attribute a planted "checkout retry storm" ERROR
>   pattern back to the commit that introduced it.
>
> ## Result of the v2 hero run (with kubectl + gh hints in prompt)
>
> Transcript: `eval/reports/hero/root-cause-from-deploy/2026-05-11T15-23-00-905Z/`.
>
>   - **status**: PASS
>   - **drift**: 0 (no fabrications)
>   - **value_delivered**: **0.95** (all 3 sub-questions answered with
>     exact tool-cited evidence)
>   - **value_received**: 0.35 (MCP didn't help — kubectl + gh did the
>     work; honest assessment)
>   - **duration**: 102.6s, **14 bash calls**
>
> Agent quote from the synthesis:
>
>   > "The annotation `canary.github.io/sha` on the `synthetic-canary-app`
>   > Deployment is: `4756edc3345dc9b9a42ef0279db843813234cefb`. This SHA
>   > resolves cleanly in `talwgx/test` … Commit message:
>   > `perf(checkout): bump payment-service retry budget to 5 attempts`
>   > … Author: Tal Weiss … no pull request is associated with this
>   > commit. It was pushed directly to the branch without a PR."
>
> Agent also produced a sophisticated process-gap recommendation
> ("enforce branch protection on talwgx/test to require PRs before any
> commit that touches synthetic-canary/MODE reaches the cluster") —
> noticing the absence of a PR and tying it back to deploy-safety.
>
> ## Negative-data point: v1 run (without kubectl/gh hints) FAILED
>
> Transcript: `eval/reports/hero/root-cause-from-deploy/2026-05-11T15-18-53-864Z/`.
>
>   - status: PARTIAL, value_delivered: 0.00, drift: 0
>   - Agent reached for `gh` autonomously but searched the wrong repo
>     (`open-telemetry/opentelemetry-demo` — confused by the env name
>     "otel-demo"). Honest behavior: drift=0 means no fabricated
>     attribution; agent reported it couldn't resolve.
>   - Finding: the agent needs a scenario-level hint about where to
>     look. The MCP layer alone doesn't expose enough metadata (no
>     event-body access on Prometheus-only envs) to bridge the gap.
>   - **Follow-up**: when the SIEM-side retriever is wired,
>     `log10x_pattern_examples` or `log10x_event_lookup` should return
>     event bodies including `github_sha`. At that point the v1
>     scenario (no hints) becomes solvable autonomously.
>
> ## What this proves
>
> - **End-to-end attribution loop**: GitHub push → Actions OIDC →
>   AWS-EKS-Edit → kubectl apply → tenx-edge → Prometheus → MCP → agent
>   → kubectl get annotation → gh api commits → cited commit message +
>   author. No human in the loop.
> - **Multi-pillar correlation works**: the agent autonomously combined
>   kubectl + gh CLI outputs to resolve a SHA to a commit, then to a
>   process gap (missing PR).
> - **Anti-hallucination defenses hold**: drift=0 on both runs. The
>   failed v1 run did NOT fabricate a SHA / repo / commit — it reported
>   that it couldn't bridge the gap, which is the correct behavior.
> - **The harness is now end-to-end falsifiable**: any future test can
>   push to `talwgx/test` with a new MODE or new emitter logic, watch
>   the planted signal flow, and measure whether agents can attribute
>   it.
>
> ## Files in tree
>
>   - `eval/counterfactual/k8s/synthetic-canary.yaml` (Phase 2,
>     continuous canary)
>   - `eval/counterfactual/k8s/fresh-burst-job.yaml` (Phase 2.5,
>     short-burst newly-emerged validator)
>   - `eval/fixtures/hero/root-cause-from-deploy.json` (Phase 3, this
>     section)
>   - GitHub repo: `talwgx/test/synthetic-canary/` (Phase 3 deploy
>     source-of-truth)
>
> ## How to re-run / tear down
>
>   - **Re-deploy in bug mode**: in `talwgx/test`, write `bug` to
>     `synthetic-canary/MODE` and push. Actions deploys ~30s later.
>     New `github_sha` flows through the pipeline within ~90s of pod
>     start.
>   - **Quiet the canary**: write `baseline` to the MODE file and push.
>     Pod re-rolls; emits INFO heartbeats only.
>   - **Full teardown**: `kubectl delete deploy synthetic-canary-app -n
>     otel-demo` + `kubectl delete configmap synthetic-canary-script -n
>     otel-demo`. The IAM role + EKS access entry can stay (no cost,
>     namespace-scoped).

---

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
> ## Volume tuning + algorithmic constraint findings (2026-05-11 afternoon)
>
> Bumped the canary rate from 0.5 → 2.0 ev/s (~170k events/day, <1%
> of demo env volume) to see if it cracks ranking-based scenarios.
>
> | Scenario | 0.5 ev/s | 2.0 ev/s | Notes |
> |---|---|---|---|
> | `error-critical-events` | PASS, canary at rank #3 in CRITICAL | (not re-run) | Severity-filter ensures canary surfaces regardless of rate |
> | `error-investigate-pattern` | PASS but on natural #1 ERROR | (not re-run) | Canary at any rate < natural OTLP ERROR volume |
> | `stability-newly-emerged` | FAIL (pattern_match 0.67), canary not surfaced | FAIL (value_delivered 0.65), canary STILL not surfaced | Algorithmic constraint discovered — see below |
>
> **Newly-emerged detection has a hidden 1h-ago-offset constraint.**
> The MCP's `log10x_top_patterns` newly-emerged section uses the query
> `rate(...{...}[5m]) > 0.001 unless on (pattern) rate(...{...}[5m] offset 1h) > 0`
> — meaning a pattern only qualifies as "newly emerged" if it has
> positive 5m rate AND zero rate 1h ago. A canary that's been running
> for >1h becomes "established" by definition; the algorithm correctly
> excludes it from the newly-emerged section.
>
> **To exercise newly-emerged detection with synthetic canaries**, the
> canary deployment must be FRESH (<5min old, no prior history in the
> 1h-offset window). Future counterfactual specs targeting
> `stability-newly-emerged` should deploy a one-shot Job that runs for
> 3-5 min and then exits — not a continuous Deployment.
>
> ## Short-burst Job validation (2026-05-11 late afternoon)
>
> Implemented the prescription above: see
> `eval/counterfactual/k8s/fresh-burst-job.yaml`. A k8s Job runs a
> Python emitter for 3 min at 3 ev/s (540 events total), with a
> message template guaranteed unique to the env
> (`FRESH_BURST canary newcomer pattern probe never seen before
> ts=… run=… idx=…`). `ttlSecondsAfterFinished: 600` self-cleans.
>
> Confirmed end-to-end:
>
> - Pod → fluentd → tenx-edge → Prometheus visible at ERROR rank
>   #13 as `pattern probe never seen before ts run idx synthetic
>   canary burst run id idx` ($0.0003/wk) within ~90s of `kubectl
>   apply`.
> - `stability-newly-emerged` re-run during the burst window:
>   **PASS**, value_delivered **0.85** (up from 0.65 with the
>   continuous canary), drift 0, value_received 0.70.
> - Transcript at
>   `eval/reports/hero/stability-newly-emerged/2026-05-11T14-37-46-592Z/`.
>
> **Honest finding** — even with an algorithmically-valid fresh
> burst, the agent did NOT surface the canary itself as one of its
> top-3 newly-firing patterns. Instead it correctly named the
> natural otel-demo memory-pressure cascade (UNAVAILABLE export
> failures at +82% / +60% / +30% with the same 14:10 UTC
> inflection point). Reason: the fresh-burst pattern's absolute
> volume (~150KB over 3 min) is below the threshold at which the
> newly-emerged section ranks it against multi-MB top-movers in a
> live demo env. The agent's behavior is correct — drift=0 means
> no fabrication — but the harness DOES NOT yet force the agent
> to pick the planted signal over real incidents in the same
> window.
>
> **Next step for full counterfactual coverage** of newly-emerged:
> either (a) bump burst rate to ~30 ev/s × 3 min for a 5400-event
> burst that competes with natural top-movers on absolute volume,
> or (b) author a scenario that queries by service/label filter
> rather than top-N (`log10x_top_patterns({ service: "fresh-burst-canary" })`
> would surface the canary directly).
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
