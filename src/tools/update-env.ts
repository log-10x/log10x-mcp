/**
 * log10x_update_env — rename an env or set it as the user's default,
 * via `PUT /api/v1/user/env`.
 *
 * Backend handler: backend/lambdas/user-service-go/cmd/environment/main.go
 * (handleUpdate, dispatched on `PUT` and `PATCH`). Documented at
 * mksite/docs/api/manage.md "Update Environment".
 *
 * IMPORTANT: requires the `PUT /api/v1/user/env` route to be configured
 * in the API Gateway. Without it the call fails at the gateway layer
 * with a 4xx before the lambda is invoked. See backend PR #62
 * (fix(gateway): wire PUT /api/v1/user/env).
 */

import { z } from 'zod';
import type { Environments } from '../lib/environments.js';
import { reloadEnvironmentsInPlace } from '../lib/environments.js';
import { updateEnvironment } from '../lib/api.js';

export const updateEnvSchema = {
  env_id: z
    .string()
    .min(1)
    .describe(
      'The `env_id` UUID of the environment to update. Get it from `log10x_login_status` (which lists all envs with their env_ids) or from a prior `log10x_create_env` response.'
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe('New display name for the env. Optional — omit to keep the current name.'),
  is_default: z
    .boolean()
    .optional()
    .describe(
      'When true, this env becomes the user\'s default — every tool call without an explicit `environment` arg routes here. The previous default is automatically un-defaulted by the backend. Optional — omit to leave the default flag unchanged.'
    ),
};

export async function executeUpdateEnv(
  args: { env_id: string; name?: string; is_default?: boolean },
  envs: Environments
): Promise<string> {
  if (args.name === undefined && args.is_default === undefined) {
    return (
      '## No changes\n\n' +
      'Pass at least one of `name` or `is_default`. Example: `{"env_id": "...", "is_default": true}` ' +
      'to make an env the new default, or `{"env_id": "...", "name": "production-2"}` to rename.'
    );
  }

  // Find the existing env so the result can show before/after.
  const before = envs.all.find((e) => e.envId === args.env_id);
  if (!before) {
    const known = envs.all.map((e) => `${e.nickname} → \`${e.envId}\``).join(', ');
    return (
      `## Unknown env_id\n\n` +
      `\`${args.env_id}\` is not in the list of envs your account can reach. Available: ${known}. ` +
      `Run \`log10x_login_status\` to refresh.`
    );
  }

  const apiKey = envs.default.apiKey;

  let profile;
  try {
    profile = await updateEnvironment(apiKey, args.env_id, {
      name: args.name,
      is_default: args.is_default,
    });
  } catch (e) {
    const msg = (e as Error).message;
    // Surface the gateway-routing-missing case with a clear hint —
    // until the backend PR (fix(gateway)) deploys, PUT 4xxs at the
    // gateway and the user gets a confusing "404 Not Found" or
    // "405 Method Not Allowed".
    if (/HTTP 40[45]/.test(msg)) {
      return (
        '## Update env failed — backend route not yet deployed\n\n' +
        `${msg}\n\n` +
        'The \`PUT /api/v1/user/env\` route is not yet in the API Gateway. ' +
        'This is fixed by backend PR #62 (`fix(gateway): wire PUT /api/v1/user/env`). ' +
        'Once that PR ships to staging / prod, this tool will work. As a workaround, ' +
        'you can rename the env via the console: console.log10x.com → Profile → Environments.'
      );
    }
    return `## Update env failed\n\n${msg}`;
  }

  try {
    await reloadEnvironmentsInPlace(envs);
  } catch {
    // Non-fatal.
  }

  const after = profile.environments.find((e) => e.envId === args.env_id);

  const lines: string[] = [];
  lines.push('## Environment updated');
  lines.push('');
  if (after) {
    lines.push(`Updated env \`${args.env_id}\`.`);
    lines.push('');
    if (args.name && args.name !== before.nickname) {
      lines.push(`- **Name**: \`${before.nickname}\` → \`${after.name}\``);
    }
    if (args.is_default !== undefined && args.is_default !== before.isDefault) {
      lines.push(`- **Default**: ${before.isDefault ? '★' : '—'} → ${after.isDefault ? '★' : '—'}`);
    }
  } else {
    lines.push(`Update succeeded but the env wasn't returned in the user profile — try \`log10x_login_status\` to verify.`);
  }
  lines.push('');
  lines.push(`### Environments now on this account (${profile.environments.length})`);
  for (const e of profile.environments) {
    const star = e.isDefault ? ' ★ default' : '';
    lines.push(`- **${e.name}** · \`${e.permissions}\`${star}`);
  }
  return lines.join('\n');
}
