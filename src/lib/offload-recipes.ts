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
// fluent-bit  (research shape: rewrite_tag -> s3 output; needs JSON encode)
// ---------------------------------------------------------------------------
function recipeFluentBit(p: OffloadParams): OffloadRecipe {
  const prefix = p.prefix ?? DEFAULT_PREFIX;
  return {
    language: 'ini',
    body: `# 1) retag the dropped slice (KEEP off so the original is consumed)
[FILTER]
    Name          rewrite_tag
    Match         tenx.*
    Rule          $isDropped ^true$ tenx.offload false

# 2) strip the now-constant marker (tenx_hash kept). Match tenx.* spans both
#    the retagged "tenx.offload" and the kept "tenx.*" records (the wildcard
#    crosses dots), so one filter covers both paths.
[FILTER]
    Name          record_modifier
    Match         tenx.*
    Remove_key    isDropped

# 3) dropped slice -> customer-owned S3 as JSONL
[OUTPUT]
    Name          s3
    Match         tenx.offload
    bucket        ${p.bucket}
    region        ${p.region}
    s3_key_format /${prefix}/$UUID.jsonl
    use_put_object On
    json_date_format iso8601

# 4) your existing SIEM output stays Matched on tenx.* (the retagged
#    events no longer carry that tag, so they are not double-sent)`,
    placementNote:
      'the `rewrite_tag` FILTER must sit on the 10x return path (`Match tenx.*`); ' +
      '`isDropped` only exists on post-sidecar records.',
    prerequisites: [
      ...basePrereqs(p),
      'Encoding: the 10x return path must emit JSON (`fluentbitOutputEncodeType: json`), or the `isDropped` key is mangled in a delimited round-trip.',
      'SMOKE TEST REQUIRED: confirm `rewrite_tag` matches the boolean `isDropped` on a real dropped event before relying on this in production.',
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
      'tenx_hash is a LOG attribute; `marshaler: body` alone drops it. The offload pipeline folds attributes into the body (`set(log.body, log.attributes)`), verified to carry tenx_hash with isDropped removed. SMOKE TEST REQUIRED (S3 path): confirm the final S3-object shape (kvlist serialized to JSON by the awss3 body marshaler) against the Retriever ingest once a bucket is wired. Routing + strip + body-fold are already verified live.',
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
  mutate { remove_field => ["isDropped"] }   # marker did its job; tenx_hash kept
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
      'SMOKE TEST REQUIRED: confirm `[isDropped]` truthiness fires on a real dropped event (logstash typing of the boolean).',
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
      'SMOKE TEST REQUIRED: confirm the Route filter `isDropped == true` matches the stamped boolean in Cribl before relying on this.',
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
    body: `resource "datadog_logs_index" "tenx_offload_flex" {
  name = "tenx-offload"

  filter {
    query = "@isDropped:true"   # the slice 10x marked as low-value
  }

  # retention waterfall: 0 days in the premium Standard index, then Flex.
  retention_days      = 0
  flex_retention_days = ${flex}
}`,
    note:
      'Cuts the dominant Datadog INDEX cost (not ingest; the $0.10/GB ingest ' +
      'meter is unchanged) while the slice stays queryable in the same Log ' +
      'Explorer with no rehydration. Schema is a retention waterfall ' +
      '(`retention_days=0` + `flex_retention_days>0`), not a tier toggle, and ' +
      'needs a recent Datadog provider — verify against the live provider before ' +
      'apply. Datadog markets Flex itself; the 10x value is the per-pattern ' +
      'decision (which `pattern_hash` is safe to down-tier), not the routing.',
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

  const iam = forwarderWriteIamPolicy(params);
  lines.push(
    '**Forwarder write access** (the one new IAM grant — the Retriever\'s own role only READS the source bucket):',
    '',
    '```json',
    iam.policyJson,
    '```',
    '',
    iam.attachmentNote,
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
