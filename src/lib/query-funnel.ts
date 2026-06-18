/**
 * Query funnel diagnosis.
 *
 * Turns the engine's `_DONE.json` completion marker into a stage-by-stage
 * funnel plus a single verdict the MCP — and the agent reading its output —
 * can branch on to debug a zero-result query, instead of seeing a bare
 * "0 events" and guessing.
 *
 * The engine's query path is a 5-stage assembly line:
 *
 *     dispatch -> resolve blobs -> bloom scan -> filter match -> stream events
 *
 * The coordinator's `_DONE` marker carries counters for the stages it can see.
 * One structural caveat: in REMOTE dispatch the coordinator hands each
 * time-slice to a subquery and does no scanning itself, so its own
 * `scanned`/`matched` counters stay 0 and do NOT reflect what the subqueries
 * found. A `reason:"dispatched"` outcome with zero downstream counts is
 * therefore genuinely ambiguous — we report DISPATCHED_BLIND and say exactly
 * why, rather than pretend to localize it. Every other reason the marker
 * reports precisely, and `eventsReturned` (the actual qr/ files on disk) is
 * always authoritative for success.
 *
 * `reason` values come from the engine close() classifier (IndexQueryWriter):
 *   dispatched | empty-range | bloom-miss | match-no-dispatch | success | unknown
 */

/** The `_DONE.json` marker the engine coordinator writes to qr/<queryId>/. */
export interface DoneMarker {
  queryId?: string;
  /** Engine close() classifier; the primary signal. */
  reason?: string;
  /** Blobs the COORDINATOR scanned (0 in remote dispatch — see file header). */
  scanned?: number;
  /** Blobs that passed the bloom (coordinator view). */
  matched?: number;
  skippedSearch?: number;
  skippedTemplate?: number;
  streamRequests?: number;
  streamBlobs?: number;
  /** Subqueries fanned out (remote dispatch). */
  submittedTasks?: number;
  expectedMarkers?: number;
  elapsedMs?: number;
}

export type QueryVerdict =
  | 'OK' //                events came back
  | 'NO_MARKER' //         no _DONE yet (still running / never marked)
  | 'EMPTY_RANGE' //       no index blobs for the window (no data OR time-mapping broken)
  | 'BLOOM_REJECTED_ALL' //blobs scanned, search term in none of them
  | 'MATCHED_NO_EVENTS' // marker-only: something matched but no events landed
  | 'STREAM_FETCH_EMPTY' //ground truth: matched, but stream workers fetched 0 bytes
  | 'FILTER_NO_MATCH' //   ground truth: fetched bytes, exact predicate matched 0
  | 'DELIVERY_INCOMPLETE' //ground truth: events written but not read back
  | 'DISPATCHED_BLIND' //  remote dispatch; coordinator can't see subquery outcome
  | 'INCONCLUSIVE'; //     finished, zero events, marker lacks detail

export interface QueryFunnel {
  /** Subqueries fanned out (submittedTasks). null when not reported. */
  dispatched: number | null;
  /** Blobs scanned. NOTE: coordinator-only in remote dispatch (see coordinatorBlind). */
  scanned: number | null;
  /** Blobs that passed the bloom. Coordinator-only in remote dispatch. */
  bloomMatched: number | null;
  skippedSearch: number | null;
  skippedTemplate: number | null;
  streamRequests: number | null;
  /** Events actually downloaded from qr/ — always authoritative. */
  eventsReturned: number;
  /** True => scanned/bloomMatched reflect only the coordinator, not the subqueries. */
  coordinatorBlind: boolean;
}

export interface QueryDiagnosis {
  verdict: QueryVerdict;
  funnel: QueryFunnel;
  /** Plain-English statement of what the funnel shows. */
  explanation: string;
  /** What to do next — the actionable branch for the agent. */
  hint: string;
}

const num = (v: number | undefined | null): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Per-stage stats parsed from the engine's own DEBUG/PERF CloudWatch events
 * (retriever-diagnostics.buildDiagnostics) — the GROUND TRUTH for what each
 * stage actually did, as opposed to the coordinator marker's blind aggregate.
 * Every field is what the engine reported; nothing is inferred.
 */
export interface CloudWatchStageStats {
  /** Index blobs the bloom scan examined. */
  scanned?: number;
  /** Blobs whose bloom matched the search (candidates to fetch). */
  matched?: number;
  /** Stream workers dispatched to fetch matched objects. */
  streamWorkers?: number;
  /** Stream workers that reported completion. */
  workersComplete?: number;
  /** Total bytes the stream workers actually read from the source objects. */
  fetchedBytes?: number;
  /** Events the results writer wrote after the exact predicate. */
  resultEvents?: number;
}

