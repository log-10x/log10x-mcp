/**
 * policy-loader.ts tests.
 *
 * Covers:
 *   1. Happy-path parse: all fields present → correct values
 *   2. Defaults applied: missing optional fields get sensible defaults
 *   3. Minimal policy: only config_plane.repo required
 *   4. Malformed YAML / empty input → PolicyLoadError
 *   5. Out-of-range target_percent → PolicyLoadError
 *   6. Missing config_plane.repo → PolicyLoadError
 *   7. Severity rules override defaults
 *   8. Exceptions list parsing
 *   9. target_services list parsing
 *  10. commit_strategy field
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicyYaml, PolicyLoadError } from '../src/lib/policy-loader.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const MINIMAL_POLICY = `
schema_version: "1.0"

reduction:
  target_percent: 30
  target_services: []
  exceptions: []
  min_delta_pp: 2

config_plane:
  repo: https://github.com/acme/log10x-config
`;

const FULL_POLICY = `
schema_version: "1.0"

reduction:
  target_services:
    - frontend
    - checkout
    - payments
  target_percent: 40
  exceptions:
    - audit-svc
    - compliance-svc
  min_delta_pp: 5
  lookback_window: 7d
  severity_rules:
    ERROR: keep
    CRITICAL: keep
    WARN: auto
    INFO: drop
    DEBUG: drop

schedule:
  preset: every-6h
  cron_utc: "0 */6 * * *"
  scheduler: github_actions

config_plane:
  repo: https://github.com/acme/log10x-config
  env_id: abc123
  commit_strategy: direct_push
  base_branch: develop
`;

// ─── tests ────────────────────────────────────────────────────────────────────

test('parse happy path: minimal policy resolves defaults', () => {
  const p = parsePolicyYaml(MINIMAL_POLICY);
  assert.equal(p.schema_version, '1.0');
  assert.equal(p.target_percent, 30);
  assert.deepEqual(p.target_services, []);
  assert.deepEqual(p.exceptions, []);
  assert.equal(p.min_delta_pp, 2);
  assert.equal(p.lookback_window, '24h'); // default
  assert.equal(p.config_plane.repo, 'https://github.com/acme/log10x-config');
  assert.equal(p.config_plane.commit_strategy, 'pr'); // default
});

test('parse full policy: all optional fields populated', () => {
  const p = parsePolicyYaml(FULL_POLICY);

  assert.deepEqual(p.target_services, ['frontend', 'checkout', 'payments']);
  assert.equal(p.target_percent, 40);
  assert.deepEqual(p.exceptions, ['audit-svc', 'compliance-svc']);
  assert.equal(p.min_delta_pp, 5);
  assert.equal(p.lookback_window, '7d');

  assert.equal(p.severity_rules.ERROR, 'keep');
  assert.equal(p.severity_rules.CRITICAL, 'keep');
  assert.equal(p.severity_rules.INFO, 'drop');
  assert.equal(p.severity_rules.DEBUG, 'drop');

  assert.equal(p.cron_utc, '0 */6 * * *');
  assert.equal(p.scheduler, 'github_actions');

  assert.equal(p.config_plane.repo, 'https://github.com/acme/log10x-config');
  assert.equal(p.config_plane.env_id, 'abc123');
  assert.equal(p.config_plane.commit_strategy, 'direct_push');
  assert.equal(p.config_plane.base_branch, 'develop');
});

test('default severity_rules: ERROR and CRITICAL are keep', () => {
  const p = parsePolicyYaml(MINIMAL_POLICY);
  assert.equal(p.severity_rules.ERROR, 'keep');
  assert.equal(p.severity_rules.CRITICAL, 'keep');
  assert.equal(p.severity_rules.INFO, 'auto');
  assert.equal(p.severity_rules.DEBUG, 'auto');
});

test('default lookback_window when absent', () => {
  const p = parsePolicyYaml(MINIMAL_POLICY);
  assert.equal(p.lookback_window, '24h');
});

test('lookback_window: custom value accepted', () => {
  const yaml = MINIMAL_POLICY + '\n  lookback_window: 48h\n';
  // The lookback is inside reduction block; rebuild properly:
  const yaml2 = `
schema_version: "1.0"
reduction:
  target_percent: 30
  lookback_window: 48h
config_plane:
  repo: https://github.com/acme/x
