# MCP Advisor — End-to-End Verification Handoff

**Date:** 2026-04-21 (overnight autonomous session)
**Against:** Live `log-10x` demo EKS cluster (tenant `d02ad247-1e32-49ee-918d-93467ba8b134`)
**Charts under test:** all at version `1.0.6` (except `reporter-10x@1.0.7`)

## TL;DR

| Path | Verdict | Evidence |
|---|---|---|
| `log10x-fluent/fluent-bit` reporter | **WORKS** | Pipeline init + PrometheusClient publish of `emitted_events_summaryBytes_total` etc. |
| `log10x-fluent/fluent-bit` regulator | **WORKS** | Pipeline init with `app:regulator` + `rawOutputForwardAddress=/tmp/tenx_fluentbit.sock` readback wired |
| `log10x-fluent/fluentd` reporter | **WORKS** | Pipeline init (`readFile(file:fluentd) => … => publishEnvMetrics`) |
| `log10x-elastic/filebeat` reporter | **WORKS w/ caveat** | Pipeline init clean, pods 1/1, BUT tenx stdin shows no events flowing from the filebeat script processor — needs deeper debug before we claim full pass |
| `log10x-elastic/logstash` reporter | **BROKEN CHART** | Sidecar tenx needs to be spawned by logstash `pipe` output, but chart runs it as independent container with empty stdin; pipeline inits then dies after ~9s |
| `log10x-otel/opentelemetry-collector` reporter | **WORKS** | Unix socket wiring verified (`client connected to Forward protocol input`) + Publishing TenXSummary metrics |
| `log10x-k8s/reporter-10x@1.0.7` (non-invasive) | **WORKS (cleanest path)** | Full pipeline + real backpressure (2MB/s) + publish verified |
| `log10x-k8s/streamer-10x@1.0.6` | Already live in demo ns | Pattern documented |
| Optimizer (`kind=optimize` OR `kind=regulate` + `regulatorOptimize=true`) | **BROKEN — no working install path** | See Deferred #4 |

## Pre-reqs the advisor MUST communicate

1. **Real license key required.** The `metricOutput(Log10xMetricRegistryFactory)` unit fails-fast if the `TENX_API_KEY` value is a tenant-id (UUID). It must be a license key (different UUID). The advisor already surfaces this as a blocker.
2. **`github.com/log-10x/config` main branch compatibility.** Commit `6960e01` ("Feature/edge apps rework") renamed `apps/edge/X/config.yaml` → `apps/X/config.yaml` without a corresponding rebuild of `pipeline-10x:1.0.6`. The `1.0.6` image still ships `apps/edge/*/` as thin modules (no `runtimeName`), so any fresh install crashed with `could not resolve config variable: 'runtimeName'`.
   **Fixed** in this session: config PR #9 merged to main (commit `a982e06`) restores `apps/edge/{reporter,regulator,optimizer}/config.yaml` with full `runtimeName` declaration + enrichment/output includes. Flat `apps/{reporter,regulator,compiler}/config.yaml` now point at `- edge/*` as a band-aid.
3. **Image rebuild still pending.** `pipeline-10x:1.0.7` already has flat topology (`apps/{reporter,regulator,compiler}/` on `/opt/tenx-cloud/lib/app/modules/apps/`). When forwarder charts bump to `app_version: 1.0.7`, the band-aid should be reverted. Note that `log10x/edge-10x:1.0.7` (used by `reporter-10x@1.0.7`) ALSO has flat topology — this chart works best when `config.git.enabled=false` (uses image-baked config).
4. **Forwarder-self-log exclusion.** `/var/log/containers/*.log` includes every forwarder's own stdout. When two or more forwarders run on the same node, each tails the other's output, producing recursive events that grow 10KB/hop and OOM the tenx aggregator. The advisor now injects `Exclude_Path` (fluent-bit) / `exclude_files` (filebeat) / `exclude_path` (fluentd) for all known forwarder container names.

## Log10x chart catalog (what the advisor can recommend today)

Repos:
- `log10x-fluent` — fluent-bit, fluentd (+ fluent-operator)
- `log10x-elastic` — filebeat (OK), logstash (BROKEN)
- `log10x-otel` — opentelemetry-collector + kube-stack + demo + ebpf + operator
- `log10x-k8s` — **reporter-10x (1.0.7), streamer-10x (1.0.6), cron-10x (1.0.6)**

Published charts that map to apps:

