import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidDockerImageRef, parseHelmRepos, classifyHelmChartRef } from '../src/tools/compile.js';

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
