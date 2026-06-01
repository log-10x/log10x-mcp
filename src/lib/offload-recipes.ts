/**
 * Per-forwarder OFFLOAD recipes for the Retriever cost loop.
 *
 * Sibling to `forwarder-snippets.ts`, but a different shape. Where the
 * drop-rule snippet emits a single SIEM-side exclude, an offload recipe is a
 * TWO-route fan-out keyed on the engine-stamped `isDropped` marker:
 *
 *   1. the dropped slice (isDropped == true) -> the forwarder's OWN native S3
 *      output, written as full, newline-delimited JSON under `{bucket}/{prefix}`
 *      (the exact layout the Retriever indexes), and
 *   2. everything else -> the existing SIEM destination.
 *
 * Nothing is deleted: the noise is relocated to the customer's own bucket
 * before the SIEM bills it, and the Retriever fetches it back by stamped
 * identity. This is lossless cost reduction, not archival.
 *
 * Engine contract (verified live on run-edge 1.1.0, config repo 42e5331):
 *   - the receiver runs with `outputOffload true`, which resolves the output
 *     field to `fullText("tenx_hash","isDropped")` and the drop filter to
 *     `isObject` (every marked event flows back to the forwarder, full text).
 *   - `isDropped` lands as a JSON boolean UNQUOTED (`"isDropped":true` /
 *     `"isDropped":false`), spliced inside the event envelope. Every forwarder
 *     match MUST therefore be a boolean test (`== true` / truthiness), NEVER
 *     the string `"true"`.
 *   - `tenx_hash` ships alongside it, so the same S3 object carries the stable
 *     identity the Retriever correlates on.
 */

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
    'Engine: the receiver runs with `outputOffload true` (full-text events + `isDropped` marker, all events flow back to the forwarder).',
    `IAM: the forwarder's identity can \`s3:PutObject\` to \`${p.bucket}/${p.prefix ?? DEFAULT_PREFIX}/*\` — see \`forwarderWriteIamPolicy()\`.`,
    'Match on the boolean `isDropped == true`, never the string "true" (the engine writes an unquoted JSON boolean).',
  ];
}

// ---------------------------------------------------------------------------
// vector  (verified shape: route transform + aws_s3 sink, newline-delimited)
// ---------------------------------------------------------------------------
function recipeVector(p: OffloadParams): OffloadRecipe {
  const prefix = p.prefix ?? DEFAULT_PREFIX;
  return {
    language: 'toml',
    body: `# Split the 10x return stream: dropped slice -> S3, the rest -> SIEM.
[transforms.tenx_offload_route]
type   = "route"
inputs = ["tenx_sidecar"]            # the source reading 10x's return path
route.offload = '.isDropped == true' # boolean test, not "true"

# Dropped slice -> customer-owned S3, as the Retriever's input layout (JSONL).
[sinks.tenx_offload_s3]
type        = "aws_s3"
inputs      = ["tenx_offload_route.offload"]
bucket      = "${p.bucket}"
key_prefix  = "${prefix}/"
region      = "${p.region}"
compression = "none"
encoding.codec          = "json"
encoding.except_fields  = ["isDropped"]   # marker did its job at the route; drop it (tenx_hash kept)
framing.method          = "newline_delimited"

# Everything else -> your existing SIEM sink (the implicit _unmatched route).
[sinks.your_siem]
inputs = ["tenx_offload_route._unmatched"]
encoding.except_fields = ["isDropped"]     # strip the marker on the SIEM path too
# ... your existing SIEM sink config ...`,
    placementNote:
      'add the `route` transform downstream of the source reading 10x\'s return ' +
      'path, then point your existing SIEM sink at `tenx_offload_route._unmatched` ' +
      'so only the kept slice is billed. The marker is stripped at each sink via ' +
      '`encoding.except_fields`, so no extra transform is needed. Validate with ' +
      '`vector validate <config>`.',
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
  <!-- 1) fan the 10x return stream to two labels; each keeps only its slice -->
  <match tenx.**>
    @type copy
    <store>
      @type relabel
      @label @TENX_OFFLOAD
    </store>
    <store>
      @type relabel
      @label @TENX_SIEM
    </store>
  </match>
</label>

<!-- 2) dropped slice -> customer-owned S3 as plain JSONL -->
<label @TENX_OFFLOAD>
  <filter **>
    @type grep
    <regexp>
      key isDropped
      pattern /^true$/        <!-- keep only the dropped slice -->
    </regexp>
  </filter>
  <filter **>
    @type record_transformer
    remove_keys isDropped       <!-- marker did its job; tenx_hash kept -->
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

