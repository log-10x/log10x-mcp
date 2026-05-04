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
import { activeNotices, getManifest } from '../lib/manifest.js';

export const loginStatusSchema = {};

export async function executeLoginStatus(
  _args: Record<string, never>,
  envs: Environments
): Promise<string> {
  const lines: string[] = [];
  lines.push('## Log10x login status');
  lines.push('');

  // Surface any global notices the Log10x team has published in the manifest
  // (e.g., scheduled maintenance, API deprecation lead times, new tool tips).
  // Rendered at the top so the LLM relays them prominently.
  const notices = activeNotices(getManifest());
  if (notices.length > 0) {
    for (const n of notices) {
      const tag = n.level === 'warn' ? '⚠ Notice' : 'ℹ Notice';
      lines.push(`> **${tag}:** ${n.message}`);
    }
    lines.push('');
  }

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
    lines.push('### To use your own account');
    lines.push('Two ways to sign in. Both end up in the same place — the MCP autodiscovers your envs from `/api/v1/user` and the next tool call runs against your real account without an MCP-host restart.');
    lines.push('');
    lines.push('**Option A — `log10x_signin` (recommended, no host-config edit needed).** Two modes, ask the user which they prefer:');
    lines.push('- `mode: "browser"` (default): opens a browser to Auth0\'s universal login page with the device code pre-filled. The user picks **GitHub** or **Google** there, completes OAuth with the chosen IdP, and confirms the device authorization. The MCP polls until done, then exchanges the Auth0 access token for a long-lived Log10x API key. Auto-creates an account on first sign-up. 30s to 2 min.');
    lines.push('- `mode: "api_key"` with `api_key: "<key>"`: validates a Log10x API key the user already has (e.g., copied from console.log10x.com → Profile → API Settings, or issued by a workspace admin). No browser.');
    lines.push('');
    lines.push('Either mode writes the resolved key to `~/.log10x/credentials` (mode 0600), which persists across MCP-host restarts on its own — no config-file edit needed.');
    lines.push('');
    lines.push('**Option B — set `LOG10X_API_KEY` in your MCP host config** (manual, useful for CI / shared / scripted setups):');
    lines.push('1. Get your API key at https://console.log10x.com → Profile → API Settings.');
    lines.push('2. Edit your MCP host\'s config file:');
    lines.push('   - **Claude Desktop**: `%APPDATA%\\Claude\\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).');
    lines.push('   - **Cursor / Windsurf / other**: see your host\'s docs for where MCP server env vars are configured.');
    lines.push('3. In the `log10x` server\'s `env` block, add `"LOG10X_API_KEY": "<your-key>"`.');
    lines.push('4. Fully quit and restart the MCP host.');
    lines.push('');
    lines.push('After either option, re-run `log10x_login_status` to confirm — the response should list your real envs instead of the demo.');
    return lines.join('\n');
  }

  const profile = envs.profile;
  if (profile) {
    const username = profile.username || profile.userId || '<unknown>';
    const tier = profile.tier ? ` · tier=${profile.tier}` : '';
    lines.push(`**Signed in as ${username}**${tier}.`);
  } else {
    lines.push('**Signed in via static env-var configuration.** (No `/api/v1/user` profile available — credentials came from `LOG10X_API_KEY`.)');
  }
  lines.push('');

  lines.push(`### Environments accessible (${envs.all.length})`);
  for (const e of envs.all) {
    const perm = e.permissions ? `\`${e.permissions}\`` : '`UNKNOWN`';
    const owner = e.owner ? ` · owner: ${e.owner}` : '';
    const star = e.isDefault ? ' ★ default' : '';
    const current = envs.lastUsed && envs.lastUsed.envId === e.envId ? ' ← last used' : '';
    lines.push(`- **${e.nickname}** · ${perm}${owner}${star}${current}`);
    lines.push(`    \`env_id: ${e.envId}\``);
  }
  lines.push('');

  lines.push('### Env resolution for tool calls');
  lines.push('Tools that take an `environment` arg resolve in this order: explicit value → last env you named this session → your default env. Pass `environment: "<nickname>"` to any tool to switch envs (subsequent calls without an `environment` arg stick to that env until you change it).');
  lines.push('');
  lines.push('Tools that mutate an env (`log10x_update_env`, `log10x_delete_env`) take an `env_id` UUID, not the nickname — copy it from the line under each env above.');

  return lines.join('\n');
}

// Schema is empty for now — the tool takes no args. We export the empty
// object anyway so the registration in index.ts can pass it as the
// schema parameter to server.tool().
export const _typeGuard: typeof loginStatusSchema = loginStatusSchema;
void z; // satisfy unused-import in strict TS configs
