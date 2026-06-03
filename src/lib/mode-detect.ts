/**
 * Mode detection at server boot.
 *
 * log10x-mcp targets two distinct user states:
 *
 *   - **Analysis mode**: a deployed log10x environment exists. The
 *     TSDB resolves (Grafana Cloud, AMP, GCP Managed, Datadog Prom,
 *     self-hosted Prometheus, or 10x Cloud) AND `tenx_pattern_bytes_total`
 *     series are present. The full analysis catalog (top_patterns,
 *     find_*, pattern_mitigate, dependency_check, etc.) is meaningful.
 *
 *   - **POC mode**: no TSDB resolves. The user is a prospect with no
 *     log10x deployment yet. Only POC tools + install advisors make
 *     sense; analysis tools would 5xx on every call.
 *
 *   - **Analysis-pending mode**: TSDB resolves but zero `tenx_*` series
 *     yet. Fresh deploy: nothing has been scraped yet (or the engine
 *     was just installed and hasn't emitted metrics). Register analysis
 *     tools AND install advisors together so the user has the
 *     onboarding affordance alongside the still-empty analysis surface.
 *
 * The mode is **fixed at boot**. If the user later configures a
 * backend, restarting the MCP picks it up. There is no runtime toggle
 * and no CLI flag.
 *
 * Why this lives in its own module (not inline in `src/index.ts`):
 *   - testable in isolation
 *   - reusable by `log10x_doctor` for diagnostic output
 *   - keeps the `main()` boot path readable
 */

import type { CustomerMetricsBackend } from './customer-metrics.js';
import { resolveBackend, formatDetectionTrace } from './customer-metrics.js';

export type Mode = 'analysis' | 'analysis_pending' | 'poc';

