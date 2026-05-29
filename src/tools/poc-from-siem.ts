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
    .default('7d')
    .describe('Window to pull over. Accepts "1h", "24h", "7d", "30d". Default "7d".'),
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
    .max(2_000_000)
    .default(250_000)
    .describe('Target event count for the pull. Default 250k (~125 MB at 500B avg, tokenizes in 2-3 min).'),
  max_pull_minutes: z
    .number()
    .min(1)
    .max(60)
    .default(5)
    .describe('Hard cap on pull wall-time. Default 5. The pull stops at whichever of target_event_count or max_pull_minutes hits first.'),
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
    .enum(['summary', 'full', 'yaml', 'configs', 'top', 'pattern'])
    .default('summary')
    .describe(
      "How much detail to render. Default `summary` — a ~30-line exec banner + top-5 table + " +
        'available-views list. Use `full` for the complete 9-section report (~300 lines). ' +
        'Use `yaml` for paste-ready receiver mute-file entries; `configs` for native SIEM ' +
        "exclusion configs (Datadog exclusion filter, Splunk props.conf, etc.); `top` for an " +
        "expanded N-row drivers table (combine with `top_n`); `pattern` for a deep-dive on " +
        'one identity (requires `pattern` arg).'
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
      report_file_path: s.reportFilePath,
      error: s.error,
      retry_hint: s.retryHint,
      view_rendered: s.status === 'complete' ? (args.view ?? 'summary') : undefined,
      report_markdown: s.status === 'complete' ? md : undefined,
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
    extraction = await extractPatterns(pullResult.events, {
      privacyMode: args.privacy_mode,
      autoBatch: true,
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
  };
  snapshot.renderInput = renderInput;
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

// Exposed for tests.
export function _resetSnapshots(): void {
  SNAPSHOTS.clear();
}

export function _getSnapshot(id: string): Snapshot | undefined {
  return SNAPSHOTS.get(id);
}

// Re-export for tests
export type { SiemConnector, CredentialDiscovery, RegistrySiemId };
