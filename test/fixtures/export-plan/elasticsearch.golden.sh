#!/usr/bin/env bash
# Sample export for Elasticsearch — log10x fenced POC, step 2 of 4.
#
# WHAT THIS READS
#   API:         GET  _cat/indices  (which indices the pattern below resolves to)
#                POST _search       (the documents themselves)
#                Both are read-only. No index, template or pipeline is created.
#   Credentials: ELASTIC_URL, plus ELASTIC_API_KEY or ELASTIC_USERNAME/ELASTIC_PASSWORD from this shell.
#                They are sent to ELASTIC_URL and to nowhere else.
#   Window:      2026-08-20 12:00:00Z .. 2026-08-27 12:00:00Z  (7d)
#   Sampling:    24 random sub-windows, up to 26,042 events each,
#                stopping at 500,000 events total.
#
# WHAT THIS WRITES
#   ./poc/logs/<index>.NN.log — one document message per line, plain text.
#   Nothing else is written outside that directory.
#
# WHAT ELSE IT DOES
#   Nothing. The only host it contacts is the one named above, nothing is
#   uploaded, and no vendor address appears anywhere in this file. The
#   container that analyses these files afterwards starts with --network none
#   and cannot send them anywhere either.
#
#   Index pattern: logs-*  (up to 100 concrete indices)
#   No filter: every document in range.
#   Message field: the first of `message`, `log`, `@message` present on the
#   document; a document with none is written as its own JSON, so nothing is
#   silently dropped from the byte accounting.
#
# SUB-WINDOWS SAMPLED
#    1. 2026-08-20 15:03:25Z .. 2026-08-20 16:48:25Z
#    2. 2026-08-20 21:43:44Z .. 2026-08-20 23:28:44Z
#    3. 2026-08-21 06:48:12Z .. 2026-08-21 08:33:12Z
#    4. 2026-08-21 12:40:05Z .. 2026-08-21 14:25:05Z
#    5. 2026-08-21 19:57:13Z .. 2026-08-21 21:42:13Z
#    6. 2026-08-22 02:37:10Z .. 2026-08-22 04:22:10Z
#    7. 2026-08-22 08:44:09Z .. 2026-08-22 10:29:09Z
#    8. 2026-08-22 13:47:49Z .. 2026-08-22 15:32:49Z
#    9. 2026-08-22 20:15:27Z .. 2026-08-22 22:00:27Z
#   10. 2026-08-23 04:11:17Z .. 2026-08-23 05:56:17Z
#   11. 2026-08-23 11:30:31Z .. 2026-08-23 13:15:31Z
#   12. 2026-08-23 22:14:03Z .. 2026-08-23 23:59:03Z
#   13. 2026-08-24 03:43:46Z .. 2026-08-24 05:28:46Z
#   14. 2026-08-24 10:31:29Z .. 2026-08-24 12:16:29Z
#   15. 2026-08-24 15:53:59Z .. 2026-08-24 17:38:59Z
#   16. 2026-08-24 22:20:44Z .. 2026-08-25 00:05:44Z
#   17. 2026-08-25 04:32:56Z .. 2026-08-25 06:17:56Z
#   18. 2026-08-25 15:43:19Z .. 2026-08-25 17:28:19Z
#   19. 2026-08-25 22:27:41Z .. 2026-08-26 00:12:41Z
#   20. 2026-08-26 05:24:31Z .. 2026-08-26 07:09:31Z
#   21. 2026-08-26 10:22:07Z .. 2026-08-26 12:07:07Z
#   22. 2026-08-26 16:28:34Z .. 2026-08-26 18:13:34Z
#   23. 2026-08-27 02:25:05Z .. 2026-08-27 04:10:05Z
#   24. 2026-08-27 05:14:19Z .. 2026-08-27 06:59:19Z

set -euo pipefail

OUT_DIR='./poc/logs'
TARGET=500000
BUCKET_CAP=26042
PAGE_SIZE=1000
INDEX_PATTERN='logs-*'

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }
}
need curl
need jq
: "${ELASTIC_URL:?set ELASTIC_URL to your cluster endpoint, e.g. https://es.internal:9200}"

URL="${ELASTIC_URL%/}"

CURL_OPTS=(--silent --show-error --fail -H 'Accept: application/json')

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
# Auth itself is optional: a dev cluster with security disabled needs
# neither branch, and an empty header file is a valid header file.
:> "$CURL_HEADERS"
if [ -n "${ELASTIC_API_KEY:-}" ]; then
  (
    umask 077
    printf 'Authorization: ApiKey %s\n' "${ELASTIC_API_KEY}"
  ) > "$CURL_HEADERS"
elif [ -n "${ELASTIC_USERNAME:-}" ] && [ -n "${ELASTIC_PASSWORD:-}" ]; then
  (
    umask 077
    printf 'Authorization: Basic %s\n' "$(printf '%s:%s' "${ELASTIC_USERNAME}" "${ELASTIC_PASSWORD}" | base64 | tr -d '\n')"
  ) > "$CURL_HEADERS"
fi
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

