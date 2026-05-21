#!/usr/bin/env bash
# demo-gallery.sh — render every user-facing log10x MCP tool against the
# otel-demo env into ONE readable markdown file, so you can review the exact
# output a user/agent sees. Re-runnable.
#
#   Usage:  PROMETHEUS_URL=http://localhost:9090 bash eval/bin/demo-gallery.sh
#   (PROMETHEUS_URL only needed for correlate_cross_pillar; start it with
#    kubectl -n otel-demo port-forward svc/prometheus 9090:9090 &)
#
# Output: eval/reports/demo-gallery.md
set -uo pipefail
cd "$(dirname "$0")/.."                 # -> eval/
OUT="reports/demo-gallery.md"
mkdir -p reports
PAT="cart_cartstore_ValkeyCartStore_GetCartAsync_called_userId"
export LOG10X_EVAL_ENV=demo
export PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"

call() {  # $1=title  $2=tool  $3=args-json
  { echo "## $1"
    echo '`'"tool: $2  ·  args: $3"'`'
    echo
    echo '```'
  } >> "$OUT"
  timeout 120 node bin/mcp-call.mjs --tool "$2" --args "$3" >> "$OUT" 2>&1 \
    || echo "(tool errored or timed out)" >> "$OUT"
  { echo '```'; echo; echo '---'; echo; } >> "$OUT"
  echo "  rendered: $2"
}

{ echo "# log10x MCP — otel-demo output gallery"
  echo "_Generated $(date -u +%FT%TZ) · env=demo · pattern=\`$PAT\`_"
  echo
  echo "What a user/agent actually sees. The 6 tools changed this pass are first."
  echo
} > "$OUT"

# --- changed this pass (review first) ---
call "top_patterns — cost ranking (FIXED: \$/h + \$/mo were 24x off on 24h/7d)" log10x_top_patterns '{"timeRange":"24h","limit":8}'
call "correlate_cross_pillar — logs<->metrics (NEW: co-movement-not-causation handoff)" log10x_correlate_cross_pillar "{\"anchor_type\":\"log10x_pattern\",\"anchor\":\"$PAT\",\"window\":\"3h\"}"
call "investigate — env audit (reworded: 'lead' / 'temporal chain')" log10x_investigate '{"starting_point":"environment","window":"24h"}'
call "pattern_trend — (de-verdict: 'Change over' not 'Verdict: RISING')" log10x_pattern_trend "{\"pattern\":\"$PAT\",\"timeRange\":\"1d\",\"step\":\"1h\"}"
call "event_lookup — (de-verdict: factual, no 'filter X% / regression' verdict)" log10x_event_lookup "{\"pattern\":\"$PAT\"}"
call "cost_drivers — (de-verdict: 'no pattern grew' not 'environment stable')" log10x_cost_drivers '{"timeRange":"7d"}'

# --- other user-facing tools (unchanged this pass) ---
call "savings — (env-blocked on demo: truthful-empty)" log10x_savings '{"timeRange":"7d"}'
call "pattern_examples — live SIEM evidence + slots" log10x_pattern_examples "{\"pattern\":\"$PAT\",\"vendor\":\"cloudwatch\"}"
call "list_by_label — bytes by service" log10x_list_by_label '{"label":"tenx_user_service"}'
call "exclusion_filter — exact-hash drop snippet" log10x_exclusion_filter "{\"pattern\":\"$PAT\"}"
call "dependency_check — blast-radius before muting" log10x_dependency_check "{\"pattern\":\"$PAT\"}"
call "doctor — env self-diagnosis" log10x_doctor '{}'

echo
echo "Wrote $OUT"
echo "NOTE: log10x_pattern_mitigate is registered in the public MCP but NOT in the"
echo "eval CLI registry, so it can't be rendered here — it has no eval coverage."
