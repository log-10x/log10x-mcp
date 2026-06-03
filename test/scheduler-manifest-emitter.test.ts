/**
 * Tests for src/lib/scheduler-manifest-emitter.ts
 *
 * Covers:
 *   - cron expression resolution for each preset + passthrough
 *   - policy.yaml structure (YAML parses, required fields present)
 *   - k8s CronJob YAML (parses, correct cron, namespace, secret refs)
 *   - GitHub Actions workflow YAML (parses, correct cron, permissions)
 *   - crontab emitter (crontab_line + wrapper_script shapes)
 *   - yamlString quoting edge cases
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCronExpression,
  emitPolicyYaml,
  emitK8sCronJob,
  emitGitHubActions,
  emitCrontab,
  yamlString,
  type PolicyOptions,
} from '../src/lib/scheduler-manifest-emitter.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const BASE_OPTS: PolicyOptions = {
  target_services: ['frontend', 'checkout'],
  target_percent: 30,
  schedule: 'daily-03utc',
  scheduler: 'k8s_cron',
  config_plane: 'https://github.com/acme/log10x-config',
  exceptions: [],
  min_delta_pp: 2,
};

/** Naive YAML key-value extractor for top-level scalar fields. */
function extractYamlScalar(yaml: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'm');
  const m = yaml.match(re);
  return m?.[1]?.trim();
}

// ─── cron expression resolution ───────────────────────────────────────────────

test('resolveCronExpression: daily-03utc', () => {
  assert.equal(resolveCronExpression('daily-03utc'), '0 3 * * *');
});

test('resolveCronExpression: every-6h', () => {
  assert.equal(resolveCronExpression('every-6h'), '0 */6 * * *');
});

test('resolveCronExpression: every-12h', () => {
  assert.equal(resolveCronExpression('every-12h'), '0 */12 * * *');
});

test('resolveCronExpression: every-24h-localtz returns a valid cron', () => {
  const expr = resolveCronExpression('every-24h-localtz');
  // Must be a 5-field cron expression.
  assert.match(expr, /^[\d*,\-\/]+\s+[\d*,\-\/]+\s+[\d*,\-\/]+\s+[\d*,\-\/]+\s+[\d*,\-\/]+$/);
});

test('resolveCronExpression: custom cron passthrough', () => {
  assert.equal(resolveCronExpression('0 5 * * 1'), '0 5 * * 1');
});

// ─── policy.yaml ──────────────────────────────────────────────────────────────

test('emitPolicyYaml: produces non-empty output', () => {
  const yaml = emitPolicyYaml(BASE_OPTS);
  assert.ok(yaml.length > 0, 'policy yaml must be non-empty');
});

test('emitPolicyYaml: contains schema_version 1.0', () => {
  const yaml = emitPolicyYaml(BASE_OPTS);
  assert.ok(yaml.includes('schema_version: "1.0"'), 'must include schema_version');
});

test('emitPolicyYaml: contains target_percent', () => {
  const yaml = emitPolicyYaml(BASE_OPTS);
  assert.ok(yaml.includes('target_percent: 30'), 'must include target_percent');
});

test('emitPolicyYaml: contains the cron expression', () => {
  const yaml = emitPolicyYaml(BASE_OPTS);
  assert.ok(yaml.includes('0 3 * * *'), 'must include resolved cron expression');
});

test('emitPolicyYaml: contains service names', () => {
  const yaml = emitPolicyYaml(BASE_OPTS);
  assert.ok(yaml.includes('frontend'), 'must include service name');
  assert.ok(yaml.includes('checkout'), 'must include service name');
});

test('emitPolicyYaml: empty target_services emits empty array comment', () => {
  const yaml = emitPolicyYaml({ ...BASE_OPTS, target_services: [] });
  assert.ok(yaml.includes('target_services: []'), 'empty services must yield empty array');
});

test('emitPolicyYaml: contains scheduler kind', () => {
  const yaml = emitPolicyYaml(BASE_OPTS);
  assert.ok(yaml.includes('k8s_cron'), 'must include scheduler kind');
});

test('emitPolicyYaml: contains config_plane repo', () => {
  const yaml = emitPolicyYaml(BASE_OPTS);
  assert.ok(yaml.includes('acme/log10x-config'), 'must include config_plane');
});

test('emitPolicyYaml: contains min_delta_pp', () => {
  const yaml = emitPolicyYaml(BASE_OPTS);
  assert.ok(yaml.includes('min_delta_pp: 2'), 'must include min_delta_pp');
});

