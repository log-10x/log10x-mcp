/**
 * Local `tenx` dev CLI runner.
 *
 * Spawns a local Log10x engine (a native tenx CLI or a local Docker
 * container) with a packaged runtime config, reads the resulting
 * templates + encoded rows + aggregated summary from a per-invocation
 * temp dir. Two modes:
 *
 *   - stdin: batch piped to stdin (log10x_resolve_batch)
 *   - file:  reads from a path/glob (log10x_extract_templates)
 *
 * Backend selection via LOG10X_TENX_MODE (see resolveTenxMode):
 *   - unset (default): auto-detect. Prefer the host-installed tenx binary;
 *     fall back to docker only when no binary is on PATH. The host install is
 *     a version the operator chose, whereas the default image tag is mutable,
 *     so preferring docker made a report's engine build depend on whatever
 *     `:latest` happened to be that day.
 *   - "local": invoke the host-installed tenx binary.
 *     Binary lookup: LOG10X_TENX_PATH env var wins; otherwise `tenx` on PATH.
 *   - "docker": `docker run --rm -i log10x/pipeline-10x:latest` (or
 *     LOG10X_RUNTIME_IMAGE / LOG10X_TENX_IMAGE — see resolveRuntimeImage;
 *     `LOG10X_RUNTIME_IMAGE=native` selects the GraalVM-native
 *     log10x/edge-10x, which runs @apps/mcp identically at 391 MB instead of
 *     926 MB). Works on hosts without a native tenx install, and for
 *     hermetic/offline-capable invocation.
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
import { resolveRuntimeImage } from './runtime-image.js';

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
    super(tenxAvailabilityHint());
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
  /** Which backend produced this failure, when the caller recorded it. */
  readonly tenxMode?: 'local' | 'docker';
  constructor(
    exitCode: number,
    stderr: string,
    stdout: string,
    configPath: string,
    tenxMode?: 'local' | 'docker'
  ) {
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
    this.tenxMode = tenxMode;
  }
}

/**
 * True when the engine refused a license it was handed, as opposed to
 * refusing to start because it was handed none.
 *
 * An engine handed a non-JWT `TENX_LICENSE_KEY` prints:
 *
 *   could not launch pipeline: 'run'
 *   Invalid serialized unsecured/JWS/JWE object: Missing part delimiters
 *   details:
 *   error initializating engine environment
 *   license verification failed: MALFORMED — license token is not a parseable JWT
 *   LicenseException: license token is not a parseable JWT
 *
 * `license verification failed:` carries the state word (MALFORMED here,
 * EXPIRED and the rest elsewhere), so it is the anchor, with
 * `LicenseException` as the second reading.
 *
 * The "handed none" case reads `license required: set --licenseFile, …` and
 * deliberately does NOT match: withholding a key that was never forwarded
 * cannot fix it.
 */
export function isEngineLicenseRejection(stderr: string): boolean {
  const s = (stderr || '').toLowerCase();
  return s.includes('license verification failed') || s.includes('licenseexception');
}

/**
 * Bare `-e VAR` pass-through for the engine license, mirroring the compile
 * path (compile-runner buildDockerArgs). Bare form so the value is inherited
 * from the spawning process env and never lands in argv.
 *
 * The runtime docker path used to forward nothing, so a caller with
 * TENX_LICENSE_KEY set watched the key get silently dropped.
 */
export function dockerLicenseArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return env.TENX_LICENSE_KEY ? ['-e', 'TENX_LICENSE_KEY'] : [];
}

