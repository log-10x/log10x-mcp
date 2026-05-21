# READER FIRST — tool-output gate (validation gate #6)

The `READER FIRST` macro (see the repo `CLAUDE.md`) forces a stable
reader-model *before* drafting, to counter racing-to-please. Applied to
**tool output** it has **two readers**, and a render change passes the
gate only when both are served:

- **Human SRE** reads the rendered markdown.
- **SRE AI agent** reads the machine channels: `agentOnly()` HTML
  comments + the `NEXT_ACTIONS` JSON block (`renderNextActions`).

For every tool whose render we touch, fill the block below *before*
editing, and record the before/after. This is the human half of gate 6;
`eval/bin/lint-verdict-overreach.mjs` is the mechanical half.

> **The de-verdict rule (TOOL-AUDIT Phase 2) is this gate in one line:**
> a human reader distrusts an asserted verdict; an agent reader is
> mis-led into parroting it. So strip the asserted judgment, keep the
> context both readers can act on. The differentiated value (the moat)
> is always *context the agent cannot cheaply improvise* — never a
> louder conclusion.

## Template (copy per touched tool)

```
### <tool>
- Reader (human SRE): <who, what they already know, where in the funnel>
- Reader (SRE AI agent): <which channels it reads; what it does next>
- Job of this beat (human): <what they need in the first screen, before mechanism>
- Job of this beat (agent): <the context to orchestrate with, not a conclusion to parrot>
- Before: <the asserted verdict / prose being removed>
- After: <the context retained>
- Lint: <green | exempted: reason>
```

---

## Worked example — `top_patterns` core (the model citizen)

This is the reference for what "passes". The flagship pattern table is
pure NEEDS-ENGINE context (pattern + cost + `tenx_hash` + drop%), and it
already serves both readers without an asserted verdict.

### top_patterns
- Reader (human SRE): on-call or cost-owner who knows their services by
  name but not which log *patterns* drive spend; arrives wanting "where
  is my log bill going, and what's safe to act on".
- Reader (SRE AI agent): an MCP-host agent mid-investigation; reads the
  `NEXT_ACTIONS` JSON to chain into `investigate` / `correlate` /
  `savings` with pre-filled, verified args, and the `agentOnly()` join
  provenance to keep identity stable across calls.
- Job of this beat (human): in the first screen, the ranked
  pattern→cost→drop% table with the `tenx_hash` identity — legible spend
  attribution they could not get from a raw SIEM query, no prose padding.
- Job of this beat (agent): the same rows as structured next-actions +
  re-runnable PromQL, so it orchestrates the next blade itself rather
  than re-deriving what the pattern is.
- Before: (n/a — already context-first)
- After: (unchanged; this is the baseline the de-verdicted tools should
  resemble)
- Lint: green

---

## Phase 2 de-verdict entries

Each de-verdict applies the rule above: strip the asserted judgment, keep
the differentiated context. Validated by `lint-verdict-overreach.mjs` (green)
+ a fixture grep confirming no campaign expected-answer references the removed
strings (so the deterministic campaign axes are unchanged).

### trend
- Reader (human SRE): asked "is this pattern's cost going up?"; wants the
  trajectory + magnitude, will judge "rising" themselves.
- Reader (SRE AI agent): reads the signed delta + the sparkline + the
  NEXT_ACTIONS to chain into investigate/correlate; doesn't need a label.
- Job (human): the measured `+X%` change + the curve + the peak, in the first line.
- Job (agent): the numbers to reason from, not a `RISING` label to echo.
- Before: `Verdict: RISING +47% ...` / `FALLING` / `STABLE`.
- After: `Change over <window>: +X% (last quarter vs first quarter run-rate);
  peak N× the window average at <ts>` + the existing run-rates + sparkline.
- Lint: green.

### event_lookup
- Reader (human SRE): "what is this pattern, what's it costing, show me a sample."
- Reader (SRE AI agent): reads category + cost/severity/sample to decide
  routing itself.