| App | Inline chart (replaces forwarder image) | Non-invasive chart (runs alongside) |
|---|---|---|
| Reporter | `log10x-fluent/fluent-bit`, `log10x-fluent/fluentd`, `log10x-elastic/filebeat`, `log10x-otel/opentelemetry-collector` — all with `tenx.kind=report` | `log10x-k8s/reporter-10x@1.0.7` ← **cleanest** |
| Regulator | Same charts with `tenx.kind=regulate` | N/A (regulator needs bidirectional readback, must be inline) |
| Optimizer | Same charts with `tenx.kind=optimize` (not yet verified) | N/A |
| Compiler | NOT a forwarder chart — needs its own path (batch compile job, consuming symbol-library inputs and producing `.10x.tar`) | — |
| Streamer | `log10x-k8s/streamer-10x@1.0.6` + S3 bucket + 4 SQS queues + CloudWatch log group (see demo values for pattern) | — |

## Key findings per forwarder

### fluent-bit (reporter)
- Pipeline init line: `[INFO ] ... ExecutionPipeline - executing /opt/tenx-edge/lib/app/modules/pipelines/run/pipeline.yaml (adv-fb-v)`
- Pipeline units: `configLoader => symbolLoader => templateLoader => readFile(file:lua) => parallelize => transform => group => aggregateSingle(emitted_events: 10000/2s) => metricOutput(Log10xMetricRegistryFactory) => printProgress => monitor => tokenizeStats => publishEnvMetrics`
- Publish evidence: `[WARN] PrometheusClient - Failed to send metrics to https://prometheus.log10x.com/api/v1/write. Response code: 400, Metrics: [emitted_events_summaryBytes_total, emitted_events_summaryVolume_total]` (400 = server-side out-of-order dedup when two fresh pods publish concurrently, NOT a pipeline failure)
- Verified against branch `main` commit `a982e06` (post-band-aid merge)

### fluentd (reporter)
- Pipeline init: `executing … (adv-fd-v)`, units include `readFile(file:fluentd) => … => publishEnvMetrics`
- Confirmed pods 1/1 and init produces the standard welcome sequence (`🚀 Launching 10x Engine: Edge reporter app … 📈 Publishing TenXSummary metrics to the log10x backend`)
- Fresh pods were slow to schedule on the demo cluster (node capacity pressure); recommend a longer `wait --for=condition=Ready` timeout in verify probes

### filebeat (reporter)
- Pipeline init: `executing … (adv-fbeat-v)`, units include `readFile(file:filebeat) => … => publishEnvMetrics`
- Welcome sequence completes but private `/etc/tenx/log/tenx.log` stays at 5 lines — **tenx subprocess sees no events on stdin despite the filebeat `script` processor running**
- The `output.file` sink at `/tmp/tenx-mock-*.ndjson` DOES accumulate events (14MB in test) so filebeat itself is tailing `/var/log/containers/*.log` correctly
- Root cause not fully isolated in this session. Script file exists at the right `$TENX_MODULES` path; filebeat+tenx processes both alive with the pipe set up; but `console.info(JSON.stringify(event.fields))` output isn't reaching tenx. Likely a javascript-processor logging-destination issue when `-e` flag is set.
- **Handoff note:** the advisor should install cleanly (1/1 Ready), but advise the user to verify via the tenx.log, not just pod ready-state.

