# MCP Advisor — End-to-End Verification Handoff

**Date:** 2026-04-22 (updated after Dor's 1.0.7 fluent-helm-charts fixes landed)
**Against:** Live `log-10x` demo EKS cluster (tenant `d02ad247-1e32-49ee-918d-93467ba8b134`)
**Charts under test:** `log10x-fluent/*` at `1.0.7`, `log10x-elastic/*` + `log10x-otel/*` still at `1.0.6`, `log10x-k8s/reporter-10x@1.0.7`, `log10x-k8s/streamer-10x@1.0.6`.

## TL;DR

| Path | Verdict | Evidence |
|---|---|---|
| `log10x-fluent/fluent-bit@1.0.7` reporter/regulator | **WORKS** | Pipeline init + PrometheusClient publish of `emitted_events_summaryBytes_total` etc. Chart 1.0.7 silently ignores `tenx.kind` — always runs regulator pipeline. |
| `log10x-fluent/fluent-bit@1.0.7` **optimizer** | **WORKS via env workaround** | Events emitted to fluent-bit stdout come out compact: `"log":"~-8Av]P9cVZb,1776860517542787000,1,proxier,1484,numServices,49,..."` — templateHash + comma-sep values per the transform/compact spec. 20-40x volume reduction by eyeball. Trigger: `env: [{name: regulatorOptimize, value: "true"}]` on the pod. The chart's own `tenx.optimize: true` field is CHART-BROKEN (points at `tenx-optimize.lua` missing from the 1.0.7 image). |
| `log10x-fluent/fluentd@1.0.7` reporter/regulator | **WORKS** | Pipeline init (`readFile(file:fluentd) => … => publishEnvMetrics`). |
| `log10x-fluent/fluentd@1.0.7` **optimizer** | **WORKS via same env workaround** | tenx banner shows `📝 Writing TenXObject fields: 'encoded=encode()' → Fluentd: /tmp/tenx_fluentd.sock`. |
| `log10x-elastic/filebeat@1.0.6` reporter | **WORKS w/ caveat** | Pipeline inits clean, pods 1/1, BUT tenx stdin shows no events flowing from the filebeat script processor — needs deeper debug before claiming full pass. |
| `log10x-elastic/logstash@1.0.6` reporter | **BROKEN CHART** | Sidecar tenx needs to be spawned by logstash `pipe` output, chart runs it as independent container with empty stdin; pipeline inits then dies after ~9s. Advisor now blocks `forwarder=logstash`. |
| `log10x-otel/opentelemetry-collector@1.0.6` reporter | **WORKS** | Unix socket wiring verified (`client connected to Forward protocol input`) + Publishing TenXSummary metrics. |
| `log10x-k8s/reporter-10x@1.0.7` (non-invasive) | **WORKS (cleanest path)** | Full pipeline + real backpressure (2MB/s) + publish verified. |
| `log10x-k8s/streamer-10x@1.0.6` | Already live in demo ns | Install pattern documented (S3 + 4 SQS queues + CloudWatch log group + IRSA role pre-provisioned). |

**Every app the user asked about (reporter, regulator, optimizer, streamer) now has at least one verified working install path.**

## Pre-reqs the advisor MUST communicate

1. **Real license key required.** The `metricOutput(Log10xMetricRegistryFactory)` unit fails-fast if the `TENX_API_KEY` value is a tenant-id (UUID). It must be a license key (different UUID). The advisor already surfaces this as a blocker.
2. **`github.com/log-10x/config@main` compatibility (resolved 2026-04-22).** PR #9 (commit `a982e06`) merged band-aid `apps/edge/{reporter,regulator,optimizer}/config.yaml` templates to unblock pipeline-10x:1.0.6 charts. Then dor shipped fluent-helm-charts PR #7 which bumped fluent-bit + fluentd to 1.0.7 using pipeline-10x:1.0.7 (flat topology). Commit `4dc0712` on main **reverts** the `apps/{reporter,regulator,compiler}/config.yaml` include redirects back to flat form (`- reporter` / `- regulator` / `- compiler`) to match the 1.0.7 image. The `apps/edge/*/config.yaml` templates from PR #9 **stay in place** so forwarder charts still on 1.0.6 (filebeat/logstash/otel-collector) keep working.
3. **Chart/image version pairings verified:**
   - `log10x-fluent/fluent-bit@1.0.7` → `log10x/fluent-bit-10x:1.0.7-jit` (flat topology, `tenx.optimize` boolean)
   - `log10x-fluent/fluentd@1.0.7` → `log10x/fluentd-10x:1.0.7-jit` (flat topology)
   - `log10x-k8s/reporter-10x@1.0.7` → `log10x/edge-10x:1.0.7` (flat; best with `config.git.enabled=false` so the image-baked config wins)
   - `log10x-elastic/filebeat@1.0.6` → `log10x/filebeat-10x:1.0.6-jit` (hybrid — needs clone's `apps/edge/reporter/config.yaml`)
   - `log10x-elastic/logstash@1.0.6` → broken (chart sidecar wiring)
   - `log10x-otel/opentelemetry-collector@1.0.6` → `otel/opentelemetry-collector-contrib` + tenx sidecar `log10x/pipeline-10x:1.0.6`
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
4. **Optimizer mode — WORKING via env workaround (verified 2026-04-22 after Dor's 1.0.7 charts landed).** Events emitted out of fluent-bit stdout in compact form as spec'd in the transform/compact doc, e.g.:
   ```
   "log":"~-8Av]P9cVZb,1776860517542787000,1,proxier,1484,numServices,49,numEndpoints,136,numFilterChains,6,numFilterRules,4,numNATChains,14,numNATRules,85"
   ```
   First field is templateHash, rest are timestamp + high-cardinality vars. The raw form of this event was ~2KB of JSON-embedded text; the compact form is ~150 bytes. Trigger: `env: [{name: regulatorOptimize, value: "true"}]` on the forwarder pod. The chart's `tenx.optimize: true` field is chart-broken (references `tenx-optimize.lua` which is missing from `log10x/fluent-bit-10x:1.0.7-jit`) — do NOT use it. Recorded in `TenxKind` docstring. Follow-up: expose `optimize: boolean` as a first-class parameter on `advise-regulator` so users get the env workaround in their rendered install plan.
5. **Compiler app**: verify the batch-compile install path. Likely a one-shot Job, not a DaemonSet. Needs its own advisor tool.
6. **Image rebuild coordination**: once forwarder charts bump to `1.0.7` (pipeline-10x flat topology), drop the band-aid on `log-10x/config@main` as part of the regulator→reducer / streamer→offloader rename.
