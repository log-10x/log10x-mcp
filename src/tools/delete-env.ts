/**
 * log10x_delete_env — destructive: removes an environment from the
 * user's account via `DELETE /api/v1/user/env`. Irrecoverable.
 *
 * Backend handler: backend/lambdas/user-service-go/cmd/environment/main.go
 * (handleDelete). Documented at mksite/docs/api/manage.md
 * "Delete Environment".
 *
 * Confirm-name pattern: the caller must pass `confirm_name` matching
 * the env's exact display name (case-sensitive). Mirrors `gh repo
 * delete` and the GitHub web UI's "type the repo name to confirm".
 * Without this guard, an LLM that hallucinates an `env_id` could
 * silently delete the wrong env.
 */

import { z } from 'zod';
import type { Environments } from '../lib/environments.js';
import { reloadEnvironmentsInPlace } from '../lib/environments.js';
import { deleteEnvironment } from '../lib/api.js';

export const deleteEnvSchema = {
  env_id: z
    .string()
    .min(1)
    .describe(
      'The `env_id` UUID of the environment to delete. Get it from `log10x_login_status` (which lists all envs with their env_ids).'
    ),
  confirm_name: z
    .string()
    .min(1)
    .describe(
      'The exact display name of the env being deleted. Must match the current `name` (case-sensitive). This is a typo-prevention guard — if it does not match, the tool refuses without calling the backend, and shows the correct name so the LLM can confirm with the user before retrying.'
    ),
};

export async function executeDeleteEnv(
  args: { env_id: string; confirm_name: string },
  envs: Environments
): Promise<string> {
  const target = envs.all.find((e) => e.envId === args.env_id);
  if (!target) {
    const known = envs.all.map((e) => `${e.nickname} → \`${e.envId}\``).join(', ');
    return (
      `## Unknown env_id\n\n` +
      `\`${args.env_id}\` is not in the list of envs your account can reach. Available: ${known}. ` +
      `Run \`log10x_login_status\` to refresh.`
    );
  }

  // Strict match — no case-fold, no whitespace trim. The point of the
  // confirm guard is to make the user (or the LLM, double-checking
  // with the user) state the env name verbatim. Sloppy matching defeats
  // the purpose.
  if (args.confirm_name !== target.nickname) {
    return (
      '## Confirmation does not match — refusing to delete\n\n' +
      `You passed \`confirm_name: "${args.confirm_name}"\` for env \`${args.env_id}\`, but ` +
      `the env's actual name is **${target.nickname}** (case-sensitive). The delete is ` +
      `cancelled — no backend call was made.\n\n` +
      `If you really want to delete \`${target.nickname}\`, retry with ` +
      `\`{ "env_id": "${args.env_id}", "confirm_name": "${target.nickname}" }\`. ` +
      `**Confirm with the user before retrying** — deletion is irrecoverable, including any ` +
      `metrics history scoped to this env.`
    );
  }

  // Permission check — the BE refuses with 401 if caller is not the
  // owner, but surfacing this client-side avoids a confusing auth error.
  if (target.permissions && target.permissions !== 'OWNER') {
    return (
      '## Cannot delete — not the owner\n\n' +
      `Your permission on **${target.nickname}** is \`${target.permissions}\`, not \`OWNER\`. ` +
      `Only the env owner can delete it. Ask the owner (\`${target.owner ?? 'unknown'}\`) ` +
      `to either delete it themselves or transfer ownership to you first.`
    );
  }

  const apiKey = envs.default.apiKey;

  let profile;
  try {
    profile = await deleteEnvironment(apiKey, args.env_id);
  } catch (e) {
    return `## Delete failed\n\n${(e as Error).message}`;
  }

  try {
    await reloadEnvironmentsInPlace(envs);
  } catch {
    // Non-fatal.
  }

  const lines: string[] = [];
  lines.push('## Environment deleted');
  lines.push('');
  lines.push(`Removed **${target.nickname}** (env_id \`${args.env_id}\`) from your account. **Irrecoverable.**`);
  lines.push('');
  lines.push(`### Environments remaining (${profile.environments.length})`);
  for (const e of profile.environments) {
    const star = e.isDefault ? ' ★ default' : '';
    lines.push(`- **${e.name}** · \`${e.permissions}\`${star}`);
  }
  if (profile.environments.length === 0) {
    lines.push('');
    lines.push(
      'No envs remain on this account. Use `log10x_create_env` to provision a new one before any other tool that needs an env can run.'
    );
  }
  return lines.join('\n');
}
