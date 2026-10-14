/**
 * Which Datadog log monitors and log-based metrics read the lines a rule
 * moves off Standard.
 *
 * A rule is a service (k8s container), its action (`tier_down` to Flex or
 * `offload` to S3) and the statements it moves. Each monitor or metric search
 * is parsed as Datadog log search syntax and evaluated against every moved
 * statement as a virtual log line: its service, its fixed text, status not
 * known. Facets the line does not carry (env, host, @attributes) evaluate as
 * unknown, so they never rule a statement out.
 *
 * What counts as a match:
 *   - service: a positive `service:` (or `container_name:` /
 *     `kube_container_name:`) value equals, or wildcard-matches, the rule's
 *     service or one of its aliases. A query that names only other services,
 *     or negates this one, does not match.
 *   - text: no service facet names the rule, and a positive free-text term or
 *     quoted phrase appears in a moved statement's fixed text (whole words,
 *     case-insensitive, phrases as a contiguous run). Values that fill a
 *     template slot are not known and never count.
 *   - unscoped: neither, yet the query does not rule the statements out
 *     (`*`, `status:error`, `env:prod`). Listed once for all rules.
 * A text term narrows a service match to the statements that contain it; a
 * query whose text no moved statement contains does not match.
 *
 * errors_only: the query rejects info, debug, notice and ok lines. When no
 * moved statement is error-class, the severity defaults keep those lines in
 * Standard and the monitor is not blinded.
 *
 * Flex lines do not feed log monitors; log-based metrics are generated at
 * ingestion and still count them. Offloaded lines never reach Datadog.
 */

import { isProtectedSeverity } from '../../severity-policy.js';
import type { LogQueryObject } from './types.js';

// ─── parse ──────────────────────────────────────────────────────────────────

export type QueryNode =
  | { t: 'and'; kids: QueryNode[] }
  | { t: 'or'; kids: QueryNode[] }
  | { t: 'not'; kid: QueryNode }
  | { t: 'all' }
  | { t: 'unknown' }
  | { t: 'facet'; key: string; value: string }
  | { t: 'text'; value: string; phrase: boolean };

type Tok =
  | { k: 'lp' }
  | { k: 'rp' }
  | { k: 'and' }
  | { k: 'or' }
  | { k: 'not' }
  | { k: 'phrase'; v: string }
  | { k: 'term'; v: string }
  | { k: 'facet'; key: string; v: string; quoted: boolean }
  | { k: 'group'; key: string };

function lex(q: string): Tok[] {
  const out: Tok[] = [];
  const n = q.length;
  let i = 0;
  const isWs = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);
  const readQuoted = (): string => {
    i++;
    let s = '';
    while (i < n && q[i] !== '"') {
      if (q[i] === '\\' && i + 1 < n) {
        s += q[i + 1];
        i += 2;
        continue;
      }
      s += q[i++];
    }
    i++;
    return s;
  };

  while (i < n) {
    const c = q[i];
    if (isWs(c)) { i++; continue; }
    if (c === '(') { out.push({ k: 'lp' }); i++; continue; }
    if (c === ')') { out.push({ k: 'rp' }); i++; continue; }
    if (c === '"') { out.push({ k: 'phrase', v: readQuoted() }); continue; }
    if (c === '-' && i + 1 < n && !isWs(q[i + 1])) { out.push({ k: 'not' }); i++; continue; }

    let buf = '';
    let key: string | undefined;
    let quoted = false;
    let group = false;
    while (i < n && !isWs(q[i]) && q[i] !== '(' && q[i] !== ')') {
      const ch = q[i];
      if (ch === '\\' && i + 1 < n) {
        buf += q[i + 1];
        i += 2;
        continue;
      }
      if (ch === ':' && key === undefined && buf.length > 0) {
        key = buf;
        buf = '';
        i++;
        if (q[i] === '"') { buf = readQuoted(); quoted = true; break; }
        if (q[i] === '(') { group = true; break; }
        if (q[i] === '[' || q[i] === '{') {
          const close = q[i] === '[' ? ']' : '}';
          const j = q.indexOf(close, i);
          buf = q.slice(i, j < 0 ? n : j + 1);
          i = j < 0 ? n : j + 1;
          break;
        }
        continue;
      }
      buf += ch;
      i++;
    }
    if (key !== undefined) {
      out.push(group ? { k: 'group', key } : { k: 'facet', key, v: buf, quoted });
      continue;
    }
    if (buf === 'AND') out.push({ k: 'and' });
    else if (buf === 'OR') out.push({ k: 'or' });
    else if (buf === 'NOT') out.push({ k: 'not' });
    else if (buf.length > 0) out.push({ k: 'term', v: buf });
  }
  return out;
}

