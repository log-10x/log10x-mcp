/**
 * Datadog Logs export-plan emitter.
 *
 * Mirrors `lib/siem/datadog.ts`: 24 stratified sub-windows, the same
 * per-bucket cap, the same `index:<name>` + free-text query composition, the
 * same cursor pagination over the v2 logs search endpoint, and the same
 * message resolution — `attributes.message` first, then `message` / `log` /
 * `body` / `raw` under `attributes.attributes`, then the nested attributes
 * as JSON so a custom-format ingest still contributes its bytes.
 *
 * `DD_SITE` selects the regional endpoint (US1/EU1/US3/US5/AP1) exactly as
 * the SDK does, so the script reaches the same host the live connector would.
 */

import { DATADOG_BUCKET_COUNT, DATADOG_PAGE_LIMIT } from '../datadog.js';
import {
  assertNoVendorHost,
  fileStem,
  planBuckets,
  renderBucketArrays,
  renderFooter,
  renderHeader,
  renderOutfileHelper,
  renderPreflight,
  renderCurlHeaders,
  renderScratch,
  shQuote,
  DEFAULT_OUTPUT_DIR,
  POC_MAX_FILES,
  POC_PER_FILE_LIMIT,
  type SamplePlan,
  type SamplePlanOptions,
} from './_shared.js';

