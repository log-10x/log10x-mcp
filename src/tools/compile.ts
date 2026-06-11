/**
 * log10x_compile — run the Log10x Compiler app to generate a symbol library.
 *
 * Scans source code / binaries with the CLOUD-flavor Compiler app
 * (`tenx @apps/compiler`) and writes a symbol library — per-file `.10x.json`
 * units plus a linked `.10x.tar` — that the 10x runtime later uses to assign
 * hidden classes (TenXTemplates) to events.
 *
 * Sources — all combine freely:
 *   - a local folder (`source_path`),
 *   - GitHub repositories pulled via the GitHub REST API (`github_repos`,
 *     token required — the engine refuses an empty token even for public
 *     repos),
 *   - docker/OCI images (`docker_images`), pulled DAEMONLESSLY by the podman
 *     bundled in compiler-10x — no host docker socket; the tool adds
 *     `--cap-add SYS_ADMIN` to the compile container automatically, and
 *     registry creds are optional (public images pull anonymously),
 *   - Helm charts (`helm_charts`) — a meta-source: the engine renders the
 *     chart and pulls the docker images + GitHub source repos it references.
 *     OCI/URL chart refs resolve standalone; bare `repo/chart` names need a
 *     matching `helm_repos` entry (added in a pre-step).
 * Artifactory / gomod pull are the remaining axes; the runner's CompileConfig
 * descriptor carries the seams.
 *
 * Backend: Docker-first. By default it runs the cloud image
 * log10x/compiler-10x (which is cloud-flavor by construction); if the caller
 * has a local CLOUD-flavor `tenx` it can use that instead. The Edge (native /
 * JIT) flavor cannot compile and is refused with a clear remediation.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { type StructuredOutput, type Action } from '../lib/output-types.js';
import {
  buildChassisEnvelope,
  buildChassisErrorEnvelope,
  type ChassisStatus,
} from '../lib/chassis-envelope.js';
import { buildNotConfiguredEnvelope } from '../lib/not-configured.js';
import {
  runCompile,
  NotCloudFlavorError,
  HelmRepoAddError,
  type CompileConfig,
  type CompileRunResult,
  type HelmRepo,
} from '../lib/compile-runner.js';
import { DevCliNotInstalledError, DockerNotAvailableError } from '../lib/dev-cli.js';

const TOOL = 'log10x_compile';

export const compileSchema = {
  source_path: z
    .string()
    .optional()
    .describe(
      'Absolute path to a local folder of source code / binaries to scan. The compiler recursively traverses it for supported languages (Java, Go, Python, JS/TS, Scala, C/C++, C#) and binaries. Note: .jar files are not scanned directly — provide extracted .class files. Optional when github_repos is given; at least one source (source_path and/or github_repos) is required.',
    ),
  github_repos: z
    .array(z.string())
    .optional()
    .describe(
      'GitHub repositories to pull (via the GitHub REST API) and scan, each as owner/repo (e.g. ["apache/commons-cli"]). REQUIRES a GitHub token — even for public repos: pass github_token, or have GH_TOKEN / GITHUB_TOKEN set in the MCP server environment. Combines freely with source_path.',
    ),
  github_branch: z
    .string()
    .optional()
    .describe(
      'Branch to pull for ALL github_repos. Omit to pull each repo’s default branch.',
    ),
  github_folders: z
    .array(z.string())
    .optional()
    .describe(
      'Folders within each GitHub repo to pull (e.g. ["src/main/java"]). Omit to pull entire repos. Narrowing this speeds up both the pull and the scan.',
    ),
  github_token: z
    .string()
    .optional()
    .describe(
      'GitHub access token for github_repos (a fine-grained token with read-only Contents access to the target repos suffices). Falls back to GH_TOKEN / GITHUB_TOKEN from the MCP server environment. Reaches the compiler as process environment only — never written to disk or argv. When docker_images are given too, this same token additionally lets the compiler pull + scan each image\'s source repo (the org.opencontainers.image.source annotation); without it that extra scan is skipped silently.',
    ),
  docker_images: z
    .array(z.string())
    .optional()
    .describe(
      'Docker/OCI images to pull and scan for symbols, as image refs — fully-qualified recommended (e.g. ["docker.io/grafana/grafana:11.1.0"]; a port-bearing host like "harbor.corp:8443/team/app:2.1" is fine, and a bare "alpine" resolves against the engine default registry). The pull is daemonless — podman inside the compiler-10x image, no host docker socket — and the tool automatically grants the compile container `--cap-add SYS_ADMIN` (needed by podman; only when this arg is used). Public images need no credentials. docker_username + docker_token `docker login` to the DEFAULT registry (Docker Hub), so they cover private Docker Hub repos; images on a different private registry must be pre-authenticated on the host/engine. In mode=local the host needs a docker/podman CLI with a working engine, and pulled images are left in its store (remove:false). Combines freely with source_path and github_repos.',
    ),
  docker_username: z
    .string()
    .optional()
    .describe(
      'Registry username for docker_images login — also used for private images a Helm chart references (helm_pull_images). Authenticates the default registry (Docker Hub). Falls back to DOCKER_USERNAME from the MCP server environment. Omit for public images. The engine logs in only when BOTH username and token are non-blank. Reaches the compiler as process environment only.',
    ),
  docker_token: z
    .string()
    .optional()
    .describe(
      'Registry token/password for docker_images (fed to `docker login --password-stdin` against the default registry, Docker Hub). Falls back to DOCKER_TOKEN from the MCP server environment. Omit for public images; pair with docker_username. Reaches the compiler as process environment only.',
    ),
  helm_charts: z
    .array(z.string())
    .optional()
    .describe(
      'Helm charts to render and scan, as chart refs. A meta-source: the compiler runs `helm template` / `helm show chart` to extract the docker images and GitHub source repos the chart references, then (by default) pulls those too. OCI refs (e.g. "oci://ghcr.io/nginxinc/charts/nginx-ingress") and full URLs resolve standalone; a bare "repo/chart" (e.g. "ingress-nginx/ingress-nginx") needs a matching helm_repos entry. Combines freely with the other sources. In mode=local the host needs the helm CLI and must have the repos already `helm repo add`-ed.',
    ),
  helm_repos: z
    .array(z.string())
    .optional()
    .describe(
      'Helm chart repositories to register before resolving helm_charts, each as "name=url" (e.g. ["ingress-nginx=https://kubernetes.github.io/ingress-nginx"]). Required for bare "repo/chart" names; unnecessary for OCI/URL refs. Added via `helm repo add` in pre-step containers (docker mode only — in mode=local the host helm config is used as-is). url must be an http(s):// chart-repo index URL; for an OCI registry, put the oci://… ref directly in helm_charts (`helm repo add` does not support oci://).',
    ),
  helm_pull_images: z
    .boolean()
    .default(true)
    .describe(
      'Whether to pull + scan the docker images a chart references (the richest symbol source for a chart). Default true. When true the tool grants the compile container `--cap-add SYS_ADMIN` (daemonless podman), same as docker_images. Set false to scan only the chart template/values text.',
    ),
  helm_pull_repos: z
    .boolean()
    .default(false)
    .describe(
      'Whether to pull + scan the GitHub source repos a chart references (via org.opencontainers.image.source annotations). Default false because it REQUIRES a GitHub token (engine refuses an empty token) — enabling it without github_token / GH_TOKEN returns not_configured.',
    ),
  output_path: z
    .string()
    .optional()
    .describe(
      'Absolute path where the symbol library is written (the .10x.json units and the linked .10x.tar). Defaults to a fresh temp directory, returned in the result as data.payload.output.folder.',
    ),
  library_name: z
    .string()
    .default('symbols')
    .describe(
      'Base name for the linked .10x.tar library file and the compile runtimeName. Sanitized to [A-Za-z0-9_.-].',
    ),
  mode: z
    .enum(['auto', 'docker', 'local'])
    .default('auto')
    .describe(
      'Execution backend. `auto` (default) prefers Docker (cloud image, guaranteed cloud flavor) and falls back to a local cloud-flavor tenx. `docker` forces the image (LOG10X_COMPILER_IMAGE or LOG10X_TENX_IMAGE, default log10x/compiler-10x:latest). `local` forces the binary (LOG10X_TENX_PATH or `tenx` on PATH) and refuses if it is not the cloud flavor. With a local install, local-folder compilation and GitHub pull (REST API + token) work out of the box; docker_images pull additionally needs a container engine (podman or docker) on the host. The docker `compiler-10x` image bundles all of those — podman included, daemonless — which is why Docker is the default.',
    ),
  timeout_ms: z
    .number()
    .int()
    .min(10_000)
    .max(3_600_000)
    .default(1_800_000)
    .describe(
      'Hard cap on compile wall time in milliseconds. Default 1,800,000 (30 min) — the first compile of a large codebase typically runs 10–30 min; subsequent runs are near-instant via checksum reuse.',
    ),
};

interface CompileArgs {
  source_path?: string;
  github_repos?: string[];
  github_branch?: string;
  github_folders?: string[];
  github_token?: string;
  docker_images?: string[];
  docker_username?: string;
  docker_token?: string;
  helm_charts?: string[];
  helm_repos?: string[];
  helm_pull_images: boolean;
  helm_pull_repos: boolean;
  output_path?: string;
  library_name: string;
  mode: 'auto' | 'docker' | 'local';
  timeout_ms: number;
}

const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HELM_REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Loose ref shape: host (optional :port) / repo path, optional :tag and/or
// @sha256 digest. The `(:\d+)?` after the first component is what lets a
// port-bearing registry host through (localhost:5000/app, harbor.corp:8443/x).
const DOCKER_IMAGE_RE =
  /^[a-z0-9][a-z0-9._-]*(:\d+)?(\/[a-z0-9._-]+)*(:[\w.-]+)?(@sha256:[a-f0-9]{64})?$/i;

/** Pure predicate over a docker/OCI image ref, exported for unit tests. */
export function isValidDockerImageRef(ref: string): boolean {
  return DOCKER_IMAGE_RE.test(ref);
}

