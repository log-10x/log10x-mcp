/**
 * Per-forwarder action-routing recipes for the Retriever cost loop.
 *
 * Sibling to `forwarder-snippets.ts`, but a different shape. Where the
 * drop-rule snippet emits a single SIEM-side exclude, these recipes are a
  * MULTI-way fan-out keyed on the engine-stamped `routeState` marker. The
  * receiver stamps a PER-SERVICE action (drop | offload | tier_down |
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
  * Engine contract:
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
  /**
   * Destination type of the offload sink. Every generator below emits an S3
   * sink, so `azure_blob` and `gcs` have no recipe: the render path returns
   * the state of play instead of a config that would write to the wrong
   * store. Defaults to `s3`.
   */
  destinationType?: 's3' | 'gcs' | 'azure_blob' | 'file';
  /** Azure storage account holding the container. Read when `destinationType` is `azure_blob`. */
  storageAccount?: string;
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

/**
 * The state of Azure Blob as an offload sink, as one markdown block.
 *
 * Offload delivery to Azure Blob is not available. Every generator in this
 * file emits an `aws_s3` sink, and no Blob writer exists behind them, so a
 * recipe here would hand the operator a config that writes somewhere other
 * than the container they named. S3 and S3-compatible buckets (MinIO, Ceph)
 * carry the write path today. The Retriever reads Blob either way: it
 * indexes and queries blobs that are already in the container, so an Azure
 * Monitor diagnostic export into Blob is queryable now.
 *
 * Writing this as a block rather than a caveat under a recipe is the point.
 * A generated `aws_s3` sink with a warning above it is still a generated
 * `aws_s3` sink, and the operator applies it.
 */
export function azureBlobOffloadUnavailable(params: OffloadParams): string {
  const container = params.bucket;
  const account = params.storageAccount ?? '<storage-account>';
  return [
    '**Offload delivery to Azure Blob is not available.** log10x emits forwarder offload ' +
      'recipes for S3 and S3-compatible buckets (MinIO, Ceph, and any endpoint speaking the ' +
      'S3 API). Blob speaks its own API and has no recipe here, so this destination has no ' +
      'config to paste.',
    '',
    'What holds today:',
    '',
    `- The Retriever indexes and queries blobs already in \`https://${account}.blob.core.windows.net/${container}/\`. ` +
      'An Azure Monitor diagnostic export that lands in the container is queryable by stamped ' +
      'identity, with no forwarder change.',
    '- For a new offload path, point the forwarder at an S3 or S3-compatible bucket and re-run ' +
      '`log10x_advise_retriever` with that destination to get the recipe.',
    '- `log10x_doctor` and `log10x_retriever_probe` read the blob container directly, so delivery ' +
      'into Blob by any other route is still verified.',
    '',
  ].join('\n');
}

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
  * additive — the Retriever's own role only reads the bucket.
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
      'toward the IA group on the offload path only when `routeState` is present. ' +
      'THE SAVING IS INGEST ONLY: AWS bills Standard and IA the same for storage ' +
      'and for Logs Insights queries, so size the win on the $0.50 -> $0.25/GB ' +
      'ingest delta and on nothing else. ' +
      'WHAT THE SLICE LOSES: an IA log group serves Logs Insights, but it does ' +
      'NOT support subscription filters, metric filters, Live Tail, field ' +
      'indexing, Facets, anomaly detection, embedded metrics format, Container ' +
      'or Lambda Insights ingestion, or the GetLogEvents and FilterLogEvents ' +
      'APIs. Anything downstream of this group that reads it through a ' +
      'subscription filter or FilterLogEvents stops returning events, with no ' +
      'error. Check what consumes the log group before down-tiering it, and ' +
      'note the class cannot be changed afterwards: undoing this means a new ' +
      'log group.',
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
//     only thing a `dpxl_expression` policy can match. It arrives as a
//     first-class body field: `filter $d.routeState == 'tier_down'` and
//     `groupby $d.routeState` both resolve server-side, where a keypath that
//     does not exist returns `keypath does not exist`.
//
//  2. The decision cannot be derived at the destination at all, whatever the
//     pipeline order. Whether a pattern has passed its byte budget for the
//     window is a fact about a STREAM, counted in the sidecar across many
//     events. A destination-side rule reads one event at a time and cannot
//     derive it no matter when it runs. So the routing decision has to arrive
//     stamped on the event, and the shipper is the only thing that can stamp
//     it. (Ordering is not the argument: Coralogix's Pipeline Analyzer doc
//     puts parsing rules, then enrichments, then TCO pipelines.)
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

// ---------------------------------------------------------------------------
// ClickHouse / ClickStack offload  (copied from the harness that ran, not from
// documentation: benchmarks/clickstack-e2e, results/clickstack-e2e-2026-09-15.md)
// ---------------------------------------------------------------------------

/**
 * Which collector writes the offloaded rows. The OpenTelemetry Collector
 * variant is a copy of the config that ran end to end on ClickStack 2.38.0 with
 * engine 1.1.79, the released image
 * `ghcr.io/log-10x/edge-10x@sha256:14357d8d570cb36ba6ca254802a1b8eedb11d8acf6916a936893f8e3babb41f4`.
 * The Vector variants are copied from the runs that exercised them: the JSON
 * arm in gap 2 and the Parquet arm in gap 2b on `timberio/vector:0.58.0-debian`,
 * results at
 * benchmarks/clickstack-e2e-gaps/results/clickstack-e2e-close-2026-09-15.md.
 */
export type ClickhouseCollector = 'otel-collector' | 'vector' | 'vector-parquet';

export interface ClickhouseOffloadParams {
  /** Bucket the collector writes the offloaded rows into. */
  bucket: string;
  /** Region of that bucket. */
  region: string;
  /** Database holding the ClickStack tables. Default `default`. */
  database?: string;
  /** The hot table ClickStack ships. Default `otel_logs`. */
  hotTable?: string;
  /**
   * S3 endpoint ClickHouse itself reads the objects through. Default is the
   * regional AWS endpoint. The harness ran against MinIO at
   * `http://cse-minio:9000`, which is why the path-style switches appear in
   * the collector block as comments.
   */
  s3Endpoint?: string;
  /** OTLP endpoint of the 10x receiver. Default `tenx-receiver:4317`. */
  engineOtlpEndpoint?: string;
  /** ClickStack's own OTLP endpoint, where everything not marked offload returns. */
  clickstackOtlpEndpoint?: string;
  /** Host and port of the HyperDX API. Default `clickstack:8000`. */
  hyperdxApi?: string;
  /** The engine's `symbolMessageHashField` value. Default `tenx_hash`. */
  hashField?: string;
}

export interface ClickhouseRecipePart {
  language: 'yaml' | 'toml' | 'sql' | 'bash' | 'text';
  body: string;
  note: string;
}

export interface ClickhouseOffloadRecipeParts {
  collector: ClickhouseRecipePart & {
    variant: ClickhouseCollector;
    /** True only for the variant the harness actually ran. */
    exercised: boolean;
  };
  /** The tables, the view, the Merge table and the counts table, as SQL. */
  ddl: ClickhouseRecipePart;
  /** Adding the Merge table to HyperDX as a second source, over its API. */
  hyperdx: ClickhouseRecipePart;
  /** Mandatory. Rendered with every variant, never trimmed. */
  honesty: string[];
}

const CH_DEFAULTS = {
  database: 'default',
  hotTable: 'otel_logs',
  engineOtlp: 'tenx-receiver:4317',
  clickstackOtlp: 'clickstack:4317',
  hyperdxApi: 'clickstack:8000',
  hashField: 'tenx_hash',
};

function chNames(p: ClickhouseOffloadParams) {
  const db = p.database ?? CH_DEFAULTS.database;
  const hot = p.hotTable ?? CH_DEFAULTS.hotTable;
  return {
    db,
    hot,
    coldTable: `${hot}_cold`,
    coldView: `${hot}_coldv`,
    mergeTable: `${hot}_all`,
    countsTable: 'counts_by_type',
    countsMv: 'counts_by_type_hot_mv',
    s3Endpoint: p.s3Endpoint ?? `https://s3.${p.region}.amazonaws.com`,
    hashField: p.hashField ?? CH_DEFAULTS.hashField,
  };
}

/**
 * The honesty block. It states what the saving is, what the cold path costs,
 * and the engine version this recipe requires. Every number quoted is from the
 * single run in
 * benchmarks/clickstack-e2e/results/clickstack-e2e-2026-09-15.md, measured on
 * 50,000 lines of the released capture with a dropped cache before each query.
 *
 * Exported so a caller can assert it is present rather than re-derive it.
 */