- Job (human): the factual classification + cost/severity split + a real sample.
- Job (agent): the context to judge filtering, not an AI's pre-baked filter %.
- Before: AI prompt elicited `ACTION (filter/keep/reduce), FILTER_PCT
  (% safe to filter)`; a corroboration line asserted "treat as a real regression."
- After: AI prompt asks for `CATEGORY / CONFIDENCE / EXPLANATION` (factual, no
  recommendation); corroboration shows the short+7d facts ("up X% short, up Y%
  over 7d, shows on both windows") and lets the reader conclude.
- Lint: green.

### cost_drivers
- Reader (human SRE): "what's pushing my bill up vs last week?"
- Reader (SRE AI agent): reads the growth-delta ranking + comparison to chain on.
- Job (human): the patterns ranked by growth Δ + the exact comparison window.
- Job (agent): the deltas (the differentiated compute), not a global stability call.
- Before: `none detected (environment stable vs baseline)` (a global-state verdict).
- After: `no pattern grew materially vs baseline` (factual) + the existing
  growth-Δ ranking + methodology footnote retained.
- Lint: green (audit ranked this SLIM — the Δ compute was already context-forward).

### dependency_check
- Already a model citizen: it returns the reproduction script + an explicit
  constraint *against* asserting "safe to drop" before the user pastes results.
- Action: lint-exempt the anti-verdict constraint line (`verdict-lint-ok`) —
  the only "safe to drop" occurrence is the instruction NOT to assert it.
- Lint: green (exempted, with reason).

### investigate (full de-verdict DEFERRED — refactor, not a string removal)
- Reader (human SRE): mid-incident, wants the co-mover chain + timeline.
- Reader (SRE AI agent): reads the ranked chain (stat × lag × chain confidence)
  to orchestrate the next blade.
- Finding on grounding: investigate has NO clean asserted-verdict string to
  strip. Its environment mode is already factual (signed top-movers + honest
  caveats), and its single-pattern core — `correlation.chain` — is the co-mover
  ranking the audit said to KEEP, and it already self-caps confidence on
  inferred inflections (no overclaim). The audit's "slim it to the co-mover
  ranking, shed the canned RCA orchestration" is a REFACTOR (shape-classification
  + narrative woven into the architecture), which: (a) can't be grader-validated
  while API credit is out, (b) risks the campaign's investigate fixtures, and
  (c) matches the merges/cuts scope the user deferred this pass.
- Decision: NOT half-shipped. Logged as a deferred refactor alongside the
  merges/cuts. Shipping an unvalidated investigate refactor would be exactly
  the "code in a vacuum" this whole effort rejects.
- Lint: green (no asserted-verdict string present today).

## Phase 1 cross-pillar entry

### correlate_cross_pillar (#9 dedup + #4 evidence)
- Reader (human SRE): mid-incident, knows the anchor service moved, wants
  "what else moved with it and is it real" — without wading through four
  representations of the same CPU signal.
- Reader (SRE AI agent): reads the confirmed/coincidence tiers + the
  `query:` line to chain into `customer_metrics_query` / `dependency_check`;
  needs the exact re-runnable PromQL, not a truncated blob.
- Job of this beat (human): a crisp ranked list of *distinct* co-movers
  (one per physical signal), each with the evidence to judge it — did it
  move (spread), at what rate window, leads/trails/concurrent.
- Job of this beat (agent): the full re-runnable query + the moved-spread
  evidence so it can verify independently, not trust a headline %.
- Before: confirmed tier = 4 redundant CPU reps at a misleading 21%
  (lag-tightness crushed genuine co-movers); candidate = truncated PromQL
  blob; no movement evidence.
- After: family-dedup → one row per physical signal; app-path surfaced;
  honest confidence (lag is a modifier, not a gate); each row leads with
  the metric name + `moved (spread X) · rate 3m` evidence + a full `query:`
  line. **No new verdict** — the tier label already carries the call and is
  magnitude-gated (#8); the evidence is context that lets the reader judge.
- Lint: green (no asserted-verdict tokens added).
- Validated: run-3 grader, tool 31→43/60, gap to SRE 14→2.
