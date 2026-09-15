/**
 * The ClickHouse offload recipe, and the guard that adding it changed nothing
 * else.
 *
 * The recipe is a copy of a run, not a reading of documentation: the
 * OpenTelemetry Collector config, the DDL and the HyperDX call all come from
 * benchmarks/clickstack-e2e and its results file for 2026-09-14. So the tests
 * here are mostly identity tests. They assert that the lines the run depends on
 * are still the lines being emitted, because every one of them is a finding
 * that a well-meaning rewrite would erase: the S3 engine rejects ALIAS columns,
 * ClickStack's table has no day column, the JSON encoding drops everything but
 * the body and the attributes, and ClickStack's own collector cannot write the
 * objects at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  clickhouseOffloadRecipe,
  clickhouseOffloadHonesty,
  renderClickhouseOffloadSection,
  renderOffloadSection,
  offloadRecipe,
  datadogFlexRecipe,
  cloudwatchIaRecipe,
  azureLogsTierRecipe,
  elasticFrozenTierRecipe,
  coralogixMonitoringRecipe,
  coralogixTcoApiContract,
  forwarderWriteTerraform,
  OFFLOAD_FORWARDERS,
  type ClickhouseCollector,
} from '../src/lib/offload-recipes.js';
import { clickhouseOffloadReadiness } from '../src/tools/doctor.js';

const CH = { bucket: 'tenx-cold-logs', region: 'us-east-1' };
const VARIANTS: ClickhouseCollector[] = ['otel-collector', 'vector'];

// ---------------------------------------------------------------------------
// The recipe renders, both variants
// ---------------------------------------------------------------------------

test('the recipe renders for both collector variants, each with its own DDL', () => {
  for (const v of VARIANTS) {
    const r = clickhouseOffloadRecipe(CH, v);
    assert.equal(r.collector.variant, v);
    assert.ok(r.collector.body.includes(CH.bucket), `${v}: bucket missing`);
    assert.ok(r.collector.body.includes(CH.region), `${v}: region missing`);
    assert.ok(r.ddl.body.includes('ENGINE = Merge('), `${v}: no Merge table`);
    assert.ok(r.hyperdx.body.includes('/sources'), `${v}: no HyperDX source call`);
    assert.ok(r.honesty.length > 0, `${v}: honesty block empty`);
  }
  // Both collectors write body plus a flat attribute map as JSON, so one cold
  // table reads either. Vector can write Parquet on aws_s3 under
  // batch_encoding.codec (v0.55.0, official builds v0.56.0), but no run of ours
  // has exercised it, so no Parquet variant is rendered and there is no second
  // object format to read.
  assert.match(clickhouseOffloadRecipe(CH, 'otel-collector').ddl.body, /'JSONEachRow'/);
  assert.match(clickhouseOffloadRecipe(CH, 'vector').ddl.body, /'JSONEachRow'/);
  assert.ok(!clickhouseOffloadRecipe(CH, 'vector').ddl.body.includes("'Parquet'"));
});

test('both variants ran, and the Vector body says what it wrote and what it did not measure', () => {
  assert.equal(clickhouseOffloadRecipe(CH, 'otel-collector').collector.exercised, true);
  const vector = clickhouseOffloadRecipe(CH, 'vector').collector;
  assert.equal(vector.exercised, true);
  assert.ok(vector.body.includes('COPIED from the harness config that ran end to end'));
  // The arm that ran, and the retreat on the arm that did not.
  assert.ok(vector.body.includes('VECTOR WRITES JSON HERE, AND JSON IS THE ARM THAT RAN'));
  assert.ok(vector.body.includes('run measured nothing about Parquet in Vector'));
  assert.ok(!/^\s*codec: parquet\s*$/m.test(vector.body));
});

test('the collector routes on the route name as a STRING, in the syntax of each tool', () => {
  assert.match(
    clickhouseOffloadRecipe(CH, 'otel-collector').collector.body,
    /condition: attributes\["routeState"\] == "offload"/,
  );
  assert.match(
    clickhouseOffloadRecipe(CH, 'vector').collector.body,
    /cold: '\.attributes\.routeState == "offload"'/,
  );
});

test('the OTel variant carries the three hops the encoding makes necessary', () => {
  const body = clickhouseOffloadRecipe(CH, 'otel-collector').collector.body;
  // Copied verbatim from conf/router.yaml. The JSON encoding writes body and
  // log attributes only, so the record time, the service and the severity are
  // copied into attributes first or the cold rows carry none of them.
  assert.ok(body.includes('mode: body_with_inline_attributes'));
  assert.ok(body.includes('set(log.time_unix_nano, log.observed_time_unix_nano) where log.time_unix_nano == 0'));
  assert.ok(body.includes('groupbyattrs/service:'));
  assert.ok(body.includes('set(log.attributes["TimestampSec"], UnixSeconds(log.time))'));
  assert.ok(body.includes(`set(resource.attributes["s3.prefix"], Concat(["service=", resource.attributes["service.name"]], ""))`));
  assert.ok(body.includes("s3_partition_format: 'day=%Y-%m-%d'"));
  assert.ok(body.includes('resource_attrs_to_s3:'));
  // The reason this runs as a second container at all.
  assert.match(
    clickhouseOffloadRecipe(CH, 'otel-collector').collector.note,
    /NOT `awss3`, `json_log_encoding` or `otlp_encoding`/,
  );
});

test('the Vector sink keys the object path on service and day, in the codec it has', () => {
  const body = clickhouseOffloadRecipe(CH, 'vector').collector.body;
  assert.ok(body.includes('key_prefix: "service={{ svc }}/day=%F/"'));
  assert.ok(body.includes('codec: json'));
  assert.ok(body.includes('method: newline_delimited'));
  // Why object count matters, in the config where the operator will change it.
  assert.ok(body.includes('OBJECT COUNT IS THE QUERY-COST MULTIPLIER'));
});

test('the DDL keeps the four findings the run depends on', () => {
  const ddl = clickhouseOffloadRecipe(CH, 'otel-collector').ddl.body;
  // 1. counts table first, or its materialized view sees nothing
  assert.ok(ddl.indexOf('counts_by_type_hot_mv') < ddl.indexOf('ENGINE = Merge('));
  assert.ok(ddl.includes('RUN THIS FIRST'));
  // 2. ClickStack ships no day column
  assert.ok(ddl.includes('ADD COLUMN IF NOT EXISTS day Date MATERIALIZED toDate(Timestamp)'));
  // 3. the S3 engine rejects ALIAS columns, so the rename is a view and the
  //    Merge table reads the view
  assert.ok(ddl.includes('REJECTS ALIAS COLUMNS'));
  assert.match(ddl, /ENGINE = Merge\(default, '\^\(otel_logs\|otel_logs_coldv\)\$'\)/);
  // 4. the cold counts are a second pass, because offloaded rows never insert
  assert.ok(ddl.includes("'cold'"));
  assert.ok(ddl.includes('INSERT INTO default.counts_by_type'));
  assert.ok(ddl.includes('use_hive_partitioning = 1'));
});

test('HyperDX gets the Merge table as a SECOND source, hot stays default', () => {
  const hdx = clickhouseOffloadRecipe(CH, 'otel-collector').hyperdx;
  assert.ok(hdx.body.includes('/connections'));
  assert.ok(hdx.body.includes('POST http://clickstack:8000/sources'));
  assert.ok(hdx.body.includes('otel_logs_all'));
  assert.match(hdx.note, /hot table STAYS THE DEFAULT SOURCE/);
});

// ---------------------------------------------------------------------------
// The honesty block
// ---------------------------------------------------------------------------

test('the honesty block is present in every render and states what it must', () => {
  const renders = [
    renderClickhouseOffloadSection(CH),
    ...VARIANTS.map((v) => renderClickhouseOffloadSection(CH, v)),
    renderOffloadSection(CH, 'otel-collector', 'clickhouse'),
    renderOffloadSection(CH, null, 'clickhouse'),
  ];
  for (const text of renders) {
    for (const line of clickhouseOffloadHonesty()) {
      if (!line.trim()) continue;
      assert.ok(text.includes(line), `honesty line missing:\n${line.slice(0, 80)}`);
    }
    // the six claims, by their load-bearing words
    assert.match(text, /saving on ClickHouse is the WRITE PATH/);
    assert.match(text, /NO LINE IS DROPPED/);
    assert.match(text, /THE DAY IN THE PATH IS THE UPLOAD DAY, NOT THE RECORD DAY/);
    assert.match(text, /ClickHouse issue 116888/);
    assert.match(text, /s3_list_object_keys_size, default 1000/);
    assert.match(text, /remote_read_min_bytes_for_seek, default 4194304/);
    assert.match(text, /TTL MOVES ARE THE RIGHT TOOL FOR STORAGE/);
    assert.match(text, /ClickHouse issue 85636/);
    assert.match(text, /NO PER-TYPE CPU FIGURE IS A MEASUREMENT/);
    assert.match(text, /searchable in place, through the Merge table, and reading them is SLOWER/);
    assert.match(text, /query filtered only on time opens EVERY cold object/);
    assert.match(text, /14 S3 GET in 118 ms/);
    assert.match(text, /6 S3 GET\s+in 77 ms/);
    assert.match(text, /Count-all dashboards read the counts-per-type table/);
    assert.match(text, /Alerts are NOT claimed unchanged/);
    assert.match(text, /point at THE COUNTS TABLE/);
    assert.match(text, /Never point an alert at the Merge table/);
    assert.ok(!text.includes('point at the Merge table or the counts table'));
    assert.match(text, /THIS RECIPE REQUIRES ENGINE 1\.1\.79 OR NEWER/);
    assert.match(text, /19,436 of 37,519 records on 1\.1\.74/);
    assert.match(text, /37,536 of 37,536 returned records carried\s+`routeState`/);
    assert.match(text, /gap of 0/);
    assert.match(text, /2,495 distinct type hashes/);
    assert.match(text, /no `timeUnixNano`/);
    assert.match(text, /corrupted spellings/);
  }
});

test('the ClickHouse section says offload, never archive, and carries no em dash', () => {
  const text = renderClickhouseOffloadSection(CH);
  assert.ok(!/archiv/i.test(text), 'the ClickHouse section must say offload, never archive');
  assert.ok(!text.includes('—'), 'no em dashes');
});

// ---------------------------------------------------------------------------
// The dispatch block
// ---------------------------------------------------------------------------

test('the dispatch routes a clickhouse offload to the new recipe, alias included', () => {
  for (const dest of ['clickhouse', 'ClickHouse', ' ch ', 'CH', 'clickstack', 'ClickStack']) {
    const text = renderOffloadSection(CH, 'vector', dest);
    assert.ok(text.includes('### 2. The ClickHouse side'), `${dest}: not the ClickHouse recipe`);
    assert.ok(text.includes('ENGINE = Merge('), `${dest}: no Merge table`);
    // The generic section would be wrong here: it writes the Retriever's
    // `{bucket}/app/` JSONL layout and strips routeState on the output path.
    assert.ok(!text.includes('the Retriever indexes that bucket'), `${dest}: generic opener leaked`);
    assert.ok(!text.includes('Fetch back: `log10x_retriever_query`'), `${dest}: generic tail leaked`);
  }
});

test('no other destination reaches the ClickHouse recipe', () => {
  for (const dest of [undefined, 'datadog', 'cloudwatch', 'azure-monitor', 'coralogix', 'elasticsearch', 'splunk']) {
    const text = renderOffloadSection(CH, 'vector', dest);
    assert.ok(!text.includes('### 2. The ClickHouse side'), `${dest}: ClickHouse recipe leaked`);
  }
});

// ---------------------------------------------------------------------------
// Nothing else moved
// ---------------------------------------------------------------------------

/**
 * Byte-identity snapshot of every recipe that existed before the ClickHouse one
 * was added, taken on the parent commit. A change to any of these is a change
 * to a config a customer has already applied, so it fails here and has to be
 * intentional.
 */
