/**
 * log10x_datadog_spike_audit: the account's log spikes over a lookback, read
 * from Datadog's estimated usage metrics with the org's own keys, priced at
 * its rates, with what a fleet default limit would have held. Needs no 10x
 * install. Every request is a GET to Datadog's metrics query API.
 */

import { z } from 'zod';
import { datadogMetricsCredsFromEnv, ddQueryPoints, type DatadogMetricsCreds, type DdPointSeries } from '../lib/datadog-metrics-read.js';
import {
  BASELINE_DAYS,
  SPIKE_MULTIPLIER,
  buildSpikeAudit,
  budgetScopeWords,
  renderSpikeAuditMarkdown,
} from '../lib/datadog-spike-audit.js';
import { FLEET_DEFAULT_HEADROOM } from '../lib/fleet-default.js';
import { fmtAboutUsd } from '../lib/report/user-units.js';
import { validateStrictArgs } from '../lib/strict-args.js';
import {
  buildChassisEnvelope,
  buildChassisErrorEnvelope,
  newChassisTelemetry,
  recordQuery,
  type ChassisEnvelope,
} from '../lib/chassis-envelope.js';
import { QUERY_BUDGET } from '../lib/interactive-query.js';

const TOOL = 'log10x_datadog_spike_audit';
/** Days per query, so each hourly series stays well inside one response. */
const CHUNK_DAYS = 30;
const MAX_LOOKBACK_DAYS = 455;

export const EVENTS_QUERY =
  'sum:datadog.estimated_usage.logs.ingested_events{datadog_is_excluded:false} by {service,datadog_index}.as_count().rollup(sum, 3600)';
export const BYTES_QUERY = 'sum:datadog.estimated_usage.logs.ingested_bytes{*} by {service}.as_count().rollup(sum, 3600)';

export const datadogSpikeAuditSchema = {
  view: z
    .enum(['markdown', 'summary'])
    .default('markdown')
    .describe('`markdown` (default): the audit page. `summary`: the same data without the page.'),
  lookback: z
    .string()
    .regex(/^\d+d$/)
    .default('90d')
    .describe(`Days back from now to read, e.g. \`90d\` (default), from \`${BASELINE_DAYS + 1}d\` to \`${MAX_LOOKBACK_DAYS}d\`; older days the API does not return are left out. The first ${BASELINE_DAYS} days of each service set its baseline.`),
  standard_rate_per_million: z
    .number()
    .positive()
    .optional()
    .describe('The account\'s Standard indexing rate in dollars per million events. Default: list, $1.70 (15-day retention).'),
  ingestion_rate_per_gb: z
    .number()
    .positive()
    .optional()
    .describe('The account\'s ingestion rate in dollars per GB. Default: list, $0.10.'),
  spike_multiplier: z
    .number()
    .min(1.5)
    .max(20)
    .default(SPIKE_MULTIPLIER)
    .describe(`An hour is a spike when its events exceed this many times the median of the same hour over the ${BASELINE_DAYS} days before. Default ${SPIKE_MULTIPLIER}.`),
  headroom: z
    .number()
    .min(1)
    .max(10)
    .default(FLEET_DEFAULT_HEADROOM)
    .describe('The fleet default\'s multiplier on a service\'s largest hour outside its spikes. Default 2.'),
  limit: z.number().int().min(1).max(50).default(10).describe('Services listed, by spike cost. Default 10.'),
  site: z.string().optional().describe('Datadog site (e.g. `us5.datadoghq.com`). Defaults to DD_SITE, then `datadoghq.com`.'),
  budget_usd_monthly: z
    .number()
    .positive()
    .optional()
    .describe('X, a monthly Standard indexing budget for the whole account in dollars. Adds how far over it the account went in each month and each service\'s share of the overage.'),
  standard_indexes: z
    .array(z.string().min(1))
    .optional()
    .describe('With budget_usd_monthly: the index names that bill as Standard. Omit to count every index.'),
};

export interface DatadogSpikeAuditArgs {
  view?: 'markdown' | 'summary';
  lookback?: string;
  standard_rate_per_million?: number;
  ingestion_rate_per_gb?: number;
  spike_multiplier?: number;
  headroom?: number;
  limit?: number;
  site?: string;
  budget_usd_monthly?: number;
  standard_indexes?: string[];
}

export interface SpikeAuditDeps {
  /** Datadog keys. Undefined reads DD_API_KEY / DD_APP_KEY / DD_SITE; null means none. */
  creds?: DatadogMetricsCreds | null;
  nowMs?: () => number;
}

function inputError(hint: string): ChassisEnvelope {
  return buildChassisErrorEnvelope({
    tool: TOOL,
    err: { error_type: 'input_invalid', retryable: false, suggested_backoff_ms: null, hint },
  });
}

