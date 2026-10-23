/**
 * The hot-tier run: an Elasticsearch hot tier held under a size. The reads go
 * through a fake cluster that answers the exact requests the run sends; the
 * plan is checked against the arithmetic it states (the hot tier settles at or
 * under S once the lines on hot have aged out).
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePolicyYaml, PolicyLoadError } from '../src/lib/policy-loader.js';
import { emitPolicyYaml, emitK8sCronJob, emitGitHubActions } from '../src/lib/scheduler-manifest-emitter.js';
import { esDurationHours, ilmHotHours, planHotTier, readHotTierInputs, type EsRequest, type HotTierReads } from '../src/lib/elastic-budget-tick.js';
import { receiverFleetValues, ELASTIC_HOT_TIER_FIELDS } from '../src/lib/fleet-default-install.js';
import { RECEIVER_FORWARDER_SPECS } from '../src/lib/advisor/reporter-forwarders.js';
import * as tick from '../src/lib/recurring-tick.js';

const GB = 1e9;
const NOW = 1_792_660_000;

test('Elasticsearch durations and the hours a policy keeps an index on hot', () => {
  assert.equal(esDurationHours('1h'), 1);
  assert.equal(esDurationHours('30d'), 720);
  assert.equal(esDurationHours('90m'), 1.5);
  assert.equal(esDurationHours('0ms'), 0);
  assert.equal(esDurationHours('soon'), undefined);
  const h = ilmHotHours({ phases: { hot: { actions: { rollover: { max_age: '1d' } } }, frozen: { min_age: '6d', actions: {} }, delete: { min_age: '30d' } } });
  assert.equal(h?.hours, 24 + 144);
  assert.equal(ilmHotHours({ phases: { hot: { actions: { rollover: { max_primary_shard_size: '50gb' } } }, frozen: { min_age: '1d' } } }), undefined);
  assert.equal(ilmHotHours({ phases: { hot: { actions: { rollover: { max_age: '30d' } } } } }), undefined);
});

function policyText(extra: string, plane = '  delivery: configmap\n  namespace: logging'): string {
  return ['schema_version: "1.0"', 'reduction:', '  target_services: []', extra, '  exceptions: []', 'config_plane:', '  repo: /tmp/x', plane, ''].join('\n');
}

test('policy: hot_tier_gb as GB or auto, and alone', () => {
  const p = parsePolicyYaml(policyText('  hot_tier_gb: 120'));
  assert.equal(p.hot_tier?.gb, 120);
  assert.equal(p.hot_tier?.capacity_share, 0.8);
  assert.equal(p.hot_tier?.pass_alias, 'tenx-app');
  assert.equal(p.hot_tier?.default_action, 'tier_down');
  assert.equal(p.config_plane.delivery, 'configmap');
  const a = parsePolicyYaml(policyText('  hot_tier_gb: auto\n  hot_retention_hours: 72'));
  assert.equal(a.hot_tier?.gb, undefined);
  assert.equal(a.hot_tier?.retention_hours, 72);
  assert.throws(() => parsePolicyYaml(policyText('  hot_tier_gb: lots')), PolicyLoadError);
  assert.throws(() => parsePolicyYaml(policyText('  hot_tier_gb: 10\n  budget_usd_monthly: 5\n  standard_indexes:\n    - main')), /different goals/);
  assert.throws(() => parsePolicyYaml(policyText('  hot_tier_gb: 10\n  hot_tier_share: 1.2')), PolicyLoadError);
});

test('setup writes a hot-tier policy the loader reads, hourly, with Elasticsearch credentials', () => {
  for (const scheduler of ['k8s_cron', 'github_actions'] as const) {
    const opts = { target_services: [], target_percent: 30, scheduler, config_plane: '/tmp/repo', exceptions: [], min_delta_pp: 2, hot_tier_gb: 'auto' as const };
    const y = emitPolicyYaml(opts);
    const p = parsePolicyYaml(y);
    assert.ok(p.hot_tier, scheduler);
    assert.equal(p.hot_tier?.gb, undefined);
    assert.equal(p.cron_utc, '0 * * * *');
    assert.equal(p.config_plane.delivery, scheduler === 'k8s_cron' ? 'configmap' : 'gitops');
    const manifest = scheduler === 'k8s_cron' ? emitK8sCronJob(opts) : emitGitHubActions(opts);
    assert.match(manifest, /LOG10X_ES_URL/);
    assert.doesNotMatch(manifest, /DD_API_KEY/);
  }
});

test('an Elasticsearch Receiver for the hot-tier run stamps the counted size, and never renders the Elastic metric output', () => {
  const v = receiverFleetValues({ datadog: false, unit: 'bytes', elasticHotTier: true });
  assert.deepEqual(v.options.find(([k]) => k === 'outputEncodeField'), ['outputEncodeField', ELASTIC_HOT_TIER_FIELDS]);
  assert.deepEqual(v.options.find(([k]) => k === 'symbolMessageHashField'), ['symbolMessageHashField', 'tenx_hash']);
  assert.match(ELASTIC_HOT_TIER_FIELDS, /"utf8Size"/);
  const yaml = RECEIVER_FORWARDER_SPECS.fluentbit.renderValues({
    releaseName: 'r', licenseJwt: '', destination: 'elasticsearch', builtinLicense: true, airgapped: true,
    licenseSecretName: 's', licenseSecretKey: 'k', backends: ['elastic'], engineOptions: v.options, engineEnv: v.env,
  });
  assert.doesNotMatch(yaml, /@run\/output\/metric\/elastic/);
  assert.match(yaml, /utf8Size/);
});

/** A cluster with one hot node, one frozen node, the Receiver's aliases and three statements. */
function fakeCluster(opts: { hotStore: number; hotDisk: number; passStore: number; passCounted: number; tdStore?: number; tdCounted?: number; statements: Array<{ c: string; h: string; r: string; bytes: number; n?: string; v?: string }>; spanHours?: number }) {
  const calls: string[] = [];
  const span = opts.spanHours ?? 24;
  const req: EsRequest = async (method, path, body: any) => {
    calls.push(`${method} ${path}`);
    const p = path.split('?')[0];
    if (p === '/_nodes') return { nodes: { hot1: { name: 'hot1', roles: ['data_hot', 'data_content', 'ingest', 'master'] }, frz1: { name: 'frz1', roles: ['data_frozen'] } } };
    if (p === '/_nodes/hot1/stats/fs,indices') return { nodes: { hot1: { fs: { total: { total_in_bytes: opts.hotDisk } }, indices: { store: { size_in_bytes: opts.hotStore } } } } };
    if (p === '/_alias/tenx-app,tenx-tierdown')
      return {
        'tenx-app-000001': { aliases: { 'tenx-app': {} } },
        'tenx-tierdown-000003': { aliases: { 'tenx-tierdown': { is_write_index: true } } },
        'partial-tenx-tierdown-000002': { aliases: { 'tenx-tierdown': {} } },
      };
    if (p === '/tenx-app-000001/_stats/store') return { indices: { 'tenx-app-000001': { total: { store: { size_in_bytes: opts.passStore } } } } };
    if (p === '/tenx-tierdown-000003/_stats/store') return { indices: { 'tenx-tierdown-000003': { total: { store: { size_in_bytes: opts.tdStore ?? 0 } } } } };
    if (p === '/tenx-app-000001/_search' && body?.aggs?.b) return { aggregations: { b: { value: opts.passCounted } } };
    if (p === '/tenx-tierdown-000003/_search' && body?.aggs?.b) return { aggregations: { b: { value: opts.tdCounted ?? 0 } } };
    if (p === '/tenx-app/_settings/index.lifecycle.name') return { 'tenx-app-000001': { settings: { 'index.lifecycle.name': 'tenx-keep' } } };
    if (p === '/tenx-tierdown/_settings/index.lifecycle.name') return { 'tenx-tierdown-000003': { settings: { 'index.lifecycle.name': 'tenx-tier-down' } } };
    if (p === '/_ilm/policy/tenx-keep') return { 'tenx-keep': { policy: { phases: { hot: { actions: { rollover: { max_age: '1h' } } }, frozen: { min_age: '9h', actions: {} } } } } };
    if (p === '/_ilm/policy/tenx-tier-down') return { 'tenx-tier-down': { policy: { phases: { hot: { actions: { rollover: { max_age: '1h' } } }, frozen: { min_age: '1m', actions: {} } } } } };
    if (p === '/partial-tenx-tierdown-000002/_ilm/explain')
      // index_creation_date_millis on a mounted index is the original creation: a trap the run must not read.
      return { indices: { 'partial-tenx-tierdown-000002': { lifecycle_date_millis: (NOW - 7200) * 1000, index_creation_date_millis: (NOW - 10800) * 1000, phase: 'frozen', step: 'complete', step_time_millis: (NOW - 7200 + 2100) * 1000 } } };
    if (p.startsWith('/tenx-app/_mapping/field/')) {
      const f = decodeURIComponent(p.split('/').pop()!);
      return { 'tenx-app-000001': { mappings: { [f]: { full_name: f, mapping: { [f.split('.').pop()!]: { type: 'text', fields: { keyword: { type: 'keyword' } } } } } } } };
    }
    if (p === '/tenx-app-000001/_settings/index.creation_date') return { 'tenx-app-000001': { settings: { 'index.creation_date': String((NOW - span * 3600) * 1000) } } };
    if (p === '/tenx-tierdown-000003/_settings/index.creation_date') return { 'tenx-tierdown-000003': { settings: { 'index.creation_date': String((NOW - 3600) * 1000) } } };
    const route = p === '/tenx-app-000001/_search' ? 'pass' : p === '/tenx-tierdown-000003/_search' ? 'tier_down' : undefined;
    if (route && body?.aggs?.unsized) return { aggregations: { unsized: { doc_count: 0 } } };
    if (route && body?.aggs?.s) {
      assert.equal(body.aggs.s.composite.sources[0].c.terms.field, 'kubernetes.container_name.keyword');
      assert.equal(body.query, undefined, 'no event-time filter');
      if (body.aggs.s.composite.after) return { aggregations: { s: { buckets: [] } } };
      return {
        aggregations: {
          s: {
            after_key: { c: 'z' },
            buckets: opts.statements.filter((x) => x.r === route).map((x) => ({
              key: { c: x.c, h: x.h },
              doc_count: Math.round(x.bytes / 300),
              b: { value: x.bytes },
              n: { buckets: [{ key: x.n ?? x.h }] },
              v: { buckets: [{ key: x.v ?? 'info' }] },
            })),
          },
        },
      };
    }
    throw new Error(`unexpected request ${method} ${path}`);
  };
  return { req, calls };
}

