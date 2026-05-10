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
 * EnvConfig shape (from build/lib/environments.js): just
 * {nickname, apiKey, envId}. Apibase / retrieverUrl / region are read
 * by tools from process.env directly — applyEvalEnvToProcess() in env.ts
 * makes sure those are set before any tool fires.
 */
import { z } from 'zod';
import { resolveEnv, type EnvConfig, type Environments } from '../../build/lib/environments.js';
import { fetchAnalyzerCost } from '../../build/lib/api.js';
import type { EvalEnv } from './env.js';

// ─── Tool imports (pulled from build/tools/*.js) ────────────────────────
import { costDriversSchema, executeCostDrivers } from '../../build/tools/cost-drivers.js';
import { eventLookupSchema, executeEventLookup } from '../../build/tools/event-lookup.js';
import { patternExamplesSchema, executePatternExamples } from '../../build/tools/pattern-examples.js';
import { savingsSchema, executeSavings } from '../../build/tools/savings.js';
import { trendSchema, executeTrend } from '../../build/tools/trend.js';
import { servicesSchema, executeServices } from '../../build/tools/services.js';
import { exclusionFilterSchema, executeExclusionFilter } from '../../build/tools/exclusion-filter.js';
import { dependencyCheckSchema, executeDependencyCheck } from '../../build/tools/dependency-check.js';
import { discoverLabelsSchema, executeDiscoverLabels } from '../../build/tools/discover-labels.js';
import { topPatternsSchema, executeTopPatterns } from '../../build/tools/top-patterns.js';
import { listByLabelSchema, executeListByLabel } from '../../build/tools/list-by-label.js';
import {
  investigateSchema,
  executeInvestigate,
  investigationGetSchema,
  executeInvestigationGet,
} from '../../build/tools/investigate.js';
import { resolveBatchSchema, executeResolveBatch } from '../../build/tools/resolve-batch.js';
import { extractTemplatesSchema, executeExtractTemplates } from '../../build/tools/extract-templates.js';
import { retrieverQuerySchema, executeRetrieverQuery } from '../../build/tools/retriever-query.js';
import {
  retrieverQueryStatusSchema,
  executeRetrieverQueryStatus,
} from '../../build/tools/retriever-query-status.js';
import { retrieverSeriesSchema, executeRetrieverSeries } from '../../build/tools/retriever-series.js';
import { backfillMetricSchema, executeBackfillMetric } from '../../build/tools/backfill-metric.js';
import { doctorSchema, executeDoctor } from '../../build/tools/doctor.js';
import {
  customerMetricsQuerySchema,
  executeCustomerMetricsQuery,
} from '../../build/tools/customer-metrics-query.js';
import { discoverJoinSchema, executeDiscoverJoin } from '../../build/tools/discover-join.js';
import {
  correlateCrossPillarSchema,
  executeCorrelateCrossPillar,
} from '../../build/tools/correlate-cross-pillar.js';
import {
  translateMetricToPatternsSchema,
  executeTranslateMetricToPatterns,
} from '../../build/tools/translate-metric-to-patterns.js';
import { discoverEnvSchema, executeDiscoverEnv } from '../../build/tools/discover-env.js';
import { adviseReporterSchema, executeAdviseReporter } from '../../build/tools/advise-reporter.js';
import { adviseReceiverSchema, executeAdviseReceiver } from '../../build/tools/advise-receiver.js';
import { adviseRetrieverSchema, executeAdviseRetriever } from '../../build/tools/advise-retriever.js';
import { adviseInstallSchema, executeAdviseInstall } from '../../build/tools/advise-install.js';
import { adviseCompactSchema, executeAdviseCompact } from '../../build/tools/advise-compact.js';
import { loginStatusSchema, executeLoginStatus } from '../../build/tools/login-status.js';

// ─── Env shim ───────────────────────────────────────────────────────────

function buildEnvConfig(env: EvalEnv): EnvConfig {
  return {
    nickname: env.mode,
    apiKey: env.apiKey,
    envId: env.envId,
  };
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

type ExecuteFn = (
  args: Record<string, unknown>,
  env: EvalEnv
) => Promise<string>;

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
  log10x_cost_drivers: async (raw, ev) => {
    const args = parseArgs(costDriversSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    const cost = await getAnalyzerCost(e, args.analyzerCost);
    return executeCostDrivers({ ...args, analyzerCost: cost }, e);
  },
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
  log10x_list_by_label: async (raw, ev) => {
    const args = parseArgs(listByLabelSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    const cost = await getAnalyzerCost(e, args.analyzerCost);
    return executeListByLabel({ ...args, analyzerCost: cost }, e);
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
  log10x_retriever_query_status: async (raw, ev) => {
    const args = parseArgs(retrieverQueryStatusSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    return executeRetrieverQueryStatus(args, e);
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
  log10x_correlate_cross_pillar: async (raw, ev) => {
    const args = parseArgs(correlateCrossPillarSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    return executeCorrelateCrossPillar(args, e);
  },
  log10x_translate_metric_to_patterns: async (raw, ev) => {
    const args = parseArgs(translateMetricToPatternsSchema, raw);
    const e = resolveEnv(buildLoadedEnvs(ev), args.environment);
    return executeTranslateMetricToPatterns(args, e);
  },

  // args only (no env / no cost)
  log10x_exclusion_filter: async (raw) => executeExclusionFilter(parseArgs(exclusionFilterSchema, raw)),
  log10x_dependency_check: async (raw) => executeDependencyCheck(parseArgs(dependencyCheckSchema, raw)),
  log10x_investigation_get: async (raw) => executeInvestigationGet(parseArgs(investigationGetSchema, raw)),
  log10x_resolve_batch: async (raw) => executeResolveBatch(parseArgs(resolveBatchSchema, raw)),
  log10x_extract_templates: async (raw) => executeExtractTemplates(parseArgs(extractTemplatesSchema, raw)),
  log10x_doctor: async (raw) => executeDoctor(parseArgs(doctorSchema, raw)),
  log10x_customer_metrics_query: async (raw) =>
    executeCustomerMetricsQuery(parseArgs(customerMetricsQuerySchema, raw)),
  log10x_discover_env: async (raw) => executeDiscoverEnv(parseArgs(discoverEnvSchema, raw)),
  log10x_advise_reporter: async (raw) => executeAdviseReporter(parseArgs(adviseReporterSchema, raw)),
  log10x_advise_receiver: async (raw) => executeAdviseReceiver(parseArgs(adviseReceiverSchema, raw)),
  log10x_advise_retriever: async (raw) => executeAdviseRetriever(parseArgs(adviseRetrieverSchema, raw)),
  log10x_advise_install: async (raw) => executeAdviseInstall(parseArgs(adviseInstallSchema, raw)),
  log10x_advise_compact: async (raw) => executeAdviseCompact(parseArgs(adviseCompactSchema, raw)),

  // envs object (full Environments shape)
  log10x_login_status: async (raw, ev) =>
    executeLoginStatus(parseArgs(loginStatusSchema, raw), buildLoadedEnvs(ev)),
};

export const TOOL_NAMES = Object.keys(TOOL_TABLE).sort();

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
    const text = await fn(args, env);
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
