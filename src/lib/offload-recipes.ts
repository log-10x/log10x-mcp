/**
 * Per-forwarder action-routing recipes for the Retriever cost loop.
 *
 * Sibling to `forwarder-snippets.ts`, but a different shape. Where the
 * drop-rule snippet emits a single SIEM-side exclude, these recipes are a
 * MULTI-way fan-out keyed on the engine-stamped `routeState` marker. The
 * receiver now stamps a PER-SERVICE action (drop | offload | tier_down |
 * compact | sample | pass) on each service's regulator-excess slice, so the
 * forwarder branches one destination per action:
 *
 *   - `offload`   -> the forwarder's OWN native S3 output, written as full,
 *                    newline-delimited JSON under `{bucket}/{prefix}` (the
 *                    exact layout the Retriever indexes).
 *   - `tier_down` -> a cheaper in-platform SIEM tier (Datadog Flex /
 *                    CloudWatch Infrequent-Access / ES frozen / etc). The
 *                    cheap-tier sink is destination-specific, so each recipe
 *                    leaves a clearly-labeled placeholder for it.
 *   - `drop`      -> suppressed (no output at all; the slice is shed).
 *   - `pass` / `compact` / `sample` -> the existing SIEM destination. The
 *                    engine already carries `compact`'s encoded bytes and
 *                    `sample`'s thinning on the wire, so the forwarder just
 *                    routes them to the SIEM unchanged.
 *
 * Nothing the customer wants kept is deleted: the `offload` slice is relocated
 * to the customer's own bucket before the SIEM bills it, and the Retriever
 * fetches it back by stamped identity. This is lossless cost reduction, not
 * archival.
 *
 * Engine contract (verified live on run-edge 1.1.0, config repo 42e5331):
 *   - the receiver runs with `outputOffload true`, which resolves the output
 *     field to `fullText("tenx_hash","routeState")` and the drop filter to
 *     `isObject` (every marked event flows back to the forwarder, full text).
 *   - `routeState` lands as a JSON STRING (`"routeState":"drop"` /
 *     `"routeState":"offload"` / `"routeState":"pass"` / ...), spliced inside
 *     the event envelope. Every forwarder match MUST therefore be string
 *     equality against the action NAME, never a boolean/truthiness test.
 *   - `tenx_hash` ships alongside it, so the same S3 object carries the stable
 *     identity the Retriever correlates on.
 *
 * On EVERY branch the `routeState` marker is stripped and `tenx_hash` is kept
 * (mirroring the original single-route drop branch).
 */

import { getAllowedActionsForDestination, COST_MODEL_BY_DESTINATION } from './cost.js';

export type OffloadForwarderId =
  | 'vector'
  | 'fluentd'
  | 'fluent-bit'
  | 'otel-collector'
  | 'logstash'
  | 'cribl';

/** Forwarders whose recipe shape is verified against the engine contract and
 * the forwarder's own docs. The rest are research-derived and carry a
 * `smokeTest` prerequisite so the caller never claims end-to-end without it. */
export const OFFLOAD_FORWARDERS: OffloadForwarderId[] = [
  'vector',
  'fluentd',
  'fluent-bit',
  'otel-collector',
  'logstash',
  'cribl',
];

export interface OffloadRecipe {
  language: 'toml' | 'xml' | 'ini' | 'yaml' | 'ruby' | 'json' | 'text';
  /** The two-route config, ready to paste. */
  body: string;
  /** Where it goes in the user's config, and why (anchors the Reader to the
   * engine mechanism so the match isn't arbitrary). */
  placementNote: string;
  /** Hard prerequisites the recipe depends on. Always includes the engine
   * offload mode and the forwarder-write IAM grant; per-forwarder gotchas
   * (contrib distro, plugin install, JSON encoding) are appended. */
  prerequisites: string[];
}

export interface OffloadParams {
  /** The Retriever input bucket (snapshot.recommendations.retrieverS3Bucket). */
  bucket: string;
  /** Key prefix == the Retriever `target` (default `app`). Objects land at
   * `{bucket}/{prefix}/...`; the indexer's S3->SQS notification picks them up. */
  prefix?: string;
  /** AWS region of the bucket (snapshot.aws.region). */
  region: string;
  /** The engine's `symbolMessageHashField` value. Defaults to `tenx_hash`. */
  hashField?: string;
}

const DEFAULT_PREFIX = 'app';

/** Prerequisites shared by every forwarder recipe. */
function basePrereqs(p: OffloadParams): string[] {
  return [
    'Engine: the receiver runs with `outputOffload true` (full-text events + `routeState` marker, all events flow back to the forwarder).',
    `IAM: the forwarder's identity can \`s3:PutObject\` to \`${p.bucket}/${p.prefix ?? DEFAULT_PREFIX}/*\` — see \`forwarderWriteIamPolicy()\` (only the \`offload\` branch needs this grant).`,
    'Match the route-state name as a STRING (`routeState == "offload"`, `"tier_down"`, `"drop"`, ...), never a boolean test (the engine writes the action name as a JSON string).',
  ];
}

// ---------------------------------------------------------------------------
// vector  (verified shape: route transform + aws_s3 sink, newline-delimited)
// ---------------------------------------------------------------------------
function recipeVector(p: OffloadParams): OffloadRecipe {
  const prefix = p.prefix ?? DEFAULT_PREFIX;
  return {
    language: 'toml',
    body: `# Fan the 10x return stream per stamped action. One route per action;
# the implicit _unmatched route carries pass/compact/sample to the SIEM.
[transforms.tenx_action_route]
type   = "route"
inputs = ["tenx_sidecar"]              # the source reading 10x's return path
route.offload   = '.routeState == "offload"'   # -> customer S3
route.tier_down = '.routeState == "tier_down"' # -> cheaper SIEM tier
route.drop      = '.routeState == "drop"'      # -> suppressed (no sink)
# pass / compact / sample fall through to ._unmatched -> the SIEM.

# offload slice -> customer-owned S3, as the Retriever's input layout (JSONL).
[sinks.tenx_offload_s3]
type        = "aws_s3"
inputs      = ["tenx_action_route.offload"]
bucket      = "${p.bucket}"
key_prefix  = "${prefix}/"
region      = "${p.region}"
compression = "none"
encoding.codec          = "json"
encoding.except_fields  = ["routeState"]  # marker did its job at the route; drop it (tenx_hash kept)
framing.method          = "newline_delimited"

# tier_down slice -> your cheaper in-platform tier (destination-specific).
# PLACEHOLDER: point this at the cheap-tier sink for your SIEM, e.g. a
# CloudWatch IA log group, a Datadog Flex index, or an ES frozen tier. See
# datadogFlexRecipe() / cloudwatchIaRecipe() / azureLogsTierRecipe() for the
# destination-side TF (Azure Basic/Auxiliary needs Fluent Bit or Logstash, not Vector).
[sinks.tenx_tier_down]
inputs = ["tenx_action_route.tier_down"]
encoding.except_fields = ["routeState"]   # strip the marker (tenx_hash kept)
# ... your CHEAP-TIER sink config (Flex index / IA log group / frozen tier) ...

# drop slice -> SUPPRESSED. The "drop" route has no sink, so Vector discards
# it: shedding the slice the engine marked as pure noise. (Leaving it
# unwired is the suppression — do not add a sink here.)

# pass / compact / sample -> your existing SIEM sink (the _unmatched route).
# compact already carries the engine's encoded bytes on the wire, so no
# special handling is needed beyond routing it to the SIEM.
[sinks.your_siem]
inputs = ["tenx_action_route._unmatched"]
encoding.except_fields = ["routeState"]   # strip the marker on the SIEM path too
# ... your existing SIEM sink config ...`,
    placementNote:
      'add the `route` transform downstream of the source reading 10x\'s return ' +
      'path. The `offload` route goes to S3, `tier_down` to your cheap-tier sink, ' +
      '`drop` is left unwired (suppressed), and pass/compact/sample fall through ' +
      '`._unmatched` to your existing SIEM sink. The marker is stripped at each ' +
      'sink via `encoding.except_fields`, so no extra transform is needed. ' +
      'Validate with `vector validate <config>`.',
    prerequisites: basePrereqs(p),
  };
}

// ---------------------------------------------------------------------------
// fluentd  (verified live: copy -> relabel -> grep + record_transformer.
// CORE plugins only — no rewrite_tag_filter gem, no rewrite loop, explicit
// label routing so nothing escapes to the root router.)
// ---------------------------------------------------------------------------
function recipeFluentd(p: OffloadParams): OffloadRecipe {
  const prefix = p.prefix ?? DEFAULT_PREFIX;
  return {
    language: 'xml',
    body: `<label @OUTPUT>
  <!-- 1) fan the 10x return stream to one label per action; each grep keeps
       only its slice, so routing is explicit (core copy/relabel/grep only, no
       extra tag-rewrite gem, no rewrite loop, nothing escapes to the root
       router). -->
  <match tenx.**>
    @type copy
    <store>
      @type relabel
      @label @TENX_OFFLOAD
    </store>
    <store>
      @type relabel
      @label @TENX_TIER_DOWN
    </store>
    <store>
      @type relabel
      @label @TENX_DROP
    </store>
    <store>
      @type relabel
      @label @TENX_SIEM
    </store>
  </match>
</label>

<!-- 2) offload slice -> customer-owned S3 as plain JSONL -->
<label @TENX_OFFLOAD>
  <filter **>
    @type grep
    <regexp>
      key routeState
      pattern /^offload$/       <!-- keep only the offload slice -->
    </regexp>
  </filter>
  <filter **>
    @type record_transformer
    remove_keys routeState      <!-- marker did its job; tenx_hash kept -->
  </filter>
  <match **>
    @type s3
    s3_bucket ${p.bucket}
    s3_region ${p.region}
    path ${prefix}/
    store_as txt                <!-- plain newline-delimited JSON, not gzip -->
    <format>
      @type json
    </format>
    <buffer tag,time>
      @type file
      timekey 60
      timekey_wait 10s
    </buffer>
  </match>
</label>

<!-- 3) tier_down slice -> your cheaper in-platform SIEM tier -->
<label @TENX_TIER_DOWN>
  <filter **>
    @type grep
    <regexp>
      key routeState
      pattern /^tier_down$/      <!-- keep only the tier_down slice -->
    </regexp>
  </filter>
  <filter **>
    @type record_transformer
    remove_keys routeState
  </filter>
  <match **>
    <!-- PLACEHOLDER: your CHEAP-TIER destination <match> (destination-specific):
         e.g. a second cloudwatch_logs <match> pointed at an Infrequent-Access
         log group, or a datadog <match> tagged to a Flex index. See
         cloudwatchIaRecipe() / datadogFlexRecipe() / azureLogsTierRecipe() for the
         destination-side TF (Azure Basic/Auxiliary needs Fluent Bit or Logstash, not Fluentd). -->
  </match>
</label>

<!-- 4) drop slice -> SUPPRESSED. @type null discards it (the slice the engine
     marked as pure noise never reaches a destination). -->
<label @TENX_DROP>
  <filter **>
    @type grep
    <regexp>
      key routeState
      pattern /^drop$/          <!-- keep only the drop slice... -->
    </regexp>
  </filter>
  <match **>
    @type null                  <!-- ...then discard it -->
  </match>
</label>

<!-- 5) pass / compact / sample -> your existing SIEM destination. compact
     already carries the engine's encoded bytes on the wire, so no special
     handling beyond routing it to the SIEM. -->
<label @TENX_SIEM>
  <filter **>
    @type grep
    <regexp>
      key routeState
      pattern /^(pass|compact|sample)$/   <!-- keep only the SIEM-bound slices -->
    </regexp>
  </filter>
  <filter **>
    @type record_transformer
    remove_keys routeState
  </filter>
  <match **>
    <!-- ... your existing destination <match> ... -->
  </match>
</label>`,
    placementNote:
      'the `<match tenx.**>` copy goes in the `@OUTPUT` label; the `@TENX_*` ' +
      'labels go at root. `copy` duplicates every event to all four labels and ' +
      'each `grep` keeps only its action(s): `offload` -> S3, `tier_down` -> your ' +
      'cheap-tier <match>, `drop` -> `@type null` (suppressed), pass/compact/sample ' +
      '-> the SIEM. Routing is explicit (no rewrite_tag_filter, no rewrite loop, ' +
      'nothing escapes to the root router). `record_transformer` strips the marker ' +
      'on every kept path.',
    prerequisites: [
      ...basePrereqs(p),
      'Plugin: `fluent-plugin-s3` must be present for the S3 output (bundled in td-agent / fluent-package; on a vanilla OSS image run `fluent-gem install fluent-plugin-s3`). copy / relabel / grep / record_transformer / null are core, no extra gem.',
    ],
  };
}

