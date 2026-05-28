/**
 * Shared types for the install-advisor render layer.
 *
 * The advise tools all produce an `AdvisePlan` — a structured, agent-
 * consumable breakdown of preflight checks, install commands, verify
 * probes, and teardown. The same shape is rendered to markdown by
 * `renderPlan()` so every advisor produces a visually-consistent
 * report.
 */

import type { ForwarderKind } from '../discovery/types.js';

/** The action the advisor was asked to produce guidance for. */
export type AdviseAction = 'install' | 'verify' | 'teardown' | 'all';

/** A single preflight check — a pre-install sanity probe. */
export interface PreflightCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'unknown';
  detail: string;
}

/** A single file emitted as part of an install step. */
export interface PlanFile {
  path: string;
  contents: string;
  language: 'yaml' | 'ini' | 'conf' | 'json' | 'toml' | 'bash' | 'batch';
  /**
   * When true, the user must `chmod +x` the file before running the
   * commands that reference it. The renderer surfaces a chmod hint
   * automatically; the script itself is still emitted verbatim.
   */
  executable?: boolean;
}

/** A single step the user (or a subagent) should execute. */
export interface PlanStep {
  title: string;
  /** One-line purpose for the step. */
  rationale: string;
  /** Commands to run, in order. Each is a shell string the user pastes verbatim. */
  commands: string[];
  /**
   * Optional single config blob to write to disk. The command list may
   * reference the resulting filename. Most steps emit at most one file;
   * use `files` (plural) when a step needs to write more than one
   * (e.g. the Fluentd Receiver overlay emits a values.yaml + a
   * kustomize/ directory of patches and post-render scripts).
   *
   * A step should set EITHER `file` OR `files`, not both. `files` wins
   * if both are set.
   */
  file?: PlanFile;
  /** Optional multi-file emit. See `file` above for the convention. */
  files?: PlanFile[];
  /** If set, this step should succeed within this many seconds. Used for `wait` commands. */
  expectDurationSec?: number;
}

/** One verify probe — a specific fact we're checking is true after install. */
export interface VerifyProbe {
  name: string;
  /** One-line question being answered ("Are Reporter pods ready?"). */
  question: string;
  /** Commands that, collectively, answer the question. */
  commands: string[];
  /**
   * Regex (as a string) the command output should match for success.
   * Optional — the advisor surfaces this so a subagent can grade its own
   * output without asking the model to interpret prose.
   */
  expectOutput?: string;
  /** Max wall time to wait for this probe to pass (seconds). */
  timeoutSec?: number;
}

/**
 * Optional GitOps section for install plans whose app supports
 * MCP-managed runtime config updates (today: the Receiver's
 * compactReceiver). Renders between Install and Verify.
 *
 * The mechanism: a GitHub-pull module inside the engine fetches the
 * customer's config repo on a schedule, drops it into a temp dir,
 * adds that dir to the engine's working folders. The
 * ResourceReloadUnit watches files there: CSV changes hot-reload
 * via FileResourceLookup.reset() (no pipeline restart); .js / .yaml
 * changes call restartPipeline().
 *
 * The MCP's log10x_configure_compact and log10x_configure_regulator
 * tools author PRs against the customer repo. Once merged, the engine
 * picks up the change on the next poll. End-to-end seconds, no redeploy.
 */
export interface GitopsExplainer {
  /** Headline — one sentence describing the value prop. */
  headline: string;
  /** When the user would want this enabled. */
  whenToEnable: string[];
  /** When the user can skip this. */
  whenToSkip: string[];
  /**
   * Repo-relative paths the MCP / customer authors. Renders as a
   * stylized tree.
   */
  repoLayout: { path: string; comment: string }[];
  /**
   * Pod env vars (or helm values keys) the customer sets. Each
   * `value` is a literal default the customer pastes in.
   */
  envVars: { name: string; value: string; required: boolean; note?: string }[];
  /** MCP tool to call once GitOps is wired. */
  mcpHandoff: { tool: string; example: string };
  /** Caveats / known gaps the customer should be aware of. */
  caveats: string[];
}

/**
 * The complete plan. Keep the shape narrow so the render layer and the
 * subagent-dogfooding harness can both consume it structurally.
 */
export interface AdvisePlan {
  /** Which app this plan installs. */
  app: 'reporter' | 'receiver' | 'retriever';
  /** Snapshot the plan was built against. */
  snapshotId: string;
  /** Target forwarder (for reporter/receiver). Unused by retriever. */
  forwarder?: ForwarderKind;
  /** Target helm release name. */
  releaseName: string;
  /** Target namespace. */
  namespace: string;
  /** Kubernetes context the plan targets, for display. */
  context?: string;
  /**
   * License kind the plan ships with. Surfaces directly into the typed
   * envelope (AdvisePlanSummary.license_kind) so agents don't have to
   * parse notes to know whether the install is demo-grade or real.
   *   - 'user-scoped' — real license minted from /api/v1/license
   *   - 'demo'        — anonymous 14-day demo license
   *   - 'user-pasted' — user supplied via license_jwt_paste; opaque
   *   - 'placeholder' — REPLACE_WITH_LICENSE_JWT (skipInstall mode or
   *     license fetch deferred)
   */
  licenseKind?: 'user-scoped' | 'demo' | 'user-pasted' | 'placeholder';
  /**
   * How the helm command lands:
   *   - 'upgrade-existing' — `helm upgrade --reuse-values <release>` against
   *     the user's existing forwarder Helm release. Sidecar overlay layers
   *     on top of their values. NO second forwarder is deployed. Receiver
   *     path's canonical mode.
   *   - 'fresh-release'   — `helm upgrade --install <new-release> --create-namespace`.
   *     New release name + namespace. Used by the Reporter path (parallel
   *     DaemonSet by design) and by Receiver as a fallback when no helm-
   *     managed forwarder is detected.
   */
  installMode?: 'upgrade-existing' | 'fresh-release';
  /**
   * When installMode === 'upgrade-existing', the detected existing
   * release name (same as `releaseName`). Surfaced separately so the
   * agent can flag "this UPGRADES X" without needing to compare fields.
   */
  existingHelmRelease?: { name: string; namespace: string };
  /** Preflight checks the advisor ran against the snapshot. */
  preflight: PreflightCheck[];
  /** Install steps (ordered). */
  install: PlanStep[];
  /** Verify probes (ordered). */
  verify: VerifyProbe[];
  /** Teardown steps (ordered). */
  teardown: PlanStep[];
  /** Freeform notes the advisor wants to surface above the steps. */
  notes: string[];
  /**
   * If the plan is incomplete (e.g., missing required input), the
   * advisor fills blockers instead of throwing. The CTA becomes
   * "provide X and re-run".
   */
  blockers: string[];
  /**
   * Optional GitOps section explaining MCP-managed runtime config
   * updates. Set for app=receiver; omitted for reporter/retriever.
   */
  gitopsExplainer?: GitopsExplainer;
}
