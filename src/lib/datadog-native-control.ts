/**
 * The Datadog POC report's control arm: on the same pulled events, the index
 * filters a person writes without 10x against the per-pattern plan, counted in
 * Datadog's unit (events kept out of the Standard index).
 *
 * Native filters, the rule the public benchmarks use: one per service with
 * `-status:(error OR warn)`; inside a service whose events carry a parsed split
 * attribute (`logger.name`), one per value instead; largest first until they
 * reach the events the plan moves, the overshoot kept.
 */

import { SPLIT_ATTRIBUTES, type PatternCell } from './pattern-extraction.js';
import { isProtectedSeverity } from './severity-policy.js';
import {
  perEventTierPricing,
  projectPerEventTierMove,
  datadogIngestionUsd,
  DATADOG_INGEST_LIST_PRICING,
  fmtEventCount,
  fmtListRate,
  type PerEventTierMove,
} from './cost.js';
import { fmtDollar, fmtGb } from './format.js';

export interface ControlPattern {
  identity: string;
  template: string;
  sampleEvent: string;
  tenxHash?: string;
  service?: string;
  severity?: string;
  count: number;
  bytes: number;
  cells?: PatternCell[];
  /** The plan's action. Anything but `keep` takes the pattern out of the Standard index. */
  action: string;
}

export interface NativeFilter {
  service: string;
  attribute?: { name: string; value: string };
  events: number;
  bytes: number;
}

export interface ArmCounts {
  events: number;
  bytes: number;
  errorsAndWarnings: number;
  /** Events of patterns the plan keeps that this arm moves. */
  keptPatternEventsMoved: number;
  /** Events this arm leaves in Standard that the other arm moves. */
  leftThatOtherMoves: number;
}

export interface ServiceNote {
  service: string;
  /** The parsed split attribute's name, when the service's events carry one with two or more values. */
  splitAttribute?: string;
  filters: NativeFilter[];
  /** Events of the plan's patterns in this service that the native filters leave in Standard. */
  planEventsLeft: number;
}

export interface NativeControl {
  movedPatterns: number;
  native: ArmCounts & { filters: NativeFilter[] };
  plan: ArmCounts & {
    tierDownEvents: number;
    tierDownBytes: number;
    offloadEvents: number;
    offloadBytes: number;
  };
  services: ServiceNote[];
  id: {
    isolable: string[];
    group: string[];
    notIsolable: Array<{ identity: string; events: number; sharedWithKept: string[] }>;
    hashes: string[];
    withoutHash: number;
    /** Moved patterns with no event tied to its envelope; left out of the three counts. */
    unplaced: number;
  };
  eventsCounted: number;
  eventsTotal: number;
}

/** A pattern as the POC renderers carry it, before it is set against the native filters. */
export interface ControlSource {
  identity: string;
  template: string;
  sampleEvent: string;
  tenxHash?: string;
  hash: string;
  service?: string;
  severity?: string;
  count: number;
  bytes: number;
  cells?: PatternCell[];
  recommendedAction: string;
}

/**
 * The control arm's patterns: each pattern's action from the plan when one
 * was solved (anything it does not move is `keep`), else its recommended
 * action. A cell with no Datadog status (a forwarder's raw records carry
 * none) takes the pattern's severity as the engine reads it.
 */
export function controlPatterns(
  patterns: ControlSource[],
  plannedAction?: ReadonlyMap<string, string>,
): ControlPattern[] {
  return patterns.map((p) => ({
    identity: p.identity,
    template: p.template,
    sampleEvent: p.sampleEvent,
    ...(p.tenxHash !== undefined ? { tenxHash: p.tenxHash } : {}),
    ...(p.service !== undefined ? { service: p.service } : {}),
    ...(p.severity !== undefined ? { severity: p.severity } : {}),
    count: p.count,
    bytes: p.bytes,
    ...(p.cells ? { cells: p.cells.map((c) => (c.status !== undefined ? c : { ...c, status: p.severity })) } : {}),
    action: plannedAction ? (plannedAction.get(p.tenxHash ?? p.hash) ?? 'keep') : p.recommendedAction,
  }));
}

/** What `-status:(error OR warn)` keeps in Standard. */
function excludedByStatusClause(status?: string): boolean {
  return /^(error|warn|warning)$/i.test(status ?? '');
}

