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

import { DATADOG_FLEX_LIST_PRICING } from './cost.js';

// ─── public types ─────────────────────────────────────────────────────────────

/** Datadog Standard indexing at list, 15-day retention, $ per million events. */
export const DATADOG_STANDARD_LIST_USD_PER_MILLION = DATADOG_FLEX_LIST_PRICING.standard_index_usd_per_million_events;

/**
 * Per-severity rules the tick applies. Compaction is not one of them: it is a
 * per-source switch (the sidecar's `optimize` flag), set at install from a
 * measured ratio, not a per-pattern row the tick writes.
 */
export type SeverityAction = 'keep' | 'auto' | 'drop' | 'sample';

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
  /**
   * Budget policies only: where the run writes the Receiver's files.
   *   'configmap' — the policy ConfigMap the Receiver reads (in-cluster CronJob).
   *   'gitops'    — `repo`, for the engine's gitops pull.
   */
  delivery?: 'configmap' | 'gitops';
  /** Namespace of the policy ConfigMap (configmap delivery). Default: the pod's namespace. */
  namespace?: string;
  /** Name of the policy ConfigMap (configmap delivery). Default: log10x-action-intent. */
  configmap?: string;
  /** Gitops delivery: the branch the run commits to directly and the engine pulls. Default: log10x-policy. */
  policy_branch?: string;
}

/**
 * A Datadog Standard indexing budget held month to date (the budget run).
 * X is the whole account's Standard bill.
 */
export interface DollarBudget {
  /** X: dollars a month of Standard indexing, the whole account. */
  usd_monthly: number;
  /** The account's Standard indexing rate, $ per million events. */
  standard_usd_per_million: number;
  /** Index names that bill as Standard. Empty: every index counts. */
  standard_indexes: string[];
  /** Error lines over a limit that pass per statement per node per window. */
  keep_count: number;
  /** Where a service's lines over its limit go when it names none. */
  default_action: 'tier_down' | 'offload';
  /** Per-service destination for lines over the limit. */
  service_actions: Record<string, 'tier_down' | 'offload'>;
  /**
   * Dollars a month of Standard for a named service (the container), held
   * month to date against its own number. The rest of the account is held
   * to usd_monthly minus their sum.
   */
  service_budgets: Record<string, ServiceBudget>;
  /** Nodes each service's pods run on, when the run cannot discover them (gitops delivery). */
  nodes_by_container: Record<string, number>;
  /** Receivers in the fleet, for the `*` row, when the run cannot discover them. */
  nodes_total?: number;
}

/**
 * An Elasticsearch hot tier held under a size (the hot-tier run). The run
 * reads the hot nodes' store and the Receiver's own indices every hour and
 * rewrites the per-statement limits, in bytes, so growth goes to the frozen
 * tier instead of filling hot.
 */
export interface HotTierBudget {
  /** S in GB of index store on the hot nodes; undefined: `capacity_share` of their disk. */
  gb?: number;
  /** Share of the hot nodes' disk to hold under when `gb` is not set. Default 0.8 (Elasticsearch's low watermark is 85%). */
  capacity_share: number;
  /** Hours a kept line stays on hot; default read from the ILM policy on the kept alias. */
  retention_hours?: number;
  /** Write alias of the kept lines (routeState pass). */
  pass_alias: string;
  /** Write alias of the tier_down lines, rolled to frozen by ILM. */
  tier_down_alias: string;
  /** Field holding the container in the Receiver's documents. */
  container_field: string;
  /** Error lines over a limit that pass per statement per node per window. */
  keep_count: number;
  default_action: 'tier_down' | 'offload';
  service_actions: Record<string, 'tier_down' | 'offload'>;
  nodes_by_container: Record<string, number>;
  nodes_total?: number;
}

/** A named service's own number, and the `service` tag Datadog's usage metric carries for it. */
export interface ServiceBudget {
  usd: number;
  /** Default: the container name. */
  datadog_service: string;
}

/** As written: `payments: 4000`, or `payments: {usd: 4000, datadog_service: payments-api}`. */
export type ServiceBudgetInput = number | { usd: number; datadog_service?: string };

export interface Policy {
  schema_version: string;

