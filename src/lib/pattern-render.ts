/**
 * Shared renderer for pattern-list output (top_patterns, cost_drivers,
 * event_lookup, services). One stanza per pattern: a header line
 * (service · severity), the full untruncated pattern, a volume
 * share-bar, a metrics line (volume · cost · events), then the
 * tenx_hash join key. Optional grouping into per-service sections.
 *
 * Why a stanza, not a table: pattern names run 20-80+ chars and
 * variable-width columns break in monospace. A stanza lets the name
 * wrap on its own line and keeps magnitude (volume + bar) and the
 * paste-back hash always visible. No em-dashes in any emitted prose.
 */
import { fmtBytes, fmtCount, fmtDollar, fmtPattern, fmtSeverity } from './format.js';

export interface PatternStanzaRow {
  /** Canonical pattern label (snake_case) or a placeholder like (no-symbol). */
  pattern: string;
  service: string;
  severity: string;
  bytes: number;
  /** Cost for the period (already scaled to periodSuffix). */
  cost: number;
  /** Event count over the window, when available. */
  events?: number;
  /** Portable cross-pillar join key. Shown to the human for paste-back. */
  tenxHash?: string;
  /** Short flags rendered after the header, e.g. ['stale', 'no-symbol']. */
  flags?: string[];
  /**
   * Growth mode: when set, the metrics line shows `$base -> $now`
   * plus deltaLabel instead of a plain cost. Used by cost_drivers.
   */
  costBaseline?: number;
  /** Preformatted delta tag for growth mode, e.g. "+34%", "NEW". */
  deltaLabel?: string;
  /**
   * Value the share-bar is scaled against. Defaults to bytes. Tools
   * whose magnitude is not volume (cost_drivers ranks by $ delta) set
   * this so the bar reflects the metric that actually ranks the list.
   */
  barValue?: number;
  /**
   * Volume-over-window samples. When present (>=2 points) the row
   * renders a trend sparkline + direction word INSTEAD of the static
   * share-bar (a flat scope-share bar is near-useless on a long-tailed
   * workload; "is this getting worse" is the question that matters).
   */
  spark?: number[];
  /** Preformatted "impacts" line: which services this pattern hits. */
  impacts?: string;
  /**
   * A verbatim sample log line (already truncated) pulled from the
   * user's SIEM by exact tenx_hash. When present it leads the stanza
   * as the readable identity and the tokenized pattern is demoted to
   * a `pattern:` line. Ground truth, not fabrication.
   */
  sample?: string;
}

const SPARK = '▁▂▃▄▅▆▇█';

/** Unicode sparkline scaled to the series own min..max. */
export function sparkline(vals: number[]): string {
  const v = vals.filter(x => Number.isFinite(x));
  if (v.length < 2) return '';
  const min = Math.min(...v);
  const max = Math.max(...v);
  if (max <= min) return SPARK[0].repeat(v.length);
  return v
    .map(x => {
      const i = Math.round(((x - min) / (max - min)) * (SPARK.length - 1));
      return SPARK[Math.min(SPARK.length - 1, Math.max(0, i))];
    })
    .join('');
}

/** First-third vs last-third mean -> rising / falling / flat. */
export function trendWord(vals: number[]): string {
  const v = vals.filter(x => Number.isFinite(x));
  if (v.length < 4) return 'flat';
  const k = Math.max(1, Math.floor(v.length / 3));
  const head = v.slice(0, k).reduce((a, b) => a + b, 0) / k;
  const tail = v.slice(-k).reduce((a, b) => a + b, 0) / k;
  if (head <= 0 && tail <= 0) return 'flat';
  if (head <= 0) return tail > 0 ? 'rising' : 'flat';
  const ratio = tail / head;
  if (ratio >= 1.2) return 'rising';
  if (ratio <= 0.8) return 'falling';
  return 'flat';
}

