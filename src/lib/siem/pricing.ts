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
  // Not in vendors.json — self-hosted ClickHouse storage cost, approx.
  // Set to 0.15 ($/GB-month) as a conservative default. Override via
  // analyzer_cost_per_gb arg on the submit tool if using ClickHouse Cloud.
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

export function getAnalyzerCostForSiem(id: SiemId, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return override;
  return DEFAULT_ANALYZER_COST_PER_GB[id];
}