  // ── reduction config ────────────────────────────────────────────────
  /** Services the policy targets. Empty = all services. */
  target_services: string[];
  /** Desired savings target (1-95). */
  target_percent: number;
  /**
   * VOLUME BUDGET (thermostat): keep monthly ingest for the targeted scope at
   * or under this many GB/mo. When present it REPLACES target_percent as the
   * tick's goal: the tick scales the budget to its lookback window and cuts
   * only the overage — already under budget means every pattern passes.
   */
  budget_gb_monthly?: number;
  /**
   * DOLLAR BUDGET on Datadog Standard indexing, held month to date. When
   * present the tick is the budget run (caps, actions, totals per service),
   * not the mute-list tick.
   */
  budget_usd?: DollarBudget;
  /**
   * HOT-TIER BUDGET on Elasticsearch: hold the hot nodes' store under a size.
   * When present the tick is the hot-tier run (caps, actions, totals in bytes).
   */
  hot_tier?: HotTierBudget;
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
  const rawDelivery = typeof cp?.['delivery'] === 'string' ? cp['delivery'].trim() : '';
  if (rawDelivery && rawDelivery !== 'configmap' && rawDelivery !== 'gitops') {
    throw new PolicyLoadError(`config_plane.delivery must be configmap or gitops; got: ${rawDelivery}`);
  }
  const delivery = rawDelivery ? (rawDelivery as 'configmap' | 'gitops') : undefined;
  const cmNamespace = typeof cp?.['namespace'] === 'string' ? cp['namespace'].trim() || undefined : undefined;
  const cmName = typeof cp?.['configmap'] === 'string' ? cp['configmap'].trim() || undefined : undefined;
  const policyBranch = typeof cp?.['policy_branch'] === 'string' ? cp['policy_branch'].trim() || undefined : undefined;
  if (!repo && delivery !== 'configmap') {
    throw new PolicyLoadError(
      'policy.yaml is missing config_plane.repo: the tick needs a gitops repo or s3:// prefix to write CSVs'
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

  // budget_gb_monthly (volume thermostat — wins over target_percent)
  const rawBudget = red?.['budget_gb_monthly'];
  const budget_gb_monthly =
    typeof rawBudget === 'string'
      ? parseFloat(rawBudget)
      : typeof rawBudget === 'number'
      ? rawBudget
      : undefined;
  if (budget_gb_monthly !== undefined && (!Number.isFinite(budget_gb_monthly) || budget_gb_monthly <= 0)) {
    throw new PolicyLoadError(
      `budget_gb_monthly must be a positive number of GB per month; got: ${rawBudget}`
    );
  }
  const budget_usd = parseDollarBudget(red);
  const hot_tier = parseHotTier(red);
  if (hot_tier && (budget_usd || budget_gb_monthly !== undefined || red?.['target_percent'] !== undefined)) {
    throw new PolicyLoadError(
      'reduction carries hot_tier_gb with budget_usd_monthly, budget_gb_monthly or target_percent: they are different goals. Keep exactly one.'
    );
  }
  if (budget_usd && (budget_gb_monthly !== undefined || red?.['target_percent'] !== undefined)) {
    throw new PolicyLoadError(
      'reduction carries budget_usd_monthly with budget_gb_monthly or target_percent: they are different goals. Keep exactly one.'
    );
  }
  if (delivery === 'configmap' && !budget_usd && !hot_tier) {
    throw new PolicyLoadError('config_plane.delivery: configmap is the budget run\'s delivery; it needs reduction.budget_usd_monthly or reduction.hot_tier_gb.');
  }
  if (budget_gb_monthly !== undefined && red?.['target_percent'] !== undefined) {
    throw new PolicyLoadError(
      'reduction carries BOTH budget_gb_monthly and target_percent: they are different goals (a standing line vs a one-shot cut). Keep exactly one.'
    );
  }

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
    'keep', 'auto', 'drop', 'sample',
  ]);
  if (rawSev && typeof rawSev === 'object') {
    for (const [sev, action] of Object.entries(rawSev)) {
      if (typeof action === 'string' && VALID_SEVERITY_ACTIONS.has(action)) {
        (severity_rules as Record<string, SeverityAction>)[sev.toUpperCase()] =
          action as SeverityAction;
      } else if (action === 'compact') {
        // A rule written for the per-pattern compact row the tick no longer
        // writes. The intent was lossless, so the severity is kept, never
        // sampled or dropped under `auto`; compaction is the sidecar's
        // optimize flag.
        (severity_rules as Record<string, SeverityAction>)[sev.toUpperCase()] = 'keep';
        process.stderr.write(
          `[tenx-recur] severity_rules.${sev}: "compact" is not a tick action; the severity is kept. ` +
            'Compaction is the sidecar\'s optimize flag, set at install.\n'
        );
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
    ...(budget_gb_monthly !== undefined ? { budget_gb_monthly } : {}),
    ...(budget_usd ? { budget_usd } : {}),
    ...(hot_tier ? { hot_tier } : {}),
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
      ...(budget_usd || hot_tier ? { delivery: delivery ?? (repo ? 'gitops' : 'configmap') } : {}),
      ...(cmNamespace !== undefined ? { namespace: cmNamespace } : {}),
      ...(cmName !== undefined ? { configmap: cmName } : {}),
      ...(policyBranch !== undefined ? { policy_branch: policyBranch } : {}),
    },
  };
}

function positiveNumber(raw: unknown): number | undefined {
  const v = typeof raw === 'string' ? parseFloat(raw) : typeof raw === 'number' ? raw : undefined;
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined;
}

function countMap(raw: unknown, field: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = positiveNumber(v);
    if (n === undefined || !Number.isInteger(n)) {
      throw new PolicyLoadError(`${field}.${k} must be a whole number of nodes above 0; got: ${String(v)}`);
    }
    out[k] = n;
  }
  return out;
}

