/**
 * The Elasticsearch hot-tier run's install path: the Receiver from
 * log10x_advise_install with `log_destination: "elasticsearch"`, the indices
 * from the frozen-tier recipe, and setup_recurring pointing at both.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ELASTIC_HOT_TIER_FIELDS } from '../src/lib/fleet-default-install.js';
import { ELASTIC_KEEP_HOT_DAYS, elasticFrozenTierRecipe } from '../src/lib/offload-recipes.js';
import { ilmHotHours } from '../src/lib/elastic-budget-tick.js';
import { executeSetupRecurring } from '../src/tools/setup-recurring.js';

async function plan(extra: Record<string, unknown>, id: string): Promise<string> {
  const { putSnapshot } = await import('../src/lib/discovery/snapshot-store.js');
  const { SNAPSHOT_SCHEMA_VERSION } = await import('../src/lib/discovery/types.js');
  const { executeAdviseInstall } = await import('../src/tools/advise-install.js');
  putSnapshot({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: id,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    kubectl: {
      available: true,
      namespaces: ['logging'],
      probedNamespaces: ['logging'],
      forwarders: [
        { kind: 'fluentbit', namespace: 'logging', workloadKind: 'DaemonSet', workloadName: 'fluent-bit', image: 'cr.fluentbit.io/fluent/fluent-bit:3.1.0', containerName: 'fluent-bit', labels: {}, readyReplicas: 3 },
      ],
      helmReleases: [],
      log10xApps: [],
      storageClasses: [],
      ingressClasses: [],
      serviceAccountIrsa: [],
      backendAgents: [],
    },
    aws: { available: false, s3Buckets: [], sqsQueues: [], cwLogGroups: [] },
    recommendations: { suggestedNamespace: 'logging', alreadyInstalled: {} },
    probeLog: [],
  } as never);
  const out = await executeAdviseInstall(
    {
      snapshot_id: id,
      app: 'receiver',
      forwarder: 'fluentbit',
      backends: ['prometheus'],
      backend_credentials: { prometheus: { secretName: 'prom-creds' } },
      airgapped: false,
      license_source: 'builtin',
      log_destination: 'elasticsearch',
      ...extra,
    } as never,
    {} as never,
  );
  return String((out.data as Record<string, unknown>).markdown);
}

/** The sidecar's args as the values file's YAML double-quoted scalars decode them. */
function sidecarArgs(md: string): string[] {
  const block = md.slice(md.indexOf('  - name: log10x'));
  const text = block.split('\n    args:\n')[1].split('\n    env:\n')[0];
  return text.split('\n').map((l) => {
    const m = /^\s+- (".*")$/.exec(l);
    assert.ok(m, `not a quoted list item: ${l}`);
    return JSON.parse(m![1]) as string;
  });
}

const optionValue = (args: string[], k: string): string | undefined => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};

test('advise_install elasticsearch: the Receiver plan writes the hash field and the hot-tier field list', async () => {
  const md = await plan({}, 'snap-es-hot-tier');
  const args = sidecarArgs(md);
  assert.equal(optionValue(args, 'symbolMessageHashField'), 'tenx_hash');
  assert.equal(optionValue(args, 'outputEncodeField'), ELASTIC_HOT_TIER_FIELDS);
  // the policy seed records bytes, the unit the hot-tier run writes
  assert.match(md, /regulator-unit: bytes/);
  assert.match(md, /hot-tier run \(log10x_setup_recurring `hot_tier_gb`\)/);
});

test('advise_install elasticsearch: nothing Datadog or ClickHouse specific, whatever else is passed', async () => {
  const md = await plan({ regulator_unit: 'events', keep_count: 20, fleet_default: { action: 'tier_down', cap_bytes_per_window_per_node: 6000 } }, 'snap-es-hot-tier-extra');
  const args = sidecarArgs(md);
  for (const k of [
    'rateReceiverUnit',
    'rateReceiverKeepCounts',
    'rateReceiverSeverityFloors',
    'rateReceiverWarmupMs',
    'rateReceiverMinSharePercent',
    'rateReceiverMinRetentionThreshold',
    'rateReceiverBaselineCount',
    'rateReceiverAbsoluteCap',
    'rateReceiverDefaultAction',
  ]) {
    assert.ok(!args.includes(k), `${k} written`);
  }
  assert.doesNotMatch(md, /outputOffload|Flex|@routeState:tier_down|regulator-unit: events/);
  assert.match(md, /`regulator_unit: "events"` is not written for Elasticsearch/);
});

