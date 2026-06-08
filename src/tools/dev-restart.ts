/**
 * log10x_dev_restart — forcibly exit the MCP server process so the
 * host respawns a fresh instance with an updated build.
 *
 * ONLY registered when LOG10X_DEV_MODE=true is set at server startup.
 * Never visible in production tool listings.
 *
 * Usage: call with no arguments. The tool returns a confirmation
 * envelope and schedules process.exit(0) 100ms later so the response
 * can be flushed to the MCP host before the process disappears.
 * After the respawn, re-fetch tool schemas — the new process may have
 * a different tool set if the build changed.
 *
 * Fix 95 — env-var survival across respawn:
 * Some MCP hosts (e.g. Claude Desktop) do not re-inject the .mcp.json
 * `env` block when respawning after a process.exit(). This means
 * LOG10X_API_KEY and LOG10X_ENV_ID are absent in the child process,
 * causing loadLegacyLog10x() to fall through to Path 5 (demo mode) and
 * triggering the METRIC_REQUIRING_TOOLS not_configured gate.
 *
 * To avoid this, before exiting we write a marker file at
 * ~/.log10x/dev-restart-pending.json containing the current API key and
 * env ID. loadLegacyLog10x() reads and deletes the marker on boot,
 * re-injecting the credentials as if the env vars had been present.
 *
 * Limitation 96 — MCP client tool-schema cache is NOT refreshed.
 * dev_restart respawns the SERVER process. It does NOT cause the MCP
 * CLIENT (Claude Code, Claude Desktop, Cursor, etc.) to re-list the
 * tool catalog. If the new build registered new tools, the client's
 * cached tool schema list is stale until the client itself is
 * restarted. Symptoms:
 *   - A newly-registered tool is invisible to the client
 *   - ToolSearch by exact name returns "No matching deferred tools found"
 *   - The server logs show the tool registered correctly at boot
 *
 * The MCP spec defines a `tools/list_changed` notification the server
 * MAY emit to ask the client to re-list — but most clients today
 * either don't subscribe or don't honor it for an in-session server.
 *
 * Workaround: restart the MCP CLIENT after a dev_restart that adds or
 * removes tools. For Claude Code: close + reopen the session. For
 * Claude Desktop: quit and relaunch the app. For Cursor: reload the
 * window. Existing tools whose schemas have NOT changed continue to
 * work without a client restart — only catalog-shape changes trigger
 * this.
 *
 * See docs/dev-mode-known-limitations.md for the full discussion.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { requireWriteAccess } from '../lib/read-only-guard.js';

export const devRestartSchema = {};

export function executeDevRestart(): StructuredOutput {
  requireWriteAccess('exits the MCP server process to force a respawn (developer-only)');
  const envelope = buildEnvelope({
    tool: 'log10x_dev_restart',
    view: 'summary',
    summary: {
      headline: 'MCP server restarting in 100ms. Re-load tool schemas after respawn.',
    },
    data: {},
    actions: [],
  });

  // Fix 95 — write marker file so env vars survive the respawn.
  // Best-effort: if the write fails (e.g. no home dir, permissions), we
  // still exit — the worst case is the fresh process falls back to demo
  // mode, which is the pre-fix behavior and is recoverable.
  try {
    const apiKey = process.env.LOG10X_API_KEY;
    const envId = process.env.LOG10X_ENV_ID;
    if (apiKey) {
      const dir = join(homedir(), '.log10x');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const marker = join(dir, 'dev-restart-pending.json');
      writeFileSync(
        marker,
        JSON.stringify({ apiKey, ...(envId ? { envId } : {}) }),
        { mode: 0o600 }
      );
    }
  } catch {
    // Swallow — non-fatal. The respawned process will fall back to
    // demo mode if the marker wasn't written, which is recoverable.
  }

  // Schedule exit after the envelope has been returned and serialised by
  // the MCP transport layer. 100ms is enough for the stdio flush.
  setTimeout(() => process.exit(0), 100);

  return envelope;
}
