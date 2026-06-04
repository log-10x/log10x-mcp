/**
 * log10x_set_gitops_repo — write the gitops.repo field on an env entry
 * in ~/.log10x/envs.json so configure_engine can author cap-CSV PRs.
 *
 * configure_engine requires gitops_repo (owner/name) to know which
 * GitHub repo to open the PR against. The value can come from three
 * places:
 *   1. Passed directly as `gitops_repo` to configure_engine.
 *   2. The LOG10X_GH_REPO environment variable on the MCP server.
 *   3. The `gitops.repo` field in the env entry in ~/.log10x/envs.json.
 *
 * This tool handles option 3 — writing the field to envs.json. After
 * writing, the MCP server must restart to pick up the change (the file
 * is read once at boot by environments.ts). Use log10x_dev_restart to
 * trigger the restart, or restart the MCP server process manually.
 *
 * Why not log10x_configure_env?
 * configure_env runs a live-backend validation before writing — it
 * requires metricsBackend credentials and refuses to persist without
 * them. Setting gitops.repo is orthogonal to backend validation: the
 * user may already have a working env and just needs to add the gitops
 * field. Adding this as a separate targeted tool avoids forcing the user
 * to re-supply backend credentials for an unrelated field update.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';

// ── Schema ───────────────────────────────────────────────────────────────────

export const setGitopsRepoSchema = {
  gitops_repo: z
    .string()
    .regex(
      /^[^/\s]+\/[^/\s]+$/,
      'Must be in owner/repo format (e.g. acme-corp/platform-config). No spaces, no leading slash.'
    )
    .describe(
      'GitHub repo where configure_engine will open cap-CSV PRs. Format: `owner/repo` (e.g. `acme-corp/platform-config`). Must match the repo your team uses for gitops — configure_engine will create a branch and PR here.'
    ),
  environment: z
    .string()
    .optional()
    .describe(
      'Nickname of the env entry to update (from `~/.log10x/envs.json`). Omit to update the default env (the entry with `isDefault: true`, or the only entry if there is just one).'
    ),
  gitops_lookup_path: z
    .string()
    .optional()
    .describe(
      'Override the path inside the repo where configure_engine looks for the cap-CSV (default: `pipelines/run/regulate/rate/caps.csv`). Omit to keep the default.'
    ),
  confirm: z
    .literal('set-now')
    .describe(
      'Safety gate — must be the literal string `"set-now"` to write. This prevents accidental invocations from an agent chain that threads the args wrong.'
    ),
};

interface SetGitopsRepoArgs {
  gitops_repo: string;
  environment?: string;
  gitops_lookup_path?: string;
  confirm: 'set-now';
}

// ── envs.json helpers (mirrors configure-env.ts) ────────────────────────────

function envsJsonPath(): string {
  return join(process.env.HOME || homedir(), '.log10x', 'envs.json');
}

/**
 * Minimal interface — we read the file as opaque JSON objects and only
 * touch the `gitops` sub-field, so we do not need to know (or validate)
 * the full shape of every entry.
 */
interface RawEnvEntry {
  nickname?: string;
  isDefault?: boolean;
  gitops?: { repo: string; lookupPath?: string };
  [key: string]: unknown;
}

