/**
 * Local `tenx` dev CLI runner.
 *
 * Spawns the locally-installed tenx CLI with a packaged runtime config,
 * reads the resulting templates + encoded rows + aggregated summary
 * from a per-invocation temp dir. Two modes:
 *
 *   - stdin: batch piped to stdin (log10x_resolve_batch)
 *   - file:  reads from a path/glob (log10x_extract_templates)
 *
 * Backend selection via LOG10X_TENX_MODE:
 *   - "local" (default): invoke the host-installed tenx binary.
 *     Binary lookup: LOG10X_TENX_PATH env var wins; otherwise `tenx` on PATH.
 *   - "docker": `docker run --rm -i log10x/pipeline-10x:latest` (or
 *     LOG10X_TENX_IMAGE). Useful on hosts without a local tenx install,
 *     or for hermetic/offline-capable invocation. No auto-fallback —
 *     the user opts in explicitly.
 *
 * Config lookup: LOG10X_MCP_STDIN_CONFIG_PATH / LOG10X_MCP_FILE_CONFIG_PATH
 *   wins; otherwise the packaged configs shipped alongside the MCP.
 *
 * Concurrency safety: each invocation gets its own /tmp/log10x-mcp-<uuid>/
 * tempdir with a shadow template config (empty files list). Parallel calls
 * don't collide.
 */

import { spawn } from 'child_process';
import { mkdtemp, readFile, writeFile as fsWriteFile, rm, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Result types ──

export interface DevCliResult {
  templatesJson: string;
  encodedLog: string;
  decodedLog: string;
  aggregatedCsv: string;
  wallTimeMs: number;
  cliVersion?: string;
  configPath: string;
  tempDir: string;
}

// ── Error types ──

export class DevCliNotInstalledError extends Error {
  constructor() {
    super(
      "Log10x dev CLI (`tenx`) is not installed on this machine. Options: " +
        "(1) install locally — `brew install log-10x/tap/log10x` on macOS, " +
        "MSI installer on Windows (`irm https://raw.githubusercontent.com/log-10x/pipeline-releases/main/install.ps1 | iex`), " +
        "or deb/rpm/install.sh on Linux — see https://docs.log10x.com/install/; " +
        "(2) run tenx in Docker — set `LOG10X_TENX_MODE=docker` (requires Docker Desktop or a docker daemon); " +
        "(3) set privacy_mode=false to route the batch through the public Log10x paste endpoint instead."
    );
    this.name = 'DevCliNotInstalledError';
  }
}

export class DockerNotAvailableError extends Error {
  constructor(cause: string) {
    super(
      `LOG10X_TENX_MODE=docker is set but docker is not available: ${cause.slice(0, 300)}. ` +
        `Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or start the docker daemon and retry, ` +
        `or unset LOG10X_TENX_MODE to use a local tenx install.`
    );
    this.name = 'DockerNotAvailableError';
  }
}

export class DevCliRunError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly configPath: string;
  constructor(exitCode: number, stderr: string, stdout: string, configPath: string) {
    super(
      `Local tenx CLI exited with code ${exitCode}.\n` +
        `Config: ${configPath}\n` +
        `Stderr (first 2000 chars):\n${stderr.slice(0, 2000)}`
    );
    this.name = 'DevCliRunError';
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.stdout = stdout;
    this.configPath = configPath;
  }
}

// ── Public API ──

/**
 * Run the local tenx CLI with batch piped to stdin.
 * Used by log10x_resolve_batch.
 */
export async function runDevCliStdin(rawLogText: string): Promise<DevCliResult> {
  const configPath = resolveConfigPath('LOG10X_MCP_STDIN_CONFIG_PATH', 'tenx-mcp-stdin.config.yaml');
  return runDevCliCore({ mode: 'stdin', stdinData: rawLogText, configPath });
}

/**
 * Run the local tenx CLI reading from a file path/glob.
 * Used by log10x_extract_templates.
 */
export async function runDevCliFile(inputPath: string): Promise<DevCliResult> {
  const configPath = resolveConfigPath('LOG10X_MCP_FILE_CONFIG_PATH', 'tenx-mcp-file.config.yaml');
  return runDevCliCore({ mode: 'file', inputPath, configPath });
}

