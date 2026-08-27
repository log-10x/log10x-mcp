#!/usr/bin/env bash
# Sample export for Splunk — log10x fenced POC, step 2 of 4.
#
# WHAT THIS READS
#   API:         POST /services/search/jobs/export  (one streaming search per sub-window)
#                A search reads; it creates no saved search and no artifact that
#                outlives the request.
#   Credentials: SPLUNK_HOST and SPLUNK_TOKEN from this shell. The token is sent to your
#                own search head and to nowhere else.
#   Window:      2026-08-13 12:00:00Z .. 2026-08-27 12:00:00Z  (14d)
#   Sampling:    12 random sub-windows, up to 104,167 events each,
#                stopping at 1,000,000 events total.
#
# WHAT THIS WRITES
#   ./poc/logs/main.NN.log — one event per line, exactly as Splunk stores it.
#   Nothing else is written outside that directory.
#
# WHAT ELSE IT DOES
#   Nothing. The only host it contacts is the one named above, nothing is
#   uploaded, and no vendor address appears anywhere in this file. The
#   container that analyses these files afterwards starts with --network none
#   and cannot send them anywhere either.
#
#   Search run in each sub-window:  search index=main sourcetype=access_combined | head 104167
#
# SUB-WINDOWS SAMPLED
#    1. 2026-08-14 00:13:42Z .. 2026-08-14 07:13:42Z
#    2. 2026-08-15 02:54:58Z .. 2026-08-15 09:54:58Z
#    3. 2026-08-16 15:12:49Z .. 2026-08-16 22:12:49Z
#    4. 2026-08-17 14:40:22Z .. 2026-08-17 21:40:22Z
#    5. 2026-08-18 19:48:52Z .. 2026-08-19 02:48:52Z
#    6. 2026-08-19 22:28:41Z .. 2026-08-20 05:28:41Z
#    7. 2026-08-20 22:56:36Z .. 2026-08-21 05:56:36Z
#    8. 2026-08-21 19:11:17Z .. 2026-08-22 02:11:17Z
#    9. 2026-08-22 21:01:49Z .. 2026-08-23 04:01:49Z
#   10. 2026-08-24 04:45:09Z .. 2026-08-24 11:45:09Z
#   11. 2026-08-25 10:02:04Z .. 2026-08-25 17:02:04Z
#   12. 2026-08-27 04:56:15Z .. 2026-08-27 11:56:15Z

set -euo pipefail

OUT_DIR='./poc/logs'
TARGET=1000000
STEM='main'
SPL='search index=main sourcetype=access_combined | head 104167'

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }
}
need curl
: "${SPLUNK_HOST:?set SPLUNK_HOST to your search head, e.g. https://splunk.internal:8089}"
: "${SPLUNK_TOKEN:?set SPLUNK_TOKEN to a Splunk bearer token with search rights}"

# Normalise the host the same way the live connector does: add https:// if
# absent, and the management port 8089 if no port was given.
HOST="${SPLUNK_HOST%/}"
case "$HOST" in
  http://*|https://*) ;;
  *) HOST="https://$HOST" ;;
esac
case "$HOST" in
  *:[0-9]*) ;;
  *) HOST="$HOST:8089" ;;
esac

# Add --insecure here if your search head serves a self-signed certificate
# and you have decided that is acceptable.
CURL_OPTS=(--silent --show-error --fail)

TMPDIR_RUN=$(mktemp -d)
trap 'rm -rf "$TMPDIR_RUN"' EXIT
RESP="$TMPDIR_RUN/response"
ERR="$TMPDIR_RUN/stderr"
CURL_HEADERS="$TMPDIR_RUN/headers"
# Credentials go in a file, not on the command line: argv is readable by
# every user on the machine through `ps`. The file holds raw header lines
# (curl -H @file), sits inside the 0700 scratch directory, and the EXIT
# trap above removes it.
(
  umask 077
  printf 'Authorization: Bearer %s\n' "$SPLUNK_TOKEN"
) > "$CURL_HEADERS"
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

BUCKET_FROM=('2026-08-14T00:13:42.453Z' '2026-08-15T02:54:58.290Z' '2026-08-16T15:12:49.445Z' '2026-08-17T14:40:22.896Z' '2026-08-18T19:48:52.938Z' '2026-08-19T22:28:41.169Z' '2026-08-20T22:56:36.379Z' '2026-08-21T19:11:17.849Z' '2026-08-22T21:01:49.063Z' '2026-08-24T04:45:09.438Z' '2026-08-25T10:02:04.689Z' '2026-08-27T04:56:15.685Z')
BUCKET_TO=('2026-08-14T07:13:42.454Z' '2026-08-15T09:54:58.291Z' '2026-08-16T22:12:49.446Z' '2026-08-17T21:40:22.897Z' '2026-08-19T02:48:52.939Z' '2026-08-20T05:28:41.170Z' '2026-08-21T05:56:36.380Z' '2026-08-22T02:11:17.850Z' '2026-08-23T04:01:49.064Z' '2026-08-24T11:45:09.439Z' '2026-08-25T17:02:04.690Z' '2026-08-27T11:56:15.686Z')

# ── Read events, sub-window by sub-window ──────────────────────────────
TOTAL=0
for i in "${!BUCKET_FROM[@]}"; do
  if [ "$TOTAL" -ge "$TARGET" ]; then break; fi
  if ! curl "${CURL_OPTS[@]}" -H @"$CURL_HEADERS" \
      --data-urlencode "search=$SPL" \
      --data-urlencode "earliest_time=${BUCKET_FROM[$i]}" \
      --data-urlencode "latest_time=${BUCKET_TO[$i]}" \
      --data-urlencode "output_mode=raw" \
      "$HOST/services/search/jobs/export" > "$RESP" 2> "$ERR"; then
    echo "  skipped sub-window $((i + 1)): $(head -n 1 "$ERR")" >&2
    continue
  fi
  n=$(wc -l < "$RESP" | tr -d " ")
  # Only name a part file once there is something to put in it: an empty
  # file would show up in the report as a source that contributed no bytes.
  if [ "$n" -gt 0 ]; then cat "$RESP" >> "$(outfile "$STEM")"; fi
  TOTAL=$((TOTAL + n))
  printf "sub-window %2d/%d — %d lines so far\n" "$((i + 1))" "${#BUCKET_FROM[@]}" "$TOTAL" >&2
done

echo "" >&2
echo "wrote $(ls -1 './poc/logs' | wc -l | tr -d ' ') file(s) to ./poc/logs" >&2
du -sh './poc/logs' >&2
echo "Next: start the fenced container and run the POC over these files." >&2
