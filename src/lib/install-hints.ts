/**
 * Centralized install guidance for the tenx CLI / docker image.
 *
 * Canonical URLs (verified):
 *   - Docs:    https://doc.log10x.com  (singular — "docs" plural does NOT resolve)
 *   - Install scripts: https://raw.githubusercontent.com/log-10x/pipeline-releases/main/
 *
 * Do NOT reintroduce install.log10x.com or docs.log10x.com — neither exists.
 *
 * FLAVORS. Three ship, across two independent axes, what the build can DO
 * (compile+run vs run only) and how it is BUILT (JVM vs native image):
 *
 *                 | JVM           | native
 *   compile + run | compiler      | none (compiling needs dynamic class loading)
 *   run only      | runtime-jvm   | runtime
 *
 *   compiler     the JVM build. The only one carrying the `generate` pipeline
 *                unit, so the only one that can compile and link a symbol
 *                library. Ships as .deb/.rpm/.msi/.dmg (and as the container
 *                image log10x/compiler-10x).
 *   runtime      the native binary (GraalVM). Reporter, Receiver, Retriever,
 *                MCP server, CLI. No compile. NOT BUILT FOR WINDOWS.
 *   runtime-jvm  the same runtime capabilities, packaged for the JVM
 *                (.deb/.rpm/.msi/.dmg). Not a new build, those artifacts ship
 *                in every release. It is the ONLY runtime available on Windows,
 *                and it still cannot compile: being a JVM build is not what
 *                makes a build a compiler.
 *
 * The flavor NAME and the FILE name deliberately differ, and the file names do
 * not change (published releases are immutable, and `--version` must keep
 * resolving old ones): `runtime` fetches `tenx-edge-<v>-<arch>-native`,
 * `runtime-jvm` fetches `tenx-edge-<v>.{deb,rpm,msi,dmg}`, `compiler` fetches
 * `tenx-cloud-<v>.{deb,rpm,msi,dmg}`. See FLAVORS.md in log-10x/pipeline-releases.
 */

/** The three flavors the engine and the installers know about. */
export type TenxFlavor = 'compiler' | 'runtime' | 'runtime-jvm';

/** One line per flavor, for any output that has to enumerate them. */
export const FLAVOR_SUMMARY: ReadonlyArray<string> = [
  '  compiler     JVM build. The only flavor with the `generate` pipeline unit, compile + link + run.',
  '  runtime      native binary (GraalVM). Reporter / Receiver / Retriever / MCP / CLI. No compile. Not built for Windows.',
  '  runtime-jvm  same runtime capabilities, JVM-packaged. No compile either. The only runtime available on Windows.',
];

export interface InstallHint {
  /** One-line shell command the user can paste to install. */
  command: string;
  /** Full URL to the platform-specific install docs page. */
  docsUrl: string;
  /** Which flavor the command above actually installs. */
  flavor: TenxFlavor;
}

/**
 * How to install a RUNTIME on this platform, the flavor every non-compile tool
 * in this server needs (Reporter/Receiver/Retriever/CLI work).
 *
 * Per platform, and why:
 *   - macOS   `runtime`. The Homebrew formula lays down the native binary
 *             (`tenx-edge-<v>-macos-<arch>-native`).
 *   - Linux   `runtime`. `install.sh` defaults to it; the flag is passed
 *             explicitly so the command keeps meaning the same thing if that
 *             default ever moves.
 *   - Windows `runtime-jvm`. NO native Windows runtime is built, the release
 *             carries no `tenx-*-windows-*-native` asset, so the JVM package
 *             is the runtime on Windows. Falling through to `install.ps1`
 *             with no flavor set installs the COMPILER: a whole JVM
 *             compiler toolchain handed to a user who asked for a runtime.
 */
export function installHintForPlatform(): InstallHint {
  if (process.platform === 'darwin') {
    return {
      command: 'brew install log-10x/tap/log10x',
      docsUrl: 'https://doc.log10x.com/install/macos/',
      flavor: 'runtime',
    };
  }
  if (process.platform === 'win32') {
    return {
      command:
        '$env:TENX_FLAVOR="runtime-jvm"; irm https://raw.githubusercontent.com/log-10x/pipeline-releases/main/install.ps1 | iex',
      docsUrl: 'https://doc.log10x.com/install/win/',
      flavor: 'runtime-jvm',
    };
  }
  if (process.platform === 'linux') {
    return {
      command:
        'curl -fsSL https://raw.githubusercontent.com/log-10x/pipeline-releases/main/install.sh | sh -s -- --flavor runtime',
      docsUrl: 'https://doc.log10x.com/install/linux/',
      flavor: 'runtime',
    };
  }
  return {
    command: 'see docs for install instructions',
    docsUrl: 'https://doc.log10x.com/install/',
    flavor: 'runtime',
  };
}

/**
 * How to install the COMPILER flavor on this platform, the one the Compiler
 * app (`log10x_compile` / `log10x_compile_link`) requires. Every platform has
 * one, Windows included.
 *
 * macOS is a cask, not the install script: the compiler's macOS artifact is a
 * `.dmg`, which `install.sh` refuses by name and hands to Homebrew rather than
 * half-installing. The cask token is `log10x-cloud`, the PACKAGE id, which is
 * frozen and does not follow the flavor rename.
 */
export function compilerInstallHintForPlatform(): InstallHint {
  if (process.platform === 'darwin') {
    return {
      command: 'brew install --cask log-10x/tap/log10x-cloud',
      docsUrl: 'https://doc.log10x.com/install/macos/',
      flavor: 'compiler',
    };
  }
  if (process.platform === 'win32') {
    return {
      command:
        '$env:TENX_FLAVOR="compiler"; irm https://raw.githubusercontent.com/log-10x/pipeline-releases/main/install.ps1 | iex',
      docsUrl: 'https://doc.log10x.com/install/win/',
      flavor: 'compiler',
    };
  }
  if (process.platform === 'linux') {
    return {
      command:
        'curl -fsSL https://raw.githubusercontent.com/log-10x/pipeline-releases/main/install.sh | sh -s -- --flavor compiler',
      docsUrl: 'https://doc.log10x.com/install/linux/',
      flavor: 'compiler',
    };
  }
  return {
    command: 'see docs for install instructions',
    docsUrl: 'https://doc.log10x.com/install/',
    flavor: 'compiler',
  };
}

/**
 * Multi-line guidance for "tenx is unavailable" errors. Docker is listed
 * first because it's the lower-friction option for most users — no host
 * install, easier updates (`docker pull` vs reinstall), and the same
 * engine version that ships with the official image.
 *
 * The local command installs a RUNTIME (see installHintForPlatform), which is
 * what every caller of this hint needs. Compile is called out separately so a
 * user who lands here for `log10x_compile` is not left installing the one
 * flavor that cannot serve them.
 */
export function tenxAvailabilityHint(): string {
  const local = installHintForPlatform();
  const compiler = compilerInstallHintForPlatform();
  return [
    'Tenx is not available. Two ways to get it:',
    '',
    '  1. Docker (recommended — no host install, updates via `docker pull`):',
    '     Install Docker Desktop (https://www.docker.com/products/docker-desktop/)',
    '     and set LOG10X_TENX_MODE=docker.',
    '',
    `  2. Local install (${process.platform}), installs the \`${local.flavor}\` flavor:`,
    `     ${local.command}`,
    `     Docs: ${local.docsUrl}`,
    '',
    'Three flavors ship. Only one of them compiles:',
    ...FLAVOR_SUMMARY,
    '',
    `For compile / link specifically, install the compiler flavor instead: ${compiler.command}`,
  ].join('\n');
}
