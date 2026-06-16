/**
 * Symbol-placement resolution.
 *
 * Maps the "detect the receiver's active symbol source, then place into it"
 * model (docs/COMPILE-LINK-DISTRIBUTION-DESIGN.md §4-§5) onto a concrete
 * target, from declarative state on the env config.
 *
 * Phase 1 is DECLARATIVE only: it reads `env.symbolSource` (and falls back to
 * `env.gitops.repo` for the `git` backend) plus any explicit tool args. Live
 * kubectl introspection of the deployed pod (initContainer image -> git, PVC
 * mount -> volume, GH_ENABLED -> @github, ...) is a documented follow-up - this
 * function takes only the resolved EnvConfig so it stays pure/unit-testable
 * with no cluster reach.
 *
 * The output's `liveness` is the load-bearing field: shipped reporter/receiver
 * deployments do NOT hot-reload symbols by default (the reload unit is wired,
 * but `@github` is off and delivery is one-time), so `git`+`init` resolves to
 * `rollout` - `place_symbols` must emit a rollout-restart after the commit.
 * Only an explicit `syncMode: 'github'` (the opt-in live loop) yields
 * `hot-reload`.
 */

import { type EnvConfig } from '../environments.js';

export type PlacementBackend = 'git' | 'pvc' | 'configmap' | 'baked';

/** Folder inside the repo where the `.10x.tar` lands, when none is given. */
export const DEFAULT_SYMBOL_FOLDER = 'symbols';

/** Explicit per-call overrides (all optional; each beats the env config). */
export interface PlacementArgs {
  backend?: PlacementBackend;
  repo?: string;
  branch?: string;
  path?: string;
}

export interface ResolvedPlacement {
  backend: PlacementBackend;
  /** owner/repo for `git` (undefined => caller must surface a "need repo" gate). */
  repo?: string;
  /** Branch to commit to (undefined => the script resolves the repo default). */
  branch?: string;
  /** Folder in the repo for the `.10x.tar`. Always set (defaults to `symbols`). */
  folder: string;
  /** How a running pod picks up the change. */
  syncMode: 'init' | 'github';
  /**
   * `hot-reload` only when `syncMode === 'github'` (the opt-in live loop);
   * otherwise a pod rollout is required after placement.
   */
  liveness: 'hot-reload' | 'rollout';
  /** Where the resolved `repo` came from, for transparency in the result. */
  repoSource: 'arg' | 'symbolSource' | 'gitops' | 'none';
  /** Human-readable resolution notes / caveats for the result envelope. */
  notes: string[];
}

/**
 * Resolve a placement target from explicit args layered over the env's
 * declarative `symbolSource` (+ `gitops.repo` fallback for `git`). Pure.
 */
export function resolvePlacement(env: EnvConfig, args: PlacementArgs): ResolvedPlacement {
  const ss = env.symbolSource;
  const backend: PlacementBackend = args.backend ?? ss?.backend ?? 'git';

  let repo: string | undefined;
  let repoSource: ResolvedPlacement['repoSource'] = 'none';
  if (args.repo) {
    repo = args.repo;
    repoSource = 'arg';
  } else if (ss?.repo) {
    repo = ss.repo;
    repoSource = 'symbolSource';
  } else if (env.gitops?.repo) {
    repo = env.gitops.repo;
    repoSource = 'gitops';
  }

  const branch = args.branch ?? ss?.branch;
  const folder = (args.path ?? ss?.path ?? DEFAULT_SYMBOL_FOLDER).replace(/^\/+|\/+$/g, '');
  const syncMode: 'init' | 'github' = ss?.syncMode ?? 'init';
  const liveness: ResolvedPlacement['liveness'] = syncMode === 'github' ? 'hot-reload' : 'rollout';

  const notes: string[] = [];
  if (backend === 'git') {
    if (!repo) {
      notes.push(
        'No git repo resolved. Pass `repo` (owner/name), set `symbolSource.repo` or ' +
          '`gitops.repo` in ~/.log10x/envs.json (e.g. via log10x_set_gitops_repo), or set ' +
          'LOG10X_GH_REPO on the MCP server.',
      );
    } else if (repoSource === 'gitops') {
      notes.push(
        `Using the gitops policy repo (${repo}) for symbols too - symbols go under ` +
          `\`${folder}/\`, separate from the caps/lookup files. Set \`symbolSource.repo\` to split them.`,
      );
    }
    if (liveness === 'rollout') {
      notes.push(
        'Shipped deployments do not hot-reload symbols (the @github live loop is off by ' +
          'default), so a pod rollout-restart is required after the commit for the change to ' +
          'take effect. Set `symbolSource.syncMode: "github"` once the @github loop + a ' +
          '`symbols/*.10x.tar` glob are enabled to switch to hot-reload.',
      );
    }
  } else if (backend === 'baked') {
    notes.push(
      'The deployed receiver reads symbols baked into its image - there is no runtime ' +
        'placement target. Rebuild/retag the image with the new library, or switch the ' +
        'deployment to a `git`/`pvc` symbol source.',
    );
  } else {
    notes.push(
      `Backend "${backend}" is not implemented yet (Phase 2/3 in the design doc). Use ` +
        '`git` for now, or place the .10x.tar onto the PVC / ConfigMap out of band.',
    );
  }

  return { backend, repo, branch, folder, syncMode, liveness, repoSource, notes };
}
