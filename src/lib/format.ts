/**
 * Output formatting helpers.
 *
 * Plain text, not markdown. Dollar amounts are prominent.
 * Designed for AI consumption — concise, structured, parseable.
 */

/**
 * Format a dollar amount: $1.2K, $14K, $1.2M, etc. Sub-dollar amounts
 * expand precision so sample-size POC runs don't collapse to `$0.00`
 * and obscure which patterns are actually the most expensive. Anything
 * below $0.01 goes to 4 decimals; below $1 goes to 2.
 */
export function fmtDollar(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';

  if (abs === 0) return `${sign}$0`;
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  if (abs < 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs < 10) return `${sign}$${abs.toFixed(1)}`;
  if (abs < 1000) return `${sign}$${Math.round(abs)}`;
  if (abs < 10000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  if (abs < 1000000) return `${sign}$${Math.round(abs / 1000)}K`;
  return `${sign}$${(abs / 1000000).toFixed(1)}M`;
}

/** Format bytes as human-readable: 1.2 GB, 450 MB, etc. */
export function fmtBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${Math.round(abs)} B`;
  if (abs < 1024 * 1024) return `${(abs / 1024).toFixed(1)} KB`;
  if (abs < 1024 * 1024 * 1024) return `${(abs / (1024 * 1024)).toFixed(1)} MB`;
  if (abs < 1024 * 1024 * 1024 * 1024) return `${(abs / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${(abs / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB`;
}

/** Format event count: 1.2B, 450M, 12K, etc. */
export function fmtCount(count: number): string {
  const abs = Math.abs(count);
  if (abs < 1000) return `${Math.round(abs)}`;
  if (abs < 1000000) return `${(abs / 1000).toFixed(abs < 10000 ? 1 : 0)}K`;
  if (abs < 1000000000) return `${(abs / 1000000).toFixed(abs < 10000000 ? 1 : 0)}M`;
  return `${(abs / 1000000000).toFixed(1)}B`;
}

/** Format a pattern name for display: replace underscores with spaces. */
export function fmtPattern(pattern: string): string {
  return pattern.replace(/_/g, ' ');
}

/**
 * Normalize a pattern name for use in a PromQL `message_pattern="..."` selector.
 *
 * Reporter-side pattern labels are always snake_case (word_word_word), but the
 * display formatter renders them with spaces via `fmtPattern` for readability.
 * When an agent re-feeds a displayed pattern back into a tool, the spaces
 * round-trip into PromQL and the exact-match selector fails. This helper
 * reverses the display transform so round-trip calls land on the canonical
 * label value.
 */
export function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/\s+/g, '_');
}

/** Format severity: standard display names (not truncated to 4 chars). */
export function fmtSeverity(sev: string): string {
  const map: Record<string, string> = {
    trace: 'TRACE', debug: 'DEBUG', info: 'INFO', warn: 'WARN',
    warning: 'WARN', error: 'ERROR', critical: 'CRIT', fatal: 'FATAL',
    uncl: '',
  };
  return map[sev.toLowerCase()] ?? sev.toUpperCase();
}

/** Format a percentage. */
export function fmtPct(value: number): string {
  if (value < 1) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

/** Timeframe config matching SlackTimeframe.java. */
export interface Timeframe {
  /** Window length in days. Fractional for sub-day windows (e.g., 1h = 1/24). */
  days: number;
  /** PromQL range expression, passed verbatim to queries (e.g., "15m", "1h", "7d"). */
  range: string;
  /** Human-readable label for output rendering. */
  label: string;
  /**
   * Baseline offsets for cost_drivers 3-window average (in days). Scaled to
   * match `days` so sub-day windows compare against other sub-day windows.
   */
  baselineOffsets: number[];
}

/**
 * Parse a timeframe string into a Timeframe config.
 *
 * Accepts: `15m`, `30m`, `1h`, `6h`, `12h`, `1d`, `7d`, `30d` — any number
 * of m/h/d suffixes where the resulting range is at least 1 minute and at
 * most 90 days. Sub-day windows (minutes/hours) are useful for incident
 * investigation; day-level windows for cost and trend analysis.
 */
export function parseTimeframe(input: string): Timeframe {
  const match = input.match(/^(\d+)([mhd])$/);
  if (!match) throw new Error(`Invalid timeframe: "${input}". Expected format like "15m", "1h", "6h", "1d", "7d", "30d".`);

  const n = parseInt(match[1], 10);
  const unit = match[2];
  const unitToDays: Record<string, number> = { m: 1 / 1440, h: 1 / 24, d: 1 };
  const days = n * unitToDays[unit];

  // Sanity bounds: 1 minute minimum, 90 days maximum.
  if (days < 1 / 1440) throw new Error(`Timeframe must be at least 1 minute, got ${input}`);
  if (days > 90) throw new Error(`Timeframe must be at most 90 days, got ${input}`);

  let label: string;
  if (unit === 'd' && n === 1) label = 'last 24h';
  else if (unit === 'd' && n === 7) label = 'this week';
  else if (unit === 'd') label = `last ${n}d`;
  else if (unit === 'h') label = `last ${n}h`;
  else label = `last ${n}m`;

  // Baseline: 3 prior windows of same size (scaled to the chosen unit).
  const baselineOffsets = [days, days * 2, days * 3];

  return { days, range: `${n}${unit}`, label, baselineOffsets };
}

/** Cost period label for output. Renders a short suffix matching the window size. */
export function costPeriodLabel(days: number): string {
  if (days === 1) return '/day';
  if (days === 7) return '/wk';
  if (days === 30) return '/mo';
  if (days < 1) {
    // Sub-day windows: render in minutes or hours
    const minutes = Math.round(days * 1440);
    if (minutes < 60) return `/${minutes}m`;
    const hours = Math.round(days * 24);
    return `/${hours}h`;
  }
  return `/${days}d`;
}
