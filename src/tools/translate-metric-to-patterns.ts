/**
 * log10x_translate_metric_to_patterns — preset wrapper for the customer-
 * metric-to-log-patterns direction of cross-pillar correlation.
 *
 * This is the "agent looking at an APM metric asks what logs correspond"
 * workflow. It's the most common direction in practice and agents route
 * more reliably to a descriptively-named tool than to
 * `log10x_correlate_cross_pillar` with an `anchor_type` parameter.
 *
 * Internally it just calls `executeCorrelateCrossPillar` with
 * `anchor_type: 'customer_metric'`. The output shape is identical.
 *
 * Tier prerequisite: same as correlate_cross_pillar.
 * This tool issues the same 4-12 PromQL queries as correlate_cross_pillar.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { executeCorrelateCrossPillar } from './correlate-cross-pillar.js';

export const translateMetricToPatternsSchema = {
  customer_metric: z
    .string()
    .describe('Customer PromQL metric expression. Example: `apm_request_duration_p99{service="payments-svc"}` or `container_memory_rss{pod="payments-svc-7f9d-xk2z"}`.'),
  window: z.string().default('1h').describe('Time window for correlation. `1h` default. Alias: `timeRange`.'),
  timeRange: z.string().optional().describe('Alias for `window` for consistency with other Log10x tools.'),
  step: z.string().default('60s').describe('Bucket step. Default 60s.'),
  depth: z
    .enum(['shallow', 'normal', 'deep'])
    .default('normal')
    .describe('`shallow` / `normal` / `deep`.'),
  minimum_confidence: z.number().min(0).max(1).default(0.3),
  environment: z.string().optional(),
};

export async function executeTranslateMetricToPatterns(
  args: {
    customer_metric: string;
    window: string;
    timeRange?: string;
    step: string;
    depth: 'shallow' | 'normal' | 'deep';
    minimum_confidence: number;
    environment?: string;
  },
  env: EnvConfig
): Promise<string> {
  const window = args.window || args.timeRange || '1h';
  return executeCorrelateCrossPillar(
    {
      anchor_type: 'customer_metric',
      anchor: args.customer_metric,
      window,
      step: args.step,
      depth: args.depth,
      minimum_confidence: args.minimum_confidence,
      environment: args.environment,
    },
    env
  );
}
