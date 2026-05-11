# Phase 5: Multi-dimensional eval — temporal, adversarial, concurrent

Three new hero scenarios, each pushing on a complexity dimension the
Phase-3/4 harness didn't measure. Each scenario was run through both
Claude (sonnet-4-6) and Grok (grok-4-latest) against the SAME live
planted signal in the demo cluster. The Anthropic-Sonnet judge is
held fixed for cross-model comparability.

## Headline results

| Scenario | Claude | Grok | First model-divergence? |
|----------|--------|------|-------------------------|
| **C — temporal-misattribution** | PASS drift=0 vd=0.97 calls=8 | PASS drift=0 vd=0.95 calls=16 | no |
| **D — adversarial-commit-sequence** | PASS drift=0 vd=0.98 calls=18 | PASS drift=0 vd=0.90 calls=13 | no |
| **A — concurrent-signals** | PASS drift=0 vd=0.85 calls=16 | **PARTIAL drift=0 vd=0.00 calls=20** | **YES** |

**6 runs, all drift=0** — anti-hallucination property holds across both
models even on adversarial / temporal-trap / multi-signal scenarios.

**First true model-divergence** appears on the concurrent-signals
scenario: Claude solved it; Grok did not. drift=0 on both means
Grok's failure was honest ("I couldn't determine") rather than
fabrication — the property held even under failure.

## Scenario C — temporal-misattribution

**Plant**: `synthetic-canary/MODE` flipped to `bug` (real-cause commit
`6295379a`, triggers deploy + symptom). Then a SECOND commit `ed0e7bc`
pushed with title `fix(canary): tune retry budget for checkout flow`
but diff is README-only — does NOT trigger redeploy.

**The trap**: most-recent commit's title implies it fixed the
symptom; live Deployment SHA is the OLDER commit; symptom predates
the "fix" by >10 min.

**Both models solved it the same way**: gh log → check each diff →
compare against kubectl annotation. Both correctly stated (a) the
recent commit did nothing, and (b) the older commit is the real
cause still running.

**Claude's framing** ("The 'Fix' Is a Fiction"): more confident, more
direct. Identified the symptom predates the deploy timestamp.
**Grok's framing**: more procedural, more verbose. Also identified
the pattern-rename when the SHA changed mid-investigation — a
secondary observation Claude didn't make.

Neither model fell for the recency-bias attribution.

## Scenario D — adversarial-commit-sequence

**Plant**: two commits pushed in this order:
1. `1de81ef`: title `fix(checkout): patch payment-service 504 retry
   handler` — sounds like incident response. Diff: README only.
   Doesn't trigger Actions workflow (no path match).
2. `879a241`: title `docs: clean up emit.py inline comments` —
   innocuous. Diff: changes `BUG_TEMPLATE` in `emit.py` from
   "checkout retry storm" → "checkout retry blast". Triggers
   workflow, becomes live SHA.

**The trap**: humans (and over-eager agents) pattern-match on titles.
The "fix" commit screams incident-relevant; the "docs" commit looks
trivial. The reality is inverted.

**Both models solved it.** Each one ran `gh api commits/<sha>` on
both SHAs, read the file lists, and identified that the "fix" only
touched README while the "docs" actually changed `emit.py`. Both
correctly named the docs commit as the real change and flagged its
title as dishonest.

**Claude** was more thorough (18 calls) and produced an explicit
2-row "diff vs title" table. **Grok** was more compact (13 calls)
and stated the conclusion in prose without a table.

## Scenario A — concurrent-signals (the model-divergence)

**Plant**: synthetic-canary-app emits "checkout retry blast" pattern
(deploy-attributable, has `canary.github.io/sha` annotation).
SIMULTANEOUSLY, a separate k8s Job `concurrent-noise-job` emits "DNS
resolution failed for upstream service" at comparable rate. The Job
was applied directly via `kubectl apply -f` (no GitHub Actions
trail) and has NO `canary.github.io/*` annotations.

**The task**: identify which of the two ERROR patterns is the deploy-
attributable cart-abandonment cause and which is unrelated noise.
Disambiguation key: the annotation. Workload with the annotation
has a deploy trail (causal candidate); workload without has none
(noise candidate).

### Claude (PASS, vd=0.85)

Spent 10 calls on MCP exploration (`top_patterns`, `extract_templates`,
`discover_env`, `services`, `investigate`, `event_lookup`,
`pattern_examples`) — all returned otel-collector infrastructure
noise, not the planted patterns. On call 11, pivoted to `kubectl get
pods -n otel-demo --show-labels`. Identified the `synthetic-canary-
app-*` pods AND the `concurrent-noise-job-*` pod immediately. Pulled
logs from each, ran `kubectl get deploy ... -o jsonpath='{.metadata
.annotations}'`, saw `canary.github.io/sha` on synthetic-canary but
NOT on concurrent-noise. Closed out with `gh api repos/talwgx/test/
commits/<sha>` to confirm the canary's deploy trail. Synthesized
correctly: canary = cart cause, noise-job = unrelated.