const BASELINE: Record<string, string> = {
  datadogFlexRecipe: 'b3b45e52c6a24626',
  cloudwatchIaRecipe: '71daf19b1ff60147',
  'azureLogsTierRecipe.basic': '9a0c878895b4dfca',
  'azureLogsTierRecipe.aux': 'de87bc671d7264ff',
  elasticFrozenTierRecipe: 'e9b1e55c341a7060',
  coralogixMonitoringRecipe: '8a6da4b70815abe3',
  coralogixTcoApiContract: '835216577057de80',
  'offloadRecipe.vector': '0d706eb3869c241e',
  'offloadRecipe.fluentd': '78d0249acf9f1cc5',
  'offloadRecipe.fluent-bit': 'd25142048eb7cc73',
  'offloadRecipe.otel-collector': 'd12563720dda1c89',
  'offloadRecipe.logstash': 'c724edcc895a7f6e',
  'offloadRecipe.cribl': '617a7ef8a96e455a',
  'renderOffloadSection.none': '359fe8db2834b632',
  'renderOffloadSection.nofwd.none': '8e31f26af8e3465b',
  'renderOffloadSection.datadog': '6eddaa0847ae4df9',
  'renderOffloadSection.nofwd.datadog': '6320b51ae98aea31',
  'renderOffloadSection.cloudwatch': '57b34b496d634791',
  'renderOffloadSection.nofwd.cloudwatch': '32c78915bfdaf9c6',
  'renderOffloadSection.azure-monitor': 'a53491e6c52d1be4',
  'renderOffloadSection.nofwd.azure-monitor': '1660741eeb677ae5',
  'renderOffloadSection.coralogix': '8f2628944a16400e',
  'renderOffloadSection.nofwd.coralogix': 'e1f5e644ce59341e',
  'renderOffloadSection.elasticsearch': '4fddcc7ab38308ce',
  'renderOffloadSection.nofwd.elasticsearch': '0d500c602ef7788f',
  'renderOffloadSection.splunk': 'e0454f3735c37064',
  'renderOffloadSection.nofwd.splunk': 'd9b502894d9e2057',
  forwarderWriteTerraform: '33fbf1f20045b799',
};

