# Log10x MCP — Differentiation & Autonomy Plan

> Working tracker. Update the **Status** column in the action table as we execute. Status values: `TODO` · `IN PROGRESS` · `BLOCKED` · `DONE`.
> Source: the 2026-05-31 MCP catalog differentiation audit (39 tools, adversarial Claude-4.8 substitution pass) + per-item design specs.

---

## The reframe (the thesis everything hangs on)

**The moat is the data the engine STAMPS at ingest and PERSISTS, plus the hands to act in-path — not analysis on top of it.**

A powerful Claude 4.8 with SIEM/PromQL read access already does ~80% of diagnosis (search, summarize, rank waste, write queries, triage pasted lines). The adversarial pass refuted every tool that only *analyzes* customer data or *re-templatizes locally*. A tool is genuinely differentiated **only** when it leverages one of:

1. **Stable pattern identity** (`tenx_hash` / `message_pattern`) stamped at ingest — survives deploys/restarts/pod-names; a generic agent's ad-hoc grouping decays on the next deploy.
2. **Persistent per-pattern TSDB history** keyed to that identity — instant "is this new / when did it start / month-long trend", zero query setup.
3. **Bloom-indexed S3 archive** (Retriever) — forensic retrieval of data **not in the SIEM**.
4. **In-data-path enforcement** (Receiver) — actually filter/sample/compact/drop. An agent recommends; only the engine enforces.
5. **Autonomous control loop** — holds savings as the stream drifts. A one-shot forecast rots in a week. **(Currently missing entirely.)**
6. **Cross-pillar correlation via the fingerprint** — only where it joins on the stamped identity, not generic series math.

**Positioning: Claude is the analyst; 10x is the differentiated data layer + the actuator.** Don't build tools that out-analyze the model. Build tools that hand it identity/history/archive it can't get, and in-path hands it doesn't have.

---

## Differentiated core (keep + double down)

| tool | moat | why it survives Claude 4.8 |
|---|---|---|
| `event_lookup` | stable-id | reverse-lookup by the ingest-stamped `tenx_hash`: line → stable identity → history. Non-replicable by construction. |
| `trend` / `pattern_trend` | tsdb-history | `sum by(message_pattern) increase(all_events_…[…])` over months — history a grep can't rebuild |
| `top_patterns` | stable-id + tsdb | stable-id ranking + first-seen + trajectory badges |
| `savings` | tsdb-history | realized savings from engine-emitted metrics (chunked daily aggregation) |
| `configure_regulator` | in-path-exec | derives **and emits** the in-path cap — enforcement, not advice |
| `retriever_query` / `retriever_series` | bloom-archive | forensic retrieval of data not in the SIEM |
| `backfill_metric` | bloom-archive | builds a historical metric from the archive |
| `investigate` | orchestrator | value = the moat primitives + stable identity it composes |

## Commodity (refuted by the substitution pass — demote / fold / deprecate, never market as moat)
- **Analysis-over-PromQL** (pure arithmetic the agent does natively): `metrics_that_moved`, `rank_by_shape_similarity`, `metric_overlay` → fold into `investigate`.
- **Local re-templatizers** (emit a LOCAL hash, not the stamped identity): `resolve_batch`, `extract_templates`, `pattern_examples` → see action #6.
- **Routers / discovery / SIEM-scan**: `dependency_check`, `top_volume`, `poc_from_*`, `discover_*`, `services`, `doctor`, `pattern_mitigate` → consolidate.

---

## ▶ PRIORITIZED ACTION ITEMS (the tracker)

