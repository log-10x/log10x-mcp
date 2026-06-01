/**
 * log10x_poc_from_siem — async MCP tool pair.
 *
 * The submit tool kicks off the pull + templatize + render pipeline in the
 * background and returns a `snapshot_id`. The status tool reports progress
 * and returns the final markdown once done.
 *
 * This mirrors the retriever_query / retriever_query_status async shape so
 * callers can track a long-running pull without blocking the MCP loop.
 */

import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';

import {
  getConnector,
  parseWindowMs,
  type SiemConnector,
  type PullEventsResult,
  type CredentialDiscovery,
  type SiemId as RegistrySiemId,
} from '../lib/siem/index.js';
import {
  resolveSiemSelection,
  formatAmbiguousError,
  formatNoneError,
} from '../lib/siem/resolve.js';
import type { SiemId } from '../lib/siem/pricing.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';
import type { PrimitiveError } from '../lib/primitive-errors.js';
import { SIEM_DISPLAY_NAMES, getAnalyzerCostForSiem } from '../lib/siem/pricing.js';
import { extractPatterns, collapseBySymbolMessage } from '../lib/pattern-extraction.js';
import {
  renderPocReport,
  renderPocSummary,
  renderPocYaml,
  renderPocConfigs,
  renderPocTop,
  renderPocPattern,
  type RenderInput,
} from '../lib/poc-report-renderer.js';
import { prettifyPatterns } from '../lib/ai-prettify.js';
import { readClientVersion } from '../lib/manifest.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkDeps, DEP_CHECK_VENDORS } from '../lib/siem/deps/index.js';
import { buildPocEnvelopeV2 } from '../lib/poc-envelope-v2.js';
import { _enrichForEnvelope } from '../lib/poc-report-renderer.js';
import { enrichWithHostAgent } from '../lib/poc-host-agent-enricher.js';

const MCP_VERSION = readClientVersion();

// ── Schemas ──

const SIEM_ENUM = [
  'cloudwatch',
  'datadog',
  'sumo',
  'gcp-logging',
  'elasticsearch',
  'azure-monitor',
  'splunk',
  'clickhouse',
] as const;

export const pocFromSiemSubmitSchema = {
  siem: z.enum(SIEM_ENUM).optional().describe(
    'Which SIEM to pull from. Omit to auto-detect from ambient credentials. Valid values: cloudwatch, datadog, sumo, gcp-logging, elasticsearch, azure-monitor, splunk, clickhouse.'
  ),
  window: z
    .string()
    .default('14d')
    .describe(
      'Window to pull over. Accepts "1h", "24h", "7d", "14d", "30d". Default "14d" — wide windows ' +
        'unlock the differentiated longitudinal signals (first-seen, growth, stable-vs-new) that the ' +
        'agent cannot compute from a small sample. Pull pacing is automatic; long windows take ' +
        'minutes but the snapshot continues in the background.'
    ),
  scope: z
    .string()
    .optional()
    .describe(
      'SIEM-specific resource scope. CloudWatch: log group name or wildcard (`/aws/ecs/*`). Datadog: index name. Sumo: `_sourceCategory`. GCP: project id. Elasticsearch: index pattern. Azure Monitor: workspace id. Splunk: index name. ClickHouse: database name.'
    ),
  query: z
    .string()
    .optional()
    .describe(
      'SIEM-native filter expression layered on top of `scope`. Syntax per SIEM (CloudWatch filter pattern; Datadog query; KQL for ES/Azure; SPL for Splunk; SQL WHERE for ClickHouse; Sumo query).'
    ),
  target_event_count: z
    .number()
    .min(1_000)
    .max(5_000_000)
    .default(1_000_000)
    .describe(
      'Target event count for the pull. Default 1,000,000 (~500 MB at 500B avg, tokenizes in 5-10 min). ' +
        'The pull self-terminates earlier on saturation — when new patterns per 100k events drops below ' +
        '2%, the long tail has been covered and the report is generated. This default is intentionally ' +
        'two orders of magnitude beyond what an unaided agent can fit in context.'
    ),
  max_pull_minutes: z
    .number()
    .min(1)
    .max(60)
    .default(30)
    .describe(
      'Hard cap on pull wall-time. Default 30. The pull stops at whichever of target_event_count, ' +
        'max_pull_minutes, or saturation-detected hits first. Long pulls run in the background; ' +
        'poll status while the user does other things.'
    ),
  analyzer_cost_per_gb: z
    .number()
    .positive()
    .optional()
    .describe('Override the $/GB rate for cost calculations. Default is read from vendors.json per detected SIEM.'),
  total_daily_gb: z
    .number()
    .positive()
    .optional()
    .describe(
      'Customer\'s total daily log volume in GB/day. Pick any one of total_daily_gb / total_monthly_gb / ' +
        'total_annual_gb — whichever unit the user naturally thinks in. The tool normalizes to daily ' +
        'internally. When any is provided (or auto_detect_volume succeeds), per-pattern costs are ' +
        'extrapolated from the pulled sample to the full volume, producing meaningful annual-savings ' +
        'figures instead of sub-cent numbers. Priority: daily > monthly > annual. If the pull was ' +
        'narrowed via `query` to one service, this overstates cost — only a fraction of daily volume ' +
        'matches the filter.'
    ),
  total_monthly_gb: z
    .number()
    .positive()
    .optional()
    .describe('Customer\'s total monthly log volume in GB/month. See total_daily_gb for semantics.'),
  total_annual_gb: z
    .number()
    .positive()
    .optional()
    .describe('Customer\'s total annual log volume in GB/year. See total_daily_gb for semantics.'),
  auto_detect_volume: z
    .boolean()
    .default(true)
    .describe(
      'Default true: when no total_*_gb arg is provided, probe the SIEM\'s usage/metrics API to ' +
        'auto-detect daily ingest volume. Per-SIEM best-effort: CloudWatch (describeLogGroups ÷ ' +
        'retention), Datadog (Usage API), Elasticsearch (_stats), Azure (Usage KQL table), GCP ' +
        '(Cloud Monitoring byte_count), ClickHouse (system.parts), Splunk (license API), Sumo ' +
        '(Account Usage API). Fails silently and falls back to scenario brackets if the current ' +
        'creds lack the required scope. Set false to skip the probe and go straight to manual args ' +
        'or scenarios.'
    ),
  ai_prettify: z
    .boolean()
    .default(true)
    .describe(
      'Default true: use MCP sampling to ask the host LLM (the same model the user is already ' +
        'chatting with — Claude Desktop, Claude Code, Cursor, etc.) to batch-generate 3-5-word ' +
        'human-readable names for the top patterns. No Log10x-side endpoint, no extra API key — ' +
        'the host uses whatever model + credentials the user already has. Sends only templated ' +
        'pattern identities (no variable values, no raw log content). Skipped automatically when ' +
        'the host does not advertise the `sampling` capability; the report falls back to raw ' +
        'snake_case identities plus a note. Set false to skip unconditionally.'
    ),
  enrich_with_host_agent: z
    .boolean()
    .default(true)
    .describe(
      'Default true: after the engine produces measured findings (per-pattern $/mo, growth, ' +
        'incident clusters), ask the MCP host LLM via sampling to contribute operational context ' +
        'the engine cannot see: kubectl events / deploys correlating with GROWING patterns, ' +
        'alert / dashboard dependencies before recommending mute, code-level root-cause refinement ' +
        'on code_fix patterns, and prioritization based on customer context. Single round-trip, ' +
        'capped at 8000 output tokens. Skipped automatically when the host does not advertise ' +
        'sampling; the v2 envelope still ships without enrichment. Contributions land in ' +
        'output.agent_enrichment.contributions with an audit trail (tools_inspected) so the ' +
        'customer sees what the agent says it looked at.'
    ),
  enrich_max_tokens: z
    .number()
    .int()
    .min(1000)
    .max(32000)
    .default(8000)
    .describe('Output token cap for the host-agent enrichment call. Default 8000.'),
  privacy_mode: z
    .boolean()
    .default(true)
    .describe(
      'Default true: templating runs through the locally-installed `tenx` CLI so events never leave the machine. ' +
        'Requires `tenx` to be installed (brew install log-10x/tap/log10x, or see https://doc.log10x.com/apps/dev/); ' +
        'the tool errors cleanly with an install hint otherwise. ' +
        'Set to false to route through the public Log10x paste endpoint instead — intended for demo use only, ' +
        'not production log content (raw events are sent to a shared public Lambda).'
    ),
  environment: z.string().optional().describe('Optional environment nickname — cosmetic only, for the report header.'),
  // ClickHouse-specific
  clickhouse_table: z.string().optional().describe('[ClickHouse] Required — table name holding log events.'),
  clickhouse_timestamp_column: z.string().optional().describe('[ClickHouse] Column holding the timestamp. Default auto-detected.'),
  clickhouse_message_column: z.string().optional().describe('[ClickHouse] Column holding the message body. Default auto-detected.'),
  clickhouse_service_column: z.string().optional().describe('[ClickHouse] Optional column for service name.'),
  clickhouse_severity_column: z.string().optional().describe('[ClickHouse] Optional column for severity.'),
};

