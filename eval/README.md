# log10x-mcp eval harness

End-to-end test harness for the log10x MCP catalog. Measures three properties of an autonomous-chain agent on the OTel demo env (or any Receiver-deployed customer env):

1. **Reasoning** — did the agent pick the right tools with sensible args, in sensible order?
2. **Value** — did the final synthesis answer the user's actual question?
3. **Autonomy** — did it walk NEXT_ACTIONS chains without stalling for user nudges?

Two execution modes write the same JSONL transcript shape, so judging and reporting are mode-agnostic:

- **Deterministic** (default, CI-friendly, no LLM cost): in-process simulator that seeds `initial_tool` and BFS-walks NEXT_ACTIONS hints with cycle detection.
- **Autonomous** (gated on `ANTHROPIC_API_KEY`, costs tokens): drives Anthropic Messages API tool-use loop with the same in-process tool registry.

## Quickstart

```bash
# from log10x-mcp/
npm run build                       # builds the MCP itself (eval imports build/tools/*.js)
npm install --prefix eval
cd eval && npm run build            # compiles eval/src → eval/build-eval

# run one scenario, deterministic mode, no judge
LOG10X_EVAL_ENV=demo node bin/run-scenario.mjs fixtures/cost-spike-cart-store.json

# run the full suite
LOG10X_EVAL_ENV=demo node bin/run-suite.mjs --mode deterministic --no-judge

# autonomous mode + judge (one scenario, costs tokens)
ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=demo \
  node bin/run-scenario.mjs fixtures/install-advisor-receiver.json --mode autonomous

# regression diff (CI gate)
node bin/diff-runs.mjs eval/baselines/<sha> eval/reports
```

## Anti-hallucination campaign (15 hero questions)

The campaign drives 15 sub-agent (no shared planner context) hero
questions against the live OTel demo env, scores each on 5 axes
against a pre-computed Prometheus oracle, and tracks gaps to closure.
See [CAMPAIGN.md](./CAMPAIGN.md) for the plan, the Outcome Ledger
(7 fix-rerun cycles, 4→14/15 PASS, $10 / $25 budget), and the
resume protocol.

```bash
# refresh the oracle snapshot (writes eval/oracle/expected/<ts>.json + latest.json)
LOG10X_EVAL_ENV=demo node bin/oracle-probe.mjs --snapshot

# rebuild expected_answer blocks in every fixtures/hero/<id>.json
LOG10X_EVAL_ENV=demo node bin/refresh-expected.mjs

# run all 15 hero scenarios (full Sonnet driver + judge — costs tokens)
ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=demo \
  node bin/run-campaign.mjs

# re-score saved transcripts only (no LLM cost — falsifiability check)
LOG10X_EVAL_ENV=demo node bin/run-campaign.mjs --score-only --stale --skip-refresh

# score one saved transcript against its expected_answer
node bin/score-hero-vs-expected.mjs reports/hero/<id>/<ts>/transcript.jsonl
```

### Deeper test surfaces (landed 2026-05-10)

After the campaign closed at 14/15, eight deeper test surfaces were
added to make the rubric itself defensible. See
`eval/CAMPAIGN.md`'s "Deeper harness landed 2026-05-10" section
and `eval/UNVERIFIED.md` for the full state.

```bash
# shape-coverage harness: every catalogued failure shape gets at least
# one fabrication; CI gates on the coverage_score baseline (3/16)
LOG10X_EVAL_ENV=demo node eval/bin/run-shapes.mjs --min-coverage 0.18

# mutation testing of the scorer: surfaces dead defense
LOG10X_EVAL_ENV=demo node eval/bin/mutation-test.mjs --quick

# tool-output perturbation: wraps mcp-call.mjs to mutate one response
# per scenario; tests the agent's anti-hallucination defenses
ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=demo \
  node eval/bin/run-perturbed-scenario.mjs \
    --scenario eval/fixtures/hero/cost-week-over-week.json \
    --perturbation eval/perturbations/top-patterns-fake-row.json

# parametric scenario generator: seeded, reproducible
node eval/bin/generate-scenarios.mjs --count 20 --seed 42

# multi-judge ensemble: same transcript, multiple judge models
ANTHROPIC_API_KEY=... [XAI_API_KEY=...] \
  node eval/bin/judge-ensemble.mjs --all
```

