/**
 * Tool registry — mirrors the dispatch logic in build/index.js.
 *
 * The MCP server's index.ts file has 41 registerLog10xTool calls. Each
 * one wraps an executeXxx function with env-resolution and (sometimes)
 * cost auto-detection. We can't import build/index.js directly because
 * it calls main() at top-level which connects to stdio.
 *
 * So instead we mirror the dispatch table here. When tools change shape
 * upstream (new tool added, signature changed), the type system catches
 * the drift on the next build. Adding a tool is one line in TOOL_TABLE.
 *
 * The registry returns the raw response *text* (the .content[0].text
 * of an MCP tool result). The eval harness wraps this in tool_result
 * blocks for the JSONL transcript.
 *
 * EnvConfig shape (from build/lib/environments.js) now also requires
 * `metricsBackend` + `labels`; buildEnvConfig() builds them with the
 * canonical createMetricsBackend()/DEFAULT_LABELS so the eval path is
 * byte-identical to production. Apibase / retrieverUrl / region are
 * read by tools from process.env directly — applyEvalEnvToProcess() in
 * env.ts makes sure those are set before any tool fires.
 */
import { z } from 'zod';
import { resolveEnv, type EnvConfig, type Environments } from '../../build/lib/environments.js';
import { createMetricsBackend } from '../../build/lib/metrics-backend.js';
import { DEFAULT_LABELS } from '../../build/lib/promql.js';
import { fetchAnalyzerCost } from '../../build/lib/api.js';
import type { EvalEnv } from './env.js';

// ─── Tool imports (pulled from build/tools/*.js) ────────────────────────
// chk-15 cut 5 redundant tools (cost_drivers, list_by_label, exclusion_filter,
// investigation_get, retriever_query_status); they no longer exist as files
// or registrations. Fixtures referencing the old names have been rewritten
// to the replacements (top_patterns / pattern_mitigate / investigate /
// retriever_query) — see eval/fixtures/*.json.
import { eventLookupSchema, executeEventLookup } from '../../build/tools/event-lookup.js';
import { patternExamplesSchema, executePatternExamples } from '../../build/tools/pattern-examples.js';
import { savingsSchema, executeSavings } from '../../build/tools/savings.js';
import { trendSchema, executeTrend } from '../../build/tools/trend.js';
import { servicesSchema, executeServices } from '../../build/tools/services.js';
import { dependencyCheckSchema, executeDependencyCheck } from '../../build/tools/dependency-check.js';
import { discoverLabelsSchema, executeDiscoverLabels } from '../../build/tools/discover-labels.js';
import { topPatternsSchema, executeTopPatterns } from '../../build/tools/top-patterns.js';
import {
  investigateSchema,
  executeInvestigate,
} from '../../build/tools/investigate.js';
import { resolveBatchSchema, executeResolveBatch } from '../../build/tools/resolve-batch.js';
import { extractTemplatesSchema, executeExtractTemplates } from '../../build/tools/extract-templates.js';
import { retrieverQuerySchema, executeRetrieverQuery } from '../../build/tools/retriever-query.js';
import { retrieverSeriesSchema, executeRetrieverSeries } from '../../build/tools/retriever-series.js';
import { backfillMetricSchema, executeBackfillMetric } from '../../build/tools/backfill-metric.js';
import { doctorSchema, executeDoctor } from '../../build/tools/doctor.js';
import {
  customerMetricsQuerySchema,
  executeCustomerMetricsQuery,
} from '../../build/tools/customer-metrics-query.js';
import { discoverJoinSchema, executeDiscoverJoin } from '../../build/tools/discover-join.js';
import { discoverEnvSchema, executeDiscoverEnv } from '../../build/tools/discover-env.js';
import { adviseRetrieverSchema, executeAdviseRetriever } from '../../build/tools/advise-retriever.js';
import { adviseInstallSchema, executeAdviseInstall } from '../../build/tools/advise-install.js';
import { loginStatusSchema, executeLoginStatus } from '../../build/tools/login-status.js';
import { patternMitigateSchema, executePatternMitigate } from '../../build/tools/pattern-mitigate.js';

// ─── Env shim ───────────────────────────────────────────────────────────

