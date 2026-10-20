/**
 * Local-source POC tool: pulls log lines from kubectl or from local
 * files/globs and renders a cost-optimization report without touching
 * any log-analyzer API.
 *
 * Distinct from `log10x_poc_from_siem_submit`:
 *   - No vendor credentials needed (kubeconfig, or plain file reads)
 *   - Cost framing is an industry-pricing matrix (Datadog list,
 *     Splunk list, CloudWatch, OpenSearch), NOT a prediction of any
 *     specific bill — we only see the sampled slice, not
 *     CloudTrail / ALB logs / VM-hosted apps that the SIEM ingests
 *   - Synchronous (the pull is fast); no snapshot lifecycle
 *
 * `source: "file"` is the serverless-estate path: a host with no
 * cluster (100% Lambda shops, VMs, a downloaded log bundle) samples
 * from `paths` instead of pods.
 *
 * Sample-composition table forces the user to declare the sample
 * representative: "70% of bytes come from your-noisy-service" surfaces
 * up-front so the prospect can either confirm or widen scope before
 * trusting the savings projection.
 */

import { resolveEnforcingInstances } from '../lib/enforcing-instances.js';
import { promises as fs } from 'fs';
import * as nodePath from 'path';

import { z } from 'zod';

import {
  sampleFromFiles,
  sampleFromKubectl,
  type LocalSourceOptions,
  type LocalSourceResult,
} from '../lib/local-source.js';
import {
  sampleFromFile,
  resolveFileSpan,
  describeFileSpan,
  receiverExtractionInputs,
  containerOrder,
  captureEventSource,
  captureEventSourceSentence,
  FileSpanRefusal,
  type FileSpan,
} from '../lib/local-file-source.js';
import { receiverBytesStatement } from '../lib/receiver-bytes.js';
import { renderNativeControlSection, controlPatterns } from '../lib/datadog-native-control.js';
import { extractPatterns, pipelineSplitAttribute } from '../lib/pattern-extraction.js';
import { DevCliNotInstalledError, type RoundTripResult } from '../lib/dev-cli.js';
import { tenxAvailabilityShortHint } from '../lib/install-hints.js';
import { fmtBytes, fmtCount, fmtDollar, fmtPct } from '../lib/format.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';
import type { PrimitiveError } from '../lib/primitive-errors.js';
import { DEFAULT_ANALYZER_COST_PER_GB, SIEM_DISPLAY_NAMES, defaultRateNote, type SiemId } from '../lib/siem/pricing.js';
import { _enrichForEnvelope, type RenderInput } from '../lib/poc-report-renderer.js';
import {
  buildReportData,
  ReportRefusal,
  CAPS_FILE_NAME,
  ACTIONS_FILE_NAME,
  type FleetDefaultReport,
} from '../lib/report/build-report-data.js';
import { solvePlan, type Plan, type PlanTarget } from '../lib/plan-solver.js';
import { checkRuleDependencies, dependencyRulesFromPlan, fleetDefaultDependencyRules } from '../lib/plan-dependencies.js';
import { renderReportHtml } from '../lib/report/html-template-v1.js';
import { readClientVersion } from '../lib/manifest.js';
import { isFenced, fencedOffer, fencedVerification } from '../lib/fenced.js';

const MCP_VERSION = readClientVersion();

export const REPORT_FILE_NAME = 'log10x-poc-report.html';

/**
 * Markdown copy of the plan, written alongside the HTML report in the fenced
 * profile only.
 *
 * The fenced profile's honest residual is that the ANSWER leaves the fence —
 * any tool that answers leaks its answer, and the plan is read by a human in
 * a chat window that is not inside the container. Nothing can change that.
 * What can change is where the detail lives: the full plan lands on the
 * mounted output directory as a file the user controls, so the chat transcript
 * does not have to be the only copy, and a user who wants to keep pattern
 * bodies off a hosted model's context has somewhere to read them instead.
 */
export const PLAN_FILE_NAME = 'plan.md';

/** Kept rows a tool response carries: the costliest, since the rest are the long tail the plan leaves alone. */
export const RESPONSE_KEPT_ROWS = 20;

/**
 * The plan as a tool response carries it. Every kept row (thousands on a real
 * capture, over a megabyte) would fill an agent's context, so the response
 * keeps the costliest RESPONSE_KEPT_ROWS and counts the rest; the report and
 * the engine files are built from the full plan.
 */
export function planForResponse(plan: Plan): Plan {
  if (plan.kept.length <= RESPONSE_KEPT_ROWS) return plan;
  const kept = [...plan.kept].sort((a, b) => b.billUsd - a.billUsd).slice(0, RESPONSE_KEPT_ROWS);
  return { ...plan, kept, keptTotal: plan.kept.length, keptOmitted: plan.kept.length - kept.length };
}

const SIEM_IDS = [
  'cloudwatch', 'datadog', 'sumo', 'gcp-logging', 'elasticsearch',
  'azure-monitor', 'splunk', 'clickhouse', 'coralogix', 'elastic-serverless',
] as const;

