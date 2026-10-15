/**
 * The Datadog spike audit, read from the account's estimated usage metrics.
 * Every Datadog response is a stub with the documented /api/v1/query shape
 * (pointlist of [ms, value]). No network.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildSpikeAudit, renderSpikeAuditMarkdown } from '../src/lib/datadog-spike-audit.js';
import { type DdPointSeries } from '../src/lib/datadog-metrics-read.js';
import { BYTES_QUERY, EVENTS_QUERY, executeDatadogSpikeAudit } from '../src/tools/datadog-spike-audit.js';

const H = 3600;
const DAY = 86_400;
const T0 = Date.UTC(2026, 6, 1) / 1000; // 2026-07-01T00:00Z
const DAYS = 21;

/** One series of hourly points over the 21 days from T0. */
function hourly(tags: Record<string, string>, value: (day: number, hour: number) => number): DdPointSeries {
  const points: Array<[number, number]> = [];
  for (let i = 0; i < DAYS * 24; i++) {
    const v = value(Math.floor(i / 24), i % 24);
    if (v > 0) points.push([T0 + i * H, v]);
  }
  return { tags, points };
}

// checkout: 1,000 + 100 an hour of the day (largest normal hour 3,300 at 23:00),
// a three-hour spike of 20,000 an hour on day 10 from 14:00, most of it in `main`.
const checkout = (d: number, h: number): number => (d === 10 && h >= 14 && h <= 16 ? 20_000 : 1_000 + 100 * h);
// web: a flat 500 an hour, a 4,000 hour on day 3 (inside its first 7 days, not judged)
// and a 2,000 hour on day 15 at 02:00.
const web = (d: number, h: number): number => (d === 3 && h === 5 ? 4_000 : d === 15 && h === 2 ? 2_000 : 500);
// late: starts on day 12 and doubles on day 16, inside its first 7 days.
const late = (d: number): number => (d < 12 ? 0 : d === 16 ? 1_000 : 300);

function fixture(): { events: DdPointSeries[]; bytes: DdPointSeries[] } {
  return {
    events: [
      hourly({ service: 'checkout', datadog_index: 'main' }, (d, h) => (d === 10 && h >= 14 && h <= 16 ? 18_000 : checkout(d, h) / 2)),
      hourly({ service: 'checkout', datadog_index: 'retention-30' }, (d, h) => (d === 10 && h >= 14 && h <= 16 ? 2_000 : checkout(d, h) / 2)),
      hourly({ service: 'web', datadog_index: 'main' }, web),
      hourly({ service: 'late', datadog_index: 'N/A' }, (d) => late(d)),
    ],
    bytes: [
      hourly({ service: 'checkout' }, (d, h) => checkout(d, h) * 500),
      hourly({ service: 'web' }, (d, h) => web(d, h) * 200),
      hourly({ service: 'late' }, (d) => late(d) * 100),
    ],
  };
}

test('spike hours are those above 3x the same hour\'s median over the 7 days before; runs merge; the first 7 days are not judged', () => {
  const a = buildSpikeAudit({ fromSec: T0, toSec: T0 + DAYS * DAY, ...fixture() });
  assert.equal(a.servicesScanned, 3);
  assert.equal(a.judgedDays, 14);
  assert.deepEqual(a.services.map((s) => s.service), ['checkout', 'web']);

  const [c, w] = a.services;
  assert.equal(c.spikes.length, 1);
  const s = c.spikes[0];
  assert.equal(s.startIso, '2026-07-11T14:00:00.000Z');
  assert.equal(s.hours, 3);
  assert.equal(s.index, 'main');
  // Medians 2,400, 2,500 and 2,600 for 14:00 to 16:00.
  assert.equal(s.excessEvents, 3 * 20_000 - (2_400 + 2_500 + 2_600));
  assert.equal(s.excessBytes, s.excessEvents * 500);
  assert.ok(Math.abs(s.usd - ((52_500 / 1e6) * 1.7 + (26_250_000 / 1e9) * 0.1)) < 1e-12);
  // Fleet default: 2 x the largest hour outside the spike (3,300) = 6,600 an hour.
  assert.equal(c.largestNormalHourEvents, 3_300);
  assert.equal(c.limitEventsPerHour, 6_600);
  assert.equal(s.heldEvents, 3 * (20_000 - 6_600));
  assert.ok(Math.abs(s.heldUsd - (40_200 / 1e6) * 1.7) < 1e-12);

  assert.equal(w.spikes.length, 1);
  assert.equal(w.spikes[0].startIso, '2026-07-16T02:00:00.000Z');
  assert.equal(w.spikes[0].excessEvents, 1_500);
  // The day-3 hour was never judged, so it is a normal hour and sets the limit.
  assert.equal(w.largestNormalHourEvents, 4_000);
  assert.equal(w.limitEventsPerHour, 8_000);
  assert.equal(w.spikes[0].heldEvents, 0);

  assert.equal(a.totals.spikes, 2);
  assert.ok(Math.abs(a.totals.usdPerYear - (a.totals.usd * 365) / 14) < 1e-9);
});

