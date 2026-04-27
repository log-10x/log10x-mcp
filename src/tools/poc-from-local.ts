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
};

export interface PocFromLocalArgs {
  source?: 'kubectl';
  namespace?: string;
  window?: string;
  per_pod_limit?: number;
  max_pods?: number;
  privacy_mode?: boolean;
  ai_prettify?: boolean;
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

export async function executePocFromLocal(args: PocFromLocalArgs): Promise<string> {
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
    return lines.join('\n');
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

  // Section: top patterns (terse — full report would belong to the SIEM-attached path).
  lines.push('## Top patterns in the sample');
  lines.push('');
  if (patterns.length === 0) {
    lines.push('_No patterns resolved — the templater returned zero._');
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
      `_For native SIEM exclusion configs, paste-ready Reducer YAML, and the full 9-section report, run \`log10x_poc_from_siem\` once you have credentials available._`
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

  return lines.join('\n');
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
