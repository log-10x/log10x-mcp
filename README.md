# Log10x MCP Server

Ask your AI assistant about log costs, log patterns, and incidents in plain English, and get structured answers backed by real per-pattern metrics. "Why did our log costs spike this week?", "what's driving payments-svc volume?", "pull the payment_retry events for acme-corp from Jan 15 to Apr 15." The server exposes the 10x platform to Claude and any MCP-compatible assistant as a set of tools.

10x groups your logs by message type. The same lines repeat over and over with only the timestamp or request ID changing, so 10x collapses each flood of near-identical lines into one message type and ranks them by volume and cost. That is how the answers stay exact instead of best-effort clustering, no regex required.

This server is open source under MIT. A Log10x product license (API key) unlocks the account-scoped tools; without one, the server boots read-only against a public demo dataset so the tools can be explored immediately.

## What you can ask

| You say | What happens |
|---|---|
| "Where do I start? Help me cut log costs." | A guided menu asks what you want (cut cost, investigate, install) and routes to the right next step, plus what's new and what changed. `log10x_start`, `log10x_whats_new`, `log10x_whats_changing` |
| "Sign me in." / "Who am I connected as?" | GitHub sign-in mints and stores an API key, and shows the environments your account can reach. `log10x_signin_start`, `log10x_login_status`, `log10x_create_env` |
| "Show me how to install this on my stack." | Paste-ready setup steps for your own pipeline, fetch-back wiring, and a recommended action per service. `log10x_advise_install`, `log10x_advise_retriever`, `log10x_configure_engine` |
| "Estimate savings on my data before I deploy." | A no-install savings report from a local log file or your existing log platform. `log10x_poc_from_local`, `log10x_poc_from_siem_submit`, `log10x_poc_from_siem_status`. **POC mode only**: a keyless boot attaches to the public demo dataset and does not register these three. Set `LOG10X_DEMO_FALLBACK=off` to boot into POC mode. The cost is a smaller tool set: POC mode drops `log10x_top_patterns`, `log10x_investigate`, `log10x_savings` and every Retriever tool. |
| "How much can I cut, and how much have I cut?" | Projected and realized savings with the per-pattern math behind every number. `log10x_estimate_savings`, `log10x_savings`, `log10x_commitment_report` |
| "What's driving my cost right now?" | The repeating message types and services driving volume and cost, and what moved week over week. `log10x_top_patterns`, `log10x_whats_changing`, `log10x_services` |
| "Why did payments-svc spike?" | A single-call investigation: timeline, correlated patterns, and the strongest temporal evidence, with confidence shown so nothing is presented as proven cause. `log10x_investigate`, `log10x_metrics_that_moved`, `log10x_metric_overlay` |
| "This message type is noise, cut it." | Sample, drop, compact, tier down, or offload a chosen message type, with examples and trend so the action is clear. `log10x_pattern_mitigate`, `log10x_pattern_examples`, `log10x_pattern_trend` |
| "Get me the actual events I offloaded." | Fetch the exact events back on demand from your own S3. `log10x_retriever_query`, `log10x_offload_add`, `log10x_retriever_register` |
| "Recognize more of my message types." | Build a custom symbol library from your own logs so the engine finds more savings. `log10x_compile`, `log10x_compile_link`, `log10x_compile_status` |

## Install

**Claude Code**

```bash
claude mcp add --transport stdio --env LOG10X_API_KEY=your-api-key log10x -- npx -y log10x-mcp
```

Verify with `/mcp`. Omit the `--env` flag to run read-only against the public demo dataset.

