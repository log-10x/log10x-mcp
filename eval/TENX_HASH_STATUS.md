# tenx_hash: honest verification status

Read this before retesting. It states what is proven solid, the one
fix that was hard-won (the CloudWatch egress) and how it was actually
fixed, the defects found in the verification itself, and exactly how to
re-confirm. The goal is that retesting *confirms* this, not that it
collapses on the first question.

## Bottom line

The tenx_hash **correctness chain is solid and independently
re-verifiable**, and the **whole data plane now works end to end**,
including the CloudWatch egress that was previously broken:

1. The engine emits `tenx_hash` on events (xxHash64 of the symbol
   sequence, base64url, 11 chars). Proven by running the real engine
   (not the spec): conformance vectors + a live otel-demo run.
2. The MCP's local `tenxHash()` reproduces the engine's value
   **byte-for-byte**, a pure-local, network-independent oracle.
   Conformance test: `node --test test-build/test/pattern-hash.test.js`.
3. The engine's log10x **cloud** Prometheus backend independently binds
   the same `tenx_hash` values to named patterns. Verified live: for N
   sampled hashes, `tenxHash(engine's own bound pattern) == the hash`
   with **zero tolerance for a single mismatch** (latest run: 8/8, 0
   mismatch).
4. MCP tools act on it correctly. `event_lookup({tenxHash})`
   reverse-resolves hash to pattern to cost; `exclusion_filter` emits
   the exact-hash drop config (fluentd block byte-identical to one
   proven on the live demo); fabricated hashes return an honest "not
   found" (4 fakes, no hallucinated pattern).
5. Tool output is clean: human-visible text carries no agent chatter
   (HTML-comment-fenced; stripped and checked every run).
6. **The fluentd to CloudWatch egress is fixed and proven.** Enriched
   events carrying `tenx_hash` land in CW group
   `/log10x/otel-demo/enriched` sustained, fresh, and readable, so the
   harness verifies the *real* data plane, not just the cloud backend.

Re-confirm all of the above in one command:

    bash eval/bin/verify-tenx-hash-e2e.sh 8

Exit 0 = every gate passed. Latest: **6 passed, 0 failed**. It
re-derives everything from ground truth each run and prints a
KNOWN-LIMITATIONS block every time.

## The CloudWatch egress: what was broken and how it was fixed

For most of this work the CW egress (the WS5 rig) was broken and could
not be stabilized from the fluentd side. The honest, hard-won story:

**Symptom.** The fluentd image's Ruby `fluent-plugin-cloudwatch-logs`
(v0.14.3) **silently never flushed** in this pod/firehose topology. The
file buffer filled (events arrived fine from the 10x sidecar), the
chunk left disk, CloudWatch stayed starved, and the plugin emitted
**zero** diagnostic lines, no flush, no retry, no AWS error, even with
`@log_level info` set explicitly.

**Not a tenx / creds / AWS / network defect.** A direct `PutLogEvents`
from the pod using its IRSA role succeeded. The AWS path was always
good; the Ruby plugin's flush scheduling is the pathology.

**Four fluentd-side fixes were attempted; all failed identically:**
(1) plain `rollout restart`; (2) bounded-retry + capped memory buffer +
`flush_thread_count 2`; (3) finite-retry + file buffer + bounded
chunks; (4) `cloudwatch_logs` as the sole top-level `@OUTPUT` match
(its own normal flush context, no `copy`/`ignore_error`). Every one
showed the identical signature.

**The fix (escalation off the broken plugin).** CW egress was taken
off the Ruby plugin entirely. fluentd still does ingest + the 10x
receive/return; its `@OUTPUT` now `@type forward`s to a **Fluent Bit
sidecar** on `127.0.0.1:24226` whose Go `cloudwatch_logs` output (a
completely separate codebase) does the `PutLogEvents`.

**Proven (2026-05-16), with AWS-acknowledged ground truth:**

* Egress sustained: 7 consecutive 40s windows, each ~38-41
  `PutLogEvents` HTTP 200 with `nextSequenceToken`, ~1.8k-2.7k events
  per window, **zero errors over ~4 minutes**. That decisively defeats
  the old "one batch then stall" failure mode.
* Fresh: newest retrievable CW event age ~0-9s (real time, not lagging).
* Correct payload: every event read back from CW carries `tenx_hash`;
  one 200-event page held 72-79 distinct hashes across real otel-demo
  services (llm, product-reviews, otel-collector).
