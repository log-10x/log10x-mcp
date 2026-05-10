# Unverified state of the eval campaign

> This file is the compaction-survivable record of what the
> 14/15 PASS verdict does **not** prove. Read alongside
> [CAMPAIGN.md](./CAMPAIGN.md) (what was done) and
> [gaps/gaps.json](./gaps/gaps.json) (per-scenario disposition).
>
> Keep it honest. When something here gets verified, move it to
> CAMPAIGN.md's Outcome Ledger with the commit + run-ts that
> closed it.

Last reconciled: 2026-05-10.

## 1. Formally tracked gaps

8 records in [gaps/gaps.json](./gaps/gaps.json), all `wontfix`. Each
carries a reasoning note, but `wontfix` is a disposition, not a proof.

| # | Question | Reasoning given | What I have NOT shown |
|---|---|---|---|
| 1 | `stability-newly-emerged` (low_value 0.30) | Env variance, not agent bug | Not run on a customer env with deterministic newly-emerging traffic. Could be agent reasoning failure mis-classified as env-driven. |
| 2 | `cost-bill-driver` (low_received 0.65) | Demo env stable; cost_drivers correctly returns no-drivers | Not run on an env with KNOWN growth deltas. |
| 3 | `cost-week-over-week` (low_received) | Same as #2 | Same as #2. |
| 4 | `cost-mute-candidates` (low_received 0.65) | dependency_check returned 0 deps | Circular: I only know "0 deps" because the tool said so. Not seeded a CloudWatch dashboard referencing one of those patterns and re-run. |
| 5 | `error-top-error-pattern` (low_received 0.50) | After severity-filter fix, chain works | Not re-run the agent post-fix to confirm synthesis quality moves. |
| 6 | `stability-cloud-reporter-missing` (low_received 0.50) | advise_reporter returned a one-line answer | Not tested the deferred enhancement (cross-link to install advisor). |
| 7 | `stability-env-sweep` (low_received 0.65) | Friendly Zod-error fix should help | Not re-run the agent post-fix to confirm fewer round-trips. |
| 8 | `stability-pipeline-health` (low_received 0.60) | doctor returned all-green | Not exercised on an env with actual pipeline health issues. |

## 2. Foundational assumptions under every PASS

1. **Sonnet 4.6 judge correlates with human SREs — MEASURED PARTIAL
   2026-05-10.** Multi-judge ensemble (Sonnet 4.6 + Opus 4.7) on
   5 representative transcripts found σ-disagreement
   (pairwise diff > 0.2) on 2 of 5: `error-severity-distribution`
   (Sonnet 0.72 vd, Opus 0.90 vd — diff 0.18; vr diff 0.25) and
   `error-critical-events` (vd 0.25, vr 0.30). The two judges are
   the SAME family (Claude); cross-family agreement still unknown.
   Still no human-SRE baseline. See
   `eval/reports/hero/JUDGE-ENSEMBLE.md` for the matrix.
2. **`expected_answer` derived from PromQL == what an SRE wants.**
   For finance-scope questions the highest-volume row in PromQL
   may not be the right answer (OTel collector noise vs cart-store
   traffic). Oracle is mechanically right; semantically untested.
3. **0.7 axis threshold.** Picked by feel. Not validated against
   a human PASS/FAIL grid.
4. **Drift detector — MEASURED 2026-05-10, ~67% false-negative
   rate on hand-fabricated answers.** Adversarial run #3
   ([eval/adversarial/RESULTS.md](./adversarial/RESULTS.md))
   spliced 12 fabrications into 3 PASSING transcripts; the
   scorer caught 4, missed 8. Fixable failure modes documented:
   fabricated volumes on real patterns, direction inversions,
   honest-empty when spec lacks anchors, fabricated services.
   Six concrete fix priorities listed in RESULTS.md; #1/#3/#4/#6
   are zero-LLM-cost mechanical changes that close 5 of the 8
   FNs.
