/**
 * Face extraction — turn an ExtractedPattern's template into the
 * masked evidence face the report renders.
 *
 * A face is the pattern body with every variable slot shown as a
 * masked `$` chip — the product visibly working. The template already
 * carries `$` / `$(...)` slot markers from the engine; this module
 * only re-shapes them into render segments. It NEVER truncates inside
 * a line: long lines wrap/scroll in the template's CSS, and lines
 * beyond the cap are elided by COUNT ("+ N more lines in this
 * statement"), which is the one permitted elision.
 */

import type { ExtractedPattern } from '../pattern-extraction.js';
import type { EvidenceFace, FaceLine, FaceSegment } from './report-data.js';

/** Face lines shown before count-elision kicks in. */
export const MAX_FACE_LINES = 3;

/**
 * Matches one variable slot: `$(...)` (typed slot with format hint,
 * e.g. `$(yyyy-MM-dd'T'HH:mm:ss)`) or a bare `$`.
 */
const SLOT_RE = /\$\([^)]*\)|\$/g;

/** Split one template line into text / val / tab segments. */
export function segmentLine(line: string): FaceSegment[] {
  const segs: FaceSegment[] = [];
  const pushText = (s: string): void => {
    if (s.length === 0) return;
    // Tabs are the engine's field separators — surface them as their
    // own segment so the renderer can draw the ⇥ mark.
    const parts = s.split('\t');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) segs.push({ t: 'tab' });
      if (parts[i].length > 0) segs.push({ t: 'text', s: parts[i] });
    }
  };
  let last = 0;
  for (const m of line.matchAll(SLOT_RE)) {
    pushText(line.slice(last, m.index));
    // A typed slot keeps its format hint as visible text after the
    // chip (the mock renders `$(yyyy-MM-dd...)` as chip + hint).
    const body = m[0];
    segs.push({ t: 'val' });
    if (body.length > 1) {
      segs.push({ t: 'text', s: body.slice(1) });
    }
    last = (m.index ?? 0) + body.length;
  }
  pushText(line.slice(last));
  return segs;
}

/**
 * Build the masked face for a pattern. `bytesEach` is window
 * arithmetic (total bytes / count), rounded to whole bytes.
 */
export function buildFace(p: ExtractedPattern, maxLines: number = MAX_FACE_LINES): EvidenceFace {
  const rawLines = (p.template ?? '').split('\n').filter((l) => l.trim().length > 0);
  const shown = rawLines.slice(0, maxLines);
  const lines: FaceLine[] = shown.map((l, i) => ({
    cont: i > 0,
    segs: segmentLine(l),
  }));
  const elided = rawLines.length - shown.length;
  const count = Math.max(1, p.count);
  return {
    // tenx_hash is the query key the forwarder stamps on events; the
    // structural templateHash is the internal fallback identifier.
    hash: p.tenxHash ?? p.hash,
    count: p.count,
    bytesEach: Math.round(p.bytes / count),
    lines,
    ...(elided > 0 ? { elidedLineCount: elided } : {}),
  };
}
