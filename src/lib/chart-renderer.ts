/**
 * G6 chart renderer: PNG output for MCP image content blocks.
 *
 * Used by tools that produce time series or bar-shaped data to emit a real
 * chart (alongside the JSON envelope) so hosts that render image content
 * — Claude Desktop, ChatGPT Desktop — surface a visual the user can scan
 * in one glance. Hosts that don't render images ignore the block.
 *
 * Tech choice: chart.js + chartjs-node-canvas. Chart.js is the most-trained-
 * on charting library in LLM corpora; its output looks conventional to
 * agents and humans. The node-canvas dependency requires Cairo on Linux
 * (one-time install pain); on Mac it Just Works. If init fails we fall
 * back to ASCII sparklines (the prior behavior) so a missing Cairo doesn't
 * block tool execution.
 *
 * All renderers return base64-encoded PNG so callers can drop the result
 * straight into a `{ type: 'image', data, mimeType: 'image/png' }` MCP
 * content block.
 */

import type { ChartConfiguration } from 'chart.js';

let canvasInstance: import('chartjs-node-canvas').ChartJSNodeCanvas | null = null;
let initAttempted = false;

const WIDTH = 720;
const HEIGHT = 360;

async function getCanvas(): Promise<import('chartjs-node-canvas').ChartJSNodeCanvas | null> {
  if (initAttempted) return canvasInstance;
  initAttempted = true;
  try {
    const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
    canvasInstance = new ChartJSNodeCanvas({
      width: WIDTH,
      height: HEIGHT,
      backgroundColour: '#ffffff',
      chartCallback: (ChartJS) => {
        // Slightly larger default font; cleaner ticks.
        ChartJS.defaults.font.family = 'system-ui, -apple-system, sans-serif';
        ChartJS.defaults.font.size = 12;
        ChartJS.defaults.color = '#222';
      },
    });
    return canvasInstance;
  } catch (e) {
    process.stderr.write(`[log10x-mcp] chart renderer init failed (fallback to no-image): ${(e as Error).message}\n`);
    return null;
  }
}

export interface TimeseriesPoint {
  t: string | number;
  value: number;
}

export interface RenderResult {
  /** Base64-encoded PNG ready for an MCP image content block. */
  base64: string;
  /** `image/png` literal so callers don't memorize it. */
  mimeType: 'image/png';
}

/**
 * Render a single-series timeseries chart. Used by `pattern_trend` and
 * the trend sparkline in `top_patterns` cards.
 */
export async function renderTimeseries(
  points: TimeseriesPoint[],
  opts: { title?: string; yLabel?: string; lineColor?: string } = {}
): Promise<RenderResult | null> {
  const canvas = await getCanvas();
  if (!canvas) return null;
  const config: ChartConfiguration<'line'> = {
    type: 'line',
    data: {
      labels: points.map((p) => String(p.t)),
      datasets: [
        {
          label: opts.yLabel ?? 'value',
          data: points.map((p) => p.value),
          fill: false,
          borderColor: opts.lineColor ?? '#1e88e5',
          backgroundColor: opts.lineColor ?? '#1e88e5',
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.2,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        legend: { display: false },
        title: opts.title ? { display: true, text: opts.title, font: { size: 14 } } : { display: false },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 8, maxRotation: 0 } },
        y: { beginAtZero: true, title: opts.yLabel ? { display: true, text: opts.yLabel } : undefined },
      },
    },
  };
  const buf = await canvas.renderToBuffer(config, 'image/png');
  return { base64: buf.toString('base64'), mimeType: 'image/png' };
}

export interface BarRow {
  label: string;
  value: number;
}

/**
 * Render a horizontal bar chart. Used by `top_patterns` (top N patterns by
 * cost) and `services` (services by share).
 */
export async function renderHorizontalBar(
  rows: BarRow[],
  opts: { title?: string; xLabel?: string; barColor?: string } = {}
): Promise<RenderResult | null> {
  const canvas = await getCanvas();
  if (!canvas) return null;
  const config: ChartConfiguration<'bar'> = {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.label.length > 40 ? r.label.slice(0, 37) + '…' : r.label),
      datasets: [
        {
          label: opts.xLabel ?? 'value',
          data: rows.map((r) => r.value),
          backgroundColor: opts.barColor ?? '#1e88e5',
          borderColor: opts.barColor ?? '#1e88e5',
          borderWidth: 0,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: false,
      plugins: {
        legend: { display: false },
        title: opts.title ? { display: true, text: opts.title, font: { size: 14 } } : { display: false },
      },
      scales: {
        x: { beginAtZero: true, title: opts.xLabel ? { display: true, text: opts.xLabel } : undefined },
        y: { ticks: { autoSkip: false } },
      },
    },
  };
  const buf = await canvas.renderToBuffer(config, 'image/png');
  return { base64: buf.toString('base64'), mimeType: 'image/png' };
}
