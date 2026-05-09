# Autonomous hero-scenario plan (compaction-survivable)

This file is the persistent state of a multi-stage test plan. Read it
on every session start. Each stage's "done marker" is a file at a
known path. Resume from the first stage whose done marker is missing.

## Why this plan exists

Earlier eval work validated three test surfaces (deterministic chain
walker, oracle cross-checks, autonomous mode + judge). All three are
**code-driven** — they validate the harness's own tool dispatch,
oracle queries, and judge calls. None of them simulate a real user
asking a real question and watching a real LLM-driven agent answer
it.

This plan adds a fourth surface: **sub-agent-as-user**. A Claude
sub-agent (no shared context with the planner) gets a hero question
plus Bash access to a per-tool MCP CLI wrapper. The sub-agent
investigates the live demo env via the actual MCP catalog, writes a
synthesis, and we score it independently against the Prometheus
oracle and via Sonnet 4.6 judging.

## The three measurement axes (per sub-agent run)

1. **Hallucination** — drift score from oracle. Every numeric claim
   in the sub-agent's synthesis must round-trip to a PromQL result on
   the live env. Unsupported numbers count as drift.
2. **Value delivered** — does the synthesis answer the user's actual
   question? Judged by Sonnet 4.6 against the prompt with the
   rubric "would an SRE actually act on this?"
3. **Value received** — did the MCP give the agent useful data? If
   the chain hit `(empty)` rows, "no patterns resolved", or stub
   responses, we capture it as an MCP-side failure regardless of how
   the agent handled it.

## Anti-drift mechanisms

- Sub-agents have no shared context with the planner. Their behavior
  exposes any holes the planner couldn't see.
- The Prometheus oracle (`eval/src/prom-oracle.ts`) talks to the
  demo env's gateway over a separate HTTP path. A bug in the oracle
  would have to coincidentally cover for a bug in the MCP for an
  agreement check to lie — independent failure modes.
- GitHub PRs are objective: `gh pr view <number>` returns or 404s.
  No interpretive latitude.
- Every run produces committed artifacts under
  `eval/reports/hero/<scenario>/<ts>/`. Anyone (including a
  post-compaction planner) can read them and reconstruct.

## Hero scenarios

| ID | User prompt | Done marker |
|----|-------------|-------------|
| `hero-cost-breakdown` | "Our log bill jumped this week. What's driving it and what's safest to mute?" | `eval/reports/hero/hero-cost-breakdown/SUMMARY.md` |
| `hero-investigation` | "We're getting alerts for failed-to-upload-metrics errors. What is happening and what's the impact?" | `eval/reports/hero/hero-investigation/SUMMARY.md` |
| `hero-improvement` | "We just deployed Receiver. What 3 changes would cut our log spend the most over the next month?" | `eval/reports/hero/hero-improvement/SUMMARY.md` |
| `hero-pr-compact` | "Generate the gh PR command to enable compact mode on our top patterns and run it." | `eval/reports/hero/hero-pr-compact/SUMMARY.md` |

## Stages

Each stage's done marker is at `eval/state/<stage>.done`. Stages run
in order; later stages depend on artifacts produced by earlier stages.

### Stage 1 — Per-tool CLI wrapper

Build `eval/bin/mcp-call.mjs` so a sub-agent can invoke any MCP tool
by name from Bash:

    LOG10X_EVAL_ENV=demo node eval/bin/mcp-call.mjs \
      --tool log10x_top_patterns --args '{"timeRange":"1d","limit":5}'

Done marker: `eval/state/stage1-mcp-call-cli.done` (created by Stage 1
exit).

### Stage 2 — Hero-runner driver

Build `eval/bin/run-hero.mjs` that:
1. Reads a hero spec from `eval/fixtures/hero/<id>.json`
2. Spawns a Claude sub-agent (via Anthropic SDK, NOT the harness's
   in-process autonomous-runner) with the hero question and a
   targeted system prompt that says "use Bash to call the MCP via
   `node eval/bin/mcp-call.mjs`"
3. Captures the sub-agent's tool calls, Bash invocations, and final
   synthesis to `eval/reports/hero/<id>/<ts>/transcript.jsonl`
4. Runs oracle validation (Stage 3) inline
5. Writes `SUMMARY.md` with all three axes scored

Done marker: `eval/state/stage2-hero-runner.done`.

### Stage 3 — Oracle validation pass

Build `eval/src/hero-oracle.ts`:
1. Parses the sub-agent's final synthesis text
2. Extracts every numeric claim (`$X.XX/day`, `N MB`, `N events`,
   `+N%`, `N patterns`)
3. Extracts every pattern name (snake_case identifiers)
4. For each claim, queries Prometheus directly to check if a
   matching value exists in the metrics universe
5. Returns a drift report: passed / failed claims and the gap

Done marker: `eval/state/stage3-hero-oracle.done`.

### Stage 4 — Run all four hero scenarios

For each hero in the table above, run the hero-runner. Token budget:
~$2 per hero (Sonnet 4.6 driving, Sonnet 4.6 judging, ~30 calls each).
Total: ~$8.

Done marker: each hero's `SUMMARY.md` exists with `status: complete`.

### Stage 5 — GitHub PR end-to-end

For `hero-pr-compact` only: the hero-runner observes the sub-agent
emit a `gh pr create` command via `log10x_advise_compact`. The
runner extracts the command, executes it against a sandbox repo
(`<owner>/log10x-mcp-eval-sandbox` — to be created), then verifies
the PR exists via `gh pr view <number>`. The PR's URL goes into
the SUMMARY.md.

Done marker: `eval/state/stage5-pr-e2e.done` exists AND contains a
real GitHub PR URL.

### Stage 6 — Aggregate report

Roll up all four hero scenarios into
`eval/reports/hero/SUITE-SUMMARY.md` with:
- Per-scenario hallucination / value-delivered / value-received
  scores
- Findings (MCP-side bugs, agent-behavior surprises)
- Token cost
- PR URL from Stage 5

Done marker: `eval/reports/hero/SUITE-SUMMARY.md` exists.

## Resume protocol after compaction

1. Read this file (`AUTONOMOUS_HERO_PLAN.md`).
2. List `eval/state/*.done` markers.
3. Find the lowest-numbered stage whose marker is missing.
4. Resume from that stage's instructions above.
5. Each stage's source files (paths listed above) are
   self-contained — the planner doesn't need to remember
   implementation details, just the contract.

## Invariants the planner must NOT violate

- Never fake a done marker. The marker proves the artifact exists,
  not that the planner intends to.
- Never edit a sub-agent's output. The transcript is read-only after
  capture; oracle validation runs against the original.
- Never use Sonnet 4.6 to score itself — judging happens with a
  separate model invocation that doesn't see the sub-agent's
  intermediate reasoning, only its final synthesis.
- If a sub-agent run hits a real MCP bug, fix the bug, re-run the
  scenario, and capture both the broken and fixed runs in the
  scenario's report directory.

## Scope creep guard

This plan does NOT include:
- Multi-tenant testing (one env, demo only)
- Customer envs (`LOG10X_EVAL_ENV=customer`)
- Long-window scenarios (>30d windows)
- Adversarial prompts (red-team scenarios)

If the user asks for any of these, write a separate plan file. Do
not bolt them onto this one.