// ---------------------------------------------------------------------------
// fluent-bit  (smoke-tested live, v5: a lua filter maps the routeState match
// to a dedicated routing key first; KEEP must be true; a grep excludes the
// dropped slice from the SIEM.)
// ---------------------------------------------------------------------------
function recipeFluentBit(p: OffloadParams): OffloadRecipe {
  const prefix = p.prefix ?? DEFAULT_PREFIX;
  return {
    language: 'ini',
    body: `[SERVICE]
    Grace 5                # let the re-emitted chunks flush before shutdown

# 1) map the routeState marker to a dedicated routing key for the rewrite_tag
#    Rules below. offload/tier_down/drop get their own tags; pass, compact and
#    sample stay on tenx.app for the SIEM. (Keeping rec["routeState"]=="drop"
#    explicit so the noise slice is unambiguous.)
[FILTER]
    Name    lua
    Match   tenx.*
    call    tag_route
    code    function tag_route(tag,ts,rec) local r=rec["routeState"] if r=="offload" then rec["_route"]="offload" elseif r=="tier_down" then rec["_route"]="tier_down" elseif r=="drop" then rec["_route"]="drop" else rec["_route"]="siem" end return 2,ts,rec end

# 2) route each non-SIEM action to its own tag. KEEP=true (4th field): KEEP=false
#    drops the re-emitted record entirely in fluent-bit. The original copy stays
#    on tenx.app and the routed slices are excluded from it in step 3.
[FILTER]
    Name    rewrite_tag
    Match   tenx.*
    Rule    $_route ^offload$   tenx.offload   true
    Rule    $_route ^tier_down$ tenx.tier_down true
    Rule    $_route ^drop$      tenx.drop      true

# 3) keep the routed slices OUT of the SIEM path (the KEEP=true originals on
#    tenx.app). What remains on tenx.app is pass/compact/sample == _route siem.
[FILTER]
    Name    grep
    Match   tenx.app
    Regex   _route ^siem$

# 4) strip both markers on every path (tenx_hash kept). tenx.* spans the
#    retagged tags and the kept tenx.app (the wildcard crosses dots).
[FILTER]
    Name       record_modifier
    Match      tenx.*
    Remove_key routeState
    Remove_key _route

# 5) offload slice -> customer-owned S3 as JSONL
[OUTPUT]
    Name          s3
    Match         tenx.offload
    bucket        ${p.bucket}
    region        ${p.region}
    s3_key_format /${prefix}/$UUID.jsonl
    use_put_object On
    json_date_format iso8601

# 6) tier_down slice -> your cheaper in-platform SIEM tier.
#    PLACEHOLDER: replace with the OUTPUT for your cheap tier, e.g. a second
#    [OUTPUT] Name cloudwatch_logs pointed at an Infrequent-Access log group,
#    a datadog output tagged to a Flex index, or an azure_logs_ingestion output
#    to an Azure Basic/Auxiliary table. See cloudwatchIaRecipe() /
#    datadogFlexRecipe() / azureLogsTierRecipe() for the destination-side TF.
# [OUTPUT]
#     Name   <your_cheap_tier_output>
#     Match  tenx.tier_down

# 7) drop slice -> SUPPRESSED. The null output discards the noise slice.
[OUTPUT]
    Name   null
    Match  tenx.drop

# 8) pass / compact / sample -> your existing SIEM output, Match tenx.app.
#    compact already carries the engine's encoded bytes on the wire, so no
#    special handling beyond routing it to the SIEM.`,
    placementNote:
      'all FILTERs sit on the 10x return path (`Match tenx.*`); `routeState` only ' +
      'exists on post-sidecar records. The lua filter maps the marker to a routing ' +
      'key `_route`, the `rewrite_tag` Rules send offload/tier_down/drop to their ' +
      'own tags (S3 / cheap-tier / `null`), and pass/compact/sample stay on ' +
      '`tenx.app` for the SIEM.',
    prerequisites: [
      ...basePrereqs(p),
      // CORRECTED against a live run (see test/fixtures/coralogix-e2e).
      // This previously said the return path MUST emit json. That is backwards
      // and it fails silently on every destination that uses the lua branch
      // below: under `json` the engine ships the whole rendered record as ONE
      // msgpack string field named after the encode expression, so
      // `rec["routeState"]` is nil, no branch matches, and offload/drop
      // routing quietly stops while everything still returns success.
      'Encoding: KEEP the shipped default `fluentbitOutputEncodeType: delimited`, which delivers `routeState` as its own record field. Do NOT set it to `json`: that collapses the record into a single string field, the routing lua stops matching, and the offload/drop slices silently fall through to the SIEM with no error.',
      'The lua filter (marker -> routing key) and `KEEP=true` are both mandatory in this shape: the routes are keyed off `_route`, and KEEP=false drops the re-emitted record (verified live on fluent-bit v5).',
    ],
  };
}

// ---------------------------------------------------------------------------
// otel-collector  (smoke-tested live on the full contrib distro: routing
// connector context:log + condition, transform strip, body-fold so tenx_hash
// survives marshaler:body. Requires the FULL otelcol-contrib distro.)
// ---------------------------------------------------------------------------
function recipeOtelCollector(p: OffloadParams): OffloadRecipe {
  const prefix = p.prefix ?? DEFAULT_PREFIX;
  return {
    language: 'yaml',
    body: `connectors:
  routing:
    default_pipelines: [logs/siem]      # pass/compact/sample fall through here
    table:
      # context: log is REQUIRED — routeState is a LOG attribute. The default
      # resource context never matches it (every event falls through to default).
      - context: log
        condition: attributes["routeState"] == "offload"
        pipelines: [logs/offload]
      - context: log
        condition: attributes["routeState"] == "tier_down"
        pipelines: [logs/tier_down]
      - context: log
        condition: attributes["routeState"] == "drop"
        pipelines: [logs/drop]

processors:
  transform/offload:
    error_mode: ignore
    log_statements:
      - delete_key(log.attributes, "routeState") # marker did its job; tenx_hash kept
      - set(log.body, log.attributes)            # fold attrs into the body so tenx_hash
                                                  # survives marshaler:body (it is a LOG
                                                  # attribute; body-only would drop it)
  transform/strip:
    error_mode: ignore
    log_statements:
      - delete_key(log.attributes, "routeState") # SIEM / tier_down path: drop the marker

exporters:
  awss3:
    s3uploader:
      region: ${p.region}
      s3_bucket: ${p.bucket}
      s3_prefix: ${prefix}
    marshaler: body                              # writes the folded flat-JSON body as JSONL
  # PLACEHOLDER: your cheaper in-platform tier exporter (destination-specific),
  # e.g. awscloudwatchlogs pointed at an Infrequent-Access log group, or a
  # datadog exporter tagged to a Flex index. See cloudwatchIaRecipe() /
  # datadogFlexRecipe() / azureLogsTierRecipe() for the destination-side TF
  # (Azure Basic/Auxiliary needs Fluent Bit or Logstash, not the OTel Collector).
  # <your_cheap_tier_exporter>: {}
  nop: {}                                        # drop sink: discards the noise slice

service:
  pipelines:
    logs/in:        { receivers: [otlp], exporters: [routing] }
    logs/offload:   { receivers: [routing], processors: [transform/offload], exporters: [awss3] }
    # tier_down -> swap exporters:[nop] for your cheap-tier exporter above.
    logs/tier_down: { receivers: [routing], processors: [transform/strip], exporters: [nop] }
    logs/drop:      { receivers: [routing], exporters: [nop] }   # SUPPRESSED (no SIEM, no S3)
    logs/siem:      { receivers: [routing], processors: [transform/strip], exporters: [<your_siem_exporter>] }`,
    placementNote:
      'the routing connector reads 10x\'s OTLP return path, where 10x\'s fields ' +
      'arrive as LOG attributes (body carries the message). `offload` strips the ' +
      'marker and folds attributes into the body so tenx_hash survives ' +
      '`marshaler: body`; `tier_down` strips the marker and exports to your ' +
      'cheap-tier exporter; `drop` routes to the `nop` exporter (suppressed); and ' +
      'pass/compact/sample fall through to the default SIEM pipeline.',
    prerequisites: [
      ...basePrereqs(p),
      'Distribution: requires the FULL otelcol-contrib distro (routingconnector + transformprocessor + awss3exporter). A minimal/custom "contrib" build can omit them — verified: a stripped otelcol-contrib had connectors:[] and no transform/awss3.',
      'Routing MUST use `context: log` + `condition` (verified live). `statement: route() where ...` defaults to RESOURCE context and never matches the log attribute, so every event falls through to the SIEM.',
      'tenx_hash is a LOG attribute; `marshaler: body` alone drops it, so the offload pipeline folds attributes into the body (`set(log.body, log.attributes)`). VERIFIED live against MinIO S3: the object is flat JSONL `{"...":...,"tenx_hash":"..."}` with routeState removed (the awss3 body marshaler serializes the kvlist body to a flat JSON object).',
      'Object layout: the awss3 exporter TIME-PARTITIONS the key under the prefix (e.g. `app/year=2026/month=06/day=01/...`), so the Retriever S3->SQS notification must fire recursively under `app/` (it does). Set `s3uploader.s3_partition_format` to flatten the layout if a specific key shape is required.',
    ],
  };
}

