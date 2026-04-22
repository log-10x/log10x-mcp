# Engine team tickets — ready to file

These are pre-written tickets for the engine-side bugs caught during the 2026-04-15 GA hardening session. All have MCP-layer mitigations shipped (PRs #32–#36) but need engine root-cause fixes before the affected workflows are fully GA-ready.

Each ticket is self-contained — copy the title and body directly into whichever issue tracker the engine team uses.

## 2026-04-15 evening status

- **Ticket 0 (G12 JSONL writer)**: confirmed engine bug, awaits engine fix. MCP shape guard merged.
- **Ticket 1 (G11 paste templatizer)**: **Status split.**
  - In-cluster fluentd ingestion path: hot-patched live in 4 fluentd pods (group-template.js negator-fallback branch). Verified — 30-line G11 bundle produces 22 distinct templates instead of 7. Awaits image rebuild for permanence.
  - **Paste Lambda path: STILL BROKEN.** Reproduced 2026-04-15 evening: `log10x_resolve_batch` with 10 distinct lines returns 3 patterns, 7 lines silently dropped, cross-event template merge present (libgssapi error + shipping error glued by `\n` in Pattern #1's body). The paste Lambda is a separate deployment from in-cluster fluentd — different image, different runtime — so the hot-patch never touched it. **The G11 fix needs a coordinated rollout: rebuild engine image AND redeploy the paste Lambda.** Customers using SlackPasteBot / `/log10x triage` are still affected even after the fluentd image rebuild lands. See **Ticket 1b** below.
  - **Failure 4 (UUID over-segmentation) WITHDRAWN** — `$-$-$-$-$` still produces stable templateHash for structurally-identical UUIDs; structural identity is preserved.
- **Ticket 2 (G12 streamer)**: **Status split.**
  - **Failure B (-32000 crash on canonical name): RESOLVED.** Did not reproduce post-fix. Was an artifact of the malformed body in Failure A.
  - **Failure A (zero events on known-exists data): RECONFIRMED reproducible.** PR #36 fixed the body shape (verified end-to-end with 886 matched / 16 returned earlier today after manually triggering an indexer run). Hours later, multiple distinct queries reproduce the 0-events / 92s wall-time symptom: `tenx_user_service=="frontend"`, `includes(text, "shipping")`, and canonical pattern-name searches all return 0 against an environment where `pattern_trend` shows live $4.1/day CRIT shipping traffic. The earlier 16-event verification required manually copying an existing S3 object to trigger an indexer event — twice today. **The pattern of needing manual S3 triggers indicates a real indexer freshness/coverage bug, root cause TBD.** Hypotheses: (a) indexer's S3 event subscription not firing reliably, (b) indexer cron is too sparse, (c) indexer crashes silently on certain object shapes. Need engine investigation with indexer-pod logs tailed during a live query.
- **Ticket 3 (G10 fingerprinter)**: **WITHDRAWN.** The two product-reviews templates are structurally different at the templater level (different literal sets in overlapping positions) — the templater is internally consistent. PR #35's MCP-layer collapse heuristic addresses the operational UX pain at the right layer. Not an engine bug.
- **Ticket 4 (G9 tenx-edge stale state)**: **Confirmed engine bug, root cause TBD.** Symptom is reproducible and currently active: doctor flags 11 services with non-zero 24h volume and zero 15m volume; `kubectl rollout restart ds/tenx-fluentd` clears it instantly. Two hypotheses ruled out today against the source: `PrometheusRequestBuilder.reportedCounters` latch (zero-baselines are first-time-only by design — missing them on retry is correct, not a bug) and `BaseReaderDecoderProducer` backpressure wait loop (the `wait(intervalDuration)` + time-gated `shouldTest()` recovers after at most one interval, not a deadlock). Need live repro with thread dump from a stuck pod and Prometheus scrape logs (Grok's hint: check for missing labels during recovery — could indicate metric exporter caching service metadata incorrectly during backpressure recovery).

---

## Ticket 1b — GA BLOCKER: Paste Lambda runs unfixed templater (separate from in-cluster fluentd)

**Severity**: GA blocker for the paste-triage workflow. SEPARATE from Ticket 1's in-cluster fluentd fix.
**Affected component**: Paste Lambda (the AWS Lambda behind `LOG10X_PASTE_URL` that backs `log10x_resolve_batch`).
**GAPS ID**: G11 (Lambda half)

### Evidence

`log10x_resolve_batch` with 10 distinct log lines (subset of the original G11 bundle) on 2026-04-15 evening:

Input:
```
info: cart.cartstore.ValkeyCartStore[0] GetCartAsync called with userId=0b244836-38ef-11f1-97c3-2e37e12f85c8
Error: libgssapi_krb5.so.2: cannot open shared object file: No such file or directory
Post "http://shipping:8080/quote": unsupported protocol scheme "shipping"
2026-04-15T17:23:47Z WRN checkpoints.go:73 failed to find checkpoint: resource not found
grpc: addrConn.createTransport failed to connect to {Addr: "jaeger:4317", ServerName: "jaeger:4317"}
AdService Targeted ad request received for "books" with trace_id=abc123
frontend: POST /api/checkout 200
opentelemetry-collector: exporter otlp failed to send metrics: rpc error: code=Unavailable
payment: gRPC server started on :9000
kube-proxy: Running on node ip-10-0-48-245.ec2.internal
```

Output: 3 patterns, **7 lines (70%) silently dropped**. Pattern #1's body literally contains the libgssapi error AND the Post shipping error fused with `\n`:
```
template: 'Error: libgssapi_krb5.so.$: cannot open shared object file: No such file or directory\nPost "http://shipping:$/quote": unsupported protocol scheme...'
```

This is the same cross-event template merge bug from the original G11 ticket, in a different deployment.

### Why the in-cluster hot-patch doesn't help

The hot-patch applied earlier this session was `kubectl cp` of `group-template.js` into 4 in-cluster fluentd pods, followed by `kill <PID>` to respawn the tenx-edge child. The paste Lambda is an entirely separate AWS Lambda runtime — it bundles its own copy of the engine, runs in Lambda execution environment, and is not reachable via kubectl. The hot-patch never touched it.

### Required fix

Rebuild the engine image (which fixes the in-cluster fluentd path's persistence issue too), then redeploy the paste Lambda with the new image. Both are downstream of the same engine source change, so a single image rebuild covers both surfaces.

### MCP-side mitigation

PR #35's drop-count warning IS already firing on the broken paste Lambda output and correctly tells users not to trust the result. But the workflow remains unusable for production triage until the paste Lambda is redeployed.

---

## Ticket 0 — Streamer JSONL writer doesn't escape `\n` in the `text` field

**Severity**: high. Produces subtly-broken JSONL that requires client-side workarounds.
**Affected component**: `IndexQueryWriter` (or whatever writes the stream-worker's JSONL result files to S3 under `tenx/{target}/qr/{queryId}/*.jsonl`).
**GAPS ID**: G12 (partial, the client-side half is fixed)

### Evidence

Pulled a sample JSONL file from the streamer's result bucket during G12 verification:
```
s3://tenx-demo-cloud-streamer-351939435334/indexing-results/tenx/app/qr/ff4ae1fc-b89c-4525-ab95-c1cc2a02d48e/wcZSyGG_nMnwQaNzc98Stg.jsonl
```

Parsed it in Node with `content.split(/\r?\n/).map(JSON.parse)`:
- 727 non-empty lines total
- 685 parse as valid JSON (94%)
- **42 parse as invalid JSON** (6%) — these are mid-record fragments where the split hit an unescaped newline inside a `text` field
- Of the 685 valid parses, only some are "real" events; the rest are the fluentd-wrapped inner shape (`{stream, log, docker, kubernetes, tenx_tag}`) which is itself valid JSON by coincidence

The `text` field of real events looks like:
```
"text":"{\"stream\":\"stderr\",\"log\":\"2026-04-15T12:08:00.183Z\\tinfo\\tinternal/retry_sender.go:133\\tExporting failed. ..."
```

Note `\\t` is correctly escaped (because the internal JSON-in-JSON uses `\\` for its own escapes). But the OUTER record's newline escaping is wrong: when the content includes a raw `\n` from the source log, it ends up as a literal `\n` byte in the outer JSONL line, breaking the record into two.

### Required fix

In the writer that serializes `StreamerEvent` → JSONL, escape newlines in string field values as `\\n` before `JSON.stringify`. Or just use a standard JSON library that handles this (most do by default — custom escape logic likely introduced the bug).

Test: emit an event whose `text` field contains `"line1\nline2"`. Read the output file via `split('\n').map(JSON.parse)` and assert both lines of the input appear in the same parsed record's `text` field, not split across two JSON parses.

### MCP-side mitigation shipped

`parseJsonl` in `src/lib/streamer-api.ts` now includes a shape guard that rejects records missing the expected event fields (timestamp, text, tenx_user_service, tenx_user_process, LevelTemplate.severity_level, MessageTemplate.message_pattern). Fluentd-wrapped fragments with only `{stream, log, docker, kubernetes, tenx_tag}` get discarded. Count / aggregated / events renders now work correctly end-to-end.

When the engine writer is fixed, the shape guard becomes a defensive no-op — fragments won't exist anymore, so nothing to discard.

---

## Ticket 1 — GA BLOCKER: Paste Lambda templatizer silently drops input lines

**Severity**: GA blocker for the paste-triage workflow.
**Affected tool**: `log10x_resolve_batch` (MCP), and by extension the SlackPasteBot / `/log10x triage` workflow and any customer using the paste endpoint directly.
**GAPS ID**: G11

### Evidence (verbatim from sub-agent S9, 2026-04-15)

S9 pasted 30 distinct log lines into `log10x_resolve_batch` and received back 7 patterns accounting for only ~9 events. **21 of 30 lines silently dropped.** No error, no warning, no "uncategorized" bucket — the tool trusted the templater's output blindly.

**Failure taxonomy** (per S9's per-line verdict table):

1. **Cross-event template merge (critical).** Pattern #1's template literally contained two newline-joined distinct log lines glued together: the `libgssapi_krb5.so.2` error AND the `Post "http://shipping:8080/quote"` error fused into one template. Same bug on pattern #6 (checkpoints.go line merged with grpc jaeger line). The templatizer is sliding a tokenization window across event boundaries and emitting one template spanning two distinct log records.

2. **Over-split.** Lines 6+7 were byte-identical libgssapi errors but got different pattern identities because line 6 got glued to line 8. Two identical bytes → two identities. Deterministic templater output should be byte-deterministic.

3. **Silent event dropping.** ~21 of 30 lines produce no pattern row at all. The JSON response header says "30 events, resolved into 7 distinct patterns" but no mechanism indicates which 21 of 30 weren't accounted for. A triage report built on this output silently hides 70% of the input.

4. **UUID over-segmentation.** UUIDs like `1a4d9e7a-38ef-11f1-97c3-2e37e12f85c8` are split on every `-` into 5 separate slots (`$-$-$-$-$`) rather than treated as one token. This inflates template diversity and causes byte-identical events to produce different templates depending on surrounding context.

5. **Variable name leakage.** Literals like `shipping` and `checkpoints.go` are being used as slot names (e.g. `shipping · 1 distinct · '8080' 100%`) even when there's no `k=v` structure in the source. Purely cosmetic but erodes trust in the report output.

### Reproduction

```bash
# From the log10x-mcp session
log10x_resolve_batch({
  source: "events",
  events: [
    "info: cart.cartstore.ValkeyCartStore[0] GetCartAsync called with userId=0b244836-38ef-11f1-97c3-2e37e12f85c8",
    "info: cart.cartstore.ValkeyCartStore[0] GetCartAsync called with userId=7c881929-38ef-11f1-97c3-2e37e12f85c8",
    "info: cart.cartstore.ValkeyCartStore[0] AddItemAsync called with userId=1a4d9e7a-38ef-11f1-97c3-2e37e12f85c8, productId=6E92ZMYYFZ, quantity=2",
    "info: cart.cartstore.ValkeyCartStore[0] AddItemAsync called with userId=0b244836-38ef-11f1-97c3-2e37e12f85c8, productId=LECAVKIM, quantity=1",
    "info: cart.cartstore.ValkeyCartStore[0] EmptyCartAsync called with userId=06446cce-38ef-11f1-97c3-2e37e12f85c8",
    "Error: libgssapi_krb5.so.2: cannot open shared object file: No such file or directory",
    "Error: libgssapi_krb5.so.2: cannot open shared object file: No such file or directory",
    "Post \"http://shipping:8080/quote\": unsupported protocol scheme \"shipping\"",
    "Post \"http://shipping:8080/quote\": unsupported protocol scheme \"shipping\"",
    "2026-04-15T17:23:47Z WRN checkpoints.go:73 failed to find checkpoint: resource not found",
    "2026-04-15T17:23:52Z WRN checkpoints.go:73 failed to find checkpoint: resource not found",
    "grpc: addrConn.createTransport failed to connect to {Addr: \"jaeger:4317\", ServerName: \"jaeger:4317\"}",
    "grpc: addrConn.createTransport failed to connect to {Addr: \"jaeger:4317\", ServerName: \"jaeger:4317\"}",
    "AdService Targeted ad request received for \"books\" with trace_id=abc123",
    "AdService Targeted ad request received for \"binoculars\" with trace_id=def456",
    // ... 15 more lines — see full list in session 2026-04-15 S9 prompt
  ]
})
```

Expected: ≥15 distinct pattern identities (allowing reasonable deduplication of byte-identical lines).
Actual: 7 patterns accounting for ~9 events. 21 lines silently dropped. Cross-event templates.

### Required fixes

1. **Templatizer must never span newline boundaries.** Add test coverage: "30 distinct lines produce ≥N identities where N >= (distinct structural shapes in the input)".
2. **UUID tokenization**: treat `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` as a single slot, not 5.
3. **Byte-deterministic output**: byte-identical input lines must always produce the same templateHash regardless of surrounding context.
4. **Non-dropping guarantee**: every input line must be accounted for in the output (assigned to a pattern OR explicitly flagged as "uncategorized"). Silent drops are the worst possible failure mode for a triage tool.
5. **Variable-name inference**: do not use preceding literals as slot names unless there's a `k=v` structure in the source.

### MCP-side mitigation already shipped

PR #35 (`log10x-mcp` repo) added a drop-count warning in `resolve_batch`:
- Compares `encoded.length` (events accounted for) against `lineCount` (input lines)
- If the gap is ≥20% of input, emits a prominent warning with the exact drop count and a pointer to this ticket
- Minor drops (5-20%) get a quieter one-line note
- The mitigation surfaces the problem but does NOT fix it — users still can't safely use the paste-triage workflow for production incidents.

---

## Ticket 2 — GA BLOCKER: Streamer forensic query false negatives + crash on canonical pattern names

**Severity**: GA blocker for the forensic retrieval workflow. Storage Streamer is the Tier-4 customer capability and a key GA selling point.
**Affected tool**: `log10x_streamer_query` (MCP), and any direct caller of the streamer `/query` endpoint.
**GAPS ID**: G12

### Evidence (verbatim from sub-agent S7, 2026-04-15)

S7 attempted to reconstruct a shipping-error incident via forensic retrieval. Streamer endpoint was confirmed configured (`log10x_doctor` → streamer_endpoint PASS, Edge Reporter tier, prometheus gateway reachable). The shipping pattern was confirmed to have ~$11K/wk of traffic with 166 data points and a 109 GB peak visible via `log10x_pattern_trend`.

**Two reproducible failures**:

#### Failure A — False negatives on known-exists data

```
log10x_streamer_query({
  pattern: "shipping",
  from: "2026-04-12T11:30:00Z",
  to: "2026-04-12T12:30:00Z",
  format: "events"
})
```

Returns 0 events. Wall time ~92 seconds (full query execution — submitter reached the marker prefix and read the empty results prefix). Reproduced with `now-3d`-style relative expressions and with `last 1h` windows — same zero result in every case.

Independent ground truth via `log10x_pattern_trend` on the same pattern in overlapping windows: 166 data points, ~$11K/wk average, 109 GB peak at 2026-04-14T08:00 UTC. The events definitely exist in the archive (or the metric path is flagrantly lying, which we don't think it is).

**Two query IDs for the record**: `ad907b42-e113-463c-86fd-30176dd01db4`, `5ec74e06-75b0-4b4f-855a-a93176fef038`.

#### Failure B — `-32000: Connection closed` on canonical pattern names

```
log10x_streamer_query({
  pattern: "shipping_service_Post_shipping_get_quote_unsupported_protocol_scheme_shipping",
  from: "now-1h"
})
```

Reproducible, 2+ attempts. Returns `MCP error -32000: Connection closed`. Short-form (`shipping`) does not crash but returns 0 events (Failure A).

### Hypothesis space (not yet diagnosed)

1. **Archive coverage gap**: the Bloom filter index doesn't cover the time windows being queried. Check whether the streamer indexer has ingested the affected time ranges.
2. **Target prefix mismatch**: the streamer is writing under a different `target` than the default (`app`). Check `LOG10X_STREAMER_TARGET` / `LOG10X_STREAMER_INDEX_SUBPATH` in the MCP config against what the indexer actually uses.
3. **Name-based filter mismatch**: canonical slash-underscore pattern names don't match the stored event keys. The indexer may be storing raw pattern body text, not the encoded identity.
4. **-32000 crash root cause**: likely a length cap, special-char escaping, or JSON field handling bug in the streamer request handler. Check `src/main/java/com/log10x/ext/quarkus/streamer/...` for input validation on the `name` parameter.
5. **Recently-wired-up race**: the streamer was deployed during the 2026-04-15 otel-demo swap. If the indexer hasn't backfilled historical S3 objects yet, queries against older windows will return empty by design but the tool should say so, not return an empty dataset without explanation.

### Required investigation

1. Pull the streamer coordinator logs during a Failure A reproduction. Confirm the query submitted, which workers ran it, what marker objects were written, and whether the JSONL results prefix is actually populated or just empty.
2. Reproduce Failure B locally in the engine dev env. The -32000 is an RPC-level failure that propagates up through the MCP client as "Connection closed" — the underlying HTTP response or exception should be captured in the streamer service logs.
3. Document the expected pattern-name encoding for streamer queries. Is it the canonical snake_case identity? Raw message body? Template ID? The MCP tool currently passes whatever the caller provides, which may mismatch what the indexer stores.

### MCP-side mitigation already shipped

PR #35 (`log10x-mcp` repo) added a `streamer_forensic_health` doctor check that permanently WARNs whenever `LOG10X_STREAMER_URL` is configured, with three practical workarounds:
1. Use short pattern names / free-text search strings rather than canonical identities
2. Cross-check any zero-event result against `log10x_pattern_trend` before concluding the archive is empty
3. Prefer `log10x_event_lookup` + `log10x_pattern_trend` for incident reconstruction where approximate timing is acceptable

The MCP will downgrade the check to conditional PASS once this ticket is fixed.

---

## Ticket 3 — Fingerprinter leaks high-cardinality variables into pattern identities

**Severity**: UX / credibility — not a data-loss bug, but produces phantom "5 patterns declined" alerts when users rotate.
**Affected tool**: anywhere the engine emits `message_pattern` label values.
**GAPS ID**: G10

### Evidence

The real otel-demo `product-reviews` service produces pattern identities like:
```
service_name_product_reviews_trace_sampled_True_username_bookworm_astro
service_name_product_reviews_trace_sampled_True_username_history_buff_description
service_name_product_reviews_trace_sampled_True_username_ancient_texts_description
service_name_product_reviews_trace_sampled_True_username_rare_find_description
service_name_product_reviews_trace_sampled_True_username_celestial_history
```

Each username variant gets its own pattern identity. When the load generator cycles through a new set of reviewer usernames, the previous set's patterns all drop to zero simultaneously — the env audit then shows 5 patterns "declined -100%" in a single service, which looks like a service incident but is actually variable-value rotation.

### Required fix

The fingerprinter should tokenize / strip high-cardinality variable values (usernames, UUIDs, request IDs) before computing the pattern identity. Identical log *structure* with different variable values should produce the *same* pattern ID, not N different ones. The tokenizer probably already has a `VAR_TOKEN_SET` — `username`, `trace_id`, `span_id`, `userId`, etc. should be in it.

### MCP-side mitigation already shipped

PR #35 added a collapse heuristic in `renderEnvironmentAudit`:
- When ≥3 patterns from the same service have rate changes within ±5% of each other AND |rc| >= 0.5, collapse them into a single summary row
- Annotation explains the fingerprinter leak and points to drilling into any one variant if the signal is real

This reduces the noise but doesn't fix the underlying cardinality explosion in the metric backend — every distinct username still creates a new time series and consumes label space.

---

## Ticket 4 — tenx-edge subprocess stale state after prolonged remote-write rejection

**Severity**: Customer upgrade gotcha — MATERIAL for any customer running multi-node forwarder installs.
**Affected component**: `tenx-edge` subprocess spawned by fluentd's `exec_filter`.
**GAPS ID**: G9

### Evidence

After deploying backend PR #55 (G8 fix for the prometheus-proxy usage-metric collision) at 2026-04-15 16:58 UTC, fluentd OOO errors immediately dropped to zero. However, cart / frontend / other service volumes in log10x stayed near zero for several minutes despite kubectl confirming those services were actively logging. A `kubectl rollout restart ds/tenx-fluentd` resolved it — fresh tenx-edge subprocesses immediately resumed shipping metrics.

**Observed again 2026-04-15 19:13 UTC**: doctor's `forwarder_dark_zones` check flagged 14 services with non-zero 24h volume and zero 15m volume including cart and frontend, which kubectl confirmed were actively logging. A second DaemonSet rollout restart was required to clear the state.

The issue appears to be that tenx-edge's internal write-error state (buffer, circuit breaker, or metric producer error flag) does not reset when the downstream write path recovers. Fluentd's `exec_filter` keeps the child subprocess alive across errors, so whatever stale state is there persists indefinitely until the parent restarts.

### Required investigation

1. Review the tenx-edge subprocess write path: look for latched error flags, retry queues that don't drain, circuit breakers that don't reset, backpressure conditions that don't clear.
2. Add a "self-heal" check: periodic probe of the downstream write endpoint, and if it recovers, reset any latched error state.
3. Alternatively: add an exec_filter wrapper that detects N consecutive empty emission windows and SIGTERMs the child so fluentd respawns it.

### Customer impact

Any customer who upgrades to a forwarder version that contained a write-error period (whether from G8 itself or an upstream outage) will have silent metric loss until either the pod is rolled or something triggers a child-process respawn. The MCP doctor check (PR #35) detects the symptom and points users at `kubectl rollout restart ds/tenx-fluentd`, but the root cause should self-heal rather than require manual intervention.

---

## How to file these

Copy each ticket's title + body into the appropriate engine tracker. Link back to this file for persistent context. GAPS.md tracks the MCP-side status of each; update both files when engine fixes land.

Each ticket's MCP-side mitigation is already shipped and live on prod `prometheus.log10x.com` via the log10x-mcp package. No coordinated rollout required — engine fixes and MCP mitigations are independent.