/** The errors-and-warnings column: the protected severities plus Datadog's alert and emergency. */
function isErrorOrWarning(status?: string): boolean {
  return isProtectedSeverity(status) || /^(emerg|emergency|alert)$/i.test(status ?? '');
}

function cellsOf(p: ControlPattern): PatternCell[] {
  if (p.cells) return p.cells;
  return [{ service: p.service, status: p.severity, count: p.count, bytes: p.bytes }];
}

function isMoved(p: ControlPattern): boolean {
  return p.action !== 'keep';
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 0);
}

function joined(ts: string[]): string {
  return ` ${ts.join(' ')} `;
}

/**
 * The phrases of a template's constant words: each literal run between slots,
 * as tokens, without a token a slot touches (that token's text varies). The
 * escaping follows `templateEnds`: `/` escapes the next character, `$` opens a
 * slot, `$(...)` a timestamp slot and `$N` a back-reference.
 */
export function templatePhrases(template: string): string[][] {
  const runs: Array<{ text: string; afterSlot: boolean; beforeSlot: boolean }> = [];
  let cur = '';
  let afterSlot = false;
  let i = 0;
  const n = template.length;
  while (i < n) {
    const c = template[i];
    if (c === '/' && i + 1 < n) {
      cur += template[i + 1];
      i += 2;
      continue;
    }
    if (c === '$') {
      runs.push({ text: cur, afterSlot, beforeSlot: true });
      cur = '';
      afterSlot = true;
      i += 1;
      if (i < n && template[i] === '(') {
        const close = template.indexOf(')', i);
        if (close >= 0 && close <= i + 40 && !template.slice(i, close).includes('"')) i = close + 1;
      } else {
        while (i < n && template[i] >= '0' && template[i] <= '9') i += 1;
      }
      continue;
    }
    cur += c;
    i += 1;
  }
  runs.push({ text: cur, afterSlot, beforeSlot: false });
  const out: string[][] = [];
  for (const r of runs) {
    let ts = tokens(r.text);
    if (ts.length > 0 && r.afterSlot && /^[A-Za-z0-9_]/.test(r.text)) ts = ts.slice(1);
    if (ts.length > 0 && r.beforeSlot && /[A-Za-z0-9_]$/.test(r.text)) ts = ts.slice(0, -1);
    if (ts.length > 0) out.push(ts);
  }
  return out;
}

function unitKey(service: string, value?: string): string {
  return value === undefined ? service : `${service}\u0000${value}`;
}