test('every pre-existing recipe is byte-identical to the parent commit', () => {
  const P = { bucket: 'tenx-demo-cloud-retriever-351939435334', region: 'us-east-1' };
  const h = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
  const actual: Record<string, string> = {
    datadogFlexRecipe: h(JSON.stringify(datadogFlexRecipe())),
    cloudwatchIaRecipe: h(JSON.stringify(cloudwatchIaRecipe())),
    'azureLogsTierRecipe.basic': h(JSON.stringify(azureLogsTierRecipe())),
    'azureLogsTierRecipe.aux': h(JSON.stringify(azureLogsTierRecipe({ plan: 'Auxiliary' }))),
    elasticFrozenTierRecipe: h(JSON.stringify(elasticFrozenTierRecipe())),
    coralogixMonitoringRecipe: h(JSON.stringify(coralogixMonitoringRecipe())),
    coralogixTcoApiContract: h(JSON.stringify(coralogixTcoApiContract())),
    forwarderWriteTerraform: h(forwarderWriteTerraform()),
  };
  for (const f of OFFLOAD_FORWARDERS) actual[`offloadRecipe.${f}`] = h(JSON.stringify(offloadRecipe(f, P)));
  for (const d of [undefined, 'datadog', 'cloudwatch', 'azure-monitor', 'coralogix', 'elasticsearch', 'splunk']) {
    actual[`renderOffloadSection.${d ?? 'none'}`] = h(renderOffloadSection(P, 'vector', d));
    actual[`renderOffloadSection.nofwd.${d ?? 'none'}`] = h(renderOffloadSection(P, null, d));
  }
  assert.deepEqual(actual, BASELINE);
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

// The five objects the recipe creates, plus the hot table ClickStack ships.
const TABLES_ALL = [
  'otel_logs',
  'otel_logs_cold',
  'otel_logs_coldv',
  'otel_logs_all',
  'counts_by_type',
  'counts_by_type_hot_mv',
];

test('doctor reports missing ClickHouse tables without throwing', async () => {
  const check = await clickhouseOffloadReadiness({
    listTables: async () => ['otel_logs'],
    listObjects: async () => [{ Key: 'service=cart/day=2026-09-14/logs_1.json' }],
    database: 'default',
    store: { kind: 's3', container: 'tenx-cold-logs' },
  });
  assert.equal(check.name, 'clickhouse_offload_readiness');
  assert.equal(check.status, 'warn');
  // Every object the recipe creates is reported, not just the Merge table.
  assert.match(check.message, /5 of 6 tables missing/);
  for (const name of ['otel_logs_cold', 'otel_logs_coldv', 'otel_logs_all', 'counts_by_type', 'counts_by_type_hot_mv']) {
    assert.match(check.message, new RegExp(`\`default\\.${name}\`: MISSING`), `${name} not reported`);
  }
  assert.match(check.message, /`default\.otel_logs`: present/);
  assert.ok(check.fix && check.fix.length > 0);
});

test('doctor survives a ClickHouse that cannot be read at all', async () => {
  const check = await clickhouseOffloadReadiness({
    listTables: async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8123');
    },
    listObjects: async () => {
      throw new Error('offload bucket does not exist: tenx-cold-logs');
    },
    database: 'default',
    store: { kind: 's3', container: 'tenx-cold-logs' },
  });
  assert.equal(check.status, 'warn');
  assert.match(check.message, /could not read the database/);
  assert.match(check.message, /ECONNREFUSED/);
  assert.match(check.message, /NOT READ/);
});

test('doctor passes when every table is present and the bucket lists', async () => {
  const check = await clickhouseOffloadReadiness({
    listTables: async () => TABLES_ALL,
    listObjects: async () => [
      { Key: 'service=cart/day=2026-09-14/logs_1.json' },
      { Key: 'service=kafka/day=2026-09-14/logs_2.json' },
    ],
    database: 'default',
    store: { kind: 's3', container: 'tenx-cold-logs' },
  });
  assert.equal(check.status, 'pass');
  assert.match(check.message, /every table the recipe needs is present/);
  assert.match(check.message, /reachable, 2 objects/);
  assert.equal(check.fix, undefined);
});

test('doctor says so when no offload bucket is configured, and still reads the tables', async () => {
  const check = await clickhouseOffloadReadiness({
    listTables: async () => TABLES_ALL,
    listObjects: async () => {
      throw new Error('listObjects must not be called without a store');
    },
    database: 'default',
  });
  assert.equal(check.status, 'warn');
  assert.match(check.message, /offload bucket: not configured/);
  assert.match(check.message, /`default\.otel_logs_all`: present/);
});

// ---------------------------------------------------------------------------
// The config has to be loadable, and the header has to be true
// ---------------------------------------------------------------------------

test('every receiver a pipeline names is declared in the receivers block', () => {
  // A pipeline naming a receiver the file does not define is a collector that
  // refuses to start, and the operator sees it as our config being broken.
  const body = clickhouseOffloadRecipe(CH, 'otel-collector').collector.body;
  const declared = new Set<string>();
  const receiversBlock = body.slice(body.indexOf('\nreceivers:'), body.indexOf('\nprocessors:'));
  for (const line of receiversBlock.split('\n')) {
    const m = /^ {2}([A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)?):\s*$/.exec(line);
    if (m) declared.add(m[1]);
  }
  assert.ok(declared.has('otlp/back'), 'otlp/back missing');
  assert.ok(declared.has('otlp'), 'the placeholder otlp receiver is not declared');
  assert.ok(declared.has('filelog'), 'the placeholder filelog receiver is not declared');
  for (const m of body.matchAll(/^ {6}receivers: \[ ([^\]]+) \]$/gm)) {
    for (const name of m[1].split(',').map((s) => s.trim())) {
      if (name === 'routing/state') continue; // a connector, declared as one
      assert.ok(declared.has(name), `pipeline names an undeclared receiver: ${name}`);
    }
  }
  // And the placeholders say what they are, in the config itself.
  assert.ok(body.includes('PLACEHOLDERS, REPLACE BOTH'));
});

