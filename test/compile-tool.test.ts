import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidDockerImageRef } from '../src/tools/compile.js';

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