Persistent state for the campaign:

| Path | Purpose |
|---|---|
| `eval/CAMPAIGN.md` | In-repo plan + Outcome Ledger (canonical) |
| `eval/gaps/gaps.json` | Open + fixed gap records (survives compaction) |
| `eval/oracle/expected/<ts>.json` | Per-probe oracle snapshot |
| `eval/oracle/expected/latest.json` | Stable pointer to most recent snapshot |
| `eval/fixtures/hero/<id>.json` | 15 hero specs with `expected_answer` baked in |
| `eval/reports/hero/<id>/<ts>/` | Sub-agent transcripts + 5-axis verdict |
| `eval/reports/hero/CAMPAIGN-PROOF.md` | Falsifiable suite report |
| `eval/shapes/catalog.json` | 15-shape catalogue of agent-failure modes |
| `eval/shapes/<shape>/fabrications/*.json` | Hand-crafted fabrications per shape |
| `eval/shapes/COVERAGE.md` | Per-shape coverage matrix (CI-gated) |
| `eval/perturbations/<id>.json` | 10 tool-output perturbation specs |
| `eval/COUNTERFACTUAL.md` | Counterfactual injection harness design (deferred) |
| `eval/reports/hero/JUDGE-ENSEMBLE.md` | Multi-judge calibration matrix |
| `eval/audits/dead-defense-<date>.md` | Mutation-testing audit output |

## Env modes

`LOG10X_EVAL_ENV` selects credentials:

- `demo` (default): hardcoded OTel demo env (`6aa99191-…`), public gateway. Reproducible, free, but cost_drivers can't show growth (continuous replay = stable cost).
- `customer`: `~/.log10x/credentials` first, then `LOG10X_API_KEY` env var. Real customer data; expect rate limits.
- `ci`: `LOG10X_API_KEY` env only; aborts if missing. For GitHub-Actions-style runs.
- `demo-license`: `LOG10X_LICENSE_JWT` (a self-minted demo license). Queries `/api/v1/demo/*` via the MCP's `log10x_demo` backend — the caller's OWN demo tenant, last 3h. Used by the install→validate close-the-loop e2e below; the runner mints + sets the JWT for you.

## Close-the-loop install e2e (`bin/run-install-e2e.mjs`)

The full thing — what a first-time user actually does: talk to the MCP about installing on a cluster, let it guide the install, then validate the metrics. A not-signed-in user installs the engine on a real cluster with a demo license, the engine writes to the SaaS Prometheus, and the MCP reads it back via the demo-license query path. Gated on `LOG10X_E2E=1` (else dry-run: preflight + license mint, no cluster). Defaults to **minikube** (`LOG10X_E2E_PROVIDER=existing` to use the current kube-context instead).

```bash
npm run build                                  # build the MCP (the e2e imports build/lib/*)
node eval/bin/run-install-e2e.mjs --dry-run    # preflight + mint, no cluster

# Full deterministic loop (no API key needed):
LOG10X_E2E=1 node eval/bin/run-install-e2e.mjs # cull+recreate minikube → helm install log10x/reporter-10x
                                               # → poll /api/v1/demo/* → assert tenx_pipeline_up → teardown

# + the LLM↔MCP install conversation (the "what the user does" leg):
ANTHROPIC_API_KEY=… LOG10X_E2E=1 node eval/bin/run-install-e2e.mjs   # adds an autonomous wizard conversation
                                                                     # (run-scenario.mjs fixtures/install-e2e-demo-license.json)
                                                                     # before the install. --no-conversation to force off.
```

Phases: cull + **recreate** the minikube profile (fresh cluster every run — never collide with old pods/releases/data) → mint one demo license → *(conversational)* drive `discover_env → advise_install(license_source=demo)` via an autonomous LLM → `helm install` the published `log10x/reporter-10x` chart with that license + a JSON log generator → poll `/api/v1/demo/*` (in `LOG10X_EVAL_ENV=demo-license`) until `tenx_pipeline_up` appears → assert → teardown.

The wizard's recommended install, the executed install, and the validation query all use the SAME persisted demo license, so everything hits one demo tenant. The deterministic poll is always the PASS/FAIL gate, so the test is reliable whether or not the LLM leg runs. `LOG10X_E2E_KEEP=1` skips teardown for debugging.

