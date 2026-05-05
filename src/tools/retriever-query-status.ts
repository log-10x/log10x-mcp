/**
 * log10x_retriever_query_status — poll diagnostics and optionally fetch
 * results for an in-flight or recently-completed retriever query.
 *
 * Use when a prior `log10x_retriever_query` returned diagnostics with
 * `partialResults: true` (MCP poll budget exceeded before the server query
 * finished). The engine still finishes the scan and uploads results to S3
 * under `qr/{queryId}/`. Calling this tool with `fetch_results: true`
 * recovers those stranded events directly — re-running
 * `log10x_retriever_query` would submit a new queryId and the original
 * results would remain inaccessible. Default `fetch_results: false`
 * preserves the original diagnostics-only behavior.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import {
  getRetrieverQueryStatus,
  explainZeroResults,
  type RetrieverQueryDiagnostics,
} from '../lib/retriever-diagnostics.js';
import {
  fetchExistingResults,
  isRetrieverConfigured,
  type RetrieverEvent,
} from '../lib/retriever-api.js';
import { retrieverNotConfiguredMessage } from './retriever-query.js';
import { fmtCount } from '../lib/format.js';

export const retrieverQueryStatusSchema = {
  queryId: z.string().describe('The queryId returned by log10x_retriever_query.'),
  queryStartedAt: z
    .number()
    .optional()
    .describe(
      'Epoch ms of when the original query was submitted. Bounds the CW log scan to events from that point onward. Defaults to 5 minutes before now if omitted.',
    ),
  fetch_results: z
    .boolean()
    .default(false)
    .describe(
      'When true, after the diagnostics check, fetch the events directly from the queryId\'s qr/ S3 prefix and append a sample to the response. Use this to recover events from a partialResults query without resubmitting (which would generate a new queryId). Requires the engine to have completed; if `_DONE.json` is missing the events block reports the in-flight state.',
    ),
  target: z
    .string()
    .optional()
    .describe(
      'Target app prefix for the original query. Defaults to the configured retriever target. Pass only when the original query used a non-default target.',
    ),
  environment: z.string().optional().describe('Environment nickname.'),
};

export async function executeRetrieverQueryStatus(
  args: { queryId: string; queryStartedAt?: number; fetch_results?: boolean; target?: string },
  _env: EnvConfig,
): Promise<string> {
  const startTime = args.queryStartedAt ?? (Date.now() - 5 * 60_000);
  const diag = await getRetrieverQueryStatus(args.queryId, startTime);

  const lines: string[] = [];
  lines.push(`## Retriever Query Status — \`${args.queryId}\``);
  lines.push('');

  if (diag.pollingError) {
    lines.push(`**Error polling CloudWatch**: ${diag.pollingError}`);
    return lines.join('\n');
  }

  if (diag.queryPlan) {
    const p = diag.queryPlan;
    lines.push(`**Plan**: ${p.templateHashes} template hashes · ${p.vars} var sets · dispatch=${p.dispatch} · timeslice=${p.timeslice}ms`);
  } else {
    lines.push('**Plan**: _not yet observed in CloudWatch_');
  }

  if (diag.emptyReason) {
    lines.push(`**Empty**: ${diag.emptyReason}`);
  }

  if (diag.scanStats) {
    const s = diag.scanStats;
    lines.push(
      `**Scan**: ${fmtCount(s.scanned)} scanned · ${fmtCount(s.matched)} matched · ` +
        `${fmtCount(s.skippedSearch)} skipped (search) · ${fmtCount(s.skippedTemplate)} (template) · ` +
        `${fmtCount(s.skippedDuplicate)} (duplicate)`,
    );
  } else {
    lines.push('**Scan**: _no sub-query has reported scan completion yet_');
  }

  if (diag.streamDispatch) {
    const d = diag.streamDispatch;
    lines.push(`**Stream dispatch**: ${d.requests} requests · ${d.objects} objects · ${d.blobs} target blobs`);
  }

  if (diag.workerStats) {
    const w = diag.workerStats;
    lines.push(
      `**Workers**: ${w.complete}/${w.started} complete · ${fmtCount(w.totalFetchedBytes)} bytes fetched · ` +
        `${fmtCount(w.totalResultEvents)} result events decoded`,
    );
  }

  if (diag.coordinatorElapsedMs !== undefined) {
    lines.push(`**Coordinator**: ${diag.coordinatorElapsedMs}ms plan+dispatch time`);
  }

  if (diag.errors && diag.errors.length > 0) {
    lines.push(`**Errors**: ${diag.errors.length} — first: _${diag.errors[0].slice(0, 160)}_`);
  }

  lines.push('');
  lines.push(statusInterpretation(diag, args.fetch_results));

  // ── Optional: fetch events directly from the qr/ S3 prefix. ──
  // Required to recover events from a `partialResults: true` query without
  // resubmitting. Re-running retriever_query would generate a new queryId
  // and leave the original results stranded.
  if (args.fetch_results) {
    if (!isRetrieverConfigured()) {
      lines.push('');
      lines.push(retrieverNotConfiguredMessage());
      return lines.join('\n');
    }
    lines.push('');
    lines.push('### Results fetch');
    lines.push('');
    try {
      const fetched = await fetchExistingResults(args.queryId, { target: args.target });
      if (!fetched.done) {
        lines.push(
          `_Engine has not written \`_DONE.json\` yet — query still in-flight. ${fmtCount(
            fetched.events.length,
          )} partial events recovered from \`${fetched.jsonlObjectCount}\` worker files so far. Re-run with \`fetch_results: true\` after another diagnostics check shows complete._`,
        );
      } else if (fetched.events.length === 0) {
        lines.push(
          `_Query complete (\`_DONE.json\` present), zero events recovered. Workers wrote \`${fetched.jsonlObjectCount}\` jsonl files but none contained events. See \`Empty\` reason above._`,
        );
      } else {
        lines.push(
          `**Recovered**: ${fmtCount(fetched.events.length)} events from \`${fetched.jsonlObjectCount}\` worker files` +
            (fetched.truncated ? ` (some workers hit per-worker truncation cap)` : '') +
            `. Target: \`${fetched.target}\`.`,
        );
        lines.push('');
        const sampleSize = Math.min(fetched.events.length, 50);
        lines.push(`_Sample (${sampleSize} of ${fetched.events.length}):_`);
        lines.push('');
        lines.push('```');
        for (let i = 0; i < sampleSize; i++) {
          lines.push(formatRecoveredEvent(fetched.events[i]));
        }
        lines.push('```');
        if (fetched.events.length > sampleSize) {
          lines.push('');
          lines.push(
            `_${fetched.events.length - sampleSize} additional events recovered but not rendered. Use \`log10x_retriever_query\` with the same time window to re-fetch with full formatting if needed._`,
          );
        }
      }
    } catch (e) {
      lines.push(`_Failed to fetch results: ${(e as Error).message}_`);
    }
  }

  return lines.join('\n');
}

function formatRecoveredEvent(ev: RetrieverEvent): string {
  const ts = ev.timestamp ? String(ev.timestamp) : '?';
  const sev = (ev.severity_level || ev.severity || '').toString();
  const svc = (ev.tenx_user_service || ev.service || '').toString();
  const text = (ev.text || '').toString().slice(0, 200);
  const sevPart = sev ? ` ${sev}` : '';
  const svcPart = svc ? ` [${svc}]` : '';
  return `${ts}${sevPart}${svcPart} ${text}`;
}

function statusInterpretation(diag: RetrieverQueryDiagnostics, fetchRequested?: boolean): string {
  const workersDone =
    diag.workerStats !== undefined &&
    diag.workerStats.complete === diag.workerStats.started &&
    diag.workerStats.started > 0;

  if (workersDone && diag.workerStats && diag.workerStats.totalResultEvents > 0) {
    if (fetchRequested) {
      return `_Status: **complete** — ${fmtCount(diag.workerStats.totalResultEvents)} result events. Recovered events appear below._`;
    }
    return `_Status: **complete** — ${fmtCount(diag.workerStats.totalResultEvents)} result events. Call this tool again with \`fetch_results: true\` to recover them directly from S3 (re-running log10x_retriever_query would generate a new queryId)._`;
  }

  if (workersDone && (!diag.workerStats || diag.workerStats.totalResultEvents === 0)) {
    const zero = explainZeroResults(diag);
    return `_Status: **complete, zero events** — ${zero || 'no events matched.'}_`;
  }

  if (diag.workerStats && diag.workerStats.complete < diag.workerStats.started) {
    return `_Status: **in-flight** — ${diag.workerStats.complete}/${diag.workerStats.started} workers complete. Check again in a few seconds._`;
  }

  if (diag.queryPlan && !diag.scanStats) {
    return '_Status: **scan pending** — query coordinator dispatched but no scan stats yet. Either the scan is running or CW events have not flushed. Retry in a few seconds._';
  }

  if (!diag.queryPlan) {
    return '_Status: **unknown** — no CloudWatch events observed for this queryId yet. Verify the queryId is correct and the query was submitted in the last few minutes._';
  }

  return '_Status: **unclear** — see raw fields above._';
}
