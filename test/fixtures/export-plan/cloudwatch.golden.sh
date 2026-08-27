#!/usr/bin/env bash
# Sample export for Amazon CloudWatch Logs — log10x fenced POC, step 2 of 4.
#
# WHAT THIS READS
#   API:         logs:DescribeLogGroups  (which log groups exist under the scope below)
#                logs:FilterLogEvents    (the log events themselves)
#                Both are read-only. Nothing is created, tagged or deleted.
#   Credentials: whatever the `aws` CLI on this machine already uses — AWS_PROFILE,
#                AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, SSO cache or an instance
#                role. This script neither reads nor copies them.
#   Window:      2026-08-13 12:00:00Z .. 2026-08-27 12:00:00Z  (14d)
#   Sampling:    24 random sub-windows, up to 52,084 events each,
#                stopping at 1,000,000 events total.
#
# WHAT THIS WRITES
#   ./poc/logs/<log-group>.NN.log — one log message per line, plain text.
#   Nothing else is written outside that directory.
#
# WHAT ELSE IT DOES
#   Nothing. The only host it contacts is the one named above, nothing is
#   uploaded, and no vendor address appears anywhere in this file. The
#   container that analyses these files afterwards starts with --network none
#   and cannot send them anywhere either.
#
#   Scope: log groups whose name starts with /aws/ecs/
#   No filter pattern: every event in range.
#
# SUB-WINDOWS SAMPLED
#    1. 2026-08-13 18:06:51Z .. 2026-08-13 21:36:51Z
#    2. 2026-08-14 07:27:29Z .. 2026-08-14 10:57:29Z
#    3. 2026-08-15 01:36:24Z .. 2026-08-15 05:06:24Z
#    4. 2026-08-15 13:20:11Z .. 2026-08-15 16:50:11Z
#    5. 2026-08-16 03:54:26Z .. 2026-08-16 07:24:26Z
#    6. 2026-08-16 17:14:20Z .. 2026-08-16 20:44:20Z
#    7. 2026-08-17 05:28:18Z .. 2026-08-17 08:58:18Z
#    8. 2026-08-17 15:35:38Z .. 2026-08-17 19:05:38Z
#    9. 2026-08-18 04:30:54Z .. 2026-08-18 08:00:54Z
#   10. 2026-08-18 20:22:34Z .. 2026-08-18 23:52:34Z
#   11. 2026-08-19 11:01:02Z .. 2026-08-19 14:31:02Z
#   12. 2026-08-20 08:28:07Z .. 2026-08-20 11:58:07Z
#   13. 2026-08-20 19:27:33Z .. 2026-08-20 22:57:33Z
#   14. 2026-08-21 09:02:58Z .. 2026-08-21 12:32:58Z
#   15. 2026-08-21 19:47:59Z .. 2026-08-21 23:17:59Z
#   16. 2026-08-22 08:41:29Z .. 2026-08-22 12:11:29Z
#   17. 2026-08-22 21:05:52Z .. 2026-08-23 00:35:52Z
#   18. 2026-08-23 19:26:39Z .. 2026-08-23 22:56:39Z
#   19. 2026-08-24 08:55:23Z .. 2026-08-24 12:25:23Z
#   20. 2026-08-24 22:49:02Z .. 2026-08-25 02:19:02Z
#   21. 2026-08-25 08:44:15Z .. 2026-08-25 12:14:15Z
#   22. 2026-08-25 20:57:08Z .. 2026-08-26 00:27:08Z
#   23. 2026-08-26 16:50:11Z .. 2026-08-26 20:20:11Z
#   24. 2026-08-26 22:28:39Z .. 2026-08-27 01:58:39Z

set -euo pipefail

OUT_DIR='./poc/logs'
TARGET=1000000
BUCKET_CAP=52084
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }
}
need aws
need jq

TMPDIR_RUN=$(mktemp -d)
trap 'rm -rf "$TMPDIR_RUN"' EXIT
RESP="$TMPDIR_RUN/response"
ERR="$TMPDIR_RUN/stderr"
BATCH="$TMPDIR_RUN/batch"
mkdir -p "$OUT_DIR"

MAX_LINES_PER_FILE=45000
MAX_BYTES_PER_FILE=15000000