export function clickhouseOffloadHonesty(): string[] {
  return [
    '**What this buys, and what it costs.**',
    '',
    '- NO LINE IS DROPPED. The cap decides what moves, never what disappears: the marked ' +
      'lines go to the account\'s own bucket and are read beside the hot rows through the ' +
      'Merge table below. Gap 5 counted 36,395 rows before the offload and 36,395 after, ' +
      'matching to the row.',
    '- The saving on ClickHouse is the WRITE PATH, through rows that never enter: insert CPU, ' +
      'merge CPU and merge IO, disk bandwidth, part metadata in Keeper, and object-store ' +
      'requests. A row held back at the edge is a row the cluster never tokenises, never ' +
      'inserts and never merges. Table bytes barely move, and table bytes are not where a ' +
      'ClickHouse bill lives. THAT COMES FROM A DIFFERENT MEASUREMENT: the compute-vs-rows ' +
      'arms in benchmarks/clickhouse-clickstack (benchmarks PR #10), insert CPU from ' +
      'system.query_log and merge CPU from system.part_log. The run this recipe is copied ' +
      'from measured no write path, no bill and no autoscaler.',
    '- WHAT THE INVOICE DOES. ClickHouse Cloud meters compute per minute in 8 GiB increments ' +
      'and bills it per compute-unit-hour, where a unit is 8 GiB of RAM and 2 vCPU; storage ' +
      'is metered on the compressed bytes stored. Fewer rows lower the work the cluster does, ' +
      'and the invoice moves when that lets the autoscaler hold a smaller size, or lets the ' +
      'service idle for longer. On a service already sitting at its floor, a smaller row ' +
      'count changes nothing on the invoice at all. ClickHouse\'s own Managed ClickStack post ' +
      '(2026-02-04) says retention "effectively stops being a meaningful cost dimension" and ' +
      'that "the remaining variable becomes compute".',
    '- NO PER-TYPE CPU FIGURE IS A MEASUREMENT. system.part_log records a merge against a ' +
      'PART, never against a message type, and a part holds rows of every type inserted in ' +
      'its window. What the compute arms measure is the whole table\'s insert and merge CPU ' +
      'with a given set of rows removed before the load, which is an A/B of whole-table cost. ' +
      'Any per-type figure derived from it is MODELED and is labeled modeled.',
    '- The offloaded rows stay searchable in place, through the Merge table, and reading them ' +
      'is SLOWER than reading the hot table. A cold read pays object-store requests; a hot ' +
      'read pays none.',
    '- SIZING THE REQUESTS, because this is where an operator sizes a bucket. One LIST per ' +
      'query covers up to a thousand matched keys (s3_list_object_keys_size, default 1000), ' +
      'and one further LIST for every thousand after that, so the LIST count rises with the ' +
      'bucket. The runs behind this recipe never crossed that line: 14 objects end to end, 50 ' +
      'in gap 2, 180 in gap 1. One GET per object is what a read of the whole object costs, ' +
      'which is what JSONEachRow does. A columnar object large enough to seek past four ' +
      'megabytes at a time (remote_read_min_bytes_for_seek, default 4194304) pays one GET per ' +
      'skip on top. The Vector batch below is set at 33554432 bytes, eight times that ' +
      'threshold, and the run never reached it: timeout_secs 5 flushed first, so the JSON ' +
      'objects averaged about 2.5 MiB and the Parquet objects about 48 KiB, every one of ' +
      'them under the seek threshold. S3GetObject then came back exactly equal to the ' +
      'objects the query did not exclude, 68 on a full scan and 24 with service and day, in ' +
      'BOTH arms, Parquet included. Keep the objects under four megabytes or expect more ' +
      'than one GET per object: a batch that does fill 32 MiB sits on the other side of ' +
      'that threshold, and the one-GET line would need measuring again rather than ' +
      'assuming.',
    '- A query filtered only on time opens EVERY cold object in the bucket. Measured on the ' +
      'harness sample, which held 14 objects: time only read 37,536 rows through 14 S3 GET in ' +
      '118 ms, while the same query with a service predicate read 25,793 rows through 6 S3 GET ' +
      'in 77 ms, and adding a day predicate held at 6 GET and 43 ms. The hot table alone ' +
      'answered its count in 8 ms with zero requests.',
    '- Across thirty days of objects the same shape holds and costs more. Measured on 180 ' +
      'objects, 30 days of the cold side: a time-only query opened all 180 in 7,449 ms, and ' +
      'the same query with `day >= today() - 1` opened 12 in 468 ms. A service predicate ' +
      'alone opened 60, that service\'s objects on every day. A pattern-hash predicate alone ' +
      'opened all 180, because the hash is a column inside the file and not a path segment. ' +
      'Every dashboard query that names only a time pays one request per object in the ' +
      'bucket. THE DAY IN THE PATH IS THE UPLOAD DAY, NOT THE RECORD DAY: the S3 exporter ' +
      'builds the key from the wall clock at upload (awss3exporter, ' +
      'internal/upload/writer.go, clock.Now). On a steady feed the two agree. After a ' +
      'backfill or a replay they do not, so a day predicate is a cost control and never a ' +
      'substitute for the time filter.',
    '- PATH PREDICATES PRUNE. PARQUET STATISTICS DID NOT. Measured on 2026-09-15 (gap 2b, ' +
      'Vector 0.58.0, 68 objects per arm): system.query_log was read per query, and ' +
      'ParquetPrunedRowGroups, ParquetPrunedPages and ParquetReadPages are ZERO on every ' +
      'query on this capture, while ParquetReadRowGroups is 68 on the three full scans, ' +
      'one row group per object and all of them read. What Parquet bought is BYTES: the ' +
      'time-only query read 3,594,401 bytes against the JSON arm\'s 177,418,092 and ' +
      'answered in 137 ms against 951 ms, because only the columns the query names are ' +
      'read. Both arms returned 157,151 rows and opened the same 68 objects. Service and ' +
      'day took both to 24 objects and 106,917 rows read, 75 ms against 628 ms. Do not ' +
      'sell row-group pruning on this layout: one object holds one row group, so there is ' +
      'nothing inside an object to skip.',
    '- Count-all dashboards read the counts-per-type table, not the Merge table: count all by ' +
      'service over the counts table read 2,539 rows with zero S3 requests in 6 ms. The ' +
      'counts table is fed twice, by a materialized view on the hot inserts and by an ' +
      'INSERT ... SELECT over the cold objects, because offloaded rows never pass through an ' +
      'insert.',
    '- Alerts are NOT claimed unchanged, and an alert an offload keeps must point at THE ' +
      'COUNTS TABLE. HyperDX accepted an alert over the hot table, the Merge table and the ' +
      'counts table, all 200, and an alert on the hot table stops firing once the rows it ' +
      'counts are offloaded. Never point an alert at the Merge table: every evaluation opens ' +
      'every cold object its predicates do not prune, so the alert pays object-store requests ' +
      'on its own schedule, for as long as it is enabled. Whether HyperDX\'s own evaluation ' +
      'loop fires is still unmeasured: a replayed capture is older than any interval short ' +
      'enough to wait for.',
    '- THE HANDOFF IS NOT DURABLE, so "every line kept" is a claim about the POLICY and not ' +
      'about the route. Neither hop keeps a queue on disk in this recipe. Measured by a ' +
      'sequence number inside every line, the routing collector killed mid-feed and ' +
      'restarted twenty seconds later. The first pass (gap 4, 2026-09-15) never stored ' +
      '65,269 of 197,430 input lines and saw 16,828 deliveries arrive twice; with the ' +
      'receiver killed instead, 84,762 were never stored. Two arms rerun the same evening ' +
      'never stored 36,372 with the shipped queue and 44,555 with the configuration the ' +
      'collector\'s own maintainers prescribe (filelog retry_on_failure with ' +
      'max_elapsed_time 0, no batch processor, no sending queue), and BOTH reported zero ' +
      'duplicate deliveries. The loss reproduces and the duplication does not, because the ' +
      'kill lands at a different point relative to the file receiver\'s checkpoint flush ' +
      'each time, so quote the loss and treat any duplicate count as unrepeated. The ' +
      'prescription loses MORE, not less, because the loss sits on the far side of the ' +
      'kill in records that had already left the file receiver, and it costs objects rather ' +
      'than throughput: 1,180 objects against 65 for a comparable number of rows, at 141 ' +
      'seconds of feed against 150. Separately, the collector\'s sending queue REJECTS a batch that does not fit ' +
      'and only logs it, so a feed reads as finished while lines are missing unless ' +
      '`sending_queue.block_on_overflow: true` is set on the exporter into the receiver. Set ' +
      'it, and put a persistent queue behind both hops, before quoting anything about loss.',
    '- INSTALL ORDER, AND A DEFECT IT AVOIDS. Run the collector FIRST and confirm at least ' +
      'one object exists under the prefix before the cold table is created. An S3 table ' +
      'created with an explicit schema and use_hive_partitioning = 1 while the prefix is ' +
      'still empty caches that empty listing as resolved: the partition columns then read ' +
      'file defaults, and every path predicate returns ZERO ROWS, with no error, for the ' +
      'lifetime of the table. ClickHouse issue 116888, open, filed 2026-08-28 by a ClickHouse ' +
      'member. The DDL below carries the check as its own numbered step; do not skip it and ' +
      'do not reorder the steps. MEASURED on 2026-09-15 (gap 7, ClickHouse 26.5.7.64, four ' +
      'tables over one DDL, two objects of 20,000 rows each), and the trigger is narrower ' +
      'than the issue summary reads: THE READ ARMS IT, NOT THE CREATE. A table created ' +
      'before any object existed and left unread until after answered 20,000 rows on a ' +
      'service predicate and 40,000 on a day predicate, the same as a table created after ' +
      'the first object. The same table created AND read once while the prefix was still ' +
      'empty answered 0 on both, because the S3 engine resolves its listing during SELECT. ' +
      'The failure is silent where it matters: count() with no predicate answered 40,000 on ' +
      'the broken table, so the one query a reader runs to check the setup step says the ' +
      'table is fine. DETACH TABLE then ATTACH TABLE restored every predicate on the broken ' +
      'table without dropping it, and is the repair for a table already in that state.',
    '- TTL MOVES ARE THE RIGHT TOOL FOR STORAGE, AND THIS RECIPE DOES NOT COMPETE WITH THEM. ' +
      'A `TTL Timestamp + INTERVAL <n> DAY TO VOLUME \'cold\'` rule leaves the parts as ' +
      'MergeTree parts, so the primary index and the eight skip indexes still apply, the ' +
      'schema does not change, nothing is renamed, and no Merge table, no view and no counts ' +
      'table are needed. An operator who wants cheaper STORAGE should use TTL moves. TTL is ' +
      'evaluated during background merges, after the row has been parsed, indexed, written ' +
      'and merged, so a TTL move never returns insert or merge work; the lever here is the ' +
      'row that never enters. Two things worth knowing before choosing between them: ' +
      '`prefer_not_to_merge` on a cold volume, the standard way to keep merges off the ' +
      'bucket, stops TTL deletes from running (ClickHouse issue 85636, open, confirmed ' +
      'independently across 25.1 to 25.8), and Mohamed Aziz of Luciq published on 2026-08-10 ' +
      'what merges on object storage cost when they do run there. MEASURED on 2026-09-15 ' +
      '(gap 8), ClickStack\'s own otel_logs reissued under a hot_cold policy with a ' +
      'MinIO-backed s3 disk and `Timestamp + INTERVAL 60 SECOND TO VOLUME \'cold\'`, the ' +
      'whole 197,430 line capture fed with nothing offloaded, 157,096 rows: the insert cost ' +
      '1.16 CPU seconds, and the merge and move that followed cost 5.40 CPU seconds and ' +
      'charged 332 S3PutObject, 332 of them DiskS3PutObject, leaving one active part of ' +
      '10,535,999 bytes on the cold volume. The same rows replayed with timestamps seven ' +
      'days back, behind the boundary, charged 807 and left two parts. On the same capture ' +
      'the offload route wrote 68 objects on the cold side. Two things belong beside those ' +
      'figures. The bucket\'s own object count, 3,837 and then 4,318, is ClickHouse\'s s3 ' +
      'disk layout with intermediate merge outputs still present rather than what the move ' +
      'charged; 332 and 807 are what it charged. And the capture spans seven seconds as ' +
      'inserted, so the table held one partition and moved as one: the part of the recipe ' +
      'that does the work, insertion landing in a new partition while older partitions move ' +
      'after their merges settle, is not exercised by this arm. What the arm measures is ' +
      'what a move costs once it fires.',
    '- THIS RECIPE REQUIRES ENGINE 1.1.79 OR NEWER. The three OpenTelemetry return-path ' +
      'defects that blocked it are fixed and released in 1.1.79 (pipeline-extensions ' +
      '8ebaf793, engine b9074b9a, engine PR #150). On an older image a record whose message ' +
      'is itself JSON with a top-level `body` key came back carrying no attributes at all, so ' +
      'it had no `routeState`, could not be routed, and took the default route into the hot ' +
      'table: 19,436 of 37,519 records on 1.1.74. Marked records came back with no ' +
      '`timeUnixNano`, and the `tenx_resource_keys` field name arrived in several corrupted ' +
      'spellings.',
    '- Verified on the released image. The harness reran on ' +
      '`ghcr.io/log-10x/edge-10x:1.1.79` and 37,536 of 37,536 returned records carried ' +
      '`routeState` and a `timeUnixNano`, against 18,083 marked of 37,519 on 1.1.74. Hot plus ' +
      'offloaded reconciled to 37,536 with a gap of 0, on 13,010 hot rows and 24,526 ' +
      'offloaded, and 2,495 distinct type hashes came back on the wire against 2,495 stored.',
    '- A COLLECTOR-ONLY RULE CAN BEAT THIS ON HOT WRITE-PATH CPU. Measured over the whole ' +
      '197,430 ' +
      'line capture on one container: a rule by service and severity, written off one reading ' +
      'of the census, cost 2.7 insert-plus-merge CPU seconds against 8.1 for the per-type cap ' +
      'and 10.1 for no offload at all, while keeping MORE rows. The receiver groups a ' +
      'multi-line event into one record, so the per-type arm\'s rows are fewer and bigger, and ' +
      'ClickStack indexes the text of every row. What the collector-only rule cannot do is ' +
      'answer a question by message type: no row it writes carries a type hash, so the ' +
      'question cannot be put at all. Sell the question, not the CPU second. Merge CPU is also ' +
      'unstable run to run; it depends on which parts the scheduler merged inside the window.',
    '- The route arrives more often than the type does. In that rerun all 37,536 records ' +
      'carried `routeState`, 37,486 carried the type hash and 37,469 carried the type text, ' +
      'so the router moves every record while the counts-per-type table can only count what ' +
      'carries a type.',
  ];
}

