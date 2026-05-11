# Counterfactual injection harness

A 2-container stack (Python generator + `log10x/edge-10x` engine)
plants synthetic events into a real env's Prometheus tenant via the
Fluentd Forward Protocol. The generator speaks msgpack directly over
the engine's Unix socket — no Fluent Bit in between (initial smoke
test revealed an incompatibility between Fluent Bit 4.2.4's forward
output and the engine's decoder; the direct-forward path bypasses it
and matches the user's original "synthetic event generator" vision
more cleanly).
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
# log10x/edge-10x is on Docker Hub — no auth needed for public pulls.
docker pull log10x/edge-10x:1.0.19
```

### 2. Start the engine pointed at the talw.gx env

```bash
cd log10x-mcp/eval/counterfactual

# Create a .env file (gitignored) with the target env credentials.
cat > .env <<EOF
TENX_API_KEY=1bb8b68f-4579-4b3c-b2fd-975f2ce9883b
TENX_ENV_ID=8209858b-30e8-452c-8cc9-e26e02d828f6
EOF

# Build the generator image
docker compose build generator

# Bring up the engine (single container)
docker compose up -d pipeline-10x
# Engine takes ~10s to initialize the unix socket and start listening.
docker compose logs --tail 20 pipeline-10x
# Look for: "Forward protocol server listening on: /tenx-sockets/tenx-reporter.sock"
```

### 3. Smoke test: plant a tiny batch and check Prometheus

```bash
# Emit 3 events through a tiny spec
cat > specs/smoke.json << 'EOF'
{
  "id": "smoke",
  "description": "Tiny smoke test",
  "target_env": "talw_gx",
  "generator_spec": {
    "template": "smoke test event ${idx}",
    "severity": "INFO",
    "service": "canary-smoke",
    "rate_per_second": 1.0,
    "duration_seconds": 3
  },
  "propagation_seconds": 60,
  "sensitive_scenarios": []
}
EOF

docker compose run --rm generator --spec /specs/smoke.json

# Wait for remote_write + Prometheus scrape (60-90s).
sleep 90

# Confirm via direct Prometheus query — Phase 1's engine produces
# `emitted_events_*` (edge tier output). The MCP tools query
# `all_events_*` which only Phase-2 (full cloud stack) populates.
curl -s -G "https://prometheus.log10x.com/api/v1/query" \
  --data-urlencode 'query={__name__="emitted_events_summaryBytes_total",message_pattern=~"smoke.*"}' \
  -H "X-10X-Auth: $TENX_API_KEY/$TENX_ENV_ID" | python3 -m json.tool
```

Expected: a `result` array with the planted message pattern and a positive byte count.

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
    emit.py              # Python event emitter (msgpack forward
                         # protocol direct to engine socket)
    Dockerfile           # python:3.11-slim + msgpack
  docker-compose.yml     # 2 services + 1 shared volume
  specs/                 # 5 day-1 counterfactual specs
  runs/                  # per-run artifacts (snapshots + verdicts)
  COUNTERFACTUAL-PROOF.md  # written by run-counterfactual-suite
  README.md              # this file
  .env                   # gitignored; TENX_API_KEY + TENX_ENV_ID
```
