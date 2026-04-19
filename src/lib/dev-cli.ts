/**
 * Local `tenx` dev CLI wrapper for privacy-mode batch resolution.
 *
 * When `log10x_resolve_batch` or `log10x_poc_from_siem` is invoked with
 * `privacy_mode: true` (the default), the MCP shells out to a locally-
 * installed `tenx` binary instead of posting events to the public
 * Log10x paste Lambda. Events never leave the caller's machine.
 *
 * The CLI ships via Homebrew, deb/rpm, PowerShell, and Docker — see
 * https://docs.log10x.com/apps/dev/ for install instructions.
 *
 * We detect the binary at call time by checking:
 *   1. LOG10X_TENX_PATH env var (explicit override)
 *   2. `tenx` on PATH (standard install)
 *
 * If neither is reachable we throw DevCliNotInstalledError with a
 * platform-specific install command.
 *
 * Config resolution: tenx's module system layers the user's
 * $TENX_CONFIG (typically /usr/local/etc/tenx/config, populated by
 * the Homebrew postinstall) on top of the Cellar modules. Early
 * versions of this wrapper overrode TENX_CONFIG to a bare tempdir,
 * which broke module resolution on Homebrew 1.0.4 (modules like
 * `run/bootstrap` only live in the user config, not the Cellar).
 * We now use the user's real TENX_CONFIG and write our I/O files
 * into a per-invocation subdirectory under `data/sample/`.
 */

import { spawn } from 'child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

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

/** Platform-specific install commands for the tenx CLI. */
function installHint(): string {
  if (process.platform === 'darwin') {
    return 'brew install log10x/tap/tenx';
  }
  if (process.platform === 'linux') {
    return 'curl -fsSL https://install.log10x.com | sh  # or apt/yum packages at https://docs.log10x.com/apps/dev/';
  }
  if (process.platform === 'win32') {
    return 'iwr -useb https://install.log10x.com/install.ps1 | iex';
  }
  return 'see https://docs.log10x.com/apps/dev/ for install instructions';
}

export class DevCliNotInstalledError extends Error {
  constructor() {
    super(
      `Log10x dev CLI (\`tenx\`) is not installed. Install with:\n\n    ${installHint()}\n\n` +
        'Then re-run the tool. For a no-install alternative, set `privacy_mode: false` to route ' +
        'through the public Log10x paste endpoint — but note that this sends raw log text to a ' +
        'shared public Lambda and is intended for demo use only, not production log content.'
    );
    this.name = 'DevCliNotInstalledError';
  }
}

export class DevCliBrokenInstallError extends Error {
  constructor(underlying: string) {
    super(
      `Log10x dev CLI (\`tenx\`) is installed but its module configuration is broken. ` +
        `Error: ${underlying.slice(0, 300)}\n\n` +
        `Most likely cause: a partial Homebrew install. Try:\n\n    ${installHint().includes('brew') ? 'brew reinstall log10x/tap/tenx' : installHint()}\n\n` +
        'If that does not resolve it, inspect the user config directory (default /usr/local/etc/tenx/config). ' +
        'Missing `pipelines/run/bootstrap/` is the specific signature of GAPS-H1.'
    );
    this.name = 'DevCliBrokenInstallError';
  }
}

/** Default user-config location populated by the Homebrew postinstall. */
const DEFAULT_TENX_CONFIG = '/usr/local/etc/tenx/config';

/**
 * Run the local `tenx @apps/dev` pipeline on a raw log text blob.
 *
 * Per-invocation isolation strategy:
 *   1. Build a scratch TENX_CONFIG at $TMPDIR/log10x-mcp-<uuid>/ that
 *      SYMLINKS the user's real TENX_CONFIG top-level dirs (apps,
 *      pipelines, lib, symbols, etc.) — so module resolution works
 *      exactly as it does in the user's install.
 *   2. Put our own `data/sample/input/batch.log` inside the scratch
 *      dir — NOT a symlink. Our batch is the only input tenx sees,
 *      so we don't accidentally template whatever sample.log was
 *      already sitting in the user's real data dir.
 *   3. Output goes to scratch `data/sample/output/` and is read back.
 *   4. The whole scratch dir is removed on exit (best-effort).
 *
 * This is robust against:
 *   - Homebrew 1.0.4's split module layout (user-config + Cellar) —
 *     symlinks to the real $TENX_CONFIG preserve resolution.
 *   - Pre-existing sample.log files in the user's real input dir —
 *     we never touch that dir.
 *   - Concurrent invocations — each gets its own scratch dir.
 */