/** Parse a Datadog log search string. Malformed input degrades to unknown, never throws. */
export function parseLogSearch(query: string): QueryNode {
  const toks = lex(query);
  if (toks.length === 0) return { t: 'all' };
  let p = 0;
  const peek = (): Tok | undefined => toks[p];

  const parseOr = (key?: string): QueryNode => {
    const kids = [parseAnd(key)];
    while (peek()?.k === 'or') {
      p++;
      kids.push(parseAnd(key));
    }
    return kids.length === 1 ? kids[0] : { t: 'or', kids };
  };
  const parseAnd = (key?: string): QueryNode => {
    const kids = [parseUnary(key)];
    for (;;) {
      const tk = peek();
      if (!tk || tk.k === 'rp' || tk.k === 'or') break;
      if (tk.k === 'and') { p++; continue; }
      kids.push(parseUnary(key));
    }
    return kids.length === 1 ? kids[0] : { t: 'and', kids };
  };
  const parseUnary = (key?: string): QueryNode => {
    if (peek()?.k === 'not') {
      p++;
      return { t: 'not', kid: parseUnary(key) };
    }
    return parsePrimary(key);
  };
  const parsePrimary = (key?: string): QueryNode => {
    const tk = peek();
    if (!tk) return { t: 'unknown' };
    if (tk.k === 'rp' || tk.k === 'or' || tk.k === 'and') return { t: 'unknown' };
    p++;
    switch (tk.k) {
      case 'lp': {
        const e = parseOr(key);
        if (peek()?.k === 'rp') p++;
        return e;
      }
      case 'group': {
        if (peek()?.k !== 'lp') return { t: 'unknown' };
        p++;
        const e = parseOr(tk.key);
        if (peek()?.k === 'rp') p++;
        return e;
      }
      case 'facet':
        return { t: 'facet', key: tk.key, value: tk.v };
      case 'phrase':
        return key ? { t: 'facet', key, value: tk.v } : { t: 'text', value: tk.v, phrase: true };
      case 'term':
        if (key) return { t: 'facet', key, value: tk.v };
        return tk.v === '*' ? { t: 'all' } : { t: 'text', value: tk.v, phrase: false };
      default:
        return { t: 'unknown' };
    }
  };

  const kids: QueryNode[] = [];
  while (p < toks.length) {
    const before = p;
    kids.push(parseOr());
    if (peek()?.k === 'rp') p++;
    if (p === before) p++;
  }
  return kids.length === 1 ? kids[0] : { t: 'and', kids };
}

// ─── evaluate ───────────────────────────────────────────────────────────────

/** Three-valued: 0 false, 0.5 unknown, 1 true. */
type Tri = 0 | 0.5 | 1;

const SERVICE_KEYS = new Set(['service', 'container_name', 'kube_container_name']);
const STATUS_KEYS = new Set(['status', '@status', 'level', '@level']);
const MESSAGE_KEYS = new Set(['message', '@message']);
const SLOT = '\u0000';

export interface StatementLine {
  /** The rule's service and aliases, lower-cased. */
  services: string[];
  /** Fixed-text tokens of the statement; template slots are SLOT. */
  tokens: string[];
  /** Line status, when the evaluation pins one. */
  status?: string;
}

/** Lower-cased word tokens of a statement's fixed text; `$` marks a slot. */
export function statementTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\$/g, ` ${SLOT} `)
    .split(/[^a-z0-9\u0000]+/)
    .filter(Boolean);
}

const globCache = new Map<string, RegExp>();
function globToRegExp(glob: string): RegExp {
  const g = glob.toLowerCase();
  let re = globCache.get(g);
  if (!re) {
    const body = g
      .split('')
      .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('');
    re = new RegExp(`^${body}$`);
    if (globCache.size > 5000) globCache.clear();
    globCache.set(g, re);
  }
  return re;
}

function valueMatches(pattern: string, value: string): boolean {
  if (/[*?]/.test(pattern)) return globToRegExp(pattern).test(value.toLowerCase());
  return pattern.toLowerCase() === value.toLowerCase();
}

