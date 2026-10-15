/**
 * The plan in the units a person reads: lines a day per statement and dollars
 * a month. The engine's own units, bytes per regulator window per node, stay
 * in the CSV rows; these sentences sit beside the rows and in their reason
 * column, so the files explain themselves in the repo.
 */

import {
  getDestinationCostModel,
  perEventTierPricing,
  projectAction,
  projectPerEventTierMove,
  type Action,
} from '../cost.js';
import type { SiemId } from '../siem/pricing.js';

export const SECONDS_PER_DAY = 86_400;
/** The engine's rate-regulator reset window. */
export const REGULATOR_WINDOW_SECONDS = 240;
/** Lines of a statement that pass in every window before its limit applies (engine default `rateReceiverBaselineCount`). */
export const ALWAYS_PASS_LINES = 5;

export interface ServiceLimit {
  service: string;
  action: Action;
  /**
   * Lines a day above which a statement takes the route. `null` when every
   * statement takes it (offload, drop, or nothing kept); `undefined` when the
   * rows carry no event count, so no line figure can be stated.
   */
  limitLinesPerDay?: number | null;
  /** Statements the plan moves today. */
  movedStatements: number;
  /** What those statements cost today at list, $/month; absent when no line is priced. */
  movedUsdMonthly?: number;
}

/** A fleet-wide default for services with no row of their own. */
export interface FleetLimit {
  limitLinesPerDay: number;
  action: Action;
}

function tierName(siem: string | null): string | undefined {
  if (!siem) return undefined;
  try {
    return getDestinationCostModel(siem as SiemId).tier_down_target_tier?.name;
  } catch {
    return undefined;
  }
}

/** Where a statement over its limit goes, as a verb phrase. */
export function routeVerb(siem: string | null, action: Action): string {
  switch (action) {
    case 'tier_down': {
      if (siem === 'datadog') return 'goes to Flex';
      if (siem === 'cloudwatch') return 'goes to Infrequent Access';
      const name = tierName(siem);
      return name ? `goes to ${name}` : 'goes to the cheaper tier';
    }
    case 'offload':
      return 'goes to the offload bucket';
    case 'compact':
      return 'is compacted';
    case 'sample':
      return 'is sampled';
    case 'drop':
      return 'is dropped';
    default:
      return 'stays where it lands today';
  }
}

/** Where kept lines land, as a noun. */
export function keptNoun(siem: string | null): string {
  return siem === 'datadog' || siem === 'cloudwatch' ? 'Standard' : 'the ingest path';
}

