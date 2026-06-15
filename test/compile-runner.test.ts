import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseFlavor,
  isCloudFlavorOutput,
  buildDockerArgs,
  buildLocalIncludePaths,
  renderScannersOverlay,
  renderGithubPullOverlay,
  renderDockerPullOverlay,
  renderHelmPullOverlay,
  renderArtifactoryPullOverlay,
  needsContainerEngine,
  compileEnvVars,
  compileAppArgs,
  scanSymbolOutputs,
  type CompileConfig,
} from '../src/lib/compile-runner.js';

function fixtureConfig(overrides: Partial<CompileConfig> = {}): CompileConfig {
  return {
    inputs: [{ kind: 'local', path: '/src/app' }],
    output: {
      folder: '/out/symbols',
      libraryFile: '/out/symbols/mylib.10x.tar',
      runtimeName: 'mylib',
    },
    timeoutMs: 1_800_000,
    ...overrides,
  };
}

// ── parseFlavor / isCloudFlavorOutput ────────────────────────────────────

test('parseFlavor extracts the cloud token from the engine version banner', () => {
  assert.equal(parseFlavor("10x engine v1.0.21, flavor: 'cloud'"), 'cloud');
  assert.equal(isCloudFlavorOutput("10x engine v1.0.21, flavor: 'cloud'"), true);
});

test('parseFlavor reports a non-cloud flavor (edge) and isCloudFlavorOutput rejects it', () => {
  assert.equal(parseFlavor("10x engine v1.0.21, flavor: 'edge'"), 'edge');
  assert.equal(isCloudFlavorOutput("10x engine v1.0.21, flavor: 'edge'"), false);
});

test('parseFlavor is case-insensitive on the label and lowercases the token', () => {
  assert.equal(parseFlavor("10x engine v9, Flavor: 'Cloud'"), 'cloud');
});

test('parseFlavor returns null when no flavor token is present', () => {
  assert.equal(parseFlavor('some unrelated --help output with no banner'), null);
  assert.equal(isCloudFlavorOutput(''), false);
});

// ── buildDockerArgs ──────────────────────────────────────────────────────

test('buildDockerArgs mounts the source at the default sources path (read-only) and the output dir', () => {
  const args = buildDockerArgs(fixtureConfig(), 'log10x/pipeline-10x:latest');
  const joined = args.join(' ');
  // No CLI inputPaths override — relies on the bundled default location.
  assert.ok(!args.includes('inputPaths'), 'must not pass inputPaths on the CLI');
  assert.match(joined, /-v \/src\/app:\/etc\/tenx\/config\/data\/compile\/sources:ro/);
  assert.match(joined, /-v \/out\/symbols:\/work\/symbols(?: |$)/);
  // Invocation tail.
  assert.equal(args[args.length - 2], 'log10x/pipeline-10x:latest');
  assert.equal(args[args.length - 1], '@apps/compiler');
  assert.equal(args[0], 'run');
  assert.equal(args[1], '--rm');
});

test('buildDockerArgs drives output via TENX_OUTPUT_SYMBOL_* env pointed at the mount, not host paths', () => {
  const args = buildDockerArgs(fixtureConfig(), 'img');
  assert.ok(args.includes('TENX_OUTPUT_SYMBOL_FOLDER=/work/symbols'));
  assert.ok(args.includes('TENX_OUTPUT_SYMBOL_LIBRARY_FILE=/work/symbols/mylib.10x.tar'));
  assert.ok(args.includes('TENX_RUNTIME_NAME=mylib'));
  assert.ok(args.includes('TENX_LOG_APPENDER=tenxConsoleAppender'));
});

test('buildDockerArgs adds --user only when a linuxUser mapping is supplied', () => {
  const withUser = buildDockerArgs(fixtureConfig(), 'img', { linuxUser: '1000:1000' });
  assert.ok(withUser.includes('--user'));
  assert.ok(withUser.includes('1000:1000'));
  const withoutUser = buildDockerArgs(fixtureConfig(), 'img');
  assert.ok(!withoutUser.includes('--user'));
});

