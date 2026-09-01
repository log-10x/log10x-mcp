/**
 * Compaction is only lossless where the destination can expand the encoded
 * events again, and that expander is a separate install on the destination.
 * A plan that recommends compaction and omits it hands the customer broken
 * searches and calls the install a success — so these tests pin BOTH
 * directions: the prerequisite appears wherever compaction is on the table,
 * and never appears on a plan that cannot compact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReporterPlan } from '../../src/lib/advisor/reporter.js';
import { renderPlan } from '../../src/lib/advisor/render.js';
import type { DiscoverySnapshot } from '../../src/lib/discovery/types.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../../src/lib/discovery/types.js';

function baseSnapshot(): DiscoverySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'disc-expander-1',
    startedAt: '2026-09-01T00:00:00Z',
    finishedAt: '2026-09-01T00:01:00Z',
    kubectl: {
      available: true,
      context: 'arn:aws:eks:us-east-1:111:cluster/test',
      namespaces: ['demo', 'logging', 'default'],
      probedNamespaces: ['demo'],
      forwarders: [],
      helmReleases: [],
      log10xApps: [],
      storageClasses: ['gp3'],
      ingressClasses: ['alb'],
      backendAgents: [],
      serviceAccountIrsa: [],
    },
    aws: { available: false, s3Buckets: [], sqsQueues: [], cwLogGroups: [] },
    recommendations: { suggestedNamespace: 'logging', alreadyInstalled: {} },
    probeLog: [],
  };
}

const EXPANDER_ROW = 'destination-expander';

test('Splunk + optimize names the Splunk app as a prerequisite', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentbit',
    licenseJwt: 'test-key',
    destination: 'splunk',
    splunkHecToken: 'tok',
    optimize: true,
  });
  assert.equal(plan.blockers.length, 0, `unexpected blockers: ${plan.blockers.join(' | ')}`);
  const row = plan.preflight.find((p) => p.name === EXPANDER_ROW);
  assert.ok(row, 'expected a destination-expander preflight row');
  assert.match(row.detail, /Splunk app/, 'must name the Splunk app');
});

test('Elasticsearch + optimize names the l1es plugin AND its version pin', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentbit',
    licenseJwt: 'test-key',
    destination: 'elasticsearch',
    optimize: true,
  });
  assert.equal(plan.blockers.length, 0, `unexpected blockers: ${plan.blockers.join(' | ')}`);
  const row = plan.preflight.find((p) => p.name === EXPANDER_ROW);
  assert.ok(row, 'expected a destination-expander preflight row');
  assert.match(row.detail, /l1es/, 'must name the l1es plugin');
  // The plugin is built per platform version; a plan that omits the pin sends
  // the customer to install an artifact that will not load.
  assert.match(row.detail, /8\.17\.0/, 'must carry the Elasticsearch version pin');
});

// A destination with no expander is not a "warn and proceed" case: there is
// nothing to install, the events land permanently unreadable, and the cost
// model pins compact_ratio at 1.0 so there is no saving to trade against it.
for (const destination of ['datadog', 'cloudwatch'] as const) {
  test(`optimize on ${destination} blocks — no expander exists to install`, async () => {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: 'fluentbit',
      licenseJwt: 'test-key',
      destination,
      optimize: true,
    });
    assert.ok(
      plan.blockers.some((b) => b.includes('optimize=true cannot be used')),
      `expected a blocker on ${destination}; got: ${plan.blockers.join(' | ') || '(none)'}`,
    );
    const row = plan.preflight.find((p) => p.name === EXPANDER_ROW);
    assert.equal(row?.status, 'fail', 'preflight must record the failure, not a soft unknown');
  });
}

test('the wizard-shaped plan states the dependency even without a destination', async () => {
  // The install wizard does not ask where events go — it pins destination to
  // `mock` and tells the customer to enable the chart `optimize` flag later.
  // That recommendation is exactly where the prerequisite has to appear.
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentbit',
    licenseJwt: 'test-key',
    destination: 'mock',
  });
  assert.equal(plan.blockers.length, 0, `unexpected blockers: ${plan.blockers.join(' | ')}`);
  const md = renderPlan(plan, 'all');
  assert.match(md, /Splunk app/, 'rendered plan must name the Splunk app');
  assert.match(md, /l1es plugin/, 'rendered plan must name the l1es plugin');
  assert.match(md, /ClickHouse view/, 'rendered plan must name the ClickHouse view');
  // The line that tells the user to turn compaction on later must not do so
  // silently.
  assert.match(md, /Install the destination expander first/);
});

// The mirror-image bug: a plan that cannot compact must not demand a plugin.
test('a Reporter plan never mentions the expander — it cannot compact', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reporter',
    forwarder: 'fluentbit',
    licenseJwt: 'test-key',
    destination: 'mock',
  });
  assert.equal(plan.preflight.find((p) => p.name === EXPANDER_ROW), undefined);
  const md = renderPlan(plan, 'all');
  assert.doesNotMatch(md, /l1es/, 'Reporter has no write-back path; nothing to expand');
});

test('a read-only Receiver never mentions the expander — it writes no events back', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentbit',
    licenseJwt: 'test-key',
    destination: 'splunk',
    splunkHecToken: 'tok',
    readOnly: true,
  });
  assert.equal(plan.preflight.find((p) => p.name === EXPANDER_ROW), undefined);
});