**Claude Desktop**

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "log10x": {
      "command": "npx",
      "args": ["-y", "log10x-mcp"],
      "env": {
        "LOG10X_API_KEY": "your-api-key"
      }
    }
  }
}
```

**Cursor, Windsurf, and other MCP clients**

Add an `mcpServers` entry of the same shape: `"command": "npx"`, `"args": ["-y", "log10x-mcp"]`, and `LOG10X_API_KEY` in `env`. Omit the key to run read-only demo mode.

Full setup walkthrough: https://doc.log10x.com/apps/mcp/

## Credentials

Account-scoped tools need a Log10x API key. Two ways to get one:

- **GitHub sign-in:** run `log10x_signin_start`, complete the flow, then `log10x_signin_complete`. The key is stored for you. `log10x_login_status` shows who you're connected as.
- **Environment variable:** set `LOG10X_API_KEY` directly.

**No key?** The server boots read-only against the public 10x demo dataset (the same sample data the website console shows), so analysis, discovery, and the install advisors all work out of the box. Mutating tools are disabled in this mode so shared demo state stays untouched. Set `LOG10X_DEMO_FALLBACK=off` to boot into pure POC mode (savings estimates on your own files, no account). The mode is fixed at startup; restart the server to re-detect.

## Environment variables

All optional. The common path is just `LOG10X_API_KEY` (or no key at all).

| Variable | Purpose |
|---|---|
| `LOG10X_API_KEY` | Your Log10x API key. Omit to boot read-only on the public demo dataset. |
| `LOG10X_API_BASE` | API base URL override (default `https://prometheus.log10x.com`). |
| `LOG10X_ENV_ID` | Pin a specific environment id instead of autodiscovering from your account. |
| `LOG10X_DEMO_FALLBACK` | Set to `off` to boot into POC mode instead of attaching to the public demo dataset when no key is set. |
| `LOG10X_MCP_READ_ONLY` | Set to `true` or `1` to force read-only mode (all mutating tools refuse). |
| `LOG10X_CUSTOMER_METRICS_URL` / `_TYPE` / `_AUTH` | Point at your own metrics backend (Prometheus, Grafana Cloud, Mimir, Thanos, AMP) for BYO-metrics setups. |
| `DD_API_KEY` / `DD_APP_KEY` / `DD_SITE` | Datadog credentials for backfilling per-pattern metrics into Datadog. |
| `PROMETHEUS_REMOTE_WRITE_URL` / `PROMETHEUS_URL` | Prometheus endpoints for backfilling and reading per-pattern series. |
| `LOG10X_RETRIEVER_URL` | Base URL of your deployed Retriever query endpoint, for fetch-back (or set it with `log10x_retriever_register`). |
| `LOG10X_RETRIEVER_TIMEOUT_MS` / `LOG10X_RETRIEVER_POLL_MS` | Fetch-back query timeout (default 90000) and poll interval (default 1500). |
| `LOG10X_RETRIEVER_AUTH_HEADER` / `LOG10X_RETRIEVER_AUTH_VALUE` | Override the fetch-back auth header (defaults derive from the active environment). |
| `LOG10X_OFFLOAD_BUCKET` / `LOG10X_STREAMER_BUCKET` | S3 bucket names the offload tools manage. |
| `TENX_LICENSE_KEY` | Engine license key. Passed through to the engine on both the compile path and the local-engine run path (`log10x_resolve_batch`, `log10x_extract_templates`), in docker mode as well as local mode. In docker mode, a key the engine rejects is withheld on an automatic retry so the run falls back to the image's built-in limited license rather than failing; the downgrade is logged on the server's stderr. |
| `TENX_LICENSE_FILE` | Path to an engine license file, the alternative to `TENX_LICENSE_KEY`. Read by the engine itself, so it must name a path the engine process can see (inside the container when the engine runs in docker). |
| `LOG10X_TENX_MODE` | `local` or `docker` for the local-engine and compile tools. Unset auto-detects: a `tenx` on PATH wins, docker is the fallback. Set `docker` to run the engine image instead of a local install, which is also the escape when a local `tenx` has no license. |
| `LOG10X_TENX_PATH` | Path to the local `tenx` binary (used when the resolved mode is `local`). Defaults to `tenx` on PATH. |
| `LOG10X_RUNTIME_IMAGE` | Engine image for the run path in docker mode (default `log10x/pipeline-10x:latest`). Accepts the alias `native`, which selects the GraalVM-native `log10x/edge-10x`. |
| `LOG10X_TENX_IMAGE` | Engine image shared by the run path and, as a fallback, `log10x_compile`. A runtime-flavor image here is refused on the compile path. |
| `LOG10X_COMPILER_IMAGE` | Compiler image for `log10x_compile` / `log10x_compile_link` (default `log10x/compiler-10x:latest`, falls back to `LOG10X_TENX_IMAGE` when unset). Only the compiler flavor can build a symbol library. |
| `LOG10X_GH_REPO` / `LOG10X_GITOPS_REPO_PATH` | GitHub repo and local path for GitOps-aware config tools. |

## Connect your own data (optional)

10x keeps logs queryable without paying to index everything. The Receiver ships budget-overflow noise to your own S3, and the Retriever fetches those exact events back on demand when you need them. `log10x_offload_add` and `log10x_retriever_register` wire up the offload-and-fetch path; `log10x_backfill_metric` pushes per-pattern volume and cost series into your existing Datadog or Prometheus so the cost views light up alongside the rest of your dashboards.

## Security

The server runs locally as a subprocess of your AI client. Only pre-aggregated metric queries (per-pattern volume and cost) leave the machine, never raw log content. Local triage with `log10x_resolve_batch` runs entirely on your machine over stdin and stdout. Connections to your own log platform use read-only credentials. Set `LOG10X_MCP_READ_ONLY=true` to refuse every mutating tool regardless of mode.

## Open source and license

MIT. Published on npm as `log10x-mcp` (Node 20+). The source is public so the behavior behind every tool can be read directly. Account-scoped tools require a Log10x product license (API key); the public demo dataset needs none.

MCP clients run the server as a long-lived child process. After upgrading the package, restart the client so the new version takes effect.

## Documentation

https://doc.log10x.com/apps/mcp/
