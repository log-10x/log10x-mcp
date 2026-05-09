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

## Env modes

`LOG10X_EVAL_ENV` selects credentials:

- `demo` (default): hardcoded OTel demo env (`6aa99191-…`), public gateway. Reproducible, free, but cost_drivers can't show growth (continuous replay = stable cost).
- `customer`: `~/.log10x/credentials` first, then `LOG10X_API_KEY` env var. Real customer data; expect rate limits.
- `ci`: `LOG10X_API_KEY` env only; aborts if missing. For GitHub-Actions-style runs.

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
  bin/
    run-scenario.mjs                  Single fixture, one mode
    run-suite.mjs                     Fan-out across fixtures
    judge-only.mjs                    Re-score an existing transcript
    diff-runs.mjs                     Compare report dirs; CI gate
  fixtures/                           Scenario JSONs (5 Receiver-core to start)
  reports/                            Gitignored except .gitkeep
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
