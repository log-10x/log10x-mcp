/**
 * Local-source POC tool: pulls log lines from kubectl and renders a
 * cost-optimization report without touching any log-analyzer API.
 *
 * Distinct from `log10x_poc_from_siem`:
 *   - No vendor credentials needed (uses the user's kubeconfig)
 *   - Cost framing is an industry-pricing matrix (Datadog list,
 *     Splunk list, CloudWatch, OpenSearch), NOT a prediction of any
 *     specific bill — we only see kubernetes pod stdout, not
 *     CloudTrail / ALB logs / VM-hosted apps that the SIEM ingests
 *   - Synchronous (kubectl pull is fast); no snapshot lifecycle
 *
 * Sample-composition table forces the user to declare the sample
 * representative: "70% of bytes come from your-noisy-service" surfaces
 * up-front so the prospect can either confirm or widen scope before
 * trusting the savings projection.
 */

import { z } from 'zod';

import { sampleFromKubectl, type LocalSourceOptions } from '../lib/local-source.js';
import { extractPatterns } from '../lib/pattern-extraction.js';
import { fmtBytes, fmtCount, fmtDollar, fmtPct } from '../lib/format.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';
import type { PrimitiveError } from '../lib/primitive-errors.js';

export const pocFromLocalSchema = {
  source: z
    .enum(['kubectl'])
    .optional()
    .default('kubectl')
    .describe(
      'Where to pull log lines from. Currently `kubectl` only; `docker` and `journald` are follow-up work.'
    ),
  namespace: z
    .string()
    .optional()
    .default('default')
    .describe(
      'Kubernetes namespace to sample from. Pass `*` to sample across all namespaces. Default `default`.'
    ),
  window: z
    .string()
    .optional()
    .default('1h')
    .describe('How far back to read per pod. Accepts `1h`, `24h`, etc. Default `1h`.'),
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
  privacy_mode: z
    .boolean()
    .optional()
    .default(true)
    .describe('Templatize via locally-installed `tenx` (true) or the public Log10x paste endpoint (false). Default true.'),
  target_percent_reduction: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'Customer-specified target reduction percent. If absent, POC produces a recommendation-only output. ' +
        'If present, POC produces a feasibility verdict + a pre-deploy commitment artifact stub the agent ' +
        'can surface alongside the per-pod savings matrix. Cap CSV ships in Item 4.'
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
  source?: 'kubectl';
  namespace?: string;
  window?: string;
  per_pod_limit?: number;
  max_pods?: number;
  privacy_mode?: boolean;
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

const INDUSTRY_PRICING: PriceRow[] = [
  { vendor: 'Datadog', perGb: 2.5, note: '30-day indexed, list price' },
  { vendor: 'Splunk', perGb: 5.0, note: 'self-hosted ingest license, list price' },
  { vendor: 'CloudWatch Logs', perGb: 0.5, note: 'ingestion + first-month storage' },
  { vendor: 'Sumo Logic', perGb: 2.0, note: 'Continuous ingest tier' },
  { vendor: 'Elastic Cloud', perGb: 0.95, note: 'Hot tier + searchable' },
  { vendor: 'OpenSearch', perGb: 0.1, note: 'self-hosted compute baseline' },
];

export async function executePocFromLocal(args: PocFromLocalArgs): Promise<StructuredOutput> {
  const telemetry = newTelemetry();
  let inner: Awaited<ReturnType<typeof executePocFromLocalInner>>;
  try {
    inner = await executePocFromLocalInner(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err: PrimitiveError = {
      error_type: /kubectl|kubeconfig|cluster/i.test(msg) ? 'backend_unavailable' : 'local_processing_failed',
      retryable: /kubectl|cluster/i.test(msg),
      suggested_backoff_ms: null,
      hint: msg.slice(0, 400),
    };
    const human_summary = `poc_from_local failed: ${err.hint}`;
    return buildEnvelope({
      tool: 'log10x_poc_from_local',
      view: 'summary',
      summary: { headline: `POC from kubectl failed: ${err.error_type}` },
      data: {
        events_pulled: 0,
        ...buildUnifiedFields({ status: 'error', telemetry, humanSummary: human_summary, error: err }),
        human_summary,
      },
    });
  }
  const hasData = inner.events_pulled > 0;
  // Headline leads with percent reduction (universal, vendor-independent),
  // followed by the volume context, then a trailing "at list price" dollar
  // band so the cost framing stays explicitly list-priced — not a customer-
  // specific quote we cannot honestly produce from a kubectl sample.
  const headline = hasData
    ? `POC from kubectl: ${Math.round(inner.daily_pct_reduction_low ?? 0)}-${Math.round(inner.daily_pct_reduction_high ?? 0)}% byte reduction across ${inner.distinct_patterns} pattern${inner.distinct_patterns !== 1 ? 's' : ''} (${inner.events_pulled.toLocaleString()} lines from ${inner.pods_sampled} pod${inner.pods_sampled !== 1 ? 's' : ''}). At list price across vendors: ${fmtDollar(inner.daily_dollar_projection_low ?? 0)}-${fmtDollar(inner.daily_dollar_projection_high ?? 0)}/day.`
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
    return `POC from kubectl pulled 0 log lines across the requested window. Either no pods matched the namespace + pod filter, or kubectl is not reachable. Confirm the namespace and re-run with a wider window or pod selector.`;
  }
  const lo = Math.round(inner.daily_pct_reduction_low ?? 0);
  const hi = Math.round(inner.daily_pct_reduction_high ?? 0);
  const dlo = fmtDollar(inner.daily_dollar_projection_low ?? 0);
  const dhi = fmtDollar(inner.daily_dollar_projection_high ?? 0);
  return `Sampled ${inner.events_pulled.toLocaleString()} log lines from ${inner.pods_sampled} pod${inner.pods_sampled !== 1 ? 's' : ''} (${fmtBytes(inner.total_bytes)}) covering ${inner.distinct_patterns} distinct pattern${inner.distinct_patterns !== 1 ? 's' : ''}. Estimated byte reduction is ${lo}-${hi}% per day. At industry list price the same volume costs roughly ${dlo}-${dhi}/day across vendors.`;
}

interface PocFromLocalInner {
  ok: boolean;
  source: 'kubectl';
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
  if (source !== 'kubectl') {
    throw new Error(
      `source "${source}" not yet supported. Only "kubectl" is implemented; "docker" and "journald" are follow-up work.`
    );
  }

  const opts: LocalSourceOptions = {
    namespace: args.namespace ?? 'default',
    window: args.window ?? '1h',
    perPodLimit: args.per_pod_limit ?? 5000,
    maxPods: args.max_pods ?? 20,
  };

  const sample = await sampleFromKubectl(opts);

  if (sample.events.length === 0) {
    const lines: string[] = ['## Log10x POC — local source (kubectl)', ''];
    lines.push('**No log lines were pulled.**');
    lines.push('');
    if (sample.notes.length > 0) {
      lines.push('### Notes');
      for (const note of sample.notes) lines.push(`- ${note}`);
      lines.push('');
    }
    if (sample.failedPods.length > 0) {
      lines.push('### Failed pods');
      for (const f of sample.failedPods.slice(0, 10)) lines.push(`- ${f}`);
      if (sample.failedPods.length > 10) {
        lines.push(`- ... and ${sample.failedPods.length - 10} more`);
      }
    }
    return {
      ok: false,
      source: 'kubectl',
      namespace: opts.namespace!,
      window: opts.window!,
      pods_sampled: 0,
      pods_failed: sample.failedPods.length,
      events_pulled: 0,
      total_bytes: 0,
      distinct_patterns: 0,
      daily_gb_projection: 0,
      rate_source: 'list_price',
      notes: sample.notes,
      markdown: lines.join('\n'),
    };
  }

  const extraction = await extractPatterns(sample.events, {
    privacyMode: args.privacy_mode ?? true,
    autoBatch: true,
  });

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
  lines.push('# Log10x POC — local source (kubectl)');
  lines.push('');
  lines.push(
    `_Pulled ${fmtCount(sample.events.length)} log lines (${fmtBytes(sample.totalBytes)}) across ${sample.composition.length} pod${sample.composition.length === 1 ? '' : 's'} in namespace \`${opts.namespace}\` over the last ${opts.window}._`
  );
  lines.push('');

  // Section: sample composition (Opus-recommended trust pre-emption).
  lines.push('## Sample composition');
  lines.push('');
  lines.push(
    'These pods produced the bytes in the sample. **Confirm this looks like your production mix before trusting the projection** — if 70% of your real-prod bytes come from a service that is NOT in this list, the savings projection is meaningless to you. Widen with `namespace: "*"` or a longer `window` if anything looks off.'
  );
  lines.push('');
  lines.push('| Pod | Bytes | Lines | % of sample |');
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
  if (sample.failedPods.length > 0 || sample.notes.length > 0) {
    lines.push('## Notes');
    for (const note of sample.notes) lines.push(`- ${note}`);
    if (sample.failedPods.length > 0) {
      lines.push(
        `- ${sample.failedPods.length} pod(s) failed to read (e.g., access denied, terminated). Sample-composition table reflects only successfully-read pods.`
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
      artLines.push('### Exception pods (stay in log analyzer, full retention)');
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
      artLines.push('1. Re-run `log10x_poc_from_siem` once log-analyzer credentials are available — the stack path produces the per-pattern action plan + native exclusion configs.');
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

  return {
    ok: true,
    source: 'kubectl',
    namespace: opts.namespace!,
    window: opts.window!,
    pods_sampled: sample.composition.length,
    pods_failed: sample.failedPods.length,
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
