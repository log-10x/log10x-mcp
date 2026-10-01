import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_IMAGE,
  CLI_OVERRIDE_MIN_ENGINE,
  compileAppArgs,
  buildDockerArgs,
  resolveCompilerImage,
  parseEngineVersion,
  imageTagVersion,
  engineVersionAtLeast,
  type CompileConfig,
} from '../src/lib/compile-runner.js';
import {
  detectLossMarkers,
  findRunningJobForOutput,
  type CompileJobRecord,
} from '../src/lib/compile-jobs.js';
import { stableOutputKey, scanOperationTimeoutFor } from '../src/tools/compile.js';

function cfg(overrides: Partial<CompileConfig> = {}): CompileConfig {
  return {
    inputs: [{ kind: 'local', path: '/src/app' }],
    output: { folder: '/out/symbols', libraryFile: '/out/symbols/lib.10x.tar', runtimeName: 'lib' },
    timeoutMs: 1_800_000,
    ...overrides,
  };
}

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

// ── 1. scanOperationTimeout rides the command line ───────────────────────

test('compileAppArgs passes scanOperationTimeout as a positional ms value after the app', () => {
  assert.deepEqual(compileAppArgs(cfg({ scanOperationTimeoutMs: 1_620_000 })), [
    '@apps/compiler',
    'scanOperationTimeout',
    '1620000ms',
  ]);
  assert.deepEqual(compileAppArgs(cfg()), ['@apps/compiler']);
});

test('the docker argv carries scanOperationTimeout after the image', () => {
  const args = buildDockerArgs(cfg({ scanOperationTimeoutMs: 90_000 }), 'img:1');
  const at = args.indexOf('img:1');
  assert.deepEqual(args.slice(at), ['img:1', '@apps/compiler', 'scanOperationTimeout', '90000ms']);
});

test('a local engine older than the CLI-override release does not get the option', () => {
  const c = cfg({ scanOperationTimeoutMs: 90_000 });
  assert.deepEqual(compileAppArgs(c, '1.1.81'), ['@apps/compiler']);
  assert.deepEqual(compileAppArgs(c, CLI_OVERRIDE_MIN_ENGINE), [
    '@apps/compiler',
    'scanOperationTimeout',
    '90000ms',
  ]);
  assert.deepEqual(compileAppArgs(c, '1.2.0'), ['@apps/compiler', 'scanOperationTimeout', '90000ms']);
  // Unknown version: pass it (the pinned image is new enough).
  assert.deepEqual(compileAppArgs(c, null), ['@apps/compiler', 'scanOperationTimeout', '90000ms']);
});

test('scanOperationTimeoutFor leaves 10% of the wall cap for the link', () => {
  assert.equal(scanOperationTimeoutFor(1_800_000), 1_620_000);
  assert.equal(scanOperationTimeoutFor(10_000), 10_000);
});

test('parseEngineVersion / engineVersionAtLeast read the banner', () => {
  assert.equal(parseEngineVersion("10x engine v1.1.89, flavor: 'compiler'"), '1.1.89');
  assert.equal(parseEngineVersion('no banner here'), null);
  assert.equal(engineVersionAtLeast('1.1.89', '1.1.89'), true);
  assert.equal(engineVersionAtLeast('1.1.90', '1.1.89'), true);
  assert.equal(engineVersionAtLeast('1.1.9', '1.1.89'), false);
  assert.equal(engineVersionAtLeast('1.2', '1.1.89'), true);
});

// ── 2. loss markers ──────────────────────────────────────────────────────

test('detectLossMarkers finds each engine loss marker, verbatim strings', () => {
  const log = [
    '12:00:01 INFO  scanning 1200 files',
    '12:10:01 ERROR FileSymbolScanOperation scan operation timeout: 600000 for com.log10x.eng.scanner.operations.FileSymbolScanOperation: {...} after: 10m',
    '12:10:02 WARN  symbol scan timed out, file dropped: Big.java',
    '12:10:02 WARN  symbol scan timed out, file dropped: Huge.cpp',
    '12:10:03 INFO  FileSymbolScanOperation traverse aborted for com.log10x...: {...} after: 10m',
    '12:10:03 WARN  traverser aborted: Other.java',
    '12:10:04 WARN  process output not fully read: java [-cp, ...], pid: 4242, 30000ms after it ended, lines read: 17',
    'com.log10x.eng.scanner.antlr.langs.AntlrParseTimeOutException: timeout exceeded: 30000ms',
  ].join('\n');
  const markers = detectLossMarkers(log);
  const byKind = Object.fromEntries(markers.map((m) => [m.kind, m]));
  assert.equal(byKind.scan_operation_timeout.count, 1);
  assert.equal(byKind.unit_timeout.count, 2);
  assert.equal(byKind.traverse_aborted.count, 2);
  assert.equal(byKind.process_output_not_drained.count, 1);
  assert.equal(byKind.antlr_parse_timeout.count, 1);
  assert.match(byKind.unit_timeout.sample, /Big\.java/);
});

