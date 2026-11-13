/**
 * A Retriever search the engine cannot parse must fail in milliseconds with
 * the reason, and plain words must still find events.
 *
 * Measured 2026-11-13 on the hosted demo (mcp.log10x.com, build 1.30.101):
 * log10x_retriever_query with search "react hooks" over 24 h took 202.5 s
 * and answered "0 events, NO_MARKER, poll again". The engine's own parser
 * (pipeline-extensions QueryFilterEvaluator, origin/main d0d81c9) throws on
 * that string at query start, the query Lambda reported the error in the body
 * of a 200 the MCP did not read, no _DONE.json was written, and the MCP waited
 * out its 180 s marker budget plus the 20 s quiet window. An outside agent
 * retried the same shape for six minutes.
 *
 * The parse cases below are the engine's results for the same strings, run
 * through the Java class on 2026-11-13; the TypeScript port must agree.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRetrieverSearch,
  normalizeRetrieverSearch,
  INVALID_SEARCH_PREFIX,
} from '../src/lib/retriever-search.js';
import {
  lambdaQueryReplyError,
  submitQuery,
  setLambdaUrlPosterForTest,
  clearRetrieverResolutionCacheForTest,
  RETRIEVER_REJECTED_PREFIX,
} from '../src/lib/retriever-api.js';
import { trailStopDecision } from '../src/lib/retriever-diagnostics.js';
import { diagnoseEmptyQuery } from '../src/lib/query-funnel.js';
import type { EnvConfig } from '../src/lib/environments.js';

// Engine verdicts (QueryFilterEvaluator.parse) for each string.
const ENGINE_CASES: Array<[string, 'OK' | 'THROW']> = [
  ['react hooks', 'THROW'],
  ['react', 'THROW'],
  ['"react hooks"', 'THROW'],
  ['includes(text, "react hooks")', 'OK'],
  ['includes(text, "react") && includes(text, "hooks")', 'OK'],
  ['severity_level=="ERROR"', 'OK'],
  ['includes(text, "fg1YkiyrF3Q")', 'OK'],
  ['error AND timeout', 'THROW'],
  ['level:error', 'THROW'],
  ['text == "react"', 'OK'],
];

test('the port agrees with the engine parser on every measured string', () => {
  for (const [expr, engine] of ENGINE_CASES) {
    let got: 'OK' | 'THROW' = 'OK';
    try {
      parseRetrieverSearch(expr);
    } catch {
      got = 'THROW';
    }
    assert.equal(got, engine, `parse("${expr}")`);
  }
});

test('grammar edges: precedence, grouping, dotted fields, unclosed strings', () => {
  assert.deepEqual(
    parseRetrieverSearch('(a=="1" || b.c=="2") && includes(text, "x")').map((c) => c.field),
    ['a', 'b.c', 'text'],
  );
  assert.throws(() => parseRetrieverSearch('a=="1'), /unclosed string/);
  assert.throws(() => parseRetrieverSearch('a=="1" &&'), /expected a field name/);
  assert.throws(() => parseRetrieverSearch('a=="1" b=="2"'), /extra tokens/);
});

test('a valid expression passes through unchanged', () => {
  const n = normalizeRetrieverSearch('severity_level=="ERROR" && includes(text, "timeout")');
  assert.equal(n.search, 'severity_level=="ERROR" && includes(text, "timeout")');
  assert.equal(n.rewrittenFrom, undefined);
});

test('plain words become includes(text) clauses and keep the original', () => {
  const n = normalizeRetrieverSearch('react hooks');
  assert.equal(n.search, 'includes(text, "react") && includes(text, "hooks")');
  assert.equal(n.rewrittenFrom, 'react hooks');
  assert.doesNotThrow(() => parseRetrieverSearch(n.search));
});

test('quoted phrases stay whole; uppercase OR splits, AND is dropped', () => {
  assert.equal(normalizeRetrieverSearch('"connection refused"').search, 'includes(text, "connection refused")');
  assert.equal(
    normalizeRetrieverSearch('"connection refused" timeout').search,
    'includes(text, "connection refused") && includes(text, "timeout")',
  );
  assert.equal(normalizeRetrieverSearch('error AND timeout').search, 'includes(text, "error") && includes(text, "timeout")');
  assert.equal(normalizeRetrieverSearch('timeout OR refused').search, 'includes(text, "timeout") || includes(text, "refused")');
  assert.equal(normalizeRetrieverSearch('level:error').search, 'includes(text, "level:error")');
});

test('a malformed expression is refused before dispatch, with the reason', () => {
  for (const bad of ['severity_level==ERROR', 'includes(text, timeout)', '(error', 'a=="1" b=="2"']) {
    assert.throws(
      () => normalizeRetrieverSearch(bad),
      (e: Error) => e.message.startsWith(INVALID_SEARCH_PREFIX) && e.message.includes('includes(text,'),
      bad,
    );
  }
});

test('the Lambda reply body: an error is read, an empty success is not', () => {
  assert.equal(
    lambdaQueryReplyError('{"role":"query","error":"IllegalArgumentException: Failed to parse expression \'react hooks\'","elapsedMs":812}'),
    "IllegalArgumentException: Failed to parse expression 'react hooks'",
  );
  assert.equal(lambdaQueryReplyError(''), null);
  assert.equal(lambdaQueryReplyError('{"role":"query","queryId":"q1","elapsedMs":2100}'), null);
  assert.equal(lambdaQueryReplyError('not json'), null);
});

const SAVED_ENV = { ...process.env };
afterEach(() => {
  setLambdaUrlPosterForTest(null);
  process.env = { ...SAVED_ENV };
  clearRetrieverResolutionCacheForTest();
});

function useLambdaRetriever(): void {
  process.env.__SAVE_LOG10X_RETRIEVER_URL__ = 'https://abc123.lambda-url.us-east-1.on.aws/';
  process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__ = 'test-bucket';
  clearRetrieverResolutionCacheForTest();
}

test('a 200 whose body carries the handler error is surfaced, not dropped', async () => {
  useLambdaRetriever();
  setLambdaUrlPosterForTest(async () =>
    new Response(
      JSON.stringify({
        role: 'query',
        error: "IllegalArgumentException: Failed to parse expression 'react hooks': Expected operator '==' but found 'ID:hooks'",
        elapsedMs: 812,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  await assert.rejects(
    submitQuery({} as EnvConfig, { id: 'q1', name: 'mcp-q1', from: '0', to: '1', search: 'react hooks' }),
    (e: Error) => e.message.startsWith(RETRIEVER_REJECTED_PREFIX) && e.message.includes('Failed to parse'),
  );
});

test('a 200 with an empty body is a successful submit', async () => {
  useLambdaRetriever();
  setLambdaUrlPosterForTest(async () => new Response('', { status: 200 }));
  const r = await submitQuery({} as EnvConfig, { id: 'q2', name: 'mcp-q2', from: '0', to: '1', search: 'a=="b"' });
  assert.equal(r.queryId, 'q2');
});

test('trail decisions: empty and pre-dispatch errors stop, an unreadable trail never does', () => {
  assert.deepEqual(trailStopDecision({ emptyReason: 'no_template_hashes_or_vars' }, 4_000, 20_000), {
    kind: 'empty',
    reason: 'no_template_hashes_or_vars',
  });
  assert.deepEqual(trailStopDecision({ errors: ['query error: boom'] }, 4_000, 20_000), {
    kind: 'error',
    message: 'query error: boom',
  });
  // An error after the plan was logged: the coordinator ran, keep waiting for its marker.
  assert.equal(
    trailStopDecision({ errors: ['scan error: x'], queryPlan: { templateHashes: 1, vars: 0, timeslice: 60000, dispatch: 'remote' } }, 4_000, 20_000),
    null,
  );
  // Nothing in the trail: stop only after the no-start budget, and only when one applies.
  assert.equal(trailStopDecision({}, 19_999, 20_000), null);
  assert.deepEqual(trailStopDecision({}, 20_000, 20_000), { kind: 'no_start' });
  assert.equal(trailStopDecision({}, 600_000, Number.POSITIVE_INFINITY), null);
  // Cannot read the trail, or no trail configured: fall back to the marker wait.
  assert.equal(trailStopDecision({ pollingError: 'AccessDenied' }, 600_000, 20_000), null);
  assert.equal(trailStopDecision(null, 600_000, 20_000), null);
});

test('an empty query is a final zero, not "poll again"', () => {
  const d = diagnoseEmptyQuery('no_template_hashes_or_vars');
  assert.equal(d.verdict, 'EMPTY_QUERY');
  assert.equal(d.funnel.eventsReturned, 0);
  assert.doesNotMatch(d.hint, /poll again/i);
});