/**
 * Run a docker attempt with the license forwarded, and retry once with it
 * withheld if the engine rejects it.
 *
 * Forwarding `TENX_LICENSE_KEY` is an improvement for the caller who has a
 * good key and a regression for everyone else: the runtime images carry their
 * own built-in limited license, so before forwarding, a stale or malformed
 * `TENX_LICENSE_KEY` sitting in the environment was simply ignored and the run
 * succeeded. Measured on the same batch, engine 1.1.39: no key forwarded gives
 * `2 events -> 1 pattern`; a non-JWT key forwarded gives exit 1 and
 * `license verification failed: MALFORMED`. Docker mode is also not opt-in — a
 * host with no `tenx` on PATH auto-resolves to it — so the forwarding change
 * alone would take a working call away from a user who never asked for it.
 *
 * Withholding the key on a license rejection restores exactly the pre-forward
 * behaviour, and only in the case where the forwarded key is what broke the
 * run. A run that fails for any other reason is re-thrown untouched, and a run
 * with no key set never makes a second attempt.
 *
 * The downgrade is announced on stderr rather than swallowed: a caller who
 * meant to run under their own license should not silently end up on the
 * image's limited one.
 */
export async function withDockerLicenseFallback<T>(
  attempt: (licenseArgs: string[]) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env
): Promise<T> {
  const licenseArgs = dockerLicenseArgs(env);
  if (licenseArgs.length === 0) return attempt([]);
  try {
    return await attempt(licenseArgs);
  } catch (e) {
    const stderr = e instanceof DevCliRunError ? e.stderr : ((e as Error)?.message ?? '');
    if (!isEngineLicenseRejection(stderr)) throw e;
    console.error(
      '[log10x-mcp] the engine refused the TENX_LICENSE_KEY this server forwarded to docker. ' +
        'Retrying on the image built-in limited license. Replace or unset TENX_LICENSE_KEY to stop seeing this.'
    );
    return attempt([]);
  }
}

/**
 * Turn a non-zero local-engine exit into a hint the caller can act on.
 *
 * The hint must name what the engine actually refused on. `TENX_API_KEY` is
 * not it, and the engine's own diagnosis sits in `debug_stderr`; an
 * unlicensed `tenx` on PATH (the state every Homebrew install starts in)
 * otherwise produces a message that points nowhere.
 *
 * Two traps:
 *
 *   - Appending "Set LOG10X_TENX_MODE=docker … (no license needed)" on every
 *     failure tells a reader already in docker mode to turn on the mode they
 *     are in, and tells them no license is needed in the same breath as their
 *     license refusing the run. `mode` decides which escape is named.
 *   - Promoting only `license required:` leaves the far commoner refusal,
 *     `license verification failed:`, buried under
 *     `could not launch pipeline: 'run'`, which is what `lines[0]` is.
 */
export function describeDevCliFailure(
  exitCode: number,
  stderr: string,
  opts: { mode?: 'local' | 'docker'; licenseKeyForwarded?: boolean } = {}
): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const licenseLine = lines.find(
    (l) =>
      l.toLowerCase().startsWith('license required:') ||
      l.toLowerCase().startsWith('license verification failed')
  );
  const engineLine = licenseLine ?? lines[0];
  const rejected = isEngineLicenseRejection(stderr);
  const forwarded = opts.licenseKeyForwarded ?? Boolean(process.env.TENX_LICENSE_KEY);

  let escape: string;
  if (opts.mode === 'docker') {
    escape = rejected
      ? 'The engine ran in docker mode and refused a license. ' +
        (forwarded
          ? 'The TENX_LICENSE_KEY this server forwarded was already withheld on an automatic retry, so the key alone is not what is left: '
          : 'No TENX_LICENSE_KEY was forwarded, so the refusal came from inside the image: ') +
        'check TENX_LICENSE_FILE and any licenseKey/licenseFile entry in the bootstrap .yaml the engine reads, or pin a known-good image with LOG10X_RUNTIME_IMAGE.'
      : 'The engine ran in docker mode (LOG10X_TENX_MODE=docker, or no tenx on PATH so docker was the fallback). ' +
        'Set LOG10X_TENX_MODE=local with LOG10X_TENX_PATH to run a local install instead, or pin the image with LOG10X_RUNTIME_IMAGE.';
  } else if (opts.mode === 'local') {
    escape =
      'The engine ran as a local binary. Set LOG10X_TENX_MODE=docker to run the engine image instead ' +
      '(it carries a built-in limited license, so a local install without one still gets an answer), ' +
      'or point the local engine at a license with TENX_LICENSE_KEY or TENX_LICENSE_FILE.';
  } else {
    escape =
      'Point the engine at a license with TENX_LICENSE_KEY or TENX_LICENSE_FILE, ' +
      'or run the engine image with LOG10X_TENX_MODE=docker, which carries a built-in limited license.';
  }

  return [
    `Local tenx CLI exited with code ${exitCode}.`,
    engineLine ? `Engine said: ${engineLine.slice(0, 400)}` : undefined,
    escape,
    'Full engine output is in data.payload.debug_stderr.',
  ]
    .filter(Boolean)
    .join(' ');
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

