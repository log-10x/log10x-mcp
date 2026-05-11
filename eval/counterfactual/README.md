# Counterfactual injection harness

A small 3-container stack (generator + Fluent Bit + `log10x/edge-10x`
engine) plants synthetic events into a real env's Prometheus tenant.
The orchestrator snapshots oracle state before/after, runs the
affected hero scenario, then scores on three layers:

| Layer | Question | How checked |
|---|---|---|
| Metric | Did Prometheus reflect the planted change? | Pre/post oracle snapshot diff |
| Agent | Did the agent take the expected investigative action? | `bashCommands` includes `must_call_tool`; `finalText` includes `must_mention_correlation` |
| Synthesis | Does the agent's final answer match the planted reality? | Existing campaign-scorer's drift / pattern_match / classifier axes |

This is the **first harness in the suite that exercises agent + scorer + env + MCP end-to-end with a known signal**.

## Quickstart

### 1. One-time docker setup

```bash
docker login ghcr.io       # if not already; not strictly needed since log10x/edge-10x is on docker.io
```

### 2. Start the engine + forwarder stack pointed at the talw.gx env

```bash
cd log10x-mcp/eval/counterfactual

export TENX_API_KEY=1bb8b68f-4579-4b3c-b2fd-975f2ce9883b
export TENX_ENV_ID=8209858b-30e8-452c-8cc9-e26e02d828f6

docker compose up -d pipeline-10x fluent-bit
# pipeline-10x takes ~10s to initialize the unix socket.
docker compose logs --tail 20 pipeline-10x
docker compose logs --tail 20 fluent-bit
```

### 3. Smoke test: plant one canary event and check Prometheus

```bash
# Emit a single event into the shared volume (no docker compose run yet).
docker compose exec -u 0 fluent-bit sh -c '
  echo "{\"timestamp\":\"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'\",\"severity\":\"INFO\",\"service\":\"canary-smoke\",\"message\":\"counterfactual stack smoke test\",\"synthetic_canary\":\"true\",\"run_id\":\"smoke\"}" \
    >> /var/log/synthetic/events.log
'

# Wait for Reporter aggregation (Prometheus scrape ~30-60s).
sleep 90

# Confirm via the MCP that the canary service appears in services list.
LOG10X_EVAL_ENV=customer LOG10X_API_KEY=$TENX_API_KEY \
  node ../bin/mcp-call.mjs --tool log10x_services --args '{"timeRange":"15m"}'
```

Expected: `canary-smoke` appears with a small byte count.

### 4. Run one counterfactual spec end-to-end

```bash
ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=customer LOG10X_API_KEY=$TENX_API_KEY \
  node ../bin/run-counterfactual-scenario.mjs \
    --spec specs/inject-critical-burst.json
```

The runner:
1. snapshots Prometheus state via `log10x_services`, `log10x_top_patterns`, severity split
2. spawns the generator (`docker compose run --rm generator --spec /specs/inject-critical-burst.json`)
3. waits 90s for propagation
4. snapshots state again
5. runs the affected hero scenario (`error-critical-events`) via a sub-agent
6. assembles a 3-layer verdict
7. writes everything under `eval/counterfactual/runs/<spec_id>-<ts>/`

### 5. Run the full suite

```bash
ANTHROPIC_API_KEY=... LOG10X_EVAL_ENV=customer LOG10X_API_KEY=$TENX_API_KEY \
  node ../bin/run-counterfactual-suite.mjs
# Output: eval/counterfactual/COUNTERFACTUAL-PROOF.md
```

### 6. Tear down

```bash
docker compose down
```

## Cleanup / isolation

Every planted event carries:
- `synthetic_canary: "true"` filterable label
- `run_id: "<uuid>"` per-run filter
- Service name prefix `canary-`
- Pattern names contain `canary_` or `synthetic_` token

Events persist for the env's retention window. For Phase 1 (talw.gx)
that's the user's own data; cost is negligible.

The verdict layer marks the transcripts it produces with a
`.counterfactual` file so the existing campaign re-score path
skips them (same idiom as `.perturbed`).

## Phase 2 — graduating to the OTel demo env

Repoint `TENX_API_KEY` + `TENX_ENV_ID` at the OTel demo env and re-run.
Two implementation paths documented in
`.claude/plans/dor-has-done-a-recursive-pnueli.md` —
(a) plant from outside via our local engine instance, or
(b) plant inside the demo cluster (needs k8s access).

Phase 2 specs reference real demo services (`cart`, `checkout`,
`shipping`) and are filed under `eval/counterfactual/specs/phase2-*.json`.

## Files

```
counterfactual/
  generator/
    emit.py              # Python NDJSON event emitter (stdlib only)
    Dockerfile           # python:3.11-slim
  forwarder/
    fluent-bit.conf      # tails synthetic-logs vol → unix socket
    parsers.conf         # JSON parser for synthetic events
  docker-compose.yml     # 3 services + 2 shared volumes
  specs/                 # 5 day-1 counterfactual specs
  runs/                  # per-run artifacts (snapshots + verdicts)
  COUNTERFACTUAL-PROOF.md  # written by run-counterfactual-suite
  README.md              # this file
```
