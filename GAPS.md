# Open Gaps

**Purpose**: persistent list of known issues, architectural observations, and deferred fixes surfaced during sub-agent acceptance testing. Kept in repo so context isn't lost across sessions or compaction events. Update this file when closing an item or adding a new one.

Last update: session ending 2026-04-15. Eight PRs merged (#6–#13). Findings below are the things **not** closed by those PRs.

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

### C1. Proactive "boilerplate-only service" detection in doctor
**Insight source**: Hard-3 sub-agent ("no-data vs no-occurrence" scenario) caught that the payment service has only OTel-SDK-generated logs and no business events. This is an **architectural anti-pattern** that doctor could detect automatically.

**Proposed check**: for each service in `services` output, count distinct pattern identities with severity ≥ INFO and total events > N (e.g., 1000). If the pattern set is dominated by a small number of boilerplate templates (`process.runtime.*`, `host.*`, `service.instance.id *`, `gRPC server started`), flag the service as "emitting telemetry boilerplate only — business events may be in traces, not logs".

**Why it's valuable**: a customer running this doctor check would immediately see which of their services are "silently not logging business events", which is a class of observability gap that's normally invisible until an incident exposes it. **Real product value**, surfaced by a real finding.

**Effort**: low-medium. New doctor check + a small library of known-boilerplate pattern regexes.

### C2. Severity distribution sanity check in doctor
**Proposed check**: warn if an environment's log volume is >99% INFO with effectively zero ERROR/WARN/CRIT. Two interpretations:
- (Good): the services are healthy
- (Bad): the services aren't logging errors at all

The MCP can't distinguish these without the customer's input, but it can flag the pattern and ask the user which interpretation applies. A CFO wants to know if "no errors" means "healthy" or "blind".

**Effort**: low. Leverages existing `list_by_label` on `severity_level` plus a threshold check.

### C3. Cardinality concentration warning in doctor
**Proposed check**: if the top 1 pattern is >40% of total cost, or the top 5 are >70%, flag as high-concentration and suggest running `cost_drivers` for drop candidates. This turns "which patterns should I consider filtering" into an automatic recommendation rather than an agent discovery task.

**Effort**: low. Single `top_patterns` query + ratio math.

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
