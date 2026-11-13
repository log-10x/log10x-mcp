/**
 * The Retriever `search` grammar, checked before a query is sent.
 *
 * `search` is not free text. The engine parses it when the query starts
 * (pipeline-extensions `QueryFilterEvaluator.parse`, called from
 * `IndexQueryReader.createReaders`) and accepts only:
 *
 *   clause  := field '==' "value"  |  includes '(' field ',' "value" ')'
 *   field   := ident ( '.' ident )?            ident := [letters digits _]+
 *   expr    := clause, '&&' binds tighter than '||', parentheses group
 *
 * Strings have no escapes. Anything else throws inside the query Lambda before
 * the coordinator runs, so no `_DONE.json` is ever written and the caller used
 * to wait out its whole timer. Measured 2026-11-13 on the hosted demo: the
 * search `react hooks` took 202.5 s (180 s marker wait + 20 s quiet window) and
 * came back "0 events, NO_MARKER, poll again"; an outside agent retried that
 * shape for six minutes. The engine's own parser, run on the same string,
 * throws "Expected operator '==' but found 'ID:hooks' at token position 1".
 *
 * This module is a faithful port of that parser (validation only, no
 * evaluation) plus one convenience: plain words, which no valid expression can
 * contain, are rewritten to `includes(text, "...")` clauses and the caller is
 * told the original text and what ran instead.
 */

export const INVALID_SEARCH_PREFIX = 'Invalid search expression:';

type TokType = 'SYMBOL' | 'OP' | 'STRING' | 'ID';
interface Tok { type: TokType; value: string; }

// Java Character.isWhitespace: Unicode space separators except the no-break
// spaces, plus \t \n \u000B \f \r \u001C-\u001F.
const JAVA_WS = /[\t\n\u000B\f\r\u001C-\u001F \u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]/;
// Java Character.isLetterOrDigit (letters + decimal digits) or underscore.
const JAVA_IDENT = /[\p{L}\p{Nd}_]/u;

function tokenize(input: string): Tok[] {
  const toks: Tok[] = [];
  let pos = 0;
  while (pos < input.length) {
    while (pos < input.length && JAVA_WS.test(input[pos])) pos++;
    if (pos >= input.length) break;
    const c = input[pos];
    if ('().,'.includes(c)) {
      toks.push({ type: 'SYMBOL', value: c });
      pos++;
    } else if (c === '&' && input[pos + 1] === '&') {
      toks.push({ type: 'OP', value: '&&' });
      pos += 2;
    } else if (c === '|' && input[pos + 1] === '|') {
      toks.push({ type: 'OP', value: '||' });
      pos += 2;
    } else if (c === '=' && input[pos + 1] === '=') {
      toks.push({ type: 'OP', value: '==' });
      pos += 2;
    } else if (c === '"') {
      const open = pos;
      pos++;
      const start = pos;
      while (pos < input.length && input[pos] !== '"') pos++;
      if (pos >= input.length) {
        throw new Error(`unclosed string starting at position ${open}`);
      }
      toks.push({ type: 'STRING', value: input.slice(start, pos) });
      pos++;
    } else if (JAVA_IDENT.test(c)) {
      const start = pos;
      while (pos < input.length && JAVA_IDENT.test(input[pos])) pos++;
      toks.push({ type: 'ID', value: input.slice(start, pos) });
    } else {
      throw new Error(`invalid character '${c}' at position ${pos}`);
    }
  }
  return toks;
}

function describe(t: Tok | undefined): string {
  return t ? `${t.type}:${t.value}` : 'end of expression';
}

/**
 * Parse `input` with the engine's grammar. Returns the constants (field,
 * value) in order, or throws an Error whose message names the first problem.
 */
