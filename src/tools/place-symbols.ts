/**
 * log10x_place_symbols - deliver a compiled `.10x.tar` symbol library to where
 * a deployed receiver/reporter retrieves symbols.
 *
 * The producer (`log10x_compile` / `_status` / `_link`) writes a linked
 * `.10x.tar` to a local pinned folder; this tool is the delivery leg. It
 * follows the "detect the receiver's symbol source, then place into it" model
 * (docs/COMPILE-LINK-DISTRIBUTION-DESIGN.md §4-§9).
 *
 * Phase 1 implements the `git` backend: it EMITS a `gh` script that commits the
 * tar to the user's GitHub repo (the same Contents-API + base64 pattern
 * `configure_engine` uses for cap-CSVs) and opens a PR. The MCP does not run
 * `gh` itself - the agent runs the emitted script where a write-scoped `gh` is
 * available. Because shipped deployments do not hot-reload symbols by default,
 * the result also instructs a `kubectl rollout restart` so the one-time
 * init-container re-clones - unless the env declares the live `@github`
 * (`syncMode: 'github'`) loop, in which case it hot-reloads on the next poll.
 *
 * `pvc` / `configmap` / `baked` backends are later phases; this tool returns a
 * clear "use git / not yet" envelope for them.
 */

import { promises as fs } from 'node:fs';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { buildEnvelope, type Action, type StructuredOutput } from '../lib/output-types.js';
import { type EnvConfig } from '../lib/environments.js';
import { resolvePlacement } from '../lib/symbol-placement/detect.js';
import { renderSymbolPlacementScript } from '../lib/symbol-placement/git.js';

const TOOL = 'log10x_place_symbols';

/** GitHub Contents API gets unreliable for large blobs; warn past this, hard-fail near 100 MB. */
const CONTENTS_API_WARN_BYTES = 50 * 1024 * 1024;

export const placeSymbolsSchema = {
  library_path: z
    .string()
    .describe(
      'Absolute path to the compiled .10x.tar symbol library to deliver - the linked artifact from log10x_compile / log10x_compile_status (data.payload.output.library_files[].path) or log10x_compile_link. Must be the .10x.tar, not a .10x.json unit or the units folder.',
    ),
  environment: z
    .string()
    .optional()
    .describe('Env nickname (from ~/.log10x/envs.json) whose symbolSource / gitops repo to target. Omit for the default env.'),
  backend: z
    .enum(['git', 'pvc', 'configmap', 'baked'])
    .optional()
    .describe(
      'Delivery backend. Omit to resolve from the env\'s symbolSource (default: git). Only `git` is implemented in this phase; `pvc`/`configmap`/`baked` return guidance.',
    ),
  repo: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, 'Must be owner/repo, e.g. acme/log10x-config.')
    .optional()
    .describe('GitHub owner/repo override for backend=git. Falls back to symbolSource.repo, then gitops.repo, then LOG10X_GH_REPO.'),
  branch: z
    .string()
    .optional()
    .describe('Branch to commit to. Omit to use the repo default branch.'),
  path: z
    .string()
    .optional()
    .describe('Folder inside the repo for the .10x.tar (default "symbols"). The receiver\'s symbols.git path / @github glob must match this.'),
  open_pr: z
    .boolean()
    .default(true)
    .describe('Open a PR after committing (true), or just push the commit branch (false).'),
};

interface PlaceSymbolsArgs {
  library_path: string;
  environment?: string;
  backend?: 'git' | 'pvc' | 'configmap' | 'baked';
  repo?: string;
  branch?: string;
  path?: string;
  open_pr: boolean;
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'symbols';
}

function humanByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorEnvelope(headline: string, data: Record<string, unknown>, actions: Action[] = []): StructuredOutput {
  return buildEnvelope({
    tool: TOOL,
    view: 'summary',
    summary: { headline },
    data: { ok: false, ...data },
    actions,
  });
}

