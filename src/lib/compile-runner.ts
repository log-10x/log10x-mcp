/**
 * Compiler app runner — runs `tenx @apps/compiler` (CLOUD flavor only) to
 * scan a local source folder and emit a symbol library (`.10x.json` units +
 * a linked `.10x.tar`). Docker-first (the cloud image log10x/pipeline-10x),
 * with a local CLOUD-flavor `tenx` binary as an opt-in fallback.
 *
 * Why a dedicated runner (not dev-cli's runners): the streaming apps
 * (@apps/mcp / @apps/mcp-file) are stdin-in / templates-out over a
 * `/mcp/{config,input,output}` contract. The compiler is shaped
 * differently — it scans SOURCE folders and writes SYMBOL libraries to
 * disk, configured by the bundled `@apps/compiler` config. We reuse
 * dev-cli's mode/install/binary resolution so that logic stays
 * single-sourced, but the compile invocation, mounts, and output handling
 * live here.
 *
 * Extensibility (v1 is local-source / local-artifacts only):
 *   The `CompileConfig` descriptor + the two per-mode appliers
 *   (`runDockerCompile` / `runLocalCompile`) are the seam for the deferred
 *   axes. Each future axis — GitHub/Helm/Docker-image PULL, GitHub PUSH,
 *   scan/link tuning — adds an optional field on `CompileConfig` plus a
 *   small renderer that emits one of four injection primitives:
 *     1. env vars            (e.g. TENX_OUTPUT_SYMBOL_*),
 *     2. file replacements   (shadow configs, e.g. the inputPaths overlay),
 *     3. @overlay launch args(the engine's native config layering),
 *     4. mounts              (docker only).
 *   Mode selection, the cloud-flavor gate, process exec, and output
 *   scanning are written once and don't change as axes are added.
 *
 * The cloud-flavor gate: the compiler is absent from the Edge (native /
 * JIT) flavor — its scanners (ANTLR, bytecode, archive, executable) and
 * the link stage need the full JRE-packaged cloud distribution. Docker
 * mode uses the cloud image by contract; local mode probes the binary's
 * version banner (`10x engine v…, flavor: 'cloud'`) and refuses anything
 * that isn't cloud.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveTenxMode,
  resolveInstallPaths,
  isBinaryOnPath,
  DevCliNotInstalledError,
  DockerNotAvailableError,
} from './dev-cli.js';

// ── Config descriptor (the extension seam) ─────────────────────────────────

/** A local source folder on disk to scan. v1's only input kind. */
export interface CompileLocalInput {
  kind: 'local';
  /** Absolute host path to the folder of source code / binaries. */
  path: string;
}

/**
 * Where the compiler reads sources from. v1: exactly one local folder.
 * Future kinds (github / helm / dockerImage) slot in here as a union; the
 * appliers branch on `kind` and emit the matching pull config.
 */
export type CompileInput = CompileLocalInput;

export interface CompileConfig {
  /** Inputs to scan. v1 carries a single CompileLocalInput. */
  inputs: CompileInput[];
  /** Output artifact locations (host paths). */
  output: {
    /** Folder for `.10x.json` symbol unit files (TENX_OUTPUT_SYMBOL_FOLDER). */
    folder: string;
    /** Path of the linked `.10x.tar` library (TENX_OUTPUT_SYMBOL_LIBRARY_FILE). */
    libraryFile: string;
    /** Compile runtimeName (TENX_RUNTIME_NAME); also the default tar stem. */
    runtimeName: string;
  };
  /** TENX_LICENSE_KEY to pass through. Omit to use the image's built-in limited license. */
  license?: string;
  /** Hard cap on compile wall time in ms. */
  timeoutMs: number;
}

export type CompileMode = 'docker' | 'local';

