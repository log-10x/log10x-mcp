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
  forwarderWriteTerraform,
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
    'fluent-bit': /rec\["isDropped"\]==true/,
    'otel-collector': /attributes\["isDropped"\] == true/,
    logstash: /if \[isDropped\]/,
    cribl: /isDropped == true/,
  };
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.match(r.body, expected[fwd], `${fwd}: isDropped match form wrong`);
  }
});

test('each recipe strips isDropped on the output path, never tenx_hash', () => {
  const stripForm: Record<OffloadForwarderId, RegExp> = {
    vector: /except_fields\s*=\s*\["isDropped"\]/,
    fluentd: /remove_keys isDropped/,
    'fluent-bit': /Remove_key\s+isDropped/,
    'otel-collector': /delete_key\(log\.attributes, "isDropped"\)/,
    logstash: /remove_field => \["isDropped"/,
    cribl: /Remove fields: isDropped/,
  };
  // A real removal of tenx_hash would name it as a field token (quoted in
  // vector/otel/logstash, or `remove_keys tenx_hash` / `Remove_key tenx_hash`
  // / `Remove fields: ... tenx_hash`). Comments say "tenx_hash kept" (bare),
  // so guard the directive forms, not any mention.
  const stripsTenxHash =
    /"tenx_hash"|(?:remove_keys|Remove_key|Remove fields:)\s+tenx_hash/;
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.match(r.body, stripForm[fwd], `${fwd}: does not strip isDropped on the output path`);
    assert.ok(!stripsTenxHash.test(r.body), `${fwd}: must NOT strip tenx_hash`);
  }
});

test('fluentd routes with CORE plugins (copy/relabel/grep, no rewrite_tag_filter gem)', () => {
  const r = offloadRecipe('fluentd', PARAMS);
  // copy fans to two labels; grep keeps each slice. No rewrite_tag_filter
  // (an extra gem) and no rewrite loop / root-router escape.
  assert.match(r.body, /@type copy/);
  assert.match(r.body, /@label @TENX_OFFLOAD/);
  assert.match(r.body, /@label @TENX_SIEM/);
  assert.ok(!/rewrite_tag_filter/.test(r.body), 'fluentd must not depend on the rewrite_tag_filter gem');
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

test('after the smoke wave, only otel keeps a SMOKE TEST caveat (S3 path); the rest are verified live', () => {
  const withCaveat: OffloadForwarderId[] = ['otel-collector'];
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    const hasCaveat = r.prerequisites.some(p => p.includes('SMOKE TEST REQUIRED'));
    if (withCaveat.includes(fwd)) {
      assert.ok(hasCaveat, `${fwd}: should still flag the open S3-path smoke test`);
    } else {
      assert.ok(!hasCaveat, `${fwd}: verified live, should carry no SMOKE TEST caveat`);
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

test('Datadog Flex recipe includes index_order companion + provider pin (first-match-wins)', () => {
  const r = datadogFlexRecipe();
  assert.match(r.body, /datadog_logs_index_order/);
  assert.match(r.body, /version\s*=\s*">= 4\.6\.0"/);
  assert.ok(r.note.toLowerCase().includes('first-match'), 'note must explain the first-match ordering requirement');
});

test('forwarder-write Terraform: role + scoped PutObject + IRSA ServiceAccount binding', () => {
  const tf = forwarderWriteTerraform();
  assert.match(tf, /resource "aws_iam_role"/);
  assert.match(tf, /"s3:PutObject"/);
  assert.match(tf, /arn:aws:s3:::\$\{var\.bucket\}\/\$\{var\.prefix\}\/\*/);
  assert.match(tf, /system:serviceaccount:\$\{var\.namespace\}:\$\{var\.service_account\}/);
  assert.match(tf, /sts:AssumeRoleWithWebIdentity/);
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
