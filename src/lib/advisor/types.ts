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
 * The complete plan. Keep the shape narrow so the render layer and the
 * subagent-dogfooding harness can both consume it structurally.
 */
export interface AdvisePlan {
  /** Which app this plan installs. */
  app: 'reporter' | 'regulator' | 'streamer';
  /** Snapshot the plan was built against. */
  snapshotId: string;
  /** Target forwarder (for reporter/regulator). Unused by streamer. */
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
}
