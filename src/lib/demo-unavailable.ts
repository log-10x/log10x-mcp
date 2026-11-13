/**
 * Tools the hosted demo registers but cannot serve: each reads a system the
 * demo environment does not have. On 2026-11-13 they answered a visitor's
 * agent with set-your-API-key instructions (DD_API_KEY, CLICKHOUSE_URL,
 * LOG10X_CUSTOMER_METRICS_URL) or routed it to tools the demo does not
 * expose. In the demo playground they now say so in one line instead.
 *
 * They stay registered: the deploy gate (backend .github/scripts/
 * verify-demo-mcp.py) requires the live tool list to equal the manifest
 * allowlist, and an agent that lists tools should learn what the product can
 * do on its own data.
 */
import { buildEnvelope, type StructuredOutput } from './output-types.js';

const READS: Record<string, string> = {
  log10x_datadog_change_report: 'a Datadog org through its API and application keys',
  log10x_datadog_spike_audit: 'a Datadog org through its API and application keys',
  log10x_clickhouse_census: "a ClickHouse cluster's system tables",
  log10x_customer_metrics_query: "the customer's own metrics backend (Prometheus, Grafana Cloud, AMP or Datadog)",
  log10x_discover_join: "the customer's own metrics backend (Prometheus, Grafana Cloud, AMP or Datadog)",
  log10x_metrics_that_moved: "the customer's own metrics backend (Prometheus, Grafana Cloud, AMP or Datadog)",
  log10x_rank_by_shape_similarity: "the customer's own metrics backend (Prometheus, Grafana Cloud, AMP or Datadog)",
  log10x_metric_overlay: "the customer's own metrics backend (Prometheus, Grafana Cloud, AMP or Datadog)",
  log10x_commitment_report: 'the commitment records written when a cost plan is applied to a cluster',
  log10x_retriever_probe: 'a Kubernetes Retriever deployment (pods, queues and helm values)',
};

const DOCS_URL = 'https://doc.log10x.com/apps/mcp/';

/**
 * Tools refused for what they take rather than what they read. find_skew
 * analyses pasted raw log lines, which the hosted demo does not accept (SOC 2
 * scope ruling 2026-10-15, upheld 2026-11-13).
 */
const TAKES: Record<string, string> = {
  log10x_find_skew: 'analyses pasted raw log lines, and the hosted demo does not accept pasted lines',
};

export function isDemoPlayground(): boolean {
  return /^(1|true|yes)$/i.test(process.env.LOG10X_MCP_DEMO_PLAYGROUND ?? '');
}

/** The demo line for `tool`, or null when the tool is served in the demo. */
export function demoUnavailableLine(tool: string): string | null {
  const reads = READS[tool];
  const takes = TAKES[tool];
  if (!reads && !takes) return null;
  const why = reads ? `reads ${reads}, and the demo environment has none` : takes;
  return (
    `Not available in the hosted demo: ${tool} ${why}. ` +
    `It runs when the log10x MCP is installed against a real environment: ${DOCS_URL}`
  );
}

export function demoUnavailableEnvelope(tool: string): StructuredOutput | null {
  if (!isDemoPlayground()) return null;
  const line = demoUnavailableLine(tool);
  if (!line) return null;
  return buildEnvelope({
    tool,
    view: 'summary',
    summary: { headline: line },
    data: {
      status: 'not_available_in_demo',
      human_summary: line,
      docs_url: DOCS_URL,
    },
  });
}
