/**
 * Elasticsearch / OpenSearch export-plan emitter.
 *
 * Mirrors `lib/siem/elasticsearch.ts`: 24 stratified sub-windows, the same
 * per-bucket cap, a `range` query on `@timestamp`, `search_after` paging
 * sorted by `@timestamp` ascending, and `track_total_hits: false`. OpenSearch
 * speaks the same dialect on all of it, so one emitter serves both and the
 * only thing that changes is the label on the report.
 *
 * Two read-only endpoints: `_cat/indices` to resolve the index pattern into
 * concrete indices (so the report can attribute bytes per index), and
 * `_search` for the events.
 *
 * Request bodies are built with `jq -n`, never by pasting values into a JSON
 * string. The user's scope and filter reach the cluster as JSON values, so a
 * filter containing a quote is a filter, not a broken request.
 */

import {
  ELASTICSEARCH_BUCKET_COUNT,
  ELASTICSEARCH_DEFAULT_INDEX,
  ELASTICSEARCH_PAGE_SIZE,
} from '../elasticsearch.js';
import {
  assertNoVendorHost,
  planBuckets,
  renderBucketArrays,
  renderFooter,
  renderHeader,
  renderOutfileHelper,
  renderPreflight,
  renderCurlHeaders,
  renderScratch,
  CURL_HEADERS_RATIONALE,
  shQuote,
  DEFAULT_OUTPUT_DIR,
  POC_MAX_FILES,
  POC_PER_FILE_LIMIT,
  type SamplePlan,
  type SamplePlanOptions,
} from './_shared.js';

/** Ceiling on how many concrete indices one script will walk. */
const MAX_INDICES = 100;

type Flavor = 'elasticsearch' | 'opensearch';

const LABEL: Record<Flavor, string> = {
  elasticsearch: 'Elasticsearch',
  opensearch: 'OpenSearch',
};

/** Credential env vars, per flavor. Both accept the ES names as a fallback. */
const ENV_PREFIX: Record<Flavor, string> = {
  elasticsearch: 'ELASTIC',
  opensearch: 'OPENSEARCH',
};

