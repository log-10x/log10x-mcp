/**
 * log10x_rotate_api_key — destructive: replace the user's Log10x API
 * key with a freshly-minted one via `POST /api/v1/user/rotate-key`.
 *
 * Backend handler: backend/lambdas/user-service-go/cmd/user/main.go
 * (handleRotateKey). Documented at mksite/docs/api/manage.md
 * "Rotate API Key".
 *
 * What this tool does on success (in order):
 *   1. POST to the BE → get back `{ user, api_key: <new-uuid> }`. The
 *      previous key is invalidated immediately on the server side.
 *   2. Write the new key to `~/.log10x/credentials` (overwriting any
 *      existing entry) so other MCP hosts on the same machine pick it
 *      up next time they read.
 *   3. Update `process.env.LOG10X_API_KEY` in this process so the
 *      file path takes precedence on the next reload (mirrors the
 *      symmetric env-var-clear pattern signin/signout already do).
 *   4. Reload envs in-place so the next tool call uses the new key
 *      seamlessly — no MCP-host restart needed for THIS server.
 *
 * What it does NOT do:
 *   - Revoke the old key on other machines / hosts. Other devices
 *     holding the old key will start receiving 401 on the next
 *     request. They need to be updated manually (or rotate again
 *     from there).
 *   - Edit the user's MCP host config files (claude_desktop_config.json
 *     etc.). The new key is in `process.env.LOG10X_API_KEY` for this
 *     session, but on next host restart, whatever the host config
 *     specifies will be re-injected. The result message tells the
 *     user to also update their host config to make the rotation
 *     stick across restarts.
 *
 * Confirm pattern: the caller must pass the literal string
 * `rotate-now` to proceed. Prevents an LLM from accidentally rotating
 * via a chained tool call without explicit user assent.
 *
 * Demo accounts: the backend returns 403 Forbidden, surfaced cleanly.
 */

import { z } from 'zod';
import type { Environments } from '../lib/environments.js';
import { reloadEnvironmentsInPlace } from '../lib/environments.js';
import { writeCredentials, getCredentialsPath } from '../lib/credentials.js';
import { rotateApiKey } from '../lib/api.js';

export const rotateApiKeySchema = {
  confirm: z
    .literal('rotate-now')
    .describe(
      'Pass the literal string `rotate-now` to confirm rotation. This is a typo-prevention guard. Rotation invalidates the previous key immediately on every machine and tool that uses it — only proceed when the user has explicitly asked for rotation, not as a chained side effect of another flow. **Always ask the user to confirm before calling this tool.**'
    ),
};

