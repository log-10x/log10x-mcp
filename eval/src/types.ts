/**
 * Shared types for the eval harness.
 *
 * Both the deterministic and autonomous runners produce artifacts in these
 * shapes, so judging, reporting, and diffing work the same regardless of mode.
 */

import { z } from 'zod';

// ── Scenario fixture (input) ──────────────────────────────────────────

export const groundTruthAssertionSchema = z.discriminatedUnion('matcher_kind', [
  z.object({
    matcher_kind: z.literal('contains'),
    description: z.string(),
    scope: z.enum(['tool_result', 'final_text', 'tool_call_args']),
    tool: z.string().optional(),
    value: z.string(),
    case_insensitive: z.boolean().optional(),
  }),
  z.object({
    matcher_kind: z.literal('regex'),
    description: z.string(),
    scope: z.enum(['tool_result', 'final_text', 'tool_call_args']),
    tool: z.string().optional(),
    pattern: z.string(),
    flags: z.string().optional(),
  }),
  z.object({
    matcher_kind: z.literal('numeric_range'),
    description: z.string(),
    scope: z.enum(['tool_result', 'final_text', 'tool_call_args']),
    tool: z.string().optional(),
    extract: z.string(), // regex with one capturing group
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    matcher_kind: z.literal('rank_at_least'),
    description: z.string(),
    scope: z.enum(['tool_result', 'final_text', 'tool_call_args']),
    tool: z.string().optional(),
    pattern: z.string(),
    max_rank: z.number().int().positive(),
  }),
]);
export type GroundTruthAssertion = z.infer<typeof groundTruthAssertionSchema>;

export const scenarioSchema = z.object({
  /** Slug; must match filename (without .json). */
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string(),
  description: z.string(),
  prompt: z.string(),

  /** Required for deterministic mode — there's no LLM to pick a first tool. */
  initial_tool: z.object({
    tool: z.string(),
    args: z.record(z.unknown()),
    reason: z.string(),
  }),

  /** Defaults merged into every tool call's args (e.g. force demo env). */
  tool_arg_defaults: z.record(z.unknown()).optional(),

  expected_sequence: z.object({
    must_include: z.array(z.string()),
    must_not_include: z.array(z.string()).optional(),
    tolerance: z.number().int().nonnegative().default(1),
  }),

  ground_truth: z.array(groundTruthAssertionSchema),

  quality_criteria: z.object({
    reasoning: z.number().min(0).max(1),
    value: z.number().min(0).max(1),
    autonomy: z.number().min(0).max(1),
    hallucination_max: z.number().min(0).max(1),
  }),

  optimal_steps: z.number().int().positive(),
  max_steps: z.number().int().positive().default(12),
  error_policy: z.enum(['stop', 'continue']).default('continue'),

  /** Receiver-specific assertions (compact mode, readonly/readwrite). */
  receiver_assertions: z
    .object({
      expected_mode: z.enum(['readonly', 'readwrite']).optional(),
      expected_optimize: z.boolean().optional(),
      must_emit_chart_field: z.array(z.string()).optional(),
    })
    .optional(),

  /**
   * Pre-supplied answers for wizard-style tools (currently log10x_advise_install)
   * so the deterministic runner can satisfy `next_question` envelopes the
   * same way an LLM would in autonomous mode. When the wizard emits an
   * action with a literal `"<user answer>"` placeholder at any top-level
   * arg, the runner substitutes `wizard_answers[<that_key>]` before
   * enqueueing the call. Autonomous mode ignores this block — Sonnet
   * supplies its own answers from the user prompt.
   *
   * Key = the wizard's `answer_field` (e.g. "app", "backends", "airgapped").
   * Value = whatever shape the schema expects (string / array / boolean).
   */
  wizard_answers: z.record(z.unknown()).optional(),

  tags: z.array(z.string()).default([]),
});
export type Scenario = z.infer<typeof scenarioSchema>;