export interface StanzaRenderOpts {
  /** e.g. "Top patterns", "Cost drivers". */
  title: string;
  /** e.g. "all services" or a specific service name. */
  scopeLabel: string;
  /** e.g. "last 24h". */
  windowLabel: string;
  /** e.g. "/day", "/7d", "" . Appended to every dollar figure. */
  periodSuffix: string;
  /** Total volume in scope (bar denominator + footer). */
  scopeBytes?: number;
  /** Total cost in scope (footer). */
  scopeCost?: number;
  /** Bytes actually shown (sum of the displayed rows), for reconciliation. */
  shownBytes?: number;
  /** Distinct pattern count in scope (the "of M" in "N of M patterns"). */
  totalPatternCount?: number;
  /** Preformatted annualized note, e.g. "~$1.9K/yr". Shown on Scope line. */
  annualNote?: string;
  /**
   * Single dominant service: hoisted into the header, omitted from
   * every row header (it would be identical noise on each row).
   */
  hoistedService?: string;
  /** Render per-service sections instead of one global ranking. */
  groupByService?: boolean;
  /**
   * Skip the title + Scope summary lines (the legend and stanzas still
   * render). For callers that print their own header block, e.g.
   * cost_drivers with its baseline/comparison framing.
   */
  suppressHeader?: boolean;
}

const BAR_WIDTH = 24;