test('buildDockerArgs passes the license as a bare -e (name only — value never in argv)', () => {
  const withLicense = buildDockerArgs(fixtureConfig({ license: 'jwt-123' }), 'img');
  const i = withLicense.indexOf('TENX_LICENSE_KEY');
  assert.ok(i > 0 && withLicense[i - 1] === '-e', 'bare -e TENX_LICENSE_KEY expected');
  assert.ok(!withLicense.some((a) => a.includes('jwt-123')), 'license value must not appear in argv');
  const withoutLicense = buildDockerArgs(fixtureConfig(), 'img');
  assert.ok(!withoutLicense.includes('TENX_LICENSE_KEY'));
});

test('buildDockerArgs adds --name only when a containerName is supplied', () => {
  const named = buildDockerArgs(fixtureConfig(), 'img', { containerName: 'log10x-compile-xyz' });
  const i = named.indexOf('log10x-compile-xyz');
  assert.ok(i > 0 && named[i - 1] === '--name', '--name <containerName> expected');
  assert.ok(!buildDockerArgs(fixtureConfig(), 'img').includes('--name'));
});

test('buildDockerArgs omits --rm under keepContainer (async needs the container post-exit)', () => {
  // Synchronous runner reaps via --rm; the async start keeps the container so
  // compile_status can read a true exit code via `docker inspect`.
  assert.ok(buildDockerArgs(fixtureConfig(), 'img').includes('--rm'));
  assert.ok(!buildDockerArgs(fixtureConfig(), 'img', { keepContainer: true }).includes('--rm'));
});

test('buildDockerArgs mounts pull-config overlays read-only over their baked paths', () => {
  const args = buildDockerArgs(fixtureConfig(), 'img', {
    configMounts: [
      {
        hostPath: '/tmp/ov/github-config.yaml',
        containerPath: '/etc/tenx/config/pipelines/compile/pull/github/config.yaml',
      },
    ],
  });
  assert.ok(
    args.includes(
      '/tmp/ov/github-config.yaml:/etc/tenx/config/pipelines/compile/pull/github/config.yaml:ro',
    ),
  );
});

test('buildDockerArgs passes GH_TOKEN as a bare -e pass-through (never the value in argv)', () => {
  const cfg = fixtureConfig({
    inputs: [{ kind: 'github', repos: ['apache/commons-cli'] }],
    credentials: { githubToken: 'ghp_secret' },
  });
  const args = buildDockerArgs(cfg, 'img');
  const tokenFlagIdx = args.indexOf('GH_TOKEN');
  assert.ok(tokenFlagIdx > 0 && args[tokenFlagIdx - 1] === '-e', 'bare -e GH_TOKEN expected');
  assert.ok(!args.some((a) => a.includes('ghp_secret')), 'token value must not appear in argv');
  const withoutToken = buildDockerArgs(fixtureConfig(), 'img');
  assert.ok(!withoutToken.includes('GH_TOKEN'));
});

test('buildDockerArgs mounts no source dir for a github-only compile', () => {
  const cfg = fixtureConfig({ inputs: [{ kind: 'github', repos: ['apache/commons-cli'] }] });
  const args = buildDockerArgs(cfg, 'img');
  assert.ok(!args.some((a) => a.endsWith('/etc/tenx/config/data/compile/sources:ro')));
  // Output mount is always present.
  assert.ok(args.some((a) => a.endsWith(':/work/symbols')));
});

test('buildDockerArgs grants CAP_SYS_ADMIN + vfs storage ONLY when a dockerImage input is present', () => {
  const withImages = buildDockerArgs(
    fixtureConfig({ inputs: [{ kind: 'dockerImage', images: ['docker.io/library/alpine:latest'] }] }),
    'img',
  );
  const capIdx = withImages.indexOf('SYS_ADMIN');
  assert.ok(capIdx > 0 && withImages[capIdx - 1] === '--cap-add', '--cap-add SYS_ADMIN expected');
  assert.ok(withImages.includes('STORAGE_DRIVER=vfs'));

  // local / github compiles stay unprivileged.
  const localOnly = buildDockerArgs(fixtureConfig(), 'img');
  assert.ok(!localOnly.includes('--cap-add'));
  assert.ok(!localOnly.includes('STORAGE_DRIVER=vfs'));
  const githubOnly = buildDockerArgs(
    fixtureConfig({ inputs: [{ kind: 'github', repos: ['a/b'] }] }),
    'img',
  );
  assert.ok(!githubOnly.includes('--cap-add'));
});

