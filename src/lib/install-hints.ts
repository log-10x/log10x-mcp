/**
 * Centralized install guidance for the tenx CLI / docker image.
 *
 * Canonical URLs (verified):
 *   - Docs:    https://doc.log10x.com  (singular — "docs" plural does NOT resolve)
 *   - Install scripts: https://raw.githubusercontent.com/log-10x/pipeline-releases/main/
 *
 * Do NOT reintroduce install.log10x.com or docs.log10x.com — neither exists.
 */

export interface InstallHint {
  /** One-line shell command the user can paste to install. */
  command: string;
  /** Full URL to the platform-specific install docs page. */
  docsUrl: string;
}

export function installHintForPlatform(): InstallHint {
  if (process.platform === 'darwin') {
    return {
      command: 'brew install log-10x/tap/log10x',
      docsUrl: 'https://doc.log10x.com/install/macos/',
    };
  }
  if (process.platform === 'win32') {
    return {
      command: 'irm https://raw.githubusercontent.com/log-10x/pipeline-releases/main/install.ps1 | iex',
      docsUrl: 'https://doc.log10x.com/install/win/',
    };
  }
  if (process.platform === 'linux') {
    return {
      command: 'curl -fsSL https://raw.githubusercontent.com/log-10x/pipeline-releases/main/install.sh | sh',
      docsUrl: 'https://doc.log10x.com/install/linux/',
    };
  }
  return {
    command: 'see docs for install instructions',
    docsUrl: 'https://doc.log10x.com/install/',
  };
}

/**
 * Multi-line guidance for "tenx is unavailable" errors. Docker is listed
 * first because it's the lower-friction option for most users — no host
 * install, easier updates (`docker pull` vs reinstall), and the same
 * engine version that ships with the official image.
 */
export function tenxAvailabilityHint(): string {
  const local = installHintForPlatform();
  return [
    'Tenx is not available. Two ways to get it:',
    '',
    '  1. Docker (recommended — no host install, updates via `docker pull`):',
    '     Install Docker Desktop (https://www.docker.com/products/docker-desktop/)',
    '     and set LOG10X_TENX_MODE=docker.',
    '',
    `  2. Local install (${process.platform}):`,
    `     ${local.command}`,
    `     Docs: ${local.docsUrl}`,
  ].join('\n');
}
