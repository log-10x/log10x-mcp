# Anti-Hallucination Campaign — MCP Hero Questions vs Demo-Env Ground Truth

## Context

The eval harness is built (PR #96, 14 commits, deterministic + oracle + autonomous + sub-agent surfaces all working). What's missing is a **structured, deep, falsifiable campaign** that asks: *given a question whose correct answer we computed independently from Prometheus, does an MCP-driven sub-agent produce that correct answer — or does it hallucinate, mis-route, or stop short?*

The mission is anti-hallucination + anti-assumption: every claim about MCP correctness must be backed by a question whose expected answer was computed from the live env BEFORE the agent ran, plus a captured agent transcript whose answer can be machine-compared. Gaps live as persistent JSON; fixes are tracked; the loop repeats until expected ≈ actual on every question.

Recent failure that prompted this design: the planner (me) declared an "engine bug" without doing diligence. The user pushed back, asked "can you see the engine log", and reading `/var/log/tenx/tenx.log` revealed the real cause was an MCP config issue (commit `78752da`). This campaign forces that same diligence on EVERY question by pre-computing expected answers from oracle queries and refusing to score on the agent's word alone.

**Token budget**: ~$25 over the campaign (15 questions × full Sonnet driver + judge × ~3 iteration cycles). User authorized full judge every run.

## Ground-truth oracle facts (probe 2026-05-10 02:24Z)

These are fixed reference points. Refreshed periodically via `bin/oracle-probe.mjs`; campaign always uses the most recent probe.

- Total volume: **5.39 GB / 24h** (edge tier only; cloud has 0 metrics)
- Pattern cardinality: **410** distinct
- Top patterns dominated by OTel collector self-emitted noise (`untagged` 429MB, `service_instance_id_*` ERROR 397MB, `opensearchexporter` 394MB, `batchprocessor` 383MB, ...)
- Cart family (`cart_cartstore_ValkeyCartStore` etc.) exists but no longer in top-10 — ~33MB / 24h
- Severity distribution: **83% UNTAGGED**, 8.6% ERROR (464MB), <5% each DEBUG/INFO/TRACE/WARN/CRITICAL
- Service cardinality: **2** (`email` 1.86MB, untagged-rest)
- Namespace cardinality: **2** (`otel-demo` 1.86MB, untagged-rest); 99.96% unlabeled
- Cost-driver growth (last 24h vs prior 24h): Kafka metadata churn + OTel export retry errors (300–550 KB delta each)
- Newly emerged patterns (5m vs 1h offset): LLM trace patterns from `product-reviews` + chat completions
- K8s state: 32 pods total, all healthy; 23 services in `otel-demo` namespace; cloud reporter cronjob **does not exist**
- Reporter freshness: edge 27s, cloud never

## Approach

### Three categories × 5 questions each (15 total)

**Cost category**: bill drivers, attribution, savings, pattern-rank questions. Each tests whether the agent uses cost_drivers/top_patterns/savings correctly and reports numbers traceable to oracle.

**Error-levels category**: severity distribution, error-pattern counts, error-trend questions. Tests whether the agent uses pattern_trend, list_by_label on severity_level, investigate correctly.

**Stability category**: pipeline health, fresh-vs-stale questions, dropped-zones, newly-emerged patterns. Tests whether the agent uses doctor, services, list_by_label on namespace, and investigate (env-mode) correctly.

For each question we pre-compute an `expected_answer` containing:
- `summary`: one-sentence ground truth (e.g., *"OTel collector self-emitted patterns dominate cost; cart family is not a current top driver"*)
- `top_patterns`: top-N pattern names + volumes from oracle PromQL
- `expected_severity_split` / `expected_freshness` / `expected_namespaces`: category-specific ground truth
- `must_mention`: substrings the synthesis must contain (oracle-traceable)
- `must_not_mention`: substrings indicating hallucination (e.g., a pattern not in metrics)
- `expected_tool_chain`: tool names that must appear in the bash trace, in order
- `expected_oracle_query`: the exact PromQL the oracle uses to verify

### Scoring rubric (5 axes per run)

1. **Drift score** (oracle): unsupported numeric/pattern claims. Target = 0.
2. **Top-N pattern match** (NEW): does the agent's named top-N intersect oracle's top-N? Score = matched / max(matched + missed).
3. **Tool-chain alignment**: does the bash trace include `expected_tool_chain` in order? 0/1 per chain step.
4. **Value delivered** (Sonnet judge): does the synthesis answer the question? 0..1.
5. **Value received** (Sonnet judge): did the MCP give the agent useful data? 0..1.

A question PASSES when all of: drift=0, top-N match ≥ 0.7, tool-chain alignment ≥ 0.7, value-delivered ≥ 0.7. Anything less = open gap.

### Gap-tracking schema (persistent)

Each gap is a JSON record in `eval/gaps/gaps.json`:

```typescript
{
  question_id: string;              // e.g. "cost-q3-week-over-week"
  run_timestamp: string;            // ISO of the run that produced the gap
  gap_kind: 'drift' | 'pattern_miss' | 'chain_miss' | 'low_value' | 'low_received';
  gap_description: string;          // one-line description
  expected_answer_excerpt: string;  // what the oracle says is true
  actual_answer_excerpt: string;    // what the agent said
  fix_status: 'open' | 'in_progress' | 'fixed' | 'wontfix';
  fix_commit?: string;              // git sha of the fix
  fix_verified_run_ts?: string;     // ISO of the re-run that confirmed
  notes: string[];
}
```

Gaps persist across compaction because they're files on disk. The campaign's resume protocol reads `gaps.json` first, identifies open gaps, picks one, fixes it, re-runs the affected question(s), updates the record.

### Iteration loop

```
for round in 1..N:
  1. Refresh oracle ground truth (bin/oracle-probe.mjs > eval/oracle/expected/<ts>.json)
  2. (First round only) Compute expected_answer for each question; bake into hero spec
  3. Run all 15 hero scenarios via bin/run-hero.mjs (full judge)
  4. For each run:
       a. Score on 5 axes
       b. Compare against expected_answer
       c. If any axis fails → emit GapRecord to eval/gaps/gaps.json
  5. Aggregate per-question pass/fail into eval/reports/hero/SUITE-SUMMARY.md
  6. Pick one open gap; understand root cause:
       - If MCP-side bug → fix in src/, commit
       - If oracle-side bug → fix in eval/src/hero-oracle.ts, commit
       - If question is bad → revise the spec, commit
  7. Re-run only the affected scenario; if drift=0 and all axes pass, mark gap fixed
  8. Update SUITE-SUMMARY with the new pass count
  9. If all gaps closed → exit loop with hard artifact
  10. Else → continue
```

Termination: all 15 questions produce a final synthesis whose drift=0, top-N match ≥ 0.7, value ≥ 0.7. The hard artifact is `eval/reports/hero/CAMPAIGN-PROOF.md` containing per-question expected-vs-actual side-by-sides + signed-off gap records.

## Files to modify / create

### Modify
- `log10x-mcp/eval/src/types.ts` — extend `HeroSpec` with `expected_answer` block (top_patterns, must_mention, must_not_mention, expected_tool_chain, expected_oracle_query). Add `PatternMatchScore` to `HeroRunReport`.
- `log10x-mcp/eval/src/hero-oracle.ts` — add `extractAgentTopPatterns(text, N)` function that pulls top-N pattern names from the agent's synthesis (looks for the most-referenced snake_case patterns in summary tables / recommendations). Add `scoreTopNMatch(agentTop, oracleTop)`.
- `log10x-mcp/eval/src/hero-runner.ts` — invoke pattern-match scoring; emit chain-alignment score by parsing bash commands for tool names; produce a 5-axis verdict.
- `log10x-mcp/eval/bin/oracle-probe.mjs` — extend to dump the full oracle snapshot to `eval/oracle/expected/<ts>.json` (top patterns, severity split, namespace split, growth deltas, freshness).

### Create
- `log10x-mcp/eval/src/gap-tracker.ts` — `loadGaps()`, `appendGap()`, `markFixed()`, `pickNextOpenGap()` plus the `GapRecord` type.
- `log10x-mcp/eval/src/expected-answer.ts` — function `computeExpectedAnswer(question_id, env)` that runs the question's `expected_oracle_query` and returns the structured ground-truth block.
- `log10x-mcp/eval/bin/refresh-expected.mjs` — refresh all hero specs' expected_answer blocks against the current oracle snapshot.
- `log10x-mcp/eval/bin/score-hero-vs-expected.mjs` — compare a saved transcript against the hero's expected_answer; emit gap records for mismatches.
- `log10x-mcp/eval/bin/run-campaign.mjs` — top-level orchestrator: refresh oracle, run all 15 heroes, score each, emit SUITE-SUMMARY + CAMPAIGN-PROOF.
- `log10x-mcp/eval/CAMPAIGN.md` — in-repo working copy of this plan (mirrored from `.claude/plans/`), used as the campaign's status doc.
- 11 new hero specs under `log10x-mcp/eval/fixtures/hero/`: 5 cost (1 reusable), 5 error-level, 5 stability (one reusable each).
- `log10x-mcp/eval/gaps/gaps.json` — initially `[]`, grows as the campaign runs.
- `log10x-mcp/eval/reports/hero/CAMPAIGN-PROOF.md` — final hard artifact, written when all 15 PASS.

### Reuse (no changes needed)
- `log10x-mcp/eval/bin/mcp-call.mjs` — sub-agent's MCP CLI surface
- `log10x-mcp/eval/bin/run-hero.mjs` — hero-runner driver (already wires oracle + judge)
- `log10x-mcp/eval/src/prom-oracle.ts` — direct PromQL client
- `log10x-mcp/eval/src/judge.ts` — Sonnet judge wrapper

## Resume-after-compaction protocol

Persistent files (all on disk, survive compaction):
1. `/Users/talweiss/.claude/plans/dor-has-done-a-recursive-pnueli.md` — this plan
2. `log10x-mcp/eval/CAMPAIGN.md` — same plan, in-repo
3. `log10x-mcp/eval/gaps/gaps.json` — open + fixed gaps
4. `log10x-mcp/eval/oracle/expected/<ts>.json` — most recent oracle snapshot
5. `log10x-mcp/eval/fixtures/hero/*.json` — hero specs with `expected_answer` baked in
6. `log10x-mcp/eval/reports/hero/<id>/<ts>/` — per-run transcripts + verdicts
7. `log10x-mcp/eval/reports/hero/SUITE-SUMMARY.md` — current pass count

After compaction, the planner reads (1)/(2), scans (3) for open gaps, scans (5) for any spec drift, scans (7) for current pass count. The next action is: pick one open gap, fix it, re-run only that scenario, update (3) and (7).

## Verification (how we know we're done)

The campaign is complete when **all three** are true:

1. `eval/reports/hero/CAMPAIGN-PROOF.md` exists, contains 15 question entries, each with:
   - The pre-computed `expected_answer`
   - The agent's actual synthesis
   - All 5 scoring axes passing
   - The gap records that led there (from `[]` initial state, every gap eventually marked `fixed`)
2. `eval/gaps/gaps.json` has 0 open gaps; every gap has `fix_status: 'fixed'` and `fix_commit` set.
3. The full campaign re-runs cleanly end-to-end (idempotent): `node eval/bin/run-campaign.mjs` produces the same per-question PASS verdict on a fresh sub-agent run.

The artifact is *falsifiable*: anyone can re-run `bin/run-campaign.mjs` and either produce the same proof (campaign is intact) or surface a regression (a question that previously passed now fails — gap reopens).

Anti-drift mechanisms (carried forward from PR #96):
- Sub-agents have no shared context with the planner.
- Oracle is independent (separate HTTP path, separate auth, separate code from MCP).
- Sonnet judge sees the agent's full transcript (no mid-chain reasoning).
- Every numeric / pattern claim must round-trip to a Prometheus query.

The mission is satisfied when each of the 15 hero questions has a PROOF triple: `(question, oracle-computed expected answer, sub-agent actual answer that matches it)` — committed, re-runnable, and gap-tracked from initial-fail to verified-pass.
