/**
 * kubectl-writer acceptance tests.
 *
 * Covers the structured-result contract of `applyViaKubectl`:
 *
 *   1. Happy path — dry-run + apply both succeed; result.status='applied'.
 *   2. Dry-run only — caller passes dryRun=true; no real apply runs.
 *   3. 403 Forbidden — kubectl exits non-zero with "Forbidden …";
 *      result.status='forbidden' and the structured error carries an
 *      RBAC-actionable hint.
 *   4. 404 NotFound — namespace missing; result.status='not_found'.
 *   5. RequestEntityTooLarge — pre-flight size guard fires BEFORE kubectl
 *      is even invoked (verifies the pre-flight path) and kubectl-side
 *      stderr classification also maps to request_entity_too_large.
 *   6. kubectl missing — ENOENT surfaces as kubectl_unavailable, not a throw.
 *   7. Timeout — SIGTERM + null status maps to status='timeout'.
 *   8. YAML rendering — namespace + configmap appear in the YAML piped to
 *      stdin, and keys are sorted deterministically.
 *
 * Mocking strategy: we inject a fake `spawn` function into `applyViaKubectl`
 * so no real process is started. The fake captures the args and stdin and
 * returns canned stdout/stderr/exit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyViaKubectl,
  renderConfigMapYaml,
  classifyKubectlStderr,
  buildVerificationHint,
  CONFIGMAP_MAX_BYTES,
  type SpawnSyncFn,
  type SpawnSyncResult,
} from '../src/lib/configure-engine/kubectl-writer.js';

// ─── helpers ─────────────────────────────────────────────────────────

interface Captured {
  command: string;
  args: string[];
  stdin: string;
}

/**
 * Build a fake spawn function that returns the queue of canned results
 * in order. The captured invocations are pushed into `captured`.
 */
function makeFakeSpawn(
  results: SpawnSyncResult[],
  captured: Captured[],
): SpawnSyncFn {
  let i = 0;
  return (command, args, opts) => {
    captured.push({ command, args: [...args], stdin: opts.input });
    if (i >= results.length) {
      throw new Error(`fake spawn: no more results queued (call #${i + 1})`);
    }
    return results[i++];
  };
}

function okResult(stdout = ''): SpawnSyncResult {
  return { status: 0, stdout, stderr: '' };
}

function failResult(stderr: string, status = 1): SpawnSyncResult {
  return { status, stdout: '', stderr };
}

// ─── test 1: happy path ───────────────────────────────────────────────

