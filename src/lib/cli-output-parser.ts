/**
 * Parsers for the Log10x dev CLI's output files.
 *
 * The CLI (and the paste Lambda that wraps it) produces four files:
 *   - templates.json   NDJSON, one template per line
 *   - encoded.log      per-event lines: ~templateHash,val1,val2,...
 *   - aggregated.csv   per-pattern statistics (count, bytes, severity, ...)
 *   - decoded.log      losslessly reconstructed events (ignored)
 *
 * This module parses those strings into in-memory structures the rest of
 * the tool can use. Defensive on format: some CLI versions emit slightly
 * different column names, so we look up by header name rather than index.
 */

export interface Template {
  templateHash: string;
  /** Human-readable template body with `$` marking variable slots. */
  template: string;
  /** Optional: structured slot list. Present in newer CLI versions. */
  variableSlots?: VariableSlot[];
  /** Optional: static tokens flanking the slots. */
  staticTokens?: string[];
  /** Optional: explicit symbolMessage field-set string. */
  symbolMessage?: string;
  /** Optional: severity reported by the CLI at template discovery. */
  severity?: string;
  /** Optional: whether this is a group template (regex-joined variants). */
  isGroup?: boolean;
}

export interface VariableSlot {
  position: number;
  type?: string;
  /** The static text immediately before this slot — used for semantic naming. */
  precedingToken?: string;
  /** Name assigned by the CLI (if any) — typically only for structured logs. */
  name?: string;
}

export interface EncodedEvent {
  templateHash: string;
  /** Variable values in slot order. */
  values: string[];
  /**
   * UTF-8 byte length of the `~hash,val1,val2,...\n` line as it would
   * ship to a compaction-aware SIEM. Optional for back-compat with older
   * parser callers. Includes the trailing newline so the sum matches the
   * on-wire payload.
   */
  lineBytes?: number;
  /**
   * Reporter-tier symbol-lookup name (`message_pattern`) emitted by the
   * engine via `apps/mcp/stdout`'s `pattern=` anchor. Present only on
   * engine builds that include the anchored encoded layout; undefined
   * otherwise.
   */
  symbolMessage?: string;
  /**
   * Engine-emitted xxHash64 (base64url, 11 chars) of `symbolMessage`,
   * carried on the `patternHash=` anchor of the encoded line. Same key
   * that the engine writes into the `tenx_hash` field of the summary
   * row, so it joins the encoded event to its aggregated summary
   * deterministically.
   */
  tenxHash?: string;
}

export interface AggregatedRow {
  /** Pattern identifier — either templateHash or symbolMessage depending on CLI version. */
  pattern: string;
  count: number;
  totalBytes: number;
  severity?: string;
  /** Raw row by header name — anything the specific CLI version emitted. */
  raw: Record<string, string>;
}

/** Parse NDJSON `templates.json` content into a hash-keyed map. */
export function parseTemplates(text: string): Map<string, Template> {
  const map = new Map<string, Template>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const rawHash = (obj.templateHash || obj.hash || obj.id) as string | undefined;
      if (!rawHash) continue;
      const hash = normalizeHash(rawHash);
      const body = (obj.template || obj.body || obj.text || '') as string;
      const template: Template = {
        templateHash: hash,
        template: body,
        symbolMessage: (obj.symbolMessage || obj.symbol || obj.name) as string | undefined,
        severity: (obj.severity || obj.severityLevel) as string | undefined,
        isGroup: Boolean(obj.is_group || obj.isGroup),
      };

      // Prefer explicit slot metadata if present (some CLI versions emit it).
      const slots = (obj.variable_slots || obj.variableSlots) as unknown;
      if (Array.isArray(slots) && slots.length > 0) {
        template.variableSlots = slots.map((s: Record<string, unknown>, idx: number) => ({
          position: (s.position as number) ?? idx,
          type: s.type as string | undefined,
          precedingToken: (s.preceding_token || s.precedingToken) as string | undefined,
          name: (s.inferred_name || s.name) as string | undefined,
        }));
      } else if (body) {
        // Fallback: derive slots + preceding tokens from the template body.
        // The paste Lambda marks variable positions with a bare `$` character.
        // Format specs like `$(yyyy-MM-dd'T'HH:mm:ss'Z')` are NOT variable slots —
        // they're typed format hints. Drop them from the preceding context.
        template.variableSlots = extractSlotsFromBody(body);
      }

      map.set(hash, template);
    } catch {
      // Skip malformed lines — paste Lambda sometimes emits trailing commentary.
    }
  }
  return map;
}

