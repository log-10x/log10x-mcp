# Log10x MCP Server

Per-pattern log cost attribution for AI assistants. Ask Claude (or any MCP-compatible AI) "why did our log costs spike this week?" and get an instant, dollar-ranked answer powered by pre-aggregated Prometheus metrics.

## What it does

Log10x pre-aggregates per-pattern byte metrics inline, before logs hit any SIEM. This MCP server exposes that data to AI assistants as a set of tools:

| Tool | Answers |
|---|---|
| `log10x_cost_drivers` | "Why did our log costs spike?" — dollar-ranked patterns with before→after deltas |
| `log10x_event_lookup` | "What is this Payment Gateway pattern?" — cost breakdown + AI classification |
| `log10x_savings` | "How much are we saving?" — per-app savings with annual projection |
| `log10x_pattern_trend` | "When did this pattern start spiking?" — time series + sparkline |
| `log10x_services` | "What services are we monitoring?" — volume + cost by service |
| `log10x_exclusion_filter` | "How do I drop this in Datadog?" — config snippets for 14 vendors |
| `log10x_dependency_check` | "Anything depending on this before I drop it?" — SIEM dependency scan |

The server queries `prometheus.log10x.com` over HTTPS. No log scanning, sub-second at any scale.

## Install

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "log10x": {
      "command": "npx",
      "args": ["-y", "log10x-mcp"],
      "env": {
        "LOG10X_API_KEY": "your-api-key",
        "LOG10X_ENV_ID": "your-env-id"
      }
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add --transport stdio \
  --env LOG10X_API_KEY=your-api-key \
  --env LOG10X_ENV_ID=your-env-id \
  log10x -- npx -y log10x-mcp
```

Verify with `/mcp`.

### Cursor / Windsurf / other MCP clients

Same pattern — add an `mcpServers` entry with `"command": "npx"`, `"args": ["-y", "log10x-mcp"]`, and the two env vars.

## Get your credentials

1. Log into [console.log10x.com](https://console.log10x.com)
2. Open Profile → API Settings
3. Copy your **API Key** and **Environment ID**
4. (Optional) Set your **Analyzer Cost** ($/GB for your SIEM) — the server reads this automatically

## Multi-environment setup

To query multiple Log10x environments (prod, staging, etc.), register one MCP server per environment with a distinct name:

```json
{
  "mcpServers": {
    "log10x-prod": {
      "command": "npx",
      "args": ["-y", "log10x-mcp"],
      "env": {
        "LOG10X_API_KEY": "prod-api-key",
        "LOG10X_ENV_ID": "prod-env-id"
      }
    },
    "log10x-staging": {
      "command": "npx",
      "args": ["-y", "log10x-mcp"],
      "env": {
        "LOG10X_API_KEY": "staging-api-key",
        "LOG10X_ENV_ID": "staging-env-id"
      }
    }
  }
}
```

Ask "check prod costs" and your AI assistant routes to the `log10x-prod` server automatically. Each environment gets its own toolset namespaced by server name — no param juggling, no footguns.

### Advanced: single-process multi-env (for 10+ environments)

If you need to query many environments from a single process, use `LOG10X_ENVS` with a JSON array of `{nickname, apiKey, envId}` objects. Queries accept an `environment` parameter to route by nickname. This is more complex but avoids spawning N subprocesses.

```bash
LOG10X_ENVS='[{"nickname":"prod","apiKey":"...","envId":"..."},{"nickname":"staging","apiKey":"...","envId":"..."}]'
```

## Usage

You never call tools directly. Just ask your AI assistant a question in plain English:

| You say | The AI calls |
|---|---|
| "Why did our log costs spike this week?" | `log10x_cost_drivers` |
| "What is this Payment Gateway Timeout pattern?" | `log10x_event_lookup` |
| "How much are we saving with the pipeline?" | `log10x_savings` |
| "When did the checkout service start spiking?" | `log10x_pattern_trend` |
| "What services are we monitoring?" | `log10x_services` |
| "How do I drop this in Datadog?" | `log10x_exclusion_filter` |
| "Anything depending on this before I drop it?" | `log10x_dependency_check` |

## Cost driver algorithm

When you ask about cost spikes, the server runs the same algorithm as the Log10x Slack bot:

1. **Query current window** — bytes per pattern for the selected timeframe
2. **Query baseline** — average of the 3 prior windows of the same size
3. **Compute delta** — `cost_this_period - cost_baseline` per pattern
4. **Apply gates** — a pattern is a cost driver when it passes both:
   - Dollar floor: delta exceeds `$500/period`
   - Contribution floor: delta is at least `5%` of the total service increase
5. **Sort by delta** descending

Example output:

```
cart — $103 → $13K/wk (3 cost drivers)

#1  cart cartstore ValkeyCartStore      $51 → $6.4K/wk   INFO  6.6B events
#2  GetCartAsync called with userId     $34 → $4.3K/wk         4.2B events
#3  AddItemAsync called with userId     $18 → $2.2K/wk         2.1B events

3 drivers = 98% of increase · 11 other patterns
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `LOG10X_API_KEY` | Yes (single-env) | Your Log10x API key |
| `LOG10X_ENV_ID` | Yes (single-env) | Your Log10x environment ID |
| `LOG10X_ENVS` | Yes (multi-env) | JSON array of `{nickname, apiKey, envId}` |
| `LOG10X_API_BASE` | No | API base URL (default: `https://prometheus.log10x.com`) |

The server fetches your analyzer cost ($/GB) from your Console profile at startup and refreshes it hourly. To change it, update the cost in your profile — the server picks up the new value within an hour.

## Security

- All API calls use your personal API key (never exposed in tool output)
- The server runs locally — no data leaves your machine except Prometheus queries
- Dependency check scripts run locally with your own SIEM credentials (read-only)
- No caching of log content — all data comes from pre-aggregated metrics

## Documentation

Full documentation: [doc.log10x.com/manage/mcp-server](https://doc.log10x.com/manage/mcp-server/)

## License

MIT
