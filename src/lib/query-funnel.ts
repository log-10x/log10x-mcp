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
  | 'EMPTY_RANGE' //       resolution mapped 0 blobs for the window (no data OR time-mapping broken)
  | 'BLOOM_REJECTED_ALL' //blobs scanned, search term in none of them
  | 'MATCHED_NO_EVENTS' // marker-only: something matched but no events landed
  | 'FILTER_NO_MATCH' //   ground truth: events reached the writer, the exact predicate dropped them all (fetchedVolume/emptyFlushes>0)
  | 'FETCH_EMPTY' //       ground truth: object read returned 0 bytes (s3BytesRead==0)
  | 'PARSE_EMPTY' //       ground truth: object bytes read (s3BytesRead>0) but 0 events parsed
  | 'FETCH_OR_PARSE_EMPTY' //ground truth: bloom matched but no rows reached the writer; s3BytesRead unavailable to split fetch vs parse
  | 'DELIVERY_INCOMPLETE' //ground truth: events written but not read back
  | 'DISPATCHED_BLIND' //  remote dispatch; coordinator can't see subquery outcome
  | 'INCONCLUSIVE'; //     finished, zero events, marker lacks detail

export interface QueryFunnel {
  /** Subqueries fanned out (submittedTasks). null when not reported. */
  dispatched: number | null;
  /**
   * Blobs the RESOLUTION stage mapped for the window (sum of `scan range:`
   * submittedKeys). Ground-truth only; only set by diagnoseFromStats. 0 => the
   * time->blob mapping returned nothing.
   */
  resolvedBlobs?: number | null;
  /** Blobs scanned. NOTE: coordinator-only in remote dispatch (see coordinatorBlind). */
  scanned: number | null;
  /** Blobs that passed the bloom. Coordinator-only in remote dispatch. */
  bloomMatched: number | null;
  skippedSearch: number | null;
  skippedTemplate: number | null;
  streamRequests: number | null;
  /**
   * Volume (utf8 bytes) of events FETCHED from the matched byte-ranges, pre-filter
   * (q/ writer "fetched N bytes"). Ground-truth only. >0 with 0 written =>
   * FILTER_NO_MATCH (fetched but predicate wrote none); 0 => FETCH_OR_PARSE_EMPTY.
   * Despite the engine's "fetched" label this is event volume, not S3-GET bytes.
   */
  fetchedVolume?: number | null;
  /** Bytes read from the source object (S3 GET). The real fetch counter; splits FETCH_EMPTY from PARSE_EMPTY. */
  s3BytesRead?: number | null;
  /**
   * Events that reached the results writer but were dropped by the exact
   * predicate pre-write (results-writer emptyFlushes). Ground-truth only; a
   * corroborator for FILTER_NO_MATCH alongside fetchedVolume.
   */
  filterDropped?: number | null;
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
  /**
   * Index blobs the RESOLUTION stage mapped for the window (sum of `scan range:`
   * submittedKeys). 0 => the time->blob mapping returned nothing (empty window).
   * The ground-truth empty signal, distinct from scanned/bloom.
   */
  submittedKeys?: number;
  /** Index blobs the bloom scan examined. */
  scanned?: number;
  /** Blobs whose bloom matched the search (candidates to fetch). */
  matched?: number;
  /** Stream workers dispatched to fetch matched objects. */
  streamWorkers?: number;
  /** Stream workers that reported completion. */
  workersComplete?: number;
  /**
   * Written-event utf8 volume from the q/ writer ("stream worker complete:
   * fetched N bytes"). NOT the S3-read byte count — informational only; never
   * used as a fetch success/failure signal (the engine emits no S3-read counter).
   */
  fetchedBytes?: number;
  /** Events the results writer wrote after the exact predicate (qr/). */
  resultEvents?: number;
  /**
   * Flushes that reached the results writer but were empty because the exact
   * predicate dropped the event pre-write. The distinguisher for a 0-result:
   * >0 (with 0 written) = the filter rejected events that arrived; 0 (with 0
   * written) = no rows reached the writer (the fetch or the parse produced none).
   */
  emptyFlushes?: number;
  /** Events dropped at the results cap. */
  resultsTruncated?: number;
  /**
   * Bytes actually read from the source object (S3 GET), from the engine's
   * "stream worker fetch complete: s3BytesRead" PERF event. The REAL fetch
   * counter (unlike fetchedBytes, which is pre-filter event volume). When
   * present it splits a 0-result cleanly: ==0 => FETCH_EMPTY (read returned
   * nothing); >0 with 0 events parsed => PARSE_EMPTY. Absent on engines that
   * predate the counter (the funnel falls back to FETCH_OR_PARSE_EMPTY).
   */
  s3BytesRead?: number;
  /**
   * The exact in-memory predicate applied to fetched events (queryFilters), from
   * the "query plan" event's filter= field. Surfaced in a FILTER_NO_MATCH
   * explanation so the agent sees what was matched, not just that nothing passed.
   */
  filterExpr?: string;
}

