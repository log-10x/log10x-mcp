/**
 * log10x_signin — one-click GitHub-based signup/signin from inside the
 * MCP. Replaces the manual "go to console.log10x.com → Profile → API
 * Settings → paste key into host config → restart" workflow that
 * `log10x_login_status` describes today.
 *
 * Flow (user-visible):
 *   1. We probe `gh auth token`. If the GitHub CLI is installed and
 *      logged in with the scopes we need, we use that token directly
 *      (zero clicks, no browser pop-up).
 *   2. Otherwise we start GitHub Device Flow:
 *        - request a device + user code
 *        - auto-open the user's browser at
 *          `https://github.com/login/device?user_code=ABCD-1234`
 *          with the code pre-filled — they just click "Authorize"
 *        - poll until GitHub returns the access token
 *   3. POST the GitHub token to `prometheus.log10x.com/api/v1/auth/github`.
 *      The BE verifies it against api.github.com, looks up or
 *      auto-creates a Log10x account keyed by GitHub user id, and
 *      returns a long-lived API key.
 *   4. Write the API key to `~/.log10x/credentials` (mode 0600).
 *   5. Hot-reload envs in-process so the very next tool call runs
 *      against the new account — no MCP-host restart needed.
 *
 * Single user-facing message even though we kick off three round
 * trips, because the LLM caller doesn't get to render anything while
 * we're polling.
 */

import { z } from 'zod';
import type { Environments } from '../lib/environments.js';
import { reloadEnvironmentsInPlace } from '../lib/environments.js';
import { writeCredentials, getCredentialsPath } from '../lib/credentials.js';
import { tryGhCliToken } from '../lib/gh-cli.js';
import {
  requestDeviceCode,
  pollForAccessToken,
  buildVerificationUrlWithCode,
  REQUESTED_SCOPES,
  LOG10X_GITHUB_CLIENT_ID,
} from '../lib/github-device-flow.js';
import { tryOpenBrowser } from '../lib/open-browser.js';
import { exchangeGithubTokenForApiKey } from '../lib/auth-api.js';
import { log } from '../lib/log.js';

export const signinSchema = {
  /**
   * Maximum number of seconds to wait for the user to authorize in the
   * browser. Default 300 (5 minutes). Cap at 900 (GitHub's
   * device_code expiry).
   */
  wait_seconds: z
    .number()
    .int()
    .min(30)
    .max(900)
    .optional()
    .describe('Max seconds to wait for browser authorization. Default 300.'),
};