5. **Two-layer pattern match (oracle-exact OR Prom-existence) —
   MEASURED 2026-05-10, real-but-unrelated patterns are a real
   FN.** Same adversarial run found that naming a real ERROR-severity
   pattern when the question asked for CRITICAL passes layer 2.
   Fix: add a scope-relevance check (RESULTS.md fix #2).
6. **Tool-chain alignment scorer.** Checks order, not arg sanity.
   `top_patterns {"limit":1}` passes the chain check but delivers
   nothing.
7. **CI gate `--min-pass=14`.** Picked because that's today's
   result. Not shown to be the *minimum* sustainable across env
   drift; a flake on any other scenario reds CI.
8. **Audit memo's "no caller bypasses Zod"
   ([eval/audits/zod-default-bypass-2026-05-10.md](./audits/zod-default-bypass-2026-05-10.md)).**
   Scoped to `src/` and `eval/src/`. Other repos that import
   `executeFoo` directly were not surveyed.
9. **Friendly Zod-error formatter
   ([src/tool-registry.ts](./src/tool-registry.ts)).** Tested
   with one tool, one bad input (`cost_drivers` enum). Other Zod
   issue codes (`too_small`, `too_big`, `invalid_string`,
   refinements) fall through to the generic branch; output
   quality there is unverified.

## 3. Coverage holes in the harness

### Tools never exercised by any hero scenario

About 10 of ~30 MCP tools have zero campaign coverage. Split by
what blocks adding them:

**Unblocked — can write scenarios on demo env right now:**

- `event_lookup`
- `resolve_batch`
- `dependency_check`
- `extract_templates` (briefly used; needs a dedicated scenario)
- `pattern_examples` (briefly used)
- `discover_join` (read-only path)
- `advise_compact`, `advise_install`, `advise_receiver`,
  `advise_reporter`, `advise_retriever`
- `poc_from_local` (needs local `tenx` CLI)
- `poc_from_siem` (rate-limited public Lambda)

Estimated cost for the unblocked set: ~$0.60 × 9-11 scenarios
= $5-7 of Anthropic budget. Effort: 4-8 hours.

**Blocked by infrastructure:**

| Tool(s) | Blocker |
|---|---|
| `signin`, `signout`, `delete_env`, `update_env`, `update_settings` | State-mutating. Risk corrupting demo env. Need throwaway env or rollback fixtures. |
| `retriever_query`, `retriever_query_status`, `retriever_series` | Demo env has no deployed Retriever. Need a Retriever fixture env. |
| `correlate_cross_pillar` (cross-backend), `translate_metric_to_patterns`, `customer_metrics_query`, `backfill_metric` | Need a customer metrics backend (Grafana Cloud / Mimir / Thanos). Demo has only Prometheus. |

### Other coverage holes

- **One env (OTel demo).** Demo-replay stability hides bug
  classes that show up only with real growth, real cost spikes,
  and a heterogenous service mesh.
- **STDIO transport not tested by campaign.** Campaign uses the
  CLI surface (`mcp-call.mjs`). The actual production path
  (MCP SDK over STDIO) is covered only by the 3-second boot smoke
  in CI. **(Item #5 below would close this.)**
- **No latency or cost gating.** A 60s tool call passes if the
  answer is correct.
- **Sequential only.** Concurrent tool calls (which a real
  autonomous agent may issue) are untested; cache /
  env-resolution race conditions not exercised.
- **Error-path coverage is thin.** Prometheus 5xx, retriever
  timeout, rotated API key, partial Prom aggregation 422 — none
  of these are scenarios.

## 4. Claims in commits / docs that lean on assertion not proof

- "Demo replay is continuous and stable." Asserted multiple
  places. Not measured the actual variance window (could be
  24h-stable but 7d-variable).
- "$10 of $25 budget consumed." Tracked by feel; no actual
  Anthropic cost receipt pulled.
- "The campaign loop produced one durable MCP code change."
  True for the severity-filter fix. The other ~5 hardenings are
  scorer-side, framed as "calibration." Each scorer change moves
  the verdict line. The 14/15 number is partially a function of
  where I drew the calibration.
- "Iteration loop is real, each PASS-bump traces to a specific
  commit." True for the cycle counts. But the per-cycle PASS
  deltas (4→5→6→7→9→11→14) include scorer changes that
  retroactively rescored existing transcripts. Two of the seven
  PASS bumps cost $0 because they were re-score only. Recorded
  honestly in the Outcome Ledger but it does mean the iteration
  loop is partially "harden the scorer until more transcripts
  pass."

## 5. De-risking — order of leverage

| # | Action | Closes | Cost | Blocked? |
|---|---|---|---|---|
| 1 | ~~Adversarial run~~ — **DONE 2026-05-10**, found 67% FN rate. See [adversarial/RESULTS.md](./adversarial/RESULTS.md). Closes assumption #4, #5 with measured numbers. | Assumption #4, #5 | $0 | DONE |
| 1a | Implement RESULTS.md fix #1, #3, #4, #6 (zero-LLM scorer hardenings that close 5 of 8 FNs) | Five FN classes | $0 | No |
| 1b | Re-run all hero scenarios after fix #1a is in; expect verdict deltas on cases that previously passed via volume-fabrication-blindness | Validates fix lands cleanly | re-score $0; re-runs vary | No |
| 1c | ~~Shape catalog harness~~ — **DONE 2026-05-10**. 15-shape catalog in `eval/shapes/catalog.json`, 15 fabrications ported, CI gate at `bin/run-shapes.mjs --min-coverage 0.18`. Baseline = 3/16 covered. | Tracked metric for scorer shape-detection | $0 | DONE |
| 1d | ~~Mutation testing driver~~ — **DONE 2026-05-10** at `eval/bin/mutation-test.mjs`. Mutates scorer source; surviving mutations are filed to `eval/audits/dead-defense-<date>.md`. | Dead defense in the scorer | $0 | DONE (not yet executed) |
| 1e | Run the mutation tester on the current scorer; investigate every survivor | Surfaces dead defense | $0 | No |
| 6 | ~~Multi-judge ensemble~~ — **DONE 2026-05-10** at `eval/bin/judge-ensemble.mjs`. Sonnet+Opus run. Found σ > 0.2 on 2 of 5 transcripts → assumption #1 partially measured. Cross-family (e.g., Grok) deferred. | Assumption #1 | $0 (one-time ~$3 run) | DONE |
| 7 | ~~Refusal calibration~~ — **DONE 2026-05-10**. 3 specs in `fixtures/hero/refusal-*.json`; new `refusal_required` axis in the scorer. 3/3 PASS after one calibration round (widened refusal phrases when the first run refused semantically without hitting the strict list). | Over-eager fabrication on out-of-scope | $0 (~$2 run) | DONE |
| 8a | ~~Prompt-injection (static)~~ — **DONE 2026-05-10**. 2 specs; new `injection_must_not_emit` axis with context-aware framing-word check. 2/2 PASS. | Prompt injection through prompt content | $0 (~$1.20 run) | DONE |
| 8b | Prompt-injection (live, via env labels) | Live injection surface | Needs parallel env | Blocked on counterfactual env |
| 5 | ~~Counterfactual design doc~~ — **DONE 2026-05-10** at `eval/COUNTERFACTUAL.md`. Implementation blocked on env-fixture infra. | Whole-pipeline integration test | Infra cost | Blocked |
| 2 | Human-SRE-rated baseline on 5-10 transcripts | Assumption #1, #3 | Free if SRE willing | Need a willing SRE |
| 3 | Coverage scenarios for the 9-11 unblocked tools | Coverage hole 3.1 | ~$5-7 | No |
| 4 | STDIO transport scenario | Coverage hole 3.2 | $0-0.50 | No |
| 5 | One run on a customer env with real growth | Gaps #1-#3, #7 + assumption #2 | Customer-cycle dependent | Need customer access |
| 6 | Retriever fixture env | Tools `retriever_*` | Infra cost | Need infra |
| 7 | Customer metrics backend fixture | Tools `correlate_*`, `customer_metrics_query`, `backfill_metric` | Infra cost | Need backend |

## Resume protocol

After compaction:

1. Read this file alongside `CAMPAIGN.md`.
2. Check `gaps/gaps.json` — are there still 8 wontfix and 0 open?
3. Check `eval/reports/hero/CAMPAIGN-PROOF.md` — is it still 14/15?
4. Look at section 5 above. The next concrete action is whichever
   item is `In progress`. If none, item #1 (adversarial run) is
   cheapest and most informative.
5. State on disk is canonical. Conversation memory is not.