test('the account\'s rates and the multiplier override the defaults', () => {
  const a = buildSpikeAudit(
    { fromSec: T0, toSec: T0 + DAYS * DAY, ...fixture() },
    { standardUsdPerMillion: 2.5, ingestionUsdPerGb: 0.05, multiplier: 5, headroom: 3 },
  );
  assert.deepEqual(a.services.map((s) => s.service), ['checkout']);
  const s = a.services[0].spikes[0];
  assert.ok(Math.abs(s.usd - ((52_500 / 1e6) * 2.5 + (26_250_000 / 1e9) * 0.05)) < 1e-12);
  assert.equal(a.services[0].limitEventsPerHour, 9_900);
});

test('the page states the rule, the price, the fleet default and the caveats in plain sentences', () => {
  const a = buildSpikeAudit({ fromSec: T0, toSec: T0 + DAYS * DAY, ...fixture() });
  const md = renderSpikeAuditMarkdown(a, { standardRateSupplied: true });
  assert.ok(md.includes('more than 3 times the median of the same hour of the day over the 7 days before it'));
  assert.ok(md.includes("$1.70 per million (Standard indexing, the account's rate)"));
  assert.ok(md.includes('$0.10 per GB (ingestion, list price)'));
  assert.ok(md.includes('2 times its largest hour outside the spikes'));
  assert.ok(md.includes('| 2026-07-11 14:00 | 3 | main | 52,500 |'));
  assert.ok(md.includes('a year at that rate'));
  assert.ok(md.includes('differs from billable usage by 10 to 20 percent on average'));
  assert.ok(md.includes('The hold figure is an upper bound'));
  assert.ok(md.includes('The data is hourly'));
  assert.ok(!md.includes('\u2014'), 'no em dash');
  assert.ok(!/\byou\b/i.test(md), 'no "you"');
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('the tool reads both usage metrics with GETs in 30-day chunks and returns the page', async () => {
  const seen: Array<{ method: string; path: string; query: string; from: number; to: number }> = [];
  const f = fixture();
  const toPointlist = (s: DdPointSeries, from: number, to: number) => ({
    tag_set: Object.entries(s.tags).map(([k, v]) => `${k}:${v}`),
    pointlist: s.points.filter(([ts]) => ts >= from && ts < to).map(([ts, v]) => [ts * 1000, v]),
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const query = url.searchParams.get('query') ?? '';
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    seen.push({ method: init?.method ?? 'GET', path: url.pathname, query, from, to });
    const src = query === EVENTS_QUERY ? f.events : f.bytes;
    return new Response(JSON.stringify({ status: 'ok', series: src.map((s) => toPointlist(s, from, to)) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const now = (T0 + DAYS * DAY) * 1000;
  const out = await executeDatadogSpikeAudit(
    { lookback: '35d' },
    { creds: { site: 'datadoghq.com', apiKey: 'k', appKey: 'a' }, nowMs: () => now },
  );
  assert.equal(out.status, 'success');
  assert.ok(seen.every((s) => s.method === 'GET' && s.path === '/api/v1/query'));
  assert.equal(seen.length, 4, 'two chunks, two queries each');
  assert.deepEqual([...new Set(seen.map((s) => s.query))].sort(), [BYTES_QUERY, EVENTS_QUERY].sort());
  assert.equal(EVENTS_QUERY, 'sum:datadog.estimated_usage.logs.ingested_events{datadog_is_excluded:false} by {service,datadog_index}.as_count().rollup(sum, 3600)');
  const payload = out.data.payload as { services: Array<{ service: string }>; markdown: string; judgedDays: number };
  assert.deepEqual(payload.services.map((s) => s.service), ['checkout', 'web']);
  assert.equal(payload.judgedDays, 28);
  assert.ok(payload.markdown.includes('### checkout'));
});

test('a lookback shorter than the baseline, or no keys, is refused with the reason', async () => {
  globalThis.fetch = (async () => {
    throw new Error('no network in this test');
  }) as typeof fetch;
  const short = await executeDatadogSpikeAudit({ lookback: '7d' }, { creds: { site: 'datadoghq.com', apiKey: 'k', appKey: 'a' } });
  assert.equal(short.data.error?.error_type, 'input_invalid');
  const none = await executeDatadogSpikeAudit({}, { creds: null });
  assert.equal(none.data.error?.error_type, 'config_missing');
  assert.ok(String(none.data.error?.hint).includes('DD_API_KEY'));
});