/** The OpenTelemetry Collector variant, copied from the harness config. */
function clickhouseOtelCollector(p: ClickhouseOffloadParams): ClickhouseOffloadRecipeParts['collector'] {
  const engine = p.engineOtlpEndpoint ?? CH_DEFAULTS.engineOtlp;
  const clickstack = p.clickstackOtlpEndpoint ?? CH_DEFAULTS.clickstackOtlp;
  return {
    variant: 'otel-collector',
    exercised: true,
    language: 'yaml',
    body: `# COPIED from the harness config that ran end to end
# (benchmarks/clickstack-e2e/conf/router.yaml). Every processor, connector and
# exporter OPTION below is the text that produced the measured run. What
# differs from the file that ran, in full:
#   - the two OTLP exporter endpoints carry this deployment's hosts. The run
#     used \`cse-engine:4317\` and \`cse-clickstack:4317\`.
#   - the S3 bucket and the region carry this deployment's values. The run used
#     \`coldlogs\` and \`us-east-1\`.
#   - the run wrote to MinIO, so its \`endpoint: http://cse-minio:9000\`,
#     \`s3_force_path_style\` and \`disable_ssl\` are commented out below and the
#     host is written as \`minio:9000\`. On AWS S3 all three stay out.
#   - the run's input was a \`filelog\` receiver over one capture file. The two
#     receivers under \`logs/in\` here are PLACEHOLDERS for the estate's own and
#     must be replaced.
#   - the run's measurement tap (the \`file/wire\` exporter and the \`logs/wire\`
#     pipeline) is dropped. It counted what the receiver returned and is not
#     part of the design.
#   - the comments are expanded here. The ones the harness file carries are
#     kept word for word.
#
# The routing hop. ClickStack's own collector build carries the routing
# connector but no S3 exporter and no encoding extension, so the route and the
# offload write run in a second, stock opentelemetry-collector-contrib
# container. Everything that is not marked \`offload\` goes back to ClickStack's
# shipped OTLP endpoint and is inserted by ClickStack's own ClickHouse exporter.

extensions:
  json_log_encoding/cold:
    mode: body_with_inline_attributes

receivers:
  # The return path from the receiver.
  otlp/back:
    protocols:
      grpc:
        endpoint: 0.0.0.0:24225
        max_recv_msg_size_mib: 32

  # PLACEHOLDERS, REPLACE BOTH. These two stand for whatever reads the logs in
  # the estate today. Pointing them at this collector rather than at ClickStack
  # is what puts the 10x receiver in front of the stream. The harness ran a
  # \`filelog\` receiver over one capture file in their place.
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
  filelog:
    include: [ /var/log/containers/*.log ]

processors:
  # The capture's envelope carries no timestamp, so records arrive with none and
  # would land on 1970-01-01. Ingest time is used instead, on both routes.
  transform/stamp:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          - set(log.time_unix_nano, log.observed_time_unix_nano) where log.time_unix_nano == 0

  # Part of the returned stream carries the service as a log attribute rather
  # than on the OTLP resource. groupbyattrs lifts it back onto the resource so
  # ServiceName is set on the ClickHouse side and the offload path can key the
  # object prefix on it.
  transform/service:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          - set(log.attributes["service.name"], log.attributes["k8s_container"]) where log.attributes["service.name"] == nil and log.attributes["k8s_container"] != nil
  groupbyattrs/service:
    keys: [ service.name ]

  # The offloaded object carries body and log attributes only, so the service,
  # the record time and the severity are copied into attributes before the
  # write or they do not survive the encoding.
  transform/cold:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          - set(log.attributes["ServiceName"], resource.attributes["service.name"])
          - set(log.attributes["SeverityText"], log.severity_text)
          - set(log.attributes["TimestampNano"], UnixNano(log.time))
          - set(log.attributes["TimestampSec"], UnixSeconds(log.time))
      - context: resource
        statements:
          - set(resource.attributes["s3.prefix"], Concat(["service=", resource.attributes["service.name"]], ""))
  batch/cold:
    send_batch_size: 5000
    timeout: 5s

exporters:
  otlp/engine:
    endpoint: ${engine}
    tls:
      insecure: true
  otlp/clickstack:
    endpoint: ${clickstack}
    tls:
      insecure: true
    headers:
      authorization: \${env:HDX_API_KEY}
  awss3/cold:
    s3uploader:
      region: ${p.region}
      s3_bucket: ${p.bucket}
      s3_prefix: cold
      s3_partition_format: 'day=%Y-%m-%d'
      # The harness ran against MinIO, which needs these three. On AWS S3 leave
      # them out and let the exporter resolve the regional endpoint.
      # endpoint: http://minio:9000
      # s3_force_path_style: true
      # disable_ssl: true
      compression: none
    encoding: json_log_encoding/cold
    encoding_file_extension: json
    # This is what puts the service in the object path: the per-record resource
    # attribute REPLACES the static s3_prefix above, so objects land at
    # service=<name>/day=<date>/logs_<n>.json.
    resource_attrs_to_s3:
      s3_prefix: s3.prefix

connectors:
  routing/state:
    default_pipelines: [ logs/hot ]
    error_mode: ignore
    table:
      - context: log
        condition: attributes["routeState"] == "offload"
        pipelines: [ logs/cold ]

service:
  extensions: [ json_log_encoding/cold ]
  telemetry:
    logs:
      level: warn
  pipelines:
    logs/in:
      # The placeholder receivers declared above, to be replaced with the
      # estate's own. Only the exporter matters on this pipeline.
      receivers: [ otlp, filelog ]
      exporters: [ otlp/engine ]
    logs/back:
      receivers: [ otlp/back ]
      processors: [ transform/stamp, transform/service, groupbyattrs/service ]
      exporters: [ routing/state ]
    logs/hot:
      receivers: [ routing/state ]
      exporters: [ otlp/clickstack ]
    logs/cold:
      receivers: [ routing/state ]
      processors: [ transform/cold, batch/cold ]
      exporters: [ awss3/cold ]`,
    note:
      'Runs as a SECOND, stock `opentelemetry-collector-contrib` container beside ' +
      "ClickStack's own collector. ClickStack's build reports itself as 0.155.0 and " +
      'carries `routing`, `clickhouse`, `groupbyattrs` and `transform`, but NOT ' +
      '`awss3`, `json_log_encoding` or `otlp_encoding`, so the offload write cannot ' +
      'run inside it. Everything not marked `offload` returns to ' +
      "ClickStack's OTLP endpoint and is inserted by ClickStack's own ClickHouse " +
      'exporter, unchanged. The three hops before the write are not decoration: the ' +
      'JSON encoding extension in `body_with_inline_attributes` mode writes ' +
      '`{"body": ..., "logAttributes": {...}}` and nothing else, so the record time, ' +
      'the resource attributes and the severity are copied into log attributes first ' +
      'or the cold rows have no timestamp and no service at all. The harness ran ' +
      'this against ClickStack 2.38.0, ClickHouse 26.5.7.64 and ' +
      'contrib 0.160.0 on 2026-09-14.',
  };
}