const STATUS_CANON: Record<string, string> = {
  emerg: 'emergency', crit: 'critical', err: 'error', warning: 'warn', informational: 'info',
};
const canonStatus = (s: string): string => STATUS_CANON[s.toLowerCase()] ?? s.toLowerCase();

function containsRun(tokens: string[], run: string[]): boolean {
  if (run.length === 0) return false;
  outer: for (let i = 0; i + run.length <= tokens.length; i++) {
    for (let j = 0; j < run.length; j++) {
      const t = tokens[i + j];
      if (t === SLOT) continue outer;
      const r = run[j];
      if (/[*?]/.test(r) ? !globToRegExp(r).test(t) : t !== r) continue outer;
    }
    return true;
  }
  return false;
}

function evalText(value: string, phrase: boolean, line: StatementLine): Tri {
  const run = value
    .toLowerCase()
    .split(phrase ? /[^a-z0-9]+/ : /[^a-z0-9*?]+/)
    .filter(Boolean);
  if (run.length === 0) return 0.5;
  return containsRun(line.tokens, run) ? 1 : 0;
}

function evalFacet(key: string, value: string, line: StatementLine): Tri {
  const k = key.toLowerCase();
  if (SERVICE_KEYS.has(k)) return line.services.some((s) => valueMatches(value, s)) ? 1 : 0;
  if (STATUS_KEYS.has(k)) {
    if (line.status === undefined) return 0.5;
    return valueMatches(canonStatus(value), canonStatus(line.status)) ? 1 : 0;
  }
  if (MESSAGE_KEYS.has(k)) return evalText(value, true, line);
  return 0.5;
}

export function evaluateLogSearch(node: QueryNode, line: StatementLine): Tri {
  switch (node.t) {
    case 'all':
      return 1;
    case 'unknown':
      return 0.5;
    case 'not':
      return (1 - evaluateLogSearch(node.kid, line)) as Tri;
    case 'and': {
      let v: Tri = 1;
      for (const k of node.kids) {
        const x = evaluateLogSearch(k, line);
        if (x < v) v = x;
        if (v === 0) break;
      }
      return v;
    }
    case 'or': {
      let v: Tri = 0;
      for (const k of node.kids) {
        const x = evaluateLogSearch(k, line);
        if (x > v) v = x;
        if (v === 1) break;
      }
      return v;
    }
    case 'facet':
      return evalFacet(node.key, node.value, line);
    case 'text':
      return evalText(node.value, node.phrase, line);
  }
}

/** Leaves reached through an even number of negations. */
function positiveLeaves(node: QueryNode, negated = false, out: QueryNode[] = []): QueryNode[] {
  switch (node.t) {
    case 'and':
    case 'or':
      for (const k of node.kids) positiveLeaves(k, negated, out);
      break;
    case 'not':
      positiveLeaves(node.kid, !negated, out);
      break;
    default:
      if (!negated) out.push(node);
  }
  return out;
}

const NON_ERROR_STATUSES = ['info', 'debug', 'notice', 'ok'];
const ERROR_STATUSES = ['emergency', 'alert', 'critical', 'error', 'warn'];

// ─── rules ──────────────────────────────────────────────────────────────────

export type RuleAction = 'tier_down' | 'offload';

export interface RuleStatement {
  /** The statement's identity as the plan names it. */
  name: string;
  /** Template text with `$` slots, when known; the name is matched otherwise. */
  text?: string;
  severity?: string;
}

export interface DependencyRule {
  /** The k8s container the rule is keyed on. */
  service: string;
  /** Other names the same lines carry in Datadog's `service` tag. */
  aliases?: string[];
  action: RuleAction;
  statements: RuleStatement[];
  /**
   * The fleet default, not a row of the service's own: it holds every
   * statement above the limit, error statements included, so no query that
   * reads only error lines is treated as kept in Standard.
   */
  fleetDefault?: boolean;
}

export type DependencyEffect = 'goes_blind' | 'not_blinded' | 'stops_counting' | 'still_counts';

export interface RuleDependencyMatch {
  kind: 'log_monitor' | 'log_metric';
  id: string;
  name: string;
  url?: string;
  query: string;
  matched_on: 'service' | 'text';
  /** Set when the query reads only some of the moved statements. */
  statements?: string[];
  errors_only: boolean;
  effect: DependencyEffect;
  line: string;
}

