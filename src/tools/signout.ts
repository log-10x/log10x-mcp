/**
 * log10x_signout — wipe the persistent credentials file written by
 * log10x_signin and hot-reload envs so subsequent tool calls fall
 * through to demo mode (or whichever lower-priority configuration
 * source picks up).
 *
 * Idempotent: running it on a fresh machine is a no-op.
 *
 * Does NOT revoke the API key on the BE — that's a server-side
 * decision the user can make from console.log10x.com → Profile.
 * Local sign-out only wipes the local file, mirroring how
 * `gh auth logout` and `aws sso logout` work.
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

  // Reload envs so the in-process state reflects the wipe.
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
    lines.push(`Removed credentials at \`${path}\`.`);
  } else {
    lines.push(`No credentials file at \`${path}\` — nothing to remove.`);
  }
  lines.push('');
  if (reloadErr) {
    lines.push(`**Env reload failed**: ${reloadErr}`);
    lines.push('Restart your MCP host to fully drop the previous session.');
  } else if (envs.isDemoMode) {
    lines.push(
      `Now running in demo mode against the public Log10x demo env. ` +
        `Run \`log10x_signin\` to sign back in via GitHub.`
    );
  } else {
    lines.push(
      `An env-var-based credential is still active (\`LOG10X_API_KEY\` or ` +
        `\`LOG10X_ENVS\` is set in your MCP host config). The local credentials ` +
        `file was wiped, but those env vars take precedence — unset them in ` +
        `your host config and restart to fully sign out.`
    );
  }
  lines.push('');
  lines.push(
    `**Note**: this only logs you out on this machine. Your account and API ` +
      `key still exist on log10x.com — visit https://console.log10x.com → Profile ` +
      `→ API Settings to rotate or revoke.`
  );
  return lines.join('\n');
}