async function readEnvsJsonRaw(): Promise<RawEnvEntry[]> {
  try {
    const raw = await fs.readFile(envsJsonPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(
        `Existing ${envsJsonPath()} is not a JSON array. Fix the file manually, then retry.`
      );
    }
    return parsed as RawEnvEntry[];
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No envs.json found at ${envsJsonPath()}. Run log10x_configure_env first to create an env, then set gitops_repo on it.`
      );
    }
    throw e;
  }
}

async function writeEnvsJsonRaw(entries: RawEnvEntry[]): Promise<void> {
  const dir = join(process.env.HOME || homedir(), '.log10x');
  await fs.mkdir(dir, { recursive: true });
  const content = JSON.stringify(entries, null, 2) + '\n';
  await fs.writeFile(envsJsonPath(), content, { mode: 0o600 });
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function executeSetGitopsRepo(
  args: SetGitopsRepoArgs
): Promise<string | StructuredOutput> {
  let entries: RawEnvEntry[];
  try {
    entries = await readEnvsJsonRaw();
  } catch (e) {
    const msg = (e as Error).message;
    return buildEnvelope({
      tool: 'log10x_set_gitops_repo',
      view: 'summary',
      summary: { headline: `set_gitops_repo failed: ${msg}` },
      data: { ok: false, error: msg },
      actions: [
        {
          tool: 'log10x_configure_env',
          args: {},
          role: 'required-next',
          reason: 'No envs.json yet — create the first env entry. set_gitops_repo can then update its gitops.repo field.',
        },
      ],
    });
  }

  if (entries.length === 0) {
    const msg =
      'envs.json is empty — run log10x_configure_env first to register an env, then set gitops_repo on it.';
    return buildEnvelope({
      tool: 'log10x_set_gitops_repo',
      view: 'summary',
      summary: { headline: `set_gitops_repo refused: ${msg}` },
      data: { ok: false, error: msg },
    });
  }

  // Resolve target entry by nickname or default.
  let targetIdx: number;
  if (args.environment) {
    targetIdx = entries.findIndex((e) => e.nickname === args.environment);
    if (targetIdx === -1) {
      const names = entries.map((e) => e.nickname ?? '(unnamed)').join(', ');
      const msg = `No env named "${args.environment}" found in ${envsJsonPath()}. Known envs: ${names}`;
      return buildEnvelope({
        tool: 'log10x_set_gitops_repo',
        view: 'summary',
        summary: { headline: `set_gitops_repo refused: env not found` },
        data: { ok: false, error: msg },
      });
    }
  } else if (entries.length === 1) {
    targetIdx = 0;
  } else {
    // Multiple entries — find the default.
    targetIdx = entries.findIndex((e) => e.isDefault === true);
    if (targetIdx === -1) {
      const names = entries.map((e) => e.nickname ?? '(unnamed)').join(', ');
      const msg =
        `Multiple envs found (${names}) and none is marked isDefault. ` +
        'Pass `environment` to specify which env to update, or set one as the default via log10x_configure_env first.';
      return buildEnvelope({
        tool: 'log10x_set_gitops_repo',
        view: 'summary',
        summary: { headline: `set_gitops_repo refused: ambiguous target` },
        data: { ok: false, error: msg },
      });
    }
  }

  const target = entries[targetIdx];
  const nickname = target.nickname ?? `entry[${targetIdx}]`;
  const prevGitops = target.gitops;

  // Write the gitops field.
  const newGitops: { repo: string; lookupPath?: string } = {
    repo: args.gitops_repo,
  };
  if (args.gitops_lookup_path) {
    newGitops.lookupPath = args.gitops_lookup_path;
  }

  entries[targetIdx] = { ...target, gitops: newGitops };

  try {
    await writeEnvsJsonRaw(entries);
  } catch (e) {
    const msg = (e as Error).message;
    return buildEnvelope({
      tool: 'log10x_set_gitops_repo',
      view: 'summary',
      summary: { headline: `set_gitops_repo failed: could not write envs.json` },
      data: { ok: false, error: `write envs.json: ${msg}` },
    });
  }

  const action = prevGitops ? 'updated' : 'set';
  const lookupNote = newGitops.lookupPath
    ? ` lookup path: \`${newGitops.lookupPath}\``
    : '';
  const headline =
    `gitops.repo ${action} to \`${args.gitops_repo}\`${lookupNote} on env "${nickname}".`;

  return buildEnvelope({
    tool: 'log10x_set_gitops_repo',
    view: 'summary',
    summary: { headline },
    data: {
      ok: true,
      action,
      nickname,
      gitops_repo: args.gitops_repo,
      gitops_lookup_path: newGitops.lookupPath ?? null,
      envs_json_path: envsJsonPath(),
      previous_gitops_repo: prevGitops?.repo ?? null,
      restart_required: true,
      human_summary: [
        headline,
        '',
        `envs.json written at ${envsJsonPath()}.`,
        'The MCP server must restart to pick up the change.',
        'Run log10x_dev_restart, or restart the MCP server process manually.',
        'After restart, retry log10x_configure_engine — it will resolve gitops_repo from the updated env.',
      ].join('\n'),
    },
  });
}
