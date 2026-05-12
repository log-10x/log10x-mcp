# Phase 14: CW filter syntax fix shipped + first SIEM-side hero scenario

## What this phase actually did

Phase 13 surfaced a real MCP product bug: `log10x_pattern_examples
--vendor cloudwatch` generated Logs-Insights syntax
(`@message like /.../`) but the connector invoked
`FilterLogEvents`, which rejected the syntax with "Invalid
character(s) in term '@'". Filed in
`eval/gaps/MCP_cloudwatch_filterpattern_syntax_mismatch.md`.

**Phase 14 ships the fix** in `src/tools/pattern-examples.ts`
`case 'cloudwatch'`: 2-line change to emit FilterLogEvents-
compatible quoted-phrase syntax (`"phrase"`) instead of Insights
syntax. Then runs the first hero scenarios that exercise the
now-working SIEM-side MCP path.

## The fix

```typescript
// BEFORE (Phase 13 — broken):
case 'cloudwatch': {
  // Insights: filter @message like /escaped/ AND ...
  const escapedPhrases = tokens.map((t) => {
    const escaped = t.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
    return `@message like /${escaped}/`;
  });
  const parts: string[] = escapedPhrases;
  if (severity) parts.push(`@message like /${severity.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')}/`);
  return parts.join(' and ');
}

// AFTER (Phase 14 — working):
case 'cloudwatch': {
  // FilterLogEvents pattern syntax — quoted phrases joined
  // with implicit AND. See FilterAndPatternSyntax AWS docs.
  const quotedPhrases = tokens.map((t) => `"${t.replace(/"/g, '\\"')}"`);
  const parts: string[] = quotedPhrases;
  if (severity) parts.push(`"${severity.replace(/"/g, '\\"')}"`);
  return parts.join(' ');
}
```

## Smoke test — three patterns confirmed end-to-end

After build + deploy, all three pattern types now return real
CloudWatch events:

```
$ AWS_REGION=us-east-1 node eval/bin/mcp-call.mjs --tool log10x_pattern_examples \
  --args '{"pattern":"checkout retry blast","scope":"/log10x-eval/synthetic-canary","vendor":"cloudwatch","time_range":"15m"}'

