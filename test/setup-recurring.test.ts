/**
 * Tests for src/tools/setup-recurring.ts
 *
 * Covers:
 *   1. First call with no args mints a session and asks for target_services.
 *   2. Progressive answer accumulation advances through each question.
 *   3. Confirm step is the last before emit.
 *   4. Full happy path emits policy_yaml + scheduler_manifest + apply_instructions.
 *   5. Envelope shape is schema-valid StructuredOutput.
 *   6. Session TTL: expired session IDs start fresh.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeSetupRecurring,
} from '../src/tools/setup-recurring.js';
import { isStructuredOutput, StructuredOutputSchema } from '../src/lib/output-types.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function getData(result: unknown): Record<string, unknown> {
  assert.ok(isStructuredOutput(result), 'expected StructuredOutput');
  return (result as any).data as Record<string, unknown>;
}

/**
 * Drive the wizard through all questions by supplying every answer
 * one at a time. Returns the final emit envelope.
 */
async function driveToEmit(overrides?: {
  scheduler?: string;
  target_percent?: number;
}) {
  // Q1: target_services
  let result = await executeSetupRecurring({
    target_services: ['frontend', 'checkout'],
  });
  let data = getData(result);
  assert.equal(data.mode, 'next_question', 'after target_services should ask next question');
  const session_id = data.session_id as string;

  // Q2: target_percent
  result = await executeSetupRecurring({ session_id, target_percent: overrides?.target_percent ?? 25 });
  data = getData(result);
  assert.equal(data.mode, 'next_question');

  // Q3: schedule
  result = await executeSetupRecurring({ session_id, schedule: 'every-6h' });
  data = getData(result);
  assert.equal(data.mode, 'next_question');

  // Q4: scheduler
  result = await executeSetupRecurring({
    session_id,
    scheduler: (overrides?.scheduler ?? 'github_actions') as any,
  });
  data = getData(result);
  assert.equal(data.mode, 'next_question');

  // Q5: config_plane
  result = await executeSetupRecurring({
    session_id,
    config_plane: 'https://github.com/acme/log10x-config',
  });
  data = getData(result);
  // Should be at the confirm question now.
  assert.equal(data.mode, 'next_question');
  assert.equal(data.question_id, 'confirm', 'should ask for confirm next');

  // Confirm
  result = await executeSetupRecurring({ session_id, confirm: true });
  return result;
}

// ─── tests ────────────────────────────────────────────────────────────────────

test('first call with no args: schema-valid envelope, asks for target_services', async () => {
  const result = await executeSetupRecurring({});
  assert.ok(isStructuredOutput(result), 'must return StructuredOutput');
  StructuredOutputSchema.parse(result);
  const data = getData(result);
  assert.equal(data.mode, 'next_question', 'first call must ask a question');
  assert.equal(data.question_id, 'target_services', 'first question must be target_services');
  assert.ok(typeof data.session_id === 'string' && data.session_id.length > 0, 'session_id must be set');
});

test('session_id is returned on first call and is reused on subsequent calls', async () => {
  const r1 = await executeSetupRecurring({});
  const d1 = getData(r1);
  const session_id = d1.session_id as string;

  const r2 = await executeSetupRecurring({ session_id, target_services: ['svc-a'] });
  const d2 = getData(r2);
  assert.equal(d2.session_id, session_id, 'session_id must be preserved across calls');
});

test('each answer advances to the next question', async () => {
  const r1 = await executeSetupRecurring({ target_services: [] });
  const d1 = getData(r1);
  assert.equal(d1.question_id, 'target_percent', 'after target_services comes target_percent');

  const sid = d1.session_id as string;
  const r2 = await executeSetupRecurring({ session_id: sid, target_percent: 20 });
  const d2 = getData(r2);
  assert.equal(d2.question_id, 'schedule', 'after target_percent comes schedule');

  const r3 = await executeSetupRecurring({ session_id: sid, schedule: 'every-12h' });
  const d3 = getData(r3);
  assert.equal(d3.question_id, 'scheduler', 'after schedule comes scheduler');

  const r4 = await executeSetupRecurring({ session_id: sid, scheduler: 'crontab' });
  const d4 = getData(r4);
  assert.equal(d4.question_id, 'config_plane', 'after scheduler comes config_plane');

  const r5 = await executeSetupRecurring({ session_id: sid, config_plane: '/opt/log10x-config' });
  const d5 = getData(r5);
  assert.equal(d5.question_id, 'confirm', 'after config_plane comes confirm');
});

test('next_question envelope has required-next action pointing back to the same tool', async () => {
  const result = await executeSetupRecurring({});
  assert.ok(isStructuredOutput(result));
  const actions = (result as any).actions as unknown[];
  assert.ok(Array.isArray(actions) && actions.length > 0, 'actions must be non-empty');
  const first = actions[0] as Record<string, unknown>;
  assert.equal(first.tool, 'log10x_setup_recurring', 'action tool must be log10x_setup_recurring');
  assert.equal(first.role, 'required-next', 'role must be required-next');
});

