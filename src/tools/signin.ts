/**
 * log10x_signin_start + log10x_signin_complete: two-tool sign-in chain.
 *
 * Why split into two tools? Auth0 Device Authorization Flow is
 * inherently asynchronous: we hand the user a code, they confirm it
 * in their browser, then we poll Auth0 for the access token. There is
 * no in-band channel inside a single tool call to surface the
 * verification code BEFORE we block on polling. We tried mid-tool
 * `notifications/message` push, but Cursor (and most other hosts
 * today) does not render that channel during a tool execution, so the
 * user never sees the code and the tool just hangs until expiry.
 *
 * Splitting the flow into two tools sidesteps the host limitation: the
 * `_start` tool returns the code immediately as plain markdown, the
 * model relays it to the user, and the `_complete` tool resumes the
 * flow by polling for the access token using the device_code returned
 * by `_start`. Works in every MCP host, no notification API required.
 *
 * The two tools share `log10x_signin_complete`:
 *   - With `device_code`: finishes the browser flow started by `_start`.
 *   - With `api_key`: pasted-key path (no browser, no IdP). The user
 *     already has a key from console.log10x.com and just needs the
 *     MCP to validate + persist it.
 *
 * On success either path writes the API key to `~/.log10x/credentials`
 * (mode 0600), hot-reloads envs in-place, and clears
 * `LOG10X_API_KEY` from `process.env` if set so the freshly written
 * file wins the priority chain.
 */

import { z } from 'zod';
import type { Environments } from '../lib/environments.js';
import { reloadEnvironmentsInPlace, clearOverridingEnvVar } from '../lib/environments.js';
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

/**
 * Default polling deadline for `_complete`. Auth0's device_code expiry
 * is 900s (15 min). 600s is a comfortable middle ground that gives
 * users plenty of time to switch tabs and confirm without burning the
 * whole expiry on one stuck call.
 */
const DEFAULT_WAIT_SECONDS_COMPLETE = 600;

/** Floor: less than 30s is not enough for a human to switch tabs and approve. */
const MIN_WAIT_SECONDS = 30;

/** Cap: matches Auth0's device_code expiry. Asking for more is meaningless. */
const MAX_WAIT_SECONDS = 900;

// ── log10x_signin_start ──────────────────────────────────────────────

export const signinStartSchema = {
  /**
   * No `wait_seconds` here. `_start` does NOT block on polling: it
   * requests a device code, opens the browser, and returns the code
   * to the model. The model then calls `_complete` with the
   * device_code, where polling actually happens.
   */
};

export interface SigninStartResult {
  markdown: string;
}

export async function executeSigninStart(): Promise<string> {
  let device;
  try {
    device = await requestDeviceCode();
  } catch (e) {
    return `## Sign-in failed to start\n\nCould not request a device code from Auth0: ${(e as Error).message}`;
  }

  const opened = tryOpenBrowser(device.verification_uri_complete);

  log.info('signin.device_flow.started', {
    user_code: device.user_code,
    verification_uri: device.verification_uri,
    interval: device.interval,
    expires_in: device.expires_in,
    browser_launched: opened,
    auth0_domain: LOG10X_AUTH0_DOMAIN,
  });

  const lines: string[] = [];
  lines.push('## Sign in to Log10x: confirm the code in your browser');
  lines.push('');
  lines.push(`**User code**: \`${device.user_code}\``);
  lines.push('');
  lines.push(`**Verification URL**: ${device.verification_uri_complete}`);
  if (!opened) {
    lines.push('');
    lines.push('_(Auto-launch failed. Copy the URL above into your browser.)_');
  }
  lines.push('');
  lines.push(
    'Open the URL, verify the code on the Auth0 page matches the user code above, ' +
      'pick **GitHub** or **Google** (or any other configured login), and click **Confirm**. ' +
      `You have ${Math.min(device.expires_in, MAX_WAIT_SECONDS)} seconds before the code expires.`
  );
  lines.push('');
  lines.push(
    `Once the user confirms in the browser, call \`log10x_signin_complete\` with ` +
      `\`{ device_code: "${device.device_code}" }\`. ` +
      `The user does NOT need to ask for that step. The model should call ` +
      `\`log10x_signin_complete\` automatically as the next action.`
  );

  return lines.join('\n');
}

