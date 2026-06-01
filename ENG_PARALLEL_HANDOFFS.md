# Parallel Eng-Chat Handoffs

> Copy the **ENV CONTEXT** block into every eng chat's first message, then append the one **TASK** block for that chat.
> Verified 2026-05-31. The cost/savings chat (the orchestrator) owns log10x-mcp cost tools + config/modules aggregate — other chats must not touch those.

---

## ENV CONTEXT (paste into EVERY eng chat)

You are working in the Log10x monorepo-of-repos. Read this carefully — the #1 mistake is editing the wrong copy.

**Working discipline (do not skip):** Stay grounded in what you can OBSERVE, not what you reason about the engine doing. When a question is "does X behave this way?", build the smallest controlled run that prints the answer and read it — do not theorize about internals (that path burns hours and is usually wrong). Every claim of "fixed" / "works" must be backed by a run you just did and can show. Never report something as verified that you only deduced. When a metric/file/flag is named in this doc, confirm it still exists before relying on it.

**Two copies of everything (this is the trap):**
- **GIT = CI source of truth:** `/Users/talweiss/git/l1x-co/<repo>` → `github.com/log-10x/<repo>`. CI builds from these. Push here.
- **ECLIPSE = local run + IDE:** `/Users/talweiss/eclipse-workspace/l1x-co/{config,l1x,l1x-inc}`.
  - The **local JVM engine run uses Eclipse `l1x`** (`l1x/pipeline/*/bin/main` is on the run classpath). NOT git `l1x-inc`, and NOT eclipse `l1x-inc` (a stale third copy — ignore it).
  - **An engine change must land in BOTH git `l1x-inc` (for CI) AND eclipse `l1x` (for the local run + IDE compile).** They drift; keep them byte-identical for files you touch.

**Repos + current branches:**
- `l1x-inc` (engine) → `log-10x/engine`, branch **`feat/soft-drop`**
- `config`, `modules` → `log-10x/{config,modules}`, branch **`feat/soft-drop`** (ONE CI input `branch_modules_config` covers both)
- `log10x-mcp` → `log-10x/log10x-mcp`, branch **`feat/json-default-overnight-2026-05-25`** (a feature branch, NOT main — confirm the target branch with the orchestrator before committing; MCP is autonomous-after-preview per repo policy)
- `helm-charts` → `log-10x/helm-charts`, branch `main`; charts dir holds `reporter` + `retriever` (no `-10x` suffix)
- decoder/expand plugins (for compact modality): `splunk-app` (main), `elasticsearch-plugin` (main), `clickhouse-app` (feature/transparent-install)

**Local engine run (JVM, for fast iteration without CI):**
- Java 23: `/Library/Java/JavaVirtualMachines/jdk-23.jdk/Contents/Home/bin/java`
- Main: `com.log10x.ext.cloud.run.RunCloud`; classpath file: `/Users/talweiss/run-cloud.classpath` (use `-cp "$(cat …)"`)
- **cwd MUST be `TENX_HOME=/Users/talweiss/eclipse-workspace/l1x-co/config`** (running from `config/config` → infinite path recursion → StackOverflow)
- env: `TENX_LICENSE=-Bb_TTuaJgX0snvqyCojvVlgc5y6wMdoIy4qjGKG`, license file arg `-DTENX_LICENSE_FILE=/Users/talweiss/.tenx/demo-license.jwt`, `TENX_SYMBOLS_PATH=$TENX_HOME/config/data/shared/symbols`
- **Engine code changes need the Eclipse `l1x` classes RECOMPILED** (Eclipse auto-build, or compile) before the local run sees them — verify the `.class` mtime is newer than the `.java`.
- A working launcher exists at `/tmp/dimtest-run.sh` (reads the classpath, sets cwd, runs `RunCloud "$@"`).

**CI build (produces a dev image in ~4-7 min):**
```
gh workflow run dev_build_pipeline.yaml --repo log-10x/engine \
  -f dev_tag=<your-tag> \
  -f branch_main=feat/soft-drop \
  -f branch_extensions=9b614ff3ced14c686ce49430fe3b33fa517c7337 \   # PINNED (pre OFFLINE->AIRGAPPED rename)
  -f branch_modules_config=feat/soft-drop \
  -f branch_antlr=main
# watch: gh run watch <id> --repo log-10x/engine --exit-status
# output image: ghcr.io/log-10x/pipeline-10x-dev:<your-tag>
```