test('full happy path with github_actions: emits valid artifacts', async () => {
  const result = await driveToEmit({ scheduler: 'github_actions' });
  assert.ok(isStructuredOutput(result), 'final result must be StructuredOutput');
  StructuredOutputSchema.parse(result);

  const data = getData(result);
  assert.equal(data.mode, 'emit', 'mode must be emit');
  assert.equal(data.ok, true, 'ok must be true on emit');

  assert.ok(typeof data.policy_yaml === 'string' && data.policy_yaml.length > 0, 'policy_yaml must be set');
  assert.ok(typeof data.scheduler_manifest === 'string' && data.scheduler_manifest.length > 0, 'scheduler_manifest must be set');
  assert.equal(data.scheduler_manifest_filename, '.github/workflows/log10x-recurring.yml');
  assert.ok(typeof data.apply_instructions === 'string' && data.apply_instructions.length > 0);
  assert.ok(typeof data.human_summary === 'string' && data.human_summary.length > 0);
  assert.ok(typeof data.markdown === 'string' && data.markdown.length > 0);
});

test('full happy path with k8s_cron: scheduler_manifest_filename is log10x-cronjob.yaml', async () => {
  const result = await driveToEmit({ scheduler: 'k8s_cron' });
  const data = getData(result);
  assert.equal(data.mode, 'emit');
  assert.equal(data.scheduler_manifest_filename, 'log10x-cronjob.yaml');
  const manifest = data.scheduler_manifest as string;
  assert.ok(manifest.includes('kind: CronJob'), 'manifest must include CronJob kind');
});

test('full happy path with crontab: scheduler_manifest_filename is log10x-tick.sh and wrapper_script is set', async () => {
  const result = await driveToEmit({ scheduler: 'crontab' });
  const data = getData(result);
  assert.equal(data.mode, 'emit');
  assert.equal(data.scheduler_manifest_filename, 'log10x-tick.sh');
  assert.ok(
    typeof data.crontab_wrapper_script === 'string' && data.crontab_wrapper_script.length > 0,
    'crontab_wrapper_script must be set for crontab scheduler'
  );
});

test('emit: policy_yaml contains target_percent', async () => {
  const result = await driveToEmit({ target_percent: 42 });
  const data = getData(result);
  const policyYaml = data.policy_yaml as string;
  assert.ok(policyYaml.includes('target_percent: 42'), 'policy_yaml must contain target_percent');
});

test('emit: policy_yaml contains service names', async () => {
  const result = await driveToEmit();
  const data = getData(result);
  const policyYaml = data.policy_yaml as string;
  assert.ok(policyYaml.includes('frontend'), 'policy_yaml must contain service name');
  assert.ok(policyYaml.includes('checkout'), 'policy_yaml must contain service name');
});

test('emit: optional-followup action points to log10x_doctor', async () => {
  const result = await driveToEmit();
  assert.ok(isStructuredOutput(result));
  const actions = (result as any).actions as Array<Record<string, unknown>>;
  const doctor = actions.find((a) => a.tool === 'log10x_doctor');
  assert.ok(doctor, 'emit must suggest log10x_doctor as optional-followup');
  assert.equal(doctor?.role, 'optional-followup');
});

test('all-at-once call: supplying all fields in one call advances to confirm', async () => {
  const result = await executeSetupRecurring({
    target_services: ['api'],
    target_percent: 30,
    schedule: 'daily-03utc',
    scheduler: 'github_actions',
    config_plane: 'https://github.com/acme/log10x-config',
  });
  const data = getData(result);
  // Should be at confirm since everything is set but confirm is still missing.
  assert.equal(data.mode, 'next_question');
  assert.equal(data.question_id, 'confirm');
});

test('all-at-once with confirm: true emits immediately', async () => {
  const result = await executeSetupRecurring({
    target_services: ['api'],
    target_percent: 30,
    schedule: 'daily-03utc',
    scheduler: 'github_actions',
    config_plane: 'https://github.com/acme/log10x-config',
    confirm: true,
  });
  const data = getData(result);
  assert.equal(data.mode, 'emit');
  assert.equal(data.ok, true);
});

test('exceptions are reflected in policy_yaml', async () => {
  const result = await executeSetupRecurring({
    target_services: ['api'],
    target_percent: 30,
    schedule: 'daily-03utc',
    scheduler: 'github_actions',
    config_plane: 'https://github.com/acme/cfg',
    exceptions: ['audit-svc', 'compliance-svc'],
    confirm: true,
  });
  const data = getData(result);
  assert.equal(data.mode, 'emit');
  const policyYaml = data.policy_yaml as string;
  assert.ok(policyYaml.includes('audit-svc'), 'exceptions must appear in policy_yaml');
  assert.ok(policyYaml.includes('compliance-svc'), 'exceptions must appear in policy_yaml');
});

test('min_delta_pp default is 2 when not supplied', async () => {
  const result = await executeSetupRecurring({
    target_services: ['api'],
    target_percent: 30,
    schedule: 'daily-03utc',
    scheduler: 'github_actions',
    config_plane: 'https://github.com/acme/cfg',
    confirm: true,
  });
  const data = getData(result);
  const policyYaml = data.policy_yaml as string;
  assert.ok(policyYaml.includes('min_delta_pp: 2'), 'default min_delta_pp must be 2');
});

test('unknown session_id starts a fresh session', async () => {
  const result = await executeSetupRecurring({ session_id: 'does-not-exist' });
  const data = getData(result);
  // Fresh session — should ask the first question.
  assert.equal(data.mode, 'next_question');
  assert.equal(data.question_id, 'target_services');
  // The returned session_id must be a new one.
  assert.notEqual(data.session_id, 'does-not-exist', 'fresh session must mint a new session_id');
});
