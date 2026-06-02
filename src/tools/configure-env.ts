/**
 * log10x_configure_env — write a customer's env into ~/.log10x/envs.json
 * after validating that the backend is reachable, authenticated, and
 * has 10x engine metrics with the expected labels.
 *
 * This is the conversational onboarding entry point. Every metric tool,
 * when no env is configured, returns a structured `not_configured`
 * response naming this tool. The agent gathers the backend details
 * from the user, then calls configure_env to persist.
 *
 * Validator failures DO NOT persist — the user gets the diagnostic and
 * re-runs after fixing. Successful validation appends an entry to
 * `~/.log10x/envs.json`; if no file exists, it's created.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import {
  createMetricsBackend,
  MetricsBackendConfigError,
  type MetricsBackendConfig,
} from '../lib/metrics-backend.js';
import { DEFAULT_LABELS, type LabelNameMap } from '../lib/promql.js';
import { validateBackend, renderValidationResult } from '../lib/backend-validator.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';

const promAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string() }),
  z.object({ type: z.literal('basic'), user: z.string(), password: z.string() }),
  z.object({ type: z.literal('header'), name: z.string(), value: z.string() }),
]);

const metricsBackendConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('log10x'), apiKey: z.string(), envId: z.string() }),
  z.object({ kind: z.literal('prometheus'), url: z.string(), auth: promAuthSchema }),
  z.object({ kind: z.literal('mimir'), url: z.string(), auth: promAuthSchema, orgId: z.string().optional() }),
  z.object({ kind: z.literal('cortex'), url: z.string(), auth: promAuthSchema, orgId: z.string() }),
  z.object({ kind: z.literal('amp'), url: z.string(), region: z.string() }),
  z.object({ kind: z.literal('datadog'), site: z.string(), apiKey: z.string(), appKey: z.string() }),
  z.object({ kind: z.literal('grafana_cloud_prom'), url: z.string(), user: z.string(), apiKey: z.string() }),
  z.object({ kind: z.literal('gcp_managed_prom'), url: z.string(), projectId: z.string() }),
]);

const labelNameMapSchema = z
  .object({
    pattern: z.string().optional(),
    service: z.string().optional(),
    severity: z.string().optional(),
    env: z.string().optional(),
  })
  .optional();

export const configureEnvSchema = {
  nickname: z
    .string()
    .min(1)
    .describe(
      'Short human-readable name for this env (e.g., `acme-prod`, `acme-staging`). Must be unique across configured envs.'
    ),
  metricsBackend: metricsBackendConfigSchema.describe(
    'The metrics backend this env queries. Discriminated by `kind`. The 10x engine in the customer\'s pipeline ' +
      'must be writing to this same store via its metric output module. Credential fields accept either literal ' +
      'values OR `${VAR_NAME}` references resolved from the environment at load time.'
  ),
  labels: labelNameMapSchema.describe(
    'Optional per-env label name overrides. Defaults to the engine\'s standard names. Set when the customer\'s ' +
      'engine `metricFieldNames` config renames `tenx_user_service` to `service`, `message_pattern` to ' +
      '`pattern_hash`, etc.'
  ),
  isDefault: z.boolean().optional().describe('Mark this env as the user\'s default. At most one env in the file should have this set.'),
  validateOnly: z
    .boolean()
    .optional()
    .describe(
      'When true, run validation and return the result but DO NOT write the env to `~/.log10x/envs.json`. Useful for dry-run checks during conversational onboarding.'
    ),
};

interface ConfigureEnvArgs {
  nickname: string;
  metricsBackend: MetricsBackendConfig;
  labels?: Partial<LabelNameMap>;
  isDefault?: boolean;
  validateOnly?: boolean;
}

function envsJsonPath(): string {
  return join(process.env.HOME || homedir(), '.log10x', 'envs.json');
}

interface EnvsJsonEntry {
  nickname: string;
  metricsBackend: MetricsBackendConfig;
  labels?: Partial<LabelNameMap>;
  isDefault?: boolean;
}

async function readEnvsJsonRaw(): Promise<EnvsJsonEntry[]> {
  try {
    const raw = await fs.readFile(envsJsonPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      // KEEP (internal-state): corrupt user file. Surfaced via wrap().
      throw new Error(`Existing ${envsJsonPath()} is not a JSON array.`);
    }
    return parsed as EnvsJsonEntry[];
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // KEEP (internal-state): unexpected fs read failure on user's envs.json.
    throw e;
  }
}

async function writeEnvsJson(entries: EnvsJsonEntry[]): Promise<void> {
  const dir = join(process.env.HOME || homedir(), '.log10x');
  await fs.mkdir(dir, { recursive: true });
  const content = JSON.stringify(entries, null, 2) + '\n';
  await fs.writeFile(envsJsonPath(), content, { mode: 0o600 });
}

function buildHumanSummary(result: ConfigureEnvInner): string {
  if (!result.ok) {
    return `configure_env failed: ${result.error ?? 'validation failed'}.`;
  }
  if (result.action === 'validated_only') {
    return `Env "${result.nickname}" validated against the live backend; not persisted (validateOnly=true).`;
  }
  const envCount = result.total_envs ?? 0;
  const defaultNote = result.is_default ? ` and set as default` : '';
  return `Env "${result.nickname}" was ${result.action}${defaultNote}; ${envCount} env${envCount === 1 ? '' : 's'} now configured. Backend reachable and engine metrics validated.`;
}

export async function executeConfigureEnv(args: ConfigureEnvArgs): Promise<string | StructuredOutput> {
  const result = await executeConfigureEnvInner(args);
  return buildEnvelope({
    tool: 'log10x_configure_env',
    view: 'summary',
    summary: { headline: result.ok ? `Env "${result.nickname}" ${result.action}, ${result.total_envs ?? '?'} env${result.total_envs !== 1 ? 's' : ''} configured.` : `Configure env refused: ${result.error ?? 'validation failed'}.` },
    data: {
      ok: result.ok,
      nickname: result.nickname,
      action: result.action,
      is_default: result.is_default,
      total_envs: result.total_envs,
      envs_json_path: result.envs_json_path,
      validation_passed: result.validation_passed,
      error: result.error,
      human_summary: buildHumanSummary(result),
    },
  });
}

interface ConfigureEnvInner {
  ok: boolean;
  nickname: string;
  action?: 'added' | 'updated' | 'validated_only';
  is_default?: boolean;
  total_envs?: number;
  envs_json_path?: string;
  validation_passed?: boolean;
  error?: string;
  markdown: string;
}

async function executeConfigureEnvInner(args: ConfigureEnvArgs): Promise<ConfigureEnvInner> {
  let backend;
  try {
    backend = createMetricsBackend(args.metricsBackend);
  } catch (e) {
    if (e instanceof MetricsBackendConfigError) {
      const md = `## Configuration error\n\n${e.message}\n\nFix and re-run \`log10x_configure_env\`.`;
      return { ok: false, nickname: args.nickname, error: e.message, markdown: md };
    }
    // KEEP (internal-state): unexpected backend-construction failure.
    throw e;
  }

  const labels: LabelNameMap = {
    pattern: args.labels?.pattern ?? DEFAULT_LABELS.pattern,
    service: args.labels?.service ?? DEFAULT_LABELS.service,
    severity: args.labels?.severity ?? DEFAULT_LABELS.severity,
    env: args.labels?.env ?? DEFAULT_LABELS.env,
    hash: args.labels?.hash ?? DEFAULT_LABELS.hash,
  };

  // ── 2. Validate against the live backend ──
  const validation = await validateBackend(backend, labels);
  const validationMarkdown = renderValidationResult(validation, { nickname: args.nickname, metricsBackend: backend });

  if (!validation.ok) {
    const head = `# Validation failed — env \`${args.nickname}\` NOT persisted`;
    const footer = `\n\nFix the first FAIL above, then re-run \`log10x_configure_env\` with the same arguments.`;
    const md = `${head}\n\n${validationMarkdown}${footer}`;
    return { ok: false, nickname: args.nickname, validation_passed: false, error: 'validation failed', markdown: md };
  }

  if (args.validateOnly) {
    const md = [
      `# Validation passed — env \`${args.nickname}\` NOT persisted (validateOnly=true)`,
      '',
      validationMarkdown,
      '',
      'Re-run with `validateOnly: false` (or omit) to persist this env to `~/.log10x/envs.json`.',
    ].join('\n');
    return { ok: true, nickname: args.nickname, action: 'validated_only', validation_passed: true, envs_json_path: envsJsonPath(), markdown: md };
  }

  // ── 4. Persist to ~/.log10x/envs.json ──
  let existing: EnvsJsonEntry[];
  try {
    existing = await readEnvsJsonRaw();
  } catch (e) {
    const msg = (e as Error).message;
    const md = `## Could not read existing envs.json\n\n${msg}\n\nValidation passed but the file isn't writable. Fix the file, then re-run.`;
    return { ok: false, nickname: args.nickname, error: `read envs.json: ${msg}`, markdown: md };
  }

  // Replace if same nickname exists (idempotent re-config), else append.
  const filtered = existing.filter((e) => e.nickname !== args.nickname);
  const replacing = filtered.length !== existing.length;
  // If isDefault=true, clear any other default first.
  const entries = args.isDefault
    ? filtered.map((e) => ({ ...e, isDefault: undefined as undefined | boolean }))
    : filtered;
  entries.push({
    nickname: args.nickname,
    metricsBackend: args.metricsBackend,
    labels: args.labels,
    isDefault: args.isDefault,
  });

  try {
    await writeEnvsJson(entries);
  } catch (e) {
    const msg = (e as Error).message;
    const md = `## Validation passed but failed to write envs.json\n\n${msg}\n\nPath: ${envsJsonPath()}`;
    return { ok: false, nickname: args.nickname, validation_passed: true, error: `write envs.json: ${msg}`, markdown: md };
  }

  const action: 'added' | 'updated' = replacing ? 'updated' : 'added';
  const lines: string[] = [];
  lines.push(`# Env \`${args.nickname}\` ${action} in \`${envsJsonPath()}\``);
  lines.push('');
  lines.push(validationMarkdown);
  lines.push('');
  lines.push(`The MCP will use the new env on the next tool call. ${entries.length} env${entries.length === 1 ? '' : 's'} now configured: ${entries.map((e) => `\`${e.nickname}\``).join(', ')}.`);
  if (args.isDefault) {
    lines.push('');
    lines.push(`\`${args.nickname}\` is now the default env (other envs' \`isDefault\` flag was cleared).`);
  }
  return {
    ok: true,
    nickname: args.nickname,
    action,
    is_default: !!args.isDefault,
    total_envs: entries.length,
    envs_json_path: envsJsonPath(),
    validation_passed: true,
    markdown: lines.join('\n'),
  };
}