// ── Step log (per-step trace) ─────────────────────────────────────────

export interface StepLog {
  step: number;
  kind: 'tool_call' | 'cycle_skipped' | 'unknown_tool' | 'terminate';
  tool?: string;
  args?: unknown;
  durationMs?: number;
  isError?: boolean;
  resultBytes?: number;
  nextActionsFound?: number;
  reason?: string;
  outcome?: string;
  totalSteps?: number;
}

// ── Run report (output) ────────────────────────────────────────────────

export type RunOutcome =
  | 'completed'
  | 'max_steps'
  | 'tool_error'
  | 'unknown_tool'
  | 'inconclusive';

export interface JudgeVerdict {
  model: string;
  scoresRaw: {
    tool_selection: number;
    parameters: number;
    sequencing: number;
    accuracy: number;
    hallucination: number;
    follow_through: number;
  };
  rationale: Record<string, string>;
  flags: string[];
}

export interface AutonomyMetrics {
  /** Total mcp__log10x__* tool calls. */
  toolCallCount: number;
  /** optimal_steps from scenario. */
  optimalSteps: number;
  /** True when the agent's final text contains a stall-marker (e.g. "would you like me to"). */
  stalled: boolean;
  /** NEXT_ACTIONS that were emitted by tools but never followed. */
  abandonedNextActions: number;
  /** 0..1 score: 1.0 if steps == optimal and no stalls; degrades with overshoots and stalls. */
  score: number;
}

export interface SequenceDiff {
  expected: string[];
  actual: string[];
  missing: string[];
  extra: string[];
  mustNotIncludeViolations: string[];
  /** true if must_include subsequence is satisfied within tolerance. */
  satisfied: boolean;
}

export interface GroundTruthResult {
  description: string;
  matcher_kind: GroundTruthAssertion['matcher_kind'];
  passed: boolean;
  detail: string;
}

export interface RunReport {
  scenarioId: string;
  scenarioTitle: string;
  mode: 'deterministic' | 'autonomous';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  transcriptPath: string;
  stepLogPath: string;
  outcome: RunOutcome;
  totalSteps: number;
  scores: {
    tool_selection: number; // 0-2
    parameters: number; // 0-2
    sequencing: number; // 0-2
    accuracy: number; // 0-2
    hallucination: number; // 0-1 (1 = bad, 0 = none)
    follow_through: number; // 0-2
    /** Derived: avg(tool_selection, parameters, sequencing) / 2, normalized 0..1. */
    reasoning: number;
    /** Derived: avg(accuracy, follow_through) / 2, normalized 0..1. */
    value: number;
    /** From AutonomyMetrics.score, 0..1. */
    autonomy: number;
  };
  groundTruth: GroundTruthResult[];
  sequenceDiff: SequenceDiff;
  autonomyMetrics: AutonomyMetrics;
  judgeVerdict: JudgeVerdict | null;
  passedCriteria: boolean;
  /** Free-form flags surfaced for diff-runs.mjs (e.g. 'upstream_rate_limit'). */
  flags: string[];
}

// ── Anti-hallucination campaign types (CAMPAIGN.md) ───────────────────

/**
 * Pre-computed expected answer for a hero question. Populated by
 * `bin/refresh-expected.mjs` from the latest oracle snapshot. The
 * sub-agent's actual synthesis is compared against this — strict
 * pattern-name matching, plus must_mention / must_not_mention checks,
 * plus a tool-chain alignment check on the bash trace.
 */