export const pocFromLocalSchema = {
  source: z
    .enum(['kubectl', 'file'])
    .optional()
    .default('kubectl')
    .describe(
      'Where to pull log lines from. `kubectl` samples pod logs; `file` samples local logs: ' +
        'pass `paths` (files, directories, globs) or `path` (one file; fluentd/k8s/docker-wrapped ' +
        'JSONL is detected and normalized before the engine sees it). ' +
        '`docker` and `journald` are follow-up work.'
    ),
  path: z
    .string()
    .optional()
    .describe(
      'One local log file to analyse (source=`file`). Wrapped JSONL is normalized so the engine ' +
        'patterns payloads, not wrappers. For many files or globs use `paths` instead.'
    ),
  siem: z
    .enum(SIEM_IDS)
    .optional()
    .describe(
      'The destination SIEM, used for the report header chip and command selection. ' +
        'When absent the analysis assumes CloudWatch and the report labels the assumption.'
    ),
  forwarder: z
    .string()
    .optional()
    .describe(
      'Forwarder in the pipeline (fluentd, fluent-bit, filebeat, logstash, otel-collector, vector, hec). ' +
        'Used to pick verified apply/undo commands. Not guessed when absent: the report says commands are unavailable.'
    ),
  workload: z
    .string()
    .optional()
    .describe('Forwarder workload name (daemonset/deployment) for the apply commands. Not guessed when absent.'),
  report_annotations: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Optional one-sentence annotations keyed by evidence statement identifier, rendered under the matching ' +
        'action. Hard cap 140 chars each; over-cap or unknown-hash input refuses the render (nothing is truncated).'
    ),
  namespace: z
    .string()
    .optional()
    .default('default')
    .describe(
      'Kubernetes namespace to sample from (`source: kubectl` only). Pass `*` to sample across all namespaces. Default `default`.'
    ),
  paths: z
    .array(z.string())
    .optional()
    .describe(
      'Required for `source: file`: files, directories, or glob patterns (`*`, `**`, `?`) to sample, ' +
        'e.g. `["/var/log/app/*.log", "./bundle/**"]`. A directory is read one level deep; use `dir/**` for the tree.'
    ),
  window: z
    .string()
    .optional()
    .describe(
      'How far back to read per pod (`source: kubectl`, default `1h`). For `source: file`, the time span ' +
        'the files cover: read from the first and last record timestamps when the records carry them, and ' +
        'from `window` when they do not. With neither, a file run refuses rather than assume a span. ' +
        'Accepts `30m`, `10h`, `7d`, etc.'
    ),
  per_pod_limit: z
    .number()
    .min(100)
    .max(50_000)
    .optional()
    .default(5000)
    .describe('Cap on log lines pulled per pod. Default 5000.'),
  max_pods: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .default(20)
    .describe('Cap on number of pods sampled. Default 20.'),
  fleet_default: z
    .object({
      headroom: z.number().min(1).max(10).optional().describe('Multiplier on the largest kept per-node cell of the capture. Default 2.'),
      action: z
        .enum(['tier_down', 'offload'])
        .optional()
        .describe('Where a statement above the limit goes: `tier_down` (Flex on Datadog, the default) or `offload` (S3).'),
      error_floor: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Share of ERROR and CRITICAL lines above the limit kept in Standard. Default 0.5 with offload, 0 with tier_down.'),
    })
    .optional()
    .describe(
      'Set the fleet default from this capture: the limit for every service the plan gives no row, the largest statement the plan keeps per node times the headroom. The report states it in lines a day, and `fleet_default.cap_bytes_per_window_per_node` in the result is the value `log10x_advise_install` writes. On Datadog, the dependency check also lists the log monitors and log-based metrics of the services it covers, error monitors included.'
    ),
  record_overhead_bytes: z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .optional()
    .describe(
      'Bytes of forwarder metadata per record, for a capture that carries the log text only (a kubectl sample or plain lines). The Receiver counts each record as the forwarder sends it, metadata included, so the caps add this to every line. Default 760, the median of a Fluent Bit kubernetes record on an EKS capture. A file of the forwarder\'s own JSON records is measured instead.'
    ),
  check_dependencies: z
    .boolean()
    .optional()
    .describe(
      'Datadog only, default true: before the plan moves statements off Standard, read the account\'s log monitors and log-based metrics (read-only GETs, needs DD_API_KEY + DD_APP_KEY in the session) and print beside each service line the ones whose query reads its moved lines. Set false to skip the read.'
    ),
  retriever_installed: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Whether the prospect will install the S3 retriever. Gates the offload rung of the plan ladder: ' +
        'without it offloaded events would be unreachable, so the plan stops at the in-SIEM levers and ' +
        'the gap names "install the retriever" as the keep-everything remedy. Set from conversation.'
    ),
  allow_lossy: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Permit sample/drop (lossy) to close a keep-everything shortfall. Default false: the plan stops at ' +
        'the keep-everything ceiling and reports the gap. Only set after the user explicitly chooses loss.'
    ),
  target_percent_reduction: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'Customer-specified target reduction percent. If absent, POC produces a recommendation-only output. ' +
        'If present, POC produces a feasibility verdict + a pre-deploy commitment artifact stub the agent ' +
        'can surface alongside the per-pod savings matrix. The cap CSV is attached by a later change.'
    ),
  budget_usd_monthly: z
    .number()
    .positive()
    .optional()
    .describe(
      'DOLLAR BUDGET: keep the projected monthly bill on the assumed SIEM at or under this $/mo. The ' +
        'sample is scaled to a 30-day month (kubectl window, or the file span) before solving, so ' +
        'the budget and the bill share a denominator. Mutually exclusive with target_percent_reduction ' +
        'and budget_gb_monthly.'
    ),
  budget_gb_monthly: z
    .number()
    .positive()
    .optional()
    .describe(
      'VOLUME BUDGET: keep projected monthly ingest at or under this many GB/mo. BYTE accounting: ' +
        'tier_down keeps every byte and is excluded from the ladder for this target. Sample scaled to a ' +
        '30-day month before solving. Mutually exclusive with target_percent_reduction and budget_usd_monthly.'
    ),
  exception_services: z
    .array(z.string())
    .optional()
    .describe(
      'Services / pods flagged by the customer to stay in the log analyzer with full retention (action=pass). ' +
        'Their bytes are subtracted from the achievable reduction pool used for the feasibility verdict. ' +
        'Matched case-insensitively against the pod / source name.'
    ),
  splunk_pricing: z
    .enum(['ingest', 'workload'])
    .optional()
    .describe(
      'Splunk only: `ingest` (bytes per day) prices compact; `workload` (vCPU) meters compute, where compaction ' +
        'is not a saving and compact leaves the lever set. Set from what the user said; absent means ingest.'
    ),
  enterprise_security: z
    .boolean()
    .optional()
    .describe(
      'Splunk only: whether Enterprise Security or any CIM data model reads this estate. True or absent keeps ' +
        'the add-on sourcetypes raw. Pass false only when the user states it. On a kubectl or file sample the ' +
        'services are containers or files, not sourcetypes, so the rule fires only where a service is named ' +
        'after its Splunk sourcetype.'
    ),
  pin_services: z
    .record(z.string(), z.enum(['pass','sample','compact','tier_down','offload','drop']))
    .optional()
    .describe(
      'Primary per-pod/source override surface. Map of pod / source name to action. Pins are applied AFTER ' +
        'the destination default and AFTER exception_services. Feasibility reruns with the pins; ' +
        'max_achievable shifts and reason cites the pins.'
    ),
  pin_patterns: z
    .record(z.string(), z.enum(['pass','sample','compact','tier_down','offload','drop']))
    .optional()
    .describe(
      'Advanced: most customers will not need this. Map of pattern_hash to action for rare per-pattern ' +
        'overrides within a pod / source. Applied AFTER pin_services.'
    ),
};

export interface PocFromLocalArgs {
  source?: 'kubectl' | 'file';
  path?: string;
  siem?: SiemId;
  forwarder?: string;
  workload?: string;
  report_annotations?: Record<string, string>;
  namespace?: string;
  paths?: string[];
  window?: string;
  per_pod_limit?: number;
  max_pods?: number;
  ai_prettify?: boolean;
  retriever_installed?: boolean;
  /** Datadog only, default true: list the log monitors and log-based metrics that read each rule's moved lines. */
  check_dependencies?: boolean;
  /** Forwarder metadata bytes per record when the capture carries the log text only. */
  record_overhead_bytes?: number;
  /** Set the fleet default from this capture. */
  fleet_default?: { headroom?: number; action?: 'tier_down' | 'offload'; error_floor?: number };
  allow_lossy?: boolean;
  target_percent_reduction?: number;
  budget_usd_monthly?: number;
  budget_gb_monthly?: number;
  exception_services?: string[];
  splunk_pricing?: 'ingest' | 'workload';
  enterprise_security?: boolean;
  pin_services?: Record<string, 'pass'|'sample'|'compact'|'tier_down'|'offload'|'drop'>;
  pin_patterns?: Record<string, 'pass'|'sample'|'compact'|'tier_down'|'offload'|'drop'>;
}

/**
 * Feasibility / commitment shape mirrored from poc-envelope-v2. Local
 * POC produces its own struct (no SIEM destination) but holds the same
 * field names so a downstream renderer can switch on either source.
 */
interface LocalFeasibility {
  feasible: boolean;
  /** For budget targets this is the DERIVED reduction percent the solver chased. */
  target_percent_reduction: number;
  budget_usd_monthly?: number;
  budget_gb_monthly?: number;
  max_achievable_percent: number;
  reason: string;
  exception_services: string[];
  exception_share_of_bytes: number;
}

interface LocalCommitmentArtifact {
  markdown: string;
  next_step: { tool: 'log10x_advise_install' | 'log10x_configure_engine'; reason: string };
}

export interface PriceRow {
  vendor: string;
  perGb: number;
  note: string;
}

// The no-env matrix cannot resolveRate, so its figures come from the canonical
// defaults (DEFAULT_ANALYZER_COST_PER_GB), and each note says what the figure
// is: a list price only where the vendor sells logs per GB.
export const INDUSTRY_PRICING: PriceRow[] = [
  { vendor: 'Datadog', perGb: DEFAULT_ANALYZER_COST_PER_GB.datadog, note: `default rate, ${defaultRateNote('datadog')}` },
  { vendor: 'Splunk', perGb: DEFAULT_ANALYZER_COST_PER_GB.splunk, note: 'default rate, not a Splunk list price' },
  { vendor: 'CloudWatch Logs', perGb: DEFAULT_ANALYZER_COST_PER_GB.cloudwatch, note: 'ingestion + first-month storage' },
  { vendor: 'Azure Monitor', perGb: DEFAULT_ANALYZER_COST_PER_GB['azure-monitor'], note: 'Analytics tier ingest, list price' },
  { vendor: 'Sumo Logic', perGb: DEFAULT_ANALYZER_COST_PER_GB.sumo, note: 'default rate, not a Sumo Logic list price' },
  { vendor: 'Elasticsearch', perGb: DEFAULT_ANALYZER_COST_PER_GB.elasticsearch, note: `default rate, ${defaultRateNote('elasticsearch')}` },
  { vendor: 'Coralogix', perGb: DEFAULT_ANALYZER_COST_PER_GB.coralogix, note: 'Frequent Search (High) priority, list price' },
  { vendor: 'Elastic Cloud Serverless', perGb: DEFAULT_ANALYZER_COST_PER_GB['elastic-serverless'], note: 'Logs Essentials ingest floor; retention billed separately' },
  { vendor: 'OpenSearch', perGb: 0.1, note: 'self-hosted compute baseline (no canonical list rate)' },
];

/** At most `max` characters, cut at a word boundary, with an ellipsis-free "(cut)" marker when shortened. */
export function clipAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const at = head.lastIndexOf(' ');
  return `${(at > max * 0.6 ? head.slice(0, at) : head).replace(/[\s,;:.]+$/, '')} (cut)`;
}

