/**
 * Shared pattern-extraction lib — run a batch of events through the engine.
 *
 * Used by log10x_resolve_batch and log10x_poc_from_siem_submit. Both tools feed
 * raw log lines through this and get back a structured list of per-pattern
 * records with aggregated counts, bytes, severity, service, and sample
 * event bodies.
 *
 * Always runs the local 10x engine (a locally-installed `tenx` binary, or
 * local Docker via LOG10X_TENX_MODE=docker). Events never leave the machine.
 *
 * Under the hood this uses the existing dev-cli + cli-output-parser
 * machinery so the engine contract stays single-source.
 */

import {
  runDevCli,
  runDevCliFileOutput,
  DevCliNotInstalledError, DockerNotAvailableError,
  verifyRoundTrip,
  stripEncodedAnchors,
  type RoundTripResult,
} from './dev-cli.js';
import {
  ASSUMED_RECORD_OVERHEAD_BYTES,
  RECEIVER_WINDOW_SECONDS,
  jsonStringBodyBytes,
  type ReceiverBytesBasis,
} from './receiver-bytes.js';
import { runChunkedTemplater } from './poc-chunked-templater.js';
import {
  parseTemplates,
  parseEncoded,
  parseAggregated,
  type Template,
  type EncodedEvent,
  type AggregatedRow,
} from './cli-output-parser.js';

export interface ExtractedPattern {
  /**
   * Engine's internal templateHash — the templater's structural
   * fingerprint of the field-set. Used as an INTERNAL join key
   * between encoded events and their template body. NEVER use this
   * as a user-facing identity or in mute YAML: the receiver does not
   * match against templateHash (it matches `symbolMessage` or
   * `tenx_hash`). Mute targets must use `symbolMessage` (preferred)
   * or `tenxHash` (patternHash) below.
   */
  hash: string;
  /**
   * Engine-emitted Reporter-tier pattern name (symbol-lookup result).
   * Bound per-event via the `pattern=` anchor on the encoded line
   * when the engine's `apps/mcp/stdout` config emits it. This is the
   * default receiver match key (`compactReceiverFieldNames:
   * [symbolMessage]`) and the preferred user-facing identity.
   */
  symbolMessage?: string;
  /**
   * Engine-emitted xxHash64 (11-char base64url) of `symbolMessage`,
   * carried per-event via the `patternHash=` anchor. Same key the
   * forwarder enrichment writes to the `tenx_hash` field on events.
   * Acts as the secondary mute target when symbolMessage isn't
   * available (receiver must be configured with
   * `compactReceiverFieldNames: [tenx_hash]`).
   */
  tenxHash?: string;
  /** Template body with `$` marking variable slots. */
  template: string;
  /**
   * Dominant service label, from the envelope of the events bound to this
   * pattern. A record is bound to its input line by position, re-synchronised
   * on the template's literal ends where the engine dropped a line; a record
   * whose ends match no line nearby stays unbound and carries no service.
   */
  service?: string;
  /** Dominant severity (uppercase standard form). */
  severity?: string;
  /** Number of events in this batch matching the pattern. */
  count: number;
  /** Total bytes across all matching events. */
  bytes: number;
  /**
   * Bytes of the records as they arrived, before any unwrapping, summed over
   * the bound events: the size a forwarder sends and a platform bills. Only
   * present when the caller supplied `lineRawBytes`.
   */
  rawBytes?: number;
  /**
   * Total bytes that would ship over the wire if these events were
   * encoded by the engine. Sum of the raw `encoded.log` line bytes
   * (`~hash,val,val,...` + newline) across this pattern's events.
   * Measured, not estimated. Used to compute the real compact-byte
   * ratio in Section 6.
   *
   * Optional: missing on older CLI builds without anchored encoded
   * layout. Consumers treat missing as 0.
   */
  encodedBytes?: number;
  /** One representative raw event (from the first encoded match). */
  sampleEvent: string;
  /** Per-slot captured values (slot name or positional index → distinct values observed, capped at 20 samples). */
  variables: Record<string, string[]>;
  /**
   * Per-slot TRUE distinct-value count, not capped. The `variables`
   * field holds at most 20 sample values to keep payloads bounded;
   * this field carries the real cardinality measurement from the
   * templater. Use this for unbounded-slot detection — `variables[k].length`
   * is the sample size, not the cardinality.
   */
  slotDistinctCounts?: Record<string, number>;
  /** Epoch ms of the earliest event seen in the pulled window. `undefined` when no envelope timestamps were available. */
  firstSeenMs?: number;
  /** Epoch ms of the latest event seen in the pulled window. */
  lastSeenMs?: number;
  /**
   * Per-hour event counts within the pulled window. Keyed by epoch-hour
   * (Math.floor(timestampMs / 3_600_000)). Used by `poc-enrichers` to
   * compute growth rate, last-24h-vs-window-average acceleration, and
   * a 24-bucket trajectory.
   */
  eventsByHour?: Record<number, number>;
  /**
   * Events and bytes per envelope (service, status, split attribute) value,
   * from the records bound to their input line. Present only when the caller
   * asked for `cells`.
   */
  cells?: PatternCell[];
  /**
   * Bytes the Receiver's regulator counts for these events, summed: each
   * record as the forwarder sends it, metadata included, continuation lines
   * joined into the head record (see `receiver-bytes.ts`).
   */
  receiverBytes?: number;
  /**
   * The largest `receiverBytes` within any 240-second interval, when the
   * events carry times: the busiest window whatever its alignment, so a cap
   * set from it holds wherever the Receiver's window falls.
   */
  receiverPeakWindowBytes?: number;
  /** The extraction's timed span in seconds, which the peak's rate is taken over. */
  receiverSpanSeconds?: number;
  /**
   * The bytes a cap compares against, over the capture: the Receiver's
   * counter for this statement (its message pattern in its container, every
   * template that shares them), at its busiest window's rate over the timed
   * span when that is higher than its total. A cap set from it holds that
   * window. Templates of one counter carry the same value, so rows that merge
   * take the larger, never the sum.
   */
  receiverCapBytes?: number;
}

/** One envelope combination a pattern's events arrived with. */
export interface PatternCell {
  service?: string;
  /** The status as the platform stored it (Datadog: `info`, `warn`, `error`, ...). */
  status?: string;
  /** A parsed attribute from SPLIT_ATTRIBUTES, when the event carried one. */
  attribute?: { name: string; value: string };
  count: number;
  bytes: number;
}

/**
 * Parsed attributes that name the emitting code inside a service. Datadog's
 * Java integration pipelines (Kafka among them) parse the logger into the
 * standard attribute `logger.name`, so a filter per value is the native split
 * below the service.
 */
export const SPLIT_ATTRIBUTES = ['logger.name'] as const;

/** Services whose Datadog integration log pipeline parses the log4j logger at the end of a line into `logger.name`. */
export const LOGGER_NAME_PIPELINE_SERVICES = ['kafka'] as const;