const hot = parsePolicyYaml(policyText('  hot_tier_gb: 10')).hot_tier!;

test('reads: hot store, the Receiver\'s split, retention from ILM, tier_down lifetime from mounts, statements from utf8Size', async () => {
  const day = 24;
  const { req } = fakeCluster({
    hotStore: 9 * GB, hotDisk: 20 * GB, passStore: 6 * GB, passCounted: 4 * GB, tdStore: 1 * GB, tdCounted: 1 * GB,
    statements: [
      { c: 'cart', h: 'A', r: 'pass', bytes: 6 * GB },
      { c: 'cart', h: 'A', r: 'tier_down', bytes: 6 * GB },
      { c: 'kafka', h: 'B', r: 'pass', bytes: 4.8 * GB },
    ],
    spanHours: day,
  });
  const r = await readHotTierInputs(NOW, hot, req);
  assert.equal(r.hotNodes, 1);
  assert.equal(r.hotStoreBytes, 9 * GB);
  assert.equal(r.hotDiskBytes, 20 * GB);
  assert.deepEqual(r.pass, { storeBytes: 6 * GB, countedBytes: 4 * GB, indices: 1 });
  assert.deepEqual(r.tierDown, { storeBytes: 1 * GB, countedBytes: 1 * GB, indices: 1 });
  assert.equal(r.retentionHours, 10);
  assert.match(r.retentionSource, /tenx-keep/);
  assert.ok(Math.abs(r.tierDownHotHours - (1 + 35 / 60)) < 1e-9, String(r.tierDownHotHours));
  assert.equal(r.statements.length, 3);
  const kept = r.statements.find((x) => x.container === 'cart' && x.route === 'pass')!;
  const moved = r.statements.find((x) => x.container === 'cart' && x.route === 'tier_down')!;
  // by ingest time: the kept index was created a day ago, the tier_down index an hour ago
  assert.ok(Math.abs(kept.bytesPerHour - (6 * GB) / day) < 1);
  assert.ok(Math.abs(moved.bytesPerHour - 6 * GB) < 1);
  assert.equal(r.spanHours, day);
});

