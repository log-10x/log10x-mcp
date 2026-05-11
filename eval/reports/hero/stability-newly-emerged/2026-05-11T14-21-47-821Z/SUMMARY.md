# Hero scenario: Stability — newly emerged patterns in the last hour

**Scenario:** `stability-newly-emerged`
**Status:** PASS
**Env:** demo
**Started:** 2026-05-11T14:21:47.826Z
**Duration:** 185.2s
**Bash calls:** 21

## User question

> Are there any patterns that have just started firing in the last hour — patterns that were silent an hour ago but are active now? List up to 3, name them specifically, and characterize whether they look like incidents or normal new traffic.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 7 supported · 8 inconclusive
- **Value delivered:** 0.65 — The agent identified 3 named patterns with characterization (incident-shaped vs normal traffic) and gave actionable watch recommendations, but the core question asked for patterns 'silent an hour ago but active now' — the agent correctly admitted none met that strict definition yet still presented the relative movers as an answer, which partially punts on the original question.
- **Value received:** 0.55 — The environment audit tool returned useful relative-mover data and pattern trend tools provided week-long context, but there was no tool available to directly compare hour-ago vs now pattern presence (zero-to-nonzero), forcing the agent to approximate with 24h baseline deltas rather than the 1h silence-to-active transition the user asked about.

## Sub-agent final synthesis

Now I have a complete picture. The doctor confirms metrics are fresh (emitted within last 15s), all services still emitting, and 1,201 patterns across 3 services. The environment is stable — the 1h audit movers are within-window percentage fluctuations of patterns that are already part of the week-long baseline, not genuinely new/silent-before patterns.

---

## 🔍 Investigation Summary

**The honest answer: no patterns are *completely* silent before and firing for the first time in the last hour.** The environment-wide audit (1h window vs 24h baseline) did surface the top relative movers, and the two error-class patterns are the most noteworthy. Here's what the data actually shows:

---

### Pattern 1 — `status_code_UNAVAILABLE_error_message_data_refused_due_high_memory_usage`
- **1h vs 24h delta:** +39% relative to yesterday per the environment audit
- **Week trend:** stable ($0.02/wk), peaked at 147.8 KB on 2026-05-05 18:00 UTC; Low at 1.8 KB on 2026-05-10 16:00 UTC — this is *intermittent*, not new
- **Rate right now:** near-zero (no events in last 5 minutes per investigate tool)
- **Verdict:** 🟡 **Incident-shaped but intermittent.** The `UNAVAILABLE` + "data refused due high memory usage" content is a genuine pressure signal (likely the OTel collector rejecting log export under memory pressure), but the pattern has existed all week and has already subsided. Watch for recurrence, not a live incident.

### Pattern 2 — `OTLP_LOG_GRPC_Exporter_Export_failed_data_refused_due_high_memory_usage`
- **1h vs 24h delta:** +38% relative to yesterday per the environment audit
- **Week trend:** stable ($0.02/wk), peaked at 140.9 KB on 2026-05-05 18:00 UTC
- **Rate right now:** near-zero (no events in last 5 minutes)
- **Verdict:** 🟡 **Same incident signature as Pattern 1 — they co-move.** This is the exporter-side counterpart (gRPC export failures) to the memory-pressure rejections above. Both peaked together on 2026-05-05, suggesting a prior memory pressure event, not an ongoing one.

### Pattern 3 — `oteldemo_AdService_Targeted_ad_request_received_trace_id_span_id_trace_flags`
- **1h vs 24h delta:** +44% — the largest upward mover in the 1h audit
- **Week trend:** stable ($0.0081/wk), normal traffic shape with no structural change
- **Rate right now:** near-zero (no events in last 5 minutes)
- **Verdict:** 🟢 **Normal traffic variation, not an incident.** AdService request tracing is routine OTel demo telemetry. The +44% is a within-noise hourly fluctuation on a very small-volume pattern.

---

### Recommendations
1. **Patterns 1 & 2 are your watch items.** Both carry "data refused due high memory usage" semantics — set an alert threshold if they fire together again. Their last joint peak was 2026-05-05 18:00 UTC; if they re-emerge, check OTel Collector memory limits.
2. **No true "silent → active" new patterns were detected** in this 1h window. The 24h cost-driver check confirmed all 853 patterns are within normal range. The reported +38–44% deltas are hourly fluctuations on patterns already present all week — not emergent novel patterns.
3. **The cardinality warning from the doctor** (one pattern = 54% of 30-day spend) is worth a follow-up: run `log10x_top_patterns(limit=1)` and then `log10x_investigate` on that single dominant pattern to determine if it's noise you can filter.

## Oracle validation

