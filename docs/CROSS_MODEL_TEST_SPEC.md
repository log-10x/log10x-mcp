# Cross-model validation test spec

**Status**: spec written, not yet executed
**Authored**: session 2026-04-15 (continued), post-GA-hardening sub-agent battery
**Audience**: engineers or future agent sessions validating MCP behavior across LLMs

---

## Why this exists

Every sub-agent run that shaped the current GA-readiness scorecard used Claude Opus 4.6 (Claude Code's `Agent` tool is hardcoded to Claude). A real customer connecting `log10x-mcp` to their AI IDE or agent framework may be using GPT-4/5, Grok, Gemini, DeepSeek, Qwen, or Llama. If the MCP's wins depend on Claude-specific interpretation patterns — tolerance for uncertainty, willingness to read warning banners, prose-parsing style, confidence calibration — our 2-wins-0-losses scorecard does not generalize.

This spec pins down the scenarios, Claude baselines, ground truth, and scoring rubric so a future session can rerun the identical test matrix against other models and produce an apples-to-apples comparison table.

---

## What needs to be true before running this

**Prerequisites** (check each before running any test):

1. **Live demo env available**: otel-demo cluster on EKS (`log10x-otel-demo`), `otel-demo` namespace has 27 pods, `tenx-fluentd` DaemonSet healthy on 4+ nodes, `prometheus.log10x.com` reachable, Edge Reporter tier detected via `log10x_doctor`.

2. **Ground truth reproducible**: the accounting pod must still be crashlooping with the same stacked bugs (libgssapi historical + Kafka poison-pill current). Verify with `kubectl get pod -n otel-demo -l app.kubernetes.io/component=accounting` and `kubectl logs <pod> --previous | grep -iE "krb|duplicate"`.

3. **Engine fixes NOT required before running**: tests 1 and 2 do not touch `resolve_batch` or `streamer_query`, so the G11 templatizer bug and G12 streamer bug do not invalidate results. Test 3 (canary detection) uses `top_patterns` which does not depend on either.

4. **API keys**: Claude (Anthropic), OpenAI, xAI (Grok), Google (Gemini), DeepSeek, Perplexity. All stored in `/Users/talweiss/.claude/projects/.../memory/api_keys.md`.

5. **MCP binary built and fresh**: `cd log10x-mcp && npm run build && pkill -9 -f log10x-mcp/build/index.js`. The binary listens on stdio and the test harness spawns it as a subprocess.

---

## Test harness requirements

The harness must be a standalone Node.js script (no `claude` CLI dependency) at `log10x-mcp/scripts/cross-model-test.mjs` that:

1. **Spawns the MCP server** as a child process with stdio transport:
   ```
   node /path/to/log10x-mcp/build/index.js
   ```
   Uses the MCP TypeScript SDK's `StdioClientTransport` or a minimal hand-written JSON-RPC loop.

2. **Discovers tools** via the `tools/list` RPC and normalizes them into each target model's tool format:
   - Anthropic: `input_schema` → `{name, description, input_schema}`
   - OpenAI: `{type: "function", function: {name, description, parameters}}`
   - Grok/xAI: same as OpenAI (OpenAI-compatible tool format)
   - Gemini: `function_declarations` shape
   - DeepSeek: OpenAI-compatible

3. **Runs the tool-use loop** for up to 15 rounds:
   - Send system prompt + user prompt + tools
   - Receive `tool_use` blocks, execute each via MCP `tools/call`, send results back
   - Stop when model returns a final text-only response OR hits 15-round ceiling
   - Count tool calls, track which tools were called, capture the final text

4. **Scores each run** against a rubric (see below).

5. **Writes one JSONL row per run** to `log10x-mcp/scripts/cross-model-results.jsonl`:
   ```json
   {
     "scenario": "accounting-crashloop",
     "model": "gpt-5",
     "provider": "openai",
     "tool_calls": 8,
     "tool_sequence": ["log10x_services", "log10x_top_patterns", ...],
     "wall_time_ms": 42131,
     "tokens_in": 14200,
     "tokens_out": 1800,
     "cost_usd": 0.089,
     "final_text": "...",
     "score": {
       "correct_root_cause": true,
       "identified_both_bugs": true,
       "read_recency_warning": true,
       "confidence_calibrated": true,
       "stayed_in_budget": true
     },
     "notes": "..."
   }
   ```

6. **Emits a summary table** at the end:
   ```
   scenario               | claude-opus-4-6 | gpt-5 | grok-4 | gemini-2-5 | deepseek-v3
   accounting-crashloop   | ✓ complete      | ?     | ?      | ?          | ?
   historical-drift       | ✓ exact         | ?     | ?      | ?          | ?
   retry-storm-canary     | ✓ 2 calls       | ?     | ?      | ?          | ?
   ```

---

## Test scenarios

### Scenario 1 — Accounting crashloop (mixed historical + live)

**User prompt** (paste verbatim, no edits):

```
You are an SRE on-call. PagerDuty just paged you: accounting pod in the
`otel-demo` namespace is crashlooping with 30+ restarts and OOMKilled status.
Diagnose the root cause (the specific underlying bug, not just "OOM") and
recommend the correct one-line fix.

You may use ONLY the log10x MCP tools. No bash, no kubectl, no shell.

Budget: 10 tool calls total. Count them. Report your final count.

Read every tool output carefully. The investigate tool may emit a
"⚠ Anchor may be historical, not current" warning pointing to a currently-
active pattern that differs from the 24h top-cost anchor. If you see this
warning, its next-action suggestion is diagnostic guidance you should follow.

Report in under 400 words:
- Root cause (exact pattern/error/library driving the current crashloop)
- Reasoning chain (tool order)
- Correct one-line fix
- Confidence level (honest)
- Tool call count: X/10
- Did the MCP output lead you to the answer, or did you reason past a
  misleading confident output?
```

**Ground truth** (verified independently via kubectl):

Accounting has **two stacked bugs**:
1. **Startup dlopen failure**: `Error: libgssapi_krb5.so.2: cannot open shared object file` — fires at every container init, 27% of accounting's 24h log volume, CRITICAL severity. Historical loudest.
2. **Kafka poison-pill → Postgres unique-constraint violation**: `Npgsql.PostgresException (0x80004005): 23505: duplicate key value violates unique constraint "order_pkey"` — fires on every attempt to reprocess a specific Kafka message, originates in `Accounting.Consumer.ProcessMessage` at `Consumer.cs:line 132`. Rare but causally important — this is what actually OOMs the pod.

**Either answer alone is partially correct. Both with a correct live-vs-historical split is the ideal answer.**

Verify ground truth before running:
```bash
POD=$(kubectl -n otel-demo get pod -l app.kubernetes.io/component=accounting -o name | head -1)
kubectl -n otel-demo logs $POD --previous --tail=40 | grep -iE "krb|duplicate|constraint"
# should show both "libgssapi_krb5.so.2" and "duplicate key value violates"
```

**Claude Opus 4.6 baselines** (three independent runs with different access):

| Run | Access | Answer | Calls | Confidence | Verdict |
|---|---|---|---|---|---|
| S11 | kubectl only | Poison-pill Postgres only | 3/10 | 90% | Half right — missed Kerberos |
| S12 | MCP only (pre-fix) | libgssapi only | 3/10 | 90% | Wrong about live cause — shipped an anchor that would not stop crashloop |
| S16 | MCP only (post-PR#32) | **Both bugs, correct live/historical split** | 8/10 | Medium-high | **Most complete of any run** |

**S16 Claude cues to capture** (from the actual transcript):

1. Reasoning chain S16 followed:
   - `log10x_services` confirmed `accounting` exists (despite later investigate mis-resolution)
   - `log10x_top_patterns(service=accounting, 1d)` surfaced libgssapi as #1 cost + `fail Accounting Consumer` at #11 + Confluent.Kafka consume frames at #17/#20
   - `log10x_pattern_trend` on libgssapi → **empty** → decided it was historical, not live
   - `log10x_pattern_trend` on `fail Accounting Consumer` → active, 17 datapoints, peak at 11:00 UTC today
   - `log10x_event_lookup("unique constraint")` → NEW in **both** `accounting` and `postgresql` → cross-service confirmation

2. Claude's verbatim critical paragraph (keep this — it's the diagnostic style to benchmark against):
   > "The MCP output was partially misleading but recoverable. `top_patterns` confidently anchored libgssapi as #1 with a CRIT badge and $0.01/day — a less careful operator would stop there and ship a Dockerfile fix that does nothing to stop the crashloop. There was no explicit '⚠ Anchor may be historical, not current' warning surfaced by investigate in this run — investigate instead returned 'no significant movement' which was easy to misread as 'nothing wrong.' I had to reason past it: the empty pattern_trend on libgssapi was the decisive signal that the top-cost anchor was stale, and scanning further down the top_patterns list for 'fail Accounting Consumer' + running event_lookup on 'unique constraint' surfaced the live bug. Without actively distrusting the #1 anchor and running the trend check, I would have shipped a wrong fix."

3. What to look for in GPT/Grok/etc responses:
   - **Does the model blindly accept the first CRIT pattern (libgssapi) or distrust it?** Claude's instinct was to distrust; this is what rescued the diagnosis.
   - **Does the model chain `pattern_trend` on the top result to check freshness?** Claude did; this surfaced the historical/live split.
   - **Does the model run `event_lookup` on a specific free-text fragment** ("unique constraint") **as a cross-service join probe?** This is subtle — the tool's design supports it, but the affordance isn't obvious unless the model reads the tool description carefully.
   - **Does the model synthesize "both bugs stacked" or commit to one?** Commitment is fine if it's the live one; commitment to the historical one is a failure.

### Scenario 2 — Historical cost drift (MCP category advantage)

**User prompt**:

```
You are a FinOps / cost-control engineer. Accounting sent a memo: "our log
ingest bill jumped significantly over the last 3 weeks. Find when and why."

You may use ONLY the log10x MCP tools. No bash, no kubectl.

Budget: 10 tool calls total. Count them.

Report in under 300 words:
- When did the cost jump? Specific date/time.
- Which pattern(s) are driving it? Exact pattern names + services.
- Magnitude (e.g. +X% vs baseline)?
- Inferred root cause (config regression, new deploy, debug flag left on,
  real traffic growth)?
- Tool call count: X/10
```

**Ground truth**: Inflection at **2026-04-11 00:00 UTC**. Four specific patterns driving the jump:
- `cart cartstore ValkeyCartStore` (cart INFO) — $138/mo → $15K/mo (+11,094%)
- `GetCartAsync called with userId` (cart) — $93 → $10K/mo (+11,129%)
- `AddItemAsync called with userId productId quantity` (cart) — $48 → $5.4K/mo (+11,171%)
- `shipping service POST get-quote unsupported protocol scheme` (shipping, CRIT) — $191 → $58K/mo (+30,443%)

Identical +11,000% magnitude on three sibling cart patterns = log-level-flip signature. The shipping pattern is a separate CRIT regression.

Verify via MCP before running:
```
log10x_cost_drivers({ timeRange: '30d' })
log10x_pattern_trend({ pattern: 'cart_cartstore_ValkeyCartStore', timeRange: '30d', step: '1h' })
```

**Claude Opus 4.6 baseline** (S14):

| Run | Access | Answer | Calls | Verdict |
|---|---|---|---|---|
| S13 | kubectl only | **Explicit: "kubectl alone cannot answer this question"** — fell back to current-state inference | 5/10 | Category failure (kubectl has no log-volume history) |
| S14 | MCP only | Exact inflection 2026-04-11 00:00 UTC, 4 specific patterns, +11,000-30,443%, correct config-regression inference | 5/10 | **Exact correct answer** |

**S14 Claude cues**:

1. S14's tool chain:
   - `log10x_cost_drivers()` global → week-over-week service-level deltas
   - `log10x_cost_drivers({ service: "cart" })` → per-pattern deltas within cart
   - `log10x_pattern_trend({ pattern: "...", timeRange: "30d", step: "1h" })` on each candidate → confirmed inflection date
   - `log10x_top_patterns({ service: "cart" })` → verified current top
   - Implicit cross-pattern magnitude compare (noticed three cart patterns all at ~11,000%)

2. The key inference Claude made (verbatim):
   > "Three correlated INFO patterns in the same ValkeyCartStore class (constructor log + every Get + every Add) all jumping by the identical ~11,000% factor on the same day is the signature of a log-level flip."

   **This is a synthesis step**, not a tool output. GPT/Grok may or may not make the identical-magnitude observation. If a model reports four percentage numbers without noticing they're clustered, that's a calibration gap.

3. What to look for in other models:
   - Do they use `cost_drivers` at all, or default to `top_patterns` and miss that it doesn't do week-over-week?
   - Do they use `pattern_trend` at 30d × 1h to see the actual inflection shape, or do they trust the aggregate delta numbers alone?
   - Do they synthesize the "identical magnitude = log-level flip" inference, or do they just list the numbers?
   - Do they distinguish this from organic traffic growth?

### Scenario 3 — APM-invisible retry storm (seeded canary)

**Setup — must be done before running** (MCP alone cannot seed the bug):

```bash
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: retry-storm-canary
  namespace: otel-demo
  labels: { app: retry-storm-canary }
spec:
  replicas: 1
  selector: { matchLabels: { app: retry-storm-canary } }
  template:
    metadata: { labels: { app: retry-storm-canary } }
    spec:
      containers:
      - name: canary
        image: busybox:1.36
        command: [/bin/sh, -c]
        args:
        - |
          while true; do
            for i in 1 2 3 4 5; do
              echo "$(date -Iseconds) WARN retrying downstream call attempt=$i pool=checkout-svc status=transient_failure"
              sleep 0.2
            done
            echo "$(date -Iseconds) INFO downstream call succeeded after 5 retries pool=checkout-svc"
            sleep 1
          done
        resources:
          requests: { cpu: 10m, memory: 16Mi }
          limits: { cpu: 50m, memory: 32Mi }
EOF
```

Wait 60 seconds for metrics to propagate. Verify via MCP:
```
log10x_top_patterns({ service: "canary", timeRange: "1d" })
# should show:
#   #1  retrying downstream call attempt pool checkout svc status transient failure ... WARN canary
#   #2  downstream call succeeded after retries pool checkout svc ... INFO canary
```

**User prompt**:

```
You are doing a scheduled health sweep on a Kubernetes cluster. Product hasn't
complained, alerts are green, APM shows normal error rate and normal latency
across all services. Your job: find anything that might be quietly wrong that
APM wouldn't catch.

You may use ONLY the log10x MCP tools.

Recommended flow:
1. log10x_doctor() for environment overview
2. log10x_services() for cost-weighted service list
3. log10x_top_patterns() globally to see loudest patterns AND anything in the
   "newly emerged" section (read the whole output — there may be a section
   below the cost ranking)
4. For anything suspicious, drill in with log10x_investigate

CRITICAL: the bug you're looking for is APM-invisible by construction. Every
retrying call eventually succeeds, so tracing shows normal latency and normal
error rate. Only log volume on a specific retry / backoff / transient-failure
pattern would surface it. The bug might be very fresh (minutes old). A
cumulative 7d cost ranking may not surface it because a 90-second-old
high-rate pattern has tiny total volume.

Report in under 400 words:
- Did you find the retry-storm pattern? Exact pattern name + service + rate
- Tool call count
- What signal made you notice it?
```

**Ground truth**: The canary pattern `retrying downstream call attempt pool checkout svc status transient failure` is emitted at ~5 events/sec on the `canary` service. Cumulative 7d cost is trivial (<$0.01). The pattern should be surfaced by the **"Newly emerged patterns (last 5 min, no activity 1h ago)"** section in `top_patterns` output, not by the main cost ranking.

**Claude Opus 4.6 baselines**:

| Run | Fix state | Result | Calls | Verdict |
|---|---|---|---|---|
| S10 | pre-PR#33 | **Missed the canary** — found a different pre-existing APM-invisible bug (the G5 shipping URL pattern at $13K/wk) | 7/10 | Partial — found a real bug, not the seeded one |
| S15 | post-PR#33 | **Found the canary in the first data call** (2 calls total including doctor bootstrap) | 2/10 | Decisive positive |

**S15 Claude cues**:

1. S15's observation (verbatim) — this is the specific reasoning the newly-emerged section triggered:
   > "The retry WARN and its matching success INFO were listed there together — exactly the signature the brief described. Without that section I would have missed it entirely: at 2/s for a few minutes, its cumulative cost is far below the $0.25/day floor of the top-25 ranking."

2. S15 also went beyond the prompt:
   > "The ~5:1 retry:success ratio on the canary service is the real finding: roughly 80% of downstream pool checkout svc calls are failing transiently on first attempt and only succeeding after backoff. Worth escalating even though error rate and latency dashboards look clean."

3. What to look for in other models:
   - **Do they read the "Newly emerged patterns" section as distinct from the main cost ranking?** Claude treated it as a separate signal. A model that reads top_patterns top-down and stops at #10 would miss it.
   - **Do they compute the retry:success ratio?** That's the "this matters" inference — not a tool output.
   - **Do they fall for the false leads** that S10 (pre-fix) fell for (WARN-tier drill on prometheus-server, the 54% cardinality concentration warning)? Claude had to explicitly recognize these as cost concerns not health concerns.

---

## Scoring rubric

Each scenario scored on five axes. 0/1 each, max 5 per scenario.

1. **Correct root cause identified** — reaches the ground truth answer (or, for scenario 1, either bug is partial credit, both is full credit)
2. **Stayed within tool-call budget** — ≤10 for scenarios 1/2, ≤3 for scenario 3
3. **Calibrated confidence** — honest about uncertainty, flags what it doesn't know, does not over-claim
4. **Read tool warning banners** — if the recency warning or newly-emerged section fires, the agent references it in its reasoning (not just regurgitates)
5. **No hallucinated content** — every specific claim (pattern name, date, magnitude, line number) is traceable to tool output

**Aggregate score** = sum across three scenarios (max 15).

**Reporting table**:

```
| Model              | Scenario 1 | Scenario 2 | Scenario 3 | Total | Notes                    |
|--------------------|------------|------------|------------|-------|--------------------------|
| claude-opus-4-6    | 5/5 (S16)  | 5/5 (S14)  | 5/5 (S15)  | 15/15 | baseline                 |
| gpt-5              | ?/5        | ?/5        | ?/5        | ?/15  |                          |
| grok-4-latest      | ?/5        | ?/5        | ?/5        | ?/15  |                          |
| gemini-2-5-pro     | ?/5        | ?/5        | ?/5        | ?/15  |                          |
| deepseek-v3        | ?/5        | ?/5        | ?/5        | ?/15  |                          |
```

Cell notes should call out **specifically where the model diverged from Claude**: tool ordering, what it missed, what it hallucinated, what it over- or under-claimed.

---

## Known failures to watch for (model-agnostic)

These are not caused by the MCP or the model — they're known substrate bugs that may affect results if they resurface. Check first if a test fails in an unexpected way:

- **G11 templatizer bug** (resolve_batch): do NOT use `log10x_resolve_batch` in any scenario. The tool silently drops ~70% of input. Not in scope for any of the three test scenarios above.
- **G12 streamer bug**: do NOT use `log10x_streamer_query` in any scenario. Returns 0 events on known-exists data and crashes on canonical pattern names. Not in scope for any test scenario.
- **G9 tenx-edge stale state**: if the MCP shows zero volume for services that kubectl confirms are actively logging, the fluentd DaemonSet may need a rollout restart. Verify via `kubectl -n demo logs tenx-fluentd-<pod> --since=5m | grep "out of order"` — if non-zero, restart via `kubectl -n demo rollout restart ds/tenx-fluentd`.
- **Replay-to-real data swap artifacts**: 24h-ago comparisons may reflect the pre-2026-04-15 log-simulator replay data, not real otel-demo traffic. Keep baseline_offset ≤ 1h for any "last hour" test.

---

## How to run this

```bash
cd /Users/talweiss/git/l1x-co/log10x-mcp

# 1. Build the MCP binary
npm run build

# 2. Set API keys as env vars (read from memory/api_keys.md)
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
export XAI_API_KEY=...
export GOOGLE_API_KEY=...
export DEEPSEEK_API_KEY=...

# 3. Seed the canary (scenario 3 only)
kubectl apply -f docs/retry-storm-canary.yaml
sleep 60

# 4. Run the harness
node scripts/cross-model-test.mjs \
  --scenarios accounting,drift,canary \
  --models claude-opus-4-6,gpt-5,grok-4-latest,gemini-2-5-pro,deepseek-v3 \
  --output results.jsonl

# 5. Cleanup canary
kubectl -n otel-demo delete deployment retry-storm-canary
```

---

## What the result tells us

**If every model scores ≥12/15**: the MCP's output is model-agnostic. The wedge story holds for any customer regardless of their agent framework. Ship.

**If Claude scores 15/15 and GPT/Grok score 8-10/15**: the MCP's output depends on Claude-specific interpretation (calibrated confidence, careful reading of warning banners). This is not a disaster, but it means the "it works with any LLM" claim is wrong. Actionable fixes:
- Add more explicit structural markers to warning banners (`### ⚠ DANGER` not `⚠ anchor may be historical`)
- Make section headers more obvious in `top_patterns` output
- Ship a "how to read log10x MCP output" section in the README that the customer must paste into their agent's system prompt

**If one specific test fails across all non-Claude models**: that's a product gap specific to the capability (historical drift, current-crash, APM-invisible) — worth a targeted fix before GA.

**If a non-Claude model beats Claude on any scenario**: capture the reasoning chain and consider whether Claude's approach is sub-optimal. This is valuable signal for future MCP tool descriptions.

---

## Open questions this test does NOT answer

1. **Latency / cost differences** across models — tracked in the JSONL but not scored
2. **Longer-context behavior** — these tests are ~400 words of user prompt, not 100K-token incident pastes
3. **Multi-turn robustness** — does the model behave differently on turn 10 than turn 1 when the tool output is evolving
4. **Adversarial inputs** — what happens when the model is pointed at a non-existent service or a malformed pattern name
5. **Tool-use format compliance** — some models malformed tool calls in the past, may retry or fail

These are follow-on test specs to write once the core matrix is validated.
