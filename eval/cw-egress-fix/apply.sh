#!/bin/bash
# Re-apply the CW egress fix to the demo's tenx-fluentd daemonset.
#
# WHY THIS EXISTS
# ---------------
# The demo forwarder ships 10x-enriched events (carrying tenx_hash) to
# AWS CloudWatch Logs. The fluentd image's Ruby
# fluent-plugin-cloudwatch-logs SILENTLY never flushed under this
# pod/firehose topology: the buffer filled, the chunk left disk,
# CloudWatch stayed starved, and the plugin emitted ZERO log lines even
# at @log_level info. Four fluentd-side fixes were tried and all failed
# with the identical signature (plain restart; bounded-retry + capped
# memory buffer; finite-retry + file buffer; cloudwatch_logs as the
# sole top-level @OUTPUT match). The AWS path itself was proven good
# (direct PutLogEvents with the pod IRSA role succeeded).
#
# THE FIX
# -------
# Take CW egress off the Ruby plugin entirely. fluentd's @OUTPUT now
# forwards to a Fluent Bit sidecar whose Go cloudwatch_logs output (a
# completely separate codebase) does the PutLogEvents. Proven: sustained
# ~50 ev/s, PutLogEvents HTTP 200 + nextSequenceToken, newest CW event
# age ~0-5s, readback events carry tenx_hash. See TENX_HASH_STATUS.md.
#
# This is a kubectl patch on the Helm-managed daemonset + a configmap
# rewrite + one new configmap. A `helm upgrade` of the fluentd release
# REVERTS it. Re-run this script after any such upgrade.
#
#   Usage:  kubectl ctx = log10x-otel-demo;  bash apply.sh
set -euo pipefail
NS=demo
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[1/4] fluent-bit-cwl configmap (Go cloudwatch_logs sidecar config)"
kubectl create configmap fluent-bit-cwl -n "$NS" \
  --from-file=fluent-bit.conf="$DIR/fluent-bit.conf" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "[2/4] fluentd-config-tenx :: 04_outputs.conf -> forward to sidecar"
python3 - "$DIR/04_outputs.conf" <<'PY' | kubectl patch configmap fluentd-config-tenx -n demo --type merge --patch-file /dev/stdin
import json,sys
print(json.dumps({"data":{"04_outputs.conf": open(sys.argv[1]).read()}}))
PY

echo "[3/4] tenx-fluentd daemonset :: add fluent-bit sidecar + volume"
kubectl patch daemonset tenx-fluentd -n "$NS" --type strategic \
  --patch-file "$DIR/ds-patch.json"

echo "[4/4] rollout"
kubectl rollout restart daemonset/tenx-fluentd -n "$NS"
kubectl rollout status  daemonset/tenx-fluentd -n "$NS" --timeout=180s

echo
echo "Applied. Verify with:  bash ../bin/verify-tenx-hash-e2e.sh 8"
echo "(expect Gate 2 PASS: newest CW event a few seconds old, >=8 distinct tenx_hash)"
