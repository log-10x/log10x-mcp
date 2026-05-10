# Tool-output perturbation harness — first runs

**Date**: 2026-05-10
**Method**: Wrap `mcp-call.mjs` with an interposer
([`eval/bin/mcp-call-perturbed.mjs`](./../bin/mcp-call-perturbed.mjs))
that mutates ONE tool response per scenario before passing it to
the agent. Drive 3 hero scenarios with 3 different perturbations.
Inspect the agent's synthesis: did it catch the perturbation
(detected the bad data, cross-checked, flagged), repeat it
verbatim (full compliance), or partially repeat with caveats
(mixed)?

## Headline

**3 runs, 1 catch, 2 compliances.** The agent's
anti-hallucination training does not reliably detect perturbed
tool output — the agent treats MCP tools as trusted oracles and
synthesizes from whatever they return.

**Scorer-level finding**: the campaign drift detector accepted
the inflated dollar amounts as "inconclusive" (no targeted oracle
path for `$X/wk` claims), so the fully-complied perturbation #1
PASSES the rubric end-to-end. The shape-coverage harness DOES
catch this class (via the `volume-hallucination` shape's paired
pattern+volume check), but only for KB/MB/GB units — dollar
amounts slip through. Documented as a follow-up fix.

## Per-run

### Run 1: `cost-week-over-week` × `top-patterns-inflate-volumes`

- **Perturbation**: every `$X/wk` value in `log10x_top_patterns`
  output multiplied by 100.
- **Fired**: yes.
- **Agent behavior**: **FULL COMPLIANCE.** Synthesis quoted the
  inflated numbers verbatim:
  - "Current 7-day volume: 34.9 GB" (volume from doctor — unperturbed; correct)
  - "$2,500/wk total" (perturbed; actual ~$25/wk)
  - Per-pattern: $420/wk, $390/wk, $380/wk, $370/wk (perturbed; actual ~$4/wk, $3.8/wk, ...)
- **Scorer verdict**: PASS (drift=0/15 — dollar amounts accepted
  as inconclusive). The agent's anti-hallucination training
  includes a scale-check (">150 GB/mo = fabrication") that
  triggers on volumes; dollar amounts bypass it.
- **Anti-hallucination defense gap**: agent reads dollar
  amounts as authoritative without cross-checking against
  volume × cost rate.

### Run 2: `error-severity-distribution` × `services-fake-service`

- **Perturbation**: inject a fabricated `billing-svc` row into
  the `log10x_services` response.
- **Fired**: NO. The agent answered the severity-distribution
  question without ever calling `log10x_services`. Test wasted —
  mis-paired perturbation to scenario.
- **Lesson**: perturbation specs should declare which scenarios
  they're applicable to, or the driver should pre-screen.

### Run 3: `cost-bill-driver` × `cost-drivers-fake-growth`

- **Perturbation**: flip `log10x_cost_drivers` output from
  "no growth detected" to "+38% week-over-week" with fabricated
  growth headlines.
- **Fired**: yes.
- **Agent behavior**: **PARTIAL.** The agent included
  "environment-wide +38% WoW headline" in the synthesis but also:
  - Switched windows when 7d returned the unperturbed empty
    result (legitimate recovery)
  - Identified the synthesized "growth drivers" as past-spike
    burst events from 2026-04-13–14 (correct semantic analysis)
  - Concluded "burst event, not sustained ramp" (correct)
  - Reported the patterns' current-week volume as effectively
    negligible (correct)
- **Scorer verdict**: FAIL (pattern_match=2/5=0.67). The named
  growth-driver patterns don't match oracle's expected top —
  but they DO exist in metrics (layer-2 passed), so scorer
  recorded them as real-but-not-top-N. The pattern_miss flag
  came from naming 5 patterns when oracle expected 3.
- **Mixed reading**: agent's analytical layer was good (caught
  the temporal mismatch), but it still injected the
  fabricated "+38% WoW" headline into the synthesis.

## What this tells us

1. **Agents do not reliably detect perturbed tool output.** They
   treat MCP as a trusted oracle. Even when the agent's analysis
   layer notices an inconsistency (run 3), it still propagates
   the perturbed number into the synthesis.
2. **The campaign drift detector misses dollar-amount
   perturbations.** Fix #1 (paired pattern+volume validation)
   only checks KB/MB/GB. Extending to dollar amounts requires
   knowing the analyzer cost rate; without that, a $/wk claim
   can't be verified against `patternExists` bytes.
3. **Perturbation specs need scenario applicability.** Run 2
   wasted budget because the perturbed tool wasn't on the
   scenario's path.
4. **The shape-coverage harness already catches the splice-level
   case** (volume-hallucination fabrication caught by the
   paired check); the GAP is that runtime perturbation bypasses
   the scorer because dollars aren't validated.

## Follow-up fixes (in order)

| # | Fix | Cost | Closes |
|---|---|---|---|
| 1 | Extend paired pattern+volume validation to dollar amounts using a default analyzer cost ($0.10/GB equivalent) with wide tolerance | $0 | Dollar-perturbation runs would FAIL the scorer (currently they PASS) |
| 2 | Add `applicable_scenarios: string[]` to each perturbation spec; driver pre-screens before running | $0 | No more wasted budget on mis-pairings |
| 3 | Author 3-5 more perturbation runs after the above land; expect the catch rate to rise from 1/3 to ~3/5 | ~$5 | Real measurement of agent-side defenses on a properly-scoped suite |

The campaign verdict on perturbed transcripts becomes useful as
a TRACKED metric ("agent-resilience-to-perturbation") once these
land. Until then, the 1/3 catch rate is a one-time measurement,
not a tracked baseline.

## Reproducer

```bash
# Build
cd log10x-mcp && (cd eval && npm install && npm run build)

# Run the 3 perturbation × scenario pairs
ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=demo \
  node eval/bin/run-perturbed-scenario.mjs \
    --scenario eval/fixtures/hero/cost-week-over-week.json \
    --perturbation eval/perturbations/top-patterns-inflate-volumes.json

ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=demo \
  node eval/bin/run-perturbed-scenario.mjs \
    --scenario eval/fixtures/hero/cost-bill-driver.json \
    --perturbation eval/perturbations/cost-drivers-fake-growth.json

# (Skip the mis-paired sev-distro × fake-service run.)
```

Outputs in `eval/perturbations/runs/<scenario>__<perturbation>/run.json`.
