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
#   Window:      2026-08-26 12:00:00Z .. 2026-08-27 12:00:00Z  (24h)
#   Sampling:    24 random sub-windows, up to 2,605 events each,
#                stopping at 50,000 events total.
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
#   Scope: every log group in the region, up to 200.
#   No filter pattern: every event in range.
#
# SUB-WINDOWS SAMPLED
#    1. 2026-08-26 12:26:12Z .. 2026-08-26 12:41:12Z
#    2. 2026-08-26 13:23:23Z .. 2026-08-26 13:38:23Z
#    3. 2026-08-26 14:41:10Z .. 2026-08-26 14:56:10Z
#    4. 2026-08-26 15:31:26Z .. 2026-08-26 15:46:26Z
#    5. 2026-08-26 16:33:53Z .. 2026-08-26 16:48:53Z
#    6. 2026-08-26 17:31:01Z .. 2026-08-26 17:46:01Z
#    7. 2026-08-26 18:23:27Z .. 2026-08-26 18:38:27Z
#    8. 2026-08-26 19:06:49Z .. 2026-08-26 19:21:49Z
#    9. 2026-08-26 20:02:12Z .. 2026-08-26 20:17:12Z
#   10. 2026-08-26 21:10:11Z .. 2026-08-26 21:25:11Z
#   11. 2026-08-26 22:12:55Z .. 2026-08-26 22:27:55Z
#   12. 2026-08-26 23:44:51Z .. 2026-08-26 23:59:51Z
#   13. 2026-08-27 00:31:58Z .. 2026-08-27 00:46:58Z
#   14. 2026-08-27 01:30:12Z .. 2026-08-27 01:45:12Z
#   15. 2026-08-27 02:16:17Z .. 2026-08-27 02:31:17Z
#   16. 2026-08-27 03:11:32Z .. 2026-08-27 03:26:32Z
#   17. 2026-08-27 04:04:42Z .. 2026-08-27 04:19:42Z
#   18. 2026-08-27 05:40:28Z .. 2026-08-27 05:55:28Z
#   19. 2026-08-27 06:38:14Z .. 2026-08-27 06:53:14Z
#   20. 2026-08-27 07:37:47Z .. 2026-08-27 07:52:47Z
#   21. 2026-08-27 08:20:18Z .. 2026-08-27 08:35:18Z
#   22. 2026-08-27 09:12:39Z .. 2026-08-27 09:27:39Z
#   23. 2026-08-27 10:37:52Z .. 2026-08-27 10:52:52Z
#   24. 2026-08-27 11:02:02Z .. 2026-08-27 11:17:02Z

set -euo pipefail

OUT_DIR='./poc/logs'
TARGET=50000
BUCKET_CAP=2605
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

BUCKET_FROM=(1787747172230 1787750603510 1787755270337 1787758286532 1787762033319 1787765461470 1787768607013 1787771209923 1787774532466 1787778611051 1787782375881 1787787891988 1787790718088 1787794212730 1787796977094 1787800292089 1787803482344 1787809228538 1787812694524 1787816267332 1787818818272 1787821959183 1787827072262 1787828522820)
BUCKET_TO=(1787748072231 1787751503511 1787756170338 1787759186533 1787762933320 1787766361471 1787769507014 1787772109924 1787775432467 1787779511052 1787783275882 1787788791989 1787791618089 1787795112731 1787797877095 1787801192090 1787804382345 1787810128539 1787813594525 1787817167333 1787819718273 1787822859184 1787827972263 1787829422821)

# ── 1. Which log groups are in scope (read-only) ───────────────────────
aws logs describe-log-groups \
  --region "$REGION" \
  \
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
