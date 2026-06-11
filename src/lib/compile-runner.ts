/**
 * Compiler app runner — runs `tenx @apps/compiler` (CLOUD flavor only) to
 * scan a local source folder and emit a symbol library (`.10x.json` units +
 * a linked `.10x.tar`). Docker-first (the cloud compiler image log10x/compiler-10x),
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
 * Extensibility:
 *   The `CompileConfig` descriptor + the two per-mode appliers
 *   (`runDockerCompile` / `runLocalCompile`) are the seam for source axes.
 *   Each axis — GitHub pull (implemented), Helm / Docker-image pull, GitHub
 *   PUSH, scan/link tuning — adds an optional field on `CompileConfig` plus
 *   a small renderer that emits one of four injection primitives:
 *     1. env vars            (e.g. TENX_OUTPUT_SYMBOL_*, GH_TOKEN),
 *     2. file replacements   (shadow configs: the inputPaths overlay local-
 *                             side, the pull/<source>/config.yaml overlays),
 *     3. @overlay launch args(the engine's native config layering),
 *     4. mounts              (docker only).
 *   Mode selection, the cloud-flavor gate, process exec, and output
 *   scanning are written once and don't change as axes are added.
 *
 * GitHub pull: the engine's github scanner uses the GitHub REST API (no git
 * binary involved), configured by `pull/github/config.yaml`. We replace that
 * file wholesale — bind-mount over it in docker mode, shadow it via
 * TENX_INCLUDE_PATHS in local mode — listing the requested repos/branch/
 * folders. The token stays an `$=TenXEnv.get("GH_TOKEN")` reference in the
 * rendered YAML (never written to disk); the value travels as process env.
 * The engine hard-refuses an empty token ("empty GitHub API token"), even
 * for public repos, so callers must gate on a token being present.
 *
 * Docker-image pull: the engine materializes an image's filesystem by
 * shelling out to `docker manifest inspect` → `docker create` → `docker
 * export` (no `docker pull`, no registry HTTP client), configured by
 * `pull/docker/config.yaml` — replaced the same way as github. The
 * compiler-10x image bundles podman symlinked as /usr/local/bin/docker, so
 * the pull is DAEMONLESS — no host docker socket — but podman needs
 * CAP_SYS_ADMIN (user-namespace clone) + vfs storage, so docker mode adds
 * `--cap-add SYS_ADMIN -e STORAGE_DRIVER=vfs` ONLY when a dockerImage input
 * is present; the other sources stay unprivileged. Registry creds are
 * optional (public images pull anonymously); when given they travel as
 * DOCKER_USERNAME / DOCKER_TOKEN process env, same pattern as GH_TOKEN.
 * Local mode renders the overlay without a `command` override (the engine's
 * platform default applies) and needs a docker/podman CLI on the host.
 *
 * The cloud-flavor gate: the compiler is absent from the Edge (native /
 * JIT) flavor — its scanners (ANTLR, bytecode, archive, executable) and
 * the link stage need the full JRE-packaged cloud distribution. Docker
 * mode uses the cloud image by contract; local mode probes the binary's
 * version banner (`10x engine v…, flavor: 'cloud'`) and refuses anything
 * that isn't cloud.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

/** A local source folder on disk to scan. */
export interface CompileLocalInput {
  kind: 'local';
  /** Absolute host path to the folder of source code / binaries. */
  path: string;
}

/** GitHub repositories to pull (REST API) and scan. */
export interface CompileGithubInput {
  kind: 'github';
  /** Repositories as `owner/repo` (e.g. `apache/commons-cli`). */
  repos: string[];
  /** Branch to pull for ALL repos; omit for each repo's default branch. */
  branch?: string;
  /** Folders within each repo to pull; omit for the entire repo. */
  folders?: string[];
}

/** Docker/OCI images to pull (daemonless via podman in-image) and scan. */
export interface CompileDockerImageInput {
  kind: 'dockerImage';
  /** Fully-qualified image refs (e.g. `docker.io/grafana/grafana:11.1.0`). */
  images: string[];
}

/** A `helm repo add` target — needed to resolve a bare `repo/chart` name. */
export interface HelmRepo {
  name: string;
  url: string;
}

/**
 * Helm charts to render (`helm template` + `helm show chart`) and scan. A
 * meta-source: the engine extracts the docker images and GitHub source repos
 * the chart references and (optionally) pulls THOSE too.
 */
