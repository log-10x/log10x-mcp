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
  compileEnvVars,
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

test('buildDockerArgs passes TENX_LICENSE_KEY only when set', () => {
  const withLicense = buildDockerArgs(fixtureConfig({ license: 'jwt-123' }), 'img');
  assert.ok(withLicense.includes('TENX_LICENSE_KEY=jwt-123'));
  const withoutLicense = buildDockerArgs(fixtureConfig(), 'img');
  assert.ok(!withoutLicense.some((a) => a.startsWith('TENX_LICENSE_KEY=')));
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
    assert.equal(out.libraries.length, 1);
    assert.ok(out.libraries[0].path.endsWith('mylib.10x.tar'));
    assert.equal(out.libraries[0].bytes, Buffer.byteLength('TARDATA'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('scanSymbolOutputs returns zeros for a missing directory (a no-symbol compile is no_signal, not an error)', async () => {
  const out = await scanSymbolOutputs(path.join(os.tmpdir(), 'log10x-compile-does-not-exist-' + process.pid));
  assert.deepEqual(out, { unitCount: 0, libraries: [] });
});
