/**
 * log10x_clickhouse_census: where a ClickHouse cluster's CPU goes, read from its
 * own system tables with the credentials in the environment. Read only.
 */

import { z } from 'zod';
import { chCredsFromEnv, chRequester, type ChCreds, type ChQuery } from '../lib/clickhouse-rows-tick.js';
import { CensusConnectError, censusGrants, pct, renderCensusMarkdown, runCensus } from '../lib/clickhouse-census.js';
import { validateStrictArgs } from '../lib/strict-args.js';
import { buildChassisEnvelope, buildChassisErrorEnvelope, newChassisTelemetry, type ChassisEnvelope } from '../lib/chassis-envelope.js';

const TOOL = 'log10x_clickhouse_census';
const IDENT = /^[A-Za-z0-9_]+$/;
const QUERY_TIMEOUT_MS = 120_000;

export const clickhouseCensusSchema = {
  days: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(7)
    .describe('Days back from now to read. Default 7. System-log retention bounds what the server still holds; the report states the hours it found.'),
  database: z
    .string()
    .regex(IDENT)
    .default('default')
    .describe('Database of the logs table, and the database checked for tables no SELECT read. Default `default`.'),
  table: z
    .string()
    .regex(IDENT)
    .default('otel_logs')
    .describe('The logs table whose write share is W. Default `otel_logs`, the ClickStack logs table.'),
  cluster: z
    .string()
    .optional()
    .describe('Cluster name for clusterAllReplicas over the system logs. Default `default` on a ClickHouse Cloud host and none elsewhere; pass "" to read one node.'),
  view: z
    .enum(['markdown', 'summary'])
    .default('markdown')
    .describe('`markdown` (default): the census page. `summary`: the same data without the page.'),
};

export interface ClickhouseCensusArgs {
  days?: number;
  database?: string;
  table?: string;
  cluster?: string;
  view?: 'markdown' | 'summary';
}

export interface ClickhouseCensusDeps {
  /** Undefined reads CLICKHOUSE_URL and its credentials from the environment; null means none. */
  creds?: ChCreds | null;
  ch?: ChQuery;
  nowMs?: () => number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the configured host';
  }
}

/** ClickHouse Cloud spreads the system logs over replicas; a self-managed node does not need the wrapper. */
export function defaultCluster(url: string): string | undefined {
  return /\.clickhouse\.cloud(:\d+)?$/i.test(hostOf(url)) ? 'default' : undefined;
}

function scrub(message: string, creds: ChCreds): string {
  return creds.password ? message.split(creds.password).join('***') : message;
}

export async function executeClickhouseCensus(args: ClickhouseCensusArgs, deps: ClickhouseCensusDeps = {}): Promise<ChassisEnvelope> {
  const strict = validateStrictArgs<ClickhouseCensusArgs>(TOOL, clickhouseCensusSchema, args);
  if (strict.error) return strict.error;
  const days = args.days ?? 7;
  const database = args.database ?? 'default';
  const table = args.table ?? 'otel_logs';
  const view = args.view ?? 'markdown';
  if (!IDENT.test(database) || !IDENT.test(table) || !(days >= 1 && days <= 30)) {
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: { error_type: 'input_invalid', retryable: false, suggested_backoff_ms: null, hint: 'database and table must be identifiers; days from 1 to 30.' },
    });
  }

  const creds = deps.creds === undefined ? chCredsFromEnv() : deps.creds ?? undefined;
  if (!creds) {
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: 'config_missing',
        retryable: false,
        suggested_backoff_ms: null,
        hint:
          'Set CLICKHOUSE_URL with CLICKHOUSE_API_KEY (the default user\'s password), or CLICKHOUSE_URL with CLICKHOUSE_USER and CLICKHOUSE_PASSWORD. ' +
          `The census user needs: ${censusGrants('<user>', database, 'default').join('; ')} (REMOTE only on a cluster).`,
      },
      source_disclosure: { siem_vendor: 'clickhouse' },
    });
  }

  const cluster = args.cluster !== undefined ? args.cluster.trim() || undefined : defaultCluster(creds.url);
  const ch = deps.ch ?? chRequester(creds, QUERY_TIMEOUT_MS);
  const nowSec = Math.floor((deps.nowMs ? deps.nowMs() : Date.now()) / 1000);
  const host = hostOf(creds.url);
  const telemetry = newChassisTelemetry();
  let report;
  try {
    report = await runCensus(
      async (sql) => {
        telemetry.queryCount += 1;
        return ch(sql);
      },
      { nowSec, days, database, table, cluster, user: creds.username },
    );
  } catch (e) {
    const msg = scrub(e instanceof Error ? e.message : String(e), creds);
    const auth = /AUTHENTICATION_FAILED|REQUIRED_PASSWORD|Code: (516|194)\b|ClickHouse 401/.test(msg);
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: auth ? 'config_missing' : 'backend_error',
        retryable: !auth && !(e instanceof CensusConnectError && /ClickHouse 4\d\d/.test(msg)),
        suggested_backoff_ms: auth ? null : 5000,
        hint: `ClickHouse at ${host} did not answer the census: ${msg.slice(0, 300)}`,
      },
      telemetry,
      source_disclosure: { siem_vendor: 'clickhouse' },
    });
  }

  for (const u of report.unreadable) u.message = scrub(u.message, creds);
  const markdown = renderCensusMarkdown(report);
  const measured = report.cpu_seconds.node_total > 0;
  const partial = report.unreadable.length > 0 || report.missing_logs.some((m) => m === 'system.query_log' || m === 'system.part_log');
  const headline = !measured
    ? `No CPU recorded in ClickHouse's system tables at ${host} over the last ${days} days.`
    : `W ${pct(report.w_share)} and Q ${pct(report.q_share)} of node CPU on ${report.target_table} over ${days} days` +
      (report.peak ? `; peak hour ${report.peak.peak_to_mean.toFixed(1)} times the mean, W ${pct(report.peak.w_at_peak)} in it.` : '.');

  return buildChassisEnvelope({
    tool: TOOL,
    view: view === 'markdown' ? 'markdown' : 'summary',
    headline,
    status: !measured ? (partial ? 'partial' : 'no_signal') : partial ? 'partial' : 'success',
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {
      bytes_source: 'siem_direct',
      rate_source: 'none',
      siem_vendor: 'clickhouse',
      source_label: `ClickHouse ${host}, system tables`,
    },
    scope: {
      window: `${report.window.from}/${report.window.to}`,
      window_basis: args.days !== undefined ? 'explicit' : 'auto_default',
      ...(report.unreadable.length ? { candidates_failed: report.unreadable.map((u) => u.table) } : {}),
    },
    payload: view === 'markdown' ? { ...report, markdown } : report,
    human_summary: headline,
    ...(view === 'markdown' ? { must_render_verbatim: markdown } : {}),
    telemetry,
  });
}
