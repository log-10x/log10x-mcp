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
import { runDevCli, DevCliNotInstalledError } from './dev-cli.js';
import {
  parseTemplates,
  parseEncoded,
  parseAggregated,
  type Template,
  type EncodedEvent,
  type AggregatedRow,
} from './cli-output-parser.js';

export interface ExtractedPattern {
  /** Stable template hash — key for round-trip identity. */
  hash: string;
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
  /** One representative raw event (from the first encoded match). */
  sampleEvent: string;
  /** Per-slot captured values (slot name or positional index → distinct values observed). */
  variables: Record<string, string[]>;
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
  const pairs = events
    .map((e) => {
      const line = coerceToLine(e);
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
      const local = await runDevCli(text);
      for (const [hash, tpl] of parseTemplates(local.templatesJson)) {
        mergedTemplates.set(hash, tpl);
      }
      mergedEncoded.push(...parseEncoded(local.encodedLog));
      mergedAggregated.push(...parseAggregated(local.aggregatedCsv));
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
      mergedEncoded.push(...parseEncoded(resp['encoded.log']));
      mergedAggregated.push(...parseAggregated(resp['aggregated.csv']));
    }
  }

  // Build the pattern records.
  const byHash = new Map<string, {
    count: number;
    bytes: number;
    sampleEvent: string;
    variables: Map<string, Set<string>>;
    lineIndices: number[];
    services: Map<string, number>;
    severities: Map<string, number>;
  }>();

  for (let i = 0; i < mergedEncoded.length; i++) {
    const ev = mergedEncoded[i];
    const rec = byHash.get(ev.templateHash) || {
      count: 0,
      bytes: 0,
      sampleEvent: '',
      variables: new Map<string, Set<string>>(),
      lineIndices: [],
      services: new Map<string, number>(),
      severities: new Map<string, number>(),
    };
    rec.count += 1;
    // Best-effort: attribute the raw-line bytes to this pattern by index into `lines`.
    const raw = i < lines.length ? lines[i] : undefined;
    if (raw) {
      rec.bytes += Buffer.byteLength(raw, 'utf8');
      if (!rec.sampleEvent) rec.sampleEvent = raw;
      rec.lineIndices.push(i);
    }
    // Aggregate envelope-derived service/severity for majority voting.
    const enr = i < enrichments.length ? enrichments[i] : undefined;
    if (enr?.service) rec.services.set(enr.service, (rec.services.get(enr.service) || 0) + 1);
    if (enr?.severity) rec.severities.set(enr.severity, (rec.severities.get(enr.severity) || 0) + 1);

    const tpl = mergedTemplates.get(ev.templateHash);
    for (let s = 0; s < ev.values.length; s++) {
      const slotName = tpl?.variableSlots?.[s]?.name || `slot_${s}`;
      const set = rec.variables.get(slotName) || new Set<string>();
      set.add(ev.values[s]);
      rec.variables.set(slotName, set);
    }
    byHash.set(ev.templateHash, rec);
  }

  // Severity lookup: try aggregated rows (keyed by pattern name) first by
  // Jaccard token match between template body + aggregated pattern token set.
  const aggTokenized = mergedAggregated.map((r) => ({ row: r, tokens: tokenize(r.pattern) }));

  const patterns: ExtractedPattern[] = [];
  for (const [hash, rec] of byHash) {
    const tpl = mergedTemplates.get(hash);
    const body = tpl?.template || hash;
    // Severity priority: envelope majority > template hint > aggregated lookup.
    const envelopeMajorSeverity = majority(rec.severities);
    const severity =
      envelopeMajorSeverity ||
      tpl?.severity ||
      bestAggregatedMatch(body, aggTokenized)?.row.severity;

    const variables: Record<string, string[]> = {};
    for (const [slot, set] of rec.variables) {
      // Cap at 20 sample values per slot — enough for dependency analysis, not enough to blow context.
      variables[slot] = Array.from(set).slice(0, 20);
    }

    // Service priority: envelope majority > sample-text regex.
    const envelopeMajorService = majority(rec.services);
    const service = envelopeMajorService || inferServiceFromSample(rec.sampleEvent, variables);

    patterns.push({
      hash,
      template: body,
      severity: severity ? severity.toUpperCase() : undefined,
      service,
      count: rec.count,
      bytes: rec.bytes,
      sampleEvent: rec.sampleEvent,
      variables,
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
function coerceToLine(e: unknown): string {
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
          return coerceObjectToLine(parsed as Record<string, unknown>);
        }
      } catch {
        // fall through — not valid JSON, treat as plain
      }
    }
    return e.replace(/\r?\n/g, ' ');
  }
  if (typeof e === 'number' || typeof e === 'boolean') return String(e);
  if (typeof e === 'object') {
    return coerceObjectToLine(e as Record<string, unknown>);
  }
  return String(e);
}

function coerceObjectToLine(obj: Record<string, unknown>): string {
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
      try {
        const nested = JSON.parse(t);
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
          const inner = coerceObjectToLine(nested as Record<string, unknown>);
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

  // CloudWatch events are `{ timestamp, message, ingestionTime }`. If the
  // message itself is JSON (fluent-bit-shaped), descend into it.
  if (!out.service && typeof obj.message === 'string') {
    const msg = obj.message.trim();
    if (msg.startsWith('{') && msg.endsWith('}')) {
      try {
        const inner = JSON.parse(msg) as Record<string, unknown>;
        const nested = extractEnrichmentFromEnvelope(inner);
        if (nested.service && !out.service) out.service = nested.service;
        if (nested.severity && !out.severity) out.severity = nested.severity;
        if (nested.namespace && !out.namespace) out.namespace = nested.namespace;
        if (nested.pod && !out.pod) out.pod = nested.pod;
      } catch {
        // not JSON — ignore
      }
    }
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