export const pocFromSiemStatusSchema = {
  snapshot_id: z.string().describe('Snapshot id returned by log10x_poc_from_siem_submit.'),
  view: z
    .enum(['summary', 'full', 'yaml', 'configs', 'top', 'pattern', 'markdown'])
    .default('summary')
    .describe(
      "How to surface the report. Default `summary` returns the v2 structured envelope " +
        '(`data.result` carries the full JSON: input section with scale + methodology + ' +
        'coverage, output section with aggregates, incidents, per-pattern actions). ' +
        'The agent reads this directly and writes prose in its own voice — no rendered ' +
        'markdown is included in the summary path. Use `markdown` to receive the rendered ' +
        '9-section markdown report (legacy / human-readable surface). `yaml` returns ' +
        'paste-ready receiver mute-file entries; `configs` returns native SIEM exclusion ' +
        "configs; `top` returns an expanded N-row drivers markdown; `pattern` deep-dives " +
        "on one identity (requires `pattern` arg). `full` is kept as an alias for `markdown`."
    ),
  pattern: z
    .string()
    .optional()
    .describe('Required when view="pattern". The snake_case pattern identity to expand. Pass the raw identity as printed in prior views.'),
  top_n: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Number of rows for views that accept it (`top`, `yaml`, `configs`, `summary`). Defaults: summary=5, top=20, yaml/configs=5.'),
};

// ── Async state ──

type Status = 'pulling' | 'templatizing' | 'analyzing' | 'rendering' | 'complete' | 'failed';

interface Snapshot {
  id: string;
  status: Status;
  progressPct: number;
  stepDetail: string;
  partialPatternsFound?: number;
  /** Live counters surfaced during the pull so status polling shows real work. */
  partialEventsPulled?: number;
  partialBytesPulled?: number;
  /**
   * Saturation indicator computed across pull progress slices. Each
   * value is the number of distinct patterns newly observed in the
   * preceding ~100k events. When the trailing average drops below 2%
   * of the running pattern count for 3 consecutive slices, the
   * pipeline self-terminates the pull and proceeds to render — the
   * long tail has been covered.
   */
  partialNewPatternsByChunk?: number[];
  /** Reason the pull stopped: `target_reached`, `time_exhausted`, `saturation_reached`, `source_exhausted`. */
  partialStopReason?: string;
  startedAt: string; // ISO
  startedAtMs: number;
  finishedAt?: string;
  // Complete state
  reportMarkdown?: string;        // the `full` view; back-compat
  reportFilePath?: string;
  /**
   * The full RenderInput the report was built from. Stored so status
   * calls can render alternate views (`summary`, `yaml`, `configs`,
   * `top`, `pattern`) on the fly without re-running extraction.
   */
  renderInput?: RenderInput;
  summary?: RenderInput extends unknown ? ReturnType<typeof renderPocReport>['summary'] : never;
  // Failure state
  error?: string;
  partialReportMarkdown?: string;
  retryHint?: string;
  /**
   * Host-agent enrichment result, computed once at the end of
   * runPipeline. Read by the status path when building the v2
   * envelope so we don't re-call the host LLM on every status poll.
   */
  hostAgentEnrichment?: import('../lib/poc-host-agent-enricher.js').AgentEnrichmentResult;
}

const SNAPSHOTS = new Map<string, Snapshot>();

// Max retained snapshots — prevent long-lived servers from leaking memory.
const MAX_RETAINED = 50;

function retain(s: Snapshot): void {
  SNAPSHOTS.set(s.id, s);
  if (SNAPSHOTS.size > MAX_RETAINED) {
    // Evict oldest completed/failed — keep in-progress entries.
    const candidates = [...SNAPSHOTS.values()]
      .filter((x) => x.status === 'complete' || x.status === 'failed')
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
    const toEvict = candidates.slice(0, SNAPSHOTS.size - MAX_RETAINED);
    for (const c of toEvict) SNAPSHOTS.delete(c.id);
  }
}

// ── Submit ──