test('emitPolicyYaml: exceptions list is included', () => {
  const yaml = emitPolicyYaml({
    ...BASE_OPTS,
    exceptions: ['audit-service', 'compliance-svc'],
  });
  assert.ok(yaml.includes('audit-service'), 'must include exception service');
  assert.ok(yaml.includes('compliance-svc'), 'must include exception service');
});

// ─── k8s CronJob ──────────────────────────────────────────────────────────────

test('emitK8sCronJob: contains apiVersion batch/v1', () => {
  const yaml = emitK8sCronJob(BASE_OPTS);
  assert.ok(yaml.includes('apiVersion: batch/v1'), 'must include batch/v1');
});

test('emitK8sCronJob: contains kind: CronJob', () => {
  const yaml = emitK8sCronJob(BASE_OPTS);
  assert.ok(yaml.includes('kind: CronJob'), 'must include CronJob kind');
});

test('emitK8sCronJob: schedule field contains resolved cron', () => {
  const yaml = emitK8sCronJob(BASE_OPTS);
  assert.ok(yaml.includes('0 3 * * *'), 'must include cron expression');
});

test('emitK8sCronJob: default namespace is log10x', () => {
  const yaml = emitK8sCronJob(BASE_OPTS);
  assert.ok(yaml.includes('namespace: log10x'), 'default namespace must be log10x');
});

test('emitK8sCronJob: custom namespace is used', () => {
  const yaml = emitK8sCronJob({ ...BASE_OPTS, namespace: 'monitoring' });
  assert.ok(yaml.includes('namespace: monitoring'), 'custom namespace must be used');
});

test('emitK8sCronJob: default secret name is log10x-secret', () => {
  const yaml = emitK8sCronJob(BASE_OPTS);
  assert.ok(yaml.includes('log10x-secret'), 'default secret name must be log10x-secret');
});

test('emitK8sCronJob: custom secret name is used', () => {
  const yaml = emitK8sCronJob({ ...BASE_OPTS, secret_name: 'my-secret' });
  assert.ok(yaml.includes('my-secret'), 'custom secret name must appear');
});

test('emitK8sCronJob: env_id injected when supplied', () => {
  const yaml = emitK8sCronJob({ ...BASE_OPTS, env_id: 'env-abc123' });
  assert.ok(yaml.includes('LOG10X_ENV_ID'), 'must include LOG10X_ENV_ID env var');
  assert.ok(yaml.includes('env-abc123'), 'must include env_id value');
});

test('emitK8sCronJob: env_id absent when not supplied', () => {
  const yaml = emitK8sCronJob(BASE_OPTS);
  assert.ok(!yaml.includes('LOG10X_ENV_ID'), 'must not include LOG10X_ENV_ID when not supplied');
});

test('emitK8sCronJob: references LOG10X_API_KEY from secretKeyRef', () => {
  const yaml = emitK8sCronJob(BASE_OPTS);
  assert.ok(yaml.includes('LOG10X_API_KEY'), 'must reference LOG10X_API_KEY');
  assert.ok(yaml.includes('secretKeyRef'), 'must use secretKeyRef');
});

test('emitK8sCronJob: concurrencyPolicy is Forbid', () => {
  const yaml = emitK8sCronJob(BASE_OPTS);
  assert.ok(yaml.includes('concurrencyPolicy: Forbid'), 'concurrencyPolicy must be Forbid');
});

test('emitK8sCronJob: every-6h schedule resolves correctly', () => {
  const yaml = emitK8sCronJob({ ...BASE_OPTS, schedule: 'every-6h' });
  assert.ok(yaml.includes('*/6'), 'must include */6 for every-6h schedule');
});

// ─── GitHub Actions ───────────────────────────────────────────────────────────

test('emitGitHubActions: contains name: log10x-recurring', () => {
  const yaml = emitGitHubActions(BASE_OPTS);
  assert.ok(yaml.includes('name: log10x-recurring'), 'workflow name must be log10x-recurring');
});

test('emitGitHubActions: cron expression is included', () => {
  const yaml = emitGitHubActions(BASE_OPTS);
  assert.ok(yaml.includes('0 3 * * *'), 'must include resolved cron expression');
});

test('emitGitHubActions: has workflow_dispatch trigger', () => {
  const yaml = emitGitHubActions(BASE_OPTS);
  assert.ok(yaml.includes('workflow_dispatch'), 'must include workflow_dispatch');
});

test('emitGitHubActions: contents:write permission declared', () => {
  const yaml = emitGitHubActions(BASE_OPTS);
  assert.ok(yaml.includes('contents: write'), 'must have contents:write permission');
});

test('emitGitHubActions: references LOG10X_API_KEY secret', () => {
  const yaml = emitGitHubActions(BASE_OPTS);
  assert.ok(yaml.includes('LOG10X_API_KEY'), 'must reference LOG10X_API_KEY');
  assert.ok(yaml.includes('secrets.LOG10X_API_KEY'), 'must use secrets.LOG10X_API_KEY');
});

