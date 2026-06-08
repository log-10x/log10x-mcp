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
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { requireWriteAccess } from '../lib/read-only-guard.js';

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

function buildCreateEnvHumanSummary(inner: CreateEnvInner): string {
  if (!inner.ok) {
    return `create_env failed: ${inner.error ?? 'unknown reason'}.`;
  }
  const total = inner.total_envs ?? 0;
  const defaultNote = inner.is_default ? ' and set as default' : '';
  return `Env "${inner.name}" was created${defaultNote}; ${total} env${total === 1 ? '' : 's'} now on this account. Next step: install a Reporter / Receiver / Retriever via log10x_advise_install.`;
}

export async function executeCreateEnv(
  args: { name: string; is_default?: boolean },
  envs: Environments
): Promise<string | StructuredOutput> {
  requireWriteAccess('creates a new environment on your Log10x account');
  const inner = await executeCreateEnvInner(args, envs);
  return buildEnvelope({
    tool: 'log10x_create_env',
    view: 'summary',
    summary: { headline: inner.ok ? `Created env "${inner.name}" (env_id ${inner.env_id}${inner.is_default ? ', new default' : ''}).` : `Create env refused: ${inner.error}.` },
    data: {
      ok: inner.ok,
      name: inner.name,
      env_id: inner.env_id,
      permissions: inner.permissions,
      is_default: inner.is_default,
      total_envs: inner.total_envs,
      error: inner.error,
      human_summary: buildCreateEnvHumanSummary(inner),
    },
    actions: inner.ok && inner.env_id ? [{ tool: 'log10x_advise_install', args: { environment: inner.name }, reason: 'pick the right Reporter / Receiver / Retriever install path for the new env' }] : [],
  });
}

interface CreateEnvInner { ok: boolean; name: string; env_id?: string; permissions?: string; is_default?: boolean; total_envs?: number; error?: string; markdown: string }

async function executeCreateEnvInner(args: { name: string; is_default?: boolean }, envs: Environments): Promise<CreateEnvInner> {
  // Friendly pre-check: if a same-named env already exists, surface it
  // before paying the round-trip + parsing the BE's 409 body.
  const collision = envs.all.find(
    (e) => e.nickname.toLowerCase() === args.name.toLowerCase()
  );
  if (collision) {
    const md = '## Cannot create env — name already in use\n\n' +
      `An environment named **${collision.nickname}** is already on your account ` +
      `(env_id \`${collision.envId}\`, permissions \`${collision.permissions ?? 'unknown'}\`). ` +
      `Either pick a different name, or use \`log10x_update_env\` to rename / re-flag the ` +
      `existing one.`;
    return { ok: false, name: args.name, error: `name "${args.name}" already in use (env_id ${collision.envId})`, markdown: md };
  }

  const apiKey = envs.default.apiKey;

  let profile;
  try {
    profile = await createEnvironment(apiKey, args.name, args.is_default);
  } catch (e) {
    const msg = (e as Error).message;
    const md = '## Create env failed\n\n' + `${msg}\n\nVerify the name is unique and run \`log10x_login_status\` to confirm your account is signed in.`;
    return { ok: false, name: args.name, error: msg, markdown: md };
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
  return {
    ok: true,
    name: args.name,
    env_id: created?.envId,
    permissions: created?.permissions,
    is_default: created?.isDefault,
    total_envs: profile.environments.length,
    markdown: lines.join('\n'),
  };
}
