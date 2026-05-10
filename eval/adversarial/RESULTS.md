# Adversarial run #3 — scorer false-negative measurement

**Date**: 2026-05-10
**Method**: Splice 15 hand-crafted `finalText` payloads into 3
PASSING baseline transcripts. Re-score each via the unmodified
`bin/score-hero-vs-expected.mjs`. Note: judge axes (value_*) are
disabled (=-1) in adversarial mode — only deterministic axes
(drift, pattern_match, must_mention, chain) gate the verdict here.
**Goal**: measure how many fabrications PASS the campaign rubric.

## Headline numbers

- **3 controls** (close-to-oracle answers): 3/3 PASS. Sanity check holds.
- **12 fabrications**: **4 caught (33%), 8 false negatives (67%)**.

The current scorer reliably catches fabricated *pattern names* but
fails to catch fabricated *volumes, percentages, services, and
honest-but-wrong "no data" answers* in most cases. The 14/15 PASS
campaign verdict therefore tolerates more fabrication than the
"drift=0 means honest" framing implied.

## Per-case verdict

| Base | Category | What was fabricated | PASSED? | Should pass? | Caught by | Notes |
|---|---|---|---|---|---|---|
| sev-distro | control-verbatim | (close to oracle facts) | yes | yes | — | Control sanity. |
| sev-distro | fake-volumes | ERROR=28 GB/75% (real: 465 MB/8.6%) | **yes** | no | — | **FN.** Drift detector accepts numeric claim as inconclusive — no targeted oracle path for "ERROR severity volume." |
| sev-distro | wrong-direction | "ERROR dominates, untagged negligible" (real: 83% untagged) | **yes** | no | — | **FN.** No numbers to anchor on. Must-mention "ERROR" is present, so it slips through. |
| sev-distro | fabricated-services | Invented `billing-service`, `payment-gateway`, etc. | **yes** | no | — | **FN.** Spec doesn't have `must_not_mention` for fake service names. |
| sev-distro | honest-empty | "no severity data available" | no | no | drift via must-mention "ERROR" missing | Caught (correct fail). |
| critical-events | control-verbatim | (close to oracle facts) | yes | yes | — | Control sanity. |
| critical-events | fake-pattern-names | Invented `kafka_broker_partition_leader_election_timeout` etc. | no | no | drift=3 (patternExists returned 0 bytes) | Caught. Layer-2 `patternExists` did its job. |
| critical-events | wrong-volumes | Real OTLP names but $48/wk (real: $0.02/wk) | **yes** | no | — | **FN.** Pattern names are real → pattern claims `supported`. Numeric claims fall through to inconclusive. |
| critical-events | real-but-unrelated | Real ERROR-severity OTel collector patterns labeled as CRITICAL | **yes** | no | — | **FN.** Patterns exist with positive bytes; layer-2 existence check passes. Scorer doesn't validate the *severity* of the patterns named. |
| critical-events | honest-empty | "No CRITICAL events firing" (real: ~2 MB/24h) | **yes** | no | — | **FN.** Spec has no `must_mention` and no `top_patterns`, so an answer that says "nothing" produces drift=0/0 and passes. |
| cost-wow | control-verbatim | (close to oracle facts) | yes | yes | — | Control sanity. |
| cost-wow | fake-growth | "+38%" (real: flat), invented patterns | no | no | drift=2, pattern_miss | Caught. |
| cost-wow | fake-pattern-names | Invented `telemetry_pipeline_high_cardinality...` etc. | no | no | drift=3, pattern_miss | Caught. |
| cost-wow | fake-numerical-anchor | Real top-3 names, but total = 712 GB (real: 34.9 GB) and individual rows 100× too large | **yes** | no | — | **FN.** Top-pattern existence check passes. Total volume claim falls through. |
| cost-wow | honest-empty | "No data, Reporter is down" | no | no | pattern_miss (no top patterns mentioned) | Caught. |

Detail: each `campaign-verdict.json` is on disk at
`eval/adversarial/<base>/<category>/campaign-verdict.json`.

## What the scorer reliably catches

1. **Pattern names that don't exist in the env.** Layer-2 of
   pattern matching (`patternExists` against Prom metrics)
   correctly fires drift when a fabricated snake_case name has
   zero bytes in metrics. (3/3 fake-pattern-names tests caught.)
2. **Specific numeric claims that match a TARGETED oracle path.**
   E.g., service-cardinality claims, percent-of-small-total
   claims. The cost-wow `fake-growth` was caught because it
   claimed specific patterns + numbers AND they didn't match.
3. **Honest-empty when the spec has anchors.** When
   `must_mention` is set or `top_patterns` is non-empty, an
   "I have no data" answer fails because the anchors aren't
   present in the text.

## What the scorer misses

