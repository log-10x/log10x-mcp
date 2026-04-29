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
};

export async function executeUpdateSettings(
  args: { metadata: Record<string, unknown> },
  envs: Environments
): Promise<string> {
  if (!args.metadata || Object.keys(args.metadata).length === 0) {
    return (
      '## No changes\n\n' +
      'The `metadata` argument was empty. Pass at least one key, for example ' +
      '`{"metadata": {"analyzer_cost": 3.0}}`. See the descriptions for common fields.'
    );
  }

  const apiKey = envs.default.apiKey;

  let profile;
  try {
    profile = await updateUserMetadata(apiKey, args.metadata);
  } catch (e) {
    return (
      '## Update failed\n\n' +
      `${(e as Error).message}\n\n` +
      'Verify the field names against the [Update User docs](https://docs.log10x.com/api/manage/#update-user) ' +
      'or run `log10x_doctor` if you suspect an auth problem.'
    );
  }

  // Reload so subsequent in-process calls see the updated metadata
  // (e.g., analyzer_cost re-fetched from /api/v1/user by getAnalyzerCost).
  try {
    await reloadEnvironmentsInPlace(envs);
  } catch {
    // Non-fatal — the BE write succeeded; in-process reload glitch can be
    // resolved by a host restart. Don't error the tool result on this.
  }

  const lines: string[] = [];
  lines.push('## Settings updated');
  lines.push('');
  lines.push(`Updated ${Object.keys(args.metadata).length} field${Object.keys(args.metadata).length === 1 ? '' : 's'} for **${profile.username}**.`);
  lines.push('');
  lines.push('### Updated fields');
  for (const [k, v] of Object.entries(args.metadata)) {
    const display = typeof v === 'string' && v.length > 60 ? `${v.slice(0, 57)}…` : JSON.stringify(v);
    // Mask any field that looks like a credential.
    const isSecret = /api_key|secret|token|password/i.test(k) && typeof v === 'string';
    lines.push(`- \`${k}\`: ${isSecret ? '`<redacted>`' : display}`);
  }
  lines.push('');
  lines.push('Changes are live for this MCP session and will apply to subsequent tool calls.');
  return lines.join('\n');
}