export function computeNativeControl(patterns: ControlPattern[]): NativeControl {
  const cells = patterns.map(cellsOf);
  const moved = patterns.map(isMoved);

  // A service splits when its events carry two or more values of one split attribute.
  const splitValues = new Map<string, { name: string; values: Set<string> }>();
  for (const cs of cells) {
    for (const c of cs) {
      if (!c.attribute || !c.service) continue;
      const cur = splitValues.get(c.service) ?? { name: c.attribute.name, values: new Set<string>() };
      if (cur.name === c.attribute.name) cur.values.add(c.attribute.value);
      splitValues.set(c.service, cur);
    }
  }
  const splitOf = (service: string): string | undefined => {
    const s = splitValues.get(service);
    return s && s.values.size >= 2 ? s.name : undefined;
  };

  let planEvents = 0;
  for (let i = 0; i < patterns.length; i++) {
    if (moved[i]) for (const c of cells[i]) planEvents += c.count;
  }

  const units = new Map<string, NativeFilter>();
  for (const cs of cells) {
    for (const c of cs) {
      if (!c.service || excludedByStatusClause(c.status)) continue;
      const split = splitOf(c.service);
      let key: string;
      let attribute: NativeFilter['attribute'];
      if (split) {
        if (!c.attribute || c.attribute.name !== split) continue;
        key = unitKey(c.service, c.attribute.value);
        attribute = c.attribute;
      } else {
        key = unitKey(c.service);
      }
      const u = units.get(key) ?? { service: c.service, ...(attribute ? { attribute } : {}), events: 0, bytes: 0 };
      u.events += c.count;
      u.bytes += c.bytes;
      units.set(key, u);
    }
  }
  const ranked = [...units.entries()].sort(
    (a, b) => b[1].events - a[1].events || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const chosen = new Set<string>();
  const filters: NativeFilter[] = [];
  let reached = 0;
  for (const [key, u] of ranked) {
    if (reached >= planEvents) break;
    chosen.add(key);
    filters.push(u);
    reached += u.events;
  }
  const filterMoves = (c: PatternCell): boolean => {
    if (!c.service || excludedByStatusClause(c.status)) return false;
    const split = splitOf(c.service);
    if (split) return !!c.attribute && c.attribute.name === split && chosen.has(unitKey(c.service, c.attribute.value));
    return chosen.has(unitKey(c.service));
  };

  const native = { events: 0, bytes: 0, errorsAndWarnings: 0, keptPatternEventsMoved: 0, leftThatOtherMoves: 0 };
  const plan = {
    events: 0, bytes: 0, errorsAndWarnings: 0, keptPatternEventsMoved: 0, leftThatOtherMoves: 0,
    tierDownEvents: 0, tierDownBytes: 0, offloadEvents: 0, offloadBytes: 0,
  };
  const planLeftByService = new Map<string, number>();
  let eventsCounted = 0;
  for (let i = 0; i < patterns.length; i++) {
    for (const c of cells[i]) {
      eventsCounted += c.count;
      const byFilter = filterMoves(c);
      if (byFilter) {
        native.events += c.count;
        native.bytes += c.bytes;
        if (isErrorOrWarning(c.status)) native.errorsAndWarnings += c.count;
        if (!moved[i]) native.keptPatternEventsMoved += c.count;
      }
      if (moved[i]) {
        plan.events += c.count;
        plan.bytes += c.bytes;
        if (isErrorOrWarning(c.status)) plan.errorsAndWarnings += c.count;
        const avoidsIntake = patterns[i].action === 'offload' || patterns[i].action === 'drop';
        if (avoidsIntake) {
          plan.offloadEvents += c.count;
          plan.offloadBytes += c.bytes;
        } else {
          plan.tierDownEvents += c.count;
          plan.tierDownBytes += c.bytes;
        }
        if (!byFilter) {
          native.leftThatOtherMoves += c.count;
          const svc = c.service ?? '';
          planLeftByService.set(svc, (planLeftByService.get(svc) ?? 0) + c.count);
        }
      }
    }
  }
  plan.leftThatOtherMoves = native.keptPatternEventsMoved;

  const services: ServiceNote[] = [];
  const noteOf = new Map<string, ServiceNote>();
  for (const f of filters) {
    let note = noteOf.get(f.service);
    if (!note) {
      const split = splitOf(f.service);
      note = { service: f.service, ...(split ? { splitAttribute: split } : {}), filters: [], planEventsLeft: 0 };
      noteOf.set(f.service, note);
      services.push(note);
    }
    note.filters.push(f);
  }
  for (const [svc, left] of [...planLeftByService.entries()].sort((a, b) => b[1] - a[1])) {
    let note = noteOf.get(svc);
    if (!note) {
      const split = svc ? splitOf(svc) : undefined;
      note = { service: svc, ...(split ? { splitAttribute: split } : {}), filters: [], planEventsLeft: 0 };
      noteOf.set(svc, note);
      services.push(note);
    }
    note.planEventsLeft += left;
  }

  // The pattern ID, counted: can a native filter on service, status, the split
  // attribute and message text select each moved pattern without the others?
  const sampleText = patterns.map((p) => joined(tokens(p.sampleEvent || '')));
  const literalText = patterns.map((p) => templatePhrases(p.template).map(joined));
  const byService = new Map<string, number[]>();
  cells.forEach((cs, i) => {
    for (const svc of new Set(cs.map((c) => c.service ?? ''))) {
      const list = byService.get(svc) ?? [];
      list.push(i);
      byService.set(svc, list);
    }
  });
  const textOf = (j: number, phrase: string): boolean =>
    sampleText[j].includes(phrase) || literalText[j].some((t) => t.includes(phrase));

  const isolable: string[] = [];
  const group: string[] = [];
  const notIsolable: NativeControl['id']['notIsolable'] = [];
  const hashes: string[] = [];
  let withoutHash = 0;
  let unplaced = 0;
  let movedPatterns = 0;
  for (let i = 0; i < patterns.length; i++) {
    if (!moved[i]) continue;
    movedPatterns += 1;
    const p = patterns[i];
    if (p.tenxHash) {
      if (!hashes.includes(p.tenxHash)) hashes.push(p.tenxHash);
    } else {
      withoutHash += 1;
    }
    const cs = cells[i];
    if (cs.length === 0) {
      unplaced += 1;
      continue;
    }
    const scopeService = new Set(cs.map((c) => c.service ?? ''));
    const scopeStatus = new Set(cs.map((c) => (c.status ?? '').toLowerCase()));
    const scopeValues = cs.every((c) => c.attribute)
      ? new Set(cs.map((c) => `${c.attribute!.name}\u0000${c.attribute!.value}`))
      : undefined;
    const multiLine = p.template.includes('\n');
    const phrases = templatePhrases(p.template)
      .map(joined)
      .filter((ph) => multiLine || sampleText[i].includes(ph));
    const candidates = new Set<number>();
    for (const svc of scopeService) for (const j of byService.get(svc) ?? []) if (j !== i) candidates.add(j);
    const shared: number[] = [];
    for (const j of candidates) {
      const inCell = cells[j].some(
        (c) =>
          scopeService.has(c.service ?? '') &&
          scopeStatus.has((c.status ?? '').toLowerCase()) &&
          (!scopeValues || (!!c.attribute && scopeValues.has(`${c.attribute.name}\u0000${c.attribute.value}`))),
      );
      if (inCell && phrases.every((ph) => textOf(j, ph))) shared.push(j);
    }
    if (shared.length === 0) isolable.push(p.identity);
    else if (shared.every((j) => moved[j])) group.push(p.identity);
    else {
      notIsolable.push({
        identity: p.identity,
        events: cs.reduce((s, c) => s + c.count, 0),
        sharedWithKept: shared.filter((j) => !moved[j]).map((j) => patterns[j].identity),
      });
    }
  }

  return {
    movedPatterns,
    native: { ...native, filters },
    plan,
    services,
    id: { isolable, group, notIsolable, hashes, withoutHash, unplaced },
    eventsCounted,
    eventsTotal: patterns.reduce((s, p) => s + p.count, 0),
  };
}

// ── Rendering ──

export interface NativeControlRenderInput {
  patterns: ControlPattern[];
  /** The sample's bytes, the base the report scales from. */
  totalBytes: number;
  totalDailyGb?: number;
  windowHours: number;
  window: string;
  volumeLabel?: string;
  volumeRangeMultiplier?: { low: number; high: number };
  /** No rate to price with: render counts only. */
  dollarsWithheld?: boolean;
}

const STATUS_CLAUSE = '-status:(error OR warn)';

function n(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}

/** A Datadog query value, quoted when it holds anything but plain word characters. */
function ddValue(v: string): string {
  return /^[A-Za-z0-9_.\-/]+$/.test(v) ? v : JSON.stringify(v);
}

export function filterQuery(f: { service: string; attribute?: { name: string; value: string } }): string {
  const attr = f.attribute ? ` @${f.attribute.name}:${ddValue(f.attribute.value)}` : '';
  return `service:${ddValue(f.service)}${attr} ${STATUS_CLAUSE}`;
}

function usd(v: number): string {
  return v > 0 ? `${fmtDollar(v)} (list price)` : 'none';
}

function plural(k: number, one: string, many: string): string {
  return `${n(k)} ${k === 1 ? one : many}`;
}

export function renderNativeControlSection(input: NativeControlRenderInput): string[] {
  const c = computeNativeControl(input.patterns);
  const lines: string[] = [];
  const attrNames = SPLIT_ATTRIBUTES.map((a) => `\`${a}\``).join(' or ');

  lines.push(
    'The same pulled events, kept out of the Standard index two ways. **Native index filters** are what a Datadog user ' +
      `writes without 10x: one per service with \`${STATUS_CLAUSE}\`, and inside a service whose events carry a parsed ${attrNames} ` +
      '(the attribute Datadog\'s Java integration pipelines, Kafka among them, parse), one per value in place of the service filter. ' +
      'They are taken largest first until they reach the events the plan moves, and the overshoot is kept. The **per-pattern plan** is ' +
      'the plan above. Counts are pulled events.',
  );
  lines.push('');
  if (c.eventsCounted < c.eventsTotal) {
    lines.push(
      `${n(c.eventsCounted)} of the ${n(c.eventsTotal)} events are tied to their Datadog envelope and counted here; the rest are left out of both arms.`,
    );
    lines.push('');
  }
  if (c.movedPatterns === 0 || c.plan.events === 0) {
    lines.push('_The plan keeps every pattern in Standard on this sample, so there is nothing to set the native filters against._');
    lines.push('');
    return lines;
  }

  const over = c.native.events - c.plan.events;
  const overText = over > 0 ? ` (${n(over)} more than the plan)` : over < 0 ? ` (${n(-over)} fewer than the plan)` : '';
  const planRules =
    c.id.hashes.length > 0
      ? `1 filter, ${plural(c.id.hashes.length, 'value', 'values')}${c.id.withoutHash > 0 ? ` (${plural(c.id.withoutHash, 'pattern', 'patterns')} without a hash)` : ''}`
      : `${plural(c.movedPatterns, 'pattern row', 'pattern rows')}`;
  lines.push(
    '| Arm | Rules | Events out of Standard | Errors and warnings moved | Events of patterns the plan keeps, moved | Events it leaves in Standard that the other arm moves |',
  );
  lines.push('|---|---|---:|---:|---:|---:|');
  lines.push(
    `| Native index filters | ${plural(c.native.filters.length, 'filter', 'filters')} | ${n(c.native.events)}${overText} | ${n(c.native.errorsAndWarnings)} | ${n(c.native.keptPatternEventsMoved)} | ${n(c.native.leftThatOtherMoves)} |`,
  );
  lines.push(
    `| Per-pattern plan | ${planRules} | ${n(c.plan.events)} | ${n(c.plan.errorsAndWarnings)} | 0 | ${n(c.plan.leftThatOtherMoves)} |`,
  );
  lines.push('');
  lines.push(
    `Errors and warnings are events with status error, warn, critical, alert or emergency; \`${STATUS_CLAUSE}\` keeps the first two in Standard. ` +
      'The plan\'s rule is one `@tenx_hash` index filter with a value per pattern, or the Receiver\'s per-pattern rows behind one `@routeState:tier_down` filter. ' +
      'A native index filter may select on service, status, a parsed attribute and message text (plain terms and quoted phrases); only the `*:` free-text syntax is barred.',
  );
  lines.push('');

  lines.push('**The native filters, by service:**');
  lines.push('');
  const MAX_SERVICES = 12;
  for (const s of c.services.slice(0, MAX_SERVICES)) {
    const label = s.service ? `\`service:${ddValue(s.service)}\`` : 'Events with no service';
    if (s.filters.length > 0 && s.splitAttribute) {
      const MAX_VALUES = 8;
      const list = s.filters.slice(0, MAX_VALUES).map((f) => `\`${filterQuery(f)}\` (${n(f.events)} events)`).join(', ');
      const rest = s.filters.length > MAX_VALUES ? `, and ${plural(s.filters.length - MAX_VALUES, 'more value', 'more values')}` : '';
      lines.push(`- ${label}: \`${s.splitAttribute}\` is parsed on its events, so one filter per value: ${list}${rest}.`);
    } else if (s.filters.length > 0) {
      lines.push(`- \`${filterQuery(s.filters[0])}\` (${n(s.filters[0].events)} events): no parsed attribute on its events, so the service is the finest filter.`);
    }
    if (s.planEventsLeft > 0) {
      const finest = s.splitAttribute
        ? `\`${s.splitAttribute}\` is parsed on its events, so a filter per value would be the finest native filter there`
        : 'no parsed attribute on its events, so the service is the finest filter there';
      const named = s.filters.length > 0 ? 'the filters above leave' : 'not named by the filters, which leave';
      lines.push(`- ${label}, ${named} ${plural(s.planEventsLeft, 'event', 'events')} the plan moves in Standard: ${finest}.`);
    }
  }
  if (c.services.length > MAX_SERVICES) {
    lines.push(`- ${plural(c.services.length - MAX_SERVICES, 'more service', 'more services')}, each named in the same way.`);
  }
  lines.push('');

  // The pattern ID, counted.
  const placed = c.movedPatterns - c.id.unplaced;
  lines.push(
    `**The pattern ID.** Of the ${plural(placed, 'pattern', 'patterns')} the plan moves, a native index filter on service, status, ${attrNames} ` +
      'and message text (a phrase of the pattern\'s constant words, as Log Patterns shows them) isolates ' +
      `${n(c.id.isolable.length)} alone and ${n(c.id.group.length)} only together with other patterns the plan also moves; ` +
      `for ${n(c.id.notIsolable.length)}, every such filter also selects a pattern the plan keeps, so no native filter isolates ${c.id.notIsolable.length === 1 ? 'it' : 'them'}.` +
      (c.id.unplaced > 0 ? ` ${plural(c.id.unplaced, 'more pattern has', 'more patterns have')} no event tied to its envelope and ${c.id.unplaced === 1 ? 'is' : 'are'} not counted.` : ''),
  );
  lines.push('');
  for (const x of c.id.notIsolable.slice(0, 5)) {
    lines.push(
      `- \`${x.identity}\` (${n(x.events)} events): its phrases also match ${x.sharedWithKept.map((k) => `\`${k}\``).join(', ')}, which the plan keeps.`,
    );
  }
  if (c.id.notIsolable.length > 5) lines.push(`- ${plural(c.id.notIsolable.length - 5, 'more', 'more')} the same way.`);
  if (c.id.notIsolable.length > 0) lines.push('');
  if (c.id.hashes.length > 0) {
    lines.push(
      `With the pattern hash the Receiver stamps on each event as \`tenx_hash\`, the ${plural(c.id.hashes.length, 'pattern', 'patterns')} the plan moves are one index filter with ${plural(c.id.hashes.length, 'value', 'values')}:`,
    );
    lines.push('');
    lines.push('```');
    lines.push(`@tenx_hash:(${c.id.hashes.map((h) => JSON.stringify(h)).join(' OR ')})`);
    lines.push('```');
    lines.push('');
  }
  lines.push(
    'One value per pattern: where the engine splits one statement into several patterns, each piece is a value of its own (one statement, several hashes). ' +
      'A pattern\'s value is the same on every pod under the same engine version, library and configuration. ' +
      'Events carry it only when the Receiver runs with `symbolMessageHashField tenx_hash`.' +
      (c.id.withoutHash > 0 ? ` ${plural(c.id.withoutHash, 'pattern', 'patterns')} carry no hash in this run and are not in the filter.` : ''),
  );
  lines.push('');

  // Ingestion beside indexing, at the report's scaling.
  const sampleGiB = input.totalBytes / 1024 ** 3;
  const scale =
    input.totalDailyGb && input.totalDailyGb > 0 && sampleGiB > 0 && input.windowHours > 0
      ? (input.totalDailyGb * (input.windowHours / 24)) / sampleGiB
      : 1;
  const perMonth = input.windowHours > 0 ? (scale * 720) / input.windowHours : 0;
  const pricing = perEventTierPricing('datadog');
  const move = (events: number, bytes: number): PerEventTierMove | undefined =>
    pricing && events > 0 && bytes > 0
      ? projectPerEventTierMove(pricing, bytes * perMonth, { avgEventBytes: bytes / events })
      : undefined;
  const nativeMove = move(c.native.events, c.native.bytes);
  const planMove = move(c.plan.events, c.plan.bytes);
  const planTierMove = move(c.plan.tierDownEvents, c.plan.tierDownBytes);

  const scaledText =
    input.totalDailyGb && input.totalDailyGb > 0
      ? `scaled to ${fmtGb(input.totalDailyGb)}/day (${input.volumeLabel ?? 'the stated volume'}) by each line's share of the sample's bytes, the scaling the cost figures above use`
      : `at the sample's own volume, the ${input.window} pull projected to a month (pass \`total_daily_gb\` to scale it to the estate)`;
  lines.push(`**Ingestion beside indexing**, a month, ${scaledText}:`);
  lines.push('');
  const evM = (events: number): string => fmtEventCount(events * perMonth);
  const gbM = (bytes: number): string => Number(((bytes * perMonth) / 1e9).toFixed(1)).toLocaleString('en-US');
  const ingest = (bytes: number): number => datadogIngestionUsd(bytes * perMonth);
  if (input.dollarsWithheld || !pricing) {
    lines.push('| | Events out of Standard | GB |');
    lines.push('|---|---:|---:|');
    lines.push(`| Native index filters | ${evM(c.native.events)} | ${gbM(c.native.bytes)} |`);
    lines.push(`| Per-pattern plan | ${evM(c.plan.events)} | ${gbM(c.plan.bytes)} |`);
    lines.push('');
    lines.push('_Dollar lines are withheld: no rate is set for this report._');
    lines.push('');
    return lines;
  }
  const flexCol = (planMove ?? nativeMove)?.pricing_tier === 'starter' ? 'Flex Starter added' : 'Flex storage added';
  lines.push(`| | Events out of Standard | GB | Standard indexing avoided | Ingestion still paid | Ingestion avoided | ${flexCol} |`);
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  lines.push(
    `| Native index filters, routed to a Flex index | ${evM(c.native.events)} | ${gbM(c.native.bytes)} | ${usd(nativeMove?.standard_indexing_avoided_usd ?? 0)} | ${usd(ingest(c.native.bytes))} | none | ${usd(nativeMove?.tier_storage_added_usd ?? 0)} |`,
  );
  lines.push(
    `| Per-pattern plan, as written | ${evM(c.plan.events)} | ${gbM(c.plan.bytes)} | ${usd(planMove?.standard_indexing_avoided_usd ?? 0)} | ${usd(ingest(c.plan.tierDownBytes))} | ${usd(ingest(c.plan.offloadBytes))} | ${usd(planTierMove?.tier_storage_added_usd ?? 0)} |`,
  );
  lines.push(
    `| The plan's patterns offloaded to S3 instead | ${evM(c.plan.events)} | ${gbM(c.plan.bytes)} | ${usd(planMove?.standard_indexing_avoided_usd ?? 0)} | none | ${usd(ingest(c.plan.bytes))} | none |`,
  );
  lines.push('');

  // Rates read back from the priced move, so a change in cost.ts reaches this line.
  const ref = planMove ?? nativeMove;
  const millions = ref ? ref.events_moved / 1e6 : 0;
  const indexRate = ref && millions > 0 ? ref.standard_indexing_avoided_usd / millions : pricing.standard_index_usd_per_million_events;
  const months = ref?.tier_retention_months ?? pricing.tier_retention_months;
  const flexRate =
    ref && millions > 0 && months > 0 ? ref.tier_storage_added_usd / millions / months : pricing.tier_storage_usd_per_million_events_month;
  const held = months === 1 ? '30 days' : Number.isInteger(months) ? `${months} months` : `${Math.round(months * 30)} days`;
  const flexLine =
    ref?.pricing_tier === 'starter'
      ? `${pricing.starter.name} ${fmtListRate(flexRate)} per million events stored a month (list price), compute bundled for volumes below ` +
        `${fmtEventCount(pricing.starter.below_events_monthly)} events a month and ${fmtEventCount(pricing.starter.recommended_below_events_stored)} stored, held ${held}`
      : `Flex storage ${fmtListRate(flexRate)} per million events stored a month (list price) on a scalable compute tier, held ${held}; ${ref?.unpriced ?? pricing.unpriced_line}`;
  lines.push(
    'Index filters and tier_down act after Datadog\'s intake, so every line they move still pays ingestion. A line offloaded to S3 ' +
      '(or dropped) before the intake avoids both meters, and is out of Datadog\'s search until it is retrieved. ' +
      `Standard indexing ${fmtListRate(indexRate)} per million events at ${pricing.standard_index_retention_days}-day retention (list price); ` +
      `${flexLine}; ` +
      `ingestion ${fmtListRate(DATADOG_INGEST_LIST_PRICING.usd_per_gb)} per GB (list price). ` +
      `${pricing.source}; ingestion: ${DATADOG_INGEST_LIST_PRICING.source}.`,
  );
  if (input.volumeRangeMultiplier) {
    lines.push('');
    lines.push(
      `The daily volume behind this table is an estimate (${input.volumeRangeMultiplier.low}x to ${input.volumeRangeMultiplier.high}x), and every figure in it carries that range.`,
    );
  }
  lines.push('');
  return lines;
}
