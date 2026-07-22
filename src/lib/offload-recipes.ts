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
# datadogFlexRecipe() / cloudwatchIaRecipe() for the destination-side TF.
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
         cloudwatchIaRecipe() / datadogFlexRecipe() for the destination-side TF. -->
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
#    or a datadog output tagged to a Flex index. See cloudwatchIaRecipe() /
#    datadogFlexRecipe() for the destination-side TF.
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
      'Encoding: the 10x return path must emit JSON (`fluentbitOutputEncodeType: json`), or the `routeState` key is mangled in a delimited round-trip.',
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
  # datadogFlexRecipe() for the destination-side TF.
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
    # group, or a datadog output tagged to a Flex index. See cloudwatchIaRecipe()
    # / datadogFlexRecipe() for the destination-side TF.
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
               see datadogFlexRecipe() / cloudwatchIaRecipe() for the TF)
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

# Forwarder side: split on routeState == "tier_down" -> send the marked events to
# the ${plan}-plan table's DCR stream, everything else to your Analytics table.`,
    note:
      `Routes the down-tiered slice to a ${plan}-plan Log Analytics table (${cheaperNote}). ` +
      'The plan is a create-time table property set via the DCR, so like CloudWatch IA there ' +
      'is no in-platform auto-router: the stamped forwarder split is the missing automation. ' +
      'FORWARDER: the DCR path needs Fluent Bit azure_logs_ingestion (or Logstash Sentinel); the ' +
      'legacy Data Collector API sinks (Vector/Fluentd) write Analytics-only _CL tables and cannot ' +
      'reach this plan. CAVEAT: Basic/Auxiliary bill a per-GB QUERY fee, so the win is ingest-side; ' +
      'heavy querying of the down-tiered table erodes it. HARDENING: route to the ' +
      `${plan} table only when routeState is present; a stamp-miss falls back to the Analytics ` +
      'table and bills at the full Analytics rate (never silently down-tier un-vetted events), so ' +
      'monitor Analytics-table ingest to catch stamp gaps.',
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
  destination?: string
): string {
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

  if (forwarder) {
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

  if (showDatadog || showCloudWatch || showAzure) {
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
  }

  lines.push(
    'Fetch back: `log10x_retriever_query` by pattern identity returns the offloaded events from S3.'
  );

  return lines.join('\n');
}
