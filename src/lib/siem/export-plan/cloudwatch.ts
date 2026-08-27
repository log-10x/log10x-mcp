/**
 * CloudWatch Logs export-plan emitter.
 *
 * Mirrors `lib/siem/cloudwatch.ts`: DescribeLogGroups to resolve scope, then
 * FilterLogEvents per (sub-window × log group) with the same 24-bucket
 * stratified sample and the same per-bucket cap. Both read-only.
 *
 * One file per log group (rolled into parts), so the report's sample-
 * composition table still says which log group each slice of bytes came
 * from — the question the prospect has to answer before the savings number
 * means anything.
 */

import {
  CLOUDWATCH_BUCKET_COUNT,
} from '../cloudwatch.js';
import {
  assertNoVendorHost,
  planBuckets,
  renderBucketArrays,
  renderFooter,
  renderHeader,
  renderOutfileHelper,
  renderPreflight,
  renderScratch,
  shQuote,
  DEFAULT_OUTPUT_DIR,
  POC_MAX_FILES,
  POC_PER_FILE_LIMIT,
  type SamplePlan,
  type SamplePlanOptions,
} from './_shared.js';

/** Ceiling on how many log groups one script will walk. */
const MAX_LOG_GROUPS = 200;

export function emitCloudwatchPlan(opts: SamplePlanOptions): SamplePlan {
  const outputDir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  const { buckets, perBucketCap, fromMs, toMs } = planBuckets(opts, CLOUDWATCH_BUCKET_COUNT);

  // A wildcard scope is a NAME PREFIX to CloudWatch, not a glob: the API has
  // no wildcard matching, and the connector strips the asterisks before
  // calling DescribeLogGroups. Do the same here so `/aws/ecs/*` means the
  // same thing in both places.
  const prefix = (opts.scope ?? '').replace(/\*/g, '');
  const describeArgs = prefix
    ? `--log-group-name-prefix ${shQuote(prefix)} `
    : '';

  const filterArg = opts.query ? `\\\n        --filter-pattern ${shQuote(opts.query)} ` : '';

  const header = renderHeader({
    displayName: 'Amazon CloudWatch Logs',
    apiSummary:
      'logs:DescribeLogGroups  (which log groups exist under the scope below)\n' +
      'logs:FilterLogEvents    (the log events themselves)\n' +
      'Both are read-only. Nothing is created, tagged or deleted.',
    credentialSummary:
      'whatever the `aws` CLI on this machine already uses — AWS_PROFILE,\n' +
      'AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, SSO cache or an instance\n' +
      'role. This script neither reads nor copies them.',
    writes:
      `${outputDir}/<log-group>.NN.log — one log message per line, plain text.\n` +
      'Nothing else is written outside that directory.',
    window: opts.window,
    bucketCount: CLOUDWATCH_BUCKET_COUNT,
    perBucketCap,
    targetEventCount: opts.targetEventCount,
    fromMs,
    toMs,
    buckets,
    extra: [
      prefix
        ? `Scope: log groups whose name starts with ${prefix}`
        : `Scope: every log group in the region, up to ${MAX_LOG_GROUPS}.`,
      opts.query ? `Filter pattern: ${opts.query}` : 'No filter pattern: every event in range.',
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
    'REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"',
    '',
    renderPreflight(['aws', 'jq'], []),
    '',
    renderScratch(['batch']),
    'mkdir -p "$OUT_DIR"',
    '',
    renderOutfileHelper(),
    '',
    renderBucketArrays(buckets, 'epoch_ms'),
    '',
    '# ── 1. Which log groups are in scope (read-only) ───────────────────────',
    'aws logs describe-log-groups \\',
    `  --region "$REGION" \\`,
    `  ${describeArgs}\\`,
    `  --max-items ${MAX_LOG_GROUPS} \\`,
    "  --query 'logGroups[].logGroupName' --output text \\",
    "  | tr '\\t' '\\n' | sed '/^$/d' > \"$TMPDIR_RUN/groups\"",
    '',
    'GROUP_COUNT=$(wc -l < "$TMPDIR_RUN/groups" | tr -d " ")',
    'if [ "$GROUP_COUNT" -eq 0 ]; then',
    '  echo "no log groups matched the scope; nothing to export" >&2',
    '  exit 1',
    'fi',
    'echo "log groups in scope: $GROUP_COUNT" >&2',
    '',
    '# ── 2. Read events, sub-window by sub-window (read-only) ───────────────',
    'TOTAL=0',
    'for i in "${!BUCKET_FROM[@]}"; do',
    '  if [ "$TOTAL" -ge "$TARGET" ]; then break; fi',
    '  remaining=$BUCKET_CAP',
    '  while IFS= read -r group; do',
    '    if [ -z "$group" ]; then continue; fi',
    '    if [ "$remaining" -le 0 ] || [ "$TOTAL" -ge "$TARGET" ]; then break; fi',
    '    stem=$(printf "%s" "$group" | sed -e "s#^/##" -e "s#[^A-Za-z0-9._-]#-#g")',
    '    if ! aws logs filter-log-events \\',
    '        --region "$REGION" \\',
    '        --log-group-name "$group" \\',
    '        --start-time "${BUCKET_FROM[$i]}" \\',
    '        --end-time "${BUCKET_TO[$i]}" \\',
    `        --max-items "$remaining" ${filterArg}\\`,
    '        --output json > "$RESP" 2> "$ERR"; then',
    '      echo "  skipped $group in sub-window $((i + 1)): $(head -n 1 "$ERR")" >&2',
    '      continue',
    '    fi',
    "    jq -r '.events[].message' < \"$RESP\" > \"$BATCH\"",
    '    n=$(wc -l < "$BATCH" | tr -d " ")',
    '    # Only name a part file once there is something to put in it: an empty',
    '    # file would show up in the report as a source that contributed no',
    '    # bytes, which reads as a finding and is an artefact.',
    '    if [ "$n" -gt 0 ]; then cat "$BATCH" >> "$(outfile "$stem")"; fi',
    '    remaining=$((remaining - n))',
    '    TOTAL=$((TOTAL + n))',
    '  done < "$TMPDIR_RUN/groups"',
    '  printf "sub-window %2d/%d — %d lines so far\\n" "$((i + 1))" "${#BUCKET_FROM[@]}" "$TOTAL" >&2',
    'done',
    '',
    renderFooter(outputDir),
    '',
  ].join('\n');

  assertNoVendorHost(script, 'cloudwatch');

  return {
    siem: 'cloudwatch',
    displayName: 'Amazon CloudWatch Logs',
    filename: 'export-sample.sh',
    script,
    bucketCount: CLOUDWATCH_BUCKET_COUNT,
    perBucketCap,
    targetEventCount: opts.targetEventCount,
    window: opts.window,
    outputDir,
    requires: ['aws', 'jq'],
    credentials: ['AWS_PROFILE / AWS_ACCESS_KEY_ID / SSO cache / instance role', 'AWS_REGION'],
    apiCalls: ['logs:DescribeLogGroups', 'logs:FilterLogEvents'],
    pocFromLocalArgs: {
      source: 'file',
      paths: ['/data'],
      siem: 'cloudwatch',
      window: opts.window,
      per_pod_limit: POC_PER_FILE_LIMIT,
      max_pods: POC_MAX_FILES,
    },
    notes: [
      'Composition is per log group: the report will name each log group that contributed bytes.',
      'A log group the credentials cannot read is skipped with a warning; the rest still export.',
      'Sources share one budget per sub-window, so a chatty log group can fill it before the quieter ' +
        'ones are reached — the same behaviour the live connector has, and one more reason to check the ' +
        'composition table in the report before trusting the projection.',
    ],
  };
}
