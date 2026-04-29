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
 * **Env scoping (key design choice)**: each tool call's counter is auth'd
 * with `<api_key>/<env_id>` for the env the tool acted on, so the metric
 * lands in THAT env's Prometheus tenant. Without this, every counter would
 * land in the user's default env regardless of where the tool was actually
 * pointed — making per-env activity attribution impossible AND making the
 * write fail outright for users whose default env is read-only (most
 * notably demo users on `Log10x Demo`).
 *
 * Skip rules at flush time:
 *   - If the env the tool acted on has READ permission only, the write
 *     would 403 — skip it (telemetry isn't worth a billing-side audit
 *     event of failed writes). This silently drops counters from
 *     read-only envs, which includes the entire demo-user population.
 *   - If the env list isn't loaded yet (race during boot), counters are
 *     held in memory and flushed on the next attempt once envs resolve.
 *
 * Privacy: bounded cardinality (~30 tool names × 2 statuses × small N envs
 * the user can write to × 4 tiers). No arguments, no payload sizes. Tool
 * name + outcome + tier only — env identity is implicit in the tenant the
 * write is auth'd to, not embedded as a label.
 *
 * Gating: silent no-op unless BOTH of the following are set:
 *   - LOG10X_API_KEY (required — identifies the customer)
 *   - LOG10X_TELEMETRY_URL (or PROMETHEUS_REMOTE_WRITE_URL fallback) — push target
 *
 * Counter semantics: counters are CUMULATIVE per process lifetime — never
 * reset on flush (Prometheus counters must monotonically increase between
 * resets; PromQL rate() detects process-restart resets automatically).
 */

import protobuf from 'protobufjs';
import snappy from 'snappyjs';
import type { Environments, EnvConfig } from './environments.js';

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
  toolName: string;
  envId: string | undefined;
  success: number;
  error: number;
}

const counters = {
  // Key shape: `${toolName}|${envId ?? '_unknown'}` — separate counters per
  // (tool, env) pair so flush can group by env and auth per-env. The
  // `_unknown` bucket holds counts captured before envs finished loading;
  // those are routed to the user's default env at flush time.
  toolCalls: new Map<string, ToolCounter>(),
  starts: 0,
};

let flushTimer: NodeJS.Timeout | null = null;
let flushInFlight = false;

const FLUSH_INTERVAL_MS = 30_000;

/**
 * Provides the in-process Environments object so the wrapper can resolve
 * which env each tool call was acting on, and flush can drop counters from
 * read-only envs. Set by index.ts after `initEnvs()` completes; before that
 * point, counters are still recorded but tagged `_unknown` and re-attributed
 * to the user's default env when flush eventually runs.
 */
let envsProvider: (() => Environments | null) | null = null;

export function setEnvsProvider(fn: () => Environments | null): void {
  envsProvider = fn;
}

/** Increment the started counter. Call once per process boot. */
export function recordStart(): void {
  counters.starts += 1;
  scheduleFlush();
}

/**
 * Increment a tool-call counter. Called from `withTelemetry` wrapper. The
 * `envId` is best-effort — if the wrapper couldn't resolve the env (envs
 * not loaded yet, or no `environment` arg + no last-used + no default), the
 * counter is bucketed under an unknown env and reassigned to the user's
 * default at flush time.
 */
export function recordToolCall(
  toolName: string,
  status: 'success' | 'error',
  envId: string | undefined
): void {
  const key = `${toolName}|${envId ?? '_unknown'}`;
  const entry = counters.toolCalls.get(key) || {
    toolName,
    envId,
    success: 0,
    error: 0,
  };
  entry[status] += 1;
  counters.toolCalls.set(key, entry);
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
  /** Auth tenant: this point is written via `<apiKey>/<envId>`. */
  envId: string | undefined;
  labels: Record<string, string>;
}

