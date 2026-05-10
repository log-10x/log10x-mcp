# Hero scenario: Cost — what's actually driving the bill

**Scenario:** `cost-bill-driver`
**Status:** PASS
**Env:** demo
**Started:** 2026-05-10T12:54:24.175Z
**Duration:** 349.0s
**Bash calls:** 9

## User question

> Our log bill jumped this week. What's driving it? Use cost_drivers as your starting point and report the actual growth deltas, not the current top by volume — I want to know what GREW, not what's biggest.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 1 supported · 19 inconclusive
- **Value delivered:** 0.72 — The agent correctly reported the truthful negative (no growth detected), contextualized it well, and provided actionable next steps (exclusion filters, billing escalation), but could not answer the user's core question about what drove the bill jump since the tool found no growth deltas.
- **Value received:** 0.65 — cost_drivers returned a truthful negative across all windows and top_patterns gave useful current-rank data, but log10x_savings timed out three times before finally returning via a workaround, indicating partial reliability in the MCP responses.

## Sub-agent final synthesis

I now have all the data I need from every tool. Here's the complete picture:

---

## Cost Driver Investigation — Finance Escalation

### Growth deltas (what GREW): None detected

`log10x_cost_drivers` was run across **1,188 patterns** at the 7d, 1d, and 30d windows. All three returned the same verdict:

> **"no cost drivers detected"** — no pattern crossed the delta threshold. The environment is stable vs the 3-window rolling baseline (offsets: 7d / 14d / 21d).

This is a truthful negative result from the tool, not a tool failure. **There are no week-over-week growth outliers to report.**

---

### Current top cost (biggest right now — for context only)

`log10x_top_patterns` shows the bill at **$25/wk total**, with the top 10 patterns accounting for 47% of volume:

| # | Pattern | Cost |
|---|---------|------|
| 1 | *(unknown)* | $4.2/wk |
| 2 | `open telemetry opentelemetry collector contrib exporter opensearchexporter` | $3.8/wk |
| 3 | `opentelemetry io collector processor batchprocessor v batch processor go` | $3.7/wk |
| 4 | `service instance id service name otelcol contrib service version otelcol` (ERROR) | $3.6/wk |
| 5 | `service instance id service name otelcol contrib service version otelcol` (DEBUG) | $2.1/wk |

53% of volume sits in the long tail. These are **current rank by cost, not growth signals** — the tool explicitly flags them as such.

---

### Savings pipeline — where the real lever is

`log10x_savings` reports the Retriever is already diverting **10.2 GB to S3**, saving **$15/wk** ($788/yr projected) at the current $1.5/GB analyzer + $0.02/GB storage rate. Coverage note from the tool: only 10/14 retriever chunks returned (71%), so the true savings figure is equal or higher.

---

### What this means and what to do

1. **The "jump" isn't a sudden growth spike.** No pattern grew disproportionately this week — costs are flat against a 3-week rolling baseline across all 1,188 patterns. If the invoice number went up, the delta likely reflects **billing cycle timing, tier changes, or a pricing update** outside the log pattern layer — escalate to vendor billing.
2. **The dominant cost is infrastructure telemetry noise.** The top patterns are all OTel collector internals (`opensearchexporter`, `batchprocessor`, `ConsumeLogsFunc`). These are high-frequency, low-signal logs — strong candidates for exclusion filters or sampling rules.
3. **Immediate action:** Run `log10x_exclusion_filter` against pattern `service instance id service name otelcol contrib service version otelcol` (DEBUG tier, $2.1/wk) — DEBUG-level collector self-telemetry is almost always droppable at the pipeline edge with zero operational impact.
4. **Expand Retriever coverage** to close the 29% gap (4 missing chunks); doing so will firm up the $788/yr savings projection and may reveal additional archivable patterns in the long tail.

## Oracle validation

- Claims found: 20 numeric, 0 pattern names
- Supported by oracle: 1 · Unsupported: 0 · Inconclusive: 19
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [WARN] **$25** — no targeted oracle path for this kind; claim accepted as plausible
    > iggest right now — for context only) `log10x_top_patterns` shows the bill at **$25/wk total**, with the top 10 patterns accounting for 47% of volume: | # | Pa
- [WARN] **$4.2** — no targeted oracle path for this kind; claim accepted as plausible
    > % of volume: | # | Pattern | Cost | |---|---------|------| | 1 | *(unknown)* | $4.2/wk | | 2 | `open telemetry opentelemetry collector contrib exporter opensea
