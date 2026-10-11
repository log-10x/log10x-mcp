/**
 * The doctor's enrichment-floor check asks the metrics backend for the labels
 * cross-pillar correlation needs. Pod and host are not among them: the shipped
 * metric outputs drop both so the custom-metric count does not grow with
 * nodes or restarts, and a check that demanded them would warn on every
 * healthy install.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CROSS_PILLAR_REQUIRED_LABELS } from '../src/tools/doctor.js';

test('the enrichment floor asks for service, namespace and container only', () => {
  assert.deepEqual(CROSS_PILLAR_REQUIRED_LABELS, ['tenx_user_service', 'k8s_namespace', 'k8s_container']);
});

test('no per-node label is required', () => {
  for (const label of ['k8s_pod', 'tenx_host_name', 'tenx_pipeline_uuid']) {
    assert.ok(!CROSS_PILLAR_REQUIRED_LABELS.includes(label), label);
  }
});
