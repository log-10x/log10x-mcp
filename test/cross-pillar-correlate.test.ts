import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRUCTURAL_ALIASES } from '../src/lib/cross-pillar-correlate.js';

// The structural validation algorithm is the load-bearing correctness property
// of the v1.4 cross-pillar bridge. These tests exercise the alias map directly
// to verify the tier-assignment paths.

test('STRUCTURAL_ALIASES covers v1.4 label pairs without k8s_node', () => {
  // v1.4 ships 4 alias groups: service, namespace, pod, container.
  assert.equal(STRUCTURAL_ALIASES.length, 4);
  // Each alias group should include the expected Log10x-side label.
  const l10xLabels = STRUCTURAL_ALIASES.flatMap(([, l10x]) => l10x);
  assert.ok(l10xLabels.includes('tenx_user_service'));
  assert.ok(l10xLabels.includes('k8s_namespace'));
  assert.ok(l10xLabels.includes('k8s_pod'));
  assert.ok(l10xLabels.includes('k8s_container'));
  // k8s_node is deliberately absent.
  assert.ok(!l10xLabels.includes('k8s_node'), 'k8s_node must not be in v1.4 structural aliases — deferred to v1.4.1');
});

test('service alias group covers common customer-side service labels', () => {
  const serviceGroup = STRUCTURAL_ALIASES.find(([, l10x]) => l10x.includes('tenx_user_service'));
  assert.ok(serviceGroup);
  const [custAliases] = serviceGroup!;
  assert.ok(custAliases.includes('service'));
  assert.ok(custAliases.includes('service.name'));
  assert.ok(custAliases.includes('dd.service'));
});

test('pod alias group covers common customer-side pod labels', () => {
  const podGroup = STRUCTURAL_ALIASES.find(([, l10x]) => l10x.includes('k8s_pod'));
  assert.ok(podGroup);
  const [custAliases] = podGroup!;
  assert.ok(custAliases.includes('pod'));
  assert.ok(custAliases.includes('kubernetes_pod_name'));
});
