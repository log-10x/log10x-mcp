/**
 * Per-SIEM default analyzer cost ($/GB indexed).
 *
 * SYNCED FROM: the console UI's `src/vendors.json`.
 * DO NOT HARDCODE elsewhere — update this file if vendors.json changes.
 *
 * Values present in vendors.json override the defaults here. Values absent
 * from it (clickhouse self-hosted) use a conservative public-price estimate.
 * self-hosted) use a conservative public-price estimate.
 */

export type SiemId =
  | 'cloudwatch'
  | 'datadog'
  | 'sumo'
  | 'gcp-logging'
  | 'elasticsearch'
  | 'azure-monitor'
  | 'splunk'
  | 'clickhouse'
  | 'coralogix'
  | 'elastic-serverless';

export const DEFAULT_ANALYZER_COST_PER_GB: Record<SiemId, number> = {
  // vendors.json: CloudWatch cost=0.5
  cloudwatch: 0.5,
  // vendors.json: Datadog cost=2.5
  datadog: 2.5,
  // vendors.json: Splunk cost=6
  splunk: 6,
  // vendors.json: Elasticsearch cost=1
  elasticsearch: 1,
  // vendors.json: Azure Logs cost=2.3
  'azure-monitor': 2.3,
  // vendors.json: Google Cloud / GCP Logging cost=0.5
  'gcp-logging': 0.5,
  // vendors.json: Sumo Logic cost=2.5 (dotcom + comsite vendors.json both say
  // 2.5, matching PRICING.md). A prior entry hardcoded 0.25 with a comment that
  // misquoted vendors.json; corrected to the canonical 2.5.
  sumo: 2.5,
  // Not in vendors.json. STORAGE ONLY, and storage is not the ClickHouse
  // bill: $0.15/GB-month is a conservative stand-in for what a table costs to
  // keep. What a ClickHouse cluster actually costs is compute, priced through
  // COST_MODEL_BY_DESTINATION.clickhouse.compute (lib/cost.ts), and every
  // dollar that comes out of it is modeled. Do not read this number as the
  // destination's $/GB the way Datadog's $2.50 is read. Override via
  // analyzer_cost_per_gb arg on the submit tool for a known deployment.
  clickhouse: 0.15,
  // Coralogix Frequent Search (the default priority every event lands in when
  // no TCO policy matches — zero policies means priorityclass "high").
  //
  // DIVERGENCE FROM PRICING.md, stated so nobody silently "fixes" it:
  // PRICING.md's vendor table lists Coralogix at $0.50, which is the MONITORING
  // (Medium) tier rate, not Frequent Search. This entry is the premium tier the
  // baseline bills at, so tier_down has something to reduce FROM; $0.50 is
  // modeled below as tier_down_target_tier. Reconcile PRICING.md separately —
  // it feeds the marketing surfaces, not this model.
  coralogix: 1.15,
  // Elastic Cloud Serverless, Logs Essentials. Per
  // elastic.co/pricing/serverless-observability: "As low as $0.07" per GB
  // ingested, "As low as $0.017" per GB retained per month. The Complete plan
  // is $0.09 / $0.019.
  //
  // We take the ESSENTIALS FLOOR deliberately. These are "as low as" prices, so
  // a real bill is >= this, which makes any savings estimate built on it a
  // FLOOR too. Understating the saving is the safe direction; overstating it is
  // the one that loses trust. Override with analyzer_cost_per_gb for a tenant
  // on Complete or with a negotiated rate.
  //
  // This entry exists because `elasticsearch` (1.0, from vendors.json) is a
  // SELF-HOSTED assumption. Charging a Serverless tenant against it overstates
  // their bill ~14x and inflates every savings number in proportion.
  'elastic-serverless': 0.07,
};

export const SIEM_DISPLAY_NAMES: Record<SiemId, string> = {
  cloudwatch: 'Amazon CloudWatch Logs',
  datadog: 'Datadog',
  sumo: 'Sumo Logic',
  'gcp-logging': 'GCP Cloud Logging',
  elasticsearch: 'Elasticsearch',
  'elastic-serverless': 'Elastic Cloud Serverless',
  'azure-monitor': 'Azure Monitor / Log Analytics',
  splunk: 'Splunk',
  clickhouse: 'ClickHouse',
  coralogix: 'Coralogix',
};

/**
 * What each per-GB default is. `list`: the vendor sells logs per GB and this is
 * its price. `default`: a stand-in, because the vendor bills in other units
 * (Datadog indexes per million events) or publishes no per-GB price. A default
 * is never labelled a list price where it is printed.
 */
