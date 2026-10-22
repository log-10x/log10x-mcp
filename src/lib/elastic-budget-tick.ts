/**
 * The hot-tier run: one run of an Elasticsearch hot tier held under a size S.
 *
 * Each run, read-only against the cluster:
 *   1. the hot nodes' index store and disk (`_nodes`, `_nodes/<ids>/stats`),
 *      and the store of the Receiver's own indices still on hot, split into
 *      kept lines (the pass alias) and tier_down lines (the tier_down alias);
 *   2. how long a kept line stays on hot, from the ILM policy on the pass
 *      alias, and how long a tier_down index stays on hot, from its policy
 *      and the mount times of the indices already moved;
 *   3. every statement's bytes an hour by ingest time, from the Receiver's
 *      indices still on hot: the Receiver stamps `utf8Size` on each returned
 *      record, the same size its byte limits count;
 *   4. the store each counted byte takes on hot, measured on the indices
 *      still there;
 * then the allowance: A = (S - lines outside the Receiver - tier_down in
 * flight) / (store per byte x hours on hot) counted bytes an hour for the
 * kept lines, spread over statements with the water level the Datadog run
 * uses (the noisiest held first), as per-node per-window byte limits.
 *
 * A failed read changes nothing: the caller keeps the last files.
 */

import { ALWAYS_PASS_LINES, REGULATOR_WINDOW_SECONDS } from './report/user-units.js';
import { FLEET_DEFAULT_HEADROOM } from './fleet-default.js';
import { perWindowPerNode, waterLevel, type BudgetAction } from './budget-tick.js';
import type { HotTierBudget } from './policy-loader.js';

const HOUR = 3600;
const GB = 1e9;

// ─── access ─────────────────────────────────────────────────────────────────

export interface EsCreds {
  url: string;
  apiKey?: string;
  user?: string;
  password?: string;
}

/** `LOG10X_ES_URL` with `LOG10X_ES_API_KEY` (an encoded API key) or `LOG10X_ES_USER` and `LOG10X_ES_PASSWORD`. */
export function esCredsFromEnv(env: NodeJS.ProcessEnv = process.env): EsCreds | undefined {
  const url = (env.LOG10X_ES_URL ?? '').trim();
  if (!url) return undefined;
  return {
    url: url.replace(/\/+$/, ''),
    ...(env.LOG10X_ES_API_KEY ? { apiKey: env.LOG10X_ES_API_KEY } : {}),
    ...(env.LOG10X_ES_USER ? { user: env.LOG10X_ES_USER, password: env.LOG10X_ES_PASSWORD ?? '' } : {}),
  };
}

export type EsRequest = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<any>;

