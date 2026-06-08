/**
 * Slot semantic naming + cohort detection for pattern_examples.
 *
 * The engine assigns positional slot identifiers (slot_0, slot_1, ...) by
 * default — fine as a stable internal key, useless as a field name to an
 * agent or human. This module derives a logical name from two signals:
 *
 *   1. The preceding-token captured locally by walking the template body
 *      (cli-output-parser.ts:extractSlotsFromBody). When the token shows
 *      a `"json_key":` or `key=` shape, the name comes straight from that
 *      key, with high confidence.
 *
 *   2. The sample values themselves. Consecutive slots that together encode
 *      one logical entity (UUID octets split as `$-$-$-$-$`, IPv4 octets
 *      split as `$.$.$.$`) are merged into a single derived "cohort" with
 *      combined cardinality over reassembled values.
 *
 * Both functions are pure — no I/O, no engine calls. They consume what
 * pattern-extraction.ts already exposes:
 *   - ExtractedPattern.variables (slot -> sample values)
 *   - ExtractedPattern.slotPrecedingTokens (slot -> preceding static text)
 *   - ExtractedPattern.template (template body with $ markers)
 *
 * Naming is conservative on purpose. The earlier variable-concentration.ts
 * attempt burned on engine-emitted metadata that didn't index-align;
 * "confidently wrong" names are worse than slot_N. We omit `inferred_name`
 * entirely when no layer can justify one.
 */

export type NamingConfidence = 'high' | 'medium' | 'low';
export type NamingSource =
  | 'json_key'
  | 'json_key_composite'
  | 'kv_pair'
  | 'kv_pair_compound'
  | 'noun_prefix'
  | 'delimiter_heuristic'
  | 'format_spec';

export interface SlotNameResult {
  name: string;
  confidence: NamingConfidence;
  source: NamingSource;
}

export interface SlotInput {
  slot: string;
  sampleValues: string[];
  precedingToken?: string;
}

export interface Cohort {
  member_slots: string[];
  inferred_name: string;
  naming_confidence: NamingConfidence;
  kind: 'uuid' | 'ipv4' | 'mac';
  cardinality: number;
  sample_values: string[];
}

// ── Naming layers ──────────────────────────────────────────────────────────

// Permissive JSON-key match. Allows any non-quote, non-backslash chars in
// the key — JSON spec permits spaces, slashes, unicode in quoted strings.
// Anchored to `^` or `{`/`,` (with optional whitespace) before the opening
// quote so we only match positions that could be real object keys, not
// quoted phrases inside log-message values.
const JSON_KEY_RE = /(?:^|[{,]\s*)"([^"\\]{1,80})"\s*:\s*"?\s*$/;
// Parent-key match: same shape as JSON_KEY_RE but WITHOUT the optional
// trailing `"`. Used only when looking just before a `{` that opens an
// object — the parent's value is the object, not a string, so there's no
// quote to consume.
const PARENT_KEY_RE = /(?:^|[{,]\s*)"([^"\\]{1,80})"\s*:\s*$/;

/**
 * Stopword prepositions. When KV-pair regex matches one of these as the
 * "key" (e.g. `on:` in `decided on: $`), the matched token is grammatical
 * connective tissue, not a field label. We look one word further back; if
 * a real word sits before the preposition, the slot is a verb-preposition
 * compound field (`decided_on`, `routed_to`, `migrated_from`, `assigned_to`).
 * If the word back is also a stopword, suppress and emit null.
 */
const STOPWORD_PREPS = new Set([
  'on', 'in', 'at', 'to', 'from', 'for', 'by', 'with',
  'into', 'onto', 'after', 'before', 'during', 'between',
]);

const STOPWORDS = new Set([
  ...STOPWORD_PREPS,
  'as', 'is', 'was', 'are', 'be', 'been', 'being',
  'of', 'the', 'a', 'an', 'and', 'or', 'but',
  'has', 'had', 'have', 'do', 'does', 'did', 'this', 'that',
]);

