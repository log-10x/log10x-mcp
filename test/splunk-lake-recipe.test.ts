/**
 * Splunk tier_down: the tier_down slice as full text to a Machine Data Lake
 * raw table over HEC, the pattern hash in `source`, and the same hash on the
 * kept slice as `tenx_pattern`. Only Splunk Cloud has the lake; Splunk
 * Enterprise and an unstated deployment offload. Rendered text only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderOffloadSection, splunkLakeRecipe } from '../src/lib/offload-recipes.js';
import { DEFAULT_ACTION_BY_DESTINATION, getDefaultActionForDestination, projectAction } from '../src/lib/cost.js';

const P = { bucket: 'acme-offload', region: 'us-east-1', prefix: 'app' };

test('the lake recipe: pattern into source, raw table as the index, whole record as the event', () => {
  const r = splunkLakeRecipe();
  assert.equal(r.target, 'splunk-machine-data-lake');
  // Fluent Bit half
  assert.match(r.body, /Match +tenx\.tier_down/);
  assert.match(r.body, /event_source +tenx:\$tenx_pattern\n/);
  assert.match(r.body, /event_index +~\.federated\.<raw_table_name>\n/);
  assert.doesNotMatch(r.body.split('--- Fluent Bit')[1], /^\s+event_key/m, 'no event_key: the whole record is the event');
  assert.match(r.body, /#\s+event_field +tenx_pattern \$tenx_pattern/);
  // OpenTelemetry Collector half
  assert.match(r.body, /set\(attributes\["com\.splunk\.source"\], Concat\(\["tenx", attributes\["tenx_pattern"\]\], ":"\)\)/);
  assert.match(r.body, /set\(attributes\["com\.splunk\.index"\], "~\.federated\.<raw_table_name>"\)/);
  assert.match(r.body, /set\(body, \{"event": body, "source": attributes\["com\.splunk\.source"\]\}\) where/);
  assert.match(r.body, /logs\/tier_down: \{ receivers: \[routing\], processors: \[transform\/splunk_lake\], exporters: \[splunk_hec\/lake\] \}/);
  assert.match(r.body, /token: "\$\{env:SPLUNK_LAKE_HEC_TOKEN\}"/);
  // the original source goes into the event before source is replaced
  const body = r.body;
  assert.ok(body.indexOf('set(body, {"event"') < body.indexOf('Concat(["tenx"'));
  assert.doesNotMatch(body, /tenx_hash/);
  assert.match(splunkLakeRecipe({ rawTable: 'tenx_lake' }).body, /~\.federated\.tenx_lake/);
  assert.throws(() => splunkLakeRecipe({ hashField: 'tenx_hash' }), /template id/);
  assert.doesNotMatch(r.note, /\$\d|per GB|cheaper/);
});

test('splunk_cloud gets the lake recipe; splunk and Splunk Enterprise get offload with the question', () => {
  for (const dest of ['splunk_cloud', 'Splunk Cloud', ' splunk-cloud ']) {
    for (const fwd of ['fluent-bit', 'otel-collector', null] as const) {
      const text = renderOffloadSection(P, fwd, dest);
      assert.ok(text.includes('_Splunk Machine Data Lake_'), `${dest} ${fwd}`);
      assert.ok(text.includes('Or tier down in Splunk Cloud instead of offloading'), dest);
      assert.ok(!text.includes('_Datadog Flex_') && !text.includes('_CloudWatch Infrequent Access_'), dest);
    }
  }
  const bare = renderOffloadSection(P, 'fluent-bit', 'splunk');
  assert.ok(!bare.includes('_Splunk Machine Data Lake_'));
  assert.match(bare, /pass destination `splunk_cloud`/);
  assert.ok(!bare.includes('Or down-tier in the SIEM'));
  // the unknown-destination fallback never shows the lake
  assert.ok(!renderOffloadSection(P, 'fluent-bit').includes('Machine Data Lake'));
});

test('cost: tier_down on splunk_cloud only, after the ladder, and projected with the bytes unchanged', () => {
  assert.deepEqual(DEFAULT_ACTION_BY_DESTINATION.splunk, ['compact', 'offload']);
  assert.deepEqual(DEFAULT_ACTION_BY_DESTINATION.splunk_cloud, ['compact', 'offload', 'tier_down']);
  assert.equal(getDefaultActionForDestination('splunk_cloud', 1), 'compact');
  assert.equal(getDefaultActionForDestination('splunk_cloud', 2), 'offload');
  const pass = projectAction({ action: 'pass', bytes_in: 100e9, destination: 'splunk_cloud' as never });
  const td = projectAction({ action: 'tier_down', bytes_in: 100e9, destination: 'splunk_cloud' as never });
  assert.equal(td.bytes_out, 100e9);
  assert.equal(td.total_dollars, pass.total_dollars);
  assert.ok((td.notes ?? []).some((n) => /cheaper tier pricing not configured/.test(n)), (td.notes ?? []).join(' | '));
});
