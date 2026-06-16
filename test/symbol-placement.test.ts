import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlacement, DEFAULT_SYMBOL_FOLDER } from '../src/lib/symbol-placement/detect.js';
import { renderSymbolPlacementScript } from '../src/lib/symbol-placement/git.js';
import { type EnvConfig } from '../src/lib/environments.js';

// resolvePlacement reads only `symbolSource` + `gitops` off the env; build
// minimal fixtures and cast (the rest of EnvConfig is irrelevant here).
function env(partial: Partial<EnvConfig>): EnvConfig {
  return partial as EnvConfig;
}

// ── resolvePlacement ────────────────────────────────────────────────────────

test('resolvePlacement: defaults to git + falls back to gitops.repo + rollout', () => {
  const p = resolvePlacement(env({ gitops: { repo: 'acme/config' } }), {});
  assert.equal(p.backend, 'git');
  assert.equal(p.repo, 'acme/config');
  assert.equal(p.repoSource, 'gitops');
  assert.equal(p.folder, DEFAULT_SYMBOL_FOLDER);
  assert.equal(p.syncMode, 'init');
  assert.equal(p.liveness, 'rollout');
  assert.ok(p.notes.some((n) => /rollout/i.test(n)), 'should note rollout requirement');
  assert.ok(p.notes.some((n) => /policy repo/i.test(n)), 'should note reusing the gitops repo');
});

test('resolvePlacement: symbolSource.repo beats gitops.repo', () => {
  const p = resolvePlacement(
    env({ gitops: { repo: 'acme/config' }, symbolSource: { backend: 'git', repo: 'acme/symbols' } }),
    {},
  );
  assert.equal(p.repo, 'acme/symbols');
  assert.equal(p.repoSource, 'symbolSource');
});

test('resolvePlacement: explicit arg.repo wins over everything', () => {
  const p = resolvePlacement(
    env({ gitops: { repo: 'acme/config' }, symbolSource: { backend: 'git', repo: 'acme/symbols' } }),
    { repo: 'acme/override' },
  );
  assert.equal(p.repo, 'acme/override');
  assert.equal(p.repoSource, 'arg');
});

test('resolvePlacement: syncMode=github yields hot-reload (no rollout note)', () => {
  const p = resolvePlacement(
    env({ symbolSource: { backend: 'git', repo: 'acme/symbols', syncMode: 'github' } }),
    {},
  );
  assert.equal(p.syncMode, 'github');
  assert.equal(p.liveness, 'hot-reload');
  assert.ok(!p.notes.some((n) => /rollout/i.test(n)), 'hot-reload path must not push a rollout note');
});

test('resolvePlacement: no repo anywhere → repoSource none + a "need repo" note', () => {
  const p = resolvePlacement(env({}), {});
  assert.equal(p.repo, undefined);
  assert.equal(p.repoSource, 'none');
  assert.ok(p.notes.some((n) => /no git repo resolved/i.test(n)));
});

test('resolvePlacement: folder override is trimmed of slashes', () => {
  const p = resolvePlacement(env({ gitops: { repo: 'a/b' } }), { path: '/tenx/symbols/' });
  assert.equal(p.folder, 'tenx/symbols');
});

test('resolvePlacement: baked backend explains no runtime placement', () => {
  const p = resolvePlacement(env({ symbolSource: { backend: 'baked' } }), {});
  assert.equal(p.backend, 'baked');
  assert.ok(p.notes.some((n) => /baked into its image/i.test(n)));
});

// ── renderSymbolPlacementScript ─────────────────────────────────────────────

const base = {
  libraryPath: '/tmp/out/myapp.10x.tar',
  fileName: 'myapp.10x.tar',
  prBranch: 'mcp/place-symbols-myapp-123',
  message: 'place symbols: myapp.10x.tar',
};

test('render: base64s the library and PUTs to folder/filename via Contents API', () => {
  const s = renderSymbolPlacementScript({
    ...base,
    target: { repo: 'acme/symbols', branch: 'main', folder: 'symbols' },
    openPr: true,
  });
  assert.match(s, /base64 < "\$LIBRARY"/);
  assert.match(s, /DEST_PATH='symbols\/myapp\.10x\.tar'/);
  assert.match(s, /-X PUT "\/repos\/\$REPO\/contents\/\$DEST_PATH"/);
  assert.match(s, /BASE='main'/);
  assert.match(s, /gh pr create/);
  // Never extract or split — the tar is committed whole.
  assert.doesNotMatch(s, /tar -x|split /);
});

test('render: no branch → resolves the repo default branch in-script', () => {
  const s = renderSymbolPlacementScript({
    ...base,
    target: { repo: 'acme/symbols', folder: 'symbols' },
    openPr: true,
  });
  assert.match(s, /BASE=\$\(gh api "\/repos\/\$REPO" --jq \.default_branch\)/);
  assert.doesNotMatch(s, /BASE='/);
});

test('render: open_pr=false pushes the branch without a PR', () => {
  const s = renderSymbolPlacementScript({
    ...base,
    target: { repo: 'acme/symbols', branch: 'main', folder: 'symbols' },
    openPr: false,
  });
  assert.doesNotMatch(s, /gh pr create/);
  assert.match(s, /no PR opened/);
});

test('render: single-quotes are escaped safely', () => {
  const s = renderSymbolPlacementScript({
    ...base,
    message: "place 'sym'",
    target: { repo: 'acme/symbols', branch: 'main', folder: 'symbols' },
    openPr: false,
  });
  assert.match(s, /MSG='place '\\''sym'\\'''/);
});
