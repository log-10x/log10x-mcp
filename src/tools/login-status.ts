/**
 * log10x_login_status — explain the current credential / env state and
 * how to upgrade.
 *
 * Designed for two scenarios:
 *
 *   1. The user is in demo mode and asks "log me in" / "use my account".
 *      The LLM calls this tool, gets back a step-by-step config edit
 *      guide it can relay to the user. (MCP can't drive a browser flow,
 *      so we describe the manual steps for editing claude_desktop_config.json
 *      or the equivalent for whichever MCP host is in use.)
 *
 *   2. The user is signed in and asks "what envs do I have / am I logged
 *      in?". The tool reports identity, env list with permissions, and
 *      which env is current.
 */

import { z } from 'zod';
import type { Environments } from '../lib/environments.js';

export const loginStatusSchema = {};

export async function executeLoginStatus(
  _args: Record<string, never>,
  envs: Environments
): Promise<string> {
  const lines: string[] = [];
  lines.push('## Log10x login status');
  lines.push('');

  if (envs.isDemoMode) {
    lines.push('**You are in DEMO MODE.** No `LOG10X_API_KEY` is set in the MCP server\'s environment, so the MCP booted against the public read-only demo env (the same one console.log10x.com shows visitors who haven\'t signed up).');
    lines.push('');
    lines.push('### What works in demo mode');
    lines.push('- All read-only tools against the shared `Log10x Demo` env: `cost_drivers`, `top_patterns`, `investigate`, `services`, `event_lookup`, `list_by_label`, etc.');
    lines.push('- The privacy-mode templater tools (`resolve_batch`, `extract_templates`) — those run via local docker / tenx and don\'t need an account at all.');
    lines.push('');
    lines.push('### What doesn\'t');
    lines.push('- Anything that writes (e.g., `backfill_metric` creating a new metric on YOUR account).');
    lines.push('- Anything that needs YOUR cost data (the demo env is shared sample data — investigations against it won\'t reflect your real spend).');
    lines.push('');
    lines.push('### To upgrade to your own account');
    lines.push('1. Get your API key at https://console.log10x.com → Profile → API Settings.');
    lines.push('2. Edit your MCP host\'s config file:');
    lines.push('   - **Claude Desktop**: `%APPDATA%\\Claude\\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).');
    lines.push('   - **Other MCP hosts**: see your host\'s docs for where MCP server env vars are configured.');
    lines.push('3. In the `log10x` server\'s `env` block, add `"LOG10X_API_KEY": "<your-key>"`. You do **not** need `LOG10X_ENV_ID` — the MCP autodiscovers your envs from the API.');
    lines.push('4. Fully quit and restart the MCP host.');
    lines.push('5. Re-run `log10x_login_status` to confirm — the response should list your real envs instead of the demo.');
    return lines.join('\n');
  }

  const profile = envs.profile;
  if (profile) {
    const username = profile.username || profile.userId || '<unknown>';
    const tier = profile.tier ? ` · tier=${profile.tier}` : '';
    lines.push(`**Signed in as ${username}**${tier}.`);
  } else {
    lines.push('**Signed in via static env-var configuration.** (No `/api/v1/user` profile available — credentials came from `LOG10X_API_KEY + LOG10X_ENV_ID` or `LOG10X_ENVS`.)');
  }
  lines.push('');

  lines.push(`### Environments accessible (${envs.all.length})`);
  for (const e of envs.all) {
    const perm = e.permissions ? `\`${e.permissions}\`` : '`UNKNOWN`';
    const owner = e.owner ? ` · owner: ${e.owner}` : '';
    const star = e.isDefault ? ' ★ default' : '';
    const current = envs.lastUsed && envs.lastUsed.envId === e.envId ? ' ← last used' : '';
    lines.push(`- **${e.nickname}** · ${perm}${owner}${star}${current}`);
  }
  lines.push('');

  lines.push('### Env resolution for tool calls');
  lines.push('Tools that take an `environment` arg resolve in this order: explicit value → last env you named this session → your default env. Pass `environment: "<nickname>"` to any tool to switch envs (subsequent calls without an `environment` arg stick to that env until you change it).');

  return lines.join('\n');
}

// Schema is empty for now — the tool takes no args. We export the empty
// object anyway so the registration in index.ts can pass it as the
// schema parameter to server.tool().
export const _typeGuard: typeof loginStatusSchema = loginStatusSchema;
void z; // satisfy unused-import in strict TS configs