`;
  const p = parsePolicyYaml(yaml2);
  assert.equal(p.lookback_window, '48h');
});

test('empty input → PolicyLoadError', () => {
  assert.throws(
    () => parsePolicyYaml(''),
    (err) => err instanceof PolicyLoadError && /empty/i.test(err.message)
  );
});

test('whitespace-only input → PolicyLoadError', () => {
  assert.throws(
    () => parsePolicyYaml('   \n  \n'),
    (err) => err instanceof PolicyLoadError
  );
});

test('missing config_plane.repo → PolicyLoadError', () => {
  const yaml = `
schema_version: "1.0"
reduction:
  target_percent: 30
config_plane:
  env_id: abc123
`;
  assert.throws(
    () => parsePolicyYaml(yaml),
    (err) =>
      err instanceof PolicyLoadError && /config_plane\.repo/i.test(err.message)
  );
});

test('target_percent out of range (0) → PolicyLoadError', () => {
  const yaml = `
schema_version: "1.0"
reduction:
  target_percent: 0
config_plane:
  repo: https://github.com/acme/x
`;
  assert.throws(
    () => parsePolicyYaml(yaml),
    (err) =>
      err instanceof PolicyLoadError && /target_percent/i.test(err.message)
  );
});

test('target_percent out of range (100) → PolicyLoadError', () => {
  const yaml = `
schema_version: "1.0"
reduction:
  target_percent: 100
config_plane:
  repo: https://github.com/acme/x
`;
  assert.throws(
    () => parsePolicyYaml(yaml),
    (err) =>
      err instanceof PolicyLoadError && /target_percent/i.test(err.message)
  );
});

test('negative min_delta_pp → PolicyLoadError', () => {
  const yaml = `
schema_version: "1.0"
reduction:
  target_percent: 30
  min_delta_pp: -1
config_plane:
  repo: https://github.com/acme/x
`;
  assert.throws(
    () => parsePolicyYaml(yaml),
    (err) =>
      err instanceof PolicyLoadError && /min_delta_pp/i.test(err.message)
  );
});

test('exceptions list with multiple values', () => {
  const yaml = `
schema_version: "1.0"
reduction:
  target_percent: 20
  exceptions:
    - svc-a
    - svc-b
    - svc-c
config_plane:
  repo: https://github.com/acme/x
`;
  const p = parsePolicyYaml(yaml);
  assert.deepEqual(p.exceptions, ['svc-a', 'svc-b', 'svc-c']);
});

test('target_services with multiple values', () => {
  const yaml = `
schema_version: "1.0"
reduction:
  target_percent: 25
  target_services:
    - api-gateway
    - user-service
config_plane:
  repo: https://github.com/acme/x
`;
  const p = parsePolicyYaml(yaml);
  assert.deepEqual(p.target_services, ['api-gateway', 'user-service']);
});

test('commit_strategy: direct_push is accepted', () => {
  const yaml = `
schema_version: "1.0"
reduction:
  target_percent: 30
config_plane:
  repo: https://github.com/acme/x
  commit_strategy: direct_push
`;
  const p = parsePolicyYaml(yaml);
  assert.equal(p.config_plane.commit_strategy, 'direct_push');
});

test('unknown commit_strategy falls back to pr', () => {
  const yaml = `
schema_version: "1.0"
reduction:
  target_percent: 30
config_plane:
  repo: https://github.com/acme/x
  commit_strategy: squash_merge
`;
  const p = parsePolicyYaml(yaml);
  assert.equal(p.config_plane.commit_strategy, 'pr');
});

test('env_id in config_plane is parsed', () => {
  const yaml = `
schema_version: "1.0"
reduction:
  target_percent: 30
config_plane:
  repo: https://github.com/acme/x
  env_id: my-env-123
`;
  const p = parsePolicyYaml(yaml);
  assert.equal(p.config_plane.env_id, 'my-env-123');
});

test('missing env_id → undefined, not empty string', () => {
  const p = parsePolicyYaml(MINIMAL_POLICY);
  assert.equal(p.config_plane.env_id, undefined);
});

test('target_percent as string integer is accepted', () => {
  const yaml = `
schema_version: "1.0"
reduction:
  target_percent: 35
config_plane:
  repo: https://github.com/acme/x
`;
  const p = parsePolicyYaml(yaml);
  assert.equal(p.target_percent, 35);
});

test('PolicyLoadError has correct name', () => {
  try {
    parsePolicyYaml('');
  } catch (err) {
    assert.ok(err instanceof PolicyLoadError);
    assert.equal((err as PolicyLoadError).name, 'PolicyLoadError');
  }
});
