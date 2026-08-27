/**
 * Export-plan registry.
 *
 * Step 2 of the fenced POC: the server emits a shell script, the user reads
 * it, the user runs it OUTSIDE the container with their own credentials, and
 * it lands a log sample on disk. Nothing here contacts anything — the module
 * renders text.
 *
 * Adding a SIEM:
 *   1. Write an emitter under this directory that mirrors the connector's
 *      query grammar and imports its bucket constants rather than retyping
 *      them.
 *   2. Register it in `EMITTERS` below and add its id to `EXPORT_PLAN_SIEMS`
 *      in `_shared.ts`.
 *   3. Add a golden file under `test/fixtures/export-plan/`.
 */

import { emitCloudwatchPlan } from './cloudwatch.js';
import { emitDatadogPlan } from './datadog.js';
import { emitElasticsearchPlan } from './elasticsearch.js';
import { emitSplunkPlan } from './splunk.js';
import {
  DEFAULT_TARGET_EVENT_COUNT,
  EXPORT_PLAN_FOLLOW_UPS,
  EXPORT_PLAN_SIEMS,
  type ExportPlanSiemId,
  type SamplePlan,
  type SamplePlanOptions,
} from './_shared.js';

const EMITTERS: Record<ExportPlanSiemId, (o: SamplePlanOptions) => SamplePlan> = {
  cloudwatch: emitCloudwatchPlan,
  splunk: emitSplunkPlan,
  elasticsearch: (o) => emitElasticsearchPlan(o, 'elasticsearch'),
  opensearch: (o) => emitElasticsearchPlan(o, 'opensearch'),
  datadog: emitDatadogPlan,
};

export class UnsupportedExportSiemError extends Error {
  constructor(siem: string) {
    const followUp = EXPORT_PLAN_FOLLOW_UPS.find((f) => f.id === siem);
    super(
      followUp
        ? `No export script for ${followUp.displayName} yet. The fenced POC currently emits scripts for ` +
            `${EXPORT_PLAN_SIEMS.join(', ')}. Export a sample with your own tooling into plain text files, ` +
            `one log message per line, and run the POC over those instead.`
        : `Unknown SIEM "${siem}". Export scripts exist for: ${EXPORT_PLAN_SIEMS.join(', ')}.`,
    );
    this.name = 'UnsupportedExportSiemError';
  }
}

/** True when an export script exists for this SIEM id. */
export function hasExportPlan(siem: string): siem is ExportPlanSiemId {
  return (EXPORT_PLAN_SIEMS as readonly string[]).includes(siem);
}

/**
 * Render the export script for one SIEM.
 *
 * The bucket draw happens here, once, so the returned script carries literal
 * timestamps. Two calls produce two different samples, which is the same
 * property the live connectors have and the reason a prospect re-running a
 * POC does not re-read the same slice of their logs.
 */
export function emitSamplePlan(opts: SamplePlanOptions): SamplePlan {
  if (!hasExportPlan(opts.siem)) throw new UnsupportedExportSiemError(opts.siem);
  return EMITTERS[opts.siem](opts);
}

export {
  DEFAULT_TARGET_EVENT_COUNT,
  EXPORT_PLAN_FOLLOW_UPS,
  EXPORT_PLAN_SIEMS,
};
export type { ExportPlanSiemId, SamplePlan, SamplePlanOptions };
