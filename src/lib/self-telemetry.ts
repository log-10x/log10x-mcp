/**
 * MCP self-telemetry — `log10x_mcp_tool_call_total` and `log10x_mcp_started_total`.
 *
 * Counters that fire on each tool dispatch and on server boot. Periodically
 * flushed to the customer's Prometheus via the same JSON-adapter remote_write
 * pattern used by metric-emitters.ts (so no protobuf dependency in the MCP).
 *
 * Used by the Log10x console to render an "MCP active" badge on Step 1
 * (Connect 10x) — the console queries `count(log10x_mcp_tool_call_total)` over
 * a 24h window and lights up if any tool has been called.
 *
 * Privacy: bounded cardinality (~30 tool names + 2 statuses + 4 tiers). No
 * arguments, no payload sizes, no env labels. Tool name + outcome only.
 *
 * Gating: silent no-op unless BOTH of the following are set:
 *   - LOG10X_API_KEY (required — identifies the customer env)
 *   - PROMETHEUS_REMOTE_WRITE_URL OR LOG10X_TELEMETRY_URL (required — push target)
 *
 * If either is missing, counters increment in memory but never flush. This is
 * deliberately fail-quiet — telemetry must never block tool calls or surface
 * errors to the model.
 */

interface ToolCounter {
  success: number;
  error: number;
}

const counters = {
  toolCalls: new Map<string, ToolCounter>(),
  starts: 0,
};

let flushTimer: NodeJS.Timeout | null = null;
let flushInFlight = false;

const FLUSH_INTERVAL_MS = 30_000;

/** Increment the started counter. Call once per process boot. */
export function recordStart(): void {
  counters.starts += 1;
  scheduleFlush();
}

/** Increment a tool-call counter. Call from a wrapper around every tool handler. */
export function recordToolCall(toolName: string, status: 'success' | 'error'): void {
  const entry = counters.toolCalls.get(toolName) || { success: 0, error: 0 };
  entry[status] += 1;
  counters.toolCalls.set(toolName, entry);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

/**
 * Push pending counters to the configured Prometheus endpoint.
 * Resets counters only on successful POST. Silent on error.
 */
export async function flush(): Promise<void> {
  if (flushInFlight) return;
  const apiKey = process.env.LOG10X_API_KEY;
  if (!apiKey) return;
  const writeUrl = process.env.PROMETHEUS_REMOTE_WRITE_URL || process.env.LOG10X_TELEMETRY_URL;
  if (!writeUrl) return;

  if (counters.starts === 0 && counters.toolCalls.size === 0) return;

  const tier = process.env.LOG10X_TIER || 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const points: Array<{ metric: string; timestamp: number; value: number; labels: Record<string, string> }> = [];

  for (const [toolName, statuses] of counters.toolCalls.entries()) {
    if (statuses.success > 0) {
      points.push({
        metric: 'log10x_mcp_tool_call_total',
        timestamp: now,
        value: statuses.success,
        labels: { tool_name: toolName, status: 'success', tier },
      });
    }
    if (statuses.error > 0) {
      points.push({
        metric: 'log10x_mcp_tool_call_total',
        timestamp: now,
        value: statuses.error,
        labels: { tool_name: toolName, status: 'error', tier },
      });
    }
  }
  if (counters.starts > 0) {
    points.push({
      metric: 'log10x_mcp_started_total',
      timestamp: now,
      value: counters.starts,
      labels: { tier },
    });
  }
  if (points.length === 0) return;

  flushInFlight = true;
  try {
    const res = await fetch(writeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-10X-Auth': apiKey,
      },
      body: JSON.stringify({ points }),
    });
    if (res.ok) {
      // Reset only on successful flush so failed flushes accumulate counts
      counters.toolCalls.clear();
      counters.starts = 0;
    }
  } catch {
    // Silent — telemetry must never throw to caller
  } finally {
    flushInFlight = false;
  }
}

/** Wrap a tool handler so every call is counted. status='success' on resolve, 'error' on throw. */
export function withTelemetry<H extends (...args: any[]) => Promise<any>>(toolName: string, handler: H): H {
  const wrapped = async (...args: any[]) => {
    let status: 'success' | 'error' = 'success';
    try {
      return await handler(...args);
    } catch (err) {
      status = 'error';
      throw err;
    } finally {
      try { recordToolCall(toolName, status); } catch { /* never throw from finally */ }
    }
  };
  return wrapped as unknown as H;
}

/** Best-effort flush on process exit. Some signals don't await async work — that's OK. */
function installShutdownHooks(): void {
  const onExit = () => { void flush(); };
  process.on('beforeExit', onExit);
  process.on('SIGTERM', onExit);
  process.on('SIGINT', onExit);
}
installShutdownHooks();
