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

import { tenxAvailabilityHint } from './install-hints.js';

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
      tenxAvailabilityHint() +
        '\n\nOr bypass templating entirely: set privacy_mode=false to route the batch through the public Log10x paste endpoint.'
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

/**
 * Thrown before spawning the CLI when a required configuration value is
 * absent (e.g. LOG10X_API_KEY unset and the bootstrap config path requires
 * it). Callers convert this to a `config_missing` chassis error envelope
 * rather than surfacing a raw CLI argument-validation error.
 */
export class DevCliConfigMissingError extends Error {
  readonly field: string;
  readonly hint: string;
  constructor(field: string, hint: string) {
    super(hint);
    this.name = 'DevCliConfigMissingError';
    this.field = field;
    this.hint = hint;
  }
}

// ── Public API ──

/**
 * Run `tenx @apps/mcp-file` with batch piped to stdin and read the three
 * artifact files the engine writes to
 * `/tmp/log10x-mcp-pull/<runtimeName>/`:
 *
 *   encoded.log    — one anchored-encoded line per event
 *   templates.json — one JSON-per-line: {"templateHash":"...","template":"..."}
 *   aggregated.csv — one row per unique (severity, message_pattern, tenx_hash)
 *
 * Use this path when the input volume is too large for the stdout-based
 * runner (which buffers everything in process memory). The file runner
 * scales to multi-million-event pulls because the engine streams to disk
 * and the parser reads the files after the CLI exits.
 *
 * `runtimeName` is the unique key in the output path. Defaults to
 * `mcp-<timestamp>-<pid>` so multiple parallel invocations don't clash.
 * Cleanup of the output directory is the caller's responsibility.
 */
export async function runDevCliFileOutput(
  rawLogText: string,
  runtimeName?: string,
): Promise<DevCliResult & { encodedFile: string; templatesFile: string; aggregatedFile: string; runtimeName: string }> {
  const mode = await resolveTenxMode();
  const name = runtimeName ?? `mcp-${Date.now()}-${process.pid}`;
  const outputDir = `/tmp/log10x-mcp-pull/${name}`;
  await mkdir(outputDir, { recursive: true });
  const started = Date.now();

  let cliVersion: string | undefined;
  if (mode === 'docker') {
    ({ cliVersion } = await runAppsMcpFileViaDocker(rawLogText, name));
  } else {
    ({ cliVersion } = await runAppsMcpFileViaLocalBinary(rawLogText, name));
  }

  const [encodedLog, templatesRaw, aggregatedCsv] = await Promise.all([
    readFile(join(outputDir, 'encoded.log'), 'utf8').catch(() => ''),
    readFile(join(outputDir, 'templates.json'), 'utf8').catch(() => ''),
    readFile(join(outputDir, 'aggregated.csv'), 'utf8').catch(() => ''),
  ]);

  // templates.json is one JSON object per line. Parser expects raw
  // JSON-lines as a single string already — pass through.
  const configPath = resolveConfigPath('LOG10X_MCP_FILE_CONFIG_PATH', 'tenx-mcp-file.config.yaml');
  return {
    templatesJson: templatesRaw,
    encodedLog,
    decodedLog: '',
    aggregatedCsv,
    wallTimeMs: Date.now() - started,
    cliVersion,
    configPath,
    tempDir: outputDir,
    encodedFile: join(outputDir, 'encoded.log'),
    templatesFile: join(outputDir, 'templates.json'),
    aggregatedFile: join(outputDir, 'aggregated.csv'),
    runtimeName: name,
  };
}

