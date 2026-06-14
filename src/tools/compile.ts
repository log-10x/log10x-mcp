/**
 * Compiler source validation + config build — the shared front half of the
 * Compiler tools. `prepareCompile` validates every source and credential and
 * builds the CompileConfig; `log10x_compile` then spawns it asynchronously
 * (see compile-run.ts) and `log10x_compile_status` polls it. The pure
 * validators here (docker-ref / helm-ref / artifactory shape, the stable output
 * key) are also exercised directly by the unit tests.
 *
 * The compile itself scans source code / binaries with the CLOUD-flavor
 * Compiler app (`tenx @apps/compiler`) and writes a symbol library — per-file
 * `.10x.json` units plus a linked `.10x.tar` — that the 10x runtime later uses
 * to assign hidden classes (TenXTemplates) to events.
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
 *   - Artifactory artifacts (`artifactory_instance` + `artifactory_repo`),
 *     pulled via the Artifactory REST API — token required, no host privilege.
 * gomod pull is the one engine axis deliberately NOT exposed: it recurses the
 * full transitive dependency graph and floods the library with third-party
 * symbols.
 *
 * Backend: Docker-first. By default it runs the cloud image
 * log10x/compiler-10x (which is cloud-flavor by construction); if the caller
 * has a local CLOUD-flavor `tenx` it can use that instead. The Edge (native /
 * JIT) flavor cannot compile and is refused with a clear remediation.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { type StructuredOutput } from '../lib/output-types.js';
import { buildChassisErrorEnvelope } from '../lib/chassis-envelope.js';
import { buildNotConfiguredEnvelope } from '../lib/not-configured.js';
import { type CompileConfig, type HelmRepo } from '../lib/compile-runner.js';

// prepareCompile's validation envelopes are returned through log10x_compile —
// attribute them to that tool.
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
  artifactory_instance: z
    .string()
    .optional()
    .describe(
      'Base URL of an Artifactory instance to pull artifacts (Java archives, .NET assemblies, etc.) from and scan, e.g. "https://demo.jfrog.io/artifactory". Requires artifactory_repo and a token (artifactory_token or ARTIFACTORY_TOKEN). Pull is via the Artifactory REST API — no extra host privilege. Combines freely with the other sources.',
    ),
  artifactory_repo: z
    .string()
    .optional()
    .describe(
      'Artifactory repository key to pull from, e.g. "libs-release-local". Required when artifactory_instance is given. Scope the pull with artifactory_files and/or artifactory_folders.',
    ),
  artifactory_files: z
    .array(z.string())
    .optional()
    .describe(
      'Specific files within artifactory_repo to pull, each a repo-relative path (e.g. ["dist/app-1.0.0.tar.gz"]). Combine with artifactory_folders; at least one of the two is required when pulling from Artifactory.',
    ),
  artifactory_folders: z
    .array(z.string())
    .optional()
    .describe(
      'Folder paths within artifactory_repo to pull (e.g. ["com/acme/app"]). Traversed recursively unless artifactory_recursive is false. At least one of artifactory_files / artifactory_folders is required when pulling from Artifactory.',
    ),
  artifactory_recursive: z
    .boolean()
    .default(true)
    .describe(
      'Whether artifactory_folders are pulled recursively (sub-folders too). Default true. Ignored when only artifactory_files are given.',
    ),
  artifactory_token: z
    .string()
    .optional()
    .describe(
      'Artifactory API access token for artifactory_instance. Falls back to ARTIFACTORY_TOKEN from the MCP server environment. Required when pulling from Artifactory. Reaches the compiler as process environment only — never written to disk or argv.',
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

export interface CompileArgs {
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
  artifactory_instance?: string;
  artifactory_repo?: string;
  artifactory_files?: string[];
  artifactory_folders?: string[];
  artifactory_recursive: boolean;
  artifactory_token?: string;
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
export function describeSources(args: CompileArgs): string {
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
  if (args.artifactory_instance && args.artifactory_repo) {
    parts.push(`Artifactory ${args.artifactory_instance}/${args.artifactory_repo}`);
  }
  return parts.join(' + ');
}

export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned : 'symbols';
}

/**
 * Stable per-source cache key. Re-running the SAME compile must land in the
 * SAME output folder — that is what lets the engine's checksum-based unit
 * reuse fire (the old `${name}-${Date.now()}-${pid}` temp dir was unique every
 * run, so reuse never triggered and every compile was a cold scan, defeating
 * the "subsequent runs are near-instant" contract). Hashes only the inputs
 * that determine the symbols: the sources and the runtime name. Credentials,
 * timeout, and mode are excluded — they don't change the produced library.
 *
 * Pure (no I/O) so it is unit-testable.
 */