export async function executePlaceSymbols(
  args: PlaceSymbolsArgs,
  env: EnvConfig,
): Promise<string | StructuredOutput> {
  // ── 1. Validate the library artifact ──
  const libPath = resolve(args.library_path);
  let size: number;
  try {
    const st = await fs.stat(libPath);
    if (!st.isFile()) {
      return errorEnvelope(`place_symbols: library_path is not a file: ${libPath}.`, {
        error: 'library_path must be a .10x.tar file (the linked library), not a directory.',
      });
    }
    size = st.size;
  } catch {
    return errorEnvelope(`place_symbols: library_path does not exist: ${libPath}.`, {
      error: 'Pass the .10x.tar produced by log10x_compile (data.payload.output.library_files[].path).',
    });
  }
  if (!libPath.endsWith('.10x.tar')) {
    return errorEnvelope(`place_symbols: expected a .10x.tar, got ${basename(libPath)}.`, {
      error:
        'Point library_path at the linked .10x.tar library, not a .10x.json unit or the units folder. ' +
        'If you only have units, run log10x_compile_link first to produce the .10x.tar.',
    });
  }

  // ── 2. Resolve the placement target (declarative) ──
  const placement = resolvePlacement(env, {
    backend: args.backend,
    repo: args.repo,
    branch: args.branch,
    path: args.path,
  });

  // ── 3. Non-git backends: clear guidance (later phases) ──
  if (placement.backend !== 'git') {
    return errorEnvelope(
      `place_symbols: backend "${placement.backend}" is not available yet - use git.`,
      {
        backend: placement.backend,
        notes: placement.notes,
        library_path: libPath,
      },
    );
  }

  // ── 4. git backend: need a repo ──
  if (!placement.repo) {
    return errorEnvelope('place_symbols: no GitHub repo resolved for the git backend.', {
      backend: 'git',
      notes: placement.notes,
      library_path: libPath,
    }, [
      {
        tool: 'log10x_set_gitops_repo',
        args: { confirm: 'set-now' },
        reason: 'register the GitHub repo to commit symbols to (symbolSource.repo falls back to gitops.repo)',
        role: 'recommended-next',
      },
    ]);
  }

  // ── 5. Render the gh placement script ──
  const fileName = basename(libPath);
  const prBranch = `mcp/place-symbols-${slug(fileName)}-${Date.now()}`;
  const message = `place symbols: ${fileName}`;
  const script = renderSymbolPlacementScript({
    libraryPath: libPath,
    fileName,
    target: { repo: placement.repo, branch: placement.branch, folder: placement.folder },
    prBranch,
    openPr: args.open_pr,
    message,
  });

  const warnings: string[] = [];
  if (size > CONTENTS_API_WARN_BYTES) {
    warnings.push(
      `Library is ${humanByteSize(size)} - the GitHub Contents API is unreliable above ~50 MB and ` +
        'rejects files near 100 MB. Consider narrowing symbol.types/test filters at compile time, or a ' +
        'PVC backend for very large libraries.',
    );
  }
  warnings.push('The emitted script needs `gh` authenticated with write (Contents + PR) access to the repo.');

  // ── 6. Additive reassurance + rollout vs hot-reload guidance ──
  // symbol.paths is a LIST, so this ADDS the custom library; the bundled default
  // (the ~150 common frameworks baked into the *-10x image) stays on the path.
  const additiveNote =
    'This is additive: the engine keeps the default symbol library bundled in its image and reads ' +
    'this custom one too (symbol.paths is a list). The only way to lose the default is to override the ' +
    'whole config dir via config.git - keep symbol delivery separate from full-config delivery.';
  const branchNote = placement.branch ? `branch \`${placement.branch}\`` : 'the default branch';
  const rolloutHint =
    'kubectl rollout restart -n <namespace> daemonset/<reporter-release>   ' +
    '# Receiver sidecar: restart the forwarder Deployment instead';
  const liveNote =
    placement.liveness === 'hot-reload'
      ? 'The deployment declares the live `@github` loop (syncMode=github), so the receiver hot-reloads ' +
        'the new library on its next poll (~1 min) - no restart needed.'
      : 'Shipped deployments do not hot-reload symbols, so after the commit lands you must roll the ' +
        `receiver/reporter so its init-container re-clones:\n\n    ${rolloutHint}`;

  const headline =
    `Placement script ready: commit ${fileName} (${humanByteSize(size)}) to ${placement.repo} ` +
    ` -> \`${placement.folder}/\` on ${branchNote}` +
    (placement.liveness === 'hot-reload' ? ' (hot-reload).' : ' (then rollout-restart).');

  const human_summary = [
    headline,
    '',
    placement.notes.length > 0 ? placement.notes.join('\n') + '\n' : '',
    'Run this script (needs `gh` with write access to the repo):',
    '',
    '```bash',
    script,
    '```',
    '',
    liveNote,
    '',
    additiveNote,
  ]
    .filter((l) => l !== undefined)
    .join('\n');

  const actions: Action[] = [];

  return buildEnvelope({
    tool: TOOL,
    view: 'summary',
    summary: { headline },
    data: {
      ok: true,
      backend: 'git',
      repo: placement.repo,
      branch: placement.branch ?? null,
      folder: placement.folder,
      dest_path: `${placement.folder}/${fileName}`,
      repo_source: placement.repoSource,
      sync_mode: placement.syncMode,
      liveness: placement.liveness,
      rollout_required: placement.liveness === 'rollout',
      rollout_hint: placement.liveness === 'rollout' ? rolloutHint : null,
      open_pr: args.open_pr,
      pr_branch: prBranch,
      library_path: libPath,
      library_bytes: size,
      file_name: fileName,
      additive: true,
      preserves_default_library: true,
      script,
      notes: placement.notes,
      human_summary,
    },
    actions,
    warnings,
  });
}