export async function executePocFromLocal(args: PocFromLocalArgs): Promise<StructuredOutput> {
  const telemetry = newTelemetry();
  let inner: Awaited<ReturnType<typeof executePocFromLocalInner>>;
  try {
    inner = await executePocFromLocalInner(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof FileSpanRefusal) {
      const err: PrimitiveError = { error_type: 'missing_input', retryable: false, suggested_backoff_ms: null, hint: msg };
      const human_summary = `poc_from_local refused: ${msg}`;
      return buildEnvelope({
        tool: 'log10x_poc_from_local',
        view: 'summary',
        summary: { headline: 'POC from files refused: the files carry no time span' },
        data: {
          events_pulled: 0,
          ...buildUnifiedFields({ status: 'error', telemetry, humanSummary: human_summary, error: err }),
          human_summary,
        },
      });
    }
    // A kubectl/cluster failure on a host that has no cluster is NOT a
    // transient backend outage — retrying cannot fix an estate that is not
    // Kubernetes. Classify it as environment misconfiguration and say what
    // to do instead (the earlier classification returned
    // `backend_unavailable` + retryable:true, sending agents into a retry
    // loop against a cluster that does not exist).
    const noCluster = /kubectl|kubeconfig|cluster/i.test(msg);
    const noEngine = e instanceof DevCliNotInstalledError;
    const err: PrimitiveError = {
      error_type: noCluster || noEngine ? 'config_missing' : 'local_processing_failed',
      retryable: false,
      suggested_backoff_ms: null,
      hint: noEngine
        ? tenxAvailabilityShortHint()
        : noCluster
        ? `No Kubernetes cluster is reachable from this host (${clipAtWord(msg, 160)}). ` +
          'If this estate is serverless or file-based, re-run with source:"file" and paths:[...] ' +
          'against local log files: do not retry the kubectl path.'
        : clipAtWord(msg, 400),
    };
    const human_summary = `poc_from_local failed: ${err.hint}`;
    return buildEnvelope({
      tool: 'log10x_poc_from_local',
      view: 'summary',
      summary: { headline: `POC from local source failed: ${err.error_type}` },
      data: {
        events_pulled: 0,
        ...buildUnifiedFields({ status: 'error', telemetry, humanSummary: human_summary, error: err }),
        human_summary,
      },
    });
  }
  const hasData = inner.events_pulled > 0;
  const srcNoun = inner.source === 'file' ? 'file' : 'pod';
  // Headline leads with percent reduction (universal, vendor-independent),
  // followed by the volume context, then a trailing "at list price" dollar
  // band so the cost framing stays explicitly list-priced — not a customer-
  // specific quote we cannot honestly produce from a local sample.
  // When a target was asked and a plan solved, the plan IS the headline — the
  // same sentence family estimate_savings leads with, so the two paths read
  // identically in the agent's chat. The byte-range framing remains for the
  // no-target exploratory run.
  const pl = inner.plan;
  const sampledNote = `Sampled ${inner.events_pulled.toLocaleString()} events from ${inner.pods_sampled} ${srcNoun}${inner.pods_sampled !== 1 ? 's' : ''}, projected to a 30-day month.`;
  const fmtBudgetUsd = (v: number) => '$' + Number(v.toFixed(2)).toString();
  const headline = hasData && pl
    ? (pl.target.kind === 'usd_budget'
        ? (pl.met && pl.planned.length === 0
            ? `Budget: keep the ${pl.destination} bill under ${fmtBudgetUsd(pl.target.value)}/mo. Already under: the projected bill is ${fmtBudgetUsd(pl.billUsd)}/mo. No action needed. ${sampledNote}`
            : (pl.met
              ? `Budget: keep the ${pl.destination} bill under ${fmtBudgetUsd(pl.target.value)}/mo. This plan lands at ${fmtBudgetUsd(pl.landsAtUsd ?? pl.billUsd)}/mo (projected today: ${fmtBudgetUsd(pl.billUsd)}/mo), keeping everything. ${sampledNote}`
              : `Budget: keep the ${pl.destination} bill under ${fmtBudgetUsd(pl.target.value)}/mo. This plan lands at ${fmtBudgetUsd(pl.landsAtUsd ?? pl.billUsd)}/mo. ${pl.gap ? pl.gap.message : ''}`) +
              // Datadog Flex: on a scalable tier the landing counts priced lines only; say so.
              (pl.perEventMove ? `${pl.perEventMove.unpriced ? ' Counts priced lines only.' : ''} ${pl.perEventMove.text}` : ''))
        : pl.target.kind === 'gb_budget'
          ? (pl.met && pl.planned.length === 0
              ? `Budget: keep ingest toward ${pl.destination} under ${fmtBytes(pl.target.value * 1_000_000_000)}/mo. Already under: projected ingest is ${fmtBytes(pl.landsAtBytesMonthly ?? 0)}/mo. No action needed. ${sampledNote}`
              : pl.met
                ? `Budget: keep ingest toward ${pl.destination} under ${fmtBytes(pl.target.value * 1_000_000_000)}/mo. This plan lands at ${fmtBytes(pl.landsAtBytesMonthly ?? 0)}/mo, keeping everything. ${sampledNote}`
                : `Budget: keep ingest toward ${pl.destination} under ${fmtBytes(pl.target.value * 1_000_000_000)}/mo. This plan lands at ${fmtBytes(pl.landsAtBytesMonthly ?? 0)}/mo. ${pl.gap ? pl.gap.message : ''}`)
        : pl.percentBasis === 'standard_index_volume'
          // Datadog: volume out of the Standard index; no share of the bill
          // is stated for a Flex move, whose compute is unpriced.
          ? (pl.met
              ? `Target: move ${pl.targetPct}% of the volume out of the Datadog Standard index. This plan moves ${pl.achievedPct.toFixed(0)}%, keeping everything. Sampled ${inner.events_pulled.toLocaleString()} events from ${inner.pods_sampled} ${srcNoun}${inner.pods_sampled !== 1 ? 's' : ''}.`
              : `Target: move ${pl.targetPct}% of the volume out of the Datadog Standard index. Keeping everything, this plan moves ${pl.achievedPct.toFixed(0)}% (ceiling ${pl.keepEverythingCeilingPct.toFixed(0)}%). ${pl.gap ? pl.gap.message : ''}`) +
            (pl.perEventMove ? ` ${pl.perEventMove.text}` : '')
        : pl.met
          ? `Target: cut ${pl.targetPct}% of the ${pl.destination} bill. This plan reaches ${pl.achievedPct.toFixed(0)}%, keeping everything. Sampled ${inner.events_pulled.toLocaleString()} events from ${inner.pods_sampled} ${srcNoun}${inner.pods_sampled !== 1 ? 's' : ''}.`
          : `Target: cut ${pl.targetPct}% of the ${pl.destination} bill. Keeping everything, this plan reaches ${pl.achievedPct.toFixed(0)}% (ceiling ${pl.keepEverythingCeilingPct.toFixed(0)}%). ${pl.gap ? pl.gap.message : ''}`)
    : hasData
    ? `POC from ${inner.source}: non-error, high-frequency statements carry ${Math.round(inner.daily_pct_reduction_expected ?? 0)}% of the bytes across ${inner.distinct_patterns} pattern${inner.distinct_patterns !== 1 ? 's' : ''} (${inner.events_pulled.toLocaleString()} events from ${inner.pods_sampled} ${srcNoun}${inner.pods_sampled !== 1 ? 's' : ''}): the candidates a plan can compact, tier down or offload. No plan is made without a target; pass target_percent_reduction or a budget. At list prices and default rates this volume costs ${fmtDollar(inner.daily_dollar_projection_low ?? 0)}-${fmtDollar(inner.daily_dollar_projection_high ?? 0)} a day across vendors.`
    : inner.source === 'file'
      ? 'POC from files: no log lines pulled. Check the paths / glob patterns.'
      : 'POC from kubectl: no log lines pulled. Check namespace + pod filter.';
  const human_summary = buildHumanSummary(inner, hasData);
  return buildEnvelope({
    tool: 'log10x_poc_from_local',
    view: 'summary',
    summary: { headline },
    data: { ...inner, ...buildUnifiedFields({ status: hasData ? 'success' : 'no_signal', telemetry, humanSummary: human_summary }), human_summary },
    actions: hasData
      ? [
          { tool: 'log10x_resolve_batch', args: { source: 'text', text: '...' }, reason: 'run the same sample through resolve_batch for per-pattern variable concentration + next actions' },
          // The fenced alternative rides along on every run that had network,
          // as an `alternative` rather than a `recommended-next`: the POC is
          // finished, and an agent told to do this next would go and redo it.
          ...(inner.fenced_offer ? [inner.fenced_offer.action] : []),
        ]
      : [],
  });
}