const LOG4J_LOGGER = /\(([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\)\s*$/;

/**
 * The `logger.name` Datadog's Kafka log pipeline parses from an event that
 * reached the file before intake: the class in parentheses that ends the first
 * of the event's lines to end that way (the head line before a stack trace,
 * the last line of a multi-line message). Undefined for other services and for
 * events with no such line.
 */
export function pipelineSplitAttribute(
  service: string | undefined,
  lines: readonly string[],
): { name: string; value: string } | undefined {
  if (!service || !(LOGGER_NAME_PIPELINE_SERVICES as readonly string[]).includes(service)) return undefined;
  for (const line of lines) {
    for (const part of line.split('\n')) {
      const m = LOG4J_LOGGER.exec(part);
      if (m) return { name: 'logger.name', value: m[1] };
    }
  }
  return undefined;
}

export interface ExtractedPatterns {
  patterns: ExtractedPattern[];
  totalEvents: number;
  totalBytes: number;
  /** How `receiverBytes` was reached: measured on the forwarder's records, or the payload plus an assumed metadata size. */
  receiverBytesBasis?: ReceiverBytesBasis;
  /** The metadata bytes assumed per record on the assumed path. */
  recordOverheadBytes?: number;
  /** Seconds between the first and last event time, when the events carry times. */
  receiverTimedSpanSeconds?: number;
  /** Events whose split attribute came from `pipelineSplitAttribute`, when it was passed. */
  pipelineParsedEvents?: number;
  /** Number of raw input lines the caller passed in. */
  inputLineCount: number;
  /** Wall time spent in the engine (CLI). */
  templaterWallTimeMs: number;
  /** Always `local_cli` — the engine runs on the caller's machine. */
  executionMode: 'local_cli';
  /**
   * Which engine build actually produced the numbers: `tenx 1.1.32 (edge)`
   * for the host binary, `docker log10x/pipeline-10x:latest` otherwise.
   *
   * Recorded because the docker default tag is mutable. A report generated
   * against one `:latest` was not reproducible against another, and the
   * output said nothing about which build had run. Surfaced in the report's
   * methodology block so the engine identity travels with the numbers.
   */
  engineBuild?: string;
  /**
   * Fraction of patterns that resolved a severity, 0..1. Feeds the
   * fail-closed guard: when the engine emits no severity, every pattern
   * reads as reducible and the ERROR safety rail cannot fire.
   */
  severityCoverage: number;
  /**
   * Whether the engine's records reconciled against the input lines by count
   * alone. When false, binding re-synchronised on template ends; the two
   * counts below say how many records were bound and how many were not.
   */
  positionalBindingExact: boolean;
  /** Input lines submitted, and the line count the engine's records account for. */
  inputLinesSubmitted: number;
  inputLinesAccountedFor: number;
  /** Records bound to an input line, records whose binding re-synchronised, and records left unbound. */
  recordsBound?: number;
  recordsResynced?: number;
  recordsUnbound?: number;
  /**
   * The decode pass over this run's output compared with its input, when
   * `verifyRoundTrip` was asked for.
   */
  roundTrip?: RoundTripResult;
}

export interface ExtractPatternsOptions {
  /**
   * When true, route the engine run through the file-output engine app
   * (@apps/mcp-file)
   * instead of the stdout-based @apps/mcp. The CLI writes templates,
   * encoded events, and aggregated rows to disk; the parser reads
   * them after the process exits. Scales to multi-million-event pulls
   * because no stdout buffering is involved.
   *
   * Use this for SIEM POC pulls. Default false to preserve existing
   * `resolve_batch` semantics for small paste-style inputs.
   */
  useFileOutput?: boolean;
  /**
   * When true (with `useFileOutput=true`),
   * split the input into chunks and run multiple tenx processes in
   * parallel. Each chunk gets its own LOG10X_MCP_RUNTIME_NAME so
   * output directories don't clash; outputs are merged by
   * templateHash + tenx_hash. Cuts wall time roughly linearly with
   * core count on multi-million-event pulls.
   *
   * Default false. Enable for SIEM POC pulls > 100MB.
   */
  chunkParallel?: boolean;
  /** Target chunk size in bytes when chunkParallel=true. Default 32MB. */
  chunkTargetBytes?: number;
  /** Parallelism cap when chunkParallel=true. Default min(cpus-1, 8). */
  chunkParallelism?: number;
  /**
   * When true, coerceObjectToLine does NOT recurse into nested JSON.
   * For events whose structured-field variance lives in the envelope
   * (e.g., CloudWatch fluentd-wrapped events with kubernetes labels
   * embedded in the message field), the recursive descent would strip
   * the envelope and lose all that signal. With preserveEnvelope=true,
   * the function stops after the first unwrap and returns the JSON
   * string of the envelope so the templater sees the full structure
   * and extracts slots from across it.
   * Default: false (back-compat).
   */
  preserveEnvelope?: boolean;
  /**
   * Hint: the upstream caller already knows the bucket's pattern_hash
   * (e.g., pattern_examples queries by it). Older engine builds do not
   * anchor `patternHash=` on encoded lines, so `rec.tenxHash` ends up
   * undefined and the defensive value-based filter on the slot loop
   * cannot fire. Pass this hint to feed the filter regardless.
   * Default: undefined.
   */
  bucketHashHint?: string;
  /**
   * The on-disk byte size of each event, aligned with `events`, for callers
   * that unwrapped a record before handing it over. Summed per pattern into
   * `rawBytes`.
   */
  lineRawBytes?: number[];
  /** Keep per-pattern envelope cells (`ExtractedPattern.cells`). */
  cells?: boolean;
  /**
   * With `cells`: the split attribute a platform pipeline would parse from an
   * event's lines, for events whose envelope carries none (records read before
   * the platform's intake). Called with the event's service and lines.
   */
  pipelineSplitAttribute?: (service: string | undefined, lines: readonly string[]) => { name: string; value: string } | undefined;
  /**
   * The forwarder's records, aligned with `events`: each record's compact
   * JSON bytes, and its payload's bytes as a JSON string body. With both,
   * `receiverBytes` is measured; without, it is the payload plus
   * `recordOverheadBytes` per record.
   */
  lineRecordBytes?: Array<number | undefined>;
  linePayloadJsonBytes?: Array<number | undefined>;
  /** Metadata bytes assumed per record when the records are not supplied. Default `ASSUMED_RECORD_OVERHEAD_BYTES`. */
  recordOverheadBytes?: number;
  /** Each event's time in epoch ms, aligned with `events`; a gap takes the previous event's time. */
  lineTimesMs?: Array<number | undefined>;
  /**
   * Decode the compact records the engine wrote and compare them with the
   * text it was given, one more engine run. Not run on a chunked run, where
   * the output is spread over several directories.
   */
  verifyRoundTrip?: boolean;
}

/**
 * The literal text at a template's two ends, with the engine's escaping
 * undone: `$` marks a variable slot, `$(...)` a timestamp slot, and `/`
 * escapes the next character. `prefix` is the text before the first slot
 * and `suffix` the text after the last one; a template with no slot has the
 * whole text as both.
 */
export function templateEnds(template: string): { prefix: string; suffix: string; lines: number } {
  let prefix = '';
  let suffix = '';
  let slots = 0;
  let i = 0;
  const n = template.length;
  while (i < n) {
    const c = template[i];
    if (c === '/' && i + 1 < n) {
      if (slots === 0) prefix += template[i + 1]; else suffix += template[i + 1];
      i += 2;
      continue;
    }
    if (c === '$') {
      slots += 1;
      suffix = '';
      i += 1;
      if (i < n && template[i] === '(') {
        const close = template.indexOf(')', i);
        if (close >= 0 && close <= i + 40 && !template.slice(i, close).includes('"')) i = close + 1;
      } else {
        // `$N` repeats the value N slots back; the digits are part of the slot.
        while (i < n && template[i] >= '0' && template[i] <= '9') i += 1;
      }
      continue;
    }
    if (slots === 0) prefix += c; else suffix += c;
    i += 1;
  }
  if (slots === 0) suffix = prefix;
  return { prefix, suffix, lines: template.split('\n').length };
}

/**
 * Bind each encoded record to the input line it starts on. Records come back
 * in input order, each spanning the lines its template folds, so a cursor
 * walk binds them by position. Where the engine dropped a line the walk
 * re-synchronises on the template's literal ends: the text before the first
 * slot starts the record's first line and the text after the last slot ends
 * its last line. A record whose ends match nothing within `lookahead` lines
 * stays unbound and the cursor moves on by the record's span.
 */
export function bindRecordsToLines(
  records: Array<{ templateHash: string }>,
  templates: Map<string, { template: string }>,
  lines: string[],
  lookahead = 64,
): { head: Array<number | undefined>; bound: number; resyncs: number; unbound: number } {
  const ends = new Map<string, { prefix: string; suffix: string; lines: number }>();
  const head: Array<number | undefined> = new Array(records.length);
  let cursor = 0;
  let bound = 0;
  let resyncs = 0;
  let unbound = 0;
  const matches = (e: { prefix: string; suffix: string; lines: number }, at: number): boolean => {
    if (at + e.lines > lines.length) return false;
    const first = e.prefix.split('\n')[0];
    const last = e.suffix.slice(e.suffix.lastIndexOf('\n') + 1);
    return lines[at].startsWith(first) && lines[at + e.lines - 1].endsWith(last);
  };
  for (let i = 0; i < records.length; i++) {
    const tpl = templates.get(records[i].templateHash);
    let e = tpl ? ends.get(records[i].templateHash) : undefined;
    if (!e && tpl) {
      e = templateEnds(tpl.template);
      ends.set(records[i].templateHash, e);
    }
    const span = e?.lines ?? 1;
    let found: number | undefined;
    if (!e) {
      found = cursor < lines.length ? cursor : undefined;
    } else {
      const stop = Math.min(lines.length, cursor + lookahead + 1);
      for (let j = cursor; j < stop; j++) {
        if (matches(e, j)) { found = j; break; }
      }
    }
    if (found === undefined) {
      unbound += 1;
      head[i] = undefined;
      cursor += span;
    } else {
      if (found !== cursor) resyncs += 1;
      bound += 1;
      head[i] = found;
      cursor = found + span;
    }
  }
  return { head, bound, resyncs, unbound };
}

/**
 * Templatize a batch of events and return structured pattern records.
 *
 * `events` may contain raw strings, objects with a `text`/`message`/`log`
 * field, or JSON lines. Everything gets stringified into newline-separated
 * raw text before submission.
 */
export async function extractPatterns(
  events: unknown[],
  opts: ExtractPatternsOptions = {}
): Promise<ExtractedPatterns> {
  // Pair each line with an "enrichment" record extracted from the envelope
  // before we drop it. Fluent-bit / k8s envelopes carry service and severity
  // labels the templated text loses, so we keep them alongside for later
  // aggregation into per-pattern service/severity.
  const coerceOpts = { preserveEnvelope: opts.preserveEnvelope };
  const pairs = events
    .map((e, idx) => {
      const line = coerceToLine(e, coerceOpts);
      const enrichment = typeof e === 'object' && e !== null
        ? extractEnrichmentFromEnvelope(e as Record<string, unknown>)
        : {};
      return {
        line,
        enrichment,
        rawBytes: opts.lineRawBytes?.[idx],
        recordBytes: opts.lineRecordBytes?.[idx],
        payloadJsonBytes: opts.linePayloadJsonBytes?.[idx],
        timeMs: opts.lineTimesMs?.[idx],
      };
    })
    .filter((p) => p.line && p.line.trim().length > 0);
  const lines = pairs.map((p) => p.line);
  const enrichments = pairs.map((p) => p.enrichment);
  const rawLineBytes = pairs.map((p) => p.rawBytes);
  // The Receiver's unit: a line's forwarder record when the caller holds it,
  // else its payload plus the assumed metadata per record.
  const hasRecord = (p: (typeof pairs)[number]): boolean =>
    typeof p.recordBytes === 'number' && typeof p.payloadJsonBytes === 'number';
  const measuredRecords = pairs.length > 0 && pairs.every(hasRecord);
  const recordOverhead = opts.recordOverheadBytes ?? ASSUMED_RECORD_OVERHEAD_BYTES;
  // Event times: the caller's, else the envelope's; a gap takes the previous
  // line's time (a capture is in arrival order).
  const lineTimes: Array<number | undefined> = [];
  let lastTime: number | undefined;
  for (const p of pairs) {
    const t = opts.lineTimesMs ? p.timeMs : p.enrichment.timestampMs;
    if (typeof t === 'number' && Number.isFinite(t)) lastTime = t;
    lineTimes.push(lastTime);
  }
  let minTime: number | undefined;
  let maxTime: number | undefined;

  if (lines.length === 0) {
    return {
      patterns: [],
      totalEvents: 0,
      totalBytes: 0,
      inputLineCount: 0,
      templaterWallTimeMs: 0,
      executionMode: 'local_cli',
      severityCoverage: 0,
      positionalBindingExact: true,
      inputLinesSubmitted: 0,
      inputLinesAccountedFor: 0,
      recordsBound: 0,
      recordsResynced: 0,
      recordsUnbound: 0,
    };
  }

  const mergedTemplates = new Map<string, Template>();
  const mergedEncoded: EncodedEvent[] = [];
  const mergedAggregated: AggregatedRow[] = [];
  let totalWallTimeMs = 0;
  let engineBuild: string | undefined;
  let roundTrip: RoundTripResult | undefined;
  const executionMode = 'local_cli' as const;

  // The local 10x engine absorbs the full batch in one shot.
  {
    const text = lines.join('\n');
    try {
      // useFileOutput routes through @apps/mcp-file (engine writes
      // templates/encoded/aggregated to disk, parser reads after
      // exit). chunkParallel layers chunked parallelism on top — for
      // GB-scale inputs, splits to N concurrent tenx processes and
      // merges outputs by templateHash + tenx_hash. The stdin-based
      // runDevCli stays default for resolve_batch back-compat.
      const local = opts.chunkParallel && opts.useFileOutput
        ? await runChunkedTemplater(text, {
            parallelism: opts.chunkParallelism,
            chunkTargetBytes: opts.chunkTargetBytes,
          })
        : opts.useFileOutput
        ? await runDevCliFileOutput(text)
        : await runDevCli(text);
      engineBuild = local.cliVersion;
      for (const [hash, tpl] of parseTemplates(local.templatesJson)) {
        mergedTemplates.set(hash, tpl);
      }
      // Avoid `arr.push(...other)` — V8's function-argument limit
      // (~65k args) overflows on 400k+ event batches with
      // "Maximum call stack size exceeded". A plain loop scales.
      for (const ev of parseEncoded(local.encodedLog)) mergedEncoded.push(ev);
      for (const row of parseAggregated(local.aggregatedCsv)) mergedAggregated.push(row);
      totalWallTimeMs += local.wallTimeMs;
      if (opts.verifyRoundTrip) {
        roundTrip = await roundTripOf(text, local, Boolean(opts.chunkParallel && opts.useFileOutput));
      }
    } catch (e) {
      if (e instanceof DevCliNotInstalledError || e instanceof DockerNotAvailableError) throw e;
      throw new Error(`Local tenx CLI run failed: ${(e as Error).message}`);
    }
  }

  // Build the pattern records.
  const byHash = new Map<string, {
    count: number;
    bytes: number;
    rawBytes: number;
    receiverBytes: number;
    receiverEvents: Array<[number, number]>;
    encodedBytes: number;
    sampleEvent: string;
    variables: Map<string, Set<string>>;
    lineIndices: number[];
    services: Map<string, number>;
    severities: Map<string, number>;
    firstSeenMs?: number;
    lastSeenMs?: number;
    eventsByHour: Map<number, number>;
    cells: Map<string, PatternCell>;
    // Reporter-tier message_pattern + tenx_hash, read directly off the
    // engine's anchored encoded line (`pattern=,<symbolMessage>,patternHash=,<tenxHash>`).
    // Per-template they're constant; we just keep the first non-empty.
    symbolMessage?: string;
    tenxHash?: string;
  }>();

  // Envelope enrichment is paired to patterns BY POSITION: encoded record i
  // is assumed to be input line i. The engine does not guarantee that. Two
  // mechanisms break it, and both are real:
  //
  //   1. Multi-line grouping folds continuation lines into one record, so a
  //      grouped template spans `1 + newlines` input lines.
  //   2. The engine drops some lines outright. Across 3,000 CloudWatch
  //      events: 2,970 records for 3,000 inputs with ZERO grouped templates,
  //      so span expansion does not recover it. 17 of the 30 were events
  //      with an empty `log` field; the rest are unaccounted.
  //
  // Expanding by span reconciles case 1 exactly (verified at 30,000/30,000 on
  // envelope-shaped input). When the totals still disagree, position is not a
  // key and anything derived from it is a guess. Rather than publish a skewed
  // service breakdown, drop envelope-derived attribution and say so — the
  // same fail-closed rule severity coverage already follows.
  let expectedLines = 0;
  for (const ev of mergedEncoded) {
    const t = mergedTemplates.get(ev.templateHash);
    expectedLines += t ? 1 + (t.template.split('\n').length - 1) : 1;
  }
  const positionalBindingExact = expectedLines === lines.length;
  // Where the totals disagree, the walk re-synchronises on each template's
  // literal ends instead of dropping attribution for every record.
  const binding = bindRecordsToLines(mergedEncoded, mergedTemplates, lines);

  let cursor = 0;
  let pipelineParsedEvents = 0;
  for (let i = 0; i < mergedEncoded.length; i++) {
    const ev = mergedEncoded[i];
    const rec = byHash.get(ev.templateHash) || {
      count: 0,
      bytes: 0,
      rawBytes: 0,
      receiverBytes: 0,
      receiverEvents: [],
      encodedBytes: 0,
      sampleEvent: '',
      variables: new Map<string, Set<string>>(),
      lineIndices: [],
      services: new Map<string, number>(),
      severities: new Map<string, number>(),
      eventsByHour: new Map<number, number>(),
      cells: new Map<string, PatternCell>(),
    };
    rec.count += 1;
    const bytesBefore = rec.bytes;
    // Measured encoded-line bytes for this event (the `~hash,val,val,...`
    // line plus newline). cli-output-parser computes this per-event;
    // we sum it into the pattern record for the real compact-byte ratio.
    if (typeof ev.lineBytes === 'number') rec.encodedBytes += ev.lineBytes;
    // Span this record covers in the input: the whole group when the engine
    // folded continuation lines into it, otherwise one line.
    const tplForSpan = mergedTemplates.get(ev.templateHash);
    const span = tplForSpan ? 1 + (tplForSpan.template.split('\n').length - 1) : 1;
    // The line this record starts on: the bound line where the walk matched
    // the template's ends, the running position otherwise.
    const head = binding.head[i];
    cursor = head ?? cursor;
    // Raw bytes are the sum over every input line this record covers, so a
    // grouped stack trace is charged its real size instead of its head line.
    const eventLines: ReceiverLine[] = [];
    for (let k = 0; k < span; k++) {
      const raw = cursor + k < lines.length ? lines[cursor + k] : undefined;
      if (!raw) continue;
      rec.bytes += Buffer.byteLength(raw, 'utf8');
      rec.rawBytes += rawLineBytes[cursor + k] ?? Buffer.byteLength(raw, 'utf8');
      if (!rec.sampleEvent) rec.sampleEvent = raw;
      rec.lineIndices.push(cursor + k);
      const pr = pairs[cursor + k];
      eventLines.push(hasRecord(pr) ? { line: raw, recordBytes: pr.recordBytes!, payloadJsonBytes: pr.payloadJsonBytes! } : { line: raw });
    }
    const eventReceiverBytes = eventReceiverSize(eventLines, recordOverhead);
    rec.receiverBytes += eventReceiverBytes;
    const eventTime = cursor < lineTimes.length ? lineTimes[cursor] : undefined;
    if (eventTime !== undefined && eventReceiverBytes > 0) {
      rec.receiverEvents.push([eventTime, eventReceiverBytes]);
      if (minTime === undefined || eventTime < minTime) minTime = eventTime;
      if (maxTime === undefined || eventTime > maxTime) maxTime = eventTime;
    }
    // Capture engine-emitted Reporter-tier name + hash from the first
    // event we see for this templateHash. They're constant per template
    // because `run/initialize/message` writes them as static fields on
    // the TenXTemplate.
    if (!rec.symbolMessage && ev.symbolMessage) rec.symbolMessage = ev.symbolMessage;
    if (!rec.tenxHash && ev.tenxHash) rec.tenxHash = ev.tenxHash;
    // Envelope-derived fields, taken from the HEAD line of the span. Skipped
    // entirely when the record/line totals did not reconcile: severity has an
    // identity-keyed source (the aggregated join on tenx_hash) and survives,
    // but service and first-seen have only this one, and a wrong service
    // breakdown is worse than an absent one.
    const enr = head !== undefined && head < enrichments.length ? enrichments[head] : undefined;
    cursor += span;
    if (enr?.service) rec.services.set(enr.service, (rec.services.get(enr.service) || 0) + 1);
    if (enr?.severity) rec.severities.set(enr.severity, (rec.severities.get(enr.severity) || 0) + 1);
    if (opts.cells && enr) {
      const parsed = !enr.attribute && opts.pipelineSplitAttribute
        ? opts.pipelineSplitAttribute(enr.service, eventLines.map((l) => l.line))
        : undefined;
      if (parsed) pipelineParsedEvents += 1;
      addPatternCell(rec.cells, parsed ? { ...enr, attribute: parsed } : enr, rec.bytes - bytesBefore);
    }
    if (typeof enr?.timestampMs === 'number') {
      const ts = enr.timestampMs;
      if (rec.firstSeenMs === undefined || ts < rec.firstSeenMs) rec.firstSeenMs = ts;
      if (rec.lastSeenMs === undefined || ts > rec.lastSeenMs) rec.lastSeenMs = ts;
      const hourBucket = Math.floor(ts / 3_600_000);
      rec.eventsByHour.set(hourBucket, (rec.eventsByHour.get(hourBucket) || 0) + 1);
    }

    const tpl = mergedTemplates.get(ev.templateHash);
    for (let s = 0; s < ev.values.length; s++) {
      const slotName = tpl?.variableSlots?.[s]?.name || `slot_${s}`;
      const set = rec.variables.get(slotName) || new Set<string>();
      set.add(ev.values[s]);
      rec.variables.set(slotName, set);
    }
    byHash.set(ev.templateHash, rec);
  }

  // Aggregated rows (one per unique enrichment-fields tuple, keyed by
  // tenx_hash internally). With the per-event symbolMessage already
  // bound above, the only thing we still mine from aggregated rows is
  // severity for the templates whose envelope didn't carry it.
  const aggByHash = new Map<string, AggregatedRow>();
  for (const r of mergedAggregated) {
    const h = r.raw['tenx_hash'];
    if (h) aggByHash.set(h, r);
  }

  const timedSpanSeconds =
    minTime !== undefined && maxTime !== undefined && maxTime > minTime ? (maxTime - minTime) / 1000 : undefined;
  const patterns: ExtractedPattern[] = [];
  // The Receiver keeps one counter per message pattern per container, so the
  // busiest window is measured over every template that shares both.
  const counterGroups = new Map<string, { events: Array<[number, number]>; bytes: number; members: ExtractedPattern[] }>();
  for (const [hash, rec] of byHash) {
    const tpl = mergedTemplates.get(hash);
    const body = tpl?.template || hash;
    // Severity priority: envelope majority > template hint > aggregated
    // lookup (keyed by tenx_hash now, no Jaccard).
    const envelopeMajorSeverity = majority(rec.severities);
    const aggMatch = rec.tenxHash ? aggByHash.get(rec.tenxHash) : undefined;
    const severity =
      envelopeMajorSeverity ||
      tpl?.severity ||
      aggMatch?.severity;

    const variables: Record<string, string[]> = {};
    const slotDistinctCounts: Record<string, number> = {};
    // rec.tenxHash is populated from the patternHash= anchor on encoded lines.
    // When that anchor is absent (older engine builds), fall back to the
    // aggregated CSV's tenx_hash column (already resolved in aggByHash above)
    // so the value-based guard below can still fire.
    const bucketTenxHash = rec.tenxHash ?? aggMatch?.raw['tenx_hash'] ?? opts.bucketHashHint;
    for (const [slot, set] of rec.variables) {
      // tenx_hash is the engine's internal pattern identity field — it is never
      // useful as a slot variance signal and must not appear in slot_distribution.
      if (slot === 'tenx_hash') continue;
      // Value-based guard: if the naming heuristic mis-labelled the tenx_hash
      // position with a nearby key name (e.g. kubernetes pod-template-hash label),
      // the slot will contain exactly one distinct value equal to the bucket's
      // canonical tenxHash.  Drop it regardless of its name.
      if (bucketTenxHash && set.size === 1 && set.has(bucketTenxHash)) continue;
      // Cap at 20 sample values per slot — enough for dependency
      // analysis, not enough to blow context. Carry the true
      // distinct count separately so downstream code can tell
      // "20 sampled, 20 actual" from "20 sampled, 47K actual".
      slotDistinctCounts[slot] = set.size;
      variables[slot] = Array.from(set).slice(0, 20);
    }

    // Service priority: envelope majority > sample-text regex.
    const envelopeMajorService = majority(rec.services);
    const service = envelopeMajorService || inferServiceFromSample(rec.sampleEvent, variables);

    patterns.push({
      hash,
      // Engine-emitted Reporter name read off the encoded line's
      // `pattern=` anchor. Falls back to whatever the aggregated row
      // says (older engine builds with no anchor support) — undefined
      // if neither path provided it.
      symbolMessage: rec.symbolMessage || aggMatch?.pattern || undefined,
      tenxHash: rec.tenxHash || undefined,
      template: body,
      severity: severity ? severity.toUpperCase() : undefined,
      service,
      count: rec.count,
      bytes: rec.bytes,
      ...(opts.lineRawBytes ? { rawBytes: rec.rawBytes } : {}),
      ...receiverFields(rec.receiverBytes, slidingWindowPeak(rec.receiverEvents), timedSpanSeconds),
      encodedBytes: rec.encodedBytes,
      sampleEvent: rec.sampleEvent,
      variables,
      slotDistinctCounts,
      firstSeenMs: rec.firstSeenMs,
      lastSeenMs: rec.lastSeenMs,
      eventsByHour: rec.eventsByHour.size > 0 ? Object.fromEntries(rec.eventsByHour) : undefined,
      ...(opts.cells ? { cells: [...rec.cells.values()] } : {}),
    });
    const made = patterns[patterns.length - 1];
    const groupKey = `${made.symbolMessage || hash}\u0000${made.service ?? ''}`;
    const g = counterGroups.get(groupKey) ?? { events: [], bytes: 0, members: [] };
    for (const e of rec.receiverEvents) g.events.push(e);
    g.bytes += rec.receiverBytes;
    g.members.push(made);
    counterGroups.set(groupKey, g);
  }
  for (const g of counterGroups.values()) {
    if (g.members.length < 2) continue;
    const group = receiverFields(g.bytes, slidingWindowPeak(g.events), timedSpanSeconds);
    for (const m of g.members) {
      if (group.receiverPeakWindowBytes !== undefined) m.receiverPeakWindowBytes = group.receiverPeakWindowBytes;
      m.receiverCapBytes = group.receiverCapBytes;
    }
  }

  patterns.sort((a, b) => b.count - a.count);

  const totalBytes = patterns.reduce((s, p) => s + p.bytes, 0);

  return {
    patterns,
    totalEvents: mergedEncoded.length,
    totalBytes,
    receiverBytesBasis: measuredRecords ? 'records' : 'assumed_overhead',
    ...(measuredRecords ? {} : { recordOverheadBytes: recordOverhead }),
    ...(timedSpanSeconds !== undefined ? { receiverTimedSpanSeconds: timedSpanSeconds } : {}),
    ...(opts.pipelineSplitAttribute ? { pipelineParsedEvents } : {}),
    inputLineCount: lines.length,
    templaterWallTimeMs: totalWallTimeMs,
    executionMode,
    engineBuild,
    severityCoverage:
      patterns.length === 0 ? 0 : patterns.filter((p) => p.severity).length / patterns.length,
    positionalBindingExact,
    inputLinesSubmitted: lines.length,
    inputLinesAccountedFor: expectedLines,
    recordsBound: binding.bound,
    recordsResynced: binding.resyncs,
    recordsUnbound: binding.unbound,
    ...(roundTrip ? { roundTrip } : {}),
  };
}

/**
 * The decode pass over one engine run. A failure of the pass is reported as
 * `not_run` with its message: the extraction already succeeded, and a proof
 * that could not run is not a proof that failed.
 */
async function roundTripOf(
  inputText: string,
  run: { templatesJson: string; encodedLog: string; compactLog?: string },
  chunked: boolean,
): Promise<RoundTripResult> {
  const notRun = (note: string): RoundTripResult => ({
    status: 'not_run',
    records: 0,
    inputLines: inputText === '' ? 0 : inputText.split('\n').length,
    decodedLines: 0,
    differingLines: 0,
    note,
  });
  if (chunked) return notRun('not run on a chunked engine run');
  const compactLog = run.compactLog && run.compactLog.length > 0 ? run.compactLog : stripEncodedAnchors(run.encodedLog);
  try {
    return await verifyRoundTrip({ inputText, templatesJson: run.templatesJson, compactLog });
  } catch (e) {
    if (e instanceof DevCliNotInstalledError) throw e;
    return notRun(`the decode pass failed: ${(e as Error).message.slice(0, 300)}`);
  }
}

/**
 * Collapse patterns that share the same `symbolMessage`.
 *
 * Why this exists: the engine emits one templateHash per distinct
 * field-set, but several field-sets can resolve to the same Reporter-tier
 * `symbolMessage` (e.g., the same log line with and without a trailing
 * variable slot, or audit logs that differ only by which optional fields
 * are populated). For a user-facing top-cost view the templateHash
 * distinction is noise: ten rows all named "Kind Event ApiVersion …"
 * with slightly different identities. From an action standpoint they
 * also collapse to one mute target (the receiver matches on
 * `symbolMessage`, not on templateHash).
 *
 * Pass each `ExtractedPattern[]` through this before rendering or
 * enriching. Patterns without a `symbolMessage` (older CLI) are left
 * as-is, keyed by their templateHash.
 */
export function collapseBySymbolMessage(patterns: ExtractedPattern[]): ExtractedPattern[] {
  const groups = new Map<string, ExtractedPattern[]>();
  for (const p of patterns) {
    const key = p.symbolMessage || p.hash;
    const list = groups.get(key) || [];
    list.push(p);
    groups.set(key, list);
  }
  const out: ExtractedPattern[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) { out.push(group[0]); continue; }
    out.push(mergeExtractedPatterns(group));
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

/**
 * Merge a group of ExtractedPatterns that share a symbolMessage.
 *
 * Numeric fields sum. Service/severity pick the value carried by the
 * highest-count member (majority by event volume). Variables union
 * across the group with a per-slot cap. Template body picks the
 * longest one (most informative when slot-counts differ).
 *
 * `hash` keeps the first member's templateHash so any downstream code
 * that joins back to templates.json still works for that representative.
 */
function mergeExtractedPatterns(group: ExtractedPattern[]): ExtractedPattern {
  const sorted = [...group].sort((a, b) => b.count - a.count);
  const head = sorted[0];
  // Representative template: pick the highest-count member's template,
  // not the longest. The longest-wins rule produced snippets that did
  // not match the user-facing identity (e.g., a Postgres DB error
  // template winning over a debug-exporter pattern just because the
  // DB template body had more bytes). The dominant template is the
  // one downstream consumers should grep against.
  const representativeTemplate = head.template;
  const variables: Record<string, string[]> = {};
  // Slot-level distinct counts: sum across merged group members. Upper
  // bound only (a value present in more than one member counts twice),
  // but a tight upper bound is the right honest framing because the
  // sample is capped at 20 per member and we can't dedupe beyond that.
  // Preserves the "unbounded" signal where every member sees high-
  // cardinality slots; the count never collapses to the sample cap.
  const mergedSlotDistinctCounts: Record<string, number> = {};
  for (const p of group) {
    for (const [slot, vals] of Object.entries(p.variables)) {
      const merged = variables[slot] ? new Set([...variables[slot], ...vals]) : new Set(vals);
      variables[slot] = Array.from(merged).slice(0, 20);
    }
    if (p.slotDistinctCounts) {
      for (const [slot, n] of Object.entries(p.slotDistinctCounts)) {
        mergedSlotDistinctCounts[slot] = (mergedSlotDistinctCounts[slot] ?? 0) + n;
      }
    }
  }
  // Merge first/last-seen across the group; union the per-hour buckets.
  let firstSeenMs: number | undefined;
  let lastSeenMs: number | undefined;
  const mergedEventsByHour: Record<number, number> = {};
  for (const p of group) {
    if (p.firstSeenMs !== undefined && (firstSeenMs === undefined || p.firstSeenMs < firstSeenMs)) {
      firstSeenMs = p.firstSeenMs;
    }
    if (p.lastSeenMs !== undefined && (lastSeenMs === undefined || p.lastSeenMs > lastSeenMs)) {
      lastSeenMs = p.lastSeenMs;
    }
    if (p.eventsByHour) {
      for (const [bucket, count] of Object.entries(p.eventsByHour)) {
        const k = Number(bucket);
        mergedEventsByHour[k] = (mergedEventsByHour[k] || 0) + count;
      }
    }
  }
  return {
    hash: head.hash,
    symbolMessage: head.symbolMessage,
    tenxHash: head.tenxHash,
    template: representativeTemplate,
    severity: head.severity,
    service: head.service,
    count: group.reduce((s, p) => s + p.count, 0),
    bytes: group.reduce((s, p) => s + p.bytes, 0),
    ...(group.every((p) => p.rawBytes !== undefined) ? { rawBytes: group.reduce((s, p) => s + (p.rawBytes ?? 0), 0) } : {}),
    ...(group.every((p) => p.receiverBytes !== undefined) ? mergeReceiverFields(group) : {}),
    encodedBytes: group.reduce((s, p) => s + (p.encodedBytes ?? 0), 0),
    sampleEvent: head.sampleEvent,
    variables,
    slotDistinctCounts: Object.keys(mergedSlotDistinctCounts).length > 0 ? mergedSlotDistinctCounts : undefined,
    firstSeenMs,
    lastSeenMs,
    eventsByHour: Object.keys(mergedEventsByHour).length > 0 ? mergedEventsByHour : undefined,
    ...(group.some((p) => p.cells) ? { cells: mergeCells(group) } : {}),
  };
}

/** One input line of an event, with its forwarder record's sizes when known. */
export interface ReceiverLine {
  line: string;
  recordBytes?: number;
  payloadJsonBytes?: number;
}

/**
 * One event's size as the Receiver counts it: one record, the head line's
 * whole record and then each continuation line's payload joined with an
 * escaped newline. A line with no record of its own counts as its text as a
 * JSON string body, plus `overhead` for the head.
 */
export function eventReceiverSize(lines: ReceiverLine[], overhead: number = ASSUMED_RECORD_OVERHEAD_BYTES): number {
  let total = 0;
  lines.forEach((l, i) => {
    const measured = typeof l.recordBytes === 'number' && typeof l.payloadJsonBytes === 'number';
    if (i === 0) total += measured ? l.recordBytes! : overhead + jsonStringBodyBytes(l.line);
    else total += 2 + (measured ? l.payloadJsonBytes! : jsonStringBodyBytes(l.line));
  });
  return total;
}

/**
 * The largest sum of bytes within any 240-second interval of the events'
 * times, or undefined when no event carries a time.
 */
export function slidingWindowPeak(events: Array<[number, number]>): number | undefined {
  if (events.length === 0) return undefined;
  const sorted = [...events].sort((a, b) => a[0] - b[0]);
  const span = RECEIVER_WINDOW_SECONDS * 1000;
  let left = 0;
  let sum = 0;
  let peak = 0;
  for (let right = 0; right < sorted.length; right++) {
    sum += sorted[right][1];
    while (sorted[right][0] - sorted[left][0] >= span) {
      sum -= sorted[left][1];
      left++;
    }
    if (sum > peak) peak = sum;
  }
  return peak;
}

/**
 * The receiver fields of one pattern. The cap's bytes are the larger of the
 * total and the peak window's rate over the timed span.
 */
function receiverFields(
  receiverBytes: number,
  peak: number | undefined,
  timedSpanSeconds: number | undefined,
): Pick<ExtractedPattern, 'receiverBytes' | 'receiverPeakWindowBytes' | 'receiverSpanSeconds' | 'receiverCapBytes'> {
  const atPeakRate = peak !== undefined && timedSpanSeconds ? (peak * timedSpanSeconds) / RECEIVER_WINDOW_SECONDS : 0;
  return {
    receiverBytes,
    ...(peak !== undefined ? { receiverPeakWindowBytes: peak } : {}),
    ...(timedSpanSeconds !== undefined ? { receiverSpanSeconds: timedSpanSeconds } : {}),
    receiverCapBytes: Math.max(receiverBytes, atPeakRate),
  };
}

/**
 * Merged members share a message pattern; members in one container already
 * carry their counter's figures, so the merge keeps the largest.
 */
function mergeReceiverFields(group: ExtractedPattern[]): ReturnType<typeof receiverFields> {
  const total = group.reduce((s, p) => s + (p.receiverBytes ?? 0), 0);
  const peaks = group.map((p) => p.receiverPeakWindowBytes).filter((v): v is number => v !== undefined);
  const span = group.find((p) => p.receiverSpanSeconds !== undefined)?.receiverSpanSeconds;
  return {
    receiverBytes: total,
    ...(peaks.length > 0 ? { receiverPeakWindowBytes: Math.max(...peaks) } : {}),
    ...(span !== undefined ? { receiverSpanSeconds: span } : {}),
    receiverCapBytes: Math.max(...group.map((p) => p.receiverCapBytes ?? p.receiverBytes ?? 0)),
  };
}

function cellKey(c: { service?: string; status?: string; attribute?: { name: string; value: string } }): string {
  return [c.service ?? '', c.status ?? '', c.attribute?.name ?? '', c.attribute?.value ?? ''].join('\u0000');
}

function mergeCells(group: ExtractedPattern[]): PatternCell[] {
  const out = new Map<string, PatternCell>();
  for (const p of group) {
    for (const c of p.cells ?? []) {
      const k = cellKey(c);
      const cur = out.get(k);
      if (cur) {
        cur.count += c.count;
        cur.bytes += c.bytes;
      } else {
        out.set(k, { ...c });
      }
    }
  }
  return [...out.values()];
}

/** Add one event to a pattern's cells, keyed by its envelope's service, status and split attribute. */
export function addPatternCell(
  cells: Map<string, PatternCell>,
  env: { service?: string; severity?: string; attribute?: { name: string; value: string } },
  bytes: number,
): void {
  const cell = { service: env.service, status: env.severity, attribute: env.attribute };
  const k = cellKey(cell);
  const cur = cells.get(k);
  if (cur) {
    cur.count += 1;
    cur.bytes += bytes;
  } else {
    cells.set(k, {
      ...(cell.service !== undefined ? { service: cell.service } : {}),
      ...(cell.status !== undefined ? { status: cell.status } : {}),
      ...(cell.attribute ? { attribute: cell.attribute } : {}),
      count: 1,
      bytes,
    });
  }
}

/** The envelope fields a cell is keyed by, read from one pulled event. */
export function envelopeCellOf(event: Record<string, unknown>): {
  service?: string;
  severity?: string;
  attribute?: { name: string; value: string };
} {
  const e = extractEnrichmentFromEnvelope(event);
  return {
    ...(e.service !== undefined ? { service: e.service } : {}),
    ...(e.severity !== undefined ? { severity: e.severity } : {}),
    ...(e.attribute ? { attribute: e.attribute } : {}),
  };
}

/** A SPLIT_ATTRIBUTES value, nested (`logger: {name}`) or flat (`"logger.name"`). */
function splitAttributeOf(attrs: Record<string, unknown>): { name: string; value: string } | undefined {
  for (const name of SPLIT_ATTRIBUTES) {
    const flat = attrs[name];
    if (typeof flat === 'string' && flat.length > 0) return { name, value: flat };
    let cur: unknown = attrs;
    for (const part of name.split('.')) {
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined;
    }
    if (typeof cur === 'string' && cur.length > 0) return { name, value: cur };
  }
  return undefined;
}

/**
 * Coerce an unknown value into a single log line.
 *
 * Log events arrive in three common shapes:
 *   1. **Raw string** — already a line, just strip newlines.
 *   2. **Flat JSON with a known text field** — `{message, text, log, body, _raw}`.
 *      Pull the text field and drop the envelope.
 *   3. **Fluent-bit / k8s envelope** — the log content is inside `.log`, but
 *      the envelope also carries `kubernetes.container_name`, service labels,
 *      etc. CloudWatch messages arriving from a fluent-bit forwarder come in
 *      this shape. Pulling just the `.log` field keeps the templater focused
 *      on the actual log content instead of templating the envelope itself.
 *
 * If the string at the text field itself looks like JSON (nested structured
 * log), try parsing it and extracting again. Fluent-bit can wrap JSON-in-JSON
 * one level deep.
 */
function coerceToLine(e: unknown, opts: { preserveEnvelope?: boolean } = {}): string {
  if (e == null) return '';
  if (typeof e === 'string') {
    // Try parsing as JSON — some connectors return the event as a pre-
    // stringified blob. If it parses as an object with a known text field,
    // descend once; otherwise treat as plain text.
    const trimmed = e.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          return coerceObjectToLine(parsed as Record<string, unknown>, opts);
        }
      } catch {
      // fall through — not valid JSON, treat as plain
      }
    }
    return e.replace(/\r?\n/g, ' ');
  }
  if (typeof e === 'number' || typeof e === 'boolean') return String(e);
  if (typeof e === 'object') {
    return coerceObjectToLine(e as Record<string, unknown>, opts);
  }
  return String(e);
}

