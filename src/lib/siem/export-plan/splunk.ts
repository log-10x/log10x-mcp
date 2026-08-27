/**
 * Splunk export-plan emitter.
 *
 * Mirrors `lib/siem/splunk.ts`: the same 12 stratified sub-windows (12, not
 * 24, because a Splunk search head's default per-user job concurrency is 6)
 * and the same per-bucket cap, expressed as `| head <cap>` in the SPL.
 *
 * One difference from the connector, and it simplifies the script rather than
 * changing what it reads: the connector uses the three-call job API (create /
 * poll / paginate) because it needs progress reporting. A script that only
 * has to land bytes on disk uses `search/jobs/export`, which streams results
 * from a single request. With `output_mode=raw` the response IS the log text,
 * one event per line, so there is no JSON to unwrap and no field-name guess
 * to get wrong.
 */

import { SPLUNK_BUCKET_COUNT } from '../splunk.js';
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

export function emitSplunkPlan(opts: SamplePlanOptions): SamplePlan {
  const outputDir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  const { buckets, perBucketCap, fromMs, toMs } = planBuckets(opts, SPLUNK_BUCKET_COUNT);

  // Same SPL the connector builds: `search` verb, index from scope, the
  // caller's filter appended verbatim, then a per-bucket ceiling.
  const splParts = ['search'];
  if (opts.scope) splParts.push(`index=${opts.scope}`);
  if (opts.query) splParts.push(opts.query);
  splParts.push(`| head ${perBucketCap}`);
  const spl = splParts.join(' ');
  const stem = fileStem(opts.scope ?? 'splunk');

  const header = renderHeader({
    displayName: 'Splunk',
    apiSummary:
      'POST /services/search/jobs/export  (one streaming search per sub-window)\n' +
      'A search reads; it creates no saved search and no artifact that\n' +
      'outlives the request.',
    credentialSummary:
      'SPLUNK_HOST and SPLUNK_TOKEN from this shell. The token is sent to your\n' +
      'own search head and to nowhere else.',
    writes:
      `${outputDir}/${stem}.NN.log — one event per line, exactly as Splunk stores it.\n` +
      'Nothing else is written outside that directory.',
    window: opts.window,
    bucketCount: SPLUNK_BUCKET_COUNT,
    perBucketCap,
    targetEventCount: opts.targetEventCount,
    fromMs,
    toMs,
    buckets,
    extra: [`Search run in each sub-window:  ${spl}`],
  });

  const script = [
    '#!/usr/bin/env bash',
    header,
    '',
    'set -euo pipefail',
    '',
    `OUT_DIR=${shQuote(outputDir)}`,
    `TARGET=${opts.targetEventCount}`,
    `STEM=${shQuote(stem)}`,
    `SPL=${shQuote(spl)}`,
    '',
    renderPreflight(
      ['curl'],
      [
        { name: 'SPLUNK_HOST', hint: 'set SPLUNK_HOST to your search head, e.g. https://splunk.internal:8089' },
        { name: 'SPLUNK_TOKEN', hint: 'set SPLUNK_TOKEN to a Splunk bearer token with search rights' },
      ],
    ),
    '',
    '# Normalise the host the same way the live connector does: add https:// if',
    '# absent, and the management port 8089 if no port was given.',
    'HOST="${SPLUNK_HOST%/}"',
    'case "$HOST" in',
    '  http://*|https://*) ;;',
    '  *) HOST="https://$HOST" ;;',
    'esac',
    'case "$HOST" in',
    '  *:[0-9]*) ;;',
    '  *) HOST="$HOST:8089" ;;',
    'esac',
    '',
    '# Add --insecure here if your search head serves a self-signed certificate',
    '# and you have decided that is acceptable.',
    'CURL_OPTS=(--silent --show-error --fail)',
    '',
    renderScratch(['curl_headers']),
    renderCurlHeaders([{ header: 'Authorization: Bearer %s', value: '"$SPLUNK_TOKEN"' }]),
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
    '  if ! curl "${CURL_OPTS[@]}" -H @"$CURL_HEADERS" \\',
    '      --data-urlencode "search=$SPL" \\',
    '      --data-urlencode "earliest_time=${BUCKET_FROM[$i]}" \\',
    '      --data-urlencode "latest_time=${BUCKET_TO[$i]}" \\',
    '      --data-urlencode "output_mode=raw" \\',
    '      "$HOST/services/search/jobs/export" > "$RESP" 2> "$ERR"; then',
    '    echo "  skipped sub-window $((i + 1)): $(head -n 1 "$ERR")" >&2',
    '    continue',
    '  fi',
    '  n=$(wc -l < "$RESP" | tr -d " ")',
    '  # Only name a part file once there is something to put in it: an empty',
    '  # file would show up in the report as a source that contributed no bytes.',
    '  if [ "$n" -gt 0 ]; then cat "$RESP" >> "$(outfile "$STEM")"; fi',
    '  TOTAL=$((TOTAL + n))',
    '  printf "sub-window %2d/%d — %d lines so far\\n" "$((i + 1))" "${#BUCKET_FROM[@]}" "$TOTAL" >&2',
    'done',
    '',
    renderFooter(outputDir),
    '',
  ].join('\n');

  assertNoVendorHost(script, 'splunk');

  return {
    siem: 'splunk',
    displayName: 'Splunk',
    filename: 'export-sample.sh',
    script,
    bucketCount: SPLUNK_BUCKET_COUNT,
    perBucketCap,
    targetEventCount: opts.targetEventCount,
    window: opts.window,
    outputDir,
    requires: ['curl'],
    credentials: ['SPLUNK_HOST', 'SPLUNK_TOKEN'],
    apiCalls: ['POST /services/search/jobs/export'],
    pocFromLocalArgs: {
      source: 'file',
      paths: ['/data'],
      siem: 'splunk',
      window: opts.window,
      per_pod_limit: POC_PER_FILE_LIMIT,
      max_pods: POC_MAX_FILES,
    },
    notes: [
      'Composition is per index, not per sourcetype: the export lands one set of part files for the ' +
        'index in `scope`. Run the script once per index when the mix across indexes matters.',
      'Events Splunk stores with embedded newlines arrive as several lines here, the same shape a ' +
        'forwarder reads them in.',
    ],
  };
}
