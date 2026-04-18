/**
 * Local `tenx @apps/mcp` runner — feeds a caller-supplied pipeline config and
 * optional JS modules to the local dev CLI, pipes sample log lines in via
 * stdin, captures stdout/stderr, and returns the lot as structured JSON.
 *
 * Designed so an MCP caller (typically an agent preparing a pipeline-config
 * change) can test-drive the behavior before deploying: mount a candidate
 * object constructor / filter function / module override, pipe a few
 * representative events through, read back the templates and emitted events,
 * and any TenXConsole.log output.
 *
 * Requires:
 *   - `tenx` on PATH (Homebrew `brew install log10x/tap/tenx` or equivalent)
 *   - the workspace config + modules tree already on disk. By default we
 *     point at `LOG10X_TENX_CONFIG_ROOT` / `LOG10X_TENX_MODULES_ROOT`; fall
 *     back to opinionated paths that match the shipped repo layout.
 *
 * What we do NOT do:
 *   - generate sample events ourselves. Callers pass `input_lines` — it is
 *     the caller's responsibility to synthesize realistic shapes (the agent
 *     using its own LLM context is better at that than any templating we
 *     could bake in).
 *   - persist anything. Mounted files go into a temp dir; temp dir is
 *     deleted on exit (even if the CLI fails).
 */

import { execFile, spawn } from 'node:child_process';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, extname, basename } from 'node:path';
import { DevCliNotInstalledError } from './dev-cli.js';

const execFileP = promisify(execFile);

export interface ValidateRunResult {
  /** Process exit code. 0 = pipeline ran cleanly. */
  exitCode: number;
  /** Wall time in ms, from spawn to exit. */
  wallTimeMs: number;
  /** CLI version string, captured via `tenx --version`. */
  cliVersion?: string;
  /** Raw stdout output, as a single string. */
  stdout: string;
  /** Raw stderr output, as a single string. */
  stderr: string;
  /**
   * Parsed encoded-event lines from stdout (one entry per `~...` line).
   * Each entry is the tilde-prefixed tokens split into `[templateHash, ...tokens]`.
   * Empty when the pipeline emits no events (e.g. all filtered).
   */
  events: Array<{ templateHash: string; tokens: string[] }>;
  /**
   * Parsed template JSON lines from stdout (one entry per `{"templateHash":...}` line).
   */
  templates: Array<{ templateHash: string; template: string }>;
  /**
   * Lines from stdout that are NOT encoded events, NOT templates, and NOT
   * known CLI banners. This is where caller-side TenXConsole.log lines
   * surface — the only way the caller sees assertions the mounted JS made.
   */
  consoleLines: string[];
}

export interface ValidateRunOptions {
  /**
   * Sample input lines, one event per line. Piped to tenx via stdin.
   * Caller generates these (agent-side) from natural-language intent.
   */
  input_lines: string[];

  /**
   * Map of relative path → file contents. Each entry is materialized into
   * the temp config overlay rooted at the same directory layout as the
   * shipped config repo (e.g., `pipelines/run/initialize/custom/debug.js`
   * or `apps/cloud/streamer/stream/my-filter.js`). Included files are
   * picked up by the pipeline's existing include globs — so a JS file
   * placed under `pipelines/run/initialize/custom/` auto-loads without
   * any further wiring.
   */
  extra_files?: Record<string, string>;

  /**
   * Which launch config to invoke. Default `@apps/mcp` (stdin/stdout
   * scaffold shipped alongside this tool).
   */
  pipeline_app?: string;

  /**
   * Additional positional CLI args appended to the `tenx` invocation.
   * Useful for passing runtime config like `symbolPaths <path>` or
   * `stdoutWriteObjects false`. Each [key, value] pair is two args.
   */
  extra_args?: Array<[string, string]>;

  /**
   * Hard cap on wall time. Default 60s. The CLI is killed if it exceeds.
   */
  timeout_ms?: number;
}

function configRoot(): string {
  return (
    process.env.LOG10X_TENX_CONFIG_ROOT ||
    '/Users/talweiss/eclipse-workspace/l1x-co/config/config'
  );
}

function modulesRoot(): string {
  return (
    process.env.LOG10X_TENX_MODULES_ROOT ||
    '/Users/talweiss/eclipse-workspace/l1x-co/config/modules'
  );
}

function symbolsPath(): string {
  return (
    process.env.LOG10X_TENX_SYMBOLS_PATH ||
    '/Users/talweiss/eclipse-workspace/l1x-co/config/data/shared/symbols'
  );
}

async function captureCliVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP('tenx', ['--version']);
    return stdout.trim().split('\n')[0];
  } catch {
    return undefined;
  }
}

/**
 * Mount the caller's extra_files into the REAL config/modules trees under
 * unique, tagged filenames, so auto-discovery picks them up without us
 * having to copy the shipped tree. Returns the list of files written so
 * the caller can delete them on cleanup.
 *
 * The tag is a short uuid prefix on the filename (not the directory), so
 * `pipelines/run/initialize/custom/debug.js` gets mounted as
 * `pipelines/run/initialize/custom/__validate-<uuid>__debug.js`. The
 * original file (if any) is untouched — isolated per-run, concurrency-safe,
 * no cleanup ambiguity.
 *
 * Tradeoff: caller cannot OVERRIDE a shipped file at the same path (both
 * copies live side by side). Callers needing override semantics should
 * explicitly name their mounted file to match the target — auto-discovery
 * will load both; shouldLoad() can then decide.
 */
