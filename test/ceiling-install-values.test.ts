/**
 * Gate for handoff 4b.1: the regulator values on every Datadog Receiver
 * install, independent of the fleet default, and the error keep count and
 * totals file on the first engine that declares them (1.1.146).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { receiverFleetValues } from '../src/lib/fleet-default-install.js';
import { renderPolicyConfigMapManifest, renderPolicyPullEnvLines } from '../src/lib/advisor/reporter-forwarders.js';

const values = (o: Array<[string, string]>, k: string): string[] => o.filter(([key]) => key === k).map(([, v]) => v);

test('4b.1 gate: a Datadog Receiver plan with no fleet default carries the regulator values', () => {
  const rv = receiverFleetValues({ datadog: true, engineVersion: '1.1.145' });
  assert.deepEqual(values(rv.options, 'rateReceiverWarmupMs'), ['0']);
  assert.deepEqual(values(rv.options, 'rateReceiverMinSharePercent'), ['0']);
  assert.deepEqual(values(rv.options, 'rateReceiverMinRetentionThreshold'), ['0']);
  assert.deepEqual(values(rv.options, 'rateReceiverSeverityFloors'), [
    'TRACE=0', 'DEBUG=0', 'INFO=0', 'WARN=0', 'ERROR=0', 'CRITICAL=0', 'FATAL=0',
  ]);
  // No fleet default given: no limit and no default action are written.
  assert.deepEqual(values(rv.options, 'rateReceiverAbsoluteCap'), []);
  assert.deepEqual(values(rv.options, 'rateReceiverDefaultAction'), []);
});

test('4b.1: the error floor is half when a service offloads and the engine has no keep counts', () => {
  const rv = receiverFleetValues({ datadog: true, engineVersion: '1.1.145', anyOffload: true });
  assert.ok(values(rv.options, 'rateReceiverSeverityFloors').includes('ERROR=0.5'));
  assert.deepEqual(values(rv.options, 'rateReceiverKeepCounts'), []);
});

test('4b.1 gate: keep counts are written from 1.1.146 only, K = 50 by default', () => {
  const early = receiverFleetValues({ datadog: true, engineVersion: '1.1.145' });
  assert.deepEqual(values(early.options, 'rateReceiverKeepCounts'), []);
  const ready = receiverFleetValues({ datadog: true, engineVersion: '1.1.146' });
  assert.deepEqual(values(ready.options, 'rateReceiverKeepCounts'), ['ERROR=50', 'CRITICAL=50', 'FATAL=50']);
  // K replaces the share floor on the error levels.
  assert.ok(values(ready.options, 'rateReceiverSeverityFloors').includes('ERROR=0'));
  const k = receiverFleetValues({ datadog: true, engineVersion: '1.1.146', keepCount: 20, fleetDefault: { capBytesPerWindowPerNode: 6000, action: 'offload' } });
  assert.deepEqual(values(k.options, 'rateReceiverKeepCounts'), ['ERROR=20', 'CRITICAL=20', 'FATAL=20']);
  assert.ok(values(k.options, 'rateReceiverSeverityFloors').includes('ERROR=0'));
  // Each option once: the fleet default path does not repeat the regulator values.
  assert.equal(values(k.options, 'rateReceiverWarmupMs').length, 1);
});

test('4b.1: a non-Datadog Receiver gets none of it; an old engine gets none of it', () => {
  assert.deepEqual(receiverFleetValues({ datadog: false, engineVersion: '1.1.146' }).options, []);
  const old = receiverFleetValues({ datadog: true, engineVersion: '1.1.136' });
  assert.deepEqual(values(old.options, 'rateReceiverWarmupMs'), []);
  assert.deepEqual(old.options, [['symbolMessageHashField', 'tenx_hash']]);
});

test('4b.1 gate: the seed ConfigMap carries totals.csv and the Receiver env points at it', () => {
  const m = renderPolicyConfigMapManifest('logging');
  assert.match(m, /totals\.csv: \|\n    container,total\n    tenx-seed,1::/);
  const env = renderPolicyPullEnvLines('  ').join('\n');
  assert.match(env, /- name: TOTAL_LOOKUP_FILE\n    value: \/tmp\/tenx\/kubernetes\/\$\(K8S_NAMESPACE\)\/log10x-action-intent\/totals\.csv/);
});

// ── Review fixes: offload error floor wired from the plan, K at install, K wording ──

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
      log_destination: 'datadog',
      ...extra,
    } as never,
    {} as never,
  );
  return String((out.data as Record<string, unknown>).markdown);
}

test('review 7 gate: a plan where a service offloads keeps the error count on the pinned engine, half the error lines before 1.1.146', async () => {
  // Pinned 1.1.146: error lines pass by keep count, so every floor is 0 whatever the action.
  const md = await plan({ service_actions: { checkout: 'tier_down', payments: 'offload' } }, 'snap-offload-floor');
  assert.ok(md.includes('- "rateReceiverKeepCounts"\n      - "ERROR=50"'), 'keep counts written');
  assert.ok(md.includes('- "rateReceiverSeverityFloors"\n      - "ERROR=0"'), 'ERROR floor 0 with keep counts');
  // Before 1.1.146 there are no keep counts, so the floor is 0.5 when anything goes to S3.
  const rv = receiverFleetValues({ datadog: true, engineVersion: '1.1.145', anyOffload: true, fleetDefault: { capBytesPerWindowPerNode: 6000, action: 'tier_down' } });
  assert.ok(values(rv.options, 'rateReceiverSeverityFloors').includes('ERROR=0.5'));
  const tier = receiverFleetValues({ datadog: true, engineVersion: '1.1.145', fleetDefault: { capBytesPerWindowPerNode: 6000, action: 'tier_down' } });
  assert.ok(values(tier.options, 'rateReceiverSeverityFloors').includes('ERROR=0'));
});

test('review 8 gate: advise_install takes keep_count, written as three entries', async () => {
  const { adviseInstallSchema } = await import('../src/tools/advise-install.js');
  assert.ok('keep_count' in adviseInstallSchema, 'keep_count is in the schema');
  const md = await plan({ keep_count: 20 }, 'snap-keep-count');
  const kc = md.slice(md.indexOf('"rateReceiverKeepCounts"'), md.indexOf('"rateReceiverKeepCounts"') + 160);
  assert.ok(md.indexOf('"rateReceiverKeepCounts"') >= 0 && kc.includes('ERROR=20') && kc.includes('CRITICAL=20') && kc.includes('FATAL=20'), `three entries at the given count: ${kc}`);
  // Before 1.1.146 the count is held back.
  const early = receiverFleetValues({ datadog: true, engineVersion: '1.1.145', keepCount: 20 });
  assert.deepEqual(values(early.options, 'rateReceiverKeepCounts'), []);
  const ready = receiverFleetValues({ datadog: true, engineVersion: '1.1.146', keepCount: 0 });
  assert.deepEqual(values(ready.options, 'rateReceiverKeepCounts'), ['ERROR=0', 'CRITICAL=0', 'FATAL=0'], 'never an empty list');
});

test('review 9 gate: on 1.1.146 the fleet default step says the K count, not a share', async () => {
  const { buildFleetDefaultStep } = await import('../src/lib/advisor/fleet-default-step.js');
  const rv = receiverFleetValues({ datadog: true, engineVersion: '1.1.146', fleetDefault: { capBytesPerWindowPerNode: 6000, action: 'offload' } });
  const step = buildFleetDefaultStep({ action: 'offload', receiverValues: rv, capGiven: true });
  const text = JSON.stringify(step);
  assert.match(text, /the first 50 lines of each error statement on each node in every 4-minute window/);
  assert.doesNotMatch(text, /half of the rest/);
  // On the pinned engine, the share floor's wording stays.
  const old = receiverFleetValues({ datadog: true, engineVersion: '1.1.145', fleetDefault: { capBytesPerWindowPerNode: 6000, action: 'offload' } });
  assert.match(JSON.stringify(buildFleetDefaultStep({ action: 'offload', receiverValues: old, capGiven: true })), /half of the rest/);
});

test('configure_engine engine_options are what the install writes on the pinned engine from the numbers it returns', async () => {
  const { fleetDefaultFromRows } = await import('../src/tools/configure-engine.js');
  const { resolveEnforcingInstances } = await import('../src/lib/enforcing-instances.js');
  const instances = resolveEnforcingInstances(['payments'], { nodesByContainer: { payments: 1 } });
  const install = (fd: { cap_bytes_per_window_per_node?: number; cap_events_per_window_per_node?: number }) =>
    receiverFleetValues({
      datadog: true,
      fleetDefault: {
        capBytesPerWindowPerNode: fd.cap_bytes_per_window_per_node!,
        ...(fd.cap_events_per_window_per_node !== undefined ? { capEventsPerWindowPerNode: fd.cap_events_per_window_per_node } : {}),
        action: 'offload',
      },
    }).options.filter(([k]) => k !== 'symbolMessageHashField');
  // 3,000 bytes per window at 100 bytes a line: the limit in lines is 60 (headroom 2).
  const rows = [{ container: 'payments', action: 'pass', cap_bytes_per_window: 3000, pattern: 'ledger', current_bytes_30d: 100, events_monthly: 1 }];
  const fd = fleetDefaultFromRows(rows as never, instances, { action: 'offload' }, 'datadog' as never);
  assert.equal(fd.cap_events_per_window_per_node, 60);
  assert.deepEqual(fd.engine_options, install(fd));
  // On 1.1.146 a Datadog Receiver counts events: the unit is written and the limit is in lines.
  assert.ok(fd.engine_options!.some(([k, v]) => k === 'rateReceiverUnit' && v === 'events'));
  assert.deepEqual(fd.engine_options!.find(([k]) => k === 'rateReceiverAbsoluteCap'), ['rateReceiverAbsoluteCap', '60']);
  // Rows with no line count: no byte number is written as lines, as at install.
  const bytesOnly = fleetDefaultFromRows([{ ...rows[0], events_monthly: 0 }] as never, instances, { action: 'offload' }, 'datadog' as never);
  assert.equal(bytesOnly.cap_events_per_window_per_node, undefined);
  assert.deepEqual(bytesOnly.engine_options, install(bytesOnly));
  assert.ok(!bytesOnly.engine_options!.some(([k]) => k === 'rateReceiverAbsoluteCap'));
});