- Claims found: 15 numeric, 0 pattern names
- Supported by oracle: 7 · Unsupported: 0 · Inconclusive: 8
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **$0.02** — env ~5.40GB/day; claim within plausible cost band
    > +39% relative to yesterday per the environment audit - **Week trend:** stable ($0.02/wk), peaked at 147.8 KB on 2026-05-05 18:00 UTC; Low at 1.8 KB on 2026-05-
- [OK] **$0.02** — env ~5.40GB/day; claim within plausible cost band
    > +38% relative to yesterday per the environment audit - **Week trend:** stable ($0.02/wk), peaked at 140.9 KB on 2026-05-05 18:00 UTC - **Rate right now:** near
- [OK] **$0.0081** — env ~5.40GB/day; claim within plausible cost band
    > ta:** +44% — the largest upward mover in the 1h audit - **Week trend:** stable ($0.0081/wk), normal traffic shape with no structural change - **Rate right now:*
- [OK] **147.8 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > terday per the environment audit - **Week trend:** stable ($0.02/wk), peaked at 147.8 KB on 2026-05-05 18:00 UTC; Low at 1.8 KB on 2026-05-10 16:00 UTC — this i
- [OK] **1.8 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > trend:** stable ($0.02/wk), peaked at 147.8 KB on 2026-05-05 18:00 UTC; Low at 1.8 KB on 2026-05-10 16:00 UTC — this is *intermittent*, not new - **Rate right
- [OK] **140.9 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > terday per the environment audit - **Week trend:** stable ($0.02/wk), peaked at 140.9 KB on 2026-05-05 18:00 UTC - **Rate right now:** near-zero (no events in l
- [WARN] **201 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > metrics are fresh (emitted within last 15s), all services still emitting, and 1,201 patterns across 3 services. The environment is stable — the 1h audit movers
- [OK] **3 services** — oracle reports 1 services
    > mitted within last 15s), all services still emitting, and 1,201 patterns across 3 services. The environment is stable — the 1h audit movers are within-window pe
- [WARN] **853 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > erns were detected** in this 1h window. The 24h cost-driver check confirmed all 853 patterns are within normal range. The reported +38–44% deltas are hourly flu
- [WARN] **+39%** — percentages are derived; oracle does not gate them
    > ILABLE_error_message_data_refused_due_high_memory_usage` - **1h vs 24h delta:** +39% relative to yesterday per the environment audit - **Week trend:** stable ($
- [WARN] **+38%** — percentages are derived; oracle does not gate them
    > porter_Export_failed_data_refused_due_high_memory_usage` - **1h vs 24h delta:** +38% relative to yesterday per the environment audit - **Week trend:** stable ($
- [WARN] **+44%** — percentages are derived; oracle does not gate them
    > rgeted_ad_request_received_trace_id_span_id_trace_flags` - **1h vs 24h delta:** +44% — the largest upward mover in the 1h audit - **Week trend:** stable ($0.008
- [WARN] **+44%** — percentages are derived; oracle does not gate them
    > ot an incident.** AdService request tracing is routine OTel demo telemetry. The +44% is a within-noise hourly fluctuation on a very small-volume pattern. ---
- [WARN] **44%** — percentages are derived; oracle does not gate them
    > iver check confirmed all 853 patterns are within normal range. The reported +38–44% deltas are hourly fluctuations on patterns already present all week — not em
- [WARN] **54%** — percentages are derived; oracle does not gate them
    > t novel patterns. 3. **The cardinality warning from the doctor** (one pattern = 54% of 30-day spend) is worth a follow-up: run `log10x_top_patterns(limit=1)` an

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 6560ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 6269ms, stdout=1448B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 5737ms, stdout=1448B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 5151ms, stdout=1281B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=0, 4383ms, stdout=358B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=1, 3846ms, stdout=307B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_extract_templates --a...
exit=1, 3599ms, stdout=232B, stderr=0B

### 8. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 4852ms, stdout=590B, stderr=0B

### 9. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_retriever_series --ar...
exit=1, 3982ms, stdout=184B, stderr=0B

### 10. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 4697ms, stdout=1870B, stderr=0B

### 11. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 5008ms, stdout=1009B, stderr=0B

### 12. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 4821ms, stdout=1783B, stderr=0B

### 13. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 5621ms, stdout=1775B, stderr=0B

### 14. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 5398ms, stdout=1815B, stderr=0B

### 15. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=0, 5249ms, stdout=359B, stderr=0B

### 16. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=0, 5640ms, stdout=370B, stderr=0B

### 17. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=0, 5113ms, stdout=371B, stderr=0B

### 18. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_examples --ar...
exit=0, 5331ms, stdout=691B, stderr=0B

### 19. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_examples --ar...
exit=0, 5501ms, stdout=710B, stderr=0B

### 20. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=0, 5032ms, stdout=312B, stderr=0B

### 21. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_doctor --args '{}'
exit=0, 13145ms, stdout=5071B, stderr=0B
