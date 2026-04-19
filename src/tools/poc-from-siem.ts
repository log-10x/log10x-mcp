/**
 * log10x_poc_from_siem — async MCP tool pair.
 *
 * The submit tool kicks off the pull + templatize + render pipeline in the
 * background and returns a `snapshot_id`. The status tool reports progress
 * and returns the final markdown once done.
 *
 * This mirrors the streamer_query / streamer_query_status async shape so
 * callers can track a long-running pull without blocking the MCP loop.
 */

import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';

import {
  ALL_CONNECTORS,
  discoverAvailable,
  getConnector,
  parseWindowMs,
  type SiemConnector,
  type PullEventsResult,
  type CredentialDiscovery,
  type SiemId as RegistrySiemId,
} from '../lib/siem/index.js';
import type { SiemId } from '../lib/siem/pricing.js';
import { SIEM_DISPLAY_NAMES, getAnalyzerCostForSiem } from '../lib/siem/pricing.js';
import { extractPatterns } from '../lib/pattern-extraction.js';
import { renderPocReport, type RenderInput } from '../lib/poc-report-renderer.js';

const MCP_VERSION = '1.4.0';

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
  privacy_mode: z
    .boolean()
    .default(true)
    .describe(
      'Default true: templating runs through the locally-installed `tenx` CLI so events never leave the machine. ' +
        'Requires `tenx` to be installed (brew install log10x/tap/tenx, or see https://docs.log10x.com/apps/dev/); ' +
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
  reportMarkdown?: string;
  reportFilePath?: string;
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
  privacy_mode: boolean;
  environment?: string;
  clickhouse_table?: string;
  clickhouse_timestamp_column?: string;
  clickhouse_message_column?: string;
  clickhouse_service_column?: string;
  clickhouse_severity_column?: string;
}

export async function executePocSubmit(args: PocSubmitArgs): Promise<string> {
  // ── Resolve the connector ──
  let connector: SiemConnector;
  let siemDetectedNote = '';
  if (args.siem) {
    connector = getConnector(args.siem);
  } else {
    const discovered = await discoverAvailable();
    const available = discovered.filter((d) => d.detection.available);
    if (available.length === 0) {
      throw new Error(
        `No SIEM credentials detected. Set credentials for one of: ${ALL_CONNECTORS.map((c) => c.id).join(', ')}. ` +
          `Run \`log10x_doctor\` for per-SIEM discovery detail.`
      );
    }
    if (available.length > 1) {
      // Prefer explicit env credentials over ambient ones.
      const explicit = available.filter((d) => d.detection.source === 'env');
      if (explicit.length === 1) {
        connector = getConnector(explicit[0].id);
        siemDetectedNote = `Auto-detected ${explicit[0].displayName} via explicit env vars (others available: ${available
          .filter((d) => d.id !== explicit[0].id)
          .map((d) => d.id)
          .join(', ')}).`;
      } else {
        throw new Error(
          `Multiple SIEMs detected (${available.map((d) => d.id).join(', ')}). Pass \`siem=<name>\` to disambiguate.`
        );
      }
    } else {
      const one = available[0];
      connector = getConnector(one.id);
      if (one.detection.source === 'ambient') {
        siemDetectedNote = `Detected ambient credentials for ${one.displayName} — assuming ${one.id}. Override with \`siem=<other>\` if wrong.`;
      } else {
        siemDetectedNote = `Auto-detected ${one.displayName}.`;
      }
    }
  }

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
  planParts.push(`Max pull time: ${args.max_pull_minutes} min. Call \`log10x_poc_from_siem_status({snapshot_id: "${snapshot.id}"})\` to retrieve progress and the final report.`);

  const out = [
    '## Log10x POC — submit accepted',
    '',
    `**snapshot_id**: \`${snapshot.id}\``,
    `**siem_detected**: ${connector.id}`,
    `**estimated_duration_minutes**: ${estimatedDuration}`,
    '',
    planParts.join(' '),
  ].join('\n');

  return out;
}

// ── Status ──

export async function executePocStatus(args: { snapshot_id: string }): Promise<string> {
  const s = SNAPSHOTS.get(args.snapshot_id);
  if (!s) {
    throw new Error(
      `Unknown snapshot_id "${args.snapshot_id}". Submit via log10x_poc_from_siem_submit first; snapshots live in-memory per MCP process.`
    );
  }
  const elapsedSec = Math.round((Date.now() - s.startedAtMs) / 1000);

  if (s.status === 'complete') {
    const lines: string[] = [];
    lines.push(s.reportMarkdown || '_report missing_');
    lines.push('');
    lines.push(`_Report saved to: ${s.reportFilePath}_`);
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
  lines.push(
    `The pipeline is still running. Poll again with \`log10x_poc_from_siem_status({snapshot_id: "${s.id}"})\` in ~30s.`
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

  // ── Templatize ──
  snapshot.status = 'templatizing';
  snapshot.stepDetail = `templating ${pullResult.events.length} events`;
  snapshot.progressPct = Math.max(snapshot.progressPct, 60);
  const templStart = Date.now();
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
  snapshot.partialPatternsFound = extraction.patterns.length;

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

  const render = renderPocReport({
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
  });

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

// Exposed for tests.
export function _resetSnapshots(): void {
  SNAPSHOTS.clear();
}

export function _getSnapshot(id: string): Snapshot | undefined {
  return SNAPSHOTS.get(id);
}

// Re-export for tests
export type { SiemConnector, CredentialDiscovery, RegistrySiemId };