function reads(over: Partial<HotTierReads>): HotTierReads {
  return {
    hotNodes: 1, hotStoreBytes: 8 * GB, hotDiskBytes: 20 * GB,
    pass: { storeBytes: 5 * GB, countedBytes: 5 * GB, indices: 1 },
    tierDown: { storeBytes: 1 * GB, countedBytes: 1 * GB, indices: 1 },
    retentionHours: 10, retentionSource: 'test', tierDownHotHours: 2, tierDownSource: 'test',
    statements: [], unsized: 0, spanHours: 24,
    ...over,
  };
}

test('plan: over the size, the noisiest statement is held and hot settles at S', () => {
  const MBh = 1e6;
  const r = reads({
    statements: [
      { container: 'cart', pattern: 'A', name: 'a', severity: 'INFO', route: 'pass', bytesPerHour: 600 * MBh, linesPerHour: (600 * MBh) / 300 },
      { container: 'cart', pattern: 'B', name: 'b', severity: 'INFO', route: 'pass', bytesPerHour: 300 * MBh, linesPerHour: (300 * MBh) / 300 },
      { container: 'kafka', pattern: 'C', name: 'c', severity: 'INFO', route: 'pass', bytesPerHour: 100 * MBh, linesPerHour: (100 * MBh) / 300 },
    ],
  });
  const plan = planHotTier({ hot, reads: r, instances: { cart: 2, kafka: 1 }, nodesTotal: 3, exceptions: [], targetServices: [] });
  // outside = 8 - 5 - 1 = 2 GB; k = 1; R = 10 h; intake 1 GB/h would settle at 12 GB with nothing moved.
  assert.equal(plan.outsideBytes, 2 * GB);
  assert.ok(plan.levelPerHour !== undefined);
  assert.ok(plan.projectedBytes <= 10 * GB * 1.001, `projected ${plan.projectedBytes}`);
  assert.ok(plan.projectedBytes >= 10 * GB * 0.98, `projected ${plan.projectedBytes}`);
  // the small statement keeps every line
  assert.ok(plan.levelPerHour! >= 100 * MBh);
  // moved lines in flight on hot are part of the size
  assert.ok(plan.tierDownInFlightBytes > 0);
  const cart = plan.rows.find((x) => x.container === 'cart')!;
  assert.equal(cart.action, 'tier_down');
  assert.equal(cart.cap, Math.floor((plan.levelPerHour! * 240) / 3600 / 2));
  assert.match(plan.heldLine, /of 10 GB/);
});