/** Horizontal share bar: filled vs empty cells for a 0..1 fraction. */
export function shareBar(frac: number, width = BAR_WIDTH): string {
  const f = Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0;
  const filled = Math.round(f * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function pctText(frac: number): string {
  const p = frac * 100;
  if (!Number.isFinite(p) || p <= 0) return '<1%';
  if (p < 1) return p.toFixed(1) + '%';
  return Math.round(p) + '%';
}

function stanza(
  r: PatternStanzaRow,
  rank: number,
  opts: StanzaRenderOpts,
  maxBytes: number
): string[] {
  const out: string[] = [];
  const sev = fmtSeverity(r.severity);
  // The service is omitted from the row header when one service
  // dominates the whole list (hoisted into the header instead) — it
  // would be identical noise on every row otherwise.
  const headBits: string[] = [];
  if (!opts.hoistedService) headBits.push(r.service || '(no service)');
  if (sev) headBits.push(sev);
  if (r.flags && r.flags.length) headBits.push(...r.flags);
  out.push(`${rank}) ${headBits.join(' · ') || '(pattern)'}`);
  // Label both lines so the reader knows which is a real example event
  // and which is the canonical identity. The identity line is always
  // labeled `pattern:`; when a real sample resolved it leads, labeled
  // `sample:` (one verbatim event, not the whole population).
  if (r.sample) {
    out.push(`   sample:  ${r.sample}`);
  }
  out.push(`   pattern: ${fmtPattern(r.pattern)}`);

  // Trend sparkline (the good visual) when the caller supplies a series:
  // "is this getting worse" is the actionable question. No makeshift
  // magnitude bar otherwise — it carried no information beyond the $ and the
  // rank order, and read as an unlabeled mystery graph. Share of scope (when
  // known) goes on the metrics line below as plain text instead.
  if (r.spark && r.spark.length >= 2) {
    out.push(`   trend ${sparkline(r.spark)}  ${trendWord(r.spark)}`);
  }

  const metrics: string[] = [];
  if (r.bytes > 0) metrics.push(`${fmtBytes(r.bytes)}`);
  if (typeof r.costBaseline === 'number') {
    metrics.push(`${fmtDollar(r.costBaseline)} -> ${fmtDollar(r.cost)}${opts.periodSuffix}`);
    if (r.deltaLabel) metrics.push(r.deltaLabel);
  } else {
    metrics.push(`${fmtDollar(r.cost)}${opts.periodSuffix}`);
  }
  if (typeof r.events === 'number' && Number.isFinite(r.events) && r.events > 0) {
    metrics.push(`${fmtCount(r.events)} events`);
    if (r.bytes > 0) metrics.push(`${fmtBytes(r.bytes / r.events)}/event`);
  }
  // Share of scope as plain text (replaces the removed magnitude bar).
  const scopeDenom = opts.scopeBytes && opts.scopeBytes > 0 ? opts.scopeBytes : 0;
  if (scopeDenom > 0 && r.bytes > 0) metrics.push(`${pctText(r.bytes / scopeDenom)} of scope`);
  out.push(`   ${metrics.join(' · ')}`);

  if (r.impacts) out.push(`   impacts: ${r.impacts}`);
  if (r.tenxHash) out.push(`   tenx_hash  ${r.tenxHash}`);
  return out;
}

/**
 * Render the stanza list. Caller owns the title/caveat/agent-only blocks
 * around it; this produces just the header summary + the per-pattern
 * body (optionally grouped by service).
 */
export function renderPatternStanzas(
  rows: PatternStanzaRow[],
  opts: StanzaRenderOpts
): string {
  const lines: string[] = [];
  if (!opts.suppressHeader) {
    const scopeLabel = opts.hoistedService
      ? `${opts.hoistedService} (all ${rows.length} top patterns below are this service)`
      : opts.scopeLabel;
    lines.push([opts.title, opts.windowLabel, scopeLabel].join(' · '));
    // Reconciliation line: how much of the whole is on screen, so the
    // reader does not have to derive 27% from row sums.
    const scopeBits: string[] = [];
    if (opts.shownBytes !== undefined && opts.scopeBytes && opts.scopeBytes > 0) {
      scopeBits.push(`showing ${fmtBytes(opts.shownBytes)} of ${fmtBytes(opts.scopeBytes)}`);
    } else if (opts.scopeBytes && opts.scopeBytes > 0) {
      scopeBits.push(fmtBytes(opts.scopeBytes));
    }
    if (opts.totalPatternCount && opts.totalPatternCount > 0) {
      scopeBits.push(`${rows.length} of ${opts.totalPatternCount} patterns`);
    } else {
      scopeBits.push(`${rows.length} pattern${rows.length === 1 ? '' : 's'} shown`);
    }
    if (typeof opts.scopeCost === 'number') {
      const ann = opts.annualNote ? ` (${opts.annualNote})` : '';
      scopeBits.push(`${fmtDollar(opts.scopeCost)}${opts.periodSuffix} total${ann}`);
    }
    lines.push(`Scope: ${scopeBits.join(' · ')}`);
  }

  if (!rows.length) {
    lines.push('');
    lines.push('(no patterns in scope)');
    return lines.join('\n');
  }

  const maxBytes = rows.reduce(
    (m, r) => Math.max(m, typeof r.barValue === 'number' ? r.barValue : r.bytes),
    0
  );
  const hasSpark = rows.some(r => r.spark && r.spark.length >= 2);
  if (hasSpark) {
    lines.push('(trend = volume across the window, oldest -> newest)');
    lines.push('');
  }

  if (opts.groupByService) {
    const bySvc = new Map<string, PatternStanzaRow[]>();
    for (const r of rows) {
      const k = r.service || '(no service)';
      (bySvc.get(k) ?? bySvc.set(k, []).get(k)!).push(r);
    }
    // Order services by their summed bytes, descending.
    const svcOrder = [...bySvc.entries()]
      .map(([s, rs]) => [s, rs.reduce((a, x) => a + x.bytes, 0)] as const)
      .sort((a, b) => b[1] - a[1])
      .map(([s]) => s);
    for (const s of svcOrder) {
      const rs = bySvc.get(s)!.sort((a, b) => b.cost - a.cost);
      lines.push(`=== ${s} ===`);
      rs.forEach((r, i) => {
        lines.push(...stanza(r, i + 1, opts, maxBytes));
        lines.push('');
      });
    }
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  rows.forEach((r, i) => {
    lines.push(...stanza(r, i + 1, opts, maxBytes));
    lines.push('');
  });
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
