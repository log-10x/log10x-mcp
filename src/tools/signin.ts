/**
 * log10x_signin: sign in to a Log10x account. Two modes:
 *
 *   - `mode: "browser"` (default): runs Auth0 Device Authorization
 *     Flow (RFC 8628). We POST to `auth.log10x.com/oauth/device/code`,
 *     show the user the verification URL (browser auto-launched), and
 *     poll `/oauth/token` until they complete sign-in. The user picks
 *     GitHub OR Google (or any other connection enabled on the
 *     `mcp_backend` Auth0 client) at Auth0's universal login page;
 *     the MCP doesn't care which IdP they use. Once Auth0 issues an
 *     access_token, we exchange it at
 *     `prometheus.log10x.com/api/v1/auth/token` for a long-lived
 *     Log10x API key.
 *
 *   - `mode: "api_key"`: the user already has an API key (e.g.
 *     copied from console.log10x.com -> Profile -> API Settings, or
 *     issued out-of-band by a workspace admin). We validate the key
 *     by calling `/api/v1/user`, then proceed identically to the
 *     browser branch from step 4 onward. No browser, no IdP.
 *
 * Either way, the resolved API key is written to
 * `~/.log10x/credentials` (mode 0600) and envs are hot-reloaded
 * in-process, so the next tool call runs against the new account
 * without an MCP-host restart.
 *
 * If `LOG10X_API_KEY` is set in process.env when signin completes,
 * we ALSO `delete` it. Otherwise the env var beats the freshly
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
import {
  requestDeviceCode,
  pollForAccessToken,
  LOG10X_AUTH0_DOMAIN,
} from '../lib/auth0-device-flow.js';
import { tryOpenBrowser } from '../lib/open-browser.js';
import { exchangeAuth0TokenForApiKey } from '../lib/auth-api.js';
import { fetchUserProfile } from '../lib/api.js';
import { log } from '../lib/log.js';

export const signinSchema = {
  /**
   * Which signin path to use. The model SHOULD ask the user up front
   * (see the tool description) and pass the chosen mode here.
   */
  mode: z
    .enum(['browser', 'api_key'])
    .optional()
    .describe(
      'Which signin path: "browser" (default, opens Auth0 Device Flow in the user\'s browser, lets them pick GitHub or Google or any other configured login) or "api_key" (user pastes a Log10x API key they already have). The MCP should ask the user which they prefer before calling this tool unless the user has already specified.'
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
   * browser. Only applies to mode="browser". Default 300 (5 minutes).
   * Cap at 900 (Auth0 device_code default expiry).
   */
  wait_seconds: z
    .number()
    .int()
    .min(30)
    .max(900)
    .optional()
    .describe('Max seconds to wait for browser authorization (mode="browser" only). Default 300.'),
};

export async function executeSignin(
  args: { mode?: 'browser' | 'api_key'; api_key?: string; wait_seconds?: number },
  envs: Environments
): Promise<string> {
  // The schema allows ambiguous combinations. Resolve before branching:
  //   - api_key arg present (with or without mode) → api_key flow
  //   - mode='api_key' but no api_key → ask the caller for one
  //   - mode='browser' or unset → browser flow
  const explicitMode = args.mode;
  if (explicitMode === 'api_key' && !args.api_key) {
    return (
      '## Sign-in needs an API key\n\n' +
      'You picked `mode: "api_key"` but did not pass `api_key`. Get the key from ' +
      '[console.log10x.com](https://console.log10x.com) → Profile → API Settings, ' +
      'then call `log10x_signin` again with `{ mode: "api_key", api_key: "<your-key>" }`.\n\n' +
      'Or call `log10x_signin` with `{ mode: "browser" }` for the Auth0 Device Flow ' +
      '(opens your browser; pick GitHub or Google).'
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
        'and retry, or run `log10x_signin` with `{ mode: "browser" }` to mint a fresh key via ' +
        'the Auth0 Device Flow.'
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
        '## Signed in. Env reload failed\n\n' +
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
    lines.push(`- **Path**: pasted API key (no browser flow)`);
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

  // ── Branch B: Auth0 Device Flow (default) ───────────────────────────────
  const waitSeconds = args.wait_seconds ?? 300;

  // 1. Request device + user code from Auth0.
  let device;
  try {
    device = await requestDeviceCode();
  } catch (e) {
    return `## Sign-in failed\n\nCould not start Auth0 Device Flow: ${(e as Error).message}`;
  }

  const opened = tryOpenBrowser(device.verification_uri_complete);
  const deviceFlowDescription =
    `Opened your browser at:\n  ${device.verification_uri_complete}\n` +
    (opened ? '' : '(Auto-launch failed. Copy the URL above into your browser.)\n') +
    `User code: \`${device.user_code}\` (already embedded in the URL)\n` +
    `Sign in with **GitHub** or **Google** on the page Auth0 shows you, then confirm the device authorization.\n` +
    `Waiting up to ${Math.min(waitSeconds, device.expires_in)}s...\n`;

  log.info('signin.device_flow.started', {
    user_code: device.user_code,
    verification_uri: device.verification_uri,
    interval: device.interval,
    expires_in: device.expires_in,
    browser_launched: opened,
    auth0_domain: LOG10X_AUTH0_DOMAIN,
  });

  // 2. Poll Auth0 for the access token.
  let token;
  try {
    token = await pollForAccessToken({
      deviceCode: device.device_code,
      interval: device.interval,
      expiresIn: Math.min(waitSeconds, device.expires_in),
    });
  } catch (e) {
    return `## Sign-in did not complete\n\n${deviceFlowDescription}\nError: ${(e as Error).message}`;
  }

  // 3. Exchange the Auth0 access token for a Log10x API key.
  let signinResult;
  try {
    signinResult = await exchangeAuth0TokenForApiKey(token.access_token);
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
      `## Signed in. Env reload failed\n\n` +
      `Your API key was saved to ${credentialsPath} successfully, but the in-process ` +
      `env list could not refresh: ${(e as Error).message}.\n\n` +
      `Restart your MCP host (Claude Desktop / Cursor) to pick up the new account.`
    );
  }

  const lines: string[] = [];
  lines.push('## Signed in to Log10x');
  lines.push('');
  lines.push(`- **Account**: ${signinResult.username || '(no email)'}`);
  lines.push(`- **API key**: saved to \`${credentialsPath}\` (this machine only)`);
  lines.push(`- **Path**: Auth0 Device Flow`);
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
        'still has it set. When the host restarts, the env var will come back and override ' +
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
  log.debug('signin.device_flow.complete');

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