/** The Vector variant, copied from the harness run that exercised it. */
function clickhouseVectorCollector(p: ClickhouseOffloadParams): ClickhouseOffloadRecipeParts['collector'] {
  const n = chNames(p);
  const endpoint = p.s3Endpoint ?? `https://s3.${p.region}.amazonaws.com`;
  return {
    variant: 'vector',
    exercised: true,
    language: 'yaml',
    body: `# COPIED from the harness config that ran end to end
# (benchmarks/clickstack-e2e-gaps/gap2_vector_parquet.sh). Vector sits BEHIND
# the routing collector: the collector still makes the split and forwards the
# marked stream here over OTLP, and Vector writes the objects.
#
# VECTOR WRITES JSON HERE, AND JSON IS THE ARM THAT RAN. The sink below sets
# \`encoding.codec: json\` with newline framing, which is what the cold table
# reads. There is no \`ndjson\` codec, so newline delimited JSON is the \`json\`
# codec with newline framing.
#
# Vector ALSO writes Parquet on the \`aws_s3\` sink, under
# \`batch_encoding.codec: parquet\`, added in v0.55.0 (2026-04-22) and available
# in official release builds from v0.56.0 (2026-06-03). That option is now the
# \`vector-parquet\` variant, run on \`timberio/vector:0.58.0-debian\` on
# 2026-09-15: off the same stream, this JSON arm wrote 169MiB and the Parquet
# arm wrote 3.2MiB, both 68 objects and both 116,507 rows. Pick that variant for
# the bytes a cold read pays; pick this one to keep the attribute map whole.
#
# What differs from the file that ran: the bucket, the region and the S3
# endpoint carry this deployment's values (the run wrote to MinIO at
# \`http://cse-minio:9000\` with its root credentials, which is why the endpoint
# and the auth block are here at all; on AWS S3 both come out and the sink takes
# the instance's own credentials).

data_dir: /vector-data

sources:
  otlp:
    type: opentelemetry
    # End to end acknowledgements hold the gRPC response until the S3 batch
    # flushes, and the collector's exporter then holds the WHOLE route behind
    # it, hot side included. The first run of the harness script moved 1,425
    # records of 157,083 for that reason.
    acknowledgements:
      enabled: false
    grpc:
      address: 0.0.0.0:4319
    http:
      address: 0.0.0.0:4320
      keepalive:
        max_connection_age_secs: 600

transforms:
  # Route on the stamped action. The marker is a STRING, never a boolean.
  split:
    type: route
    inputs: [ otlp.logs ]
    route:
      cold: '.attributes.routeState == "offload"'

  # The shape the cold table reads: the body and a flat attribute map, with the
  # service, the severity and the record time folded into it, because the object
  # carries no resource and no timestamp of its own.
  shape:
    type: remap
    inputs: [ split.cold ]
    source: |
      svc = string!(.resources."service.name" || .attributes.k8s_container || "unknown")
      stamp = now()
      if is_timestamp(.timestamp) { stamp = timestamp!(.timestamp) }
      ts = to_unix_timestamp(stamp)
      attrs = object!(.attributes || {})
      attrs.ServiceName = svc
      attrs.SeverityText = string(.severity_text) ?? ""
      attrs.TimestampSec = to_string(ts)
      attrs.TimestampNano = to_string(ts * 1000000000)
      body = string(.message) ?? string(.body) ?? ""
      . = { "body": body, "logAttributes": attrs, "svc": svc }

sinks:
  cold:
    type: aws_s3
    inputs: [ shape ]
    bucket: ${p.bucket}
    region: ${p.region}
    # MinIO only. Delete both on AWS S3.
    endpoint: ${endpoint}
    auth:
      access_key_id: <access-key>
      secret_access_key: <secret-key>
    key_prefix: "service={{ svc }}/day=%F/"
    filename_extension: json
    compression: none
    encoding:
      codec: json
      except_fields: [ svc ]
    framing:
      method: newline_delimited
    # OBJECT COUNT IS THE QUERY-COST MULTIPLIER. Every cold query opens each
    # object its predicates do not prune, and ClickHouse pays one request per
    # object, so these two numbers decide what a cold read costs far more than
    # the codec does. The harness run wrote 50 objects for the whole cold side
    # with the values below; larger and slower is right here.
    batch:
      max_bytes: 33554432
      timeout_secs: 5`,
    note:
      'Ran end to end in benchmarks/clickstack-e2e-gaps (gap 2, 2026-09-15). Vector ' +
      'took the returned stream, made the same routing decision on `routeState`, and ' +
      'wrote 50 JSON objects holding 113,732 rows, which the SAME S3 table and the ' +
      'SAME Merge table below read with no change to either, answering the same ' +
      'queries with the same numbers. Parquet is now settled too, and it is the ' +
      '`vector-parquet` variant below rather than a caveat here: on `0.58.0-debian`, ' +
      'gap 2b, 2026-09-15, Vector wrote both containers off one transform and this JSON ' +
      'arm held 116,507 rows in 68 objects at 169MiB against the Parquet arm\'s 68 ' +
      'objects at 3.2MiB. The OpenTelemetry collector\'s S3 exporter still has no ' +
      'Parquet marshaler at all, and the request for one (contrib issue 45103) was ' +
      'closed unplanned in May 2026, so the Parquet option is Vector\'s alone.',
  };
}

/**
 * The Vector Parquet variant, copied from the run that exercised it
 * (benchmarks/clickstack-e2e-gaps/gap2b_vector058_parquet.sh, 2026-09-15, on
 * `timberio/vector:0.58.0-debian`, digest
 * `sha256:1c1ea358c617ea0b23003d5af87f7a678b30f8f7096437e680380c47fc13d2d9`).
 */
