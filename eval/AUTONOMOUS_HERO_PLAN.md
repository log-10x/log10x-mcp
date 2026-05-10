# Autonomous hero-scenario plan — DEPRECATED

> **Superseded 2026-05-10 by [CAMPAIGN.md](./CAMPAIGN.md).**
>
> This file documented the original "sub-agent-as-user" hero plan
> that landed in PR #96. The follow-on anti-hallucination campaign
> built on top of it (15 hero scenarios scored on 5 axes against a
> pre-computed Prometheus oracle, with persistent gap tracking and
> a fix-rerun loop) extends and replaces every section that used
> to live here.
>
> **Read `CAMPAIGN.md` first.** It contains:
> - The campaign's purpose, scoring rubric, and gap-tracking schema.
> - The Outcome Ledger: 7 fix-rerun cycles, 4→14/15 PASS, $10/$25 budget.
> - The resume-after-compaction protocol.
> - Pointers to all persistent artifacts (`gaps/gaps.json`,
>   `oracle/expected/<ts>.json`, `fixtures/hero/*.json`,
>   `reports/hero/CAMPAIGN-PROOF.md`).
>
> The older three-axis (drift / value_delivered / value_received)
> rubric described in this file's prior content was extended to
> the current five axes (drift / pattern_match / chain_alignment /
> value_delivered / value_received). The hero-runner driver and
> sub-agent CLI surface (`bin/run-hero.mjs`, `bin/mcp-call.mjs`)
> are unchanged and are the runtime under both plans.
>
> No code or test depends on this file. Nothing in `bin/` or
> `src/` references it. It is kept as a stub so reviewers landing
> here from older PR discussion threads can find the current plan.