// ── log10x_signin_complete ──────────────────────────────────────────

export const signinCompleteSchema = {
  /**
   * The opaque device_code returned by `log10x_signin_start`. Passed
   * back unchanged. Mutually exclusive with `api_key`: pass exactly one.
   */
  device_code: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The opaque device_code returned by `log10x_signin_start`. Pass it back unchanged. The tool polls Auth0 for the access token, then exchanges it for a long-lived Log10x API key. Mutually exclusive with `api_key`.'
    ),
  /**
   * A Log10x API key the user already has (pasted from
   * console.log10x.com). When passed, no browser flow runs; we
   * validate the key and persist it. Mutually exclusive with
   * `device_code`.
   */
  api_key: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Log10x API key to sign in with directly (no browser). Validated against /api/v1/user before saving. Use this when the user already has a key from console.log10x.com → Profile → API Settings, or when issued out-of-band by a workspace admin. Mutually exclusive with `device_code`.'
    ),
  /**
   * Maximum number of seconds to poll Auth0 for the access token.
   * Only applies when `device_code` is passed; ignored on the api_key
   * path. Default 600 (10 minutes). Floor 30, cap 900 (Auth0 expiry).
   */
  wait_seconds: z
    .number()
    .int()
    .min(MIN_WAIT_SECONDS)
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe(
      `Max seconds to poll for browser confirmation (only used when device_code is passed). Default ${DEFAULT_WAIT_SECONDS_COMPLETE}.`
    ),
};

export async function executeSigninComplete(
  args: { device_code?: string; api_key?: string; wait_seconds?: number },
  envs: Environments
): Promise<string> {
  if (args.device_code && args.api_key) {
    return (
      '## Sign-in could not complete\n\n' +
      'Pass exactly one of `device_code` (to finish a browser sign-in started by ' +
      '`log10x_signin_start`) or `api_key` (to validate a key the user already has). ' +
      'Both were provided, which is ambiguous.'
    );
  }
  if (!args.device_code && !args.api_key) {
    return (
      '## Sign-in could not complete\n\n' +
      'Pass either `device_code` (returned by `log10x_signin_start`) to finish a ' +
      'browser flow, or `api_key` to validate a key the user already has from ' +
      'console.log10x.com → Profile → API Settings.'
    );
  }

  if (args.api_key) {
    return await completeWithApiKey(args.api_key, envs);
  }
  return await completeWithDeviceCode(args.device_code!, args.wait_seconds, envs);
}

async function completeWithApiKey(apiKey: string, envs: Environments): Promise<string> {
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
      'and retry, or run `log10x_signin_start` to mint a fresh key via the Auth0 Device Flow.'
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

async function completeWithDeviceCode(
  deviceCode: string,
  waitSecondsArg: number | undefined,
  envs: Environments
): Promise<string> {
  const waitSeconds = waitSecondsArg ?? DEFAULT_WAIT_SECONDS_COMPLETE;

  // 1. Poll Auth0 for the access token. Auth0's interval is 5s by
  //    default; we don't have a fresh device-code response here so we
  //    pick a sane default. The poll loop honors the slow_down signal
  //    too if Auth0 returns it.
  let token;
  try {
    token = await pollForAccessToken({
      deviceCode,
      interval: 5,
      expiresIn: waitSeconds,
    });
  } catch (e) {
    return (
      `## Sign-in did not complete\n\n` +
      `Polling Auth0 for the access token failed: ${(e as Error).message}\n\n` +
      `Run \`log10x_signin_start\` again to get a fresh code.`
    );
  }

  // 2. Exchange the Auth0 access token for a Log10x API key.
  let signinResult;
  try {
    signinResult = await exchangeAuth0TokenForApiKey(token.access_token);
  } catch (e) {
    return (
      `## Sign-in failed at the Log10x backend\n\n${(e as Error).message}\n\n` +
      `If this persists, check https://status.log10x.com or run \`log10x_doctor\`.`
    );
  }

  // 3. Persist credentials.
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

  // 4. Clear any overriding env var, then hot-reload envs so the next
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