function clickhouseVectorParquetCollector(p: ClickhouseOffloadParams): ClickhouseOffloadRecipeParts['collector'] {
  const n = chNames(p);
  const endpoint = p.s3Endpoint ?? `https://s3.${p.region}.amazonaws.com`;
  return {
    variant: 'vector-parquet',
    exercised: true,
    language: 'yaml',
    body: `# COPIED from the harness config that ran
# (benchmarks/clickstack-e2e-gaps/gap2b_vector058_parquet.sh). Vector sits
# BEHIND the routing collector, exactly as the JSON variant does: the collector
# makes the split and forwards the marked stream here over OTLP.
#
# THE THREE KEYS THAT MAKE PARQUET VALIDATE, and the run put all three to
# \`vector validate\` on this build. \`encoding.codec: parquet\` is refused, and
# the binary names the thirteen per-event codecs it does take. \`batch_encoding\`
# alone is refused for a missing \`encoding\`. \`batch_encoding.codec: parquet\`
# WITH \`encoding.codec: json\` validates, exit 0. So \`encoding\` stays required
# and ignored for the batch, \`compression\` at the sink is \`none\` because
# Parquet compresses per column page, and snappy goes inside the file.
#
# Build that ran: vector 0.58.0 (x86_64-unknown-linux-gnu 2bcad9b 2026-08-26).
# The option landed in v0.55.0 (2026-04-22) and is in the official release
# binaries from v0.56.0 (2026-06-03), upstream issue 1374.
#
# What differs from the file that ran: the bucket, the region and the S3
# endpoint carry this deployment's values (the run wrote to MinIO at
# \`http://cse-minio:9000\` with its root credentials, which is why the endpoint
# and the auth block are here at all; on AWS S3 both come out and the sink takes
# the instance's own credentials).

data_dir: /vector-data

sources:
  otlp:
    type: opentelemetry
    # End to end acknowledgements hold the gRPC response until the S3 batch
    # flushes, and the collector's exporter then holds the WHOLE route behind
    # it, hot side included.
    acknowledgements:
      enabled: false
    grpc:
      address: 0.0.0.0:4319
    http:
      address: 0.0.0.0:4320
      keepalive:
        max_connection_age_secs: 600

transforms:
  # Route on the stamped action. The marker is a STRING, never a boolean.
  split:
    type: route
    inputs: [ otlp.logs ]
    route:
      cold: '.attributes.routeState == "offload"'

  shape:
    type: remap
    inputs: [ split.cold ]
    source: |
      svc = string!(.resources."service.name" || .attributes.k8s_container || "unknown")
      stamp = now()
      if is_timestamp(.timestamp) { stamp = timestamp!(.timestamp) }
      ts = to_unix_timestamp(stamp)
      attrs = object!(.attributes || {})
      attrs.ServiceName = svc
      attrs.SeverityText = string(.severity_text) ?? ""
      attrs.TimestampSec = to_string(ts)
      attrs.TimestampNano = to_string(ts * 1000000000)
      body = string(.message) ?? string(.body) ?? ""
      . = { "body": body, "logAttributes": attrs, "svc": svc }

  # THE FLATTENING, and it is not optional. A schema inferred from a free
  # attribute map carries one field per attribute key the batch happened to
  # see, so the fields the queries name are lifted into columns of their own
  # here and the cold table names them. Add any further attribute the cold
  # queries read to BOTH this transform and the table, the pattern text
  # included: the arm that ran carried the hash and not the text.
  columns:
    type: remap
    inputs: [ shape ]
    source: |
      attrs = object!(.logAttributes)
      . = {
        "body":          string!(.body),
        "ServiceName":   string!(.svc),
        "SeverityText":  string(attrs.SeverityText) ?? "",
        "TimestampSec":  string(attrs.TimestampSec) ?? "0",
        "TimestampNano": string(attrs.TimestampNano) ?? "0",
        "${n.hashField}":     string(attrs.${n.hashField}) ?? "",
        "svc":           string!(.svc)
      }

sinks:
  cold:
    type: aws_s3
    inputs: [ columns ]
    bucket: ${p.bucket}
    region: ${p.region}
    # MinIO only. Delete both on AWS S3.
    endpoint: ${endpoint}
    auth:
      access_key_id: <access-key>
      secret_access_key: <secret-key>
    key_prefix: "service={{ svc }}/day=%F/"
    filename_extension: parquet
    compression: none
    encoding:
      codec: json
      except_fields: [ svc ]
    batch_encoding:
      codec: parquet
      schema_mode: auto_infer
      compression:
        algorithm: snappy
    # OBJECT COUNT IS THE QUERY-COST MULTIPLIER, and object SIZE decides whether
    # one GET per object still holds. The run never reached max_bytes because
    # timeout_secs flushed first, so its Parquet objects averaged about 48 KiB,
    # well under the 4 MiB remote_read_min_bytes_for_seek default at which
    # ClickHouse starts seeking inside an object rather than reading it end to
    # end, and S3GetObject came back equal to the object count. Batches that do
    # fill 32 MiB sit on the other side of that threshold.
    batch:
      max_bytes: 33554432
      timeout_secs: 5`,
    note:
      'Ran in benchmarks/clickstack-e2e-gaps (gap 2b, 2026-09-15) beside the JSON arm, ' +
      'both sinks fed off one transform in one Vector process, from 157,151 records the ' +
      'receiver returned. Vector wrote 68 Parquet objects holding 116,507 rows at 3.2MiB, ' +
      'against 68 JSON objects holding the same 116,507 rows at 169MiB, and every query ' +
      'answered the same number through both. WHAT PARQUET BUYS IS BYTES READ, NOT ' +
      'PRUNING: the time-only query read 3,594,401 bytes here against 177,418,092 through ' +
      'JSON and answered in 137 ms against 951 ms, while ParquetPrunedRowGroups, ' +
      'ParquetPrunedPages and ParquetReadPages read ZERO on every query in ' +
      'system.query_log and ParquetReadRowGroups read 68, one row group per object, all ' +
      'of them read. The path predicates are what prune, the same as on the JSON arm: ' +
      'service and day took both arms to 24 objects, 106,917 rows read, 75 ms here ' +
      'against 628 ms through JSON. The cold table below differs from the JSON one, ' +
      'because this arm writes named columns rather than a Map(String, String).',
  };
}

/** The ClickHouse side. SQL the operator runs. One shape reads what either
 * collector writes, because both write body plus a flat attribute map. */