## File layout

```
eval/
  README.md
  package.json                        @anthropic-ai/sdk + zod
  tsconfig.json                       ES2022, build-eval/
  src/
    types.ts                          Scenario (Zod) + RunReport + transcript shapes
    fixture-loader.ts                 Zod-validates fixtures; id must match filename
    env.ts                            demo/customer/ci resolver + process.env shim + {{env.envId}} interpolation
    tool-registry.ts                  invokeTool(name, args, env) — mirrors index.js dispatch (~30 tools)
    transcript-writer.ts              JSONL writer in Anthropic-shape
    transcript-parser.ts              parseTranscript() — typed copy of test-agent-scorer.mjs logic
    deterministic-runner.ts           BFS over NEXT_ACTIONS, cycle detect on tool+JSON(args)
    autonomous-runner.ts              Anthropic Messages tool-use loop using local tool registry
    scenario-validator.ts             LCS-style subsequence match + 4 ground-truth matchers
    autonomy-metrics.ts               Deterministic autonomy scoring (no LLM)
    judge.ts                          Sonnet 4.6 LLM-judge for reasoning/value/hallucination
    report-writer.ts                  Markdown report.md + verdict.json
    orchestrator.ts                   Wires runner → validators → judge → report
    gap-tracker.ts                    GapRecord type + load/append/markFixed/pickNextOpenGap
    expected-answer.ts                computeExpectedAnswer(question_id, env) — oracle round-trip
    campaign-scorer.ts                5-axis scorer + two-layer pattern match (oracle exact + Prom existence)
    hero-runner.ts                    Sub-agent driver (Sonnet via Bash → mcp-call.mjs CLI)
    hero-oracle.ts                    Pattern extraction + scoreTopNMatch + chain alignment
    prom-oracle.ts                    Direct PromQL client (independent of MCP code path)
  bin/
    run-scenario.mjs                  Single fixture, one mode
    run-suite.mjs                     Fan-out across fixtures
    judge-only.mjs                    Re-score an existing transcript
    diff-runs.mjs                     Compare report dirs; CI gate
    run-hero.mjs                      Single hero scenario via sub-agent driver
    run-campaign.mjs                  Full 15-hero campaign orchestrator (--score-only / --stale / --skip-refresh)
    refresh-expected.mjs              Rebuild expected_answer blocks against latest oracle
    score-hero-vs-expected.mjs        Compare a saved transcript against its hero spec's expected_answer
    oracle-probe.mjs                  Probe Prometheus; --snapshot writes eval/oracle/expected/<ts>.json
    mcp-call.mjs                      Per-tool CLI surface for sub-agents (no SDK dependency)
  fixtures/                           Scenario JSONs (Receiver-core)
  fixtures/hero/                      15 hero specs with expected_answer baked in
  oracle/expected/                    Per-probe oracle snapshots + latest.json pointer
  gaps/gaps.json                      Persistent gap records (survives compaction)
  reports/                            Gitignored except .gitkeep
  reports/hero/<id>/<ts>/             Sub-agent transcripts + verdicts + campaign-verdict.json
  reports/hero/CAMPAIGN-PROOF.md      Falsifiable suite report
  baselines/                          Committed regression baselines (one dir per SHA)
```

## Scenario fixture schema

```typescript
{
  id: "cost-spike-cart-store",        // must match filename
  title: "...",
  description: "...",                 // shown to the LLM-judge
  prompt: "...",                      // the user's verbatim message

  initial_tool: { tool, args, reason },  // deterministic-mode seed (no LLM)
  tool_arg_defaults?: Record<string, unknown>,  // {{env.envId}} interpolation

  expected_sequence: {
    must_include: string[],           // LCS subsequence match
    must_not_include?: string[],
    tolerance?: number,               // default 1
  },

  ground_truth: GroundTruthAssertion[],  // contains | regex | numeric_range | rank_at_least
  quality_criteria: {                    // CI thresholds
    reasoning: number,                   // 0..1
    value: number,
    autonomy: number,
    hallucination_max: number,
  },

  optimal_steps: number,              // hand-authored, drives autonomy scoring
  max_steps: number,                  // default 12
  error_policy: "stop" | "continue",  // default continue

  receiver_assertions?: {              // Receiver-specific metadata (not yet auto-validated)
    expected_mode?: "readonly" | "readwrite",
    expected_optimize?: boolean,
    must_emit_chart_field?: string[],
  },

  tags: string[],
}
```

