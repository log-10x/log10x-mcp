# Open Gaps

**Purpose**: persistent list of known issues, architectural observations, and deferred fixes surfaced during sub-agent acceptance testing. Kept in repo so context isn't lost across sessions or compaction events. Update this file when closing an item or adding a new one.

Last update: session 2026-04-15 (continued). **Twelve PRs merged (#6–#17)**. Most recent: PR #17 fixed three streamer end-to-end bugs surfaced during first live validation against the demo env deployment. Findings below are the things **not** closed by those PRs.

---

## Category A: Real bugs with partial or deferred fixes

### A1. Savings chunk coverage — server-side root cause
**Status**: PR #12 surfaces partial-coverage honestly, PR #13 documents that client-side throttling does NOT help. The Final-1 audit finding is **symptom-fixed but not root-caused**.

**What we know**: the `streamerIndexedBytesChunk` queries intermittently hit Prometheus's 5GB aggregation limit with `HTTP 422: expanding series: the query hit the aggregated data size limit`. Failures are **deterministic per chunk**, not caused by client concurrency (tested: throttling to 6 concurrent quadrupled wall time 90s→370s with zero coverage improvement, 37/60 chunks in both cases).

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

### B1. Storage Streamer not wired in demo env
**Evidence**: S1 (auth forensics), S6 (connection pool), Hard-1 (73-day exfil) — all hit `LOG10X_STREAMER_URL` unset. Verbose error message from PR #9 handled it gracefully but the forensic use-case is untested end-to-end.

**Resolution paths**:
- Wire `LOG10X_STREAMER_URL` + `LOG10X_STREAMER_BUCKET` in the demo env config so forensic scenarios have a happy path
- OR update the demo env documentation to say "Streamer is intentionally disabled in the demo, use Reporter metrics only"

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

## Category F: Streamer engine issues (out of MCP scope, need upstream fixes)

### F1. Streamer server's TenXDate ISO8601 parser is broken
**Severity**: high. Silently produces wrong query windows on a documented-supported input format.

**Evidence (2026-04-15, demo env deployment)**:
| Format | HTTP | Events matched (same wall-clock hour) |
|---|---|---|
| `now("-1h")` | 200 | 894 |
| Epoch millis string | 200 | 3400 |
| `2026-04-15T11:00:00Z` (ISO8601) | 200 | **0** |

**Expected**: ISO8601 should work per streamer-api.ts comment ("The engine evaluates these as JavaScript on the server via TenXDate, so `now("-1h")` / `now()` / ISO8601 strings / epoch millis all work"). Empirically, ISO8601 silently produces a non-matching window.

**MCP workaround**: PR #17 converts any non-`now()`, non-pure-digit input to epoch millis client-side via `Date.parse()` before submitting. After workaround: same ISO8601 query → 685 events.

**Real fix**: the streamer server's TenXDate parser needs to handle ISO8601 strings correctly. Live in `com.log10x.ext.quarkus.streamer.*` — find where `from`/`to` get parsed and see why the ISO8601 path produces a bad range.

### F2. Streamer query API strict-rejects unknown body fields
**Severity**: medium. Breaks obvious client patterns.

**Evidence**: sending `{"format":"events","limit":3}` in the query body produces HTTP 400 with empty body. The MCP tool works around it by NOT sending these fields (it applies format/limit client-side after reading S3 results).

**Why it matters**: any customer building an integration against `/streamer/query` who passes standard REST-ish fields will hit 400 with no error message. The server should either:
- Accept unknown fields and ignore them (standard REST behavior)
- Return HTTP 400 with a descriptive error body explaining which field is invalid

Current behavior is the worst of both: strict rejection AND no diagnostic.

### F3. Streamer aggregation limit (5GB) on bleeding-edge day
**Severity**: medium. See GAPS A1 for MCP workaround; the root cause is server-side. `streamerIndexedBytesChunk` at offset=0d intermittently hits `HTTP 422: expanding series: the query hit the aggregated data size limit (limit: 5000000000 bytes)` under concurrent load. PR #12 added coverage annotation as client-side safety net, but the real fix is server-side: raise the limit, pre-aggregate the high-cardinality metric, or split the streamer's indexed metric across more scrape targets.

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

### G2. The "otel-demo" in the demo env is a LOG REPLAY, not a running OTel demo
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

### G3. Streamer-wired-but-undocumented in demo env
**Evidence**: LoadBalancer `tenx-streamer-query-lb` at `a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com` has been running for 21h but was NOT referenced in any MCP setup docs or env var hint. I found it by `kubectl get svc -A | grep streamer`.

**Impact**: every sub-agent run this session that asked about the streamer got "LOG10X_STREAMER_URL not configured" because nobody had wired the MCP to the already-deployed LB. Hard-1 SOC forensics scenario worked around it by suggesting branches; S6 caveated its answer; etc.

**Action**: document the streamer LB in the demo README so the next contributor knows to wire it. PR #9 documented the general setup; this adds the specific URL.

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
The comments in `streamer-api.ts:21` and `:391` reference "the otek demo env" as an example for the LOG10X_STREAMER_TARGET and LOG10X_STREAMER_INDEX_SUBPATH defaults. The code is portable; only the comments mention the demo. Low priority polish.

---

## How to use this file

- **Before compaction**: check this file for open items. If you're about to drop context, the gaps are captured here.
- **Opening a new session**: read this file first to see what's been deferred and why.
- **Closing an item**: delete the corresponding entry and reference it in the PR commit message.
- **New finding**: add it to the appropriate category with a concrete "what would fix it" note. Avoid entries that say "we should improve X" without a specific fix shape — they rot fast.