/**
 * Ground-truth verdict from the engine's per-stage CloudWatch events. Returns
 * null when the stats are absent/empty (CW not configured, or the run wasn't
 * DEBUG) so the caller falls back to the marker-only `diagnoseQuery`.
 *
 * The funnel, stage by stage, exactly as the engine reports it:
 *   scanned -> matched(bloom) -> workers -> fetchedBytes -> resultEvents -> delivered
 */
export function diagnoseFromStats(
  s: CloudWatchStageStats | null | undefined,
  eventsReturned: number,
): QueryDiagnosis | null {
  if (!s) return null;
  const scanned = num(s.scanned);
  const matched = num(s.matched);
  const workers = num(s.streamWorkers);
  const fetchedBytes = num(s.fetchedBytes);
  const resultEvents = num(s.resultEvents);
  // Nothing parsed → no ground truth to offer.
  if (scanned == null && matched == null && workers == null) return null;

  const funnel: QueryFunnel = {
    dispatched: workers,
    scanned,
    bloomMatched: matched,
    skippedSearch: null,
    skippedTemplate: null,
    streamRequests: workers,
    eventsReturned,
    coordinatorBlind: false, // these are the workers' own reported numbers
  };

  if (eventsReturned > 0) {
    return { verdict: 'OK', funnel, explanation: `Returned ${eventsReturned} event(s).`, hint: 'No action needed.' };
  }
  if ((scanned ?? 0) === 0) {
    return {
      verdict: 'EMPTY_RANGE',
      funnel,
      explanation: 'The scan examined 0 index blobs for this window.',
      hint: 'No data in range, or the time->blob mapping returned nothing. Widen the range; if a window with known data still scans 0, the index time-mapping is the bug.',
    };
  }
  if ((matched ?? 0) === 0) {
    return {
      verdict: 'BLOOM_REJECTED_ALL',
      funnel,
      explanation: `Scanned ${scanned} blob(s); the bloom matched none for this search.`,
      hint: 'The search value is not in the index for this window. Try match-all to confirm the blobs hold events; the bloom is the source of truth for candidacy.',
    };
  }
  // Matched > 0: the bloom found candidates. Now follow the bytes.
  if ((fetchedBytes ?? 0) === 0 && (workers ?? 0) > 0) {
    return {
      verdict: 'STREAM_FETCH_EMPTY',
      funnel,
      explanation: `Bloom matched ${matched} blob(s) and ${workers} stream worker(s) ran, but reported fetched 0 bytes from the source objects, so 0 events were written. The match stage is fine; the bytes did not come back. Cause is not determined from these stats alone — this is an observation, not a root cause.`,
      hint: 'The fetch (object-read) stage returned 0 bytes — not the search. Do NOT assume an engine fault: trace the read path in the engine source (which bucket/key/byte-range the worker reads), check the read-container config, and confirm the query + target object are well-formed before concluding where the fault is.',
    };
  }
  if ((resultEvents ?? 0) === 0) {
    return {
      verdict: 'FILTER_NO_MATCH',
      funnel,
      explanation: `Fetched ${fetchedBytes} byte(s) from ${matched} matched blob(s), but the exact predicate matched 0 events (the bloom is approximate; the precise filter is the truth).`,
      hint: 'The blobs were bloom-candidates but no event passed the exact predicate (the bloom is approximate). Check the field/value against the real data; if it does contain matches, trace the exact-filter path in the engine source before concluding a fault.',
    };
  }
  // Wrote events but the caller got none → delivery/path gap.
  return {
    verdict: 'DELIVERY_INCOMPLETE',
    funnel,
    explanation: `The results writer wrote ${resultEvents} event(s), but ${eventsReturned} reached the caller — a delivery/read-back gap (wrong prefix, or still arriving).`,
    hint: 'Events were written but not read back. Re-fetch by queryId; if still missing, the result prefix the caller polls differs from where the writer wrote.',
  };
}

/**
 * Diagnose a query from its `_DONE` marker and the number of events that
 * actually came back. Pure + side-effect-free so it is trivially testable.
 */