export function parseRetrieverSearch(input: string): Array<{ field: string; value: string }> {
  const src = input.trim();
  const toks = tokenize(src);
  if (toks.length === 0) throw new Error('empty expression');
  let i = 0;
  const constants: Array<{ field: string; value: string }> = [];

  const matchOp = (op: string): boolean => {
    if (toks[i]?.type === 'OP' && toks[i].value === op) { i++; return true; }
    return false;
  };
  const matchSym = (s: string): boolean => {
    if (toks[i]?.type === 'SYMBOL' && toks[i].value === s) { i++; return true; }
    return false;
  };
  const expectOp = (op: string): void => {
    if (!matchOp(op)) throw new Error(`expected '${op}' but found '${describe(toks[i])}' at token ${i}`);
  };
  const expectSym = (s: string): void => {
    if (!matchSym(s)) throw new Error(`expected '${s}' but found '${describe(toks[i])}' at token ${i}`);
  };
  const expectString = (): string => {
    if (toks[i]?.type !== 'STRING') throw new Error(`expected a "quoted value" but found '${describe(toks[i])}' at token ${i}`);
    return toks[i++].value;
  };
  const expectId = (): string => {
    if (toks[i]?.type !== 'ID') throw new Error(`expected a field name but found '${describe(toks[i])}' at token ${i}`);
    return toks[i++].value;
  };
  const field = (): string => {
    let f = expectId();
    if (toks[i]?.type === 'SYMBOL' && toks[i].value === '.') {
      i++;
      f += '.' + expectId();
    }
    return f;
  };
  const clause = (): void => {
    if (toks[i]?.type === 'ID' && toks[i].value === 'includes') {
      i++;
      expectSym('(');
      const f = field();
      expectSym(',');
      constants.push({ field: f, value: expectString() });
      expectSym(')');
    } else {
      const f = field();
      expectOp('==');
      constants.push({ field: f, value: expectString() });
    }
  };
  const primary = (): void => {
    if (matchSym('(')) {
      or();
      expectSym(')');
    } else {
      clause();
    }
  };
  const and = (): void => {
    primary();
    while (matchOp('&&')) primary();
  };
  const or = (): void => {
    and();
    while (matchOp('||')) and();
  };

  or();
  if (i < toks.length) {
    throw new Error(`unexpected extra tokens after the expression, starting at '${describe(toks[i])}'`);
  }
  return constants;
}

/** True when the text uses any operator of the grammar, i.e. it was meant as an expression. */
function looksLikeExpression(s: string): boolean {
  return /==|&&|\|\||[(),]/.test(s);
}

/**
 * Split plain text into terms: "quoted phrases" stay whole, other runs of
 * whitespace separate words, a bare uppercase OR splits alternatives and a
 * bare uppercase AND is dropped (adjacent words are already all required).
 * Returns groups of terms: OR between groups, AND within a group.
 */
function plainTerms(s: string): string[][] {
  const groups: string[][] = [[]];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const phrase = m[1];
    const word = m[2];
    if (word === 'OR') {
      if (groups[groups.length - 1].length > 0) groups.push([]);
      continue;
    }
    if (word === 'AND') continue;
    const term = (phrase ?? word ?? '').replace(/"/g, '').trim();
    if (term) groups[groups.length - 1].push(term);
  }
  return groups.filter((g) => g.length > 0);
}

export interface NormalizedSearch {
  /** The expression to send to the engine. */
  search: string;
  /** Set when `search` differs from what the caller sent. */
  rewrittenFrom?: string;
}

const EXAMPLES =
  'Examples: includes(text, "timeout") | includes(text, "connection refused") && severity_level=="ERROR" | ' +
  'pattern_hash from log10x_top_patterns instead of search.';

/**
 * Validate a caller's `search` against the engine grammar.
 *  - a valid expression passes through unchanged;
 *  - plain words (no grammar operators) become includes(text, "...") clauses,
 *    with `rewrittenFrom` carrying the original so the agent can tell its user
 *    what was searched;
 *  - anything else throws `Invalid search expression: ...` before dispatch.
 */
export function normalizeRetrieverSearch(raw: string): NormalizedSearch {
  const original = raw;
  const trimmed = raw.trim();
  try {
    parseRetrieverSearch(trimmed);
    return { search: trimmed };
  } catch (parseErr) {
    if (!looksLikeExpression(trimmed)) {
      const groups = plainTerms(trimmed);
      if (groups.length > 0) {
        const rewritten = groups
          .map((g) => g.map((t) => `includes(text, "${t}")`).join(' && '))
          .join(' || ');
        // The rewrite is built from the grammar; parse it to be certain.
        parseRetrieverSearch(rewritten);
        return { search: rewritten, rewrittenFrom: original };
      }
    }
    const why = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(
      `${INVALID_SEARCH_PREFIX} "${trimmed}" is not in the Retriever search syntax (${why}). ` +
        'search takes field=="value" and includes(field, "value") clauses joined by && and ||; ' +
        'values go in double quotes. ' + EXAMPLES,
    );
  }
}
