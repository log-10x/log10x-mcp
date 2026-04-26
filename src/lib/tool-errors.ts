/**
 * Per-tool error suggestions for tool callback try/catch blocks.
 *
 * The model sees the error string returned by a tool and decides what to do
 * next. A raw `Prometheus HTTP 404: ...` string causes the model to give
 * up; a string that ends with "→ try log10x_event_lookup with a substring"
 * causes the model to chain to the next-best tool and recover.
 *
 * Each tool gets its own suggestion logic because the right alternative is
 * different per tool. There is no generic wrapper because there is no
 * generic right answer.
 */

export function describeToolError(toolName: string, raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw);
  const suggestion = suggestForTool(toolName, msg);
  if (!suggestion) return `Error: ${msg}`;
  return `Error: ${msg}\n\n→ ${suggestion}`;
}

function suggestForTool(toolName: string, msg: string): string | undefined {
  // Universal hints that apply to any tool.
  if (/HTTP 401|HTTP 403|unauthorized|forbidden/i.test(msg)) {
    return 'Authentication failed. Run `log10x_doctor` to verify LOG10X_API_KEY is valid (or run `log10x_signin` to mint a fresh key via GitHub).';
  }
  if (/HTTP 5\d\d|fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    return 'Transient gateway failure after retries. Run `log10x_doctor` to confirm prometheus.log10x.com is reachable, then try again. If this persists, the gateway may be degraded.';
  }
  if (/EnvironmentValidationError/.test(msg)) {
    return 'Run `log10x_doctor` to see exactly which env var is missing or malformed.';
  }
  if (/Unknown environment/i.test(msg)) {
    return 'Call `log10x_doctor` (no args) to list configured environments.';
  }

  // Per-tool specific hints.
  switch (toolName) {
    case 'log10x_investigate':
      if (/Could not resolve/i.test(msg)) {
        return 'The starting_point did not match a known pattern or service. Try `log10x_event_lookup` with a substring of the line, or `log10x_services` to see which services are monitored.';
      }
      if (/Retriever/i.test(msg)) {
        return 'The Retriever fallback is unavailable. The investigation will still complete using live Reporter metrics. To enable historical fallback, deploy the Retriever and set __SAVE_LOG10X_RETRIEVER_URL__.';
      }
      return 'If this looks transient, retry. If the anchor is hard to resolve, call `log10x_event_lookup` first to canonicalize the pattern, then call investigate again with the resolved templateHash.';

    case 'log10x_event_lookup':
      if (/No data found/i.test(msg)) {
        return 'The pattern was not found in this environment. Try `log10x_resolve_batch` with a sample line to see how the templater normalizes it, or call `log10x_services` to list known services.';
      }
      return 'If you pasted a multi-line batch, use `log10x_resolve_batch` instead — event_lookup is for single-line resolution.';

    case 'log10x_cost_drivers':
      if (/No pattern data/i.test(msg)) {
        return 'No cost data in this window. Verify the service name with `log10x_services`, or widen the timeRange (try `30d`).';
      }
      return 'If costs look unexpectedly flat, run `log10x_doctor` to confirm the Reporter tier is detected. If only Cloud Reporter is deployed, sampling can mask short cost spikes.';

    case 'log10x_resolve_batch':
      if (/too large/i.test(msg)) {
        return 'Batch exceeds the 100 KB paste Lambda limit. Either trim to ~1-2K events, paginate across multiple calls, or set privacy_mode=true with a locally-installed `tenx` CLI for unlimited size.';
      }
      if (/CLI is not installed|tenx/i.test(msg)) {
        return 'Local tenx CLI is missing. Options: (1) install locally (`brew install log-10x/tap/log10x` on macOS, MSI installer on Windows, deb/rpm/install.sh on Linux — see https://docs.log10x.com/install/); (2) run tenx in Docker by setting `LOG10X_TENX_MODE=docker`; (3) set privacy_mode=false to route through the public paste endpoint.';
      }
      if (/No events provided/i.test(msg)) {
        return 'Pass `source: "text"` with the raw events as a `text` argument, or `source: "file"` with `path`, or `source: "events"` with an inline array.';
      }
      return undefined;

    case 'log10x_retriever_query':
      if (/not configured/i.test(msg)) {
        return 'The Retriever is not deployed in this environment. For in-retention queries, use the customer\'s SIEM directly. For long-window retrieval, deploy the Retriever per https://docs.log10x.com/apps/cloud/retriever/ and set __SAVE_LOG10X_RETRIEVER_URL__.';
      }
      if (/timed out/i.test(msg)) {
        return 'Query exceeded the wall-time budget. Narrow the window, add a more selective filter, or switch format to `count` or `aggregated` for a summary view instead of raw events.';
      }
      return 'If the pattern is unknown, call `log10x_event_lookup` first to resolve a raw line to its canonical templateHash, then re-run the query.';

    case 'log10x_backfill_metric':
      if (/zero events/i.test(msg)) {
        return 'The Retriever found no events matching the pattern + filters in the requested window. Verify the pattern with `log10x_event_lookup` and check the filter expressions. The window may also be outside the customer\'s S3 retention.';
      }
      if (/DATADOG_API_KEY/i.test(msg)) {
        return 'Set DATADOG_API_KEY (or DD_API_KEY) on the MCP server process. Generate a key in Datadog: Organization Settings → API Keys.';
      }
      if (/not yet implemented/i.test(msg)) {
        return 'Use destination=datadog or destination=prometheus in this build. CloudWatch / Elastic / SignalFx ship in a follow-up release.';
      }
      return undefined;

    case 'log10x_pattern_trend':
      if (/No trend data/i.test(msg)) {
        return 'The pattern was not found in this environment in the requested window. Verify with `log10x_event_lookup` first.';
      }
      return undefined;

    case 'log10x_top_patterns':
      if (/No pattern data/i.test(msg)) {
        return 'No data in this window. Try widening the timeRange, or call `log10x_services` to list services with non-zero cost.';
      }
      return undefined;

    case 'log10x_dependency_check':
      return 'This tool generates shell commands; it doesn\'t execute them. The errors here usually mean the pattern parameter is malformed — pass a templateHash or symbolMessage from `log10x_event_lookup`.';

    case 'log10x_exclusion_filter':
      return 'This tool generates a config snippet; it doesn\'t apply it. The errors here usually mean the pattern parameter is malformed.';

    case 'log10x_investigation_get':
      if (/No investigation/i.test(msg)) {
        return 'The investigation may have aged out of the cache (30-minute TTL) or been evicted by the LRU. Re-run `log10x_investigate` with the same starting_point to regenerate.';
      }
      return undefined;

    default:
      return undefined;
  }
}