test('detectLossMarkers is empty for a clean log', () => {
  assert.deepEqual(detectLossMarkers('INFO scan stats\n{"success": true, "phases": []}\n'), []);
});

// ── 3. compiler identity in the output key ──────────────────────────────

test('stableOutputKey changes with the compiler, same sources', () => {
  const args = compileArgs({ source_path: '/src/app' });
  const a = stableOutputKey(args, 'symbols', 'docker:log10x/compiler-10x:1.1.39');
  const b = stableOutputKey(args, 'symbols', `docker:${DEFAULT_IMAGE}`);
  const c = stableOutputKey(args, 'symbols', 'local:1.1.89');
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.equal(b, stableOutputKey(args, 'symbols', `docker:${DEFAULT_IMAGE}`));
});

// ── 4. one engine per output folder ─────────────────────────────────────

function record(overrides: Partial<CompileJobRecord>): CompileJobRecord {
  return {
    job_id: 'j',
    kind: 'compile',
    mode: 'local',
    output_folder: '/out/a',
    library_file: '/out/a/lib.10x.tar',
    log_file: '/tmp/x.log',
    job_dir: '/tmp/x',
    started_at: 1000,
    timeout_ms: 60_000,
    sources: '/src/a',
    runtime_name: 'lib',
    ...overrides,
  };
}

test('findRunningJobForOutput returns the live job for the folder and ignores finished or dead ones', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'l1x-jobs-'));
  const write = async (r: CompileJobRecord) => {
    await fs.mkdir(path.join(root, r.job_id), { recursive: true });
    await fs.writeFile(path.join(root, r.job_id, 'job.json'), JSON.stringify(r));
  };
  try {
    // alive: this very process
    await write(record({ job_id: 'live', pid: process.pid, started_at: 2000 }));
    // same folder, already captured terminal
    await write(record({ job_id: 'done', pid: process.pid, ended_at: 3000, exit_code: 0 }));
    // same folder, process gone
    await write(record({ job_id: 'dead', pid: 2_147_483_646, started_at: 5000 }));
    // other folder, alive
    await write(record({ job_id: 'other', pid: process.pid, output_folder: '/out/b' }));

    const hit = await findRunningJobForOutput('/out/a', { root });
    assert.equal(hit?.job_id, 'live');
    assert.equal(await findRunningJobForOutput('/out/c', { root }), null);

    const probed = await findRunningJobForOutput('/out/a', {
      root,
      probe: async () => ({ state: 'exited', exitCode: 0 }),
    });
    assert.equal(probed, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── 5. the default image ─────────────────────────────────────────────────

test('the default compiler image is pinned by tag and index digest', () => {
  assert.equal(
    DEFAULT_IMAGE,
    'log10x/compiler-10x:1.1.89@sha256:c020ff4dc1b089824fd6877c24a27acf3b5e39d607d56716dfed5cc1c48b725b',
  );
  assert.equal(resolveCompilerImage({}), DEFAULT_IMAGE);
  assert.equal(resolveCompilerImage({ LOG10X_COMPILER_IMAGE: 'log10x/compiler-10x:latest' }), 'log10x/compiler-10x:latest');
});

test('imageTagVersion reads a version tag, so an older pinned image is not given the timeout option', () => {
  assert.equal(imageTagVersion('log10x/compiler-10x:1.1.39'), '1.1.39');
  assert.equal(
    imageTagVersion(
      'log10x/compiler-10x:1.1.89@sha256:c020ff4dc1b089824fd6877c24a27acf3b5e39d607d56716dfed5cc1c48b725b',
    ),
    '1.1.89',
  );
  assert.equal(imageTagVersion('log10x/compiler-10x:1.1.89-amd64'), '1.1.89');
  assert.equal(imageTagVersion('log10x/compiler-10x:latest'), null);
  assert.equal(imageTagVersion('log10x/compiler-10x@sha256:c020ff4dc1b089824fd6877c24a27acf3b5e39d607d56716dfed5cc1c48b725b'), null);
  assert.equal(imageTagVersion('harbor.corp:8443/log10x/compiler-10x'), null);
  assert.equal(imageTagVersion('harbor.corp:8443/log10x/compiler-10x:1.1.40'), '1.1.40');
});