test('plan: under the size, every statement keeps its lines with headroom', () => {
  const r = reads({ hotStoreBytes: 3 * GB, pass: { storeBytes: 2 * GB, countedBytes: 2 * GB, indices: 1 }, statements: [{ container: 'cart', pattern: 'A', name: 'a', severity: 'INFO', route: 'pass', bytesPerHour: 1e8, linesPerHour: (1e8) / 300 }] });
  const plan = planHotTier({ hot, reads: r, instances: {}, nodesTotal: 1, exceptions: [], targetServices: [] });
  assert.equal(plan.levelPerHour, undefined);
  assert.equal(plan.movedPerHour, 0);
  assert.ok(plan.rows[0].cap > 0);
});

test('plan: above the size now, the allowance is held below the steady-state number until hot drains', () => {
  const base = { statements: [{ container: 'cart', pattern: 'A', name: 'a', severity: 'INFO', route: 'pass', bytesPerHour: 2e9, linesPerHour: (2e9) / 300 }] };
  const under = planHotTier({ hot, reads: reads({ ...base, hotStoreBytes: 8 * GB }), instances: {}, nodesTotal: 1, exceptions: [], targetServices: [] });
  const over = planHotTier({ hot, reads: reads({ ...base, hotStoreBytes: 12 * GB, pass: { storeBytes: 9 * GB, countedBytes: 9 * GB, indices: 1 } }), instances: {}, nodesTotal: 1, exceptions: [], targetServices: [] });
  assert.equal(over.overSize, true);
  assert.ok(over.allowancePerHour < under.allowancePerHour);
});

test('plan: a service in exceptions is left alone and still counts against the size', () => {
  const r = reads({
    statements: [
      { container: 'cart', pattern: 'A', name: 'a', severity: 'INFO', route: 'pass', bytesPerHour: 9e8, linesPerHour: (9e8) / 300 },
      { container: 'audit', pattern: 'Z', name: 'z', severity: 'INFO', route: 'pass', bytesPerHour: 3e8, linesPerHour: (3e8) / 300 },
    ],
  });
  const plan = planHotTier({ hot, reads: r, instances: {}, nodesTotal: 1, exceptions: ['audit'], targetServices: [] });
  const audit = plan.rows.find((x) => x.container === 'audit')!;
  assert.equal(audit.cap, 0);
  assert.equal(audit.action, 'pass');
  assert.ok(plan.projectedBytes <= 10 * GB * 1.001);
});