export function emitDatadogPlan(opts: SamplePlanOptions): SamplePlan {
  const outputDir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  const { buckets, perBucketCap, fromMs, toMs } = planBuckets(opts, DATADOG_BUCKET_COUNT);

  const queryParts: string[] = [];
  if (opts.scope) queryParts.push(`index:${opts.scope}`);
  if (opts.query) queryParts.push(opts.query);
  const queryStr = queryParts.join(' ').trim();
  const stem = fileStem(opts.scope ?? 'datadog');

  const header = renderHeader({
    displayName: 'Datadog',
    apiSummary:
      'POST /api/v2/logs/events/search  (the log events themselves)\n' +
      'Read-only. No monitor, pipeline or index is touched.',
    credentialSummary:
      'DD_API_KEY and DD_APP_KEY from this shell, sent to the Datadog site in\n' +
      'DD_SITE and to nowhere else.',
    writes:
      `${outputDir}/${stem}.NN.log — one log message per line, plain text.\n` +
      'Nothing else is written outside that directory.',
    window: opts.window,
    bucketCount: DATADOG_BUCKET_COUNT,
    perBucketCap,
    targetEventCount: opts.targetEventCount,
    fromMs,
    toMs,
    buckets,
    extra: [
      queryStr ? `Query: ${queryStr}` : 'No query: every event in range, across every index.',
    ],
  });

  const script = [
    '#!/usr/bin/env bash',
    header,
    '',
    'set -euo pipefail',
    '',
    `OUT_DIR=${shQuote(outputDir)}`,
    `TARGET=${opts.targetEventCount}`,
    `BUCKET_CAP=${perBucketCap}`,
    `PAGE_LIMIT=${DATADOG_PAGE_LIMIT}`,
    `STEM=${shQuote(stem)}`,
    `QUERY=${shQuote(queryStr)}`,
    'SITE="${DD_SITE:-datadoghq.com}"',
    '',
    renderPreflight(
      ['curl', 'jq'],
      [
        { name: 'DD_API_KEY', hint: 'set DD_API_KEY to a Datadog API key' },
        { name: 'DD_APP_KEY', hint: 'set DD_APP_KEY to a Datadog application key with logs_read_data' },
      ],
    ),
    '',
    'URL="https://api.$SITE/api/v2/logs/events/search"',
    "CURL_OPTS=(--silent --show-error --fail -H 'Content-Type: application/json')",
    '',
    renderScratch(['curl_headers', 'batch']),
    renderCurlHeaders([
      { header: 'DD-API-KEY: %s', value: '"$DD_API_KEY"' },
      { header: 'DD-APPLICATION-KEY: %s', value: '"$DD_APP_KEY"' },
    ]),
    'mkdir -p "$OUT_DIR"',
    '',
    renderOutfileHelper(),
    '',
    renderBucketArrays(buckets, 'iso'),
    '',
    '# ── Read events, sub-window by sub-window ──────────────────────────────',
    'TOTAL=0',
    'for i in "${!BUCKET_FROM[@]}"; do',
    '  if [ "$TOTAL" -ge "$TARGET" ]; then break; fi',
    '  remaining=$BUCKET_CAP',
    '  cursor=""',
    '  while [ "$remaining" -gt 0 ]; do',
    '    limit=$remaining',
    '    if [ "$limit" -gt "$PAGE_LIMIT" ]; then limit=$PAGE_LIMIT; fi',
    '    body=$(jq -n \\',
    '      --arg q "$QUERY" \\',
    '      --arg from "${BUCKET_FROM[$i]}" \\',
    '      --arg to "${BUCKET_TO[$i]}" \\',
    '      --argjson limit "$limit" \\',
    '      --arg cursor "$cursor" \\',
    '      \'{ filter: { query: $q, from: $from, to: $to },',
    '         page: ({ limit: $limit } + (if $cursor == "" then {} else { cursor: $cursor } end)),',
    '         sort: "timestamp" }\')',
    '    if ! curl "${CURL_OPTS[@]}" -H @"$CURL_HEADERS" \\',
    '        -X POST "$URL" --data-binary "$body" > "$RESP" 2> "$ERR"; then',
    '      echo "  skipped sub-window $((i + 1)): $(head -n 1 "$ERR")" >&2',
    '      break',
    '    fi',
    '    got=$(jq -r \'.data | length\' < "$RESP")',
    '    if [ "$got" -eq 0 ]; then break; fi',
    '    # Same message resolution the live connector uses, in the same order:',
    '    # attributes.message first, then message / log / body / raw under the',
    '    # nested attributes, then those attributes as JSON so a custom-format',
    '    # ingest still contributes its bytes. An event with no resolvable body',
    '    # is skipped rather than written as the string "undefined".',
    '    jq -r \'.data[].attributes as $a',
    '           | ($a.message',
    '              // $a.attributes.message // $a.attributes.log',
    '              // $a.attributes.body // $a.attributes.raw',
    '              // (if ($a.attributes // {}) | length > 0 then ($a.attributes | tojson) else null end))',
    '           | select(. != null and . != "")\' < "$RESP" > "$BATCH"',
    '    if [ -s "$BATCH" ]; then cat "$BATCH" >> "$(outfile "$STEM")"; fi',
    '    cursor=$(jq -r \'.meta.page.after // ""\' < "$RESP")',
    '    remaining=$((remaining - got))',
    '    TOTAL=$((TOTAL + got))',
    '    if [ -z "$cursor" ]; then break; fi',
    '    if [ "$TOTAL" -ge "$TARGET" ]; then break; fi',
    '  done',
    '  printf "sub-window %2d/%d — %d events so far\\n" "$((i + 1))" "${#BUCKET_FROM[@]}" "$TOTAL" >&2',
    'done',
    '',
    renderFooter(outputDir),
    '',
  ].join('\n');

  assertNoVendorHost(script, 'datadog');

  return {
    siem: 'datadog',
    displayName: 'Datadog',
    filename: 'export-sample.sh',
    script,
    bucketCount: DATADOG_BUCKET_COUNT,
    perBucketCap,
    targetEventCount: opts.targetEventCount,
    window: opts.window,
    outputDir,
    requires: ['curl', 'jq'],
    credentials: ['DD_API_KEY', 'DD_APP_KEY', 'DD_SITE (optional, defaults to datadoghq.com)'],
    apiCalls: ['POST /api/v2/logs/events/search'],
    pocFromLocalArgs: {
      source: 'file',
      paths: ['/data'],
      siem: 'datadog',
      window: opts.window,
      per_pod_limit: POC_PER_FILE_LIMIT,
      max_pods: POC_MAX_FILES,
    },
    notes: [
      'Composition is per index, not per service: the export lands one set of part files for the ' +
        'index in `scope`. Run the script once per index when the mix across indexes matters.',
      'Events with no resolvable message body are skipped rather than written as the string ' +
        '"undefined" — the same choice the live connector makes, so the two samples agree.',
    ],
  };
}