test('advise_install elasticsearch on the Reporter writes no Receiver option', async () => {
  const md = await plan({ app: 'reporter' }, 'snap-es-reporter');
  assert.doesNotMatch(md, /outputEncodeField|symbolMessageHashField/);
  assert.match(md, /the Reporter only reports/);
});

/** The JSON body of `<verb> <path>` in the recipe. */
function recipeRequest(body: string, path: string, verb = 'PUT'): any {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => l.trim() === `${verb} ${path}`);
  assert.ok(at >= 0, `no ${verb} ${path}`);
  const buf: string[] = [];
  let depth = 0;
  for (const l of lines.slice(at + 1)) {
    buf.push(l);
    for (const ch of l) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
    if (depth === 0) break;
  }
  return JSON.parse(buf.join('\n'));
}

test('recipe: tenx-keep moves kept lines to frozen, never deletes, and the run reads about 7 days on hot', () => {
  const r = elasticFrozenTierRecipe();
  const keep = recipeRequest(r.body, '_ilm/policy/tenx-keep').policy;
  assert.equal(keep.phases.frozen.actions.searchable_snapshot.snapshot_repository, 'found-snapshots');
  assert.equal(keep.phases.hot.actions.rollover.max_age, '1d');
  assert.equal(keep.phases.frozen.min_age, '6d');
  assert.deepEqual(Object.keys(keep.phases).sort(), ['frozen', 'hot']);
  assert.equal(ilmHotHours(keep)?.hours, ELASTIC_KEEP_HOT_DAYS * 24);
  assert.equal(ELASTIC_KEEP_HOT_DAYS, 7);
  // no policy in the recipe deletes anything
  assert.doesNotMatch(r.body, /"delete"/);
  const td = recipeRequest(r.body, '_ilm/policy/tenx-tier-down').policy;
  assert.deepEqual(Object.keys(td.phases).sort(), ['frozen', 'hot']);
  // same repository for both streams
  const repo = elasticFrozenTierRecipe({ repository: 'rig-snapshots' });
  assert.equal(recipeRequest(repo.body, '_ilm/policy/tenx-keep').policy.phases.frozen.actions.searchable_snapshot.snapshot_repository, 'rig-snapshots');
  assert.match(r.body, /min_age, counted from\n#\s+rollover, is how long kept lines stay on hot/);
  assert.match(r.body, /hot-tier run \(log10x_setup_recurring\n#\s+hot_tier_gb\) reads it/);
  assert.match(r.note, /a kept line stays on hot 7 days at most/);
});

test('recipe: keepHotDays sets the frozen min_age the run reads; the tier_down placement default stays warm', () => {
  for (const [days, minAge] of [[3, '2d'], [1, '0d'], [30, '29d']] as const) {
    const keep = recipeRequest(elasticFrozenTierRecipe({ keepHotDays: days }).body, '_ilm/policy/tenx-keep').policy;
    assert.equal(keep.phases.frozen.min_age, minAge);
    assert.equal(ilmHotHours(keep)?.hours, days * 24);
  }
  const td = recipeRequest(elasticFrozenTierRecipe().body, '_index_template/tenx-tierdown-tpl');
  assert.equal(td.template.settings['index.routing.allocation.include._tier_preference'], 'data_warm,data_hot');
});

test('recipe: one Kibana data view covers both aliases, and an existing one gains the tier_down pattern', () => {
  const r = elasticFrozenTierRecipe();
  const dv = recipeRequest(r.body, 'kbn:/api/data_views/data_view', 'POST').data_view;
  assert.equal(dv.title, 'tenx-app-*,tenx-tierdown-*');
  assert.equal(dv.timeFieldName, '@timestamp');
  assert.equal(dv.name, 'tenx kept and moved lines');
  // a data view id is unique across spaces, so the recipe leaves it to Kibana
  assert.equal(dv.id, undefined);
  // the title covers both index templates' patterns
  for (const tpl of ['tenx-app-tpl', 'tenx-tierdown-tpl']) {
    for (const p of recipeRequest(r.body, `_index_template/${tpl}`).index_patterns) assert.ok(dv.title.split(',').includes(p), p);
  }
  assert.match(r.body, /Saved searches, Lens visualizations\n#\s+and alert rules built on this data view read kept and moved lines alike/);
  assert.match(r.body, /moved lines answer from the frozen tier at the frozen tier's speed/);
  assert.match(r.body, /kbn:\/s\/<space id>\/api\/data_views\/data_view/);
  assert.match(r.body, /kbn-xsrf header/);
  assert.match(r.body, /POST kbn:\/api\/data_views\/data_view\/<its id>\n#\s+\{ "data_view": \{ "title": "<its title>,tenx-tierdown-\*" \} \}/);
  assert.match(r.note, /Data View Management privilege .* and `view_index_metadata` on `tenx-app-\*` and `tenx-tierdown-\*`/);
  assert.match(r.note, /no data view yet, Kibana also makes it the default, which needs the Advanced Settings privilege/);
  assert.match(r.body, /POST tenx-app-\*,tenx-tierdown-\*\/_search\n.*\n#\s+\.\.\.lists partial-tenx-tierdown-000001 beside the hot indices/);

  const custom = elasticFrozenTierRecipe({ keepAlias: 'logs-keep', tierDownAlias: 'logs-cold' });
  assert.equal(recipeRequest(custom.body, 'kbn:/api/data_views/data_view', 'POST').data_view.title, 'logs-keep-*,logs-cold-*');
  assert.match(custom.body, /"<its title>,logs-cold-\*"/);
});

test('an elasticsearch tier_down plan requires Kibana access for the data view', async () => {
  const { solvePlan } = await import('../src/lib/plan-solver.js');
  const pl = solvePlan(
    [
      { hash: 'p1', name: 'Transaction complete', services: { payment: 100_000_000_000 }, severity: 'INFO', bytes: 100_000_000_000 },
      { hash: 'p2', name: 'Charge received', services: { payment: 90_000_000_000 }, severity: 'INFO', bytes: 90_000_000_000 },
      { hash: 'c1', name: 'GetCart', services: { cart: 80_000_000_000 }, severity: 'INFO', bytes: 80_000_000_000 },
      { hash: 'e1', name: 'Charge FAILED', services: { payment: 60_000_000_000 }, severity: 'ERROR', bytes: 60_000_000_000 },
    ],
    { destination: 'elasticsearch', retrieverInstalled: true, targetPct: 40 },
  );
  assert.ok(pl.planned.some((p) => p.action === 'tier_down'));
  assert.ok(pl.prerequisites.some((x) => /Kibana access with the Data View Management privilege/.test(x)), pl.prerequisites.join(' | '));
});

test('setup_recurring hot tier: the instructions point at advise_install and name no hand-set engine option', async () => {
  for (const scheduler of ['k8s_cron', 'github_actions'] as const) {
    const result = await executeSetupRecurring({
      target_services: [],
      hot_tier_gb: 400,
      scheduler,
      config_plane: 'https://github.com/acme/log10x-config',
      nodes_by_container: { checkout: 2 },
      confirm: true,
    });
    const data = (result as any).data as Record<string, unknown>;
    assert.equal(data.mode, 'emit', String(data.markdown));
    const ins = String(data.apply_instructions);
    assert.doesNotMatch(ins, /symbolMessageHashField|outputEncodeField|fullText\(/, scheduler);
    assert.match(ins, /`log10x_advise_install` and `log_destination: "elasticsearch"`/, scheduler);
    assert.match(ins, /utf8Size/);
    assert.match(ins, /mounts them on frozen 6 days later, 7 days on hot at most/);
    assert.doesNotMatch(ins, /When that policy has no phase after hot/);
  }
});
