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

import { revalidateEnvironments, type Environments } from '../lib/environments.js';
import { activeNotices, getManifest } from '../lib/manifest.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';

export const loginStatusSchema = {};

interface LoginStatusSummary {
  signed_in: boolean;
  demo_mode: boolean;
  demo_fallback_reason?: string;
  profile?: { username?: string; user_id?: string; tier?: string };
  envs: Array<{
    env_id: string;
    nickname: string;
    permissions?: string;
    owner?: string;
    is_default: boolean;
    is_last_used: boolean;
  }>;
  notices: Array<{ level: string; message: string }>;
  human_summary: string;
}

function buildLoginStatusHumanSummary(d: Omit<LoginStatusSummary, 'human_summary'>): string {
  if (d.demo_mode) {
    const reason = d.demo_fallback_reason ? ` (fallback reason: ${d.demo_fallback_reason})` : '';
    return `Running in demo mode${reason}. Read-only against the public Log10x demo env; writes and account-scoped queries refuse. Run signin_start to switch to a real account.`;
  }
  const ident = d.profile?.username ?? 'static env-var config';
  const defaultEnv = d.envs.find((e) => e.is_default);
  const defaultFrag = defaultEnv ? `default env "${defaultEnv.nickname}"` : 'no default env set';
  return `Signed in as ${ident} with access to ${d.envs.length} env${d.envs.length === 1 ? '' : 's'}; ${defaultFrag}.${d.notices.length > 0 ? ` ${d.notices.length} active notice${d.notices.length === 1 ? '' : 's'}.` : ''}`;
}

export async function executeLoginStatus(
  _args: Record<string, never>,
  envs: Environments
): Promise<string | StructuredOutput> {
  // Revalidate credentials before reporting state. Without this, the
  // tool would render whatever was decided at MCP boot, even if the
  // credentials file has since become valid (e.g. a rotated key whose
  // authorizer cache has now cleared) or vice versa.
  try {
    await revalidateEnvironments(envs);
  } catch {
    // Best-effort. Fall through and render whatever state we have.
  }
  const notices = activeNotices(getManifest()).map((n) => ({ level: n.level, message: n.message }));
  const partial: Omit<LoginStatusSummary, 'human_summary'> = {
    signed_in: !envs.isDemoMode,
    demo_mode: envs.isDemoMode,
    demo_fallback_reason: envs.demoFallbackReason,
    profile: envs.profile ? { username: envs.profile.username, user_id: envs.profile.userId, tier: envs.profile.tier } : undefined,
    envs: envs.all.map((e) => ({
      env_id: e.envId,
      nickname: e.nickname,
      permissions: e.permissions,
      owner: e.owner,
      is_default: !!e.isDefault,
      is_last_used: !!(envs.lastUsed && envs.lastUsed.envId === e.envId),
    })),
    notices,
  };
  const data: LoginStatusSummary = { ...partial, human_summary: buildLoginStatusHumanSummary(partial) };
  const headline = data.demo_mode
    ? `Demo mode${data.demo_fallback_reason ? ` (API key failed validation)` : ''} — all queries hit the public read-only env.`
    : `Signed in${data.profile?.username ? ` as ${data.profile.username}` : ''} with access to ${data.envs.length} env${data.envs.length !== 1 ? 's' : ''}.`;
  return buildEnvelope({
    tool: 'log10x_login_status',
    view: 'summary',
    summary: { headline },
    data,
    actions: data.demo_mode
      ? [{ tool: 'log10x_signin_start', args: {}, reason: 'open browser Auth0 device flow to switch from demo to a real account' }]
      : [],
  });
}

// Schema is empty — the tool takes no args. We export the empty object
// so the registration in index.ts can pass it as the schema parameter.
export const _typeGuard: typeof loginStatusSchema = loginStatusSchema;
