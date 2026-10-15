/**
 * Datadog spike audit: from the account's own estimated usage metrics, the
 * hours each service ran far above its usual level, what the excess cost at
 * the account's rates, and what a fleet default limit would have held.
 *
 * Inputs are hourly sums of `datadog.estimated_usage.logs.ingested_events`
 * (indexed events, `datadog_is_excluded:false`, by service and datadog_index)
 * and `datadog.estimated_usage.logs.ingested_bytes` (by service).
 */

import type { DdPointSeries } from './datadog-metrics-read.js';
import { DATADOG_FLEX_LIST_PRICING, DATADOG_INGEST_LIST_PRICING, fmtEventCount, fmtListRate } from './cost.js';
import { FLEET_DEFAULT_HEADROOM, fleetDefaultLimit } from './fleet-default.js';
import { fmtAboutUsd } from './report/user-units.js';

export const SPIKE_MULTIPLIER = 3;
export const BASELINE_DAYS = 7;
const HOUR = 3600;
const GB = 1_000_000_000;
const NO_SERVICE = '(no service)';

export interface SpikeAuditInput {
  fromSec: number;
  toSec: number;
  events: DdPointSeries[];
  bytes: DdPointSeries[];
}

export interface SpikeAuditOptions {
  multiplier?: number;
  headroom?: number;
  standardUsdPerMillion?: number;
  ingestionUsdPerGb?: number;
}

export interface Spike {
  startIso: string;
  hours: number;
  /** The index that took most of the spike's events, when Datadog tagged one. */
  index?: string;
  events: number;
  excessEvents: number;
  excessBytes: number;
  usd: number;
  heldEvents: number;
  heldUsd: number;
}

export interface ServiceSpikes {
  service: string;
  spikes: Spike[];
  excessEvents: number;
  excessBytes: number;
  usd: number;
  heldEvents: number;
  heldUsd: number;
  largestNormalHourEvents: number;
  limitEventsPerHour: number;
}

