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

/** A single step the user (or a subagent) should execute. */
export interface PlanStep {
  title: string;
  /** One-line purpose for the step. */
  rationale: string;
  /** Commands to run, in order. Each is a shell string the user pastes verbatim. */
  commands: string[];
  /**
   * Optional YAML/config blob to write to disk. The command list may
   * reference the resulting filename.
   */
  file?: { path: string; contents: string; language: 'yaml' | 'ini' | 'conf' | 'json' | 'toml' };
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
 * MCP-managed runtime config updates (today: the Regulator's
 * compactRegulator). Renders between Install and Verify.
 *
 * The mechanism: a GitHub-pull module inside the engine fetches the
 * customer's config repo on a schedule, drops it into a temp dir,
 * adds that dir to the engine's working folders. The
 * ResourceReloadUnit watches files there: CSV changes hot-reload
 * via FileResourceLookup.reset() (no pipeline restart); .js / .yaml
 * changes call restartPipeline().
 *
 * The MCP's log10x_advise_compact tool authors PRs against the
 * customer repo. Once merged, the engine picks up the change on the
 * next poll. End-to-end seconds, no redeploy.
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
  app: 'reporter' | 'regulator' | 'retriever';
  /** Snapshot the plan was built against. */
  snapshotId: string;
  /** Target forwarder (for reporter/regulator). Unused by retriever. */
  forwarder?: ForwarderKind;
  /** Target helm release name. */
  releaseName: string;
  /** Target namespace. */
  namespace: string;
  /** Kubernetes context the plan targets, for display. */
  context?: string;
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
   * updates. Set for app=regulator; omitted for reporter/retriever.
   */
  gitopsExplainer?: GitopsExplainer;
}
