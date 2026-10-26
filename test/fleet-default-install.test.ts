/**
 * Items 1 and 2: the fleet default's number from a capture (the isolated
 * rule), the Receiver values that install it, the engine gate, and the
 * dependency check that treats no error line as kept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fleetDefaultBaseline, fleetDefaultNumber, type KeptCell } from '../src/lib/fleet-default.js';
import {
  FLEET_DEFAULT_MIN_ENGINE,
  engineReadsFleetDefault,
  fleetDefaultEngineOptions,
  imageEngineVersion,
  manifestEngineVersion,
  receiverFleetValues,
  validTeamLabel,
} from '../src/lib/fleet-default-install.js';
import { EDGE_MANIFEST_IMAGE } from '../src/lib/runtime-image.js';
import { RECEIVER_FORWARDER_SPECS } from '../src/lib/advisor/reporter-forwarders.js';
import { buildFleetDefaultStep } from '../src/lib/advisor/fleet-default-step.js';
import {
  dependencyLinesForFleetDefault,
  dependencyLinesForService,
  matchRuleDependencies,
} from '../src/lib/siem/deps/datadog-log-queries.js';
import { fleetDefaultDependencyRules } from '../src/lib/plan-dependencies.js';
import { fleetDefaultFromRows, type PerPatternRow } from '../src/tools/configure-engine.js';
import { resolveEnforcingInstances } from '../src/lib/enforcing-instances.js';
import { fleetDefaultFromPatterns } from '../src/lib/report/build-report-data.js';

const cells: KeptCell[] = [
  { container: 'checkout', keptMaxBytesPerWindow: 6000, instances: 3, statement: 'order placed', avgBytesPerLine: 200 },
  { container: 'payments', keptMaxBytesPerWindow: 3000, instances: 1, statement: 'ledger synced', avgBytesPerLine: 150 },
  { container: 'idle', keptMaxBytesPerWindow: 0, instances: 1 },
];

test('the number rule: the largest kept per-node cell times the headroom (2 by default)', () => {
  const b = fleetDefaultBaseline(cells)!;
  assert.equal(b.container, 'payments');
  assert.equal(b.perNode, 3000);
  const n = fleetDefaultNumber(cells)!;
  assert.equal(n.headroom, 2);
  assert.equal(n.baselineBytesPerWindowPerNode, 3000);
  assert.equal(n.capBytesPerWindowPerNode, 6000);
  assert.equal(n.baseline.statement, 'ledger synced');
  assert.equal(fleetDefaultNumber(cells, 3)!.capBytesPerWindowPerNode, 9000);
  assert.equal(fleetDefaultNumber([{ container: 'x', keptMaxBytesPerWindow: 0, instances: 1 }]), undefined);
  assert.equal(fleetDefaultNumber([]), undefined);
});

test('the engine gate: the first release that reads rateReceiverDefaultAction is 1.1.141', () => {
  assert.equal(FLEET_DEFAULT_MIN_ENGINE, '1.1.141');
  assert.equal(engineReadsFleetDefault('1.1.140'), false);
  assert.equal(engineReadsFleetDefault('1.1.141'), true);
  assert.equal(engineReadsFleetDefault('1.2.0'), true);
  assert.equal(engineReadsFleetDefault('latest'), false);
  assert.equal(engineReadsFleetDefault(undefined), false);
  assert.equal(imageEngineVersion('log10x/edge-10x:1.1.136'), '1.1.136');
  assert.equal(imageEngineVersion('log10x/edge-10x:latest'), undefined);
  assert.equal(manifestEngineVersion(), imageEngineVersion(EDGE_MANIFEST_IMAGE));
  // The install manifest pins a release that reads the fleet default (1.1.141 or later), by digest, so the gate opens.
  assert.equal(imageEngineVersion('log10x/edge-10x:1.1.141@sha256:45157d0b'), '1.1.141');
  assert.equal(EDGE_MANIFEST_IMAGE, 'log10x/edge-10x:1.1.150@sha256:3e755bbc14780a27e643e09b76dfd7ec9616cab67833f70daf9420eff646d350');
  assert.equal(engineReadsFleetDefault(manifestEngineVersion()), true);
});

test('the Receiver options: cap, default action, the always-pass sample, every floor named', () => {
  assert.deepEqual(fleetDefaultEngineOptions({ capBytesPerWindowPerNode: 6000.4, action: 'tier_down' }), [
    ['rateReceiverAbsoluteCap', '6000'],
    ['rateReceiverDefaultAction', 'tier_down'],
    ['rateReceiverMinSharePercent', '0'],
    ['rateReceiverWarmupMs', '0'],
    ['rateReceiverBaselineCount', '5'],
    ['rateReceiverMinRetentionThreshold', '0'],
    ['rateReceiverSeverityFloors', 'TRACE=0'],
    ['rateReceiverSeverityFloors', 'DEBUG=0'],
    ['rateReceiverSeverityFloors', 'INFO=0'],
    ['rateReceiverSeverityFloors', 'WARN=0'],
    ['rateReceiverSeverityFloors', 'ERROR=0'],
    ['rateReceiverSeverityFloors', 'CRITICAL=0'],
    ['rateReceiverSeverityFloors', 'FATAL=0'],
  ]);
  const off = fleetDefaultEngineOptions({ capBytesPerWindowPerNode: 6000, action: 'offload' });
  assert.deepEqual(off.filter(([k]) => k === 'rateReceiverSeverityFloors').map(([, v]) => v), [
    'TRACE=0', 'DEBUG=0', 'INFO=0', 'WARN=0', 'ERROR=0.5', 'CRITICAL=0.5', 'FATAL=0.5',
  ]);
  const quarter = fleetDefaultEngineOptions({ capBytesPerWindowPerNode: 6000, action: 'tier_down', errorFloor: 0.25 });
  assert.ok(quarter.some(([k, v]) => k === 'rateReceiverSeverityFloors' && v === 'ERROR=0.25'));
});

test('Receiver values: held back before 1.1.141 with the reason, written from it, team label only when named and valid', () => {
  const fd = { capBytesPerWindowPerNode: 6000, action: 'tier_down' as const };
  const early = receiverFleetValues({ datadog: true, fleetDefault: fd, teamLabel: 'team', engineVersion: '1.1.136' });
  assert.deepEqual(early.options, [['symbolMessageHashField', 'tenx_hash']]);
  assert.deepEqual(early.env, []);
  assert.equal(early.fleetDefaultWritten, false);
  assert.equal(early.teamLabelWritten, false);
  assert.ok(early.notes[0].startsWith('The fleet default needs engine 1.1.141 or later, the first that reads rateReceiverDefaultAction; this plan installs 1.1.136'));
  assert.ok(early.notes[1].startsWith('The regulator values (no warm-up, no share guard, a 0 floor below ERROR) need engine 1.1.141 or later'));
  assert.ok(early.notes[2].startsWith('The team label needs engine 1.1.141 or later'));

  const ready = receiverFleetValues({ datadog: true, fleetDefault: fd, teamLabel: 'app.kubernetes.io/part-of', engineVersion: '1.1.141' });
  assert.equal(ready.fleetDefaultWritten, true);
  assert.equal(ready.teamLabelWritten, true);
  assert.deepEqual(ready.options[0], ['symbolMessageHashField', 'tenx_hash']);
  assert.deepEqual(ready.options[1], ['rateReceiverAbsoluteCap', '6000']);
  assert.deepEqual(ready.options.at(-1), ['k8sTeamLabel', 'app.kubernetes.io/part-of']);
  assert.deepEqual(ready.env, [['outputOffload', 'true']]);
  assert.equal(ready.notes.length, 1);
  assert.ok(ready.notes[0].startsWith('Error lines over a limit pass at a fixed count (rateReceiverKeepCounts) from engine 1.1.146'));

  const noCap = receiverFleetValues({ datadog: true, fleetDefault: { ...fd, capBytesPerWindowPerNode: 0 }, engineVersion: '1.1.141' });
  assert.equal(noCap.fleetDefaultWritten, false);
  assert.equal(noCap.notes[0], 'No limit was given, so the plan writes no fleet default.');
  assert.equal(noCap.regulatorValuesWritten, true);

  const noLabel = receiverFleetValues({ datadog: false, engineVersion: '1.1.141' });
  assert.deepEqual(noLabel.options, []);
  assert.equal(validTeamLabel('bad label'), undefined);
  assert.ok(receiverFleetValues({ datadog: false, teamLabel: 'bad label', engineVersion: '1.1.141' }).notes[0].includes('is not a Kubernetes label key'));
});

test('every Receiver overlay carries the options after the app and the env on the engine container', () => {
  const values = receiverFleetValues({
    datadog: true,
    fleetDefault: { capBytesPerWindowPerNode: 6000, action: 'offload' },
    teamLabel: 'team',
    engineVersion: '1.1.141',
  });
  const base = {
    licenseJwt: 'x',
    builtinLicense: true,
    releaseName: 'r',
    destination: 'mock' as const,
    licenseSecretName: 'log10x-license',
    licenseSecretKey: 'license-jwt',
    engineOptions: values.options,
    engineEnv: values.env,
  };
  for (const kind of ['fluentbit', 'vector', 'otel-collector', 'logstash'] as const) {
    const y = RECEIVER_FORWARDER_SPECS[kind].renderValues(base);
    const app = y.indexOf('"@apps/receiver"');
    const cap = y.indexOf('"rateReceiverAbsoluteCap"');
    assert.ok(app > 0 && cap > app, `${kind}: options after the app`);
    assert.ok(y.includes('- "rateReceiverSeverityFloors"\n      - "ERROR=0.5"'), `${kind}: floor list repeats the option`);
    assert.ok(y.includes('- "k8sTeamLabel"\n      - "team"'), kind);
    assert.ok(y.includes('- name: outputOffload\n        value: "true"'), `${kind}: outputOffload env`);
    assert.equal(y.split('"symbolMessageHashField"').length - 1, 1, `${kind}: hash field once`);
  }
  // A Datadog destination sets the hash field itself; it is not written twice.
  const dd = RECEIVER_FORWARDER_SPECS.fluentbit.renderValues({ ...base, destination: 'datadog' });
  assert.equal(dd.split('"symbolMessageHashField"').length - 1, 1);

  const fb = RECEIVER_FORWARDER_SPECS.filebeat.renderValues({ ...base, backends: ['prometheus'] });
  const runArgs = /TENX_RUN_ARGS\n\s+value: "([^"]*)"/.exec(fb)![1];
  assert.ok(runArgs.startsWith('@run/input/forwarder/filebeat @apps/receiver'));
  assert.ok(runArgs.indexOf('@run/output/metric/prometheus') < runArgs.indexOf('rateReceiverAbsoluteCap 6000'));
  assert.ok(runArgs.includes('rateReceiverSeverityFloors ERROR=0.5 rateReceiverSeverityFloors CRITICAL=0.5'));
  assert.ok(fb.includes('- name: outputOffload\n      value: "true"'));

  const files = RECEIVER_FORWARDER_SPECS.fluentd.renderExtraFiles!({ ...base, namespace: 'logging' });
  const patch = files.find((f) => f.path.includes('sidecar-patch'))!.contents;
  assert.ok(patch.indexOf('"@apps/receiver"') < patch.indexOf('"rateReceiverDefaultAction"'));
  assert.ok(patch.includes('- name: outputOffload'));

  // Nothing is added when nothing is passed.
  const plain = RECEIVER_FORWARDER_SPECS.fluentbit.renderValues({ ...base, engineOptions: undefined, engineEnv: undefined });
  assert.ok(!plain.includes('rateReceiver') && !plain.includes('outputOffload'));
});

test('the fleet-default step lists the written values, or says what holds them back', () => {
  const fd = { capBytesPerWindowPerNode: 6000, action: 'tier_down' as const };
  const written = buildFleetDefaultStep({
    receiverValues: receiverFleetValues({ datadog: true, fleetDefault: fd, engineVersion: '1.1.141' }),
    capGiven: true,
  });
  assert.equal(written.receiver_values_written, true);
  assert.ok(written.markdown.includes('rateReceiverAbsoluteCap 6000\nrateReceiverDefaultAction tier_down'));
  assert.ok(written.markdown.includes('outputOffload=true   # env'));
  assert.ok(!written.markdown.includes('symbolMessageHashField tenx_hash\n'), 'the hash field is not a fleet value');

  const held = buildFleetDefaultStep({
    receiverValues: receiverFleetValues({ datadog: true, fleetDefault: fd, engineVersion: '1.1.136' }),
    capGiven: true,
  });
  assert.equal(held.receiver_values_written, false);
  assert.ok(held.receiver.startsWith('The fleet default needs engine 1.1.141 or later'));

  const noCap = buildFleetDefaultStep({ receiverValues: receiverFleetValues({ datadog: true, engineVersion: '1.1.141' }), capGiven: false });
  assert.ok(noCap.receiver.startsWith('No limit was given.'));
  assert.ok(noCap.receiver.includes('`fleet_default.cap_bytes_per_window_per_node`'));
});

test('the dependency check under the fleet default: no error line counts as kept', () => {
  const objects = [
    { kind: 'log_monitor' as const, id: '1', name: 'Payments errors', searches: ['service:payments status:error'] },
  ];
  const statements = [
    { service: 'payments', name: 'card declined', text: 'card declined code $', severity: 'INFO' },
    { service: 'checkout', name: 'order placed', text: 'order placed $', severity: 'INFO' },
  ];
  // As a row of its own, an INFO-only move leaves the errors-only monitor its lines.
  const asRow = matchRuleDependencies(
    [{ service: 'payments', action: 'tier_down', statements: [{ name: 'card declined', text: 'card declined code $', severity: 'INFO' }] }],
    objects,
  );
  assert.equal(asRow.rules[0].monitors[0].effect, 'not_blinded');
  // Under the fleet default it holds error statements too, so the monitor is blinded above the limit.
  const rules = fleetDefaultDependencyRules(statements, ['checkout'], 'tier_down');
  assert.deepEqual(rules.map((r) => [r.service, r.fleetDefault, r.statements.length]), [['payments', true, 1]]);
  const fd = matchRuleDependencies(rules, objects);
  assert.equal(fd.rules[0].fleet_default, true);
  assert.equal(fd.rules[0].monitors[0].effect, 'goes_blind');
  assert.ok(fd.rules[0].lines[0].startsWith('payments (fleet default, tier_down to Flex above the limit, 1 statement): 1 log monitor reads these lines.'));
  assert.deepEqual(dependencyLinesForService(fd, 'payments'), []);
  assert.equal(dependencyLinesForFleetDefault(fd).length, 2);
});

test('configure_engine: the fleet default from the rows, per node, in lines a day, with its options', () => {
  const row = (container: string, pattern: string, action: PerPatternRow['action'], capPerWindow: number, bytes: number, events?: number): PerPatternRow => ({
    pattern_hash: pattern,
    pattern,
    current_bytes_30d: bytes,
    cap_bytes_per_window: capPerWindow,
    ...(events !== undefined ? { events_monthly: events } : {}),
    action,
    container,
    saved_bytes_monthly: 0,
    saved_dollars_monthly: 0,
    projected_monthly_usd_low: 0,
    projected_monthly_usd_expected: 0,
    projected_monthly_usd_high: 0,
    reason: '',
  });
  const rows = [
    row('checkout', 'order placed', 'pass', 6000, 64_800_000, 324_000),
    row('checkout', 'cart retry', 'tier_down', 90_000, 972_000_000),
    row('payments', 'ledger synced', 'pass', 3000, 32_400_000, 216_000),
  ];
  const instances = resolveEnforcingInstances(['checkout', 'payments'], { nodesByContainer: { checkout: 3, payments: 1 } });
  const fd = fleetDefaultFromRows(rows, instances, {}, 'datadog');
  assert.equal(fd.computed, true);
  assert.equal(fd.baseline_container, 'payments');
  assert.equal(fd.cap_bytes_per_window_per_node, 6000);
  assert.equal(fd.headroom, 2);
  assert.equal(fd.action, 'tier_down');
  assert.equal(fd.error_floor, 0);
  // median of 3 and 1 nodes is 2; 6,000 bytes x 360 windows x 2 nodes / 150 bytes a line = 28,800 lines a day
  assert.equal(fd.nodes_for_lines, 2);
  assert.equal(Math.round(fd.limit_lines_per_day!), 28_800);
  assert.equal(
    fd.sentence,
    'Any service not listed: a statement above 28,800 lines a day goes to Flex. Up to 1,800 lines a day of every statement always reach Standard on each node.',
  );
  assert.deepEqual(fd.engine_options!.find(([k]) => k === 'rateReceiverDefaultAction'), ['rateReceiverDefaultAction', 'tier_down']);
  assert.deepEqual(fd.engine_env, [['outputOffload', 'true']]);
  assert.ok(fd.install_note.includes('fleet_default.cap_bytes_per_window_per_node 6000, on engine 1.1.141 or later'));

  const none = fleetDefaultFromRows([row('checkout', 'cart retry', 'tier_down', 90_000, 972_000_000)], instances, { action: 'offload' }, 'datadog');
  assert.equal(none.computed, false);
  assert.equal(none.error_floor, 0.5);
  assert.equal(none.engine_options, undefined);
  assert.ok(none.install_note.startsWith('No fleet default'));
});

test('the POC plan path: the fleet default from the capture\'s kept statements', () => {
  const patterns = [
    { service: 'checkout', name: 'order placed', bytes: 3_600_000, count: 18_000 },
    { service: 'checkout', name: 'cart retry', bytes: 90_000_000, count: 900_000 },
    { service: 'payments', name: 'ledger synced', bytes: 1_800_000, count: 12_000 },
  ];
  const moved = new Set(['cart retry']);
  const instances = resolveEnforcingInstances(['checkout', 'payments'], { nodesByContainer: { checkout: 3, payments: 1 } });
  // One hour: 15 windows. checkout keeps 240,000 bytes a window over 3 nodes, 80,000 per node; payments 120,000 on 1.
  const fd = fleetDefaultFromPatterns(patterns, (p) => moved.has(p.name), 3600, instances, {}, 'datadog', (p) => p.name);
  assert.equal(fd.baseline_container, 'payments');
  assert.equal(fd.baseline_bytes_per_window_per_node, 120_000);
  assert.equal(fd.cap_bytes_per_window_per_node, 240_000);
  // 240,000 x 360 x 2 nodes / 150 bytes a line
  assert.equal(Math.round(fd.limit_lines_per_day!), 1_152_000);
  assert.ok(fd.sentence.startsWith('Any service not listed: a statement above 1,152,000 lines a day goes to Flex.'));
  const none = fleetDefaultFromPatterns(patterns, () => true, 3600, instances, {}, 'datadog', (p) => p.name);
  assert.equal(none.computed, false);
});

test('advise_install: with the limit given, the pinned engine writes the fleet values; below 1.1.141 they are held back and the plan says so', async () => {
  const { putSnapshot } = await import('../src/lib/discovery/snapshot-store.js');
  const { SNAPSHOT_SCHEMA_VERSION } = await import('../src/lib/discovery/types.js');
  const { executeAdviseInstall } = await import('../src/tools/advise-install.js');
  putSnapshot({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'snap-fleet-values',
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
      snapshot_id: 'snap-fleet-values',
      app: 'receiver',
      forwarder: 'fluentbit',
      backends: ['prometheus'],
      backend_credentials: { prometheus: { secretName: 'prom-creds' } },
      airgapped: false,
      license_source: 'builtin',
      log_destination: 'datadog',
      fleet_default: { action: 'tier_down', cap_bytes_per_window_per_node: 6000 },
      k8s_team_label: 'team',
      // Bytes, so the byte limit is written as given; the events form is checked below.
      regulator_unit: 'bytes',
    },
    {} as never,
  );
  const data = out.data as Record<string, unknown>;
  assert.equal(data.mode, 'plan');
  const md = String(data.markdown);
  const pinned = manifestEngineVersion()!;
  assert.equal(pinned, '1.1.150');
  if (engineReadsFleetDefault(pinned)) {
    assert.ok(md.includes('- "rateReceiverAbsoluteCap"\n      - "6000"'));
    assert.ok(md.includes('- "rateReceiverDefaultAction"\n      - "tier_down"'));
    assert.ok(md.includes('- "rateReceiverSeverityFloors"\n      - "ERROR=0"'));
    assert.ok(md.includes('- "k8sTeamLabel"\n      - "team"'));
    assert.ok(md.includes('- name: outputOffload\n        value: "true"'));
    assert.ok(md.includes('rateReceiverAbsoluteCap 6000\nrateReceiverDefaultAction tier_down'), 'the step lists the written values');
    assert.ok(!md.includes('needs engine 1.1.141 or later'));
  } else {
    assert.ok(!md.includes('rateReceiverDefaultAction"'), 'no fleet value in the overlay');
    assert.ok(md.includes(`The fleet default needs engine 1.1.141 or later, the first that reads rateReceiverDefaultAction; this plan installs ${pinned}`));
    assert.ok((data.notes as string[]).some((n) => n.startsWith('The team label needs engine 1.1.141 or later')));
  }
  // The Datadog hash field ships either way.
  assert.ok(md.includes('- "symbolMessageHashField"\n      - "tenx_hash"'));
  const fd = data.fleet_default as Record<string, unknown>;
  assert.equal(fd.receiver_values_written, engineReadsFleetDefault(pinned));
  // Below 1.1.141 none of the fleet values are written, and the notes say why.
  const early = receiverFleetValues({ datadog: true, engineVersion: '1.1.140', teamLabel: 'team', fleetDefault: { capBytesPerWindowPerNode: 6000, action: 'tier_down' } });
  assert.ok(!early.options.some(([k]) => k === 'rateReceiverDefaultAction' || k === 'rateReceiverAbsoluteCap' || k === 'k8sTeamLabel'));
  assert.ok(early.notes.some((n) => n.includes('The fleet default needs engine 1.1.141 or later, the first that reads rateReceiverDefaultAction; this plan installs 1.1.140')));
  assert.ok(early.notes.some((n) => n.startsWith('The team label needs engine 1.1.141 or later')));
  // Counting events on 1.1.146, the limit is written in lines when given in lines.
  const events = receiverFleetValues({ datadog: true, engineVersion: '1.1.146', fleetDefault: { capBytesPerWindowPerNode: 6000, capEventsPerWindowPerNode: 40, action: 'tier_down' } });
  assert.ok(events.options.some(([k, v]) => k === 'rateReceiverUnit' && v === 'events'));
  assert.ok(events.options.some(([k, v]) => k === 'rateReceiverAbsoluteCap' && v === '40'));
});
