/**
 * TSDB destination emitters for log10x_backfill_metric.
 *
 * The MVP supports Datadog (api.datadoghq.com /api/v2/series) out of the
 * box because it needs only a public API key. Prometheus remote_write,
 * CloudWatch, Elastic, and SignalFx are wired as stub destinations that
 * return a clear "not yet implemented" error at runtime — the caller
 * sees exactly which destinations work today without the tool silently
 * dropping the call.
 *
 * Destination selection is driven entirely by environment variables set
 * on the MCP server process, matching the Log10x convention of "no
 * secrets in tool input". The model never gets the API key.
 */

import type { MetricPoint } from './aggregator.js';
import { resolveBackend } from './customer-metrics.js';

export type Destination = 'datadog' | 'prometheus' | 'cloudwatch' | 'elastic' | 'signalfx';

export interface EmitOptions {
  destination: Destination;
  metricName: string;
  /** Ms since epoch of the earliest point in the series — used for warning on backdated-ingestion limits. */
  earliestTimestampMs?: number;
  /** Extra destination-specific configuration passed through. */
  config?: Record<string, unknown>;
  /** Tags to apply to every point (union with the per-point labels). */
  staticTags?: Record<string, string>;
}

export interface EmitResult {
  destination: Destination;
  pointsEmitted: number;
  bytesPosted: number;
  wallTimeMs: number;
  warnings: string[];
  /** Best-effort URL to view the metric in the destination UI. Optional. */
  viewUrl?: string;
}

/**
 * Emit a pre-aggregated series to the configured destination.
 *
 * Throws if the destination is not supported or if credentials are
 * missing. The backfill_metric tool catches and surfaces the error to
 * the user.
 */
export async function emitSeries(
  points: MetricPoint[],
  options: EmitOptions
): Promise<EmitResult> {
  switch (options.destination) {
    case 'datadog':
      return emitDatadog(points, options);
    case 'prometheus':
      return emitPrometheus(points, options);
    case 'cloudwatch':
    case 'elastic':
    case 'signalfx':
      throw new Error(
        `Destination "${options.destination}" is not yet implemented in this MCP build. ` +
          `Supported today: datadog, prometheus (remote_write). ` +
          `Track the follow-up at https://github.com/log-10x/log10x-mcp/issues.`
      );
  }
}

// ── Datadog ──

async function emitDatadog(points: MetricPoint[], options: EmitOptions): Promise<EmitResult> {
  const apiKey = process.env.DATADOG_API_KEY || process.env.DD_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Datadog emission requires DATADOG_API_KEY (or DD_API_KEY) to be set on the MCP server. ' +
        'Generate an API key in Datadog: Organization Settings → API Keys.'
    );
  }
  // Accept DD_SITE and DATADOG_SITE interchangeably, matching Datadog's
  // own CLI / SDK behavior. Previously only DATADOG_SITE was read, which
  // produced a silent wrong-region bug when a user had only DD_SITE set.
  const site = process.env.DD_SITE || process.env.DATADOG_SITE || 'datadoghq.com';
  const endpoint = `https://api.${site}/api/v2/series`;

  // Check backdated ingestion window — Datadog /api/v2/series has a hard
  // limit of 1 hour in the past by default, but many accounts extend to
  // 24 hours. Older timestamps will be silently rejected — warn if we
  // detect that the series extends beyond 24 hours.
  const warnings: string[] = [];
  const now = Date.now();
  const oldest = options.earliestTimestampMs ?? (points[0]?.timestamp ? points[0].timestamp * 1000 : now);
  const ageHours = (now - oldest) / 3_600_000;
  if (ageHours > 1) {
    warnings.push(
      `Datadog /api/v2/series accepts metric points up to ~1 hour in the past by default. ` +
        `The oldest point in this backfill is ${ageHours.toFixed(1)}h old. ` +
        `For deeper history, the account needs the extended backdated-ingestion window enabled, ` +
        `or the tool should split the emission across a metric-stream path. ` +
        `Datadog may silently drop points older than the window.`
    );
  }

  // Datadog /api/v2/series body shape
  // type: 0=unspecified, 1=count, 2=rate, 3=gauge
  const datadogType = guessDatadogType(options);
  // Chunk to avoid oversized bodies — Datadog recommends < 5MB per POST.
  const CHUNK = 500;
  const staticTags = tagsToArray(options.staticTags || {});
  const chunks: MetricPoint[][] = [];
  for (let i = 0; i < points.length; i += CHUNK) {
    chunks.push(points.slice(i, i + CHUNK));
  }

  let bytesPosted = 0;
  const started = Date.now();

  for (const chunk of chunks) {
    const body = {
      series: chunk.map((p) => ({
        metric: options.metricName,
        type: datadogType,
        points: [{ timestamp: p.timestamp, value: p.value }],
        tags: [...staticTags, ...tagsToArray(p.labels)],
        resources: [{ type: 'host', name: 'log10x-backfill' }],
      })),
    };
    const payload = JSON.stringify(body);
    bytesPosted += Buffer.byteLength(payload, 'utf8');

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': apiKey,
      },
      body: payload,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Datadog /api/v2/series HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }
  }

  return {
    destination: 'datadog',
    pointsEmitted: points.length,
    bytesPosted,
    wallTimeMs: Date.now() - started,
    warnings,
    viewUrl: `https://app.${site}/metric/explorer?expression=${encodeURIComponent(options.metricName)}`,
  };
}

