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
  const headBits = [r.service || '(no service)'];
  if (sev) headBits.push(sev);
  if (r.flags && r.flags.length) headBits.push(...r.flags);
  out.push(`${rank}) ${headBits.join(' · ')}`);
  out.push(`   ${fmtPattern(r.pattern)}`);

  // Prefer a trend sparkline (volume over the window) when samples are
  // supplied: "is this getting worse" is the actionable question, and
  // a scope-share bar collapses to one cell on a long-tailed workload.
  // Fall back to the scaled share-bar for callers that pass no series.
  if (r.spark && r.spark.length >= 2) {
    out.push(`   trend ${sparkline(r.spark)}  ${trendWord(r.spark)}`);
  } else {
    const barVal = typeof r.barValue === 'number' ? r.barValue : r.bytes;
    const barFrac = maxBytes > 0 ? barVal / maxBytes : 0;
    const scopeDenom = opts.scopeBytes && opts.scopeBytes > 0 ? opts.scopeBytes : 0;
    const scopeFrac = scopeDenom > 0 ? r.bytes / scopeDenom : barFrac;
    const pctTail = scopeDenom > 0 ? ` ${pctText(scopeFrac)} of scope` : '';
    out.push(`   ${shareBar(barFrac)} ${pctTail}`.trimEnd());
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
  }
  out.push(`   ${metrics.join(' · ')}`);

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
    const headerParts = [opts.title, opts.windowLabel, opts.scopeLabel];
    lines.push(headerParts.join(' · '));
    const scopeBits: string[] = [];
    if (opts.scopeBytes && opts.scopeBytes > 0) scopeBits.push(fmtBytes(opts.scopeBytes));
    if (typeof opts.scopeCost === 'number') scopeBits.push(`${fmtDollar(opts.scopeCost)}${opts.periodSuffix}`);
    scopeBits.push(`${rows.length} pattern${rows.length === 1 ? '' : 's'} shown`);
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
  const hasScope = !!(opts.scopeBytes && opts.scopeBytes > 0);
  const hasSpark = rows.some(r => r.spark && r.spark.length >= 2);
  lines.push(
    hasSpark
      ? '(trend = volume across the window, oldest -> newest)'
      : hasScope
        ? '(bar scaled to the largest shown row; % is true share of scope)'
        : '(bar scaled to the largest shown row)'
  );
  lines.push('');

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