export async function runDevCli(rawLogText: string): Promise<DevCliResult> {
  const binary = process.env.LOG10X_TENX_PATH || 'tenx';
  if (!(await isBinaryOnPath(binary))) {
    throw new DevCliNotInstalledError();
  }

  const cliVersion = await tryGetVersion(binary);

  // 1. Resolve the user's real TENX_CONFIG (for symlink sources).
  const realTenxConfig = process.env.TENX_CONFIG || DEFAULT_TENX_CONFIG;
  if (!existsSync(realTenxConfig)) {
    throw new DevCliBrokenInstallError(
      `TENX_CONFIG directory does not exist: ${realTenxConfig}. ` +
        'Set $TENX_CONFIG to your tenx config dir, or reinstall tenx.'
    );
  }

  // 2. Build the scratch config.
  const scratch = await mkdtemp(join(tmpdir(), 'log10x-mcp-'));
  const scratchInput = join(scratch, 'data', 'sample', 'input');
  const scratchOutput = join(scratch, 'data', 'sample', 'output');
  await mkdir(scratchInput, { recursive: true });
  await mkdir(scratchOutput, { recursive: true });

  // 3. Symlink every top-level entry in the real TENX_CONFIG into the
  //    scratch dir — EXCEPT `data/` which we want isolated. This covers
  //    apps, pipelines, lib, symbols, jsconfig.json, and any bespoke
  //    directories the user has added.
  let realEntries: string[];
  try {
    realEntries = await readdir(realTenxConfig);
  } catch (e) {
    throw new DevCliBrokenInstallError(
      `Cannot read TENX_CONFIG ${realTenxConfig}: ${(e as Error).message}`
    );
  }
  for (const entry of realEntries) {
    if (entry === 'data' || entry.startsWith('.')) continue;
    const src = join(realTenxConfig, entry);
    const dest = join(scratch, entry);
    try {
      await symlink(src, dest);
    } catch (e) {
      // If symlinks fail (Windows without admin, etc.), fall back to a
      // broken-install error with actionable text instead of silently
      // breaking templating.
      throw new DevCliBrokenInstallError(
        `Could not symlink ${entry} into scratch dir: ${(e as Error).message}. ` +
          'On Windows, run with admin privileges or set LOG10X_TENX_DISABLE_PRIVACY=1 to force paste-endpoint fallback.'
      );
    }
  }
  // Also symlink `data/shared` and `data/templates` if they exist — the
  // symbol libraries + pre-compiled templates live there and tenx reads
  // them for enrichment. Only `data/sample/{input,output}` needs isolation.
  const realDataDir = join(realTenxConfig, 'data');
  if (existsSync(realDataDir)) {
    const scratchDataDir = join(scratch, 'data');
    await mkdir(scratchDataDir, { recursive: true });
    let dataEntries: string[] = [];
    try {
      dataEntries = await readdir(realDataDir);
    } catch {
      // best-effort
    }
    for (const entry of dataEntries) {
      if (entry === 'sample' || entry.startsWith('.')) continue;
      const src = join(realDataDir, entry);
      const dest = join(scratchDataDir, entry);
      await symlink(src, dest).catch(() => undefined); // non-fatal
    }
  }

  // 4. Write our input file.
  const inputFile = join(scratchInput, 'batch.log');
  await writeFile(inputFile, rawLogText, 'utf8');

  const outputTemplates = join(scratchOutput, 'templates.json');
  const outputEncoded = join(scratchOutput, 'encoded.log');
  const outputAggregated = join(scratchOutput, 'aggregated.csv');

  const started = Date.now();
  try {
    try {
      // `--set openBrowser=false --set localOnly=true` used to be passed
      // here; tenx 1.0.4 rejects those flags and neither is referenced
      // in the current config tree. Omitted intentionally.
      await runCommand(binary, ['@apps/dev'], {
        env: { ...process.env, TENX_CONFIG: scratch },
        cwd: scratch,
        timeoutMs: 120_000,
      });
    } catch (e) {
      const msg = (e as Error).message || '';
      if (
        /could not resolve include|could not process include directive|could not expand macro argument|error reading.*config\.yaml/i.test(
          msg
        )
      ) {
        throw new DevCliBrokenInstallError(msg);
      }
      throw e;
    }

    const [templatesJson, encodedLog, aggregatedCsv] = await Promise.all([
      readFile(outputTemplates, 'utf8').catch(() => ''),
      readFile(outputEncoded, 'utf8').catch(() => ''),
      readFile(outputAggregated, 'utf8').catch(() => ''),
    ]);

    if (!templatesJson || !encodedLog) {
      throw new Error(
        `Local tenx CLI ran but produced no parseable output. ` +
          `templates.json bytes=${templatesJson.length}, encoded.log bytes=${encodedLog.length}. ` +
          `Check that the CLI version supports \`@apps/dev\` with the expected output layout at ${scratchOutput}.`
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
    // Blow away the entire scratch dir. Symlinks are just pointers; rm -r
    // on the scratch dir does NOT follow them into the real config.
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
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
        // Keep both stdout + stderr in the error because tenx writes its
        // config-resolution errors to stdout (the "could not resolve include"
        // lines we detect in the broken-install path above).
        const combined = [stdout, stderr].filter((s) => s.trim()).join('\n').slice(0, 2000);
        reject(
          new Error(`Command failed (${code}): ${cmd} ${args.join(' ')}\n${combined}`)
        );
      }
    });
  });
}
