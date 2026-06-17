import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidDockerImageRef,
  parseHelmRepos,
  classifyHelmChartRef,
  stableOutputKey,
} from '../src/tools/compile.js';

/** Minimal CompileArgs with the Zod-defaulted fields filled, for key tests. */
function compileArgs(overrides: Record<string, unknown> = {}) {
  return {
    helm_pull_images: true,
    helm_pull_repos: false,
    artifactory_recursive: true,
    library_name: 'symbols',
    mode: 'auto' as const,
    timeout_ms: 1_800_000,
    ...overrides,
  } as unknown as Parameters<typeof stableOutputKey>[0];
}

// Regression guard: the first cut of DOCKER_IMAGE_RE rejected port-bearing
// registry hosts (localhost:5000/app, harbor.corp:8443/team/app) — exactly the
// private-registry case the docker_username/docker_token args exist for.
test('isValidDockerImageRef accepts legit refs incl. port-bearing private registries', () => {
  for (const ref of [
    'alpine',
    'alpine:latest',
    'alpine:3.19',
    'grafana/grafana:11.1.0',
    'docker.io/library/alpine:latest',
    'docker.io/grafana/grafana:11.1.0',
    'ghcr.io/log-10x/engine:1.1.5',
    'localhost:5000/myapp:1.0',
    'registry.example.com:443/team/app:2.1',
    'my-registry.corp.example.com:8443/team/app:2.1',
    `localhost:5000/foo@sha256:${'a'.repeat(64)}`,
    `docker.io/library/alpine@sha256:${'b'.repeat(64)}`,
  ]) {
    assert.equal(isValidDockerImageRef(ref), true, `should accept ${ref}`);
  }
});

test('isValidDockerImageRef rejects malformed refs', () => {
  for (const ref of [
    '',
    ' alpine',
    'alpine:lat est',
    'a//b..c///:tag',
    'registry:5000/repo/image:tag/',
    `docker.io/alpine@sha256:${'g'.repeat(64)}`, // non-hex digest
  ]) {
    assert.equal(isValidDockerImageRef(ref), false, `should reject ${JSON.stringify(ref)}`);
  }
});

// ── parseHelmRepos ───────────────────────────────────────────────────────

test('parseHelmRepos parses name=url for http(s) chart-repo index URLs', () => {
  const ok = parseHelmRepos([
    'ingress-nginx=https://kubernetes.github.io/ingress-nginx',
    'jetstack=http://charts.jetstack.io',
  ]);
  assert.ok('repos' in ok);
  assert.deepEqual(ok.repos, [
    { name: 'ingress-nginx', url: 'https://kubernetes.github.io/ingress-nginx' },
    { name: 'jetstack', url: 'http://charts.jetstack.io' },
  ]);
});

test('parseHelmRepos rejects bad shapes/names/schemes incl. oci (helm repo add has no oci support)', () => {
  for (const bad of [
    'noequals',
    '=https://x', // empty name
    'bad name=https://x', // space in name
    'r=ftp://x', // unsupported scheme
    'r=oci://registry-1.docker.io/bitnamicharts', // oci not supported by `helm repo add`
    'r=https://has space', // space in url
  ]) {
    const res = parseHelmRepos([bad]);
    assert.ok('error' in res, `should reject ${JSON.stringify(bad)}`);
  }
});

// ── classifyHelmChartRef ─────────────────────────────────────────────────

test('classifyHelmChartRef distinguishes standalone refs, bare repo/chart, and invalid', () => {
  // Standalone (resolve without a repo add) — incl. dashes (regression guard).
  assert.equal(classifyHelmChartRef('oci://ghcr.io/nginxinc/charts/nginx-ingress'), 'standalone');
  assert.equal(classifyHelmChartRef('https://example.com/charts/mychart-1.2.3.tgz'), 'standalone');
  // Bare repo/chart -> needs a helm_repos entry for the prefix.
  assert.deepEqual(classifyHelmChartRef('ingress-nginx/ingress-nginx'), { bareRepo: 'ingress-nginx' });
  // Invalid: unsupported scheme, bare single name, empty, or whitespace.
  assert.equal(classifyHelmChartRef('ftp://x/y'), 'invalid');
  assert.equal(classifyHelmChartRef('singlename'), 'invalid');
  assert.equal(classifyHelmChartRef(''), 'invalid');
  assert.equal(classifyHelmChartRef('has space/chart'), 'invalid');
});

// The old defaultOutputDir embedded Date.now()+pid, so every run got a fresh
// folder and the engine's checksum-based unit reuse never fired. stableOutputKey
// must be deterministic over the sources so re-runs reuse the same folder.
test('stableOutputKey is identical across runs of the same source set', () => {
  const a = stableOutputKey(compileArgs({ github_repos: ['apache/commons-cli'] }), 'symbols');
  const b = stableOutputKey(compileArgs({ github_repos: ['apache/commons-cli'] }), 'symbols');
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{16}$/);
});

test('stableOutputKey changes when any source changes', () => {
  const base = stableOutputKey(compileArgs({ github_repos: ['apache/commons-cli'] }), 'symbols');
  assert.notEqual(base, stableOutputKey(compileArgs({ github_repos: ['apache/commons-lang'] }), 'symbols'));
  assert.notEqual(base, stableOutputKey(compileArgs({ github_repos: ['apache/commons-cli'] }), 'other'));
  assert.notEqual(
    base,
    stableOutputKey(
      compileArgs({
        github_repos: ['apache/commons-cli'],
        artifactory_instance: 'https://art',
        artifactory_repo: 'r',
        artifactory_folders: ['x'],
      }),
      'symbols',
    ),
  );
});

test('stableOutputKey ignores credentials, mode, and timeout (they do not change symbols)', () => {
  const base = stableOutputKey(compileArgs({ source_path: '/src/app' }), 'symbols');
  assert.equal(
    base,
    stableOutputKey(
      compileArgs({ source_path: '/src/app', mode: 'docker', timeout_ms: 60_000, github_token: 'ghp_x' }),
      'symbols',
    ),
  );
});