export interface ExpectedAnswer {
  /** One-sentence ground truth derivable from the oracle snapshot. */
  summary: string;
  /**
   * Top patterns the agent is expected to surface, ranked. Pulled from
   * a PromQL query at fixture-refresh time.
   */
  top_patterns: Array<{
    name: string;
    bytes_24h?: number;
    severity?: string;
    service?: string;
  }>;
  /** Substrings the synthesis must contain (oracle-traceable facts). */
  must_mention?: string[];
  /** Substrings indicating hallucination. */
  must_not_mention?: string[];
  /** Tool names that must appear in the bash trace, in order. */
  expected_tool_chain?: string[];
  /** Category-specific expected fields (severity split, namespaces, freshness). */
  expected_severity_split?: Record<string, number>;
  expected_namespaces?: Array<{ name: string; bytes_24h: number }>;
  expected_freshness_seconds?: { edge?: number; cloud?: number };
  /** The exact PromQL the oracle uses to verify; refreshable. */
  expected_oracle_query?: string;
  /** Timestamp of the snapshot this was computed from. */
  snapshot_ts?: string;
  /**
   * Refusal calibration (Step 7 of the deeper-harness plan). When
   * true, the question is out of MCP scope: PASS = the agent's
   * synthesis explicitly refuses or scopes-out; FAIL = the agent
   * fabricates. Treats `top_patterns` and `must_mention` as
   * inapplicable.
   */
  refusal_required?: boolean;
  /**
   * Phrases that count as a valid refusal. If `refusal_required` is
   * true and none of these appear in the synthesis, the run fails
   * the refusal axis. Defaults to a safe baseline below.
   */
  refusal_phrases?: string[];
  /**
   * Prompt-injection resistance (Step 8 of the deeper-harness
   * plan). The synthesis must NOT emit any of these substrings
   * (the injected output the attacker tried to coerce).
   */
  injection_must_not_emit?: string[];
  /**
   * LLM-classifier axis. When non-empty, the scorer makes ONE
   * Sonnet call asking it to classify the agent's synthesis on
   * the axes listed in `enable_llm_classifier_axes`. Each axis is
   * a yes/no or enum question against the oracle's ground truth;
   * a mismatch is recorded as drift. Closes shapes that
   * deterministic checks cannot catch (direction inversion,
   * window confusion, narrative rearrangement, citation drift).
   *
   * Cost: ~$0.05 per scenario. Opt-in per spec.
   */
  enable_llm_classifier_axes?: Array<
    | 'direction'        // expected_direction must equal classified direction
    | 'window'           // expected_window must equal classified window
    | 'narrative_frame'  // facts framed correctly vs rearranged
    | 'citation'         // sources attributed correctly
    | 'refusal'          // refusal scenario: did the agent refuse OR fabricate?
  >;
  /** When `direction` axis is enabled, the expected direction. */
  expected_direction?: 'UP' | 'FLAT' | 'DOWN';
  /** When `window` axis is enabled, the window the question asks about. */
  expected_window?: string;
}

/**
 * Hero specification with optional expected_answer block. The campaign
 * extends the original hero shape (id/title/prompt/persona/budget) with
 * the structured ground truth so scoring is no longer "is this
 * plausible" but "does this match the pre-computed answer".
 */
export interface CampaignHeroSpec {
  id: string;
  title: string;
  category: 'cost' | 'error-levels' | 'stability';
  prompt: string;
  persona?: string;
  budget_hint?: string;
  expected_answer?: ExpectedAnswer;
}

/**
 * Top-N pattern-match score: how many of the agent's named patterns
 * are in the oracle's top-N, vs how many oracle patterns the agent
 * never mentioned.
 */
export interface PatternMatchScore {
  agent_top_patterns: string[];
  oracle_top_patterns: string[];
  matched: number;
  missed: number;
  extra: number;
  /** matched / max(matched + missed, 1) — 0..1. */
  score: number;
}

/**
 * Tool-chain alignment: does the bash trace include the
 * expected_tool_chain in order?
 */
export interface ChainAlignmentScore {
  expected: string[];
  actual: string[];
  hits: string[];
  misses: string[];
  /** hits.length / max(expected.length, 1) — 0..1. */
  score: number;
}

/**
 * Five-axis verdict for a hero run. Replaces the older 3-axis
 * (drift/value-delivered/value-received) verdict.
 */
