/**
 * Shared rendering machinery for the offline export-plan emitters.
 *
 * The emitters render a shell script the USER runs, outside the fence, with
 * the user's own credentials. Four properties are load-bearing, and every
 * helper here exists to hold one of them:
 *
 *   1. **The script draws the same sample the live connector draws.** Bucket
 *      count, per-bucket cap and page size come from the connector modules
 *      (`CLOUDWATCH_BUCKET_COUNT` and friends), not from constants retyped
 *      here. A fenced POC and a credentialed POC over the same window should
 *      differ because the logs differ, never because two samplers disagreed.
 *
 *   2. **A reviewer can read it once and be done.** The calls are
 *      stereotyped: a fixed preflight, a fixed loop, one read-only API per
 *      script. Bucket ranges are rendered as literal timestamps in a comment
 *      table so the reviewer can see the whole time footprint without running
 *      anything, and every value that came from tool arguments is
 *      single-quoted through `shQuote`.
 *
 *   3. **Nothing in it points at us.** No log10x hostname appears in any
 *      emitted script; `assertNoVendorHost` enforces that at render time and
 *      a regression test enforces it per SIEM.
 *
 *   4. **Credentials never reach argv.** `renderCurlHeaders` writes them to a
 *      0700 scratch file that the EXIT trap removes, because `ps` shows every
 *      user on the machine every argument of every process. The live
 *      connectors send these headers inside an HTTP client, and the script
 *      should not leak what the credentialed path does not.
 *
 * Output shape: plain text, one log message per line, one file per source the
 * vendor API already enumerates. Plain text rather than JSONL because
 * `log10x_poc_from_local`'s multi-file lane feeds lines to the templater
 * verbatim — a JSON wrapper there gets tokenized as if the wrapper were the
 * log (the measured requirement in `lib/local-file-source.ts`), so the
 * unwrapping belongs in this script, in `jq`, where the user can see it.
 */

import { randomTimeBuckets, perBucketCap, type SamplingBucket } from '../_sampling.js';
import { parseWindowMs } from '../index.js';

/** SIEMs with an export-plan emitter. The rest are listed as follow-ups. */
export const EXPORT_PLAN_SIEMS = [
  'cloudwatch',
  'splunk',
  'elasticsearch',
  'opensearch',
  'datadog',
] as const;

export type ExportPlanSiemId = (typeof EXPORT_PLAN_SIEMS)[number];

/**
 * SIEMs a fenced POC cannot export from yet. Named rather than silently
 * absent: a prospect on ClickHouse should be told "not this one, here is
 * what exists" instead of watching their SIEM fail an enum check.
 */
export const EXPORT_PLAN_FOLLOW_UPS: ReadonlyArray<{ id: string; displayName: string }> = [
  { id: 'clickhouse', displayName: 'ClickHouse' },
  { id: 'azure-monitor', displayName: 'Azure Monitor' },
  { id: 'coralogix', displayName: 'Coralogix' },
  { id: 'gcp-logging', displayName: 'Google Cloud Logging' },
  { id: 'sumo', displayName: 'Sumo Logic' },
];

/** Default target, deliberately identical to `log10x_poc_from_siem`'s. */
export const DEFAULT_TARGET_EVENT_COUNT = 1_000_000;

/** Where the emitted scripts write, relative to the user's working directory. */
export const DEFAULT_OUTPUT_DIR = './poc/logs';

export interface SamplePlanOptions {
  siem: ExportPlanSiemId;
  /** `1h`, `24h`, `7d`, `14d`, `30d` — same grammar as the connectors. */
  window: string;
  targetEventCount: number;
  /** SIEM-native resource scope: log-group prefix, index, index pattern. */
  scope?: string;
  /** SIEM-native filter layered on top of `scope`. */
  query?: string;
  outputDir?: string;
  /** Injected by tests so golden files are stable. Defaults to now. */
  nowMs?: number;
  /** Injected by tests so bucket offsets are stable. Defaults to Math.random. */
  rng?: () => number;
}

export interface SamplePlan {
  siem: ExportPlanSiemId;
  displayName: string;
  /** Suggested filename for the script. */
  filename: string;
  /** The script itself. */
  script: string;
  bucketCount: number;
  perBucketCap: number;
  targetEventCount: number;
  window: string;
  outputDir: string;
  /** Command-line tools the script needs on the user's machine. */
  requires: string[];
  /** Credential environment variables the script reads. */
  credentials: string[];
  /** Read-only API operations the script calls, for the review pass. */
  apiCalls: string[];
  /**
   * Arguments to hand `log10x_poc_from_local` afterwards, sized so the
   * whole exported sample is read rather than a fraction of it.
   */
  pocFromLocalArgs: Record<string, unknown>;
  notes: string[];
}