function coerceObjectToLine(obj: Record<string, unknown>, opts: { preserveEnvelope?: boolean } = {}): string {
  // Common text-field candidates, in priority order. CloudWatch FilteredLogEvent
  // uses `message`; Datadog uses `attributes.message`; ES/fluent-bit uses `log`;
  // Splunk surfaces `_raw` which itself is often a JSON envelope.
  const attrs = (obj.attributes as Record<string, unknown> | undefined) || undefined;
  // Azure Log Analytics custom tables suffix string columns with `_s`
  // (e.g., `log` in the source becomes `log_s` in query results). Check
  // both forms so shipped fluent-bit envelopes unwrap either way.
  const cand =
    obj.text ||
    obj.message ||
    attrs?.message ||
    obj.log ||
    obj.log_s ||
    obj.body ||
    obj._raw ||
    obj.Message || // Azure KQL rows (PascalCase)
    obj.Message_s;
  if (typeof cand === 'string') {
    // If the candidate is itself a JSON envelope (common on Splunk `_raw`
    // and CloudWatch `message` fields from fluent-bit forwarders), descend
    // once more to unwrap. Keeps templating focused on the actual log text
    // instead of paying for 3× byte count.
    const t = cand.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      if (opts.preserveEnvelope) {
        // Keep the envelope structure intact — the templater should see the
        // full structured key set (kubernetes labels, container name, etc.)
        // rather than only the innermost log string.
        return t.replace(/\r?\n/g, ' ');
      }
      try {
        const nested = JSON.parse(t);
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
          const inner = coerceObjectToLine(nested as Record<string, unknown>, opts);
          if (inner) return inner;
        }
      } catch {
      // not JSON — fall through
      }
    }
    return cand.replace(/\r?\n/g, ' ');
  }
  // Nothing matched — stringify the whole thing so the templater at least
  // sees structured key names.
  try {
    return JSON.stringify(obj).replace(/\r?\n/g, ' ');
  } catch {
    return '';
  }
}

