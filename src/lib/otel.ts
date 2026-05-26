/**
 * W3C trace-context propagation for the MCP via OTel SDK.
 *
 * Pattern matches Grafana's mcp-grafana (tools.go:230-243, 417-438):
 *   1. Extract `traceparent` from request._meta when the MCP host passes it
 *      so tool spans become children of the agent's trace. End-to-end one
 *      unified trace from the user prompt down through the tool call.
 *   2. Start a span per tool dispatch with semconv attributes
 *      (`gen_ai.tool.name`, `mcp.method.name`, plus our `gen_ai.system`).
 *   3. Defer span end + record errors via OTel semconv.
 *   4. Export via the operator's configured OTLP endpoint. We do not pin a
 *      target; we read standard OTel env vars
 *      (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME, etc.) so the MCP
 *      becomes a node in whatever observability pipeline the customer
 *      already runs.
 *
 * Zero-config behavior: if `OTEL_EXPORTER_OTLP_ENDPOINT` is not set, this
 * module initializes nothing. Tool dispatches still call into the
 * propagator helpers; they short-circuit to no-ops. No performance cost.
 *
 * Why a separate file: keeps the OTel SDK init out of the hot path of
 * src/index.ts. The SDK pulls in ~3 MB of code that we want lazy-loaded
 * only when actually exporting.
 */

import { trace, context, propagation, type Span, SpanKind, SpanStatusCode } from '@opentelemetry/api';

/** Re-export the OTel Span type under a stable name so callers don't depend on the SDK package path. */
export type OtelSpan = Span;

let initialized = false;
let initAttempted = false;
let tracer: ReturnType<typeof trace.getTracer> | null = null;

const TRACER_NAME = 'log10x-mcp';
const TRACER_VERSION = '1.0';

/**
 * Initialize the OTel SDK if the operator has configured an OTLP endpoint.
 * Idempotent. Safe to call multiple times. Returns true when OTel is
 * active for the rest of the process.
 *
 * Reads (all standard OTel env vars; no Log10x-specific config):
 *   OTEL_EXPORTER_OTLP_ENDPOINT  — required to enable
 *   OTEL_SERVICE_NAME            — defaults to "log10x-mcp"
 *   OTEL_RESOURCE_ATTRIBUTES     — free-form; honored by the SDK natively
 */
export async function initOtel(): Promise<boolean> {
  if (initAttempted) return initialized;
  initAttempted = true;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || endpoint.trim().length === 0) {
    return false;
  }
  try {
    // Dynamic import keeps the ~3MB SDK out of the cold-start path on the
    // common no-OTel case.
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter(),
      resource: resourceFromAttributes({
        'service.name': process.env.OTEL_SERVICE_NAME || 'log10x-mcp',
      }),
    });
    sdk.start();
    tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
    initialized = true;
    process.on('SIGTERM', () => { sdk.shutdown().catch(() => {}); });
    return true;
  } catch (e) {
    // OTel init failure must NOT take down the MCP. Log to stderr and
    // continue without tracing.
    process.stderr.write(`[log10x-mcp] OTel init failed: ${(e as Error).message}\n`);
    return false;
  }
}

/**
 * Start a span for a tool call. `extra` is the SDK's RequestHandlerExtra,
 * carrying optional `_meta.traceparent` from the caller.
 *
 * Returns the span (or null if OTel isn't initialized). The caller must
 * call `endToolSpan(span, ...)` once the tool finishes.
 *
 * When _meta.traceparent is present, we extract the parent context and the
 * new span becomes a child of the caller's trace — same end-to-end trace
 * that started at the user prompt.
 */
export function startToolSpan(
  toolName: string,
  extra: { _meta?: Record<string, unknown>; sessionId?: string; requestId?: string | number } | undefined
): Span | null {
  if (!initialized || !tracer) return null;
  // Extract any caller-supplied W3C trace context.
  let parentCtx = context.active();
  const traceparent = extra?._meta?.['traceparent'];
  if (typeof traceparent === 'string' && traceparent.length > 0) {
    const tracestate = extra?._meta?.['tracestate'];
    const carrier: Record<string, string> = { traceparent };
    if (typeof tracestate === 'string') carrier['tracestate'] = tracestate;
    parentCtx = propagation.extract(parentCtx, carrier);
  }
  const span = tracer.startSpan(
    `mcp.tool.${toolName}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        'gen_ai.system': 'log10x',
        'gen_ai.tool.name': toolName,
        'mcp.method.name': 'tools/call',
        ...(extra?.sessionId ? { 'mcp.session.id': String(extra.sessionId) } : {}),
        ...(extra?.requestId !== undefined ? { 'mcp.request.id': String(extra.requestId) } : {}),
      },
    },
    parentCtx
  );
  return span;
}

/**
 * Close a tool span. `outcome` lets us record the standard outcome
 * attributes per OTel semconv. On error: also record the exception and
 * set status=ERROR so the trace UI flags it.
 */
export function endToolSpan(
  span: Span | null,
  outcome: { ok: true; durationMs: number } | { ok: false; durationMs: number; error: unknown }
): void {
  if (!span) return;
  span.setAttribute('mcp.tool.duration_ms', outcome.durationMs);
  if (outcome.ok) {
    span.setStatus({ code: SpanStatusCode.OK });
  } else {
    const err = outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message.slice(0, 240) });
    span.setAttribute('error.type', err.name);
  }
  span.end();
}

export function isOtelInitialized(): boolean {
  return initialized;
}
