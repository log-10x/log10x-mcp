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
import { reloadEnvironmentsInPlace, clearOverridingEnvVar } from '../lib/environments.js';
import { writeCredentials, getCredentialsPath } from '../lib/credentials.js';
import { rotateApiKey } from '../lib/api.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { requireWriteAccess } from '../lib/read-only-guard.js';

export const rotateApiKeySchema = {
  confirm: z
    .literal('rotate-now')
    .describe(
      'Pass the literal string `rotate-now` to confirm rotation. This is a typo-prevention guard. Rotation invalidates the previous key immediately on every machine and tool that uses it — only proceed when the user has explicitly asked for rotation, not as a chained side effect of another flow. **Always ask the user to confirm before calling this tool.**'
    ),
};

function buildRotateHumanSummary(result: RotateResult): string {
  if (!result.ok) {
    return `rotate_api_key refused: ${result.error ?? 'unknown reason'}.`;
  }
  const userFrag = result.username ?? 'user';
  const pathFrag = result.credentials_path ? `; new key persisted to ${result.credentials_path}` : '';
  const stickFrag = result.host_config_edit_needed ? ' Also update LOG10X_API_KEY in the MCP host config so the rotation survives host restarts.' : '';
  return `API key rotated for ${userFrag}; the previous key is invalidated immediately on every machine and tool that uses it${pathFrag}.${stickFrag}`;
}

export async function executeRotateApiKey(
  args: { confirm: 'rotate-now' },
  envs: Environments
): Promise<string | StructuredOutput> {
  requireWriteAccess('rotates the API key on your Log10x account');
  const result = await executeRotateApiKeyInner(args, envs);
  return buildEnvelope({
    tool: 'log10x_rotate_api_key',
    view: 'summary',
    summary: { headline: result.ok ? `API key rotated for ${result.username ?? 'user'} — previous key invalidated, new key persisted to ${result.credentials_path}.` : `Rotation refused: ${result.error ?? 'unknown reason'}.` },
    data: {
      ok: result.ok,
      username: result.username,
      new_api_key: result.new_api_key,
      credentials_path: result.credentials_path,
      env_var_cleared: result.env_var_cleared,
      host_config_edit_needed: result.host_config_edit_needed,
      error: result.error,
      human_summary: buildRotateHumanSummary(result),
    },
    warnings: result.ok ? ['rotation invalidates the previous key on every machine; update other MCP hosts, scripts, and CI secrets'] : [],
  });
}

interface RotateResult {
  ok: boolean;
  username?: string;
  new_api_key?: string;
  credentials_path?: string;
  env_var_cleared?: boolean;
  host_config_edit_needed?: boolean;
  error?: string;
  markdown: string;
}

async function executeRotateApiKeyInner(
  args: { confirm: 'rotate-now' },
  envs: Environments
): Promise<RotateResult> {
  if (args.confirm !== 'rotate-now') {
    const md = '## Refused — confirm string did not match\n\n' +
      'Pass `confirm: "rotate-now"` to proceed. Rotation invalidates the previous ' +
      'key everywhere immediately; the confirm guard prevents accidental triggers.';
    return { ok: false, error: 'confirm string did not match', markdown: md };
  }

  if (envs.isDemoMode) {
    const md = '## Cannot rotate — running in demo mode\n\n' +
      'You\'re currently authenticated against the public Log10x demo account, which ' +
      'cannot rotate API keys (the backend returns 403 for demo users). Sign in to ' +
      'your own account first: call `log10x_signin_start` for the Auth0 Device Flow with ' +
      'GitHub or Google (the model chains to `log10x_signin_complete` automatically once you ' +
      'confirm in the browser), or call `log10x_signin_complete` directly with ' +
      '`{ api_key: "<key>" }` to paste a key from console.log10x.com → Profile → API ' +
      'Settings. Then retry rotation. See `log10x_login_status` for the full sign-in breakdown.';
    return { ok: false, error: 'demo mode — backend will refuse', markdown: md };
  }

  const apiKey = envs.default.apiKey;

  let result;
  try {
    result = await rotateApiKey(apiKey);
  } catch (e) {
    const msg = (e as Error).message;
    if (/HTTP 403/.test(msg)) {
      const md = '## Cannot rotate — backend returned 403 Forbidden\n\n' +
        `${msg}\n\n` +
        'This is the response demo accounts get. If you\'re NOT signed in as a demo ' +
        'user and still see this, run `log10x_doctor` to diagnose.';
      return { ok: false, error: '403 Forbidden from backend', markdown: md };
    }
    return { ok: false, error: msg, markdown: `## Rotation failed\n\n${msg}` };
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
    const md = '## Key rotated at the backend, but local save failed\n\n' +
      `Path: ${getCredentialsPath()}\n` +
      `Error: ${(e as Error).message}\n\n` +
      `**Save this new key manually** — the previous one is already invalidated:\n\n` +
      `\`${result.apiKey}\`\n\n` +
      'Update your MCP host config (`LOG10X_API_KEY`) and any scripts / CI secrets ' +
      'using the old value, then restart the host.';
    // Pivot the live process to the new key so this session keeps working
    // even though disk persistence failed. The new key is already in hand;
    // LOG10X_API_KEY (Path 3) wins priority over the stale credentials file,
    // so the reload validates and bakes the NEW key into the rebuilt backend.
    process.env.LOG10X_API_KEY = result.apiKey;
    try { await reloadEnvironmentsInPlace(envs); } catch { /* leave md telling user to restart host */ }
    return { ok: true, username: result.profile.username, new_api_key: result.apiKey, error: `local save failed: ${(e as Error).message}`, markdown: md };
  }

  // Drop the in-process LOG10X_API_KEY override so the next
  // loadEnvironments() reads from the freshly-written credentials
  // file. Without this, the OLD value in process.env would still win
  // priority 1 and we'd start hitting 401s on every subsequent tool
  // call until the host restarts. Same logic as signin / signout.
  const envVarWasSet = clearOverridingEnvVar();

  try {
    await reloadEnvironmentsInPlace(envs);
  } catch (e) {
    const md = '## Key rotated, but env reload failed\n\n' +
      `New key saved to \`${credentialsPath}\`. Reload error: ${(e as Error).message}.\n\n` +
      'Restart your MCP host to pick up the new key cleanly.';
    return { ok: true, username: result.profile.username, new_api_key: result.apiKey, credentials_path: credentialsPath, env_var_cleared: envVarWasSet, error: `env reload failed: ${(e as Error).message}`, markdown: md };
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
    'Anything else holding the previous key, other MCP hosts on this machine, scripts, CI secrets, ' +
      'forwarder configs, terraform tfvars, and so on, will start receiving `401 Unauthorized` until updated. ' +
      'Sweep them now while the new key is fresh.'
  );
  lines.push('');
  lines.push('### Heads up: brief propagation window');
  lines.push('');
  lines.push(
    'The old key stops working immediately. The new key may need up to a few seconds before it ' +
      'is accepted on every request. If the very next call fails with `401` or `403`, retry once after a ' +
      'short wait. The MCP itself recovers automatically on transient auth errors after rotation, so ' +
      'you usually will not have to do anything.'
  );
  return {
    ok: true,
    username: result.profile.username,
    new_api_key: result.apiKey,
    credentials_path: credentialsPath,
    env_var_cleared: envVarWasSet,
    host_config_edit_needed: envVarWasSet,
    markdown: lines.join('\n'),
  };
}