export function fmtLinesPerDay(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** "about $X": rounded for reading, no trailing zeros. */
export function fmtAboutUsd(usd: number): string {
  if (usd >= 100) return `$${Math.round(usd).toLocaleString('en-US')}`;
  if (usd >= 10) return `$${Math.round(usd)}`;
  if (usd >= 1) return `$${Number(usd.toFixed(1))}`;
  return `$${Number(usd.toFixed(2))}`;
}

/**
 * One service, one sentence pair: the limit in lines a day and what it moves
 * today, in statements and dollars a month.
 */
export function serviceLimitSentence(l: ServiceLimit, siem: string | null): string {
  if (l.action === 'pass') return `${l.service}: every statement stays in ${keptNoun(siem)}.`;
  const verb = routeVerb(siem, l.action);
  const head =
    l.limitLinesPerDay === null
      ? `${l.service}: every statement ${verb}.`
      : l.limitLinesPerDay === undefined
        ? l.action === 'tier_down'
          ? `${l.service}: any statement above the largest statement kept today ${verb}.`
          : `${l.service}: any statement above its limit ${verb}.`
        : `${l.service}: any statement above ${fmtLinesPerDay(l.limitLinesPerDay)} lines a day ${verb}.`;
  const k = l.movedStatements;
  if (k === 0) return `${head} Today no statement is above it.`;
  const money = l.movedUsdMonthly !== undefined ? `, about ${fmtAboutUsd(l.movedUsdMonthly)} a month` : '';
  const these = k === 1 ? 'this one statement' : `these ${k} statements`;
  return `${head} Today that is ${these}${money}.`;
}

/** The fleet line: services with no row of their own, and the lines that always pass. */
export function fleetSentence(siem: string | null, fleet?: FleetLimit, alwaysPass = ALWAYS_PASS_LINES): string {
  const kept = keptNoun(siem);
  const first = fleet
    ? `Any service not listed: a statement above ${fmtLinesPerDay(fleet.limitLinesPerDay)} lines a day ${routeVerb(siem, fleet.action)}.`
    : `Any service not listed keeps every statement in ${kept}.`;
  const perDay = alwaysPass * (SECONDS_PER_DAY / REGULATOR_WINDOW_SECONDS);
  return `${first} Up to ${fmtLinesPerDay(perDay)} lines a day of every statement always reach ${kept} on each node.`;
}

/**
 * The sentence as a CSV reason: commas and colons removed, since the engine
 * reads `<container>,<bytes>::<reason>`.
 */
export function csvReason(sentence: string): string {
  return sentence.replace(/[,:]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * What a set of statements costs today at list, $/month. On a destination
 * billed per event (Datadog) this is the Standard indexing line; elsewhere
 * the ingest and storage lines for a month.
 */
export function statementsUsdMonthly(
  siem: string | null,
  bytesMonthly: number,
  eventsMonthly?: number,
): number | undefined {
  if (!siem || !(bytesMonthly > 0)) return undefined;
  const events = eventsMonthly !== undefined && eventsMonthly > 0 ? eventsMonthly : undefined;
  const pe = perEventTierPricing(siem);
  if (pe) {
    const n = events ?? bytesMonthly / pe.assumed_event_bytes;
    return (n / 1e6) * pe.standard_index_usd_per_million_events;
  }
  try {
    const p = projectAction({
      action: 'pass',
      bytes_in: bytesMonthly,
      destination: siem as SiemId,
      ...(events ? { avg_event_size_bytes: bytesMonthly / events } : {}),
    });
    return p.total_dollars ?? undefined;
  } catch {
    return undefined;
  }
}

function fmtMonths(months: number): string {
  return months === 1 ? '30 days' : `${months} months`;
}

/**
 * Datadog only: what Flex adds for every statement the plan moves, at the
 * tier that volume lands in. Stated beside the indexing figures, never netted.
 */
export function flexAddedSentence(
  siem: string | null,
  bytesMonthly: number,
  eventsMonthly?: number,
): string | undefined {
  const pe = siem ? perEventTierPricing(siem) : undefined;
  if (!pe || !(bytesMonthly > 0)) return undefined;
  const m = projectPerEventTierMove(pe, bytesMonthly, {
    ...(eventsMonthly !== undefined && eventsMonthly > 0 ? { avgEventBytes: bytesMonthly / eventsMonthly } : {}),
  });
  const line = m.pricing_tier === 'starter' ? pe.starter.name : 'Flex storage';
  const compute = m.pricing_tier === 'starter' ? 'compute included' : 'compute priced by Datadog on request';
  return (
    `The dollar figures are the Standard indexing line at list. ` +
    `${line} adds about ${fmtAboutUsd(m.tier_storage_added_usd)} a month for all of them, ${compute}, held ${fmtMonths(m.tier_retention_months)}.`
  );
}

/** Lines a day a per-node byte cap stands for, at a statement's average line size, across the nodes that enforce it. */
export function linesPerDayFromCap(capBytesPerWindowPerNode: number, nodes: number, avgBytesPerLine: number): number {
  return (
    (capBytesPerWindowPerNode * (SECONDS_PER_DAY / REGULATOR_WINDOW_SECONDS) * Math.max(1, nodes)) /
    Math.max(1, avgBytesPerLine)
  );
}

/**
 * Service limits from a window's patterns. For each container the plan caps,
 * the largest statement it keeps sets the limit (matched by the plan's own
 * name when it gives one), and the moved statements are counted and priced
 * at a month. A container whose cap is zero bytes, or whose action takes the
 * whole container, moves every statement, and the count says so.
 */
export function serviceLimitsFromPatterns<P extends { service?: string; bytes: number; count: number }>(
  caps: Record<string, { action: Action; capBytesMonthly?: number; keptMaxPattern?: string; margin?: number }>,
  patterns: P[],
  isMoved: (p: P) => boolean,
  windowSeconds: number,
  siem: string | null,
  nameOf?: (p: P) => string,
): { limits: ServiceLimit[]; movedBytesMonthly: number; movedEventsMonthly: number } {
  const scale = (30 * SECONDS_PER_DAY) / Math.max(1, windowSeconds);
  const limits: ServiceLimit[] = [];
  let movedBytes = 0;
  let movedEvents = 0;
  for (const [service, cap] of Object.entries(caps).sort(([a], [b]) => a.localeCompare(b))) {
    const inService = patterns.filter((p) => p.service === service);
    const kept = inService.filter((p) => !isMoved(p));
    const named =
      cap.keptMaxPattern !== undefined && nameOf ? kept.find((p) => nameOf(p) === cap.keptMaxPattern) : undefined;
    const keptMax = named ?? kept.reduce<P | undefined>((m, p) => (!m || p.bytes > m.bytes ? p : m), undefined);
    const wholeContainer =
      cap.action === 'offload' ||
      cap.action === 'drop' ||
      (cap.capBytesMonthly !== undefined && !(cap.capBytesMonthly > 0)) ||
      !keptMax;
    const moved = wholeContainer ? inService : inService.filter(isMoved);
    // The limit sits `margin` above the largest kept statement (service-cap.ts).
    const limitLinesPerDay = wholeContainer
      ? null
      : ((keptMax!.count * SECONDS_PER_DAY) / Math.max(1, windowSeconds)) * (cap.margin ?? 1);
    const bytes = moved.reduce((s, p) => s + p.bytes, 0) * scale;
    const events = moved.reduce((s, p) => s + p.count, 0) * scale;
    movedBytes += bytes;
    movedEvents += events;
    const usd = statementsUsdMonthly(siem, bytes, events);
    limits.push({
      service,
      action: cap.action,
      limitLinesPerDay,
      movedStatements: moved.length,
      ...(usd !== undefined ? { movedUsdMonthly: usd } : {}),
    });
  }
  return { limits, movedBytesMonthly: movedBytes, movedEventsMonthly: movedEvents };
}
