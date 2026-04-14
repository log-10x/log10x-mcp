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
        slots.push({
          position,
          precedingToken: preceding.slice(-40),
          type: spec,
          name: inferFormatSpecName(spec),
        });
        position += 1;
        i = end + 1;
        runStart = i;
        continue;
      }
      // Bare `$` = untyped variable slot.
      const preceding = body.slice(runStart, i);
      slots.push({
        position,
        precedingToken: preceding.slice(-40),
      });
      position += 1;
      i += 1;
      runStart = i;
      continue;
    }
    i += 1;
  }
  return slots;
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
 * Parse `encoded.log` into per-event records.
 *
 * Line format: `~templateHash,val1,val2,...` — leading `~` is optional
 * depending on CLI version. Commas inside values are escaped as `\,` in
 * newer versions; older versions do not escape at all. We split on the
 * first comma for the hash and then on unescaped commas for the rest.
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
    // The CLI uses `~` as a prefix marker on encoded lines; the actual
    // templateHash is what follows. templates.json stores the hash without
    // the marker, so we normalize here to make lookups match.
    const templateHash = hashPart.startsWith('~') ? hashPart.slice(1) : hashPart;
    const values = rest ? splitEscaped(rest) : [];
    events.push({ templateHash, values });
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
