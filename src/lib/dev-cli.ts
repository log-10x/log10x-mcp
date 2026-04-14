/**
 * Local `tenx` dev CLI wrapper for privacy-mode batch resolution.
 *
 * When `log10x_resolve_batch` is invoked with `privacy_mode: true`, the
 * MCP shells out to a locally-installed `tenx` binary instead of posting
 * the batch to the public paste Lambda. Events never leave the caller's
 * machine.
 *
 * The CLI ships via Homebrew, deb/rpm, PowerShell, and Docker — see
 * https://docs.log10x.com/apps/dev/ for install instructions. We detect
 * the binary at call time by checking:
 *
 *   1. LOG10X_TENX_PATH env var (explicit override)
 *   2. `tenx` on PATH (standard install)
 *
 * If neither is reachable, we return a structured error pointing at the
 * install URL rather than silently falling back to the paste Lambda.
 *
 * The CLI emits its output files into a configurable data directory.
 * We override that directory per-invocation to a unique temp path so
 * concurrent invocations don't collide and we can clean up deterministically.
 */

import { spawn } from 'child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface DevCliResult {
  /** templates.json contents (NDJSON). */
  templatesJson: string;
  /** encoded.log contents. */
  encodedLog: string;
  /** aggregated.csv contents. */
  aggregatedCsv: string;
  /** CLI wall time in ms. */
  wallTimeMs: number;
  /** The `tenx --version` output captured at invocation. */
  cliVersion?: string;
}

export class DevCliNotInstalledError extends Error {
  constructor() {
    super(
      "Log10x dev CLI (`tenx`) is not installed on this machine. Install via Homebrew (`brew install log10x/tap/tenx`), " +
        "deb/rpm packages, or Docker — see https://docs.log10x.com/apps/dev/ for install instructions. " +
        "Alternatively, set privacy_mode=false to route the batch through the public Log10x paste endpoint instead."
    );
    this.name = 'DevCliNotInstalledError';
  }
}

/**
 * Run the local `tenx @apps/dev` pipeline on a raw log text blob.
 *
 * Creates a temp config/data directory, writes the input file, invokes
 * the CLI with `localOnly=true` and `openBrowser=false` enforced, reads
 * the three output files, and deletes the temp directory on exit.
 */
export async function runDevCli(rawLogText: string): Promise<DevCliResult> {
  const binary = process.env.LOG10X_TENX_PATH || 'tenx';
  if (!(await isBinaryOnPath(binary))) {
    throw new DevCliNotInstalledError();
  }

  const cliVersion = await tryGetVersion(binary);

  // Build a temp TENX_CONFIG directory with the `data/sample/{input,output}` layout
  // the dev app expects. The CLI reads input/*.log and writes output/*.
  const tenxConfig = await mkdtemp(join(tmpdir(), 'log10x-mcp-'));
  const inputDir = join(tenxConfig, 'data', 'sample', 'input');
  const outputDir = join(tenxConfig, 'data', 'sample', 'output');
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const inputFile = join(inputDir, 'batch.log');
  await writeFile(inputFile, rawLogText, 'utf8');

  const started = Date.now();
  try {
    await runCommand(binary, ['@apps/dev', '--set', 'openBrowser=false', '--set', 'localOnly=true'], {
      env: { ...process.env, TENX_CONFIG: tenxConfig },
      cwd: tenxConfig,
      timeoutMs: 120_000,
    });

    const [templatesJson, encodedLog, aggregatedCsv] = await Promise.all([
      readFile(join(outputDir, 'templates.json'), 'utf8').catch(() => ''),
      readFile(join(outputDir, 'encoded.log'), 'utf8').catch(() => ''),
      readFile(join(outputDir, 'aggregated.csv'), 'utf8').catch(() => ''),
    ]);

    if (!templatesJson || !encodedLog) {
      throw new Error(
        `Local tenx CLI ran but produced no parseable output. ` +
          `templates.json bytes=${templatesJson.length}, encoded.log bytes=${encodedLog.length}. ` +
          `Check that the CLI version supports \`@apps/dev\` with the expected output layout.`
      );
    }

    return {
      templatesJson,
      encodedLog,
      aggregatedCsv,
      wallTimeMs: Date.now() - started,
      cliVersion,
    };
  } finally {
    await rm(tenxConfig, { recursive: true, force: true }).catch(() => {
      // Best-effort cleanup — don't fail the tool call on rm errors.
    });
  }
}

async function isBinaryOnPath(binary: string): Promise<boolean> {
  // If it's an absolute path, check existence directly.
  if (binary.startsWith('/') || binary.match(/^[A-Za-z]:\\/)) {
    return existsSync(binary);
  }
  // Otherwise shell out to `which` / `where` once.
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
}

function runCommand(cmd: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: options.env || process.env,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${cmd} ${args.join(' ')}`));
        }, options.timeoutMs)
      : null;

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed (${code}): ${cmd} ${args.join(' ')}\n${stderr.slice(0, 800)}`));
      }
    });
  });
}