function buildEnvConfig(env: EvalEnv): EnvConfig {
  // EnvConfig now requires metricsBackend + labels. Mirror production's
  // autodiscovery path (environments.ts ~819-832): seed the ${VAR}
  // sources in process.env, then build the log10x backend from
  // references so the literal-secret guard is bypassed exactly as in
  // prod.
  process.env.LOG10X_API_KEY = env.apiKey;
  process.env.LOG10X_ENV_ID = env.envId;
  if (env.apiBase && !process.env.LOG10X_API_BASE) {
    process.env.LOG10X_API_BASE = env.apiBase;
  }
  // Forwarder hint from LOG10X_FORWARDER (e.g. `fluentd`, `fluent-bit`).
  // The demo env's forwarder is fluentd; production prod-loader infers
  // this from envs.json + LOG10X_FORWARDER, but the eval harness bypasses
  // that path. Set it here so log10x_top_patterns can render the right
  // forwarder-specific drop snippet.
  const forwarder = parseForwarderEnvVar(process.env.LOG10X_FORWARDER) ?? defaultForwarderForMode(env.mode);
  return {
    nickname: env.mode,
    apiKey: env.apiKey,
    envId: env.envId,
    metricsBackend: createMetricsBackend({
      kind: 'log10x',
      apiKey: '${LOG10X_API_KEY}',
      envId: '${LOG10X_ENV_ID}',
    }),
    labels: { ...DEFAULT_LABELS },
    ...(forwarder ? { forwarder } : {}),
  };
}

/** Mirror of parseForwarderEnv in environments.ts — kept private there
 * so we duplicate the tiny normalization here rather than restructure
 * the export surface. */
function parseForwarderEnvVar(raw: string | undefined): EnvConfig['forwarder'] {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (s === 'fluent-bit' || s === 'fluentbit' || s === 'fluent_bit') return 'fluentbit';
  if (s === 'fluentd' || s === 'fluent-d') return 'fluentd';
  if (s === 'filebeat' || s === 'beats') return 'filebeat';
  if (s === 'logstash') return 'logstash';
  if (s === 'otel' || s === 'otelcol' || s === 'otel-collector' || s === 'opentelemetry-collector')
    return 'otel-collector';
  return undefined;
}

/** Default forwarder when LOG10X_FORWARDER is unset. The demo env runs
 * fluentd; for customer / ci modes we leave it unset so the render
 * skips forwarder-specific guidance instead of fabricating a snippet. */
function defaultForwarderForMode(mode: EvalEnv['mode']): EnvConfig['forwarder'] {
  if (mode === 'demo') return 'fluentd';
  return undefined;
}

function buildLoadedEnvs(env: EvalEnv): Environments {
  const e = buildEnvConfig(env);
  const byNickname = new Map<string, EnvConfig>();
  byNickname.set(env.mode, e);
  return {
    all: [e],
    byNickname,
    default: e,
    isDemoMode: env.mode === 'demo',
  };
}

// ─── Cost cache (matches index.js behavior) ─────────────────────────────

const costCache = new Map<string, { cost: number; fetchedAt: number }>();
const COST_REFRESH_MS = 3_600_000;

async function getAnalyzerCost(env: EnvConfig, override: number | undefined): Promise<number> {
  if (override !== undefined) return override;
  const key = env.envId;
  const cached = costCache.get(key);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < COST_REFRESH_MS) {
    return cached.cost;
  }
  const cost = await fetchAnalyzerCost(env);
  costCache.set(key, { cost, fetchedAt: now });
  return cost;
}

// ─── Dispatch table ─────────────────────────────────────────────────────

/**
 * After the chk-15..chk-33 envelope refactor, every upstream tool now
 * returns `Promise<string | StructuredOutput>`. The eval harness still
 * expects a single string for downstream matchers (regex on rendered
 * markdown, headline assertions, etc.). When a tool returns the typed
 * envelope, we serialize it to JSON so the matchers can run against
 * structured fields too. Markdown-view envelopes get their data.markdown
 * extracted verbatim so the existing prose-matchers still apply.
 */
type ToolReturn = string | { view?: 'summary' | 'markdown'; data?: unknown; [k: string]: unknown };

type ExecuteFn = (
  args: Record<string, unknown>,
  env: EvalEnv
) => Promise<ToolReturn>;

function normalizeReturn(r: ToolReturn): string {
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    if (r.view === 'markdown' && r.data && typeof (r.data as { markdown?: unknown }).markdown === 'string') {
      return (r.data as { markdown: string }).markdown;
    }
    return JSON.stringify(r, null, 2);
  }
  return String(r);
}

// Dynamic args: the upstream Zod schemas know the per-tool shapes; the
// harness deliberately treats args as a generic record so fixtures can
// exercise the runtime-validation paths the MCP server uses in production.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = any;

