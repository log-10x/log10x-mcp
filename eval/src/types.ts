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