async function mountExtraFiles(
  extraFiles: Record<string, string> | undefined,
  runTag: string,
): Promise<string[]> {
  const configSrc = configRoot();
  const modulesSrc = modulesRoot();

  if (!existsSync(configSrc)) {
    throw new Error(
      `LOG10X_TENX_CONFIG_ROOT does not exist: ${configSrc}. Set the env var or check out the config repo.`,
    );
  }
  if (!existsSync(modulesSrc)) {
    throw new Error(
      `LOG10X_TENX_MODULES_ROOT does not exist: ${modulesSrc}. Set the env var or check out the modules repo.`,
    );
  }

  const written: string[] = [];
  if (!extraFiles) return written;

  for (const [relPath, contents] of Object.entries(extraFiles)) {
    let baseDir: string;
    let rel: string;
    if (relPath.startsWith('config/')) {
      baseDir = configSrc;
      rel = relPath.slice('config/'.length);
    } else if (relPath.startsWith('modules/')) {
      baseDir = modulesSrc;
      rel = relPath.slice('modules/'.length);
    } else {
      baseDir = configSrc;
      rel = relPath;
    }

    // Tag the FILENAME (not the directory) so the file lives in the
    // expected include path but is unique per-run. Preserve the extension
    // because the include globs filter on `.js`, `.yaml`, etc.
    const ext = extname(rel);
    const stem = basename(rel, ext);
    const dir = dirname(rel);
    const tagged = `__validate-${runTag}__${stem}${ext}`;
    const fullPath = join(baseDir, dir, tagged);

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, 'utf8');
    written.push(fullPath);
  }

  return written;
}

async function cleanupMounted(paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      await unlink(p);
    } catch {
      // File may have been deleted already; ignore.
    }
  }
}

/**
 * Parse the CLI's stdout into {events, templates, consoleLines}. The encoded
 * event lines start with `~<templateHash>,`. Template JSON lines are a
 * single-line JSON object with exactly "templateHash" and "template" keys.
 * Everything else is classified as consoleLines (CLI banners +
 * TenXConsole.log output).
 *
 * Deliberately simple: no multi-line JSON parsing, no binary detection.
 * Caller can inspect raw `stdout` for anything fancier.
 */
function parseStdout(stdout: string): Pick<ValidateRunResult, 'events' | 'templates' | 'consoleLines'> {
  const events: Array<{ templateHash: string; tokens: string[] }> = [];
  const templates: Array<{ templateHash: string; template: string }> = [];
  const consoleLines: string[] = [];

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    if (line.startsWith('~')) {
      const csv = line.slice(1);
      const firstComma = csv.indexOf(',');
      if (firstComma < 0) {
        // Malformed event line — preserve raw for visibility.
        consoleLines.push(line);
        continue;
      }
      const templateHash = csv.slice(0, firstComma);
      const tokens = csv.slice(firstComma + 1).split(',');
      events.push({ templateHash, tokens });
      continue;
    }
    if (line.startsWith('{') && line.includes('"templateHash"') && line.includes('"template"')) {
      try {
        const obj = JSON.parse(line) as { templateHash?: string; template?: string };
        if (typeof obj.templateHash === 'string' && typeof obj.template === 'string') {
          templates.push({ templateHash: obj.templateHash, template: obj.template });
          continue;
        }
      } catch {
        // fall through to consoleLines
      }
    }
    consoleLines.push(line);
  }

  return { events, templates, consoleLines };
}

/**
 * Run the local tenx CLI against the provided pipeline + mounted files +
 * sample stdin input. Single-call: spawn → pipe → wait → kill-on-timeout →
 * clean up temp dir → return structured result.
 */
export async function runValidate(opts: ValidateRunOptions): Promise<ValidateRunResult> {
  const cliVersion = await captureCliVersion();
  if (!cliVersion) throw new DevCliNotInstalledError();

  const runTag = randomUUID().slice(0, 8);
  const t0 = Date.now();
  let mounted: string[] = [];

  try {
    mounted = await mountExtraFiles(opts.extra_files, runTag);

    const pipelineApp = opts.pipeline_app || '@apps/mcp';
    const args: string[] = [pipelineApp, 'symbolPaths', symbolsPath()];
    if (opts.extra_args) {
      for (const [k, v] of opts.extra_args) {
        args.push(k, v);
      }
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TENX_CONFIG: configRoot(),
      TENX_MODULES: modulesRoot(),
    };

    const child = spawn('tenx', args, { env });

    // Feed stdin: one line per input event + trailing newline.
    const stdinPayload = opts.input_lines.join('\n') + '\n';
    child.stdin.write(stdinPayload);
    child.stdin.end();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));

    const timeoutMs = opts.timeout_ms ?? 60_000;
    const timeoutHandle = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    const exitCode: number = await new Promise((resolve) => {
      child.on('exit', (code) => resolve(code ?? -1));
    });
    clearTimeout(timeoutHandle);

    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    const parsed = parseStdout(stdout);

    return {
      exitCode,
      wallTimeMs: Date.now() - t0,
      cliVersion,
      stdout,
      stderr,
      ...parsed,
    };
  } finally {
    await cleanupMounted(mounted);
  }
}