// Three sentences max, plain prose. POC is always list-price — kubectl
// sample → industry pricing matrix, no customer rate involved — so
// dollar figures are allowed per the §C rate_source rule.
function buildHumanSummary(inner: PocFromLocalInner, hasData: boolean): string {
  if (!hasData) {
    return inner.source === 'file'
      ? `POC from files pulled 0 log lines. Either no files matched the supplied paths, or the matched files were empty. Check the glob patterns (a directory is read one level deep; use dir/** for the tree) and re-run.`
      : `POC from kubectl pulled 0 log lines across the requested window. Either no pods matched the namespace + pod filter, or kubectl is not reachable. Confirm the namespace and re-run with a wider window or pod selector.`;
  }
  const srcNoun = inner.source === 'file' ? 'file' : 'pod';
  const dlo = fmtDollar(inner.daily_dollar_projection_low ?? 0);
  const dhi = fmtDollar(inner.daily_dollar_projection_high ?? 0);
  const base = `Sampled ${inner.events_pulled.toLocaleString()} events from ${inner.pods_sampled} ${srcNoun}${inner.pods_sampled !== 1 ? 's' : ''} (${fmtBytes(inner.total_bytes)}) covering ${inner.distinct_patterns} distinct pattern${inner.distinct_patterns !== 1 ? 's' : ''}. Non-error, high-frequency statements carry ${Math.round(inner.daily_pct_reduction_expected ?? 0)}% of the bytes: the candidates a plan can compact, tier down or offload. At list prices and default rates the same volume costs roughly ${dlo}-${dhi}/day across vendors.`;
  const withRoundTrip = inner.round_trip ? `${base} ${describeRoundTrip(inner.round_trip)}` : base;
  if (inner.report_path) {
    return `${withRoundTrip} The action-plan report was written to ${inner.report_path}; open it in a browser.`;
  }
  return withRoundTrip;
}

interface PocFromLocalInner {
  ok: boolean;
  source: 'kubectl' | 'file';
  /** Absolute path of the written report.html deliverable. */
  report_path?: string;
  /**
   * Absolute path of the markdown plan, written in the fenced profile only.
   * See PLAN_FILE_NAME: the fence cannot stop the answer from reaching the
   * human who asked for it, so it puts the full detail on the user's own
   * mounted directory rather than leaving the transcript as the only copy.
   */
  plan_path?: string;
  /**
   * True when this POC ran inside the fenced profile. Present on every run so
   * an agent can say which mode produced the numbers without inferring it.
   */
  fenced_profile?: boolean;
  /** The fenced run's own proof: the inspect one-liner, its expected output, the Wi-Fi check. */
  fenced_verification?: { inspect_command: string; inspect_expected: string; wifi_check: string; markdown: string };
  /**
   * The offer a non-fenced run makes. Built once, inside the run that knows
   * which analyzer and window it used, and reused verbatim as the `actions[]`
   * entry — so the sentence the user reads and the call the agent would make
   * cannot describe different things.
   */
  fenced_offer?: {
    disclosure: string;
    action: { tool: string; args: Record<string, unknown>; reason: string; role: 'alternative' };
  };
  /** Absolute path of the caps CSV the report's apply commands reference. */
  report_caps_path?: string;
  /** Absolute path of the sibling actions CSV. */
  report_actions_path?: string;
  /**
   * The two files the engine reads, verbatim, with the span the plan's byte
   * figures cover: a cap row is bytes per `reset_window_seconds`, scaled from
   * that span.
   */
  /** The fleet default this capture sets, when `fleet_default` was passed. */
  fleet_default?: FleetDefaultReport;
  engine_policy?: {
    caps_csv: string;
    actions_csv: string;
    span_seconds: number;
    /** Where `span_seconds` came from. */
    span_source: 'timestamps' | 'window' | 'budget_month';
    reset_window_seconds: number;
    unattributed_planned: number;
  };
  /** `source: file` only: the span the files cover and where it came from. */
  span?: {
    seconds: number;
    source: 'timestamps' | 'window';
    statement: string;
    first_timestamp?: string;
    last_timestamp?: string;
    records_with_timestamp: number;
    records_sampled: number;
  };
  /** Honest note when report generation was skipped or degraded. */
  report_note?: string;
  /** `-` for source: file (no namespace concept). */
  namespace: string;
  /** The kubectl pull window; for a file, the `window` argument as passed, or `-`. */
  window: string;
  pods_sampled: number;
  pods_failed: number;
  events_pulled: number;
  total_bytes: number;
  distinct_patterns: number;
  daily_gb_projection: number;
  daily_dollar_projection_low?: number;
  daily_dollar_projection_high?: number;
  // Per spec § percent-first: surface the reduction band as a percent
  // alongside the dollar band. Computed from droppable-bytes / total-bytes
  // with a +/- envelope to model heuristic uncertainty without leaking
  // single-point precision.
  daily_pct_reduction_low?: number;
  daily_pct_reduction_expected?: number;
  daily_pct_reduction_high?: number;
  // Local-source POC only ever quotes list price — no customer-supplied
  // rate path exists here (we sampled their cluster, not their bill).
  rate_source: 'list_price';
  notes: string[];
  markdown: string;
  /** Populated only when target_percent_reduction was supplied on submit. */
  feasibility?: LocalFeasibility;
  /** The shared ladder plan (same object estimate_savings emits) — pattern-first,
   *  dollar-denominated, with the keep-everything ceiling and the honest gap. */
  plan?: Plan;
  commitment_artifact?: LocalCommitmentArtifact;
  /**
   * The decode pass over this sample: every compact record expanded by the
   * engine and compared with the text it was given.
   */
  round_trip?: RoundTripResult;
}