BUCKET_FROM=('2026-08-20T15:03:25.613Z' '2026-08-20T21:43:44.572Z' '2026-08-21T06:48:12.361Z' '2026-08-21T12:40:05.724Z' '2026-08-21T19:57:13.234Z' '2026-08-22T02:37:10.292Z' '2026-08-22T08:44:09.094Z' '2026-08-22T13:47:49.462Z' '2026-08-22T20:15:27.265Z' '2026-08-23T04:11:17.359Z' '2026-08-23T11:30:31.172Z' '2026-08-23T22:14:03.921Z' '2026-08-24T03:43:46.620Z' '2026-08-24T10:31:29.114Z' '2026-08-24T15:53:59.659Z' '2026-08-24T22:20:44.623Z' '2026-08-25T04:32:56.411Z' '2026-08-25T15:43:19.768Z' '2026-08-25T22:27:41.674Z' '2026-08-26T05:24:31.327Z' '2026-08-26T10:22:07.907Z' '2026-08-26T16:28:34.284Z' '2026-08-27T02:25:05.835Z' '2026-08-27T05:14:19.741Z')
BUCKET_TO=('2026-08-20T16:48:25.614Z' '2026-08-20T23:28:44.573Z' '2026-08-21T08:33:12.362Z' '2026-08-21T14:25:05.725Z' '2026-08-21T21:42:13.235Z' '2026-08-22T04:22:10.293Z' '2026-08-22T10:29:09.095Z' '2026-08-22T15:32:49.463Z' '2026-08-22T22:00:27.266Z' '2026-08-23T05:56:17.360Z' '2026-08-23T13:15:31.173Z' '2026-08-23T23:59:03.922Z' '2026-08-24T05:28:46.621Z' '2026-08-24T12:16:29.115Z' '2026-08-24T17:38:59.660Z' '2026-08-25T00:05:44.624Z' '2026-08-25T06:17:56.412Z' '2026-08-25T17:28:19.769Z' '2026-08-26T00:12:41.675Z' '2026-08-26T07:09:31.328Z' '2026-08-26T12:07:07.908Z' '2026-08-26T18:13:34.285Z' '2026-08-27T04:10:05.836Z' '2026-08-27T06:59:19.742Z')

# ── 1. Which indices the pattern resolves to (read-only) ───────────────
curl "${CURL_OPTS[@]}" -H @"$CURL_HEADERS" \
  "$URL/_cat/indices/$INDEX_PATTERN?h=index&format=json" > "$RESP"
jq -r '.[].index' < "$RESP" | sort | head -n 100 > "$TMPDIR_RUN/indices"

INDEX_COUNT=$(wc -l < "$TMPDIR_RUN/indices" | tr -d " ")
if [ "$INDEX_COUNT" -eq 0 ]; then
  echo "index pattern $INDEX_PATTERN matched no indices; nothing to export" >&2
  exit 1
fi
echo "indices in scope: $INDEX_COUNT" >&2

# ── 2. Read documents, sub-window by sub-window (read-only) ────────────
TOTAL=0
for i in "${!BUCKET_FROM[@]}"; do
  if [ "$TOTAL" -ge "$TARGET" ]; then break; fi
  remaining=$BUCKET_CAP
  while IFS= read -r index; do
    if [ -z "$index" ]; then continue; fi
    if [ "$remaining" -le 0 ] || [ "$TOTAL" -ge "$TARGET" ]; then break; fi
    stem=$(printf "%s" "$index" | sed -e "s#[^A-Za-z0-9._-]#-#g")
    after="null"
    while [ "$remaining" -gt 0 ]; do
      size=$remaining
      if [ "$size" -gt "$PAGE_SIZE" ]; then size=$PAGE_SIZE; fi
      body=$(jq -n \
        --arg from "${BUCKET_FROM[$i]}" \
        --arg to "${BUCKET_TO[$i]}" \
        --argjson size "$size" \
        --argjson after "$after" \
        --argjson extra '[]' \
        '{ query: { bool: { must: ([{ range: { "@timestamp": { gte: $from, lte: $to } } }] + $extra) } },
           size: $size,
           sort: [ { "@timestamp": "asc" } ],
           track_total_hits: false }
         + (if $after == null then {} else { search_after: $after } end)')
      if ! curl "${CURL_OPTS[@]}" -H @"$CURL_HEADERS" \
          -H "Content-Type: application/json" \
          -X POST "$URL/$index/_search" \
          --data-binary "$body" > "$RESP" 2> "$ERR"; then
        echo "  skipped $index in sub-window $((i + 1)): $(head -n 1 "$ERR")" >&2
        break
      fi
      hits=$(jq -r '.hits.hits | length' < "$RESP")
      if [ "$hits" -eq 0 ]; then break; fi
      jq -r '.hits.hits[]._source
             | (.message // .log // ."@message" // (. | tojson))' < "$RESP" > "$BATCH"
      # Only name a part file once there is something to put in it: an empty
      # file would show up in the report as a source that contributed no bytes.
      if [ -s "$BATCH" ]; then cat "$BATCH" >> "$(outfile "$stem")"; fi
      after=$(jq -c '.hits.hits[-1].sort' < "$RESP")
      remaining=$((remaining - hits))
      TOTAL=$((TOTAL + hits))
      if [ "$hits" -lt "$size" ]; then break; fi
      if [ "$TOTAL" -ge "$TARGET" ]; then break; fi
    done
  done < "$TMPDIR_RUN/indices"
  printf "sub-window %2d/%d — %d documents so far\n" "$((i + 1))" "${#BUCKET_FROM[@]}" "$TOTAL" >&2
done

echo "" >&2
echo "wrote $(ls -1 './poc/logs' | wc -l | tr -d ' ') file(s) to ./poc/logs" >&2
du -sh './poc/logs' >&2
echo "Next: start the fenced container and run the POC over these files." >&2