export interface CompileHelmInput {
  kind: 'helm';
  /**
   * Chart refs. OCI (`oci://...`) and full URLs resolve standalone; a bare
   * `repo/chart` needs a matching entry in `repos`.
   */
  charts: string[];
  /** `helm repo add` targets, so bare `repo/chart` names resolve. */
  repos?: HelmRepo[];
  /** Pull + scan docker images the charts reference (needs CAP_SYS_ADMIN). */
  pullImages: boolean;
  /** Pull + scan GitHub source repos the charts reference (needs a token). */
  pullRepos: boolean;
}

/**
 * Where the compiler reads sources from. Local folder, GitHub pull, docker-
 * image pull, and Helm pull are implemented; future kinds (artifactory /
 * gomod) slot in here as union members — the appliers branch on `kind` and
 * emit the matching pull-config overlay.
 */
export type CompileInput =
  | CompileLocalInput
  | CompileGithubInput
  | CompileDockerImageInput
  | CompileHelmInput;

export interface CompileConfig {
  /** Inputs to scan — any mix of local folders, GitHub pulls, and docker-image pulls. */
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
  /**
   * Credentials the active pull sources need. Values travel as process env
   * (docker: bare `-e` pass-through; local: child env) — never argv, never
   * disk. githubToken is REQUIRED when a github input is present (the engine
   * refuses an empty token, even for public repos).
   */
  credentials?: {
    /** GitHub access token, surfaced to the engine as GH_TOKEN. */
    githubToken?: string;
    /** Registry login for docker-image pull, surfaced as DOCKER_USERNAME. */
    dockerUsername?: string;
    /** Registry token/password for docker-image pull, surfaced as DOCKER_TOKEN. */
    dockerToken?: string;
  };
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
    /** Symbol units with actual content (zero-byte units are excluded). */
    unitCount: number;
    /** Units the scanners emitted EMPTY — every symbol was filtered out. */
    emptyUnitCount: number;
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
        '  1. Docker (recommended): set LOG10X_TENX_MODE=docker (or call this tool with mode="docker") to run the cloud compiler image log10x/compiler-10x.',
        '  2. Install the Cloud flavor locally: https://doc.log10x.com/install/ ' +
          "(e.g. `brew install --cask log10x-cloud` on macOS, or the install script with `--flavor cloud`).",
        '',
        'Note: with a local cloud install, local-folder compilation and GitHub pull (REST API + token) work out of the box; docker_images pull additionally needs a container engine (podman or docker) on the host, and helm_charts pull needs the helm CLI (plus a container engine if pulling the charts’ referenced images). The docker compiler-10x image (option 1) bundles all of these — podman included, daemonless.',
      ].join('\n'),
    );
    this.name = 'NotCloudFlavorError';
    this.flavor = flavor;
  }
}

/**
 * Thrown when a `helm repo add` pre-step fails (bad name/url, unreachable repo,
 * or it ran past the shared deadline). The message is agent-facing; `detail`
 * has URL userinfo redacted so an embedded `user:pass@` can't leak.
 */
export class HelmRepoAddError extends Error {
  constructor(repoName: string, detail: string) {
    super(`helm repo add for '${repoName}' failed: ${detail.replace(/(\/\/)[^/@\s]+@/g, '$1***@')}`);
    this.name = 'HelmRepoAddError';
  }
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_IMAGE = 'log10x/compiler-10x:latest';
/** The bundled @apps/compiler config's default inputPaths location inside the image. */
const CONTAINER_SOURCES_PATH = '/etc/tenx/config/data/compile/sources';
/** Where we mount the host output folder inside the container. */
const CONTAINER_OUTPUT_PATH = '/work/symbols';
/** The baked github pull config our rendered overlay replaces (docker mode). */
const CONTAINER_GITHUB_PULL_CONFIG = '/etc/tenx/config/pipelines/compile/pull/github/config.yaml';
/** The github pull config's path relative to a TENX_INCLUDE_PATHS root (local mode). */
const GITHUB_PULL_CONFIG_REL = ['compile', 'pull', 'github', 'config.yaml'];
/** The baked docker pull config our rendered overlay replaces (docker mode). */
const CONTAINER_DOCKER_PULL_CONFIG = '/etc/tenx/config/pipelines/compile/pull/docker/config.yaml';
/** The docker pull config's path relative to a TENX_INCLUDE_PATHS root (local mode). */
const DOCKER_PULL_CONFIG_REL = ['compile', 'pull', 'docker', 'config.yaml'];
/** compiler-10x's podman, symlinked at the docker default path. */
const IN_IMAGE_DOCKER_COMMAND = '/usr/local/bin/docker';
/** The baked helm pull config our rendered overlay replaces (docker mode). */
const CONTAINER_HELM_PULL_CONFIG = '/etc/tenx/config/pipelines/compile/pull/helm/config.yaml';
/** The helm pull config's path relative to a TENX_INCLUDE_PATHS root (local mode). */
const HELM_PULL_CONFIG_REL = ['compile', 'pull', 'helm', 'config.yaml'];
/** Where we mount the shared helm home (repositories.yaml + index cache). */
const CONTAINER_HELM_HOME = '/helm-home';

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
  const image = process.env.LOG10X_COMPILER_IMAGE || process.env.LOG10X_TENX_IMAGE || DEFAULT_IMAGE;
  // One absolute deadline shared by the helm pre-steps AND the compile run, so
  // the caller's timeout is a true total wall-cap (not per-container).
  const deadline = Date.now() + cfg.timeoutMs;