/**
 * Small vocabulary of nouns that show up in real log templates as direct
 * field labels before a `$` slot. When the preceding token ends with
 * `<noun>\s+`, name the slot `<noun>`. Format-agnostic — works whether
 * it's syslog, Apache error log, custom logger, or anything else.
 */
const COMMON_LOG_NOUNS = new Set([
  'pid', 'port', 'user', 'host', 'client', 'server',
  'version', 'error', 'count', 'file', 'path', 'request',
  'line', 'method', 'status', 'action', 'level', 'name',
  'id', 'key', 'type', 'code', 'session',
  'process', 'thread', 'group', 'role', 'token', 'tag',
  'event', 'job', 'task', 'queue', 'topic', 'channel',
  'username', 'hostname', 'address', 'reason', 'message',
  'severity', 'service', 'module', 'method', 'function',
]);
const KV_PAIR_RE = /(?:^|[\s\t,(){}[\]"'])([A-Za-z_][A-Za-z0-9_.\-]{1,60})\s*[=:]\s*$/;
const FILENAME_LINE_RE = /([A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z]{1,5}):\s*$/;
const PURE_PUNCT_RE = /^[\s\t.,;:/\\|()[\]{}<>"'`~!@#$%^&*+=-]*$/;

/**
 * Composite-value back-reference suffix. When a slot is preceded by one
 * or more `$N` engine back-references (with optional literal continuation
 * like `.` or `:`), this slot is a FRAGMENT of a larger composite value —
 * not a standalone field. Example template fragment:
 *
 *   "duration": $7.$
 *
 * The new slot is only the trailing fractional portion; `$7` is a back-ref
 * to slot 7 (the integer portion). The semantic field is `duration`; this
 * slot is part 2 of its value. We strip the `$N.` suffix before matching
 * the JSON key, then emit `<key>_partN` with `json_key_composite` source
 * and `medium` confidence (not `high` — the slot isn't the whole value).
 */
const COMPOSITE_SUFFIX_RE = /(?:\$\d+[^"{},\s]*)+$/;

function toSnakeCase(s: string): string {
  return s
    .replace(/[.\-]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/__+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/**
 * Normalize a JSON key for emission as a field name. JSON keys can hold
 * spaces, slashes, unicode; field-name conventions across analyzers
 * (Splunk, Datadog, Elastic) collapse whitespace to underscore. Dots
 * inside a single key (like `service.instance.id`) are preserved — they
 * mean different things to the engine than the dots we INSERT between
 * parent/child keys, so we keep both as-is for queryability.
 */
function normalizeJsonKey(s: string): string {
  return s.trim().replace(/\s+/g, '_');
}

/**
 * Find the index of the `{` that opens the current JSON object scope,
 * walking backward from the end of `s`. JSON-depth-aware: skips over
 * sibling key-value pairs at the same scope by tracking brace/bracket
 * nesting. Quoted strings are respected (braces inside strings ignored).
 *
 * Returns -1 if no opening `{` is found within the window — happens when
 * the window cut off mid-scope. Caller falls back to leaf-only path.
 */
function findOpenBrace(s: string): number {
  let depth = 0;
  let inString = false;
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i];
    if (c === '"') {
      // Count consecutive backslashes before this quote — odd count means escaped.
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && s[j] === '\\') {
        bs += 1;
        j -= 1;
      }
      if (bs % 2 === 0) inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '}' || c === ']') {
      depth += 1;
    } else if (c === '{' || c === '[') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * Reverse-walk a preceding-token string to collect the full JSON path
 * leading up to a slot. Sibling keys at the same scope are skipped via
 * depth tracking — only true parents (one scope up via `{`) contribute.
 *
 * Returns:
 *   - { parts: [...], composite: false } when the immediate context is
 *     a JSON key whose value IS the slot.
 *   - { parts: [...], composite: true, partN: K } when the slot is a
 *     fragment of a composite value (preceded by `$N` back-refs).
 *   - undefined when no JSON key can be matched at all.
 */
function walkJsonPath(
  precedingToken: string,
): { parts: string[]; composite: boolean; partN: number } | undefined {
  let cur = precedingToken;
  let composite = false;
  let partN = 1;

  // Strip composite-value back-reference suffix, if any. `$7.` means one
  // prior back-ref, so this slot is part 2. `$7.$8.` means two prior
  // back-refs, this slot is part 3.
  const compMatch = cur.match(COMPOSITE_SUFFIX_RE);
  if (compMatch && compMatch[0].length > 0) {
    const backrefs = compMatch[0].match(/\$\d+/g) ?? [];
    partN = backrefs.length + 1;
    composite = true;
    cur = cur.slice(0, compMatch.index);
  }

  const parts: string[] = [];
  // First iteration matches the LEAF key (key directly preceding the slot,
  // with value being the slot itself — pattern ends with `"?` optional).
  const leafMatch = cur.match(JSON_KEY_RE);
  if (!leafMatch || leafMatch.index === undefined) {
    if (!composite) return undefined;
    // Composite case: even with no leaf-key match, still emit partN naming
    // — handled by the caller via the `composite` flag.
    return { parts: [], composite, partN };
  }
  parts.unshift(normalizeJsonKey(leafMatch[1]));
  cur = cur.slice(0, leafMatch.index);

  // Subsequent iterations match PARENT keys. There are two shapes:
  //
  //   1. Direct case: cur ends with `..."<parent>": ` — the leaf was the
  //      first/only key in its scope, so the parent's `key:` is right at
  //      the end of cur. Match PARENT_KEY_RE directly.
  //
  //   2. Sibling case: cur ends with sibling-value text (e.g. `"$", "$"`
  //      because earlier siblings of the leaf also had slot values). We
  //      need to skip over the sibling contents back to the `{` that
  //      opened the current scope, then match the parent's `key:` on the
  //      prefix BEFORE that `{`.
  while (true) {
    const direct = cur.match(PARENT_KEY_RE);
    if (direct && direct.index !== undefined) {
      parts.unshift(normalizeJsonKey(direct[1]));
      cur = cur.slice(0, direct.index);
      continue;
    }
    const openIdx = findOpenBrace(cur);
    if (openIdx === -1) break;
    const before = cur.slice(0, openIdx);
    const parentMatch = before.match(PARENT_KEY_RE);
    if (!parentMatch || parentMatch.index === undefined) break;
    parts.unshift(normalizeJsonKey(parentMatch[1]));
    cur = before.slice(0, parentMatch.index);
  }

  if (parts.length === 0) return undefined;
  return { parts, composite, partN };
}

/**
 * Derive a logical name for one slot from its preceding static text.
 * Returns `undefined` when no layer can justify a name — caller emits the
 * slot with no `inferred_name` field. Layer 4 (format_spec) is handled
 * upstream by extractSlotsFromBody → inferFormatSpecName; this function
 * is invoked for non-format-spec slots only.
 */
export function inferSlotName(
  precedingToken: string | undefined,
  _sampleValues: string[],
): SlotNameResult | undefined {
  if (!precedingToken) return undefined;

  // Layer 1: JSON-key context with depth-aware parent walking. Returns
  // the full JSON path (e.g. `resource.service.instance.id`) when nested.
  // When the slot is a fragment of a composite value (preceded by `$N`
  // engine back-refs), the name carries `_partN` and confidence drops to
  // medium — the slot isn't the whole field, just a piece of it.
  const jsonPath = walkJsonPath(precedingToken);
  if (jsonPath && jsonPath.parts.length > 0) {
    // Preserve original casing and dots between nested keys. The JSON
    // path is the queryable name an analyzer (Splunk/Datadog/JQ) will
    // expect; normalizing to snake_case here would force the agent to
    // re-translate for every follow-up filter.
    const base = jsonPath.parts.join('.');
    if (jsonPath.composite) {
      return {
        name: `${base}_part${jsonPath.partN}`,
        confidence: 'medium',
        source: 'json_key_composite',
      };
    }
    return { name: base, confidence: 'high', source: 'json_key' };
  }

  // Layer 2: KV-pair context (e.g. `userId=` or `userId: `). If the matched
  // key is a stopword preposition (`on`, `to`, `from`, ...), it's grammatical
  // connective tissue, not a label — look one word further back. If a real
  // word sits there, emit `<word>_<preposition>` compound. If not, suppress.
  const kvMatch = precedingToken.match(KV_PAIR_RE);
  if (kvMatch && kvMatch.index !== undefined) {
    const matched = kvMatch[1];
    const lower = matched.toLowerCase();
    if (STOPWORD_PREPS.has(lower)) {
      // Preposition: try verb-preposition compound by looking one word back.
      const before = precedingToken.slice(0, kvMatch.index);
      const backMatch = before.match(/\b([A-Za-z][A-Za-z0-9_-]*)\s*$/);
      if (backMatch && !STOPWORDS.has(backMatch[1].toLowerCase())) {
        return {
          name: `${toSnakeCase(backMatch[1])}_${lower}`,
          confidence: 'medium',
          source: 'kv_pair_compound',
        };
      }
      return undefined;
    }
    if (STOPWORDS.has(lower)) {
      // Non-preposition stopword (`as`, `is`, `the`, ...) — suppress, no
      // compound attempt because there's no preposition semantics to attach.
      return undefined;
    }
    return { name: toSnakeCase(matched), confidence: 'high', source: 'kv_pair' };
  }

  // Layer 2.5: English-noun prefix. The preceding token ends with a known
  // log-noun word followed by whitespace (e.g. `port $`, `pid $`,
  // `for user $`). Template-derived, no value inspection, no drift.
  const nounMatch = precedingToken.match(/\b([A-Za-z]{2,20})\s+$/);
  if (nounMatch && COMMON_LOG_NOUNS.has(nounMatch[1].toLowerCase())) {
    return {
      name: nounMatch[1].toLowerCase(),
      confidence: 'medium',
      source: 'noun_prefix',
    };
  }

  // Layer 3a: filename.ext: → line number.
  const fileMatch = precedingToken.match(FILENAME_LINE_RE);
  if (fileMatch) {
    return { name: 'line', confidence: 'medium', source: 'delimiter_heuristic' };
  }

  // Layer 3b: pure-punctuation tail → no honest name.
  if (PURE_PUNCT_RE.test(precedingToken)) return undefined;

  // No layer fired.
  return undefined;
}

// ── Cohort detection ───────────────────────────────────────────────────────

const HEX_RE = /^[0-9a-f]+$/;
const UUID_SEGMENT_LENGTHS = [8, 4, 4, 4, 12] as const;
const IPV4_OCTET_RE = /^(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$/;
const MAC_OCTET_RE = /^[0-9a-f]{2}$/i;

/**
 * Parse a template body, returning the indexed list of bare-$ slot
 * positions and the separator string between each consecutive pair.
 *
 * `$N` is treated as a back-reference (compaction optimization in the
 * template format) — NOT a new slot. We only count bare `$` followed by
 * a non-digit, non-`(` character, and `$(...)` format-spec slots.
 *
 * Returns: { slotCount, separators: separators[i] is the static text
 * between slot[i] and slot[i+1] }. Index 0..slotCount-1 corresponds to
 * the engine's slot_0..slot_{N-1} for templates that don't use $N.
 */
function parseTemplateSlots(body: string): { slotCount: number; separators: string[] } {
  const separators: string[] = [];
  let separatorBuf = '';
  let slotCount = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '$') {
      const next = body[i + 1];
      if (next === '(') {
        // Typed format slot — find matching `)`.
        const end = body.indexOf(')', i + 2);
        if (end === -1) break;
        if (slotCount > 0) separators.push(separatorBuf);
        separatorBuf = '';
        slotCount += 1;
        i = end + 1;
        continue;
      }
      if (next !== undefined && /[0-9]/.test(next)) {
        // $N back-reference — consume the digit run, do NOT count as slot.
        let j = i + 1;
        while (j < body.length && /[0-9]/.test(body[j])) j += 1;
        separatorBuf += body.slice(i, j);
        i = j;
        continue;
      }
      // Bare $ — a new slot.
      if (slotCount > 0) separators.push(separatorBuf);
      separatorBuf = '';
      slotCount += 1;
      i += 1;
      continue;
    }
    separatorBuf += c;
    i += 1;
  }
  return { slotCount, separators };
}

/**
 * Detect UUID + IPv4 cohorts across the slot sequence. Operates on
 * adjacency-ordered slots (slot_0 ... slot_N), not the cardinality-sorted
 * order pattern-examples uses for display. Uses the template body's
 * static text between slots to discriminate `$-$-$-$-$` (UUID) from
 * `$.$.$.$:$` (IPv4 + port) from `$$$$$` (concatenated hex, no cohort).
 *
 * When a cohort fires:
 *   - cardinality = distinct count of REASSEMBLED values (e.g. full UUIDs),
 *     NOT the sum of per-slot distinct counts.
 *   - inferred_name inherits the Layer-1 JSON-key name of the first member
 *     when available; else a generic kind name (`uuid` / `ipv4`).
 *
 * Members keep their individual slot entries — cohorts are an additional
 * view, not a replacement.
 */
export function detectCohorts(
  slots: SlotInput[],
  templateBody: string,
): Cohort[] {
  // Order by slot index (slot_0, slot_1, ..., slot_N). Skip non-numeric
  // slot identifiers (e.g. `timestamp` from format_spec) — those don't
  // participate in cohorts.
  type Indexed = SlotInput & { idx: number };
  const indexed: Indexed[] = slots
    .map((s) => {
      const idx = parseSlotIndex(s.slot);
      return idx === undefined ? undefined : { ...s, idx };
    })
    .filter((s): s is Indexed => s !== undefined)
    .sort((a, b) => a.idx - b.idx);

  if (indexed.length === 0) return [];

  const { separators } = parseTemplateSlots(templateBody);

  // Build event-aligned value rows so reassembled cardinality is correct.
  // Each row[i] = the i-th sample value across all member slots. We rely
  // on sampleValues being captured in the same observation order across
  // slots. pattern-extraction.ts captures values via Set; order is the
  // insertion order, which is event order. For cohorts where all members
  // are is_constant=true, this collapses to a single reassembled value.
  // For variable cohorts, length mismatches mean we can only report
  // distinct-per-slot as a lower bound; we still emit the cohort but
  // cardinality = max(member distinct counts).

  const raw: Cohort[] = [];
  let i = 0;
  while (i < indexed.length) {
    const tryUuid = matchCohort(indexed, separators, i, 'uuid');
    if (tryUuid) {
      raw.push(tryUuid);
      i += tryUuid.member_slots.length;
      continue;
    }
    const tryMac = matchCohort(indexed, separators, i, 'mac');
    if (tryMac) {
      raw.push(tryMac);
      i += tryMac.member_slots.length;
      continue;
    }
    const tryIp = matchCohort(indexed, separators, i, 'ipv4');
    if (tryIp) {
      raw.push(tryIp);
      i += tryIp.member_slots.length;
      continue;
    }
    i += 1;
  }

  // Dedupe: when the same template repeats a cohort shape (e.g. an error
  // message printed N times in the body), each instance is structurally
  // a distinct slot range but holds the SAME values. Collapse those into
  // one cohort entry whose `member_slots` lists every position the value
  // lands in. Two cohorts merge only when kind + inferred_name + sample
  // set all match; differing samples mean the IPs/UUIDs are actually
  // different and the cohorts stay separate.
  const byKey = new Map<string, Cohort>();
  for (const c of raw) {
    const key = `${c.kind}|${c.inferred_name}|${[...c.sample_values].sort().join(',')}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.member_slots.push(...c.member_slots);
    } else {
      byKey.set(key, c);
    }
  }
  return Array.from(byKey.values());
}

function parseSlotIndex(slot: string): number | undefined {
  const m = slot.match(/^slot_(\d+)$/);
  if (m) return parseInt(m[1], 10);
  return undefined;
}

function matchCohort(
  indexed: Array<SlotInput & { idx: number }>,
  separators: string[],
  start: number,
  kind: 'uuid' | 'ipv4' | 'mac',
): Cohort | undefined {
  const expected = kind === 'uuid' ? 5 : kind === 'mac' ? 6 : 4;
  if (start + expected > indexed.length) return undefined;
  const members = indexed.slice(start, start + expected);

  // Adjacency: member indices must be contiguous (idx, idx+1, ..., idx+N-1).
  for (let m = 1; m < members.length; m++) {
    if (members[m].idx !== members[m - 1].idx + 1) return undefined;
  }

  // Separators between members must match the cohort shape. MAC accepts
  // both `:` (canonical) and `-` (Cisco-style); we record which one
  // matched so reassembly uses the matched separator.
  const expectedSep =
    kind === 'uuid' ? '-' : kind === 'ipv4' ? '.' : null;
  let macSep: '-' | ':' | null = null;
  for (let m = 0; m < members.length - 1; m++) {
    const sepIdx = members[m].idx;
    const sep = separators[sepIdx];
    if (kind === 'mac') {
      if (sep !== ':' && sep !== '-') return undefined;
      if (macSep === null) macSep = sep;
      else if (macSep !== sep) return undefined; // mixed separators reject
    } else if (sep !== expectedSep) {
      return undefined;
    }
  }
  const useSep = kind === 'mac' ? (macSep ?? ':') : (expectedSep as string);

  // Sample-value shape per slot.
  for (let m = 0; m < members.length; m++) {
    if (kind === 'uuid') {
      const lenWanted = UUID_SEGMENT_LENGTHS[m];
      for (const v of members[m].sampleValues) {
        if (v.length !== lenWanted || !HEX_RE.test(v)) return undefined;
      }
    } else if (kind === 'mac') {
      for (const v of members[m].sampleValues) {
        if (!MAC_OCTET_RE.test(v)) return undefined;
      }
    } else {
      for (const v of members[m].sampleValues) {
        if (!IPV4_OCTET_RE.test(v)) return undefined;
      }
    }
  }

  // Reassemble values. Cardinality = distinct reassembled count.
  const sampleCount = Math.min(...members.map((m) => m.sampleValues.length));
  const reassembled: string[] = [];
  for (let r = 0; r < sampleCount; r++) {
    reassembled.push(members.map((m) => m.sampleValues[r]).join(useSep));
  }
  const distinctSet = new Set(reassembled);
  let cardinality = distinctSet.size;
  if (sampleCount === 0) {
    cardinality = Math.max(...members.map((m) => m.sampleValues.length));
  }

  // Name inheritance: prefer the first member's Layer-1 JSON-key name.
  const firstName = inferSlotName(members[0].precedingToken, members[0].sampleValues);
  const fallback = kind === 'uuid' ? 'uuid' : kind === 'mac' ? 'mac' : 'ipv4';
  const inferredName =
    firstName && firstName.source === 'json_key' ? firstName.name : fallback;
  const confidence: NamingConfidence =
    firstName && firstName.source === 'json_key' ? 'high' : 'medium';

  return {
    member_slots: members.map((m) => m.slot),
    inferred_name: inferredName,
    naming_confidence: confidence,
    kind,
    cardinality,
    sample_values: Array.from(distinctSet).slice(0, 3),
  };
}
