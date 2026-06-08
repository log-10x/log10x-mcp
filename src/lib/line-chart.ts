/**
 * ASCII line-chart renderer for `log10x_top_patterns`.
 *
 * Draws a smooth-line ASCII chart with Y-axis labels and an X-axis time
 * scale. Two modes:
 *   - zero-anchored: floor at $0/h, peak at the data max. Used when the
 *     pattern's volume actually spans a wide range — keeps the Reader
 *     honest about magnitude.
 *   - auto-zoomed: floor at the data min, peak at the data max. Used
 *     when min/max > 0.2 (data is tightly clustered) — without this
 *     the chart would be a flat band at the top with 80% empty canvas.
 *     A caveat line below the chart names the floor so the Reader
 *     knows the chart is zoomed and doesn't read the variation as
 *     larger than it is.
 *
 * Connector chars are the same family the Python prototype uses:
 *   ●  for the first data point
 *   ─  horizontal between same-row points
 *   ╭ ╯ ╮ ╰  corners for one-row transitions
 *   │  vertical for multi-row jumps
 * That set survives in plain terminals, IDE chat panels, and Markdown
 * renderers — no fragile fonts required.
 *
 * Height adapts: 4 rows when zoomed, 6 rows when zero-anchored.
 * Width is data-driven (one column per bucket up to `widthCap`).
 */

export interface LineChartOpts {
  /** Max chart columns. Data wider than this is max-pooled into widthCap buckets. */
  widthCap?: number;
  /** Hard cap on the TOTAL rendered line width (y-label + axis + canvas),
   * in monospace columns. Charts wider than the chat panel soft-wrap into
   * garbage; this bounds the whole line so it can't. Default 54 (fits VS
   * Code's side panel); raise it for full-width terminals. */
  maxTotalWidth?: number;
  /** Total time span the data covers, in seconds. Drives the x-axis labels. */
  spanSeconds?: number;
}

/**
 * Render a line chart. Input `vals` are byte-rates (bytes/second from
 * a PromQL `rate(...)` query). The y-axis renders **volume per hour**
 * (MB/h, with KB/h fallback for low-volume patterns) — chosen over
 * $/h because:
 *   1. the row header already names the cost; the chart's job is the
 *      *trend shape*, not a second cost readout
 *   2. cost = volume × $/GB is a linear scaling, so the shape is
 *      identical either way — volume just parses faster (no mental
 *      $-conversion)
 *
 * Returns `null` if there is nothing to render (all zero / empty input);
 * callers fall back to a textual note.
 */