/**
 * Legacy alias for resolve-batch.ts backward compatibility.
 */
export async function runDevCli(rawLogText: string): Promise<{
  templatesJson: string;
  encodedLog: string;
  aggregatedCsv: string;
  wallTimeMs: number;
  cliVersion?: string;
}> {
  const r = await runDevCliStdin(rawLogText);
  return {
    templatesJson: r.templatesJson,
    encodedLog: r.encodedLog,
    aggregatedCsv: r.aggregatedCsv,
    wallTimeMs: r.wallTimeMs,
    cliVersion: r.cliVersion,
  };
}

// ── Core runner ──

interface RunDevCliOptions {
  mode: 'stdin' | 'file';
  stdinData?: string;
  inputPath?: string;
  configPath: string;
  extraOverlays?: string[];
  timeoutMs?: number;
}

async function runDevCliCore(opts: RunDevCliOptions): Promise<DevCliResult> {
  const mode = resolveTenxMode();

  if (!existsSync(opts.configPath)) {
    throw new Error(
      `MCP tenx config not found at: ${opts.configPath}. ` +
        `Reinstall the log10x-mcp package or set the appropriate config path env var.`
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'log10x-mcp-'));

  // Shadow the install's template config with empty files list.
  // Same on-disk shape in both modes — docker mounts tempDir into the
  // container so the shadow is visible there too.
  const templateConfigDir = join(tempDir, 'run', 'template');
  await mkdir(templateConfigDir, { recursive: true });
  await fsWriteFile(
    join(templateConfigDir, 'config.yaml'),
    [
      'tenx: run',
      'template:',
      '  files: []',
      '  cacheSize: $=parseBytes("10MB")',
      'var:',
      '  placeholder: "$"',
      '  maxRecurIndexes: 10',
      'timestamp:',
      '  prefix: (',
      '  postfix: )',
      '',
    ].join('\n'),
    'utf8'
  );

  const started = Date.now();
  let cliVersion: string | undefined;
  try {
    cliVersion = mode === 'docker'
      ? await runViaDocker(opts, tempDir)
      : await runViaLocalBinary(opts, tempDir);

    const [templatesJson, encodedLog, decodedLog, aggregatedCsv] = await Promise.all([
      readFile(join(tempDir, 'templates.json'), 'utf8').catch(() => ''),
      readFile(join(tempDir, 'encoded.log'), 'utf8').catch(() => ''),
      readFile(join(tempDir, 'decoded.log'), 'utf8').catch(() => ''),
      readFile(join(tempDir, 'aggregated.csv'), 'utf8').catch(() => ''),
    ]);

    if (!encodedLog && !templatesJson) {
      throw new Error(
        `tenx ran but produced no parseable output. ` +
          `tempDir=${tempDir}, config=${opts.configPath}, mode=${mode}.`
      );
    }

    return {
      templatesJson,
      encodedLog,
      decodedLog,
      aggregatedCsv,
      wallTimeMs: Date.now() - started,
      cliVersion,
      configPath: opts.configPath,
      tempDir,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Mode selection ──

function resolveTenxMode(): 'local' | 'docker' {
  const raw = (process.env.LOG10X_TENX_MODE || '').trim().toLowerCase();
  if (!raw || raw === 'local') return 'local';
  if (raw === 'docker') return 'docker';
  throw new Error(
    `Invalid LOG10X_TENX_MODE="${process.env.LOG10X_TENX_MODE}". ` +
      `Valid values: "local" (default), "docker".`
  );
}

// ── Local binary backend ──

async function runViaLocalBinary(
  opts: RunDevCliOptions,
  tempDir: string
): Promise<string | undefined> {
  const binary = process.env.LOG10X_TENX_PATH || 'tenx';
  if (!(await isBinaryOnPath(binary))) {
    throw new DevCliNotInstalledError();
  }

  const cliVersion = await tryGetVersion(binary);

  // TODO(dev-cli-os-portable): os-aware include-path construction. The
  // hardcoded /usr/local/etc/tenx/config and /usr/local/Cellar/log10x/1.0.4
  // defaults are Intel-Homebrew-only and break on Apple Silicon, Linux,
  // and Windows. Follow-up commit replaces this with a buildIncludePaths()
  // that respects TENX_HOME / TENX_MODULES / TENX_CONFIG and falls back
  // to per-OS defaults matching PipelineIncludePathResolver.java.
  const tenxConfig = process.env.TENX_CONFIG || '/usr/local/etc/tenx/config';
  const tenxModules = process.env.TENX_MODULES
    || '/usr/local/Cellar/log10x/1.0.4/lib/tenx/modules';
  const includePaths = [
    tempDir,
    tenxConfig,
    join(tenxConfig, 'pipelines'),
    tenxModules,
    join(tenxModules, 'pipelines'),
    join(tenxModules, 'apps'),
  ].join(';');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TENX_INCLUDE_PATHS: includePaths,
    LOG10X_MCP_OUTPUT_DIR: tempDir,
    LOG10X_MCP_RUNTIME_NAME: `mcp-${Date.now()}`,
  };

  if (opts.mode === 'file' && opts.inputPath) {
    env.LOG10X_MCP_INPUT_PATH = opts.inputPath;
  }

  const args = [`@${opts.configPath}`];
  if (opts.extraOverlays) {
    for (const overlay of opts.extraOverlays) {
      args.push(`@${overlay}`);
    }
  }

  await runCommandWithStdin(
    binary,
    args,
    opts.mode === 'stdin' ? (opts.stdinData ?? '') : null,
    {
      env,
      timeoutMs: opts.timeoutMs ?? 120_000,
      configPath: opts.configPath,
    }
  );

  return cliVersion;
}

// ── Docker backend ──

/**
 * Run tenx inside a container. Opt-in via LOG10X_TENX_MODE=docker.
 *
 * The container provides its own tenx install (official image
 * `log10x/pipeline-10x:latest` — Cloud flavor per mksite/docs/install/docker.md),
 * so OS portability and the Intel-Homebrew path assumption are sidestepped.
 * The host contributes only the per-invocation tempdir and the MCP's
 * packaged YAML.
 *
 * Mounts:
 *   - <tempDir>              → /mcp/output  (rw) — shadow template + result files
 *   - <dirname(configPath)>  → /mcp/config  (ro) — the packaged YAML
 *   - <dirname(inputPath)>   → /mcp/input   (ro) — file mode only
 *
 * The image's baked install lives at /opt/tenx-cloud/lib/app/modules and
 * /etc/tenx/config; we build TENX_INCLUDE_PATHS with /mcp/output first so
 * the shadow template config overrides the image's default.
 */
async function runViaDocker(
  opts: RunDevCliOptions,
  tempDir: string
): Promise<string | undefined> {
  // Probe docker up front — fail fast with a useful message rather than
  // letting the main `docker run` time out obscurely.
  try {
    await runCommand('docker', ['info'], { timeoutMs: 5_000 });
  } catch (e) {
    throw new DockerNotAvailableError((e as Error).message || String(e));
  }

  const image = process.env.LOG10X_TENX_IMAGE || 'log10x/pipeline-10x:latest';

  // Resolve to absolute paths — bind mounts reject relative paths and
  // the user may pass a relative configPath via LOG10X_MCP_*_CONFIG_PATH.
  const absConfigPath = resolve(opts.configPath);
  const hostConfigDir = dirname(absConfigPath);
  const configName = basename(absConfigPath);

  const CONTAINER_OUTPUT = '/mcp/output';
  const CONTAINER_CONFIG_DIR = '/mcp/config';
  const CONTAINER_INPUT_DIR = '/mcp/input';

  const containerIncludePaths = [
    CONTAINER_OUTPUT,
    '/etc/tenx/config',
    '/etc/tenx/config/pipelines',
    '/opt/tenx-cloud/lib/app/modules',
    '/opt/tenx-cloud/lib/app/modules/pipelines',
    '/opt/tenx-cloud/lib/app/modules/apps',
  ].join(';');

  const args: string[] = ['run', '--rm', '-i'];

  // UID mapping — only on Linux. Without it, the container (UID 1000,
  // tenxuser) writes to the host-mounted tempdir and leaves files the
  // MCP process can't clean up. Docker Desktop on Windows/macOS handles
  // ownership via its own VFS, and process.getuid doesn't exist on win32.
  if (process.platform === 'linux' && typeof process.getuid === 'function') {
    args.push('--user', `${process.getuid()}:${(process.getgid as () => number)()}`);
  }

  args.push('-v', `${hostConfigDir}:${CONTAINER_CONFIG_DIR}:ro`);
  args.push('-v', `${tempDir}:${CONTAINER_OUTPUT}`);

  let containerInputPath: string | undefined;
  if (opts.mode === 'file' && opts.inputPath) {
    // TODO: glob paths aren't supported here — we mount the parent of the
    // exact path. Resolving a glob to its minimal enclosing directory and
    // rewriting the pattern is possible but left for a follow-up. Absolute
    // file paths are the 95% case.
    const absInput = resolve(opts.inputPath);
    const inDir = dirname(absInput);
    const inName = basename(absInput);
    args.push('-v', `${inDir}:${CONTAINER_INPUT_DIR}:ro`);
    containerInputPath = `${CONTAINER_INPUT_DIR}/${inName}`;
  }

  args.push('-e', `TENX_INCLUDE_PATHS=${containerIncludePaths}`);
  args.push('-e', `LOG10X_MCP_OUTPUT_DIR=${CONTAINER_OUTPUT}`);
  args.push('-e', `LOG10X_MCP_RUNTIME_NAME=mcp-${Date.now()}`);
  if (containerInputPath) {
    args.push('-e', `LOG10X_MCP_INPUT_PATH=${containerInputPath}`);
  }

  args.push(image);
  args.push(`@${CONTAINER_CONFIG_DIR}/${configName}`);
  if (opts.extraOverlays) {
    for (const overlay of opts.extraOverlays) {
      args.push(`@${overlay}`);
    }
  }

  await runCommandWithStdin(
    'docker',
    args,
    opts.mode === 'stdin' ? (opts.stdinData ?? '') : null,
    {
      // +60s over local default absorbs first-run image pull on a cold host.
      timeoutMs: opts.timeoutMs ?? 180_000,
      configPath: opts.configPath,
    }
  );

  return `docker:${image}`;
}

// ── Config resolution ──

function resolveConfigPath(envVar: string, defaultFilename: string): string {
  const override = process.env[envVar];
  if (override) return override;
  const pkgRoot = resolve(__dirname, '..', '..');
  return join(pkgRoot, 'assets', defaultFilename);
}

// ── Binary helpers ──

async function isBinaryOnPath(binary: string): Promise<boolean> {
  if (binary.startsWith('/') || binary.match(/^[A-Za-z]:\\/)) {
    return existsSync(binary);
  }
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    await runCommand(lookup, [binary], { timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function tryGetVersion(binary: string): Promise<string | undefined> {
  try {
    const out = await runCommand(binary, ['--version'], { timeoutMs: 3000 });
    return out.trim().slice(0, 120);
  } catch {
    return undefined;
  }
}

// ── Process helpers ──

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  configPath?: string;
}

function runCommand(cmd: string, args: string[], options: RunOptions = {}): Promise<string> {
  return runCommandWithStdin(cmd, args, null, options);
}

function runCommandWithStdin(
  cmd: string,
  args: string[],
  stdinData: string | null,
  options: RunOptions = {}
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      env: options.env || process.env,
      cwd: options.cwd,
      stdio: [stdinData !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          rejectPromise(
            new Error(`Command timed out after ${options.timeoutMs}ms: ${cmd} ${args.join(' ')}`)
          );
        }, options.timeoutMs)
      : null;

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      rejectPromise(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        rejectPromise(new DevCliRunError(code ?? -1, stderr, stdout, options.configPath || ''));
      }
    });

    if (stdinData !== null && child.stdin) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }
  });
}
