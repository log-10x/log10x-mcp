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
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';

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

function buildDeleteEnvHumanSummary(inner: DeleteEnvInner): string {
  if (!inner.ok) {
    return `delete_env failed: ${inner.error ?? 'unknown reason'}.`;
  }
  const remaining = inner.remaining_envs ?? 0;
  return `Env "${inner.deleted_name ?? inner.deleted_env_id ?? ''}" was deleted (irrecoverable); ${remaining} env${remaining === 1 ? '' : 's'} remain on this account.`;
}

export async function executeDeleteEnv(
  args: { env_id: string; confirm_name: string },
  envs: Environments
): Promise<string | StructuredOutput> {
  const inner = await executeDeleteEnvInner(args, envs);
  return buildEnvelope({
    tool: 'log10x_delete_env',
    view: 'summary',
    summary: { headline: inner.ok ? `Deleted env "${inner.deleted_name}" (${inner.deleted_env_id}), ${inner.remaining_envs ?? '?'} envs remain.` : `Delete env refused: ${inner.error ?? 'unknown'}.` },
    data: {
      ok: inner.ok,
      deleted_env_id: inner.deleted_env_id,
      deleted_name: inner.deleted_name,
      remaining_envs: inner.remaining_envs,
      error: inner.error,
      human_summary: buildDeleteEnvHumanSummary(inner),
    },
    warnings: inner.ok ? ['env deletion is irrecoverable; metric history scoped to this env is also lost'] : [],
  });
}

interface DeleteEnvInner { ok: boolean; deleted_env_id?: string; deleted_name?: string; remaining_envs?: number; error?: string; markdown: string }

async function executeDeleteEnvInner(args: { env_id: string; confirm_name: string }, envs: Environments): Promise<DeleteEnvInner> {
  const target = envs.all.find((e) => e.envId === args.env_id);
  if (!target) {
    const known = envs.all.map((e) => `${e.nickname} → \`${e.envId}\``).join(', ');
    const md = `## Unknown env_id\n\n` +
      `\`${args.env_id}\` is not in the list of envs your account can reach. Available: ${known}. ` +
      `Run \`log10x_login_status\` to refresh.`;
    return { ok: false, error: `unknown env_id ${args.env_id}`, markdown: md };
  }

  // Strict match — no case-fold, no whitespace trim. The point of the
  // confirm guard is to make the user (or the LLM, double-checking
  // with the user) state the env name verbatim. Sloppy matching defeats
  // the purpose.
  if (args.confirm_name !== target.nickname) {
    const md = '## Confirmation does not match — refusing to delete\n\n' +
      `You passed \`confirm_name: "${args.confirm_name}"\` for env \`${args.env_id}\`, but ` +
      `the env's actual name is **${target.nickname}** (case-sensitive). The delete is ` +
      `cancelled — no backend call was made.\n\n` +
      `If you really want to delete \`${target.nickname}\`, retry with ` +
      `\`{ "env_id": "${args.env_id}", "confirm_name": "${target.nickname}" }\`. ` +
      `**Confirm with the user before retrying** — deletion is irrecoverable, including any ` +
      `metrics history scoped to this env.`;
    return { ok: false, error: `confirm_name mismatch — expected "${target.nickname}"`, markdown: md };
  }

  if (target.permissions && target.permissions !== 'OWNER') {
    const md = '## Cannot delete — not the owner\n\n' +
      `Your permission on **${target.nickname}** is \`${target.permissions}\`, not \`OWNER\`. ` +
      `Only the env owner can delete it. Ask the owner (\`${target.owner ?? 'unknown'}\`) ` +
      `to either delete it themselves or transfer ownership to you first.`;
    return { ok: false, error: `permissions=${target.permissions}, owner-only`, markdown: md };
  }

  const apiKey = envs.default.apiKey;

  let profile;
  try {
    profile = await deleteEnvironment(apiKey, args.env_id);
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false, error: msg, markdown: `## Delete failed\n\n${msg}` };
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
  return {
    ok: true,
    deleted_env_id: args.env_id,
    deleted_name: target.nickname,
    remaining_envs: profile.environments.length,
    markdown: lines.join('\n'),
  };
}