// ---------------------------------------------------------------------------
// logstash  (research shape: if/else in the OUTPUT block + s3 output)
// ---------------------------------------------------------------------------
function recipeLogstash(p: OffloadParams): OffloadRecipe {
  const prefix = p.prefix ?? DEFAULT_PREFIX;
  return {
    language: 'ruby',
    body: `# Route + strip run in filter {} — mutate is a filter plugin and is NOT
# valid inside output {}. The route decision is recorded in [@metadata]
# (logstash-internal, never serialized to a destination), so no routing
# field leaks into S3 or the SIEM. One branch per stamped action.
filter {
  if [routeState] == "offload" {            # string equality on the route-state name
    mutate { add_field => { "[@metadata][tenx_route]" => "offload" } }
  } else if [routeState] == "tier_down" {
    mutate { add_field => { "[@metadata][tenx_route]" => "tier_down" } }
  } else if [routeState] == "drop" {
    mutate { add_field => { "[@metadata][tenx_route]" => "drop" } }
  } else {
    # pass / compact / sample -> the SIEM.
    mutate { add_field => { "[@metadata][tenx_route]" => "siem" } }
  }
  # marker did its job; drop it (tenx_hash kept). Also drop [event][original]:
  # under ECS-compat v8 (Logstash 8.x default) the json codec stores the raw
  # source line there, which still contains "routeState" (verified leaking into
  # both sinks). Or set pipeline.ecs_compatibility: disabled on this pipeline.
  mutate { remove_field => ["routeState", "[event][original]"] }
}

output {
  if [@metadata][tenx_route] == "offload" {
    s3 {
      bucket => "${p.bucket}"
      region => "${p.region}"
      prefix => "${prefix}/"
      codec  => "json_lines"
    }
  } else if [@metadata][tenx_route] == "tier_down" {
    # PLACEHOLDER: your cheaper in-platform tier output (destination-specific),
    # e.g. a second cloudwatch_logs output pointed at an Infrequent-Access log
    # group, a datadog output tagged to a Flex index, or a microsoft-sentinel-logstash
    # output to an Azure Basic/Auxiliary table. See cloudwatchIaRecipe() /
    # datadogFlexRecipe() / azureLogsTierRecipe() for the destination-side TF.
    # <your_cheap_tier_output> { ... }
  } else if [@metadata][tenx_route] == "drop" {
    # SUPPRESSED: no output for the drop slice (the noise the engine shed).
    # The empty branch is the suppression — nothing is emitted here.
  } else {
    # pass / compact / sample -> your existing SIEM output. compact already
    # carries the engine's encoded bytes on the wire, so no special handling.
    # ... your existing SIEM output ...
  }
}`,
    placementNote:
      'the route + strip go in the `filter {}` block of the destinations pipeline ' +
      '(the one reading 10x\'s return path); `output {}` then branches on the ' +
      '`[@metadata]` flag: `offload` -> S3, `tier_down` -> your cheap-tier output, ' +
      '`drop` -> an empty (suppressed) branch, pass/compact/sample -> the SIEM. ' +
      '`@metadata` is never shipped, so the routing signal does not leak into S3 ' +
      'or the SIEM, and `routeState` is removed before either.',
    prerequisites: [
      ...basePrereqs(p),
      'Verified live (logstash 8.x): routing + strip + tenx_hash. Under ECS-compat v8 the json codec adds `[event][original]` holding the raw line (with routeState), so the strip removes it too — or set `pipeline.ecs_compatibility: disabled` on this pipeline.',
    ],
  };
}

// ---------------------------------------------------------------------------
// cribl  (research shape: routing table, first-class)
// ---------------------------------------------------------------------------
function recipeCribl(p: OffloadParams): OffloadRecipe {
  const prefix = p.prefix ?? DEFAULT_PREFIX;
  return {
    language: 'text',
    body: `Routing table (one route per action, evaluated top-down; each Final=Yes):

Route 1  "tenx-offload"
  Filter:      routeState == 'offload'
  Output:      tenx_offload_s3   (S3 destination, below)
  Final:       Yes               (stop; do not also send to the SIEM)

Route 2  "tenx-tier-down"
  Filter:      routeState == 'tier_down'
  Output:      <your CHEAP-TIER destination>   (destination-specific PLACEHOLDER:
               a Datadog Flex index / CloudWatch IA log group / ES frozen tier;
               see datadogFlexRecipe() / cloudwatchIaRecipe() / azureLogsTierRecipe() for the TF)
  Final:       Yes

Route 3  "tenx-drop"
  Filter:      routeState == 'drop'
  Output:      devnull           (Cribl's built-in null destination — SUPPRESSED)
  Final:       Yes

Route 4  "siem" (catch-all: pass / compact / sample)
  Filter:      true
  Output:      <your existing SIEM destination>

S3 destination "tenx_offload_s3":
  Bucket:          ${p.bucket}
  Region:          ${p.region}
  Key prefix:      ${prefix}/
  Format:          JSON (newline-delimited)
  Compression:     none

Strip the marker (all kept destinations):
  Pipeline "tenx_strip_routestate"  ->  one Eval function  ->  Remove fields: routeState
  Attach it as the Post-Processing Pipeline on tenx_offload_s3, the cheap-tier
  destination, AND the SIEM destination. (Cribl S3/SIEM destinations have no
  native field-exclude, so the strip is a destination-attached pipeline, after
  the route. tenx_hash kept.)`,
    placementNote:
      'order the per-action routes above the SIEM catch-all, each with Final=Yes so ' +
      'each slice is pulled out before the next route: `offload` -> S3, `tier_down` ' +
      '-> your cheap-tier destination, `drop` -> devnull (suppressed), and the ' +
      'catch-all carries pass/compact/sample to the SIEM. The routes must still see ' +
      '`routeState`, so the strip is a Post-Processing Pipeline on each destination ' +
      '(after routing). Cribl S3 destinations are batch (staging dir then flush), so ' +
      'objects appear on the flush interval, not per event.',
    prerequisites: [
      ...basePrereqs(p),
      'Logic verified live via `cribl pipe` (Cribl 4.x real expression engine): a Route filter `routeState == \'offload\'` matched the marker, the Eval "Remove fields" dropped routeState on the outputs, tenx_hash kept. This recipe ships as prose, not paste-ready config — build it in the Cribl UI/API. A full single-mode daemon run additionally needs an event-breaker ruleset + a file-monitor source scoped to your input.',
    ],
  };
}

const RECIPE_GENERATORS: Record<OffloadForwarderId, (p: OffloadParams) => OffloadRecipe> = {
  vector: recipeVector,
  fluentd: recipeFluentd,
  'fluent-bit': recipeFluentBit,
  'otel-collector': recipeOtelCollector,
  logstash: recipeLogstash,
  cribl: recipeCribl,
};

/** Return the two-route offload recipe for the given forwarder. */
export function offloadRecipe(forwarder: OffloadForwarderId, params: OffloadParams): OffloadRecipe {
  return RECIPE_GENERATORS[forwarder](params);
}

// ---------------------------------------------------------------------------
// Forwarder-write IAM  (the one AWS-side gap: the forwarder must PutObject to
// the Retriever bucket. The Retriever's own role only READS the source bucket.)
// ---------------------------------------------------------------------------
export interface ForwarderWriteIam {
  /** The least-privilege IAM policy document (PutObject to the offload prefix). */
  policyJson: string;
  /** How to attach it: EKS IRSA vs static creds. */
  attachmentNote: string;
}

export function forwarderWriteIamPolicy(params: OffloadParams): ForwarderWriteIam {
  const prefix = params.prefix ?? DEFAULT_PREFIX;
  const resource = `arn:aws:s3:::${params.bucket}/${prefix}/*`;
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'TenxForwarderOffloadWrite',
        Effect: 'Allow',
        Action: ['s3:PutObject'],
        Resource: resource,
      },
    ],
  };
  return {
    policyJson: JSON.stringify(policy, null, 2),
    attachmentNote:
      'EKS: attach this policy to a role, annotate the forwarder ServiceAccount ' +
      'with `eks.amazonaws.com/role-arn` (IRSA). Non-EKS: attach to the instance ' +
      'profile or supply scoped access keys to the forwarder\'s S3 output. This ' +
      'is the forwarder WRITE grant — the Retriever\'s own role only READS the ' +
      'source bucket, so this is a separate, additive permission.',
  };
}

/**
 * Ready-to-apply Terraform module for the forwarder-write IAM: a role + the
 * scoped PutObject policy + the EKS IRSA OIDC trust (assume-role bound to one
 * ServiceAccount). Non-EKS attachment is noted at the bottom. The grant is
 * additive — the Retriever's own role only reads the bucket. IRSA trust
 * pattern verified against the AWS EKS docs.
 */
export function forwarderWriteTerraform(): string {
  return `# Forwarder-write IAM for the offload loop. The forwarder PutObjects the
# routeState=="drop" slice to the Retriever input bucket; the Retriever's own role only
# READS it, so this is a SEPARATE, additive grant.

variable "bucket" {
  type        = string
  description = "Retriever input bucket. Objects land at <bucket>/<prefix>/..."
}
variable "prefix" {
  type        = string
  default     = "app"
  description = "Key prefix == Retriever target. PutObject is scoped to <bucket>/<prefix>/*."
}
variable "oidc_provider_arn" {
  type        = string
  description = "Cluster IAM OIDC provider ARN (arn:aws:iam::<acct>:oidc-provider/oidc.eks.<region>.amazonaws.com/id/<id>)."
}
variable "namespace"       { type = string }   # forwarder ServiceAccount namespace
variable "service_account" { type = string }   # forwarder ServiceAccount name
variable "name_prefix" {
  type    = string
  default = "tenx-forwarder-offload"
}

locals {
  # IRSA conditions key on the issuer URL (no scheme): the part after oidc-provider/.
  oidc_issuer = split("oidc-provider/", var.oidc_provider_arn)[1]
}

# PutObject scoped to <bucket>/<prefix>/*
data "aws_iam_policy_document" "write" {
  statement {
    sid       = "TenxForwarderOffloadWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::\${var.bucket}/\${var.prefix}/*"]
  }
}

resource "aws_iam_policy" "write" {
  name   = "\${var.name_prefix}-write"
  policy = data.aws_iam_policy_document.write.json
}

# IRSA trust: OIDC-federated assume-role pinned to ONE ServiceAccount.
data "aws_iam_policy_document" "trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "\${local.oidc_issuer}:sub"
      values   = ["system:serviceaccount:\${var.namespace}:\${var.service_account}"]
    }
    condition {
      test     = "StringEquals"
      variable = "\${local.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "forwarder_offload" {
  name               = var.name_prefix
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

resource "aws_iam_role_policy_attachment" "write" {
  role       = aws_iam_role.forwarder_offload.name
  policy_arn = aws_iam_policy.write.arn
}

# Annotate the forwarder ServiceAccount: eks.amazonaws.com/role-arn = <this arn>
output "forwarder_offload_role_arn" {
  value = aws_iam_role.forwarder_offload.arn
}

# Non-EKS: reuse aws_iam_policy.write unchanged; only the identity differs.
#   EC2/self-managed:  attach it to the node instance-profile role.
#   on-prem/outside AWS: attach it to an aws_iam_user + aws_iam_access_key,
#                        feed the key into the forwarder's S3 output creds.`;
}