/** True when `service_budgets` names at least one service; an empty map names none. */
function hasNamedServices(raw: unknown): boolean {
  if (raw === undefined || raw === '' || raw === '{}') return false;
  return !(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0);
}

const BUDGET_ACTIONS: ReadonlySet<string> = new Set(['tier_down', 'offload']);

/** The shared limit settings of a budget block: keep count, actions, node counts. */
function budgetCommon(red: Record<string, unknown> | undefined): Pick<HotTierBudget, 'keep_count' | 'default_action' | 'service_actions' | 'nodes_by_container' | 'nodes_total'> {
  const rawK = red?.['keep_count'];
  const k = rawK === undefined ? 50 : typeof rawK === 'string' ? Number(rawK) : typeof rawK === 'number' ? rawK : NaN;
  if (!Number.isInteger(k) || k < 0) {
    throw new PolicyLoadError(`keep_count must be a whole number of lines, 0 or more; got: ${String(rawK)}`);
  }
  const rawAction = red?.['default_action'];
  const default_action = rawAction === undefined ? 'tier_down' : String(rawAction);
  if (!BUDGET_ACTIONS.has(default_action)) {
    throw new PolicyLoadError(`default_action must be tier_down or offload; got: ${default_action}`);
  }
  const service_actions: Record<string, 'tier_down' | 'offload'> = {};
  const rawSa = red?.['service_actions'];
  if (rawSa && typeof rawSa === 'object' && !Array.isArray(rawSa)) {
    for (const [svc, a] of Object.entries(rawSa as Record<string, unknown>)) {
      if (typeof a !== 'string' || !BUDGET_ACTIONS.has(a)) {
        throw new PolicyLoadError(`service_actions.${svc} must be tier_down or offload; got: ${String(a)}`);
      }
      service_actions[svc] = a as 'tier_down' | 'offload';
    }
  }
  const nodes_total = red?.['nodes_total'] === undefined ? undefined : countMap({ nodes_total: red['nodes_total'] }, 'reduction').nodes_total;
  return {
    keep_count: k,
    default_action: default_action as 'tier_down' | 'offload',
    service_actions,
    nodes_by_container: countMap(red?.['nodes_by_container'], 'nodes_by_container'),
    ...(nodes_total !== undefined ? { nodes_total } : {}),
  };
}

function nonEmptyString(raw: unknown, field: string, dflt: string): string {
  if (raw === undefined) return dflt;
  if (typeof raw !== 'string' || raw.trim() === '') throw new PolicyLoadError(`${field} must be a non-empty string; got: ${JSON.stringify(raw)}`);
  return raw.trim();
}

/**
 * The hot-tier block of `reduction` (`hot_tier_gb: <GB>` or `hot_tier_gb: auto`),
 * or undefined when the policy has none.
 */
