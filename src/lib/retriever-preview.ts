/**
 * Event text for a retriever preview.
 *
 * The preview used to cut every event at 240 characters with no marker, so an
 * agent quoting a fetched line could not tell it was quoting a fragment: on
 * the homepage demo the recommendation lines came out as "... - Transient
 * error StatusCode.UNAVA" and "... - Receive ListRecommend". A preview holds
 * at most ten events, so it can carry them whole. Only an event over
 * PREVIEW_TEXT_MAX_CHARS (a multi-kilobyte blob, not a log line) is shortened,
 * and then the entry says so in `text_truncated` and `text_chars`, so nobody
 * mistakes the fragment for the line.
 */

export const PREVIEW_TEXT_MAX_CHARS = 8_000;

export interface PreviewText {
  text?: string;
  /** Present and true only when `text` is a prefix of a longer event. */
  text_truncated?: true;
  /** The full event length, present only alongside `text_truncated`. */
  text_chars?: number;
}

export function previewText(raw: unknown): PreviewText {
  if (typeof raw !== 'string') return {};
  if (raw.length <= PREVIEW_TEXT_MAX_CHARS) return { text: raw };
  return {
    text: raw.slice(0, PREVIEW_TEXT_MAX_CHARS),
    text_truncated: true,
    text_chars: raw.length,
  };
}
