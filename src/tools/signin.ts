/**
 * log10x_signin — sign in to a Log10x account. Two modes:
 *
 *   - `mode: "github"` (default) — runs the GitHub Device Flow. We
 *     probe `gh auth token` first; if no CLI token, we open the
 *     browser at github.com/login/device with the user_code
 *     pre-filled, poll until the user clicks Authorize, then
 *     exchange the GitHub token at
 *     `prometheus.log10x.com/api/v1/auth/github` for a long-lived
 *     Log10x API key (auto-creates the account on first signup).
 *
 *   - `mode: "api_key"` — the user already has an API key (e.g.
 *     copied from console.log10x.com → Profile → API Settings, or
 *     issued out-of-band by a workspace admin). We validate the key
 *     by calling `/api/v1/user`, then proceed identically to the
 *     GitHub branch from step 4 onward. No browser, no GitHub.
 *
 * Either way, the resolved API key is written to
 * `~/.log10x/credentials` (mode 0600) and envs are hot-reloaded
 * in-process, so the next tool call runs against the new account
 * without an MCP-host restart.
 *
 * If `LOG10X_API_KEY` is set in process.env when signin completes,
 * we ALSO `delete` it — otherwise the env var beats the freshly
 * written credentials file (priority 1 vs priority 2 in the
 * resolution chain) and the new account would be silently
 * overridden. The result message tells the user to also remove the
 * env var from their MCP host config to make the change persist
 * across host restarts.
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
import { fetchUserProfile } from '../lib/api.js';
import { log } from '../lib/log.js';

export const signinSchema = {
  /**
   * Which signin path to use. The model SHOULD ask the user up front
   * — see the tool description — and pass the chosen mode here.
   */
  mode: z
    .enum(['github', 'api_key'])
    .optional()
    .describe(
      'Which signin path: "github" (default — opens browser, runs Device Flow) or "api_key" (user pastes a Log10x API key they already have). The MCP should ask the user which they prefer before calling this tool unless the user has already specified.'
    ),
  /**
   * Required when `mode: "api_key"`. The Log10x API key minted from
   * console.log10x.com → Profile → API Settings. Validated against
   * `/api/v1/user` before being written to `~/.log10x/credentials`.
   */
  api_key: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Log10x API key to sign in with. Required when mode="api_key". Validated against /api/v1/user before saving.'
    ),
  /**
   * Maximum number of seconds to wait for the user to authorize in the
   * browser. Only applies to mode="github". Default 300 (5 minutes).
   * Cap at 900 (GitHub's device_code expiry).
   */
  wait_seconds: z
    .number()
    .int()
    .min(30)
    .max(900)
    .optional()
    .describe('Max seconds to wait for browser authorization (mode="github" only). Default 300.'),
};