/**
 * Walk the template body, find each variable slot marker, and capture the
 * preceding static token for semantic naming. Slots come in two forms:
 *
 *   1. Bare `$`                    — an untyped variable slot
 *   2. `$(yyyy-MM-dd'T'HH:mm:ss'Z')` — a typed slot with a format spec
 *
 * Both count as variables in `encoded.log`, so both are emitted here with
 * positional ordering. Typed format specs get an inferred name from the
 * format ("timestamp" for date/time formats, etc.) and keep their raw
 * spec text as the type hint.
 */
function extractSlotsFromBody(body: string): VariableSlot[] {
  const slots: VariableSlot[] = [];
  let i = 0;
  let position = 0;
  let runStart = 0;
  let previousName: string | undefined;
  while (i < body.length) {
    const c = body[i];
    if (c === '$') {
      const next = body[i + 1];
      if (next === '(') {
        // Typed format-spec slot — `$(yyyy-MM-dd...)`.
        const end = body.indexOf(')', i + 2);
        if (end === -1) break;
        const spec = body.slice(i + 2, end);
        const preceding = body.slice(runStart, i);
        const specName = inferFormatSpecName(spec);
        slots.push({
          position,
          precedingToken: preceding.slice(-120),
          type: spec,
          name: specName,
        });
        previousName = specName;
        position += 1;
        i = end + 1;
        runStart = i;
        continue;
      }
      // Bare `$` = untyped variable slot.
      // Try to infer a semantic name from the preceding token so that
      // pattern-extraction.ts's `tpl.variableSlots[s].name` lookup gets a
      // meaningful value rather than falling through to `slot_${s}`.
      const preceding = body.slice(runStart, i);
      const precedingToken = preceding.slice(-120);
      const inferredName = inferSlotNameFromToken(precedingToken, position, previousName);
      slots.push({
        position,
        precedingToken,
        name: inferredName,
      });
      previousName = inferredName;
      position += 1;
      i += 1;
      runStart = i;
      continue;
    }
    i += 1;
  }
  return slots;
}

/**
 * Infer a semantic name for a bare-$ variable slot from the static text
 * immediately preceding it. Mirrors the logic in variable-concentration.ts's
 * `inferSlotName` so that `extractSlotsFromBody` produces populated `.name`
 * fields without creating a circular import.
 *
 * When `previousName` is provided and the preceding token is separator-only
 * (e.g. `-`, `.`, `/`), the slot is treated as a continuation of the same
 * multi-part value and gets a `_partN` suffix — matching the inheritance
 * branch in variable-concentration.ts's `inferSlotName`.
 *
 * Returns `undefined` when no confident name can be derived (caller omits
 * `.name` and pattern-extraction.ts falls through to `slot_${N}`).
 */
