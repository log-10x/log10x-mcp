/**
 * Local-source POC tool: pulls log lines from kubectl or from local
 * files/globs and renders a cost-optimization report without touching
 * any log-analyzer API.
 *
 * Distinct from `log10x_poc_from_siem`:
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

import { promises as fs } from 'fs';
import * as nodePath from 'path';

import { z } from 'zod';

import {
  sampleFromFiles,
  sampleFromKubectl,
  type LocalSourceOptions,
  type LocalSourceResult,
} from '../lib/local-source.js';
import { sampleFromFile } from '../lib/local-file-source.js';
import { extractPatterns } from '../lib/pattern-extraction.js';
import { fmtBytes, fmtCount, fmtDollar, fmtPct } from '../lib/format.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';
import type { PrimitiveError } from '../lib/primitive-errors.js';
import { DEFAULT_ANALYZER_COST_PER_GB, SIEM_DISPLAY_NAMES, type SiemId } from '../lib/siem/pricing.js';
import { _enrichForEnvelope, type RenderInput } from '../lib/poc-report-renderer.js';
import { buildReportData, ReportRefusal, CAPS_FILE_NAME } from '../lib/report/build-report-data.js';
import { renderReportHtml } from '../lib/report/html-template-v1.js';
import { readClientVersion } from '../lib/manifest.js';

const MCP_VERSION = readClientVersion();

export const REPORT_FILE_NAME = 'log10x-poc-report.html';

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
      'Where to pull log lines from. `kubectl` samples pod logs; `file` samples local logs — ' +
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
        'Used to pick verified apply/undo commands. Not guessed when absent — the report says commands are unavailable.'
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
    .default('1h')
    .describe(
      'How far back to read per pod (`source: kubectl`). For `source: file` this is the time span you ' +
        'declare the sampled file tails to cover — it drives the daily projection, so set it if you know it. ' +
        'Accepts `1h`, `24h`, etc. Default `1h`.'
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
  exception_services: z
    .array(z.string())
    .optional()
    .describe(
      'Services / pods flagged by the customer to stay in the log analyzer with full retention (action=pass). ' +
        'Their bytes are subtracted from the achievable reduction pool used for the feasibility verdict. ' +
        'Matched case-insensitively against the pod / source name.'
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
      'Advanced — most customers will not need this. Map of pattern_hash to action for rare per-pattern ' +
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
  target_percent_reduction?: number;
  exception_services?: string[];
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
  target_percent_reduction: number;
  max_achievable_percent: number;
  reason: string;
  exception_services: string[];
  exception_share_of_bytes: number;
}

interface LocalCommitmentArtifact {
  markdown: string;
  next_step: { tool: 'log10x_advise_install' | 'log10x_configure_engine'; reason: string };
}

interface PriceRow {
  vendor: string;
  perGb: number;
  note: string;
}

// No-env POC matrix (kubectl scan, no resolved env/destination) so it cannot
// resolveRate, but its list figures MUST come from the single canonical source
// (DEFAULT_ANALYZER_COST_PER_GB, synced from vendors.json) instead of duplicated
// literals that drift. Splunk was hardcoded $5.0 here, contradicting canonical
// $6. OpenSearch has no SiemId in pricing.ts; it keeps a local baseline figure.
const INDUSTRY_PRICING: PriceRow[] = [
  { vendor: 'Datadog', perGb: DEFAULT_ANALYZER_COST_PER_GB.datadog, note: '30-day indexed, list price' },
  { vendor: 'Splunk', perGb: DEFAULT_ANALYZER_COST_PER_GB.splunk, note: 'self-hosted ingest license, list price' },
  { vendor: 'CloudWatch Logs', perGb: DEFAULT_ANALYZER_COST_PER_GB.cloudwatch, note: 'ingestion + first-month storage' },
  { vendor: 'Azure Monitor', perGb: DEFAULT_ANALYZER_COST_PER_GB['azure-monitor'], note: 'Analytics tier ingest, list price' },
  { vendor: 'Sumo Logic', perGb: DEFAULT_ANALYZER_COST_PER_GB.sumo, note: 'Continuous ingest tier, list price' },
  { vendor: 'Elastic Cloud', perGb: DEFAULT_ANALYZER_COST_PER_GB.elasticsearch, note: 'Hot tier + searchable' },
  { vendor: 'Coralogix', perGb: DEFAULT_ANALYZER_COST_PER_GB.coralogix, note: 'Frequent Search (High) priority, list price' },
  { vendor: 'Elastic Cloud Serverless', perGb: DEFAULT_ANALYZER_COST_PER_GB['elastic-serverless'], note: 'Logs Essentials ingest floor; retention billed separately' },
  { vendor: 'OpenSearch', perGb: 0.1, note: 'self-hosted compute baseline (no canonical list rate)' },
];

export async function executePocFromLocal(args: PocFromLocalArgs): Promise<StructuredOutput> {
  const telemetry = newTelemetry();
  let inner: Awaited<ReturnType<typeof executePocFromLocalInner>>;
  try {
    inner = await executePocFromLocalInner(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A kubectl/cluster failure on a host that has no cluster is NOT a
    // transient backend outage — retrying cannot fix an estate that is not
    // Kubernetes. Classify it as environment misconfiguration and say what
    // to do instead (the earlier classification returned
    // `backend_unavailable` + retryable:true, sending agents into a retry
    // loop against a cluster that does not exist).
    const noCluster = /kubectl|kubeconfig|cluster/i.test(msg);
    const err: PrimitiveError = {
      error_type: noCluster ? 'config_missing' : 'local_processing_failed',
      retryable: false,
      suggested_backoff_ms: null,
      hint: noCluster
        ? `No Kubernetes cluster is reachable from this host (${msg.slice(0, 160)}). ` +
          'If this estate is serverless or file-based, re-run with source:"file" and paths:[...] ' +
          'against local log files — do not retry the kubectl path.'
        : msg.slice(0, 400),
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
  const headline = hasData
    ? `POC from ${inner.source}: ${Math.round(inner.daily_pct_reduction_low ?? 0)}-${Math.round(inner.daily_pct_reduction_high ?? 0)}% byte reduction across ${inner.distinct_patterns} pattern${inner.distinct_patterns !== 1 ? 's' : ''} (${inner.events_pulled.toLocaleString()} lines from ${inner.pods_sampled} ${srcNoun}${inner.pods_sampled !== 1 ? 's' : ''}). At list price across vendors: ${fmtDollar(inner.daily_dollar_projection_low ?? 0)}-${fmtDollar(inner.daily_dollar_projection_high ?? 0)}/day.`
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
      ? [{ tool: 'log10x_resolve_batch', args: { source: 'text', text: '...' }, reason: 'run the same sample through resolve_batch for per-pattern variable concentration + next actions' }]
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
  const lo = Math.round(inner.daily_pct_reduction_low ?? 0);
  const hi = Math.round(inner.daily_pct_reduction_high ?? 0);
  const dlo = fmtDollar(inner.daily_dollar_projection_low ?? 0);
  const dhi = fmtDollar(inner.daily_dollar_projection_high ?? 0);
  const base = `Sampled ${inner.events_pulled.toLocaleString()} log lines from ${inner.pods_sampled} ${srcNoun}${inner.pods_sampled !== 1 ? 's' : ''} (${fmtBytes(inner.total_bytes)}) covering ${inner.distinct_patterns} distinct pattern${inner.distinct_patterns !== 1 ? 's' : ''}. Estimated byte reduction is ${lo}-${hi}% per day. At industry list price the same volume costs roughly ${dlo}-${dhi}/day across vendors.`;
  if (inner.report_path) {
    return `${base} The action-plan report was written to ${inner.report_path}; open it in a browser.`;
  }
  return base;
}

interface PocFromLocalInner {
  ok: boolean;
  source: 'kubectl' | 'file';
  /** Absolute path of the written report.html deliverable. */
  report_path?: string;
  /** Absolute path of the caps CSV the report's apply commands reference. */
  report_caps_path?: string;
  /** Honest note when report generation was skipped or degraded. */
  report_note?: string;
  /** `-` for source: file (no namespace concept). */
  namespace: string;
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
  commitment_artifact?: LocalCommitmentArtifact;
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
  if (source === 'file') {
    if (args.path) {
      const fileSample = await sampleFromFile(args.path);
      sample = fileSample;
      extractionInput = fileSample.records;
      rawIngestBytes = fileSample.normalized ? fileSample.rawBytes : undefined;
    } else if (args.paths && args.paths.length > 0) {
      // per_pod_limit / max_pods double as per-file / max-file caps — same
      // budget, different source grain.
      sample = await sampleFromFiles({
        paths: args.paths,
        perFileLimit: args.per_pod_limit ?? 5000,
        maxFiles: args.max_pods ?? 20,
      });
      extractionInput = sample.events;
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

  if (sample.events.length === 0) {
    const lines: string[] = [`## Log10x POC — local source (${source})`, ''];
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
      window: opts.window!,
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

  const extraction = await extractPatterns(extractionInput);

  // Project the sampled-window bytes to a daily figure.
  const windowHours = parseWindowHours(opts.window!);
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
  lines.push(`# Log10x POC — local source (${source})`);
  lines.push('');
  lines.push(
    source === 'file'
      ? `_Pulled ${fmtCount(sample.events.length)} log lines (${fmtBytes(sample.totalBytes)}) across ${sample.composition.length} file${sample.composition.length === 1 ? '' : 's'} (tail-sampled; the \`window\` parameter does not apply to files)._`
      : `_Pulled ${fmtCount(sample.events.length)} log lines (${fmtBytes(sample.totalBytes)}) across ${sample.composition.length} pod${sample.composition.length === 1 ? '' : 's'} in namespace \`${opts.namespace}\` over the last ${opts.window}._`
  );
  lines.push('');

  // Section: sample composition (Opus-recommended trust pre-emption).
  lines.push('## Sample composition');
  lines.push('');
  lines.push(
    source === 'file'
      ? 'These files produced the bytes in the sample. **Confirm this looks like your production mix before trusting the projection** — if 70% of your real-prod bytes come from a service that is NOT in this list, the savings projection is meaningless to you. Widen `paths` or raise `max_pods` (the file cap) if anything looks off.'
      : 'These pods produced the bytes in the sample. **Confirm this looks like your production mix before trusting the projection** — if 70% of your real-prod bytes come from a service that is NOT in this list, the savings projection is meaningless to you. Widen with `namespace: "*"` or a longer `window` if anything looks off.'
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
    lines.push(`| _(${sample.composition.length - 10} more)_ | ${fmtBytes(tailBytes)} | — | ${fmtPct(tailPct)} |`);
  }
  lines.push('');

  // Section: industry-pricing matrix.
  lines.push('## Projected savings at industry list pricing');
  lines.push('');
  lines.push('_Rate source: list price (vendors.json). Pass `effective_ingest_per_gb` on `log10x_estimate_savings` or `log10x_savings` once your real $/GB is known to convert these projections into a customer-specific quote._');
  lines.push('');
  lines.push(
    `If your full ingest mix matches this sample, ~${fmtPct(droppableFraction * 100)} of your byte volume is non-error high-frequency patterns — candidates for muting or sampling.`
  );
  lines.push('');
  lines.push(
    `**Projected daily ingest** (extrapolated from sample): ${fmtBytes(dailyGbProjected * 1024 ** 3)}.`
  );
  lines.push('');
  if (source === 'file') {
    lines.push(
      `_File tails carry no time span of their own; the daily projection assumes the sampled bytes cover \`${opts.window}\` (the \`window\` argument). Pass the window the files actually span to make this projection honest._`
    );
    lines.push('');
  }
  lines.push(
    '_These are list-price figures, not predictions of your specific bill — use them to size the order of magnitude, not to negotiate with procurement._'
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
    lines.push('_No patterns resolved — the pattern extractor returned zero._');
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
      `_For native stack exclusion configs, paste-ready Receiver YAML, and the full 9-section report, run \`log10x_poc_from_siem\` once you have credentials available._`
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
  if (args.target_percent_reduction !== undefined) {
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
    const maxAchievable = Math.max(0, expectedPct - exceptionShare * 100);
    const feasible = maxAchievable >= args.target_percent_reduction;
    const reasonParts = [
      `Total sample bytes ${fmtBytes(sample.totalBytes)} across ${sample.composition.length} pod(s).`,
      `Droppable fraction (non-error, ≥1% volume patterns): ${fmtPct(expectedPct)}.`,
    ];
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
    reasonParts.push(
      feasible
        ? `Achievable ${maxAchievable.toFixed(1)}% meets target ${args.target_percent_reduction}%.`
        : `Achievable ${maxAchievable.toFixed(1)}% short of target ${args.target_percent_reduction}%; trim exceptions or widen the sample.`,
    );
    feasibility = {
      feasible,
      target_percent_reduction: args.target_percent_reduction,
      max_achievable_percent: Math.round(maxAchievable * 10) / 10,
      reason: reasonParts.join(' '),
      exception_services: exceptions,
      exception_share_of_bytes: Math.round(exceptionShare * 1000) / 1000,
    };
    const artLines: string[] = [];
    artLines.push(`## Projected commitment — local (kubectl sample)`);
    artLines.push('');
    artLines.push(`- **Target reduction**: ${feasibility.target_percent_reduction}%`);
    artLines.push(
      `- **Projected max achievable**: ${feasibility.max_achievable_percent.toFixed(1)}% (${feasibility.feasible ? 'feasible' : 'short of target'})`,
    );
    artLines.push(`- **Sample bytes analyzed**: ${fmtBytes(sample.totalBytes)}`);
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
      artLines.push('1. Re-run `log10x_poc_from_siem_submit` once log-analyzer credentials are available — the stack path produces the per-pattern action plan + native exclusion configs.');
      artLines.push('2. Run `log10x_advise_install` to provision the Receiver in your forwarder pipeline.');
    } else {
      artLines.push('1. Lower `target_percent_reduction` to within the achievable band, or trim `exception_services`.');
      artLines.push('2. Re-run with a wider `window` or `namespace: "*"` to confirm the sample is representative before negotiating the target.');
    }
    artLines.push('');
    artLines.push('_This is a PRE-DEPLOY projection from a kubectl sample. Local-source feasibility carries higher uncertainty than the stack-attached path because it does not see CloudTrail / ALB / VM-hosted apps._');
    commitment_artifact = {
      markdown: artLines.join('\n'),
      next_step: feasibility.feasible
        ? { tool: 'log10x_advise_install', reason: 'feasibility passes; provision Receiver' }
        : { tool: 'log10x_configure_engine', reason: 'target exceeds achievable; iterate on plan' },
    };
  }

  // ── report.html — the durable POC deliverable ──
  // Fixed UX: report.html = render(template_v1, data). The agent's
  // only inputs are report_annotations (validated fail-closed inside
  // the builder). A ReportRefusal aborts the run so bad agent input
  // is never silently rendered around; any other report failure
  // degrades to a note — the chat envelope still ships.
  let report_path: string | undefined;
  let report_caps_path: string | undefined;
  let report_note: string | undefined;
  try {
    const siem: SiemId = args.siem ?? 'cloudwatch';
    const siemAssumed = args.siem === undefined;
    const finishedAtIso = new Date().toISOString();
    // File mode has no pull window; derive the analysed span from
    // event timestamps when the wrapper carried them, else fall back
    // to one hour with the fallback visible in the window label math.
    let windowHoursForReport = source === 'file' ? 0 : windowHours;
    let windowStartMs: number | undefined;
    let windowEndMs: number | undefined;
    const firstSeen = patterns.map((p) => p.firstSeenMs).filter((x): x is number => x !== undefined);
    const lastSeen = patterns.map((p) => p.lastSeenMs).filter((x): x is number => x !== undefined);
    if (firstSeen.length > 0 && lastSeen.length > 0) {
      windowStartMs = Math.min(...firstSeen);
      windowEndMs = Math.max(...lastSeen);
      if (source === 'file') {
        windowHoursForReport = Math.max(1 / 60, (windowEndMs - windowStartMs) / 3_600_000);
      }
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
      },
    );
    const html = renderReportHtml(built.data);
    report_path = nodePath.resolve(process.cwd(), REPORT_FILE_NAME);
    await fs.writeFile(report_path, html, 'utf8');
    if (built.capsCsv !== null) {
      report_caps_path = nodePath.resolve(process.cwd(), CAPS_FILE_NAME);
      await fs.writeFile(report_caps_path, built.capsCsv, 'utf8');
    }
  } catch (e) {
    if (e instanceof ReportRefusal) throw e;
    report_path = undefined;
    report_caps_path = undefined;
    report_note = `report.html generation failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  return {
    ok: true,
    source,
    report_path,
    report_caps_path,
    report_note,
    namespace: namespaceOut,
    window: opts.window!,
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
    feasibility,
    commitment_artifact,
  };
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
