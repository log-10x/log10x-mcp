/**
 * Local `tenx` dev CLI runner.
 *
 * Spawns the locally-installed tenx CLI with a packaged runtime config
 * (`assets/tenx-mcp-stdin.config.yaml`), pipes the batch to stdin, and
 * reads the resulting templates + encoded rows + aggregated summary
 * from a per-invocation temp dir.
 *
 * The runner is the execution substrate for every MCP tool that needs
 * to templatize events locally — log10x_resolve_batch (stdin batch),
 * log10x_extract_templates (file / directory input), and future
 * validation tools that inject generated tenx.js overlays.
 *
 * Binary lookup: LOG10X_TENX_PATH env var wins; otherwise `tenx` on PATH.
 * Config lookup: LOG10X_MCP_STDIN_CONFIG_PATH env var wins; otherwise the
 *   packaged config shipped alongside the MCP.
 *
 * Concurrency safety: each invocation gets its own /tmp/log10x-mcp-<uuid>/
 * tempdir. Tempdir + env vars are scoped to the child process; parallel
 * calls don't collide.
 */

import { spawn } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface DevCliStdinRunResult {
  /** templates.json contents (NDJSON, one template per line). */
  templatesJson: string;
  /** encoded.log contents — one encoded row per input event. */
  encodedLog: string;
  /** decoded.log contents — one decoded text per event (round-trip check). */
  decodedLog: string;
  /** aggregated.csv contents — severity / service / volume rollups. */
  aggregatedCsv: string;
  /** CLI wall time in ms. */
  wallTimeMs: number;
  /** `tenx --version` output captured at invocation, when available. */
  cliVersion?: string;
  /** Absolute path to the config yaml that was loaded. */
  configPath: string;
  /** Absolute path to the tempdir (cleaned up before return). */
  tempDir: string;
}

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

/**
 * Thrown when the CLI runs but exits non-zero. The full stderr is attached
 * unredacted so generation loops can parse parse-error details
 * (`Lexical error at line N, column M`, `could not resolve include: ...`,
 * etc.) and self-correct without a second round-trip.
 */
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

/**
 * Run the local tenx CLI against a raw log text blob piped to stdin.
 * Returns the four output artifacts from the MCP's stdin config.
 */
export async function runDevCliStdin(rawLogText: string): Promise<DevCliStdinRunResult> {
  const binary = process.env.LOG10X_TENX_PATH || 'tenx';
  if (!(await isBinaryOnPath(binary))) {
    throw new DevCliNotInstalledError();
  }

  const cliVersion = await tryGetVersion(binary);
  const configPath = resolveStdinConfigPath();

  if (!existsSync(configPath)) {
    throw new Error(
      `MCP tenx config not found at: ${configPath}. ` +
        `Set LOG10X_MCP_STDIN_CONFIG_PATH to override, or reinstall the log10x-mcp package.`
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'log10x-mcp-'));

  const started = Date.now();
  try {
    const env = {
      ...process.env,
      LOG10X_MCP_OUTPUT_DIR: tempDir,
      LOG10X_MCP_RUNTIME_NAME: `mcp-${Date.now()}`,
    };

    await runCommandWithStdin(binary, [`@${configPath}`], rawLogText, {
      env,
      timeoutMs: 120_000,
      configPath,
    });

    const [templatesJson, encodedLog, decodedLog, aggregatedCsv] = await Promise.all([
      readFile(join(tempDir, 'templates.json'), 'utf8').catch(() => ''),
      readFile(join(tempDir, 'encoded.log'), 'utf8').catch(() => ''),
      readFile(join(tempDir, 'decoded.log'), 'utf8').catch(() => ''),
      readFile(join(tempDir, 'aggregated.csv'), 'utf8').catch(() => ''),
    ]);

    if (!encodedLog && !templatesJson) {
      throw new Error(
        `Local tenx CLI ran but produced no parseable output. ` +
          `tempDir=${tempDir}, config=${configPath}. ` +
          `templates.json bytes=${templatesJson.length}, encoded.log bytes=${encodedLog.length}.`
      );
    }

    return {
      templatesJson,
      encodedLog,
      decodedLog,
      aggregatedCsv,
      wallTimeMs: Date.now() - started,
      cliVersion,
      configPath,
      tempDir,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {
      // best-effort cleanup
    });
  }
}

/**
 * Legacy alias. Earlier callers used `runDevCli`. Kept so existing imports
 * from `resolve-batch.ts` don't break during the refactor. Returns the
 * three artifacts the old interface exposed.
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

function resolveStdinConfigPath(): string {
  const override = process.env.LOG10X_MCP_STDIN_CONFIG_PATH;
  if (override) return override;
  // __dirname points at `build/lib/` after tsc compile, or `src/lib/` in dev.
  // Walk up to the package root and join `assets/...`.
  const pkgRoot = resolve(__dirname, '..', '..');
  return join(pkgRoot, 'assets', 'tenx-mcp-stdin.config.yaml');
}

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