export async function executeSignin(
  args: { mode?: 'github' | 'api_key'; api_key?: string; wait_seconds?: number },
  envs: Environments
): Promise<string> {
  // The schema allows ambiguous combinations. Resolve before branching:
  //   - api_key arg present (with or without mode) → api_key flow
  //   - mode='api_key' but no api_key → ask the caller for one
  //   - mode='github' or unset → github flow
  const explicitMode = args.mode;
  if (explicitMode === 'api_key' && !args.api_key) {
    return (
      '## Sign-in needs an API key\n\n' +
      'You picked `mode: "api_key"` but did not pass `api_key`. Get the key from ' +
      '[console.log10x.com](https://console.log10x.com) → Profile → API Settings, ' +
      'then call `log10x_signin` again with `{ mode: "api_key", api_key: "<your-key>" }`.\n\n' +
      'Or call `log10x_signin` with `{ mode: "github" }` for the GitHub Device Flow ' +
      '(opens your browser).'
    );
  }
  const useApiKey = !!args.api_key;

  // ── Branch A: user pasted a Log10x API key ──────────────────────────────
  if (useApiKey) {
    const apiKey = args.api_key!;
    // Validate. /api/v1/user is user-scoped (the key alone authenticates),
    // and a successful response also gives us the env list to render.
    let profile;
    try {
      profile = await fetchUserProfile(apiKey);
    } catch (e) {
      return (
        '## Sign-in failed\n\n' +
        `The API key you provided was rejected by \`/api/v1/user\`: ${(e as Error).message}\n\n` +
        'Verify the key at [console.log10x.com](https://console.log10x.com) → Profile → API Settings ' +
        'and retry, or run `log10x_signin` with `{ mode: "github" }` to mint a fresh key via ' +
        'GitHub Device Flow.'
      );
    }

    let credentialsPath: string;
    try {
      credentialsPath = await writeCredentials({ apiKey });
    } catch (e) {
      return (
        '## Key validated but writing credentials failed\n\n' +
        `Path: ${getCredentialsPath()}\nError: ${(e as Error).message}\n\n` +
        'As a workaround, set `LOG10X_API_KEY` in your MCP host config and restart.'
      );
    }

    const envVarCleared = clearOverridingEnvVar();
    try {
      await reloadEnvironmentsInPlace(envs);
    } catch (e) {
      return (
        '## Signed in — but env reload failed\n\n' +
        `The key was saved to \`${credentialsPath}\` successfully, but the in-process ` +
        `env list could not refresh: ${(e as Error).message}.\n\n` +
        'Restart your MCP host to pick up the new account.'
      );
    }

    const lines: string[] = [];
    lines.push('## Signed in to Log10x');
    lines.push('');
    lines.push(`Validated via \`/api/v1/user\` and signed in as **${profile.username || '(no email)'}**.`);
    lines.push('');
    lines.push(`- **API key**: saved to \`${credentialsPath}\` (this machine only)`);
    lines.push(`- **Path**: pasted API key (no GitHub flow)`);
    if (envVarCleared) {
      lines.push(`- **Note**: cleared the old \`LOG10X_API_KEY\` from this session so the new key takes effect immediately.`);
    }
    lines.push('');
    lines.push(`### Environments now available (${envs.all.length})`);
    for (const e of envs.all) {
      const star = e.isDefault ? ' ★ default' : '';
      const perm = e.permissions ? ` · \`${e.permissions}\`` : '';
      lines.push(`- **${e.nickname}**${perm}${star}`);
    }
    lines.push('');
    if (envVarCleared) {
      lines.push(
        '**To make this stick across restarts**: open your Claude Desktop config ' +
          '(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, ' +
          '`%APPDATA%\\Claude\\claude_desktop_config.json` on Windows, or the equivalent ' +
          'for Cursor / other MCP hosts) and delete the OLD `LOG10X_API_KEY` line from the ' +
          '`log10x` server\'s `env` block. Otherwise the host re-injects the old key on ' +
          'next launch and overrides the credentials I just saved.'
      );
      lines.push('');
    }
    lines.push(
      'Run `log10x_signout` to revoke. Visit https://console.log10x.com to upgrade tier or manage envs.'
    );
    return lines.join('\n');
  }

  // ── Branch B: GitHub Device Flow (default) ──────────────────────────────
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

  // 5. Clear any overriding env var, then hot-reload envs so the next
  //    tool call sees the new account.
  const envVarCleared = clearOverridingEnvVar();
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
  if (envVarCleared) {
    lines.push(`- **Note**: removed in-process \`LOG10X_API_KEY\` env override so the new key takes effect immediately.`);
  }
  lines.push('');
  lines.push(`### Environments now available (${envs.all.length})`);
  for (const e of envs.all) {
    const star = e.isDefault ? ' ★ default' : '';
    const perm = e.permissions ? ` · \`${e.permissions}\`` : '';
    lines.push(`- **${e.nickname}**${perm}${star}`);
  }
  lines.push('');
  if (envVarCleared) {
    lines.push(
      '**Persistence note**: I cleared `LOG10X_API_KEY` from this MCP server\'s in-process ' +
        'environment, but your MCP host config (e.g. `claude_desktop_config.json`) probably ' +
        'still has it set — when the host restarts, the env var will come back and override ' +
        '`~/.log10x/credentials`. To make this permanent, remove `LOG10X_API_KEY` from the ' +
        'host config\'s `env` block.'
    );
    lines.push('');
  }
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

/**
 * Delete `LOG10X_API_KEY` from `process.env` if set. Returns whether
 * a deletion occurred so the caller can mention it in the result.
 *
 * Why: the credential resolution chain checks `LOG10X_API_KEY` first
 * (priority 1) and `~/.log10x/credentials` second (priority 2). After
 * a successful signin, if the env var is still set, the next
 * `loadEnvironments()` would resolve to the OLD env-var key, not the
 * freshly written file. The user's new credentials would be silently
 * shadowed. Clearing the env var in-process is the smallest fix that
 * lets `reloadEnvironmentsInPlace()` honor the new file.
 *
 * Caveat: the deletion only lives for the current MCP server process.
 * Whatever the host config says is what gets injected on next host
 * restart. The result message tells the user to also edit the host
 * config to make the change permanent.
 */
function clearOverridingEnvVar(): boolean {
  if (process.env.LOG10X_API_KEY) {
    delete process.env.LOG10X_API_KEY;
    return true;
  }
  return false;
}