test('happy path: dry-run + real apply both succeed; result.status=applied', () => {
  const captured: Captured[] = [];
  const spawn = makeFakeSpawn(
    [
      okResult('configmap/log10x-action-intent serverside-applied (dry run)'),
      okResult('configmap/log10x-action-intent configured'),
    ],
    captured,
  );

  const res = applyViaKubectl({
    namespace: 'demo',
    configmap: 'log10x-action-intent',
    content: { 'action-intent.json': '{"entries":[]}\n' },
    dryRun: false,
    spawn,
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'applied');
  assert.equal(res.error, undefined);
  // Two kubectl invocations: server-side dry-run pre-flight + real apply.
  assert.equal(captured.length, 2);
  assert.ok(
    captured[0].args.includes('--dry-run=server'),
    'first call must be server-side dry-run',
  );
  assert.ok(
    !captured[1].args.includes('--dry-run=server'),
    'second call must be the real apply (no --dry-run)',
  );
  assert.ok(captured[0].args.includes('-n'));
  assert.ok(captured[0].args.includes('demo'));
  assert.ok(captured[0].stdin.includes("name: 'log10x-action-intent'"));
  assert.ok(captured[0].stdin.includes("namespace: 'demo'"));
  // verification_hint is always present.
  assert.match(res.verification_hint, /kubectl get configmap/);
});

// ─── test 2: dry-run only ──────────────────────────────────────────────

test('dryRun=true: only the server-side dry-run runs; status=dry_run_ok', () => {
  const captured: Captured[] = [];
  const spawn = makeFakeSpawn([okResult('configmap/x serverside-applied (dry run)')], captured);

  const res = applyViaKubectl({
    namespace: 'demo',
    configmap: 'log10x-action-intent',
    content: { 'action-intent.json': '{}' },
    dryRun: true,
    spawn,
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'dry_run_ok');
  assert.equal(captured.length, 1, 'only one kubectl invocation (the dry-run)');
  assert.ok(captured[0].args.includes('--dry-run=server'));
  assert.match(res.dry_run_diff ?? '', /serverside-applied/);
});

// ─── test 3: 403 Forbidden ─────────────────────────────────────────────

test('403 Forbidden: result.status=forbidden, structured error mentions RBAC', () => {
  const captured: Captured[] = [];
  const stderr =
    'Error from server (Forbidden): configmaps is forbidden: User "minimal" cannot create resource "configmaps" in API group "" in the namespace "demo"';
  const spawn = makeFakeSpawn([failResult(stderr)], captured);

  const res = applyViaKubectl({
    namespace: 'demo',
    configmap: 'log10x-action-intent',
    content: { 'a.json': '{}' },
    dryRun: false,
    spawn,
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 'forbidden');
  assert.equal(res.error?.error_type, 'config_missing');
  assert.equal(res.error?.retryable, false);
  assert.match(res.error?.hint ?? '', /RBAC|Forbidden/i);
  // Only one kubectl call — the dry-run pre-flight failed.
  assert.equal(captured.length, 1);
});

// ─── test 4: 404 NotFound ──────────────────────────────────────────────

test('NotFound (namespace missing): result.status=not_found', () => {
  const captured: Captured[] = [];
  const stderr =
    'Error from server (NotFound): namespaces "missing-ns" not found';
  const spawn = makeFakeSpawn([failResult(stderr)], captured);

  const res = applyViaKubectl({
    namespace: 'missing-ns',
    configmap: 'log10x-action-intent',
    content: { 'a.json': '{}' },
    dryRun: false,
    spawn,
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 'not_found');
  assert.equal(res.error?.error_type, 'config_missing');
  assert.match(res.error?.hint ?? '', /NotFound|namespace/i);
});

// ─── test 5: RequestEntityTooLarge ─────────────────────────────────────

test('RequestEntityTooLarge: pre-flight size guard fires before kubectl', () => {
  const captured: Captured[] = [];
  // No spawn results queued — pre-flight must short-circuit before any call.
  const spawn = makeFakeSpawn([], captured);

  // Build a payload that exceeds the 1 MiB soft limit.
  const big = 'x'.repeat(CONFIGMAP_MAX_BYTES + 1);
  const res = applyViaKubectl({
    namespace: 'demo',
    configmap: 'log10x-action-intent',
    content: { 'big.json': big },
    dryRun: false,
    spawn,
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 'request_entity_too_large');
  assert.equal(captured.length, 0, 'no kubectl call should have been made');
  assert.match(res.error?.hint ?? '', /1 MiB|apiserver|exceeds/i);
});

test('apiserver-side RequestEntityTooLarge (rare): stderr classifier maps it', () => {
  assert.equal(classifyKubectlStderr('Request entity too large: limit is 1048576'), 'request_entity_too_large');
  assert.equal(classifyKubectlStderr('forbidden: cannot create'), 'forbidden');
  assert.equal(classifyKubectlStderr('NotFound: namespaces "x"'), 'not_found');
});

// ─── test 6: kubectl missing ───────────────────────────────────────────

test('kubectl binary missing (ENOENT): kubectl_unavailable, no throw', () => {
  const captured: Captured[] = [];
  const enoent = new Error('spawn kubectl ENOENT') as Error & { code?: string };
  enoent.code = 'ENOENT';
  const spawn = makeFakeSpawn(
    [{ status: null, stdout: '', stderr: '', error: enoent }],
    captured,
  );

  const res = applyViaKubectl({
    namespace: 'demo',
    configmap: 'log10x-action-intent',
    content: { 'a.json': '{}' },
    dryRun: false,
    spawn,
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 'kubectl_unavailable');
  assert.equal(res.error?.error_type, 'config_missing');
  assert.match(res.error?.hint ?? '', /kubectl/);
});

// ─── test 7: timeout ───────────────────────────────────────────────────

test('SIGTERM + status=null maps to timeout', () => {
  const captured: Captured[] = [];
  const spawn = makeFakeSpawn(
    [{ status: null, stdout: '', stderr: '', signal: 'SIGTERM' }],
    captured,
  );

  const res = applyViaKubectl({
    namespace: 'demo',
    configmap: 'log10x-action-intent',
    content: { 'a.json': '{}' },
    dryRun: false,
    spawn,
    timeoutMs: 100,
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 'timeout');
  assert.equal(res.error?.error_type, 'backend_timeout');
  assert.equal(res.error?.retryable, true);
});

// ─── test 8: YAML rendering determinism ───────────────────────────────

test('renderConfigMapYaml is deterministic and sorts keys', () => {
  const a = renderConfigMapYaml({
    namespace: 'demo',
    configmap: 'cm-x',
    content: { b: 'two', a: 'one', c: 'three' },
  });
  const b = renderConfigMapYaml({
    namespace: 'demo',
    configmap: 'cm-x',
    content: { c: 'three', a: 'one', b: 'two' },
  });
  // Render twice and confirm the data section is byte-identical for both
  // orderings (we ignore the written-at timestamp).
  const stripTs = (s: string) => s.replace(/log10x\.com\/written-at': '[^']+'/g, "log10x.com/written-at': 'X'");
  assert.equal(stripTs(a), stripTs(b));
  // Sanity: key order in the rendered YAML is a < b < c. Split at
  // \ndata: (newline-anchored) so we don't accidentally cut inside
  // "metadata:".
  const dataSection = a.split('\ndata:')[1];
  assert.ok(dataSection, 'rendered YAML must have a data section');
  const aIdx = dataSection.indexOf('a:');
  const bIdx = dataSection.indexOf('b:');
  const cIdx = dataSection.indexOf('c:');
  assert.ok(aIdx >= 0 && bIdx >= 0 && cIdx >= 0, 'all keys must appear in data section');
  assert.ok(aIdx < bIdx && bIdx < cIdx, 'data keys must be sorted alphabetically');
});

test('renderConfigMapYaml puts multiline values in YAML block-literal form', () => {
  const yaml = renderConfigMapYaml({
    namespace: 'demo',
    configmap: 'cm',
    content: { 'a.json': '{\n  "x": 1\n}\n' },
  });
  // The block-literal marker `|` should appear on the value line.
  assert.match(yaml, /a\.json'?:\s*\|/);
});

// ─── invalid identifier validation ─────────────────────────────────────

test('invalid namespace (DNS-1123): failed_validation', () => {
  const res = applyViaKubectl({
    namespace: 'Bad_NS!',
    configmap: 'log10x-action-intent',
    content: { 'a.json': '{}' },
    dryRun: false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'failed_validation');
  assert.equal(res.error?.error_type, 'schema_invalid');
});

test('invalid configmap name (DNS-1123): failed_validation', () => {
  const res = applyViaKubectl({
    namespace: 'demo',
    configmap: 'Bad CM',
    content: { 'a.json': '{}' },
    dryRun: false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'failed_validation');
  assert.equal(res.error?.error_type, 'schema_invalid');
});

// ─── verification hint ────────────────────────────────────────────────

test('buildVerificationHint surfaces both get-configmap and logs commands', () => {
  const hint = buildVerificationHint('demo', 'log10x-action-intent');
  assert.match(hint, /kubectl get configmap -n demo log10x-action-intent/);
  assert.match(hint, /kubectl logs/);
});