/**
 * The credentials a local engine run actually needs.
 *
 * These are two different things and the distinction is the whole point:
 *
 *   - `licenseKey` is the REAL credential. The engine verifies it offline
 *     against embedded ES256 keys (signature + expiry, nothing else — see
 *     PipelineLauncher.resolveLicense), so once minted it works with no
 *     egress, including airgapped. A not-signed-in user gets an anonymous
 *     14-day demo license from `POST /api/v1/license/demo`, cached in
 *     `~/.log10x/demo-license.json` and reused until it expires. This is the
 *     same license the website's generated install command carries, and the
 *     same one `advise_install` bakes into its plan — one credential, every
 *     surface.
 *
 *   - `apiKey` authenticates NOTHING here. `apps/shared → run/bootstrap`
 *     declares `apiKey` as a required commandLine argument, so an absent
 *     `TENX_API_KEY` surfaces as a tilde-prefixed positional-arg error. It is
 *     a validator placeholder.
 *
 * Requiring a real API key for both is what made the POC path unreachable for
 * exactly the users it was built for: measured 2026-08-10 in a no-egress
 * container, `poc_from_local` refused with "LOG10X_API_KEY is not configured"
 * on a tool whose own contract reads "no vendor credentials needed... events
 * never leave the machine".
 */
export interface EngineCredentials {
  licenseKey: string;
  apiKey: string;
}

/** Placeholder for bootstrap's required-arg validator. Not a credential. */
const BOOTSTRAP_API_KEY_PLACEHOLDER = 'MCP-LOCAL';