export interface PocSubmitArgs {
  siem?: (typeof SIEM_ENUM)[number];
  window: string;
  scope?: string;
  query?: string;
  target_event_count: number;
  max_pull_minutes: number;
  analyzer_cost_per_gb?: number;
  total_daily_gb?: number;
  total_monthly_gb?: number;
  total_annual_gb?: number;
  auto_detect_volume?: boolean;
  ai_prettify: boolean;
  enrich_with_host_agent?: boolean;
  enrich_max_tokens?: number;
  privacy_mode: boolean;
  environment?: string;
  clickhouse_table?: string;
  clickhouse_timestamp_column?: string;
  clickhouse_message_column?: string;
  clickhouse_service_column?: string;
  clickhouse_severity_column?: string;
  /**
   * Optional MCP server handle — wired by index.ts at registration time.
   * Used ONLY by the AI-prettify path (MCP sampling via createMessage).
   * When absent, prettify skips with a clear note in the report appendix;
   * the report still renders with raw identities.
   */
  _mcpServer?: McpServer;
}

export async function executePocSubmit(args: PocSubmitArgs): Promise<import('../lib/output-types.js').StructuredOutput> {
  const { buildEnvelope: __be, buildMarkdownEnvelope: __bme } = await import('../lib/output-types.js');
  const telemetry = newTelemetry();
  // Tool-level view fallback for callers passing { view } at the registration level.
  // The submit schema doesn't declare `view`, so we accept it as an extra field on args.
  const view = (args as unknown as { view?: 'summary' | 'markdown' }).view ?? 'summary';
  let md: string;
  try {
    md = await executePocSubmitInner(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err: PrimitiveError = {
      error_type: /No.*SIEM|none/i.test(msg) ? 'input_invalid' : /ambiguous/i.test(msg) ? 'input_invalid' : 'local_processing_failed',
      retryable: false,
      suggested_backoff_ms: null,
      hint: msg.slice(0, 400),
    };
    return __be({
      tool: 'log10x_poc_from_siem_submit',
      view: 'summary',
      summary: { headline: `POC submit failed: ${err.error_type}` },
      data: {
        ok: false,
        window: args.window,
        scope: args.scope,
        query: args.query,
        ...buildUnifiedFields({ status: 'error', telemetry, humanSummary: `POC submit failed: ${err.hint}`, error: err }),
      },
    });
  }
  const sidMatch = md.match(/snapshot_id\*\*: `(.+?)`/);
  const siemMatch = md.match(/siem_detected\*\*: (\S+)/);
  const durMatch = md.match(/estimated_duration_minutes\*\*: (\d+)/);
  if (view === 'markdown') {
    return __bme({ tool: 'log10x_poc_from_siem_submit', summary: { headline: `POC submitted${sidMatch ? ` (snapshot_id ${sidMatch[1]})` : ''}` }, markdown: md });
  }
  const headline = `POC submit accepted${siemMatch ? ` for ${siemMatch[1]}` : ''}${sidMatch ? ` (snapshot_id ${sidMatch[1]})` : ''}; estimated ${durMatch?.[1] ?? '?'} min. Poll log10x_poc_from_siem_status.`;
  return __be({
    tool: 'log10x_poc_from_siem_submit',
    view: 'summary',
    summary: { headline },
    data: {
      ok: true,
      snapshot_id: sidMatch?.[1],
      siem_detected: siemMatch?.[1],
      estimated_duration_minutes: durMatch ? Number(durMatch[1]) : undefined,
      window: args.window,
      scope: args.scope,
      query: args.query,
      target_event_count: args.target_event_count,
      max_pull_minutes: args.max_pull_minutes,
      ...buildUnifiedFields({ status: 'success', telemetry, humanSummary: headline }),
    },
    actions: sidMatch ? [{ tool: 'log10x_poc_from_siem_status', args: { snapshot_id: sidMatch[1] }, reason: 'poll POC progress; phases: pulling -> templatizing -> rendering -> complete' }] : [],
  });
}

async function executePocSubmitInner(args: PocSubmitArgs): Promise<string> {
  // ── Resolve the connector ──
  const resolution = await resolveSiemSelection({ explicit: args.siem });
  if (resolution.kind === 'none') {
    throw new Error(
      formatNoneError(resolution.probedIds, 'Run `log10x_doctor` for per-SIEM discovery detail.')
    );
  }
  if (resolution.kind === 'ambiguous') {
    throw new Error(formatAmbiguousError(resolution.candidates, 'siem'));
  }
  const connector: SiemConnector = getConnector(resolution.id);
  const siemDetectedNote = resolution.note ?? '';

  // ── Build snapshot ──
  const snapshot: Snapshot = {
    id: randomUUID(),
    status: 'pulling',
    progressPct: 0,
    stepDetail: 'initializing',
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
  };
  retain(snapshot);

  // Fire and forget — the background worker updates the snapshot in place.
  runPipeline(connector, snapshot, args).catch((e) => {
    snapshot.status = 'failed';
    snapshot.error = (e as Error).message;
    snapshot.finishedAt = new Date().toISOString();
  });

  const windowMs = parseWindowMs(args.window);
  const estimatedDuration = Math.min(args.max_pull_minutes, Math.max(2, Math.round(windowMs / (3600 * 1000) / 2)));
  const planParts = [
    `Pulling up to ${args.target_event_count.toLocaleString()} events from ${SIEM_DISPLAY_NAMES[connector.id]} over the last ${args.window}.`,
  ];
  if (args.scope) planParts.push(`Scope: \`${args.scope}\`.`);
  if (args.query) planParts.push(`Query: \`${args.query}\`.`);
  if (siemDetectedNote) planParts.push(siemDetectedNote);

  const out = [
    '## Log10x POC — submit accepted',
    '',
    `**snapshot_id**: \`${snapshot.id}\``,
    `**siem_detected**: ${connector.id}`,
    `**estimated_duration_minutes**: ${estimatedDuration}`,
    '',
    planParts.join(' '),
    '',
    '### Phases',
    '',
    `1. \`pulling\` — fetching events from ${SIEM_DISPLAY_NAMES[connector.id]} (typical 1-3 min)`,
    `2. \`templatizing\` — extracting patterns from the sample (typical 3-8 min depending on event count)`,
    `3. \`rendering\` — building the final report (<5s)`,
    `4. \`complete\` — full report available; call status with \`view: "summary"\` (default), \`"yaml"\`, \`"configs"\`, \`"top"\`, or \`"pattern"\`.`,
    '',
    '### Polling',
    '',
    `Call \`log10x_poc_from_siem_status({snapshot_id: "${snapshot.id}"})\` every ~30s while the pipeline runs.`,
    `During \`templatizing\`, the snapshot exposes \`partialPatternsFound\` — when that number stabilizes, the templater is winding down and the report is close to ready.`,
    `Hard ceiling on pull time: ${args.max_pull_minutes} min (per the submit \`max_pull_minutes\` arg).`,
  ].join('\n');

  return out;
}

// ── Status ──

export interface PocStatusArgs {
  snapshot_id: string;
  view?: 'summary' | 'full' | 'yaml' | 'configs' | 'top' | 'pattern';
  pattern?: string;
  top_n?: number;
}

export async function executePocStatus(args: PocStatusArgs): Promise<import('../lib/output-types.js').StructuredOutput> {
  const { buildEnvelope: __be, buildMarkdownEnvelope: __bme } = await import('../lib/output-types.js');
  const telemetry = newTelemetry();
  // poc_from_siem_status already has its own `view` enum (summary/full/yaml/configs/top/pattern).
  // The MCP envelope `view` is a SEPARATE control: how to package the output.
  // Convention: when the caller wants the typed envelope, they pass envelope_view='summary' or just omit it.
  // We default to wrapping any view's rendered markdown in a typed envelope.
  const envView = (args as unknown as { envelope_view?: 'summary' | 'markdown' }).envelope_view ?? 'summary';
  const s = SNAPSHOTS.get(args.snapshot_id);
  if (!s) {
    const err: PrimitiveError = {
      error_type: 'input_invalid',
      retryable: false,
      suggested_backoff_ms: null,
      hint: `Unknown snapshot_id "${args.snapshot_id}". Submit via log10x_poc_from_siem_submit first; snapshots live in-memory per MCP process.`,
    };
    return __be({
      tool: 'log10x_poc_from_siem_status',
      view: 'summary',
      summary: { headline: `Unknown snapshot_id "${args.snapshot_id}".` },
      data: {
        snapshot_id: args.snapshot_id,
        ...buildUnifiedFields({ status: 'error', telemetry, humanSummary: err.hint, error: err }),
      },
    });
  }
  let md: string;
  try {
    md = await executePocStatusInner(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err: PrimitiveError = {
      error_type: /view="pattern"/i.test(msg) ? 'input_invalid' : 'local_processing_failed',
      retryable: false,
      suggested_backoff_ms: null,
      hint: msg.slice(0, 400),
    };
    const unified = buildUnifiedFields({ status: 'error', telemetry, humanSummary: err.hint, error: err });
    const { status: _u, ...unifiedRest } = unified;
    return __be({
      tool: 'log10x_poc_from_siem_status',
      view: 'summary',
      summary: { headline: `POC status render failed: ${err.error_type}` },
      data: {
        snapshot_id: s.id,
        status: s.status,
        envelope_status: 'error' as const,
        ...unifiedRest,
      },
    });
  }
  if (envView === 'markdown') {
    return __bme({
      tool: 'log10x_poc_from_siem_status',
      summary: { headline: `POC status (${s.status}) for snapshot_id ${s.id}` },
      markdown: md,
    });
  }
  // Map snapshot's internal phase to the unified envelope's status enum.
  // 'complete' → 'success', 'failed' → 'error', else → 'no_signal'
  // (in-progress, not yet actionable — agent should keep polling).
  const unifiedStatus: 'success' | 'error' | 'no_signal' =
    s.status === 'complete' ? 'success' : s.status === 'failed' ? 'error' : 'no_signal';
  const unifiedError: PrimitiveError | undefined = s.status === 'failed'
    ? {
        error_type: 'local_processing_failed',
        retryable: true,
        suggested_backoff_ms: 30_000,
        hint: s.error ?? 'POC pipeline failed; check error + retry_hint fields.',
      }
    : undefined;
  // v2 envelope: when status is complete AND view='summary' (default), build the
  // structured input+output JSON the agent will quote. Prose surfaces (markdown,
  // human_summary) are intentionally absent from the summary path — the agent's
  // own writing is the report; we provide facts only.
  let v2Result: unknown = undefined;
  let dailyProjection: DailyProjection | undefined = undefined;
  if (s.status === 'complete' && s.renderInput && (args.view ?? 'summary') === 'summary') {
    try {
      const { patterns, clusters, redundancyPairs } = _enrichForEnvelope(s.renderInput);
      const envelope = buildPocEnvelopeV2(
        s.renderInput,
        patterns as unknown as Parameters<typeof buildPocEnvelopeV2>[1],
        clusters,
        redundancyPairs,
        args.top_n ?? 50,
      );
      // Attach pre-computed host-agent enrichment from the snapshot,
      // when present. The enrichment is computed once at end of
      // runPipeline so status polling is idempotent + free.
      if (s.hostAgentEnrichment) {
        envelope.output.agent_enrichment = s.hostAgentEnrichment;
      }
      v2Result = envelope;
      // Envelope-edge daily projection: dollar low/high (mirrors
      // poc-from-local) plus pct reduction low/high. Computed off the
      // same enriched patterns so the central point matches the
      // renderer's totals. Range comes from the volume detector's
      // multiplier when present, else collapses to a single point.
      dailyProjection = computeDailyProjection(
        s.renderInput,
        patterns as unknown as ReadonlyArray<{ bytes: number; projectedSavings: number }>,
      );
    } catch (e) {
      // Fall back silently — v2 envelope is best-effort; the snapshot
      // metadata + markdown view always remains available as a recovery
      // path. Surface the error only as `envelope_build_error` so the
      // agent can see it and re-call with view='markdown' if needed.
      v2Result = { build_error: (e as Error).message };
    }
  }
  const headline = `POC ${s.status} for snapshot_id ${s.id}${s.status === 'complete' ? ` (${args.view ?? 'summary'} view)` : `, progress=${s.progressPct}%, elapsed=${Math.round((Date.now() - s.startedAtMs) / 1000)}s`}.`;
  return __be({
    tool: 'log10x_poc_from_siem_status',
    view: 'summary',
    summary: { headline },
    data: {
      snapshot_id: s.id,
      status: s.status,
      progress_pct: s.progressPct,
      step_detail: s.stepDetail,
      elapsed_seconds: Math.round((Date.now() - s.startedAtMs) / 1000),
      partial_patterns_found: s.partialPatternsFound,
      partial_events_pulled: s.partialEventsPulled,
      partial_bytes_pulled: s.partialBytesPulled,
      partial_stop_reason: s.partialStopReason,
      report_file_path: s.reportFilePath,
      error: s.error,
      retry_hint: s.retryHint,
      view_rendered: s.status === 'complete' ? (args.view ?? 'summary') : undefined,
      // v2 envelope under `result` for view='summary' (the default).
      // Other views (markdown / full / yaml / configs / top / pattern)
      // hit the alternate code path above and never land here.
      result: v2Result,
      // Envelope-edge daily projection — mirrors poc-from-local's
      // `daily_dollar_projection_low/high` and adds the bytes-first
      // `daily_pct_reduction_low/high` band. Present only when the
      // snapshot has a renderInput and the v2 envelope built cleanly;
      // omitted on partial/failed snapshots.
      daily_projection: dailyProjection,
      // `report_markdown` retained for back-compat callers; v2 surface
      // is `result`. Default-summary agents should ignore the markdown.
      report_markdown: s.status === 'complete' && (args.view ?? 'summary') !== 'summary' ? md : undefined,
      partial_report_markdown: s.status === 'failed' ? s.partialReportMarkdown : undefined,
      // Unified envelope fields. NOTE: snapshot's `status` and `error`
      // keys above are tool-specific (the in-memory pipeline state); the
      // unified envelope's `status` lives under a different key derived
      // from the pipeline state. Spread last so the unified `error`
      // overwrites the partial-string-error from snapshot.
      query_count: telemetry.queryCount,
      total_latency_ms: Date.now() - telemetry.startedAt,
      backend_pressure_hint: null,
      human_summary: headline,
      // Don't overwrite snapshot's tool-specific `status` and `error`
      // with the unified ones; agents read both. Unified status lives
      // under `envelope_status` so the field name disambiguates.
      envelope_status: unifiedStatus,
      ...(unifiedError ? { envelope_error: unifiedError } : {}),
    },
    actions: s.status === 'complete'
      ? []
      : s.status === 'failed'
        ? [{ tool: 'log10x_poc_from_siem_submit', args: {}, reason: 'POC failed — resubmit with adjusted args' }]
        : [{ tool: 'log10x_poc_from_siem_status', args: { snapshot_id: s.id }, reason: 'continue polling every ~30s until status=complete' }],
  });
}

async function executePocStatusInner(args: PocStatusArgs): Promise<string> {
  const s = SNAPSHOTS.get(args.snapshot_id);
  if (!s) {
    throw new Error(
      `Unknown snapshot_id "${args.snapshot_id}". Submit via log10x_poc_from_siem_submit first; snapshots live in-memory per MCP process.`
    );
  }
  const elapsedSec = Math.round((Date.now() - s.startedAtMs) / 1000);

  if (s.status === 'complete') {
    const view = args.view ?? 'summary';
    const lines: string[] = [];
    // Dispatch on view. All non-full views need renderInput; fall back
    // to the stored full markdown for back-compat on old snapshots.
    const ri = s.renderInput;
    let body: string;
    if (!ri) {
      body = s.reportMarkdown || '_report missing_';
    } else {
      switch (view) {
        case 'full':
          body = renderPocReport(ri).markdown;
          break;
        case 'yaml':
          body = renderPocYaml(ri, args.top_n ?? 5);
          break;
        case 'configs':
          body = renderPocConfigs(ri, args.top_n ?? 5);
          break;
        case 'top':
          body = renderPocTop(ri, args.top_n ?? 20);
          break;
        case 'pattern':
          if (!args.pattern) {
            throw new Error(
              'view="pattern" requires a `pattern` arg — pass the snake_case identity from a prior view (e.g., from the top drivers table).'
            );
          }
          body = renderPocPattern(ri, args.pattern);
          break;
        case 'summary':
        default:
          body = renderPocSummary(ri, args.top_n ?? 5);
          break;
      }
    }
    lines.push(body);
    lines.push('');
    if (s.reportFilePath) {
      lines.push(`_Full report on disk: ${s.reportFilePath}_`);
    }
    return lines.join('\n');
  }

  if (s.status === 'failed') {
    const lines: string[] = [];
    lines.push('## POC — failed');
    lines.push('');
    lines.push(`**snapshot_id**: \`${s.id}\``);
    lines.push(`**error**: ${s.error}`);
    if (s.retryHint) lines.push(`**retry_hint**: ${s.retryHint}`);
    if (s.partialReportMarkdown) {
      lines.push('');
      lines.push('### Partial report (from what was pulled before failure)');
      lines.push('');
      lines.push(s.partialReportMarkdown);
    }
    return lines.join('\n');
  }

  // In-progress
  const lines = [
    '## POC — in progress',
    '',
    `**snapshot_id**: \`${s.id}\``,
    `**status**: ${s.status}`,
    `**progress_pct**: ${s.progressPct}`,
    `**elapsed_seconds**: ${elapsedSec}`,
    `**step_detail**: ${s.stepDetail}`,
  ];
  if (s.partialPatternsFound !== undefined) {
    lines.push(`**partial_patterns_found**: ${s.partialPatternsFound}`);
  }
  lines.push('');
  // Phase-aware polling guidance: tell the LLM how long this phase
  // typically lasts so it can pick a sane next-poll interval and not
  // burn cycles on pointless 5s-poll loops.
  const phaseHint =
    s.status === 'pulling'
      ? 'Pulling phase typically takes 1-3 min; partial patterns surface only after pull completes.'
      : s.status === 'templatizing'
      ? 'Templatizing phase typically takes 3-8 min. `partial_patterns_found` updates as patterns resolve; when it stops growing, render is close.'
      : s.status === 'rendering'
      ? 'Rendering takes <5s; the next poll should return `complete`.'
      : '';
  if (phaseHint) lines.push(phaseHint);
  lines.push(
    `Poll again with \`log10x_poc_from_siem_status({snapshot_id: "${s.id}"})\` in ~30s.`
  );
  return lines.join('\n');
}

// ── Background pipeline ──

export async function runPipeline(
  connector: SiemConnector,
  snapshot: Snapshot,
  args: PocSubmitArgs
): Promise<void> {
  const pullStart = Date.now();
  snapshot.status = 'pulling';
  snapshot.stepDetail = `pulling from ${connector.id}`;

  let pullResult: PullEventsResult;
  try {
    pullResult = await connector.pullEvents({
      window: args.window,
      scope: args.scope,
      query: args.query,
      targetEventCount: args.target_event_count,
      maxPullMinutes: args.max_pull_minutes,
      onProgress: (p) => {
        snapshot.progressPct = Math.min(55, Math.max(snapshot.progressPct, p.pct));
        snapshot.stepDetail = p.step;
        // Surface live counters when the connector exposes them. Each
        // SIEM-specific connector reports its own progress shape; the
        // standard fields we read are `eventsPulled` and `bytesPulled`.
        const progressData = p as unknown as { eventsPulled?: number; bytesPulled?: number };
        if (typeof progressData.eventsPulled === 'number') {
          snapshot.partialEventsPulled = progressData.eventsPulled;
        }
        if (typeof progressData.bytesPulled === 'number') {
          snapshot.partialBytesPulled = progressData.bytesPulled;
        }
      },
      schemaOverride: args.clickhouse_table
        ? {
            timestampColumn: args.clickhouse_timestamp_column,
            messageColumn: args.clickhouse_message_column,
            serviceColumn: args.clickhouse_service_column,
            severityColumn: args.clickhouse_severity_column,
            table: args.clickhouse_table,
          }
        : undefined,
    });
  } catch (e) {
    snapshot.status = 'failed';
    snapshot.error = `pull_failed: ${(e as Error).message}`;
    snapshot.retryHint = 'Check SIEM credentials with log10x_doctor; verify scope/query syntax.';
    snapshot.finishedAt = new Date().toISOString();
    return;
  }
  const pullWallTimeMs = Date.now() - pullStart;
  snapshot.partialEventsPulled = pullResult.events.length;
  snapshot.partialBytesPulled = pullResult.events.reduce<number>(
    (s, e) => s + (typeof e === 'string' ? e.length : JSON.stringify(e).length),
    0,
  );
  snapshot.partialStopReason = pullResult.metadata.reasonStopped;

  if (pullResult.metadata.reasonStopped === 'error' && pullResult.events.length === 0) {
    snapshot.status = 'failed';
    snapshot.error = `pull_errored: ${pullResult.metadata.notes?.join('; ') || 'no events retrieved'}`;
    snapshot.retryHint = 'Check SIEM credentials with log10x_doctor; verify scope/query syntax.';
    snapshot.finishedAt = new Date().toISOString();
    return;
  }

  // ── Templatize + parallel volume detection ──
  // Both are independent of each other's output so we race them.
  // Volume detection timeout: 15s; never blocks the report.
  snapshot.status = 'templatizing';
  snapshot.stepDetail = `templating ${pullResult.events.length} events`;
  snapshot.progressPct = Math.max(snapshot.progressPct, 60);
  const templStart = Date.now();

  const volumeDetectPromise = resolveVolume(args, connector);

  let extraction;
  try {
    // Approx raw input size in bytes to decide whether to chunk.
    // Threshold: 64 MB. JVM cold-start dominates for smaller inputs,
    // so single-process is faster there.
    const approxRawBytes = pullResult.events.reduce<number>((sum, e) => {
      if (typeof e === 'string') return sum + e.length + 1;
      if (e && typeof e === 'object' && typeof (e as { message?: string }).message === 'string') {
        return sum + (e as { message: string }).message.length + 1;
      }
      return sum + 200;
    }, 0);
    const chunkParallel = args.privacy_mode === true && approxRawBytes > 64 * 1024 * 1024;
    extraction = await extractPatterns(pullResult.events, {
      privacyMode: args.privacy_mode,
      autoBatch: true,
      // POC pulls scale to 100K-1M events. Route through the file-
      // output engine app (@apps/mcp-file) so the templater can stream
      // results to disk instead of buffering in stdout. Falls back to
      // stdin-based runner when privacy_mode=false (paste lambda).
      useFileOutput: args.privacy_mode === true,
      // For GB-scale inputs (over 64 MB raw), split events into
      // chunks and run N tenx processes in parallel. Outputs merge
      // by templateHash + tenx_hash. JVM cold-start makes this a
      // loss on small inputs so the threshold is hard-coded above.
      chunkParallel,
    });
  } catch (e) {
    snapshot.status = 'failed';
    snapshot.error = `templatize_failed: ${(e as Error).message}`;
    snapshot.retryHint = 'Try smaller target_event_count, enable privacy_mode with local tenx installed, or reduce window size.';
    snapshot.finishedAt = new Date().toISOString();
    return;
  }
  const templateWallTimeMs = Date.now() - templStart;
  // Collapse engine-emitted templateHashes that share a Reporter-tier
  // symbolMessage into one row. From a user-facing-action standpoint
  // those rows resolve to the same mute target, so showing them
  // separately is noise. Patterns without a symbolMessage are left
  // keyed by templateHash.
  extraction.patterns = collapseBySymbolMessage(extraction.patterns);
  snapshot.partialPatternsFound = extraction.patterns.length;

  // Await volume detect AFTER templating — the templater is the long pole
  // and volume detection likely finished during it.
  const volumeResult = await volumeDetectPromise;

  // ── AI prettify via MCP sampling ──
  // Ask the host's LLM (Claude Desktop, Claude Code, Cursor, etc.) to
  // generate 3-5-word names for the top patterns. No Log10x backend
  // egress, no extra credentials — the host uses whatever model + auth
  // the user already has. Fail-soft when the host doesn't advertise
  // sampling; the report renders with raw identities + an appendix note.
  let aiPrettyNames: Record<string, string> | undefined;
  let aiPrettifyErrorNote: string | undefined;
  if (args.ai_prettify) {
    snapshot.stepDetail = 'ai-prettifying pattern names';
    const topPatterns = extraction.patterns.slice(0, 30);
    const prettifyInputs = topPatterns.map((p) => ({
      identity: p.hash,
      service: p.service,
      severity: p.severity,
      count: p.count,
      bytes: p.bytes,
    }));
    const result = await prettifyPatterns(prettifyInputs, {
      server: args._mcpServer,
      timeoutMs: 30_000,
    });
    if (Object.keys(result.names).length > 0) aiPrettyNames = result.names;
    aiPrettifyErrorNote = result.errorNote;
  }

  // ── Dependency pre-warm ──
  // For the top N patterns, query the resolved vendor's dashboards /
  // monitors / saved searches in parallel. Folds into the renderer's
  // refined-action column: any pattern with refs flips from `mute` →
  // `BLOCKED`. Only runs when the vendor is in DEP_CHECK_VENDORS;
  // otherwise the renderer shows `(not checked)`.
  let dependencyByIdentity: Map<string, number> | undefined;
  if (DEP_CHECK_VENDORS.includes(connector.id as SiemId)) {
    snapshot.status = 'rendering';
    snapshot.stepDetail = 'pre-warming dependency check on top patterns';
    snapshot.progressPct = Math.max(snapshot.progressPct, 80);
    const topForDeps = extraction.patterns.slice(0, 10);
    const depResults = await Promise.all(
      topForDeps.map(async (p) => {
        const identity =
          (p.symbolMessage && p.symbolMessage.length > 0 && p.symbolMessage) ||
          (p.tenxHash && p.tenxHash.length > 0 && p.tenxHash) ||
          p.hash;
        const tokens = identity.split(/[_-]+/).filter((t) => t.length >= 3);
        try {
          const scan = await checkDeps(connector.id as SiemId, {
            pattern: identity,
            tokens,
            service: p.service,
            severity: p.severity,
          });
          if (scan.error) return null;
          return [identity, scan.matches.length] as const;
        } catch {
          return null;
        }
      }),
    );
    dependencyByIdentity = new Map();
    for (const result of depResults) {
      if (result) dependencyByIdentity.set(result[0], result[1]);
    }
  }

  // ── Render ──
  snapshot.status = 'rendering';
  snapshot.stepDetail = 'rendering report';
  snapshot.progressPct = Math.max(snapshot.progressPct, 85);

  const windowHours = parseWindowMs(args.window) / 3_600_000;
  const analyzerCost = getAnalyzerCostForSiem(connector.id as SiemId, args.analyzer_cost_per_gb);

  const banners: string[] = [];
  if (pullResult.metadata.truncated) {
    banners.push(
      `Pull stopped at ${pullResult.events.length.toLocaleString()} events (reason: ${pullResult.metadata.reasonStopped}). Rerun with a larger max_pull_minutes for deeper coverage.`
    );
  }

  // Build the RenderInput once, stash it on the snapshot, and use it
  // for both the initial full-view render AND any later view-specific
  // status calls (summary/yaml/configs/top/pattern). This is what
  // makes view-dispatch free — no re-extraction round-trip.
  const renderInput: RenderInput = {
    siem: connector.id as SiemId,
    window: args.window,
    scope: args.scope,
    query: args.query,
    extraction,
    targetEventCount: args.target_event_count,
    pullWallTimeMs,
    templateWallTimeMs,
    reasonStopped: pullResult.metadata.reasonStopped,
    queryUsed: pullResult.metadata.queryUsed,
    windowHours,
    analyzerCostPerGb: analyzerCost,
    snapshotId: snapshot.id,
    startedAt: snapshot.startedAt,
    finishedAt: new Date().toISOString(),
    mcpVersion: MCP_VERSION,
    banners,
    pullNotes: pullResult.metadata.notes,
    totalDailyGb: volumeResult?.dailyGb,
    volumeSource: volumeResult?.source ?? 'none',
    volumeDetectSource: volumeResult?.sourceLabel,
    volumeDetectErrorNote: volumeResult?.errorNote,
    volumeRangeMultiplier: volumeResult?.rangeMultiplier,
    aiPrettyNames,
    aiPrettifyErrorNote,
    dependencyByIdentity,
    // first-seen by identity requires engine history. The POC primary
    // path (paste SIEM creds, no engine env configured) cannot resolve
    // this; the renderer degrades to `(unknown)` and the row still
    // displays. Wire from engine env when a future caller supplies it.
    firstSeenByIdentity: undefined,
    // Window bounds for emergence categorization: pulled events fall
    // within [pullStart-windowMs, pullEnd]. The enricher uses these to
    // classify each pattern as new / growing / stable / recent_burst
    // from its per-event timestamps.
    windowStartMs: pullStart - parseWindowMs(args.window),
    windowEndMs: pullStart,
  };
  snapshot.renderInput = renderInput;

  // ── Host-agent enrichment ──
  // After the engine measured everything it can, ask the host's LLM to
  // contribute operational context it can see and we can't: deploy
  // correlation, dependency-safety checks against dashboards/alerts,
  // code-level fix refinement, prioritization. Single round-trip,
  // capped at enrich_max_tokens. Skipped when the host doesn't
  // advertise sampling, or when ai_prettify already failed (a useful
  // signal that the host isn't sampling-capable in this session).
  if (args.enrich_with_host_agent !== false && args._mcpServer) {
    snapshot.stepDetail = 'enriching with host agent';
    snapshot.progressPct = Math.max(snapshot.progressPct, 90);
    try {
      // Build the v2 envelope first; the enricher needs the structured
      // findings to know which patterns to ask about. We re-enrich and
      // re-build inside executePocStatusInner when summary view is
      // requested, but the enrichment result attaches to the snapshot
      // so it's not re-run on every status poll.
      const { patterns, clusters, redundancyPairs } = _enrichForEnvelope(renderInput);
      const previewEnvelope = buildPocEnvelopeV2(
        renderInput,
        patterns as unknown as Parameters<typeof buildPocEnvelopeV2>[1],
        clusters,
        redundancyPairs,
        15,
      );
      const enrichment = await enrichWithHostAgent(previewEnvelope, {
        server: args._mcpServer,
        maxTokensTotal: args.enrich_max_tokens ?? 8000,
        topN: 10,
      });
      snapshot.hostAgentEnrichment = enrichment;
    } catch (e) {
      // Never let enrichment break the POC; stash the error and proceed.
      snapshot.hostAgentEnrichment = {
        contributions: [],
        metadata: {
          host_capability: 'host_unavailable',
          tokens_spent: 0,
          calls_attempted: 0,
          calls_succeeded: 0,
          skipped_reason: `enrichment_threw: ${(e as Error).message.slice(0, 200)}`,
        },
      };
    }
  }

  const render = renderPocReport(renderInput);

  // ── Write file ──
  const reportDir = process.env.LOG10X_REPORT_DIR || '/tmp/log10x-reports';
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const reportPath = join(reportDir, `poc_from_siem-${timestamp}.md`);
  try {
    await mkdir(reportDir, { recursive: true });
    const header = `<!-- Generated by log10x_poc_from_siem at ${new Date().toISOString()} · siem=${connector.id} · window=${args.window} · events_analyzed=${extraction.totalEvents} · snapshot_id=${snapshot.id} -->\n\n`;
    await writeFile(reportPath, header + render.markdown, 'utf8');
  } catch (e) {
    // Non-fatal: still return the markdown even if the file write failed.
    snapshot.error = `report_write_failed: ${(e as Error).message}`;
  }

  snapshot.status = 'complete';
  snapshot.progressPct = 100;
  snapshot.stepDetail = 'done';
  snapshot.reportMarkdown = render.markdown;
  snapshot.reportFilePath = reportPath;
  snapshot.summary = render.summary;
  snapshot.finishedAt = new Date().toISOString();
}

/**
 * Resolve the customer's total daily log volume for cost projection.
 *
 * Priority:
 *   1. Explicit user arg — `total_daily_gb` > `total_monthly_gb` / 30 >
 *      `total_annual_gb` / 365. Marked as `user_arg`.
 *   2. Auto-detect via the connector's `detectDailyVolumeGb` method
 *      when `auto_detect_volume !== false`. Marked as `auto_detected`.
 *   3. None — caller will render scenario brackets.
 *
 * Fail-soft: returns errorNote rather than throwing.
 */
async function resolveVolume(
  args: PocSubmitArgs,
  connector: SiemConnector
): Promise<{
  dailyGb?: number;
  source?: 'user_arg' | 'auto_detected';
  sourceLabel?: string;
  errorNote?: string;
  rangeMultiplier?: { low: number; high: number };
} | null> {
  // User arg wins.
  if (args.total_daily_gb && args.total_daily_gb > 0) {
    return { dailyGb: args.total_daily_gb, source: 'user_arg', sourceLabel: 'user-supplied total_daily_gb' };
  }
  if (args.total_monthly_gb && args.total_monthly_gb > 0) {
    return {
      dailyGb: args.total_monthly_gb / 30,
      source: 'user_arg',
      sourceLabel: `user-supplied ${args.total_monthly_gb.toLocaleString()} GB/mo`,
    };
  }
  if (args.total_annual_gb && args.total_annual_gb > 0) {
    return {
      dailyGb: args.total_annual_gb / 365,
      source: 'user_arg',
      sourceLabel: `user-supplied ${args.total_annual_gb.toLocaleString()} GB/yr`,
    };
  }
  // Auto-detect (default true).
  if (args.auto_detect_volume === false) return null;
  if (!connector.detectDailyVolumeGb) {
    return {
      errorNote: `${connector.displayName}: auto-detect not implemented for this SIEM`,
    };
  }
  try {
    const timeout = new Promise<{ errorNote: string }>((resolve) =>
      setTimeout(() => resolve({ errorNote: 'Volume auto-detect timed out after 20s' }), 20_000)
    );
    const result = await Promise.race([
      connector.detectDailyVolumeGb({
        scope: args.scope,
        schemaOverride: args.clickhouse_table
          ? {
              timestampColumn: args.clickhouse_timestamp_column,
              messageColumn: args.clickhouse_message_column,
              serviceColumn: args.clickhouse_service_column,
              severityColumn: args.clickhouse_severity_column,
              table: args.clickhouse_table,
            }
          : undefined,
      }),
      timeout,
    ]);
    if ('dailyGb' in result && result.dailyGb && result.dailyGb > 0) {
      return {
        dailyGb: result.dailyGb,
        source: 'auto_detected',
        sourceLabel: result.source || 'SIEM usage API',
        ...('rangeMultiplier' in result && result.rangeMultiplier
          ? { rangeMultiplier: result.rangeMultiplier }
          : {}),
      };
    }
    return { errorNote: ('errorNote' in result && result.errorNote) || 'Auto-detect returned no value' };
  } catch (e) {
    return { errorNote: `Auto-detect threw: ${(e as Error).message.slice(0, 200)}` };
  }
}

/**
 * Envelope-edge daily projection. Dollar fields mirror
 * poc-from-local.ts:153-154; percent-reduction fields are the
 * bytes-first band added per the bytes-lead/dollars-overlay spec.
 *
 * Range semantics: when the volume detector returned a range
 * multiplier (auto-detected with uncertainty), low/high reflect that
 * multiplier. When the customer passed an explicit volume (or no
 * volume), low===high===expected. Percent reduction is bound to
 * [0, 100]; expected is `projectedSavings / totalCost`. Range is the
 * same multiplier applied to projected savings vs total cost — when
 * both axes scale by the same factor the percent is invariant, so the
 * band collapses to a single point in that case. We still emit
 * low===expected===high so callers can read the schema uniformly.
 */
interface DailyProjection {
  daily_dollar_projection_low: number | null;
  daily_dollar_projection_expected: number | null;
  daily_dollar_projection_high: number | null;
  daily_pct_reduction_low: number;
  daily_pct_reduction_expected: number;
  daily_pct_reduction_high: number;
  /** 'auto_detected' | 'user_arg' | 'none' — provenance for the dollar axis. */
  volume_source: 'auto_detected' | 'user_arg' | 'none';
}

function computeDailyProjection(
  ri: RenderInput,
  patterns: ReadonlyArray<{ bytes: number; projectedSavings: number }>,
): DailyProjection {
  const analyzerCost = ri.analyzerCostPerGb;
  const totalBytes = ri.extraction?.totalBytes ?? 0;
  const totalCostWindow = (totalBytes / 1024 ** 3) * analyzerCost;
  const projectedSavingsWindow = patterns.reduce((s, p) => s + p.projectedSavings, 0);
  const pctExpected = totalCostWindow > 0
    ? Math.min(100, Math.max(0, (projectedSavingsWindow / totalCostWindow) * 100))
    : 0;

  // Dollar axis: scale the window cost to a daily figure using the
  // customer's total daily volume when known. Without volume, the
  // dollar projection is undefined (the renderer falls back to scenario
  // brackets), so we emit null per the bytes-first spec.
  let dollarLow: number | null = null;
  let dollarExpected: number | null = null;
  let dollarHigh: number | null = null;
  let volumeSource: DailyProjection['volume_source'] = ri.volumeSource ?? 'none';
  if (volumeSource !== 'none' && ri.totalDailyGb && ri.totalDailyGb > 0) {
    const sampleGb = totalBytes / 1024 ** 3;
    const dailyFactor = sampleGb > 0 ? ri.totalDailyGb / sampleGb : 0;
    const expected = projectBilling(totalCostWindow * dailyFactor, ri.windowHours, 24);
    dollarExpected = expected;
    const m = ri.volumeRangeMultiplier;
    dollarLow = m ? expected * m.low : expected;
    dollarHigh = m ? expected * m.high : expected;
  }

  // Percent axis: same multiplier applied to both numerator and
  // denominator cancels out; band collapses to a point. Emit
  // low===expected===high for schema uniformity.
  return {
    daily_dollar_projection_low: dollarLow,
    daily_dollar_projection_expected: dollarExpected,
    daily_dollar_projection_high: dollarHigh,
    daily_pct_reduction_low: pctExpected,
    daily_pct_reduction_expected: pctExpected,
    daily_pct_reduction_high: pctExpected,
    volume_source: volumeSource,
  };
}

function projectBilling(windowCost: number, windowHours: number, targetHours: number): number {
  if (windowHours <= 0) return 0;
  return windowCost * (targetHours / windowHours);
}

// Exposed for tests.
export function _resetSnapshots(): void {
  SNAPSHOTS.clear();
}

export function _getSnapshot(id: string): Snapshot | undefined {
  return SNAPSHOTS.get(id);
}

// Re-export for tests
export type { SiemConnector, CredentialDiscovery, RegistrySiemId };
