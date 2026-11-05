/**
 * OpenSearch tier_down: Amazon OpenSearch Service UltraWarm through ISM, the
 * calls the benchmarks run (opensearch-ultrawarm-tierdown, 2026-11-04) made.
 * An OpenSearch destination must never receive the Elastic frozen-tier recipe:
 * ILM, searchable snapshots and Kibana do not exist there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { opensearchUltrawarmRecipe, renderOffloadSection } from '../src/lib/offload-recipes.js';

const P = { bucket: 'acme-offload', region: 'us-east-1', prefix: 'app' };

const ELASTIC_ONLY = /_ilm\/|index\.lifecycle|searchable_snapshot|searchable snapshots|kbn:|Kibana|frozen tier|partial-tenx/i;

/** The JSON body that follows `marker` in a recipe, brace-matched. */
function jsonAfter(body: string, marker: string): unknown {
  const at = body.indexOf(marker);
  assert.ok(at >= 0, `missing ${marker}`);
  const start = body.indexOf('{', at);
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === '{') depth++;
    if (body[i] === '}' && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error(`unbalanced JSON after ${marker}`);
}

test('an opensearch destination never receives the Elastic recipe', () => {
  for (const dest of ['opensearch', 'OpenSearch', ' opensearch ', 'opensearch_self', 'opensearch-self-managed',
    'opensearch_managed', 'amazon-opensearch', 'Amazon OpenSearch Service', 'aws-opensearch']) {
    const text = renderOffloadSection(P, 'fluent-bit', dest);
    assert.doesNotMatch(text, ELASTIC_ONLY, dest);
    assert.ok(!text.includes('_Elasticsearch frozen tier_'), dest);
  }
});

test('managed opensearch gets the UltraWarm recipe', () => {
  for (const dest of ['opensearch_managed', 'amazon-opensearch', 'Amazon OpenSearch Service', 'aws-opensearch']) {
    const text = renderOffloadSection(P, 'fluent-bit', dest);
    assert.ok(text.includes('_Amazon OpenSearch Service UltraWarm_'), dest);
    assert.ok(text.includes('warm_migration'), dest);
    assert.ok(text.includes('`routeState == "tier_down"`'), dest);
  }
});

test('self-managed or unstated opensearch gets offload alone; unstated is asked', () => {
  for (const dest of ['opensearch_self', 'opensearch-self-managed', 'opensearch']) {
    const text = renderOffloadSection(P, 'fluent-bit', dest);
    assert.doesNotMatch(text, /warm_migration|_plugins\/_ism/, dest);
    assert.ok(!text.includes('Or down-tier in the SIEM'), dest);
  }
  assert.match(renderOffloadSection(P, 'fluent-bit', 'opensearch'), /pass destination `opensearch_managed`/);
  assert.doesNotMatch(renderOffloadSection(P, 'fluent-bit', 'opensearch_self'), /opensearch_managed/);
});

test('elasticsearch still gets the frozen tier, not UltraWarm', () => {
  const text = renderOffloadSection(P, 'fluent-bit', 'elasticsearch');
  assert.ok(text.includes('_Elasticsearch frozen tier_'));
  assert.doesNotMatch(text, /UltraWarm|warm_migration/);
});

test('the recipe carries the proof run calls', () => {
  const r = opensearchUltrawarmRecipe();
  assert.equal(r.target, 'opensearch-ultrawarm');
  assert.doesNotMatch(r.body + r.note, ELASTIC_ONLY);

  const mappings = { properties: {
    tenx_hash: { type: 'keyword' },
    routeState: { type: 'keyword' },
    '@timestamp': { type: 'date' },
  } };
  for (const [name, alias] of [['tenx-tierdown-tpl', 'tenx-tierdown'], ['tenx-app-tpl', 'tenx-app']]) {
    assert.deepEqual(jsonAfter(r.body, `PUT _index_template/${name}`), {
      index_patterns: [`${alias}-*`],
      template: {
        settings: {
          'plugins.index_state_management.rollover_alias': alias,
          number_of_shards: 1,
          number_of_replicas: 0,
        },
        mappings,
      },
    }, name);
  }

  const tierDown = jsonAfter(r.body, 'PUT _plugins/_ism/policies/tenx-tier-down') as {
    policy: { default_state: string; states: unknown[]; ism_template: unknown };
  };
  assert.equal(tierDown.policy.default_state, 'hot');
  assert.deepEqual(tierDown.policy.states, [
    { name: 'hot', actions: [{ rollover: { min_primary_shard_size: '50gb', min_index_age: '1h' } }], transitions: [{ state_name: 'warm' }] },
    { name: 'warm', actions: [{ warm_migration: {}, retry: { count: 5, delay: '10m' } }], transitions: [] },
  ]);
  assert.deepEqual(tierDown.policy.ism_template, { index_patterns: ['tenx-tierdown-*'], priority: 100 });

  const keep = jsonAfter(r.body, 'PUT _plugins/_ism/policies/tenx-keep') as {
    policy: { states: unknown[]; ism_template: unknown };
  };
  assert.deepEqual(keep.policy.states, [
    { name: 'hot', actions: [{ rollover: { min_primary_shard_size: '50gb', min_index_age: '1d' } }], transitions: [] },
  ]);
  assert.deepEqual(keep.policy.ism_template, { index_patterns: ['tenx-app-*'], priority: 100 });

  // Policies before bootstrap: ism_template attaches only to indices created after it.
  assert.ok(r.body.indexOf('PUT _plugins/_ism/policies/tenx-keep') < r.body.indexOf('PUT tenx-tierdown-000001'));
  assert.deepEqual(jsonAfter(r.body, 'PUT tenx-tierdown-000001'), { aliases: { 'tenx-tierdown': { is_write_index: true } } });
  assert.deepEqual(jsonAfter(r.body, 'PUT tenx-app-000001'), { aliases: { 'tenx-app': { is_write_index: true } } });

  assert.ok(r.body.includes('/_dashboards/api/saved_objects/index-pattern/tenx-all'));
  assert.ok(r.body.includes('osd-xsrf: true'));
  assert.deepEqual(jsonAfter(r.body, 'Content-Type: application/json'), {
    attributes: { title: 'tenx-app-*,tenx-tierdown-*', timeFieldName: '@timestamp' },
  });
});

test('the recipe names what UltraWarm needs and claims nothing the run did not show', () => {
  const { note } = opensearchUltrawarmRecipe();
  for (const need of [/UltraWarm enabled on the domain/, /dedicated master nodes/, /no T2 or T3 data nodes/,
    /ISM plugin/, /OpenSearch Dashboards access/]) {
    assert.match(note, need);
  }
  assert.match(note, /\$0\.024\/GB-month/);
  assert.match(note, /\$0\.122\/GB-month/);
  assert.match(note, /\$0\.238\/h/);
  assert.match(note, /resized to bank it/);
  assert.match(note, /NOT SHOWN: warm search latency under query load, and cold storage/);
  assert.ok(!note.includes('—'), 'no em dashes');
});