# Name the part file the next batch appends to, rolling when the current
# part is full. Parts keep the source name so the report can still say
# which log group / index / service each slice of the sample came from.
outfile() {
  stem="$1"
  part=1
  while :; do
    f="$OUT_DIR/$stem.$(printf "%02d" "$part").log"
    if [ ! -f "$f" ]; then printf "%s" "$f"; return; fi
    lines=$(wc -l < "$f" | tr -d " ")
    bytes=$(wc -c < "$f" | tr -d " ")
    if [ "$lines" -lt "$MAX_LINES_PER_FILE" ] && [ "$bytes" -lt "$MAX_BYTES_PER_FILE" ]; then
      printf "%s" "$f"; return
    fi
    part=$((part + 1))
  done
}

BUCKET_FROM=(1786644411226 1786692449145 1786757784722 1786800011448 1786852466469 1786900460584 1786944498189 1786980938924 1787027454531 1787084554719 1787137262344 1787214487842 1787254053241 1787302978228 1787341679318 1787388089247 1787432752823 1787513199537 1787561723349 1787611742655 1787647455815 1787691428568 1787763011671 1787783319482)
BUCKET_TO=(1786657011227 1786705049146 1786770384723 1786812611449 1786865066470 1786913060585 1786957098190 1786993538925 1787040054532 1787097154720 1787149862345 1787227087843 1787266653242 1787315578229 1787354279319 1787400689248 1787445352824 1787525799538 1787574323350 1787624342656 1787660055816 1787704028569 1787775611672 1787795919483)

# ── 1. Which log groups are in scope (read-only) ───────────────────────
aws logs describe-log-groups \
  --region "$REGION" \
  --log-group-name-prefix '/aws/ecs/' \
  --max-items 200 \
  --query 'logGroups[].logGroupName' --output text \
  | tr '\t' '\n' | sed '/^$/d' > "$TMPDIR_RUN/groups"

GROUP_COUNT=$(wc -l < "$TMPDIR_RUN/groups" | tr -d " ")
if [ "$GROUP_COUNT" -eq 0 ]; then
  echo "no log groups matched the scope; nothing to export" >&2
  exit 1
fi
echo "log groups in scope: $GROUP_COUNT" >&2

# ── 2. Read events, sub-window by sub-window (read-only) ───────────────
TOTAL=0
for i in "${!BUCKET_FROM[@]}"; do
  if [ "$TOTAL" -ge "$TARGET" ]; then break; fi
  remaining=$BUCKET_CAP
  while IFS= read -r group; do
    if [ -z "$group" ]; then continue; fi
    if [ "$remaining" -le 0 ] || [ "$TOTAL" -ge "$TARGET" ]; then break; fi
    stem=$(printf "%s" "$group" | sed -e "s#^/##" -e "s#[^A-Za-z0-9._-]#-#g")
    if ! aws logs filter-log-events \
        --region "$REGION" \
        --log-group-name "$group" \
        --start-time "${BUCKET_FROM[$i]}" \
        --end-time "${BUCKET_TO[$i]}" \
        --max-items "$remaining" \
        --output json > "$RESP" 2> "$ERR"; then
      echo "  skipped $group in sub-window $((i + 1)): $(head -n 1 "$ERR")" >&2
      continue
    fi
    jq -r '.events[].message' < "$RESP" > "$BATCH"
    n=$(wc -l < "$BATCH" | tr -d " ")
    # Only name a part file once there is something to put in it: an empty
    # file would show up in the report as a source that contributed no
    # bytes, which reads as a finding and is an artefact.
    if [ "$n" -gt 0 ]; then cat "$BATCH" >> "$(outfile "$stem")"; fi
    remaining=$((remaining - n))
    TOTAL=$((TOTAL + n))
  done < "$TMPDIR_RUN/groups"
  printf "sub-window %2d/%d — %d lines so far\n" "$((i + 1))" "${#BUCKET_FROM[@]}" "$TOTAL" >&2
done

echo "" >&2
echo "wrote $(ls -1 './poc/logs' | wc -l | tr -d ' ') file(s) to ./poc/logs" >&2
du -sh './poc/logs' >&2
echo "Next: start the fenced container and run the POC over these files." >&2