test('needsContainerEngine / cap-add tracks helm pullImages, not helm alone', () => {
  const helmWithImages = fixtureConfig({
    inputs: [{ kind: 'helm', charts: ['oci://x/y'], pullImages: true, pullRepos: false }],
  });
  const helmNoImages = fixtureConfig({
    inputs: [{ kind: 'helm', charts: ['oci://x/y'], pullImages: false, pullRepos: false }],
  });
  assert.equal(needsContainerEngine(helmWithImages), true);
  assert.equal(needsContainerEngine(helmNoImages), false);
  assert.ok(buildDockerArgs(helmWithImages, 'img').includes('--cap-add'));
  assert.ok(!buildDockerArgs(helmNoImages, 'img').includes('--cap-add'));
});

test('buildDockerArgs mounts the helm-home + HELM_* env only when given', () => {
  const cfg = fixtureConfig({
    inputs: [{ kind: 'helm', charts: ['ingress-nginx/ingress-nginx'], pullImages: true, pullRepos: false }],
  });
  const args = buildDockerArgs(cfg, 'img', { helmHomeHostDir: '/tmp/hh' });
  assert.ok(args.includes('/tmp/hh:/helm-home'));
  assert.ok(args.includes('HELM_REPOSITORY_CONFIG=/helm-home/repositories.yaml'));
  assert.ok(args.includes('HELM_REPOSITORY_CACHE=/helm-home/cache'));
  assert.ok(!buildDockerArgs(cfg, 'img').some((a) => a.includes('helm-home')));
});

test('buildDockerArgs passes registry creds as bare -e pass-throughs, only when set', () => {
  const cfg = fixtureConfig({
    inputs: [{ kind: 'dockerImage', images: ['docker.io/acme/private:1'] }],
    credentials: { dockerUsername: 'acme', dockerToken: 'dckr_secret' },
  });
  const args = buildDockerArgs(cfg, 'img');
  for (const v of ['DOCKER_USERNAME', 'DOCKER_TOKEN']) {
    const i = args.indexOf(v);
    assert.ok(i > 0 && args[i - 1] === '-e', `bare -e ${v} expected`);
  }
  assert.ok(!args.some((a) => a.includes('dckr_secret')), 'token value must not appear in argv');
  const anonymous = buildDockerArgs(
    fixtureConfig({ inputs: [{ kind: 'dockerImage', images: ['docker.io/library/alpine:latest'] }] }),
    'img',
  );
  assert.ok(!anonymous.includes('DOCKER_USERNAME'));
  assert.ok(!anonymous.includes('DOCKER_TOKEN'));
});

test('buildDockerArgs passes ARTIFACTORY_TOKEN as a bare -e and grants no SYS_ADMIN (REST pull)', () => {
  const cfg = fixtureConfig({
    inputs: [
      {
        kind: 'artifactory',
        instance: 'https://art.corp',
        repo: 'libs-release-local',
        folders: ['com/acme'],
        recursive: true,
      },
    ],
    credentials: { artifactoryToken: 'art_secret' },
  });
  const args = buildDockerArgs(cfg, 'img');
  const i = args.indexOf('ARTIFACTORY_TOKEN');
  assert.ok(i > 0 && args[i - 1] === '-e', 'bare -e ARTIFACTORY_TOKEN expected');
  assert.ok(!args.some((a) => a.includes('art_secret')), 'token value must not appear in argv');
  // Artifactory is a REST pull — no daemonless podman, so no privilege grant.
  assert.ok(!args.includes('--cap-add'));
  assert.ok(!args.some((a) => a.endsWith('/etc/tenx/config/data/compile/sources:ro')));
});

test('needsContainerEngine is false for an artifactory-only compile', () => {
  assert.ok(
    !needsContainerEngine(
      fixtureConfig({
        inputs: [
          { kind: 'artifactory', instance: 'https://art', repo: 'r', folders: ['x'], recursive: true },
        ],
      }),
    ),
  );
});

// ── compileEnvVars ───────────────────────────────────────────────────────

test('compileEnvVars builds the TENX_* env hooks the bundled compiler config reads', () => {
  const env = compileEnvVars({
    outputFolder: '/out',
    libraryFile: '/out/lib.10x.tar',
    runtimeName: 'lib',
  });
  assert.deepEqual(env, {
    TENX_OUTPUT_SYMBOL_FOLDER: '/out',
    TENX_OUTPUT_SYMBOL_LIBRARY_FILE: '/out/lib.10x.tar',
    TENX_RUNTIME_NAME: 'lib',
    TENX_LOG_APPENDER: 'tenxConsoleAppender',
  });
});