  // Pull-config overlays are written to a host temp dir and bind-mounted
  // OVER the corresponding baked config file (wholesale replacement — the
  // engine reads one config.yaml per pull source).
  const githubInput = cfg.inputs.find((i): i is CompileGithubInput => i.kind === 'github');
  const dockerImageInput = cfg.inputs.find(
    (i): i is CompileDockerImageInput => i.kind === 'dockerImage',
  );
  const helmInput = cfg.inputs.find((i): i is CompileHelmInput => i.kind === 'helm');
  const configMounts: Array<{ hostPath: string; containerPath: string }> = [];
  let overlayDir: string | undefined;
  let helmHomeDir: string | undefined;
  try {
    if (githubInput || dockerImageInput || helmInput) {
      overlayDir = await mkdtemp(join(tmpdir(), 'log10x-mcp-compile-pull-'));
    }
    if (githubInput) {
      const hostPath = join(overlayDir!, 'github-config.yaml');
      await writeFile(hostPath, renderGithubPullOverlay(githubInput), 'utf8');
      configMounts.push({ hostPath, containerPath: CONTAINER_GITHUB_PULL_CONFIG });
    }
    if (dockerImageInput) {
      const hostPath = join(overlayDir!, 'docker-config.yaml');
      await writeFile(
        hostPath,
        renderDockerPullOverlay(dockerImageInput, { command: IN_IMAGE_DOCKER_COMMAND }),
        'utf8',
      );
      configMounts.push({ hostPath, containerPath: CONTAINER_DOCKER_PULL_CONFIG });
    }
    if (helmInput) {
      const hostPath = join(overlayDir!, 'helm-config.yaml');
      await writeFile(hostPath, renderHelmPullOverlay(helmInput), 'utf8');
      configMounts.push({ hostPath, containerPath: CONTAINER_HELM_PULL_CONFIG });
      // A bare `repo/chart` only resolves if its repo is known to helm, and
      // the engine never runs `helm repo add`. Populate a shared helm-home
      // (repositories.yaml + cached index) in pre-step containers, then mount
      // it into the compile so the engine's `helm template` resolves it.
      if (helmInput.repos && helmInput.repos.length > 0) {
        helmHomeDir = await prepHelmHome(image, helmInput.repos, linuxUserMapping(), deadline);
      }
    }

    // Named so a timeout can reap the container: `docker run` does NOT
    // forward SIGKILL to the container, so killing the client on timeout
    // would otherwise leave the compile running — holding CAP_SYS_ADMIN and
    // the output mount — to completion.
    const containerName = `log10x-compile-${randomUUID()}`;
    const args = buildDockerArgs(cfg, image, {
      linuxUser: linuxUserMapping(),
      configMounts,
      containerName,
      helmHomeHostDir: helmHomeDir,
    });

    // Secrets ride the docker client's own env via bare `-e VAR` pass-through
    // (buildDockerArgs) so the values never appear in argv.
    const credEnv: Record<string, string> = {};
    if (cfg.credentials?.githubToken) credEnv.GH_TOKEN = cfg.credentials.githubToken;
    if (cfg.credentials?.dockerUsername) credEnv.DOCKER_USERNAME = cfg.credentials.dockerUsername;
    if (cfg.credentials?.dockerToken) credEnv.DOCKER_TOKEN = cfg.credentials.dockerToken;
    if (cfg.license) credEnv.TENX_LICENSE_KEY = cfg.license;
    const env: NodeJS.ProcessEnv | undefined =
      Object.keys(credEnv).length > 0 ? { ...process.env, ...credEnv } : undefined;

    const t0 = Date.now();
    const r = await execCapture('docker', args, {
      env,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    const wallTimeMs = Date.now() - t0;

    // The killed client doesn't stop the container; reap it (best-effort).
    // `--rm` then removes it once stopped.
    if (r.timedOut) {
      await execCapture('docker', ['kill', containerName], { timeoutMs: 15_000 }).catch(() => {});
    }

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
  } finally {
    if (overlayDir) await rm(overlayDir, { recursive: true, force: true }).catch(() => {});
    if (helmHomeDir) await rm(helmHomeDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Populate a host helm-home (repositories.yaml + per-repo index cache) by
 * running `helm repo add` in one throwaway container per repo. Each invocation
 * passes the repo name/url as ARGV (no shell), so a hostile name/url can't
 * inject. The directory is mounted into the compile run so the engine's
 * `helm template <repo>/<chart>` resolves against it. Returns the host dir
 * (caller cleans it up); a failed/timed-out `repo add` throws HelmRepoAddError.
 *
 * `deadline` is the absolute end-time SHARED with the compile run, so N repo
 * adds + the compile together honour the caller's single timeout budget (each
 * step gets the remaining time). Each pre-step is named so a timed-out add can
 * be reaped — `docker run` doesn't forward the client SIGKILL to the container.
 */
async function prepHelmHome(
  image: string,
  repos: HelmRepo[],
  linuxUser: string | undefined,
  deadline: number,
): Promise<string> {
  const hostDir = await mkdtemp(join(tmpdir(), 'log10x-mcp-compile-helm-'));
  const helmEnv = [
    '-e',
    `HELM_REPOSITORY_CONFIG=${CONTAINER_HELM_HOME}/repositories.yaml`,
    '-e',
    `HELM_REPOSITORY_CACHE=${CONTAINER_HELM_HOME}/cache`,
  ];
  for (const repo of repos) {
    const containerName = `log10x-helmadd-${randomUUID()}`;
    const args = ['run', '--rm', '--name', containerName];
    if (linuxUser) args.push('--user', linuxUser);
    args.push(
      '-v',
      `${hostDir}:${CONTAINER_HELM_HOME}`,
      ...helmEnv,
      '--entrypoint',
      'helm',
      image,
      'repo',
      'add',
      repo.name,
      repo.url,
    );
    const r = await execCapture('docker', args, { timeoutMs: Math.max(1, deadline - Date.now()) });
    if (r.timedOut) {
      await execCapture('docker', ['kill', containerName], { timeoutMs: 15_000 }).catch(() => {});
      throw new HelmRepoAddError(repo.name, 'timed out (the chart repo may be unreachable)');
    }
    if (r.exitCode !== 0) {
      const tail = (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-1)[0] ?? `exit ${r.exitCode}`;
      throw new HelmRepoAddError(repo.name, tail);
    }
  }
  return hostDir;
}

/**
 * True when the compile pulls a container image and therefore needs the
 * daemonless in-image podman: a direct dockerImage input, or a Helm chart
 * configured to pull its referenced images. Pure / testable.
 */
export function needsContainerEngine(cfg: CompileConfig): boolean {
  return cfg.inputs.some(
    (i) => i.kind === 'dockerImage' || (i.kind === 'helm' && i.pullImages),
  );
}

/**
 * Build the `docker run` argv. A local input is realized by bind-mounting
 * it at the image's DEFAULT sources path, so the bundled `inputPaths:
 * path("data/compile/sources")` picks it up with no CLI/overlay override —
 * sidestepping the `OverwrittenOptionException` that a CLI `inputPaths`
 * would trigger (the scan unit is `allowMultiple: false`). Pull sources are
 * realized as `configMounts`: rendered pull configs bind-mounted (read-only)
 * over their baked counterparts. Outputs are driven entirely by env vars the
 * bundled scan/link configs already read via `TenXEnv.get`, pointed at a
 * single mounted `/work/symbols`.
 *
 * Credential env vars (GH_TOKEN / DOCKER_USERNAME / DOCKER_TOKEN) and the
 * license are passed as BARE `-e VAR` (docker's env pass-through) so the
 * secrets ride the spawned client's environment, not the argv — argv is
 * visible in process listings.
 *
 * `needsContainerEngine` inputs (dockerImage, or Helm-with-images) add
 * `--cap-add SYS_ADMIN` + `STORAGE_DRIVER=vfs`: the in-image podman pulls
 * daemonlessly (no host socket) but needs the user-namespace clone
 * capability, and vfs avoids a /dev/fuse device requirement. Only those
 * inputs pay the privilege. `opts.helmHomeHostDir` mounts a pre-populated
 * helm home so the engine's `helm template <repo>/<chart>` resolves.
 *
 * Pure (no I/O) so it is unit-testable.
 */
export function buildDockerArgs(
  cfg: CompileConfig,
  image: string,
  opts: {
    linuxUser?: string;
    configMounts?: Array<{ hostPath: string; containerPath: string }>;
    containerName?: string;
    helmHomeHostDir?: string;
  } = {},
): string[] {
  const args = ['run', '--rm'];
  if (opts.containerName) args.push('--name', opts.containerName);
  if (opts.linuxUser) args.push('--user', opts.linuxUser);
  // Daemonless podman needs the cap for any image pull — a direct dockerImage
  // input OR a Helm chart that pulls its referenced images.
  if (needsContainerEngine(cfg)) {
    args.push('--cap-add', 'SYS_ADMIN', '-e', 'STORAGE_DRIVER=vfs');
  }

  for (const input of cfg.inputs) {
    if (input.kind === 'local') {
      args.push('-v', `${input.path}:${CONTAINER_SOURCES_PATH}:ro`);
    }
  }
  for (const m of opts.configMounts ?? []) {
    args.push('-v', `${m.hostPath}:${m.containerPath}:ro`);
  }
  // Shared helm-home (pre-populated repos) + the env pointing helm at it.
  if (opts.helmHomeHostDir) {
    args.push(
      '-v',
      `${opts.helmHomeHostDir}:${CONTAINER_HELM_HOME}`,
      '-e',
      `HELM_REPOSITORY_CONFIG=${CONTAINER_HELM_HOME}/repositories.yaml`,
      '-e',
      `HELM_REPOSITORY_CACHE=${CONTAINER_HELM_HOME}/cache`,
    );
  }
  args.push('-v', `${cfg.output.folder}:${CONTAINER_OUTPUT_PATH}`);

  // Non-secret output env carries values; secrets (license + creds) use a
  // bare `-e VAR` pass-through so their values never land in argv.
  const env = compileEnvVars({
    outputFolder: CONTAINER_OUTPUT_PATH,
    libraryFile: `${CONTAINER_OUTPUT_PATH}/${cfg.output.runtimeName}.10x.tar`,
    runtimeName: cfg.output.runtimeName,
  });
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  if (cfg.license) args.push('-e', 'TENX_LICENSE_KEY');
  if (cfg.credentials?.githubToken) args.push('-e', 'GH_TOKEN');
  if (cfg.credentials?.dockerUsername) args.push('-e', 'DOCKER_USERNAME');
  if (cfg.credentials?.dockerToken) args.push('-e', 'DOCKER_TOKEN');

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

  // Local mode can't bind-mount, so config injection rides a temp overlay
  // dir placed FIRST on TENX_INCLUDE_PATHS (first-match-wins shadowing — the
  // same trick dev-cli uses for run/template): a shadow of
  // `compile/scanners/config.yaml` overrides inputPaths for local sources
  // (written only when local sources exist — a pull-only compile keeps the
  // bundled default), and a shadow of `compile/pull/github/config.yaml`
  // configures the GitHub pull. Outputs ride the same TENX_OUTPUT_SYMBOL_*
  // env hooks the bundled config reads.
  const overlayDir = await mkdtemp(join(tmpdir(), 'log10x-mcp-compile-cfg-'));
  try {
    const sourcePaths = cfg.inputs
      .filter((i): i is CompileLocalInput => i.kind === 'local')
      .map((i) => i.path);
    if (sourcePaths.length > 0) {
      await mkdir(join(overlayDir, 'compile', 'scanners'), { recursive: true });
      await writeFile(
        join(overlayDir, 'compile', 'scanners', 'config.yaml'),
        renderScannersOverlay(sourcePaths),
        'utf8',
      );
    }

    const githubInput = cfg.inputs.find((i): i is CompileGithubInput => i.kind === 'github');
    if (githubInput) {
      const githubDir = join(overlayDir, ...GITHUB_PULL_CONFIG_REL.slice(0, -1));
      await mkdir(githubDir, { recursive: true });
      await writeFile(
        join(overlayDir, ...GITHUB_PULL_CONFIG_REL),
        renderGithubPullOverlay(githubInput),
        'utf8',
      );
    }

    const dockerImageInput = cfg.inputs.find(
      (i): i is CompileDockerImageInput => i.kind === 'dockerImage',
    );
    if (dockerImageInput) {
      const dockerDir = join(overlayDir, ...DOCKER_PULL_CONFIG_REL.slice(0, -1));
      await mkdir(dockerDir, { recursive: true });
      // No `command` override locally — the engine's platform default docker
      // path applies; the host must have a docker/podman CLI with a working
      // engine behind it.
      await writeFile(
        join(overlayDir, ...DOCKER_PULL_CONFIG_REL),
        renderDockerPullOverlay(dockerImageInput, {}),
        'utf8',
      );
    }

    const helmInput = cfg.inputs.find((i): i is CompileHelmInput => i.kind === 'helm');
    if (helmInput) {
      const helmDir = join(overlayDir, ...HELM_PULL_CONFIG_REL.slice(0, -1));
      await mkdir(helmDir, { recursive: true });
      await writeFile(
        join(overlayDir, ...HELM_PULL_CONFIG_REL),
        renderHelmPullOverlay(helmInput),
        'utf8',
      );
      // Local mode uses the host's own helm config — `helm_repos` are NOT
      // auto-added here, so a bare `repo/chart` only resolves if the user has
      // already `helm repo add`-ed it (OCI / URL chart refs always resolve).
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TENX_INCLUDE_PATHS: buildLocalIncludePaths(resolveInstallPaths(), overlayDir),
      ...compileEnvVars({
        outputFolder: cfg.output.folder,
        libraryFile: cfg.output.libraryFile,
        runtimeName: cfg.output.runtimeName,
      }),
    };
    if (cfg.license) env.TENX_LICENSE_KEY = cfg.license;
    if (cfg.credentials?.githubToken) env.GH_TOKEN = cfg.credentials.githubToken;
    if (cfg.credentials?.dockerUsername) env.DOCKER_USERNAME = cfg.credentials.dockerUsername;
    if (cfg.credentials?.dockerToken) env.DOCKER_TOKEN = cfg.credentials.dockerToken;

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
 * Render the github pull config that replaces the baked
 * `compile/pull/github/config.yaml` wholesale. The token field stays an
 * `$=TenXEnv.get("GH_TOKEN")` env reference — the secret value travels as
 * process env, never onto disk. Repos/branch/folders are single-quoted so
 * they can't be parsed as `$=` expressions.
 *
 * Pure (no I/O) so it is unit-testable.
 */
export function renderGithubPullOverlay(input: CompileGithubInput): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const lines = [
    'tenx: compile',
    'githubPull:',
    '  - token: $=TenXEnv.get("GH_TOKEN")',
    '    repos:',
  ];
  for (const r of input.repos) lines.push(`      - ${q(r)}`);
  lines.push(`    branch: ${input.branch ? q(input.branch) : 'null'}`);
  if (input.folders && input.folders.length > 0) {
    lines.push('    folders:');
    for (const f of input.folders) lines.push(`      - ${q(f)}`);
  } else {
    lines.push('    folders: []');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Render the docker pull config that replaces the baked
 * `compile/pull/docker/config.yaml` wholesale. Credentials stay
 * `$=TenXEnv.get(...)` env references — blank means "pre-authenticated /
 * anonymous" and the engine skips `docker login` (public images pull with no
 * creds). `githubRepoToken` rides GH_TOKEN too: when present, the engine
 * also pulls + scans the source repo named by the image's
 * `org.opencontainers.image.source` annotation; when blank it skips that,
 * silently. `remove` stays false — in docker mode the pulled image lives in
 * the throwaway container's vfs store, and local-mode users keep their cache.
 *
 * `opts.command` pins the docker CLI path (docker mode pins the in-image
 * podman symlink); omitted, the engine's platform default applies.
 *
 * Pure (no I/O) so it is unit-testable.
 */
export function renderDockerPullOverlay(
  input: CompileDockerImageInput,
  opts: { command?: string } = {},
): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const lines = [
    'tenx: compile',
    'docker:',
    '  username: $=TenXEnv.get("DOCKER_USERNAME")',
    '  password: $=TenXEnv.get("DOCKER_TOKEN")',
  ];
  if (opts.command) lines.push(`  command: ${q(opts.command)}`);
  if (input.images.length === 0) {
    lines.push('  images: []');
  } else {
    lines.push('  images:');
    for (const img of input.images) lines.push(`    - ${q(img)}`);
  }
  lines.push('  remove: false', '  githubRepoToken: $=TenXEnv.get("GH_TOKEN")', '');
  return lines.join('\n');
}

/**
 * Render the helm pull config that replaces the baked
 * `compile/pull/helm/config.yaml` wholesale. The default `helmCommand`
 * (/usr/local/bin/helm) is already correct in compiler-10x, so the overlay
 * only carries chartNames + the pull toggles. `pull.dockerImages` and
 * `pull.github.repos` control whether the engine also pulls the images /
 * source repos a chart references; the GitHub token stays an env reference.
 *
 * Pure (no I/O) so it is unit-testable.
 */
export function renderHelmPullOverlay(input: CompileHelmInput): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const lines = ['tenx: compile', 'helm:'];
  if (input.charts.length === 0) {
    lines.push('  chartNames: []');
  } else {
    lines.push('  chartNames:');
    for (const c of input.charts) lines.push(`    - ${q(c)}`);
  }
  lines.push(
    '  pull:',
    `    dockerImages: ${input.pullImages ? 'true' : 'false'}`,
    '    github:',
    `      repos: ${input.pullRepos ? 'true' : 'false'}`,
    '      token: $=TenXEnv.get("GH_TOKEN")',
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
 * The non-secret TENX_* output env the bundled compiler config reads via
 * `TenXEnv.get`. Shared by both appliers (docker maps these to value-bearing
 * `-e` flags; local spreads them into the child env).
 * `TENX_LOG_APPENDER=tenxConsoleAppender` routes the engine's progress log to
 * stdout so the tool can capture and tail it. The license is NOT here — it is
 * a secret and rides a bare `-e` (docker) / direct env assignment (local) so
 * its value never lands in argv.
 *
 * Pure so it is unit-testable.
 */
export function compileEnvVars(p: {
  outputFolder: string;
  libraryFile: string;
  runtimeName: string;
}): Record<string, string> {
  return {
    TENX_OUTPUT_SYMBOL_FOLDER: p.outputFolder,
    TENX_OUTPUT_SYMBOL_LIBRARY_FILE: p.libraryFile,
    TENX_RUNTIME_NAME: p.runtimeName,
    TENX_LOG_APPENDER: 'tenxConsoleAppender',
  };
}

// ── Output scanning ────────────────────────────────────────────────────────

/**
 * Walk the output folder for the artifacts the compiler produced: `.10x.json`
 * symbol units and `.10x.tar` libraries (path + byte size). Tolerant of a
 * missing/empty dir (returns zeros), since a compile that produced nothing is
 * a valid `no_signal` outcome, not an error.
 *
 * Zero-byte units are counted separately (`emptyUnitCount`), NOT as units:
 * the scanners write an empty `.10x.json` when every symbol in a file was
 * filtered out (e.g. only method/package tokens, which the default
 * `symbol.types` drops) — counting those as success is the "green but empty"
 * trap.
 */
export async function scanSymbolOutputs(
  dir: string,
): Promise<{
  unitCount: number;
  emptyUnitCount: number;
  libraries: Array<{ path: string; bytes: number }>;
}> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return { unitCount: 0, emptyUnitCount: 0, libraries: [] };
  }
  let unitCount = 0;
  let emptyUnitCount = 0;
  const libraries: Array<{ path: string; bytes: number }> = [];
  for (const rel of entries) {
    if (rel.endsWith('.10x.json')) {
      try {
        const st = await stat(join(dir, rel));
        if (st.size > 0) unitCount++;
        else emptyUnitCount++;
      } catch {
        // race / vanished file — skip
      }
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
  return { unitCount, emptyUnitCount, libraries };
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
