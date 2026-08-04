/**
 * The not-configured remediation must only ever name a tool the session can
 * actually call.
 *
 * Measured before the fix: on a keyless boot the MCP attaches read-only to the
 * shared public demo account, DEMO_FALLBACK_DENYLIST keeps log10x_configure_env
 * off the tool list, and the metrics_backend remediation still shipped
 * `actions: [{ tool: 'log10x_configure_env' }]` plus markdown walking the agent
 * to that same tool. The agent's required-next step was a tool that answers
 * "no such tool".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNotConfigured, defaultActionsForKind } from '../src/lib/not-configured.js';
import { DEMO_FALLBACK_DENYLIST } from '../src/lib/demo-env.js';
import { TOOL_MODES } from '../src/lib/mode-detect.js';

test('log10x_configure_env is denylisted against the shared demo account', () => {
  // The premise of the whole fix. If this ever stops being true the demo
  // remediation should go back to naming configure_env.
  assert.ok(
    DEMO_FALLBACK_DENYLIST.has('log10x_configure_env'),
    'configure_env must stay off the shared demo account for this remediation to be needed',
  );
});

test('log10x_signin_start is registered in every mode, so it is a safe remediation target', () => {
  assert.deepEqual(TOOL_MODES['log10x_signin_start'], ['always']);
});

test('demo-mode metrics_backend actions point at signin_start, not the denylisted configure_env', () => {
  const demo = defaultActionsForKind('metrics_backend', { configureEnvRegistered: false });
  assert.deepEqual(
    demo.map((a) => a.tool),
    ['log10x_signin_start'],
  );
  assert.equal(demo[0].role, 'required-next');
});

test('the normal metrics_backend actions are unchanged', () => {
  for (const opts of [undefined, { configureEnvRegistered: true }]) {
    const actions = defaultActionsForKind('metrics_backend', opts);
    assert.deepEqual(
      actions.map((a) => a.tool),
      ['log10x_configure_env'],
    );
  }
});

test('demo-mode remediation markdown names signin_start and warns off configure_env', () => {
  const md = renderNotConfigured({
    callingTool: 'log10x_top_patterns',
    configureEnvRegistered: false,
  });
  assert.match(md, /log10x_signin_start/, 'must name the registered sign-in path');
  assert.match(md, /log10x_top_patterns/, 'must name the tool that reported the state');
  assert.match(
    md,
    /Do not call `log10x_configure_env`/,
    'must say plainly that configure_env is not callable here',
  );
});

test('the normal remediation markdown still drives configure_env', () => {
  const md = renderNotConfigured({ callingTool: 'log10x_top_patterns' });
  assert.match(md, /Metrics backend not configured/);
  assert.match(md, /log10x_configure_env/);
  assert.doesNotMatch(md, /Do not call `log10x_configure_env`/);
});