/**
 * Ground-truth verdict from the engine's per-stage CloudWatch events. Returns
 * null when the stats are absent/empty (CW not configured, or the run wasn't
 * DEBUG) so the caller falls back to the marker-only `diagnoseQuery`.
 *
 * The funnel, stage by stage, exactly as the engine reports it:
 *   resolved(submittedKeys) -> scanned -> matched(bloom) -> workers ->
 *   resultEvents written / emptyFlushes dropped -> delivered
 *
 * The verdict turns on RESOLUTION (submittedKeys===0 => EMPTY_RANGE) and the
 * fetch/filter split (matched>0, written===0: fetchedBytes>0 OR emptyFlushes>0 =>
 * FILTER_NO_MATCH, i.e. events were fetched+parsed but the exact predicate wrote
 * none; both 0 => FETCH_OR_PARSE_EMPTY). The q/ "fetched bytes" is event volume
 * pre-filter, NOT S3-GET bytes — so >0 proves fetch+parse worked, but it can't
 * separate a real S3-read failure from a parse miss (that needs an engine counter).
 */
export function diagnoseFromStats(
  s: CloudWatchStageStats | null | undefined,
  eventsReturned: number,
): QueryDiagnosis | null {
  if (!s) return null;
  const submittedKeys = num(s.submittedKeys);
  const scanned = num(s.scanned);
  const matched = num(s.matched);
  const workers = num(s.streamWorkers);
  const fetchedBytes = num(s.fetchedBytes);
  const resultEvents = num(s.resultEvents);
  const emptyFlushes = num(s.emptyFlushes);
  const s3BytesRead = num(s.s3BytesRead);
  // Nothing parsed → no ground truth to offer.
  if (submittedKeys == null && scanned == null && matched == null && workers == null) return null;

  const funnel: QueryFunnel = {
    dispatched: workers,
    resolvedBlobs: submittedKeys,
    scanned,
    bloomMatched: matched,
    skippedSearch: null,
    skippedTemplate: null,
    streamRequests: workers,
    s3BytesRead,
    fetchedVolume: fetchedBytes,
    filterDropped: emptyFlushes,
    eventsReturned,
    coordinatorBlind: false, // these are the workers' own reported numbers
  };

  if (eventsReturned > 0) {
    return { verdict: 'OK', funnel, explanation: `Returned ${eventsReturned} event(s).`, hint: 'No action needed.' };
  }
  // Resolution: did the time->blob mapping yield any blobs? submittedKeys is the
  // ground-truth empty signal; fall back to scanned when scan-range wasn't parsed.
  const resolved = submittedKeys ?? scanned;
  if (resolved != null && resolved === 0) {
    return {
      verdict: 'EMPTY_RANGE',
      funnel,
      explanation: submittedKeys != null
        ? 'The resolution stage mapped 0 index blobs for this window (every scan range reported submittedKeys=0).'
        : 'The scan examined 0 index blobs for this window.',
      hint: 'No data in range, or the time->blob mapping returned nothing. Widen the range; if a window with known data still resolves 0, the index time-mapping is the cause to trace.',
    };
  }
  if ((scanned ?? 0) > 0 && (matched ?? 0) === 0) {
    return {
      verdict: 'BLOOM_REJECTED_ALL',
      funnel,
      explanation: `Scanned ${scanned} blob(s); the bloom matched none for this search.`,
      hint: 'The search value is not in the index for this window. Try match-all to confirm the blobs hold events; the bloom is the source of truth for candidacy.',
    };
  }
  // Matched > 0 but nothing written. Was anything fetched+parsed from the blobs?
  // fetchedBytes is the q/ writer's volume of events FETCHED from the matched
  // byte-ranges (pre-filter); emptyFlushes corroborates that events reached the
  // writer. Either > 0 means events WERE fetched but the exact predicate wrote
  // none (FILTER_NO_MATCH). Otherwise nothing materialized — and s3BytesRead, when
  // present, splits a true fetch-empty (==0) from a parse miss (>0).
  if ((matched ?? 0) > 0 && (resultEvents ?? 0) === 0) {
    const fetched = fetchedBytes ?? 0;
    const flushed = emptyFlushes ?? 0;
    if (fetched > 0 || flushed > 0) {
      const filterClause = s.filterExpr ? ` Filter applied: \`${s.filterExpr}\`.` : '';
      return {
        verdict: 'FILTER_NO_MATCH',
        funnel,
        explanation: `Bloom matched ${matched} blob(s); ${fetched} byte(s) of events were fetched from them but the exact predicate wrote 0 (written=0${flushed > 0 ? `, emptyFlushes=${flushed}` : ''}).${filterClause} The bloom is approximate; the exact filter is the truth and it matched nothing.`,
        hint: 'Events were fetched but none passed the exact predicate. Probe what the field actually carries; the search field/value most likely does not match the real data.',
      };
    }
    // Nothing reached the writer. Use the real S3-read counter to localize.
    if (s3BytesRead != null && s3BytesRead === 0) {
      return {
        verdict: 'FETCH_EMPTY',
        funnel,
        explanation: `Bloom matched ${matched} blob(s) but the object read returned 0 bytes (s3BytesRead=0) — nothing came back from storage to parse or filter.`,
        hint: 'The fetch itself returned nothing. Check the read container/bucket, the byte-range, and that the matched object still exists in storage; this is the object-read stage, not the search.',
      };
    }
    if (s3BytesRead != null && s3BytesRead > 0) {
      return {
        verdict: 'PARSE_EMPTY',
        funnel,
        explanation: `Bloom matched ${matched} blob(s) and the object read returned ${s3BytesRead} byte(s), but 0 events were parsed from them (fetchedVolume=0) — the bytes came back but the parser produced no events.`,
        hint: 'Bytes were read but parsed into zero events — a parse/format issue, not the search. Confirm the object encoding matches the reader (e.g. NDJSON vs the expected line format) before concluding a fault.',
      };
    }
    return {
      verdict: 'FETCH_OR_PARSE_EMPTY',
      funnel,
      explanation: `Bloom matched ${matched} blob(s) but 0 bytes of events were fetched from them (fetchedBytes=0, emptyFlushes=0, written=0) — the fetch or the parse produced nothing. This engine does not emit s3BytesRead, so fetch and parse cannot be split here; this is an observation, not a root cause.`,
      hint: 'Not the search — candidates matched but no event bytes materialized. Splitting fetch from parse needs the engine s3BytesRead counter (added but may not be deployed here); until then trace the read+parse path. Do NOT assume an engine fault.',
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
  const p = (label: string, v: number | null | undefined): string => `${label}=${v == null ? '?' : v}`;
  const blind = f.coordinatorBlind ? ' [coordinator-blind: scan/bloom are not the subqueries\' counts]' : '';
  const parts = [`verdict=${d.verdict}`, p('dispatched', f.dispatched)];
  if (f.resolvedBlobs != null) parts.push(p('resolved', f.resolvedBlobs));
  parts.push(p('scanned', f.scanned), p('bloomMatched', f.bloomMatched), p('streamReq', f.streamRequests));
  if (f.s3BytesRead != null) parts.push(p('s3BytesRead', f.s3BytesRead));
  if (f.fetchedVolume != null) parts.push(p('fetchedBytes', f.fetchedVolume));
  if (f.filterDropped != null) parts.push(p('filterDropped', f.filterDropped));
  parts.push(p('events', f.eventsReturned));
  return parts.join(' ') + blind;
}
