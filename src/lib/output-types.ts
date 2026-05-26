/**
 * StructuredOutput envelope — the canonical response shape for every
 * default-loaded analysis tool (the "11 lean-on tools" subset in the
 * JSON-by-default catalog).
 *
 * Contract:
 *   - `view: "summary"` (default) returns the typed `data` block plus
 *     a `summary.headline` line the agent uses as default render.
 *   - `view: "markdown"` returns `data.markdown: string` carrying the
 *     pre-rendered artifact; `wrap()` in src/index.ts pulls that
 *     through to the MCP text channel verbatim.
 *
 * Why this shape:
 *   - JSON-by-default is the architectural choice (see
 *     /Users/talweiss/.claude/plans/so-the-q-is-mutable-ladybug.md).
 *   - `actions[]` carries the next-callable tool IDs so the agent
 *     can chain without guessing the catalog graph.
 *   - `render_hint` lets surfaces with rich rendering (chart,
 *     callouts) consume the same `data` without the tool author
 *     committing to one presentation.
 *   - `truncated` + `next_cursor` for list-returning tools.
 *   - `schema_epoch` carries the deploy boundary; engine-derived
 *     IDs (template_hash, tenx_hash) are only stable within an
 *     epoch. Agents that cache action args across an epoch
 *     boundary see a mismatch from `wrap()` and re-fetch upstream.
 */

import { z } from 'zod';

/** Bumped when the envelope shape itself changes. */
export const SCHEMA_VERSION = '1.0' as const;

/**
 * Bumped per-deploy when engine-derived ID encoding changes (templater
 * rebuild, symbolMessage normalizer change, tenx_hash function change).
 * Kept simple: an ISO date string. Agents do not parse it; they just
 * compare for equality across calls.
 */
export const SCHEMA_EPOCH = '2026-05-25' as const;

/**
 * Uniform view enum across all default-loaded tools. Per-tool
 * extensions (e.g. POC's "yaml" / "configs") stay tool-local and do
 * not conform to this enum.
 */
export const ViewEnum = z.enum(['summary', 'markdown']).default('summary');
export type View = z.infer<typeof ViewEnum>;

/**
 * Next-tool chaining hint. Agent reads `actions[]` and decides which
 * to follow up with. `args` is a partial — the agent fills in the
 * caller-supplied bits before invoking.
 */
export const ActionSchema = z.object({
  tool: z.string(),
  args: z.record(z.unknown()).default({}),
  reason: z.string(),
});
export type Action = z.infer<typeof ActionSchema>;

/**
 * Optional rendering hints for surfaces that support richer output
 * than a JSON-ish text block. Stage 1 emits ASCII sparkline only;
 * Stage 2 may upgrade to MCP image content when
 * `clientCapabilities.image === true`.
 */
export const RenderHintSchema = z
  .object({
    chart: z.enum(['sparkline', 'timeseries', 'bar', 'none']).optional(),
    units: z.string().optional(),
    callouts: z.array(z.string()).default([]).optional(),
  })
  .optional();
export type RenderHint = z.infer<typeof RenderHintSchema>;

/**
 * The summary block. `headline` is the 1-3 sentence line the agent
 * quotes when it cannot fit more. Designed to land cold to a user
 * who has not seen the underlying data.
 */
export const SummarySchema = z.object({
  headline: z.string().min(1),
  bullets: z.array(z.string()).max(5).optional(),
  callout: z.string().optional(),
});
export type Summary = z.infer<typeof SummarySchema>;

/**
 * The canonical envelope. Every default-loaded tool returns one of
 * these. Per-tool `data` is typed by a separate per-tool Zod schema;
 * here we accept z.unknown() because the envelope itself is
 * tool-agnostic.
 */
export const StructuredOutputSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  schema_epoch: z.string(),
  tool: z.string(),
  generated_at: z.string(),
  view: ViewEnum,
  summary: SummarySchema,
  data: z.unknown(),
  actions: z.array(ActionSchema).default([]),
  render_hint: RenderHintSchema,
  truncated: z.boolean().default(false),
  next_cursor: z.string().optional(),
  warnings: z.array(z.string()).default([]),
});

export type StructuredOutput = z.infer<typeof StructuredOutputSchema>;

/**
 * Builder helper. Fills the boilerplate (schema_version, schema_epoch,
 * generated_at). Per-tool implementations construct a typed `data`
 * block and pass it in.
 */
export function buildEnvelope(args: {
  tool: string;
  view: View;
  summary: Summary;
  data: unknown;
  actions?: Action[];
  render_hint?: RenderHint;
  truncated?: boolean;
  next_cursor?: string;
  warnings?: string[];
}): StructuredOutput {
  return {
    schema_version: SCHEMA_VERSION,
    schema_epoch: SCHEMA_EPOCH,
    tool: args.tool,
    generated_at: new Date().toISOString(),
    view: args.view,
    summary: args.summary,
    data: args.data,
    actions: args.actions ?? [],
    render_hint: args.render_hint,
    truncated: args.truncated ?? false,
    next_cursor: args.next_cursor,
    warnings: args.warnings ?? [],
  };
}

/**
 * Type guard distinguishing the structured envelope from legacy
 * string returns. `wrap()` in src/index.ts uses this to decide
 * how to package the response for the MCP transport.
 */
export function isStructuredOutput(x: unknown): x is StructuredOutput {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o.schema_version === SCHEMA_VERSION &&
    typeof o.tool === 'string' &&
    typeof o.generated_at === 'string' &&
    typeof o.summary === 'object'
  );
}

/**
 * Markdown-view helper. Tools that have an existing markdown renderer
 * use this to wrap the rendered string as a markdown-view envelope.
 * `wrap()` extracts `data.markdown` for the MCP text channel.
 */
export function buildMarkdownEnvelope(args: {
  tool: string;
  summary: Summary;
  markdown: string;
  actions?: Action[];
  warnings?: string[];
}): StructuredOutput {
  return buildEnvelope({
    tool: args.tool,
    view: 'markdown',
    summary: args.summary,
    data: { markdown: args.markdown },
    actions: args.actions,
    warnings: args.warnings,
  });
}
