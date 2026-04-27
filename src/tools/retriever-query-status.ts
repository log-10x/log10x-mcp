/**
 * log10x_retriever_query_status — poll the CloudWatch diagnostics for an
 * in-flight or recently-completed retriever query.
 *
 * Use when a prior `log10x_retriever_query` returned diagnostics with
 * `partialResults: true` (MCP poll budget exceeded before server query
 * finished), or when the agent wants to verify a queryId's progress
 * without re-running the full query. This tool does NOT re-query S3 for
 * result events — it only reads the query's CW log streams and returns
 * a fresh diagnostics snapshot. To fetch events, re-run
 * `log10x_retriever_query`.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import {
  getRetrieverQueryStatus,
  explainZeroResults,
  type RetrieverQueryDiagnostics,
} from '../lib/retriever-diagnostics.js';
import { fmtCount } from '../lib/format.js';

export const retrieverQueryStatusSchema = {
  queryId: z.string().describe('The queryId returned by log10x_retriever_query.'),
  queryStartedAt: z
    .number()
    .optional()
    .describe(
      'Epoch ms of when the original query was submitted. Bounds the CW log scan to events from that point onward. Defaults to 5 minutes before now if omitted.',
    ),
  environment: z.string().optional().describe('Environment nickname.'),
};

export async function executeRetrieverQueryStatus(
  args: { queryId: string; queryStartedAt?: number },
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
  lines.push(statusInterpretation(diag));

  return lines.join('\n');
}

function statusInterpretation(diag: RetrieverQueryDiagnostics): string {
  const workersDone =
    diag.workerStats !== undefined &&
    diag.workerStats.complete === diag.workerStats.started &&
    diag.workerStats.started > 0;

  if (workersDone && diag.workerStats && diag.workerStats.totalResultEvents > 0) {
    return `_Status: **complete** — ${fmtCount(diag.workerStats.totalResultEvents)} result events. Re-run log10x_retriever_query to retrieve them._`;
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