function parseHotTier(red: Record<string, unknown> | undefined): HotTierBudget | undefined {
  const raw = red?.['hot_tier_gb'];
  if (raw === undefined) return undefined;
  const auto = typeof raw === 'string' && raw.trim().toLowerCase() === 'auto';
  const gb = auto ? undefined : positiveNumber(raw);
  if (!auto && gb === undefined) {
    throw new PolicyLoadError(`hot_tier_gb must be a positive number of GB, or auto for a share of the hot nodes' disk; got: ${String(raw)}`);
  }
  const rawShare = red?.['hot_tier_share'];
  const share = rawShare === undefined ? 0.8 : positiveNumber(rawShare);
  if (share === undefined || share >= 1) {
    throw new PolicyLoadError(`hot_tier_share must be a number above 0 and below 1; got: ${String(rawShare)}`);
  }
  const rawR = red?.['hot_retention_hours'];
  const retention = rawR === undefined ? undefined : positiveNumber(rawR);
  if (rawR !== undefined && retention === undefined) {
    throw new PolicyLoadError(`hot_retention_hours must be a positive number of hours; got: ${String(rawR)}`);
  }
  return {
    ...(gb !== undefined ? { gb } : {}),
    capacity_share: share,
    ...(retention !== undefined ? { retention_hours: retention } : {}),
    pass_alias: nonEmptyString(red?.['pass_alias'], 'pass_alias', 'tenx-app'),
    tier_down_alias: nonEmptyString(red?.['tier_down_alias'], 'tier_down_alias', 'tenx-tierdown'),
    container_field: nonEmptyString(red?.['container_field'], 'container_field', 'kubernetes.container_name'),
    ...budgetCommon(red),
  };
}

/** The dollar budget block of `reduction`, or undefined when the policy has none. */
function parseDollarBudget(red: Record<string, unknown> | undefined): DollarBudget | undefined {
  const raw = red?.['budget_usd_monthly'];
  if (raw === undefined) {
    if (hasNamedServices(red?.['service_budgets'])) {
      throw new PolicyLoadError('service_budgets needs budget_usd_monthly: each named number is part of the account\'s Standard budget.');
    }
    return undefined;
  }
  const usd = positiveNumber(raw);
  if (usd === undefined) {
    throw new PolicyLoadError(`budget_usd_monthly must be a positive number of dollars a month; got: ${String(raw)}`);
  }
  const rawRate = red?.['standard_rate_per_million'];
  const rate = rawRate === undefined ? DATADOG_STANDARD_LIST_USD_PER_MILLION : positiveNumber(rawRate);
  if (rate === undefined) {
    throw new PolicyLoadError(`standard_rate_per_million must be a positive number of dollars; got: ${String(rawRate)}`);
  }
  const rawIdx = red?.['standard_indexes'];
  const standard_indexes = Array.isArray(rawIdx)
    ? rawIdx.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
    : [];
  if (standard_indexes.length === 0) {
    throw new PolicyLoadError(
      'budget_usd_monthly needs standard_indexes: the Datadog index names that bill as Standard. Datadog\'s usage metric does not separate Flex from Standard, so without them Flex lines would count as spend.'
    );
  }
  const rawK = red?.['keep_count'];
  const k = rawK === undefined ? 50 : typeof rawK === 'string' ? Number(rawK) : typeof rawK === 'number' ? rawK : NaN;
  if (!Number.isInteger(k) || k < 0) {
    throw new PolicyLoadError(`keep_count must be a whole number of lines, 0 or more; got: ${String(rawK)}`);
  }
  const rawAction = red?.['default_action'];
  const default_action = rawAction === undefined ? 'tier_down' : String(rawAction);
  if (!BUDGET_ACTIONS.has(default_action)) {
    throw new PolicyLoadError(`default_action must be tier_down or offload; got: ${default_action}`);
  }
  const service_actions: Record<string, 'tier_down' | 'offload'> = {};
  const rawSa = red?.['service_actions'];
  if (rawSa && typeof rawSa === 'object' && !Array.isArray(rawSa)) {
    for (const [svc, a] of Object.entries(rawSa as Record<string, unknown>)) {
      if (typeof a !== 'string' || !BUDGET_ACTIONS.has(a)) {
        throw new PolicyLoadError(`service_actions.${svc} must be tier_down or offload; got: ${String(a)}`);
      }
      service_actions[svc] = a as 'tier_down' | 'offload';
    }
  }
  const service_budgets: Record<string, ServiceBudget> = {};
  const rawSb = red?.['service_budgets'] === '{}' ? {} : red?.['service_budgets'];
  if (rawSb !== undefined && (!rawSb || typeof rawSb !== 'object' || Array.isArray(rawSb))) {
    throw new PolicyLoadError('service_budgets must map each service to dollars a month, e.g. payments: 4000.');
  }
  for (const [svc, v] of Object.entries((rawSb ?? {}) as Record<string, unknown>)) {
    const obj = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    const n = positiveNumber(obj ? obj['usd'] : v);
    if (n === undefined) {
      throw new PolicyLoadError(`service_budgets.${svc} must be a positive number of dollars a month; got: ${String(obj ? obj['usd'] : v)}`);
    }
    const rawDd = obj?.['datadog_service'];
    if (rawDd !== undefined && (typeof rawDd !== 'string' || rawDd.trim() === '')) {
      throw new PolicyLoadError(`service_budgets.${svc}.datadog_service must be the service name Datadog tags it with; got: ${JSON.stringify(rawDd)}`);
    }
    service_budgets[svc] = { usd: n, datadog_service: typeof rawDd === 'string' ? rawDd.trim() : svc };
  }
  const exceptions = Array.isArray(red?.['exceptions']) ? (red['exceptions'] as unknown[]).filter((s): s is string => typeof s === 'string') : [];
  const problem = serviceBudgetsProblem(service_budgets, usd, exceptions);
  if (problem) throw new PolicyLoadError(problem);
  const nodes_total = red?.['nodes_total'] === undefined ? undefined : countMap({ nodes_total: red['nodes_total'] }, 'reduction').nodes_total;
  return {
    usd_monthly: usd,
    standard_usd_per_million: rate,
    standard_indexes,
    keep_count: k,
    default_action: default_action as 'tier_down' | 'offload',
    service_actions,
    service_budgets,
    nodes_by_container: countMap(red?.['nodes_by_container'], 'nodes_by_container'),
    ...(nodes_total !== undefined ? { nodes_total } : {}),
  };
}

