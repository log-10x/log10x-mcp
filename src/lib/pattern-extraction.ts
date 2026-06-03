/**
 * Shared pattern-extraction lib — templatize a batch of events.
 *
 * Used by log10x_resolve_batch and log10x_poc_from_siem. Both tools feed
 * raw log lines through this and get back a structured list of per-pattern
 * records with aggregated counts, bytes, severity, service, and sample
 * event bodies.
 *
 * Honors `privacyMode`:
 *   - false (default): route through the paste Lambda (events leave the box)
 *   - true: shell out to a locally-installed `tenx` binary (events stay local)
 *
 * Under the hood this uses the existing paste-api + dev-cli + cli-output-parser
 * machinery so the templater contract stays single-source.
 */

import { submitPaste, PASTE_MAX_BYTES } from './paste-api.js';
import { runDevCli, runDevCliFileOutput, DevCliNotInstalledError } from './dev-cli.js';
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
  /** Dominant service label, when resolvable from sample events. */
  service?: string;
  /** Dominant severity (uppercase standard form). */
  severity?: string;
  /** Number of events in this batch matching the pattern. */
  count: number;
  /** Total bytes across all matching events. */
  bytes: number;
  /**
   * Total bytes that would ship over the wire if these events were
   * encoded by the engine. Sum of the raw `encoded.log` line bytes
   * (`~hash,val,val,...` + newline) across this pattern's events.
   * Measured, not estimated. Used to compute the real compact-byte
   * ratio in Section 6.
   *
   * Optional: missing when the engine didn't emit encoded lines
   * (paste-lambda fallback path, older CLI without anchored encoded
   * layout). Consumers treat missing as 0.
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
}

export interface ExtractedPatterns {
  patterns: ExtractedPattern[];
  totalEvents: number;
  totalBytes: number;
  /** Number of raw input lines the caller passed in. */
  inputLineCount: number;
  /** Wall time spent in the templater (network + CLI). */
  templaterWallTimeMs: number;
  /** `paste_lambda` or `local_cli`. */
  executionMode: 'paste_lambda' | 'local_cli';
}