function snapshotPoints(): PendingPoint[] {
  const tier = process.env.LOG10X_TIER || 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const points: PendingPoint[] = [];
  for (const counter of counters.toolCalls.values()) {
    if (counter.success > 0) {
      points.push({
        metric: 'log10x_mcp_tool_call_total',
        timestamp: now,
        value: counter.success,
        envId: counter.envId,
        labels: { tool_name: counter.toolName, status: 'success', tier },
      });
    }
    if (counter.error > 0) {
      points.push({
        metric: 'log10x_mcp_tool_call_total',
        timestamp: now,
        value: counter.error,
        envId: counter.envId,
        labels: { tool_name: counter.toolName, status: 'error', tier },
      });
    }
  }
  if (counters.starts > 0) {
    // The "started" counter isn't tied to a specific env — the user just
    // booted their MCP. Tag it with no envId; flush routes it to the user's
    // default env (if writable).
    points.push({
      metric: 'log10x_mcp_started_total',
      timestamp: now,
      value: counters.starts,
      envId: undefined,
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
 * Group pending points by the env tenant they should be written to. Drops
 * any point whose target env is read-only (those writes would 403 at the
 * backend). Points with `envId === undefined` (e.g. `started_total`, or
 * tool calls captured before envs loaded) are routed to the user's default
 * env if it's writable.
 *
 * Returns a map keyed by env_id with each value containing the env's
 * EnvConfig (auth credentials) plus the points to send to that tenant.
 */
function groupPointsByWritableEnv(
  envs: Environments,
  points: PendingPoint[]
): Map<string, { env: EnvConfig; points: PendingPoint[] }> {
  const out = new Map<string, { env: EnvConfig; points: PendingPoint[] }>();
  for (const p of points) {
    const env = resolveTargetEnv(envs, p.envId);
    if (!env) continue; // unknown env_id — drop
    if (env.permissions === 'READ') continue; // can't write — drop silently
    const bucket = out.get(env.envId);
    if (bucket) {
      bucket.points.push(p);
    } else {
      out.set(env.envId, { env, points: [p] });
    }
  }
  return out;
}

function resolveTargetEnv(envs: Environments, envId: string | undefined): EnvConfig | null {
  if (envId) {
    const found = envs.all.find((e) => e.envId === envId);
    if (found) return found;
  }
  // Fall back to default env for points without an env tag (started_total,
  // or anything captured before envs were available).
  return envs.default ?? null;
}

/**
 * Push pending counters to the configured Prometheus remote_write endpoint.
 * Uses native protobuf + snappy. Each writable env gets its own POST with
 * `<apiKey>/<envId>` auth so the metric lands in that env's tenant.
 *
 * Counters are NOT reset on flush — they're cumulative for the lifetime
 * of this process; restart = counter reset (handled by PromQL rate()).
 */
export async function flush(): Promise<void> {
  if (flushInFlight) return;
  const writeUrl = process.env.LOG10X_TELEMETRY_URL || process.env.PROMETHEUS_REMOTE_WRITE_URL;
  if (!writeUrl) return;
  const envs = envsProvider?.();
  if (!envs) return; // env list not loaded yet — wait for next flush

  const points = snapshotPoints();
  if (points.length === 0) return;

  const grouped = groupPointsByWritableEnv(envs, points);
  if (grouped.size === 0) return; // every point's target env is read-only

  flushInFlight = true;
  try {
    for (const { env, points: envPoints } of grouped.values()) {
      try {
        const protobufBytes = encodeWriteRequest(envPoints);
        const compressed = snappy.compress(protobufBytes);
        await fetch(writeUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-protobuf',
            'Content-Encoding': 'snappy',
            'X-Prometheus-Remote-Write-Version': '0.1.0',
            'X-10X-Auth': `${env.apiKey}/${env.envId}`,
          },
          body: compressed as unknown as BodyInit,
        });
        // Counters are cumulative — do NOT reset on success.
      } catch {
        // Per-env failure is silent. Counters keep their cumulative values;
        // the next flush will retry with the new totals.
      }
    }
  } finally {
    flushInFlight = false;
  }
}

/**
 * Wrap a tool handler so every call is counted. status='success' on
 * resolve, 'error' on throw.
 *
 * Resolves the env the tool acted on by inspecting the first arg's
 * `environment` field (the standard arg the rest of the codebase uses to
 * pick an env per call), falling back to last-used / default if absent.
 * The resolution is best-effort — never throws into the handler path. If
 * envs aren't available yet (boot race), the call is bucketed with
 * `envId=undefined` and routed to the default env at flush time.
 */
export function withTelemetry<H extends (...args: any[]) => Promise<any>>(toolName: string, handler: H): H {
  const wrapped = async (...args: any[]) => {
    let status: 'success' | 'error' = 'success';
    let envId: string | undefined;
    try {
      const envs = envsProvider?.() ?? null;
      if (envs) {
        const nicknameArg = (args[0] as { environment?: string } | undefined)?.environment;
        if (nicknameArg) {
          const env = envs.byNickname.get(nicknameArg.toLowerCase());
          if (env) envId = env.envId;
        }
        // Match resolveEnv's chain (without mutating envs.lastUsed):
        // explicit nickname → last-used → default.
        if (!envId) {
          envId = envs.lastUsed?.envId ?? envs.default?.envId;
        }
      }
    } catch {
      /* never throw from telemetry env resolution */
    }
    try {
      return await handler(...args);
    } catch (err) {
      status = 'error';
      throw err;
    } finally {
      try {
        recordToolCall(toolName, status, envId);
      } catch {
        /* never throw from finally */
      }
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