export function lineChart(vals: number[], opts: LineChartOpts = {}): string | null {
  const widthCap = opts.widthCap ?? 60;
  const maxTotalWidth = opts.maxTotalWidth ?? 54;

  if (vals.length === 0 || vals.every(v => v === 0)) return null;

  // Choose the canvas width so the WHOLE line fits maxTotalWidth. Each
  // rendered row is `  ` + label + ` ` + connector + canvas, so the
  // non-canvas overhead is the y-label column (≤16 chars for any
  // realistic MB/KB-per-hour value) plus 4. Reserving 20 keeps the
  // total ≤ maxTotalWidth without needing the (circular) zoom decision
  // up front. Floor at 12 columns so the shape stays legible on a very
  // narrow panel.
  const canvasCap = Math.max(12, Math.min(widthCap, maxTotalWidth - 20));

  // Downsample to canvasCap if needed (max-pool over each chunk so spikes
  // aren't smoothed away).
  let series = vals;
  if (series.length > canvasCap) {
    const step = series.length / canvasCap;
    const sampled: number[] = [];
    for (let i = 0; i < canvasCap; i++) {
      const chunk = series.slice(Math.floor(i * step), Math.floor((i + 1) * step) + 1);
      sampled.push(chunk.length > 0 ? Math.max(...chunk) : 0);
    }
    series = sampled;
  }
  const width = series.length;

  const maxV = Math.max(...series) || 1;
  const minV = Math.min(...series);
  // auto-zoom when data is tightly clustered
  const zoomed = minV / maxV > 0.2;
  const height = zoomed ? 4 : 6;
  const floorV = zoomed ? minV : 0;
  const span = maxV - floorV || 1;

  const toRow = (v: number): number => {
    const norm = (v - floorV) / span;
    return Math.round((1 - norm) * (height - 1));
  };

  // Build canvas
  const canvas: string[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ' ')
  );
  const positions = series.map(toRow);
  for (let i = 0; i < width; i++) {
    const cur = positions[i];
    if (i === 0) {
      canvas[cur][i] = '●';
      continue;
    }
    const prev = positions[i - 1];
    if (prev === cur) {
      canvas[cur][i] = '─';
    } else if (prev > cur) {
      // going up (lower row index = higher value)
      canvas[cur][i] = '╭';
      canvas[prev][i] = '╯';
      for (let r = cur + 1; r < prev; r++) {
        if (canvas[r][i] === ' ') canvas[r][i] = '│';
      }
    } else {
      // going down
      canvas[cur][i] = '╰';
      canvas[prev][i] = '╮';
      for (let r = prev + 1; r < cur; r++) {
        if (canvas[r][i] === ' ') canvas[r][i] = '│';
      }
    }
  }

  // Format y-axis values as volume per hour. `vals` are bytes/sec.
  // Adaptive unit: MB/h for typical patterns, KB/h when peak < 1 MB/h
  // so low-volume noise doesn't render as a row of "0.0 MB/h" labels.
  const peakMbPerHr = (maxV * 3600) / 1e6;
  const useKb = peakMbPerHr < 1;
  const fmtY = (bytesPerSec: number): string => {
    if (useKb) {
      const kbPerHr = (bytesPerSec * 3600) / 1e3;
      if (kbPerHr >= 100) return `${kbPerHr.toFixed(0)} KB/h`;
      if (kbPerHr >= 10) return `${kbPerHr.toFixed(1)} KB/h`;
      return `${kbPerHr.toFixed(2)} KB/h`;
    }
    const mbPerHr = (bytesPerSec * 3600) / 1e6;
    if (mbPerHr >= 100) return `${mbPerHr.toFixed(0)} MB/h`;
    if (mbPerHr >= 10) return `${mbPerHr.toFixed(1)} MB/h`;
    return `${mbPerHr.toFixed(1)} MB/h`;
  };

  const peakLbl = zoomed ? `peak  ${fmtY(maxV)}` : fmtY(maxV);
  const floorLbl = zoomed ? `floor ${fmtY(floorV)}` : (useKb ? '0 KB/h' : '0 MB/h');
  const labelW = Math.max(peakLbl.length, floorLbl.length) + 1;

  const lines: string[] = [];
  for (let r = 0; r < height; r++) {
    const lbl = r === 0 ? peakLbl : r === height - 1 ? floorLbl : '';
    const connector = r < height - 1 ? '┤' : '┼';
    lines.push(`  ${lbl.padStart(labelW)} ${connector}${canvas[r].join('')}`);
  }
  lines.push(`  ${''.padStart(labelW)} └${'─'.repeat(width)}`);

  // X-axis labels. If caller gave us span_seconds, use it. Otherwise we
  // can't honestly label the axis (length-of-array tells us nothing
  // about the underlying step).
  const spanMin = opts.spanSeconds ? Math.floor(opts.spanSeconds / 60) : 0;
  if (spanMin > 0) {
    let left: string;
    let mid: string;
    if (spanMin >= 60) {
      left = `-${Math.floor(spanMin / 60)}h`;
      mid = `-${Math.floor(spanMin / 120)}h`;
    } else {
      left = `-${spanMin}m`;
      mid = `-${Math.floor(spanMin / 2)}m`;
    }
    const right = 'now';
    const dataChars = new Array(width).fill(' ');
    // left aligned at col 0
    for (let j = 0; j < left.length && j < width; j++) dataChars[j] = left[j];
    // mid centered
    const midStart = Math.floor(width / 2) - Math.floor(mid.length / 2);
    for (let j = 0; j < mid.length; j++) {
      const idx = midStart + j;
      if (idx >= 0 && idx < width) dataChars[idx] = mid[j];
    }
    // right at end
    const rightStart = width - right.length;
    for (let j = 0; j < right.length; j++) {
      const idx = rightStart + j;
      if (idx >= 0 && idx < width) dataChars[idx] = right[j];
    }
    lines.push(' '.repeat(labelW + 2) + dataChars.join(''));
  }

  if (zoomed) {
    lines.push(`  zoomed: floor ${fmtY(floorV)} (not 0)`);
  }
  return lines.join('\n');
}

/**
 * 8-bar Unicode sparkline for the table column. No y-axis labels.
 * Returns 8 chars wide regardless of input length (max-pool if longer,
 * pad with ─ if shorter — the shape stays comparable across rows).
 */
export function sparkline(vals: number[], width = 8): string {
  if (vals.length === 0 || vals.every(v => v === 0)) {
    return '─'.repeat(width);
  }
  const blocks = ' ▁▂▃▄▅▆▇█';
  const maxV = Math.max(...vals) || 1;
  // Downsample / index into width buckets
  let bars: number[];
  if (vals.length >= width) {
    const step = Math.max(1, Math.floor(vals.length / width));
    bars = [];
    for (let i = 0; i < width; i++) {
      const idx = i * step;
      bars.push(idx < vals.length ? vals[idx] : 0);
    }
  } else {
    bars = [...vals];
    while (bars.length < width) bars.push(0);
  }
  return bars
    .map(v => blocks[Math.min(8, Math.floor((v / maxV) * 8))])
    .join('');
}
