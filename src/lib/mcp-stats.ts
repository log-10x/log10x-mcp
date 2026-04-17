/**
 * Per-process MCP tool call stats — surfaced via the log10x_mcp_stats meta tool.
 *
 * Lives in its own module (separate from index.ts) so that harnesses,
 * dashboards, or test suites can read the stats without triggering the
 * stdio server bootstrap in index.ts.
 */

export interface ToolStat {
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  lastErrorMs?: number;
  lastErrorMsg?: string;
}

const toolStats = new Map<string, ToolStat>();

export function recordToolCall(toolName: string, ms: number, err?: Error): void {
  let s = toolStats.get(toolName);
  if (!s) {
    s = { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
    toolStats.set(toolName, s);
  }
  s.calls++;
  s.totalMs += ms;
  if (ms > s.maxMs) s.maxMs = ms;
  if (err) {
    s.errors++;
    s.lastErrorMs = Date.now();
    s.lastErrorMsg = err.message.slice(0, 200);
  }
}

export function getToolStats(): Array<{ name: string; stats: ToolStat }> {
  return Array.from(toolStats.entries()).map(([name, stats]) => ({ name, stats }));
}

/** Clear stats — for tests and tool introspection resets. */
export function clearToolStats(): void {
  toolStats.clear();
}
