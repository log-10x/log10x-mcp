/**
 * log10x://status resource — pipeline health summary.
 *
 * AI assistants can read this for context before answering questions.
 */

import type { EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { parsePrometheusValue, bytesToGb } from '../lib/cost.js';
import { fmtBytes } from '../lib/format.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';

export async function getStatus(env: EnvConfig): Promise<string> {
  const metricsEnv = await resolveMetricsEnv(env);
  const [pipeRes, svcRes, volRes] = await Promise.all([
    queryInstant(env, pql.pipelineUp()).catch(() => null),
    queryInstant(env, pql.distinctServices('24h')).catch(() => null),
    queryInstant(env, pql.totalBytes(metricsEnv, '24h')).catch(() => null),
  ]);

  const pipelines = pipeRes?.data?.result?.[0] ? Math.round(parsePrometheusValue(pipeRes.data.result[0])) : 0;
  const services = svcRes?.data?.result?.[0] ? Math.round(parsePrometheusValue(svcRes.data.result[0])) : 0;
  const vol24h = volRes?.data?.result?.[0] ? parsePrometheusValue(volRes.data.result[0]) : 0;

  const lines: string[] = [];
  lines.push('Log10x Pipeline Status');
  lines.push('');

  if (pipelines > 0 || services > 0 || vol24h > 0) {
    lines.push(`  Pipeline instances: ${pipelines}`);
    lines.push(`  Services monitored: ${services}`);
    lines.push(`  Volume (24h): ${fmtBytes(vol24h)} (${bytesToGb(vol24h).toFixed(1)} GB)`);
    lines.push('');
    lines.push('  Status: active');
  } else {
    lines.push('  No pipeline data available.');
    lines.push('  Data appears after the first 24h of collection.');
  }

  return lines.join('\n');
}