// ── compileAppArgs (mergeExistingUnits wiring) ───────────────────────────

test('compileAppArgs is just the app for a normal compile (no mergeExistingUnits)', () => {
  assert.deepEqual(compileAppArgs(fixtureConfig()), ['@apps/compiler']);
  assert.deepEqual(compileAppArgs(fixtureConfig({ mergeExistingUnits: false })), ['@apps/compiler']);
});

test('compileAppArgs appends the literal `mergeExistingUnits true` for a link run', () => {
  // Link shape: no source inputs, output folder pointed at a units tree.
  const linkCfg = fixtureConfig({ inputs: [], mergeExistingUnits: true });
  assert.deepEqual(compileAppArgs(linkCfg), ['@apps/compiler', 'mergeExistingUnits', 'true']);
  // The value is the literal string 'true', NOT a $=TenXEnv.get(...) expression.
  assert.ok(!compileAppArgs(linkCfg).some((a) => a.includes('TenXEnv') || a.includes('~')));
});

test('buildDockerArgs tail carries `mergeExistingUnits true` after the app for a link run', () => {
  const args = buildDockerArgs(fixtureConfig({ inputs: [], mergeExistingUnits: true }), 'img');
  // The engine reads options as positional name/value pairs AFTER the config path.
  assert.deepEqual(args.slice(-3), ['@apps/compiler', 'mergeExistingUnits', 'true']);
  // A normal compile keeps the app as the final arg (no merge option).
  assert.equal(buildDockerArgs(fixtureConfig(), 'img').at(-1), '@apps/compiler');
});

// ── renderScannersOverlay ────────────────────────────────────────────────

