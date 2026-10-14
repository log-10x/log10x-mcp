#!/usr/bin/env bash
# Runs the Receiver args a Datadog fleet-default plan writes on a real engine and
# checks each severity floor from what the Receiver returns.
#
#   npm run build            # once, from the repo root
#   ENGINE_IMAGE=log10x/edge-10x:1.1.141 scripts/check-fleet-default-floors/run.sh
#
# Before 1.1.141 is published, the same check runs on 1.1.140 with the config
# and modules trees from main, which carry rateReceiverDefaultAction:
#   ENGINE_IMAGE=log10x/edge-10x:1.1.140 CONFIG_DIR=<config checkout> \
#   MODULES_DIR=<modules checkout> scripts/check-fleet-default-floors/run.sh
#
# Settings: ACTION (offload | tier_down, both by default), CAP (bytes per
# window per node, default 1, so only the first 5 of each statement pass before
# the floor applies and every count is exact), N (lines per statement, default 1000),
# WORK (scratch directory). Local Docker only; nothing leaves the machine.
# The plan's k8s policy pull is replaced by two mounted seed files, the only
# difference from the install: there is no cluster here.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE_IMAGE="${ENGINE_IMAGE:-log10x/edge-10x:1.1.141}"
FB_IMAGE="${FB_IMAGE:-fluent/fluent-bit:4.2}"
CAP="${CAP:-1}"
N="${N:-1000}"
ACTIONS="${ACTION:-offload tier_down}"
WORK="${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/fdcheck.XXXXXX")}"
NET=fdcheck-net

cleanup() { docker rm -f fdcheck-tenx fdcheck-fb >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT

status=0
for action in $ACTIONS; do
  run="$WORK/$action"
  rm -rf "$run" && mkdir -p "$run/data" "$run/lookups"
  printf 'container,cap\ntenx-seed,1::check seed\n' > "$run/lookups/caps.csv"
  printf 'container,action\ntenx-seed,pass::check seed\n' > "$run/lookups/actions.csv"
  node "$HERE/gen.mjs" "$run/measure.jsonl" "$N" >/dev/null
  # One warm-up line first: the regulator passes every event of a container it
  # has not yet seen, and parallel workers can see the same burst as first, so
  # the measured lines start once the container is known.
  printf '{"log":"DEBUG check warm-up line"}\n' > "$run/data/in.jsonl"
  plan="$(node "$HERE/plan-args.mjs" "$action" "$CAP")"
  echo "$plan" > "$run/plan.json"
  floor="$(node -e 'const p=JSON.parse(process.argv[1]);const a=p.args;for(let i=0;i<a.length-1;i++)if(a[i]==="rateReceiverSeverityFloors"&&a[i+1].startsWith("ERROR="))console.log(a[i+1].slice(6))' "$plan")"
  mapfile -t ARGS < <(node -e 'for (const a of JSON.parse(process.argv[1]).args) console.log(a)' "$plan")
  ENVS=()
  while IFS= read -r kv; do ENVS+=(-e "$kv"); done < <(node -e 'for (const [k,v] of JSON.parse(process.argv[1]).env) if (!/^(K8S_|CAP_LOOKUP_FILE|ACTION_LOOKUP_FILE|CONFIG_GENERATION_FILE)/.test(k)) console.log(k+"="+v)' "$plan")
  MOUNTS=(-v "$run/lookups:/etc/tenx/lookups:ro")
  [ -n "${CONFIG_DIR:-}" ] && MOUNTS+=(-v "$CONFIG_DIR:/etc/tenx/config:ro")
  [ -n "${MODULES_DIR:-}" ] && MOUNTS+=(-v "$MODULES_DIR:/opt/tenx-check/modules:ro" -e TENX_MODULES=/opt/tenx-check/modules)

  cleanup
  docker network create "$NET" >/dev/null
  cmd=(docker run -d --name fdcheck-tenx --network "$NET"
    -e TENX_AIRGAPPED=true -e TENX_FLUENTBIT_OUTPUT_HOST=fdcheck-fb
    -e CAP_LOOKUP_FILE=/etc/tenx/lookups/caps.csv -e ACTION_LOOKUP_FILE=/etc/tenx/lookups/actions.csv
    "${ENVS[@]}" "${MOUNTS[@]}" "$ENGINE_IMAGE" "${ARGS[@]}")
  echo "== $action: ${cmd[*]}" | tee "$run/command.txt"
  "${cmd[@]}" >/dev/null
  for i in $(seq 1 60); do docker logs fdcheck-tenx 2>&1 | grep -q "Forward protocol server listening" && break; sleep 2; done
  docker run -d --name fdcheck-fb --network "$NET" -v "$HERE/fluent-bit.conf:/fluent-bit/etc/check.conf:ro" \
    -v "$run/data:/data" "$FB_IMAGE" /fluent-bit/bin/fluent-bit -c /fluent-bit/etc/check.conf >/dev/null
  for i in $(seq 1 60); do grep -qs 'warm-up' "$run/data/pass.jsonl" "$run/data/moved.jsonl" && break; sleep 2; done
  sleep 2
  cat "$run/measure.jsonl" >> "$run/data/in.jsonl"
  total=$((N * 4 + 1)); prev=-1
  for i in $(seq 1 90); do
    got=$(( $(cat "$run/data/pass.jsonl" "$run/data/moved.jsonl" 2>/dev/null | grep -c '"log"' || true) ))
    [ "$got" -ge "$total" ] && break
    [ "$got" -eq "$prev" ] && [ "$i" -gt 30 ] && break
    prev=$got; sleep 2
  done
  docker logs fdcheck-tenx > "$run/engine.log" 2>&1 || true
  docker logs fdcheck-fb > "$run/fluent-bit.log" 2>&1 || true
  node "$HERE/count.mjs" "$run/data" "$N" "$CAP" "$action" "$floor" | tee "$run/counts.txt" || status=1
done
echo "work dir: $WORK"
exit $status
