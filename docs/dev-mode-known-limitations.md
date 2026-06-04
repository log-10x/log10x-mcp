# Dev mode — known limitations

`log10x_dev_restart` is only registered when `LOG10X_DEV_MODE=true` is set
at server startup. It exits the server process so the MCP host respawns
a fresh instance with the latest build. Two limitations are worth knowing
before relying on it as a tight iteration loop.

## Limitation 95 — env vars across respawn (FIXED)

Some MCP hosts (e.g. Claude Desktop) do not re-inject the `.mcp.json`
`env` block when respawning after a `process.exit()`. The fresh child
process boots without `LOG10X_API_KEY` and `LOG10X_ENV_ID`, falls
through to demo mode, and the metrics-backend gate fires `not_configured`
on every Reporter-tier tool.

Fixed in commit ed1a26e. `dev_restart` now writes a marker file at
`~/.log10x/dev-restart-pending.json` with the current credentials before
exiting. `loadLegacyLog10x()` reads and deletes the marker on boot,
re-injecting the credentials as if the env vars had been present. A
diagnostic line `[log10x-mcp] metricsBackend resolved via <source>` lands
in stderr on every boot so the resolution path is auditable.

## Limitation 96 — MCP client tool-schema cache (NOT server-fixable)

`dev_restart` respawns the SERVER process. It does NOT cause the MCP
CLIENT (Claude Code, Claude Desktop, Cursor, Zed, etc.) to re-list the
tool catalog.

If the new build registered, removed, or renamed tools, the client's
cached schema list is stale until the client itself is restarted.

### Symptoms

- A newly-registered tool is invisible to the client.
- `ToolSearch select:<new_tool_name>` returns "No matching deferred tools
  found" even though `grep <new_tool_name> build/index.js` shows it
  registered.
- The server's stderr log on boot shows the tool registered correctly.
- Existing tools whose schemas have NOT changed continue to work.

### Root cause

MCP clients cache the tool list returned by `tools/list` at session
start. The MCP spec defines a `tools/list_changed` notification the
server MAY emit to ask the client to re-list, but most clients today
either don't subscribe to it or don't honor it for an in-session server
process. The cache lifetime is controlled by the client, not the server.

### Workaround

Restart the MCP CLIENT after a `dev_restart` that adds or removes tools.

- **Claude Code**: close + reopen the session (`/exit` then re-run, or
  open a new tab).
- **Claude Desktop**: quit and relaunch the application.
- **Cursor**: reload the window (Cmd+Shift+P → "Developer: Reload Window").
- **Zed**: restart the app or use Cmd+R if the MCP integration supports it.

For schema-only changes to existing tools (description, args), the
client cache may serve the old description but tool-call execution still
hits the new server code. Cosmetic mismatch only — invocations work.

### Long-term fix path

Implementing `tools/list_changed` on the server side is straightforward
(call `notifyToolListChanged()` after registering the new tool list).
The blocker is client adoption — Claude Code, Claude Desktop, and
Cursor all need to subscribe to the notification and react by re-listing.
Tracking upstream:
- Anthropic MCP SDK roadmap (client-side `tools/list_changed` subscriber)
- Cursor MCP integration changelog

Until adoption lands across the major clients, the manual restart is
the documented workaround. This is not a Log10x-specific issue — it
affects every MCP server that adds tools at runtime.
