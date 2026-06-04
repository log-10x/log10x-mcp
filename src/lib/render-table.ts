/**
 * renderMonospaceTable — generic fixed-width plain-text table builder.
 *
 * Produces a string suitable for placement inside a fenced code block
 * (must_render_verbatim). The renderer does NOT use markdown table
 * syntax because proportional fonts in IDE chat panels destroy alignment
 * of markdown tables; this uses space-padded ASCII that stays correct in
 * any monospace context.
 *
 * Layout:
 *   [title line]
 *   HEADER ROW (left/right-padded per column)
 *   DIVIDER ROW (─ repeated per column width)
 *   DATA ROWS
 *   [footer line]
 *
 * All widths are auto-computed from max(header.length, max(cell.length))
 * then optionally capped at max_width. Columns are separated by "  "
 * (two spaces).
 */

export interface Column<Row> {
  /** Column header text. */
  header: string;
  /** Cell alignment. */
  align: 'left' | 'right';
  /** Extract the cell value from a row as a string. */
  get: (row: Row) => string;
  /** Optional width cap. Cells longer than this are truncated with …. */
  max_width?: number;
}

export interface RenderTableOpts {
  title?: string;
  footer?: string;
  /** Column separator. Defaults to "  " (two spaces). */
  separator?: string;
}

/**
 * Render a plain-text monospace table from a row array and column descriptors.
 *
 * @param rows    - Data rows to render.
 * @param columns - Column descriptors (order matches rendered order).
 * @param opts    - Optional title / footer / separator.
 * @returns       Multi-line string. Caller places it inside a fenced code block.
 */
export function renderMonospaceTable<Row>(
  rows: Row[],
  columns: Column<Row>[],
  opts?: RenderTableOpts
): string {
  const sep = opts?.separator ?? '  ';

  // Collect all cell strings per column (header + data), compute widths.
  const cells: string[][] = columns.map((col) => rows.map((row) => col.get(row)));

  const widths: number[] = columns.map((col, ci) => {
    const maxData = cells[ci].reduce((m, c) => Math.max(m, c.length), 0);
    const raw = Math.max(col.header.length, maxData);
    return col.max_width != null ? Math.min(raw, col.max_width) : raw;
  });

  // Build a padded cell string.
  function pad(text: string, width: number, align: 'left' | 'right'): string {
    const truncated = text.length > width ? text.slice(0, width - 1) + '…' : text;
    const spaces = width - truncated.length;
    if (align === 'right') return ' '.repeat(spaces) + truncated;
    return truncated + ' '.repeat(spaces);
  }

  const lines: string[] = [];

  if (opts?.title) lines.push(opts.title);

  // Header row.
  lines.push(columns.map((col, ci) => pad(col.header, widths[ci], col.align)).join(sep));

  // Divider row.
  lines.push(widths.map((w) => '─'.repeat(w)).join(sep));

  // Data rows.
  for (let ri = 0; ri < rows.length; ri++) {
    lines.push(columns.map((col, ci) => pad(cells[ci][ri], widths[ci], col.align)).join(sep));
  }

  if (opts?.footer) lines.push(opts.footer);

  return lines.join('\n');
}