**otel-demo cluster (safe to deploy/validate — NOT prod):**
- AWS acct `351939435334`, `us-east-1`, EKS `log10x-otel-demo`
- kubectl context: `arn:aws:eks:us-east-1:351939435334:cluster/log10x-otel-demo`, namespace **`demo`**
- DaemonSet **`tenx-fluentd`**, 2 containers: `log10x` (the engine) + `fluentd` (the forwarder); node selector `workload=otel-demo`; currently image `…/pipeline-10x-dev:soft-drop-dim2`
- engine args: `@run/input/forwarder/fluentd @apps/receiver receiverOptimize false`
- redeploy: `kubectl -n demo set image ds/tenx-fluentd log10x=ghcr.io/log-10x/pipeline-10x-dev:<tag>` then `kubectl -n demo rollout status ds/tenx-fluentd`
- configmap/overlay edits need `kubectl -n demo rollout restart ds/tenx-fluentd` (subPath mounts don't live-reload)

**10x Prometheus (the TSDB):**
- `https://prometheus.log10x.com`, single auth header: `X-10X-Auth: 4d985100-ee4a-4b6c-b784-a416b8684868/6aa99191-f827-4579-a96a-c0ebdfe73884`
- key metrics: `all_events_summaryBytes_total`, `emitted_events_summaryBytes_total`, `all_events{isDropped="true"}` (new — the regulator-marked slice), `emitted_events_optimized_size_total` (compacted size; only emitted when `receiverOptimize=true`)

**Demo SIEM source (for POC-mode, raw events pre-install):** CloudWatch log group **`/log10x/otel-demo`** (acct `351939435334`, `us-east-1`) — live, ~1.5 GB, stream `tenx-fluentd`, real otel-demo app logs (cart/checkout/payment/etc). This is the "before 10x is installed" data source. (`/log10x/poc-test-otel` also exists, currently empty.)

**Git + prod safety rules (non-negotiable):**
- Branch off the feature branch; **preview every push**; **never force-push**; **never `git add -A`/`-A`** (each repo has pre-existing drift — stage only YOUR files by path).
- `main` needs the human's explicit "OK to push to main" — EXCEPT `log10x-mcp` (autonomous). Feature branches: autonomous after preview.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **NEVER deploy to prod** unless the message contains the exact phrase `DEPLOY TO PROD`. The otel-demo cluster is NOT prod (safe). `prometheus.log10x.com` is a shared prod API — **read only**. Do not touch S3 `log10x-console`, CloudFront `E1ZA6ENI06V2YF`, `console.log10x.com`, `auth.log10x.com`.

**Current soft-drop state (context, don't re-do):** `feat/soft-drop` has soft-drop working (the rate regulator marks `isDropped` in the groupFilter; the output decides via the `outputSoftDrop` knob: soft=emit/encode, hard=omit) plus the `isDropped` metric dimension (engine `5b9721693` + modules `8c044e0`). Verified live on the demo. NOT merged to `main` yet.

**OFF-LIMITS (owned by the cost/savings chat):** `log10x-mcp/src/tools/{savings,estimate-savings,resolve-batch,extract-templates}.ts`, `log10x-mcp/src/lib/{cost,promql,customer-metrics,cap-derivation}.ts`, `log10x-mcp/src/index.ts` (registration — coordinate before editing), and `config|modules/.../pipelines/run/aggregate/**`.

---

## TASK B — Engine fail-open (repo: git `l1x-inc` + eclipse `l1x`)

**Problem (trust-fatal):** a user-JS exception thrown inside the rate regulator's `groupFilter` getter is caught only at the **batch** level (around `EventSequenceDispatcher.java` ~L245-259), so a single bad event or a JS error **silently drops the whole batch**. Customers must never lose data to a regulator bug.

**Fix:** wrap the per-event user-JS group-filter invocation in a try-catch. On exception: **fail OPEN** — retain the event (treat the filter result as truthy / not-dropped) and increment an error counter/metric (so the failure is visible, not silent). One throwing event must not drop its neighbors.

**Where:** the engine group-filter invocation path. Start at `EventSequenceDispatcher` and the regulator getter dispatch; find where the user getter is called per event. Apply the same change in **both** git `l1x-inc` and eclipse `l1x` (keep them identical).

**Validate (local first, then CI+demo):**
1. Local run (see ENV CONTEXT harness): craft a regulator JS / input that throws on one event; confirm that event is **retained**, an error metric increments, and the batch's other events flow. Recompile eclipse `l1x` first.
2. Then CI build off `feat/soft-drop` (new `dev_tag`), redeploy to otel-demo, confirm no silent batch loss under an induced error.

**Boundaries:** engine only. Do not touch MCP, config, or modules. Push to `feat/soft-drop` (preview first). Report your commit SHAs.

---

## TASK C — Receiver Helm chart (repo: `helm-charts`)  — ASSIGNED: Dor

**Problem (GA blocker):** `helm-charts/charts/` has only `reporter` and `retriever`. There is **no `receiver`** chart, so there's no self-serve way to install the Receiver (the in-path sidecar that filters/samples/compacts inside the customer's forwarder).

**Task:** create `charts/receiver`, modeled on `charts/reporter` (and cross-referencing `retriever`), for the **Receiver** app:
- runs as a sidecar/DaemonSet alongside the customer's forwarder (fluent-bit / fluentd / filebeat / logstash / otel-collector / vector)
- engine args shape: `@run/input/forwarder/<forwarder> @apps/receiver` with `receiverOptimize` toggle and the rate-cap config (`rateReceiver.absoluteCap` / cap lookup file) + the `outputSoftDrop` knob exposed as values
- image `ghcr.io/log-10x/pipeline-10x:<version>` (use a dev tag like `soft-drop-dim2` for testing)
- standard values: image/tag, resources, nodeSelector, the `$TENX_CONFIG` overlay mechanism the other charts use, metrics output to the customer's Prometheus

**Validate:** `helm lint charts/receiver-10x` + `helm template` render cleanly; optionally deploy to the otel-demo cluster in a **test namespace** (not `demo`, to avoid disturbing the live demo) and confirm the receiver pod starts and emits metrics to `prometheus.log10x.com`.

**Boundaries:** `helm-charts` only. `main` needs the human's "OK to push to main" — work on a feature branch and report it. Report your branch + SHAs.

---

## TASK D — Sharpen investigative tools vs vanilla agents (repo: `log10x-mcp`)  — PARALLEL-OK

**Thesis:** a strong Claude 4.8 with SIEM/PromQL read access already does ~80% of diagnosis. A 10x investigative tool is only worth shipping if it leverages something an agent CANNOT replicate: (1) stable pattern identity (`tenx_hash`/`message_pattern`) stamped at ingest, (2) persistent per-pattern TSDB history keyed to it, (3) the bloom-indexed Retriever S3 archive, (4) cross-pillar joins on the stamped identity. Tools that only do PromQL arithmetic or local re-templatizing are commodity. Full thesis: `log10x-mcp/MCP_DIFFERENTIATION_PLAN.md`.

**Task:**
1. KEEP + sharpen the differentiated ones so they lean hard on the moat: `event_lookup` (pasted line → stamped `tenx_hash` → history), `pattern_trend`/`trend` (per-fingerprint TSDB history), `top_patterns` (stamped-id ranking + first-seen + trajectory), `investigate` (orchestrator).
2. FOLD the commodity primitives into `investigate` as internal steps; stop exposing them as standalone "differentiated" tools: `metrics_that_moved`, `rank_by_shape_similarity`, `metric_overlay` (pure PromQL arithmetic an agent does natively).
3. Re-point `pattern_examples` to the stamped-`tenx_hash` reverse-lookup path (makes it moat). (The `resolve_batch`/`extract_templates` hash-relabel is the cost chat's — those files are off-limits to you.)
4. Reposition tool descriptions: "Claude analyzes; 10x is the data layer + the actuator."

**Files you own:** `src/tools/{investigate,event-lookup,trend,pattern-trend,top-patterns,metrics-that-moved,rank-by-shape-similarity,metric-overlay,pattern-examples}.ts` + `src/lib/promql.ts` (cost chat only READS promql.ts, does not edit it — it's yours).
**Shared (coordinate, line-disjoint edits, tell the orchestrator):** `src/index.ts` (registration/deprecation).
**Off-limits (cost chat owns):** `src/tools/{savings,estimate-savings,resolve-batch,extract-templates}.ts`, `src/lib/{cost,customer-metrics,cap-derivation}.ts`, and `config|modules/.../aggregate/**`.

**Validate by running** (per the discipline above): for every "differentiated" claim, show a concrete call against the demo that a vanilla agent couldn't reproduce — e.g. `event_lookup` resolving a pasted line to its stamped `tenx_hash` and pulling that fingerprint's TSDB history. A claim with no run behind it doesn't count.

---

## NOT-YET-PARALLEL — Receiver-as-offloader (route dropped data to S3 instead of dropping)

This is the "offload → S3" modality (the cheapest non-drop rung: data leaves the SIEM, lands in the bloom-indexed Retriever archive, forensic-retrievable). **Hold it out of the parallel build for now**, because:
- It spans **engine + config/modules + the Retriever/S3 side** — it overlaps the cost chat's `config|modules/aggregate` work AND the engine chat's files, so a blind parallel build would collide.
- It's underspecified: does it reuse the existing Retriever archive writer, or add a new output target? Is "offload" a new cap-CSV action alongside pass/sample/compact/drop? How does the Receiver hand off to the Retriever's index pipeline?
- It is NOT blocking the savings work: `estimate_savings` can already *forecast* offload savings (~99% of SIEM cost avoided minus S3) without the offloader existing. The offloader is the actuator that later delivers what the forecast promises.

**Right sequence:** a short DESIGN pass first (collision-free — scope the action + the routing + Retriever reuse), then build it sequenced after the cost chat's aggregate change and the engine fail-open land. If you want motion now, the only safely-parallel slice is the **Retriever/S3 side** (`terraform-aws-tenx-retriever*` repos), not the engine/config routing.

---

## Merge coordination (orchestrator = cost/savings chat)
- Engine fail-open (B) → `feat/soft-drop`, folds into the eventual soft-drop GA merge.
- Receiver chart (C) → feature branch off `helm-charts/main`, separate PR.
- Cost/savings (me) → log10x-mcp `main` (autonomous) + config/modules aggregate on `feat/soft-drop`.
- No two chats share a file. If a cross-repo dep appears, surface it to the orchestrator rather than reaching into another repo.

---

## TASK F — Retriever shaping (repo: `log10x-mcp` retriever tools + `terraform-aws-tenx-retriever*`)  — PARALLEL-OK

**Scope (collision-free, verified 2026-05-31):** MCP tools `src/tools/{retriever-query,retriever-series,backfill-metric,advise-retriever}.ts` (import NONE of the shared cost/promql/cap-derivation/customer-metrics libs — keep it that way) + `terraform-aws-tenx-retriever` + `terraform-aws-tenx-retriever-infra` (both on `main`). Use an isolated worktree (`git -C log10x-mcp worktree add ../log10x-mcp-retriever -b feat/retriever-shaping feat/json-default-overnight-2026-05-25`).

**Off-limits (cost/savings orchestrator owns):** `src/tools/{savings,estimate-savings,resolve-batch,extract-templates}.ts`, `src/lib/{cost,promql,customer-metrics,cap-derivation}.ts`, `src/index.ts` registration (coordinate), `config|modules/.../aggregate/**`, any engine change. **THE OFFLOADER** ("Receiver routes dropped/over-cap data to S3 instead of dropping") is a SEQUENCED cross-repo item the orchestrator owns (engine + config/aggregate + retriever). Task F may DESIGN how the retriever ingests/indexes offloaded data, but NOT build the engine/config routing or the cap-CSV "offload" action.

**Task:** (1) read current retriever tools + memories ([[project_retriever_handoff_guide]], [[project_retriever_prod_readiness]], [[project_retriever_bloom_architecture]]); state works-today vs claimed-but-unverified with code citations. (2) Sharpen toward the moat = bloom-indexed archive (forensic retrieval of data NOT in the SIEM) + backfill_metric (history from archive); demote anything that's just an S3 list/scan a vanilla agent could do. (3) Validate against the demo — every "retriever does X" = a call you ran.

**Git:** preview every push; push to `feat/retriever-shaping`; never force-push/`git add -A`; main needs human OK except log10x-mcp. Report branch + SHAs + any `index.ts` regions touched.