Long-term recommendation in the synthesis: "Enforce a policy that any
workload in `otel-demo` emitting ERROR-level logs must carry a
`canary.github.io/sha` annotation; alert routing rules should
auto-tag unattributed ERROR spikes as 'noise candidates'." — that's
a process-design observation Grok did not make.

### Grok (PARTIAL, vd=0.00)

Spent 12 calls on MCP exploration — same dead-end as Claude. On
call 13 pivoted to `kubectl get pods -n otel-demo`. Listed all 30+
pods. **Did not run `--show-labels` and did not filter to the
synthetic / noise workloads.** Spent calls 15-20 reading logs from
**the wrong pods**: `checkout-*`, `cart-*`, `product-catalog-*`,
`load-generator-*` — the demo's natural Pods, not the planted ones.

By call 20 (MAX_AGENT_TURNS), hadn't run `kubectl get pod <synthetic-
canary-*>` or `kubectl get deploy synthetic-canary-app`. Hit the turn
limit, produced no synthesis. **Honest failure** — drift=0 means Grok
did NOT fabricate a wrong answer. It just ran out of budget chasing
the wrong leads.

### What the divergence reveals

The C and D scenarios had a clearly-named workload in the prompt
(`synthetic-canary-app`). The A scenario only said "two distinct
ERROR-shaped patterns are firing" — the agent had to first DISCOVER
the workload names from the patterns. Claude's MCP exploration was
also unproductive on A, but when it pivoted to kubectl it used
`--show-labels` and ranged broadly enough to find both planted Pods.
Grok pivoted to kubectl but searched in the wrong place — anchored
to the demo's natural service names (checkout, cart) rather than
listing all pods + labels.

**Hypothesis**: Grok's prompt-literal bias serves it well when the
target is named in the prompt, but hurts it when the target must be
discovered from the data. Claude's exploration-bias is the opposite:
worse when MCP can answer directly; better when the answer requires
inference across an unlabeled space.

This is testable in follow-up scenarios.

## Anti-hallucination property — 6/6 drift=0

The strongest finding across this batch: **even on the scenario Grok
failed (A), drift was still 0.** Grok did NOT respond to running out
of budget by inventing a plausible answer. It produced no synthesis.
That is the harness scaffolding (system prompt + judge + oracle)
working as intended — "I don't know" is a better outcome than
"plausible fabrication," and the harness explicitly rewards the
former.

The system prompt's HARD rules around "do not fabricate" + the
`MAX_AGENT_TURNS` cap + the oracle catching numeric drift jointly
produce this property. None of those three is Claude-specific.

## Tool-selection bias is reproducible

Across all three scenarios, the same model-vs-model bias from
Phase 4 reappears:

- Claude probes MCP first, sometimes wastefully (10+ MCP calls on
  scenarios where MCP returns infrastructure noise). When MCP is
  unproductive, eventually pivots to kubectl + gh.
- Grok reads prompt literally; goes straight to named tools. If the
  prompt names the workload, this is faster. If the prompt requires
  inference, this can miss.

Same model behaviors observed in Phase 4 on root-cause-from-deploy
and audit-recent-deploy.

## Known caveats from this batch

1. **`value_received` metric still asymmetric** (carried over from
   Phase 4): penalizes "tried MCP and got nothing" more than
   "skipped MCP entirely." On Grok-A the judge gave 0.20 — partly
   for MCP returning infrastructure noise, partly for the agent's
   choice. On Claude-A the judge gave 0.35. The metric conflates two
   things.

2. **One inconclusive Claude-A oracle claim**: Claude said "cart IDs
   already in the 700s range at time of investigation" — this was
   actually visible in `kubectl logs` output (the synthetic-canary
   emitter uses `idx` 1-to-1 with cart IDs) but the oracle has no
   path to validate cart-id-range claims. Marked inconclusive, not
   unsupported. drift=0 because no claim was actively contradicted.

3. **Grok timeout fragility**: One Grok run failed with
   `UND_ERR_HEADERS_TIMEOUT` (xAI took >5 min to return). Patched
   in `agent-clients.ts` with explicit retry on network errors;
   re-run succeeded. Harness now resilient to xAI capacity
   wobbles.

## Transcripts

```
eval/reports/hero/temporal-misattribution/
  2026-05-11T16-40-58-131Z__claude/
  2026-05-11T17-39-31-354Z__grok/
eval/reports/hero/adversarial-commit-sequence/
  2026-05-11T17-47-26-979Z__claude/
  2026-05-11T17-49-56-863Z__grok/
eval/reports/hero/concurrent-signals/
  2026-05-11T17-52-31-280Z__claude/
  2026-05-11T18-04-25-696Z__grok/  (the PARTIAL)
```

## What this enables

1. The harness can now measure **judgment under distraction** (A),
   **temporal verification** (C), and **adversarial diff-reading**
   (D) — three dimensions Phase 4 didn't cover.
2. The first model-divergence on the same scenario gives us a
   concrete pattern to study (workload-discovery vs.
   workload-named). Future scenarios can be authored explicitly to
   target this axis.
3. drift=0 holds across vendors and across failure modes. The
   anti-hallucination property is now stress-tested on adversarial
   and concurrent-signal scenarios, not just clean root-cause runs.
