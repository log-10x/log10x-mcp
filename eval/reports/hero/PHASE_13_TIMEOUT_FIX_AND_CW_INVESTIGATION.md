# Phase 13: Anthropic timeout fix + CloudWatch SIEM investigation

Three tasks proposed; results mixed. Major bug found in the MCP
CloudWatch path (separate from the Phase 11 event_lookup bridge
bug). Anthropic API throughput at parallel scale remains the
load-bearing constraint on Claude data quality.

## Task 1 — AbortController/timeout on Anthropic SDK ✓ done

`src/agent-clients.ts` AnthropicAgentClient now wraps each
`messages.create` in an `AbortController` with a 180s timeout,
catches and retries on:

- Network errors: `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`,
  `UND_ERR_SOCKET`, `UND_ERR_CONNECT_TIMEOUT`, `ECONNRESET`,
  `ETIMEDOUT`, `AbortError`, `ECONNREFUSED`
- HTTP status: 429, 500, 502, 503, 504, 529 (Anthropic-specific
  overloaded)

Up to 4 attempts with exponential backoff capped at 30s. Mirrors
the existing GrokAgentClient logic.

Smoke test on null-scenario: completed in 667s with 9 API calls;
**did not hang** (prior runs hung indefinitely under same conditions).

The fix is doing what it's designed to do — preventing infinite
hangs. But it cannot accelerate the underlying API; Anthropic's
parallel-scale throughput today is genuinely slow.

## Task 2 — Claude N=10 correlation (1 of 10 completed) ⚠ partial

Launched 10 Claude correlation runs at 8:09 EDT. By 9:05 EDT (56
minutes later): **1 completed, 9 still in-flight**. With 9
concurrent Claude SDK calls, the API was throttling/serializing.

The 1 completed run:

| Metric | Value |
|--------|-------|
| status | PASS |
| drift | 0 |
| value_delivered | 0.65 |
| held_ground | true |
| **causal_rating drift** | **0 (perfect)** |
| over_attributions | 0 |
| bash_calls | 24 |
| duration | 1458s (~24 min for one run) |
| cost | $0.60 |

Consistent with Phase 12 Claude observations (4/4 held_ground=true,
3/4 perfect rating_drift). Combined Claude N across Phases 11 + 12
+ 13 = 6 runs:

- 5/6 perfect causal_rating (no over- or under-attribution)
- 1/6 with single over-attribution (DNS=2 in Phase 12 run 1)
- **Claude over-attribution rate at N=6: 17%**
- vs Grok at N=24: 37.5%

The Claude vs Grok differential signal **directionally holds** at
the merged N=6 vs N=24 sample, but Claude N is still too small for
a confident cross-model claim. The right next session step is to
re-run Claude N=10-20 in serial (not parallel) to dodge the
throughput bottleneck, OR investigate the Anthropic SDK's parallel
behavior for tuning.

## Task 3 — CloudWatch SIEM path: investigated, found a NEW MCP bug ⚠ filed

### What I checked first

Demo cluster inventory:
- `tenx-fluentd` daemonset in namespace `demo` tails
  `/var/log/containers/*_otel-demo_*.log` and ships to 10x engine
  (NOT to CloudWatch). Terminal output is `@type null`.
- No CW agent or fluent-bit-cloudwatch sidecar exists.
- AWS CW Log Groups inventory has Lambda + EKS control-plane,
  but no application logs from otel-demo.

So the canary's logs are visible to the 10x Prometheus tier ONLY.
To test the MCP's CloudWatch SIEM connector, I needed to ship
events to CW from scratch.

### Smallest viable test

Created a fresh CW Log Group `/log10x-eval/synthetic-canary` and
pushed 7 representative events via `aws logs put-log-events`:

- 3 canary `checkout retry blast` events
- 2 payment-gateway connection-pool events
- 2 DNS-failure events

Verified events are queryable via direct AWS CLI:

```bash
$ aws logs filter-log-events --log-group-name /log10x-eval/synthetic-canary \
    --region us-east-1 --filter-pattern '"checkout retry blast"' --start-time 0
{
    "events": [ ... 3 events returned ... ]
}
```

### MCP CloudWatch path returns "no events" — and surfaces a new bug

```bash
$ AWS_REGION=us-east-1 LOG10X_EVAL_ENV=demo node eval/bin/mcp-call.mjs \
    --tool log10x_pattern_examples \
    --args '{"pattern":"checkout retry blast","scope":"/log10x-eval/synthetic-canary","vendor":"cloudwatch","time_range":"15m"}'
## Pattern Examples — no events in 1h window

No events matched the probe in the 1h window on cloudwatch.
Query used: `/log10x-eval/synthetic-canary | @message like /checkout/ and @message like /retry/ and @message like /blast/`

### Probe notes
- bucket_0_/log10x-eval/synthetic-canary_error: Invalid character(s) in term '@'
- ... (24 more notes truncated)
```