test('the copy header lists every substitution, not just the endpoints', () => {
  const body = clickhouseOffloadRecipe(CH, 'otel-collector').collector.body;
  assert.ok(!body.includes('COPIED VERBATIM'), 'the body is not verbatim, so it must not claim to be');
  for (const substitution of [
    'cse-engine:4317',
    'cse-clickstack:4317',
    'coldlogs',
    'http://cse-minio:9000',
    'minio:9000',
    'measurement tap',
  ]) {
    assert.ok(body.includes(substitution), `substitution not disclosed: ${substitution}`);
  }
  // The DDL discloses its own two: the S3 URL and the credentials.
  const ddl = clickhouseOffloadRecipe(CH, 'otel-collector').ddl.body;
  assert.ok(ddl.includes("'http://cse-minio:9000/coldlogs/**.json'"));
  assert.ok(ddl.includes('MinIO root credentials'));
  assert.ok(ddl.includes("'<access-key>', '<secret-key>'"));
});

test('a Vector-only render reads the same cold table and renders no Parquet variant', () => {
  const text = renderClickhouseOffloadSection(CH, 'vector');
  assert.ok(!text.includes('The JSON variant above'));
  assert.ok(text.includes("/tenx-cold-logs/**.json', '<access-key>', '<secret-key>', 'JSONEachRow')"));
  assert.ok(!text.includes("'Parquet')"));
  assert.ok(text.includes('VECTOR WRITES JSON HERE, AND JSON IS THE ARM THAT RAN'));
  assert.ok(!text.includes('Vector will not write Parquet'));
});

test('the write-path claim is attributed to the measurement that made it', () => {
  // This harness measured no write path, no bill and no autoscaler, so the one
  // sentence carrying the product claim names where it does come from.
  const text = renderClickhouseOffloadSection(CH);
  assert.match(text, /compute-vs-rows arms in benchmarks\/clickhouse-clickstack \(benchmarks PR #10\)/);
  assert.match(text, /measured no write path, no bill and no autoscaler/);
});
