/**
 * Server instructions for the hosted demo playground (LOG10X_MCP_DEMO_PLAYGROUND).
 *
 * The full SERVER_INSTRUCTIONS (41 KB) route every cost question to
 * log10x_start and POC asks to log10x_poc_from_local, and forbid calling
 * services / cost_options / estimate_savings until log10x_start answers. The
 * demo registers neither tool, so an agent that followed the instructions
 * could not start (2026-11-13). This text names only tools the demo serves.
 */
export const DEMO_SERVER_INSTRUCTIONS = `LOG10X HOSTED DEMO. This server is a read-only demo of the log10x MCP on one demo environment: the OpenTelemetry demo application (17 services) sending its logs to Amazon CloudWatch through the 10x receiver. Every number comes from that environment, not from the user's systems; say so when you quote one. To run on their own logs, the user installs the MCP: https://doc.log10x.com/apps/mcp/

How the demo pipeline works: the receiver assigns every log line to a pattern (identified by pattern_hash, e.g. "fg1YkiyrF3Q") and routes each pattern one of three ways: pass (sent to CloudWatch, billed there), offload (written to an S3 archive and retrievable on demand), or drop. Volumes are reported per route; say which route a figure covers.

Where to start, by question:
- What is log10x, how does it work: log10x_product_qa.
- What drives the log bill: log10x_services, then log10x_top_patterns.
- What changed or grew: log10x_whats_changing, log10x_whats_new, log10x_pattern_diff, log10x_pattern_trend.
- Cut the bill by N% without losing data: log10x_estimate_savings with target_percent, then log10x_cost_options; log10x_explain_mode and log10x_preview_filter for one service.
- The events behind a pattern: log10x_pattern_examples (lines in CloudWatch) or log10x_retriever_query with pattern_hash (events in the S3 archive).
- One pattern in depth: log10x_event_lookup, log10x_pattern_detail, log10x_dependency_check, log10x_pattern_mitigate.

Inputs: every tool takes 24h, 7d and 30d windows; most also take 15m, 1h and 6h. log10x_retriever_query search is an expression: includes(text, "value") or field=="value", joined with && and ||; plain words are searched as includes(text, "...") and the reply says so. Prefer pattern_hash from log10x_top_patterns. A Retriever query answers in under a minute, and zero events is a final answer: do not re-run the same query.

Some tools read systems the demo does not have (a Datadog org, ClickHouse, the user's own metrics backend, a Kubernetes Retriever, applied cost plans). They answer "Not available in the hosted demo"; do not retry them.`;