export interface ExtractPatternsOptions {
  /** Route through the local `tenx` CLI instead of the paste Lambda. */
  privacyMode?: boolean;
  /**
   * When true, automatically batch the input through multiple paste-Lambda
   * calls if it exceeds PASTE_MAX_BYTES. Merges results by templateHash.
   * Default false to preserve existing `resolve_batch` semantics.
   */
  autoBatch?: boolean;
  /**
   * When true (only meaningful with `privacyMode=true`), route the
   * templater run through the file-output engine app (@apps/mcp-file)
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
   * When true (with `privacyMode=true` and `useFileOutput=true`),
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
  if (opts.privacyMode) {
    // Fail fast if tenx isn't installed — don't silently degrade.
    // The DevCliNotInstalledError shape has a user-actionable install hint.
  }
  // Pair each line with an "enrichment" record extracted from the envelope
  // before we drop it. Fluent-bit / k8s envelopes carry service and severity
  // labels the templated text loses, so we keep them alongside for later
  // aggregation into per-pattern service/severity.
  const coerceOpts = { preserveEnvelope: opts.preserveEnvelope };
  const pairs = events
    .map((e) => {
      const line = coerceToLine(e, coerceOpts);
      const enrichment = typeof e === 'object' && e !== null
        ? extractEnrichmentFromEnvelope(e as Record<string, unknown>)
        : {};
      return { line, enrichment };
    })
    .filter((p) => p.line && p.line.trim().length > 0);
  const lines = pairs.map((p) => p.line);
  const enrichments = pairs.map((p) => p.enrichment);

  if (lines.length === 0) {
    return {
      patterns: [],
      totalEvents: 0,
      totalBytes: 0,
      inputLineCount: 0,
      templaterWallTimeMs: 0,
      executionMode: opts.privacyMode ? 'local_cli' : 'paste_lambda',
    };
  }

  const mergedTemplates = new Map<string, Template>();
  const mergedEncoded: EncodedEvent[] = [];
  const mergedAggregated: AggregatedRow[] = [];
  let totalWallTimeMs = 0;
  let executionMode: 'paste_lambda' | 'local_cli' = opts.privacyMode ? 'local_cli' : 'paste_lambda';

  if (opts.privacyMode) {
    // Local CLI can absorb the full batch in one shot.
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
      for (const [hash, tpl] of parseTemplates(local.templatesJson)) {
        mergedTemplates.set(hash, tpl);
      }
      // Avoid `arr.push(...other)` — V8's function-argument limit
      // (~65k args) overflows on 400k+ event batches with
      // "Maximum call stack size exceeded". A plain loop scales.
      for (const ev of parseEncoded(local.encodedLog)) mergedEncoded.push(ev);
      for (const row of parseAggregated(local.aggregatedCsv)) mergedAggregated.push(row);
      totalWallTimeMs += local.wallTimeMs;
    } catch (e) {
      if (e instanceof DevCliNotInstalledError) throw e;
      throw new Error(`Local tenx CLI run failed: ${(e as Error).message}`);
    }
  } else {
    // Paste Lambda has a 100 KB body limit. Split by lines into chunks.
    const chunks = opts.autoBatch ? chunkByBytes(lines, PASTE_MAX_BYTES) : [lines.join('\n')];
    for (const chunk of chunks) {
      const size = Buffer.byteLength(chunk, 'utf8');
      if (size > PASTE_MAX_BYTES) {
        // Only possible when autoBatch=false and the caller passed an oversize batch.
        throw new Error(
          `Batch too large: ${(size / 1024).toFixed(1)} KB exceeds the 100 KB paste Lambda limit. ` +
            `Set autoBatch=true (the tool layer does this automatically) or privacy_mode=true to ` +
            `route through a locally-installed tenx CLI.`
        );
      }
      const started = Date.now();
      const resp = await submitPaste(chunk);
      totalWallTimeMs += Date.now() - started;
      for (const [hash, tpl] of parseTemplates(resp['templates.json'])) {
        if (!mergedTemplates.has(hash)) mergedTemplates.set(hash, tpl);
      }
      for (const ev of parseEncoded(resp['encoded.log'])) mergedEncoded.push(ev);
      for (const row of parseAggregated(resp['aggregated.csv'])) mergedAggregated.push(row);
    }
  }

  // Build the pattern records.
  const byHash = new Map<string, {
    count: number;
    bytes: number;
    encodedBytes: number;
    sampleEvent: string;
    variables: Map<string, Set<string>>;
    lineIndices: number[];
    services: Map<string, number>;
    severities: Map<string, number>;
    firstSeenMs?: number;
    lastSeenMs?: number;
    eventsByHour: Map<number, number>;
    // Reporter-tier message_pattern + tenx_hash, read directly off the
    // engine's anchored encoded line (`pattern=,<symbolMessage>,patternHash=,<tenxHash>`).
    // Per-template they're constant; we just keep the first non-empty.
    symbolMessage?: string;
    tenxHash?: string;
  }>();

  for (let i = 0; i < mergedEncoded.length; i++) {
    const ev = mergedEncoded[i];
    const rec = byHash.get(ev.templateHash) || {
      count: 0,
      bytes: 0,
      encodedBytes: 0,
      sampleEvent: '',
      variables: new Map<string, Set<string>>(),
      lineIndices: [],
      services: new Map<string, number>(),
      severities: new Map<string, number>(),
      eventsByHour: new Map<number, number>(),
    };
    rec.count += 1;
    // Measured encoded-line bytes for this event (the `~hash,val,val,...`
    // line plus newline). cli-output-parser computes this per-event;
    // we sum it into the pattern record for the real compact-byte ratio.
    if (typeof ev.lineBytes === 'number') rec.encodedBytes += ev.lineBytes;
    // Best-effort: attribute the raw-line bytes to this pattern by index into `lines`.
    const raw = i < lines.length ? lines[i] : undefined;
    if (raw) {
      rec.bytes += Buffer.byteLength(raw, 'utf8');
      if (!rec.sampleEvent) rec.sampleEvent = raw;
      rec.lineIndices.push(i);
    }
    // Capture engine-emitted Reporter-tier name + hash from the first
    // event we see for this templateHash. They're constant per template
    // because `run/initialize/message` writes them as static fields on
    // the TenXTemplate.
    if (!rec.symbolMessage && ev.symbolMessage) rec.symbolMessage = ev.symbolMessage;
    if (!rec.tenxHash && ev.tenxHash) rec.tenxHash = ev.tenxHash;
    // Aggregate envelope-derived service/severity for majority voting.
    const enr = i < enrichments.length ? enrichments[i] : undefined;
    if (enr?.service) rec.services.set(enr.service, (rec.services.get(enr.service) || 0) + 1);
    if (enr?.severity) rec.severities.set(enr.severity, (rec.severities.get(enr.severity) || 0) + 1);
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

  const patterns: ExtractedPattern[] = [];
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
    for (const [slot, set] of rec.variables) {
      // tenx_hash is the engine's internal pattern identity field — it is never
      // useful as a slot variance signal and must not appear in slot_distribution.
      if (slot === 'tenx_hash') continue;
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
      encodedBytes: rec.encodedBytes,
      sampleEvent: rec.sampleEvent,
      variables,
      slotDistinctCounts,
      firstSeenMs: rec.firstSeenMs,
      lastSeenMs: rec.lastSeenMs,
      eventsByHour: rec.eventsByHour.size > 0 ? Object.fromEntries(rec.eventsByHour) : undefined,
    });
  }

  patterns.sort((a, b) => b.count - a.count);

  const totalBytes = patterns.reduce((s, p) => s + p.bytes, 0);

  return {
    patterns,
    totalEvents: mergedEncoded.length,
    totalBytes,
    inputLineCount: lines.length,
    templaterWallTimeMs: totalWallTimeMs,
    executionMode,
  };
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
 * enriching. Patterns without a `symbolMessage` (older CLI, paste-lambda
 * fallback) are left as-is, keyed by their templateHash.
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
    encodedBytes: group.reduce((s, p) => s + (p.encodedBytes ?? 0), 0),
    sampleEvent: head.sampleEvent,
    variables,
    slotDistinctCounts: Object.keys(mergedSlotDistinctCounts).length > 0 ? mergedSlotDistinctCounts : undefined,
    firstSeenMs,
    lastSeenMs,
    eventsByHour: Object.keys(mergedEventsByHour).length > 0 ? mergedEventsByHour : undefined,
  };
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
    // instead of paying for 3× byte count through the paste Lambda.
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

/** Split lines into chunks whose serialized form fits in maxBytes. */
function chunkByBytes(lines: string[], maxBytes: number): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let curBytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
    if (curBytes + lineBytes > maxBytes && cur.length > 0) {
      chunks.push(cur.join('\n'));
      cur = [];
      curBytes = 0;
    }
    // Single-line-exceeds-limit: truncate to avoid infinite loop.
    if (lineBytes > maxBytes) {
      chunks.push(line.slice(0, maxBytes - 1));
      continue;
    }
    cur.push(line);
    curBytes += lineBytes;
  }
  if (cur.length > 0) chunks.push(cur.join('\n'));
  return chunks;
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