/**
 * Parse args through the upstream tool schema BEFORE dispatching to the
 * executor. Mirrors what the MCP SDK does at boundary time
 * (validateToolInput) — fills in Zod-defaults and rejects malformed
 * input. Crucial because the harness dispatches directly without going
 * through the SDK boundary; without this, args:{} from a NEXT_ACTIONS
 * hint would crash any executor that .match()'s args.timeRange etc.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseArgs(schema: Record<string, z.ZodTypeAny>, raw: Record<string, unknown>): any {
  try {
    return z.object(schema).parse(raw);
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new Error(formatZodError(e, schema));
    }
    throw e;
  }
}

/**
 * Render a Zod error in a way an agent can act on. Stock ZodError JSON
 * (`[ {received, code, options, path, ...} ]`) reads as a structured
 * dump and the agent has to puzzle out the field name + fix.
 *
 * Surfaced by the anti-hallucination campaign: stability-env-sweep
 * called `cost_drivers --args '{"timeRange":"1h"}'`, got a raw enum
 * dump, retried with `'1d'` — costs an extra round-trip and a confused
 * trace. This formatter pulls the field's `.describe()` text (which
 * already explains the redirect to pattern_trend / investigate for
 * sub-day questions) into the error message itself.
 */
function formatZodError(e: z.ZodError, schema: Record<string, z.ZodTypeAny>): string {
  const lines: string[] = [];
  for (const issue of e.issues) {
    const field = issue.path.join('.') || '(root)';
    const fieldSchema = (schema as Record<string, z.ZodTypeAny>)[String(issue.path[0] ?? '')];
    // Zod attaches the human description on the inner type (after .default()).
    const describe = fieldSchema?.description ?? '';
    if (issue.code === 'invalid_enum_value') {
      const opts = (issue as z.ZodIssue & { options?: readonly string[] }).options ?? [];
      lines.push(
        `Invalid value for \`${field}\`: '${(issue as z.ZodIssue & { received?: string }).received}' is not one of ${opts.map(o => `'${o}'`).join(', ')}.` +
          (describe ? `\n  Field guidance: ${describe}` : '')
      );
    } else if (issue.code === 'invalid_type') {
      lines.push(
        `Wrong type for \`${field}\`: ${issue.message}.` +
          (describe ? `\n  Field guidance: ${describe}` : '')
      );
    } else {
      lines.push(`\`${field}\`: ${issue.message}` + (describe ? `\n  Field guidance: ${describe}` : ''));
    }
  }
  return lines.join('\n');
}