## Pass / fail gate

`passedCriteria=true` requires:

- subsequence satisfied (every `must_include` tool ran in order, with up to `tolerance` extras between)
- every ground-truth assertion passed
- autonomy.score ≥ `quality_criteria.autonomy`
- (when judge ran) reasoning ≥ threshold, value ≥ threshold, hallucination ≤ `hallucination_max`
- outcome ≠ `unknown_tool`
- no `tool_error` if `error_policy: "stop"`

`upstream_rate_limit` flag is excluded from the gate — surfaces in the diff but doesn't fail CI (transient infra).

## Findings from the first deterministic run (2026-05-09, demo env)

The harness fired against the OTel demo env on initial baseline and surfaced three real issues that warrant Dor's review before any "all green" claim:

1. **`log10x_top_patterns` emits a buggy NEXT_ACTIONS hint.** When the top pattern resolves to `(unknown)`, the tool emits `{tool: log10x_investigate, args: {starting_point: "(unknown)"}}`. `log10x_investigate` then correctly rejects `(unknown)` as a non-pattern. The hint should either be suppressed when the row is unresolvable, or pass the templateHash instead of the human label.
2. **`log10x_cost_drivers` throws `Cannot read properties of undefined (reading 'match')` on empty args.** Reproduces from the `top_patterns` NEXT_ACTIONS hint `{tool: log10x_cost_drivers, args: {}}`. Should be a Zod validation error, not a TypeError.
3. **OTel demo env top patterns drift from `comsite/tools/mcp/otek-demo-env-map.md`.** The doc lists `cart_cartstore_ValkeyCartStore` as the #2 pattern; actual top patterns are otel-collector self-emitted logs (`opentelemetry collector contrib exporter opensearchexporter` etc.). Either the env changed or the doc is stale.

Findings 1 and 2 are MCP bugs — they break autonomous chains. Finding 3 is a demo-env state drift; fixtures may need to be re-tuned against actual top patterns.

## Anti-goals

What the harness does NOT do, on purpose:

- No web dashboard. Markdown reports + `git diff` is the regression UX.
- No scenario DSL with conditionals or loops — JSON fixtures + Zod are sufficient.
- No mocked Prometheus/Retriever endpoints. Demo env stability IS the test.
- No retry-on-rate-limit. Surface flakes; don't hide them.
- No multi-LLM judge ensemble. One judge, recalibrate quarterly.
- No "fix the test" auto-update of fixtures from green runs.

## Adding a new tool

When the MCP catalog grows (someone merges a new `executeFooBar`):

1. Add the import + dispatch entry in `src/tool-registry.ts` `TOOL_TABLE`.
2. `npm run build` — TS errors will catch any drift in the upstream `(args, env)` signature.
3. Add a fixture under `fixtures/` exercising the new chain.

## Adding a new scenario

1. Drop a JSON fixture under `fixtures/<id>.json` (id must match filename, `[a-z][a-z0-9-]*`).
2. `node bin/run-scenario.mjs fixtures/<id>.json` — Zod will reject malformed fixtures with per-field details.
3. Iterate on `must_include` / `ground_truth` until the deterministic run flags only true regressions.
4. Once passing, snapshot the run dir as a baseline:
   ```bash
   git rev-parse --short HEAD | xargs -I{} cp -r reports/<id>/<latest>/ baselines/{}/<id>/
   ```

## CI integration (planned, M2)

```yaml
- run: npm run build && npm install --prefix eval && cd eval && npm run build
- run: LOG10X_EVAL_ENV=ci LOG10X_API_KEY=${{ secrets.LOG10X_API_KEY }} \
       node eval/bin/run-suite.mjs --mode deterministic --no-judge
- run: node eval/bin/diff-runs.mjs eval/baselines/${{ env.MAIN_SHA }} eval/reports
```

PR comment trigger `/eval-autonomous` (M3) gates the full Anthropic-driven run on demand.