// ---------------------------------------------------------------------------
// SIEM tier_down recipes  (down-tier in place, keyed on the SAME routeState
// marker — no second attribute needed for a binary premium/cheap split).
// ---------------------------------------------------------------------------
export interface SiemTierRecipe {
  /** 'datadog-flex' | 'cloudwatch-ia' | 'azure-basic' | 'azure-auxiliary' */
  target: string;
  language: 'hcl' | 'text';
  body: string;
  note: string;
}

/** Datadog: route `@routeState:drop` to a Flex-only index (cheaper queryable
 * tier) instead of the premium Standard index. In-platform Terraform. */
export function datadogFlexRecipe(opts: { flexRetentionDays?: number } = {}): SiemTierRecipe {
  const flex = opts.flexRetentionDays ?? 30;
  return {
    target: 'datadog-flex',
    language: 'hcl',
    body: `terraform {
  required_providers {
    datadog = {
      source  = "DataDog/datadog"
      version = ">= 4.6.0"   # flex_retention_days added in 3.45.0; 4.6.0 fixes flex=0 ignore
    }
  }
}

resource "datadog_logs_index" "tenx_offload_flex" {
  name = "tenx-offload"

  filter {
    query = "@routeState:drop"   # the slice 10x marked as low-value
    # D1d end state: @routeState:tier_down once the engine stamps tier_down
  }

  # retention waterfall: 0 days Standard, then ${flex} days TOTAL (= ${flex} in Flex).
  retention_days      = 0
  flex_retention_days = ${flex}
}

# REQUIRED: log indexes are FIRST-MATCH-WINS. The dropped slice only lands in
# this Flex index if it is ordered BEFORE the existing catch-all index.
resource "datadog_logs_index_order" "tenx_offload_order" {
  name    = "tenx-offload-order"
  indexes = [
    datadog_logs_index.tenx_offload_flex.id,   # must precede the broad index
    # "<your existing catch-all index name>",  # then the existing index(es)
  ]
}`,
    note:
      'Cuts the dominant Datadog INDEX cost (not ingest; the $0.10/GB ingest ' +
      'meter is unchanged) while the slice stays queryable in the same Log ' +
      'Explorer with no rehydration. Schema verified against the live provider: ' +
      'retention waterfall `retention_days=0` + `flex_retention_days` (a TOTAL, ' +
      'Standard+Flex), provider `>= 4.6.0`. The `datadog_logs_index_order` ' +
      'companion is REQUIRED: indexes are first-match-wins, so without ordering ' +
      'the Flex index ahead of the catch-all the events never reach it. ' +
      'Enablement caveats: Flex Logs must be turned on for the account first ' +
      '(pick a Compute size on the Flex Logs page) or apply is rejected; some ' +
      'accounts cannot create a new index via API (retarget retention on an ' +
      'existing index instead). Datadog markets Flex itself; the 10x value is the ' +
      'per-pattern decision (which `pattern_hash` is safe to down-tier), not the route.',
  };
}

/** CloudWatch: route `routeState == "drop"` to an Infrequent-Access log group
 * (~50% cheaper ingest, still Logs-Insights queryable). The split is
 * forwarder-side (events go to a different log group); this is the TF for the
 * IA group. */
export function cloudwatchIaRecipe(opts: { logGroupName?: string } = {}): SiemTierRecipe {
  const name = opts.logGroupName ?? '/tenx/offload';
  return {
    target: 'cloudwatch-ia',
    language: 'hcl',
    body: `resource "aws_cloudwatch_log_group" "tenx_offload_ia" {
  name            = "${name}"
  log_group_class = "INFREQUENT_ACCESS"   # ~50% cheaper ingest, still Insights-queryable
}

# Forwarder side: split on routeState == "drop" today (== "tier_down" after
# D1d): send the marked events to "${name}",
# everything else to your Standard log group.`,
    note:
      'IA is a create-time-only, immutable log-group property; AWS ships no ' +
      'auto-router, so the stamped forwarder log-group split is the missing ' +
      'automation (10x is not redundant here). HARDENING: a stamp-miss routes to ' +
      'the Standard fallback and bills at full rate, so the recipe should fail ' +
      'toward the IA group on the offload path only when `routeState` is present.',
  };
}

/** Azure Monitor: route the tier_down slice to a Log Analytics table on the
 * Basic (default) or Auxiliary plan. Like CloudWatch IA, the table PLAN is
 * fixed at creation (via a Data Collection Rule), so the split is
 * forwarder-side: marked events go to a different DCR stream / table. This is
 * the provisioning for the cheaper-plan table + DCR. */
export function azureLogsTierRecipe(
  opts: { plan?: 'Basic' | 'Auxiliary'; tableName?: string } = {}
): SiemTierRecipe {
  const plan = opts.plan ?? 'Basic';
  const table = opts.tableName ?? 'Tenx_Offload_CL';
  const cheaperNote =
    plan === 'Basic'
      ? '~78% cheaper ingest than the Analytics plan ($0.50 vs $2.30/GB), still KQL-queryable'
      : '~98% cheaper ingest than the Analytics plan ($0.05 vs $2.30/GB), archive-oriented with limited query';
  return {
    target: plan === 'Basic' ? 'azure-basic' : 'azure-auxiliary',
    language: 'text',
    body: `# Create the cheaper-plan custom table (${plan}) in the Log Analytics workspace.
# The table PLAN is set at creation and drives the price; ingestion reaches it
# through a Data Collection Endpoint (DCE) + Data Collection Rule (DCR).
az monitor log-analytics workspace table create \\
  --resource-group "<rg>" --workspace-name "<workspace>" \\
  --name "${table}" --plan ${plan} \\
  --columns TimeGenerated=datetime routeState=string text=string

# The DCE + DCR (stream -> ${table}) are the ingestion path. Basic/Auxiliary plans
# accept data ONLY via the DCR Logs Ingestion API, so the forwarder output must be
# one that targets a DCR: Fluent Bit 'azure_logs_ingestion' (AZURE_DCE_URL /
# AZURE_DCR_ID / AZURE_STREAM_NAME) or the Logstash Microsoft Sentinel output. The
# legacy Data Collector API sinks (Vector 'azure_monitor_logs', Fluentd
# 'azure-loganalytics') write Analytics-only *_CL tables and CANNOT reach a
# Basic/Auxiliary plan. Provision the DCE/DCR with: az monitor data-collection
# endpoint create; az monitor data-collection rule create.

# Naming contract (both sides): the DCR streamDeclarations key is Custom-${table}
# (WITH the prefix); the forwarder's table_name is the BARE table name (${table}).
# The azure_logs_ingestion plugin derives the Custom-<table> stream itself, so a
# Custom- prefix on the table_name OR a bare key in the DCR both yield 400 InvalidStream.
#
# Forwarder side: split on routeState == "tier_down" -> send the marked events to
# the ${plan}-plan table, everything else to your Analytics table. The forwarder
# must EMIT routeState in the record payload (add it to the output's field list)
# for the split filter to match; without it the split silently no-ops and all
# traffic bills at the Analytics rate.`,
    note:
      `Routes the down-tiered slice to a ${plan}-plan Log Analytics table (${cheaperNote}). ` +
      'The plan is a create-time table property set via the DCR, so like CloudWatch IA there ' +
      'is no in-platform auto-router: the stamped forwarder split is the missing automation. ' +
      'FORWARDER: the DCR path needs Fluent Bit azure_logs_ingestion (or Logstash Sentinel); the ' +
      'legacy Data Collector API sinks (Vector/Fluentd) write Analytics-only _CL tables and cannot ' +
      'reach this plan. CAVEAT: Basic/Auxiliary bill a per-GB QUERY fee (and are queried via the Log ' +
      'Analytics /search API, not the standard /query API), so the win is ingest-side; heavy querying ' +
      'of the down-tiered table erodes it. HARDENING: route to the ' +
      `${plan} table only when routeState is present; a stamp-miss falls back to the Analytics ` +
      'table and bills at the full Analytics rate (never silently down-tier un-vetted events), so ' +
      'monitor Analytics-table ingest to catch stamp gaps.',
  };
}

// ---------------------------------------------------------------------------
// Coralogix  (tier_down without a second sink)
//
// Coralogix differs structurally from Datadog Flex and CloudWatch IA: the
// down-tiered slice is NOT sent somewhere else. It goes to the SAME ingest
// endpoint, and a TCO policy moves it from High (Frequent Search) to Medium
// (Monitoring). So the forwarder's job here is to make the routing decision
// VISIBLE to policy evaluation, not to fan out to a second output.
//
// Two things follow, and they are the reason this recipe exists separately:
//
//  1. `routeState` must NOT be stripped. Every other recipe in this file drops
//     the marker once it has routed (see the module docstring). On Coralogix the
//     marker IS the signal the destination reads, so stripping it removes the
//     only thing a `dpxl_expression` policy can match. VERIFIED live on a US2
//     tenant: it arrives as a first-class body field, `filter $d.routeState ==
//     'tier_down'` and `groupby $d.routeState` both work server-side, and a
//     bogus keypath returns `keypath does not exist` while this one does not.
//
//  2. The decision cannot be derived at the destination AT ALL, whatever the
//     pipeline order. Do NOT justify this with "TCO evaluates before
//     enrichment" — that is false: Coralogix's own Pipeline Analyzer doc
//     orders it parsing rules, then enrichments, then TCO pipelines.
//     The order-independent argument is the real one, and it is stronger:
//     whether a pattern has passed its byte budget for the window is a fact
//     about a STREAM, counted in the sidecar across many events. A
//     destination-side rule reads one event at a time and cannot derive it no
//     matter when it runs. So the routing decision has to arrive stamped on
//     the event, and the shipper is the only thing that can stamp it.
//
// The lua ALSO mirrors routeState onto `subsystemName`. That is belt-and-braces,
// not redundancy: `dpxl_expression` (body-field match) needs Terraform provider
// >= 3.4.0, while `subsystems` matching works on every provider version and on
// the plain HTTP API. See coralogixMonitoringRecipe() for both policy forms.
// ---------------------------------------------------------------------------
export interface CoralogixTierParams {
  /** Coralogix ingest domain for the tenant's region, e.g. `cx498.coralogix.com` (US2). */
  domain: string;
  /** applicationName stamped on every shipped event. */
  applicationName?: string;
  /** subsystemName carrying the untouched premium slice. */
  passSubsystem?: string;
  /** subsystemName the tier_down slice is moved to (what a `subsystems` policy matches). */
  tierDownSubsystem?: string;
}