export async function executeRotateApiKey(
  args: { confirm: 'rotate-now' },
  envs: Environments
): Promise<string> {
  if (args.confirm !== 'rotate-now') {
    // Belt-and-suspenders — Zod already enforces the literal, but this
    // makes the failure mode explicit if someone bypasses the schema.
    return (
      '## Refused — confirm string did not match\n\n' +
      'Pass `confirm: "rotate-now"` to proceed. Rotation invalidates the previous ' +
      'key everywhere immediately; the confirm guard prevents accidental triggers.'
    );
  }

  if (envs.isDemoMode) {
    return (
      '## Cannot rotate — running in demo mode\n\n' +
      'You\'re currently authenticated against the public Log10x demo account, which ' +
      'cannot rotate API keys (the backend returns 403 for demo users). Sign in to ' +
      'your own account first: call `log10x_signin_start` for the Auth0 Device Flow with ' +
      'GitHub or Google (the model chains to `log10x_signin_complete` automatically once you ' +
      'confirm in the browser), or call `log10x_signin_complete` directly with ' +
      '`{ api_key: "<key>" }` to paste a key from console.log10x.com → Profile → API ' +
      'Settings. Then retry rotation. See `log10x_login_status` for the full sign-in breakdown.'
    );
  }

  const apiKey = envs.default.apiKey;

  let result;
  try {
    result = await rotateApiKey(apiKey);
  } catch (e) {
    const msg = (e as Error).message;
    if (/HTTP 403/.test(msg)) {
      return (
        '## Cannot rotate — backend returned 403 Forbidden\n\n' +
        `${msg}\n\n` +
        'This is the response demo accounts get. If you\'re NOT signed in as a demo ' +
        'user and still see this, run `log10x_doctor` to diagnose.'
      );
    }
    return `## Rotation failed\n\n${msg}`;
  }

  // Persist the new key to ~/.log10x/credentials so other MCP hosts
  // on the same machine pick it up; this MCP server uses it for this
  // session via the env-var update below.
  let credentialsPath: string;
  try {
    credentialsPath = await writeCredentials({
      apiKey: result.apiKey,
    });
  } catch (e) {
    // BE rotated but local persistence failed — surface honestly so
    // the user can capture the key from chat before it scrolls away.
    return (
      '## Key rotated at the backend, but local save failed\n\n' +
      `Path: ${getCredentialsPath()}\n` +
      `Error: ${(e as Error).message}\n\n` +
      `**Save this new key manually** — the previous one is already invalidated:\n\n` +
      `\`${result.apiKey}\`\n\n` +
      'Update your MCP host config (`LOG10X_API_KEY`) and any scripts / CI secrets ' +
      'using the old value, then restart the host.'
    );
  }

  // Drop the in-process LOG10X_API_KEY override so the next
  // loadEnvironments() reads from the freshly-written credentials
  // file. Without this, the OLD value in process.env would still win
  // priority 1 and we'd start hitting 401s on every subsequent tool
  // call until the host restarts. Same logic as signin / signout.
  const envVarWasSet = !!process.env.LOG10X_API_KEY;
  if (envVarWasSet) {
    delete process.env.LOG10X_API_KEY;
  }

  try {
    await reloadEnvironmentsInPlace(envs);
  } catch (e) {
    return (
      '## Key rotated, but env reload failed\n\n' +
      `New key saved to \`${credentialsPath}\`. Reload error: ${(e as Error).message}.\n\n` +
      'Restart your MCP host to pick up the new key cleanly.'
    );
  }

  const lines: string[] = [];
  lines.push('## API key rotated');
  lines.push('');
  lines.push(`Rotated for **${result.profile.username}**. The previous key is invalidated immediately.`);
  lines.push('');
  lines.push('### What changed');
  lines.push(`- New key saved to \`${credentialsPath}\` (this machine).`);
  if (envVarWasSet) {
    lines.push(`- Cleared the old \`LOG10X_API_KEY\` from this session so the new key takes effect immediately for follow-up tool calls.`);
  }
  lines.push(`- This MCP server is already running on the new key — no restart needed for this host.`);
  lines.push('');
  lines.push('### New API key');
  lines.push('');
  lines.push(`\`${result.apiKey}\``);
  lines.push('');
  lines.push(
    '_(Also viewable at [console.log10x.com](https://console.log10x.com) → Profile → API Settings if you miss it here.)_'
  );
  lines.push('');
  if (envVarWasSet) {
    lines.push('### To make rotation stick across restarts');
    lines.push('');
    lines.push(
      'Open your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` ' +
        'on macOS, `%APPDATA%\\Claude\\claude_desktop_config.json` on Windows, or the equivalent for ' +
        'Cursor / other MCP hosts) and replace the `LOG10X_API_KEY` value in the `log10x` server\'s ' +
        '`env` block with the new key above. Otherwise the host re-injects the OLD key on next launch ' +
        'and overrides the freshly-rotated credentials.'
    );
    lines.push('');
  }
  lines.push('### Other places to update');
  lines.push('');
  lines.push(
    'Anything else holding the previous key — other MCP hosts on this machine, scripts, CI secrets, ' +
      'forwarder configs, terraform tfvars, etc. — will start receiving `401 Unauthorized` until updated. ' +
      'Sweep them now while the new key is fresh.'
  );
  return lines.join('\n');
}
