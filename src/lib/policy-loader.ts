/**
 * Policy loader — parses and validates a `policy.yaml` file for the
 * `tenx-recur` CLI tick runner.
 *
 * The schema mirrors what `scheduler-manifest-emitter.ts` emits via
 * `emitPolicyYaml()`. Validation is intentionally lenient — unknown fields
 * are ignored so policies written by newer versions of the setup wizard
 * still load correctly on an older CLI binary.
 *
 * Minimal YAML parser note: we parse the policy.yaml with a hand-rolled
 * line-by-line parser rather than pulling in a heavy YAML library.  The
 * policy format is simple (no anchors, no multi-document, no block
 * scalars) so this is safe and keeps the dependency footprint small.
 *
 * Policy shape (all fields with defaults):
 *
 *   schema_version: "1.0"
 *
 *   reduction:
 *     target_services: []          # empty = all services
 *     target_percent: 30           # integer 1-95
 *     exceptions: []               # service names never touched
 *     min_delta_pp: 2              # minimum savings change before commit
 *     lookback_window: "24h"       # PromQL range for the volume query
 *     severity_rules:              # per-severity action overrides
 *       ERROR: keep                # kept at floor regardless of volume
 *       INFO: auto                 # auto = apply cost policy
 *       DEBUG: auto
 *       WARN: auto
 *
 *   schedule:
 *     preset: daily-03utc
 *     cron_utc: "0 3 * * *"
 *     scheduler: k8s_cron
 *
 *   config_plane:
 *     repo: https://github.com/acme/log10x-config
 *     env_id: <optional>
 */

// ─── public types ─────────────────────────────────────────────────────────────

export type SeverityAction = 'keep' | 'auto' | 'drop' | 'sample' | 'compact';

export interface SeverityRules {
  ERROR?: SeverityAction;
  CRITICAL?: SeverityAction;
  WARN?: SeverityAction;
  INFO?: SeverityAction;
  DEBUG?: SeverityAction;
  TRACE?: SeverityAction;
}

export interface ConfigPlane {
  /**
   * URL or local filesystem path to the customer gitops config repo.
   * The CLI clones/pulls from here, writes updated CSVs, and opens a PR
   * (or pushes directly, depending on the `commit_strategy` field below).
   */
  repo: string;
  /**
   * Log10x env ID — scopes the PromQL metric queries.
   * Falls back to LOG10X_ENV_ID when absent.
   */
  env_id?: string;
  /**
   * How the CLI commits changes.
   *   'pr'          — open a GitHub PR via `gh pr create` (default).
   *   'direct_push' — push directly to the specified branch.
   */
  commit_strategy?: 'pr' | 'direct_push';
  /** Branch to push to (direct_push) or base branch for the PR. Default: main. */
  base_branch?: string;
}

export interface Policy {
  schema_version: string;

  // ── reduction config ────────────────────────────────────────────────
  /** Services the policy targets. Empty = all services. */
  target_services: string[];
  /** Desired savings target (1-95). */
  target_percent: number;
  /** Services the policy must never touch. */
  exceptions: string[];
  /**
   * Minimum change (percentage points) before a new CSV is committed.
   * Prevents noisy churn on small week-to-week fluctuations.
   */
  min_delta_pp: number;
  /**
   * PromQL range window for the volume query (e.g. "24h", "7d").
   * This is the lookback the tick uses when calling top_patterns.
   */
  lookback_window: string;
  /** Per-severity action overrides. */
  severity_rules: SeverityRules;

  // ── schedule (informational — the tick runner ignores this; cron
  //    scheduling is handled by the external scheduler) ────────────────
  cron_utc?: string;
  scheduler?: string;

  // ── config_plane ────────────────────────────────────────────────────
  config_plane: ConfigPlane;
}

// ─── defaults ─────────────────────────────────────────────────────────────────

const POLICY_DEFAULTS: Omit<Policy, 'config_plane'> = {
  schema_version: '1.0',
  target_services: [],
  target_percent: 30,
  exceptions: [],
  min_delta_pp: 2,
  lookback_window: '24h',
  severity_rules: {
    ERROR: 'keep',
    CRITICAL: 'keep',
    WARN: 'auto',
    INFO: 'auto',
    DEBUG: 'auto',
    TRACE: 'auto',
  },
};

// ─── parse errors ─────────────────────────────────────────────────────────────

export class PolicyLoadError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PolicyLoadError';
  }
}

// ─── YAML parser ──────────────────────────────────────────────────────────────