| # | Item | Priority | Effort | Status | Notes |
|---|---|---|---|---|---|
| 1 | **Merge `configure_compact` → `configure_engine`** (one `reduction` knob: soft/hard/sample) | P0 | M | TODO | spec §1. soft→compact, hard→drop, sample→sample; maps to cap-CSV `:action` + `outputSoftDrop`. configure_compact → deprecated alias. |
| 2 | **`estimate_savings`** — forecast $/volume of a proposed cap before approval | P0 | M | TODO | spec §2. the prescribe→apply bridge; computes from per-pattern `all_events` bytes × cap math; per-SIEM honesty. |
| 3 | **Autonomous re-tune loop** (`configure_retune`) — detect drift, re-cap via PR | P0 | M | TODO | spec §3. **moat #5, missing today.** Approve-only (emits PR, never auto-merges). The #1 lever for "almost automatic". |
| 4 | **Graceful-not-configured framework** — convert ~8 hard-error tools | P0 | M | TODO | spec §4. `src/lib/not-configured.ts` envelope + remediation hints; unblocks autonomous chains. |
| 5 | **Fold analysis primitives into `investigate`** (metrics_that_moved, rank_by_shape_similarity, metric_overlay) | P1 | M | TODO | keep the capability as internal steps; stop exposing replicable tools as differentiation. |
| 6 | **Templatizer decision** — re-point `pattern_examples` to `tenx_hash`; relabel `resolve_batch`/`extract_templates` hashes as local | P1 | S+M | TODO | decision §5. pattern_examples → prefer stamped-hash path (becomes moat); resolve/extract → Dev conveniences, drop the identity claim. |
| 7 | **Consolidate auth** 5→2 (`sign_in` + `manage_account`) | P2 | M | TODO | login_status/signin_start/signin_complete/signout/rotate_api_key → 2 tools. |
| 8 | **`check_status`** = login_status + discover_env in one "am I set up" call | P2 | S | TODO | reduces setup friction for autonomy. |
| 9 | **Deprecate `top_volume`, `poc_from_siem`; fold `poc_from_local` into guided discovery** | P2 | S | TODO | top_volume redundant w/ top_patterns; live top_patterns > poc_from_siem. |
| 10 | **Reposition messaging** — "Claude analyzes, 10x is the data + the hands"; stop calling refuted tools differentiated | P3 | S | TODO | docs/console/MCP descriptions. No code. |

---

## Detailed specs

### §1 — `configure_engine` (merge configure_compact)  ·  item #1
- **Now:** `configure_regulator` already has the unified `reduction` knob (soft→compact, hard→drop) + tier model (audit/error/standard/debug/synthetic) + `tier_overrides`, two-phase (service→containers→PR), emits cap CSV row `container,<bytes>::<reason>:<action>`. `configure_compact` is a near-duplicate two-phase tool with a binary decision → separate `compact-cap.csv`.
- **Do:** rename/extend to `configure_engine`; add `reduction='sample'` (standard tier → sample). Keep `configure_compact` as a **deprecated alias** that calls `configure_engine(compaction_enabled=true)` and warns. Compaction becomes an orthogonal per-row flag, not a separate tool/file.
- **Files:** new `src/tools/configure-engine.ts`; deprecate `configure-regulator.ts` + `configure-compact.ts` (aliases); `src/index.ts` registry.
- **Resolve first (open Qs):** (a) where the engine regulator parses the CSV `:action` (confirm `bytes::reason:action` order + enum); (b) ~~does soft/compact keep events in `all_events_*`~~ **RESOLVED 2026-05-31:** yes — `all_events` filter is `isObject` (counts everything); `emitted_events` excludes the drop-routed slice; AND the route state (now the `routeState` label) is a direct metric label (modules `ad02ec6`), so marked/compacted/down-tiered bytes = `all_events{routeState="drop"}` per service. Cost stays visible and is directly attributable. (c) one unified CSV vs two files (recommend one + migration note); (d) exact `sample` semantics.