export async function resolveEngineCredentials(): Promise<EngineCredentials> {
  const apiKey =
    process.env.TENX_API_KEY ||
    process.env.LOG10X_API_KEY ||
    BOOTSTRAP_API_KEY_PLACEHOLDER;

  // An explicit license always wins — a customer with a full license, or an
  // airgapped box that was seeded with one, never needs the mint path.
  const explicit = process.env.TENX_LICENSE_KEY?.trim();
  if (explicit) {
    return { licenseKey: explicit, apiKey };
  }

  try {
    const { getOrMintDemoLicense } = await import('./license-api.js');
    const lic = await getOrMintDemoLicense();
    return { licenseKey: lic.jwt, apiKey };
  } catch (e) {
    throw new DevCliConfigMissingError(
      'TENX_LICENSE_KEY',
      `The local engine needs a license and none could be obtained: ${(e as Error).message}. ` +
        `A cached demo license lives at ~/.log10x/demo-license.json and is minted automatically ` +
        `on first use — that mint needs one call to the log10x gateway. If this host has no ` +
        `egress, set TENX_LICENSE_KEY (or TENX_LICENSE_FILE) to a license minted elsewhere; ` +
        `the engine verifies it offline, so it keeps working with no network. Signed-in users ` +
        `get a longer-lived license via \`log10x_signin_start\`.`
    );
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
  //
  // Before injecting: check that a real API key is available. If not, throw
  // DevCliConfigMissingError so the tool boundary converts it to a
  // config_missing chassis envelope with a useful hint (FIX 68-residual).
  const engineCreds = await resolveEngineCredentials();
  const resolvedApiKey = engineCreds.apiKey;
  // tenx-mcp-file.config.yaml is a FILE-input config: it reads from
  // LOG10X_MCP_INPUT_PATH, not from stdin. Piping the batch to stdin (as
  // this used to) left the input path unset, so the engine read nothing,
  // exited immediately, and the pending stdin write died with EPIPE. The
  // docker backend already writes an input.log and mounts it; do the same
  // here so both backends drive the identical config.
  const outputDir = '/tmp/log10x-mcp-pull/' + runtimeName;
  await mkdir(outputDir, { recursive: true });
  const inputFile = join(outputDir, 'input.log');
  await fsWriteFile(inputFile, rawLogText, 'utf8');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOG10X_MCP_RUNTIME_NAME: runtimeName,
    TENX_INCLUDE_PATHS: includePaths,
    LOG10X_MCP_OUTPUT_DIR: outputDir,
    LOG10X_MCP_INPUT_PATH: inputFile,
    TENX_API_KEY: resolvedApiKey,
    TENX_LICENSE_KEY: engineCreds.licenseKey,
  };
  await runCommandWithStdin(
    binary,
    ['@' + configPath],
    null,
    { env, timeoutMs: 300_000, configPath, tenxMode: 'local' },
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
  const image = resolveRuntimeImage();
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
  await withDockerLicenseFallback((licenseArgs) =>
    runCommandWithStdin(
      'docker',
      [
        'run', '--rm',
        ...licenseArgs,
        '-e', `LOG10X_MCP_RUNTIME_NAME=${runtimeName}`,
        '-e', `LOG10X_MCP_OUTPUT_DIR=${containerOutputDir}`,
        '-e', `LOG10X_MCP_INPUT_PATH=${containerInputFile}`,
        '-v', `${hostOutputDir}:${containerOutputDir}`,
        '-v', `${hostConfigPath}:${containerConfigPath}:ro`,
        '-v', `${hostInputFile}:${containerInputFile}:ro`,
        image,
        '@' + containerConfigPath,
      ],
      null,
      { timeoutMs: 300_000, configPath: hostConfigPath, tenxMode: 'docker' }
    )
  );
  // Record WHICH image ran. The default tag is mutable, so `:latest` alone
  // does not identify a build; append the local image id when docker can
  // resolve one. Best-effort: a failed inspect must not fail the run.
  let ref = `docker ${image}`;
  try {
    const id = await runCommand('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
      timeoutMs: 5_000,
    });
    const digest = id.trim().split('\n')[0]?.trim();
    if (digest) ref = `docker ${image} (${digest.slice(0, 19)})`;
  } catch {
  // leave the bare image ref
  }
  return { cliVersion: ref };
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
 * that ships `apps/mcp`.
 *
 * No tempdir, no shadow template config, no file I/O — eliminates the
 * macOS `/var/folders` config-resolver bug, the system-cache dedup, and
 * the `LOG10X_MCP_OUTPUT_DIR` empty-path crash.
 */
export async function runDevCliStdin(rawLogText: string): Promise<DevCliResult> {
  // Guard: require a real API key before running. Covers both local and docker
  // mode — docker still needs the key injected as TENX_API_KEY so the engine
  // can validate it (FIX 68-residual). Throw DevCliConfigMissingError so the
  // tool boundary (executeResolveBatch / executeExtractTemplates) converts it
  // to a config_missing chassis envelope.
  const engineCreds = await resolveEngineCredentials();
  const resolvedApiKey = engineCreds.apiKey;
  // Both backends need the license. The local path takes it through the env
  // object it builds; the docker path forwards it with a bare `-e
  // TENX_LICENSE_KEY` (see dockerLicenseArgs), which inherits from THIS
  // process env — so a minted demo license has to land there or docker mode
  // keeps running on the image's built-in limited license instead.
  if (!process.env.TENX_LICENSE_KEY) {
    process.env.TENX_LICENSE_KEY = engineCreds.licenseKey;
  }

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
  // routing — match prefixes by string.
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
export async function resolveTenxMode(): Promise<'local' | 'docker'> {
  const raw = (process.env.LOG10X_TENX_MODE || '').trim().toLowerCase();
  if (raw === 'local') return 'local';
  if (raw === 'docker') return 'docker';
  if (raw) {
    throw new Error(
      `Invalid LOG10X_TENX_MODE="${process.env.LOG10X_TENX_MODE}". ` +
        `Valid values: "local", "docker", or unset for auto-detect.`
    );
  }
  // Unset — prefer the host binary, fall back to docker.
  //
  // This order used to be reversed, and the reversal was silently
  // load-bearing: the default runtime image tag is MUTABLE, so a host with
  // Docker running would get whatever `:latest` happened to be, at a
  // different version and flavor than the `tenx` on its PATH. A POC report
  // generated on one machine was not reproducible on another, and nothing
  // in the output said which engine had produced it. The host binary is a
  // pinned install with a version the caller chose, so prefer it and treat
  // docker as the fallback for hosts with no install.
  const binary = process.env.LOG10X_TENX_PATH || 'tenx';
  if (await isBinaryOnPath(binary)) return 'local';
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

  // Guard: if LOG10X_API_KEY is absent or equals the placeholder, throw
  // DevCliConfigMissingError so the tool boundary emits a config_missing
  // envelope (FIX 68-residual). Same guard as runAppsMcpFileViaLocalBinary.
  const engineCreds = await resolveEngineCredentials();
  const resolvedApiKey = engineCreds.apiKey;

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
    TENX_API_KEY: resolvedApiKey,
    TENX_LICENSE_KEY: engineCreds.licenseKey,
  };

  const stdout = await runCommandWithStdin(
    binary,
    ['@apps/mcp'],
    rawLogText,
    { env, timeoutMs: 120_000, configPath: '@apps/mcp', tenxMode: 'local' }
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
  const image = resolveRuntimeImage();
  const stdout = await withDockerLicenseFallback((licenseArgs) =>
    runCommandWithStdin(
      'docker',
      [
        'run', '--rm', '-i',
        ...licenseArgs,
        '-e', `LOG10X_MCP_RUNTIME_NAME=mcp-${Date.now()}`,
        image,
        '@apps/mcp',
      ],
      rawLogText,
      { timeoutMs: 180_000, configPath: '@apps/mcp', tenxMode: 'docker' }
    )
  );
  return { stdout, cliVersion: `docker:${image}` };
}

// ── Install path resolution ──

/**
 * Locate the user's tenx install (modules + config). Mirrors the engine's
 * own resolver (https://doc.log10x.com/install/paths/), skipping
 // own resolver (https://doc.log10x.com/install/paths/), skipping
 * step (not meaningful when spawned from the MCP).
 *
 * Precedence:
 *   1. TENX_MODULES + TENX_CONFIG (both required)
 *   2. TENX_HOME → $TENX_HOME/lib/app/modules (or /modules) + /config
 *   3. Per-OS defaults — Linux /opt/tenx-{cloud,edge}, Windows %ProgramFiles%/TenX
 *      (or %LOCALAPPDATA%/TenX), macOS Homebrew (/opt/homebrew or /usr/local)
 */
export function resolveInstallPaths(): { config: string; modules: string } {
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

  // Enumerate the install's modules+config to put tempDir FIRST in
  // TENX_INCLUDE_PATHS so the shadow wins resolution. Setting
  // TENX_INCLUDE_PATHS replaces the engine's own path resolver, so it must
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
  // Guard: if LOG10X_API_KEY is absent or equals the placeholder, throw
  // DevCliConfigMissingError so the tool boundary emits a config_missing
  // chassis envelope (FIX 68-residual).
  const engineCreds = await resolveEngineCredentials();
  const resolvedApiKey = engineCreds.apiKey;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TENX_INCLUDE_PATHS: includePaths,
    LOG10X_MCP_OUTPUT_DIR: tempDir,
    LOG10X_MCP_RUNTIME_NAME: `mcp-${Date.now()}`,
    TENX_API_KEY: resolvedApiKey,
    TENX_LICENSE_KEY: engineCreds.licenseKey,
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
      tenxMode: 'local',
    }
  );

  return cliVersion;
}

