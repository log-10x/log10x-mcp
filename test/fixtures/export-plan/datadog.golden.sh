#!/usr/bin/env bash
# Sample export for Datadog — log10x fenced POC, step 2 of 4.
#
# WHAT THIS READS
#   API:         POST /api/v2/logs/events/search  (the log events themselves)
#                Read-only. No monitor, pipeline or index is touched.
#   Credentials: DD_API_KEY and DD_APP_KEY from this shell, sent to the Datadog site in
#                DD_SITE and to nowhere else.
#   Window:      2026-08-13 12:00:00Z .. 2026-08-27 12:00:00Z  (14d)
#   Sampling:    24 random sub-windows, up to 52,084 events each,
#                stopping at 1,000,000 events total.
#
# WHAT THIS WRITES
#   ./poc/logs/main.NN.log — one log message per line, plain text.
#   Nothing else is written outside that directory.
#
# WHAT ELSE IT DOES
#   Nothing. The only host it contacts is the one named above, nothing is
#   uploaded, and no vendor address appears anywhere in this file. The
#   container that analyses these files afterwards starts with --network none
#   and cannot send them anywhere either.
#
#   Query: index:main
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
PAGE_LIMIT=1000
STEM='main'
QUERY='index:main'
SITE="${DD_SITE:-datadoghq.com}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }
}
need curl
need jq
: "${DD_API_KEY:?set DD_API_KEY to a Datadog API key}"
: "${DD_APP_KEY:?set DD_APP_KEY to a Datadog application key with logs_read_data}"

URL="https://api.$SITE/api/v2/logs/events/search"
CURL_OPTS=(--silent --show-error --fail -H 'Content-Type: application/json')

TMPDIR_RUN=$(mktemp -d)
trap 'rm -rf "$TMPDIR_RUN"' EXIT
RESP="$TMPDIR_RUN/response"
ERR="$TMPDIR_RUN/stderr"
CURL_HEADERS="$TMPDIR_RUN/headers"
BATCH="$TMPDIR_RUN/batch"
# Credentials go in a file, not on the command line: argv is readable by
# every user on the machine through `ps`. The file holds raw header lines
# (curl -H @file), sits inside the 0700 scratch directory, and the EXIT
# trap above removes it.
(
  umask 077
  printf 'DD-API-KEY: %s\n' "$DD_API_KEY"
  printf 'DD-APPLICATION-KEY: %s\n' "$DD_APP_KEY"
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

BUCKET_FROM=('2026-08-13T18:06:51.226Z' '2026-08-14T07:27:29.145Z' '2026-08-15T01:36:24.722Z' '2026-08-15T13:20:11.448Z' '2026-08-16T03:54:26.469Z' '2026-08-16T17:14:20.584Z' '2026-08-17T05:28:18.189Z' '2026-08-17T15:35:38.924Z' '2026-08-18T04:30:54.531Z' '2026-08-18T20:22:34.719Z' '2026-08-19T11:01:02.344Z' '2026-08-20T08:28:07.842Z' '2026-08-20T19:27:33.241Z' '2026-08-21T09:02:58.228Z' '2026-08-21T19:47:59.318Z' '2026-08-22T08:41:29.247Z' '2026-08-22T21:05:52.823Z' '2026-08-23T19:26:39.537Z' '2026-08-24T08:55:23.349Z' '2026-08-24T22:49:02.655Z' '2026-08-25T08:44:15.815Z' '2026-08-25T20:57:08.568Z' '2026-08-26T16:50:11.671Z' '2026-08-26T22:28:39.482Z')
BUCKET_TO=('2026-08-13T21:36:51.227Z' '2026-08-14T10:57:29.146Z' '2026-08-15T05:06:24.723Z' '2026-08-15T16:50:11.449Z' '2026-08-16T07:24:26.470Z' '2026-08-16T20:44:20.585Z' '2026-08-17T08:58:18.190Z' '2026-08-17T19:05:38.925Z' '2026-08-18T08:00:54.532Z' '2026-08-18T23:52:34.720Z' '2026-08-19T14:31:02.345Z' '2026-08-20T11:58:07.843Z' '2026-08-20T22:57:33.242Z' '2026-08-21T12:32:58.229Z' '2026-08-21T23:17:59.319Z' '2026-08-22T12:11:29.248Z' '2026-08-23T00:35:52.824Z' '2026-08-23T22:56:39.538Z' '2026-08-24T12:25:23.350Z' '2026-08-25T02:19:02.656Z' '2026-08-25T12:14:15.816Z' '2026-08-26T00:27:08.569Z' '2026-08-26T20:20:11.672Z' '2026-08-27T01:58:39.483Z')

# ── Read events, sub-window by sub-window ──────────────────────────────
TOTAL=0
for i in "${!BUCKET_FROM[@]}"; do
  if [ "$TOTAL" -ge "$TARGET" ]; then break; fi
  remaining=$BUCKET_CAP
  cursor=""
  while [ "$remaining" -gt 0 ]; do
    limit=$remaining
    if [ "$limit" -gt "$PAGE_LIMIT" ]; then limit=$PAGE_LIMIT; fi
    body=$(jq -n \
      --arg q "$QUERY" \
      --arg from "${BUCKET_FROM[$i]}" \
      --arg to "${BUCKET_TO[$i]}" \
      --argjson limit "$limit" \
      --arg cursor "$cursor" \
      '{ filter: { query: $q, from: $from, to: $to },
         page: ({ limit: $limit } + (if $cursor == "" then {} else { cursor: $cursor } end)),
         sort: "timestamp" }')
    if ! curl "${CURL_OPTS[@]}" -H @"$CURL_HEADERS" \
        -X POST "$URL" --data-binary "$body" > "$RESP" 2> "$ERR"; then
      echo "  skipped sub-window $((i + 1)): $(head -n 1 "$ERR")" >&2
      break
    fi
    got=$(jq -r '.data | length' < "$RESP")
    if [ "$got" -eq 0 ]; then break; fi
    # Same message resolution the live connector uses, in the same order:
    # attributes.message first, then message / log / body / raw under the
    # nested attributes, then those attributes as JSON so a custom-format
    # ingest still contributes its bytes. An event with no resolvable body
    # is skipped rather than written as the string "undefined".
    jq -r '.data[].attributes as $a
           | ($a.message
              // $a.attributes.message // $a.attributes.log
              // $a.attributes.body // $a.attributes.raw
              // (if ($a.attributes // {}) | length > 0 then ($a.attributes | tojson) else null end))
           | select(. != null and . != "")' < "$RESP" > "$BATCH"
    if [ -s "$BATCH" ]; then cat "$BATCH" >> "$(outfile "$STEM")"; fi
    cursor=$(jq -r '.meta.page.after // ""' < "$RESP")
    remaining=$((remaining - got))
    TOTAL=$((TOTAL + got))
    if [ -z "$cursor" ]; then break; fi
    if [ "$TOTAL" -ge "$TARGET" ]; then break; fi
  done
  printf "sub-window %2d/%d — %d events so far\n" "$((i + 1))" "${#BUCKET_FROM[@]}" "$TOTAL" >&2
done

echo "" >&2
echo "wrote $(ls -1 './poc/logs' | wc -l | tr -d ' ') file(s) to ./poc/logs" >&2
du -sh './poc/logs' >&2
echo "Next: start the fenced container and run the POC over these files." >&2
