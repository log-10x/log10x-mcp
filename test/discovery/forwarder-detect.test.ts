/**
 * Pure-function tests for the forwarder/log10x classifiers. These
 * encode the image-naming conventions we've observed in customer
 * clusters + log10x-repackaged charts so a drift (e.g., fluent-bit
 * registry moves) trips the suite rather than silently breaking
 * discovery.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyForwarderImage,
  classifyLog10xApp,
  isLog10xImage,
} from '../../src/lib/discovery/forwarder-detect.js';

test('classifyForwarderImage: fluentbit variants', () => {
  assert.equal(classifyForwarderImage('cr.fluentbit.io/fluent/fluent-bit:4.0'), 'fluentbit');
  assert.equal(
    classifyForwarderImage('public.ecr.aws/fluent/fluent-bit:3.2.0'),
    'fluentbit'
  );
  assert.equal(classifyForwarderImage('fluentbit/fluentbit:latest'), 'fluentbit');
  // log10x-repackaged variant
  assert.equal(classifyForwarderImage('ghcr.io/log-10x/fluent-bit-10x-dev:dev-g11'), 'fluentbit');
});

test('classifyForwarderImage: fluentd (not confused with fluentbit)', () => {
  assert.equal(classifyForwarderImage('ghcr.io/log-10x/fluentd-10x-dev:dev-g11'), 'fluentd');
  assert.equal(classifyForwarderImage('fluent/fluentd:v1.16'), 'fluentd');
  // fluent-bit must NOT be mis-classified as fluentd even though it contains "fluent".
  assert.equal(
    classifyForwarderImage('cr.fluentbit.io/fluent/fluent-bit:4.0'),
    'fluentbit'
  );
});

test('classifyForwarderImage: other forwarders', () => {
  assert.equal(classifyForwarderImage('docker.elastic.co/beats/filebeat:8.15.0'), 'filebeat');
  assert.equal(classifyForwarderImage('docker.elastic.co/logstash/logstash:8.15.0'), 'logstash');
  assert.equal(
    classifyForwarderImage('otel/opentelemetry-collector-contrib:0.108.0'),
    'otel-collector'
  );
});

test('classifyForwarderImage: vector is NOT supported (returns unknown)', () => {
  // Vector has no log10x-repackaged image + no config-repo module,
  // so the advisor doesn't support it today. Discovery surfaces it as
  // unknown so the advisor falls back to "no existing forwarder".
  assert.equal(classifyForwarderImage('timberio/vector:0.40.0-debian'), 'unknown');
});

test('classifyForwarderImage: unknown for random images', () => {
  assert.equal(classifyForwarderImage('nginx:1.25'), 'unknown');
  assert.equal(classifyForwarderImage('ghcr.io/log-10x/quarkus-10x-dev:dev-obs-v16'), 'unknown');
});

test('classifyLog10xApp: retriever by chart label', () => {
  const labels = { 'helm.sh/chart': 'retriever-10x-1.0.6', app: 'retriever-10x' };
  const out = classifyLog10xApp('ghcr.io/log-10x/quarkus-10x-dev:dev-obs-v16', labels);
  assert.equal(out, 'retriever');
});

test('classifyLog10xApp: retriever by passed chart arg', () => {
  const out = classifyLog10xApp(
    'ghcr.io/log-10x/quarkus-10x-dev:dev-obs-v16',
    {},
    'retriever-10x-1.0.6'
  );
  assert.equal(out, 'retriever');
});

test('classifyLog10xApp: reporter by release name', () => {
  const labels = { 'app.kubernetes.io/instance': 'tenx-cloud-reporter' };
  const out = classifyLog10xApp(
    'ghcr.io/log-10x/fluentd-10x-dev:dev-g11',
    labels,
    'cron-10x-1.0.6'
  );
  assert.equal(out, 'reporter');
});

test('classifyLog10xApp: reducer by release name (policy-gen)', () => {
  const labels = { 'app.kubernetes.io/instance': 'tenx-policy-gen' };
  const out = classifyLog10xApp(
    'ghcr.io/log-10x/fluentd-10x-dev:dev-g11',
    labels,
    'cron-10x-1.0.6'
  );
  assert.equal(out, 'reducer');
});

test('classifyLog10xApp: unknown for non-log10x workloads', () => {
  assert.equal(classifyLog10xApp('nginx:1.25', {}), 'unknown');
});

test('isLog10xImage: positives', () => {
  assert.equal(isLog10xImage('ghcr.io/log-10x/quarkus-10x-dev:dev-obs-v16'), true);
  assert.equal(isLog10xImage('ghcr.io/log-10x/fluentd-10x-dev:dev-g11'), true);
});

test('isLog10xImage: negatives', () => {
  assert.equal(isLog10xImage('nginx:1.25'), false);
  assert.equal(isLog10xImage('fluent/fluentd:v1.16'), false);
  assert.equal(isLog10xImage('otel/opentelemetry-collector-contrib:0.108.0'), false);
});