export function stableOutputKey(args: CompileArgs, runtimeName: string): string {
  const canonical = JSON.stringify({
    runtimeName,
    source_path: args.source_path ? resolve(args.source_path) : null,
    github_repos: args.github_repos ?? null,
    github_branch: args.github_branch ?? null,
    github_folders: args.github_folders ?? null,
    docker_images: args.docker_images ?? null,
    helm_charts: args.helm_charts ?? null,
    helm_repos: args.helm_repos ?? null,
    helm_pull_images: args.helm_pull_images,
    helm_pull_repos: args.helm_pull_repos,
    artifactory_instance: args.artifactory_instance ?? null,
    artifactory_repo: args.artifactory_repo ?? null,
    artifactory_files: args.artifactory_files ?? null,
    artifactory_folders: args.artifactory_folders ?? null,
    artifactory_recursive: args.artifactory_recursive,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function defaultOutputDir(runtimeName: string, key: string): string {
  return join(tmpdir(), 'log10x-mcp-compile', `${runtimeName}-${key}`, 'symbols');
}


/**
 * Validate every source + credential and build the CompileConfig the runner
 * consumes. Returns the built config on success, or a ready-to-return error /
 * not_configured envelope when validation fails — discriminate with
 * `'inputs' in result`. Single-sources all the gating so log10x_compile (which
 * spawns the config asynchronously) shares exactly the same checks.
 */
export async function prepareCompile(args: CompileArgs): Promise<CompileConfig | StructuredOutput> {
  // ── 1. Validate sources ──
  const hasGithub = (args.github_repos?.length ?? 0) > 0;
  const hasDockerImages = (args.docker_images?.length ?? 0) > 0;
  const hasHelm = (args.helm_charts?.length ?? 0) > 0;
  const hasArtifactory = !!(args.artifactory_instance || args.artifactory_repo);
  if (!args.source_path && !hasGithub && !hasDockerImages && !hasHelm && !hasArtifactory) {
    return buildChassisErrorEnvelope({
      tool: TOOL,
      err: {
        error_type: 'input_invalid',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'No source given. Pass source_path (a local folder), github_repos (owner/repo list), docker_images (image refs), helm_charts (chart refs), artifactory_instance + artifactory_repo, or any combination.',
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

  if (hasArtifactory) {
    if (!args.artifactory_instance || !args.artifactory_repo) {
      return buildChassisErrorEnvelope({
        tool: TOOL,
        err: {
          error_type: 'input_invalid',
          retryable: false,
          suggested_backoff_ms: null,
          hint: 'Artifactory pull needs both artifactory_instance (the base URL, e.g. https://demo.jfrog.io/artifactory) and artifactory_repo (the repository key, e.g. libs-release-local).',
        },
      });
    }
    if (!/^https?:\/\/\S+$/i.test(args.artifactory_instance)) {
      return buildChassisErrorEnvelope({
        tool: TOOL,
        err: {
          error_type: 'input_invalid',
          retryable: false,
          suggested_backoff_ms: null,
          hint: `artifactory_instance must be an http(s):// URL (no spaces); got: ${JSON.stringify(args.artifactory_instance)}.`,
        },
      });
    }
    if ((args.artifactory_files?.length ?? 0) === 0 && (args.artifactory_folders?.length ?? 0) === 0) {
      return buildChassisErrorEnvelope({
        tool: TOOL,
        err: {
          error_type: 'input_invalid',
          retryable: false,
          suggested_backoff_ms: null,
          hint: 'Artifactory pull needs at least one of artifactory_files (repo-relative file paths) or artifactory_folders (folder paths) to scope what to pull.',
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

  // Artifactory pull requires an API token; resolve from arg or env and gate
  // up front (the engine cannot pull without it).
  const artifactoryToken: string | undefined = hasArtifactory
    ? args.artifactory_token || process.env.ARTIFACTORY_TOKEN
    : undefined;
  if (hasArtifactory && !artifactoryToken) {
    return buildNotConfiguredEnvelope({
      tool: TOOL,
      kind: 'generic',
      remediation: [
        'Artifactory pull needs an API access token.',
        'Ask the user for an Artifactory token (a scoped access token with read access to the target repo suffices) and either:',
        '  1. pass it as the `artifactory_token` argument of this tool, or',
        '  2. set ARTIFACTORY_TOKEN in the MCP server environment and retry.',
        'The token is forwarded to the compiler as process environment only — never written to disk or argv.',
      ].join('\n'),
    });
  }

  // ── 2. Build the compile config ──
  const runtimeName = sanitizeName(args.library_name);
  const outputFolder = resolve(
    args.output_path ?? defaultOutputDir(runtimeName, stableOutputKey(args, runtimeName)),
  );
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
  if (hasArtifactory) {
    inputs.push({
      kind: 'artifactory',
      instance: args.artifactory_instance!,
      repo: args.artifactory_repo!,
      files: args.artifactory_files,
      folders: args.artifactory_folders,
      recursive: args.artifactory_recursive,
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
    githubToken || dockerUsername || dockerToken || artifactoryToken
      ? { githubToken, dockerUsername, dockerToken, artifactoryToken }
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

  return cfg;
}