export interface RuleDependencyCheck {
  service: string;
  action: RuleAction;
  /** Set for a service the fleet default covers. */
  fleet_default?: boolean;
  statements: number;
  monitors: RuleDependencyMatch[];
  metrics: RuleDependencyMatch[];
  lines: string[];
}

export interface UnscopedDependency {
  kind: 'log_monitor' | 'log_metric';
  id: string;
  name: string;
  url?: string;
  query: string;
  /** all: the query reads every line; maybe: it filters on fields a statement does not show. */
  reads: 'all' | 'maybe';
  errors_only: boolean;
  services: string[];
  actions: RuleAction[];
  line: string;
}

export interface RuleDependencySummary {
  checked: boolean;
  note: string;
  log_monitors_scanned: number;
  log_metrics_scanned: number;
  rules: RuleDependencyCheck[];
  unscoped: UnscopedDependency[];
  /** Every rendered line: each rule's block, then the unscoped block. */
  lines: string[];
}

interface ParsedObject {
  obj: LogQueryObject;
  searches: Array<{ query: string; node: QueryNode }>;
}

interface PreparedStatement {
  stmt: RuleStatement;
  tokens: string[];
}

const ACTION_PHRASE: Record<RuleAction, string> = {
  tier_down: 'tier_down to Flex',
  offload: 'offload to S3',
};

const MAX_LISTED = 5;
const MAX_STATEMENTS_NAMED = 3;