### §2 — `estimate_savings`  ·  item #2
- **Purpose:** forecast $/mo + bytes saved for a *proposed* cap/config **before** the human approves — lets the agent validate "saves ~$X" autonomously.
- **Design:** input either a $budget (derive cap, reuse `configure_regulator` math) or an explicit cap; compute from per-pattern `all_events_summaryBytes_total` (× fraction over cap, honoring severity floors + baseline) × `$/GB`. Output per-pattern/container savings + total, with **per-SIEM honesty** (Datadog soft = index-only; hard = ingest+index; Splunk soft ≈ 0). Surface coverage caveat when < 100%.
- **Files:** new `src/tools/estimate-savings.ts` + `src/lib/estimate-savings-helpers.ts`.
- **Open Qs:** show soft-vs-hard side by side or one + caveat; per-pattern overrides merge vs replace; confidence signal on low coverage.

### §3 — Autonomous re-tune loop (`configure_retune`)  ·  item #3  ·  **the key autonomy lever**
- **Purpose:** moat #5. Periodically (default 24h) detect per-pattern drift and re-derive caps, emitting a gitops PR — so prescribed savings **hold** as the stream changes. Human stays **approve-only** (never auto-merge).
- **Where:** MCP scheduled routine (RemoteTrigger-style) — analysis stays MCP-side; one agent per env. (Alt: Reporter background cron — not recommended.)
- **Drift signal:** compare current per-pattern share/volume (`all_events_*`) vs the active cap + a baseline window; re-cap only within a band; emit PR (or alert) on material drift.
- **Files:** new `src/tools/configure-retune.ts`; extend `src/lib/promql.ts` (drift/growth queries); `src/lib/telemetry.ts`.
- **Open Qs:** MCP-scheduled vs Reporter-job (confirm w/ deploy); PR review SLA + batch-vs-per-container; confidence metric; Slack/email alert vs GitHub-watch.

### §4 — Graceful-not-configured framework  ·  item #4
- **Purpose:** the ~8 tools that hard-error on a missing precondition (metrics backend, SIEM creds, gitops repo, Retriever) should return a structured `not_configured` status + remediation hint instead, so autonomous chains don't break.
- **Design:** `src/lib/not-configured.ts` → `buildNotConfiguredEnvelope()` (status + error code + remediation markdown + suggested `actions[]`). Exemplars already graceful: `retriever_query`, `discover_join`, `dependency_check`. Convert the throwers: `configure_regulator`/`configure_compact` (`CustomerMetricsNotConfiguredError`), etc. Agent contract: read `status`, don't retry, surface workaround, continue the chain.
- **Files:** `src/lib/not-configured.ts` + the ~8 throwing tools.

### §5 — Templatizer decision  ·  item #6
The local-templatizers emit a **local** template hash (local `tenx` CLI over a pasted/file corpus), **not** the ingest-stamped `tenx_hash`. The stamped identity only exists for events the 10x forwarder processed (queryable via `siem/hash-query.ts` reverse lookup or the Prometheus `message_pattern` label). So:
- **`pattern_examples` → RE-POINT (makes it moat).** When events are in the SIEM with a stamped `tenx_hash`, prefer the stamped-hash reverse-lookup path (like `event_lookup`) over content-token + local re-templatize. Fall back to content-token only when the hash isn't available. This moves it from "replicable" to differentiated.
- **`resolve_batch` + `extract_templates` → KEEP as Dev-tier conveniences, DROP the identity claim.** They're zero-setup top-of-funnel triage on pasted/local data 10x never ingested — there is no stamped identity to point to. Relabel their hash explicitly as "local/preview," don't imply cross-deploy stability, and don't market them as differentiated. (Optional later: a "resolve against live" mode that maps a pasted line to its stamped identity *if* it's already in the SIEM/TSDB.)

---

## Cross-cutting open questions (resolve as we go)
- Engine CSV `:action` parser location. (Metric-visibility half RESOLVED 2026-05-31 — see §1 open-Q (b): the route state (now the `routeState` label) is a metric dimension, marked bytes are a direct `all_events{routeState="drop"}` query.)
- One unified cap CSV vs two files (migration).
- Re-tune host (MCP-scheduled vs Reporter job) + alerting.
- Whether `estimate_savings` + `configure_retune` share the cap-derivation lib with `configure_engine` (recommend yes — one `src/lib/cap-derivation.ts`).

