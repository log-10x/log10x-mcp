/**
 * Per-SIEM default analyzer cost ($/GB indexed).
 *
 * SYNCED FROM: /Users/talweiss/git/l1x-co/backend/terraform/console/ui/src/vendors.json
 * DO NOT HARDCODE elsewhere — update this file if vendors.json changes.
 *
 * Values the handoff prescribed are kept as-is; values present in
 * vendors.json override defaults. Values not in vendors.json (clickhouse
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
  | 'clickhouse';

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
  // vendors.json: Sumo Logic cost=0.25 (cheaper than handoff's 2.5 estimate;
  // the vendors.json is authoritative)
  sumo: 0.25,
  // Not in vendors.json — self-hosted ClickHouse storage cost, approx.
  // Set to 0.15 ($/GB-month) as a conservative default. Override via
  // analyzer_cost_per_gb arg on the submit tool if using ClickHouse Cloud.
  clickhouse: 0.15,
};

export const SIEM_DISPLAY_NAMES: Record<SiemId, string> = {
  cloudwatch: 'Amazon CloudWatch Logs',
  datadog: 'Datadog',
  sumo: 'Sumo Logic',
  'gcp-logging': 'GCP Cloud Logging',
  elasticsearch: 'Elasticsearch',
  'azure-monitor': 'Azure Monitor / Log Analytics',
  splunk: 'Splunk',
  clickhouse: 'ClickHouse',
};

export function getAnalyzerCostForSiem(id: SiemId, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return override;
  return DEFAULT_ANALYZER_COST_PER_GB[id];
}