/**
 * Parse helm_repos "name=url" strings into {name,url}, validating the name
 * shape and the url scheme. Returns an error string on the first bad entry.
 * Exported for unit tests.
 */
export function parseHelmRepos(entries: string[]): { repos: HelmRepo[] } | { error: string } {
  const repos: HelmRepo[] = [];
  for (const e of entries) {
    const eq = e.indexOf('=');
    if (eq <= 0) {
      return { error: `helm_repos entries must be "name=url"; got: ${JSON.stringify(e)}.` };
    }
    const name = e.slice(0, eq).trim();
    const url = e.slice(eq + 1).trim();
    if (!HELM_REPO_NAME_RE.test(name)) {
      return { error: `helm_repos name must be alphanumeric/._-; got: ${JSON.stringify(name)}.` };
    }
    // http(s) only: `helm repo add` does NOT support oci:// (OCI registries
    // aren't "added" — reference an OCI chart directly in helm_charts as
    // oci://...). Accepting oci here would fail the whole compile at repo-add.
    if (!/^https?:\/\/\S+$/i.test(url)) {
      return {
        error: `helm_repos url must be an http(s):// chart-repo index URL (no spaces); got: ${JSON.stringify(url)}. For an OCI registry, put the oci://… ref directly in helm_charts instead.`,
      };
    }
    repos.push({ name, url });
  }
  return { repos };
}