export type DefaultRateBasis = 'list' | 'default';

export const DEFAULT_RATE_BASIS: Record<SiemId, DefaultRateBasis> = {
  cloudwatch: 'list',
  'gcp-logging': 'list',
  'azure-monitor': 'list',
  coralogix: 'list',
  'elastic-serverless': 'list',
  datadog: 'default',
  splunk: 'default',
  elasticsearch: 'default',
  sumo: 'default',
  clickhouse: 'default',
};

/** The vendor's own units, where the per-GB default stands in for them. */
const DEFAULT_RATE_NOTES: Partial<Record<SiemId, string>> = {
  datadog:
    'a blend of Datadog\'s two meters, which datadoghq.com/pricing/list gives as $0.10 per GB ingested and $2.50 per million events indexed at 30-day retention, billed annually',
  elasticsearch: 'an estimate of self-managed infrastructure per GB',
  clickhouse: 'a storage stand-in; the ClickHouse bill is compute',
};

/**
 * Both lookups below read only the constant tables above, and the plan solver
 * calls them for every pattern on every step, so each keeps its answers.
 */
const siemIdCache = new Map<string, SiemId | undefined>();
const defaultRateCache = new Map<string, string>();

/** A SiemId from an id or a display name; undefined when neither matches. */
export function siemIdOf(x: string | null | undefined): SiemId | undefined {
  if (!x) return undefined;
  if (siemIdCache.has(x)) return siemIdCache.get(x);
  const id = siemIdOfUncached(x);
  siemIdCache.set(x, id);
  return id;
}

function siemIdOfUncached(x: string): SiemId | undefined {
  const k = x.trim();
  if (k in DEFAULT_ANALYZER_COST_PER_GB) return k as SiemId;
  const lower = k.toLowerCase();
  if (lower in DEFAULT_ANALYZER_COST_PER_GB) return lower as SiemId;
  const byName = (Object.entries(SIEM_DISPLAY_NAMES) as [SiemId, string][]).find(
    ([, name]) => name.toLowerCase() === lower,
  );
  return byName?.[0];
}

/** "list price" or "default rate": the label for this destination's per-GB default. */
export function defaultRateLabel(x: string | null | undefined): 'list price' | 'default rate' {
  const id = siemIdOf(x);
  return id && DEFAULT_RATE_BASIS[id] === 'list' ? 'list price' : 'default rate';
}

/** The vendor's own units behind a default rate, when known. */
export function defaultRateNote(x: string | null | undefined): string | undefined {
  const id = siemIdOf(x);
  return id ? DEFAULT_RATE_NOTES[id] : undefined;
}

/**
 * The per-GB default in words, with its basis: "Amazon CloudWatch Logs list
 * price $0.50/GB", or "the Datadog default rate $2.50/GB, a per-GB default,
 * not a Datadog list price (a blend of Datadog's two meters: ...)".
 */
export function describeDefaultRate(x: string | null | undefined, ratePerGb?: number | null): string {
  const key = `${x ?? ''}\u0000${ratePerGb ?? ''}`;
  const hit = defaultRateCache.get(key);
  if (hit !== undefined) return hit;
  const text = describeDefaultRateUncached(x, ratePerGb);
  defaultRateCache.set(key, text);
  return text;
}

function describeDefaultRateUncached(x: string | null | undefined, ratePerGb?: number | null): string {
  const id = siemIdOf(x);
  const rate = ratePerGb ?? (id ? DEFAULT_ANALYZER_COST_PER_GB[id] : undefined);
  const shown =
    rate != null && Number.isFinite(rate) ? ` $${Number.isInteger(rate) ? rate : rate.toFixed(2)}/GB` : '';
  if (!id) return `the default rate${shown} for ${x?.trim() || 'this destination'}, a per-GB default, not a vendor list price`;
  const name = SIEM_DISPLAY_NAMES[id];
  if (DEFAULT_RATE_BASIS[id] === 'list') return `${name} list price${shown}`;
  const note = defaultRateNote(id);
  const article = /^[aeiou]/i.test(name) ? 'an' : 'a';
  return `the ${name} default rate${shown}, a per-GB default, not ${article} ${name} list price` + (note ? ` (${note})` : '');
}

export function getAnalyzerCostForSiem(id: SiemId, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return override;
  return DEFAULT_ANALYZER_COST_PER_GB[id];
}
