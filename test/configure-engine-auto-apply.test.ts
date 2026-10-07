/**
 * The ConfigMap delivery puts a policy live at once, so it does not apply by
 * default: the call renders the policy and stops, and one explicit
 * `auto_apply: true` call writes it. The gitops delivery still opens its PR,
 * which the operator merges.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { configureEngineSchema, resolveAutoApply } from '../src/tools/configure-engine.js';

test('auto_apply is unset unless the caller sets it, so the delivery decides', () => {
  assert.equal(z.object(configureEngineSchema).parse({ service: 's', target_percent: 30 }).auto_apply, undefined);
});

test('the ConfigMap delivery renders and stops by default', () => {
  assert.equal(resolveAutoApply({ delivery: 'kubectl_configmap' }), false);
  assert.equal(resolveAutoApply({ delivery: 'kubectl_configmap', auto_apply: true }), true);
});

test('the gitops delivery opens its PR by default', () => {
  assert.equal(resolveAutoApply({ delivery: 'gitops' }), true);
  assert.equal(resolveAutoApply({}), true);
  assert.equal(resolveAutoApply({ delivery: 'gitops', auto_apply: false }), false);
});