- [WARN] **$3.8** — no targeted oracle path for this kind; claim accepted as plausible
    > `open telemetry opentelemetry collector contrib exporter opensearchexporter` | $3.8/wk | | 3 | `opentelemetry io collector processor batchprocessor v batch pro
- [WARN] **$3.7** — no targeted oracle path for this kind; claim accepted as plausible
    > | `opentelemetry io collector processor batchprocessor v batch processor go` | $3.7/wk | | 4 | `service instance id service name otelcol contrib service versio
- [WARN] **$3.6** — no targeted oracle path for this kind; claim accepted as plausible
    > ice instance id service name otelcol contrib service version otelcol` (ERROR) | $3.6/wk | | 5 | `service instance id service name otelcol contrib service versio
- [WARN] **$2.1** — no targeted oracle path for this kind; claim accepted as plausible
    > ice instance id service name otelcol contrib service version otelcol` (DEBUG) | $2.1/wk | 53% of volume sits in the long tail. These are **current rank by cost
- [WARN] **$15** — no targeted oracle path for this kind; claim accepted as plausible
    > savings` reports the Retriever is already diverting **10.2 GB to S3**, saving **$15/wk** ($788/yr projected) at the current $1.5/GB analyzer + $0.02/GB storage
- [WARN] **$788** — no targeted oracle path for this kind; claim accepted as plausible
    > eports the Retriever is already diverting **10.2 GB to S3**, saving **$15/wk** ($788/yr projected) at the current $1.5/GB analyzer + $0.02/GB storage rate. Cove
- [WARN] **$1.5** — no targeted oracle path for this kind; claim accepted as plausible
    > verting **10.2 GB to S3**, saving **$15/wk** ($788/yr projected) at the current $1.5/GB analyzer + $0.02/GB storage rate. Coverage note from the tool: only 10/1
- [WARN] **$0.02** — no targeted oracle path for this kind; claim accepted as plausible
    > o S3**, saving **$15/wk** ($788/yr projected) at the current $1.5/GB analyzer + $0.02/GB storage rate. Coverage note from the tool: only 10/14 retriever chunks
- [WARN] **$2.1** — no targeted oracle path for this kind; claim accepted as plausible
    > instance id service name otelcol contrib service version otelcol` (DEBUG tier, $2.1/wk) — DEBUG-level collector self-telemetry is almost always droppable at th
- [WARN] **$788** — no targeted oracle path for this kind; claim accepted as plausible
    > r coverage** to close the 29% gap (4 missing chunks); doing so will firm up the $788/yr savings projection and may reveal additional archivable patterns in the
- [OK] **10.2 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > he real lever is `log10x_savings` reports the Retriever is already diverting **10.2 GB to S3**, saving **$15/wk** ($788/yr projected) at the current $1.5/GB an
- [WARN] **188 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > wth deltas (what GREW): None detected `log10x_cost_drivers` was run across **1,188 patterns** at the 7d, 1d, and 30d windows. All three returned the same verdi
- [WARN] **10 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > t only) `log10x_top_patterns` shows the bill at **$25/wk total**, with the top 10 patterns accounting for 47% of volume: | # | Pattern | Cost | |---|---------
- [WARN] **188 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > ately this week — costs are flat against a 3-week rolling baseline across all 1,188 patterns. If the invoice number went up, the delta likely reflects **billing
- [WARN] **47%** — percentages are derived; oracle does not gate them
    > ns` shows the bill at **$25/wk total**, with the top 10 patterns accounting for 47% of volume: | # | Pattern | Cost | |---|---------|------| | 1 | *(unknown)*
- [WARN] **53%** — percentages are derived; oracle does not gate them
    > e id service name otelcol contrib service version otelcol` (DEBUG) | $2.1/wk | 53% of volume sits in the long tail. These are **current rank by cost, not growt
- [WARN] **71%** — percentages are derived; oracle does not gate them
    > torage rate. Coverage note from the tool: only 10/14 retriever chunks returned (71%), so the true savings figure is equal or higher. --- ### What this means a
- [WARN] **29%** — percentages are derived; oracle does not gate them
    > dge with zero operational impact. 4. **Expand Retriever coverage** to close the 29% gap (4 missing chunks); doing so will firm up the $788/yr savings projection

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 4389ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 7460ms, stdout=1279B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 6395ms, stdout=1279B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 6057ms, stdout=1279B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_savings --args '{"tim...
exit=-1, 60016ms, stdout=0B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 4906ms, stdout=1448B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_savings --args '{"tim...
exit=-1, 60041ms, stdout=0B, stderr=0B

### 8. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_savings --args '{}'
exit=-1, 60019ms, stdout=0B, stderr=0B

### 9. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --help 2>&1 | head -40...
exit=-1, 97304ms, stdout=1430B, stderr=0B