export function diagnoseQuery(
  done: DoneMarker | null,
  eventsReturned: number,
  opts?: { failedWorkerFiles?: number },
): QueryDiagnosis {
  const failed = opts?.failedWorkerFiles ?? 0;
  const reason = done?.reason;
  const remote = reason === 'dispatched';

  const funnel: QueryFunnel = {
    dispatched: num(done?.submittedTasks),
    scanned: num(done?.scanned),
    bloomMatched: num(done?.matched),
    skippedSearch: num(done?.skippedSearch),
    skippedTemplate: num(done?.skippedTemplate),
    streamRequests: num(done?.streamRequests),
    eventsReturned,
    coordinatorBlind: remote,
  };

  // 1. No marker — still running, or the engine dropped the query pre-completion.
  if (!done) {
    return {
      verdict: 'NO_MARKER',
      funnel,
      explanation:
        'No _DONE marker found — the query is still running, or the engine never wrote a completion marker for it.',
      hint: 'Poll again with retriever_query_status. If it never appears, the query was dropped before completion (inspect the engine queue-consumer logs for a parse/handler error).',
    };
  }

  // 2. Events came back — authoritative regardless of coordinator counters.
  if (eventsReturned > 0) {
    return {
      verdict: 'OK',
      funnel,
      explanation:
        `Query returned ${eventsReturned} event(s).` +
        (failed > 0 ? ` ${failed} worker file(s) failed to download — results are partial.` : ''),
      hint: failed > 0 ? 'Retry fetch_results to recover the failed worker files.' : 'No action needed.',
    };
  }

  // 3. Something matched but no events landed (stream requested, or bloom matched).
  const streamReq = funnel.streamRequests ?? 0;
  const bloomHit = funnel.bloomMatched ?? 0;
  if (!remote && (streamReq > 0 || bloomHit > 0 || failed > 0 || reason === 'match-no-dispatch')) {
    const streamFailed = streamReq > 0 && failed > 0;
    return {
      verdict: 'MATCHED_NO_EVENTS',
      funnel,
      explanation: streamFailed
        ? `Matched and requested ${streamReq} stream worker(s), but ${failed} worker file(s) failed and zero events landed.`
        : `Blobs matched the bloom (${bloomHit}) but no events survived the exact predicate, so zero events came back.`,
      hint: streamFailed
        ? 'Stream workers ran but their output is missing — check stream-worker fetch/permission errors, then retry fetch_results.'
        : 'The bloom is approximate; the exact filter is the source of truth and it rejected everything. Probe the field\'s real values — the predicate field/value likely does not match the data.',
    };
  }

  // 4. Reasons the coordinator reports precisely (local dispatch).
  switch (reason) {
    case 'empty-range':
      return {
        verdict: 'EMPTY_RANGE',
        funnel,
        explanation: 'No index blobs were found for the queried time window.',
        hint: 'Either the window genuinely has no data, or the time-range -> blob mapping (r/ reference -> b/ blobs) is not resolving. Widen the range; if a window you KNOW has data still returns EMPTY_RANGE, the index time-mapping is the bug.',
      };
    case 'bloom-miss':
      return {
        verdict: 'BLOOM_REJECTED_ALL',
        funnel,
        explanation: `Scanned ${funnel.scanned ?? '?'} blob(s); the search term was present in none of them (every blob bloom-rejected).`,
        hint: 'The search value is not indexed for this window. Re-run with no predicate (match-all) to confirm the blobs hold events, then probe what values the field actually carries.',
      };
    case 'success':
      // Local dispatch completed but produced no events: the exact filter dropped all.
      return {
        verdict: 'MATCHED_NO_EVENTS',
        funnel,
        explanation: 'The scan completed but produced no events — the exact predicate matched nothing.',
        hint: 'Probe the predicate field\'s real values against the data; the field or value likely does not match.',
      };
  }

  // 5. Remote dispatch with nothing back — the structural blind spot.
  if (remote) {
    const d = funnel.dispatched ?? '?';
    return {
      verdict: 'DISPATCHED_BLIND',
      funnel,
      explanation:
        `Coordinator dispatched ${d} subquer(ies) and finished, but in remote dispatch its own scanned/matched counters stay 0 — they do NOT reflect what the subqueries found, and the subqueries do not roll their counts back into this marker. Zero events came back.`,
      hint: 'The zero cannot be localized (resolve vs bloom vs filter) from this marker alone — this is the engine ROLLUP gap (subqueries must report scanned/matched into the coordinator _DONE). Workaround: re-run with a SMALL time range so the coordinator scans locally (non-remote) and reports precise counts.',
    };
  }

  // 6. Fallback.
  return {
    verdict: 'INCONCLUSIVE',
    funnel,
    explanation: `Query finished with reason="${reason ?? 'unknown'}" and zero events, but the marker lacks the detail to localize the cause.`,
    hint: 'Re-run with a small range for local-dispatch precision, or enable subquery PERF logging on the engine.',
  };
}

/** Compact one-line funnel for embedding in a query envelope / log. */
export function formatFunnel(d: QueryDiagnosis): string {
  const f = d.funnel;
  const p = (label: string, v: number | null): string => `${label}=${v == null ? '?' : v}`;
  const blind = f.coordinatorBlind ? ' [coordinator-blind: scan/bloom are not the subqueries\' counts]' : '';
  return (
    [
      `verdict=${d.verdict}`,
      p('dispatched', f.dispatched),
      p('scanned', f.scanned),
      p('bloomMatched', f.bloomMatched),
      p('streamReq', f.streamRequests),
      p('events', f.eventsReturned),
    ].join(' ') + blind
  );
}
