# tenx_hash — honest verification status

Read this before retesting. It states what is proven solid, what is
flaky, the defects found (including in the verification itself), and
exactly how to re-confirm. The goal is that retesting *confirms* this,
not that it collapses on the first question.

## Bottom line

The tenx_hash **correctness chain is solid and independently re-verifiable**,
and it does **not** depend on the flaky CloudWatch egress:

1. The engine emits `tenx_hash` on events (xxHash64 of the symbol
   sequence, base64url, 11 chars). Proven by running the real engine
   (not the spec) — conformance vectors + a live otel-demo run.
2. The MCP's local `tenxHash()` reproduces the engine's value
   **byte-for-byte** — a pure-local, network-independent oracle.
   Conformance test: `node --test test-build/test/pattern-hash.test.js`.
3. The engine's log10x **cloud** Prometheus backend independently binds
   the same `tenx_hash` values to named patterns. Verified live: for N
   sampled live hashes, `tenxHash(engine's own bound pattern) == the
   hash` with **zero tolerance for a single mismatch**.
4. MCP tools act on it correctly. Exercised by THIS harness:
   `event_lookup({tenxHash})` reverse-resolves hash→pattern→cost (Gate
   3/5 path), and `exclusion_filter` emits the exact-hash drop config —
   fluentd block byte-identical to one proven on the live demo to drop a
   pattern with zero collateral (Gate 5). Fabricated hashes return an
   honest "not found" — no hallucinated pattern (Gate 4, 4 fakes).
   NOT re-exercised here: `pattern_examples` exact-hash SIEM probing —
   that was proven live separately (WS8: pattern name → 102 real CW
   events via `{ $.tenx_hash = … }`), but this harness does not re-run
   it; treat it as verified-elsewhere, not verified-by-this-script.
5. Tool output is clean: human-visible text carries no agent chatter
   (all guidance is HTML-comment-fenced, invisible to humans).

Re-confirm all of the above in one command:

    bash eval/bin/verify-tenx-hash-e2e.sh 8

Exit 0 = every gate passed. It re-derives everything from ground truth
each run and prints a KNOWN-LIMITATIONS block every time.

## What is flaky / limited (do not be ambushed)

* **The CloudWatch egress (WS5 test-rig) is BROKEN and was not
  stabilizable.** WS5 added a fluentd `cloudwatch_logs` output so the
  demo could ship enriched events to CW. It worked initially (WS6/WS7
  proved real tenx_hash events in CW, correlated 11/12), then began
  stalling. Observed failure signature, repeatedly: after a
  `kubectl rollout restart` exactly **one** catch-up batch lands, then
  ingestion stops entirely (CW `lastIngestionTime` age climbs 1:1 with
  wall clock). Two principled fixes were attempted and **both failed
  identically**: (a) plain restart; (b) bounded-retry
  (`retry_max_interval 30s`, `retry_forever`), capped buffer
  (`total_limit_size 128m`, `overflow_action drop_oldest_chunk`),
  `flush_thread_count 2`, and `@log_level info` on the store. Even with
  per-store info logging the `out_cwl` plugin emits **zero** diagnostic
  lines — the stall is persistent and opaque. Root cause not determined;
  it is a fluentd `fluent-plugin-cloudwatch-logs` issue in this
  image/topology, **not a tenx_hash defect**. Do NOT trust "a restart
  fixes it" — it does not. Treat the CW egress as currently
  non-functional. The correctness chain (1–5 above) is verified against
  the cloud backend and is **completely independent** of this rig.
* The harness Gate 2 now uses `describe-log-streams` `lastIngestionTime`
  as the authoritative freshness signal, so a CW stall now **fails Gate
  2 loudly** instead of being faked (see "verification defects" below).
* CW ingestion lag is real (~250–330s in steady state). Gate 2's
  threshold is 720s to distinguish normal lag from a stall.
* Scope: the harness **observes live production traffic**; it does not
  inject a synthetic canary through fluentd. For an injected end-to-end
  probe, use `eval/counterfactual/`.

## Pre-existing demo defect (unrelated to tenx_hash)

The receiver also remote-writes to `http://localhost:9090/api/v1/write`
(no listener) — ~180 connection-refused failures / 5 min. This predates
and is unrelated to tenx_hash; the cloud backend used for correlation is
healthy. Gate 1 **discloses** this rather than claiming "healthy".

## Defects found in the verification itself (the anti-hollow-harness work)

An adversarial sub-agent (non-leading prompt) was tasked to break the
harness. It found 5 real holes; all fixed:

1. "Three independent ways" was two — the MCP tool and the engine query
   read the same backend. Now: the independent oracle is the local
   recompute; the tool is labeled a usability check, not a 3rd source.
2. An 80% ratio could pass real correctness failures. Now: correctness
   is **zero-tolerance** (any hash mismatch fails); availability has a
   floor, not a ratio.
3. Gate 1 claimed "healthy" while the pod failed 180 writes/5m. Now
   disclosed, not hidden.
4. Single hard-coded fake in the negative test. Now 4 fakes.
5. "E2E" overclaimed (the fluentd→CW write itself isn't asserted, only
   reconciled). Now scoped honestly as "live data-plane verification".

Then a 6th hole was caught directly: Gate 2's freshness was **theater**
— `filter-log-events --max-items 600` returns the *oldest* 600 of the
window, so "newest age" was always ≈ window-size, not real freshness. It
masked the ~40-min CW stall above. Rewritten to authoritative
`lastIngestionTime`. This is the failure mode being guarded against;
it was found and fixed before retest, not after.

## How to retest

* Full chain: `bash eval/bin/verify-tenx-hash-e2e.sh 8` (exit 0 = pass;
  reads the KNOWN-LIMITATIONS block it prints).
* Hash algorithm only (no infra): `npm run build && node --test
  test-build/test/pattern-hash.test.js`.
* **Gate 2 is EXPECTED to FAIL right now** (CW egress broken, see
  above), so the harness exits non-zero (`5 passed, 1 failed`). That is
  the honest, correct state — not a regression in tenx_hash. The
  signal that matters is **Gate 3 (correctness) = PASS, 0 mismatches**;
  it is CW-independent and is the product invariant. Do not "fix" Gate 2
  by trusting a restart; it will pass exactly one batch then stall.
  Re-confirming the product only needs Gate 3 + Gate 4 + the conformance
  test — all green and CW-independent.

## Honest one-line verdict

The tenx_hash feature and its MCP tooling are sound and independently
re-verifiable (Gate 3 + conformance, 0 mismatches, no fabrication, clean
output). The only failing element is a WS5 CloudWatch demo egress rig
that is broken and was not stabilizable — disclosed loudly, never faked,
and orthogonal to the product.