/**
 * Classify a helm chart ref: 'standalone' (oci:// or http(s):// — resolves
 * with no repo add), {bareRepo} (a `repo/chart` short name that needs its repo
 * in helm_repos), or 'invalid' (empty, contains whitespace, an unsupported
 * scheme, or a bare single name). Exported for tests.
 */
export function classifyHelmChartRef(
  ref: string,
): 'standalone' | { bareRepo: string } | 'invalid' {
  if (!ref || /\s/.test(ref)) return 'invalid';
  const scheme = ref.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    return s === 'oci' || s === 'http' || s === 'https' ? 'standalone' : 'invalid';
  }
  const slash = ref.indexOf('/');
  if (slash > 0 && slash < ref.length - 1) return { bareRepo: ref.slice(0, slash) };
  return 'invalid';
}

/** Human description of what the compile read, for headlines/summaries. */
function describeSources(args: CompileArgs): string {
  const parts: string[] = [];
  if (args.source_path) parts.push(args.source_path);
  if (args.github_repos?.length) {
    const qualifiers = [
      args.github_branch ? `branch ${args.github_branch}` : null,
      args.github_folders?.length ? `folders ${args.github_folders.join(', ')}` : null,
    ].filter(Boolean);
    parts.push(
      `GitHub ${args.github_repos.join(', ')}${qualifiers.length ? ` (${qualifiers.join('; ')})` : ''}`,
    );
  }
  if (args.docker_images?.length) {
    parts.push(`images ${args.docker_images.join(', ')}`);
  }
  if (args.helm_charts?.length) {
    parts.push(`Helm ${args.helm_charts.join(', ')}`);
  }
  return parts.join(' + ');
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned : 'symbols';
}