---

## Status log
- 2026-05-31 — Plan created from the catalog audit + 4 design specs. All items `TODO`. Starting with P0 (#1–#4), one by one.
- 2026-05-31 — Resolved §1 open-Q (b): added the route-state label (now `routeState`) to `enrichmentFields` (modules `ad02ec6`, feat/soft-drop) so reduction is directly attributable per service via `all_events{routeState="drop"}` — no extra aggregator. Confirmed the route-state field accessor (now `EventRouteStateFieldAccessor`) makes it groupable. Runtime proof (label appears) folds into the pending soft-drop demo redeploy. Unblocks #2 estimate_savings (honest per-lever math).

---

## Splunk compaction + search-acceleration finding (2026-05-31, code-grounded, 3-way adversarially verified)

**Question:** does 10x compaction kill Splunk index-time (tsidx/bloom) search acceleration for values inside the compacted message body?

**Verdict: MIXED, and it splits on CONSTANT-in-pattern vs VARIABLE-value.** (3 adversarial verifiers all said CLAIM_CONFIRMED for the variable case; the reader summaries over-stated preservation. Reconciled against the actual code below — both are partly right.)

The app DOES have a query-rewrite layer (not just display decode): `tenxsearch` command / `tenx-search` REST / `tenx_spl_parser` / `tenx_search_builder`. The resolved search (tenx_search_builder.py:311-337) is:
`((<user_words>) OR (tenx_hash IN (h1,h2,...))) | tenx-inflate | ...`
where the hash list comes from `run_dml_search(user_words)` against sourcetype `tenx_dml_pure` — which stores the template PATTERN TEXT with **variables stripped**.

- **CONSTANT-in-pattern term → ACCELERATED.** If the searched word is part of the template's fixed text (e.g. a message phrase, or a value that the templater treats as constant), it matches a row in `tenx_dml_pure` → returns hashes → `tenx_hash IN (...)` is a LITERAL token present in the compacted `_raw` → tsidx + per-bucket bloom prune buckets. Genuine index acceleration. (Inner-encode envelope fields like container/namespace, shipped as literal JSON, are also directly accelerated — separate from this path.)
- **VARIABLE-value term → NOT accelerated (verifiers' case).** If the searched value lives in the per-event variable slots (e.g. a specific user_id/req_id that the templater stripped out of the pattern), it is NOT in `tenx_dml_pure` → no hash from the DML path → the term survives only as the raw `(<user_words>)` OR-branch, searched literally against compacted `_raw` where that value is NOT a stored token → no bloom pruning; correctness leans on the post-`tenx-inflate` `where`. Effectively decode-and-filter.
- **No-DML-match → falls back to the literal user search** (line 328-330), unaccelerated on compacted data.

**Why it matters for savings:** compaction hits ONLY noisy patterns (deliberate cost-vs-speed tradeoff). Honest framing for the savings tool: "compacting a pattern gives full ingest/license cost reduction; searches that filter by the pattern or by constants in it stay index-accelerated; drilling to a specific VARIABLE VALUE inside a compacted pattern costs a decode pass (template-granular prune, then inflate+filter)." Do NOT claim search is unaffected.

**Confidence:** the CODE PATH is high-confidence (read directly, tenx_search_builder.py:289-337). What needs a LIVE Splunk run to settle: whether `tenx_hash IN()` truly triggers bloom/tsidx bucket-skipping in practice; whether `tenx_dml_pure` is itself keyword-indexed; the real cost delta of the variable-value decode-scan at scale; and exactly which tokens the templater classifies constant vs variable (decides how often a user's filter lands in the accelerated vs unaccelerated case).

**Correction to my earlier statement:** I first said outer-encode is needed / all acceleration lost (architecture-lore) — too strong. Then I over-corrected to "refuted for the common case" — too optimistic. The grounded answer is the constant-vs-variable split above. ClickHouse + ES acceleration paths still to be drilled (next).