function clickhouseDdl(
  p: ClickhouseOffloadParams,
  variant: ClickhouseCollector = 'otel-collector',
): ClickhouseRecipePart {
  const n = chNames(p);
  const parquet = variant === 'vector-parquet';
  const glob = parquet ? '**.parquet' : '**.json';
  const format = parquet ? 'Parquet' : 'JSONEachRow';
  const key = `'<access-key>', '<secret-key>'`;
  const coldJson = `-- COPIED from the harness (benchmarks/clickstack-e2e/conf/schema_cold.sql).
-- Substituted: the S3 URL and the key pair (the run read
-- 'http://cse-minio:9000/coldlogs/**.json' with the MinIO root credentials),
-- and the database and table names. Everything else is the text that ran.
--
-- The S3 engine takes the column names from the JSON the collector wrote:
-- the jsonlogencoding extension in body_with_inline_attributes mode writes
-- {"body": ..., "logAttributes": {...}} per record, as one JSON array per
-- object. \`service\` and \`day\` are not in the file at all; they come from the
-- object path, which is why use_hive_partitioning is on.
--
-- The Vector variant's remap writes the same two keys, one record per line, and
-- this table read Vector's objects unchanged in the gap 2 run.
DROP TABLE IF EXISTS ${n.db}.${n.coldTable};
CREATE TABLE ${n.db}.${n.coldTable}
(
  body           String,
  logAttributes  Map(String, String),
  service        LowCardinality(String),
  day            Date
) ENGINE = S3('${n.s3Endpoint}/${p.bucket}/**.json', ${key}, 'JSONEachRow')
SETTINGS use_hive_partitioning = 1;

-- The S3 engine REJECTS ALIAS COLUMNS, so the rename to the ClickStack column
-- names is a view. The Merge table below reads the view, not the S3 table.
DROP VIEW IF EXISTS ${n.db}.${n.coldView};
CREATE VIEW ${n.db}.${n.coldView} AS
SELECT toDateTime64(toUInt64OrZero(logAttributes['TimestampSec']), 9) AS Timestamp,
       CAST(service AS LowCardinality(String))                        AS ServiceName,
       body                                                           AS Body,
       CAST(logAttributes['SeverityText'] AS LowCardinality(String))  AS SeverityText,
       logAttributes                                                  AS LogAttributes,
       day                                                            AS day
FROM ${n.db}.${n.coldTable};`;

  const coldParquet = `-- COPIED from the harness
-- (benchmarks/clickstack-e2e-gaps/gap2b_vector058_parquet.sh, the arm that ran
-- on Vector 0.58.0 on 2026-09-15). Substituted: the S3 URL and the key pair
-- (the run read 'http://cse-minio:9000/coldparquetv/**.parquet' with the MinIO
-- root credentials), the database, and the table names, because the run held
-- both arms side by side and called these otel_logs_coldpq and
-- otel_logs_coldpqv.
--
-- THIS TABLE IS NOT THE JSON ONE. The Parquet arm writes named columns, not a
-- Map(String, String), because a schema inferred from a free attribute map
-- carries one field per attribute key the batch happened to see. The columns
-- here are the columns the \`columns\` transform in the Vector config writes, and
-- the two lists are edited together or the cold rows lose a field. \`service\`
-- and \`day\` are still not in the file: they come from the object path, which
-- is why use_hive_partitioning is on.
DROP TABLE IF EXISTS ${n.db}.${n.coldTable};
CREATE TABLE ${n.db}.${n.coldTable}
(
  body           String,
  ServiceName    String,
  SeverityText   String,
  TimestampSec   String,
  TimestampNano  String,
  ${n.hashField}${' '.repeat(Math.max(1, 15 - n.hashField.length))}String,
  service        LowCardinality(String),
  day            Date
) ENGINE = S3('${n.s3Endpoint}/${p.bucket}/**.parquet', ${key}, 'Parquet')
SETTINGS use_hive_partitioning = 1;

-- The S3 engine REJECTS ALIAS COLUMNS here too, so the rename is a view.
-- THE ARM THAT RAN CARRIED THE TYPE HASH AND NOT THE PATTERN TEXT, so the cold
-- side of the counts table in step 6 names types by hash alone until
-- message_pattern is added to the transform, to the table above and to the map
-- below.
DROP VIEW IF EXISTS ${n.db}.${n.coldView};
CREATE VIEW ${n.db}.${n.coldView} AS
SELECT toDateTime64(toUInt64OrZero(TimestampSec), 9)          AS Timestamp,
       CAST(service AS LowCardinality(String))                AS ServiceName,
       body                                                   AS Body,
       CAST(SeverityText AS LowCardinality(String))           AS SeverityText,
       map('${n.hashField}', ${n.hashField})${' '.repeat(Math.max(1, 46 - 2 * n.hashField.length))}AS LogAttributes,
       day                                                    AS day
FROM ${n.db}.${n.coldTable};`;

  const body = `-- 1) The counts-per-type table and its materialized view. RUN THIS FIRST,
--    before any data flows, or the view sees none of what is already there.
--    COPIED from the harness (conf/schema_hot.sql); only the database, the
--    table and the hash-field names are substituted.
CREATE TABLE IF NOT EXISTS ${n.db}.${n.countsTable}
(
  Minute DateTime,
  ServiceName LowCardinality(String),
  ${n.hashField} String,
  message_pattern String,
  source LowCardinality(String),
  cnt UInt64
) ENGINE = SummingMergeTree(cnt)
ORDER BY (Minute, ServiceName, ${n.hashField}, message_pattern, source);

CREATE MATERIALIZED VIEW IF NOT EXISTS ${n.db}.${n.countsMv}
TO ${n.db}.${n.countsTable} (Minute DateTime, ServiceName LowCardinality(String), ${n.hashField} String, message_pattern String, source LowCardinality(String), cnt UInt64) AS
SELECT toStartOfMinute(Timestamp)          AS Minute,
       ServiceName,
       LogAttributes['${n.hashField}']${' '.repeat(Math.max(1, 20 - n.hashField.length))}AS ${n.hashField},
       LogAttributes['message_pattern']    AS message_pattern,
       'hot'                               AS source,
       count()                             AS cnt
FROM ${n.db}.${n.hot}
GROUP BY Minute, ServiceName, ${n.hashField}, message_pattern;

-- 2) ClickStack's ${n.hot} has NO day column, so a day predicate over the
--    Merge table would exclude every hot row. One materialized column fixes it.
--    This is a change to ClickStack's shipped schema and the harness reports it
--    as one.
ALTER TABLE ${n.db}.${n.hot} ADD COLUMN IF NOT EXISTS day Date MATERIALIZED toDate(Timestamp);

-- 3) START THE COLLECTOR NOW, AND DO NOT CREATE THE COLD TABLE UNTIL AT LEAST
--    ONE OBJECT EXISTS UNDER THE PREFIX. An S3 table created with an explicit
--    schema and use_hive_partitioning = 1 while the prefix is still empty
--    caches that empty listing as resolved: the partition columns then read
--    file defaults and every path predicate returns ZERO ROWS, with no error,
--    for the lifetime of the table. ClickHouse issue 116888, open, filed
--    2026-08-28 by a ClickHouse member. The s3 TABLE FUNCTION below lists at
--    call time and caches nothing, so it is safe to run before the table
--    exists. Wait for a non-zero count. A bucket listing answers the same
--    question:  aws s3 ls s3://${p.bucket}/ --recursive | head
--
--    MEASURED, and the trigger is narrower than the issue's summary reads: the
--    CREATE alone arms nothing, because the S3 engine resolves its listing
--    during SELECT. Reading the table ONCE while the prefix is still empty is
--    what arms it, which is what a reader who runs the CREATE and then a count
--    to check the step worked does. On an armed table count() with no
--    predicate still answers in full, so that check says the table is fine
--    while every path predicate is dead. A table already in that state is
--    repaired by DETACH TABLE then ATTACH TABLE, without dropping it.
SELECT count() AS objects_ready
FROM s3('${n.s3Endpoint}/${p.bucket}/${glob}', ${key}, '${format}');

-- 4) The offloaded objects, read in place. Create this only after step 3
--    returned a non-zero count.${parquet ? '' : ` The same table reads what either JSON collector
--    writes: the OpenTelemetry Collector's JSON encoding extension and Vector's
--    remap both produce {"body": ..., "logAttributes": {...}}.`}
${parquet ? coldParquet : coldJson}

-- 5) Hot and cold as one table. \`_table\` names the side a row came from.
DROP TABLE IF EXISTS ${n.db}.${n.mergeTable};
CREATE TABLE ${n.db}.${n.mergeTable}
(
  Timestamp     DateTime64(9),
  ServiceName   LowCardinality(String),
  Body          String,
  SeverityText  LowCardinality(String),
  LogAttributes Map(String, String),
  day           Date
) ENGINE = Merge(${n.db}, '^(${n.hot}|${n.coldView})$');

-- 6) The cold side of the counts table, one pass over the objects. Offloaded
--    rows never pass through an insert, so the materialized view never sees
--    them. Run this on a schedule, or feed the cold side from the receiver's
--    own counters instead.
INSERT INTO ${n.db}.${n.countsTable} (Minute, ServiceName, ${n.hashField}, message_pattern, source, cnt)
SELECT toStartOfMinute(Timestamp)       AS Minute,
       ServiceName,
       LogAttributes['${n.hashField}']${' '.repeat(Math.max(1, 19 - n.hashField.length))}AS ${n.hashField},
       LogAttributes['message_pattern'] AS message_pattern,
       'cold'                           AS source,
       count()                          AS cnt
FROM ${n.db}.${n.coldView}
GROUP BY Minute, ServiceName, ${n.hashField}, message_pattern;`;

  return {
    language: 'sql',
    body,
    note:
      'ORDER MATTERS IN TWO PLACES, and both are numbered above. The counts table and ' +
      'its materialized view are created BEFORE any data flows, or the view sees none of ' +
      'the run; and the cold S3 table is created AFTER the collector has written its ' +
      'first object, because a table created over an empty prefix with ' +
      'use_hive_partitioning = 1 caches the empty listing and answers every path ' +
      'predicate with zero rows, silently, for the life of the table (ClickHouse issue ' +
      '116888). Step 3 is the guard; run it until it returns a non-zero count. The ' +
      'trigger is the READ, not the CREATE: a table created over an empty prefix and ' +
      'left unread until objects exist answers every predicate correctly, and a table ' +
      'read once while the prefix is empty answers zero on every path predicate ' +
      'afterwards while count() with no predicate still answers in full. DETACH TABLE ' +
      'then ATTACH TABLE repairs one that is already in that state. The rest ' +
      'is idempotent. Two findings from the run are baked into the shape above and are ' +
      'easy to lose in a rewrite: the S3 table engine rejects ALIAS columns, so the ' +
      "rename to ClickStack's column names is a VIEW and the Merge table reads the " +
      "view rather than the S3 table; and ClickStack's shipped table has no day " +
      'column, so the day predicate that prunes objects would drop every hot row ' +
      'until the materialized column is added.',
  };
}

/** Adding the Merge table to HyperDX as a second source, over its API. */
function clickhouseHyperdx(p: ClickhouseOffloadParams): ClickhouseRecipePart {
  const n = chNames(p);
  const api = p.hyperdxApi ?? CH_DEFAULTS.hyperdxApi;
  return {
    language: 'bash',
    body: `# COPIED from the harness (benchmarks/clickstack-e2e/run.sh). It returned
# HTTP 200 and no click was needed.

# 1) Sign in and keep the cookie. The connection id is read from the response.
curl -s -c /tmp/hdx.txt -X POST http://${api}/login/password \\
  -H 'Content-Type: application/json' \\
  --data '{"email":"<hyperdx-user>","password":"<hyperdx-password>"}' > /dev/null

CONN=$(curl -s -b /tmp/hdx.txt http://${api}/connections \\
  | sed -n 's/.*"_id":"\\([^"]*\\)".*/\\1/p' | head -1)

# 2) Add the Merge table as a SECOND source. The hot table stays the default.
curl -s -o /dev/null -w '%{http_code}\\n' -b /tmp/hdx.txt \\
  -X POST http://${api}/sources -H 'Content-Type: application/json' \\
  --data "{\\"kind\\":\\"log\\",\\"name\\":\\"Logs hot plus cold\\",\\"connection\\":\\"$CONN\\",
 \\"from\\":{\\"databaseName\\":\\"${n.db}\\",\\"tableName\\":\\"${n.mergeTable}\\"},
 \\"timestampValueExpression\\":\\"Timestamp\\",\\"displayedTimestampValueExpression\\":\\"Timestamp\\",
 \\"implicitColumnExpression\\":\\"Body\\",\\"serviceNameExpression\\":\\"ServiceName\\",
 \\"bodyExpression\\":\\"Body\\",\\"eventAttributesExpression\\":\\"LogAttributes\\",
 \\"defaultTableSelectExpression\\":\\"Timestamp,ServiceName,Body\\"}"`,
    note:
      'The hot table STAYS THE DEFAULT SOURCE. A query against the Merge table pays ' +
      'object-store requests and a query against the hot table pays none, so the ' +
      'Merge table is the source picked when cold rows are wanted, not the one every ' +
      'dashboard lands on. Searching it is how an operator reaches an offloaded line ' +
      'without leaving HyperDX.',
  };
}

/**
 * The ClickHouse offload recipe: the collector that writes the objects, the SQL
 * that reads them back beside the hot table, the HyperDX source, and the
 * honesty block.
 *
 * Pass a collector to get one variant; the render function below shows both so
 * the customer picks.
 */