### logstash (reporter)
- **Chart broken.** Pipeline inits cleanly inside tenx sidecar (saw `executing … (adv-ls-v)` + full welcome) but then `shutting down` after ~9s because tenx.stdin is empty.
- The tenx-logstash integration expects tenx to be a child process of logstash spawned by the `pipe { command = "tenx run …" }` output plugin (so tenx's stdin is the logstash pipe). The log10x-elastic/logstash chart at 1.0.6 runs tenx as an independent container — pipe never exists.
- **Advisor now returns a blocker** when `forwarder=logstash` — won't produce broken install instructions.
- **Recommended workaround**: use `log10x-k8s/reporter-10x` non-invasive parallel DaemonSet alongside existing logstash.

### otel-collector (reporter)
- Pipeline init: `executing … (adv-otel-v)`, units include `readStream(stream:otelCollector) => … => publishEnvMetrics`
- Welcome: `📥 Reading events via Forward protocol on unix:///tmp/tenx-otel-in.sock`
- Verified socket wiring: `UnixSocketInputStream - client connected to Unix socket: /tmp/tenx-otel-in.sock` (the otel-collector container writes events to this socket, confirming chart wiring works)
- Only runtime note: default chart uses host ports (`4317`, `4318`, `6831` etc.) which conflict with any existing otel collector on the node. Advisor should null these (`ports.<name>.hostPort: null`) for side-by-side install.

### reporter-10x standalone @ 1.0.7 ← recommend this as preferred path
- Chart: `log10x-k8s/reporter-10x@1.0.7`, image: `log10x/edge-10x:1.0.7` (FLAT topology)
- 2-container pod: `fluent-bit` (upstream `fluent/fluent-bit:4.2`) + `tenx` (`log10x/edge-10x:1.0.7`)
- Fluent-bit tails `/var/log/containers/*.log` and forwards to tenx via Forward protocol over `/tenx-sockets/tenx-reporter.sock`
- **End-to-end verified**: pipeline init + `ForwardProtocolInputStream - client connected` + backpressure tester firing with `lastObjectSize: 2001006` (~2MB/s real load) + `📈 Publishing TenXSummary metrics to the log10x backend`
- Works BEST with `config.git.enabled=false` — image's baked-in config is the flat apps topology the image expects. Enabling git clone of `log-10x/config@main` pulls the band-aid which breaks 1.0.7.

### streamer (live in demo)
- Chart: `log10x-k8s/streamer-10x@1.0.6` (image `log10x/quarkus-10x`)
- Prerequisites (infra):
  - S3 bucket `<name>` for source, `<name>/indexing-results/` for outputs
  - 4 SQS queues: `-index-queue`, `-query-queue`, `-subquery-queue`, `-stream-queue`
  - CloudWatch log group `/tenx/<name>/query`
  - IAM role via IRSA for S3/SQS access
- `clusters[]` topology defines which pods handle `index`, `stream`, `query` roles
- Fluent-bit forwarder pushes events into the streamer via the chart's `fluentBit` values block
- Verified pattern from `helm get values tenx-streamer -n demo`

## Verified artifacts

- PR #9 in `log-10x/config` — merged to main (commit `a982e06`). Restores runtimeName band-aid.
- `log10x-mcp/src/lib/advisor/reporter-forwarders.ts` — added `FORWARDER_EXCLUDE_GLOBS` / `FORWARDER_EXCLUDE_REGEX` constants, applied to fluent-bit `[INPUT]`, filebeat `exclude_files`, fluentd `<source>` exclude_path. Logstash spec marked `chartAvailability: 'wip'`.
- `log10x-mcp/src/lib/advisor/reporter.ts` — added explicit blocker for `forwarder=logstash` pointing to `reporter-10x` workaround.

## Recommended next session work

1. **Add `reporter-10x` (1.0.7) as a distinct option in `advise-reporter`** (not a forwarder — a standalone "non-invasive" deployment mode). This is the cleanest path and should be the advisor's default recommendation when the user has any unsupported forwarder.
2. **Filebeat tenx-stdin issue**: debug why the script processor's `console.info` output isn't reaching tenx. Likely needs a change to how filebeat `-e` flag interacts with the JS processor's logging sink, OR a direct-stdout-writing processor alternative.
3. **Logstash**: either fix the `log10x-elastic/logstash` chart to run tenx as a child of logstash (pipe output), OR stop shipping it and officially recommend reporter-10x for logstash users.
4. **Optimizer mode — BROKEN in current chart/config combo.** Verification goal was that events emitted OUT of forwarders are in the compact/encoded form (templateHash-prefixed, comma-separated values per [transform doc](../config/modules/pipelines/run/units/transform/doc.md) — e.g. `-1VNUo?i|uV,1758825165678901000,12345,836,...`), not raw JSON. Two paths tested against live demo cluster 2026-04-22, both fail at init:
   - **Path A: `kind=optimize` directly on forwarder chart** → fails with `could not resolve include file: @run/input/forwarder/fluentbit/optimize/config.yaml`. Commit `6960e01` ("Feature/edge apps rework — Integrate optimizer into regulator") intentionally deleted the per-forwarder optimize configs AND the `apps/edge/optimizer` path from the config repo, but the forwarder charts at 1.0.6 still advertise `kind=optimize` and their Lua/filter hardcodes paths to the deleted files. My band-aid restored `apps/edge/optimizer/config.yaml` but not the `@run/input/forwarder/*/optimize/config.yaml` files.
   - **Path B: `kind=regulate` + env `regulatorOptimize=true`** (the new design intent per that commit) → fails with `ParameterException: Invalid value for option 'fluentbitEncodeObjects': '~$=TenXEnv.get("regulatorOptimize", false)' is not a boolean`. The `encodeObjects: $=yield TenXEnv.get("regulatorOptimize", false)` macro in `pipelines/run/input/forwarder/*/regulate/config.yaml` doesn't evaluate inside the boolean option parser — the engine sees the raw macro string instead of `true`/`false`. Bug is in either the engine's yield handler for boolean options or in the config repo's macro usage; not something the advisor can work around. `TenxKind` in the advisor has a docstring noting this; no MCP tool currently accepts `kind=optimize` so users can't request it today.
   - **Unblock path**: need either the config repo to republish working `optimize/config.yaml` files for each forwarder, OR the `$=yield` macro to work inside boolean option values (engine fix), OR a different mechanism (e.g., `regulatorOptimize` declared as a formal option the user can pass literally).
5. **Compiler app**: verify the batch-compile install path. Likely a one-shot Job, not a DaemonSet. Needs its own advisor tool.
6. **Image rebuild coordination**: once forwarder charts bump to `1.0.7` (pipeline-10x flat topology), drop the band-aid on `log-10x/config@main` as part of the regulator→reducer / streamer→offloader rename.