function quoteName(s: string): string {
  return `"${s}"`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function effectFor(
  kind: 'log_monitor' | 'log_metric',
  action: RuleAction,
  errorsOnly: boolean,
  errorsStay: boolean,
): DependencyEffect {
  if (errorsOnly && errorsStay) return kind === 'log_monitor' ? 'not_blinded' : 'still_counts';
  if (kind === 'log_monitor') return 'goes_blind';
  return action === 'offload' ? 'stops_counting' : 'still_counts';
}

function effectClause(
  kind: 'log_monitor' | 'log_metric',
  action: RuleAction,
  effect: DependencyEffect,
): string {
  if (effect === 'not_blinded') {
    return 'reads only error and warning lines, which the severity defaults keep in Standard, so it is not blinded';
  }
  if (kind === 'log_metric' && effect === 'still_counts' && action === 'offload') {
    return 'counts only error and warning lines, which the severity defaults keep in Standard, so it keeps counting';
  }
  if (effect === 'goes_blind') {
    return action === 'offload'
      ? 'goes blind to the lines sent to S3'
      : 'stops seeing the lines moved to Flex, because Flex lines do not feed log monitors';
  }
  if (effect === 'stops_counting') return 'stops counting the lines sent to S3';
  return 'still counts the lines moved to Flex, because Datadog generates log-based metrics at ingestion';
}

function objectNoun(kind: 'log_monitor' | 'log_metric', name: string): string {
  return kind === 'log_monitor' ? `Monitor ${quoteName(name)}` : `Log-based metric ${name}`;
}

function matchLine(m: Omit<RuleDependencyMatch, 'line'>, action: RuleAction): string {
  const detail = [`query ${m.query || '*'}`];
  if (m.statements && m.statements.length > 0) {
    const named = m.statements.slice(0, MAX_STATEMENTS_NAMED).join(', ');
    const more = m.statements.length > MAX_STATEMENTS_NAMED ? ` and ${m.statements.length - MAX_STATEMENTS_NAMED} more` : '';
    detail.push(`${m.statements.length === 1 ? 'statement' : 'statements'} ${named}${more}`);
  }
  return `${objectNoun(m.kind, m.name)} ${effectClause(m.kind, action, m.effect)} (${detail.join('; ')}).`;
}

function prepare(stmts: RuleStatement[]): PreparedStatement[] {
  return stmts.map((stmt) => ({ stmt, tokens: statementTokens(stmt.text || stmt.name) }));
}

function lineFor(services: string[], p: PreparedStatement, status?: string): StatementLine {
  return { services, tokens: p.tokens, ...(status !== undefined ? { status } : {}) };
}

interface SearchVerdict {
  matchedOn: 'service' | 'text' | 'unscoped';
  reads: 'all' | 'maybe';
  matched: PreparedStatement[];
  errorsOnly: boolean;
}

function judgeSearch(node: QueryNode, services: string[], stmts: PreparedStatement[]): SearchVerdict | null {
  const scored = stmts.map((p) => ({ p, v: evaluateLogSearch(node, lineFor(services, p)) }));
  const matched = scored.filter((s) => s.v > 0);
  if (matched.length === 0) return null;

  const leaves = positiveLeaves(node);
  const serviceNamed = leaves.some(
    (l) => l.t === 'facet' && SERVICE_KEYS.has(l.key.toLowerCase()) && services.some((s) => valueMatches(l.value, s)),
  );
  const textHit = leaves.some((l) =>
    matched.some(({ p }) => {
      const line = lineFor(services, p);
      if (l.t === 'text') return evalText(l.value, l.phrase, line) === 1;
      if (l.t === 'facet' && MESSAGE_KEYS.has(l.key.toLowerCase())) return evalText(l.value, true, line) === 1;
      return false;
    }),
  );
  const errorsOnly = matched.every(
    ({ p }) =>
      NON_ERROR_STATUSES.every((s) => evaluateLogSearch(node, lineFor(services, p, s)) === 0) &&
      ERROR_STATUSES.some((s) => evaluateLogSearch(node, lineFor(services, p, s)) > 0),
  );
  return {
    matchedOn: serviceNamed ? 'service' : textHit ? 'text' : 'unscoped',
    reads: matched.every((s) => s.v === 1) ? 'all' : 'maybe',
    matched: matched.map((s) => s.p),
    errorsOnly,
  };
}

const RANK: Record<SearchVerdict['matchedOn'], number> = { service: 2, text: 1, unscoped: 0 };

/**
 * One verdict per object across its searches (a formula monitor carries
 * several). The object is errors-only only when every matching search is,
 * so an error-rate monitor whose denominator reads all lines is blinded.
 */
function combineSearches(
  searches: ParsedObject['searches'],
  services: string[],
  stmts: PreparedStatement[],
): { query: string; v: SearchVerdict } | null {
  const hits: Array<{ query: string; v: SearchVerdict }> = [];
  for (const s of searches) {
    const v = judgeSearch(s.node, services, stmts);
    if (v) hits.push({ query: s.query, v });
  }
  if (hits.length === 0) return null;
  const errorsOnly = hits.every((h) => h.v.errorsOnly);
  hits.sort((a, b) => RANK[b.v.matchedOn] - RANK[a.v.matchedOn] || Number(a.v.errorsOnly) - Number(b.v.errorsOnly));
  const matched = stmts.filter((p) => hits.some((h) => h.v.matched.includes(p)));
  return {
    query: hits[0].query,
    v: {
      matchedOn: hits[0].v.matchedOn,
      reads: hits.some((h) => h.v.reads === 'all') ? 'all' : 'maybe',
      matched,
      errorsOnly,
    },
  };
}

/** Parse each object's searches once; objects with no readable search are skipped. */
function parseObjects(objects: LogQueryObject[]): ParsedObject[] {
  return objects
    .filter((o) => o.searches.length > 0)
    .map((obj) => ({ obj, searches: obj.searches.map((query) => ({ query, node: parseLogSearch(query) })) }));
}

function ruleHeader(rule: DependencyRule, monitors: number, metrics: number): string {
  const head = rule.fleetDefault
    ? `${rule.service} (fleet default, ${ACTION_PHRASE[rule.action]} above the limit, ${plural(rule.statements.length, 'statement', 'statements')})`
    : `${rule.service} (${ACTION_PHRASE[rule.action]}, ${plural(rule.statements.length, 'statement', 'statements')})`;
  if (monitors === 0 && metrics === 0) {
    return `${head}: no log monitor or log-based metric queries this service or the text of these statements.`;
  }
  const parts: string[] = [];
  if (monitors > 0) parts.push(plural(monitors, 'log monitor', 'log monitors'));
  if (metrics > 0) parts.push(plural(metrics, 'log-based metric', 'log-based metrics'));
  return `${head}: ${parts.join(' and ')} ${monitors + metrics === 1 ? 'reads' : 'read'} these lines.`;
}

/** The lines to print beside one service's rule (both blocks when it has two actions). */
export function dependencyLinesForService(summary: RuleDependencySummary | undefined, service: string): string[] {
  if (!summary) return [];
  return summary.rules.filter((r) => r.service === service && !r.fleet_default).flatMap((r) => r.lines);
}

/** The lines for the services the fleet default covers, printed beside the fleet line. */
export function dependencyLinesForFleetDefault(summary: RuleDependencySummary | undefined): string[] {
  if (!summary) return [];
  return summary.rules.filter((r) => r.fleet_default).flatMap((r) => r.lines);
}

function renderRule(rule: DependencyRule, monitors: RuleDependencyMatch[], metrics: RuleDependencyMatch[]): string[] {
  const lines = [ruleHeader(rule, monitors.length, metrics.length)];
  for (const group of [monitors, metrics]) {
    for (const m of group.slice(0, MAX_LISTED)) lines.push(m.line);
    if (group.length > MAX_LISTED) {
      const noun = group[0].kind === 'log_monitor' ? 'log monitors' : 'log-based metrics';
      lines.push(`${group.length - MAX_LISTED} more ${noun} read these lines; the full list is in rule_dependencies.`);
    }
  }
  return lines;
}

function unscopedLine(u: Omit<UnscopedDependency, 'line'>, errorsStay: boolean): string {
  const noun = objectNoun(u.kind, u.name);
  const q = `query ${u.query || '*'}`;
  if (u.errors_only && errorsStay) {
    return u.kind === 'log_monitor'
      ? `${noun} reads only error and warning lines, which the severity defaults keep in Standard, so it is not blinded (${q}).`
      : `${noun} counts only error and warning lines, which the severity defaults keep in Standard, so it keeps counting (${q}).`;
  }
  const offload = u.actions.includes('offload');
  const tier = u.actions.includes('tier_down');
  let effect: string;
  if (u.kind === 'log_monitor') {
    effect = offload && tier
      ? 'stops seeing the lines these rules move off Standard'
      : offload
        ? 'goes blind to the lines these rules send to S3'
        : 'stops seeing the lines these rules move to Flex, because Flex lines do not feed log monitors';
  } else {
    effect = offload && tier
      ? 'still counts the lines moved to Flex and stops counting the lines sent to S3'
      : offload
        ? 'stops counting the lines these rules send to S3'
        : 'still counts the lines these rules move to Flex, because Datadog generates log-based metrics at ingestion';
  }
  return u.reads === 'all'
    ? `${noun} reads every service and ${effect} (${q}).`
    : `${noun} filters on fields these statements do not show, so it may read their lines; if it does, it ${effect} (${q}).`;
}

/**
 * Match every rule against the account's log monitors and log-based metrics.
 * Pure: the caller fetched the objects once.
 */
export function matchRuleDependencies(
  rules: DependencyRule[],
  objects: LogQueryObject[],
  opts: { notes?: string[] } = {},
): RuleDependencySummary {
  const parsed = parseObjects(objects);
  const monitorsScanned = objects.filter((o) => o.kind === 'log_monitor').length;
  const metricsScanned = objects.filter((o) => o.kind === 'log_metric').length;
  const unscopedById = new Map<string, Omit<UnscopedDependency, 'line'> & { errorsStay: boolean }>();
  const checks: RuleDependencyCheck[] = [];

  for (const rule of rules) {
    const services = [rule.service, ...(rule.aliases ?? [])]
      .map((s) => s.trim().toLowerCase())
      .filter((s, i, a) => s.length > 0 && a.indexOf(s) === i);
    const stmts = prepare(rule.statements);
    const errorsStay = rule.fleetDefault ? false : !rule.statements.some((s) => isProtectedSeverity(s.severity));
    const monitors: RuleDependencyMatch[] = [];
    const metrics: RuleDependencyMatch[] = [];

    for (const { obj, searches } of parsed) {
      const best = combineSearches(searches, services, stmts);
      if (!best) continue;
      const { v } = best;
      if (v.matchedOn === 'unscoped') {
        const key = `${obj.kind}\u0000${obj.id}`;
        const prev = unscopedById.get(key);
        if (prev) {
          if (!prev.services.includes(rule.service)) prev.services.push(rule.service);
          if (!prev.actions.includes(rule.action)) prev.actions.push(rule.action);
          prev.errors_only = prev.errors_only && v.errorsOnly;
          prev.errorsStay = prev.errorsStay && errorsStay;
          if (v.reads === 'maybe') prev.reads = 'maybe';
        } else {
          unscopedById.set(key, {
            kind: obj.kind,
            id: obj.id,
            name: obj.name,
            ...(obj.url ? { url: obj.url } : {}),
            query: best.query,
            reads: v.reads,
            errors_only: v.errorsOnly,
            services: [rule.service],
            actions: [rule.action],
            errorsStay,
          });
        }
        continue;
      }
      const narrowed = v.matched.length < stmts.length;
      const effect = effectFor(obj.kind, rule.action, v.errorsOnly, errorsStay);
      const base: Omit<RuleDependencyMatch, 'line'> = {
        kind: obj.kind,
        id: obj.id,
        name: obj.name,
        ...(obj.url ? { url: obj.url } : {}),
        query: best.query,
        matched_on: v.matchedOn,
        ...(narrowed || v.matchedOn === 'text' ? { statements: v.matched.map((p) => p.stmt.name) } : {}),
        errors_only: v.errorsOnly,
        effect,
      };
      const m: RuleDependencyMatch = { ...base, line: matchLine(base, rule.action) };
      (obj.kind === 'log_monitor' ? monitors : metrics).push(m);
    }

    checks.push({
      service: rule.service,
      action: rule.action,
      ...(rule.fleetDefault ? { fleet_default: true } : {}),
      statements: rule.statements.length,
      monitors,
      metrics,
      lines: renderRule(rule, monitors, metrics),
    });
  }

  const unscoped: UnscopedDependency[] = [...unscopedById.values()].map(({ errorsStay, ...u }) => ({
    ...u,
    line: unscopedLine(u, errorsStay),
  }));

  const lines = checks.flatMap((c) => c.lines);
  if (unscoped.length > 0) {
    const um = unscoped.filter((u) => u.kind === 'log_monitor').length;
    const ul = unscoped.length - um;
    const counts = [
      ...(um > 0 ? [plural(um, 'log monitor', 'log monitors')] : []),
      ...(ul > 0 ? [plural(ul, 'log-based metric', 'log-based metrics')] : []),
    ].join(' and ');
    lines.push(`Not tied to one service: ${counts} also ${unscoped.length === 1 ? 'reads' : 'read'} lines from the services above.`);
    for (const u of unscoped.slice(0, MAX_LISTED)) lines.push(u.line);
    if (unscoped.length > MAX_LISTED) {
      lines.push(`${unscoped.length - MAX_LISTED} more read lines from these services; the full list is in rule_dependencies.`);
    }
  }

  const matchedCount = checks.reduce((s, c) => s + c.monitors.length + c.metrics.length, 0);
  const noteParts = [
    `checked ${plural(monitorsScanned, 'log monitor', 'log monitors')} and ${plural(metricsScanned, 'log-based metric', 'log-based metrics')} against ${plural(rules.length, 'rule', 'rules')}`,
    matchedCount > 0
      ? `${matchedCount} ${matchedCount === 1 ? 'match' : 'matches'} by service or statement text`
      : 'none queries these services or the text of these statements',
  ];
  if (unscoped.length > 0) noteParts.push(`${unscoped.length} not tied to a service`);
  const skipped = objects.length - parsed.length;
  if (skipped > 0) noteParts.push(`${skipped} with no readable log search, not matched`);
  for (const n of opts.notes ?? []) noteParts.push(n);

  return {
    checked: true,
    note: noteParts.join('; '),
    log_monitors_scanned: monitorsScanned,
    log_metrics_scanned: metricsScanned,
    rules: checks,
    unscoped,
    lines,
  };
}

/** The not-checked result: one line saying why. */
export function ruleDependenciesNotChecked(reason: string): RuleDependencySummary {
  return {
    checked: false,
    note: reason,
    log_monitors_scanned: 0,
    log_metrics_scanned: 0,
    rules: [],
    unscoped: [],
    lines: [`Log monitors and log-based metrics were not checked: ${reason}.`],
  };
}

/** Log search strings inside a log monitor's query and its formula variables. */
export function logMonitorSearches(query: string | undefined, variables?: unknown): string[] {
  const out: string[] = [];
  const re = /logs\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g;
  for (const m of (query ?? '').matchAll(re)) out.push(m[1].replace(/\\(.)/g, '$1'));
  if (Array.isArray(variables)) {
    for (const v of variables) {
      const rec = v as { data_source?: unknown; search?: { query?: unknown } };
      if (rec && rec.data_source === 'logs' && typeof rec.search?.query === 'string') out.push(rec.search.query);
    }
  }
  return out;
}