/**
 * Why a set of per-service budgets cannot be held, or undefined when it can:
 * their sum must leave something of X for the rest of the account, and a
 * service the policy never touches cannot be held to a number.
 */
export function serviceBudgetsProblem(
  budgets: Record<string, ServiceBudgetInput | ServiceBudget>,
  usdMonthly: number | undefined,
  exceptions: readonly string[],
): string | undefined {
  const named = Object.keys(budgets);
  if (named.length === 0) return undefined;
  if (usdMonthly === undefined) return 'service_budgets needs budget_usd_monthly: each named number is part of the account\'s Standard budget.';
  const sum = named.reduce((a, s) => a + serviceBudgetUsd(budgets[s]), 0);
  if (named.length > 0 && sum >= usdMonthly) {
    return `service_budgets add up to ${sum} dollars a month, which leaves nothing of budget_usd_monthly (${usdMonthly}) for the rest of the account. Their sum must be under it.`;
  }
  const byDatadogName = new Map<string, string[]>();
  for (const c of named) {
    const b = budgets[c];
    const dd = (typeof b === 'number' ? '' : b.datadog_service?.trim() ?? '') || c;
    byDatadogName.set(dd, [...(byDatadogName.get(dd) ?? []), c]);
  }
  const shared = [...byDatadogName].find(([, cs]) => cs.length > 1);
  if (shared) {
    return `${shared[1].join(' and ')} in service_budgets both read Datadog's spend for service:${shared[0]}, so each would be charged the other's lines. Give each its own datadog_service.`;
  }
  const both = named.filter((s) => exceptions.includes(s));
  if (both.length > 0) {
    return `${both.join(', ')} ${both.length === 1 ? 'is' : 'are'} in both service_budgets and exceptions: an exception is never touched, so it cannot be held to a number. Keep each service in one.`;
  }
  return undefined;
}

export function serviceBudgetUsd(b: ServiceBudgetInput | ServiceBudget): number {
  return typeof b === 'number' ? b : b.usd;
}
