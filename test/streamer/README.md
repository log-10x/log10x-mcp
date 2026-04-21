# Streamer E2E test harnesses

End-to-end / observability / performance harnesses that drive the Log10x
Storage Streamer via HTTP and validate via S3 + CloudWatch. Written during
a prod-readiness pass; each harness answers a specific question.

These are **live tests** — they hit a real deployed streamer. Set
`LOG10X_STREAMER_URL` in env, or edit the constant at the top of each
harness. Default target is the demo env URL baked into the scripts; those
URLs will die with the demo env.

## Setup

```bash
cd test/streamer
npm install   # pulls @aws-sdk/client-s3, @aws-sdk/client-cloudwatch-logs
```

AWS credentials must be available via the default chain (env vars, `~/.aws/credentials`,
or IRSA if running in-cluster).

## Harness catalog

| file | question it answers | exit code |
|---|---|---|
| `ground_truth.mjs` | Baseline: does streamer eventsWrittenTotal agree with raw-file substring count over a 60min window? (v1 — polls CW log events directly) | 0 if within 20% |
| `ground_truth_v2.mjs` | Same baseline via R18 `/status` endpoint. Preferred over v1. | 0 if within 10% |
| `patterns.mjs` | 7 adversarial query shapes: nested boolean, always-false, wide OR, substring `includes(text, …)`, compound AND, specific `message_pattern`, infrastructure namespace filter. Each must complete without SOE. | 0 if 7/7 pass |
| `complex.mjs` | 10-case complex-query suite: nested AND/OR/NOT, always-false, empty search, wide OR over 10 codes, huge substring, `processingTime=1ms` (must not hang), `resultSize=0`, reversed time range, deep fan-out 60min×5s timeslice, SQL-injection-shaped string (must reject or handle safely). | prints PASS/FAIL table |
| `lat_p95.mjs N` | N serial small-window queries, compute p50 / p95 / p99 / min / max wall-clock. | 0 always; read stdout |
| `latency_diag.mjs N` | Fine-grained stage timing: submit, first `query started`, first scan dispatched, first scan complete, first stream dispatch, first worker started, first worker complete, R18 detect-complete. Reveals where tail-latency lives. | 0 always |
| `tail.mjs` | Tiny resultSize (10 KB) — verifies the tail clamp terminates cleanly with no SOE. | 0 if clean |
| `saturation.mjs N` | N concurrent POSTs, retry on socket errors, wait all to `complete`. Reports completed / SOE / timeout counts. | 0 if 0 SOE and ≥80% complete |
| `pod_loss.mjs` | Submit a query, mid-flight `kubectl delete pod -l cluster=stream-worker`, verify SQS redelivers and new pods drain the backlog. | 0 if PASS |
| `cold_start.mjs` | `kubectl delete pod -l cluster=query-handler`, time kill→healthy, healthy→submit, submit→complete. | 0 if submit completes within 3 min post cold-start |
| `obs_edge.mjs` | 10 adversarial HTTP inputs: malformed JSON body, empty body, missing required fields, 50KB search string, malformed traceparent, control-char traceparent, status for ghost qid, malformed qid path, double-submit same qid, text/plain content-type. Verifies no 500 Internal Server Error. | 0 if no crashes |
| `obs_edge_v15.mjs` | Post-hardening verification: confirms malformed traceparent values produce a freshly minted W3C tp in CW (not the malicious value). Tests 3–5 are blocked by Node undici's client-side CRLF-header rejection, see `obs_crlf.mjs` for the raw-socket bypass. | 0 if 5/5 pass |
| `obs_crlf.mjs` | Bypass Node undici via raw TCP socket; send literal CRLF in traceparent header. Proves the HTTP parser / Java validator reject it before reaching logs. | 0 if no injection leaked to CW |
| `v16_e2e.mjs` | Combined R21 + R18 latency check: measure _DONE.json S3 lag from coordinator complete AND R18 `/status` lag. Target: both under 12s. | 0 if both meet target |
| `c1_exact_count_recall.mjs` | Pre-R21 harness from the early bug-hunting pass: run same query twice in a locked window, assert deterministic event counts. Superseded by `ground_truth_v2.mjs` but kept for historical reference. | 0 if counts agree |

## Conventions

- All harnesses are Node ESM (`.mjs`), Node 20+.
- Most use only `fetch` + `setTimeout/promises`. A few use `@aws-sdk/client-s3`
  or `@aws-sdk/client-cloudwatch-logs` (declared in `package.json`).
- Default streamer URL is hardcoded to the demo-env ELB. Set
  `LOG10X_STREAMER_URL` to override.
- No credentials baked in; the demo streamer's internal ELB does not require
  X-10X-Auth for the tests done here.

## How the v16 hardening maps back

Several tests found or verified fixes during the 2026-04-17..20 session.
See the streamer handoff guide in
`~/.claude/projects/-Users-talweiss-eclipse-workspace-l1x-co-config/memory/project_streamer_handoff_guide.md`
for the full narrative. Short version:

- `obs_edge.mjs` found the log-injection risk in `[tp=%X{traceparent}]`.
- `obs_crlf.mjs` confirmed the fix (W3C regex + control-char reject at
  `StreamerQuery` and `AWSAccessor`).
- `latency_diag.mjs` characterised the ~25s Insights polling lag in R18,
  leading to the `DescribeLogStreams` + `GetLogEvents` rewrite in
  `StreamerQueryStatus`.
- `v16_e2e.mjs` confirmed the R21 `_DONE.json` marker and the R18 rewrite
  both land under 2s on the demo env.

## When the demo env dies

These harnesses assume a live streamer. When the demo env is retired in
favor of the replay-based simulator (see handoff guide §8), update the
hardcoded ELB URL constants to point at the simulator's streamer, or pass
`LOG10X_STREAMER_URL` via env. The harnesses themselves should work
unchanged — they only assume a streamer implementing the REST contract
documented in `src/lib/streamer-api.ts`.
