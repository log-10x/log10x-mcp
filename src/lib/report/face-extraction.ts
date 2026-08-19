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
/**
 * True when a template renders as opaque noise a prospect cannot read — only
 * short symbol/punctuation tokens, no word of 4+ letters and no space-separated
 * phrase. The engine occasionally emits such a body for a line it symbolized
 * almost entirely (e.g. a heavily-structured JSON metrics line), and showing
 * "-.ExmX.eKQs" in a customer deliverable reads as a rendering bug (F10). See
 * HANDOFF_ENGINE_DEMO_POC.md — the underlying parser mis-assignment is the
 * proper fix; this keeps the deliverable honest until then.
 */
function isReadableTemplate(t: string): boolean {
  if (!t) return false;
  // A real log line has either a run of lowercase letters that reads as a word
  // (5+), or two alpha tokens separated by a space (a phrase). Symbol-code
  // noise like "-.ExmX.eKQs" or "-5m2H4;1D!S" has neither: its "words" are
  // short CamelCase or mixed tokens joined by punctuation, not spaces.
  return /[a-z]{5,}/.test(t) || /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(t);
}

export function buildFace(p: ExtractedPattern, maxLines: number = MAX_FACE_LINES): EvidenceFace {
  // Prefer the abstracted template; if it is opaque, fall back to the real
  // sample line, which is always a readable log statement. The sample carries
  // concrete values instead of $ markers, so it is a faithful, if less
  // abstracted, face — never noise.
  const body =
    isReadableTemplate(p.template ?? '') || !p.sampleEvent
      ? (p.template ?? '')
      : p.sampleEvent;
  const rawLines = body.split('\n').filter((l) => l.trim().length > 0);
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
