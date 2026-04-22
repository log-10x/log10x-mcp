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
 * Binary lookup: LOG10X_TENX_PATH env var wins; otherwise `tenx` on PATH.
 * Config lookup: LOG10X_MCP_STDIN_CONFIG_PATH / LOG10X_MCP_FILE_CONFIG_PATH
 *   wins; otherwise the packaged configs shipped alongside the MCP.
 *
 * Concurrency safety: each invocation gets its own /tmp/log10x-mcp-<uuid>/
 * tempdir with a shadow template config (empty files list) and isolated
 * TENX_INCLUDE_PATHS. Parallel calls don't collide.
 */

import { spawn } from 'child_process';
import { mkdtemp, readFile, writeFile as fsWriteFile, rm, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
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
      "Log10x dev CLI (`tenx`) is not installed on this machine. " +
        "Install via Homebrew (`brew install log10x/tap/tenx`), deb/rpm packages, " +
        "or Docker — see https://docs.log10x.com/apps/dev/ for install instructions. " +
        "Alternatively, set privacy_mode=false to route the batch through the public Log10x paste endpoint."
    );
    this.name = 'DevCliNotInstalledError';
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
  const binary = process.env.LOG10X_TENX_PATH || 'tenx';
  if (!(await isBinaryOnPath(binary))) {
    throw new DevCliNotInstalledError();
  }

  const cliVersion = await tryGetVersion(binary);

  if (!existsSync(opts.configPath)) {
    throw new Error(
      `MCP tenx config not found at: ${opts.configPath}. ` +
        `Reinstall the log10x-mcp package or set the appropriate config path env var.`
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'log10x-mcp-'));

  // Shadow the install's template config with empty files list.
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
  try {
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

    const [templatesJson, encodedLog, decodedLog, aggregatedCsv] = await Promise.all([
      readFile(join(tempDir, 'templates.json'), 'utf8').catch(() => ''),
      readFile(join(tempDir, 'encoded.log'), 'utf8').catch(() => ''),
      readFile(join(tempDir, 'decoded.log'), 'utf8').catch(() => ''),
      readFile(join(tempDir, 'aggregated.csv'), 'utf8').catch(() => ''),
    ]);

    if (!encodedLog && !templatesJson) {
      throw new Error(
        `Local tenx CLI ran but produced no parseable output. ` +
          `tempDir=${tempDir}, config=${opts.configPath}.`
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