const TOOL_TABLE: Record<string, ExecuteFn> = {
  // env + cost auto-detect
  log10x_event_lookup: async (raw, ev) => {
    const args = parseArgs(eventLookupSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    const cost = await getAnalyzerCost(e, args.analyzerCost);
    return executeEventLookup({ ...args, analyzerCost: cost }, e);
  },
  log10x_savings: async (raw, ev) => {
    const args = parseArgs(savingsSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    const cost = await getAnalyzerCost(e, args.analyzerCost);
    return executeSavings({ ...args, analyzerCost: cost }, e);
  },
  log10x_pattern_trend: async (raw, ev) => {
    const args = parseArgs(trendSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    const cost = await getAnalyzerCost(e, args.analyzerCost);
    return executeTrend({ ...args, analyzerCost: cost }, e);
  },
  log10x_services: async (raw, ev) => {
    const args = parseArgs(servicesSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    const cost = await getAnalyzerCost(e, args.analyzerCost);
    return executeServices({ ...args, analyzerCost: cost }, e);
  },
  log10x_top_patterns: async (raw, ev) => {
    const args = parseArgs(topPatternsSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    const cost = await getAnalyzerCost(e, args.analyzerCost);
    return executeTopPatterns({ ...args, analyzerCost: cost }, e);
  },
  log10x_backfill_metric: async (raw, ev) => {
    const args = parseArgs(backfillMetricSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    return executeBackfillMetric(args, e);
  },

  // env only
  log10x_pattern_examples: async (raw, ev) => {
    const args = parseArgs(patternExamplesSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    return executePatternExamples(args, e);
  },
  log10x_discover_labels: async (raw, ev) => {
    const args = parseArgs(discoverLabelsSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    return executeDiscoverLabels(args, e);
  },
  log10x_investigate: async (raw, ev) => {
    const args = parseArgs(investigateSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    return executeInvestigate(args, e);
  },
  log10x_retriever_query: async (raw, ev) => {
    const args = parseArgs(retrieverQuerySchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    return executeRetrieverQuery(args, e);
  },
  log10x_retriever_series: async (raw, ev) => {
    const args = parseArgs(retrieverSeriesSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    return executeRetrieverSeries(args, e);
  },
  log10x_discover_join: async (raw, ev) => {
    const args = parseArgs(discoverJoinSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    return executeDiscoverJoin(args, e);
  },

  // args only (no env / no cost)
  log10x_dependency_check: async (raw) => executeDependencyCheck(parseArgs(dependencyCheckSchema, raw)),
  log10x_resolve_batch: async (raw) => executeResolveBatch(parseArgs(resolveBatchSchema, raw)),
  log10x_extract_templates: async (raw) => executeExtractTemplates(parseArgs(extractTemplatesSchema, raw)),
  log10x_doctor: async (raw) => executeDoctor(parseArgs(doctorSchema, raw)),
  log10x_customer_metrics_query: async (raw) =>
    executeCustomerMetricsQuery(parseArgs(customerMetricsQuerySchema, raw)),
  log10x_discover_env: async (raw) => executeDiscoverEnv(parseArgs(discoverEnvSchema, raw)),
  log10x_advise_retriever: async (raw) => executeAdviseRetriever(parseArgs(adviseRetrieverSchema, raw)),
  log10x_advise_install: async (raw, ev) => {
    // Passthrough rather than strip — the wizard does its own unknown-arg
    // detection with "did you mean" suggestions. Default Zod .strip() would
    // silently swallow typos like `targets` (instead of `backends`) and
    // bounce the agent through a question-back turn for an arg it already
    // tried to supply.
    const parsed = (z.object(adviseInstallSchema).passthrough().parse(raw)) as Parameters<typeof executeAdviseInstall>[0];
    return executeAdviseInstall(parsed, buildLoadedEnvs(ev));
  },
  log10x_pattern_mitigate: async (raw) => executePatternMitigate(parseArgs(patternMitigateSchema, raw)),

  // envs object (full Environments shape)
  log10x_login_status: async (raw, ev) =>
    executeLoginStatus(parseArgs(loginStatusSchema, raw), buildLoadedEnvs(ev)),

  // log10x_cost_drivers: synthetic stub. The tool itself was cut in
  // Tal's chk-15 catalog refactor — it no longer exists as a source
  // file or production registration. But ~24 src/ files still emit
  // `log10x_cost_drivers` in their NEXT_ACTIONS chains (a stale dangling
  // reference). Without a stub the deterministic runner halts at
  // `unknown_tool` whenever a chain reaches one of those references,
  // most visibly on every install fixture's post-install plan
  // (top_patterns -> investigate -> pattern_mitigate -> cost_drivers).
  // The proper fix is to sweep src/ and rewrite the dangling references
  // to top_patterns or similar; until that lands, the stub keeps
  // fixtures runnable. The warning surfaces the issue in transcripts so
  // it doesn't get silently forgotten.
  log10x_cost_drivers: async () => {
    return JSON.stringify(
      {
        schema_version: '1.0',
        tool: 'log10x_cost_drivers',
        view: 'summary',
        summary: {
          headline: 'cost_drivers stub — tool was cut, chain emitter is stale.',
        },
        data: {
          mode: 'stub',
          message:
            'eval-harness stub for log10x_cost_drivers: the tool was removed in chk-15 but ~24 source files still emit it as a NEXT_ACTIONS hint. Stubbing keeps deterministic install fixtures from halting at unknown_tool. Real fix: rewrite the dangling references in src/ to log10x_top_patterns (or whichever tool actually serves the cost-drivers use case now).',
        },
        actions: [],
        warnings: [
          'stub: log10x_cost_drivers no longer exists as a real tool; the emitter that linked to it is stale and should be repointed at log10x_top_patterns',
        ],
      },
      null,
      2
    );
  },

  // log10x_signin_start: synthetic stub. The real tool opens a browser
  // device-code flow and writes Auth0 tokens to ~/.log10x/credentials —
  // unmockable from a test process. The wizard's signin_required
  // envelope emits this as a `required-next` action; without a stub the
  // deterministic runner halts at unknown_tool there and the chain
  // can't continue. The stub returns a success-shaped envelope so the
  // chain progresses; the wizard's subsequent advise_install re-invoke
  // still fails license-acquisition (no real Auth0 tokens were written)
  // and surfaces signin_required again, but the cycle detector catches
  // that repeat call instead of looping. Full coverage needs #3's
  // license-path stub too.
  log10x_signin_start: async () => {
    return JSON.stringify(
      {
        schema_version: '1.0',
        tool: 'log10x_signin_start',
        view: 'summary',
        summary: {
          headline: 'Signin started (eval stub — no real Auth0 device flow opened).',
        },
        data: {
          mode: 'stub',
          message: 'eval-harness stub for log10x_signin_start: returns synthetic success so the deterministic runner does not halt at unknown_tool when the wizard chains through signin_required. The real device-flow that writes ~/.log10x/credentials cannot run from a test subprocess.',
        },
        actions: [],
        warnings: [
          'stub: no real Auth0 tokens were minted; advise_install re-invoke will hit signin_required again and the cycle detector will halt the chain harmlessly',
        ],
      },
      null,
      2
    );
  },
};

export const TOOL_NAMES = Object.keys(TOOL_TABLE).sort();

/**
 * Per-tool ZodObject schemas, suitable for JSON-Schema conversion.
 *
 * The autonomous runner uses this to advertise real `input_schema` blocks
 * to the model (replacing the earlier additionalProperties:true stub).
 * Exposing the actual property names is what lets the LLM read literal
 * keys like `backends` off the schema instead of inventing plausible
 * synonyms (`targets`, `destinations`, `outputs`).
 *
 * Adding a tool: pair it here with the same schema you registered in
 * TOOL_TABLE. The two maps must stay in lockstep — the type system
 * doesn't enforce it, but a runtime check at autonomous-runner boot does.
 */
export const TOOL_SCHEMAS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  log10x_event_lookup: z.object(eventLookupSchema),
  log10x_pattern_examples: z.object(patternExamplesSchema),
  log10x_savings: z.object(savingsSchema),
  log10x_pattern_trend: z.object(trendSchema),
  log10x_services: z.object(servicesSchema),
  log10x_dependency_check: z.object(dependencyCheckSchema),
  log10x_discover_labels: z.object(discoverLabelsSchema),
  log10x_top_patterns: z.object(topPatternsSchema),
  log10x_investigate: z.object(investigateSchema),
  log10x_resolve_batch: z.object(resolveBatchSchema),
  log10x_extract_templates: z.object(extractTemplatesSchema),
  log10x_retriever_query: z.object(retrieverQuerySchema),
  log10x_retriever_series: z.object(retrieverSeriesSchema),
  log10x_backfill_metric: z.object(backfillMetricSchema),
  log10x_doctor: z.object(doctorSchema),
  log10x_customer_metrics_query: z.object(customerMetricsQuerySchema),
  log10x_discover_join: z.object(discoverJoinSchema),
  log10x_discover_env: z.object(discoverEnvSchema),
  log10x_advise_retriever: z.object(adviseRetrieverSchema),
  log10x_advise_install: z.object(adviseInstallSchema),
  log10x_pattern_mitigate: z.object(patternMitigateSchema),
  log10x_login_status: z.object(loginStatusSchema),
  // signin_start takes no required args; an empty object is the
  // schema the production tool exposes (its `view` arg is optional).
  log10x_signin_start: z.object({}).passthrough(),
  // cost_drivers stub takes whatever args the stale callers send; we
  // accept anything and return the synthetic stub envelope.
  log10x_cost_drivers: z.object({}).passthrough(),
};

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(
      `Tool '${name}' is not registered in the eval harness. Known: ${TOOL_NAMES.join(', ')}`
    );
    this.name = 'UnknownToolError';
  }
}

export interface ToolInvocation {
  text: string;
  isError: boolean;
  durationMs: number;
}

/**
 * Invoke a tool by name. Mirrors `wrap()` in index.js: catches errors,
 * returns isError=true with the error message rather than rethrowing.
 * Tools generally don't throw — they return error markdown — but
 * runtime arg-validation throws synchronously and we catch that here.
 */
export async function invokeTool(
  name: string,
  args: Record<string, unknown>,
  env: EvalEnv
): Promise<ToolInvocation> {
  const fn = TOOL_TABLE[name];
  if (!fn) throw new UnknownToolError(name);
  const started = Date.now();
  try {
    const raw = await fn(args, env);
    const text = normalizeReturn(raw);
    return { text, isError: false, durationMs: Date.now() - started };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      text: `Tool '${name}' threw: ${msg}`,
      isError: true,
      durationMs: Date.now() - started,
    };
  }
}