function tokenize(s: string): Set<string> {
  const parts = s.split(/[^A-Za-z0-9]+/).filter((t) => t.length >= 2).map((t) => t.toLowerCase());
  return new Set(parts);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function bestAggregatedMatch(
  body: string,
  aggregated: Array<{ row: AggregatedRow; tokens: Set<string> }>
): { row: AggregatedRow; similarity: number } | null {
  const bodyTokens = tokenize(body);
  let best: { row: AggregatedRow; similarity: number } | null = null;
  for (const { row, tokens } of aggregated) {
    const similarity = jaccard(bodyTokens, tokens);
    if (similarity > (best?.similarity ?? 0)) {
      best = { row, similarity };
    }
  }
  if (best && best.similarity >= 0.3) return best;
  return null;
}

interface EnvelopeEnrichment {
  service?: string;
  severity?: string;
  namespace?: string;
  pod?: string;
  /** Event timestamp in epoch milliseconds. Used to compute first-seen / last-seen / growth per pattern. */
  timestampMs?: number;
  /** A parsed SPLIT_ATTRIBUTES value (Datadog `attributes`). */
  attribute?: { name: string; value: string };
}

/**
 * Extract service + severity from a SIEM event envelope BEFORE we strip
 * it down to the log text. Different SIEMs carry these fields in different
 * places:
 *
 * - Fluent-bit / k8s: `kubernetes.container_name`, `kubernetes.labels["app.kubernetes.io/name"]`
 * - Datadog: `service`, `status`, plus `attributes.service`
 * - Splunk: `sourcetype` (often the service), `host`
 * - CloudWatch: nothing structured — service is inside the JSON `.log` body
 *   or inside a fluent-bit envelope nested there
 * - Azure KQL rows: `SeverityLevel`, `AppRoleName`
 *
 * Returns partial info; callers aggregate across all events for majority voting.
 */
function extractEnrichmentFromEnvelope(obj: Record<string, unknown>): EnvelopeEnrichment {
  const out: EnvelopeEnrichment = {};

  // Datadog shape
  if (typeof obj.service === 'string') out.service = obj.service;
  if (typeof obj.status === 'string') out.severity = obj.status;
  if (obj.attributes && typeof obj.attributes === 'object') {
    const attrs = obj.attributes as Record<string, unknown>;
    if (!out.service && typeof attrs.service === 'string') out.service = attrs.service;
    if (!out.severity && typeof attrs.status === 'string') out.severity = attrs.status;
    const attribute = splitAttributeOf(attrs);
    if (attribute) out.attribute = attribute;
  }

  // Timestamp extraction — each SIEM puts the event time somewhere different:
  //   Datadog: top-level `timestamp` (epoch ms) or `attributes.timestamp` (ISO 8601)
  //   Splunk: `_time` (ISO 8601)
  //   CloudWatch: `timestamp` (epoch ms) directly
  //   Elasticsearch: `@timestamp` (ISO 8601)
  //   Azure: `TimeGenerated` (ISO 8601)
  //   GCP: `timestamp` (ISO 8601)
  //   Sumo: `_messagetime` (epoch ms)
  const tryParseTs = (v: unknown): number | undefined => {
    if (typeof v === 'number' && v > 0) {
      // Guess s vs ms: epoch ms for 2001+ is > 1e12; below that is seconds.
      return v < 1e12 ? v * 1000 : v;
    }
    if (typeof v === 'string' && v.length > 0) {
      const parsed = Date.parse(v);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  };
  out.timestampMs =
    tryParseTs(obj.timestamp) ??
    tryParseTs(obj._time) ??
    tryParseTs(obj['@timestamp']) ??
    tryParseTs(obj.TimeGenerated) ??
    tryParseTs(obj._messagetime) ??
    (obj.attributes && typeof obj.attributes === 'object'
      ? tryParseTs((obj.attributes as Record<string, unknown>).timestamp)
      : undefined);

  // Fluent-bit / k8s envelope — check BEFORE the SIEM-specific fallbacks
  // (Splunk sourcetype, Azure role name) because when the envelope is
  // present it's the most specific service identifier — container name +
  // pod labels are authoritative, sourcetype like `_json` is generic.
  const kube = obj.kubernetes as Record<string, unknown> | undefined;
  if (kube && typeof kube === 'object') {
    if (!out.service) {
      const labels = kube.labels as Record<string, unknown> | undefined;
      const appName = labels?.['app.kubernetes.io/name'] || labels?.app;
      out.service =
        (typeof appName === 'string' ? appName : undefined) ||
        (typeof kube.container_name === 'string' ? kube.container_name : undefined);
    }
    if (!out.namespace && typeof kube.namespace_name === 'string') out.namespace = kube.namespace_name;
    if (!out.pod && typeof kube.pod_name === 'string') out.pod = kube.pod_name;
  }

  // Splunk shape (from our connector) — sourcetype is a fallback; only
  // use it if no k8s envelope pinned the service.
  if (!out.service && typeof obj.sourcetype === 'string' && obj.sourcetype !== '_json') {
    out.service = obj.sourcetype;
  }

  // Azure KQL rows (PascalCase for built-in tables, <name>_s for custom).
  if (!out.service && typeof obj.AppRoleName === 'string') out.service = obj.AppRoleName;
  if (!out.severity && typeof obj.SeverityLevel === 'string') out.severity = obj.SeverityLevel;
  if (!out.service && typeof obj.container_name_s === 'string') out.service = obj.container_name_s;
  if (!out.namespace && typeof obj.namespace_name_s === 'string') out.namespace = obj.namespace_name_s;
  if (!out.pod && typeof obj.pod_name_s === 'string') out.pod = obj.pod_name_s;

  // CloudWatch events are `{ timestamp, message, ingestionTime }`. If
  // the message itself is JSON (fluent-bit-shaped, fluentd-shaped,
  // otel-collector-shaped), descend into it FIRST. The nested
  // payload usually carries `kubernetes.container_name` which is the
  // true emitter, whereas the outer `logStreamName` is just the
  // forwarder's daemonset stream (e.g., `tenx-fluentd`). Picking the
  // emitter is what makes `by_service` rollups and `owning_service`
  // claims accurate.
  if (typeof obj.message === 'string') {
    const msg = obj.message.trim();
    if (msg.startsWith('{') && msg.endsWith('}')) {
      try {
        const inner = JSON.parse(msg) as Record<string, unknown>;
        const nested = extractEnrichmentFromEnvelope(inner);
        // Nested service wins over any outer value already set —
        // the inner k8s envelope is the emitter, the outer is the
        // shipping layer.
        if (nested.service) out.service = nested.service;
        if (nested.severity && !out.severity) out.severity = nested.severity;
        if (nested.namespace && !out.namespace) out.namespace = nested.namespace;
        if (nested.pod && !out.pod) out.pod = nested.pod;
        if (!out.timestampMs && nested.timestampMs) out.timestampMs = nested.timestampMs;
      } catch {
      // not JSON — fall through to logStreamName fallback
      }
    }
  }

  // CloudWatch raw events expose `logStreamName` like
  // `kube-apiserver-audit-<32hex>`, `authenticator-<32hex>`, `<app>-<id>`.
  // The trailing hash is per-pod / per-instance noise; strip it. Used
  // ONLY as the last-resort fallback when the inner message did not
  // expose a kubernetes envelope (e.g., events emitted directly by
  // an AWS-managed agent).
  if (!out.service && typeof obj.logStreamName === 'string') {
    const stripped = obj.logStreamName.replace(/-[a-f0-9]{20,}$/i, '');
    out.service = stripped || obj.logStreamName;
  }

  return out;
}

/** The event time an envelope carries, read from the same fields the enrichment reads. */
export function envelopeTimestampMs(obj: Record<string, unknown>): number | undefined {
  return extractEnrichmentFromEnvelope(obj).timestampMs;
}

/** Return the majority value in a counting map, or undefined if empty. */
function majority<K>(counts: Map<K, number>): K | undefined {
  if (counts.size === 0) return undefined;
  let best: K | undefined;
  let bestCount = 0;
  for (const [k, n] of counts) {
    if (n > bestCount) {
      best = k;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Best-effort service extraction from a sample event + captured variables.
 * Services are typically emitted via a `service=name` kv pair, a JSON
 * `"service":"name"` field, or a leading token before a severity keyword.
 * Returns undefined when no candidate is found.
 */
function inferServiceFromSample(sample: string, variables: Record<string, string[]>): string | undefined {
  if (!sample) return undefined;
  const structured = variables['service'] || variables['svc'] || variables['tenx_user_service'];
  if (structured && structured.length === 1) return structured[0];

  const kv = sample.match(/\bservice[=:]\s*"?([A-Za-z0-9_.\-]+)"?/i);
  if (kv) return kv[1];

  const json = sample.match(/"service"\s*:\s*"([^"]+)"/);
  if (json) return json[1];

  return undefined;
}