test('renderScannersOverlay produces a compile-pipeline config setting inputPaths to the source folder', () => {
  const yaml = renderScannersOverlay(['/src/app']);
  assert.match(yaml, /^tenx: compile$/m);
  assert.match(yaml, /^inputPaths:$/m);
  assert.match(yaml, /^ {2}- '\/src\/app'$/m);
  // Re-declares the env-hook outputSymbolFolder so the shadow doesn't drop it.
  assert.match(yaml, /outputSymbolFolder: \$=TenXEnv\.get\("TENX_OUTPUT_SYMBOL_FOLDER"/);
});

test('renderScannersOverlay single-quotes paths and escapes embedded quotes (Windows-safe)', () => {
  const yaml = renderScannersOverlay(['C:\\src\\app']);
  assert.match(yaml, /- 'C:\\src\\app'/);
  const escaped = renderScannersOverlay(["/weird/o'brien"]);
  assert.match(escaped, /- '\/weird\/o''brien'/);
});

// ── renderGithubPullOverlay ──────────────────────────────────────────────

test('renderGithubPullOverlay lists repos and keeps the token as an env reference', () => {
  const yaml = renderGithubPullOverlay({
    kind: 'github',
    repos: ['apache/commons-cli', 'log-10x/engine'],
  });
  assert.match(yaml, /^tenx: compile$/m);
  assert.match(yaml, /^githubPull:$/m);
  // The secret never lands in the rendered file — only the env hook.
  assert.match(yaml, /- token: \$=TenXEnv\.get\("GH_TOKEN"\)/);
  assert.match(yaml, /- 'apache\/commons-cli'/);
  assert.match(yaml, /- 'log-10x\/engine'/);
  assert.match(yaml, /^ {4}branch: null$/m);
  assert.match(yaml, /^ {4}folders: \[\]$/m);
});

test('renderGithubPullOverlay renders branch and folders when given, single-quoted', () => {
  const yaml = renderGithubPullOverlay({
    kind: 'github',
    repos: ["weird/o'brien"],
    branch: 'release-1.x',
    folders: ['src/main/java', 'src/gen'],
  });
  assert.match(yaml, /branch: 'release-1\.x'/);
  assert.match(yaml, /^ {4}folders:$/m);
  assert.match(yaml, /- 'src\/main\/java'/);
  assert.match(yaml, /- 'src\/gen'/);
  // Embedded single quotes are YAML-escaped by doubling.
  assert.match(yaml, /- 'weird\/o''brien'/);
});

// ── renderDockerPullOverlay ──────────────────────────────────────────────

test('renderDockerPullOverlay lists images and keeps all creds as env references', () => {
  const yaml = renderDockerPullOverlay({
    kind: 'dockerImage',
    images: ['docker.io/library/alpine:latest', 'docker.io/grafana/grafana:11.1.0'],
  });
  assert.match(yaml, /^tenx: compile$/m);
  assert.match(yaml, /^docker:$/m);
  // Secrets never land in the rendered file — only env hooks.
  assert.match(yaml, /username: \$=TenXEnv\.get\("DOCKER_USERNAME"\)/);
  assert.match(yaml, /password: \$=TenXEnv\.get\("DOCKER_TOKEN"\)/);
  assert.match(yaml, /githubRepoToken: \$=TenXEnv\.get\("GH_TOKEN"\)/);
  assert.match(yaml, /- 'docker\.io\/library\/alpine:latest'/);
  assert.match(yaml, /- 'docker\.io\/grafana\/grafana:11\.1\.0'/);
  assert.match(yaml, /^ {2}remove: false$/m);
  // No command override unless requested (local mode uses the engine default).
  assert.ok(!yaml.includes('command:'));
});

test('renderDockerPullOverlay pins the docker CLI path when a command is supplied (docker mode)', () => {
  const yaml = renderDockerPullOverlay(
    { kind: 'dockerImage', images: ['docker.io/library/alpine:latest'] },
    { command: '/usr/local/bin/docker' },
  );
  assert.match(yaml, /^ {2}command: '\/usr\/local\/bin\/docker'$/m);
});

test('renderDockerPullOverlay renders an explicit empty list (not a null images key) for no images', () => {
  const yaml = renderDockerPullOverlay({ kind: 'dockerImage', images: [] });
  assert.match(yaml, /^ {2}images: \[\]$/m);
});

// ── renderHelmPullOverlay ────────────────────────────────────────────────

test('renderHelmPullOverlay lists charts and reflects the pull toggles', () => {
  const yaml = renderHelmPullOverlay({
    kind: 'helm',
    charts: ['oci://ghcr.io/nginxinc/charts/nginx-ingress', 'ingress-nginx/ingress-nginx'],
    pullImages: true,
    pullRepos: false,
  });
  assert.match(yaml, /^tenx: compile$/m);
  assert.match(yaml, /^helm:$/m);
  assert.match(yaml, /^ {2}chartNames:$/m);
  assert.match(yaml, /- 'oci:\/\/ghcr\.io\/nginxinc\/charts\/nginx-ingress'/);
  assert.match(yaml, /- 'ingress-nginx\/ingress-nginx'/);
  assert.match(yaml, /^ {4}dockerImages: true$/m);
  assert.match(yaml, /^ {6}repos: false$/m);
  assert.match(yaml, /token: \$=TenXEnv\.get\("GH_TOKEN"\)/);
  // No helmCommand override — the image default (/usr/local/bin/helm) is correct.
  assert.ok(!yaml.includes('command:'));
});

test('renderHelmPullOverlay honors pullRepos=true / pullImages=false', () => {
  const yaml = renderHelmPullOverlay({
    kind: 'helm',
    charts: ['oci://x/y'],
    pullImages: false,
    pullRepos: true,
  });
  assert.match(yaml, /^ {4}dockerImages: false$/m);
  assert.match(yaml, /^ {6}repos: true$/m);
});

// ── renderArtifactoryPullOverlay ─────────────────────────────────────────

test('renderArtifactoryPullOverlay renders instance/repo as a list entry, token as an env reference', () => {
  const yaml = renderArtifactoryPullOverlay({
    kind: 'artifactory',
    instance: 'https://demo.jfrog.io/artifactory',
    repo: 'libs-release-local',
    folders: ['com/acme/app'],
    recursive: true,
  });
  assert.match(yaml, /^tenx: compile$/m);
  assert.match(yaml, /^artifactory:$/m);
  assert.match(yaml, /^ {2}- token: \$=TenXEnv\.get\("ARTIFACTORY_TOKEN"\)$/m);
  assert.match(yaml, /^ {4}instance: 'https:\/\/demo\.jfrog\.io\/artifactory'$/m);
  assert.match(yaml, /^ {4}repo: 'libs-release-local'$/m);
  assert.match(yaml, /^ {4}folders:$/m);
  assert.match(yaml, /^ {6}- 'com\/acme\/app'$/m);
  assert.match(yaml, /^ {4}recursive: true$/m);
  // No files given → explicit empty list, not a null key.
  assert.match(yaml, /^ {4}files: \[\]$/m);
});

test('renderArtifactoryPullOverlay lists files, omits empty folders as [], and reflects recursive=false', () => {
  const yaml = renderArtifactoryPullOverlay({
    kind: 'artifactory',
    instance: 'https://art.corp',
    repo: 'pypi-local',
    files: ['dist/app-1.0.0.tar.gz'],
    recursive: false,
  });
  assert.match(yaml, /^ {4}files:$/m);
  assert.match(yaml, /^ {6}- 'dist\/app-1\.0\.0\.tar\.gz'$/m);
  assert.match(yaml, /^ {4}folders: \[\]$/m);
  assert.match(yaml, /^ {4}recursive: false$/m);
});

test('renderArtifactoryPullOverlay single-quotes and escapes embedded quotes', () => {
  const yaml = renderArtifactoryPullOverlay({
    kind: 'artifactory',
    instance: "https://art/o'hare",
    repo: 'r',
    folders: ["a'b"],
    recursive: true,
  });
  assert.match(yaml, /instance: 'https:\/\/art\/o''hare'/);
  assert.match(yaml, /- 'a''b'/);
});

// ── buildLocalIncludePaths ───────────────────────────────────────────────

test('buildLocalIncludePaths puts the overlay dir first so it shadows the shipped scanners config', () => {
  const inc = buildLocalIncludePaths({ config: '/etc/tenx/config', modules: '/opt/tenx-cloud/lib/app/modules' }, '/tmp/overlay');
  const parts = inc.split(';');
  assert.equal(parts[0], '/tmp/overlay');
  // ';' separator on all OSes; the install config/modules roots follow.
  assert.ok(parts.includes('/etc/tenx/config'));
  assert.ok(parts.includes(path.join('/etc/tenx/config', 'pipelines')));
  assert.ok(parts.includes('/opt/tenx-cloud/lib/app/modules'));
  assert.ok(parts.includes(path.join('/opt/tenx-cloud/lib/app/modules', 'apps')));
});

// ── scanSymbolOutputs ────────────────────────────────────────────────────

test('scanSymbolOutputs counts .10x.json units and collects .10x.tar libraries with sizes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'log10x-compile-scan-'));
  try {
    await fs.mkdir(path.join(dir, 'app'), { recursive: true });
    await fs.writeFile(path.join(dir, 'app', 'foo.js.10x.json'), '{}');
    await fs.writeFile(path.join(dir, 'app', 'bar.go.10x.json'), '{}');
    await fs.writeFile(path.join(dir, 'mylib.10x.tar'), 'TARDATA');
    await fs.writeFile(path.join(dir, 'README.txt'), 'ignored');

    const out = await scanSymbolOutputs(dir);
    assert.equal(out.unitCount, 2);
    assert.equal(out.emptyUnitCount, 0);
    assert.equal(out.libraries.length, 1);
    assert.ok(out.libraries[0].path.endsWith('mylib.10x.tar'));
    assert.equal(out.libraries[0].bytes, Buffer.byteLength('TARDATA'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('scanSymbolOutputs reports zero-byte units as empty, not as symbols (the green-but-empty trap)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'log10x-compile-scan-empty-'));
  try {
    await fs.writeFile(path.join(dir, 'real.go.10x.json'), '{"symbols":[1]}');
    await fs.writeFile(path.join(dir, 'hollow.go.10x.json'), '');

    const out = await scanSymbolOutputs(dir);
    assert.equal(out.unitCount, 1);
    assert.equal(out.emptyUnitCount, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('scanSymbolOutputs returns zeros for a missing directory (a no-symbol compile is no_signal, not an error)', async () => {
  const out = await scanSymbolOutputs(path.join(os.tmpdir(), 'log10x-compile-does-not-exist-' + process.pid));
  assert.deepEqual(out, { unitCount: 0, emptyUnitCount: 0, libraries: [] });
});
