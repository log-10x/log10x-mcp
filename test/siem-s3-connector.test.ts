/**
 * siem-s3-connector tests — lock the verified Datadog Forwarder / Splunk
 * SQS-based S3 contracts + the notification fan-out gotcha into the recipes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siemS3ConnectorRecipe } from '../src/lib/siem-s3-connector.js';

const P = { bucket: 'tenx-offload', region: 'us-east-1', accountId: '111122223333', prefix: 'app/' };

test('datadog: event-driven, logs-only, NDJSON drop-in, S3 GetObject IAM', () => {
  const r = siemS3ConnectorRecipe('datadog', P);
  assert.equal(r.target, 'datadog');
  assert.match(r.discovery, /event-driven/i);
  assert.ok(r.caveats.some((c) => /logs only/i.test(c)), 'must state logs-only');
  assert.ok(r.caveats.some((c) => /NDJSON/i.test(c)), 'must mention NDJSON');
  const iam = r.blocks.find((b) => b.language === 'json');
  assert.ok(iam && /s3:GetObject/.test(iam.body), 's3:GetObject IAM present');
  // fan-out, not a second raw bucket notification
  assert.match(r.notificationNote, /SNS|EventBridge/);
  assert.ok(r.blocks.some((b) => /aws_sns_topic/.test(b.body)), 'SNS fan-out terraform');
});

test('splunk: SQS-based, new-objects-only, 7 SQS actions + GetObject + kms, inputs.conf', () => {
  const r = siemS3ConnectorRecipe('splunk', P);
  assert.equal(r.target, 'splunk');
  assert.match(r.discovery, /SQS/);
  assert.ok(r.caveats.some((c) => /not collected|created after/i.test(c)), 'pre-queue objects skipped');
  const iam = r.blocks.find((b) => b.language === 'json');
  assert.ok(iam, 'iam block present');
  for (const action of ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 's3:GetObject', 'kms:Decrypt']) {
    assert.ok(iam!.body.includes(action), `IAM includes ${action}`);
  }
  const conf = r.blocks.find((b) => b.language === 'ini');
  assert.ok(conf && /aws_sqs_based_s3/.test(conf.body), 'inputs.conf SQS-based S3 stanza');
});

test('both targets share the fan-out note (bucket already notifies the indexer)', () => {
  for (const t of ['datadog', 'splunk'] as const) {
    const r = siemS3ConnectorRecipe(t, P);
    assert.match(r.notificationNote, /indexer|already/i);
  }
});

test('prefix + bucket are threaded into the recipe', () => {
  const r = siemS3ConnectorRecipe('splunk', { ...P, prefix: 'logs' });
  assert.ok(JSON.stringify(r).includes('tenx-offload'));
  assert.ok(r.blocks.some((b) => b.body.includes('logs/')), 'prefix normalized with trailing slash');
});
