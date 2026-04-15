/**
 * Output formatting helpers.
 *
 * Plain text, not markdown. Dollar amounts are prominent.
 * Designed for AI consumption — concise, structured, parseable.
 */

/** Format a dollar amount: $1.2K, $14K, $1.2M, etc. */
export function fmtDollar(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';

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
  days: number;
  range: string;
  label: string;
  baselineOffsets: number[];
}

/** Parse a timeframe string (1d, 7d, 30d) into a Timeframe config. */
export function parseTimeframe(input: string): Timeframe {
  const match = input.match(/^(\d+)d$/);
  if (!match) throw new Error(`Invalid timeframe: ${input}`);

  const days = parseInt(match[1], 10);
  if (days < 1 || days > 90) throw new Error(`Timeframe must be 1-90 days, got ${days}`);

  let label: string;
  if (days === 1) label = 'last 24h';
  else if (days === 7) label = 'this week';
  else label = `last ${days}d`;

  // Baseline: 3 prior windows of same size
  const baselineOffsets = [days, days * 2, days * 3];

  return { days, range: `${days}d`, label, baselineOffsets };
}

/** Cost period label for output. */
export function costPeriodLabel(days: number): string {
  if (days === 1) return '/day';
  if (days === 7) return '/wk';
  if (days === 30) return '/mo';
  return `/${days}d`;
}
