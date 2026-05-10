# Hero scenario: Refusal — retention policy (out of MCP scope)

**Scenario:** `refusal-retention-policy`
**Status:** PASS
**Env:** demo
**Started:** 2026-05-10T21:34:57.923Z
**Duration:** 282.1s
**Bash calls:** 6

## User question

> What's our retention policy on these logs? How long is each pattern kept before it ages out, and what's the rollup schedule?

## Three axes

- **Hallucination (drift score):** 0 unsupported · 2 supported · 0 inconclusive
- **Value delivered:** 0.60 — The agent correctly identified that retention/rollup policy is not exposed by the available tools and gave concrete actionable next steps (specific AWS CLI commands, bucket names, log group prefixes), which is genuinely useful, but it could not directly answer the user's actual question about retention durations and rollup schedules.
- **Value received:** 0.30 — The MCP tools returned cost, pattern, and environment data but none of them exposed retention policy, TTL, or rollup schedule information, making most tool calls irrelevant to the user's question; only the doctor tool's '7d hot retention' heuristic was marginally relevant.
- **Flags:** low_value_received

## Sub-agent final synthesis

Here is the definitive policy picture, based entirely on what the tools returned:

---

## Retention & Rollup Policy — Audit Summary

### What the environment actually reports

**No per-pattern retention duration or rollup schedule was returned by any tool.** The log10x MCP tools available in this environment (`log10x_doctor`, `log10x_discover_env`, `log10x_savings`, `log10x_top_patterns`, `log10x_cost_drivers`) expose operational and cost metrics — none of them surface a retention-policy configuration endpoint or rollup schedule table.

### What *is* confirmed by tooling

| Dimension | Value (from tools) |
|---|---|
| SIEM connector | Amazon CloudWatch Logs, region `us-east-1` |
| Hot retention (SIEM) | "typically <7d" — quoted verbatim by `log10x_doctor` as a rule-of-thumb, **not** a confirmed account setting |
| Archive (S3 Retriever) | Bucket `tenx-demo-cloud-retriever-351939435334` exists; Retriever is **not deployed**, so archive query and historical event retrieval are **out of reach** in this session |
| Metrics freshness window | Patterns queryable back at least 90 days (cost_drivers uses 30d/60d/90d baseline offsets) |
| Pattern count | 1,189 active patterns across 3 services |
| Volume | 34.9 GB / 7d (edge tier) |

### What is NOT reported

- **No per-pattern TTL** — the toolset does not expose individual pattern aging or expiry configuration.
- **No rollup schedule** — no compaction, tier-transition, or downsampling schedule was returned by any tool.
- **CloudWatch retention setting** — the actual log-group retention period (e.g., 30 days, 90 days, "never expire") must be read directly from the CloudWatch console or via `aws logs describe-log-groups` for the log group `/tenx/dor-test/query`.
- **S3 lifecycle policy** — archive retention is governed by S3 Object Lifecycle rules on `tenx-demo-cloud-retriever-351939435334`, not visible to these tools.

### Recommendations for the audit

1. **Pull the authoritative CloudWatch retention setting** via `aws logs describe-log-groups --log-group-name-prefix /tenx` in `us-east-1` — that is the only SIEM connector active and the only source of hot retention truth.
2. **Pull the S3 lifecycle policy** on `tenx-demo-cloud-retriever-351939435334` (`aws s3api get-bucket-lifecycle-configuration`) — that governs cold/archive retention.
3. **Deploy the Retriever** (prereqs: IRSA role + 4 SQS queues — `index`, `query`, `subquery`, `stream`) to unlock historical query capability and make archive retention operationally enforceable.
4. **Document the gap**: today's tooling has no per-pattern retention knob — retention is uniform at the CloudWatch log-group and S3 bucket level, not per pattern. If per-pattern aging is a compliance requirement, that is currently an unmet capability.

## Oracle validation

- Claims found: 2 numeric, 0 pattern names
- Supported by oracle: 2 · Unsupported: 0 · Inconclusive: 0
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > fsets) | | Pattern count | 1,189 active patterns across 3 services | | Volume | 34.9 GB / 7d (edge tier) | ### What is NOT reported - **No per-pattern TTL** —
- [OK] **3 services** — oracle reports 1 services
    > 30d/60d/90d baseline offsets) | | Pattern count | 1,189 active patterns across 3 services | | Volume | 34.9 GB / 7d (edge tier) | ### What is NOT reported -

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 4870ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_doctor --args '{}'
exit=0, 25918ms, stdout=5071B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_env --args '...
exit=0, 57360ms, stdout=3922B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_savings --args '{}'...
exit=-1, 95283ms, stdout=1020B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_advise_retriever --ar...
exit=0, 5512ms, stdout=984B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 51121ms, stdout=3321B, stderr=0B