test('plan: when the always-pass sample alone exceeds what fits, the run says so and projects above S', () => {
  // 2,000 small statements, one line every few seconds each: the 5-line sample per window keeps them all.
  const statements = Array.from({ length: 2000 }, (_, i) => ({ container: `svc${i % 40}`, pattern: `p${i}`, name: `n${i}`, severity: 'INFO', route: 'pass', bytesPerHour: 300 * 60, linesPerHour: 60 }));
  statements.push({ container: 'cart', pattern: 'BIG', name: 'big', severity: 'INFO', route: 'pass', bytesPerHour: 2e9, linesPerHour: 2e9 / 300 });
  // 9.8 GB outside the Receiver on a 10 GB size: almost nothing fits, less than the floor.
  const plan = planHotTier({ hot, reads: reads({ hotStoreBytes: 10.2 * GB, pass: { storeBytes: 0.4 * GB, countedBytes: 0.4 * GB, indices: 1 }, tierDown: { storeBytes: 0, countedBytes: 0, indices: 0 }, statements }), instances: {}, nodesTotal: 1, exceptions: [], targetServices: [] });
  assert.ok(plan.floorPerHour > 0);
  assert.equal(plan.floorExceedsSize, true);
  // the noisy statement is held to its own sample
  const cart = plan.rows.find((x) => x.container === 'cart')!;
  assert.ok(cart.keptPerHour < 2e9 * 0.01, String(cart.keptPerHour));
  assert.ok(plan.projectedBytes > 10 * GB);
  assert.ok(plan.warnings.some((w) => /always-pass sample/.test(w)));
});

test('plan: the floor is part of the kept total, so a binding size still projects at or under S', () => {
  const MB = 1e6;
  const st = (c: string, p: string, rate: number) => ({ container: c, pattern: p, name: p, severity: 'INFO', route: 'pass', bytesPerHour: rate, linesPerHour: rate / 300 });
  const plan = planHotTier({ hot, reads: reads({ statements: [st('cart', 'A', 600 * MB), st('cart', 'B', 300 * MB), st('kafka', 'C', 100 * MB)] }), instances: {}, nodesTotal: 1, exceptions: [], targetServices: [] });
  assert.equal(plan.floorExceedsSize, false);
  assert.ok(plan.projectedBytes <= 10 * GB * 1.001, String(plan.projectedBytes));
  // each statement's sample: 5 lines x 15 windows x 300 bytes
  assert.ok(Math.abs(plan.floorPerHour - 3 * 5 * 15 * 300) < 1, String(plan.floorPerHour));
});

const seams = tick as unknown as { _setBudgetDeps?: (d: unknown) => void; _resetBudgetDeps?: () => void };
afterEach(() => seams._resetBudgetDeps?.());

test('the run writes byte limits to the policy ConfigMap, and refuses a Receiver counting events', async () => {
  const { req } = fakeCluster({
    hotStore: 9 * GB, hotDisk: 20 * GB, passStore: 6 * GB, passCounted: 6 * GB, tdStore: 1 * GB, tdCounted: 1 * GB,
    statements: [
      { c: 'cart', h: 'A', r: 'pass', bytes: 20 * GB },
      { c: 'kafka', h: 'B', r: 'pass', bytes: 4 * GB },
    ],
  });
  const writes: Array<Record<string, string>> = [];
  const cluster = (unit: string | undefined) => ({
    async listRunningPods(namespace?: string) {
      const r = [{ nodeName: 'n1', containers: ['fluent-bit', 'tenx'], policyConfigMaps: ['log10x-action-intent'] }];
      return namespace === 'logging' ? r : [...r, { nodeName: 'n1', containers: ['cart'] }, { nodeName: 'n1', containers: ['kafka'] }];
    },
    async getConfigMap() {
      return { data: { 'caps.csv': 'container,cap\n', ...(unit ? { 'regulator-unit': unit } : {}) }, resourceVersion: '1' };
    },
    async replaceConfigMap(_ns: string, _n: string, data: Record<string, string>) {
      writes.push(data);
    },
  });
  const p = parsePolicyYaml(policyText('  hot_tier_gb: 10'));
  seams._setBudgetDeps?.({ es: req, k8s: cluster(undefined), nowMs: () => NOW * 1000 });
  const ok = await tick.runTick(p);
  assert.equal(ok.status, 'applied', ok.message);
  assert.equal(writes.length, 1);
  assert.match(writes[0]['caps.csv'], /^container,cap\ncart,\d+::budget run\n/);
  assert.match(writes[0]['budget-report.md'], /Hot-tier run/);
  seams._setBudgetDeps?.({ es: req, k8s: cluster('events'), nowMs: () => NOW * 1000 });
  const refused = await tick.runTick(p);
  assert.equal(refused.status, 'refused');
  seams._setBudgetDeps?.({ es: async () => { throw new Error('connection refused'); }, k8s: cluster(undefined), nowMs: () => NOW * 1000 });
  const failed = await tick.runTick(p);
  assert.equal(failed.status, 'read_failed');
  assert.match(failed.message, /last run stay in force/);
  void mkdtempSync(join(tmpdir(), 'hot-tier-'));
});
