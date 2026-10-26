/**
 * Item 10: the fleet-default step after the POC on a Datadog Receiver plan,
 * and the isolated number rule it shares with the change report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultErrorFloor,
  errorMonitorVisibility,
  fleetDefaultLimit,
  alwaysPassSentence,
  alwaysPassLinesPerDay,
} from '../src/lib/fleet-default.js';
import { buildFleetDefaultStep, FLEX_INDEX_FILTER } from '../src/lib/advisor/fleet-default-step.js';
import { putSnapshot } from '../src/lib/discovery/snapshot-store.js';
import { SNAPSHOT_SCHEMA_VERSION, type DiscoverySnapshot } from '../src/lib/discovery/types.js';
import { executeAdviseInstall } from '../src/tools/advise-install.js';
import type { Environments } from '../src/lib/environments.js';

test('the number rule: baseline times headroom, nothing without a baseline', () => {
  assert.equal(fleetDefaultLimit(1000), 2000);
  assert.equal(fleetDefaultLimit(1000, 3), 3000);
  assert.equal(fleetDefaultLimit(0), 0);
  assert.equal(fleetDefaultLimit(Number.NaN), 0);
  assert.equal(fleetDefaultLimit(1000, 0.5), 2000, 'a headroom below 1 falls back to the default');
});

test('error floor defaults: half under offload, none under tier_down', () => {
  assert.equal(defaultErrorFloor('offload'), 0.5);
  assert.equal(defaultErrorFloor('tier_down'), 0);
});

test('what an error monitor sees, per action and floor', () => {
  assert.equal(
    errorMonitorVisibility('offload'),
    'An error monitor sees every ERROR and CRITICAL line under the limit, up to 1,800 lines a day of each statement on each node, and half of the rest. ' +
      'The other error lines above the limit go to S3: no Datadog log monitor sees them and no log-based metric counts them.',
  );
  assert.equal(
    errorMonitorVisibility('tier_down'),
    'An error monitor sees every ERROR and CRITICAL line under the limit and up to 1,800 lines a day of each statement on each node, in Standard. ' +
      'The other error lines above the limit go to Flex, where Datadog runs no log monitors; log-based metrics still count them, because Datadog computes those at ingestion.',
  );
  assert.ok(errorMonitorVisibility('tier_down', 0.25).includes(', and 25% of the rest, in Standard.'));
  assert.ok(errorMonitorVisibility('offload', 1).startsWith('An error monitor sees every ERROR and CRITICAL line: none leaves Standard'));
  assert.equal(alwaysPassLinesPerDay(), 1800);
  assert.equal(alwaysPassSentence(), 'Up to 1,800 lines a day of every statement always reach Standard on each node.');
});

test('the fleet default writes no service total, so its keep count stays per statement with no service bound', () => {
  const s = errorMonitorVisibility('tier_down', 0, 5, 50);
  assert.ok(s.includes('the first 50 lines of each error statement on each node'), s);
  assert.ok(!/500|total/.test(s), s);
});

test('tier_down step: the Flex index with its routeState filter, the sample, the error monitors', () => {
  const s = buildFleetDefaultStep();
  assert.equal(s.action, 'tier_down');
  assert.equal(s.error_floor, 0);
  assert.equal(s.always_pass_lines, 5);
  assert.equal(s.destination_setup.kind, 'flex_index');
  assert.equal(FLEX_INDEX_FILTER, '@routeState:tier_down');
  assert.ok(s.markdown.includes('query = "@routeState:tier_down"'));
  assert.ok(s.markdown.includes('datadog_logs_index_order'));
  assert.ok(s.markdown.includes('a statement above the fleet limit goes to Flex'));
  assert.ok(s.markdown.includes(alwaysPassSentence()));
  assert.ok(s.markdown.includes('The fleet default holds error statements too.'));
  assert.ok(s.markdown.includes('until then a service with no rule keeps every statement in Standard'));
  assert.ok(!s.markdown.includes('\u2014'), 'no em dash');
  assert.ok(!/minute|window|240/i.test(s.markdown.split('```')[0] + s.markdown.split('```').slice(-1)[0]), 'no window length in the prose');
});

test('offload step: the forwarder routing to the bucket, marker kept for Datadog, half the errors kept', () => {
  const s = buildFleetDefaultStep({ action: 'offload', forwarder: 'fluentbit', bucket: 'acme-offload', region: 'us-east-1' });
  assert.equal(s.error_floor, 0.5);
  assert.equal(s.destination_setup.kind, 's3_offload');
  assert.ok(s.markdown.includes('`s3://acme-offload/app/`'));
  assert.ok(s.markdown.includes('**fluent-bit routing**'));
  assert.ok(s.markdown.includes('acme-offload'));
  assert.ok(s.markdown.includes('half of the rest'));
  assert.ok(!s.markdown.includes('### 1. The Flex index'));

  const noS3 = buildFleetDefaultStep({ action: 'offload', forwarder: 'filebeat' });
  assert.ok(noS3.markdown.includes('`filebeat` has no S3 output of its own'));
  assert.ok(noS3.markdown.includes('<offload-bucket>'));

  const floor = buildFleetDefaultStep({ action: 'tier_down', errorFloor: 0.25 });
  assert.equal(floor.error_floor, 0.25);
  assert.ok(floor.error_monitors.includes('25% of the rest'));
});

function k8sSnapshot(id: string): DiscoverySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: id,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    kubectl: {
      available: true,
      namespaces: ['logging'],
      probedNamespaces: ['logging'],
      forwarders: [
        {
          kind: 'fluentbit',
          namespace: 'logging',
          workloadKind: 'DaemonSet',
          workloadName: 'fluent-bit',
          image: 'cr.fluentbit.io/fluent/fluent-bit:3.1.0',
          containerName: 'fluent-bit',
          labels: {},
          readyReplicas: 3,
        },
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
  } as unknown as DiscoverySnapshot;
}

test('advise_install: a Datadog Receiver plan carries the fleet-default step; a Reporter plan says why not', async () => {
  putSnapshot(k8sSnapshot('snap-fleet-default'));
  const out = await executeAdviseInstall(
    {
      snapshot_id: 'snap-fleet-default',
      app: 'receiver',
      forwarder: 'fluentbit',
      backends: ['prometheus'],
      backend_credentials: { prometheus: { secretName: 'prom-creds' } },
      airgapped: false,
      license_source: 'builtin',
      log_destination: 'datadog',
      fleet_default: { action: 'tier_down' },
    },
    {} as Environments,
  );
  const data = out.data as Record<string, unknown>;
  assert.equal(data.mode, 'plan', String(data.markdown).slice(0, 400));
  const md = String(data.markdown);
  assert.ok(md.includes('## After the POC: the fleet default (Datadog)'));
  assert.ok(md.includes('@routeState:tier_down'));
  const fd = data.fleet_default as Record<string, unknown>;
  assert.equal(fd.action, 'tier_down');
  assert.equal(fd.error_floor, 0);
  assert.equal(fd.markdown, undefined);

  putSnapshot(k8sSnapshot('snap-fleet-default-reporter'));
  const rep = await executeAdviseInstall(
    {
      snapshot_id: 'snap-fleet-default-reporter',
      app: 'reporter',
      backends: ['prometheus'],
      backend_credentials: { prometheus: { secretName: 'prom-creds' } },
      airgapped: false,
      license_source: 'builtin',
      log_destination: 'datadog',
    },
    {} as Environments,
  );
  const rd = rep.data as Record<string, unknown>;
  assert.equal(rd.mode, 'plan');
  assert.equal(rd.fleet_default, undefined);
  assert.ok((rd.notes as string[]).some((n) => n.startsWith('The fleet default routes lines above a limit')));
});
