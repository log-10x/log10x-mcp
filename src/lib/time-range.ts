/**
 * Shared timeRange enum for all tools.
 *
 * Canonical token: '24h' for the one-day window (explicit, unambiguous).
 * Legacy alias:    '1d'  — normalized to '24h' at the tool handler level
 *                          for tools that previously declared '1d'.
 */

import { z } from 'zod';

/**
 * The canonical set of timeRange values accepted by every tool that
 * takes a timeRange argument.  Import this and use it directly in
 * each tool's schema object instead of re-declaring z.enum([...]).
 */
export const TIME_RANGE_ENUM = ['15m', '1h', '6h', '24h', '7d', '30d'] as const;

export type TimeRangeValue = (typeof TIME_RANGE_ENUM)[number];

export const timeRangeSchema = z
  .enum(TIME_RANGE_ENUM)
  .describe(
    "Time range. Use '24h' for a one-day window. Sub-day values (15m/1h/6h) " +
    "show fine-grained trajectory around an incident; '7d' and '30d' for " +
    "baseline and trend views."
  );

/**
 * Normalise any accepted legacy token to the canonical value.
 * Currently: '1d' → '24h'.
 * Returns the input unchanged when it is already canonical.
 */
export function normalizeTimeRange(raw: string): string {
  if (raw === '1d') return '24h';
  return raw;
}
