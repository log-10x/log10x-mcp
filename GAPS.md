# Open Gaps

**Purpose**: persistent list of known issues, architectural observations, and deferred fixes surfaced during sub-agent acceptance testing. Kept in repo so context isn't lost across sessions or compaction events. Update this file when closing an item or adding a new one.

## Open-items summary (top-of-file for quick triage)

| ID | Title | Owner | Severity | State |
|---|---|---|---|---|
| **G1** | Cloud reporter CronJob ~10% OOMKilled failure rate | Demo infra | Material | Not fixed — needs memory-limit bump + engine review |
| ~~G3~~ | Retriever LB wired but undocumented in setup docs | Docs | — | ✅ **CLOSED** — README now documents the LB URL, demo bucket, all env vars, and G12 known issues |
| **G4** | upstream opentelemetry-demo missing libgssapi-krb5-2 | External upstream | Demo hygiene | Needs upstream issue filed |
| **G5** | upstream opentelemetry-demo frontend shipping URL bug | External upstream | Demo hygiene | Needs upstream issue filed |
| ~~G6~~ | env audit +100% false flags | MCP | — | ✅ **CLOSED** via PRs #25/#26/#27 |
| **G7** | Cross-agent divergence on crashloop attribution | MCP | Material | **PARTIALLY ADDRESSED** via PRs #32/#34 recency warnings |
| ~~G8~~ | prometheus-proxy usage metric collision | Backend | — | ✅ **CLOSED** via backend PR #55 (deployed to prod) |
| **G9** | tenx-edge subprocess stale state after remote-write rejection | Engine | Material | Engine fix needed. **MCP mitigation shipped (PR #35)**: `forwarder_dark_zones` doctor check detects the signature and emits remediation hint with `kubectl rollout restart` command. |
| **G10** | Engine fingerprinter leaks high-cardinality vars into pattern identities | Engine | Material | Engine fix needed. **MCP mitigation shipped (PR #35)**: env audit collapses 3+ same-service same-delta variants into one summary row with explanation. |
| **G11** | Paste Lambda templatizer silently drops ~70% of input | Engine | **GA blocker** | Engine fix required. **MCP mitigation shipped (PR #35)**: `resolve_batch` emits prominent "N input lines not accounted for" warning when the gap is ≥20% of input, with workarounds. |
| ~~G12~~ | Retriever forensic query — false negatives + canonical-name crash | Engine | — | ✅ **PARTIALLY CLOSED 2026-04-26.** False-negative root cause identified + engine fix shipped in [pipeline-extensions#7](https://github.com/log-10x/pipeline-extensions/pull/7) — `_DONE.json` reason field was misclassifying remote-dispatch queries as `"empty-range"` because the coordinator's local atomics never aggregate from remote scan workers (different processes). Fix branches the reason classifier on dispatch mode + adds `"dispatched"` state. **The other sub-symptom (-32000 crash on long canonical names) is no longer reproducible** on current engine — verified with 117 / 500 / 5000-char names, all returned HTTP 200. The original false-negative S7 saw on 2026-04-15 (live shipping pattern returning 0 events) cannot be re-verified — S7's QIDs expired from S3 and the indexer is no longer wired to live cluster logs. |
| **G13** | Investigate ranks historical cost, not current firing | MCP | Material | **PARTIALLY ADDRESSED** via PRs #32/#33/#34 |

**Next steps for GA**:
1. File engine tickets for G11 and G12 with verbatim evidence already captured below
2. Ship MCP-layer mitigations for G9, G10, G11, G12 (this session)
3. Raise cloud-reporter memory limit (G1) — 2-line demo infra change
4. File upstream opentelemetry-demo issues for G4, G5 (public bug reports)
5. Run the cross-model validation test matrix (`docs/CROSS_MODEL_TEST_SPEC.md`) once engine substrate is stable

Last update: session 2026-04-15 (continued). **34 MCP PRs merged (#6–#34) + 3 backend PRs (#54, #55)**. PR #32 shipped investigate recency warning (G7/G13 partial); PR #33 shipped top_patterns newly-emerged section (addresses S10 canary-miss); PR #34 propagated recency warning to flat-path report (S16 residual). Cross-model test spec written at `docs/CROSS_MODEL_TEST_SPEC.md` with full ground truth and Claude baselines for GPT/Grok/Gemini/DeepSeek comparison.

**Earlier**: PR #31 fixed cross-pillar correlation (S8). PR #30 fixed event_lookup regex escaping (S4) and investigate long-window routing (S6). PR #31 fixed cross-pillar correlation (S8) — structural passthrough + pod-level candidate filtering, took accounting→Kerberos test from 0 candidates → 16 Tier 1 matches. Second sub-agent battery (S4-S9, 6 scenarios) against live otel-demo:
- **S4 paste-triage**: found event_lookup 400s on raw lines (fixed #30) + resolve_batch silently drops 70% of input (engine-side templatizer bug, documented G11)
- **S5 orientation briefing**: 6 tools composed cleanly, totals reconcile across services/top_patterns/list_by_label. Strong positive signal
- **S6 drift**: caught investigate 30d-window blindness (fixed #30)
- **S7 retriever forensics**: reproducible false-negative (0 events returned for windows where metrics prove events exist) + MCP -32000 crash on canonical pattern name. Engine/retriever-side issue, documented G12
- **S8 cross-pillar APM wedge**: 0 candidates on canonical test (fixed #31 — 16 Tier 1 matches now)
- **S9 resolve_batch stress**: confirmed S4's templatizer bug with detailed failure taxonomy (engine-side)

 PR #29 fixed savings credibility bug (emitted=0 no longer counted as realized savings) and `<owner>` placeholder in verification commands. Post-G8 sub-agent battery (3 scenarios) against real otel-demo:
- **S1 biggest-grower**: surfaced real top mover with honest 20% low-confidence, caught real floor-amplification interpretation nuance (worth watching; not a bug but the UX could be clearer when absolute rates are near the floor)
- **S2 cost-cutting**: surfaced $559K/mo in cut candidates, flagged the savings credibility bug — now fixed in PR #29
- **S3 accounting crashloop**: reached 90% confidence correct Kerberos diagnosis on call #1. Quote: "MCP verdict: the tool chain DID lead to the correct answer on call #1. A textbook SRE who trusts kubectl describe ('OOMKilled') would bump memory and stay broken; top_patterns surfacing the CRIT linker error on the very first call is exactly the structural wedge that prevents the wrong fix." **This is the GA differentiation story, validated by an independent agent with no session memory.**

 PR #28 fixed 4 compounding service-mode investigate bugs that caused it to disagree with env-mode on identical data (anchor by absolute rate not delta; kebab-case regex; classifyTrajectory hardcoded 7d baseline; acute threshold too strict at >1.0). PR #27 fixed correlate baseline-only floor. PR #26 fixed sign loss in environment audit. **G8 CLOSED via backend PR #55** (prometheus-proxy Lambda adds instance label to tenx_usage_* metrics) — deployed to prod at 16:58 UTC. **Operational note (G9)**: Lambda fix alone was not sufficient — tenx-edge subprocesses accumulated stale state during the pre-fix OOO rejection period, and a DaemonSet rollout restart was required to resume metric flow. Earlier: PR #22 shipped sub-day timeRanges (`15m`/`1h`/`6h`) on five tools after agent scenario 3 identified the gap live. G2 (log replay), F3a (exec_filter format), F3b (fluentd nodeSelector) all CLOSED. Cross-pillar validated end-to-end against real opentelemetry-demo — 5 sub-agent scenarios, all 12/12, one of which found a real upstream bug in the `accounting` service image.

---

## Category A: Real bugs with partial or deferred fixes

### A1. Savings chunk coverage — server-side root cause
**Status**: PR #12 surfaces partial-coverage honestly, PR #13 documents that client-side throttling does NOT help. The Final-1 audit finding is **symptom-fixed but not root-caused**.

**What we know**: the `retrieverIndexedBytesChunk` queries intermittently hit Prometheus's 5GB aggregation limit with `HTTP 422: expanding series: the query hit the aggregated data size limit`. Failures are **deterministic per chunk**, not caused by client concurrency (tested: throttling to 6 concurrent quadrupled wall time 90s→370s with zero coverage improvement, 37/60 chunks in both cases).

**Why it matters**: the savings tool's headline number can be 10× undercounted without the coverage annotation. Customer acceptance test (Final-1) caught an internal inconsistency ($12.7M run-rate note text vs $14.4M standalone 7d call); we verified the standalone 7d numbers were real, but the 30d internal 7d computation was using partial data silently.

**What would fix it (out of MCP scope)**:
- Raise the Prometheus `query.max-samples` / aggregation limit server-side
- Split the `indexed_events_total` high-cardinality metric (~12k active series) across more scrape targets or pre-aggregate
- Add a pre-computed daily rollup metric (e.g., `indexed_events_daily_total`) that sums per-day at scrape time, letting the client do a single `sum(rate())` without the big aggregation
- Client-side alternative: sub-chunk the offset=0d day into 4×6h queries (smaller per-query series footprint). I tested this in isolation (all 4 sub-chunks worked) but did not wire it into savings.ts because the sub-chunk approach needs a retry path for offsets that still exceed the limit and the coverage annotation from PR #12 is "good enough" for honest output.

**If a customer hits this, what to tell them**: "The tool is reporting partial data honestly. Retry in 30s for a cleaner number. The underlying cause is a server-side aggregation limit on your Prometheus backend; raising it or reducing the indexed metric's series cardinality is the long-term fix."

### A2. Sub-day windows in cost_drivers
**Status**: PR #10 added `baselineOffsetDays` but the `timeRange` enum is still `1d/7d/30d`. Hard-2 sub-agent asked for T-2h snapshot comparison — the closest path is `investigate` with anchor semantics, not a clean ranking.

**Why it matters**: deploys typically land at hour granularity, not day granularity. A "since this deploy 2 hours ago" comparison is a legitimate real-world question the tool can't answer cleanly.

**What would fix it**:
- Expand the `timeRange` enum to include `1h`, `6h`, `12h`, OR accept a free-form PromQL range string (`2h`, `45m`, etc.) with validation
- Update the cost_drivers baseline math to handle sub-day windows — specifically, the 3-window-average default needs sensible behavior when `tf.days` is fractional
- Add a test for the `baselineOffsetDays: 0.083` (2h) case

**Workaround for agents now**: use `log10x_investigate` with `window: "2h"` and `baseline_offset: "2h"`, which does exactly this comparison but via the investigate path. Hard-2 agent found this workaround independently.

### A3. `dependency_check` returns a command, not a scan result
**Status**: PR #7 added a `NO SCAN HAS BEEN RUN` banner to make this explicit, so agents no longer risk reporting "zero dependencies" based on the tool output alone.

**Why it's still a gap**: the banner prevents misinterpretation but doesn't enable the feature itself. A real customer still has to run `siem-check-datadog.py` locally with their DD credentials and paste results back. For a complete "safe to drop" verdict the tool would need to **actually execute the scan**.

**What would fix it**:
- Option 1: let the MCP accept credentials and execute the scan in-process (security concern — credentials flow through the MCP process)
- Option 2: add a companion MCP that bundles the siem-check scripts and is invoked after the user authorizes it
- Option 3: have the main LLM client run the scan via a separate tool (e.g., have the agent use its bash tool to curl the script + execute) — but this requires the agent to have bash and credentials locally, which isn't always true

**If a customer asks "why can't the tool just do it"**: "Dependency scanning requires your SIEM's live credentials. We don't accept those into the MCP process because that would make us a target for credential theft. The tool gives you the exact command to run — takes 30 seconds locally against your own credentials."

### A4. Run-rate note threshold hardcoded at 2×
**Status**: pre-existing, not my session. `annual7d > annualProjection * 2` is the condition that fires the ramp-up warning.

**Why it's a gap**: 2× is an arbitrary threshold. An environment that's growing 1.8× on a 30d view is still notably ramping, but the tool would silently say nothing. Conversely, a noisy demo environment might cross 2× on random day-to-day variance without genuine growth.

**What would fix it**: expose as a tunable parameter (`runRateFlagRatio?: number = 2.0`) or make it percentile-based relative to historic variance.

**Effort**: low. Deferred because no customer or agent has complained about the threshold yet.

---

## Category B: Infrastructure gaps (demo env, not MCP code)

### B1. Retriever not wired in demo env
**Evidence**: S1 (auth forensics), S6 (connection pool), Hard-1 (73-day exfil) — all hit `__SAVE_LOG10X_RETRIEVER_URL__` unset. Verbose error message from PR #9 handled it gracefully but the forensic use-case is untested end-to-end.

**Resolution paths**:
- Wire `__SAVE_LOG10X_RETRIEVER_URL__` + `__SAVE_LOG10X_RETRIEVER_BUCKET__` in the demo env config so forensic scenarios have a happy path
- OR update the demo env documentation to say "Retriever is intentionally disabled in the demo, use Reporter metrics only"

This is **demo env infrastructure work**, not MCP code work.

### B2. Cross-pillar (customer metrics) not wired in demo env
**Evidence**: Reconnaissance sub-agent confirmed `LOG10X_CUSTOMER_METRICS_URL` is unset. Four cross-pillar tools (`customer_metrics_query`, `discover_join`, `correlate_cross_pillar`, `translate_metric_to_patterns`) are built but dormant.

**Why this is a blocker for the "APM wedge" claim**: the v1.4 cross-pillar bridge is the MCP's differentiating feature vs every other agent observability tool ("temporal + structural validation on the pattern universe"). We can't test it in the demo env, and we can't run cross-pillar sub-agent scenarios, so the claim is currently **unvalidated by acceptance testing**.

**What would enable testing**:
- Stand up a Prometheus-compatible metric backend next to the demo env (generic_prom, amp, grafana_cloud, or datadog_prom) with real OTel k8s metrics (container CPU/memory, pod restarts, HTTP latency histograms)
- Ensure the demo env's Reporter tier emits the v1.4 enrichment labels (`k8s_pod`, `k8s_container`, `k8s_namespace`, `tenx_user_service`) so the Jaccard join discovery has something to match on
- Set the env vars on the demo MCP install
- Re-run the sub-agent test suite with cross-pillar scenarios added

**Effort**: medium-high. Requires deploying + scraping + configuring a second metric backend. This is the **next big workstream** once logs-only MCP is locked.

### B3. Demo env payment service has no business logs
**Evidence**: Hard-3 sub-agent investigation. Payment service emits only OTel SDK boilerplate (`process.runtime.name nodejs`, `host.name payment`, `service.version`, one `gRPC server started` line) — **zero application-level log records**.

**Implication**: when a user reports a payment decline, the log pipeline has nothing to find. The decline is in an OTel span with `error=true` attributes, but not in a log record. Any "where's my payment error" investigation against this env returns empty.

**Resolution paths**:
- (Fix the demo): add real application logs to the payment service so investigation scenarios work end-to-end
- (Teach with it): document as a known architectural anti-pattern and have the MCP detect it proactively — see C2 below

---

## Category C: Product opportunities (features, not bugs)

### ~~C1. Silent service detection in doctor~~ ✅ SHIPPED in PR #15
Implemented as `silent_services` check in `doctor.ts`. Uses percentile ratio (service volume <100× below environment median) rather than a boilerplate regex, so it works on any service naming convention. Verified on demo env: surfaces 4 services not previously discovered by any sub-agent.

### ~~C2. Severity distribution sanity check~~ ✅ SHIPPED in PR #15
Implemented as `severity_distribution` check in `doctor.ts`. Flags environments >99% INFO with ~0 errors. Healthy envs get the PASS path. Verified on demo env: returns PASS with 24% INFO, 9.6% error-class.

### ~~C3. Cardinality concentration warning~~ ✅ SHIPPED in PR #15
Implemented as `cardinality_concentration` check in `doctor.ts`. Flags when top-1 pattern is >40% of spend or top-5 are >70%. Verified on demo env: fires at 54% top-1 (the otelcol DEBUG self-telemetry pattern).

---

## Category F: Retriever engine issues (out of MCP scope, need upstream fixes)

### F1. Retriever server's TenXDate ISO8601 parser is broken
**Severity**: high. Silently produces wrong query windows on a documented-supported input format.

**Evidence (2026-04-15, demo env deployment)**:
| Format | HTTP | Events matched (same wall-clock hour) |
|---|---|---|
| `now("-1h")` | 200 | 894 |
| Epoch millis string | 200 | 3400 |
| `2026-04-15T11:00:00Z` (ISO8601) | 200 | **0** |

**Expected**: ISO8601 should work per retriever-api.ts comment ("The engine evaluates these as JavaScript on the server via TenXDate, so `now("-1h")` / `now()` / ISO8601 strings / epoch millis all work"). Empirically, ISO8601 silently produces a non-matching window.

**MCP workaround**: PR #17 converts any non-`now()`, non-pure-digit input to epoch millis client-side via `Date.parse()` before submitting. After workaround: same ISO8601 query → 685 events.

**Real fix**: the retriever server's TenXDate parser needs to handle ISO8601 strings correctly. Live in `com.log10x.ext.quarkus.retriever.*` — find where `from`/`to` get parsed and see why the ISO8601 path produces a bad range.

### F2. Retriever query API strict-rejects unknown body fields
**Severity**: medium. Breaks obvious client patterns.

**Evidence**: sending `{"format":"events","limit":3}` in the query body produces HTTP 400 with empty body. The MCP tool works around it by NOT sending these fields (it applies format/limit client-side after reading S3 results).

**Why it matters**: any customer building an integration against `/retriever/query` who passes standard REST-ish fields will hit 400 with no error message. The server should either:
- Accept unknown fields and ignore them (standard REST behavior)
- Return HTTP 400 with a descriptive error body explaining which field is invalid

Current behavior is the worst of both: strict rejection AND no diagnostic.

### ~~F3a. tenx-edge exec_filter format=single_value~~ ✅ CLOSED 2026-04-15 (backend PR #54)
**Original characterization was wrong**. On deeper inspection, the `format: single_value, message_key: log` config is NOT an engine default — it lives in the demo env's values file (`backend/terraform/demo/values/tenx-optimizer-demo.yaml`), with a comment explicitly saying *"to directly pass data from the log simulator pod instead of overriding key fields"*. It was a deliberate demo-specific optimization for the JSON-wrapped replay sample. The upstream fluentd chart default does NOT hardcode this — it uses the standard `@KUBERNETES` label routing.

The real issue was that when we swapped the demo from log-simulator to real opentelemetry-demo, the demo values file still carried the replay-era configuration. Fixed in backend PR #54: values now use `format: json`, widen source path to `/var/log/containers/*_otel-demo_*.log`, and route via `@KUBERNETES` so the `kubernetes_metadata` filter actually injects pod/namespace/container fields.

### F3a-legacy. (for history)

**Evidence**: the `00_tenx.conf` fluentd config used by the demo fluentd install has:
```yaml
<format>
  @type "single_value"
  message_key log
  add_newline false
</format>
```
This sends ONLY the string value of the `log` field to the tenx-edge child process. That works for the canned S3 log replay sample (`log10x-public-assets/samples/otel-k8s/large/input/otel-sample.log`) because its content IS a JSON blob (`{"stream":"stderr","log":"...","kubernetes":{...}}`), so tenx-edge's JSON extractor parses it recursively and finds the nested fields.

On REAL Kubernetes CRI container logs, the `log` field is plaintext (`info: cart.cartstore.ValkeyCartStore[0]`). tenx-edge's edge optimizer pipeline is configured to run a JSON extractor on the incoming stream, which crashes with:
```
jakarta.json.stream.JsonParsingException:
  Invalid token=NUMBER at (line no=1, column no=7, offset=6).
  Expected tokens are: [COMMA]
```
and the entire batch is dropped. No events reach log10x.

**Workaround** (applied live in demo env during session): change `<format>` to `@type "json"` — fluentd then serializes the full structured record (including the `kubernetes.*` fields injected by the `kubernetes_metadata` filter) and tenx-edge's JSON extractor receives a valid JSON document with the expected shape.

**Real fix** (engine work, out of MCP scope): the tenx-edge edge optimizer's input pipeline should accept plaintext logs directly, not require JSON-formatted input. The current config assumes fluentd's output is JSON-shaped, which is a hidden coupling that breaks silently on any real customer forwarder setup that uses `format: single_value`.

**Customer impact**: any customer who deploys the demo's fluentd helm chart against their own k8s cluster (not the replay sample) will hit this with zero diagnostic signal — fluentd says "flowing", tenx-edge says "running", but `prometheus.log10x.com` shows zero events. **This is a GA blocker for the out-of-box forwarder path**.

### ~~F3b. tenx-fluentd nodeSelector workload=edge~~ ✅ CLOSED 2026-04-15 (backend PR #54)
Same fix — backend PR #54 removes the nodeSelector from the demo values file. DaemonSet now runs on all nodes, matching the upstream chart default. 4 of 5 fluentd pods run in the cluster (5th is Pending due to a pod density cap on one node — that's unrelated to the chart config).

### F3b-legacy. (for history)

**Evidence**: the tenx-fluentd helm chart sets `nodeSelector: workload=edge` on the DaemonSet. In the demo env, only 1 of 5 nodes has that label, so fluentd runs on only 1 node. Any pods scheduled to the other 4 nodes have their container logs completely ignored (fluentd tails `/var/log/containers/` which is node-local). In the otel-demo swap, 24 of 27 pods were on unfluentd-ed nodes.

**Workaround** (applied live): `kubectl patch ds tenx-fluentd --type=json -p='[{"op":"remove","path":"/spec/template/spec/nodeSelector"}]'`.

**Real fix**: the helm chart default should be no nodeSelector (run on all nodes like any log forwarder DaemonSet). If a customer wants to limit fluentd to specific node pools, that should be a helm value they set explicitly, not a baked-in default.

### F3. Retriever aggregation limit (5GB) on bleeding-edge day
**Severity**: medium. See GAPS A1 for MCP workaround; the root cause is server-side. `retrieverIndexedBytesChunk` at offset=0d intermittently hits `HTTP 422: expanding series: the query hit the aggregated data size limit (limit: 5000000000 bytes)` under concurrent load. PR #12 added coverage annotation as client-side safety net, but the real fix is server-side: raise the limit, pre-aggregate the high-cardinality metric, or split the retriever's indexed metric across more scrape targets.

---

## Category G: Demo env infrastructure issues

### G1. Cloud reporter cronjob ~10% failure rate (OOMKilled)
**Severity**: high. The cloud reporter is the metric producer for the entire MCP experience. A ~10% failure rate means 10% of 5-minute intervals are metric-blind.

**Evidence**: Checked `kubectl get jobs -n demo | grep cloud-reporter` on 2026-04-15. Out of ~28 recent jobs:
- Job 29603280 (16h ago): 3 pods all OOMKilled
- Job 29603640 (10h ago): 4 pods all failed
- Job 29604200 (51m ago): 1 failed pod
- Remaining jobs: Complete

**Root cause**: the cloud reporter pod has `memory: limits 2Gi, requests 1Gi`. Reading the 500MB / 500k-event / 4min-duration S3 sample through the tokenization + pattern-fingerprinting + enrichment pipeline apparently pushes heap close to 2Gi. GC timing determines whether the job survives. Logs of a failed run show backpressure firing at t+13s (QueuedObjects limit 95000) followed by OOMKill under 2Gi.

**Short-term fix (demo infra)**: raise memory limit in `backend/terraform/demo/values/tenx-cloud-reporter.yaml:62` from `2Gi` to `4Gi`. Two-line change.

**Medium-term fix (engine)**: the engine should stay within bounded memory regardless of batch size. 500k events shouldn't require >2Gi. Investigate why the pipeline heap footprint scales with input rate — likely suspects are (a) `QueuedObjects` buffer sizing, (b) retained pattern fingerprints accumulating, (c) enrichment lookups caching every symbol.

### ~~G2. The "otel-demo" in the demo env is a LOG REPLAY~~ ✅ CLOSED 2026-04-15
Was a log replay. Now replaced with a real `opentelemetry-demo` helm deployment (27 pods in `otel-demo` namespace) — cart, payment, checkout, frontend, kafka, otel-collector, etc. running for real. Log-simulator scaled to 0, cloud-reporter cronjob suspended.

**What the swap took** (in order; each step surfaced a real engine issue):
1. Deploy `open-telemetry/opentelemetry-demo` helm chart with bundled observability disabled (we use kube-prometheus-stack separately)
2. Scale `log-simulator` deployment to 0 (stop the replay)
3. Suspend `tenx-cloud-reporter-cron-10x-cloud-reporter` (stop the S3 sample read)
4. **Remove `nodeSelector: workload=edge` from tenx-fluentd DaemonSet** — was pinned to 1 node, missed 24 of 27 otel-demo pods
5. Rewrite fluentd source: tag `kubernetes.*` + route via `@KUBERNETES` label so the `kubernetes_metadata` filter actually injects pod/namespace/container fields
6. **Engine config fix**: exec_filter `<format>` changed from `single_value, message_key: log` → `json`. The old format sent only the raw log string to tenx-edge; worked for the JSON-wrapped replay sample, silently broke on plaintext CRI logs (crashed with `JsonParsingException: Invalid token=NUMBER at column 7`). With `json`, fluentd sends the full structured record and tenx-edge's JSON extractor has valid input.

**What's running now** (on the demo EKS cluster, 2026-04-15):
- 27 real opentelemetry-demo pods in `otel-demo` namespace producing live logs and traffic
- 5 (of 5) tenx-fluentd DaemonSet pods on cluster nodes (4 Running, 1 Pending due to pod density cap on one node)
- tenx-edge processing real CRI logs via exec_filter
- log10x `edge` tier metrics flowing to `prometheus.log10x.com` with real k8s_pod/k8s_namespace/k8s_container labels
- kube-prometheus-stack in `monitoring` namespace scraping the same pods' CPU/memory/HTTP metrics
- MCP config in `.mcp.json` wired to both: retriever LB + customer metrics via port-forwarded kube-prom

**Live validated** (PR #19): primary cross-pillar join `k8s_namespace ↔ namespace` with Jaccard **1.000**. Both pillars observe the same real pod `kafka-57d6ff9c6c-sgnzv` with identical structural labels.

### G2-OLD. (previous entry preserved for history)
**Severity**: product narrative / validation gap.

**Evidence**: the `log-simulator-56b6444567-74d8g` pod is the only source of "application" events. Its container args:
```
--source s3 --bucket log10x-public-assets --key samples/otel-k8s/large/input/otel-sample.log --rate 1000
```

Every service name the MCP tools show (`cart`, `frontend`, `payment`, `opentelemetry-collector`, etc.) is a pattern identity from this **canned S3 sample file**. There are NO running microservices, NO live traces, NO real OTel metrics being produced. `kubectl get pods -A` returns zero OTel collectors, zero Prometheus, zero Grafana, zero opentelemetry-demo.

**Implications**:
1. Cross-pillar testing is **literally impossible** in this env without standing up new infrastructure
2. The anti-patterns agents surfaced (Hard-3 payment-service-no-business-logs, validation-run quote-service-only-"Listening on") are **artifacts of the canned sample**, not real architectural findings about a live system
3. The cardinality_concentration warning (54% = otelcol DEBUG self-telemetry) reflects the **sample's characteristics**, not a live customer's observability pattern

**This does NOT invalidate the MCP fixes** — every bug caught is real regardless of whether the data is live or replayed. But it does mean the "APM wedge" claim (cross-pillar correlation validates log patterns against k8s metrics) is unvalidated against real production-shaped data.

**To actually validate the APM wedge**:
- **Option A**: deploy `open-telemetry/opentelemetry-demo` into the demo cluster (20+ microservices, real spans, real metrics) → wire its Prometheus to `LOG10X_CUSTOMER_METRICS_URL` → re-run cross-pillar scenarios
- **Option B**: stand up a minimal `prom-node-exporter` + `kube-state-metrics` + OTel collector alongside the existing log-simulator → wire that Prom to the cross-pillar env var
- **Option C**: accept that the demo validates log-only operation and mark cross-pillar as "untested against live data, code is ready"

Option A is the correct answer for GA. It's substantial infra work (several hours) but it's the only way to validate the cross-pillar wedge claim on production-shaped data.

### G4. Upstream opentelemetry-demo `accounting` image has a missing library (libgssapi_krb5.so.2)
**Discovered by**: sub-agent scenario 4 (pod-restart investigation), 2026-04-15.
**Severity**: this is a bug in the **upstream opentelemetry-demo repo**, not in log10x. Worth filing upstream and/or surfacing as a "demo hygiene" note for anyone using this repo for observability POCs.

**Evidence** (verified independently via `kubectl`):
```
$ kubectl get pod -n otel-demo accounting-76dc9dc54-jfqxm -o jsonpath='{.status.containerStatuses[*].restartCount}'
19

$ kubectl get pod -n otel-demo accounting-76dc9dc54-jfqxm -o jsonpath='{.status.containerStatuses[*].lastState.terminated.reason}'
OOMKilled

$ kubectl logs -n otel-demo accounting-76dc9dc54-jfqxm --previous | grep -i krb
Cannot load library libgssapi_krb5.so.2
Error: libgssapi_krb5.so.2: cannot open shared object file: No such file or directory
  Microsoft.EntityFrameworkCore.DbUpdateException: An error occurred while saving the entity changes.
```

The .NET accounting service tries to load the GSSAPI/Kerberos library at PostgreSQL-connection time (Entity Framework Core's Npgsql driver). The library is missing from the base image, so every container init enters a retry loop, allocates memory, and eventually gets OOMKilled. 19 restarts with OOMKilled hides the real root cause (missing library) unless you read `kubectl logs --previous`.

**The sub-agent diagnosed this from log10x patterns alone** (the #1 CRIT pattern on accounting was exactly `libgssapi_krb.so: cannot open shared object file: No such file or directory`), and correctly identified that OOM is a symptom of the init-path failure retrying, not a memory-sizing issue.

**Fix** (not in scope for this session but worth noting):
- File upstream issue on https://github.com/open-telemetry/opentelemetry-demo
- Workaround: add `libgssapi-krb5-2` (Debian/Ubuntu) or `krb5-libs` (RHEL/Alpine) to the accounting container's Dockerfile base layer
- Or: disable GSSAPI auth in the Npgsql connection string for the demo

**Why this matters for the session**: validates that cross-pillar investigation with log10x finds real upstream bugs, not just synthetic scenarios. The sub-agent's workflow (restart metric → log pattern discovery → Kerberos ID → OOM-is-symptom diagnosis) is exactly the customer story we want for the product.

### G5. Upstream opentelemetry-demo frontend → shipping URL construction bug
**Discovered by**: Live-S3 sub-agent (checkout slowness investigation), 2026-04-15.
**Severity**: real upstream bug in the running otel-demo that a user would hit on any checkout attempt that reaches the shipping-quote step.

**Evidence**:
- `log10x_pattern_trend` on pattern `shipping_service_Post_shipping_get_quote_unsupported_protocol_scheme_shipping`: flat $6.4/day steady state, 258 data points on a 5m step, marked **stable** (not a spike, continuously firing)
- `list_by_label` + per-service `top_patterns`: the pattern is the #1 CRIT-severity log in the frontend service
- `kubectl` independent verification: `SHIPPING_ADDR=http://shipping:8080` on the frontend deployment — **env var is correct**

So the URL is configured correctly but the frontend code is somehow constructing `shipping://...` instead of using the `SHIPPING_ADDR` properly. The bug is in the frontend app code path (likely the shipping-quote HTTP client), NOT in the env var or helm values.

**Agent caveat**: Live-S3 agent's specific diagnosis ("env var is literally shipping://...") was inference from log content, not verification against kubectl. The agent doesn't have kubectl access — it could only reason from log patterns. An enterprise-ready tool flow would cross-check with customer metric labels or allow shelling out to verify a hypothesis before committing to it in a VP report.

**Why this is G5 not just "fix the demo"**: the otel-demo frontend is upstream open-telemetry/opentelemetry-demo code. Filing the bug upstream benefits every customer who uses the demo as an observability POC harness.

### ~~G6. `investigate environment` produces +100% false flags on near-zero baselines~~ ✅ CLOSED 2026-04-15 (PRs #25, #26, #27)
**Original finding**: Live-S5 ran `log10x_investigate starting_point="environment" window="1h"` and the tool flagged 5 patterns with `+100%` day-over-day deltas that per-service reruns immediately contradicted. Root cause: near-zero baselines inflating relative change to +100% (really +∞%) when dividing `current_rate / ~0_baseline`.

**Fix landed across three PRs**:
- **PR #25** — added `meaningfulBaselineFloor = 10 × acuteNoiseFloor = 0.01 events/s` guard on the baseline side of the env audit's `topk(signed_change)` query. Patterns with near-zero baseline now fail the filter and don't surface.
- **PR #26** — fixed sign loss: the audit was using `topk(abs(...))` which also lost direction. Now runs `topk(signed)` + `bottomk(signed)` separately and merges, so declines render as `-X%` and growths as `+X%`.
- **PR #27** — narrowed the floor to baseline-side only. The first implementation guarded both sides, which killed real low-volume crashloop signals (accounting's Kerberos pattern at 0.00225 events/s averaged).

**Verified live**: the env audit on the real otel-demo now produces clean output with correct signs. Cart patterns that declined -100% are labeled declined -100%, not +100%. No phantom growth flags on near-zero baselines.

### G7. Cross-agent divergence on crashloop root-cause attribution (PARTIALLY ADDRESSED via PRs #32/#34)
**Original finding**: two different Claude sub-agents investigating the same accounting pod reached different conclusions — one correctly diagnosed the libgssapi dlopen failure, the other defaulted to textbook "OOM → bump memory". Both had the same tool data.

**Partial resolution (PR #32 + PR #34)**: the investigate tool now runs a **recency probe** after anchor resolution. If the resolved anchor has not fired in the last 5 minutes (rate below noise floor) but is still ranked top by 24h cost, the report prepends a prominent banner:
> ⚠ **Anchor may be historical, not current**: `<anchor>` has not fired in the last 5 minutes but is still ranked top by 24h cost... Currently-active patterns in `<service>`: `<list>`. Re-run investigate with one of these as starting_point.

This fires on both the acute-spike path (PR #32) and the flat-path (PR #34). Verified on the S16 accounting rerun head-to-head — the agent recognized the historical anchor and found the live poison-pill bug the same session.

**Full head-to-head scorecard after mitigation** (captured in `docs/CROSS_MODEL_TEST_SPEC.md`):
- S11 (kubectl-only, 3 calls): found Postgres poison-pill only, missed Kerberos
- S12 (MCP-only, pre-PR#32, 3 calls): found libgssapi only, **wrong on current crashloop**
- S16 (MCP-only, post-PR#32/#34, 8 calls): **found both bugs with correct live/historical split — most complete diagnosis of any run**

**Remaining residual** (tracked in G13): "loudest currently-firing" is still not the same as "most causally important". The Kafka poison-pill that actually OOMs the accounting pod fires below the `acuteNoiseFloor=0.001 events/s` and doesn't surface directly — a competent agent has to reason past the recency pointer and cross-check with `pattern_trend` on lower-ranked patterns. A more complete fix would require:
1. Cross-pillar correlation with `kube_pod_container_status_restarts_total` to detect which patterns are causally linked to restart cycles
2. Severity-weighted uncommon-but-severe floor (a rare CRIT is more causally important than a frequent INFO)
3. Known-signature matching (`.NET + Npgsql + 23505` → poison-pill, `.NET + dlopen + failure` → missing library)

These are in the follow-up backlog (see G13).

### ~~G8. prometheus-proxy usage-metric collision — multi-writer out-of-order rejection~~ ✅ CLOSED 2026-04-15 (backend PR #55, deployed to prod)

**Root cause** was NOT in tenx-edge as initially suspected — it was in the `prometheus-proxy` Lambda at `backend/lambdas/prometheus-proxy/src/main/java/com/log10x/backend/lambda/prometheus/util/PrometheusUtil.java:334`. Every remote-write / query request caused the Lambda to append `tenx_usage_*` usage series labelled only by `{__name__, TENX_Tenant, userId}`. N concurrent writers per tenant → N samples/sec on one series at near-identical `System.currentTimeMillis()` → AMP rejected the **whole** WriteRequest as out-of-order, killing the client's per-pattern metrics as collateral.

**Fix**: added `instance` label sourced from `event.getRequestContext().getHttp().getSourceIp()`. Each writer pod has a distinct egress IP → distinct usage series → no cross-writer collision. Cardinality bounded by (pods × tenants). Zero client changes.

**Files changed**: `PrometheusUtil.java`, `RemoteWriteHandler.java`, `QueryHandler.java`, `QueryAIHandler.java`, `MultiLabelValuesHandler.java`.

**Deployed**: 2026-04-15 16:58 UTC via `aws lambda update-function-code` on all 4 functions (`tenx-prometheus-remote-write`, `tenx-prometheus-query`, `tenx-prometheus-query-ai`, `tenx-prometheus-multi-label-values`). All 4 `LastUpdateStatus=Successful`.

**Verified**:
- Pre-fix: 4 fluentd pods logging `out of order sample` HTTP 400s (counts: `9ks5j=8, 8pf87=7, pnl2c=3, 6ckbq=1`). Cart volume trajectory 1.3 GB → 0. `investigate cart window=5m` returned "Could not resolve" (zero data).
- Post-fix (7 min after deploy): **0 OOO errors across all 4 pods** in 5m lookback. `investigate cart window=5m` returned "No significant movement" — tool successfully ran `rate(all_events_summaryVolume_total{service="cart"}[5m])` on live data and reported honest steady-state. Fluentd actively processing 168-185 pods cached per node.

**Residual** (not a blocker): same-pod same-millisecond collisions on variable-value metrics (`write_samples`, `write_bytes`, `write_series`) could still race, but affect only the usage metric itself — client pattern data is safe. Rare in practice. Follow-up if we want it bulletproof: per-sample timestamp offset or per-Lambda-invocation UUID label.

### ~~G8-legacy. (original entry preserved for history)~~
**Discovered by**: cart-spike validation of PR #25/#26 fixes, 2026-04-15.
**Severity**: **GA blocker for any multi-node forwarder install**. Silently causes whole-batch metric rejection — customers see "fluentd flowing, tenx-edge running, metrics gone".

**Evidence** (verified live on demo EKS cluster):
- `kubectl logs` on all 4 tenx-fluentd pods shows repeated HTTP 400 from `prometheus.log10x.com/api/v1/write` with body `out of order sample`. Error counts this session: `9ks5j=8, 8pf87=7, pnl2c=3, 6ckbq=1`.
- The failing series in the error body is a **tenant-level** metric like `tenx_usage_write_requests` — it has no per-instance label distinguishing the 4 writer processes.
- Cart volume trajectory on the same window: **6h = 1.3 GB, 2h = 5.9 KB, 1h and shorter = 0 bytes**. The series goes to zero exactly when multiple fluentd/tenx-edge instances start racing each other on writes.
- Remote-write rejects the WHOLE batch on any out-of-order sample, so pattern metrics (`all_events_summaryVolume_total{…}`) get dropped as collateral damage even though they ARE per-instance labelled.

**Root cause**: tenx-edge emits tenant-level usage metrics (`tenx_usage_write_requests`, etc.) that are identical across all writer instances. With 4 fluentd pods in the demo DaemonSet, 4 tenx-edge processes publish the SAME series concurrently. Prometheus's remote-write receiver treats samples on a single series as strictly monotonic in time — two writers publishing at `t=1000` and `t=999` produces an out-of-order rejection on the second one. Whole batch fails.

**Why this is a silent killer**:
1. `tenx-edge` logs "running"
2. `tenx-fluentd` logs "flowing, events shipped"
3. `prometheus.log10x.com` shows zero events for the affected window
4. Customer doctor check passes (because the metric backend is reachable)
5. Only `kubectl logs -n demo tenx-fluentd-… | grep "out of order"` reveals the problem

**Fix options** (all engine-side, out of MCP scope):
1. **Add per-instance labels** to tenant-level metrics: `tenx_usage_write_requests{instance="$POD_NAME"}` — makes each writer own a distinct series, no collision. Simplest fix.
2. **Single-coordinator writer**: elect one fluentd/tenx-edge pod per cluster to emit tenant metrics, others stay silent. Brittle under pod churn.
3. **Configure Mimir/Prom receiver** to tolerate out-of-order samples via `out_of_order_time_window=5m` (receiver-side config, but only works if the backend is Mimir or Prom ≥2.39 with OOO enabled).

**MCP-layer mitigation** (NOT a fix, but makes the bug visible instead of silent):
- New doctor check: **`remote_write_drops`** — scans a recent window for zero-volume streaks on services that had non-zero volume immediately before. Flags as "possible multi-writer collision, check tenx-edge logs for 'out of order sample'".
- Alternatively: query Prometheus for `tenx_usage_write_errors_total{reason="out_of_order"}` and fire doctor warning when non-zero.

**How this was discovered**: Ran cart-spike investigation after merging PR #25 (correlate.ts meaningfulBaselineFloor) to validate it catches real low-volume crashloops. Investigation returned "no significant movement" which was unexpected. Queried cart pattern volume directly: 1.3GB → 0 over successively shorter windows — impossible unless the data itself was dropped. `kubectl logs` on tenx-fluentd pods immediately surfaced the HTTP 400 chain. Independent verification via direct Prom query confirmed cart pattern series has no samples in the affected window.

**Why this blocks GA**: every real customer runs multi-node forwarder deployments. The demo only has 4 fluentd pods and we see the rejection chain on every scrape. A 50-node customer cluster would have 50× the collision rate. Silently dropping metrics is the worst possible failure mode for an observability product.

**Action**: file engine ticket with full evidence bundle. Block GA on option (1). Add doctor check as MCP-layer mitigation in the interim.

---

### G13. Investigate ranks by historical cost, not by "is this pattern still firing" (PARTIALLY MITIGATED via PRs #32/#34)
**Discovered by**: head-to-head test S11 (kubectl-only) vs S12 (MCP-only) on accounting crashloop, 2026-04-15.
**Severity (before mitigation)**: GA-critical — MCP produced wrong root cause with high confidence on the exact scenario its marketing story uses (crashloop diagnosis).
**Severity (after PRs #32/#34)**: material — MCP now honestly flags when its answer may be historical and points to currently-active alternatives. A competent agent can reach the right answer; a naive one gets a clear warning rather than a silent wrong answer.

**Evidence**:
- S11 (kubectl-only, 3 calls) → correctly diagnosed the CURRENT failure: Postgres `23505 duplicate key violates unique constraint "order_pkey"` on `accounting.order`, triggered by a Kafka poison-pill message that the consumer re-reads after each OOM.
- S12 (MCP-only, 3 calls) → diagnosed the libgssapi_krb5.so missing-library error based on `top_patterns(service=accounting, timeRange=1d)` ranking that pattern as #1 CRIT.
- **Independent verification via `kubectl logs accounting --previous`**: the CURRENT restart cycle is failing on the Postgres duplicate-key exception, NOT on the Kerberos dlopen failure. The Kerberos error was from an earlier restart cycle that's now suppressed (likely the libgssapi was installed at some point, or the crash path changed).
- Both agents reported 90% confidence. Only the kubectl agent was right.

**Root cause of the MCP miss**: `top_patterns` ranks by **total cost over the window**, not by recency. The Kerberos error accumulated enough cost in the 24h window to be #1 even though it's no longer the active failure. The investigate tool + top_patterns have no signal for "is this pattern still firing RIGHT NOW vs was it firing 6 hours ago?".

**What the MCP needed (and didn't have)**:
1. A "most-recent-error" view that ranks by the *latest sample timestamp* with severity >= ERROR, not by cumulative volume
2. A "pattern activity flag" on each pattern returned by top_patterns — "last seen: 30s ago" vs "last seen: 4h ago"
3. For crashloop scenarios specifically: investigate should query the last N minutes of per-severity patterns separately from the total-cost ranking

**Mitigation shipped (PRs #32 + #34)**:
- **PR #32**: `investigate` now runs a recency probe after anchor resolution. If the resolved anchor's last 5-minute rate is below `acuteNoiseFloor`, prepend a warning banner to the acute-spike report pointing to a separate most-currently-firing-pattern probe that's unfiltered by severity (because stack traces often have empty severity). The probe excludes the anchor itself and lists the top 3 actively-firing patterns.
- **PR #34**: the same warning now also applies to the `renderEmpty` (flat trajectory) path — previously the warning was computed but dropped when the trajectory classifier routed to the empty template. This was caught by S16 on the accounting rerun.
- **PR #33**: `top_patterns` also got a "newly emerged patterns" section that surfaces high-rate-now-zero-rate-1h-ago patterns. Addresses the freshness issue for open-ended health sweeps.

**S16 verification** (post-mitigation head-to-head):
| Run | Access | Calls | Result |
|---|---|---|---|
| S11 | kubectl only | 3 | Found poison-pill only |
| S12 | MCP pre-fix | 3 | Found libgssapi only (wrong about live cause) |
| S16 | MCP post-fix | 8 | **Found BOTH bugs, correct historical/live split** |

**Remaining residual** (not a GA blocker, but worth tracking):
- "Loudest currently-firing" ≠ "most causally important". The Kafka poison-pill fires below the 0.001 events/s noise floor because it only triggers on one specific Kafka message per retry loop. An agent has to reason past the recency pointer and cross-check with `pattern_trend` or `event_lookup` to find it.
- Full fix options (all out of scope for MCP-layer patching, require engine or cross-pillar work):
  1. Cross-pillar correlation with `kube_pod_container_status_restarts_total` to detect which log patterns are causally linked to restart cycles via temporal co-movement around the restart timestamps
  2. Severity-weighted uncommon-but-severe floor (a rare CRIT is more causally important than a frequent INFO; the floor should scale by severity level)
  3. Known-signature matching table (`.NET + Npgsql + 23505` → "Kafka poison-pill with Postgres unique constraint", `.NET + dlopen + failure` → "missing native library at init")
  4. Pattern novelty detection: patterns with current activity + zero activity before the first restart timestamp are likely the crash cause

**Customer impact after mitigation**: an SRE using the MCP gets a clear warning banner when the anchor is historical, with a specific next-action pointer to currently-active patterns. They will NOT ship a confidently-wrong fix — they may still need 1-2 extra queries to reach the full answer, but they are not misled.

### G11. Paste Lambda templatizer is broken (resolve_batch silently drops ~70% of input)
**Discovered by**: sub-agents S4 and S9 (paste-triage scenarios), 2026-04-15.
**Severity**: blocks the paste-triage workflow entirely. `log10x_resolve_batch` is the foundation of that workflow — if it can't reliably templatize a batch, downstream triage is impossible.

**Evidence** (S9 detailed taxonomy):
- S9 pasted 30 distinct log lines, got back 7 patterns accounting for only ~9 events. **21 of 30 lines silently dropped**. No error, no "uncategorized" bucket, no warning. The header says "30 events, resolved into 7 distinct patterns" — the 30 is trusted, the 7 is misleading.
- **Cross-event template merge (critical)**: Pattern #1's template literally contained two newline-joined distinct log lines glued together — the libgssapi error AND the shipping URL error in one template. Same bug on pattern #6 (checkpoints + grpc jaeger). The templatizer is sliding a window across event boundaries.
- **Over-split**: lines 6+7 were byte-identical libgssapi errors but got different pattern identities because line 6 got glued to line 8. Two identical bytes → two identities.
- **UUID over-segmentation**: UUIDs got split on every `-` into 5 separate slots (`$-$-$-$-$`) rather than treated as one token.
- **Variable name leakage**: literals like `shipping` and `checkpoints.go` were used as slot names even when there was no `k=v` structure.

**Why this is an engine/paste-Lambda bug, not MCP**: `log10x_resolve_batch` just POSTs events to the paste endpoint and renders the response. The templatization happens server-side in the paste Lambda via the same Log10x engine code used by the main pipeline. The bugs are in the templatizer itself.

**Action**:
1. Engine team: audit the templatizer for newline-boundary handling — events must NEVER span newlines. Add test coverage for "30 distinct lines produce ≥20 identities (not 7)".
2. Engine team: fix UUID tokenization to treat `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` as a single slot, not 5.
3. MCP layer: once the engine fix ships, `resolve_batch` should still emit an "uncategorized events" bucket so the customer can see dropped lines instead of having them silently vanish. Currently the tool trusts the engine output blindly.

**Customer impact**: any customer who pastes a SIEM dump into resolve_batch today gets a report that looks plausible but silently hides 70% of the input. This is the worst possible failure mode for a triage tool.

### G12. Retriever forensic query — false negatives + crash on canonical pattern names
**Discovered by**: sub-agent S7 (forensic post-mortem scenario), 2026-04-15.
**Severity**: blocks the forensic retrieval workflow. Retriever is the Tier-4 customer capability and a key GA feature — currently unreliable.

**Evidence** (S7's stress test):
- **False negative on known-exists data**: `log10x_pattern_trend` confirms ~$11K/wk of the shipping pattern flowing right now (166 data points, 109 GB peak on 2026-04-14). `log10x_retriever_query` with ISO8601, now-expressions, and `last 1h` windows ALL return 0 events. The retriever is submitting queries successfully (92s wall time = full execution), producing marker objects, and reading the results prefix — but the results prefix is empty.
- **Crash on canonical pattern name**: passing `shipping_service_Post_shipping_get_quote_unsupported_protocol_scheme_shipping` to `name` → `MCP error -32000: Connection closed`. Reproducible, 2 attempts. Short-form (`shipping`) does not crash but returns 0.
- Two query IDs recorded for false-negative: `ad907b42-e113-463c-86fd-30176dd01db4`, `5ec74e06-75b0-4b4f-855a-a93176fef038`.

**Possible root causes** (not yet diagnosed):
1. Bloom filter index is not covering the time windows being queried (S3 archive coverage gap?)
2. Target prefix mismatch — the retriever indexer writes under a different target than `app` or whatever the default is
3. Name-based filter: canonical slash-underscore name doesn't match the underlying stored event keys
4. The -32000 crash is specifically on name length / content — maybe a JSON-encoding issue in the backend
5. The retriever was wired up recently and hasn't ingested historical data yet

**Action**:
1. **Diagnosis required on engine side**: pull the retriever coordinator logs during a reproduction to see whether the query runs, matches, and writes. The MCP is operating correctly per its contract (submit → wait for marker → read results); the failure is downstream.
2. **MCP-layer mitigation**: when retriever returns 0 events while `pattern_trend` proves the pattern exists, emit a clear warning ("retriever returned 0 events but live metrics prove this pattern has ~$X/wk of traffic — retriever index may be stale or target mismatch; fall back to `pattern_trend` for trajectory and `event_lookup` for pattern metadata").
3. **Hard crash fix**: investigate the -32000 error — likely a length cap, special-char escaping, or JSON field handling bug. Check engine-side retriever request handler for input validation.

**Customer impact**: a customer trying to do forensic retrieval on a known-live pattern gets an empty result set with no explanation. If they pass the canonical name, they get an obscure RPC error. The workflow is currently unusable end-to-end.

### G10. Engine fingerprinter leaks high-cardinality variables into pattern identities
**Discovered by**: session 2026-04-15 sub-agent S1 and live environment audit review.
**Severity**: UX / credibility — not a data-loss bug, but produces phantom "5-pattern decline" alerts that a naive operator will panic about.

**Evidence**: the real otel-demo's `product-reviews` service produces pattern identities like:
```
service_name_product_reviews_trace_sampled_True_username_bookworm_astro
service_name_product_reviews_trace_sampled_True_username_history_buff_description
service_name_product_reviews_trace_sampled_True_username_ancient_texts_description
service_name_product_reviews_trace_sampled_True_username_rare_find_description
service_name_product_reviews_trace_sampled_True_username_celestial_history
```

Each username variant gets its own pattern identity. When the load generator cycles through a new set of reviewer usernames, the previous set's patterns all drop to zero simultaneously — the env audit then shows 5 patterns "declined -100%" in a single service.

**Why this is an engine problem**: the fingerprinter should tokenize / strip high-cardinality variable values (usernames, UUIDs, request IDs) before computing the pattern identity. Identical log *structure* with different variable values should produce the *same* pattern ID, not 5 different ones.

**MCP-layer mitigation** (would help without an engine fix): add a collapse heuristic to `renderEnvironmentAudit` that detects "≥3 patterns from the same service with rate changes within ±5% of each other" and collapses them into a single summary row like:
```
5 high-cardinality variants in `product-reviews` — declined -100% each (likely username rotation, not incident)
```

This would turn a noisy "5 incidents" output into a single informative row. The operator can still drill down if they want, but the audit doesn't overstate the signal count.

**Action**: file engine ticket for the fingerprinter leak. Ship MCP-layer collapse heuristic as a defensive measure in parallel.

### G9. tenx-edge subprocess stale state after prolonged remote-write rejection
**Discovered by**: follow-up verification after backend PR #55 (G8 fix) was deployed.
**Severity**: operational — not a code bug, but a customer upgrade gotcha.

**Evidence**: after deploying the prometheus-proxy Lambda fix at 16:58 UTC, OOO errors on the fluentd pods immediately dropped to zero. However, the `log10x_investigate environment window=1h baseline_offset=24h` call continued to show cart patterns as "-100% declined" — not because of a new bug, but because the 40 minutes of current-window data from the pre-fix period WERE genuinely lost from the metric backend AND the tenx-edge subprocesses appeared to have accumulated stale internal state that prevented them from resuming metric emission for a few minutes after the Lambda fix.

A `kubectl rollout restart ds/tenx-fluentd -n demo` resolved it — the fresh tenx-edge subprocesses immediately began shipping metrics again, and the next env audit correctly surfaced real movers (product-reviews -73%, opentelemetry-collector +167%) instead of phantom cart -100%.

**Why this is a customer upgrade gotcha**: any customer who has been running with the pre-fix Lambda + high writer fanout will have been silently losing metrics in a steady-state pattern. Deploying the Lambda fix alone will not restore visibility — they need to either wait for the forwarder's natural restart cycle or trigger a rollout restart. Without this operational step, the "fix deployed but nothing changed" story will look like a failure.

**Action**:
1. Document in the backend PR #55 release notes: "after upgrading, roll the tenx-fluentd DaemonSet to fully restore metric flow"
2. Add a doctor check (future) that detects "fluentd pod uptime > 1h AND recent OOO errors in pod logs" and warns "post-upgrade restart recommended"
3. Investigate the engine side: why does the tenx-edge subprocess not self-recover after remote-write errors clear? Is there a poisoned buffer, a back-pressure flag not being reset, or a circuit breaker stuck open? Worth a 1-2 hour engine review.

**Root cause is not fully diagnosed** — it may be (a) tenx-edge internal queue/buffer that needs flushing, (b) a metric-producer error flag that latches on fatal write errors, or (c) fluentd's exec_filter retry semantics interacting badly with the child process. The restart works; the underlying mechanism deserves engine investigation before GA.

### G3. Retriever-wired-but-undocumented in demo env
**Evidence**: LoadBalancer `tenx-retriever-query-lb` at `a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com` has been running for 21h but was NOT referenced in any MCP setup docs or env var hint. I found it by `kubectl get svc -A | grep retriever`.

**Impact**: every sub-agent run this session that asked about the retriever got "__SAVE_LOG10X_RETRIEVER_URL__ not configured" because nobody had wired the MCP to the already-deployed LB. Hard-1 SOC forensics scenario worked around it by suggesting branches; S6 caveated its answer; etc.

**Action**: document the retriever LB in the demo README so the next contributor knows to wire it. PR #9 documented the general setup; this adds the specific URL.

### C4. Sub-agent bootstrap catch-22
**Status**: PR #9 documented the fix (prompt prefix) in README; per-prompt hint works reliably. Fundamental fix requires upstream change in Agent SDK / Claude Code that lets sub-agents auto-load parent MCP tools without requiring a ToolSearch call.

**Blocker**: outside MCP scope. File upstream feedback with Anthropic Agent SDK team.

**Measured impact**: 5/5 honesty-framed prompts failed to bootstrap without the hint; 5/5 succeeded with it. ~30% of real sub-agent test cases would have bootstrap-failed silently without the hint.

---

## Category D: Testing + process findings

### D1. MCP server restart required after every rebuild
**Status**: documented in README (PR #8). Not a code bug; it's an operational gotcha that cost ~8 hours of debugging this session.

**Why it's still worth flagging**: new contributors will hit it. Every rebuild needs `pkill -f log10x-mcp/build/index.js` or the running processes serve stale compiled code from memory.

### D2. Agent prompt framing determines bootstrap success
**Finding**: deterministic split — action-oriented prompts bootstrapped 9/9; honesty-oriented prompts 0/5 without the hint. The honesty disposition fires before tool discovery.

**Captured in**: README "Spawning sub-agents" section (PR #9).

### D3. Cross-agent convergence as a validation signal
**Observation**: 5 independent sub-agents discovered the same real bug in the demo env (`unsupported protocol scheme 'shipping'`) without coordination. This is a strong signal that tool outputs are deterministic enough for consensus, not noisy enough to fabricate different stories.

**Why this matters for GA**: the tool passes an implicit "reproducibility" test across independent investigations. Worth preserving as a regression check — if a future code change makes independent sub-agents diverge on the same question, something has broken in determinism.

### D4. `test-agent-scorer.mjs` is the reusable harness
**Status**: shipped in PR #6. Parses JSONL transcripts from async Agent runs, extracts tool-call sequences and final assistant text, scores on 6 dimensions. Used every session to audit sub-agent runs.

**Next step**: wire this into a CI/regression test. Given a fixed set of sub-agent scenarios, score them on each PR and fail the build if scores regress below a floor.

---

## Category E: Things explicitly NOT done

### E1. Throttling the savings chunk queries
Tried, measured, reverted. Documented in PR #13. 4× wall time regression, zero coverage improvement. **Do not re-attempt without a different hypothesis** — specifically, sub-chunking the offset=0d day (see A1) is the only untried approach worth considering.

### E2. Cross-pillar sub-agent testing
Blocked on B2 (demo env infra). Tests are ready to run as soon as `LOG10X_CUSTOMER_METRICS_URL` is wired.

### E3. Expanding sub-agent coverage to `event_lookup`, `discover_labels`, `discover_join`, `backfill_metric`
Partially tested via incidental usage. No dedicated stress test. Worth a pass when revisiting test coverage.

### E4. Demo-specific polish
The comments in `retriever-api.ts:21` and `:391` reference "the otek demo env" as an example for the __SAVE_LOG10X_RETRIEVER_TARGET__ and LOG10X_RETRIEVER_INDEX_SUBPATH defaults. The code is portable; only the comments mention the demo. Low priority polish.

---

## How to use this file

- **Before compaction**: check this file for open items. If you're about to drop context, the gaps are captured here.
- **Opening a new session**: read this file first to see what's been deferred and why.
- **Closing an item**: delete the corresponding entry and reference it in the PR commit message.
- **New finding**: add it to the appropriate category with a concrete "what would fix it" note. Avoid entries that say "we should improve X" without a specific fix shape — they rot fast.
