/**
 * configure_engine gitops PR: config-generation.csv emission.
 *
 * Bug shape (repo audit): the kubectl ConfigMap path stamps a sibling
 * config-generation.csv (so the engine advertises tenx_config_version and the
 * config-generation closed loop can verify the running policy), but the gitops
 * PR path committed ONLY caps.csv. Engines deployed via gitops therefore never
 * received a generation file and verification stayed perpetually "stale".
 *
 * Fix: renderPrCommand now also commits config-generation.csv (a sibling of
 * caps.csv) to the same branch before opening the PR, mirroring the kubectl
 * path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrCommand } from '../src/tools/configure-engine.js';

type Args = Parameters<typeof renderPrCommand>[0];
type Resolved = Parameters<typeof renderPrCommand>[1];

function build(lookupPath: string): string {
  const args = {
    service: 'cartservice',
    containers: ['cartservice'],
    current_csv: undefined,
    target_percent: 30,
    reduction: 'hard',
  } as unknown as Args;
  const resolved = {
    gitops_repo: 'acme/infra',
    gitops_branch: 'main',
    lookup_path: lookupPath,
    destination: 'cloudwatch',
  } as unknown as Resolved;
  const csvDiff =
    '--- a/caps.csv\n+++ b/caps.csv\n+container,cap\n+cartservice,100:compact:MCP configure_engine (hard)';
  return renderPrCommand(args, resolved, csvDiff);
}

test('gitops PR commits config-generation.csv as a sibling of caps.csv', () => {
  const script = build('tenx/app/caps.csv');

  // Sibling path derived from the caps.csv lookup path.
  assert.ok(
    script.includes('tenx/app/config-generation.csv'),
    'GEN_PATH should be the sibling config-generation.csv'
  );
  // The generation file content is written via its own heredoc...
  assert.ok(script.includes("<<'GEN_EOF'"), 'GEN_EOF heredoc missing');
  // ...and committed via its own contents-API PUT.
  assert.ok(
    script.includes('gh api "${GEN_PUT_ARGS[@]}"'),
    'config-generation.csv PUT missing'
  );
  // The original caps.csv PUT still happens.
  assert.ok(script.includes('gh api "${PUT_ARGS[@]}"'), 'caps.csv PUT missing');
});

test('config-generation.csv is committed after caps.csv and before the PR opens', () => {
  const script = build('tenx/app/caps.csv');
  const capsPut = script.indexOf('gh api "${PUT_ARGS[@]}"');
  const genPut = script.indexOf('gh api "${GEN_PUT_ARGS[@]}"');
  const prCreate = script.indexOf('gh pr create');
  assert.ok(capsPut > 0 && genPut > 0 && prCreate > 0, 'all three steps present');
  assert.ok(genPut > capsPut, 'gen PUT should come after the caps PUT');
  assert.ok(genPut < prCreate, 'gen PUT should come before the PR is opened');
});

test('sibling path is derived even when the lookup path is not named caps.csv', () => {
  const script = build('config/policy.csv');
  assert.ok(
    script.includes('config/config-generation.csv'),
    'GEN_PATH should replace the final path segment with config-generation.csv'
  );
});