/**
 * Very small subset YAML parser sufficient for the policy.yaml shape.
 *
 * Limitations (all intentional — policy.yaml never uses these):
 *   - No anchors/aliases
 *   - No multi-document streams
 *   - No block scalars (| or >)
 *   - No flow sequences inside mappings except `[]`
 *   - Inline comments after values are not stripped (not needed — generated
 *     YAML from emitPolicyYaml puts comments on their own lines)
 *
 * Returns a plain JS object tree: string | string[] | Record<string, unknown>
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const root: Record<string, unknown> = {};

  // Stack tracks the nesting level.  Each entry describes the mapping that owns
  // key-value pairs at this indent level:
  //   - `obj`      : the Record that deeper mapping keys are written into.
  //   - `owner`    : the parent Record that holds this frame's seed key (only
  //                  set for frames opened by an empty-value key).
  //   - `ownerKey` : the key in `owner` that this frame seeds.  A following
  //                  block-sequence (`- item`) promotes `owner[ownerKey]` from
  //                  the placeholder mapping into an array.
  const stack: Array<{
    indent: number;
    obj: Record<string, unknown>;
    owner?: Record<string, unknown>;
    ownerKey?: string;
  }> = [{ indent: -1, obj: root }];

  for (const raw of lines) {
    // Skip blank lines and comment-only lines.
    const trimmed = raw.trimEnd();
    if (!trimmed || trimmed.trimStart().startsWith('#')) continue;

    const indent = trimmed.length - trimmed.trimStart().length;
    const content = trimmed.trimStart();

    const isListItem = content.startsWith('- ');

    // Pop stack until we're at the right level.  A block-sequence item (`- `)
    // may sit one indent level deeper than its owning key, or at the SAME
    // indent (YAML allows both).  For list items keep the owning frame on the
    // stack when its indent equals the item's indent (`>` pop); for mapping
    // keys pop frames at the same-or-greater indent (`>=` pop).
    while (
      stack.length > 1 &&
      (isListItem
        ? stack[stack.length - 1].indent > indent
        : stack[stack.length - 1].indent >= indent)
    ) {
      stack.pop();
    }

    const frame = stack[stack.length - 1];
    const parent = frame.obj;

    // List item — promote the owning key's placeholder mapping into an array
    // and append.  Items resolve against the frame opened by their owning key.
    if (isListItem) {
      const val = content.slice(2).trim();
      const strippedVal = stripInlineComment(stripQuotes(val));
      const owner = frame.owner;
      const ownerKey = frame.ownerKey;
      if (owner === undefined || ownerKey === undefined) {
        // A `- item` with no preceding key to own it — malformed; skip safely.
        continue;
      }
      if (!Array.isArray(owner[ownerKey])) {
        owner[ownerKey] = [];
      }
      (owner[ownerKey] as string[]).push(strippedVal);
      continue;
    }

    // Empty list shorthand: `key: []`
    const colonIdx = content.indexOf(':');
    if (colonIdx < 0) continue;

    const key = content.substring(0, colonIdx).trim();
    const rest = content.substring(colonIdx + 1).trim();

    if (rest === '[]') {
      parent[key] = [];
      continue;
    }

    if (rest === '' || rest.startsWith('#')) {
      // This key starts a sub-object OR will be followed by block-sequence
      // items.  Seed it with an empty mapping and push a frame whose `obj` is
      // that child (so nested mapping keys land inside it) while remembering
      // `owner`/`ownerKey` so a following `- item` promotes it to an array.
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, obj: child, owner: parent, ownerKey: key });
      continue;
    }

    // Scalar value
    const val = stripInlineComment(stripQuotes(rest));
    parent[key] = val;
  }

  return root;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function stripInlineComment(s: string): string {
  // Only strip ` #…` when a space precedes the `#`.
  const idx = s.indexOf(' #');
  return idx >= 0 ? s.substring(0, idx).trimEnd() : s;
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Parse a `policy.yaml` string into a validated `Policy` object.
 *
 * Missing fields receive sensible defaults so policies written by an older
 * setup wizard still load without error. The only required field is
 * `config_plane.repo` — the tick has nowhere to write without it.
 *
 * @throws PolicyLoadError on structural problems (missing repo, out-of-range
 *         target_percent, negative min_delta_pp, etc.).
 */