async function executePocFromLocalInner(args: PocFromLocalArgs): Promise<PocFromLocalInner> {
  const source = args.source ?? 'kubectl';
  if (source !== 'kubectl' && source !== 'file') {
    throw new Error(
      `source "${source}" not yet supported. Only "kubectl" and "file" are implemented; "docker" and "journald" are follow-up work.`
    );
  }
  const startedAtIso = new Date().toISOString();

  const opts: LocalSourceOptions = {
    namespace: args.namespace ?? 'default',
    window: args.window ?? '1h',
    perPodLimit: args.per_pod_limit ?? 5000,
    maxPods: args.max_pods ?? 20,
  };

  let sample: LocalSourceResult;
  /** What extractPatterns consumes. The single-file lane hands over the
   * PARSED wrapper records — the input-normalization step: the coercion
   * layer unwraps the `log` payload for the templater while the envelope
   * enrichment keeps container/service attribution. The glob and kubectl
   * lanes feed raw lines, which is what those sources actually carry. */
  let extractionInput: unknown[];
  let rawIngestBytes: number | undefined;
  /** On-disk bytes per sampled record, so patterns carry the size a platform bills. */
  let lineRawBytes: number[] | undefined;
  /** File bytes over sampled bytes: a strided sample's rates scaled to the whole file. */
  let sampleScale = 1;
  if (source === 'file') {
    if (args.path) {
      const fileSample = await sampleFromFile(args.path);
      sample = fileSample;
      extractionInput = fileSample.records;
      rawIngestBytes = fileSample.normalized ? fileSample.rawBytes : undefined;
      lineRawBytes = fileSample.lineRawBytes;
      sampleScale = fileSample.sampledRawBytes > 0 ? fileSample.rawBytes / fileSample.sampledRawBytes : 1;
    } else if (args.paths && args.paths.length > 0) {
      // per_pod_limit / max_pods double as per-file / max-file caps — same
      // budget, different source grain.
      sample = await sampleFromFiles({
        paths: args.paths,
        perFileLimit: args.per_pod_limit ?? 5000,
        maxFiles: args.max_pods ?? 20,
      });
      extractionInput = sample.events;
      if (sample.rawBytes && sample.sampledRawBytes) sampleScale = sample.rawBytes / sample.sampledRawBytes;
    } else {
      throw new Error(
        'source "file" requires `path` (one file, wrapper-normalized) or `paths` (files, directories, globs).'
      );
    }
  } else {
    sample = await sampleFromKubectl(opts);
    extractionInput = sample.events;
  }

  const srcNoun = source === 'file' ? 'file' : 'pod';
  const namespaceOut = source === 'file' ? '-' : opts.namespace!;
  const windowOut = source === 'file' ? (args.window ?? '-') : opts.window!;

  if (sample.events.length === 0) {
    const lines: string[] = [`## Log10x POC: local source (${source})`, ''];
    lines.push('**No log lines were pulled.**');
    lines.push('');
    if (sample.notes.length > 0) {
      lines.push('### Notes');
      for (const note of sample.notes) lines.push(`- ${note}`);
      lines.push('');
    }
    if (sample.failedSources.length > 0) {
      lines.push(`### Failed ${srcNoun}s`);
      for (const f of sample.failedSources.slice(0, 10)) lines.push(`- ${f}`);
      if (sample.failedSources.length > 10) {
        lines.push(`- ... and ${sample.failedSources.length - 10} more`);
      }
    }
    return {
      ok: false,
      source,
      namespace: namespaceOut,
      window: windowOut,
      pods_sampled: 0,
      pods_failed: sample.failedSources.length,
      events_pulled: 0,
      total_bytes: 0,
      distinct_patterns: 0,
      daily_gb_projection: 0,
      rate_source: 'list_price',
      notes: sample.notes,
      markdown: lines.join('\n'),
    };
  }

  // Resolved before the engine runs, so a file with no span refuses at once.
  const fileSpan: FileSpan | undefined = source === 'file' ? resolveFileSpan(extractionInput, args.window) : undefined;
  const fileSpanStatement = fileSpan ? describeFileSpan(fileSpan, 1 / sampleScale) : undefined;

  // Each event in the Receiver's unit: the forwarder's record where the
  // capture carries it, else the payload plus the assumed metadata. The
  // records go to the templater grouped by container, so a continuation line
  // joins its own container's line, as it does in the Receiver.
  const order = containerOrder(extractionInput);
  const inOrder = <T,>(a: T[]): T[] => order.map((i) => a[i]);
  const receiverInputs = receiverExtractionInputs(extractionInput);
  const extraction = await extractPatterns(inOrder(extractionInput), {
    ...(lineRawBytes ? { lineRawBytes: inOrder(lineRawBytes) } : {}),
    lineRecordBytes: inOrder(receiverInputs.lineRecordBytes),
    linePayloadJsonBytes: inOrder(receiverInputs.linePayloadJsonBytes),
    lineTimesMs: inOrder(receiverInputs.lineTimesMs),
    ...(args.record_overhead_bytes !== undefined ? { recordOverheadBytes: args.record_overhead_bytes } : {}),
    // The Datadog report sets native index filters against the plan, which
    // needs each pattern's events by service, status and parsed attribute.
    cells: args.siem === 'datadog',
    // A file read before Datadog's intake has no parsed attributes; the Kafka
    // pipeline's logger.name is read from the event's text instead.
    ...(args.siem === 'datadog' ? { pipelineSplitAttribute } : {}),
    // The savings figure is only worth quoting beside the proof that the
    // compact form gives the text back.
    verifyRoundTrip: true,
  });

  // Hours the sampled bytes stand for: a file's span shrinks by the share of
  // its bytes the sample holds.
  const windowHours = fileSpan ? fileSpan.seconds / 3600 / sampleScale : parseWindowHours(opts.window!);
  // Project the sampled-window bytes to a daily figure.
  const sampleGb = sample.totalBytes / 1024 ** 3;
  const dailyGbProjected = sampleGb * (24 / Math.max(0.001, windowHours));

  // Estimate per-pattern compaction so the savings matrix has real
  // signal, not a constant ratio. Heuristic: compact bytes per event
  // approximate template-bytes amortized + variable-fraction-per-event.
  const patterns = extraction.patterns;
  const totalEvents = extraction.totalEvents || 1;
  const droppableBytes = patterns
    .filter((p) => p.count / totalEvents >= 0.01) // top-of-distribution
    .filter((p) => !/ERROR|CRIT|FATAL|WARN/i.test(p.severity ?? ''))
    .reduce((s, p) => s + p.bytes, 0);
  const droppableFraction = sample.totalBytes > 0 ? droppableBytes / sample.totalBytes : 0;

  const lines: string[] = [];
  lines.push(`# Log10x POC: local source (${source})`);
  lines.push('');
  lines.push(
    source === 'file'
      ? `_Pulled ${fmtCount(sample.events.length)} log lines (${fmtBytes(sample.totalBytes)}) across ${sample.composition.length} file${sample.composition.length === 1 ? '' : 's'}. ${fileSpanStatement}_`
      : `_Pulled ${fmtCount(sample.events.length)} log lines (${fmtBytes(sample.totalBytes)}) across ${sample.composition.length} pod${sample.composition.length === 1 ? '' : 's'} in namespace \`${opts.namespace}\` over the last ${opts.window}._`
  );
  lines.push('');

  if (extraction.roundTrip) {
    lines.push('## Round trip');
    lines.push('');
    lines.push(describeRoundTrip(extraction.roundTrip));
    lines.push('');
  }

  // Section: sample composition (Opus-recommended trust pre-emption).
  lines.push('## Sample composition');
  lines.push('');
  lines.push(
    source === 'file'
      ? 'These files produced the bytes in the sample. **Confirm this looks like your production mix before trusting the projection**: if 70% of your real-prod bytes come from a service that is NOT in this list, the savings projection is meaningless to you. Widen `paths` or raise `max_pods` (the file cap) if anything looks off.'
      : 'These pods produced the bytes in the sample. **Confirm this looks like your production mix before trusting the projection**: if 70% of your real-prod bytes come from a service that is NOT in this list, the savings projection is meaningless to you. Widen with `namespace: "*"` or a longer `window` if anything looks off.'
  );
  lines.push('');
  lines.push(`| ${source === 'file' ? 'File' : 'Pod'} | Bytes | Lines | % of sample |`);
  lines.push('|---|---|---|---|');
  for (const c of sample.composition.slice(0, 10)) {
    lines.push(`| \`${c.source}\` | ${fmtBytes(c.bytes)} | ${fmtCount(c.lines)} | ${fmtPct(c.pct)} |`);
  }
  if (sample.composition.length > 10) {
    const tailBytes = sample.composition
      .slice(10)
      .reduce((s, c) => s + c.bytes, 0);
    const tailPct = sample.totalBytes > 0 ? (tailBytes / sample.totalBytes) * 100 : 0;
    lines.push(`| _(${sample.composition.length - 10} more)_ | ${fmtBytes(tailBytes)} | - | ${fmtPct(tailPct)} |`);
  }
  lines.push('');

  // Section: industry-pricing matrix.
  lines.push('## Projected savings at default rates');
  lines.push('');
  lines.push('_Rates: the vendor\'s list price where it sells logs per GB, and a per-GB default, marked "default rate", where it bills in other units or publishes no per-GB price. Pass `effective_ingest_per_gb` on `log10x_estimate_savings` or `log10x_savings` once your real $/GB is known to convert these projections into a customer-specific quote._');
  lines.push('');
  lines.push(
    `If your full ingest mix matches this sample, ~${fmtPct(droppableFraction * 100)} of your byte volume is non-error high-frequency patterns: candidates for compacting, tiering down or offloading, each of which keeps every line.`
  );
  lines.push('');
  lines.push(
    `**Projected daily ingest** (extrapolated from sample): ${fmtBytes(dailyGbProjected * 1024 ** 3)}.`
  );
  lines.push('');
  if (fileSpan) {
    lines.push(
      `_The daily projection spreads the files' bytes over their span, read from ${fileSpan.source === 'timestamps' ? 'the record timestamps' : 'the `window` argument'}._`
    );
    lines.push('');
  }
  lines.push(
    '_These are list prices and default rates, not predictions of your specific bill: use them to size the order of magnitude, not to negotiate with procurement._'
  );
  lines.push('');
  lines.push('| Log analyzer | Rate | Annual cost | Annual savings |');
  lines.push('|---|---|---|---|');
  const dailyGb = dailyGbProjected;
  for (const row of INDUSTRY_PRICING) {
    const annualCost = dailyGb * 365 * row.perGb;
    const annualSavings = annualCost * droppableFraction;
    lines.push(
      `| ${row.vendor} | $${row.perGb.toFixed(2)}/GB (${row.note}) | ${fmtDollar(annualCost)} | ${fmtDollar(annualSavings)} |`
    );
  }
  lines.push('');

  // Section: top patterns (terse — full report would belong to the stack-attached path).
  lines.push('## Top patterns in the sample');
  lines.push('');
  if (patterns.length === 0) {
    lines.push('_No patterns resolved: the pattern extractor returned zero._');
  } else {
    lines.push('| # | Identity | Events | % | Bytes |');
    lines.push('|---|---|---|---|---|');
    const top = patterns.slice(0, 10);
    for (let i = 0; i < top.length; i++) {
      const p = top[i];
      const pct = (p.count / totalEvents) * 100;
      lines.push(
        `| ${i + 1} | \`${truncate(p.template, 60)}\` | ${fmtCount(p.count)} | ${fmtPct(pct)} | ${fmtBytes(p.bytes)} |`
      );
    }
    lines.push('');
    lines.push(
      `_For native stack exclusion configs, paste-ready Receiver YAML, and the full 9-section report, run \`log10x_poc_from_siem_submit\` once you have credentials available._`
    );
  }
  lines.push('');

  // Notes / failures.
  if (sample.failedSources.length > 0 || sample.notes.length > 0) {
    lines.push('## Notes');
    for (const note of sample.notes) lines.push(`- ${note}`);
    if (sample.failedSources.length > 0) {
      lines.push(
        `- ${sample.failedSources.length} ${srcNoun}(s) failed to read (e.g., access denied, terminated). Sample-composition table reflects only successfully-read ${srcNoun}s.`
      );
    }
  }

  const lowVendor = INDUSTRY_PRICING.reduce((min, r) => (r.perGb < min ? r.perGb : min), Infinity);
  const highVendor = INDUSTRY_PRICING.reduce((max, r) => (r.perGb > max ? r.perGb : max), 0);
  // Percent reduction band: expected = droppable / total. Low/high apply a
  // +/-15% heuristic envelope (matches the spec's "uncertainty range"
  // around point estimates from local samples). Capped 0..100.
  const expectedPct = droppableFraction * 100;
  const lowPct = Math.max(0, expectedPct * 0.85);
  const highPct = Math.min(100, expectedPct * 1.15);

  // ── Feasibility + commitment artifact (only when target supplied) ──
  let feasibility: LocalFeasibility | undefined;
  let commitment_artifact: LocalCommitmentArtifact | undefined;
  /** The shared ladder plan; attached to the envelope as `plan`. */
  let plan: Plan | undefined;
  /** The span the plan's byte figures cover, for the engine's per-window caps. */
  let planSpanSeconds: number | undefined;
  const budgetCount =
    (args.budget_usd_monthly !== undefined ? 1 : 0) +
    (args.budget_gb_monthly !== undefined ? 1 : 0);
  if (budgetCount > 1) {
    throw new Error('budget_usd_monthly and budget_gb_monthly are mutually exclusive: pick one denomination.');
  }
  if (budgetCount > 0 && args.target_percent_reduction !== undefined) {
    throw new Error('target_percent_reduction and a budget are mutually exclusive: a percent is a one-shot cut, a budget is a standing line. Pass one.');
  }
  if (args.target_percent_reduction !== undefined || budgetCount > 0) {
    const exceptions = args.exception_services ?? [];
    const exceptionSet = new Set(exceptions.map((s) => s.toLowerCase()));
    const pinServices = args.pin_services ?? {};
    const pinPatterns = args.pin_patterns ?? {};
    const pinServicesLower = new Map<string, string>();
    for (const [k, v] of Object.entries(pinServices)) pinServicesLower.set(k.toLowerCase(), v);
    // Pods that match the exception list contribute their bytes back to
    // the "must-keep" pool. Composition is keyed by pod / source name
    // and is the only service-grain signal available without a SIEM.
    // pin_services with action='pass' subtracts the same way; other pin
    // actions are still counted as reducible (pin only protects 'pass').
    let exceptionBytes = 0;
    for (const c of sample.composition) {
      const src = c.source.toLowerCase();
      if (exceptionSet.has(src)) { exceptionBytes += c.bytes; continue; }
      if (pinServicesLower.get(src) === 'pass') { exceptionBytes += c.bytes; }
    }
    const exceptionShare = sample.totalBytes > 0 ? exceptionBytes / sample.totalBytes : 0;
    // The shared ladder solver (lib/plan-solver) — the SAME routine
    // estimate_savings runs on the analysis path, so a prospect's POC number
    // and the deployed forecast answer "cut N%" identically by construction.
    // It replaces the old byte "droppable fraction" (which was destination-
    // blind and implicitly assumed drop, overstating e.g. 65% on a destination
    // whose real keep-everything lever was tier_down).
    // A percent target is scale-invariant, so the sample solves as-is. A
    // BUDGET is $/mo or GB/mo — the sample must be projected onto a 30-day
    // month first or the comparison is meaningless. kubectl: the pull window;
    // file: the files' span, over bytes scaled to the whole files.
    let sampleWindowHours = fileSpan ? fileSpan.seconds / 3600 : windowHours;
    if (sampleWindowHours <= 0) sampleWindowHours = 1;
    const monthScale = budgetCount > 0 ? (24 * 30) / sampleWindowHours : 1;
    planSpanSeconds = Math.round((budgetCount > 0 ? 24 * 30 : sampleWindowHours) * 3600);
    const target: PlanTarget =
      args.budget_usd_monthly !== undefined
        ? { kind: 'usd_budget', value: args.budget_usd_monthly }
        : args.budget_gb_monthly !== undefined
          ? { kind: 'gb_budget', value: args.budget_gb_monthly }
          : { kind: 'percent', value: args.target_percent_reduction! };
    // Bytes as the forwarder sends them, on-disk record size scaled from the
    // sample to the whole file, so the plan's caps are in the units the engine
    // measures.
    plan = solvePlan(
      patterns.map((p) => {
        const bytes = (p.rawBytes ?? p.bytes) * sampleScale * monthScale;
        const capBytes = p.receiverCapBytes !== undefined ? p.receiverCapBytes * sampleScale * monthScale : undefined;
        return {
          ...(capBytes !== undefined ? { capBytes } : {}),
          hash: p.tenxHash ?? p.hash,
          name: p.symbolMessage ?? (p.template ?? '').split('\n')[0] ?? p.hash,
          ...(p.template ? { skeleton: p.template.split('\n')[0] } : {}),
          services: { [p.service ?? '(unattributed)']: bytes },
          severity: p.severity ?? '',
          bytes,
          ...(p.count > 0 ? { avgEventBytes: (p.rawBytes ?? p.bytes) / p.count } : {}),
        };
      }),
      {
        // Same assumption rule as the report header: absent siem -> cloudwatch.
        destination: (args.siem ?? 'cloudwatch') as SiemId,
        retrieverInstalled: args.retriever_installed ?? false,
        target,
        scope: 'all',
        allowLossy: args.allow_lossy ?? false,
        exceptionServices: [
          ...exceptions,
          ...[...pinServicesLower.entries()].filter(([, a]) => a === 'pass').map(([k]) => k),
        ],
        ...(args.splunk_pricing ? { splunkPricing: args.splunk_pricing } : {}),
        ...(args.enterprise_security !== undefined ? { enterpriseSecurity: args.enterprise_security } : {}),
      },
    );
    const maxAchievable = plan.keepEverythingCeilingPct;
    const feasible = plan.met;
    // On Datadog every percentage is volume out of the Standard index.
    const volumeBasis = plan.percentBasis === 'standard_index_volume';
    const basisNoun = volumeBasis ? ' of the volume out of the Standard index' : '';
    const reasonParts = [
      `Total sample bytes ${fmtBytes(sample.totalBytes)} across ${sample.composition.length} pod(s).`,
      `Ladder plan on ${args.siem ?? 'cloudwatch'}: ${plan.keepEverythingLever ?? 'no keep-everything lever'} first; ` +
        `achieved ${fmtPct(plan.achievedPct)}${volumeBasis ? basisNoun : ' of the bill'} keeping everything` +
        `${plan.planned.some((r) => !r.keepsEverything) ? ' plus opted-in loss' : ''}; ` +
        `keep-everything ceiling ${fmtPct(plan.keepEverythingCeilingPct)}.`,
    ];
    if (plan.gap) reasonParts.push(plan.gap.message);
    if (exceptions.length > 0) {
      reasonParts.push(
        `${exceptions.length} exception pod(s) cover ${fmtPct(exceptionShare * 100)} of bytes and are pinned to pass.`,
      );
    }
    if (Object.keys(pinPatterns).length > 0) {
      reasonParts.push(`${Object.keys(pinPatterns).length} pattern pin(s) applied.`);
    }
    if (pinServicesLower.size > 0) {
      reasonParts.push(`${pinServicesLower.size} service pin(s) applied; max_achievable shifted accordingly.`);
    }
    if (plan.perEventMove) reasonParts.push(plan.perEventMove.text);
    const targetLabel =
      plan.target.kind === 'usd_budget'
        ? volumeBasis
          ? `the $${plan.target.value}/mo budget (priced lines only)`
          : `the $${plan.target.value}/mo budget (derived cut ${plan.targetPct}%)`
        : plan.target.kind === 'gb_budget'
          ? `the ${plan.target.value} GB/mo budget (derived cut ${plan.targetPct}%)`
          : `target ${args.target_percent_reduction}%`;
    reasonParts.push(
      feasible
        ? `Achievable ${maxAchievable.toFixed(1)}%${basisNoun} meets ${targetLabel}.`
        : `Achievable ${maxAchievable.toFixed(1)}%${basisNoun} short of ${targetLabel}; trim exceptions or widen the sample.`,
    );
    feasibility = {
      feasible,
      target_percent_reduction: args.target_percent_reduction ?? plan.targetPct,
      ...(args.budget_usd_monthly !== undefined ? { budget_usd_monthly: args.budget_usd_monthly } : {}),
      ...(args.budget_gb_monthly !== undefined ? { budget_gb_monthly: args.budget_gb_monthly } : {}),
      max_achievable_percent: Math.round(maxAchievable * 10) / 10,
      reason: reasonParts.join(' '),
      exception_services: exceptions,
      exception_share_of_bytes: Math.round(exceptionShare * 1000) / 1000,
    };
    const artLines: string[] = [];
    artLines.push(`## Projected commitment: local (${source === 'file' ? 'file sample' : 'kubectl sample'})`);
    artLines.push('');
    if (feasibility.budget_usd_monthly !== undefined && volumeBasis) {
      artLines.push(
        `- **Budget**: $${feasibility.budget_usd_monthly}/mo (priced lines only${plan.perEventMove?.unpriced ? '; Flex compute is unpriced and excluded' : ''})`,
      );
    } else if (feasibility.budget_usd_monthly !== undefined) {
      artLines.push(`- **Budget**: $${feasibility.budget_usd_monthly}/mo (derived reduction ${feasibility.target_percent_reduction}%)`);
    } else if (feasibility.budget_gb_monthly !== undefined) {
      artLines.push(`- **Budget**: ${feasibility.budget_gb_monthly} GB/mo ingest (derived reduction ${feasibility.target_percent_reduction}%)`);
    } else {
      artLines.push(`- **Target reduction**: ${feasibility.target_percent_reduction}%${basisNoun}`);
    }
    artLines.push(
      `- **Projected max achievable**: ${feasibility.max_achievable_percent.toFixed(1)}%${basisNoun} (${feasibility.feasible ? 'feasible' : 'short of target'})`,
    );
    if (plan.perEventMove) artLines.push(`- **Datadog Flex**: ${plan.perEventMove.text}`);
    artLines.push(`- **Sample bytes analyzed**: ${fmtBytes(sample.totalBytes)}`);
    if (fileSpanStatement) artLines.push(`- **Span**: ${fileSpanStatement.replace(/^Span: /, '')}`);
    artLines.push('');
    if (exceptions.length > 0) {
      artLines.push(`### Exception ${srcNoun}s (stay in log analyzer, full retention)`);
      artLines.push('');
      for (const svc of exceptions) artLines.push(`- \`${svc}\``);
      artLines.push('');
      artLines.push(
        `_Removed ${fmtPct(feasibility.exception_share_of_bytes * 100)} of sample bytes from the achievable pool._`,
      );
      artLines.push('');
    }
    artLines.push('### Next step');
    artLines.push('');
    if (feasibility.feasible) {
      artLines.push('1. Re-run `log10x_poc_from_siem_submit` once log-analyzer credentials are available: the stack path produces the per-pattern action plan + native exclusion configs.');
      artLines.push('2. Run `log10x_advise_install` to provision the Receiver in your forwarder pipeline.');
    } else {
      artLines.push('1. Lower `target_percent_reduction` to within the achievable band, or trim `exception_services`.');
      artLines.push('2. Re-run with a wider `window` or `namespace: "*"` to confirm the sample is representative before negotiating the target.');
    }
    artLines.push('');
    artLines.push(
      source === 'file'
        ? '_This is a PRE-DEPLOY projection from a local file sample. Local-source feasibility carries higher uncertainty than the stack-attached path because the sample may not cover CloudTrail / ALB / VM-hosted apps the analyzer also ingests._'
        : '_This is a PRE-DEPLOY projection from a kubectl sample. Local-source feasibility carries higher uncertainty than the stack-attached path because it does not see CloudTrail / ALB / VM-hosted apps._',
    );
    commitment_artifact = {
      markdown: artLines.join('\n'),
      next_step: feasibility.feasible
        ? { tool: 'log10x_advise_install', reason: 'feasibility passes; provision Receiver' }
        : { tool: 'log10x_configure_engine', reason: 'target exceeds achievable; iterate on plan' },
    };
  }

  // ── The mode this ran in, disclosed on the way out ──
  //
  // Surface 3 of the offer: a fenced run hands back its own proof, at the
  // moment the reader is looking at the result rather than only in a doc they
  // may never open. Surface 2 is the mirror image — a run that had network
  // says so in one sentence and names the alternative.
  //
  // `poc_from_local` reads local files either way, so the unfenced disclosure
  // names what is actually true of it: the FILES did not travel, but the
  // process holding them had a socket the whole time. Claiming it "read the
  // analyzer over the network" would be the easy sentence and a false one.
  // Reached only with a non-empty sample: the zero-line case returned above.
  let fenced_verification: ReturnType<typeof fencedVerification> | undefined;
  let fenced_offer: ReturnType<typeof fencedOffer> | undefined;
  if (isFenced()) {
    fenced_verification = fencedVerification();
    lines.push('');
    lines.push(fenced_verification.markdown);
  } else {
    fenced_offer = fencedOffer({
      read: 'local files',
      disclosure: 'This POC read local files on a machine with network access. The same POC runs with no network at all.',
      planArgs: { siem: args.siem ?? 'cloudwatch', window: opts.window ?? '1h' },
    });
    lines.push('');
    lines.push(fenced_offer.markdown);
  }

  // ── report.html — the durable POC deliverable ──
  // Fixed UX: report.html = render(template_v1, data). The agent's
  // only inputs are report_annotations (validated fail-closed inside
  // the builder). A ReportRefusal aborts the run so bad agent input
  // is never silently rendered around; any other report failure
  // degrades to a note — the chat envelope still ships.
  let report_path: string | undefined;
  let plan_path: string | undefined;
  let report_caps_path: string | undefined;
  let report_actions_path: string | undefined;
  let engine_policy: PocFromLocalInner['engine_policy'];
  let fleet_default: FleetDefaultReport | undefined;
  let report_note: string | undefined;
  try {
    const siem: SiemId = args.siem ?? 'cloudwatch';
    const siemAssumed = args.siem === undefined;
    const finishedAtIso = new Date().toISOString();
    // The report's figures are on the sampled bytes, so its window is the
    // span those bytes stand for.
    let windowHoursForReport = windowHours;
    let windowStartMs: number | undefined;
    let windowEndMs: number | undefined;
    const firstSeen = patterns.map((p) => p.firstSeenMs).filter((x): x is number => x !== undefined);
    const lastSeen = patterns.map((p) => p.lastSeenMs).filter((x): x is number => x !== undefined);
    if (firstSeen.length > 0 && lastSeen.length > 0) {
      windowStartMs = Math.min(...firstSeen);
      windowEndMs = Math.max(...lastSeen);
    }
    if (windowHoursForReport <= 0) windowHoursForReport = 1;

    const renderInput: RenderInput = {
      siem,
      window: source === 'file' ? 'file' : opts.window!,
      extraction,
      targetEventCount: totalEvents,
      pullWallTimeMs: sample.wallTimeMs,
      templateWallTimeMs: extraction.templaterWallTimeMs,
      reasonStopped: 'source_exhausted',
      queryUsed: source === 'file' ? `file:${args.path}` : `kubectl -n ${opts.namespace} logs --since=${opts.window}`,
      windowHours: windowHoursForReport,
      analyzerCostPerGb: DEFAULT_ANALYZER_COST_PER_GB[siem],
      snapshotId: `local-${source}`,
      startedAt: startedAtIso,
      finishedAt: finishedAtIso,
      mcpVersion: MCP_VERSION,
      rawIngestBytes,
      windowStartMs,
      windowEndMs,
    };
    const enrichment = _enrichForEnvelope(renderInput);
    // Datadog: before a rule moves statements off Standard, the log monitors and
    // log-based metrics that read them. Read-only, credential-gated, never throws.
    // With a fleet default, every service the plan gives no row is covered by
    // it, error statements included, so those services are checked as well.
    const fleetRequest = args.fleet_default
      ? {
          ...(args.fleet_default.headroom !== undefined ? { headroom: args.fleet_default.headroom } : {}),
          action: args.fleet_default.action ?? 'tier_down',
          ...(args.fleet_default.error_floor !== undefined ? { errorFloor: args.fleet_default.error_floor } : {}),
        }
      : undefined;
    const fleetRules =
      fleetRequest && plan
        ? fleetDefaultDependencyRules(
            enrichment.patterns.map((p) => ({
              service: p.service,
              name: p.symbolMessage ?? (p.template ?? '').split('\n')[0] ?? p.hash,
              text: p.template,
              severity: p.severity,
            })),
            Object.keys(plan.containerCaps),
            fleetRequest.action,
          )
        : [];
    const ruleDependencies =
      siem === 'datadog' && plan && args.check_dependencies !== false
        ? await checkRuleDependencies('datadog', [...dependencyRulesFromPlan(plan), ...fleetRules])
        : undefined;
    const built = buildReportData(
      renderInput,
      { patterns: enrichment.patterns, clusters: enrichment.clusters },
      {
        siem,
        siemLabel: siemAssumed ? `${SIEM_DISPLAY_NAMES[siem]} (assumed)` : SIEM_DISPLAY_NAMES[siem],
        forwarder: args.forwarder ?? null,
        install: 'k8s',
        namespace: source === 'kubectl' ? opts.namespace : undefined,
        workload: args.workload,
        annotations: args.report_annotations,
        generatedAtIso: finishedAtIso,
        mcpVersion: MCP_VERSION,
        ...(plan && planSpanSeconds ? { plan, planSpanSeconds } : {}),
        ...(ruleDependencies ? { ruleDependencies } : {}),
        ...(fleetRequest ? { fleetDefaultRequest: fleetRequest } : {}),
        capUnitStatement: receiverBytesStatement(extraction.receiverBytesBasis, extraction.recordOverheadBytes),
        enforcingInstances: resolveEnforcingInstances(
          [...new Set([...Object.keys(plan?.containerCaps ?? {}), ...Object.keys(sample.containerNodes ?? {})])],
          { fromPods: sample.containerNodes },
        ),
      },
    );
    fleet_default = built.fleetDefault;
    if (fleet_default) {
      lines.push('');
      lines.push(
        fleet_default.computed
          ? `**Fleet default.** ${fleet_default.sentence} To install it, call \`log10x_advise_install\` with the ` +
              `\`fleet_default\` from this result` +
              (siem === 'datadog' ? ' and `log_destination: "datadog"`.' : '.')
          : `**Fleet default.** None: ${fleet_default.reason}.`,
      );
    }
    // Datadog: the native index filters a person writes without 10x, set
    // against the plan on this capture's events, the ones Datadog never
    // indexed included when the capture is the forwarder's output.
    if (siem === 'datadog') {
      const plannedAction = plan
        ? new Map(plan.planned.filter((r) => r.action !== 'pass').map((r) => [r.hash, r.action] as const))
        : undefined;
      lines.push('');
      lines.push('## Native index filters against the plan');
      lines.push('');
      lines.push(captureEventSourceSentence(captureEventSource(extractionInput, source === 'kubectl')));
      if (extraction.pipelineParsedEvents) {
        lines.push(
          "Datadog's Kafka log pipeline parses the logger class that ends a Kafka line into `logger.name` before index filters run. " +
            `These events carry it unparsed, so it is read from each Kafka event's text, ${extraction.pipelineParsedEvents.toLocaleString('en-US')} events in all.`,
        );
      }
      lines.push('');
      lines.push(
        ...renderNativeControlSection({
          patterns: controlPatterns(enrichment.patterns, plannedAction),
          totalBytes: extraction.totalBytes,
          totalDailyGb: dailyGbProjected,
          windowHours: windowHoursForReport,
          window: source === 'file' ? 'file' : opts.window!,
          volumeLabel: source === 'file' ? "the file's span" : 'the kubectl window',
        }),
      );
    }
    const html = renderReportHtml(built.data);
    report_path = nodePath.resolve(process.cwd(), REPORT_FILE_NAME);
    await fs.writeFile(report_path, html, 'utf8');
    if (isFenced()) {
      plan_path = nodePath.resolve(process.cwd(), PLAN_FILE_NAME);
      await fs.writeFile(plan_path, lines.join('\n') + '\n', 'utf8');
    }
    if (built.capsCsv !== null && built.actionsCsv !== null) {
      report_caps_path = nodePath.resolve(process.cwd(), CAPS_FILE_NAME);
      await fs.writeFile(report_caps_path, built.capsCsv, 'utf8');
      report_actions_path = nodePath.resolve(process.cwd(), ACTIONS_FILE_NAME);
      await fs.writeFile(report_actions_path, built.actionsCsv, 'utf8');
      engine_policy = {
        caps_csv: built.capsCsv,
        actions_csv: built.actionsCsv,
        span_seconds: planSpanSeconds ?? Math.round(windowHoursForReport * 3600),
        span_source: plan && budgetCount > 0 ? 'budget_month' : (fileSpan?.source ?? 'window'),
        reset_window_seconds: 240,
        unattributed_planned: built.unattributedPlanned,
      };
    } else {
      // No engine files this run. A previous run's files in this directory
      // would read as this run's plan; they may also be a plan the user means
      // to apply, so they stay, and the run says what they are.
      const stale: string[] = [];
      for (const name of [CAPS_FILE_NAME, ACTIONS_FILE_NAME]) {
        try {
          const st = await fs.stat(nodePath.resolve(process.cwd(), name));
          stale.push(`${name} (written ${st.mtime.toISOString().replace('T', ' ').slice(0, 16)} UTC)`);
        } catch {
          // not there
        }
      }
      if (stale.length > 0) {
        const note = `This run writes no engine files. ${stale.join(' and ')} in this directory ${stale.length === 1 ? 'is' : 'are'} from a previous run, not this one.`;
        sample.notes.push(note);
        lines.push('', `_${note}_`);
      }
    }
  } catch (e) {
    if (e instanceof ReportRefusal) throw e;
    report_path = undefined;
    plan_path = undefined;
    report_caps_path = undefined;
    report_actions_path = undefined;
    engine_policy = undefined;
    report_note = `report.html generation failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  return {
    ok: true,
    source,
    report_path,
    plan_path,
    report_caps_path,
    report_actions_path,
    engine_policy,
    ...(fleet_default ? { fleet_default } : {}),
    report_note,
    namespace: namespaceOut,
    window: windowOut,
    ...(fileSpan && fileSpanStatement
      ? {
          span: {
            seconds: fileSpan.seconds,
            source: fileSpan.source,
            statement: fileSpanStatement,
            ...(fileSpan.firstIso ? { first_timestamp: fileSpan.firstIso, last_timestamp: fileSpan.lastIso } : {}),
            records_with_timestamp: fileSpan.recordsWithTimestamp,
            records_sampled: fileSpan.records,
          },
        }
      : {}),
    pods_sampled: sample.composition.length,
    pods_failed: sample.failedSources.length,
    events_pulled: totalEvents,
    total_bytes: sample.totalBytes,
    distinct_patterns: patterns.length,
    daily_gb_projection: dailyGbProjected,
    daily_dollar_projection_low: dailyGbProjected * lowVendor,
    daily_dollar_projection_high: dailyGbProjected * highVendor,
    daily_pct_reduction_low: lowPct,
    daily_pct_reduction_expected: expectedPct,
    daily_pct_reduction_high: highPct,
    rate_source: 'list_price',
    notes: sample.notes,
    markdown: lines.join('\n'),
    fenced_profile: fenced_verification !== undefined,
    ...(fenced_verification ? { fenced_verification } : {}),
    ...(fenced_offer ? { fenced_offer: { disclosure: fenced_offer.disclosure, action: fenced_offer.action } } : {}),
    feasibility,
    ...(plan ? { plan: planForResponse(plan) } : {}),
    commitment_artifact,
    ...(extraction.roundTrip ? { round_trip: extraction.roundTrip } : {}),
  };
}

/**
 * One sentence on the decode pass, for the report and the summary. States
 * the count it checked; a pass that did not run says so rather than
 * implying a proof.
 */
export function describeRoundTrip(rt: RoundTripResult): string {
  if (rt.status === 'identical') {
    return `Round trip: the ${rt.records.toLocaleString()} compact records of this sample were decoded by the engine and compared with the ${rt.inputLines.toLocaleString()} lines it was given, byte for byte: identical.`;
  }
  if (rt.status === 'differs') {
    const first = rt.firstDifference
      ? ` First difference at line ${rt.firstDifference.line}: input \`${rt.firstDifference.input.slice(0, 120)}\`, decoded \`${rt.firstDifference.decoded.slice(0, 120)}\`.`
      : '';
    const note = rt.note ? ` ${rt.note[0].toUpperCase()}${rt.note.slice(1)}.` : '';
    return `Round trip: ${rt.differingLines.toLocaleString()} of ${rt.inputLines.toLocaleString()} lines differ after the engine decoded the ${rt.records.toLocaleString()} compact records of this sample (${rt.decodedLines.toLocaleString()} lines came back).${first}${note} Do not quote this sample's saving as lossless until that is understood.`;
  }
  return `Round trip: not run${rt.note ? ` (${rt.note})` : ''}. The saving above is a byte count, not a proof that the text comes back; run the POC again with the engine reachable to get one.`;
}

function parseWindowHours(window: string): number {
  const m = window.trim().match(/^(\d+)([smhd])$/i);
  if (!m) return 1;
  const n = parseInt(m[1], 10);
  switch (m[2].toLowerCase()) {
    case 's':
      return n / 3600;
    case 'm':
      return n / 60;
    case 'h':
      return n;
    case 'd':
      return n * 24;
    default:
      return 1;
  }
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ');
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}