// ── Prometheus remote_write ──

async function emitPrometheus(points: MetricPoint[], options: EmitOptions): Promise<EmitResult> {
  // Priority:
  //   1. Explicit PROMETHEUS_REMOTE_WRITE_URL (operator override).
  //   2. Derived from the already-resolved customer-metrics backend.
  //      Managed backends (Grafana Cloud, AMP, generic Prometheus with the
  //      remote-write receiver) expose a sibling write path alongside the
  //      read URL — forcing users to configure the URL twice is pure
  //      friction. Datadog + GMP return undefined here; those cases still
  //      need the explicit env.
  let url = process.env.PROMETHEUS_REMOTE_WRITE_URL;
  let urlSource = 'PROMETHEUS_REMOTE_WRITE_URL';
  if (!url) {
    try {
      const resolution = await resolveBackend();
      const derived = resolution.backend?.remoteWriteUrl();
      if (derived) {
        url = derived;
        urlSource = `derived from ${resolution.backend!.backendType} read endpoint`;
      }
    } catch {
      // Backend resolution errors (malformed explicit config) shouldn't
      // mask the primary "no remote-write URL" error. Fall through.
    }
  }
  if (!url) {
    throw new Error(
      'Prometheus remote_write emission requires a write URL. Set PROMETHEUS_REMOTE_WRITE_URL explicitly, or ' +
        'configure a customer-metrics backend whose read endpoint exposes a sibling write path (Grafana Cloud, AMP, ' +
        'self-hosted Prometheus with --web.enable-remote-write-receiver). Datadog and GCP Managed Prometheus do not ' +
        'support Prometheus remote_write and need a different destination.'
    );
  }
  void urlSource;

  // Stub: the MVP path writes JSON to an adapter endpoint rather than the
  // protobuf-Snappy binary remote_write wire format. Callers who want real
  // Prometheus ingestion should route via a small adapter Lambda until the
  // MCP ships the protobuf encoder. We surface this loudly instead of
  // silently failing.
  const warnings: string[] = [
    `Prometheus remote_write URL source: ${urlSource}. ` +
      'This build posts JSON to the configured URL and relies on an adapter ' +
      '(prometheus-remote-write-adapter, AMP sigv4-proxy) to translate to the protobuf/Snappy wire format. ' +
      'If the target accepts only native remote_write, set PROMETHEUS_REMOTE_WRITE_URL to an adapter endpoint.',
  ];

  const body = {
    metric: options.metricName,
    points: points.map((p) => ({
      timestamp: p.timestamp,
      value: p.value,
      labels: { ...(options.staticTags || {}), ...p.labels },
    })),
  };
  const payload = JSON.stringify(body);
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Prometheus adapter HTTP ${res.status}: ${errText.slice(0, 500)}`);
  }

  return {
    destination: 'prometheus',
    pointsEmitted: points.length,
    bytesPosted: Buffer.byteLength(payload, 'utf8'),
    wallTimeMs: Date.now() - started,
    warnings,
  };
}

// ── helpers ──

function tagsToArray(labels: Record<string, string>): string[] {
  return Object.entries(labels)
    .filter(([, v]) => v !== '' && v !== undefined && v !== null)
    .map(([k, v]) => `${k}:${v}`);
}

function guessDatadogType(options: EmitOptions): number {
  // Pull the caller-declared type if provided.
  const explicit = (options.config?.datadog_type as number | undefined);
  if (explicit !== undefined) return explicit;
  // Default: gauge (3) works for most backfills; callers can override.
  return 3;
}