export function fluentBitCoralogixRecipe(
  p: OffloadParams & CoralogixTierParams,
): OffloadRecipe {
  const prefix = p.prefix ?? DEFAULT_PREFIX;
  const app = p.applicationName ?? 'tenx';
  const passSub = p.passSubsystem ?? 'app';
  const tierSub = p.tierDownSubsystem ?? 'tier_down';
  return {
    language: 'ini',
    body: `[SERVICE]
    Flush 1
    Grace 5                # let the re-emitted chunks flush before shutdown

# 1) Only the slices that LEAVE Coralogix get their own tag. tier_down is
#    deliberately NOT retagged: it ships to the same endpoint and is separated
#    by subsystemName + the routeState body field.
[FILTER]
    Name    lua
    Match   tenx.*
    call    tag_route
    code    function tag_route(tag,ts,rec) local r=rec["routeState"] if r=="offload" then rec["_route"]="offload" elseif r=="drop" then rec["_route"]="drop" else rec["_route"]="siem" end return 2,ts,rec end

[FILTER]
    Name    rewrite_tag
    Match   tenx.*
    Rule    $_route ^offload$ tenx.offload true
    Rule    $_route ^drop$    tenx.drop    true

# 2) keep the routed slices out of the Coralogix path. What remains on tenx.app
#    is pass/compact/sample AND tier_down.
[FILTER]
    Name    grep
    Match   tenx.app
    Regex   _route ^siem$

# 3) Build the /logs/v1/singles envelope. subsystemName is derived FROM
#    routeState, and routeState itself stays inside \`text\` (NOT stripped) so it
#    arrives as an addressable body field. Only \`_route\`, the internal routing
#    key, is removed.
#    \`text\` may be a nested object: verified live that Coralogix parses it
#    identically to a JSON string, so no JSON encoder is needed in lua.
[FILTER]
    Name    lua
    Match   tenx.app
    call    cx_singles
    code    function cx_singles(tag,ts,rec) local r=rec["routeState"] if r==nil then for k,v in pairs(rec) do if type(v)=="string" and string.find(v,'"routeState":"${tierSub}"',1,true) then r="${tierSub}" end end end rec["_route"]=nil local out={} out["applicationName"]="${app}" out["subsystemName"]=(r=="${tierSub}") and "${tierSub}" or "${passSub}" out["severity"]=3 out["text"]=rec return 2,ts,out end

# 4) Coralogix ingest. \`Format json\` emits ONE JSON ARRAY per flush, which is
#    exactly what /logs/v1/singles accepts. \`json_date_key false\` stops
#    fluent-bit adding a stray top-level date key beside the envelope fields.
[OUTPUT]
    Name       http
    Match      tenx.app
    Host       ingress.${p.domain}
    Port       443
    URI        /logs/v1/singles
    Format     json
    json_date_key false
    tls        On
    tls.verify On
    Header     Authorization Bearer \${CORALOGIX_SEND_KEY}

# 5) Strip the routing markers from the S3 slice ONLY.
#    \`Match tenx.offload\` is deliberately narrow: on the Coralogix path
#    (tenx.app) \`routeState\` MUST survive to the destination, because the TCO
#    policy matches it. Without this filter the offloaded objects carry
#    \`routeState\` and the internal \`_route\` key, so the archived shape differs
#    from every other recipe and the Retriever indexes two junk fields.
[FILTER]
    Name       record_modifier
    Match      tenx.offload
    Remove_key routeState
    Remove_key _route

# 6) offload slice -> customer-owned S3 as JSONL (same layout as the base recipe)
[OUTPUT]
    Name          s3
    Match         tenx.offload
    bucket        ${p.bucket}
    region        ${p.region}
    s3_key_format /${prefix}/$UUID.jsonl
    use_put_object On
    json_date_format iso8601

# 7) drop slice -> SUPPRESSED
[OUTPUT]
    Name   null
    Match  tenx.drop`,
    placementNote:
      'all FILTERs sit on the 10x return path (`Match tenx.*`). Unlike the other ' +
      'recipes this one does NOT strip `routeState`: on Coralogix the marker is ' +
      'what the destination reads. The reason is NOT pipeline order (Coralogix ' +
      'runs TCO after enrichment, not before) — it is that a byte-budget ' +
      'decision is a property of a STREAM counted in the sidecar, which no ' +
      'per-event destination rule can derive whenever it runs. `severity` is ' +
      'hardcoded to 3 (Info); map it from the event if the policy needs to ' +
      'discriminate on severity, and note that `dpxl_expression` and `severities` ' +
      'are mutually exclusive in one policy.',
    prerequisites: [
      ...basePrereqs(p),
      // CORRECTED AGAINST A LIVE RUN. The generic fluent-bit recipe carries the
      // opposite instruction ("must emit JSON"), and following it here breaks
      // this recipe SILENTLY: under `json` the engine ships the whole rendered
      // record as ONE msgpack string field named after the encode expression
      // (`fullText_of_tenx_hash_and_routeState`), so `rec["routeState"]` in the
      // lua is nil, every event is labelled with the pass subsystem, and
      // nothing is ever tiered. Observed: 160/160 events landed in subsystem
      // `app` with HTTP 200 throughout and no error anywhere.
      'Encoding: KEEP the shipped default `fluentbitOutputEncodeType: delimited`. Do NOT set it to `json` on this path — `json` collapses the record into a single string field and the lua can no longer read `routeState`, which mislabels every event with no error. (The lua below carries a substring fallback for this case, but delimited is the supported shape.)',
      'Set `CORALOGIX_SEND_KEY` in the forwarder environment to a Send-Your-Data key for the target team (NOT a user/management key).',
      'TCO policy changes are NOT instant despite the docs saying "changes take effect immediately". Measured on a live tenant: a freshly enabled policy did not affect routing ~60s after enabling, and did ~6min after. Allow several minutes before concluding a policy does not work.',
      'Do NOT add a `record_modifier` that removes `routeState` on this path: it is the field the TCO policy matches.',
      'The destination-side TCO policy is a SEPARATE apply — see coralogixMonitoringRecipe(). Without it every event stays in High (Frequent Search), which is the documented default when no policy matches.',
    ],
  };
}


/**
 * Elasticsearch frozen tier. VERIFIED END TO END on a live Elastic Cloud Hosted
 * deployment (v9.4.4, enterprise licence) on 2026-07-31, and this emits the
 * artifacts that run actually used, not an idealised version of them.
 *
 * What was observed:
 *   partial-tenx-tierdown-000001  400 docs  store=0b      node roles=f (frozen)
 *   tenx-app-000001  (control)    200 docs  store=19.2kb  node roles=himrst (hot)
 * and, the reason the feature is worth shipping, IDENTITY SURVIVED the move:
 * a term query on `tenx_hash` returned 400/400 against the partially-mounted
 * index and `routeState` was still aggregatable.
 *
 * Why this shape and not a row-level rule: ILM is INDEX-level. That is a good
 * fit for a per-event marker, because the forwarder can put the marked slice in
 * its own index and the policy handles the rest. Contrast ClickHouse, where
 * `TTL ... TO VOLUME` is evaluated per PART and takes no WHERE clause, so the
 * same idea needs the routing key baked into the partition key.
 */
export function elasticFrozenTierRecipe(
  opts: { repository?: string; tierDownAlias?: string; keepAlias?: string; frozenMinAge?: string } = {}
): SiemTierRecipe {
  const repo = opts.repository ?? 'found-snapshots';
  const tdAlias = opts.tierDownAlias ?? 'tenx-tierdown';
  const keepAlias = opts.keepAlias ?? 'tenx-app';
  const minAge = opts.frozenMinAge ?? '7d';
  return {
    target: 'elasticsearch-frozen',
    language: 'text',
    body: `# 1) Policy for the tier_down slice: leave hot on rollover, then mount as a
#    PARTIALLY-MOUNTED searchable snapshot in the frozen tier.
PUT _ilm/policy/tenx-tier-down
{
  "policy": { "phases": {
    "hot":    { "min_age": "0ms", "actions": { "rollover": { "max_primary_shard_size": "50gb", "max_age": "1d" } } },
    "frozen": { "min_age": "${minAge}", "actions": { "searchable_snapshot": { "snapshot_repository": "${repo}" } } }
  }}
}

# 2) Policy for everything we keep. Same rollover, never leaves hot. This is the
#    control: without it you cannot tell "the slice moved" from "everything moved".
PUT _ilm/policy/tenx-keep
{
  "policy": { "phases": {
    "hot": { "min_age": "0ms", "actions": { "rollover": { "max_primary_shard_size": "50gb", "max_age": "30d" } } }
  }}
}

# 3) Templates. The marker decides WHICH INDEX an event lands in; the index
#    decides which policy governs it. tenx_hash and routeState are mapped as
#    keyword so both survive as queryable fields in frozen (verified).
PUT _index_template/tenx-tierdown-tpl
{
  "index_patterns": ["${tdAlias}-*"],
  "template": {
    "settings": {
      "index.lifecycle.name": "tenx-tier-down",
      "index.lifecycle.rollover_alias": "${tdAlias}",
      "number_of_replicas": 0
    },
    "mappings": { "properties": {
      "tenx_hash":  { "type": "keyword" },
      "routeState": { "type": "keyword" },
      "@timestamp": { "type": "date" }
    }}
  }
}

PUT _index_template/tenx-app-tpl
{
  "index_patterns": ["${keepAlias}-*"],
  "template": {
    "settings": {
      "index.lifecycle.name": "tenx-keep",
      "index.lifecycle.rollover_alias": "${keepAlias}",
      "number_of_replicas": 0
    },
    "mappings": { "properties": {
      "tenx_hash":  { "type": "keyword" },
      "routeState": { "type": "keyword" },
      "@timestamp": { "type": "date" }
    }}
  }
}

# 4) Bootstrap the write indices. Both policies use rollover, so each alias
#    needs an initial backing index flagged is_write_index. Skipping this is the
#    usual reason ILM sits in check-rollover-ready forever.
PUT ${tdAlias}-000001
{ "aliases": { "${tdAlias}": { "is_write_index": true } } }

PUT ${keepAlias}-000001
{ "aliases": { "${keepAlias}": { "is_write_index": true } } }

# 5) Verify, once data has rolled over and aged past min_age. The frozen index
#    is RENAMED with a partial- prefix, which is how you know it mounted:
#
#   GET _cat/indices/*${tdAlias}*?h=index,docs.count,store.size
#     partial-${tdAlias}-000001   <docs>   0b     <- data now in ${repo}
#
#   GET ${tdAlias}-000001/_ilm/explain        -> phase: frozen, step: complete
#   POST partial-${tdAlias}-000001/_search
#     { "query": { "term": { "tenx_hash": "<a hash you indexed>" } } }
#   ...must still return the documents. If it does not, STOP: the slice is
#   cheap but unretrievable and the down-tier is not worth doing.`,
    note:
      'Elasticsearch tiering is INDEX-level, so the shipper routes the marked ' +
      'slice to its own index and ILM does the rest. Verified live: the frozen ' +
      'index reported store=0b locally while the hot control stayed at 19.2kb, ' +
      'and a term query on `tenx_hash` still returned 400/400 with `routeState` ' +
      'aggregatable, so the down-tiered slice remains retrievable by stamped ' +
      'identity. ' +
      'PREREQUISITE: searchable snapshots need an Enterprise licence self-managed, ' +
      'or Gold and above on Elastic Cloud Hosted, plus a registered snapshot ' +
      'repository (Elastic Cloud provides `found-snapshots` by default). ' +
      'ON ELASTIC CLOUD HOSTED THE SAVING IS NOT AUTOMATIC: Hosted is priced by ' +
      'provisioned resources, so moving data out of hot creates headroom and the ' +
      'deployment must then be RESIZED to bank it. Do not tell a Hosted customer ' +
      'their bill drops on its own; tell them their hot tier can shrink. ' +
      'Self-managed differs: the saving is disk you stop buying. ' +
      'OPERATIONAL NOTE: ILM polls every 10 minutes by default ' +
      '(`indices.lifecycle.poll_interval`), so a transition will not be visible ' +
      'immediately after rollover; that is not a failure.',
  };
}

