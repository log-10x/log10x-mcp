/**
 * log10x_signout — clear local credentials and hot-reload envs so
 * subsequent tool calls fall through to demo mode (or whichever
 * lower-priority configuration source picks up).
 *
 * Two layers cleared in this single call:
 *
 *   1. Persistent file at `~/.log10x/credentials` (priority 2 in the
 *      resolution chain — written by `log10x_signin`).
 *
 *   2. The `LOG10X_API_KEY` entry in `process.env` (priority 1). The
 *      MCP server is a child process spawned by the MCP host with
 *      env vars from the host config baked in; we can't edit the
 *      host config from here, but we CAN remove the var from this
 *      process's env so subsequent `loadEnvironments()` calls
 *      bypass it. Without this step, the file wipe in step 1 is
 *      effectively useless because the env var still wins.
 *
 * Idempotent: running on a fresh machine with neither set is a no-op.
 *
 * Does NOT revoke the API key on the BE — that's a server-side
 * decision the user can make from console.log10x.com → Profile.
 * Mirrors how `gh auth logout` and `aws sso logout` work.
 *
 * Caveat: the env-var deletion only lives for the current MCP server
 * process. Whatever the host config (claude_desktop_config.json,
 * etc.) sets is what gets injected on the next host restart. The
 * result message tells the user to also edit the host config to
 * make the sign-out permanent.
 */
import type { Environments } from '../lib/environments.js';
import { reloadEnvironmentsInPlace } from '../lib/environments.js';
import { clearCredentials, getCredentialsPath } from '../lib/credentials.js';

export const signoutSchema = {};

export async function executeSignout(
  _args: Record<string, never>,
  envs: Environments
): Promise<string> {
  const path = getCredentialsPath();
  const wasPresent = await clearCredentials();

  // Drop the in-process LOG10X_API_KEY override too (priority 1).
  // Without this, the file wipe above does nothing visible because
  // the env var still satisfies path 1 in loadEnvironments().
  const envVarWasSet = !!process.env.LOG10X_API_KEY;
  if (envVarWasSet) {
    delete process.env.LOG10X_API_KEY;
  }

  // Reload envs so the in-process state reflects both wipes.
  let reloadErr: string | undefined;
  try {
    await reloadEnvironmentsInPlace(envs);
  } catch (e) {
    reloadErr = (e as Error).message;
  }

  const lines: string[] = [];
  lines.push('## Signed out of Log10x');
  lines.push('');
  if (wasPresent) {
    lines.push(`- Removed credentials at \`${path}\`.`);
  } else {
    lines.push(`- No credentials file at \`${path}\` — nothing to remove.`);
  }
  if (envVarWasSet) {
    lines.push(`- Cleared \`LOG10X_API_KEY\` for this session.`);
  }
  if (!wasPresent && !envVarWasSet) {
    lines.push(`- No active credential of either kind — already signed out.`);
  }
  lines.push('');

  if (reloadErr) {
    lines.push(`**Env reload failed**: ${reloadErr}`);
    lines.push('Restart your MCP host to fully drop the previous session.');
  } else if (envs.isDemoMode) {
    lines.push(
      `Now running in demo mode against the public Log10x demo env. ` +
        `Run \`log10x_signin\` to sign back in.`
    );
  } else {
    // We cleared both layers but envs is somehow not in demo mode.
    // Could happen if a future credential source (LOG10X_ENVS, etc.)
    // is reintroduced. Surface honestly rather than confidently lie.
    lines.push(
      'A non-env-var, non-file credential source is still active. ' +
        'Run `log10x_login_status` to see what\'s active and how to fully sign out.'
    );
  }
  lines.push('');

  if (envVarWasSet) {
    lines.push(
      `**To make sign-out stick across restarts**: open your Claude Desktop ` +
        `config (\`~/Library/Application Support/Claude/claude_desktop_config.json\` ` +
        `on macOS, \`%APPDATA%\\Claude\\claude_desktop_config.json\` on Windows, ` +
        `or the equivalent for Cursor / other MCP hosts) and delete the ` +
        `\`LOG10X_API_KEY\` line from the \`log10x\` server's \`env\` block. ` +
        `Otherwise the host re-injects it on next launch and you're back to signed in.`
    );
    lines.push('');
  }
  lines.push(
    `**Note**: this only logs you out on this machine. Your account and API ` +
      `key still exist on log10x.com — visit https://console.log10x.com → Profile ` +
      `→ API Settings to rotate or revoke.`
  );
  return lines.join('\n');
}
