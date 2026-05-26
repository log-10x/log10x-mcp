/**
 * log10x_update_settings — update user-account metadata via
 * `POST /api/v1/user`. Idempotent. Use case: change analyzer cost
 * ($/GB), AI provider settings, display name, etc., without leaving
 * chat to visit console.log10x.com.
 *
 * Backend handler: backend/lambdas/user-service-go/cmd/user/main.go
 * (handleUpdateProfile). Documented at mksite/docs/api/manage.md
 * "Update User" + "Update AI Settings" sections.
 */

import { z } from 'zod';
import type { Environments } from '../lib/environments.js';
import { reloadEnvironmentsInPlace } from '../lib/environments.js';
import { updateUserMetadata } from '../lib/api.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';

export const updateSettingsSchema = {
  metadata: z
    .record(z.string(), z.unknown())
    .describe(
      'Object of metadata key/value pairs to update on the user account. ' +
        'Common fields: `analyzer_cost` (number, $/GB SIEM cost used for cost-driver math); ' +
        '`ai_provider` (`openai` | `anthropic` | `xai` | `custom` | empty for Log10x-managed); ' +
        '`ai_api_key` (string, BYOK); `ai_endpoint` (string); `ai_model` (string); ' +
        '`ai_temperature` (number 0-1); `ai_disabled` (boolean, true to disable AI entirely); ' +
        '`company` (string display name). The backend persists arbitrary keys, so additional ' +
        'documented fields can be passed through. Existing fields not in the payload are ' +
        'preserved (PATCH-like semantics on the backend).'
    ),
  view: z.enum(['summary', 'markdown']).default('summary').describe('summary returns the typed envelope. markdown wraps the message in data.markdown.'),
};

export async function executeUpdateSettings(
  args: { metadata: Record<string, unknown>; view?: 'summary' | 'markdown' },
  envs: Environments
): Promise<string | StructuredOutput> {
  const view = args.view ?? 'summary';
  const inner = await executeUpdateSettingsInner(args, envs);
  if (view === 'markdown') {
    return buildMarkdownEnvelope({
      tool: 'log10x_update_settings',
      summary: { headline: inner.ok ? `Updated ${inner.fields_updated} setting${inner.fields_updated !== 1 ? 's' : ''} for ${inner.username}.` : `Update settings refused: ${inner.error ?? 'unknown'}.` },
      markdown: inner.markdown,
    });
  }
  return buildEnvelope({
    tool: 'log10x_update_settings',
    view: 'summary',
    summary: { headline: inner.ok ? `Updated ${inner.fields_updated} setting${inner.fields_updated !== 1 ? 's' : ''} for ${inner.username}.` : `Update settings refused: ${inner.error ?? 'unknown'}.` },
    data: { ok: inner.ok, username: inner.username, fields_updated: inner.fields_updated, redacted_keys: inner.redacted_keys, error: inner.error },
  });
}

interface UpdateSettingsInner { ok: boolean; username?: string; fields_updated: number; redacted_keys: string[]; error?: string; markdown: string }

async function executeUpdateSettingsInner(args: { metadata: Record<string, unknown> }, envs: Environments): Promise<UpdateSettingsInner> {
  if (!args.metadata || Object.keys(args.metadata).length === 0) {
    const md = '## No changes\n\n' +
      'The `metadata` argument was empty. Pass at least one key, for example ' +
      '`{"metadata": {"analyzer_cost": 3.0}}`. See the descriptions for common fields.';
    return { ok: false, fields_updated: 0, redacted_keys: [], error: 'metadata empty', markdown: md };
  }

  const apiKey = envs.default.apiKey;

  let profile;
  try {
    profile = await updateUserMetadata(apiKey, args.metadata);
  } catch (e) {
    const msg = (e as Error).message;
    const md = '## Update failed\n\n' + `${msg}\n\nVerify the field names or run \`log10x_doctor\` if you suspect an auth problem.`;
    return { ok: false, fields_updated: 0, redacted_keys: [], error: msg, markdown: md };
  }

  try {
    await reloadEnvironmentsInPlace(envs);
  } catch {
    // Non-fatal.
  }

  const lines: string[] = [];
  lines.push('## Settings updated');
  lines.push('');
  lines.push(`Updated ${Object.keys(args.metadata).length} field${Object.keys(args.metadata).length === 1 ? '' : 's'} for **${profile.username}**.`);
  lines.push('');
  lines.push('### Updated fields');
  const redactedKeys: string[] = [];
  for (const [k, v] of Object.entries(args.metadata)) {
    const display = typeof v === 'string' && v.length > 60 ? `${v.slice(0, 57)}…` : JSON.stringify(v);
    const isSecret = /api_key|secret|token|password/i.test(k) && typeof v === 'string';
    if (isSecret) redactedKeys.push(k);
    lines.push(`- \`${k}\`: ${isSecret ? '`<redacted>`' : display}`);
  }
  lines.push('');
  lines.push('Changes are live for this MCP session and will apply to subsequent tool calls.');
  return { ok: true, username: profile.username, fields_updated: Object.keys(args.metadata).length, redacted_keys: redactedKeys, markdown: lines.join('\n') };
}