export function clickhouseOffloadRecipe(
  params: ClickhouseOffloadParams,
  collector: ClickhouseCollector = 'otel-collector',
): ClickhouseOffloadRecipeParts {
  return {
    collector:
      collector === 'vector-parquet'
        ? clickhouseVectorParquetCollector(params)
        : collector === 'vector'
          ? clickhouseVectorCollector(params)
          : clickhouseOtelCollector(params),
    ddl: clickhouseDdl(params, collector),
    hyperdx: clickhouseHyperdx(params),
    honesty: clickhouseOffloadHonesty(),
  };
}

/**
 * The full ClickHouse offload section. Substitutes for the generic forwarder
 * section, the way the Coralogix shipper does: the generic recipes write
 * newline JSON into the Retriever's `{bucket}/app/` layout and strip
 * `routeState`, and neither is what a ClickHouse cold table reads.
 */
export function renderClickhouseOffloadSection(
  params: ClickhouseOffloadParams,
  collector?: ClickhouseCollector,
): string {
  const n = chNames(params);
  const variants: ClickhouseCollector[] = collector
    ? [collector]
    : ['otel-collector', 'vector', 'vector-parquet'];
  const lines: string[] = [
    '**ClickHouse offload: the rows marked `offload` are written to the customer\'s own ' +
      'bucket and read back beside the hot table.**',
    '',
    'The receiver stamps a per-service action on the regulator\'s excess slice. The ' +
      'collector routes `routeState == "offload"` to the bucket and everything else to ' +
      'ClickHouse unchanged. A Merge table over the hot table and a view on the objects ' +
      'answers a search across both, and a counts-per-type table answers count-all ' +
      'without touching the objects. Both are part of this recipe, not options.',
    '',
    `Target: \`s3://${params.bucket}/service=<name>/day=<date>/\` (region \`${params.region}\`).`,
    '',
    'Prerequisites:',
    '- Engine: the receiver runs with `outputOffload true`, so every event flows back to ' +
      'the collector carrying full text plus the `routeState` marker.',
    `- Engine: \`symbolMessageHashField\` is set (\`${n.hashField}\`) and the pattern TEXT is in the ` +
      'splice list beside the hash and the route. The shipped expression splices the hash ' +
      'and the route only, so without that edit the offloaded object cannot carry the ' +
      'pattern text and the cold rows cannot be counted per type.',
    `- IAM: the collector identity can \`s3:PutObject\` to \`${params.bucket}/*\`, and the ` +
      'ClickHouse identity can `s3:GetObject` and `s3:ListBucket` on the same bucket. ' +
      'ClickHouse reads the objects itself; this is not the Retriever path.',
    '- Match the route name as a STRING (`routeState == "offload"`), never a boolean test.',
    '',
    '### 1. The collector',
    '',
  ];

  if (variants.length > 1) {
    lines.push(
      'Three variants, one choice, and every one of them has been run: the OpenTelemetry ' +
        'Collector variant end to end, and two Vector variants over the returned stream ' +
        'behind that same collector, writing JSON and writing Parquet. The two JSON ' +
        'variants share one cold table. The Parquet variant writes named columns instead ' +
        'of an attribute map and takes the cold table in section 2b. On one run off one ' +
        'transform the JSON arm held 116,507 rows in 68 objects at 169MiB and the Parquet ' +
        'arm held the same rows in 68 objects at 3.2MiB.',
      '',
    );
  }

  for (const v of variants) {
    const r = clickhouseOffloadRecipe(params, v).collector;
    const label =
      v === 'vector-parquet'
        ? 'Vector 0.58.0, Parquet objects (ran behind the routing collector)'
        : v === 'vector'
          ? 'Vector, JSON objects (ran behind the routing collector)'
          : 'OpenTelemetry Collector, JSON objects (ran end to end)';
    lines.push(
      `_${label}_`,
      '',
      '```' + r.language,
      r.body,
      '```',
      '',
      r.note,
      '',
    );
  }

  const onlyParquet = variants.length === 1 && variants[0] === 'vector-parquet';
  const ddl = clickhouseDdl(params, onlyParquet ? 'vector-parquet' : 'otel-collector');
  lines.push(
    '### 2. The ClickHouse side',
    '',
    onlyParquet
      ? 'Reads the Parquet objects Vector writes, with the columns the transform lifts ' +
          'out of the attribute map named here.'
      : 'Reads the JSON objects either JSON collector writes. The OpenTelemetry ' +
          'Collector\'s JSON encoding extension and Vector\'s remap both produce a body ' +
          'and a flat attribute map, so the same table, view and Merge table cover both ' +
          'paths.',
    '',
    '```sql',
    ddl.body,
    '```',
    '',
    ddl.note,
    '',
  );

  if (!onlyParquet && variants.includes('vector-parquet')) {
    const pq = clickhouseDdl(params, 'vector-parquet');
    const start = pq.body.indexOf('-- COPIED from the harness\n-- (benchmarks/clickstack-e2e-gaps/gap2b');
    const end = pq.body.indexOf('-- 5) Hot and cold as one table.');
    lines.push(
      '### 2b. The cold table, if the Parquet variant is chosen',
      '',
      'Steps 1, 2, 3, 5 and 6 above are unchanged. Step 4 becomes this, because the ' +
        'Parquet arm writes named columns rather than a Map(String, String), and step 3 ' +
        'reads `\'**.parquet\'` with the `Parquet` format instead of `\'**.json\'` with ' +
        '`JSONEachRow`.',
      '',
      '```sql',
      pq.body.slice(start, end).trimEnd(),
      '```',
      '',
    );
  }

  lines.push('### 3. HyperDX', '');

  const hdx = clickhouseHyperdx(params);
  lines.push('```bash', hdx.body, '```', '', hdx.note, '', '### 4. Before quoting any of this', '');
  lines.push(...clickhouseOffloadHonesty());
  return lines.join('\n');
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
          // ClickStack is ClickHouse with HyperDX and a collector in front of
          // it, and it is the estate the recipe was measured on, so a caller
          // naming the distribution reaches the same recipe.
          clickstack: 'clickhouse',
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

  // An azure_blob destination gets the state of play, not a recipe. Every
  // generator emits an S3 sink, so rendering one here would tell the operator
  // to write the offload slice to a bucket they did not ask for.
  if (params.destinationType === 'azure_blob') {
    return azureBlobOffloadUnavailable(params);
  }

  // ClickHouse substitutes for the whole generic section, the way the Coralogix
  // shipper does, and for the same class of reason: applying the generic recipe
  // here produces objects a ClickHouse cold table cannot read. The generic
  // recipes write newline JSON into the Retriever's `{bucket}/app/` layout and
  // strip `routeState` on the output path. The ClickHouse recipe needs the
  // service and the day IN THE OBJECT PATH so a predicate prunes objects, and
  // the identity columns inside the file so the cold rows can be counted per
  // type. A warning appended after a config that already does the wrong thing
  // would not fix that.
  if (
    destination === 'clickhouse' &&
    getAllowedActionsForDestination('clickhouse').includes('offload')
  ) {
    return renderClickhouseOffloadSection({
      bucket: params.bucket,
      region: params.region,
      hashField: params.hashField,
    });
  }

  lines.push(
    'Route the slice 10x marks low-value (`routeState == "drop"`) to the customer\'s ' +
      'own S3 before the SIEM bills it; the Retriever indexes that bucket and ' +
      'fetches it back by stamped identity. Nothing is deleted, it is relocated. ' +
      'This is lossless cost reduction, not deletion.',
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
      'PER-PATTERN dispositions need no engine change and are OFF by default. The receiver app offers `run/receive/rate` as an optional module and the extension reads `TENX_RECEIVE_APPS`, so adding `@run/receive/rate` to that list plus `rateReceiverFieldNames=message_pattern` (NOT symbolMessage — that field does not exist in this composition and silently retains everything) and `rateReceiverLookupFile=/opt/tenx/mutes.csv` arms a per-pattern mute/sample file (build-receive-layer.sh stages it with its 6th argument and prepends the `pattern,disposition` header the lookup consumes as line 1). WITHOUT that file every lever on this estate is estate-wide — outputOffload and routeState apply to the whole stream — so a plan promising per-pattern rows on a Lambda estate is over-promising unless the mute file ships. Baked in the layer the policy is static; from engine 1.1.66, `TENX_RECEIVE_MUTE_S3_URI` fetches it from the offload bucket into /tmp at INIT and refreshes on INVOKE, so dispositions change without a redeploy.',
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

# PER-PATTERN dispositions (optional). Needs no engine change: the receiver
# app already offers run/receive/rate as an optional module, and the module
# arms itself the moment a lookup file is set (its settings.yaml swaps the
# group filter to shouldRetainEventWithMute()). TENX_RECEIVE_APPS is read by
# the extension's launchArgs(), so the whole feature is three env vars plus a
# file staged in the layer at /opt/tenx/mutes.csv.
#
# WITHOUT these, every lever on this estate is estate-wide: outputOffload and
# routeState apply to the whole stream, not to a chosen pattern.
#
# TENX_RECEIVE_APPS=@run/input/forwarder/otel-collector,@apps/receiver,@run/receive/rate
# rateReceiverFieldNames=message_pattern    # key mutes by the pattern identity
#                                           # (symbolMessage does not exist in
#                                           # this composition — empty key
#                                           # silently retains everything)
# rateReceiverLookupFile=/opt/tenx/mutes.csv
#
# mutes.csv — line 1 is a HEADER the lookup consumes (the build script
# prepends it when missing); entries: <pattern>,<rate>:<untilEpochSec>:<reason>
#   pattern,disposition
#   heartbeat_check_ok,0:1786400000:liveness spam OPS-4821   # 0 = full mute
#   jwt_validated,0.25:1786400000:auth flood after deploy    # keep 25%
# Baked into the layer the policy is STATIC — a change means republishing the
# layer and updating each function. From engine 1.1.66,
# TENX_RECEIVE_MUTE_S3_URI fetches it to /tmp at INIT and refreshes on
# INVOKE — dispositions change with one "aws s3 cp", no redeploy. One layout
# across planes: point it at the config-plane key,
# TENX_RECEIVE_MUTE_S3_URI=s3://<bucket>/<prefix>/pipelines/run/receive/rate/mutes.csv
# — the same key the eventbridge recurring tick writes.
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

// ─── Azure stream topology (Function Apps / App Service — no process slot) ───

export interface AzureStreamsRecipe {
  /** Azure-side: hub creation + diagnostic settings routing logs into it. */
  hub: OffloadRecipe;
  /** The collector that consumes the hub and pairs with the engine. */
  collector: OffloadRecipe;
  /** The engine's environment + invocation beside that collector. */
  engine: OffloadRecipe;
  /**
   * The apply half of auto-tuning: the engine's gitops pull lane delivers a
   * policy repo's mute file to a stable path (GH_DEST) that
   * rateReceiverLookupFile points into. Cloud-agnostic — the recompute half
   * is setup_recurring (github_actions kind writes the same repo).
   */
  autotune: OffloadRecipe;
}

/**
 * The stream topology for Azure surfaces that cannot host a second process:
 * the platform streams its logs to an Event Hub, and one central engine
 * consumes the hub behind a collector, using the same loopback pairing as
 * every other topology.
 *
 * The collector settings are CERTIFIED, not inferred: verified end to end
 * against a live Event Hub (Basic tier) with otelcol-contrib 0.158 and
 * engine 1.1.68 — events returned carrying tenx_hash + routeState with
 * distinct pattern identities per message type. The three prerequisites
 * marked "measured" below are failures observed in that run.
 */
export function azureStreamsRecipe(p: { eventHubNamespace?: string } = {}): AzureStreamsRecipe {
  const ns = p.eventHubNamespace ?? '<namespace>';

  const hub: OffloadRecipe = {
    language: 'text',
    body: `# One hub receives the platform's logs; diagnostic settings route them.
az eventhubs namespace create -g <rg> -n ${ns} -l <region>
az eventhubs eventhub create -g <rg> --namespace-name ${ns} -n logs

# Per resource whose logs should be regulated:
az monitor diagnostic-settings create \\
  --name tenx-stream \\
  --resource <resource-id> \\
  --event-hub-rule <auth-rule-id> \\
  --event-hub logs \\
  --logs '[{"categoryGroup":"allLogs","enabled":true}]'`,
    placementNote:
      'diagnostic settings are per resource, so each Function App or App ' +
      'Service that should be regulated gets one. The hub is the fan-in; ' +
      'the consumer below is the fan-out.',
    prerequisites: [
      'Regulation here is destination-side only: the platform has already emitted, transported, and billed these logs before the engine sees them. Prefer a sidecar or the Lambda extension wherever the platform allows a process.',
    ],
  };

  const collector: OffloadRecipe = {
    language: 'yaml',
    body: `receivers:
  azure_event_hub:
    connection: \${env:EVENTHUB_CONNECTION_STRING}
    group: $Default
    # 'azure' parses the diagnostic-settings envelope. For application logs
    # written straight to the hub use 'raw' -- the azure unmarshaler rejects
    # plain text (measured: "invalid character 'I'").
    format: azure
    # Without a checkpoint every restart replays the retention window
    # (measured: 400 sent, 2,800 delivered across restarts).
    storage: file_storage

  # Return path from the engine (loopback, same pod)
  otlp/tenx:
    protocols:
      grpc:
        endpoint: 127.0.0.1:24225

processors:
  # Only with format: raw -- the payload arrives as a BYTES body, which the
  # engine cannot pattern (every event collapses to ONE identity). Decode
  # restores text; String() is not the fix, it yields base64 (both measured).
  transform/decode:
    log_statements:
      - context: log
        statements:
          - set(log.body, Decode(log.body, "utf-8"))

extensions:
  file_storage:
    directory: /var/lib/otelcol/storage

exporters:
  # Hand-off to the engine (loopback, same pod)
  otlp/tenx:
    endpoint: 127.0.0.1:4317
    tls:
      insecure: true

connectors:
  routing/tenx:
    default_pipelines: [logs/tenx-destination]
    table:
      # context: log is required -- routeState is a LOG attribute
      - context: log
        condition: attributes["routeState"] == "offload"
        pipelines: [logs/tenx-offload]
      - context: log
        condition: attributes["routeState"] == "drop"
        pipelines: [logs/tenx-drop]`,
    placementNote:
      'the same loopback pairing as the Lambda extension and the sidecar: ' +
      'collector hands records to the engine on 127.0.0.1:4317 and receives ' +
      'them back on 127.0.0.1:24225 carrying tenx_hash + routeState.',
    prerequisites: [
      "CERTIFIED against a live Event Hub (otelcol-contrib 0.158, engine 1.1.68): events returned with tenx_hash + routeState and distinct pattern identities per message type.",
      "format must match what the hub carries: 'azure' for diagnostic-settings envelopes, 'raw' for application logs. The azure unmarshaler rejects plain text outright (measured).",
      "With format: raw, wire transform/decode into the intake pipeline before the engine exporter — a bytes body patterns to a single identity, silently (measured).",
      'The azure_event_hub receiver is beta in otelcol-contrib.',
    ],
  };

  const engine: OffloadRecipe = {
    language: 'text',
    body: `# The engine runs beside the collector as peer containers — Azure
# Container Apps, AKS, or any container host:
tenx @run/input/forwarder/otel-collector @apps/receiver

TENX_LICENSE_KEY=<your license JWT>
TENX_AIRGAPPED=true
outputOffload=true
symbolMessageHashField=tenx_hash
log10xMetricsEnabled=false`,
    placementNote:
      'centralized rather than per-node: size the consumer to the hub, not ' +
      "the estate. The hub's partition count caps consumer parallelism.",
    prerequisites: [
      'Offload fetch-back (the Retriever) is AWS-native today; on Azure the offload slice is write-only. tier_down against Azure Monitor (Basic/Auxiliary tables) is the shipped destination-side lever.',
    ],
  };

  const autotune: OffloadRecipe = {
    language: 'text',
    body: `# Add to the engine container above -- the gitops pull lane applies a
# policy repo's per-pattern mutes and hot-reloads on every push:
tenx @run/input/forwarder/otel-collector @apps/receiver @run/receive/rate @gitops

GH_ENABLED=true
GH_TOKEN=<fine-grained PAT, contents:read on the policy repo>
GH_REPO=<org>/<policy-repo>
GH_BRANCH=main
GH_SYNC_INTERVAL=30s
GH_DEST=/tmp/policy
rateReceiverLookupFile=/tmp/policy/test/mutes.csv
rateReceiverFieldNames=message_pattern
TENX_AIRGAPPED=false

# <policy-repo>/test/mutes.csv -- entries are <pattern>,<rate>:<untilEpochSec>:<reason>
pattern,disposition
noisy_heartbeat_ok,0:4102444800:liveness spam OPS-1234`,
    placementNote:
      'the recompute half is setup_recurring with the github_actions kind: a ' +
      'scheduled workflow reads the report, rewrites mutes.csv in the same ' +
      'repo, and the pull lane applies it. No Azure-native scheduler is ' +
      'involved on either half, so the loop is identical on any container host.',
    prerequisites: [
      'Engine 1.1.69 or later. GH_DEST is the load-bearing line: the pull cache lives under a sha-addressed temp path, so without the stable mirror a delivered mute file loads and silently never matches (engine#134, fixed by #135).',
      'CERTIFIED live on the released 1.1.69 image: a git-pushed mute reached the GH_DEST mirror in 23s and enforced on the next reload pass — checkout drop-marked 36/40 with the documented 10% floor, sibling pattern 40/40 untouched, identical to a local-file control.',
      'GH_DEST must be writable by the engine user — the shipped container runs as uid 1000, so a root-level path like /policy fails the launch (measured; the error names a temp file, not the permission). /tmp/policy works out of the box.',
      'rateReceiverLookupFile must be the absolute path inside GH_DEST, mirroring the file’s path in the repo (here: test/mutes.csv).',
      'A past untilEpochSec is not an error: the entry loads, the log names the file, and nothing is muted. 4102444800 is 2100-01-01, a placeholder.',
      'The pull lane needs GitHub egress; the certified composition ran TENX_AIRGAPPED=false.',
      'An Azure Files share in place of the git repo is measured dead on Container Apps, silently: REST uploads change the file without waking the reload poll, and a second SMB client (including a scheduled Job) is denied by the reader mount’s own handle. Deliver policy through the git loop.',
    ],
  };

  return { hub, collector, engine, autotune };
}