// ── Docker backend ──

/**
 * Run tenx inside a container. Opt-in via LOG10X_TENX_MODE=docker.
 * Image is `log10x/pipeline-10x:latest` (override via LOG10X_RUNTIME_IMAGE,
 * which also accepts the alias `native`, or the shared LOG10X_TENX_IMAGE).
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

  const image = resolveRuntimeImage();

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
    // TODO: glob paths aren't supported here — the parent of the exact
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

  const imageIndex = args.length;
  args.push(image);
  args.push(`@${CONTAINER_CONFIG_DIR}/${configName}`);
  if (opts.extraOverlays) {
    for (const overlay of opts.extraOverlays) {
      args.push(`@${overlay}`);
    }
  }

  // License args go last, immediately before the image ref, so the retry can
  // rebuild the tail without disturbing the mounts assembled above.
  await withDockerLicenseFallback((licenseArgs) =>
    runCommandWithStdin(
      'docker',
      [...args.slice(0, imageIndex), ...licenseArgs, ...args.slice(imageIndex)],
      opts.mode === 'stdin' ? (opts.stdinData ?? '') : null,
      {
        // +60s over local default absorbs first-run image pull on a cold host.
        timeoutMs: opts.timeoutMs ?? 180_000,
        configPath: opts.configPath,
        tenxMode: 'docker',
      }
    )
  );

  // Report the ENGINE version, not just the image reference.
  //
  // This returned `docker:log10x/pipeline-10x:latest`, which names a moving tag
  // and therefore says nothing about what actually ran. A host with a stale
  // cached `:latest` produced output indistinguishable from a current one:
  // engine 1.1.6 and engine 1.1.32 both reported that identical string, and the
  // only way to tell them apart was to inspect the local image by hand.
  // Provenance that cannot distinguish a 26-version gap is not provenance.
  //
  // Best-effort: if the probe fails, the image ref alone is still returned, so a
  // labelling problem never fails the run.
  const engineVersion = await tryGetDockerEngineVersion(image);
  return engineVersion ? `docker:${image} (${engineVersion})` : `docker:${image}`;
}

/**
 * Ask an already-pulled image which engine it carries. Short timeout and a
 * swallowed failure: this is a labelling aid, never a gate.
 */
async function tryGetDockerEngineVersion(image: string): Promise<string | undefined> {
  try {
    const out = await runCommand(
      'docker',
      [
        'run', '--rm', '--entrypoint', 'sh', image,
        '-c', '$TENX_BIN --version 2>/dev/null || tenx --version 2>/dev/null',
      ],
      { timeoutMs: 15_000 }
    );
    return out.trim().split('\n')[0]?.slice(0, 120) || undefined;
  } catch {
    return undefined;
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

export async function isBinaryOnPath(binary: string): Promise<boolean> {
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
    // First line only. `tenx --version` follows the version with a
    // "Need help? See ..." line, and this string is embedded in report
    // provenance where a stray newline breaks the surrounding markdown.
    return out.trim().split('\n')[0].trim().slice(0, 120);
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
  /**
   * Which backend this spawn is. Recorded on DevCliRunError so the hint the
   * tool renders can name the escape the caller does NOT already have, rather
   * than telling a docker-mode caller to switch to docker mode.
   */
  tenxMode?: 'local' | 'docker';
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
        rejectPromise(
          new DevCliRunError(code ?? -1, stderr, stdout, options.configPath || '', options.tenxMode)
        );
      }
    });

    if (stdinData !== null && child.stdin) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }
  });
}