/** Coralogix: move the `tier_down` slice from High (Frequent Search) to Medium
 * (Monitoring). Two policy forms, because which one is available depends on the
 * provider version. */
export function coralogixMonitoringRecipe(
  opts: { tierDownSubsystem?: string } = {},
): SiemTierRecipe {
  const sub = opts.tierDownSubsystem ?? 'tier_down';
  return {
    target: 'coralogix-monitoring',
    language: 'hcl',
    body: `terraform {
  required_providers {
    coralogix = {
      source  = "coralogix/coralogix"
      version = "~> 3.4"   # dpxl_expression added in provider 3.4.0
    }
  }
}

provider "coralogix" {
  # env     = "US2"   # or CORALOGIX_ENV
  # api_key = "..."   # or CORALOGIX_API_KEY (needs LOGS.TCO:UPDATEPOLICIES)
}

# ONE resource holds the ORDERED policy list; first match wins, so the 10x entry
# must precede any broader catch-all already in the list.
resource "coralogix_tco_policies_logs" "tenx" {
  policies = [
    # FORM A — match the routeState body field directly (provider >= 3.4.0).
    # The engine's marker drives tier selection with no label mapping at all.
    # The \`<v1>\` version prefix is REQUIRED.
    #
    # EXCLUSIVITY IS WIDER THAN THE PROVIDER DOCS SAY. They call
    # \`dpxl_expression\` mutually exclusive with \`severities\`. The server is
    # stricter: "Cannot have both rules (applicationRule, subsystemRule,
    # severities) and dpxlExpression". So a dpxl policy CANNOT also be scoped
    # to an application or subsystem — it is expression-only, evaluated across
    # everything. Scope it inside the expression instead, e.g.
    #   "<v1> $d.routeState == '${sub}' && $l.applicationname == 'checkout'"
    {
      name            = "10x tier_down -> Monitoring"
      priority        = "medium"   # medium == Monitoring
      dpxl_expression = "<v1> $d.routeState == '${sub}'"
    },

    # FORM B — match the subsystem the forwarder lua set from routeState.
    # Works on every provider version and on the plain HTTP API, which exposes
    # only application / subsystem / severity matchers. Use this if you are
    # pinned below 3.4.0, or keep it as a second entry for defence in depth.
    # {
    #   name       = "10x tier_down -> Monitoring (subsystem form)"
    #   priority   = "medium"
    #   severities = ["debug", "verbose", "info", "warning", "error", "critical"]
    #   subsystems = {
    #     rule_type = "is"
    #     names     = ["${sub}"]
    #   }
    # },

    # ... your existing policies follow, unchanged.
  ]
}`,
    note:
      'Medium (Monitoring) keeps the slice DataPrime-queryable with alerting and ' +
      'dashboarding, stored in the customer\'s own S3 — so this is a down-tier, ' +
      'not an archive, and there is no rehydration step. Data matching no policy ' +
      'stays in High (Frequent Search) by default. ' +
      'VERIFIED BY APPLY on a live US2 tenant (provider 3.8.0, CORALOGIX_ENV=US2): ' +
      'both forms create successfully and read back enabled at priority ' +
      'PRIORITY_TYPE_MEDIUM. Form A is verified to FIRE, not merely to create: ' +
      'two events in one request, same application and both on the pass ' +
      'subsystem so no subsystem rule could match, differing only in ' +
      '`$d.routeState` — the `pass` one stayed in Frequent Search at ' +
      'priorityclass=high, the `tier_down` one was removed. ' +
      'Still UNVERIFIED: that the TCO usage report actually BILLS a matching ' +
      'event at the Medium rate (that data lags and was not checked), and ' +
      'reading the slice back out of Monitoring. ' +
      'IF YOU ARE DRIVING THIS BY RAW HTTP RATHER THAN TERRAFORM, do not follow ' +
      'the published TCO REST docs; see coralogixTcoApiContract().',
  };
}

/**
 * The TCO policy HTTP contract as the product actually implements it, recovered
 * by running the Terraform provider under TF_LOG=DEBUG and replaying its
 * requests with curl until they succeeded standalone.
 *
 * This exists because the published REST documentation is wrong in five
 * independently reproducible ways, and a reader following it cannot succeed.
 */
export function coralogixTcoApiContract(): SiemTierRecipe {
  return {
    target: 'coralogix-tco-api',
    language: 'text',
    body: `WRITE — atomic overwrite of the ENTIRE policy list (not create-one):

  PUT https://api.<region>.coralogix.com/mgmt/openapi/5/dataplans/log-policies/v1
  Authorization: Bearer <user key with LOGS.TCO:UPDATEPOLICIES>
  Content-Type: application/json

  {"policies":[
    {"policy":{"name":"10x tier_down -> Monitoring","priority":"PRIORITY_TYPE_MEDIUM","disabled":false,
               "subsystemRule":{"name":"tier_down","ruleTypeId":"RULE_TYPE_ID_IS"}},
     "logRules":{"severities":["SEVERITY_INFO"]}}
  ]}

READ:

  GET https://api.<region>.coralogix.com/mgmt/openapi/5/dataplans/policies/v1?source_type=SOURCE_TYPE_LOGS

Note the HOST: the regional host (e.g. api.us2.coralogix.com), NOT the
per-team host (api.<team>.coralogix.com) the ingest and query APIs use.

WHERE THE PUBLISHED DOCS ARE WRONG (each reproduced independently):

  1. The documented example cannot ever succeed. It violates two rules at once.
  2. On the RULE-MATCHER form, \`severities\` is required and must be NON-EMPTY.
     Omitted -> 400. Empty array -> 500 "failed to create policy". The docs show
     it empty, which cannot work. This does NOT apply to a \`dpxlExpression\`
     policy: that form excludes severities AND rules, and reads back with
     \`"severities": []\` — so stated unconditionally, this item would make the
     dpxl policy in coralogixMonitoringRecipe() impossible to create.
  3. \`applicationName\` must be absent or COMPLETE. An empty object -> 400.
     The docs show an empty object.
  4. The documented write endpoint is not the one the product uses. Docs say
     POST /api/v1/external/tco/policies (create-one); the provider and UI use
     the PUT whole-list overwrite above. Different verb, path, host, semantics.
  5. \`dpxlExpression\` does not exist on the documented REST API, and the
     legacy GET cannot represent it: a dpxl policy read back through
     GET /api/v1/external/tco/policies shows NO matching criteria at all, so a
     reader of the documented API concludes it matches everything.

The documented POST does work, but only in a shape the docs never show:
\`severities\` as a non-empty array of integers 1-6
(debug/verbose/info/warning/error/critical) plus a well-formed or absent
\`applicationName\`.`,
    note:
      'Recovered from the wire, not from documentation. Use the Terraform ' +
      'resource in coralogixMonitoringRecipe() by preference; this contract is ' +
      'for callers that cannot run Terraform, and as the evidence base when a ' +
      'customer reports that the documented TCO API rejects their request.',
  };
}

/** Forwarders besides the detected one, stable order, for the "also supports"
 * hint. */
export function otherOffloadForwarders(detected: OffloadForwarderId): OffloadForwarderId[] {
  return OFFLOAD_FORWARDERS.filter(f => f !== detected);
}

// ---------------------------------------------------------------------------
// Rendering — assemble the full offload section for the retriever advisor.
// ---------------------------------------------------------------------------

/** Forwarders whose recipe shape is verified against the engine contract +
 * the forwarder's own docs (no runtime smoke-test caveat). */
export const VERIFIED_OFFLOAD_FORWARDERS: OffloadForwarderId[] = ['vector', 'fluentd'];

function renderRecipeBlock(fwd: OffloadForwarderId, p: OffloadParams): string[] {
  const r = offloadRecipe(fwd, p);
  const lines = [
    `**${fwd} offload recipe**`,
    '',
    '```' + r.language,
    r.body,
    '```',
    ``,
    `_Placement: ${r.placementNote}_`,
    ``,
    `Prerequisites:`,
    ...r.prerequisites.map(pr => `- ${pr}`),
  ];
  return lines;
}

/**
 * Build the "Forwarder offload" markdown section for the retriever plan.
 * Pass the detected forwarder (or null to show the two verified leads).
 * Always renders the loop framing, the forwarder-write IAM grant, the SIEM
 * down-tier alternatives, and the fetch-back pointer.
 */