export interface CampaignVerdict {
  drift_score: number;
  drift_supported: number;
  drift_inconclusive: number;
  pattern_match: PatternMatchScore;
  chain_alignment: ChainAlignmentScore;
  value_delivered: number;
  value_received: number;
  /** Overall PASS gate: drift=0 AND pattern_match≥0.7 AND chain≥0.7 AND value_delivered≥0.7. */
  passed: boolean;
  /** Human-readable axes summary. */
  axes_summary: string;
}

/**
 * Persistent gap record. One JSON file holds an array of these in
 * eval/gaps/gaps.json. Survives compaction; loaded at every campaign
 * start, appended on each run that produces a failure.
 */
export interface GapRecord {
  question_id: string;
  run_timestamp: string;
  gap_kind:
    | 'drift'
    | 'pattern_miss'
    | 'chain_miss'
    | 'low_value'
    | 'low_received'
    | 'over_eager_fabrication'  // refusal_required scenario; agent fabricated instead
    | 'injection_complied'      // prompt-injection scenario; agent emitted forbidden substring
    | 'classifier_mismatch';    // LLM classifier disagrees with expected direction/window/frame/citation
  gap_description: string;
  expected_answer_excerpt: string;
  actual_answer_excerpt: string;
  fix_status: 'open' | 'in_progress' | 'fixed' | 'wontfix';
  fix_commit?: string;
  fix_verified_run_ts?: string;
  notes: string[];
}

// ── Anthropic-shape transcript events (subset we write) ───────────────

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: Array<{ type: 'text'; text: string }>;
      is_error?: boolean;
    };

export interface TranscriptEvent {
  type: 'user' | 'assistant';
  message: {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
    stop_reason?: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence';
  };
  agentId?: string;
}

// ── Counterfactual injection harness types ────────────────────────────

/**
 * One synthetic-event injection. The generator emits events per
 * `generator_spec`; the harness then runs each `sensitive_scenarios`
 * scenario and checks the predicted metric + agent-behavior deltas.
 *
 * Schema source-of-truth: `eval/counterfactual/specs/*.json`.
 */
export interface CounterfactualSpec {
  id: string;
  description: string;
  target_env: 'talw_gx' | 'otel_demo';
  generator_spec: {
    /** Template body. Supports `${pod}`, `${run_id}`, `${idx}`. */
    template: string;
    severity: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
    /** Service name; convention: prefix with `canary-` so synthetic
     *  events are filterable. */
    service: string;
    rate_per_second: number;
    duration_seconds: number;
    extra_tags?: Record<string, string>;
  };
  /** Seconds to wait between generator-exit and post-snapshot, to
   *  allow Reporter aggregation + Prometheus scrape. 60-120 typical. */
  propagation_seconds: number;
  sensitive_scenarios: Array<{
    scenario_id: string;
    predicted_metric_delta: {
      top_patterns_added?: string[];
      severity_bytes_increase_at_least?: { severity: string; bytes: number };
      newly_emerged_contains?: string;
      service_appears?: string;
    };
    predicted_agent_behavior: {
      must_call_tool?: string[];
      must_mention_correlation?: string[];
      must_not_fabricate_root_cause?: boolean;
    };
  }>;
}

/**
 * Per-scenario verdict for a counterfactual run. Three layers
 * (metric / agent / synthesis), each independently scored, plus an
 * overall pass.
 */
export interface CounterfactualVerdict {
  spec_id: string;
  scenario_id: string;
  run_id: string;
  metric_layer: {
    predicted_satisfied: boolean;
    observed: Record<string, unknown>;
    notes: string[];
  };
  agent_layer: {
    predicted_satisfied: boolean;
    tools_called: string[];
    mentions_found: string[];
    mentions_missing: string[];
    notes: string[];
  };
  synthesis_layer: {
    passed: boolean;
    axes_summary: string;
  };
  passed: boolean;
  /** ISO timestamp the verdict was emitted. */
  emitted_at: string;
}
