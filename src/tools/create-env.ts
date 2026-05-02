/**
 * log10x_create_env — provision a new Log10x environment via
 * `POST /api/v1/user/env`. Pairs naturally with the install advisor
 * tools: "create a staging env, then give me the Reporter install
 * plan" runs as two tool calls, no console trip.
 *
 * Backend handler: backend/lambdas/user-service-go/cmd/environment/main.go
 * (handleCreate). Documented at mksite/docs/api/manage.md
 * "Create Environment".
 *
 * NOT idempotent: calling twice with the same name returns 409 Conflict
 * from the backend. The tool checks the in-memory env list first to
 * surface a friendly error before the network round-trip.
 */

import { z } from 'zod';
import type { Environments } from '../lib/environments.js';
import { reloadEnvironmentsInPlace } from '../lib/environments.js';
import { createEnvironment } from '../lib/api.js';

export const createEnvSchema = {
  name: z
    .string()
    .min(1)
    .describe('Display name for the new environment, e.g. "staging" or "us-east-prod".'),
  is_default: z
    .boolean()
    .optional()
    .describe(
      'When true, the new env becomes the user\'s default — every tool call without an explicit `environment` arg routes here. The previous default is automatically un-defaulted by the backend. Defaults to false (new env is created but the existing default stays the default).'
    ),
};

export async function executeCreateEnv(
  args: { name: string; is_default?: boolean },
  envs: Environments
): Promise<string> {
  // Friendly pre-check: if a same-named env already exists, surface it
  // before paying the round-trip + parsing the BE's 409 body.
  const collision = envs.all.find(
    (e) => e.nickname.toLowerCase() === args.name.toLowerCase()
  );
  if (collision) {
    return (
      '## Cannot create env — name already in use\n\n' +
      `An environment named **${collision.nickname}** is already on your account ` +
      `(env_id \`${collision.envId}\`, permissions \`${collision.permissions ?? 'unknown'}\`). ` +
      `Either pick a different name, or use \`log10x_update_env\` to rename / re-flag the ` +
      `existing one.`
    );
  }

  const apiKey = envs.default.apiKey;

  let profile;
  try {
    profile = await createEnvironment(apiKey, args.name, args.is_default);
  } catch (e) {
    return (
      '## Create env failed\n\n' +
      `${(e as Error).message}\n\n` +
      'Verify the name is unique and run `log10x_login_status` to confirm your account is signed in.'
    );
  }

  // Reload so the next tool call sees the new env in `envs.all`.
  try {
    await reloadEnvironmentsInPlace(envs);
  } catch {
    // Non-fatal — BE write succeeded. A host restart would refresh.
  }

  // Find the env we just created so we can quote its env_id.
  const created = profile.environments.find((e) => e.name === args.name);

  const lines: string[] = [];
  lines.push('## Environment created');
  lines.push('');
  lines.push(`Created **${args.name}** on the account of \`${profile.username}\`.`);
  if (created) {
    lines.push('');
    lines.push(`- **env_id**: \`${created.envId}\``);
    lines.push(`- **permissions**: \`${created.permissions}\``);
    lines.push(`- **default**: ${created.isDefault ? 'yes ★' : 'no (existing default unchanged)'}`);
  }
  lines.push('');
  lines.push(`### Environments now on this account (${profile.environments.length})`);
  for (const e of profile.environments) {
    const star = e.isDefault ? ' ★ default' : '';
    lines.push(`- **${e.name}** · \`${e.permissions}\`${star}`);
  }
  lines.push('');
  lines.push(
    'Next step: deploy a Reporter / Receiver / Retriever into this env using ' +
      '`log10x_advise_install` (pass the new `env_id` so the install plan is scoped correctly).'
  );
  return lines.join('\n');
}