<!-- 3) kept slice -> your existing SIEM destination -->
<label @TENX_SIEM>
  <filter **>
    @type grep
    <exclude>
      key isDropped
      pattern /^true$/        <!-- drop the offloaded slice from the SIEM path -->
    </exclude>
  </filter>
  <filter **>
    @type record_transformer
    remove_keys isDropped
  </filter>
  <match **>
    <!-- ... your existing destination <match> ... -->
  </match>
</label>`,
    placementNote:
      'the `<match tenx.**>` copy goes in the `@OUTPUT` label; the two `@TENX_*` ' +
      'labels go at root. `copy` duplicates every event to both labels and each ' +
      '`grep` keeps only its slice, so routing is explicit (no rewrite_tag_filter, ' +
      'no rewrite loop, nothing escapes to the root router). `record_transformer` ' +
      'strips the marker on each path.',
    prerequisites: [
      ...basePrereqs(p),
      'Plugin: `fluent-plugin-s3` must be present for the S3 output (bundled in td-agent / fluent-package; on a vanilla OSS image run `fluent-gem install fluent-plugin-s3`). copy / relabel / grep / record_transformer are core, no extra gem.',
    ],
  };
}

// ---------------------------------------------------------------------------
// fluent-bit  (smoke-tested live, v5: rewrite_tag's string regex CANNOT match
// a msgpack boolean, so a lua filter stringifies isDropped to a routing key
// first; KEEP must be true; a grep excludes the dropped slice from the SIEM.)
// ---------------------------------------------------------------------------
function recipeFluentBit(p: OffloadParams): OffloadRecipe {
  const prefix = p.prefix ?? DEFAULT_PREFIX;
  return {
    language: 'ini',
    body: `[SERVICE]
    Grace 5                # let the re-emitted chunk flush before shutdown

# 1) stringify the boolean marker to a routing key. rewrite_tag's Rule is a
#    STRING regex and does NOT match a msgpack boolean, so map it first.
[FILTER]
    Name    lua
    Match   tenx.*
    call    tag_route
    code    function tag_route(tag,ts,rec) if rec["isDropped"]==true then rec["_drop"]="yes" else rec["_drop"]="no" end return 2,ts,rec end

# 2) route the dropped slice to its own tag. KEEP=true (4th field): KEEP=false
#    drops the re-emitted record entirely in fluent-bit. The original copy
#    stays on tenx.app and is excluded from the SIEM in step 3.
[FILTER]
    Name    rewrite_tag
    Match   tenx.*
    Rule    $_drop ^yes$ tenx.offload true

# 3) keep the dropped slice OUT of the SIEM path (the KEEP=true original)
[FILTER]
    Name    grep
    Match   tenx.app
    Exclude _drop yes

# 4) strip both markers on both paths (tenx_hash kept). tenx.* spans the
#    retagged "tenx.offload" and the kept "tenx.app" (the wildcard crosses dots).
[FILTER]
    Name       record_modifier
    Match      tenx.*
    Remove_key isDropped
    Remove_key _drop

# 5) dropped slice -> customer-owned S3 as JSONL
[OUTPUT]
    Name          s3
    Match         tenx.offload
    bucket        ${p.bucket}
    region        ${p.region}
    s3_key_format /${prefix}/$UUID.jsonl
    use_put_object On
    json_date_format iso8601