async function runAppsMcpFileViaLocalBinary(
  rawLogText: string,
  runtimeName: string,
): Promise<{ cliVersion: string | undefined }> {
  const binary = process.env.LOG10X_TENX_PATH || 'tenx';
  if (!(await isBinaryOnPath(binary))) {
    throw new DevCliNotInstalledError();
  }
  const cliVersion = await tryGetVersion(binary);
  const configPath = resolveConfigPath('LOG10X_MCP_FILE_CONFIG_PATH', 'tenx-mcp-file.config.yaml');
  const { config: tenxConfig, modules: tenxModules } = resolveInstallPaths();
  const includePaths = [
    tenxConfig,
    join(tenxConfig, 'pipelines'),
    tenxModules,
    join(tenxModules, 'pipelines'),
    join(tenxModules, 'apps'),
  ].join(';');
  // tenx-mcp-file.config.yaml includes apps/shared → run/bootstrap, which
  // declares `apiKey` as a required commandLine argument. Bootstrap resolves
  // it via TenXEnv.get("TENX_API_KEY", "NO-API-KEY"). When TENX_API_KEY is
  // absent from the process env the engine emits a tilde-prefixed positional
  // arg error ("apiKey ~NO-API-KEY"). Inject the env var explicitly so
  // bootstrap resolves the default through its env-var path (no positional
  // arg surface) rather than hitting the commandLine validator.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOG10X_MCP_RUNTIME_NAME: runtimeName,
    TENX_INCLUDE_PATHS: includePaths,
    LOG10X_MCP_OUTPUT_DIR: '/tmp/log10x-mcp-pull/' + runtimeName,
    TENX_API_KEY: process.env.TENX_API_KEY ?? process.env.LOG10X_API_KEY ?? 'NO-API-KEY',
  };
  await runCommandWithStdin(
    binary,
    ['@' + configPath],
    rawLogText,
    { env, timeoutMs: 300_000, configPath },
  );
  return { cliVersion };
}

async function runAppsMcpFileViaDocker(
  rawLogText: string,
  runtimeName: string,
): Promise<{ cliVersion: string | undefined }> {
  try {
    await runCommand('docker', ['info'], { timeoutMs: 5_000 });
  } catch (e) {
    throw new DockerNotAvailableError((e as Error).message || String(e));
  }
  const image = process.env.LOG10X_TENX_IMAGE || 'log10x/pipeline-10x:latest';
  const hostConfigPath = resolveConfigPath('LOG10X_MCP_FILE_CONFIG_PATH', 'tenx-mcp-file.config.yaml');
  const containerConfigPath = '/mcp/config/tenx-mcp-file.config.yaml';
  const hostOutputDir = `/tmp/log10x-mcp-pull/${runtimeName}`;
  const containerOutputDir = hostOutputDir;
  // Write the raw log text to a temp file so the file-input config can read it.
  // The container mounts this file read-only at /mcp/input/events.log.
  const hostInputFile = join(hostOutputDir, 'input.log');
  await fsWriteFile(hostInputFile, rawLogText, 'utf8');
  const containerInputFile = '/mcp/input/events.log';
  // Mount the host's /tmp/log10x-mcp-pull/<name> into the container so the
  // engine's file writes land where the caller can read them.
  // Also mount the packaged config so the container uses the resolved path,
  // not the @apps/mcp-file macro which requires TENX_HOME inside the container.
  const args = [
    'run', '--rm',
    '-e', `LOG10X_MCP_RUNTIME_NAME=${runtimeName}`,
    '-e', `LOG10X_MCP_OUTPUT_DIR=${containerOutputDir}`,
    '-e', `LOG10X_MCP_INPUT_PATH=${containerInputFile}`,
    '-v', `${hostOutputDir}:${containerOutputDir}`,
    '-v', `${hostConfigPath}:${containerConfigPath}:ro`,
    '-v', `${hostInputFile}:${containerInputFile}:ro`,
    image,
    '@' + containerConfigPath,
  ];
  await runCommandWithStdin('docker', args, null, { timeoutMs: 300_000, configPath: hostConfigPath });
  return { cliVersion: undefined };
}

/**
 * Run `tenx @apps/mcp` with batch piped to stdin and demultiplex the
 * resulting stdout into the four buffers the parser expects.
 *
 * The @apps/mcp engine app emits a single stdout stream with three
 * discriminable line types:
 *   `~hash,vals...`                            — encoded TenXObject
 *   `{"templateHash":"...","template":"..."}`  — new TenXTemplate
 *   `summary=,SEVERITY,pattern,vol,bytes,...`  — aggregated TenXSummary
 * Any other line (engine info, JS console output) is skipped.
 *
 * Path resolution: the engine finds `apps/mcp` via the user's
 * `TENX_HOME` / `TENX_MODULES` / `TENX_CONFIG` env vars, or OS defaults.
 * See https://doc.log10x.com/install/paths/. Requires an engine release
 * with `apps/mcp` shipped (≥ the first release after PR #34).
 *
 * No tempdir, no shadow template config, no file I/O — eliminates the
 * macOS `/var/folders` config-resolver bug, the system-cache dedup, and
 * the `LOG10X_MCP_OUTPUT_DIR` empty-path crash.
 */