export function esRequester(creds: EsCreds, timeoutMs = 60_000): EsRequest {
  const auth = creds.apiKey
    ? `ApiKey ${creds.apiKey}`
    : creds.user
      ? `Basic ${Buffer.from(`${creds.user}:${creds.password ?? ''}`).toString('base64')}`
      : undefined;
  return async (method, path, body) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(creds.url + path, {
        method,
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: ctl.signal,
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`Elasticsearch ${method} ${path.split('?')[0]} returned ${r.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(t);
    }
  };
}

// ─── durations ──────────────────────────────────────────────────────────────

/** An Elasticsearch time value (`1h`, `30d`, `0ms`, `90s`) in hours, or undefined. */
export function esDurationHours(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^(\d+(?:\.\d+)?)(nanos|micros|ms|s|m|h|d)$/.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const per: Record<string, number> = { nanos: 1 / 3.6e12, micros: 1 / 3.6e9, ms: 1 / 3.6e6, s: 1 / 3600, m: 1 / 60, h: 1, d: 24 };
  return n * per[m[2]];
}

const PHASES_AFTER_HOT = ['warm', 'cold', 'frozen', 'delete'] as const;

/**
 * Hours an index governed by an ILM policy stays on hot: the hot phase's
 * rollover `max_age` plus the `min_age` of the first phase after hot (a
 * phase's `min_age` counts from rollover). Undefined when the policy has no
 * age-based rollover or no phase after hot.
 */
export function ilmHotHours(policy: any): { hours: number; detail: string } | undefined {
  const phases = policy?.phases ?? {};
  const maxAge = esDurationHours(phases.hot?.actions?.rollover?.max_age);
  const next = PHASES_AFTER_HOT.find((p) => phases[p]);
  if (maxAge === undefined || !next) return undefined;
  const minAge = esDurationHours(phases[next].min_age ?? '0ms') ?? 0;
  return { hours: maxAge + minAge, detail: `rollover max_age ${phases.hot.actions.rollover.max_age} + ${next} min_age ${phases[next].min_age ?? '0ms'}` };
}

// ─── reads ──────────────────────────────────────────────────────────────────

export interface StatementBytes {
  container: string;
  pattern: string;
  name: string;
  severity: string;
  route: string;
  bytesPerHour: number;
  linesPerHour: number;
}

export interface HotTierReads {
  hotNodes: number;
  /** Index store on the hot nodes, every index, bytes. */
  hotStoreBytes: number;
  /** Disk on the hot nodes, bytes. */
  hotDiskBytes: number;
  pass: { storeBytes: number; countedBytes: number; indices: number };
  tierDown: { storeBytes: number; countedBytes: number; indices: number };
  retentionHours: number;
  retentionSource: string;
  tierDownHotHours: number;
  tierDownSource: string;
  statements: StatementBytes[];
  /** Documents on hot with no `utf8Size`. */
  unsized: number;
  spanHours: number;
}

const MOUNTED = /^(partial-|restored-)/;

async function keywordField(req: EsRequest, index: string, field: string): Promise<string> {
  const m = await req('GET', `/${encodeURIComponent(index)}/_mapping/field/${encodeURIComponent(field)}`);
  for (const idx of Object.values<any>(m)) {
    const f = idx?.mappings?.[field]?.mapping;
    const leaf = f ? Object.values<any>(f)[0] : undefined;
    if (leaf?.type === 'keyword') return field;
    if (leaf?.fields?.keyword?.type === 'keyword') return `${field}.keyword`;
  }
  return field;
}

async function sumSize(req: EsRequest, indices: string[]): Promise<number> {
  if (indices.length === 0) return 0;
  const r = await req('POST', `/${indices.map(encodeURIComponent).join(',')}/_search?size=0`, { aggs: { b: { sum: { field: 'utf8Size' } } } });
  return Number(r?.aggregations?.b?.value ?? 0);
}

export async function readHotTierInputs(nowSec: number, hot: HotTierBudget, req: EsRequest): Promise<HotTierReads> {
  // 1. hot nodes
  const nodes = await req('GET', '/_nodes?filter_path=nodes.*.name,nodes.*.roles');
  const hotIds = Object.entries<any>(nodes?.nodes ?? {})
    .filter(([, n]) => (n.roles ?? []).some((r: string) => r === 'data_hot' || r === 'data'))
    .map(([id]) => id);
  if (hotIds.length === 0) throw new Error('no node has the data_hot (or data) role, so there is no hot tier to hold.');
  const stats = await req('GET', `/_nodes/${hotIds.join(',')}/stats/fs,indices?filter_path=nodes.*.fs.total.total_in_bytes,nodes.*.indices.store.size_in_bytes`);
  let hotStoreBytes = 0;
  let hotDiskBytes = 0;
  for (const n of Object.values<any>(stats?.nodes ?? {})) {
    hotStoreBytes += Number(n?.indices?.store?.size_in_bytes ?? 0);
    hotDiskBytes += Number(n?.fs?.total?.total_in_bytes ?? 0);
  }

  // 2. the Receiver's indices, through their aliases (ILM moves the alias to the mounted copy)
  const aliases = await req('GET', `/_alias/${encodeURIComponent(hot.pass_alias)},${encodeURIComponent(hot.tier_down_alias)}`);
  const passIdx: string[] = [];
  const tdIdx: string[] = [];
  const tdMounted: string[] = [];
  for (const [index, v] of Object.entries<any>(aliases)) {
    const names = Object.keys(v?.aliases ?? {});
    const mounted = MOUNTED.test(index);
    if (names.includes(hot.pass_alias) && !mounted) passIdx.push(index);
    if (names.includes(hot.tier_down_alias)) (mounted ? tdMounted : tdIdx).push(index);
  }
  if (passIdx.length === 0) throw new Error(`no index on hot carries the alias ${hot.pass_alias}; set pass_alias to the Receiver's write alias for kept lines.`);
  const storeOf = async (indices: string[]): Promise<number> => {
    if (indices.length === 0) return 0;
    const s = await req('GET', `/${indices.map(encodeURIComponent).join(',')}/_stats/store?level=indices&filter_path=indices.*.total.store.size_in_bytes`);
    return Object.values<any>(s?.indices ?? {}).reduce((a, i) => a + Number(i?.total?.store?.size_in_bytes ?? 0), 0);
  };
  const [passStore, tdStore, passCounted, tdCounted] = await Promise.all([storeOf(passIdx), storeOf(tdIdx), sumSize(req, passIdx), sumSize(req, tdIdx)]);

  // 3. how long kept lines and tier_down indices stay on hot
  let retentionHours = hot.retention_hours;
  let retentionSource = 'hot_retention_hours in the policy';
  const ilmName = async (alias: string): Promise<string | undefined> => {
    const st = await req('GET', `/${encodeURIComponent(alias)}/_settings/index.lifecycle.name?flat_settings=true`);
    for (const v of Object.values<any>(st)) {
      const n = v?.settings?.['index.lifecycle.name'];
      if (n) return n;
    }
    return undefined;
  };
  if (retentionHours === undefined) {
    const name = await ilmName(hot.pass_alias);
    if (!name) throw new Error(`the ${hot.pass_alias} indices carry no ILM policy, so the time a line stays on hot is unknown; set hot_retention_hours.`);
    const p = await req('GET', `/_ilm/policy/${encodeURIComponent(name)}`);
    const h = ilmHotHours(p?.[name]?.policy);
    if (!h) throw new Error(`the ILM policy ${name} on ${hot.pass_alias} has no age-based rollover or no phase after hot, so the time a line stays on hot is unknown; set hot_retention_hours.`);
    retentionHours = h.hours;
    retentionSource = `ILM policy ${name} (${h.detail})`;
  }
  let tierDownHotHours = 2;
  let tierDownSource = 'default (no tier_down index has been moved yet)';
  const tdName = await ilmName(hot.tier_down_alias).catch(() => undefined);
  const tdPolicy = tdName ? (await req('GET', `/_ilm/policy/${encodeURIComponent(tdName)}`))?.[tdName]?.policy : undefined;
  const tdMaxAge = esDurationHours(tdPolicy?.phases?.hot?.actions?.rollover?.max_age);
  if (tdMounted.length > 0 && tdMaxAge !== undefined) {
    const ex = await req('GET', `/${tdMounted.map(encodeURIComponent).join(',')}/_ilm/explain?filter_path=indices.*.lifecycle_date_millis,indices.*.index_creation_date_millis`);
    const delays = Object.values<any>(ex?.indices ?? {})
      .map((i) => (Number(i.index_creation_date_millis) - Number(i.lifecycle_date_millis)) / 3.6e6)
      .filter((d) => Number.isFinite(d) && d >= 0)
      .sort((a, b) => a - b);
    if (delays.length > 0) {
      const mid = delays[Math.floor(delays.length / 2)];
      tierDownHotHours = tdMaxAge + mid;
      tierDownSource = `rollover max_age ${tdPolicy.phases.hot.actions.rollover.max_age} + a median ${Math.round(mid * 60)} minutes from rollover to mount over ${delays.length} moved indices`;
    }
  }

  // 4. every statement's bytes an hour, by ingest time: what each statement holds in the Receiver's
  // indices still on hot, over the time since the oldest of them was created. Event timestamps are
  // not used: late or replayed lines carry old ones, and hot fills in the order lines arrive.
  const [cField, nField, sField] = await Promise.all([
    keywordField(req, hot.pass_alias, hot.container_field),
    keywordField(req, hot.pass_alias, 'message_pattern'),
    keywordField(req, hot.pass_alias, 'severity_level'),
  ]);
  const created = async (indices: string[]): Promise<number | undefined> => {
    if (indices.length === 0) return undefined;
    const st = await req('GET', `/${indices.map(encodeURIComponent).join(',')}/_settings/index.creation_date?flat_settings=true`);
    const ms = Object.values<any>(st).map((v) => Number(v?.settings?.['index.creation_date'])).filter((n) => Number.isFinite(n) && n > 0);
    return ms.length ? Math.min(...ms) : undefined;
  };
  const statements: StatementBytes[] = [];
  let unsized = 0;
  let spanHours = 0;
  for (const [route, indices] of [['pass', passIdx], ['tier_down', tdIdx]] as const) {
    const oldest = await created(indices);
    if (oldest === undefined) continue;
    const span = Math.max(1 / 60, (nowSec * 1000 - oldest) / 3.6e6);
    if (route === 'pass') spanHours = span;
    const target = indices.map(encodeURIComponent).join(',');
    const head = await req('POST', `/${target}/_search?size=0`, { aggs: { unsized: { missing: { field: 'utf8Size' } } } });
    unsized += Number(head?.aggregations?.unsized?.doc_count ?? 0);
    let after: unknown;
    for (let page = 0; page < 200; page++) {
      const r = await req('POST', `/${target}/_search?size=0`, {
        aggs: {
          s: {
            composite: {
              size: 1000,
              sources: [{ c: { terms: { field: cField } } }, { h: { terms: { field: 'tenx_hash' } } }],
              ...(after ? { after } : {}),
            },
            aggs: {
              b: { sum: { field: 'utf8Size' } },
              n: { terms: { field: nField, size: 1 } },
              v: { terms: { field: sField, size: 1 } },
            },
          },
        },
      });
      const agg = r?.aggregations?.s;
      for (const b of agg?.buckets ?? []) {
        statements.push({
          container: String(b.key.c),
          pattern: String(b.key.h),
          name: String(b.n?.buckets?.[0]?.key ?? ''),
          severity: String(b.v?.buckets?.[0]?.key ?? '').toUpperCase(),
          route,
          bytesPerHour: Number(b.b?.value ?? 0) / span,
          linesPerHour: Number(b.doc_count ?? 0) / span,
        });
      }
      after = agg?.after_key;
      if (!after || (agg?.buckets ?? []).length === 0) break;
    }
  }

  return {
    hotNodes: hotIds.length,
    hotStoreBytes,
    hotDiskBytes,
    pass: { storeBytes: passStore, countedBytes: passCounted, indices: passIdx.length },
    tierDown: { storeBytes: tdStore, countedBytes: tdCounted, indices: tdIdx.length },
    retentionHours,
    retentionSource,
    tierDownHotHours,
    tierDownSource,
    statements,
    unsized,
    spanHours,
  };
}

// ─── plan ───────────────────────────────────────────────────────────────────

export interface HotTierRow {
  container: string;
  action: BudgetAction;
  instances: number;
  /** Fleet counted bytes an hour the service sends now. */
  bytesPerHour: number;
  /** Fleet counted bytes an hour kept on hot under this run. */
  keptPerHour: number;
  /** Per-statement limit, bytes per window per node; 0 exempts the service. */
  cap: number;
  /** Service total, bytes per window per node. */
  total: number;
}

export interface HotTierPlan {
  targetBytes: number;
  targetSource: string;
  hotStoreBytes: number;
  hotDiskBytes: number;
  outsideBytes: number;
  storePerByte: number;
  storePerByteTierDown: number;
  retentionHours: number;
  tierDownHotHours: number;
  /** Fleet counted bytes an hour the kept lines may add. */
  allowancePerHour: number;
  /** Fleet counted bytes an hour each statement keeps when the size binds; undefined under it. */
  levelPerHour?: number;
  movedPerHour: number;
  tierDownInFlightBytes: number;
  /** Hot store the limits settle at once the current lines on hot have aged out. */
  projectedBytes: number;
  overSize: boolean;
  rows: HotTierRow[];
  star: { action: BudgetAction; instances: number; cap: number; total: number; keptPerHour: number };
  heldLine: string;
  lines: string[];
  warnings: string[];
}

export interface HotTierPlanInput {
  hot: HotTierBudget;
  reads: HotTierReads;
  instances: Record<string, number>;
  nodesTotal: number;
  exceptions: string[];
  targetServices: string[];
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Where a held line goes on Elasticsearch. */
export function elasticDestination(action: BudgetAction): string {
  return action === 'tier_down' ? 'the frozen tier' : action === 'offload' ? "the account's S3" : 'hot';
}

export function fmtGB(bytes: number): string {
  const gb = bytes / GB;
  if (gb >= 100) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1).replace(/\.0$/, '')} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

export function planHotTier(input: HotTierPlanInput): HotTierPlan {
  const { hot, reads } = input;
  const warnings: string[] = [];
  const lines: string[] = [];
  const S = hot.gb !== undefined ? hot.gb * GB : hot.capacity_share * reads.hotDiskBytes;
  const targetSource = hot.gb !== undefined ? `${hot.gb} GB set in the policy` : `${Math.round(hot.capacity_share * 100)}% of the hot nodes' ${fmtGB(reads.hotDiskBytes)} of disk`;
  const H = reads.hotStoreBytes;
  const outside = Math.max(0, H - reads.pass.storeBytes - reads.tierDown.storeBytes);
  let k = reads.pass.countedBytes > 0 ? reads.pass.storeBytes / reads.pass.countedBytes : undefined;
  let kTd = reads.tierDown.countedBytes > 0 ? reads.tierDown.storeBytes / reads.tierDown.countedBytes : undefined;
  if (k === undefined) {
    k = kTd ?? 1;
    warnings.push(`The kept indices on hot carry no utf8Size yet, so each counted byte is taken as ${k.toFixed(2)} bytes of store until they do.`);
  }
  if (kTd === undefined) kTd = k;
  if (reads.unsized > 0) {
    warnings.push(`${reads.unsized} documents on hot carry no utf8Size, so their statements count as 0 bytes. The Receiver writes it when installed for the hot-tier run.`);
  }
  const R = reads.retentionHours;
  const L = reads.tierDownHotHours;

  // statements by container, all routes summed: the Receiver's intake
  const byContainer = new Map<string, Map<string, number>>();
  for (const s of input.reads.statements) {
    if (!s.container || !(s.bytesPerHour > 0)) continue;
    const m = byContainer.get(s.container) ?? new Map<string, number>();
    m.set(s.pattern, (m.get(s.pattern) ?? 0) + s.bytesPerHour);
    byContainer.set(s.container, m);
  }
  const exempt = new Set(input.exceptions);
  const inScope = (c: string): boolean => !exempt.has(c) && (input.targetServices.length === 0 || input.targetServices.includes(c));
  const actionOf = (c: string): BudgetAction => hot.service_actions[c] ?? hot.default_action;
  let exemptPerHour = 0;
  const budgeted: Array<{ c: string; rate: number }> = [];
  for (const [c, m] of byContainer) {
    for (const r of m.values()) {
      if (inScope(c)) budgeted.push({ c, rate: r });
      else exemptPerHour += r;
    }
  }
  const budgetedPerHour = budgeted.reduce((a, x) => a + x.rate, 0);
  const rates = budgeted.map((x) => x.rate);

  // A = (S - outside - tier_down in flight) / (k x R); the tier_down in flight depends on A, so iterate.
  let level: number | undefined;
  let allowance = Math.max(0, (S - outside) / (k * R));
  let moved = 0;
  let inFlight = 0;
  for (let i = 0; i < 8; i++) {
    const forBudgeted = Math.max(0, allowance - exemptPerHour);
    level = budgetedPerHour > forBudgeted ? waterLevel(rates, forBudgeted) : undefined;
    moved = level === undefined ? 0 : budgeted.reduce((a, x) => a + Math.max(0, x.rate - (level as number)), 0);
    const movedToTd = level === undefined ? 0 : budgeted.reduce((a, x) => a + (actionOf(x.c) === 'tier_down' ? Math.max(0, x.rate - (level as number)) : 0), 0);
    inFlight = kTd * movedToTd * L;
    allowance = Math.max(0, (S - outside - inFlight) / (k * R));
  }
  // Above S now: lines already on hot leave only as their indices age out, so hold tighter until it drains.
  const overSize = H > S;
  if (overSize && H > 0) {
    allowance *= S / H;
    const forBudgeted = Math.max(0, allowance - exemptPerHour);
    level = budgetedPerHour > forBudgeted ? waterLevel(rates, forBudgeted) : undefined;
    moved = level === undefined ? 0 : budgeted.reduce((a, x) => a + Math.max(0, x.rate - (level as number)), 0);
  }
  const forBudgeted = Math.max(0, allowance - exemptPerHour);
  const headroom = budgetedPerHour > 0 ? Math.min(FLEET_DEFAULT_HEADROOM, Math.max(1, forBudgeted / budgetedPerHour)) : FLEET_DEFAULT_HEADROOM;

  const rows: HotTierRow[] = [];
  const knownCaps: number[] = [];
  const knownTotals: number[] = [];
  const knownNodes: number[] = [];
  let keptTotal = exemptPerHour;
  for (const c of [...byContainer.keys()].sort()) {
    const ps = [...byContainer.get(c)!.values()];
    const n = Math.max(1, input.instances[c] ?? 1);
    const rate = ps.reduce((a, r) => a + r, 0);
    if (!inScope(c)) {
      rows.push({ container: c, action: 'pass', instances: n, bytesPerHour: rate, keptPerHour: rate, cap: 0, total: perWindowPerNode(rate * FLEET_DEFAULT_HEADROOM, n) });
      continue;
    }
    const capPerHour = level !== undefined ? level : Math.max(...ps) * headroom;
    const keptPerHour = level !== undefined ? ps.reduce((a, r) => a + Math.min(r, level as number), 0) : rate * headroom;
    keptTotal += level !== undefined ? keptPerHour : rate;
    knownCaps.push(capPerHour);
    knownTotals.push(keptPerHour);
    if (input.instances[c] !== undefined) knownNodes.push(n);
    rows.push({ container: c, action: actionOf(c), instances: n, bytesPerHour: rate, keptPerHour, cap: perWindowPerNode(capPerHour, n), total: perWindowPerNode(keptPerHour, n) });
  }
  for (const c of input.exceptions) {
    if (!byContainer.has(c)) rows.push({ container: c, action: 'pass', instances: Math.max(1, input.instances[c] ?? 1), bytesPerHour: 0, keptPerHour: 0, cap: 0, total: 1 });
  }
  rows.sort((a, b) => a.container.localeCompare(b.container));

  // A service the run has not seen: the level the others get, and the median total.
  const leftover = Math.max(0, forBudgeted - (keptTotal - exemptPerHour));
  const mCap = median(knownCaps);
  const mTotal = median(knownTotals);
  const starCap = mCap === undefined ? leftover : level !== undefined ? level : Math.max(leftover, mCap);
  const starTotal = mTotal === undefined ? leftover : level !== undefined ? mTotal : Math.max(leftover, mTotal);
  const mNodes = median(knownNodes);
  const starNodes = mNodes !== undefined ? Math.max(1, Math.round(mNodes)) : Math.max(1, input.nodesTotal);
  const star = { action: hot.default_action as BudgetAction, instances: starNodes, cap: perWindowPerNode(starCap, starNodes), total: perWindowPerNode(starTotal, starNodes), keptPerHour: starTotal };

  const keptBudgeted = level !== undefined ? budgetedPerHour - moved : budgetedPerHour;
  const projected = outside + k * (keptBudgeted + exemptPerHour) * R + inFlight;
  const heldLine =
    `Hot tier: ${fmtGB(H)} of ${fmtGB(S)} (${targetSource}) on ${reads.hotNodes} hot node${reads.hotNodes === 1 ? '' : 's'}; ` +
    `at these limits it settles at about ${fmtGB(projected)} within ${Math.round(R)} hours, with ${fmtGB(moved * 24)} a day of counted lines moved to ${elasticDestination(hot.default_action)}.`;
  lines.push(
    `Outside the Receiver: ${fmtGB(outside)} on hot. The Receiver's kept lines: ${fmtGB(reads.pass.storeBytes)} in ${reads.pass.indices} indices; its tier_down lines not yet moved: ${fmtGB(reads.tierDown.storeBytes)} in ${reads.tierDown.indices}.`,
    `A kept line stays on hot ${Math.round(R * 10) / 10} hours (${reads.retentionSource}); a tier_down index ${Math.round(L * 10) / 10} hours (${reads.tierDownSource}).`,
    `Each counted byte takes ${k.toFixed(2)} bytes of store kept, ${kTd.toFixed(2)} as tier_down (measured on the indices on hot).`,
    level !== undefined
      ? `The Receiver's statements send ${fmtGB(budgetedPerHour * 24)} a day; ${fmtGB(allowance * 24)} a day fits the size, so each statement keeps up to ${fmtGB(level * 24)} a day and the noisiest give way first.`
      : `The Receiver's statements send ${fmtGB(budgetedPerHour * 24)} a day, under the ${fmtGB(allowance * 24)} a day that fits the size; every statement keeps its lines, with room to grow ${headroom.toFixed(1)} times.`,
  );
  if (overSize) {
    lines.push(`Hot is above the size now; the allowance is held at ${Math.round((S / H) * 100)}% until it drains, which takes up to ${Math.round(R)} hours as the indices on hot age out.`);
  }
  if (outside + inFlight >= S) {
    warnings.push(`Lines outside the Receiver and the tier_down lines waiting to move already fill ${fmtGB(S)}, so the Receiver's services keep nothing beyond the always-pass sample of ${ALWAYS_PASS_LINES} lines a statement a window.`);
  }
  return {
    targetBytes: S,
    targetSource,
    hotStoreBytes: H,
    hotDiskBytes: reads.hotDiskBytes,
    outsideBytes: outside,
    storePerByte: k,
    storePerByteTierDown: kTd,
    retentionHours: R,
    tierDownHotHours: L,
    allowancePerHour: allowance,
    ...(level !== undefined ? { levelPerHour: level } : {}),
    movedPerHour: moved,
    tierDownInFlightBytes: inFlight,
    projectedBytes: projected,
    overSize,
    rows,
    star,
    heldLine,
    lines,
    warnings,
  };
}

export function renderHotTierReport(plan: HotTierPlan, hot: HotTierBudget, nowSec: number): string {
  return [
    `# Hot-tier run: ${new Date(nowSec * 1000).toISOString()}`,
    '',
    plan.heldLine,
    '',
    ...plan.lines.map((l) => `- ${l}`),
    ...plan.warnings.map((w) => `- Warning: ${w}`),
    '',
    `| Service | Destination | Nodes | Sent a day | Kept a day | Limit per statement | Total |`,
    `|---|---|---|---|---|---|---|`,
    ...plan.rows.map(
      (r) =>
        `| ${r.container} | ${r.action === 'pass' ? 'left alone' : elasticDestination(r.action)} | ${r.instances} | ${fmtGB(r.bytesPerHour * 24)} | ${fmtGB(r.keptPerHour * 24)} | ${r.cap} | ${r.total} |`,
    ),
    `| \`*\` (any other service) | ${elasticDestination(hot.default_action)} | ${plan.star.instances} | | ${fmtGB(plan.star.keptPerHour * 24)} | ${plan.star.cap} | ${plan.star.total} |`,
    '',
    `Limits and totals are bytes per ${REGULATOR_WINDOW_SECONDS / 60}-minute window per node, counted the way the Receiver counts them (utf8Size). Error lines pass ${hot.keep_count} over a limit per statement per node per window.`,
    '',
  ].join('\n');
}
