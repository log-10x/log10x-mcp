/**
 * Handoff 4b.2, the surfaces around the budget run: the CronJob that runs it
 * in the cluster (service account, RBAC, Datadog keys from a Secret), the
 * GitHub Actions run for the gitops pull, the wizard, the Receiver's events
 * unit on 1.1.146, and the gitops path the mute-list emitters now set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emitCrontab, emitGitHubActions, emitK8sCronJob, emitPolicyYaml, type PolicyOptions } from '../src/lib/scheduler-manifest-emitter.js';
import { parsePolicyYaml } from '../src/lib/policy-loader.js';
import { executeSetupRecurring } from '../src/tools/setup-recurring.js';
import { receiverFleetValues } from '../src/lib/fleet-default-install.js';

const base: PolicyOptions = {
  target_services: [],
  target_percent: 30,
  schedule: 'every-6h',
  scheduler: 'k8s_cron',
  config_plane: 'https://github.com/acme/log10x-config',
  exceptions: [],
  min_delta_pp: 2,
};

const budget = { ...base, budget_usd_monthly: 20_000, standard_indexes: ['main'], namespace: 'logging' } as PolicyOptions;

function embeddedPolicy(manifest: string): string {
  const start = manifest.indexOf('  policy.yaml: |\n') + '  policy.yaml: |\n'.length;
  const end = manifest.indexOf('\n---', start);
  return manifest
    .slice(start, end)
    .split('\n')
    .map((l) => l.replace(/^    /, ''))
    .join('\n');
}

test('budget CronJob: service account, RBAC on the one ConfigMap, pods and nodes, Datadog keys from a Secret', () => {
  const m = emitK8sCronJob(budget);
  assert.match(m, /kind: ServiceAccount\nmetadata:\n  name: log10x-budget-run\n  namespace: logging/);
  assert.match(m, /resources: \["configmaps"\]\n    resourceNames: \["log10x-action-intent"\]\n    verbs: \["get", "update"\]/);
  assert.match(m, /kind: ClusterRole\n[\s\S]*resources: \["pods"\]\n    verbs: \["list"\]/);
  assert.match(m, /serviceAccountName: log10x-budget-run/);
  assert.match(m, /- name: DD_API_KEY\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: log10x-datadog\n\s+key: DD_API_KEY/);
  assert.match(m, /- name: DD_APP_KEY\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: log10x-datadog\n\s+key: DD_APP_KEY/);
  assert.match(m, /key: DD_SITE\n\s+optional: true/);
  assert.doesNotMatch(m, /LOG10X_API_KEY/);
  assert.doesNotMatch(m, /kubectl (get|apply)(?! -f log10x-cronjob)/);
  const p = parsePolicyYaml(embeddedPolicy(m));
  assert.equal(p.budget_usd?.usd_monthly, 20_000);
  assert.deepEqual(p.budget_usd?.standard_indexes, ['main']);
  assert.equal(p.budget_usd?.keep_count, 50);
  assert.equal(p.config_plane.delivery, 'configmap');
  assert.equal(p.config_plane.namespace, 'logging');
});

test('budget on GitHub Actions: Datadog secrets, the checkout as the repo path, nodes from policy.yaml', () => {
  const opts = { ...budget, scheduler: 'github_actions', nodes_by_container: { checkout: 3 } } as PolicyOptions;
  const w = emitGitHubActions(opts);
  assert.match(w, /DD_API_KEY: \$\{\{ secrets\.DD_API_KEY \}\}/);
  assert.match(w, /DD_APP_KEY: \$\{\{ secrets\.DD_APP_KEY \}\}/);
  assert.match(w, /LOG10X_GITOPS_REPO_PATH: \$\{\{ github\.workspace \}\}/);
  assert.doesNotMatch(w, /LOG10X_API_KEY/);
});

test('budget policy.yaml for gitops round-trips nodes_by_container', () => {
  const y = emitPolicyYaml({ ...budget, scheduler: 'github_actions', nodes_by_container: { checkout: 3, payments: 2 } } as PolicyOptions);
  const p = parsePolicyYaml(y);
  assert.equal(p.config_plane.delivery, 'gitops');
  assert.deepEqual(p.budget_usd?.nodes_by_container, { checkout: 3, payments: 2 });
});

test('mute-list emitters name the checkout in LOG10X_GITOPS_REPO_PATH, the variable the tick reads', () => {
  const gha = emitGitHubActions({ ...base, scheduler: 'github_actions' });
  assert.match(gha, /LOG10X_GITOPS_REPO_PATH: \$\{\{ github\.workspace \}\}/);
  assert.match(gha, /LOG10X_API_KEY: \$\{\{ secrets\.LOG10X_API_KEY \}\}/);
  const cron = emitCrontab({ ...base, scheduler: 'crontab', config_plane: '/srv/log10x-config' });
  assert.match(cron.wrapper_script, /export LOG10X_GITOPS_REPO_PATH="\/srv\/log10x-config"/);
});

test('wizard: a Standard budget on a scheduler that cannot hold it is asked to move', async () => {
  let r = await executeSetupRecurring({ target_services: [] });
  const session_id = (r as any).data.session_id as string;
  r = await executeSetupRecurring({ session_id, budget_usd_monthly: 20_000, schedule: 'every-6h', scheduler: 'eventbridge' });
  assert.equal((r as any).data.question_id, 'scheduler');
  assert.match((r as any).data.markdown, /holds no budget/);
  r = await executeSetupRecurring({ session_id, scheduler: 'k8s_cron', namespace: 'logging', confirm: true });
  assert.equal((r as any).data.question_id, 'standard_indexes', 'the Standard indexes are required');
  r = await executeSetupRecurring({ session_id, standard_indexes: ['main'] });
  assert.equal((r as any).data.mode, 'emit');
  assert.match((r as any).data.scheduler_manifest, /serviceAccountName: log10x-budget-run/);
  assert.match((r as any).data.apply_instructions, /counts events by default and records that in the policy ConfigMap \(`regulator-unit`\)/);
  assert.match((r as any).data.policy_yaml, /budget_usd_monthly: 20000/);
});

test('install: a Datadog Receiver counts events by default from 1.1.146 only; a byte fleet limit is never written as lines', () => {
  const fd = { capBytesPerWindowPerNode: 6000, action: 'tier_down' as const };
  const ready = receiverFleetValues({ datadog: true, engineVersion: '1.1.146', fleetDefault: fd });
  assert.ok(ready.options.some(([k, v]) => k === 'rateReceiverUnit' && v === 'events'));
  assert.ok(!ready.options.some(([k]) => k === 'rateReceiverAbsoluteCap'));
  assert.ok(ready.options.some(([k, v]) => k === 'rateReceiverDefaultAction' && v === 'tier_down'));
  const early = receiverFleetValues({ datadog: true, engineVersion: '1.1.145', unit: 'events', fleetDefault: fd });
  assert.ok(!early.options.some(([k]) => k === 'rateReceiverUnit'));
  assert.ok(early.options.some(([k]) => k === 'rateReceiverAbsoluteCap'));
  assert.ok(early.notes.some((n) => n.includes('the budget run must not hold this install')));
  const bytes = receiverFleetValues({ datadog: true, engineVersion: '1.1.146', unit: 'bytes', fleetDefault: fd });
  assert.ok(!bytes.options.some(([k]) => k === 'rateReceiverUnit'));
  assert.ok(bytes.options.some(([k, v]) => k === 'rateReceiverAbsoluteCap' && v === '6000'));
  assert.ok(!receiverFleetValues({ datadog: false, engineVersion: '1.1.146' }).options.some(([k]) => k === 'rateReceiverUnit'));
});

test('review 5 gate: the mute-list CronJob no longer names the repo URL as if it were a checkout', () => {
  const m = emitK8sCronJob({ ...base, scheduler: 'k8s_cron' });
  assert.doesNotMatch(m, /name: LOG10X_GITOPS_REPO\n/);
  assert.match(m, /# No LOG10X_GITOPS_REPO_PATH: this Job has no checkout of https:\/\/github\.com\/acme\/log10x-config\./);
});

test('review 2: the gitops budget policy names its Standard indexes and the policy branch', () => {
  const y = emitPolicyYaml({ ...budget, scheduler: 'github_actions', nodes_by_container: { checkout: 3 } } as PolicyOptions);
  const p = parsePolicyYaml(y);
  assert.deepEqual(p.budget_usd?.standard_indexes, ['main']);
  assert.equal(p.config_plane.policy_branch, 'log10x-policy');
});