export interface CompileRunResult {
  mode: CompileMode;
  /** Docker image used (docker mode only). */
  image?: string;
  /** Detected flavor token from the local binary banner (local mode only). */
  flavor?: string | null;
  /** True when we positively confirmed the cloud flavor before running. */
  flavorVerified: boolean;
  exitCode: number;
  timedOut: boolean;
  wallTimeMs: number;
  stdout: string;
  stderr: string;
  output: {
    folder: string;
    unitCount: number;
    libraries: Array<{ path: string; bytes: number }>;
  };
  runtimeName: string;
}

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * Thrown when a local `tenx` is present but is NOT the cloud flavor. The
 * message doubles as the agent-facing remediation (mirrors
 * DevCliNotInstalledError's self-describing-message convention).
 */
export class NotCloudFlavorError extends Error {
  readonly flavor: string;
  constructor(binary: string, flavor: string) {
    super(
      [
        `The local tenx at '${binary}' is the '${flavor}' flavor, but the Compiler app requires the Cloud flavor.`,
        '',
        'Two ways forward:',
        '  1. Docker (recommended): set LOG10X_TENX_MODE=docker (or call this tool with mode="docker") to run the cloud image log10x/pipeline-10x.',
        '  2. Install the Cloud flavor locally: https://doc.log10x.com/install/ ' +
          "(e.g. `brew install --cask log10x-cloud` on macOS, or the install script with `--flavor cloud`).",
      ].join('\n'),
    );
    this.name = 'NotCloudFlavorError';
    this.flavor = flavor;
  }
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_IMAGE = 'log10x/pipeline-10x:latest';
/** The bundled @apps/compiler config's default inputPaths location inside the image. */
const CONTAINER_SOURCES_PATH = '/etc/tenx/config/data/compile/sources';
/** Where we mount the host output folder inside the container. */
const CONTAINER_OUTPUT_PATH = '/work/symbols';

// ── Public entrypoint ──────────────────────────────────────────────────────

export async function runCompile(
  cfg: CompileConfig,
  opts: { modeOverride?: 'auto' | 'docker' | 'local' } = {},
): Promise<CompileRunResult> {
  const mode = await resolveMode(opts.modeOverride);
  await mkdir(cfg.output.folder, { recursive: true });
  return mode === 'docker' ? runDockerCompile(cfg) : runLocalCompile(cfg);
}

/**
 * Mode resolution: an explicit tool arg wins; `auto`/unset defers to
 * dev-cli's `resolveTenxMode()` (which prefers docker and falls back to a
 * local binary). Keeping this here means the compiler honours the same
 * LOG10X_TENX_MODE contract as every other engine-running tool.
 */
async function resolveMode(modeOverride?: 'auto' | 'docker' | 'local'): Promise<CompileMode> {
  if (modeOverride === 'docker' || modeOverride === 'local') return modeOverride;
  return resolveTenxMode();
}

// ── Docker applier ─────────────────────────────────────────────────────────

async function runDockerCompile(cfg: CompileConfig): Promise<CompileRunResult> {
  await probeDocker();
  const image = process.env.LOG10X_TENX_IMAGE || DEFAULT_IMAGE;
  const args = buildDockerArgs(cfg, image, { linuxUser: linuxUserMapping() });

  const t0 = Date.now();
  const r = await execCapture('docker', args, { timeoutMs: cfg.timeoutMs });
  const wallTimeMs = Date.now() - t0;

  const scanned = await scanSymbolOutputs(cfg.output.folder);
  return {
    mode: 'docker',
    image,
    // The cloud image is cloud-flavor by contract — we don't pay a second
    // container start to probe it. A non-cloud LOG10X_TENX_IMAGE override is
    // the operator's responsibility; @apps/compiler will fail loudly there.
    flavor: undefined,
    flavorVerified: false,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    wallTimeMs,
    stdout: r.stdout,
    stderr: r.stderr,
    output: { folder: cfg.output.folder, ...scanned },
    runtimeName: cfg.output.runtimeName,
  };
}

/**
 * Build the `docker run` argv. v1 realizes a local input by bind-mounting
 * it at the image's DEFAULT sources path, so the bundled `inputPaths:
 * path("data/compile/sources")` picks it up with no CLI/overlay override —
 * sidestepping the `OverwrittenOptionException` that a CLI `inputPaths`
 * would trigger (the scan unit is `allowMultiple: false`). Outputs are
 * driven entirely by env vars the bundled scan/link configs already read
 * via `TenXEnv.get`, pointed at a single mounted `/work/symbols`.
 *
 * Pure (no I/O) so it is unit-testable.
 */
export function buildDockerArgs(
  cfg: CompileConfig,
  image: string,
  opts: { linuxUser?: string } = {},
): string[] {
  const args = ['run', '--rm'];
  if (opts.linuxUser) args.push('--user', opts.linuxUser);

  for (const input of cfg.inputs) {
    if (input.kind === 'local') {
      args.push('-v', `${input.path}:${CONTAINER_SOURCES_PATH}:ro`);
    }
  }
  args.push('-v', `${cfg.output.folder}:${CONTAINER_OUTPUT_PATH}`);

  const env = compileEnvVars({
    outputFolder: CONTAINER_OUTPUT_PATH,
    libraryFile: `${CONTAINER_OUTPUT_PATH}/${cfg.output.runtimeName}.10x.tar`,
    runtimeName: cfg.output.runtimeName,
    license: cfg.license,
  });
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);

  args.push(image, '@apps/compiler');
  return args;
}

async function probeDocker(): Promise<void> {
  let r: ExecResult;
  try {
    r = await execCapture('docker', ['info'], { timeoutMs: 5_000 });
  } catch (e) {
    throw new DockerNotAvailableError((e as Error).message || String(e));
  }
  if (r.exitCode !== 0) {
    throw new DockerNotAvailableError(r.stderr.slice(0, 300) || 'docker info returned non-zero');
  }
}

/**
 * UID mapping for the bind-mounted output dir — Linux only. Without it the
 * container (UID 1000 / tenxuser) writes files the MCP process can't clean
 * up. Docker Desktop on Windows/macOS handles ownership via its own VFS,
 * and process.getuid doesn't exist on win32. Mirrors dev-cli's runViaDocker.
 */
function linuxUserMapping(): string | undefined {
  if (process.platform === 'linux' && typeof process.getuid === 'function') {
    return `${process.getuid()}:${(process.getgid as () => number)()}`;
  }
  return undefined;
}

// ── Local applier ──────────────────────────────────────────────────────────

async function runLocalCompile(cfg: CompileConfig): Promise<CompileRunResult> {
  const binary = process.env.LOG10X_TENX_PATH || 'tenx';
  if (!(await isBinaryOnPath(binary))) {
    throw new DevCliNotInstalledError();
  }

  // Cloud-flavor gate. A positively-detected non-cloud flavor is a hard
  // refusal. If the banner can't be parsed (older/newer build with a
  // different format) we proceed rather than block a possibly-valid cloud
  // install — @apps/compiler will fail loudly downstream if it really is edge.
  const { flavor } = await detectFlavor(binary);
  if (flavor && flavor !== 'cloud') {
    throw new NotCloudFlavorError(binary, flavor);
  }

  // Local mode can't bind-mount, so override inputPaths via a shadow of
  // `compile/scanners/config.yaml` placed FIRST on TENX_INCLUDE_PATHS — the
  // same first-match-wins shadow trick dev-cli uses for run/template. Outputs
  // ride the same TENX_OUTPUT_SYMBOL_* env hooks the bundled config reads.
  const overlayDir = await mkdtemp(join(tmpdir(), 'log10x-mcp-compile-cfg-'));
  try {
    const scannersPath = join(overlayDir, 'compile', 'scanners', 'config.yaml');
    await mkdir(join(overlayDir, 'compile', 'scanners'), { recursive: true });
    const sourcePaths = cfg.inputs.filter((i) => i.kind === 'local').map((i) => i.path);
    await writeFile(scannersPath, renderScannersOverlay(sourcePaths), 'utf8');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TENX_INCLUDE_PATHS: buildLocalIncludePaths(resolveInstallPaths(), overlayDir),
      ...compileEnvVars({
        outputFolder: cfg.output.folder,
        libraryFile: cfg.output.libraryFile,
        runtimeName: cfg.output.runtimeName,
        license: cfg.license,
      }),
    };

    const t0 = Date.now();
    const r = await execCapture(binary, ['@apps/compiler'], { env, timeoutMs: cfg.timeoutMs });
    const wallTimeMs = Date.now() - t0;

    const scanned = await scanSymbolOutputs(cfg.output.folder);
    return {
      mode: 'local',
      flavor: flavor ?? null,
      flavorVerified: flavor === 'cloud',
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      wallTimeMs,
      stdout: r.stdout,
      stderr: r.stderr,
      output: { folder: cfg.output.folder, ...scanned },
      runtimeName: cfg.output.runtimeName,
    };
  } finally {
    await rm(overlayDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Render the shadow `compile/scanners/config.yaml`. Because the shadow
 * REPLACES the shipped file (first match on the include path wins), it must
 * re-declare `outputSymbolFolder` too — we keep the shipped env-hook
 * expression verbatim so TENX_OUTPUT_SYMBOL_FOLDER still drives the output.
 * Source paths are single-quoted so Windows backslashes stay literal and the
 * engine doesn't treat them as `$=` expressions.
 *
 * Pure (no I/O) so it is unit-testable.
 */
export function renderScannersOverlay(sourcePaths: string[]): string {
  const lines = ['tenx: compile', 'inputPaths:'];
  for (const p of sourcePaths) {
    lines.push(`  - '${p.replace(/'/g, "''")}'`);
  }
  lines.push(
    'outputSymbolFolder: $=TenXEnv.get("TENX_OUTPUT_SYMBOL_FOLDER", path("data/shared/symbols", "<tenx.io.tmpdir>"))',
    '',
  );
  return lines.join('\n');
}

/**
 * Build TENX_INCLUDE_PATHS for local mode, overlay dir FIRST so its
 * `compile/scanners/config.yaml` shadows the install's copy. Mirrors the
 * include-path spelling in dev-cli's local runner. Separator is `;` on all
 * OSes (see the tenx install-layout reference).
 *
 * Pure (no I/O) so it is unit-testable.
 */
export function buildLocalIncludePaths(
  installPaths: { config: string; modules: string },
  overlayDir: string,
): string {
  const { config, modules } = installPaths;
  return [
    overlayDir,
    config,
    join(config, 'pipelines'),
    modules,
    join(modules, 'pipelines'),
    join(modules, 'apps'),
  ].join(';');
}

// ── Flavor detection ───────────────────────────────────────────────────────

/**
 * Probe the binary's version banner for its flavor token. The engine prints
 * `10x engine v<VERSION>, flavor: '<name>'` (PipelineLauncher.engineVersion);
 * the cloud factory's name is `cloud`. Try `--version` first (the dedicated
 * version provider), then `--help`, and read either stream.
 */
async function detectFlavor(binary: string): Promise<{ raw: string; flavor: string | null }> {
  for (const flag of ['--version', '--help']) {
    try {
      const r = await execCapture(binary, [flag], { timeoutMs: 10_000 });
      const flavor = parseFlavor(r.stdout) ?? parseFlavor(r.stderr);
      if (flavor) return { raw: r.stdout || r.stderr, flavor };
    } catch {
      // try the next flag
    }
  }
  return { raw: '', flavor: null };
}

/**
 * Extract the flavor token from a `10x engine v…, flavor: 'cloud'` banner.
 * Returns the lowercased token, or null if absent.
 *
 * Pure so it is unit-testable.
 */
export function parseFlavor(output: string): string | null {
  const m = output.match(/flavor:\s*'([^']+)'/i);
  return m ? m[1].toLowerCase() : null;
}

/** Convenience predicate over a version-banner string. Pure / testable. */
export function isCloudFlavorOutput(output: string): boolean {
  return parseFlavor(output) === 'cloud';
}

// ── Shared env builder ─────────────────────────────────────────────────────

/**
 * The TENX_* env the bundled compiler config reads via `TenXEnv.get`. Shared
 * by both appliers (docker maps these to `-e` flags; local spreads them into
 * the child env). `TENX_LOG_APPENDER=tenxConsoleAppender` routes the engine's
 * progress log to stdout so the tool can capture and tail it.
 *
 * Pure so it is unit-testable.
 */
export function compileEnvVars(p: {
  outputFolder: string;
  libraryFile: string;
  runtimeName: string;
  license?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    TENX_OUTPUT_SYMBOL_FOLDER: p.outputFolder,
    TENX_OUTPUT_SYMBOL_LIBRARY_FILE: p.libraryFile,
    TENX_RUNTIME_NAME: p.runtimeName,
    TENX_LOG_APPENDER: 'tenxConsoleAppender',
  };
  if (p.license) env.TENX_LICENSE_KEY = p.license;
  return env;
}

// ── Output scanning ────────────────────────────────────────────────────────

/**
 * Walk the output folder for the artifacts the compiler produced: `.10x.json`
 * symbol units (counted) and `.10x.tar` libraries (path + byte size). Tolerant
 * of a missing/empty dir (returns zeros), since a compile that produced
 * nothing is a valid `no_signal` outcome, not an error.
 */
export async function scanSymbolOutputs(
  dir: string,
): Promise<{ unitCount: number; libraries: Array<{ path: string; bytes: number }> }> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return { unitCount: 0, libraries: [] };
  }
  let unitCount = 0;
  const libraries: Array<{ path: string; bytes: number }> = [];
  for (const rel of entries) {
    if (rel.endsWith('.10x.json')) {
      unitCount++;
    } else if (rel.endsWith('.10x.tar')) {
      const full = join(dir, rel);
      try {
        const st = await stat(full);
        if (st.isFile()) libraries.push({ path: full, bytes: st.size });
      } catch {
        // race / vanished file — skip
      }
    }
  }
  return { unitCount, libraries };
}

// ── Process exec ───────────────────────────────────────────────────────────

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn a command, capture stdout+stderr+exit, enforce a timeout. Unlike
 * dev-cli's `runCommandWithStdin`, this does NOT throw on a non-zero exit:
 * a compile that fails partway still produces useful artifacts and logs, and
 * the tool turns the exit code into a `partial`/`error` status itself. Only a
 * spawn error (e.g. the binary is missing) rejects.
 */
function execCapture(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: opts.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
  });
}