export async function executeSignin(
  args: { wait_seconds?: number },
  envs: Environments
): Promise<string> {
  const requiredScopes = REQUESTED_SCOPES.split(/\s+/).filter(Boolean);
  const waitSeconds = args.wait_seconds ?? 300;

  // 1. Zero-click path: gh CLI.
  let githubToken: string | null = null;
  let usedGhCli = false;
  try {
    githubToken = await tryGhCliToken(requiredScopes);
    if (githubToken) {
      usedGhCli = true;
      log.info('signin.gh_cli.ok', { scopes: requiredScopes });
    }
  } catch (e) {
    log.warn('signin.gh_cli.err', { msg: (e as Error).message });
  }

  // 2. Device-flow fallback.
  let deviceFlowDescription = '';
  if (!githubToken) {
    let device;
    try {
      device = await requestDeviceCode();
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('device_flow_disabled')) {
        return (
          '## Sign-in failed\n\n' +
          'GitHub returned `device_flow_disabled`. The Log10x OAuth App needs ' +
          '**Enable Device Flow** ticked at https://github.com/settings/developers ' +
          '— this is a one-time configuration that only the app owner can fix. ' +
          'If you\'re running a fork, set `LOG10X_GITHUB_CLIENT_ID` to your own ' +
          'OAuth App\'s client id.'
        );
      }
      return `## Sign-in failed\n\nCould not start GitHub Device Flow: ${msg}`;
    }

    const verificationUrl = buildVerificationUrlWithCode(
      device.verification_uri,
      device.user_code
    );
    const opened = tryOpenBrowser(verificationUrl);
    deviceFlowDescription =
      `Opened your browser at:\n  ${verificationUrl}\n` +
      (opened ? '' : '(Auto-launch failed — copy the URL above into your browser.)\n') +
      `User code: \`${device.user_code}\` (pre-filled in the URL)\n` +
      `Waiting up to ${Math.min(waitSeconds, device.expires_in)}s for you to click ` +
      `**Authorize log10x-mcp**…\n`;

    log.info('signin.device_flow.started', {
      user_code: device.user_code,
      verification_uri: device.verification_uri,
      interval: device.interval,
      expires_in: device.expires_in,
      browser_launched: opened,
    });

    let token;
    try {
      token = await pollForAccessToken({
        deviceCode: device.device_code,
        interval: device.interval,
        expiresIn: Math.min(waitSeconds, device.expires_in),
        clientId: LOG10X_GITHUB_CLIENT_ID,
      });
    } catch (e) {
      return `## Sign-in did not complete\n\n${deviceFlowDescription}\nError: ${(e as Error).message}`;
    }
    githubToken = token.access_token;
  }

  // 3. Exchange the GitHub token for a Log10x API key.
  let signinResult;
  try {
    signinResult = await exchangeGithubTokenForApiKey(githubToken);
  } catch (e) {
    return (
      `## Sign-in failed at the Log10x backend\n\n${(e as Error).message}\n\n` +
      `If this persists, check https://status.log10x.com or run \`log10x_doctor\`.`
    );
  }

  // 4. Persist credentials.
  let credentialsPath: string;
  try {
    credentialsPath = await writeCredentials({
      apiKey: signinResult.api_key,
      githubLogin: signinResult.github_login,
    });
  } catch (e) {
    return (
      `## Sign-in succeeded at the BE but writing credentials failed\n\n` +
      `Path: ${getCredentialsPath()}\n` +
      `Error: ${(e as Error).message}\n\n` +
      `As a workaround, set \`LOG10X_API_KEY=${signinResult.api_key}\` in your ` +
      `MCP host config and restart.`
    );
  }

  // 5. Hot-reload envs so the next tool call sees the new account.
  try {
    await reloadEnvironmentsInPlace(envs);
  } catch (e) {
    return (
      `## Signed in — but env reload failed\n\n` +
      `Your API key was saved to ${credentialsPath} successfully, but the in-process ` +
      `env list could not refresh: ${(e as Error).message}.\n\n` +
      `Restart your MCP host (Claude Desktop / Cursor) to pick up the new account.`
    );
  }

  const lines: string[] = [];
  lines.push(
    signinResult.is_new_account
      ? '## Welcome to Log10x'
      : '## Signed in to Log10x'
  );
  lines.push('');
  if (signinResult.is_new_account) {
    lines.push(`We just created your account.`);
  } else {
    lines.push(`We found your existing account and signed you in.`);
  }
  lines.push('');
  lines.push(`- **Account**: ${signinResult.username || '(no email)'}`);
  if (signinResult.github_login) {
    lines.push(`- **GitHub**: \`${signinResult.github_login}\``);
  }
  lines.push(`- **API key**: saved to \`${credentialsPath}\` (this machine only)`);
  lines.push(`- **Path**: ${usedGhCli ? 'gh CLI (zero-click)' : 'GitHub Device Flow'}`);
  lines.push('');
  lines.push(`### Environments now available (${envs.all.length})`);
  for (const e of envs.all) {
    const star = e.isDefault ? ' ★ default' : '';
    const perm = e.permissions ? ` · \`${e.permissions}\`` : '';
    lines.push(`- **${e.nickname}**${perm}${star}`);
  }
  lines.push('');
  lines.push(
    `You\'re signed in across every MCP host on this machine that reads ` +
      `\`~/.log10x/credentials\`. Run \`log10x_signout\` to revoke. ` +
      `Visit https://console.log10x.com to upgrade tier or manage envs from a UI.`
  );
  if (deviceFlowDescription) {
    // Keep the device-flow trace at the bottom for debuggability — useful
    // when the user runs sign-in twice and wants to see what changed.
    log.debug('signin.device_flow.complete');
  }

  return lines.join('\n');
}
