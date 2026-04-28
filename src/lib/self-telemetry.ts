/**
 * MCP self-telemetry — `log10x_mcp_tool_call_total` and `log10x_mcp_started_total`.
 *
 * Counters that fire on each tool dispatch and on server boot. Periodically
 * flushed to a Prometheus-compatible remote_write endpoint using the native
 * wire format (protobuf + snappy), so it works against any standard receiver
 * including Log10x's hosted Prometheus at prometheus.log10x.com/api/v1/write.
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
 *   - LOG10X_TELEMETRY_URL (or PROMETHEUS_REMOTE_WRITE_URL fallback) — push target
 *
 * Counter semantics: counters are CUMULATIVE per process lifetime — never
 * reset on flush (Prometheus counters must monotonically increase between
 * resets; PromQL rate() detects process-restart resets automatically).
 */

import protobuf from 'protobufjs';
import snappy from 'snappyjs';

// Prometheus remote_write WriteRequest schema, inline.
// https://prometheus.io/docs/concepts/remote_write_spec/
const PROTO_SOURCE = `
syntax = "proto3";
message Sample {
  double value = 1;
  int64 timestamp = 2;
}
message Label {
  string name = 1;
  string value = 2;
}
message TimeSeries {
  repeated Label labels = 1;
  repeated Sample samples = 2;
}
message WriteRequest {
  repeated TimeSeries timeseries = 1;
}
`;

const protoRoot = protobuf.parse(PROTO_SOURCE).root;
const WriteRequestType = protoRoot.lookupType('WriteRequest');

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

/** Increment a tool-call counter. Called from withTelemetry wrapper. */
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

interface PendingPoint {
  metric: string;
  timestamp: number; // seconds
  value: number;
  labels: Record<string, string>;
}

function snapshotPoints(): PendingPoint[] {
  const tier = process.env.LOG10X_TIER || 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const points: PendingPoint[] = [];
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
  return points;
}

/** Build native Prometheus remote_write protobuf body for a set of points. */
function encodeWriteRequest(points: PendingPoint[]): Uint8Array {
  const timeseries = points.map((p) => ({
    labels: [
      { name: '__name__', value: p.metric },
      ...Object.entries(p.labels)
        .filter(([, v]) => v !== '' && v !== undefined && v !== null)
        .map(([name, value]) => ({ name, value: String(value) })),
    ],
    samples: [
      { value: p.value, timestamp: p.timestamp * 1000 }, // ms since epoch
    ],
  }));
  const payload = WriteRequestType.create({ timeseries });
  const err = WriteRequestType.verify(payload);
  if (err) throw new Error('Invalid WriteRequest: ' + err);
  return WriteRequestType.encode(payload).finish();
}

/**
 * Push pending counters to the configured Prometheus remote_write endpoint.
 * Uses native protobuf + snappy. Counters are NOT reset on flush — they're
 * cumulative for the lifetime of this process; restart = counter reset
 * (handled by PromQL rate()).
 */
export async function flush(): Promise<void> {
  if (flushInFlight) return;
  const apiKey = process.env.LOG10X_API_KEY;
  if (!apiKey) return;
  const writeUrl = process.env.LOG10X_TELEMETRY_URL || process.env.PROMETHEUS_REMOTE_WRITE_URL;
  if (!writeUrl) return;

  const points = snapshotPoints();
  if (points.length === 0) return;

  flushInFlight = true;
  try {
    const protobufBytes = encodeWriteRequest(points);
    const compressed = snappy.compress(protobufBytes);
    await fetch(writeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf',
        'Content-Encoding': 'snappy',
        'X-Prometheus-Remote-Write-Version': '0.1.0',
        'X-10X-Auth': apiKey,
      },
      body: compressed as unknown as BodyInit,
    });
    // Counters are cumulative — do NOT reset on success.
  } catch {
    // Silent — telemetry must never throw to caller. Counters keep their
    // cumulative values; the next flush will retry with the new totals.
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
