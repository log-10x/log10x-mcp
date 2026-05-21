# Cross-Pillar Deep-Test & A/B/Grader Comparison Log

Persistent record of validating `log10x_correlate_cross_pillar` against a
real OTLP→Prometheus metric store, the engine fixes it drove, and the
no-log10x-SRE comparison. **Do not revert the incident / restart the
in-cluster Prometheus while iterating** (see Incident protocol).

## Test bed

- **Demo**: otel-demo on EKS `log10x-otel-demo` (account 351939435334, us-east-1).
  Reach via `aws eks update-kubeconfig --region us-east-1 --name log10x-otel-demo --role-arn arn:aws:iam::351939435334:role/demo-deploy-role`.
- **Logs pillar**: pod logs → `tenx-fluentd` → log10x engine → CloudWatch
  `/log10x/otel-demo` + log10x metrics at `prometheus.log10x.com`
  (demo creds `d02ad247-1e32-49ee-918d-93467ba8b134/6aa99191-f827-4579-a96a-c0ebdfe73884`,
  header `X-10X-Auth: <apiKey>/<envId>`). Pattern volume metric:
  `all_events_summaryVolume_total{message_pattern=...,tenx_user_service=...}`.
- **Metrics pillar (the missing sink we added)**: the otel-collector was
  already pushing OTLP metrics to `http://prometheus:9090/api/v1/otlp`, but
  no `prometheus` service existed (stripped demo — same reason `opensearch`
  is absent and the #1 log pattern is a "no such host" loop). We deployed
  it: `eval/cross-pillar-demo/prometheus.yaml` (OTLP receiver +
  `otlp.promote_resource_attributes` so metrics carry `k8s_namespace_name`,
  `k8s_deployment_name`, `k8s_pod_name`, `service_name`).
- **MCP → metrics**: `kubectl -n otel-demo port-forward svc/prometheus 9090:9090`
  then `PROMETHEUS_URL=http://localhost:9090` (generic_prom backend).
  The port-forward dies between shells; restart it before each run.

## Engine fixes this deep-test drove (all committed, branch feat/eval-harness)

| Commit | Fix | Unblocked |
|---|---|---|
| `e9b7c43` | Name-aware join rescue | cross-pillar *fires* in OTLP envs (was `no_join_available`) |
| `b0a9699` | Multi-granularity candidate gen + service-scoped enum + empty-series guard + OTLP alias names | the right pod/service metrics *surface* |
| `43ee58e` | `#4` rate() counter candidates | cumulative counters stop spuriously correlating |
| `acb6300` | `#5` widen rate window to ≥3×step; `#6` rank real co-movers above flat structural matches | anchor/candidate series populate; real signal leads |

## Findings & status

- **`#3` (OPEN — deferred, needs an error incident)**: candidate metrics are
  summed over ALL label values, so a signal localized to a sub-label (e.g.
  `status_code=ERROR`) is diluted by steady OK traffic. → Use **load**
  incidents (signal in the summed total), not error incidents, until `#3` is
  fixed (label-aware candidate splitting). Not implemented this pass: the live
  bed is a load incident (signal in the summed total) so `#3` isn't exercised
  here, and the run-3 grader instead named `#10` (topology) as the
  higher-value remaining lever. Implementing `#3` blind would be "code in a
  vacuum" — defer until a `status_code=ERROR` burst is engineered to validate
  against.
- **`#7` + `#7b` (FIXED — `89c68fa`)**: lead/lag was a rate-window artifact.
  The `[≥3m]` rate window (forced by ~60s scrape resolution) right-smears a
  step ~one window, so cross-correlation peaks at a uniform offset → spurious
  "leads/trails 60s". Fix: report a direction only when the metric moved AND
  the offset exceeds the smoothing resolution; else concurrent. (`#7b`: also
  suppress lag on flat metrics — a 300s peak leaked through on a non-mover.)
- **`#8` (FIXED — `89c68fa`)**: flat metrics promoted to "confirmed". Pearson
  scores SHAPE not magnitude and `volume` was hardcoded 1.0. Fix: real
  `volume = relativeSpread(series)`; `pickTier` requires a genuine co-mover
  (moved AND temporal≥min) for confirmed/service-match — structural overlap
  without movement demotes to coincidence (grader called the volume
  sub-score "a genuinely sound design").
- **`#9` (FIXED — family-dedup + app-quota + confidence reweight)**. The
  confirmed tier was CPU-flooded: 4 near-duplicate CPU representations
  (`container_cpu_time`, `k8s_pod_cpu_time`, `k8s_pod_cpu_usage`,
  `container_cpu_usage`) crowding out the app request-path, all crushed to
  ~21% by a lag-tightness term in the confidence formula. Fix in
  `cross-pillar-correlate.ts`: (a) `metricFamily()` collapses near-duplicate
  families (entity-prefix normalize + representation-suffix strip → 4 CPU
  reps map to one `pod:cpu`) BEFORE spending the candidate budget, plus a
  post-scoring backstop; (b) 3-tier candidate ordering (app-path 0 >
  infra-diagnostic 1 > generic 2) so the request-path is evaluated, not
  crowded out; (c) `#4` confidence reweight — lag is a [0.7,1.0] modifier,
  not a `max(0.2,lag)` gate that crushed genuine co-movers to 21%; (d) `#4`
  per-candidate evidence line (`moved (spread X) · rate 3m`) + a full
  re-runnable PromQL `query:` line + metric-name headline (not a truncated
  blob). **Validated** (run 3, sub-agent grader): confirmed tier went from 4
  CPU clones to the cart causal chain (`traces_span_metrics_calls_total`,
  span duration, `app_cart_add_item_latency`, `http_server_request_duration`);
  GC churn correctly demoted to coincidence (huge spread but temporal 0.13 —
  moved yet doesn't track). Tool 31→43/60 (+12), gap to manual SRE 14→2.
- **`#10` (OPEN)** — topology / datastore-ownership awareness (the next
  lever; the grader named it as the remaining SRE edge). After `#9`, the SRE
  still wins depth 10 vs 4 because it knows the *topology*: valkey-cart is
  cart's **exclusive** downstream datastore (genuine trails-cart effect),
  the frontend is the leading entry point, and the parallel-journey services
  (checkout/payment/shipping) co-move only as **common-cause siblings**
  driven by the same load-gen — NOT caused by cart. Cross-pillar is
  structurally scoped to the anchor's own deployment, so it can't currently
  reach the exclusive-datastore or upstream-entry relationships. → Add
  datastore-ownership / call-graph awareness (e.g. surface a downstream that
  ONLY the anchor service talks to) and a lead/lag-by-dependency story.
  Distinct from `#3` and larger; logged for a future iteration.

## Incident protocol

- **Induce** (load): `kubectl scale deploy/load-generator -n otel-demo --replicas=4`. Record T.
- **Revert**: `--replicas=1` (only when fully done iterating).
- The correlation window MUST span the ramp at T. Don't restart the
  in-cluster Prometheus (emptyDir → wipes metric history).
- Anchor used: cart's request-log pattern
  `cart_cartstore_ValkeyCartStore_GetCartAsync_called_userId`
  (cart is a Deployment, joinable; high request volume from the frontend).

## Validated result (prior run, T3=2026-05-21T15:59Z, 4× load)

Cross-pillar on the cart GetCart log pattern, confirmed tier (structural 1.0):
`http_server_request_duration` temporal **0.95** (concurrent), memory_rss
**0.93** (trails 60s), cpu_usage **0.56** (leads 120s); non-moving metrics
correctly **0.00**.

## A/B/Grader comparison (in progress)

- **A** = `log10x_correlate_cross_pillar` output → `/tmp/xpillar-A-log10x.md`
- **B** = no-log10x SRE sub-agent (given BOTH pillars — CloudWatch logs +
  the Prometheus — and the same window; correlates by hand) → `/tmp/xpillar-B-sre.md`
- **Grader** = fresh no-stake sub-agent, cross-pillar rubric
  (correlation correctness · lag/direction depth · hallucination-resistance ·
  time-to-answer · durability · signal-to-noise).

### Run 1 — 2026-05-21, incident T=16:34:02Z, 4× load on cart, window 20m

Artifacts: `/tmp/xpillar-A-log10x.md` (tool, 1 call ~1s), `/tmp/xpillar-B-sre.md`
(SRE by hand, ~12 min / ~30 queries).

**Grader (fresh, no-stake) scores:**

| axis | A (log10x) | B (SRE) |
|---|--:|--:|
| Correlation-correctness | 4 | 9 |
| Depth | 3 | 9 |
| Hallucination-resistance | 3 | 8 |
| Time-to-answer | 10 | 4 |
| Durability | 8 | 4 |
| Signal-to-noise | 6 | 7 |
| **TOTAL** | **34/60** | **41/60** |

**Verdict:** B (manual SRE) wins, decisively on the central axis (correctness).
The tool is an excellent ~1s triage layer (ranked suspects + re-runnable PromQL +
stable join provenance) but its correlation verdicts can't be trusted at face
value: it reported a spurious lead/lag (`#7`) and promoted five flat memory
metrics to "confirmed co-movers" (`#8`). B was right that the relationship is
synchronous. Both `#7` and `#8` are now logged above.

**Grader's one fix for A:** gate "confirmed" by real temporal magnitude (not
structural/volume label-overlap), and flag a uniform per-metric lag ≈ the rate
window as an artifact rather than emitting "leads/trails 60s".

**Status of this run's incident:** still LIVE (load-generator=4) — not reverted,
so we can iterate (fix `#7`/`#8`, re-run A on the same incident).

### Iteration log

| # | incident T | what changed in the engine | grader A / B | key finding |
|---|---|---|--:|---|
| 1 | 16:34:02Z | baseline (post #4/#5/#6) | 34 / 41 | tool fast+durable but lag is artifact (#7), flat metrics confirmed (#8) |
| 2 | 16:34:02Z (same incident) | #8 magnitude-gated tiers + #7/#7b suppress artifact lag (`89c68fa`) | 45 / 47 | gap 7→2; fixes validated (volume sub-score "sound design"; lags now synchronous; memory→coincidence). New OPEN finding: #9 depth/redundancy (CPU-heavy confirmed tier, misses app request-path) |
| 3 | 16:34:02Z (same incident) | #9 family-dedup + app-path quota + #4 per-candidate evidence + confidence reweight | 43 / 45 (pre-fix V1 31) | **#9 validated**: confirmed tier CPU-clones → cart causal chain (span calls/duration, app_cart latency, request duration); GC→coincidence (moved spread 7.47 but temporal 0.13, doesn't track); tool **31→43 (+12)**, gap to SRE **14→2** (per-axis: correctness 4→7, depth 2→4, signal-to-noise 3→7, durability 6→8). New OPEN: **#10** topology/datastore-ownership (SRE still wins depth via valkey-exclusive-datastore + common-cause-sibling separation). Grader run via **sub-agent (no API key)** — see methodology note. |

_Note: graders are fresh per run and calibrate differently (run-2 grader scored B 41→47 too), so compare A's per-axis movement, not raw totals. Run 1→2 on A: correctness 4→7, hallucination-resistance 3→7, depth 3→5, durability 8→9._

_Run-3 methodology — the A/B/grader loop is now scripted as a gate
(`eval/bin/run-tool-vs-sre.mjs` + `eval/src/tool-vs-sre.ts`, validation gate
#5). It runs two ways: (a) via the Anthropic SDK for unattended/CI use (needs
`ANTHROPIC_API_KEY` + credit), (b) via **session sub-agents** for interactive
runs — no metered key, the same methodology that produced the run-1/2
baselines. Run 3 used the sub-agent path (the API key's credit was exhausted
mid-run) and graded BOTH the pre-fix and post-fix tool output on one
consistent grader, giving a true before/after (V1 31 → V2 43) plus the
tool-vs-SRE comparison (43 vs 45), all immune to the per-run grader-calibration
drift. A first scripted-API run also surfaced + fixed a harness bug: the SRE
arm scored 1/60 for hitting its turn cap without synthesizing — now forced to
deliver a final ranked answer when the budget is spent._