export async function runDevCliStdin(rawLogText: string): Promise<DevCliResult> {
  const mode = await resolveTenxMode();
  const started = Date.now();
  let cliVersion: string | undefined;
  let stdout: string;

  if (mode === 'docker') {
    ({ stdout, cliVersion } = await runAppsMcpViaDocker(rawLogText));
  } else {
    ({ stdout, cliVersion } = await runAppsMcpViaLocalBinary(rawLogText));
  }

  // Demultiplex stdout by per-line prefix.
  //
  // apps/mcp/stdout/config.yaml now emits each kind of line behind a
  // self-describing literal anchor:
  //
  //   encoded= ,~<hash>,val1,val2,…,pattern=,<message_pattern>,patternHash=,<tenx_hash>
  //   {"templateHash":"…","template":"…"}
  //   summary= ,<severity>,<message_pattern>,<tenx_hash>,<vol>,<bytes>,<totals>
  //
  // (The leading `~` on the encoded payload still exists but now sits
  // after the `encoded=` anchor, so first-byte tests no longer work for
  // routing — we match prefixes by string.)
  const encodedLines: string[] = [];
  const templateLines: string[] = [];
  const summaryLines: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('encoded=')) {
      // Strip the literal `encoded=,` so parseEncoded sees the
      // `~hash,vals…,pattern=,…,patternHash=,…` body without the anchor.
      encodedLines.push(line.slice('encoded='.length).replace(/^,/, ''));
    } else if (line.charCodeAt(0) === 0x7B /* { */) {
      templateLines.push(line);
    } else if (line.startsWith('summary=')) {
      summaryLines.push(line.slice('summary='.length).replace(/^,/, ''));
    }
    // Otherwise: engine info line (emoji-prefixed) or JS console output — skip.
  }

  // Synthesize a header for the aggregated rows so parseAggregated()
  // can dispatch on column names. apps/mcp's stdout config emits the
  // enrichment fields in this order:
  //   severity_level, message_pattern, tenx_hash, summaryVolume, summaryBytes, summaryTotals
  // The `tenx_hash` column was added when the new aggregator started
  // emitting summaries on EOF (drain enabled via --install-exit-handlers
  // in the native-image build). Without `tenx_hash` here, parseAggregated
  // would mis-bind every column to the right of message_pattern.
  const aggregatedHeader = 'severity_level,message_pattern,tenx_hash,summaryVolume,summaryBytes,summaryTotals';

  return {
    templatesJson: templateLines.join('\n'),
    encodedLog: encodedLines.join('\n'),
    decodedLog: '',
    aggregatedCsv: summaryLines.length > 0
      ? aggregatedHeader + '\n' + summaryLines.join('\n')
      : '',
    wallTimeMs: Date.now() - started,
    cliVersion,
    configPath: '@apps/mcp',
    tempDir: '',
  };
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
  const mode = await resolveTenxMode();

  if (!existsSync(opts.configPath)) {
    throw new Error(
      `MCP tenx config not found at: ${opts.configPath}. ` +
        `Reinstall the log10x-mcp package or set the appropriate config path env var.`
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'log10x-mcp-'));

  // Local mode only: shadow the install's run/template/config.yaml with
  // files: [] so previously-written templates under data/templates/ or
  // data/sample/output/ don't pre-load into the cache. Docker is
  // ephemeral — the image's bundled templates are deterministic per run
  // and don't survive container exit — so no shadow is needed there.
  if (mode === 'local') {
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
  }

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

/**
 * Pick the backend.
 *
 *   - Explicit `LOG10X_TENX_MODE=local|docker` wins.
 *   - Unset: prefer docker (no host install, easy updates via `docker pull`)
 *     and fall back to the local binary if docker isn't reachable.
 *   - Invalid value throws.
 *
 * The auto-detect probe runs `docker info` with a short timeout. If a user
 * wants to guarantee local mode (avoid the probe latency), they can set
 * `LOG10X_TENX_MODE=local` explicitly.
 */