function defaultOutputDir(runtimeName: string): string {
  return join(tmpdir(), 'log10x-mcp-compile', `${runtimeName}-${Date.now()}-${process.pid}`, 'symbols');
}

/**
 * Last `n` non-empty lines of the combined engine log, for the result.
 *
 * `secrets` are scrubbed first: on a failed pipeline launch the engine dumps
 * its RESOLVED options to stderr — including credential values like
 * githubPullToken / dockerPassword — and without redaction those would ride
 * log_tail straight back into the agent conversation.
 */
function logTail(result: CompileRunResult, n: number, secrets: Array<string | undefined>): string[] {
  let merged = `${result.stdout}\n${result.stderr}`;
  for (const s of secrets) {
    if (s && s.length >= 4) merged = merged.split(s).join('***');
  }
  return merged
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-n);
}

function humanByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function executeCompile(args: CompileArgs): Promise<string | StructuredOutput> {
  // ── 1. Validate sources ──
  const hasGithub = (args.github_repos?.length ?? 0) > 0;
  const hasDockerImages = (args.docker_images?.length ?? 0) > 0;
  const hasHelm = (args.helm_charts?.length ?? 0) > 0;
  if (!args.source_path && !hasGithub && !hasDockerImages && !hasHelm) {
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: 'input_invalid',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'No source given. Pass source_path (a local folder), github_repos (owner/repo list), docker_images (image refs), helm_charts (chart refs), or any combination.',
      },
    });
  }

  if (args.source_path) {
    let srcStat;
    try {
      srcStat = await fs.stat(args.source_path);
    } catch {
      return buildChassisErrorEnvelope({
        tool: TOOL,
        err: {
          error_type: 'input_invalid',
          retryable: false,
          suggested_backoff_ms: null,
          hint: `source_path does not exist: ${args.source_path}. Pass an absolute path to a folder of source code / binaries.`,
        },
      });
    }
    if (!srcStat.isDirectory()) {
      return buildChassisErrorEnvelope({
        tool: TOOL,
        err: {
          error_type: 'input_invalid',
          retryable: false,
          suggested_backoff_ms: null,
          hint: `source_path must be a directory, not a file: ${args.source_path}.`,
        },
      });
    }
  }

  if (hasDockerImages) {
    const malformed = args.docker_images!.filter((r) => !isValidDockerImageRef(r));
    if (malformed.length > 0) {
      return buildChassisErrorEnvelope({
        tool: TOOL,
        err: {
          error_type: 'input_invalid',
          retryable: false,
          suggested_backoff_ms: null,
          hint: `docker_images entries must be image refs like docker.io/grafana/grafana:11.1.0 (fully-qualified recommended); got: ${malformed.join(', ')}.`,
        },
      });
    }
  }

  // Parse + validate helm sources up front (helm_repos shape, chart-repo URLs).
  let helmRepos: HelmRepo[] = [];
  if (hasHelm && args.helm_repos?.length) {
    const parsed = parseHelmRepos(args.helm_repos);
    if ('error' in parsed) {
      return buildChassisErrorEnvelope({
        tool: TOOL,
        err: {
          error_type: 'input_invalid',
          retryable: false,
          suggested_backoff_ms: null,
          hint: parsed.error,
        },
      });
    }
    helmRepos = parsed.repos;
  }
  if (hasHelm) {
    const repoNames = new Set(helmRepos.map((r) => r.name));
    for (const c of args.helm_charts!) {
      const cls = classifyHelmChartRef(c);
      if (cls === 'invalid') {
        return buildChassisErrorEnvelope({
          tool: TOOL,
          err: {
            error_type: 'input_invalid',
            retryable: false,
            suggested_backoff_ms: null,
            hint: `helm_charts entries must be an oci://… ref, an http(s):// chart URL, or "repo/chart"; got: ${JSON.stringify(c)}.`,
          },
        });
      }
      // A bare repo/chart resolves in docker mode only if we pre-add its repo.
      // (Local mode uses the host's helm config, which may already have it.)
      if (typeof cls === 'object' && args.mode !== 'local' && !repoNames.has(cls.bareRepo)) {
        return buildChassisErrorEnvelope({
          tool: TOOL,
          err: {
            error_type: 'input_invalid',
            retryable: false,
            suggested_backoff_ms: null,
            hint: `helm chart ${JSON.stringify(c)} is a bare "repo/chart" but no helm_repos entry defines "${cls.bareRepo}". Add helm_repos: ["${cls.bareRepo}=https://<repo-index-url>"], or pass an oci://… / https://… chart ref that resolves standalone.`,
          },
        });
      }
    }
  }
  const helmNeedsToken = hasHelm && args.helm_pull_repos;

  if (hasGithub) {
    const malformed = args.github_repos!.filter((r) => !GITHUB_REPO_RE.test(r));
    if (malformed.length > 0) {
      return buildChassisErrorEnvelope({
        tool: TOOL,
        err: {
          error_type: 'input_invalid',
          retryable: false,
          suggested_backoff_ms: null,
          hint: `github_repos entries must be owner/repo (e.g. apache/commons-cli); got: ${malformed.join(', ')}.`,
        },
      });
    }
  }

  // Resolve a GitHub token only for sources that can actually use it:
  // github_repos, docker_images' source-repo scan, and helm only when it pulls
  // referenced repos or images (both consult org.opencontainers.image.source).
  // A chart-text-only or pure-local compile resolves none, so an ambient
  // GH_TOKEN is never injected into a container that can't use it.
  const githubToken: string | undefined =
    hasGithub ||
    hasDockerImages ||
    (hasHelm && (args.helm_pull_repos || args.helm_pull_images))
      ? args.github_token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
      : undefined;
  // The engine hard-refuses an empty GitHub token ("empty GitHub API token"),
  // even for public repos — so it is REQUIRED for github_repos and for helm
  // pulling referenced source repos. Gate up front instead of burning a
  // container start on a guaranteed failure.
  if ((hasGithub || helmNeedsToken) && !githubToken) {
    return buildNotConfiguredEnvelope({
      tool: TOOL,
      kind: 'generic',
      remediation: [
        hasGithub
          ? 'GitHub pull needs an access token — the compiler requires one even for public repos.'
          : 'Pulling the GitHub source repos a Helm chart references (helm_pull_repos) needs a GitHub access token — the compiler refuses an empty one. Either provide a token, or set helm_pull_repos=false to scan only the chart and its docker images.',
        'Ask the user for a GitHub token (a fine-grained token with read-only Contents access suffices; https://github.com/settings/tokens) and either:',
        '  1. pass it as the `github_token` argument of this tool, or',
        '  2. set GH_TOKEN (or GITHUB_TOKEN) in the MCP server environment and retry.',
        'The token is forwarded to the compiler as process environment only — never written to disk or argv.',
      ].join('\n'),
    });
  }

  // ── 2. Build the compile config ──
  const runtimeName = sanitizeName(args.library_name);
  const outputFolder = resolve(args.output_path ?? defaultOutputDir(runtimeName));
  const inputs: CompileConfig['inputs'] = [];
  if (args.source_path) inputs.push({ kind: 'local', path: resolve(args.source_path) });
  if (hasGithub) {
    inputs.push({
      kind: 'github',
      repos: args.github_repos!,
      branch: args.github_branch,
      folders: args.github_folders,
    });
  }
  if (hasDockerImages) {
    inputs.push({ kind: 'dockerImage', images: args.docker_images! });
  }
  if (hasHelm) {
    inputs.push({
      kind: 'helm',
      charts: args.helm_charts!,
      repos: helmRepos.length > 0 ? helmRepos : undefined,
      pullImages: args.helm_pull_images,
      pullRepos: args.helm_pull_repos,
    });
  }
  // Registry creds are used by a direct docker_images pull AND by a Helm chart
  // pulling its referenced (possibly private) images, which goes through the
  // same docker pull module.
  const needsDockerCreds = hasDockerImages || (hasHelm && args.helm_pull_images);
  const dockerUsername = needsDockerCreds
    ? args.docker_username || process.env.DOCKER_USERNAME
    : undefined;
  const dockerToken = needsDockerCreds
    ? args.docker_token || process.env.DOCKER_TOKEN
    : undefined;
  const credentials =
    githubToken || dockerUsername || dockerToken
      ? { githubToken, dockerUsername, dockerToken }
      : undefined;
  const cfg: CompileConfig = {
    inputs,
    output: {
      folder: outputFolder,
      libraryFile: join(outputFolder, `${runtimeName}.10x.tar`),
      runtimeName,
    },
    license: process.env.TENX_LICENSE_KEY || process.env.LOG10X_LICENSE_KEY || undefined,
    credentials,
    timeoutMs: args.timeout_ms,
  };

  // ── 3. Run, mapping precondition failures to branchable envelopes ──
  let result: CompileRunResult;
  try {
    result = await runCompile(cfg, { modeOverride: args.mode });
  } catch (e) {
    if (
      e instanceof DevCliNotInstalledError ||
      e instanceof DockerNotAvailableError ||
      e instanceof NotCloudFlavorError
    ) {
      return buildNotConfiguredEnvelope({ tool: TOOL, kind: 'generic', remediation: e.message });
    }
    if (e instanceof HelmRepoAddError) {
      return buildChassisErrorEnvelope({
        tool: TOOL,
        err: {
          error_type: 'input_invalid',
          retryable: false,
          suggested_backoff_ms: null,
          hint: `${e.message}. Check the helm_repos url (an http(s):// chart-repo index) and that the repo is reachable.`,
        },
      });
    }
    throw e;
  }

  // ── 4. Shape the result ──
  const { exitCode, timedOut, output } = result;
  // Zero-byte units and empty tars don't count: a unit whose every symbol was
  // filtered out, linked into a hollow library, is the "green but empty" trap.
  const producedSymbols = output.unitCount > 0 || output.libraries.some((l) => l.bytes > 0);
  const ok = exitCode === 0;
  const sources = describeSources(args);

  const library = output.libraries[0];
  const libraryDesc = library ? `${library.path} (${humanByteSize(library.bytes)})` : 'none';
  const payload = {
    mode: result.mode,
    image: result.image ?? null,
    flavor: result.flavor ?? null,
    flavor_verified: result.flavorVerified,
    exit_code: exitCode,
    timed_out: timedOut,
    wall_time_ms: result.wallTimeMs,
    source_path: args.source_path ? resolve(args.source_path) : null,
    github: hasGithub
      ? {
          repos: args.github_repos!,
          branch: args.github_branch ?? null,
          folders: args.github_folders ?? [],
        }
      : null,
    docker_images: hasDockerImages ? args.docker_images! : null,
    helm: hasHelm
      ? {
          charts: args.helm_charts!,
          repos: args.helm_repos ?? [],
          pull_images: args.helm_pull_images,
          pull_repos: args.helm_pull_repos,
        }
      : null,
    output: {
      folder: output.folder,
      unit_count: output.unitCount,
      empty_unit_count: output.emptyUnitCount,
      library_files: output.libraries,
    },
    // Scrub actual secrets only — NOT dockerUsername, which is non-sensitive
    // and (being a short, possibly-common string) would over-redact the log.
    log_tail: logTail(result, 40, [githubToken, dockerToken, cfg.license]),
  };

  if (!ok && !producedSymbols) {
    // Hard failure — engine exited non-zero and wrote nothing.
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: timedOut ? 'backend_timeout' : 'local_processing_failed',
        retryable: timedOut,
        suggested_backoff_ms: null,
        hint: timedOut
          ? `Compile timed out after ${args.timeout_ms}ms. Raise timeout_ms or scope source_path to a smaller tree.`
          : `Compiler (${result.mode}) exited ${exitCode} with no symbols produced. See data.payload.log_tail.`,
      },
      contextPayload: payload,
    });
  }

  const emptyNote =
    output.emptyUnitCount > 0
      ? ` ${output.emptyUnitCount} unit${output.emptyUnitCount === 1 ? ' was' : 's were'} emitted empty — every symbol filtered out (the default symbol.types keeps class/enum/log/exec only).`
      : '';

  const status: ChassisStatus = ok ? (producedSymbols ? 'success' : 'no_signal') : 'partial';
  const headline = ok
    ? producedSymbols
      ? `Compiled ${output.unitCount} symbol unit${output.unitCount === 1 ? '' : 's'} → ${libraryDesc}.`
      : `Compiler ran cleanly but produced no symbols from ${sources} — check the sources contain supported file types.${emptyNote}`
    : `Compiler exited ${exitCode} with partial output (${output.unitCount} unit${output.unitCount === 1 ? '' : 's'}). See data.payload.log_tail.`;

  const human_summary = ok
    ? producedSymbols
      ? `Compiled ${output.unitCount} symbol unit${output.unitCount === 1 ? '' : 's'} from ${sources} into ${output.folder} via ${result.mode} in ${result.wallTimeMs}ms${library ? `, linked to ${library.path}` : ''}.`
      : `The compiler ran to completion via ${result.mode} but found no symbols in ${sources}. Confirm the sources hold supported source/binary files (extracted .class, not .jar).${emptyNote}`
    : `The compiler exited ${exitCode} via ${result.mode} but still wrote ${output.unitCount} unit${output.unitCount === 1 ? '' : 's'} to ${output.folder}. Treat as partial; inspect data.payload.log_tail before using the library.`;

  // Next step: smoke-test the freshly compiled library against sample events
  // by pointing the validate tool's symbolPaths at the output folder.
  const actions: Action[] =
    ok && producedSymbols
      ? [
          {
            tool: 'log10x_validate',
            args: { extra_args: [['symbolPaths', output.folder]] },
            reason: 'smoke-test the compiled symbol library against a few sample event lines (supply input_lines)',
          },
        ]
      : [];

  return buildChassisEnvelope({
    tool: TOOL,
    view: 'summary',
    headline,
    status,
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {},
    scope: {
      window: [
        args.source_path ? 'local' : null,
        hasGithub ? 'github' : null,
        hasDockerImages ? 'images' : null,
        hasHelm ? 'helm' : null,
      ]
        .filter(Boolean)
        .join('+') + '_compile',
      window_basis: 'explicit',
      candidates_count: output.unitCount,
      candidates_usable: output.libraries.length,
    },
    payload,
    human_summary,
    actions,
  });
}
