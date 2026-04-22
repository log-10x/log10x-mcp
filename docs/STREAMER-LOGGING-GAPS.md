# Streamer Logging Gaps — Diagnosis from 2026-04-16 GA Session

## Problem
We couldn't trace why `message_pattern=="..."` searches return 0 events despite the enrichment values being in the Bloom filter. Added TRACE-Q logging to IndexQueryWriter + IndexQueryReader, rebuilt and deployed — but the traces never appeared for MCP-originated queries.

## Gap 1: REST-originated queries log to file, not stdout

**Root cause**: The REST endpoint (`/streamer/query`) submits the pipeline directly via `executor.submit(new PipelineLaunchTask(request))` in `BasePipeline.handleRequest()` (line 36). The pipeline runs in a managed executor thread. Log4j routes `logger.warn/info` from these threads to the **file appender** (`/var/log/tenx/tenx.log`), not to stdout.

`kubectl logs` reads stdout/stderr only. So REST-originated queries (from the MCP) are invisible in `kubectl logs`.

**Meanwhile**: SQS-originated queries (from the doctor probe's sub-queries) DO appear in `kubectl logs` because the QueueConsumer runs on a different thread pool whose output goes to stdout.

**Fix options**:
1. Add a `consoleAppender` to log4j2.yaml that also routes WARN+ to stdout
2. Change the file appender to write to `/proc/1/fd/1` (stdout of PID 1) instead of `/var/log/tenx/tenx.log`
3. Add a dedicated logger for `com.log10x.ext.cloud.index.query` that routes to both file and console

**Impact**: ALL streamer query debugging is blind when looking at `kubectl logs`. You have to exec into the pod and read `/var/log/tenx/tenx.log` directly.

## Gap 2: Missing log statements in the query path

**IndexQueryReader.createReaders()**: No logging for:
- Which constants were parsed from the search expression
- What `templateTerms` vs `eventTerms` were produced (we added TRACE-Q but it only fires when verbose)
- Whether `templateIncludes()` matched any templates (the filter runs in the pipeline JS layer, not Java — no way to trace it from Java)

**IndexQueryWriter.flush()**: No logging for:
- Which output stream instance is receiving events (templateHash output vs vars output)
- Whether the two output streams share an IndexQueryWriter instance or have separate ones
- What the raw `currChars.builder` content looks like before parsing

**IndexQueryWriter.iterateIndexObjects()**: No logging for:
- Total Bloom filters scanned per epoch range
- Per-filter match/skip reasons at a summary level (only logged at DEBUG level and limited to first 3 keys in our trace)
- Whether `eval.evaluate(filter)` was called and what the result was

**IndexQueryWriter.submitQuery()**: No logging for:
- Whether `submitToEndpoint()` or `submitToExecutor()` was chosen and why (timeslice calculation)
- How many sub-queries were dispatched and to which queue

**QueryFilterEvaluator**: No logging at all. The evaluator parses and evaluates silently. When it fails, there's no trace of which constant failed or why.

## Gap 3: `quiet=true` flag semantics confusion

`AppRequest.quiet()` returns `true` by default (line 17-19 of AppRequest.java). This adds `quiet=true` to the pipeline bootstrap args (AppPipeline.java line 23-25). The `quiet` flag:

- Suppresses `TenXConsole.log()` JS calls (confirmed by user: "quiet is just console")
- Does NOT suppress log4j logging
- But may affect which log4j appender is used (e.g., the pipeline might configure a different log4j context when quiet=true that omits the console appender)

**The confusion**: We spent significant debugging time assuming `quiet=true` was hiding our traces. It wasn't — the traces were going to the file appender regardless. The real issue was that `kubectl logs` doesn't see file appender output.

## Gap 4: No query-level correlation in logs

When a query runs, there's no consistent correlation key (queryId) in every log line. The pipeline args dump has the queryId buried in a huge flat string. Individual TRACE-Q lines don't include the queryId. This means:

- You can't grep for a specific query's lifecycle across all log sources
- Sub-queries dispatched via SQS have no parent queryId in their log lines (they get their own pipeline launch, which inherits the queryId via `PARENT_ID` but the pipeline launch log doesn't surface it)

**Fix**: Add queryId as a log4j MDC (Mapped Diagnostic Context) key at pipeline start, so every log line in that pipeline's execution thread carries the queryId.

## Gap 5: templateIncludes() is a black box

The filter on the template output stream (stream.yaml line 60):
```yaml
filter: isTemplate && templateIncludes(TenXInput.get("querySearch"))
```

`templateIncludes()` is a JS function executed by the engine's TenXTemplate runtime. When it returns false (no templates match the search terms), there's:
- No log of which templates were tested
- No log of which tokens were compared
- No log of why the match failed

For `message_pattern=="..."` searches, `templateTerms` is EMPTY (because the field isn't "this"/"text"/"this.text" — see IndexQueryReader line 107). So `querySearch` is set to an empty list. `templateIncludes([])` with an empty list may match everything or nothing depending on the implementation.

**This is likely the root cause**: when templateTerms is empty, templateIncludes gets an empty input, which may behave as "match nothing" rather than "match everything". Need to verify the JS implementation of `templateIncludes`.

## What we know for certain

1. The MCP POST reaches the REST endpoint (HTTP 200 returned with queryId)
2. The pipeline starts (pipeline args dump appears in logs)
3. TRACE-Q lines don't appear (either they go to file appender, or the code path doesn't reach them)
4. Doctor probe queries DO produce TRACE-Q because they enter via SQS (different logging path)
5. The `queryWriteResults` module fix IS deployed (grep confirmed)
6. Sub-queries for doctor probes run correctly with `queryFilterVars.size=2` (the module fix works)

## Recommended investigation order

1. **Read `/var/log/tenx/tenx.log`** from the query-handler pod — our TRACE-Q lines may already be there
2. **Check templateIncludes([])** behavior — what happens when templateTerms is empty?
3. **Fix log routing** so all pipeline execution logs go to stdout (or both stdout + file)
4. **Add queryId to MDC** for correlation
5. Once traces are visible, re-run the `message_pattern=="..."` search and trace the exact failure point