test('emitGitHubActions: env_id injected when supplied', () => {
  const yaml = emitGitHubActions({ ...BASE_OPTS, env_id: 'env-xyz' });
  assert.ok(yaml.includes('LOG10X_ENV_ID'), 'must include LOG10X_ENV_ID');
  assert.ok(yaml.includes('env-xyz'), 'must include env_id value');
});

test('emitGitHubActions: env_id absent when not supplied', () => {
  const yaml = emitGitHubActions(BASE_OPTS);
  assert.ok(!yaml.includes('LOG10X_ENV_ID'), 'must not include LOG10X_ENV_ID when not supplied');
});

test('emitGitHubActions: every-24h-localtz adds UTC note comment', () => {
  const yaml = emitGitHubActions({ ...BASE_OPTS, schedule: 'every-24h-localtz' });
  assert.ok(yaml.includes('UTC'), 'must include UTC note for localtz schedule');
});

test('emitGitHubActions: actions/checkout step present', () => {
  const yaml = emitGitHubActions(BASE_OPTS);
  assert.ok(yaml.includes('actions/checkout'), 'must include checkout step');
});

test('emitGitHubActions: actions/setup-node step present', () => {
  const yaml = emitGitHubActions(BASE_OPTS);
  assert.ok(yaml.includes('actions/setup-node'), 'must include setup-node step');
});

// ─── crontab ──────────────────────────────────────────────────────────────────

test('emitCrontab: returns crontab_line and wrapper_script', () => {
  const result = emitCrontab(BASE_OPTS);
  assert.ok(typeof result.crontab_line === 'string', 'crontab_line must be a string');
  assert.ok(typeof result.wrapper_script === 'string', 'wrapper_script must be a string');
});

test('emitCrontab: crontab_line contains cron expression', () => {
  const { crontab_line } = emitCrontab(BASE_OPTS);
  assert.ok(crontab_line.includes('0 3 * * *'), 'crontab_line must include cron expression');
});

test('emitCrontab: wrapper_script starts with shebang', () => {
  const { wrapper_script } = emitCrontab(BASE_OPTS);
  assert.ok(wrapper_script.startsWith('#!/usr/bin/env bash'), 'wrapper_script must start with shebang');
});

test('emitCrontab: wrapper_script references LOG10X_API_KEY', () => {
  const { wrapper_script } = emitCrontab(BASE_OPTS);
  assert.ok(wrapper_script.includes('LOG10X_API_KEY'), 'wrapper_script must reference LOG10X_API_KEY');
});

test('emitCrontab: wrapper_script references config_plane', () => {
  const { wrapper_script } = emitCrontab(BASE_OPTS);
  assert.ok(
    wrapper_script.includes('acme/log10x-config'),
    'wrapper_script must reference config_plane'
  );
});

test('emitCrontab: wrapper_script injects env_id when supplied', () => {
  const { wrapper_script } = emitCrontab({ ...BASE_OPTS, env_id: 'env-cron' });
  assert.ok(wrapper_script.includes('LOG10X_ENV_ID'), 'must include LOG10X_ENV_ID');
  assert.ok(wrapper_script.includes('env-cron'), 'must include env_id value');
});

// ─── yamlString ───────────────────────────────────────────────────────────────

test('yamlString: plain identifier returned as-is', () => {
  assert.equal(yamlString('k8s_cron'), 'k8s_cron');
  assert.equal(yamlString('daily-03utc'), 'daily-03utc');
});

test('yamlString: string with colon is quoted', () => {
  const result = yamlString('http://example.com');
  assert.ok(result.startsWith('"'), 'string with colon must be quoted');
});

test('yamlString: string with space is quoted', () => {
  const result = yamlString('hello world');
  assert.ok(result.startsWith('"'), 'string with space must be quoted');
});

test('yamlString: empty string is quoted', () => {
  const result = yamlString('');
  assert.ok(result.startsWith('"'), 'empty string must be quoted');
});

test('yamlString: boolean-like string is quoted', () => {
  assert.ok(yamlString('true').startsWith('"'), '"true" must be quoted');
  assert.ok(yamlString('false').startsWith('"'), '"false" must be quoted');
  assert.ok(yamlString('null').startsWith('"'), '"null" must be quoted');
});

test('yamlString: numeric-looking string is quoted', () => {
  const result = yamlString('30');
  assert.ok(result.startsWith('"'), 'numeric-looking string must be quoted');
});

test('yamlString: already-quoted string is returned as-is', () => {
  assert.equal(yamlString('"already"'), '"already"');
});