/**
 * Quote a value for POSIX shell single-quoting.
 *
 * Every tool argument that reaches a rendered script goes through here. A
 * scope of `'; curl evil.example` is then a log-group name that matches
 * nothing, which is the correct outcome — the emitted script is text the user
 * reads before running, and a value that could rewrite the script's structure
 * would defeat the reading.
 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Strip a value down to something safe to use as a filename stem. */
export function fileStem(value: string): string {
  const cleaned = value
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'logs';
}

/**
 * Domain labels that make a hostname ours.
 *
 * The check below is about HOSTNAMES, not about the word. A script may say
 * "log10x fenced POC" in its header — the user should know what wrote the
 * file they are about to read — but it must never carry an address that
 * resolves to us, because the one thing the emitted script promises is that
 * it talks to the user's own analyzer and to nothing else.
 */
const VENDOR_DOMAIN_LABELS = ['log10x', 'log-10x', 'tenx', '10x'];

/**
 * Anything shaped like a hostname: an optional scheme, then dot-separated
 * labels ending in a TLD. Deliberately loose — a false positive here is a
 * build failure a developer fixes in a minute, and a false negative is a
 * broken promise in the one artifact the user was told to read.
 */
const HOSTNAME_SHAPED = /(?:https?:\/\/)?(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;

/**
 * Refuse to return a script that would contact us.
 *
 * The guarantee the fenced profile sells is that the export step reaches the
 * user's analyzer and no one else. A log10x address in the emitted text would
 * break that guarantee where it is least likely to be noticed and most
 * damaging to find later, so it is a render-time failure, not a lint warning.
 */
export function assertNoVendorHost(script: string, siem: string): void {
  for (const match of script.match(HOSTNAME_SHAPED) ?? []) {
    const host = match.replace(/^https?:\/\//, '').toLowerCase();
    const labels = host.split('.');
    if (labels.some((label) => VENDOR_DOMAIN_LABELS.includes(label))) {
      throw new Error(
        `export-plan emitter for "${siem}" produced a script naming the host "${match}". ` +
          `Emitted scripts must reach the user's analyzer and nothing else.`,
      );
    }
  }
}

export interface BucketPlan {
  buckets: SamplingBucket[];
  perBucketCap: number;
  fromMs: number;
  toMs: number;
}

/**
 * Build the bucket plan for a script, using the same sampler the connectors
 * use. Draws once, at emit time, so the rendered script carries literal
 * timestamps a reviewer can read instead of a randomizer they would have to
 * trust.
 */
export function planBuckets(
  opts: SamplePlanOptions,
  bucketCount: number,
): BucketPlan {
  const windowMs = parseWindowMs(opts.window);
  const toMs = opts.nowMs ?? Date.now();
  const fromMs = toMs - windowMs;
  return {
    buckets: randomTimeBuckets(fromMs, toMs, bucketCount, opts.rng),
    perBucketCap: perBucketCap(opts.targetEventCount, bucketCount),
    fromMs,
    toMs,
  };
}

/** `2026-08-27 13:04:11Z` — readable in a comment, unambiguous in a log. */
export function humanTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

export interface HeaderInput {
  displayName: string;
  apiSummary: string;
  credentialSummary: string;
  writes: string;
  window: string;
  bucketCount: number;
  perBucketCap: number;
  targetEventCount: number;
  fromMs: number;
  toMs: number;
  buckets: SamplingBucket[];
  /** Extra lines appended to the header, e.g. per-SIEM caveats. */
  extra?: string[];
}

/**
 * The header every emitted script carries.
 *
 * It answers the three questions a security reviewer asks in order — what
 * does it read, what does it write, what else does it do — and then prints
 * the sampling footprint as literal times so the third answer ("nothing") is
 * checkable against the body below it.
 */
/**
 * Emit a labelled block: the label on the first line, aligned continuation on
 * the rest. Repeating "API:" down the left margin reads as three separate
 * facts when it is one.
 */
function pushLabelled(lines: string[], label: string, body: string): void {
  const bodyLines = body.split('\n');
  const head = `${label}:`.padEnd(LABEL_WIDTH, ' ');
  const pad = ' '.repeat(LABEL_WIDTH);
  lines.push(`#   ${head}${bodyLines[0]}`);
  for (const line of bodyLines.slice(1)) lines.push(`#   ${pad}${line}`);
}

/** Column the header's labelled blocks align their text at. */
const LABEL_WIDTH = 13;

export function renderHeader(h: HeaderInput): string {
  const lines: string[] = [];
  lines.push(`# Sample export for ${h.displayName} — log10x fenced POC, step 2 of 4.`);
  lines.push('#');
  lines.push('# WHAT THIS READS');
  pushLabelled(lines, 'API', h.apiSummary);
  pushLabelled(lines, 'Credentials', h.credentialSummary);
  pushLabelled(lines, 'Window', `${humanTime(h.fromMs)} .. ${humanTime(h.toMs)}  (${h.window})`);
  pushLabelled(
    lines,
    'Sampling',
    `${h.bucketCount} random sub-windows, up to ${h.perBucketCap.toLocaleString('en-US')} events each,\n` +
      `stopping at ${h.targetEventCount.toLocaleString('en-US')} events total.`,
  );
  lines.push('#');
  lines.push('# WHAT THIS WRITES');
  for (const line of h.writes.split('\n')) lines.push(`#   ${line}`);
  lines.push('#');
  lines.push('# WHAT ELSE IT DOES');
  lines.push('#   Nothing. The only host it contacts is the one named above, nothing is');
  lines.push('#   uploaded, and no vendor address appears anywhere in this file. The');
  lines.push('#   container that analyses these files afterwards starts with --network none');
  lines.push('#   and cannot send them anywhere either.');
  if (h.extra && h.extra.length > 0) {
    lines.push('#');
    for (const line of h.extra) lines.push(`#   ${line}`);
  }
  lines.push('#');
  lines.push('# SUB-WINDOWS SAMPLED');
  for (const b of h.buckets) {
    lines.push(
      `#   ${String(b.index + 1).padStart(2, ' ')}. ${humanTime(b.fromMs)} .. ${humanTime(b.toMs)}`,
    );
  }
  return lines.join('\n');
}

/**
 * Preflight block: refuse early and by name when a tool or credential is
 * missing, rather than half-writing an output directory and failing on the
 * first API call.
 */
export function renderPreflight(bins: string[], requiredEnv: Array<{ name: string; hint: string }>): string {
  const lines: string[] = [];
  lines.push('need() {');
  lines.push('  command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }');
  lines.push('}');
  for (const b of bins) lines.push(`need ${b}`);
  for (const e of requiredEnv) {
    lines.push(`: "\${${e.name}:?${e.hint}}"`);
  }
  return lines.join('\n');
}

/**
 * Render the bucket ranges as two shell arrays.
 *
 * `unit` picks the literal form the vendor API wants: CloudWatch takes epoch
 * milliseconds, everything else takes ISO-8601. Both forms are followed by a
 * comment carrying the human-readable range, so the arrays stay reviewable
 * even in the epoch-millisecond case.
 */
export function renderBucketArrays(buckets: SamplingBucket[], unit: 'epoch_ms' | 'iso'): string {
  const fromValues: string[] = [];
  const toValues: string[] = [];
  for (const b of buckets) {
    if (unit === 'epoch_ms') {
      fromValues.push(String(b.fromMs));
      toValues.push(String(b.toMs));
    } else {
      fromValues.push(shQuote(new Date(b.fromMs).toISOString()));
      toValues.push(shQuote(new Date(b.toMs).toISOString()));
    }
  }
  return [
    `BUCKET_FROM=(${fromValues.join(' ')})`,
    `BUCKET_TO=(${toValues.join(' ')})`,
  ].join('\n');
}

/**
 * Per-file ceilings the emitted scripts roll at.
 *
 * `log10x_poc_from_local`'s multi-file lane reads at most `per_pod_limit`
 * lines and 16 MB from each file it is given (`sampleFromFiles` →
 * `readStridedFileLines`); above either ceiling it strides, and a strided read
 * of one enormous file covers less of the pattern space than whole reads of
 * several. So the export script rolls to a new part file before it reaches
 * the ceiling, and the whole sample is read rather than sampled twice.
 *
 * 45,000 lines sits under the tool's 50,000-line maximum; 15 MB sits under
 * its 16 MB byte cap. At the default one-million-event target that is roughly
 * 23 part files, comfortably inside the 200-file maximum.
 */
export const MAX_LINES_PER_FILE = 45_000;
export const MAX_BYTES_PER_FILE = 15_000_000;

/** `per_pod_limit` to pass to `log10x_poc_from_local` — its schema maximum. */
export const POC_PER_FILE_LIMIT = 50_000;
/** `max_pods` to pass to `log10x_poc_from_local` — its schema maximum. */
export const POC_MAX_FILES = 200;

/**
 * Shell helper that names the file the next batch appends to, rolling to a
 * new part when the current one reaches either ceiling above.
 *
 * Stateless on purpose: it derives the part number from what is already on
 * disk rather than keeping a per-source counter. bash 3.2 (still the system
 * bash on macOS) has no associative arrays, and a helper a reviewer can read
 * top to bottom beats one that needs a data structure explained.
 */
export function renderOutfileHelper(): string {
  return [
    `MAX_LINES_PER_FILE=${MAX_LINES_PER_FILE}`,
    `MAX_BYTES_PER_FILE=${MAX_BYTES_PER_FILE}`,
    '',
    '# Name the part file the next batch appends to, rolling when the current',
    '# part is full. Parts keep the source name so the report can still say',
    '# which log group / index / service each slice of the sample came from.',
    'outfile() {',
    '  stem="$1"',
    '  part=1',
    '  while :; do',
    '    f="$OUT_DIR/$stem.$(printf "%02d" "$part").log"',
    '    if [ ! -f "$f" ]; then printf "%s" "$f"; return; fi',
    '    lines=$(wc -l < "$f" | tr -d " ")',
    '    bytes=$(wc -c < "$f" | tr -d " ")',
    '    if [ "$lines" -lt "$MAX_LINES_PER_FILE" ] && [ "$bytes" -lt "$MAX_BYTES_PER_FILE" ]; then',
    '      printf "%s" "$f"; return',
    '    fi',
    '    part=$((part + 1))',
    '  done',
    '}',
  ].join('\n');
}

/**
 * Scratch directory + cleanup trap. Every emitter buffers one API response at
 * a time here rather than in a shell variable, so a 50,000-event page does
 * not become a 25 MB string in the shell's memory.
 *
 * `extra` names the additional scratch paths a given script uses. Declared
 * per script rather than all at once: an unused variable in a file whose
 * whole value is being readable in one pass is a question the reader has to
 * answer for nothing.
 */
export function renderScratch(extra: Array<'curl_headers' | 'batch'> = []): string {
  const lines = [
    'TMPDIR_RUN=$(mktemp -d)',
    `trap 'rm -rf "$TMPDIR_RUN"' EXIT`,
    'RESP="$TMPDIR_RUN/response"',
    'ERR="$TMPDIR_RUN/stderr"',
  ];
  if (extra.includes('curl_headers')) lines.push('CURL_HEADERS="$TMPDIR_RUN/headers"');
  if (extra.includes('batch')) lines.push('BATCH="$TMPDIR_RUN/batch"');
  return lines.join('\n');
}

/**
 * Write the credential-bearing headers to a file and hand curl `-H @file`
 * instead of `-H "Authorization: ..."`.
 *
 * Two reasons, and both are about the same thing — a script whose claim is
 * that it handles credentials carefully should not handle them carelessly.
 *
 * Arguments are visible in `ps` to every user on the machine. The live
 * connectors send these headers inside an HTTP client, where they never touch
 * a command line; a script that put a Splunk bearer token or a Datadog
 * application key in argv would leak a credential the SIEM path does not.
 *
 * And the file holds RAW header lines, not curl config directives. `--config`
 * was the first shape this took and it is a trap: curl's config parser accepts
 * `option: value` as well as `option = value`, so an unquoted
 * `header = DD-API-KEY: abc` is read as the option `header` with an empty
 * value and the header silently never goes out — measured against curl 8.7.1.
 * The quoted form works but then processes backslash escapes inside the value,
 * so a token containing one would arrive mangled. `-H @file` has no quoting
 * rules at all: one header per line, verbatim.
 *
 * Values are substituted by `printf`, not by a shell heredoc, so nothing in a
 * token is expanded on the way in. The file lives in the `mktemp -d` scratch
 * directory, which is 0700 and removed by the EXIT trap.
 *
 * Each entry is a header line with one `%s`, and the shell expression that
 * fills it: `{ header: 'Authorization: Bearer %s', value: '"$SPLUNK_TOKEN"' }`.
 */
export interface CurlHeaderEntry {
  header: string;
  value: string;
}

export const CURL_HEADERS_RATIONALE = [
  '# Credentials go in a file, not on the command line: argv is readable by',
  '# every user on the machine through `ps`. The file holds raw header lines',
  '# (curl -H @file), sits inside the 0700 scratch directory, and the EXIT',
  '# trap above removes it.',
].join('\n');

export function renderCurlHeaders(
  entries: CurlHeaderEntry[],
  opts: { indent?: string; rationale?: boolean } = {},
): string {
  const indent = opts.indent ?? '';
  const lines = [
    ...(opts.rationale === false ? [] : [CURL_HEADERS_RATIONALE]),
    '(',
    '  umask 077',
    ...entries.map((e) => `  printf '${e.header}\\n' ${e.value}`),
    ') > "$CURL_HEADERS"',
  ];
  return lines
    .flatMap((block) => block.split('\n'))
    .map((line) => (line.length > 0 ? indent + line : line))
    .join('\n');
}

/**
 * The closing block every script shares: report what landed on disk, and name
 * the next step without naming a host.
 */
export function renderFooter(outputDir: string): string {
  return [
    'echo "" >&2',
    `echo "wrote \$(ls -1 ${shQuote(outputDir)} | wc -l | tr -d ' ') file(s) to ${outputDir}" >&2`,
    `du -sh ${shQuote(outputDir)} >&2`,
    'echo "Next: start the fenced container and run the POC over these files." >&2',
  ].join('\n');
}