export function parsePolicyYaml(text: string): Policy {
  if (!text || !text.trim()) {
    throw new PolicyLoadError('policy.yaml is empty');
  }

  let raw: Record<string, unknown>;
  try {
    raw = parseSimpleYaml(text);
  } catch (err) {
    throw new PolicyLoadError('failed to parse policy.yaml', err);
  }

  // ── config_plane ────────────────────────────────────────────────────
  const cp = raw['config_plane'] as Record<string, unknown> | undefined;
  const repo = typeof cp?.['repo'] === 'string' ? cp['repo'].trim() : '';
  if (!repo) {
    throw new PolicyLoadError(
      'policy.yaml is missing config_plane.repo — the tick needs a gitops repo to write CSVs'
    );
  }
  const env_id =
    typeof cp?.['env_id'] === 'string' ? cp['env_id'].trim() || undefined : undefined;
  const rawStrategy = typeof cp?.['commit_strategy'] === 'string' ? cp['commit_strategy'] : 'pr';
  const commit_strategy: 'pr' | 'direct_push' =
    rawStrategy === 'direct_push' ? 'direct_push' : 'pr';
  const base_branch =
    typeof cp?.['base_branch'] === 'string' ? cp['base_branch'].trim() || undefined : undefined;

  // ── reduction section ────────────────────────────────────────────────
  const red = raw['reduction'] as Record<string, unknown> | undefined;

  // target_services: array of strings
  const rawSvcs = red?.['target_services'];
  const target_services: string[] = Array.isArray(rawSvcs)
    ? rawSvcs.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    : [];

  // target_percent
  const rawPct = red?.['target_percent'];
  const target_percent =
    typeof rawPct === 'string'
      ? parseInt(rawPct, 10)
      : typeof rawPct === 'number'
      ? Math.round(rawPct)
      : POLICY_DEFAULTS.target_percent;
  if (!Number.isFinite(target_percent) || target_percent < 1 || target_percent > 95) {
    throw new PolicyLoadError(
      `target_percent must be an integer 1-95; got: ${rawPct}`
    );
  }

  // exceptions
  const rawExc = red?.['exceptions'];
  const exceptions: string[] = Array.isArray(rawExc)
    ? rawExc.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    : [];

  // min_delta_pp
  const rawDelta = red?.['min_delta_pp'];
  const min_delta_pp =
    typeof rawDelta === 'string'
      ? parseInt(rawDelta, 10)
      : typeof rawDelta === 'number'
      ? Math.round(rawDelta)
      : POLICY_DEFAULTS.min_delta_pp;
  if (!Number.isFinite(min_delta_pp) || min_delta_pp < 0) {
    throw new PolicyLoadError(
      `min_delta_pp must be a non-negative integer; got: ${rawDelta}`
    );
  }

  // lookback_window
  const rawLookback = red?.['lookback_window'];
  const lookback_window =
    typeof rawLookback === 'string' && /^\d+[smhd]$/.test(rawLookback)
      ? rawLookback
      : POLICY_DEFAULTS.lookback_window;

  // severity_rules
  const rawSev = red?.['severity_rules'] as Record<string, unknown> | undefined;
  const severity_rules: SeverityRules = { ...POLICY_DEFAULTS.severity_rules };
  const VALID_SEVERITY_ACTIONS: ReadonlySet<string> = new Set([
    'keep', 'auto', 'drop', 'sample', 'compact',
  ]);
  if (rawSev && typeof rawSev === 'object') {
    for (const [sev, action] of Object.entries(rawSev)) {
      if (typeof action === 'string' && VALID_SEVERITY_ACTIONS.has(action)) {
        (severity_rules as Record<string, SeverityAction>)[sev.toUpperCase()] =
          action as SeverityAction;
      }
    }
  }

  // ── schedule (informational) ─────────────────────────────────────────
  const sched = raw['schedule'] as Record<string, unknown> | undefined;
  const cron_utc =
    typeof sched?.['cron_utc'] === 'string' ? sched['cron_utc'] : undefined;
  const scheduler =
    typeof sched?.['scheduler'] === 'string' ? sched['scheduler'] : undefined;

  return {
    schema_version:
      typeof raw['schema_version'] === 'string' ? raw['schema_version'] : '1.0',
    target_services,
    target_percent,
    exceptions,
    min_delta_pp,
    lookback_window,
    severity_rules,
    cron_utc,
    scheduler,
    config_plane: {
      repo,
      ...(env_id !== undefined ? { env_id } : {}),
      commit_strategy,
      ...(base_branch !== undefined ? { base_branch } : {}),
    },
  };
}