function inferSlotNameFromToken(tok: string, position: number, previousName?: string): string | undefined {
  // Empty preceding token: do NOT apply multi-part inheritance here — leave
  // slot.name unset so variable-concentration.ts's structured-key check (which
  // has access to more context) gets a chance to run.  Returning undefined
  // keeps behaviour identical to variable-concentration.ts's empty-tok branch.
  if (!tok || !tok.trim()) {
    return undefined;
  }

  // Structured log key: ends with `":"`, `":`, `=`, `=\"`
  // This check MUST come before multi-part inheritance so that a JSON key like
  // `opentelemetry-collector-contrib` is captured rather than being shadowed by
  // a _partN name derived from a previousName.
  const structured = tok.match(/([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?$/);
  if (structured) return structured[1];

  // Natural-language word right before the slot.
  const wordMatch = tok.match(/\b([A-Za-z][A-Za-z0-9_]{1,})\s*[:=]?\s*$/);
  if (wordMatch) {
    const word = wordMatch[1].toLowerCase();
    if (word.length >= 3) return `${word} (inferred)`;
  }

  // Separator-only token (e.g. `-`, `.`, `/`, ` `) with a known previous name:
  // treat as a multi-part continuation and emit a _partN suffix.
  // Only reached when neither the structured-key nor word-match branches fired.
  if (previousName && /^[.\-\s,\/]+$/.test(tok.trim() || tok)) {
    const m = previousName.match(/_part(\d+)$/);
    const next = m ? parseInt(m[1], 10) + 1 : 2;
    const base = previousName.replace(/_part\d+$/, '');
    // Avoid emitting the same name as previousName when previousName has no
    // _partN suffix yet — always suffix with _part2 at minimum.
    return `${base}_part${next}`;
  }

  return undefined;
}

/** Guess a name for a typed format spec like `yyyy-MM-dd'T'HH:mm:ss'Z'`. */
function inferFormatSpecName(spec: string): string | undefined {
  if (/[yY].*[Mm].*[dD]/.test(spec) || /[Hh]{1,2}[:']?[mM]/.test(spec)) {
    return 'timestamp';
  }
  if (/^[\d.]+$/.test(spec)) return 'number';
  if (spec.length <= 20) return spec.toLowerCase();
  return undefined;
}

/** Strip the CLI's `~` prefix marker if present — the actual hash is what follows. */
function normalizeHash(hash: string): string {
  return hash.startsWith('~') ? hash.slice(1) : hash;
}

/**
 * Parse encoded-event lines into per-event records.
 *
 * Two layouts are accepted (auto-detected per line):
 *
 *   1. **Anchored (apps/mcp current)** — caller already stripped the
 *      `encoded=,` prefix in the demux, so what arrives here is:
 *
 *          ~<templateHash>,<val1>,<val2>,…,pattern=,<message_pattern>,patternHash=,<tenx_hash>
 *
 *      The `pattern=` and `patternHash=` literals act as section
 *      anchors, giving us the engine-emitted Reporter-tier name and
 *      the matching xxHash64 per event.
 *
 *   2. **Legacy** — older engines / configs without the anchors:
 *
 *          ~<templateHash>,<val1>,<val2>,…
 *
 *      No symbolMessage / tenxHash on the EncodedEvent.
 *
 * Commas inside variable values are escaped as `\,`. Leading `~` on the
 * hash is the templater's marker; templates.json stores the hash without
 * it, so we normalize.
 */
export function parseEncoded(text: string): EncodedEvent[] {
  const events: EncodedEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const commaIdx = line.indexOf(',');
    let hashPart: string;
    let rest: string;
    if (commaIdx === -1) {
      hashPart = line;
      rest = '';
    } else {
      hashPart = line.slice(0, commaIdx);
      rest = line.slice(commaIdx + 1);
    }
    const templateHash = hashPart.startsWith('~') ? hashPart.slice(1) : hashPart;
    const allValues = rest ? splitEscaped(rest) : [];

    // Peel anchored trailing sections (`pattern=,<value>`, `patternHash=,<value>`)
    // off the values list. Anchor token appears as its own array element
    // because the engine joins fields by `,`. Walk from the end so any
    // future anchors can be added without touching this logic.
    let values = allValues;
    let symbolMessage: string | undefined;
    let tenxHash: string | undefined;
    while (values.length >= 2) {
      const anchor = values[values.length - 2];
      if (anchor === 'patternHash=') {
        tenxHash = values[values.length - 1];
        values = values.slice(0, -2);
      } else if (anchor === 'pattern=') {
        symbolMessage = values[values.length - 1];
        values = values.slice(0, -2);
      } else {
        break;
      }
    }

    // Compaction byte cost = UTF-8 bytes of the (full) line as written,
    // plus the newline that frames it on the wire. We measure the
    // input line, NOT the anchor-stripped form, so it matches what a
    // SIEM ingesting compact format would actually receive.
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    events.push({ templateHash, values, lineBytes, symbolMessage, tenxHash });
  }
  return events;
}

/**
 * Parse `aggregated.csv` into rows.
 *
 * Header names vary across CLI versions. Common column names:
 *   pattern | templateHash | symbolMessage    → identity
 *   count | events                            → event count
 *   bytes | total_bytes | totalBytes          → total bytes
 *   severity | severityLevel                  → dominant severity
 */
export function parseAggregated(text: string): AggregatedRow[] {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows: AggregatedRow[] = [];

  const idxIdentity = firstIndexOf(header, [
    'pattern',
    'message_pattern',
    'templatehash',
    'template_hash',
    'symbolmessage',
    'symbol_message',
  ]);
  const idxCount = firstIndexOf(header, ['count', 'events', 'event_count']);
  const idxBytes = firstIndexOf(header, ['bytes', 'total_bytes', 'totalbytes', 'sum_bytes']);
  const idxSeverity = firstIndexOf(header, ['severity', 'severitylevel', 'severity_level', 'level']);

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length === 0) continue;
    const raw: Record<string, string> = {};
    for (let j = 0; j < header.length && j < cols.length; j++) {
      raw[header[j]] = cols[j];
    }
    const pattern = idxIdentity >= 0 ? cols[idxIdentity] : cols[0];
    const count = idxCount >= 0 ? parseInt(cols[idxCount], 10) || 0 : 0;
    const totalBytes = idxBytes >= 0 ? parseInt(cols[idxBytes], 10) || 0 : 0;
    const severity = idxSeverity >= 0 ? cols[idxSeverity] : undefined;
    rows.push({ pattern, count, totalBytes, severity, raw });
  }
  return rows;
}

// ── Helpers ──

function splitEscaped(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length && line[i + 1] === ',') {
      cur += ',';
      i += 1;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && (i === 0 || line[i - 1] !== '\\')) {
      inQuotes = !inQuotes;
      continue;
    }
    if (c === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function firstIndexOf(header: string[], candidates: string[]): number {
  for (const c of candidates) {
    const idx = header.indexOf(c);
    if (idx >= 0) return idx;
  }
  return -1;
}
