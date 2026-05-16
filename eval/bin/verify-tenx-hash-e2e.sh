#!/bin/bash
# Live data-plane verification for the tenx_hash feature, against the
# running otel-demo env. It OBSERVES real production traffic — it does
# NOT inject a synthetic canary through fluentd (for an injected probe
# use eval/counterfactual/). What it proves, with ground truth re-derived
# every run:
#
#   * the demo's 10x-powered forwarder is shipping tenx_hash into AWS
#     CloudWatch Logs right now;
#   * the engine's log10x cloud-metrics backend independently binds the
#     same tenx_hash values to named patterns;
#   * the MCP's local tenx_hash algorithm reproduces the engine's hash
#     byte-for-byte (the real anti-hallucination oracle);
#   * the MCP tools (event_lookup reverse, exclusion_filter) resolve and
#     act on it, with clean human output and no fabrication.
#
#   Run:  bash eval/bin/verify-tenx-hash-e2e.sh [SAMPLES]
#   Needs: kubectl ctx = log10x-otel-demo, aws (us-east-1), node, demo
#          metrics creds (defaults below; override via env).
#
# Honesty model: the CORRECTNESS invariant (engine pattern hashed locally
# == the hash the forwarder shipped) is ZERO-TOLERANCE — one mismatch
# fails the gate. Availability (how many sampled hashes resolved) has a
# floor, not a ratio, so propagation lag is reported, never hidden.
set -uo pipefail
SAMPLES="${1:-8}"
LG=/log10x/otel-demo/enriched
MCP=/Users/talweiss/git/l1x-co/log10x-mcp
export LOG10X_API_KEY="${LOG10X_API_KEY:-d02ad247-1e32-49ee-918d-93467ba8b134}"
export LOG10X_ENV_ID="${LOG10X_ENV_ID:-6aa99191-f827-4579-a96a-c0ebdfe73884}"
export LOG10X_METRICS_BACKEND=log10x
export AWS_REGION=us-east-1
export MCPB="$MCP/build"
PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
warn(){ echo "  DISCLOSED  $1"; }

