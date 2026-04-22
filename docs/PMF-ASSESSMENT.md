# PMF Assessment — 2026-04-15/16 GA Hardening Session

## Summary

**Overall score: 7/10** (Grok-4 independent assessment)

Stable templateHash is genuinely differentiated in 3 of 5 tested axes. Two axes need work before GA.

## Per-Scenario Verdicts

| # | Scenario | Axis | Verdict | Score |
|---|----------|------|---------|-------|
| 1 | Long-term trend (30d pattern_trend) | Identity stability across deploys/restarts | **DIFFERENTIATED** | 10/10 |
| 2 | Cross-service correlation (investigate) | Metric-based causal chain | **PARTIALLY DIFFERENTIATED** | 6/10 |
| 3 | Forensic retrieval (streamer_query) | Cold-storage queryability via Bloom index | **NOT DIFFERENTIATED** (demo reliability) | 3/10 |
| 4 | Offline validation (extract_templates) | Deterministic offline extraction + assertions | **DIFFERENTIATED** | 9/10 |
| 5 | Week-over-week cost attribution (cost_drivers) | Query-independent cost delta by stable identity | **DIFFERENTIATED** | 9/10 |

## What's differentiated (strengths to lead with)

1. **Unbroken time-series across chaos** (Scenario 1): 31 data points over 30 days, same templateHash through pod restarts, scale events, config changes. Competitors require manual cluster merging for this.

2. **Offline validation with assertions** (Scenario 4): local tenx CLI produces identical templateHash as the live pipeline. `forbidden_merges` assertions catch cross-event template bugs. ~7s per batch. No API key, no network. Competitors have no equivalent for CI/CD pattern regression testing.

3. **Query-independent cost attribution** (Scenario 5): 4 cost drivers identified out of 2664 patterns, all keyed on pre-computed templateHash. The same drivers appear regardless of when or how you query. Competitors' cost breakdowns are query-dependent and shift with filter changes.

## What needs work (gaps to close before GA)

1. **Forensic retrieval reliability** (Scenario 3): the Bloom-indexed S3 archive is architecturally sound but the demo indexer falls behind (0 events / 92s on 3 out of 4 recent queries despite confirmed live traffic). Filed as Ticket 2 Failure A. **GA-blocking**: customers will test this feature first and if it returns empty, trust is gone.

2. **Causality inference in cross-service correlation** (Scenario 2): the investigate tool finds co-movers across services via stable metrics but can't infer which pattern CAUSED which. All 8 co-movers moved simultaneously (+99-100%) with no lead/lag signal. APM distributed tracing would give the call chain. **Not GA-blocking** but limits the "structural wedge" marketing claim.

## Grok's key insight

> "It's a compelling fit for cost-focused, pattern-centric use cases (SREs optimizing ingest bills), but needs enhancements in reliability and tracing integration to broaden appeal."

The PMF is strongest when framed as **observability memory for cost optimization** rather than as a full incident-response platform. The offline validation angle (Scenario 4) is uniquely differentiated and has no competitor equivalent — lead with it for developer-focused GTM.

## What was tested

- **Live environment**: otel-demo, 41 services, 44.3 GB/day, 2664 patterns, Edge Reporter tier
- **Tools exercised**: log10x_doctor, log10x_services, log10x_top_patterns, log10x_cost_drivers, log10x_pattern_trend, log10x_investigate, log10x_streamer_query, log10x_resolve_batch, log10x_extract_templates, log10x_event_lookup
- **Independent reviewer**: Grok-4 (grok-4-latest via xAI API), prompted to be skeptical and assume re-skin until proven otherwise
- **Methodology**: Grok designed 5 falsifiable scenarios; Claude executed them live; Grok scored the results

## Session deliverables

| Commit | Description |
|--------|-------------|
| `31733f3` | ENGINE_TICKETS.md: Ticket 0 (JSONL newline escaping) |
| `4d25a09` | parseJsonl shape guard (G12 client-side fix) |
| `3813106` | ENGINE_TICKETS.md: evening status update — split tickets, withdraw G10 |
| `bf55bfd` | Phase 1: dev-cli.ts rewrite + packaged config + privacy_mode default |
| `30dcf1c` | Phase 1: template cache isolation via TENX_INCLUDE_PATHS shadow |
| `6673f50` | Phase 2: log10x_extract_templates tool with assertion-based validation |