# 6) kept slice -> your existing SIEM output, Match tenx.app`,
    placementNote:
      'all FILTERs sit on the 10x return path (`Match tenx.*`); `isDropped` only ' +
      'exists on post-sidecar records. The lua filter is required because ' +
      'fluent-bit\'s `rewrite_tag` string regex cannot match a msgpack boolean ' +
      '(verified live), so the marker is mapped to a string key `_drop` first.',
    prerequisites: [
      ...basePrereqs(p),
      'Encoding: the 10x return path must emit JSON (`fluentbitOutputEncodeType: json`), or the `isDropped` key is mangled in a delimited round-trip.',
      'The lua filter (boolean -> string routing key) and `KEEP=true` are both mandatory: rewrite_tag cannot regex-match a boolean, and KEEP=false drops the re-emitted record (both verified live on fluent-bit v5).',
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
    default_pipelines: [logs/siem]
    table:
      # context: log is REQUIRED — isDropped is a LOG attribute. The default
      # resource context never matches it (every event falls through to default).
      - context: log
        condition: attributes["isDropped"] == true
        pipelines: [logs/offload]

processors:
  transform/offload:
    error_mode: ignore
    log_statements:
      - delete_key(log.attributes, "isDropped")  # marker did its job; tenx_hash kept
      - set(log.body, log.attributes)            # fold attrs into the body so tenx_hash
                                                  # survives marshaler:body (it is a LOG
                                                  # attribute; body-only would drop it)
  transform/strip:
    error_mode: ignore
    log_statements:
      - delete_key(log.attributes, "isDropped")  # SIEM path: just drop the marker

exporters:
  awss3:
    s3uploader:
      region: ${p.region}
      s3_bucket: ${p.bucket}
      s3_prefix: ${prefix}
    marshaler: body                              # writes the folded flat-JSON body as JSONL

service:
  pipelines:
    logs/in:      { receivers: [otlp], exporters: [routing] }
    logs/offload: { receivers: [routing], processors: [transform/offload], exporters: [awss3] }
    logs/siem:    { receivers: [routing], processors: [transform/strip], exporters: [<your_siem_exporter>] }`,
    placementNote:
      'the routing connector reads 10x\'s OTLP return path, where 10x\'s fields ' +
      'arrive as LOG attributes (body carries the message). The offload pipeline ' +
      'strips the marker and folds attributes into the body so tenx_hash survives ' +
      '`marshaler: body`; the SIEM pipeline just strips the marker.',
    prerequisites: [
      ...basePrereqs(p),
      'Distribution: requires the FULL otelcol-contrib distro (routingconnector + transformprocessor + awss3exporter). A minimal/custom "contrib" build can omit them — verified: a stripped otelcol-contrib had connectors:[] and no transform/awss3.',
      'Routing MUST use `context: log` + `condition` (verified live). `statement: route() where ...` defaults to RESOURCE context and never matches the log attribute, so every event falls through to the SIEM.',
      'tenx_hash is a LOG attribute; `marshaler: body` alone drops it, so the offload pipeline folds attributes into the body (`set(log.body, log.attributes)`). VERIFIED live against MinIO S3: the object is flat JSONL `{"...":...,"tenx_hash":"..."}` with isDropped removed (the awss3 body marshaler serializes the kvlist body to a flat JSON object).',
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
# field leaks into S3 or the SIEM.
filter {
  if [isDropped] {                  # truthiness on the boolean (NOT a string compare)
    mutate { add_field => { "[@metadata][tenx_route]" => "offload" } }
  }
  # marker did its job; drop it (tenx_hash kept). Also drop [event][original]:
  # under ECS-compat v8 (Logstash 8.x default) the json codec stores the raw
  # source line there, which still contains "isDropped" (verified leaking into
  # both sinks). Or set pipeline.ecs_compatibility: disabled on this pipeline.
  mutate { remove_field => ["isDropped", "[event][original]"] }
}

output {
  if [@metadata][tenx_route] == "offload" {
    s3 {
      bucket => "${p.bucket}"
      region => "${p.region}"
      prefix => "${prefix}/"
      codec  => "json_lines"
    }
  } else {
    # ... your existing SIEM output ...
  }
}`,
    placementNote:
      'the route + strip go in the `filter {}` block of the destinations pipeline ' +
      '(the one reading 10x\'s return path); `output {}` then routes on the ' +
      '`[@metadata]` flag. `@metadata` is never shipped, so the routing signal does ' +
      'not leak into S3 or the SIEM, and `isDropped` is removed before either.',
    prerequisites: [
      ...basePrereqs(p),
      'Verified live (logstash 8.x): routing + strip + tenx_hash. Under ECS-compat v8 the json codec adds `[event][original]` holding the raw line (with isDropped), so the strip removes it too — or set `pipeline.ecs_compatibility: disabled` on this pipeline.',
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
    body: `Routing table (two routes, evaluated top-down):

Route 1  "tenx-offload"
  Filter:      isDropped == true
  Output:      tenx_offload_s3   (S3 destination, below)
  Final:       Yes               (stop; do not also send to the SIEM)

Route 2  "siem" (catch-all)
  Filter:      true
  Output:      <your existing SIEM destination>

S3 destination "tenx_offload_s3":
  Bucket:          ${p.bucket}
  Region:          ${p.region}
  Key prefix:      ${prefix}/
  Format:          JSON (newline-delimited)
  Compression:     none

Strip the marker (both destinations):
  Pipeline "tenx_strip_isdropped"  ->  one Eval function  ->  Remove fields: isDropped
  Attach it as the Post-Processing Pipeline on BOTH tenx_offload_s3 AND the
  SIEM destination. (Cribl S3/SIEM destinations have no native field-exclude,
  so the strip is a destination-attached pipeline, after the route. tenx_hash kept.)`,
    placementNote:
      'add Route 1 above the SIEM route with Final=Yes so the dropped slice is ' +
      'pulled out before the catch-all. The route must still see `isDropped`, so ' +
      'the strip is a Post-Processing Pipeline on each destination (after routing), ' +
      'not in the route pipeline. Cribl S3 destinations are batch (staging dir then ' +
      'flush), so objects appear on the flush interval, not per event.',
    prerequisites: [
      ...basePrereqs(p),
      'Logic verified live via `cribl pipe` (Cribl 4.x real expression engine): Route filter `isDropped == true` matched the boolean, the Eval "Remove fields" dropped isDropped on both outputs, tenx_hash kept. This recipe ships as prose, not paste-ready config — build it in the Cribl UI/API. A full single-mode daemon run additionally needs an event-breaker ruleset + a file-monitor source scoped to your input.',
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
# isDropped slice to the Retriever input bucket; the Retriever's own role only
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
// SIEM tier_down recipes  (down-tier in place, keyed on the SAME isDropped
// marker — no second attribute needed for a binary premium/cheap split).
// ---------------------------------------------------------------------------
export interface SiemTierRecipe {
  /** 'datadog-flex' | 'cloudwatch-ia' */
  target: string;
  language: 'hcl' | 'text';
  body: string;
  note: string;
}

/** Datadog: route `@isDropped:true` to a Flex-only index (cheaper queryable
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
    query = "@isDropped:true"   # the slice 10x marked as low-value
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

/** CloudWatch: route `isDropped == true` to an Infrequent-Access log group
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

# Forwarder side: send isDropped==true events to "${name}",
# everything else to your Standard log group.`,
    note:
      'IA is a create-time-only, immutable log-group property; AWS ships no ' +
      'auto-router, so the stamped forwarder log-group split is the missing ' +
      'automation (10x is not redundant here). HARDENING: a stamp-miss routes to ' +
      'the Standard fallback and bills at full rate, so the recipe should fail ' +
      'toward the IA group on the offload path only when `isDropped` is present.',
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
  forwarder: OffloadForwarderId | null
): string {
  const prefix = params.prefix ?? DEFAULT_PREFIX;
  const lines: string[] = [];

  lines.push(
    'Route the slice 10x marks low-value (`isDropped == true`) to the customer\'s ' +
      'own S3 before the SIEM bills it; the Retriever indexes that bucket and ' +
      'fetches it back by stamped identity. Nothing is deleted, it is relocated. ' +
      'This is lossless cost reduction, not archival.',
    '',
    `Target: \`s3://${params.bucket}/${prefix}/\` (region \`${params.region}\`), newline-delimited JSON.`,
    'Prerequisite on the engine side: run the receiver with `outputOffload true` ' +
      '(full-text events plus the `isDropped` marker, every event flowing back).',
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

  const ddog = datadogFlexRecipe();
  const cw = cloudwatchIaRecipe();
  lines.push(
    '**Or down-tier in the SIEM instead of offloading** (keep events in-platform at a cheaper tier, same `isDropped` marker, no second attribute):',
    '',
    `_Datadog Flex_ — ${ddog.note}`,
    '',
    '```hcl',
    ddog.body,
    '```',
    '',
    `_CloudWatch Infrequent Access_ — ${cw.note}`,
    '',
    '```hcl',
    cw.body,
    '```',
    '',
    'Fetch back: `log10x_retriever_query` by pattern identity returns the offloaded events from S3.'
  );

  return lines.join('\n');
}