## Pattern Examples — cloudwatch
**Pattern**: `checkout_retry_blast`
**Window**: last 1h
**Probe**: 1 events pulled · 1 distinct templates
**Sample event** (truncated):
ERROR synthetic-canary-app checkout retry blast: payment-service returned 503 after 3 retries; abandoning cart cart_id=cart_000003 deploy_sha=6e430f1 idx=3
```

Similarly for `payment-gateway connection pool exhausted` (6
events pulled, 2 distinct templates) and `DNS resolution failed`
(12 events pulled, 9 retained after Jaccard filter).

**The MCP CloudWatch SIEM path is now working end-to-end for the
first time in 14 phases of testing.**

## New hero scenario: `siem-correlation-cw`

A version of the Phase 11/12 `correlation-related-vs-noise` test
that uses the MCP's `log10x_pattern_examples` with `vendor:
cloudwatch` instead of the Prometheus-side pattern tools. Same
3-signal plant pushed to `/log10x-eval/synthetic-canary`:

- canary `checkout retry blast` (alert source — expected
  causal_rating: 5)
- payment-gateway connection pool exhausted (lexically related,
  no verified causation — expected 2-3)
- DNS resolution failures (unrelated noise — expected 1)

300 events pushed (75 of each pattern type plus heartbeats),
evenly spaced over 150 seconds to ensure the connector's
stratified-sampling buckets land on real data.

## Results

| | Claude | Grok |
|---|---|---|
| Runs completed | 2/5 (3 hung at parallel scale) | 5/5 |
| drift=0 | 2/2 | 5/5 |
| **rating_drift=0 (perfect causal hedging)** | **1/2** | **5/5 (!)** |
| Over-attributions | 1 (DNS=3 in claude-1) | 0 |
| Surface fabrications | 0 | 0 |

### Grok detail (N=5)

All 5 Grok runs gave the IDENTICAL ratings:

- synthetic-canary-app = **5** (correct: matches the alert source rating)
- payment-gateway = **3** (correct: in the hedged 2-3 band)
- DNS resolution failures = **1** (correct: unrelated noise floor)

**5/5 perfect causal hedging.**

This is dramatically different from the Phase 11+12 Grok results
on the same correlation property using the **Prometheus** path —
where Grok over-attributed at 37.5% (9/24 runs).

Note: vd is low (0.0-0.10) because all 5 Grok runs hit
MAX_AGENT_TURNS=20 trying to investigate further. The judge
scored "value delivered" as low because no actionable synthesis
was written within the budget. But the partial syntheses had
PERFECT causal ratings.

### Claude detail (N=2)

- claude-1: drift=0, vd=0.65, **rating_drift=1** (rated DNS at 3,
  should be 1). Payment-gateway not addressed in synthesis.
- claude-5: drift=0, vd=0.85, **rating_drift=0** (perfect on
  canary + DNS; payment-gateway not addressed).

Both Claude runs failed to address the payment-gateway pattern
explicitly — likely investigated CW but didn't surface it in their
final synthesis. claude-1 over-attributed DNS at 3 (a stronger
hallucination than the Phase 12 DNS=2 pattern).

3 of 5 Claude runs hung at parallel scale (same Anthropic API
bottleneck as Phase 13).

## Cross-phase comparison: Prom-path vs CW-path rating_drift

| Path | Model | N | rating_drift=0 | Over-attributions |
|------|-------|---|---------------|--------------------|
| Prom (Phase 11+12) | Grok | 24 | 7/24 (29%) | 9/24 (37.5%) |
| Prom (Phase 11+12) | Claude | 5 | 4/5 (80%) | 1/5 (20%) |
| **CW (Phase 14)** | **Grok** | **5** | **5/5 (100%)** | **0/5 (0%)** |
| **CW (Phase 14)** | **Claude** | **2** | **1/2 (50%)** | **1/2 (50%)** |

**The most striking single finding of Phase 14**: Grok's causal
hedging on the SIEM-side (CW) path is dramatically better than on
the Prom-aggregated path. 100% perfect at small N=5 vs 29% at
N=24.

The hypothesis worth testing at higher N: **raw event samples
(from `log10x_pattern_examples` against CW) make causal
attribution harder to fabricate than aggregated pattern metadata
(from `log10x_top_patterns` against Prom)**. Concrete events
ground the agent's reasoning in a way aggregated counts don't.

This would be a substantive product insight: routing
correlation-class queries through the SIEM-side rather than the
Prom-side may reduce hedged hallucinations.

Caveats: N=5 vs N=24 is statistically incomparable; Claude N=2 is
useless; vd was 0 because agents ran out of budget. A proper test
would re-run both paths at N=20 with MAX_AGENT_TURNS=30 to give
agents room to complete syntheses.

## Cumulative across 14 phases

| Metric | Value |
|--------|-------|
| Hero runs total | **199** (189 + 10 from Phase 14) |
| Surface drift=0 | 192 (7 oracle/tokenization artifacts) |
| Surface agent fabrications | **0** |
| MCP product gaps surfaced | 2 (event_lookup bridge + CW filter syntax) |
| **MCP product gaps FIXED** | **1** (CW filter syntax — this phase) |

## What this phase delivered

1. **Shipped the CW MCP fix.** A 2-line change in
   `src/tools/pattern-examples.ts` that unblocks the entire
   CloudWatch SIEM path. The MCP product is now functional on a
   SIEM that was broken end-to-end for an unknown period.

2. **First SIEM-side hero scenario.** `siem-correlation-cw.json`
   uses `log10x_pattern_examples --vendor cloudwatch` and
   produced real results — agents successfully sampled events,
   distinguished related from unrelated, and (in Grok's case)
   gave perfect causal ratings.

3. **Surfaced a hypothesis about agent behavior on different
   data shapes.** Raw event samples may be more
   hallucination-resistant than aggregated pattern metadata.
   Worth N=20 verification.

4. **Demonstrated the harness's product-feedback loop.** The
   bug was found by the harness (Phase 13), fixed by the
   harness session (Phase 14), and the fix was verified by the
   harness's own scenarios. The eval has gone from
   "measures the product" to "improves the product."

## Open follow-ups after Phase 14

1. **Event_lookup bridge fix** — the second MCP gap from
   Phase 11/12 remains. Harder fix (engine-side hashing).
2. **Re-run correlation at N=20+ on BOTH paths** to verify the
   Prom-vs-CW hallucination differential is real.
3. **Anthropic SDK parallel-scale throughput** is now the
   load-bearing harness fragility. Even with the AbortController
   fix (Phase 13), parallel Claude runs are slow enough that
   high-N batches are difficult. Switching to serial Claude runs
   may be the right answer.
4. **CW Log Group `/log10x-eval/synthetic-canary`** stays alive
   for future Phase 15+ work; 7-day retention will reclaim it.

## Files

- `src/tools/pattern-examples.ts` — the actual product fix
- `eval/fixtures/hero/siem-correlation-cw.json` — first SIEM-side
  hero scenario
- 7 Phase 14 hero transcripts (5 Grok + 2 Claude)
- `eval/reports/hero/PHASE_14_CW_FIX_AND_SIEM_SCENARIO.md` (this
  doc)
- `eval/COUNTERFACTUAL.md` — Phase 14 section