export function emitElasticsearchPlan(opts: SamplePlanOptions, flavor: Flavor = 'elasticsearch'): SamplePlan {
  const outputDir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  const { buckets, perBucketCap, fromMs, toMs } = planBuckets(opts, ELASTICSEARCH_BUCKET_COUNT);
  const indexPattern = opts.scope || ELASTICSEARCH_DEFAULT_INDEX;
  const label = LABEL[flavor];
  const prefix = ENV_PREFIX[flavor];
  const urlVar = `${prefix}_URL`;
  const apiKeyVar = `${prefix}_API_KEY`;
  const userVar = `${prefix}_USERNAME`;
  const passVar = `${prefix}_PASSWORD`;

  // The optional filter becomes a second `must` clause, exactly as the
  // connector does it. Rendered as a jq argument so the value stays a value.
  const extraMust = opts.query
    ? `--argjson extra ${shQuote(JSON.stringify([{ query_string: { query: opts.query } }]))}`
    : '--argjson extra \'[]\'';

  const header = renderHeader({
    displayName: label,
    apiSummary:
      'GET  _cat/indices  (which indices the pattern below resolves to)\n' +
      'POST _search       (the documents themselves)\n' +
      'Both are read-only. No index, template or pipeline is created.',
    credentialSummary:
      `${urlVar}, plus ${apiKeyVar} or ${userVar}/${passVar} from this shell.\n` +
      `They are sent to ${urlVar} and to nowhere else.`,
    writes:
      `${outputDir}/<index>.NN.log — one document message per line, plain text.\n` +
      'Nothing else is written outside that directory.',
    window: opts.window,
    bucketCount: ELASTICSEARCH_BUCKET_COUNT,
    perBucketCap,
    targetEventCount: opts.targetEventCount,
    fromMs,
    toMs,
    buckets,
    extra: [
      `Index pattern: ${indexPattern}  (up to ${MAX_INDICES} concrete indices)`,
      opts.query ? `Filter (query_string): ${opts.query}` : 'No filter: every document in range.',
      'Message field: the first of `message`, `log`, `@message` present on the',
      'document; a document with none is written as its own JSON, so nothing is',
      'silently dropped from the byte accounting.',
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
    `PAGE_SIZE=${ELASTICSEARCH_PAGE_SIZE}`,
    `INDEX_PATTERN=${shQuote(indexPattern)}`,
    '',
    renderPreflight(
      ['curl', 'jq'],
      [{ name: urlVar, hint: `set ${urlVar} to your cluster endpoint, e.g. https://es.internal:9200` }],
    ),
    '',
    `URL="\${${urlVar}%/}"`,
    '',
    "CURL_OPTS=(--silent --show-error --fail -H 'Accept: application/json')",
    '',
    renderScratch(['curl_headers', 'batch']),
    '',
    CURL_HEADERS_RATIONALE,
    '# Auth itself is optional: a dev cluster with security disabled needs',
    '# neither branch, and an empty header file is a valid header file.',
    ':> "$CURL_HEADERS"',
    `if [ -n "\${${apiKeyVar}:-}" ]; then`,
    renderCurlHeaders(
      [{ header: 'Authorization: ApiKey %s', value: `"\${${apiKeyVar}}"` }],
      { indent: '  ', rationale: false },
    ),
    `elif [ -n "\${${userVar}:-}" ] && [ -n "\${${passVar}:-}" ]; then`,
    // Basic auth as a header rather than `--user`: `--user` has no
    // read-from-file form, so the password would land in argv.
    renderCurlHeaders(
      [
        {
          header: 'Authorization: Basic %s',
          value: `"$(printf '%s:%s' "\${${userVar}}" "\${${passVar}}" | base64 | tr -d '\\n')"`,
        },
      ],
      { indent: '  ', rationale: false },
    ),
    'fi',
    'mkdir -p "$OUT_DIR"',
    '',
    renderOutfileHelper(),
    '',
    renderBucketArrays(buckets, 'iso'),
    '',
    '# ── 1. Which indices the pattern resolves to (read-only) ───────────────',
    'curl "${CURL_OPTS[@]}" -H @"$CURL_HEADERS" \\',
    '  "$URL/_cat/indices/$INDEX_PATTERN?h=index&format=json" > "$RESP"',
    `jq -r '.[].index' < "$RESP" | sort | head -n ${MAX_INDICES} > "$TMPDIR_RUN/indices"`,
    '',
    'INDEX_COUNT=$(wc -l < "$TMPDIR_RUN/indices" | tr -d " ")',
    'if [ "$INDEX_COUNT" -eq 0 ]; then',
    '  echo "index pattern $INDEX_PATTERN matched no indices; nothing to export" >&2',
    '  exit 1',
    'fi',
    'echo "indices in scope: $INDEX_COUNT" >&2',
    '',
    '# ── 2. Read documents, sub-window by sub-window (read-only) ────────────',
    'TOTAL=0',
    'for i in "${!BUCKET_FROM[@]}"; do',
    '  if [ "$TOTAL" -ge "$TARGET" ]; then break; fi',
    '  remaining=$BUCKET_CAP',
    '  while IFS= read -r index; do',
    '    if [ -z "$index" ]; then continue; fi',
    '    if [ "$remaining" -le 0 ] || [ "$TOTAL" -ge "$TARGET" ]; then break; fi',
    '    stem=$(printf "%s" "$index" | sed -e "s#[^A-Za-z0-9._-]#-#g")',
    '    after="null"',
    '    while [ "$remaining" -gt 0 ]; do',
    '      size=$remaining',
    '      if [ "$size" -gt "$PAGE_SIZE" ]; then size=$PAGE_SIZE; fi',
    '      body=$(jq -n \\',
    '        --arg from "${BUCKET_FROM[$i]}" \\',
    '        --arg to "${BUCKET_TO[$i]}" \\',
    '        --argjson size "$size" \\',
    '        --argjson after "$after" \\',
    `        ${extraMust} \\`,
    '        \'{ query: { bool: { must: ([{ range: { "@timestamp": { gte: $from, lte: $to } } }] + $extra) } },',
    '           size: $size,',
    '           sort: [ { "@timestamp": "asc" } ],',
    '           track_total_hits: false }',
    '         + (if $after == null then {} else { search_after: $after } end)\')',
    '      if ! curl "${CURL_OPTS[@]}" -H @"$CURL_HEADERS" \\',
    '          -H "Content-Type: application/json" \\',
    '          -X POST "$URL/$index/_search" \\',
    '          --data-binary "$body" > "$RESP" 2> "$ERR"; then',
    '        echo "  skipped $index in sub-window $((i + 1)): $(head -n 1 "$ERR")" >&2',
    '        break',
    '      fi',
    '      hits=$(jq -r \'.hits.hits | length\' < "$RESP")',
    '      if [ "$hits" -eq 0 ]; then break; fi',
    '      jq -r \'.hits.hits[]._source',
    '             | (.message // .log // ."@message" // (. | tojson))\' < "$RESP" > "$BATCH"',
    '      # Only name a part file once there is something to put in it: an empty',
    '      # file would show up in the report as a source that contributed no bytes.',
    '      if [ -s "$BATCH" ]; then cat "$BATCH" >> "$(outfile "$stem")"; fi',
    '      after=$(jq -c \'.hits.hits[-1].sort\' < "$RESP")',
    '      remaining=$((remaining - hits))',
    '      TOTAL=$((TOTAL + hits))',
    '      if [ "$hits" -lt "$size" ]; then break; fi',
    '      if [ "$TOTAL" -ge "$TARGET" ]; then break; fi',
    '    done',
    '  done < "$TMPDIR_RUN/indices"',
    '  printf "sub-window %2d/%d — %d documents so far\\n" "$((i + 1))" "${#BUCKET_FROM[@]}" "$TOTAL" >&2',
    'done',
    '',
    renderFooter(outputDir),
    '',
  ].join('\n');

  assertNoVendorHost(script, flavor);

  return {
    siem: flavor,
    displayName: label,
    filename: 'export-sample.sh',
    script,
    bucketCount: ELASTICSEARCH_BUCKET_COUNT,
    perBucketCap,
    targetEventCount: opts.targetEventCount,
    window: opts.window,
    outputDir,
    // `base64` and `tr` are used only by the basic-auth branch, which encodes
    // the credential pair into an Authorization header rather than passing
    // `--user` (which has no read-from-file form, so the password would land in argv).
    requires: ['curl', 'jq', 'base64', 'tr'],
    credentials: [urlVar, `${apiKeyVar} or ${userVar}/${passVar} (optional)`],
    apiCalls: ['GET _cat/indices', 'POST _search'],
    pocFromLocalArgs: {
      source: 'file',
      paths: ['/data'],
      siem: 'elasticsearch',
      window: opts.window,
      per_pod_limit: POC_PER_FILE_LIMIT,
      max_pods: POC_MAX_FILES,
    },
    notes: [
      'Composition is per index: the report will name each index that contributed bytes.',
      'Sources share one budget per sub-window, so a chatty index can fill it before the quieter ' +
        'ones are reached — the same behaviour the live connector has, and one more reason to check the ' +
        'composition table in the report before trusting the projection.',
      'Paging sorts on `@timestamp` alone, as the connector does — documents sharing a timestamp at a ' +
        'page boundary can repeat or be skipped. It is a rounding error at POC scale, not a correctness ' +
        'claim to lean on.',
      'A cluster that stores its log body under a different field needs that field added to the `jq` ' +
        'expression in the script; it is one line and it is visible.',
    ],
  };
}
