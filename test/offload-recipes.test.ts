/**
 * Emitter-correctness tests for the per-forwarder offload recipes.
 *
 * These are the build-time smoke test for the emitter: they prove the
 * generated recipe is wired to the verified engine contract (boolean
 * `isDropped` match, the Retriever's `{bucket}/app/` JSONL layout, the
 * forwarder-write IAM grant). They do NOT prove a live event routes to S3 on
 * a real forwarder — that is the per-forwarder runtime gate, flagged via the
 * `SMOKE TEST REQUIRED` prerequisite on the research-derived recipes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFLOAD_FORWARDERS,
  offloadRecipe,
  forwarderWriteIamPolicy,
  datadogFlexRecipe,
  cloudwatchIaRecipe,
  otherOffloadForwarders,
  type OffloadForwarderId,
} from '../src/lib/offload-recipes.js';

const PARAMS = { bucket: 'tenx-demo-cloud-retriever-351939435334', region: 'us-east-1' };

test('every forwarder recipe fills bucket, region, and the app/ prefix', () => {
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.ok(r.body.includes(PARAMS.bucket), `${fwd}: bucket missing`);
    assert.ok(r.body.includes(PARAMS.region), `${fwd}: region missing`);
    assert.ok(/\bapp\/?/.test(r.body), `${fwd}: app prefix missing`);
    assert.ok(r.placementNote.length > 0, `${fwd}: placementNote empty`);
  }
});

test('no recipe uses the string "true" form (engine writes an unquoted JSON boolean)', () => {
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.ok(!/==\s*"true"/.test(r.body), `${fwd}: uses == "true" (must be boolean)`);
    assert.ok(!/:\s*"true"/.test(r.body), `${fwd}: quotes the boolean true`);
  }
});

test('each forwarder matches isDropped in its native boolean form', () => {
  const expected: Record<OffloadForwarderId, RegExp> = {
    vector: /\.isDropped == true/,
    fluentd: /key isDropped[\s\S]*pattern \/\^true\$\//,
    'fluent-bit': /\$isDropped \^true\$/,
    'otel-collector': /attributes\["isDropped"\] == true/,
    logstash: /if \[isDropped\]/,
    cribl: /isDropped == true/,
  };
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.match(r.body, expected[fwd], `${fwd}: isDropped match form wrong`);
  }
});

test('every recipe carries the engine offload-mode + IAM prerequisites', () => {
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.ok(
      r.prerequisites.some(p => p.includes('outputOffload')),
      `${fwd}: missing outputOffload prerequisite`
    );
    assert.ok(
      r.prerequisites.some(p => p.includes('s3:PutObject')),
      `${fwd}: missing IAM prerequisite`
    );
  }
});

test('verified-shape forwarders (vector, fluentd) carry NO smoke-test caveat; research ones DO', () => {
  const verified: OffloadForwarderId[] = ['vector', 'fluentd'];
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    const hasCaveat = r.prerequisites.some(p => p.includes('SMOKE TEST REQUIRED'));
    if (verified.includes(fwd)) {
      assert.ok(!hasCaveat, `${fwd}: should be verified-shape (no smoke-test caveat)`);
    } else {
      assert.ok(hasCaveat, `${fwd}: research-derived recipe must flag SMOKE TEST REQUIRED`);
    }
  }
});

test('custom prefix flows through to the S3 key', () => {
  const r = offloadRecipe('vector', { ...PARAMS, prefix: 'logs' });
  assert.ok(r.body.includes('logs/'), 'custom prefix not used');
  assert.ok(!r.body.includes('"app/"'), 'default prefix leaked');
});

test('forwarder-write IAM grants PutObject scoped to the offload prefix', () => {
  const iam = forwarderWriteIamPolicy(PARAMS);
  const doc = JSON.parse(iam.policyJson);
  assert.equal(doc.Statement[0].Effect, 'Allow');
  assert.deepEqual(doc.Statement[0].Action, ['s3:PutObject']);
  assert.equal(
    doc.Statement[0].Resource,
    `arn:aws:s3:::${PARAMS.bucket}/app/*`
  );
  assert.ok(iam.attachmentNote.includes('IRSA'), 'no IRSA attachment guidance');
});

test('Datadog Flex recipe routes @isDropped:true via the retention waterfall', () => {
  const r = datadogFlexRecipe();
  assert.equal(r.target, 'datadog-flex');
  assert.match(r.body, /@isDropped:true/);
  assert.match(r.body, /retention_days\s*=\s*0/);
  assert.match(r.body, /flex_retention_days\s*=\s*30/);
  assert.ok(r.note.toLowerCase().includes('index'), 'should clarify index-not-ingest saving');
  assert.ok(!r.note.toLowerCase().includes('cuts the ingest'), 'must not claim ingest saving');
});

test('CloudWatch IA recipe creates an Infrequent-Access log group', () => {
  const r = cloudwatchIaRecipe();
  assert.equal(r.target, 'cloudwatch-ia');
  assert.match(r.body, /log_group_class\s*=\s*"INFREQUENT_ACCESS"/);
  assert.ok(r.note.includes('stamp-miss'), 'missing the fallback-billing hardening note');
});

test('otherOffloadForwarders excludes the detected one, stable order', () => {
  const rest = otherOffloadForwarders('fluentd');
  assert.ok(!rest.includes('fluentd'));
  assert.equal(rest.length, OFFLOAD_FORWARDERS.length - 1);
  assert.deepEqual(rest, OFFLOAD_FORWARDERS.filter(f => f !== 'fluentd'));
});