export interface ModeResolution {
  mode: Mode;
  /** Backend handle, present in analysis + analysis_pending modes only. */
  backend?: CustomerMetricsBackend;
  /** Which detection path matched, when applicable. */
  detectionPath?: string;
  /** Detection-cascade trace for the doctor / debug surface. */
  trace: Array<{ path: string; status: string; reason: string }>;
  /** Human-readable one-liner explaining why this mode was chosen. */
  reason: string;
  /** Wall-clock duration of the probe in milliseconds. */
  probeDurationMs: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/** PromQL probe asking "how many distinct tenx_pattern_bytes_total series exist right now?" */
const TENX_SERIES_PROBE = 'count(count by (__name__)(tenx_pattern_bytes_total))';

/**
 * Detect the operating mode for this MCP boot.
 *
 * The probe budget is bounded (default 5s) so a slow / flaky backend
 * does not block startup. On probe timeout, we optimistically land in
 * `analysis` mode and let individual tool calls surface real-time
 * "backend not reachable" errors with clear remediation. The
 * alternative (falling to POC mode on timeout) would hide a real
 * backend from users with transient network blips.
 */
export async function detectMode(opts?: {
  probeTimeoutMs?: number;
}): Promise<ModeResolution> {
  const probeTimeoutMs = opts?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const startedAt = Date.now();

  // Operator / harness override. When set to a valid Mode value, skip
  // the probe entirely and use the forced mode. Intended for the eval
  // harness's stdio-transport tests (which need to register install
  // advisors against the demo env's `analysis`-mode backend) and for
  // debugging the registration cascade without running a real probe.
  const forced = process.env.LOG10X_MCP_FORCE_MODE;
  if (forced === 'analysis' || forced === 'analysis_pending' || forced === 'poc') {
    return {
      mode: forced,
      trace: [{ path: 'forced_mode_env', status: 'matched', reason: `LOG10X_MCP_FORCE_MODE=${forced}` }],
      reason: `Mode forced via LOG10X_MCP_FORCE_MODE=${forced}; backend probe skipped.`,
      probeDurationMs: Date.now() - startedAt,
    };
  }

  // Step 1: resolve a backend (or not). Cheap, no network calls
  // beyond the existing customer-metrics autodetect (which can hit
  // AWS / GCP CLIs but each has its own timeout).
  let resolution;
  try {
    resolution = await resolveBackend();
  } catch (e) {
    // Explicit `LOG10X_CUSTOMER_METRICS_URL` was set but malformed,
    // OR the user typed an invalid LOG10X_CUSTOMER_METRICS_TYPE. The
    // existing `resolveBackend()` chooses to throw rather than
    // silently fall through. We honor that: surface the error as
    // POC mode with a clear reason, so the user sees the config bug
    // in `doctor` output.
    return {
      mode: 'poc',
      trace: [],
      reason: `TSDB resolution threw: ${(e as Error).message}. Falling to POC mode; fix the config and restart.`,
      probeDurationMs: Date.now() - startedAt,
    };
  }

  if (!resolution.backend) {
    return {
      mode: 'poc',
      trace: resolution.trace,
      reason: 'No TSDB backend resolvable from env. Prospect mode (POC + install advisors only).',
      probeDurationMs: Date.now() - startedAt,
    };
  }

  // Step 2: probe for live tenx_* series presence. Bounded by
  // `probeTimeoutMs`. Three outcomes: count > 0 (analysis), count === 0
  // (analysis_pending), timeout (analysis optimistically).
  const probeResult = await probeTenxSeriesCount(
    resolution.backend,
    probeTimeoutMs
  );

  if (probeResult.outcome === 'timeout') {
    return {
      mode: 'analysis',
      backend: resolution.backend,
      detectionPath: resolution.detectionPath,
      trace: resolution.trace,
      reason: `TSDB resolved (${resolution.detectionPath}) but tenx_* series probe timed out after ${probeTimeoutMs}ms. Registering analysis tools optimistically; individual tool errors will surface backend issues with clear remediation.`,
      probeDurationMs: Date.now() - startedAt,
    };
  }

  if (probeResult.outcome === 'error') {
    return {
      mode: 'analysis',
      backend: resolution.backend,
      detectionPath: resolution.detectionPath,
      trace: resolution.trace,
      reason: `TSDB resolved (${resolution.detectionPath}) but probe query failed (${probeResult.error}). Registering analysis tools optimistically.`,
      probeDurationMs: Date.now() - startedAt,
    };
  }

  if (probeResult.seriesCount === 0) {
    return {
      mode: 'analysis_pending',
      backend: resolution.backend,
      detectionPath: resolution.detectionPath,
      trace: resolution.trace,
      reason: `TSDB resolved (${resolution.detectionPath}) but zero tenx_pattern_bytes_total series. Fresh deploy: analysis + install advisors both enabled.`,
      probeDurationMs: Date.now() - startedAt,
    };
  }

  return {
    mode: 'analysis',
    backend: resolution.backend,
    detectionPath: resolution.detectionPath,
    trace: resolution.trace,
    reason: `TSDB resolved (${resolution.detectionPath}); ${probeResult.seriesCount} tenx_* series active. Analysis mode.`,
    probeDurationMs: Date.now() - startedAt,
  };
}

type ProbeResult =
  | { outcome: 'ok'; seriesCount: number }
  | { outcome: 'timeout' }
  | { outcome: 'error'; error: string };

async function probeTenxSeriesCount(
  backend: CustomerMetricsBackend,
  timeoutMs: number
): Promise<ProbeResult> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<ProbeResult>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ outcome: 'timeout' }), timeoutMs);
  });
  const probePromise: Promise<ProbeResult> = (async () => {
    try {
      const r = await backend.queryInstant(TENX_SERIES_PROBE);
      const series = r?.data?.result;
      if (!Array.isArray(series) || series.length === 0) {
        return { outcome: 'ok', seriesCount: 0 };
      }
      const first = series[0] as { value?: [number, string] };
      const rawValue = first.value?.[1] ?? '0';
      const parsed = parseFloat(String(rawValue));
      const seriesCount = Number.isFinite(parsed) ? Math.floor(parsed) : 0;
      return { outcome: 'ok', seriesCount };
    } catch (e) {
      return { outcome: 'error', error: (e as Error).message };
    }
  })();
  const winner = await Promise.race([probePromise, timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  return winner;
}

/**
 * Tool-set membership per mode. Source of truth for which tools the
 * MCP registers in each mode. Used by `src/index.ts` boot to gate
 * `registerLog10xTool` calls.
 *
 * "Always" tools register in every mode (auth, doctor, env discovery).
 * "Analysis" tools require a TSDB and meaningful pattern data;
 * skipped in POC mode but kept in analysis_pending.
 * "Install" tools (advisors, configure_*) register in POC mode and
 * analysis_pending mode (fresh deploy). Hidden in steady-state
 * analysis mode where they would be noise.
 * "POC" tools (`log10x_poc_*`) register in POC mode only.
 */
export const TOOL_MODES: Record<string, ('analysis' | 'analysis_pending' | 'poc' | 'always')[]> = {
  // ── Always (auth, discovery, doctor) ──
  log10x_login_status: ['always'],
  log10x_signin_start: ['always'],
  log10x_signin_complete: ['always'],
  log10x_signout: ['always'],
  log10x_update_settings: ['always'],
  log10x_rotate_api_key: ['always'],
  log10x_create_env: ['always'],
  log10x_update_env: ['always'],
  log10x_delete_env: ['always'],
  log10x_configure_env: ['always'],
  log10x_doctor: ['always'],
  log10x_discover_env: ['always'],

  // ── Analysis (default-loaded 11) ──
  log10x_top_patterns: ['analysis', 'analysis_pending'],
  log10x_pattern_examples: ['analysis', 'analysis_pending'],
  log10x_pattern_trend: ['analysis', 'analysis_pending'],
  log10x_event_lookup: ['analysis', 'analysis_pending'],
  log10x_find_skew: ['analysis', 'analysis_pending'],
  log10x_measure_compaction: ['analysis', 'analysis_pending', 'poc'], // local CLI + SIEM, no TSDB needed
  log10x_pattern_mitigate: ['analysis', 'analysis_pending'],
  log10x_dependency_check: ['analysis', 'analysis_pending'],
  log10x_metrics_that_moved: ['analysis', 'analysis_pending'],
  log10x_rank_by_shape_similarity: ['analysis', 'analysis_pending'],
  log10x_metric_overlay: ['analysis', 'analysis_pending'],

  // ── Analysis (secondary / primitive / utility) ──
  log10x_pattern_mitigate_legacy: ['analysis', 'analysis_pending'], // alias if any
  log10x_savings: ['analysis', 'analysis_pending'],
  log10x_investigate: ['analysis', 'analysis_pending'],
  log10x_services: ['analysis', 'analysis_pending'],
  log10x_overflow_contents: ['analysis', 'analysis_pending'],
  log10x_discover_labels: ['analysis', 'analysis_pending'],
  log10x_discover_join: ['analysis', 'analysis_pending'],
  log10x_customer_metrics_query: ['analysis', 'analysis_pending'],
  log10x_resolve_batch: ['analysis', 'analysis_pending', 'poc'], // local-only, no TSDB needed
  log10x_extract_templates: ['analysis', 'analysis_pending', 'poc'], // local-only, no TSDB needed
  log10x_retriever_query: ['analysis', 'analysis_pending'],
  log10x_retriever_series: ['analysis', 'analysis_pending'],
  log10x_backfill_metric: ['analysis', 'analysis_pending'],

  // ── Install advisors (POC + analysis_pending) ──
  log10x_advise_install: ['poc', 'analysis_pending'],
  log10x_advise_retriever: ['poc', 'analysis_pending'],
  log10x_configure_engine: ['poc', 'analysis_pending', 'analysis'],
  log10x_estimate_savings: ['analysis', 'analysis_pending'],
  log10x_baseline: ['analysis', 'analysis_pending'],
  log10x_commitment_report: ['analysis', 'analysis_pending'],

  // ── POC (prospect-only) ──
  log10x_poc_from_siem_submit: ['poc'],
  log10x_poc_from_siem_status: ['poc'],
  log10x_poc_from_local: ['poc'],
};

/**
 * Should this tool register in the given mode?
 */
export function shouldRegisterTool(toolName: string, mode: Mode): boolean {
  const modes = TOOL_MODES[toolName];
  if (!modes) {
    // Unknown tool: register defensively in analysis mode, skip in others.
    // Logs a warning at boot so the entry can be added to TOOL_MODES.
    return mode === 'analysis' || mode === 'analysis_pending';
  }
  if (modes.includes('always')) return true;
  return modes.includes(mode);
}

/** Human-readable mode summary for doctor / log output. */
export function formatModeResolution(res: ModeResolution): string {
  const lines = [
    `Mode: ${res.mode}`,
    `Reason: ${res.reason}`,
    `Probe duration: ${res.probeDurationMs}ms`,
  ];
  if (res.detectionPath) {
    lines.push(`Backend: ${res.detectionPath}`);
  }
  if (res.trace.length > 0) {
    lines.push(`Trace:`);
    // formatDetectionTrace expects the strict DetectionPath/status
    // union; our public ModeResolution.trace is a wider string-typed
    // shape so this module isolates callers from the customer-metrics
    // detection-path internals. Cast at the boundary.
    lines.push(formatDetectionTrace(res.trace as Parameters<typeof formatDetectionTrace>[0]));
  }
  return lines.join('\n');
}