export interface SpikeAudit {
  fromIso: string;
  toIso: string;
  judgedDays: number;
  multiplier: number;
  headroom: number;
  standardUsdPerMillion: number;
  ingestionUsdPerGb: number;
  servicesScanned: number;
  services: ServiceSpikes[];
  totals: {
    spikes: number;
    excessEvents: number;
    excessBytes: number;
    usd: number;
    heldEvents: number;
    heldUsd: number;
    usdPerYear: number;
    heldUsdPerYear: number;
  };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function grid(series: DdPointSeries[], key: (tags: Record<string, string>) => string, h0: number, n: number): Map<string, Float64Array> {
  const out = new Map<string, Float64Array>();
  for (const s of series) {
    const k = key(s.tags);
    let row = out.get(k);
    if (!row) {
      row = new Float64Array(n);
      out.set(k, row);
    }
    for (const [ts, v] of s.points) {
      const i = Math.floor(ts / HOUR) - h0;
      if (i >= 0 && i < n) row[i] += v;
    }
  }
  return out;
}

const serviceOf = (t: Record<string, string>): string => t.service || NO_SERVICE;

export function buildSpikeAudit(input: SpikeAuditInput, opts: SpikeAuditOptions = {}): SpikeAudit {
  const multiplier = opts.multiplier ?? SPIKE_MULTIPLIER;
  const headroom = opts.headroom ?? FLEET_DEFAULT_HEADROOM;
  const rate = opts.standardUsdPerMillion ?? DATADOG_FLEX_LIST_PRICING.standard_index_usd_per_million_events;
  const ingest = opts.ingestionUsdPerGb ?? DATADOG_INGEST_LIST_PRICING.usd_per_gb;
  const usdOf = (events: number, bytes: number): number => (events / 1e6) * rate + (bytes / GB) * ingest;

  const h0 = Math.floor(input.fromSec / HOUR);
  const n = Math.max(0, Math.floor((input.toSec - 1) / HOUR) - h0 + 1);
  const events = grid(input.events, serviceOf, h0, n);
  const bytes = grid(input.bytes, serviceOf, h0, n);
  const byIndex = grid(input.events, (t) => `${serviceOf(t)}\u0000${t.datadog_index ?? ''}`, h0, n);
  const lag = BASELINE_DAYS * 24;

  const services: ServiceSpikes[] = [];
  for (const [service, ev] of events) {
    const by = bytes.get(service) ?? new Float64Array(n);
    const first = ev.findIndex((v) => v > 0);
    if (first < 0) continue;
    const spikeHour = new Uint8Array(n);
    const baseEv = new Float64Array(n);
    const baseBy = new Float64Array(n);
    for (let i = first + lag; i < n; i++) {
      const prior = Array.from({ length: BASELINE_DAYS }, (_, k) => i - 24 * (k + 1));
      baseEv[i] = median(prior.map((j) => ev[j]));
      baseBy[i] = median(prior.map((j) => by[j]));
      if (ev[i] > multiplier * Math.max(baseEv[i], 1)) spikeHour[i] = 1;
    }
    let largestNormal = 0;
    for (let i = first; i < n; i++) if (!spikeHour[i] && ev[i] > largestNormal) largestNormal = ev[i];
    const limit = fleetDefaultLimit(largestNormal, headroom);

    const indexes = [...byIndex.entries()].filter(([k]) => k.startsWith(`${service}\u0000`));
    const spikes: Spike[] = [];
    for (let i = first + lag; i < n; i++) {
      if (!spikeHour[i]) continue;
      let j = i;
      while (j + 1 < n && spikeHour[j + 1]) j++;
      let total = 0;
      let excessEvents = 0;
      let excessBytes = 0;
      let held = 0;
      for (let h = i; h <= j; h++) {
        total += ev[h];
        excessEvents += ev[h] - baseEv[h];
        excessBytes += Math.max(0, by[h] - baseBy[h]);
        if (limit > 0) held += Math.max(0, ev[h] - limit);
      }
      let index: string | undefined;
      let best = 0;
      for (const [k, row] of indexes) {
        const name = k.slice(service.length + 1);
        let s = 0;
        for (let h = i; h <= j; h++) s += row[h];
        if (name && name !== 'N/A' && s > best) {
          best = s;
          index = name;
        }
      }
      spikes.push({
        startIso: new Date((h0 + i) * HOUR * 1000).toISOString(),
        hours: j - i + 1,
        ...(index ? { index } : {}),
        events: total,
        excessEvents,
        excessBytes,
        usd: usdOf(excessEvents, excessBytes),
        heldEvents: held,
        heldUsd: usdOf(held, 0),
      });
      i = j;
    }
    if (spikes.length === 0) continue;
    spikes.sort((a, b) => b.usd - a.usd);
    const sum = (f: (s: Spike) => number): number => spikes.reduce((t, s) => t + f(s), 0);
    services.push({
      service,
      spikes,
      excessEvents: sum((s) => s.excessEvents),
      excessBytes: sum((s) => s.excessBytes),
      usd: sum((s) => s.usd),
      heldEvents: sum((s) => s.heldEvents),
      heldUsd: sum((s) => s.heldUsd),
      largestNormalHourEvents: largestNormal,
      limitEventsPerHour: limit,
    });
  }
  services.sort((a, b) => b.usd - a.usd || (a.service < b.service ? -1 : 1));

  const judgedDays = Math.max(0, (n - lag) / 24);
  const sum = (f: (s: ServiceSpikes) => number): number => services.reduce((t, s) => t + f(s), 0);
  const usd = sum((s) => s.usd);
  const heldUsd = sum((s) => s.heldUsd);
  const perYear = (v: number): number => (judgedDays > 0 ? (v * 365) / judgedDays : 0);
  return {
    fromIso: new Date(input.fromSec * 1000).toISOString(),
    toIso: new Date(input.toSec * 1000).toISOString(),
    judgedDays,
    multiplier,
    headroom,
    standardUsdPerMillion: rate,
    ingestionUsdPerGb: ingest,
    servicesScanned: events.size,
    services,
    totals: {
      spikes: sum((s) => s.spikes.length),
      excessEvents: sum((s) => s.excessEvents),
      excessBytes: sum((s) => s.excessBytes),
      usd,
      heldEvents: sum((s) => s.heldEvents),
      heldUsd,
      usdPerYear: perYear(usd),
      heldUsdPerYear: perYear(heldUsd),
    },
  };
}

const n0 = (v: number): string => Math.round(v).toLocaleString('en-US');
const usd = (v: number): string => (v > 0 && v < 0.01 ? 'under $0.01' : fmtAboutUsd(v));
const days = (d: number): string => `${Number(d.toFixed(1))} ${d === 1 ? 'day' : 'days'}`;

export function renderSpikeAuditMarkdown(
  a: SpikeAudit,
  opts: { limit?: number; spikesPerService?: number; standardRateSupplied?: boolean; ingestionRateSupplied?: boolean } = {},
): string {
  const limit = opts.limit ?? 10;
  const per = opts.spikesPerService ?? 5;
  const note = (supplied?: boolean): string => (supplied ? "the account's rate" : 'list price');
  const t = a.totals;
  const L: string[] = [];
  L.push(`## Datadog log spikes, ${a.fromIso.slice(0, 10)} to ${a.toIso.slice(0, 10)}`);
  L.push('');
  L.push(
    `**Rule.** An hour is a spike hour for a service when its indexed events are more than ${a.multiplier} times the median of the same hour of the day ` +
      `over the ${BASELINE_DAYS} days before it. Consecutive spike hours are one spike. A spike's excess is each hour's events above that median, ` +
      `and its bytes above the same median of ingested bytes. A service's first ${BASELINE_DAYS} days set its baseline and are not judged. ` +
      'The counts are Datadog\'s estimated usage metrics, `datadog.estimated_usage.logs.ingested_events` with `datadog_is_excluded:false` and ' +
      '`datadog.estimated_usage.logs.ingested_bytes`, in hourly sums.',
  );
  L.push('');
  L.push(
    `**Price.** Excess events at ${fmtListRate(a.standardUsdPerMillion)} per million (Standard indexing, ${note(opts.standardRateSupplied)}), ` +
      `excess bytes at ${fmtListRate(a.ingestionUsdPerGb)} per GB (ingestion, ${note(opts.ingestionRateSupplied)}).`,
  );
  L.push('');
  L.push(
    `**Fleet default.** A limit per service of ${a.headroom} times its largest hour outside the spikes, the rule the fleet default uses ` +
      '(the largest kept level times the headroom). Each spike hour\'s events above the limit count as held, priced at the Standard rate.',
  );
  L.push('');
  if (a.services.length === 0) {
    L.push(
      `No spikes in ${a.servicesScanned} services over the ${days(a.judgedDays)} judged.`,
    );
  } else {
    L.push(
      `**Totals.** ${n0(t.spikes)} spikes in ${a.services.length} of ${a.servicesScanned} services over the ${days(a.judgedDays)} judged: ` +
        `${fmtEventCount(t.excessEvents)} excess events, ${usd(t.usd)}, about ${usd(t.usdPerYear)} a year at that rate. ` +
        `The fleet default would have held ${fmtEventCount(t.heldEvents)} of them, ${usd(t.heldUsd)}, about ${usd(t.heldUsdPerYear)} a year.`,
    );
    L.push('');
    L.push('| Service | Spikes | Excess events | Cost | Limit, events an hour | Held by the fleet default |');
    L.push('|---|---:|---:|---:|---:|---:|');
    for (const s of a.services.slice(0, limit)) {
      L.push(
        `| ${s.service} | ${s.spikes.length} | ${n0(s.excessEvents)} | ${usd(s.usd)} | ${n0(s.limitEventsPerHour)} | ${n0(s.heldEvents)}, ${usd(s.heldUsd)} |`,
      );
    }
    if (a.services.length > limit) L.push(`| ${a.services.length - limit} more services | | | | | |`);
    for (const s of a.services.slice(0, limit)) {
      L.push('');
      L.push(`### ${s.service}`);
      L.push('');
      L.push(
        `Largest hour outside the spikes: ${n0(s.largestNormalHourEvents)} events, so the limit is ${n0(s.limitEventsPerHour)} events an hour.`,
      );
      L.push('');
      L.push('| Start (UTC) | Hours | Index | Excess events | Cost | Held by the fleet default |');
      L.push('|---|---:|---|---:|---:|---:|');
      for (const p of s.spikes.slice(0, per)) {
        L.push(
          `| ${p.startIso.slice(0, 13).replace('T', ' ')}:00 | ${p.hours} | ${p.index ?? ''} | ${n0(p.excessEvents)} | ${usd(p.usd)} | ${n0(p.heldEvents)} |`,
        );
      }
      if (s.spikes.length > per) L.push(`| ${s.spikes.length - per} more spikes | | | | | |`);
    }
  }
  L.push('');
  L.push('**Caveats.**');
  L.push('');
  L.push('- The data is hourly: a burst shorter than an hour is spread over its hour, and the hold estimate cannot see inside it.');
  L.push(
    '- Datadog states that its estimated usage differs from billable usage by 10 to 20 percent on average, and by more at small volumes.',
  );
  L.push(
    '- The hold figure is an upper bound: it counts every event above the limit as held, and the engine still passes the first lines of each ' +
      'statement in every window and the share its severity floors pass.',
  );
  L.push(
    '- The limit here is per service per hour; the engine\'s is per statement per node, in bytes, so the hold figure gives the scale, not a replay. ' +
      'Held events that go to Flex still pay ingestion and Flex storage.',
  );
  return L.join('\n');
}