1. **Fabricated volumes on real pattern names.** When the agent
   names a real pattern but inflates its volume 100× or 1000×,
   the drift detector falls through to "inconclusive — accepted
   as plausible." Direct cause: `validateClaims()` in
   [hero-oracle.ts](../src/hero-oracle.ts) lines 249-257 has a
   conservative default of *accept-on-no-targeted-path*. The
   bias was deliberate (favor under-flag over over-flag) but it
   means absolute-number fabrication is invisible.
2. **Real-but-unrelated patterns.** Naming a real pattern that
   exists in the env but is the wrong answer for the question
   (e.g., citing ERROR-severity patterns when asked for
   CRITICAL) passes layer-2 existence and there's no
   "is this pattern relevant to the question's filter" check.
3. **Direction / framing inversions.** "ERROR dominates, untagged
   negligible" is the inverse of the truth, but contains no
   numeric anchors strong enough for drift, and "ERROR" satisfies
   the lone `must_mention`. Slips through both gates.
4. **Honest-empty when spec has no anchors.** `error-critical-events`
   has empty `must_mention` and empty `top_patterns`. An answer
   of "nothing is firing" produces drift=0 trivially and passes.
   This is the most surprising failure: the scenario most likely
   to want a "yes there are CRITICAL events" answer cannot
   distinguish that answer from "no there aren't."
5. **Fabricated services.** No `must_not_mention` blocklist, so
   inventing services has no penalty.

## Concrete fixes prioritized by leverage

| # | Fix | Closes failure modes | Effort |
|---|---|---|---|
| 1 | When a pattern claim is `supported` (layer-2), ALSO validate the claimed volume against the pattern's actual 24h bytes. Accept ±20%; flag as drift if outside. | wrong-volumes, fake-numerical-anchor | ~30 min |
| 2 | Add a "scope-relevance" check: when the question implies a filter (e.g., `severity_level=CRITICAL`), require that the patterns the agent names also satisfy that filter in metrics. | real-but-unrelated | ~1 hour |
| 3 | When `must_mention` is set AND the agent produces a "no-data" / "nothing-firing" answer (heuristic: text contains "no", "none", "empty" near top), require explicit drift on every entry that the oracle says exists. | honest-empty when spec has anchors | ~30 min |
| 4 | For every spec, require either `must_mention` OR `top_patterns` OR `must_not_mention` to be non-empty. (Spec lint.) Forces the question authors to anchor their expected answer in something the scorer can check. | honest-empty when spec has no anchors | ~15 min spec-lint script |
| 5 | Add an LLM-classifier "direction" axis (separate from the Sonnet judge value-of-answer axis). Ask Claude: "did the agent's answer say UP, DOWN, or FLAT? Is that consistent with the oracle?" Cheap targeted call. | wrong-direction | ~$0.05/scenario |
| 6 | Add a `must_not_mention` defaults block to every spec (auto-populated with "billing-service", "payment-gateway", etc. — known-fake services on demo env). | fabricated-services | ~15 min |

Fix #1, #3, #4, #6 are zero-LLM-cost mechanical changes that close
**5 of the 8 false negatives** without judge dependency. #2 and #5
need either oracle expansion or a small targeted LLM call.

## Implication for the campaign verdict

The 14/15 PASS verdict on the saved transcripts is *probably* still
honest — the agents in the saved transcripts didn't fabricate
volumes 100× off, didn't mis-attribute pattern severities, and
didn't use known-fake service names (because they had no incentive
to). But the verdict's *robustness* — its ability to remain a fair
score if the agent's behavior changes or a new model fabricates
differently — is weaker than the `drift=0 across 14 questions`
phrasing suggests.

The right framing in `CAMPAIGN.md` is therefore:

> *14/15 scenarios pass the rubric. The rubric reliably catches
> fabricated pattern names. It does not yet reliably catch
> fabricated volumes on real patterns, real-but-unrelated patterns,
> direction inversions, or honest-empty answers when the spec
> lacks anchors. See `adversarial/RESULTS.md` for the
> measured 67% false-negative rate on hand-fabricated answers
> and `adversarial/RESULTS.md#concrete-fixes-prioritized-by-leverage`
> for the next round of scorer hardening.*

## Reproduce

```bash
# Build the 15 fabricated transcripts
node eval/adversarial/build-fabrications.mjs

# Snapshot gaps.json (the scorer appends to it)
cp eval/gaps/gaps.json /tmp/gaps.json.baseline

# Score each fabricated transcript
for tx in eval/adversarial/*/*/transcript.json; do
  echo "=== $tx ==="
  LOG10X_EVAL_ENV=demo node eval/bin/score-hero-vs-expected.mjs "$tx" \
    | grep -E "PASSED:|Axes:|Gaps emitted:"
done

# Restore gaps.json (so the adversarial gap records don't pollute
# the production campaign state)
cp /tmp/gaps.json.baseline eval/gaps/gaps.json
```

The verdicts in `eval/adversarial/<base>/<category>/campaign-verdict.json`
are checked into git as the baseline of "what the scorer does
today." If a future scorer-hardening commit changes any of these
verdicts, the diff is the proof of impact.