async function resolveTenxMode(): Promise<'local' | 'docker'> {
  const raw = (process.env.LOG10X_TENX_MODE || '').trim().toLowerCase();
  if (raw === 'local') return 'local';
  if (raw === 'docker') return 'docker';
  if (raw) {
    throw new Error(
      `Invalid LOG10X_TENX_MODE="${process.env.LOG10X_TENX_MODE}". ` +
        `Valid values: "local", "docker", or unset for auto-detect.`
    );
  }
  // Unset — try docker first.
  try {
    await runCommand('docker', ['info'], { timeoutMs: 2_000 });
    return 'docker';
  } catch {
    return 'local';
  }
}

// ── apps/mcp backends (stdin → demuxed stdout) ──

async function runAppsMcpViaLocalBinary(
  rawLogText: string
): Promise<{ stdout: string; cliVersion: string | undefined }> {
  const binary = process.env.LOG10X_TENX_PATH || 'tenx';
  if (!(await isBinaryOnPath(binary))) {
    throw new DevCliNotInstalledError();
  }
  const cliVersion = await tryGetVersion(binary);

  // TENX_INCLUDE_PATHS injected so the engine resolves apps/mcp without
  // requiring user-set TENX_HOME in the MCP server's environment.
  const { config: tenxConfig, modules: tenxModules } = resolveInstallPaths();
  const includePaths = [
    tenxConfig,
    join(tenxConfig, 'pipelines'),
    tenxModules,
    join(tenxModules, 'pipelines'),
    join(tenxModules, 'apps'),
  ].join(';');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TENX_INCLUDE_PATHS: includePaths,
    LOG10X_MCP_RUNTIME_NAME: `mcp-${Date.now()}`,
  };

  const stdout = await runCommandWithStdin(
    binary,
    ['@apps/mcp'],
    rawLogText,
    { env, timeoutMs: 120_000, configPath: '@apps/mcp' }
  );
  return { stdout, cliVersion };
}

async function runAppsMcpViaDocker(
  rawLogText: string
): Promise<{ stdout: string; cliVersion: string | undefined }> {
  try {
    await runCommand('docker', ['info'], { timeoutMs: 5_000 });
  } catch (e) {
    throw new DockerNotAvailableError((e as Error).message || String(e));
  }
  const image = process.env.LOG10X_TENX_IMAGE || 'log10x/pipeline-10x:latest';
  const args = [
    'run', '--rm', '-i',
    '-e', `LOG10X_MCP_RUNTIME_NAME=mcp-${Date.now()}`,
    image,
    '@apps/mcp',
  ];
  const stdout = await runCommandWithStdin(
    'docker',
    args,
    rawLogText,
    { timeoutMs: 180_000, configPath: '@apps/mcp' }
  );
  return { stdout, cliVersion: `docker:${image}` };
}

// ── Install path resolution ──

/**
 * Locate the user's tenx install (modules + config). Mirrors the engine's
 * own resolver (https://doc.log10x.com/install/paths/), skipping
 * TENX_INCLUDE_PATHS (we're setting that ourselves) and the working-dir
 * step (not meaningful when spawned from the MCP).
 *
 * Precedence:
 *   1. TENX_MODULES + TENX_CONFIG (both required)
 *   2. TENX_HOME → $TENX_HOME/lib/app/modules (or /modules) + /config
 *   3. Per-OS defaults — Linux /opt/tenx-{cloud,edge}, Windows %ProgramFiles%/TenX
 *      (or %LOCALAPPDATA%/TenX), macOS Homebrew (/opt/homebrew or /usr/local)
 */
function resolveInstallPaths(): { config: string; modules: string } {
  const envModules = process.env.TENX_MODULES;
  const envConfig = process.env.TENX_CONFIG;
  if (envModules && envConfig) {
    return { config: envConfig, modules: envModules };
  }

  const tenxHome = process.env.TENX_HOME;
  if (tenxHome) {
    const libModules = join(tenxHome, 'lib', 'app', 'modules');
    const flatModules = join(tenxHome, 'modules');
    return {
      config: join(tenxHome, 'config'),
      modules: existsSync(libModules) ? libModules : flatModules,
    };
  }

  const osDefaults = resolveOsDefaultInstall();
  if (osDefaults) return osDefaults;

  throw new Error(
    'Cannot locate tenx install on this machine. ' +
      'If you have tenx installed but in a custom location, set TENX_HOME or TENX_MODULES+TENX_CONFIG to point at it.\n\n' +
      tenxAvailabilityHint()
  );
}

