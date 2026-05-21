# MCP Tool Audit — the "compiled context vs improvisable" lens

Audit of the ~22 investigation tools (auth/env/poc plumbing excluded). Facts
gathered by 5 grounded sub-agents reading the source; verdicts applied
centrally with one consistent lens.

## The lens

A tool earns its place only by handing the agent **context it cannot cheaply
improvise.** Reproduce-difficulty is the measure:

- **NEEDS-ENGINE** — impossible without log10x's template extraction /
  `tenx_hash` / byte metrics / the Retriever archive. *This is the moat.*
- **TRIVIAL** — one query/command a capable agent writes itself. *A wrapper.*

Two failure modes the lens exposes:
- **Redundancy** — the same engine data with a different knob → merge.
- **Verdict-overreach** — asserting a judgment ("RISING", "safe to drop") instead
  of returning context. This is exactly what made cross-pillar lose to the SRE:
  provide trustworthy context, let the agent (or human) judge.

## Per-tool verdict

| tool | reproduce | context/verdict | verdict | why |
|---|---|---|---|---|
| `top_patterns` | NEEDS-ENGINE | mixed | **KEEP-BLADE + slim** | flagship; pattern+cost+hash+drop is the moat. Trim the prose/badge verdicts |
| `savings` | NEEDS-ENGINE | mixed | **KEEP-BLADE** | only tool on pipeline-stage telemetry (bytes-reduced, S3-vs-analyzer). Irreplaceable ROI |
| `pattern_examples` | HARD/NEEDS-ENGINE | **context** | **KEEP-BLADE** | live SIEM evidence + slot distributions, honest disclaimers. Model citizen |
| `retriever_query` | NEEDS-ENGINE | context | **KEEP-BLADE** | forensic events from the Bloom archive — recovers dropped/post-retention logs |
| `backfill_metric` | NEEDS-ENGINE | mixed | **KEEP-BLADE** | archive→TSDB historical backfill; only write tool; unique |
| `exclusion_filter` | NEEDS-ENGINE (hash path) | verdict | **KEEP-BLADE** | exact-`tenx_hash` drop snippet matches real events only because the engine stamped them |
| `correlate_cross_pillar` | HARD | mixed | **KEEP-BLADE** | the cross-pillar join+correlate+tier; already de-verdicted (#7/#8) |
| `list_by_label` | NEEDS-ENGINE metric | mixed | **KEEP-BLADE** | general "bytes by any label"; **absorbs `services`** |
| `resolve_batch` | NEEDS-ENGINE | mixed-light | **KEEP-BLADE** | templatize a raw paste + rank; **absorbs `extract_templates`** |
| `cost_drivers` | NEEDS-ENGINE | verdict-ish | **SLIM** | real differentiated *growth-delta* compute; drop the "is a cost driver" gate-verdict |
| `pattern_trend` | NEEDS-ENGINE | mixed | **SLIM** | single-pattern fine series is differentiated; drop the asserted RISING/FALLING |
| `event_lookup` | NEEDS-ENGINE | mixed | **SLIM** | keep cost/baseline/sample context; drop the AI "filter/keep %" verdict |
| `investigate` | NEEDS-ENGINE | verdict-heavy | **SLIM** | most verdict + orchestration overlap (see below); keep co-mover ranking, shed the canned RCA |
| `retriever_series` | NEEDS-ENGINE | mixed | **KEEP/merge** | fidelity-decision is real, but heavy overlap w/ `retriever_query` → make it a mode |
| `doctor` | MODERATE/HARD | verdict | **KEEP-BLADE** | env self-diagnosis; verdicts are appropriate here (it's a health check) |
| `dependency_check` | TRIVIAL-MODERATE | verdict | **SLIM (thin)** | ships its own reproduction script → low moat; value is packaging; drop "safe to drop" assertion |
| `discover_join` | MODERATE | verdict | **KEEP (internal)** | real heuristic, but mostly an internal step of correlate; expose for debugging only |
| `customer_metrics_query` | TRIVIAL | context | **KEEP (escape hatch)** | honest PromQL passthrough; fine as the raw floor |
| `services` | MODERATE (1 query) | context | **MERGE → `list_by_label`** | it's `list_by_label{label=service}`, already embedded in `top_patterns` |
| `extract_templates` | NEEDS-ENGINE | context | **MERGE → `resolve_batch`** | strict subset (templater + assertions); keep assertions as a dev/test path |
| `translate_metric_to_patterns` | NEEDS-ENGINE | verdict | **MERGE → `correlate_cross_pillar`** | literally `correlate` with `anchor_type=customer_metric`; a preset, not a tool |
| `discover_labels` | TRIVIAL | context | **CUT/DEMOTE** | two stock Prometheus metadata endpoints; keep as an internal helper, not a tool |
| `pattern_mitigate` | TRIVIAL | menu | **CUT** | hardcoded routing menu — routing IS the agent's job (see below) |

## The four headline findings

1. **The moat is exactly the NEEDS-ENGINE context** — pattern/`tenx_hash`
   identity, per-pattern byte metrics, the Retriever archive, pipeline-savings
   telemetry. ~14 tools have it. Everything TRIVIAL is a wrapper the agent
   reproduces (`discover_labels`, `customer_metrics_query`, `services`,
   `pattern_mitigate`, and — notably — `dependency_check`, which ships the very
   script that reproduces it).

2. **~5 tools are redundant and should collapse:** `services`→`list_by_label`,
   `extract_templates`→`resolve_batch`, `translate_metric_to_patterns`→
   `correlate_cross_pillar`, `retriever_series`→a mode of `retriever_query`.
   These are the same engine data with a different knob. Fewer, sharper blades.

3. **The sharpest call: `investigate` and `pattern_mitigate` compete with the
   agent.** "What do I do / look at next" is the agent's live-reasoning job (the
   handle). `pattern_mitigate` is a hardcoded menu (cut). `investigate` is a
   canned RCA orchestration — useful for a weak-context agent, redundant for a
   capable one. Slim it to its *differentiated compute* (the co-mover ranking)
   and let the agent orchestrate the blades.

4. **Verdict-overreach is the recurring anti-pattern** — the same thing that
   lost cross-pillar to the SRE. `investigate`/`pattern_trend`/`event_lookup`/
   `dependency_check` assert judgments ("RISING", "filter 80%", "safe to drop").
   The fix generalizes: return trustworthy context, let the agent judge. The
   model citizens are the pure-context engine blades — `pattern_examples`,
   `retriever_query`, `savings`, the `top_patterns` core.

## Net

From ~22 → about **12–14 sharp blades**: collapse the 5 redundant, cut the 2
pure wrappers (`discover_labels`, `pattern_mitigate`), de-verdict the 5
overreachers, and keep the irreproducible-context tools as the differentiation.
The Swiss-army-knife is real; "max value per tool" was pulling toward fat
verdict-tools that overlap each other and the agent.

## Phase 2 de-verdict — status (2026-05-21)

Acted on the de-verdict findings (NOT the merges/cuts — those are deferred to
a later catalog-shape pass). Each is guarded by `eval/bin/lint-verdict-overreach.mjs`
(green) and the dual-reader log in `eval/READER-FIRST-TOOL-GATE.md`; no campaign
fixture references any removed string (deterministic axes unchanged).

| tool | done |
|---|---|
| `pattern_trend` (`trend.ts`) | **DE-VERDICTED** — dropped `RISING/FALLING/STABLE`; now `Change over <w>: +X%` + run-rates + peak-multiple + sparkline. Reader judges direction. |
| `event_lookup` | **DE-VERDICTED** — AI prompt now asks for factual `CATEGORY/CONFIDENCE/EXPLANATION` only (dropped `ACTION`/`FILTER_PCT % safe to filter`); corroboration shows short+7d facts, not "treat as a real regression". |
| `cost_drivers` | **DE-VERDICTED (light, per SLIM)** — dropped the global "environment stable" verdict → "no pattern grew materially vs baseline"; growth-Δ ranking kept. |
| `dependency_check` | **MODEL CITIZEN** — already returns the repro script + an explicit constraint *against* asserting "safe to drop"; lint-exempted that one anti-verdict line. |
| `investigate` | **DEFERRED (refactor, not a string removal)** — no clean asserted-verdict string exists; env mode is already factual, and the single-pattern core `correlation.chain` is the co-mover ranking the audit said to KEEP (already confidence-capped on inferred inflections). "Slim it / shed the canned RCA orchestration" is a refactor woven into shape-classification — can't be grader-validated while API credit is out, risks campaign fixtures, and matches the deferred merges/cuts. Logged, not half-shipped. |

Also landed this pass (cross-pillar engine, validated on the live otel-demo
incident — see `eval/cross-pillar-demo/CROSS-PILLAR-DEEP-TEST.md` run 3):
`#9` family-dedup + app-path quota + `#4` per-candidate evidence + confidence
reweight. Independent sub-agent grader: the cross-pillar tool went **31 → 43/60
(+12)**, closing the gap to a manual SRE from **14 → 2**. New OPEN finding `#10`
(topology / datastore-ownership) is the next lever; `#3` (label-aware split)
deferred until an error incident exists to validate it.

The validation loop itself (gate #5, `eval/bin/run-tool-vs-sre.mjs` +
`eval/src/tool-vs-sre.ts`) is the durable asset: it runs the A/B/SRE/grader
comparison either via the Anthropic SDK (CI/unattended) or via session
sub-agents (interactive, no metered key). `lint-verdict-overreach.mjs` is the
mechanical guard that keeps de-verdicting from regressing.

## Agent-safe catalog pass (2026-05-21, pass 2 — blades · cleanup · topology boundary)

Unifying lens: **don't seed agents to hallucinate.** Trustworthy context +
honest hand-off + fewer/sharper blades.

**Topology boundary (anti-hallucination).** Added a "co-movement, not
causation; confirm in your traces/APM" hand-off to `correlate_cross_pillar`
and `investigate` (user-visible + `agentOnly`), reworded the causal headers
("Causal chain"→"Temporal chain (not proven cause)", "Most likely root
cause"→"Most likely lead"), and added a lint rule blocking asserted causal
`###` headers. **Validated**: a fresh sub-agent, given the de-causal-ized
output and a hard "give me the definitive ROOT CAUSE" prompt, refused to
fabricate a cause, cited the hand-off, and deferred to APM. We deliberately do
NOT build the dependency graph itself (that is APM — no log10x moat).

**Blades (prove the moat).** Ran the A/B/SRE contest on the log10x-unique tools:
- `top_patterns` **wins 49–40** vs a strong CloudWatch-Insights SRE — moat real
  on durability (tenx_hash identity + copy-paste filters), speed (1 call vs 12
  queries), depth. The contest also **found + drove a fix for a flagship bug**:
  `$/h` + `$/mo` were 24×-inflated on non-1h windows (per-day cost mislabeled
  per-hour, ×720). Fixed (window-hours normalization); verified 24h now agrees
  with the 1h rate.
- `savings` is the clearest moat in principle but **env-blocked on the demo**
  (no reducer/retriever telemetry → truthful-empty; correctly does not
  fabricate). Needs an env that runs the pipeline to contest.
- `pattern_examples` moat confirmed (tenx_hash-pinned slot extraction an SRE
  can't reproduce).

**Cleanup (collapse to fewer/sharper blades).** Removed from the agent-facing
catalog (execute/schema + eval registry kept as internal/dev paths):
`translate_metric_to_patterns`→`correlate_cross_pillar`,
`extract_templates`→`resolve_batch`, `services`→`list_by_label`,
`discover_labels`→demoted. **Recast** `pattern_mitigate` as env-gated context
(capabilities + exact configs) rather than a routing menu (kept registered;
4 inbound chains rerouted in framing). All chains rerouted, 5 fixtures updated,
builds + lint + server-start green. **Deferred**: `retriever_series`→
`retriever_query` (needs `group_by` + `fidelity` param absorption); prune
`default-manifest.json` stale entries (harmless). The contest harness
generalization (per-spec `sreTask`/`rubric`) is a follow-up — the contests were
run + validated via sub-agents this pass.