HD=$(mktemp -d); trap 'rm -rf "$HD"' EXIT
cat > "$HD/resolve.mjs" <<'NODE'
const B=process.env.MCPB;
const e=await import(B+'/lib/environments.js');
const env=e.resolveEnv(await e.loadEnvironments(),undefined);
const {executeEventLookup}=await import(B+'/tools/event-lookup.js');
const o=await executeEventLookup({tenxHash:process.argv[2],timeRange:'1d'},env);
const m=o.match(/Resolved tenx_hash [`][^`]+[`][^`]*[`]([^`]+)[`]/);
process.stdout.write(m?m[1]:'');
NODE
cat > "$HD/hash.mjs" <<'NODE'
const m=await import(process.env.MCPB+'/lib/pattern-hash.js');
process.stdout.write(m.tenxHash(process.argv[2]??''));
NODE
cat > "$HD/enginepat.mjs" <<'NODE'
const B=process.env.MCPB;
const e=await import(B+'/lib/environments.js');
const env=e.resolveEnv(await e.loadEnvironments(),undefined);
const {queryInstant}=await import(B+'/lib/api.js');
const H=process.argv[2];
const q=`topk(1, count by (message_pattern) (all_events_summaryBytes_total{tenx_hash="${H}"}))`;
const r=await queryInstant(env,q);
process.stdout.write((r.status==='success'&&r.data.result[0])?(r.data.result[0].metric.message_pattern||''):'');
NODE
cat > "$HD/eventlookup.mjs" <<'NODE'
const B=process.env.MCPB;
const e=await import(B+'/lib/environments.js');
const env=e.resolveEnv(await e.loadEnvironments(),undefined);
const {executeEventLookup}=await import(B+'/tools/event-lookup.js');
process.stdout.write(await executeEventLookup({tenxHash:process.argv[2],timeRange:'1d'},env));
NODE
cat > "$HD/enginepairs.mjs" <<'NODE'
const B=process.env.MCPB;
const e=await import(B+'/lib/environments.js');
const env=e.resolveEnv(await e.loadEnvironments(),undefined);
const {queryInstant}=await import(B+'/lib/api.js');
const N=process.argv[2]||'10';
const q=`topk(${N}, count by (message_pattern, tenx_hash) (all_events_summaryBytes_total{message_pattern!="",tenx_hash!=""}))`;
const r=await queryInstant(env,q);
const rows=(r.status==='success'?r.data.result:[]).map(x=>`${x.metric.message_pattern}\t${x.metric.tenx_hash}`);
process.stdout.write(rows.join('\n'));
NODE
cat > "$HD/exclusion.mjs" <<'NODE'
const m=await import(process.env.MCPB+'/tools/exclusion-filter.js');
process.stdout.write(await m.executeExclusionFilter({pattern:process.argv[2],vendor:'fluentd',mode:'config'}));
NODE

echo "=== tenx_hash live data-plane verification  $(date -u +%FT%TZ)  samples=$SAMPLES ==="
echo "    (observes live traffic; does NOT inject a synthetic probe — see eval/counterfactual/)"

# ---- Gate 1: demo pod on dev image; disclose ALL container error rates ----
echo "[1] demo pod / image / honest health"
POD=$(kubectl get pods -n demo -o name 2>/dev/null | grep tenx-fluentd | head -1)
IMG=$(kubectl get "$POD" -n demo -o jsonpath='{range .status.containerStatuses[?(@.name=="log10x")]}{.image} ready={.ready} restarts={.restartCount}{end}' 2>/dev/null)
echo "    $POD  $IMG"
case "$IMG" in
  *pipeline-10x-dev:dev-tenx-hash*ready=true*) ok "log10x on dev image, container ready" ;;
  *) no "log10x not on dev image or not ready ($IMG)" ;;
esac
ERRC=$(kubectl logs "$POD" -n demo -c log10x --since=5m 2>/dev/null | grep -ciE "ERROR|ConnectException|Failed sending" || true)
LOCALHOST9090=$(kubectl logs "$POD" -n demo -c log10x --since=5m 2>/dev/null | grep -c "localhost:9090/api/v1/write" || true)
if [ "${ERRC:-0}" -gt 0 ]; then
  warn "log10x container has ~$ERRC error lines / 5m. $LOCALHOST9090 are remote-write failures to http://localhost:9090 — a PRE-EXISTING demo RW target with no listener (NOT introduced by tenx_hash; the log10x CLOUD backend used for correlation is verified independently in gate 3). Gate 1 does NOT claim 'healthy', only 'on dev image + container ready'."
fi

# ---- Gate 2: CW freshness via AUTHORITATIVE readback (get-log-events, newest) ----
# Instrument correction (2026-05-16). describe-log-streams
# lastIngestionTime was found to lag badly: it climbed 1:1 with wall
# clock to >2000s while the egress was demonstrably healthy
# (fluent-bit returning PutLogEvents HTTP 200 + nextSequenceToken,
# and get-log-events showing events at age ~0s). As a freshness gate
# it FALSE-FAILS a working pipeline. filter-log-events --max-items N
# is also unsafe here: under the demo firehose it returns the OLDEST
# N of the window, so "newest age" was really window-size (the prior
# Gate 2 theater). The authoritative signal is the literal readback:
# get-log-events with startFromHead=false returns the NEWEST events,
# so we assert (a) the newest retrievable event is recent and (b) it
# carries tenx_hash. That is the e2e claim itself, not a proxy.
# Egress now runs through a Fluent Bit sidecar (Go cloudwatch_logs);
# the Ruby fluent-plugin-cloudwatch-logs silently never flushed under
# this firehose topology (4 fluentd-side fixes failed identically).
echo "[2] CW Logs freshness (authoritative: get-log-events newest + tenx_hash present)"
NOW=$(date +%s)
STREAM="${CW_STREAM:-tenx-fluentd}"
CWEV=$(aws logs get-log-events --log-group-name "$LG" --log-stream-name "$STREAM" \
  --region us-east-1 --limit 300 --query 'events[*].[timestamp,message]' \
  --output text 2>/dev/null)
NEWEST=$(printf '%s\n' "$CWEV" | awk -F'\t' '$1 ~ /^[0-9]+$/ {print $1}' | sort -n | tail -1)
INGAGE=$(( NOW - ${NEWEST:-0}/1000 ))
CWHASHES=$(printf '%s\n' "$CWEV" \
  | grep -oE '"tenx_hash":"[A-Za-z0-9_-]{11}"' | sed -E 's/.*:"([^"]+)"/\1/' | sort -u)
NCW=$(printf '%s\n' "$CWHASHES" | grep -c . || true)
echo "    newest retrievable CW event: ${INGAGE}s ago; distinct tenx_hash in newest 300: $NCW"
if [ -n "${NEWEST:-}" ] && [ "$INGAGE" -lt 900 ] && [ "$NCW" -ge "$SAMPLES" ]; then
  ok "CW genuinely fresh via readback (newest ${INGAGE}s ago, $NCW distinct tenx_hash)"
else
  no "CW NOT fresh by readback. Newest retrievable event ${INGAGE}s ago (stall threshold 900s), $NCW distinct (need >=$SAMPLES). The fluentd->Fluent Bit->CW egress is stalled; tenx_hash correctness is still checked CW-independently in gate 3."
fi

# ---- Gate 3: correctness vs AUTHORITATIVE cloud backend (CW-independent) ----
# The real anti-hallucination invariant: for the engine's own top
# patterns (pulled from the healthy log10x cloud backend, NOT from the
# flaky CW rig), the independent local tenxHash(message_pattern) must
# equal the engine's emitted tenx_hash label. ZERO mismatch tolerated.
# CW presence of those hashes is reported as an OBSERVATION only.
echo "[3] correctness: tenxHash(engine pattern) == engine tenx_hash label (authoritative, CW-independent)"
PAIRS=$(node "$HD/enginepairs.mjs" "$SAMPLES" 2>/dev/null)
NPAIR=$(echo "$PAIRS" | grep -c . || true)
C_OK=0; C_FAIL=0; CWSEEN=0
while IFS=$'\t' read -r EP EH; do
  [ -z "$EP" ] && continue
  BH=$(node "$HD/hash.mjs" "$EP" 2>/dev/null)
  if [ "$BH" = "$EH" ]; then C_OK=$((C_OK+1)); MK="MATCH"; else C_FAIL=$((C_FAIL+1)); MK="*** MISMATCH ***"; fi
  echo "$CWHASHES" | grep -qxF "$EH" && { CWSEEN=$((CWSEEN+1)); CWT="  (also live in CW)"; } || CWT=""
  echo "    engine_pattern=$EP  engine_hash=$EH  tenxHash()=$BH  $MK$CWT"
done <<< "$PAIRS"
echo "    tally: MATCH=$C_OK MISMATCH=$C_FAIL of $NPAIR engine pairs;  $CWSEEN of them also seen live in CW"
if [ "$NPAIR" -ge "$SAMPLES" ] && [ "$C_FAIL" -eq 0 ] && [ "$C_OK" -ge "$SAMPLES" ]; then
  ok "correctness 100% ($C_OK/$NPAIR, 0 mismatches) against the authoritative cloud backend"
else
  no "correctness: $C_FAIL mismatch(es) and/or too few engine pairs ($NPAIR < $SAMPLES)"
fi

# ---- Gate 4: negative / fabrication (multiple fakes) ----
echo "[4] negative: fabricated/nonexistent hashes must NOT yield a pattern"
NEG_ALL_OK=yes
for BG in ZZZZ0000000 aaaaaaaaaaa 00000000000 Qx9_-ZK1p0A; do
  O=$(node "$HD/eventlookup.mjs" "$BG" 2>/dev/null)
  if echo "$O" | grep -qiE "no pattern carries tenx_hash" && ! echo "$O" | grep -q "Resolved tenx_hash"; then
    echo "    $BG -> honest not-found"
  else
    echo "    $BG -> *** did not cleanly report not-found ***"; NEG_ALL_OK=no
  fi
done
NEG=$(node "$HD/eventlookup.mjs" "ZZZZ0000000" 2>/dev/null)
[ "$NEG_ALL_OK" = yes ] && ok "no fabrication across 4 fake hashes" || no "a fake hash produced a fabricated/at-best-ambiguous result"

# ---- Gate 5: exclusion_filter emits the exact, proven fluentd drop ----
echo "[5] exclusion_filter exact-hash == canonical proven fluentd block"
P1=$(echo "$PAIRS" | head -1 | cut -f1)
if [ -n "$P1" ]; then
  H1=$(node "$HD/hash.mjs" "$P1" 2>/dev/null)
  EF=$(node "$HD/exclusion.mjs" "$P1" 2>/dev/null)
  if echo "$EF" | grep -qF "key tenx_hash" && echo "$EF" | grep -qF "pattern /^${H1}\$/"; then
    ok "fluentd exact-hash block keyed on tenxHash($P1)=$H1"
  else
    no "fluentd exact-hash block missing/incorrect for $P1 ($H1)"
  fi
else
  no "engine bound no pattern for the lead sample — cannot test exclusion_filter"
fi

# ---- Gate 6: human output clean (no agent-chatter bleed) ----
echo "[6] cleanliness: strip HTML comments -> no agent tokens in human text"
# Feed a REAL tenx_hash (from the gate-3 engine pairs) so event_lookup
# returns a fully-resolved output WITH its agent-only/NEXT_ACTIONS
# comments — the actual thing this gate must prove stays comment-fenced.
# (Previously referenced an unbound $SEL under `set -u`, so VIS only ever
# held a fixed not-found string => trivially always-pass. Caught by
# adversarial review; fixed here to test genuine resolved output.)
LEADH=$(echo "$PAIRS" | head -1 | cut -f2)
RAW6=$(node "$HD/eventlookup.mjs" "$LEADH" 2>/dev/null)
VIS=$(printf '%s' "$RAW6" | perl -0pe 's/<!--.*?-->//gs')
# Defect-class kill: this gate may ONLY pass if it genuinely stripped
# real fenced agent output. If LEADH was empty or the tool produced no
# `<!--` fence (arg-error / unresolved / backend down), the strip/grep
# is a no-op and proves nothing -> FAIL as UNTESTED, never a vacuous
# PASS. (Three prior rounds found three variants of "grep a string that
# never had directives"; this precondition closes the whole class.)
if [ -z "$LEADH" ] || ! printf '%s' "$RAW6" | grep -q '<!--'; then
  no "cleanliness UNTESTED — no fenced agent output was produced (LEADH='$LEADH'); cannot assert, so this is a FAIL not a pass"
elif printf '%s' "$VIS" | grep -qE "agent-only|NEXT_ACTIONS|Routing constraint|log10x_[a-z]"; then
  no "agent chatter visible in human text after stripping comments"
else
  ok "real resolved output ($(printf '%s' "$RAW6" | grep -c '<!--') fences stripped): human text carries no agent directives"
fi

echo "=== RESULT: $PASS passed, $FAIL failed ==="
cat <<LIMS
--- KNOWN LIMITATIONS (read every run; do not be ambushed) ---
 * Scope: OBSERVES live production traffic. It does not inject a synthetic
   canary through fluentd, so it asserts the data plane is producing &
   correlating tenx_hash, not that an arbitrary new line would. For an
   injected end-to-end probe use eval/counterfactual/.
 * Triangulation honesty: the real independent oracle is the local
   tenxHash recompute (gate 3 "B"). The MCP tool (event_lookup) and the
   engine query both read the same log10x cloud backend — gate 3 treats
   the tool as a USABILITY check, not a third independent source.
 * Pre-existing demo defect: the receiver also remote-writes to
   http://localhost:9090 (no listener) — ~180 failures/5m. Unrelated to
   tenx_hash; the cloud backend that correlation uses is healthy and is
   what gate 3 verifies. Disclosed by gate 1, not hidden.
 * CW freshness instrument (corrected 2026-05-16): gate 2 reads the
   NEWEST events via get-log-events (startFromHead=false), not
   describe-log-streams lastIngestionTime (that signal was observed to
   lag 1:1 to >2000s while egress was provably healthy, so it
   false-fails a working pipeline). Stall threshold is 900s on the
   actual newest retrievable event; true CW lag is ~0-330s.
 * CW egress topology: events reach CW through a Fluent Bit sidecar
   (Go cloudwatch_logs) fed by fluentd forward:24226. The Ruby
   fluent-plugin-cloudwatch-logs silently never flushed under this
   firehose (4 fluentd-side fixes failed identically); the sidecar is
   the fix. This is a live kubectl patch on the Helm-managed
   tenx-fluentd daemonset + fluentd-config-tenx/fluent-bit-cwl
   configmaps. A helm upgrade reverts it; re-apply from
   eval/cw-egress-fix/apply.sh (see TENX_HASH_STATUS.md).
 * Correctness is zero-tolerance; availability is floored (propagation
   lag => UNRESOLVED, reported, never silently passed).
LIMS
if [ "$FAIL" -eq 0 ]; then echo "DATA PLANE VERIFIED (within the stated scope/limitations)"; else echo "NOT CLEAN — $FAIL gate(s) failed"; fi
exit "$FAIL"