function resolveOsDefaultInstall(): { config: string; modules: string } | null {
  if (process.platform === 'linux') {
    const config = '/etc/tenx/config';
    for (const flavor of ['tenx-cloud', 'tenx-edge']) {
      const modules = `/opt/${flavor}/lib/app/modules`;
      if (existsSync(modules)) return { config, modules };
    }
    return null;
  }
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    const localAppData = process.env.LOCALAPPDATA;
    const moduleBases = [programFiles, localAppData].filter((v): v is string => !!v);
    const configBases = [programData, localAppData].filter((v): v is string => !!v);
    // Try MSI installer layout (tenx-cloud / tenx-edge) and the engine's
    // documented OS-default layout (TenX).
    for (const mBase of moduleBases) {
      for (const subdir of ['tenx-cloud', 'tenx-edge', 'TenX']) {
        const modules = join(mBase, subdir, 'lib', 'app', 'modules');
        if (!existsSync(modules)) continue;
        for (const cBase of configBases) {
          for (const cSubdir of ['tenx', 'TenX']) {
            const config = join(cBase, cSubdir, 'config');
            if (existsSync(config)) return { config, modules };
          }
        }
      }
    }
    return null;
  }
  if (process.platform === 'darwin') {
    // Homebrew prefix — try Apple Silicon first, then Intel.
    for (const prefix of ['/opt/homebrew', '/usr/local']) {
      const modules = `${prefix}/lib/tenx/modules`;
      const config = `${prefix}/etc/tenx/config`;
      if (existsSync(modules) && existsSync(config)) return { config, modules };
    }
    return null;
  }
  return null;
}

// ── Local binary backend (legacy file-mode path, used by extract-templates) ──

async function runViaLocalBinary(
  opts: RunDevCliOptions,
  tempDir: string
): Promise<string | undefined> {
  const binary = process.env.LOG10X_TENX_PATH || 'tenx';
  if (!(await isBinaryOnPath(binary))) {
    throw new DevCliNotInstalledError();
  }

  const cliVersion = await tryGetVersion(binary);

  // Enumerate the install's modules+config so we can put tempDir FIRST
  // in TENX_INCLUDE_PATHS for the shadow to win resolution. Setting
  // TENX_INCLUDE_PATHS replaces the engine's own path resolver, so we
  // have to spell out everything the engine would otherwise have found.
  const { config: tenxConfig, modules: tenxModules } = resolveInstallPaths();
  const includePaths = [
    tempDir,
    tenxConfig,
    join(tenxConfig, 'pipelines'),
    tenxModules,
    join(tenxModules, 'pipelines'),
    join(tenxModules, 'apps'),
  ].join(';');

  // Same bootstrap apiKey fix as runAppsMcpFileViaLocalBinary — this path
  // also goes through tenx-mcp-file.config.yaml which includes run/bootstrap.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TENX_INCLUDE_PATHS: includePaths,
    LOG10X_MCP_OUTPUT_DIR: tempDir,
    LOG10X_MCP_RUNTIME_NAME: `mcp-${Date.now()}`,
    TENX_API_KEY: process.env.TENX_API_KEY ?? process.env.LOG10X_API_KEY ?? 'NO-API-KEY',
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
 * Image is `log10x/pipeline-10x:latest` (override via LOG10X_TENX_IMAGE).
 *
 * Mounts:
 *   - <tempDir>              → /mcp/output  (rw) — result files
 *   - <dirname(configPath)>  → /mcp/config  (ro) — the packaged YAML
 *   - <dirname(inputPath)>   → /mcp/input   (ro) — file mode only
 *
 * No TENX_INCLUDE_PATHS override and no shadow template config: the
 * container's baked install at /etc/tenx/config and /opt/tenx-cloud
 * resolves modules on its own, and ephemerality means no cross-run
 * template state to suppress.
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