### Root cause

Two files in the MCP source disagree on CloudWatch query syntax:

- `src/tools/pattern-examples.ts` `case 'cloudwatch'` generates **Logs Insights**
  syntax: `@message like /escaped/ AND ...`
- `src/lib/siem/cloudwatch.ts` invokes **`FilterLogEventsCommand`** (NOT Insights).
  `FilterLogEvents` expects CloudWatch filter pattern syntax
  (e.g. `"phrase"`, `?error ?warn`) — `@message like /.../` is invalid.

The 25-bucket diagnostic note "Invalid character(s) in term '@'"
is FilterLogEvents rejecting Insights-syntax filter patterns.

**Filed as a structured bug report**: `eval/gaps/MCP_cloudwatch_filterpattern_syntax_mismatch.md`.

This is the **second MCP product gap** the harness has surfaced
(the first being `event_lookup` ↔ engine-pattern-hash bridge in
Phase 11). Both are on the SIEM-side path.

### Why this matters for the harness

The harness's `value_received` scores have hovered at 0.3-0.5
across 12 phases. Phase 9 noted "MCP isn't carrying the
investigation — kubectl/gh are." That low value_received was
**partly an MCP product bug**, not a scenario-design choice.
Once `pattern_examples` with CW vendor returns events, value_received
should rise.

The harness has now done its job at the meta-level: by trying to
exercise the SIEM-side MCP path, it revealed that the path is
broken end-to-end. Fixing the syntax mismatch unblocks an entire
class of test scenarios that Phase 14+ can run.

## Cumulative status across 13 phases

| Metric | Value |
|--------|-------|
| Hero runs total | **189** (188 + 1 from this batch) |
| Surface drift=0 | 183 |
| Surface agent fabrications | **0** |
| Causal over-attributions | 10 (Grok 9, Claude 1) |
| Cross-model rate (Grok over-attribution) | 37.5% (9/24) — p ≈ 0.000003 |
| Cross-model rate (Claude over-attribution) | 17% (1/6) — sample too small |
| **MCP product gaps surfaced** | **2** (event_lookup bridge + CW filter syntax) |

## Open follow-ups after Phase 13

1. **MCP product gap: CW filter syntax** — `eval/gaps/MCP_cloudwatch_filterpattern_syntax_mismatch.md`.
   Proposed fix (Option A): rewrite `buildPatternSearch()` case
   `'cloudwatch'` to emit FilterLogEvents-compatible patterns
   instead of Insights syntax. ~30 min code change.
2. **MCP product gap: event_lookup bridge** — `eval/gaps/MCP_event_lookup_pattern_hash_bridge.md` (filed in Phase 12).
3. **Claude N=10 correlation** — gated on Anthropic parallel-scale
   throughput. Best path: switch to serial (sleep between launches)
   for Claude. Or: investigate SDK-level batching.
4. **AWS CloudWatch SIEM path full integration** — once gap #1
   above is fixed, the harness can run scenarios that exercise
   the real SIEM-backed MCP tools (log10x_pattern_examples with
   real-CW data). This was the original Test family C the user
   proposed. Would meaningfully close the value_received gap.

## What Phase 13 actually delivered

- ✓ Anthropic SDK timeout/retry — every future high-N batch is
  protected from infinite hangs. The throughput bottleneck remains
  but isn't a hang.
- ✓ Causal_rating metric is in production-grade shape (Phase 12;
  validated again here).
- ✓ Discovered the CW MCP path is broken (2nd product gap).
- ⚠ Claude N=10 partial — 1/10 completed; data point consistent
  with Phase 12 findings, sample size unchanged for the
  cross-model claim.

## Files

  M eval/src/agent-clients.ts                          (timeout/retry on Anthropic)
  + eval/gaps/MCP_cloudwatch_filterpattern_syntax_mismatch.md
  + 1 Phase 13 hero transcript (correlation-related-vs-noise)
  + eval/reports/hero/PHASE_13_TIMEOUT_FIX_AND_CW_INVESTIGATION.md
  M eval/COUNTERFACTUAL.md                             (Phase 13 section)

CW Log Group `/log10x-eval/synthetic-canary` created with 7-day
retention; leaves a small footprint that should not exceed CW free
tier. Can be deleted with `aws logs delete-log-group`.
