/**
 * Emitter-correctness tests for the per-forwarder offload recipes.
 *
 * These are the build-time smoke test for the emitter: they prove the
 * generated recipe is wired to the verified engine contract (string
 * `routeState == "drop"` match, the Retriever's `{bucket}/app/` JSONL layout, the
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

test('no recipe uses the legacy boolean form (engine writes the string "drop")', () => {
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.ok(!/==\s*true\b/.test(r.body), `${fwd}: uses == true (must be string equality on "drop")`);
    assert.ok(!/==\s*"true"/.test(r.body), `${fwd}: matches the string "true" (the wire value is "drop")`);
  }
});

test('each forwarder matches routeState in its native string form (offload action)', () => {
  // The engine now stamps a per-service action name; each forwarder routes the
  // `offload` slice to S3 via a string match on that name.
  const expected: Record<OffloadForwarderId, RegExp> = {
    vector: /\.routeState == "offload"/,
    fluentd: /key routeState[\s\S]*pattern \/\^offload\$\//,
    'fluent-bit': /r=="offload"/,
    'otel-collector': /attributes\["routeState"\] == "offload"/,
    logstash: /if \[routeState\] == "offload"/,
    cribl: /routeState == 'offload'/,
  };
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.match(r.body, expected[fwd], `${fwd}: routeState match form wrong`);
  }
});

test('each forwarder branches per action (offload / tier_down / drop)', () => {
  // Every recipe must name all three non-SIEM actions so the per-service
  // routing is complete (pass/compact/sample fall through to the SIEM).
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    for (const action of ['offload', 'tier_down', 'drop']) {
      assert.ok(
        r.body.includes(action),
        `${fwd}: missing the ${action} branch`,
      );
    }
  }
});

test('each forwarder suppresses the drop slice (no destination for it)', () => {
  // The drop branch must be visibly suppressed, not routed to a sink. Each
  // forwarder expresses suppression in its own idiom.
  const suppression: Record<OffloadForwarderId, RegExp> = {
    // vector: the "drop" route exists but has no [sinks.*] consuming it.
    vector: /route\.drop\s*=/,
    fluentd: /@type null/,
    'fluent-bit': /Name\s+null\s*\n\s*Match\s+tenx\.drop/,
    'otel-collector': /logs\/drop:.*exporters:\s*\[nop\]/,
    logstash: /SUPPRESSED/,
    cribl: /devnull/,
  };
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.match(r.body, suppression[fwd], `${fwd}: drop slice not suppressed`);
  }
});

test('vector: the drop route has no sink consuming it (true suppression)', () => {
  const r = offloadRecipe('vector', PARAMS);
  // No [sinks.*] block should take inputs from tenx_action_route.drop.
  assert.ok(
    !/inputs\s*=\s*\["tenx_action_route\.drop"\]/.test(r.body),
    'vector: a sink consumes the drop route (must be left unwired)',
  );
});

test('each recipe strips routeState on the output path, never tenx_hash', () => {
  const stripForm: Record<OffloadForwarderId, RegExp> = {
    vector: /except_fields\s*=\s*\["routeState"\]/,
    fluentd: /remove_keys routeState/,
    'fluent-bit': /Remove_key\s+routeState/,
    'otel-collector': /delete_key\(log\.attributes, "routeState"\)/,
    logstash: /remove_field => \["routeState"/,
    cribl: /Remove fields: routeState/,
  };
  // A real removal of tenx_hash would name it as a field token (quoted in
  // vector/otel/logstash, or `remove_keys tenx_hash` / `Remove_key tenx_hash`
  // / `Remove fields: ... tenx_hash`). Comments say "tenx_hash kept" (bare),
  // so guard the directive forms, not any mention.
  const stripsTenxHash =
    /"tenx_hash"|(?:remove_keys|Remove_key|Remove fields:)\s+tenx_hash/;
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.match(r.body, stripForm[fwd], `${fwd}: does not strip routeState on the output path`);
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

test('all forwarders are verified live — no recipe carries a SMOKE TEST REQUIRED caveat', () => {
  // vector/fluentd/fluent-bit/logstash verified E2E to file sinks; cribl via
  // `cribl pipe`; otel routing+strip+body-fold + the S3 object shape verified
  // against MinIO. Nothing left pending.
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    const hasCaveat = r.prerequisites.some(p => p.includes('SMOKE TEST REQUIRED'));
    assert.ok(!hasCaveat, `${fwd}: should be verified live with no SMOKE TEST caveat`);
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

test('Datadog Flex recipe routes @routeState:drop via the retention waterfall', () => {
  const r = datadogFlexRecipe();
  assert.equal(r.target, 'datadog-flex');
  assert.match(r.body, /@routeState:drop/);
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