export function renderOffloadSection(
  params: OffloadParams,
  forwarder: OffloadForwarderId | null,
  rawDestination?: string
): string {
  // `destination` arrives as free-form text from advise_retriever, so an agent
  // passing "Coralogix" or " coralogix " would miss an exact-match gate and get
  // the GENERIC recipe, which strips `routeState` and silently disables
  // tiering. Normalise once, here, so every gate below compares canonical ids.
  const destination = rawDestination
    ? (() => {
        const d = rawDestination.trim().toLowerCase().replace(/[\s_]+/g, '-');
        const aliases: Record<string, string> = {
          cx: 'coralogix',
          'elastic-cloud-serverless': 'elastic-serverless',
          'elasticsearch-serverless': 'elastic-serverless',
          dd: 'datadog',
          cw: 'cloudwatch',
          es: 'elasticsearch',
          opensearch: 'elasticsearch',
          ch: 'clickhouse',
          azure: 'azure-monitor',
          'azure-monitor-logs': 'azure-monitor',
          gcp: 'gcp-logging',
          stackdriver: 'gcp-logging',
        };
        return aliases[d] ?? d;
      })()
    : undefined;
  const prefix = params.prefix ?? DEFAULT_PREFIX;
  const lines: string[] = [];

  lines.push(
    'Route the slice 10x marks low-value (`routeState == "drop"`) to the customer\'s ' +
      'own S3 before the SIEM bills it; the Retriever indexes that bucket and ' +
      'fetches it back by stamped identity. Nothing is deleted, it is relocated. ' +
      'This is lossless cost reduction, not archival.',
    '',
    `Target: \`s3://${params.bucket}/${prefix}/\` (region \`${params.region}\`), newline-delimited JSON.`,
    'Prerequisite on the engine side: run the receiver with `outputOffload true` ' +
      '(full-text events plus the `routeState` marker, every event flowing back).',
    ''
  );

  // Coralogix must NOT be shown the generic recipe. Every generic recipe strips
  // `routeState` on the output path, and on Coralogix that marker IS the routing
  // signal the TCO policy matches, so applying the generic artifact leaves the
  // operator with HTTP 200, no error, and nothing ever tiered. Substitute the
  // Coralogix shipper for the whole recipe block rather than appending a
  // warning after a config that already does the wrong thing.
  const coralogixShipper =
    destination === 'coralogix' &&
    getAllowedActionsForDestination('coralogix').includes('tier_down');

  if (coralogixShipper) {
    const cx = fluentBitCoralogixRecipe({ ...params, domain: '<team>.coralogix.com' });
    lines.push(
      '**Fluent Bit — Coralogix build.** This is NOT the generic recipe: it keeps ' +
        '`routeState` on the wire, because on Coralogix the marker is what the TCO ' +
        'policy matches. Do not substitute the generic fluent-bit recipe here.',
      '',
      '```ini',
      cx.body,
      '```',
      '',
      `Placement: ${cx.placementNote}`,
      '',
      'Prerequisites:',
      ...cx.prerequisites.map(p => `- ${p}`),
      '',
      'Replace `<team>.coralogix.com` with the tenant domain, and set ' +
        '`CORALOGIX_SEND_KEY` to a Send-Your-Data key.',
      ''
    );
    if (forwarder && forwarder !== 'fluent-bit') {
      lines.push(
        `Note: the detected forwarder is \`${forwarder}\`, but only the fluent-bit ` +
          'shipper has been verified end to end against a live Coralogix tenant. ' +
          'Porting it means preserving one property: `routeState` must reach the ' +
          'destination unstripped.',
        ''
      );
    }
  } else if (forwarder) {
    lines.push(...renderRecipeBlock(forwarder, params), '');
    const others = otherOffloadForwarders(forwarder);
    lines.push(`Other supported forwarders: ${others.join(', ')}.`, '');
  } else {
    lines.push(
      'No forwarder detected — showing the two verified leads. Pass the forwarder ' +
        'to get a single tailored recipe.',
      ''
    );
    for (const f of VERIFIED_OFFLOAD_FORWARDERS) {
      lines.push(...renderRecipeBlock(f, params), '');
    }
    lines.push(
      `Also supported (smoke-test first): ${OFFLOAD_FORWARDERS.filter(
        f => !VERIFIED_OFFLOAD_FORWARDERS.includes(f)
      ).join(', ')}.`,
      ''
    );
  }

  lines.push(
    '**Forwarder write access** (the one new IAM grant — the Retriever\'s own role only READS the source bucket). Ready-to-apply Terraform, EKS IRSA, non-EKS noted at the bottom:',
    '',
    '```hcl',
    forwarderWriteTerraform(),
    '```',
    ''
  );

  // Gate the SIEM down-tier sub-sections by DEFAULT_ACTION_BY_DESTINATION.
  // Datadog Flex is only relevant on `datadog`; CloudWatch Infrequent
  // Access only on `cloudwatch`. When the destination is unknown, fall
  // back to the historical behavior (show both leads) so callers that
  // do not yet thread destination keep working.
  const showDatadog = destination
    ? destination === 'datadog' && getAllowedActionsForDestination('datadog').includes('tier_down')
    : true;
  const showCloudWatch = destination
    ? destination === 'cloudwatch' && getAllowedActionsForDestination('cloudwatch').includes('tier_down')
    : true;
  const showAzure = destination
    ? destination === 'azure-monitor' && getAllowedActionsForDestination('azure-monitor').includes('tier_down')
    : true;

  // Coralogix is deliberately NOT part of the unknown-destination fallback.
  // Datadog/CloudWatch render as generic "here are the leads" when destination
  // is unset, which is harmless. The Coralogix path is different: it tells the
  // operator NOT to strip routeState, which is wrong advice on every other
  // destination. So it renders only on an explicit coralogix destination.
  const showCoralogix =
    destination === 'coralogix' &&
    getAllowedActionsForDestination('coralogix').includes('tier_down');

  // Self-hosted Elasticsearch and Elastic Cloud Hosted both reach the frozen
  // tier through ILM. Serverless is excluded on purpose: its retention is
  // already at roughly object-storage cost, so there is no premium to escape.
  const showElastic =
    destination === 'elasticsearch' &&
    getAllowedActionsForDestination('elasticsearch').includes('tier_down');

  if (showDatadog || showCloudWatch || showAzure || showCoralogix || showElastic) {
    lines.push(
      '**Or down-tier in the SIEM instead of offloading** (keep events in-platform at a cheaper tier, same `routeState` marker, no second attribute):',
      ''
    );
    if (showDatadog) {
      const ddog = datadogFlexRecipe();
      lines.push(
        `_Datadog Flex_ — ${ddog.note}`,
        '',
        '```hcl',
        ddog.body,
        '```',
        ''
      );
    }
    if (showCloudWatch) {
      const cw = cloudwatchIaRecipe();
      lines.push(
        `_CloudWatch Infrequent Access_ — ${cw.note}`,
        '',
        '```hcl',
        cw.body,
        '```',
        ''
      );
    }
    if (showAzure) {
      // Render a provisioning recipe per Azure plan: the default target (Basic)
      // plus each alternative carried in the cost model (tier_down_alt_tiers,
      // e.g. Auxiliary). The MCP picks one plan per deployment when it wires the
      // recipe; both are shown so the operator can choose Basic (queryable) or
      // Auxiliary (archive).
      const azModel = COST_MODEL_BY_DESTINATION['azure-monitor'];
      const azTiers = [
        azModel.tier_down_target_tier,
        ...(azModel.tier_down_alt_tiers ?? []),
      ].filter((t): t is NonNullable<typeof t> => Boolean(t));
      for (const tier of azTiers) {
        const plan: 'Basic' | 'Auxiliary' = /auxiliary/i.test(tier.name)
          ? 'Auxiliary'
          : 'Basic';
        const az = azureLogsTierRecipe({ plan });
        lines.push(
          `_${tier.name}_ ($${tier.ingest_rate_usd_per_gb}/GB ingest) — ${az.note}`,
          '',
          '```bash',
          az.body,
          '```',
          ''
        );
      }
    }
    if (showCoralogix) {
      const cx = coralogixMonitoringRecipe();
      lines.push(
        `_Coralogix Monitoring_ — ${cx.note}`,
        '',
        '```hcl',
        cx.body,
        '```',
        '',
        // The shipper half is load-bearing here in a way it is not for Flex or
        // IA, where the split is a second sink. On Coralogix the slice stays on
        // one endpoint and the marker IS the routing signal, so the forwarder
        // must be told not to strip it.
        'On Coralogix the down-tiered slice is NOT sent to a second sink: it ships to the ' +
          'same endpoint and the policy above moves it. That makes the forwarder half ' +
          'load-bearing — `routeState` must survive to the destination. A byte-budget ' +
          'decision is a property of a stream counted in the sidecar, so no ' +
          'per-event rule at the destination can derive it. The fluent-bit ' +
          'config rendered above is the Coralogix build and already keeps the ' +
          'marker; do not swap in a generic recipe, which strips it.',
        ''
      );
    }
    if (showElastic) {
      const el = elasticFrozenTierRecipe();
      lines.push(
        `_Elasticsearch frozen tier_ — ${el.note}`,
        '',
        '```text',
        el.body,
        '```',
        '',
        // Index-level, so unlike Flex/IA there is no second sink to stand up:
        // the shipper picks the index and the policy does the tiering.
        'Point the forwarder at the `tenx-tierdown` alias for events where ' +
          '`routeState == "tier_down"`, and at `tenx-app` for everything else. ' +
          'There is no separate cheap-tier endpoint to configure: on Elasticsearch ' +
          'the index IS the tier selector.',
        ''
      );
    }
  }

  lines.push(
    'Fetch back: `log10x_retriever_query` by pattern identity returns the offloaded events from S3.'
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Lambda + OTel-collector-extension estate (serverless; no cluster anywhere)
// ---------------------------------------------------------------------------

/**
 * Parameters for the serverless (Lambda + OTel collector extension) recipe.
 * The destination side stays Coralogix-shaped because that is the proven
 * estate; the collector parts are destination-agnostic.
 */
export interface LambdaExtensionParams {
  /** AWS region of the estate. */
  region: string;
  /** Offload bucket (customer-owned S3) for the `offload` slice. Optional —
   * without it the recipe emits the SIEM + drop routing only. */
  bucket?: string;
  /** Key prefix for offloaded objects. Default `app`. */
  prefix?: string;
  /** Coralogix ingest domain, e.g. `cx498.coralogix.com`. */
  domain?: string;
  /** applicationName stamped on shipped events. Default `tenx`. */
  applicationName?: string;
  /** ARN of the engine extension layer once published. Placeholder until then. */
  engineLayerArn?: string;
}

/** Multi-part recipe: each part is pasteable on its own. */
export interface ServerlessExtensionRecipe {
  /** Additions to the customer's existing collector-extension config. */
  collector: OffloadRecipe;
  /** The engine's environment + invocation, extension-side. */
  engine: OffloadRecipe;
  /** What declares the engine into the execution environment, and the
   * lifecycle contract the extension bootstrap must honor. */
  executionEnvironment: OffloadRecipe;
}

/**
 * The OTel-extension pairing for a 100%-Lambda estate: the customer's
 * collector extension keeps its receivers and its Coralogix exporter; two
 * loopback hops to the engine extension are spliced in between.
 *
 * Grounded in measurements (2026-08-08, local execution-environment lab —
 * see SERVERLESS_TASK1_LIFECYCLE_REPORT.md in the workspace root):
 *   - engine 1.1.57 native + otelcol paired over loopback inside one
 *     sandbox; 5,400/5,400 records round-tripped, zero dupes, with
 *     `tenx_hash` + `routeState` arriving as LOG-RECORD ATTRIBUTES
 *   - a 118 s cgroup freeze mid-burst lost nothing and duplicated nothing
 *   - the engine does NOT drain on bare SIGTERM (0/30,000 delivered when
 *     killed mid-burst) — the extension bootstrap owns the SHUTDOWN drain
 */
export function lambdaOtelExtensionRecipe(p: LambdaExtensionParams): ServerlessExtensionRecipe {
  const prefix = p.prefix ?? DEFAULT_PREFIX;
  const app = p.applicationName ?? 'tenx';
  const domain = p.domain ?? '<your-coralogix-domain>';
  const layerArn = p.engineLayerArn ?? '<tenx-receive-extension-layer-arn (unpublished — see prerequisites)>';

  const offloadBlock = p.bucket
    ? `
  # offload slice -> the customer's own S3 (same layout the Retriever indexes)
  awss3/tenx-offload:
    s3uploader:
      region: ${p.region}
      s3_bucket: ${p.bucket}
      s3_prefix: ${prefix}
    marshaler: body`
    : `
  # offload slice: supply a customer-owned bucket to enable S3 offload
  # awss3/tenx-offload: { s3uploader: { region: ${p.region}, s3_bucket: <bucket>, s3_prefix: ${prefix} }, marshaler: body }`;

  const offloadPipeline = p.bucket
    ? `    logs/tenx-offload:   { receivers: [routing/tenx], processors: [transform/tenx-fold], exporters: [awss3/tenx-offload] }`
    : `    # logs/tenx-offload: enable with the awss3 exporter above`;

  const collector: OffloadRecipe = {
    language: 'yaml',
    body: `# Merge these blocks into the collector-extension config the functions
# already run (OPENTELEMETRY_COLLECTOR_CONFIG_FILE / _URI). Existing
# receivers, processors, and the Coralogix exporter stay untouched.

receivers:
  # Return path from the engine extension (loopback, same sandbox).
  otlp/tenx:
    protocols:
      grpc:
        endpoint: 127.0.0.1:24225

exporters:
  # Hand-off to the engine extension (loopback, same sandbox).
  otlp/tenx:
    endpoint: 127.0.0.1:4317
    tls:
      insecure: true
    # MEASURED on real Lambda: the collector's eager first dial happens
    # before the engine listens (~3 s into INIT), and default exponential
    # retry intervals stretch across freeze until exports fail forever.
    # Tight bounded intervals keep every retry inside a thaw window.
    retry_on_failure:
      enabled: true
      initial_interval: 200ms
      max_interval: 1s
      max_elapsed_time: 0s
${offloadBlock}

connectors:
  routing/tenx:
    default_pipelines: [logs/tenx-siem]     # pass/compact/sample fall through
    table:
      # context: log is REQUIRED — routeState is a LOG attribute (measured on
      # the loopback pairing). The resource context never matches it.
      - context: log
        condition: attributes["routeState"] == "offload"
        pipelines: [logs/tenx-offload]
      - context: log
        condition: attributes["routeState"] == "drop"
        pipelines: [logs/tenx-drop]

processors:
  # Fold the record into a JSON-object body: {message, tenx_hash, routeState}.
  # This is for the OFFLOAD slice: awss3 uses "marshaler: body", so without
  # the fold the S3 objects carry the bare message and lose tenx_hash, which
  # is the key the Retriever indexes on.
  #
  # It is NOT what makes the TCO policy match. MEASURED on the live US2 tenant
  # (two records, one POST, identical but for routeState): the Coralogix OTLP
  # exporter nests every record under "logRecord", so the addressable keypaths
  # are $d.logRecord.attributes.* and $d.logRecord.body.*, and a flat
  # $d.routeState does not exist — it compiles to "keypath does not exist" and
  # the live flat-keypath policy left BOTH events at priorityclass=high,
  # tiering nothing. The Fluent Bit path is different and its flat
  # $d.routeState remains correct there; do not unify the two.
  transform/tenx-fold:
    error_mode: ignore
    log_statements:
      - set(log.cache["message"], log.body)
      - set(log.body, log.attributes)
      - set(log.body["message"], log.cache["message"])

exporters: {}  # (merge marker — your existing coralogix exporter is reused below)

service:
  pipelines:
    # Splice: whatever pipeline your receivers feed today now exports to the
    # engine instead of straight to Coralogix. Enrichment processors stay
    # HERE so they run exactly once, before the engine sees the event.
    # decouple LAST in both tenx pipelines is MANDATORY on Lambda: the
    # environment freezes the instant the handler returns, so without it
    # batches strand inside the collector (measured: a 30 s hang on the
    # next send, nothing exported). decouple ties forwarding to the
    # invocation lifecycle and flushes on SHUTDOWN.
    logs/to-tenx:
      receivers: [otlp]              # <- your existing receivers
      processors: [batch, decouple]  # <- your existing enrichment + batch
      exporters: [otlp/tenx]

    # Return path: engine-processed events fan out by routeState.
    logs/from-tenx:
      receivers: [otlp/tenx]
      processors: [decouple]
      exporters: [routing/tenx]

    logs/tenx-siem:      { receivers: [routing/tenx], processors: [transform/tenx-fold], exporters: [coralogix] }  # <- your existing exporter
${offloadPipeline}
    logs/tenx-drop:      { receivers: [routing/tenx], exporters: [nop] }   # SUPPRESSED`,
    placementNote:
      'two loopback hops inside each execution environment: collector -> engine ' +
      '(otlp/tenx exporter, :4317) and engine -> collector (otlp/tenx receiver, ' +
      ':24225), then a routing connector fans out on the routeState LOG attribute. ' +
      'The tier_down slice needs no collector branch on Coralogix: it ships to the ' +
      'same exporter and the destination-side TCO policy (dpxl on ' +
      '$d.logRecord.attributes.routeState, the NESTED keypath this path requires) ' +
      'moves it to the Monitoring tier — see coralogixMonitoringRecipe().',
    prerequisites: [
      `Engine pairing measured on the loopback (engine 1.1.57 native): records return with tenx_hash + routeState as log-record attributes; bodies byte-identical.`,
      'The routing connector, transform processor, and decouple processor require a collector build that includes them (otelcol-contrib and the community Lambda collector layer have them; a minimal custom build may not — check `components` output). decouple is not optional on Lambda — see the pipeline comments.',
      'THE POLICY KEYPATH IS NESTED ON THIS PATH, and it is not the one the Fluent Bit recipe uses. Verified live on the US2 tenant with a two-record single-POST control, identical but for routeState: the Coralogix OTLP exporter wraps each record under `logRecord`, so the policy expression must be `<v1> $d.logRecord.attributes.routeState == \'tier_down\'`. A flat `$d.routeState` compiles to "keypath does not exist" and tiers nothing — both control events stayed at priorityclass=high. `$d.logRecord.body.routeState` also resolves (the fold puts it there), so either nested keypath works; the flat one never does.',
      'transform/tenx-fold is for the OFFLOAD slice, not for the policy: awss3 uses `marshaler: body`, so without it the S3 objects lose tenx_hash, which is the Retriever\'s index key. Coralogix tiering works with or without it, on the nested keypath either way.',
      'TCO policy changes take ~6 minutes to apply (measured live) — do not conclude failure inside a minute.',
      `Coralogix exporter stays exactly as the customer runs it today (domain ${domain}, applicationName ${app} or their own).`,
    ],
  };

  const engine: OffloadRecipe = {
    language: 'text',
    body: `# Engine invocation (inside the extension, one process per execution environment):
tenx @run/input/forwarder/otel-collector @apps/receiver

# Function environment (Lambda env vars reach every extension process):
outputOffload=true                         # splice routeState onto every returned event (fullText path, never compacted)
symbolMessageHashField=tenx_hash           # stable pattern identity rides alongside
log10xMetricsEnabled=false                 # metric backend is BYO; hosted metrics stay off
TENX_AIRGAPPED=true                        # REQUIRED: no egress from the sandbox to log10x
TENX_LICENSE_FILE=/opt/tenx/license.jwt    # full (non-demo, non-limited) license baked into the layer
TENX_LOG_PATH=/tmp/tenx/                   # Lambda's fs is read-only outside /tmp; a /var/log
                                           # rollingFile failure poisons pipeline launch (measured).
                                           # Layers built by build-receive-layer.sh >= 1.1.63
                                           # already default this; the env var is belt-and-braces.
# optional BYO metrics:
# PROMETHEUS_REMOTE_WRITE_URL=https://<your-prometheus>/api/v1/write`,
    placementNote:
      'the engine listens on loopback :4317 (OTLP/gRPC in) and returns processed ' +
      'events to :24225. receiverReadOnly defaults to false, so writeback is on ' +
      'as soon as the forwarder module is included — no extra flag.',
    prerequisites: [
      'TENX_AIRGAPPED=true is mandatory, not optional: license validation is otherwise an online, fail-closed call on EVERY cold start (10 s connect timeout), and demo/limited licenses cannot run airgapped at all — a full license is a hard prerequisite for this estate. See SERVERLESS_TASK6_LICENSE_EGRESS.md.',
      'Engine memory: ~175 MB resident (measured, 1.1.57 native, post-traffic). Size the function memory for function + collector + engine.',
      'Cold start: engine spawn -> OTLP listener accepting measured at 1.4-1.9 s (native, 1 vCPU-equivalent, local x86 Docker). Real-Lambda numbers pending the one-shot confirmation run.',
    ],
  };

  const executionEnvironment: OffloadRecipe = {
    language: 'text',
    body: `# The engine enters the execution environment as its OWN Lambda extension:
#
#   Layer: ${layerArn}
#     /opt/extensions/tenx-receive        <- the run-lambda native bootstrap
#                                            (ReceiveExtension: placement-
#                                            dispatched, same binary as the
#                                            runtime bootstrap)
#     /opt/tenx/modules/...               <- modules tree
#     /opt/tenx/config/...                <- config tree
#     /opt/tenx/symbols/...               <- symbol library
#     /opt/tenx/license.jwt               <- full license, placed by the
#                                            deployer (never by the build)
#   Built by: engine packaging/lambda-layer/build-receive-layer.sh
#
# Lifecycle (implemented in ReceiveExtension, engine PR #120; each step
# proven against the Extensions API emulator):
#   1. POST /2020-01-01/extension/register   {"events":["INVOKE","SHUTDOWN"]}
#   2. launch the receive pipeline IN-PROCESS; hold the first event/next
#      poll until loopback :4317 accepts, so Lambda's INIT completes only
#      when the engine can receive
#   3. INVOKE -> no action (the engine runs continuously)
#      SHUTDOWN -> PipelineShutdownDrain.drainAll(deadlineMs budget), exit.
#      Measured: a SHUTDOWN two invocations deep derived a 1,747 ms budget
#      from its 2 s deadline and delivered 6,000/6,000.
#
# Freeze/thaw needs no handling: a 118 s cgroup freeze mid-burst delivered
# 5,000/5,000 after thaw with zero duplicates and clean timer resumption.`,
    placementNote:
      'one binary, two contracts, dispatched by placement: started from ' +
      '/opt/extensions/ it speaks the Extensions API loop above ' +
      '(ReceiveExtension); started as the function runtime bootstrap it ' +
      'long-polls the Runtime API (ROLE=receive handles CloudWatch ' +
      'subscription envelopes there — the remainder path).',
    prerequisites: [
      'The engine extension layer is NOT published yet. The bootstrap is implemented and lifecycle-proven (engine PR #120: ReceiveExtension + the CloudWatch-remainder receive handler; layer build script in packaging/lambda-layer/) — pending merge, release, and layer publish. No availability claims until then and until the one-shot real-Lambda confirmation has run.',
      'Architecture: build the layer for the estate architecture (x86_64 measured; arm64 needs its own native build).',
    ],
  };

  return { collector, engine, executionEnvironment };
}