export async function executeDatadogSpikeAudit(args: DatadogSpikeAuditArgs, deps: SpikeAuditDeps = {}): Promise<ChassisEnvelope> {
  const strict = validateStrictArgs<DatadogSpikeAuditArgs>(TOOL, datadogSpikeAuditSchema, args);
  if (strict.error) return strict.error;
  const view = args.view ?? 'markdown';
  const lookbackDays = parseInt((args.lookback ?? '90d').replace(/d$/, ''), 10);
  if (!(lookbackDays > BASELINE_DAYS && lookbackDays <= MAX_LOOKBACK_DAYS)) {
    return inputError(`lookback must be between ${BASELINE_DAYS + 1}d and ${MAX_LOOKBACK_DAYS}d.`);
  }

  const creds = deps.creds === undefined ? datadogMetricsCredsFromEnv(args.site) : deps.creds ?? undefined;
  if (!creds) {
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: 'config_missing',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'Set DD_API_KEY and DD_APP_KEY (and DD_SITE when the org is not on datadoghq.com). The keys need read access to metrics only.',
      },
      source_disclosure: { siem_vendor: 'datadog' },
    });
  }

  const nowSec = Math.floor((deps.nowMs ? deps.nowMs() : Date.now()) / 1000 / 3600) * 3600;
  const fromSec = nowSec - lookbackDays * 86400;
  const telemetry = newChassisTelemetry();
  const events: DdPointSeries[] = [];
  const bytes: DdPointSeries[] = [];
  try {
    for (let start = fromSec; start < nowSec; start += CHUNK_DAYS * 86400) {
      const end = Math.min(nowSec, start + CHUNK_DAYS * 86400);
      const [ev, by] = await Promise.all([
        ddQueryPoints(creds, EVENTS_QUERY, start, end, QUERY_BUDGET.heavy),
        ddQueryPoints(creds, BYTES_QUERY, start, end, QUERY_BUDGET.heavy),
      ]);
      recordQuery(telemetry);
      recordQuery(telemetry);
      events.push(...ev);
      bytes.push(...by);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: /HTTP 40[13]/.test(msg) ? 'config_missing' : 'backend_error',
        retryable: !/HTTP 4\d\d/.test(msg),
        suggested_backoff_ms: /HTTP 4\d\d/.test(msg) ? null : 5000,
        hint: `Datadog metrics query failed at ${creds.site}: ${msg.slice(0, 240)}`,
      },
      telemetry,
      source_disclosure: { siem_vendor: 'datadog' },
    });
  }

  const audit = buildSpikeAudit(
    { fromSec, toSec: nowSec, events, bytes },
    {
      multiplier: args.spike_multiplier ?? SPIKE_MULTIPLIER,
      headroom: args.headroom ?? FLEET_DEFAULT_HEADROOM,
      ...(args.standard_rate_per_million !== undefined ? { standardUsdPerMillion: args.standard_rate_per_million } : {}),
      ...(args.ingestion_rate_per_gb !== undefined ? { ingestionUsdPerGb: args.ingestion_rate_per_gb } : {}),
      ...(args.budget_usd_monthly !== undefined ? { budgetUsdMonthly: args.budget_usd_monthly } : {}),
      ...(args.standard_indexes !== undefined ? { standardIndexes: args.standard_indexes } : {}),
    },
  );
  const markdown = renderSpikeAuditMarkdown(audit, {
    limit: args.limit ?? 10,
    standardRateSupplied: args.standard_rate_per_million !== undefined,
    ingestionRateSupplied: args.ingestion_rate_per_gb !== undefined,
  });
  const t = audit.totals;
  const noSignal = audit.servicesScanned === 0;
  const b = audit.budget;
  const overLine = b
    ? b.monthsOver > 0
      ? ` Against ${fmtAboutUsd(b.usdMonthly)} a month, ${budgetScopeWords(b)} went over in ${b.monthsOver} of ${b.months.length} months, by about ${fmtAboutUsd(b.overUsd)} by the usage metrics${b.services[0] ? `, ${Math.round(b.services[0].share * 100)}% of it from ${b.services[0].service}` : ''}.`
      : ` Against ${fmtAboutUsd(b.usdMonthly)} a month, ${budgetScopeWords(b)} stayed under in every month by the usage metrics.`
    : '';
  const headline = noSignal
    ? `No Datadog log usage series at ${creds.site} over the last ${lookbackDays} days.`
    : `${t.spikes} log spikes in ${audit.services.length} of ${audit.servicesScanned} services over ${Number(audit.judgedDays.toFixed(1))} days: ` +
      `${fmtAboutUsd(t.usd)}, about ${fmtAboutUsd(t.usdPerYear)} a year; a fleet default would have held ${fmtAboutUsd(t.heldUsd)} of it at most.` +
      overLine;
  const payload = { ...audit, site: creds.site, queries: { events: EVENTS_QUERY, bytes: BYTES_QUERY } };
  const rateSupplied = args.standard_rate_per_million !== undefined || args.ingestion_rate_per_gb !== undefined;

  return buildChassisEnvelope({
    tool: TOOL,
    view: view === 'markdown' ? 'markdown' : 'summary',
    headline,
    status: noSignal ? 'no_signal' : 'success',
    decisions: {
      threshold_used: args.spike_multiplier ?? SPIKE_MULTIPLIER,
      threshold_basis: args.spike_multiplier !== undefined ? 'customer_supplied' : 'default',
      threshold_audit: {
        value: args.spike_multiplier ?? SPIKE_MULTIPLIER,
        basis: `times the median of the same hour over the ${BASELINE_DAYS} days before`,
      },
    },
    source_disclosure: {
      bytes_source: 'siem_direct',
      rate_source: rateSupplied ? 'customer_supplied' : 'list_price',
      siem_vendor: 'datadog',
      source_label: `Datadog ${creds.site}, estimated usage metrics`,
    },
    scope: {
      window: `${audit.fromIso}/${audit.toIso}`,
      window_basis: args.lookback !== undefined ? 'explicit' : 'auto_default',
      candidates_count: audit.servicesScanned,
      candidates_usable: audit.services.length,
    },
    payload: view === 'markdown' ? { ...payload, markdown } : payload,
    human_summary: noSignal
      ? `No datadog.estimated_usage.logs series at ${creds.site} over the last ${lookbackDays} days. Check DD_SITE and that the keys read metrics.`
      : headline,
    ...(view === 'markdown' ? { must_render_verbatim: markdown } : {}),
    telemetry,
  });
}