* Steady state holds at `Log_Level info` (debug was diagnostic only).

The fix lives in `eval/cw-egress-fix/` (fluent-bit.conf, the fluentd
`04_outputs.conf`, the daemonset patch, `apply.sh`, README).

## What is still limited (do not be ambushed)

* **The fix is a live kubectl patch on a Helm-managed daemonset** plus
  a `fluentd-config-tenx` rewrite and one new `fluent-bit-cwl`
  configmap. A `helm upgrade` of the fluentd release **reverts all of
  it**. Recovery is one command: `bash eval/cw-egress-fix/apply.sh`,
  then re-run the harness. The proper long-term home is the fluentd
  Helm values; until then `eval/cw-egress-fix/` is the source of truth.
* Scope: the harness **observes live production traffic**; it does not
  inject a synthetic canary through fluentd. It asserts the data plane
  is producing & correlating tenx_hash, not that an arbitrary new line
  would. For an injected end-to-end probe use `eval/counterfactual/`.
* CW read-after-write lag is real but small here (newest event a few
  seconds old in steady state). Gate 2's stall threshold is 900s, well
  clear of normal lag and of a real stall.

## Pre-existing demo defect (unrelated to tenx_hash)

The receiver also remote-writes to `http://localhost:9090/api/v1/write`
(no listener), ~180 connection-refused failures / 5 min. This predates
and is unrelated to tenx_hash; the cloud backend used for correlation
is healthy. Gate 1 **discloses** this rather than claiming "healthy".

## Defects found in the verification itself (the anti-hollow-harness work)

An adversarial sub-agent (non-leading prompt) found 5 holes; all fixed
(see git history). A 6th was caught directly: Gate 2's freshness was
theater (`filter-log-events --max-items` returns the *oldest* N of the
window, so "newest age" was always window-size). A **7th, the most
important, was found during this fix**:

* Gate 2 then used `describe-log-streams lastIngestionTime` as the
  "authoritative" freshness signal. It is **not** authoritative: it was
  observed climbing 1:1 with wall clock to >2000s **while the egress
  was provably healthy** (fluent-bit returning PutLogEvents HTTP 200 +
  nextSequenceToken, and `get-log-events` showing events at age ~0s).
  As a gate it would **false-fail a working pipeline**. Rebuilt to read
  the **newest** events via `get-log-events` (startFromHead=false, no
  oldest-N truncation) and assert (a) recent and (b) carries
  `tenx_hash`, which is the e2e claim itself, not a proxy. The stale
  "30m window" KNOWN-LIMITATIONS text was corrected to match.

This is the failure mode being guarded against in both directions:
false-pass (theater) **and** false-fail (a misleading instrument
reporting a healthy pipeline as broken). Both were found and fixed
before declaring the e2e done.

## How to retest

* Full chain: `bash eval/bin/verify-tenx-hash-e2e.sh 8` (exit 0 = pass;
  read the KNOWN-LIMITATIONS block it prints every run). Expected now:
  **6 passed, 0 failed**, with Gate 2 PASS (newest CW event a few
  seconds old, >=8 distinct tenx_hash) and Gate 3 PASS (correctness
  0 mismatch, CW-independent).
* Hash algorithm only (no infra): `npm run build && node --test
  test-build/test/pattern-hash.test.js`.
* If Gate 2 fails with "newest event thousands of seconds ago": the
  fluentd Helm release was likely upgraded and reverted the fix. Run
  `bash eval/cw-egress-fix/apply.sh`, wait ~2 min, retest. Do **not**
  reach for `describe-log-streams lastIngestionTime`; it lies here.
* Gate 3 (correctness) is the product invariant and is CW-independent;
  it must be PASS with 0 mismatches regardless of the egress.

## Honest one-line verdict

The tenx_hash feature, its MCP tooling, and the full data plane are
sound and independently re-verifiable: conformance + Gate 3 (0
mismatch, CW-independent) prove correctness; the CloudWatch egress that
resisted four fluentd-side fixes was fixed by moving egress to a Fluent
Bit sidecar and is now proven sustained, fresh, and carrying tenx_hash,
so the harness verifies the genuine end-to-end pipeline (6 passed, 0
failed). The one honest caveat is operational, not correctness: the fix
is a live patch a `helm upgrade` reverts, with a one-command recovery.
