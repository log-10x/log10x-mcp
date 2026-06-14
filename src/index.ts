#!/usr/bin/env node

/**
 * Log10x MCP Server
 *
 * Gives AI assistants real-time access to per-pattern log cost attribution data.
 * Queries pre-aggregated Prometheus metrics — no log scanning, sub-second at any scale.
 */

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { recordStart, withTelemetry, setEnvsProvider } from './lib/self-telemetry.js';
import {
  loadManifest,
  applyManifestToTools,
  readClientVersion,
  getPackageDefaultTool,
} from './lib/manifest.js';
import { z } from 'zod';
import {
  StructuredOutputSchema,
  buildEnvelope,
  type StructuredOutput,
} from './lib/output-types.js';
import {
  detectMode,
  shouldRegisterTool,
  formatModeResolution,
  type ModeResolution,
} from './lib/mode-detect.js';
import { makeShapeCoercive } from './lib/input-coerce.js';

import { loadEnvironments, resolveEnv, revalidateEnvironments, type EnvConfig, type Environments, EnvironmentValidationError } from './lib/environments.js';
import { eventLookupSchema, executeEventLookup } from './tools/event-lookup.js';
import { savingsSchema, executeSavings } from './tools/savings.js';
import { trendSchema, executeTrend } from './tools/trend.js';
import { patternExamplesSchema, executePatternExamples } from './tools/pattern-examples.js';
import { dependencyCheckSchema, executeDependencyCheck } from './tools/dependency-check.js';
import { configureEnvSchema, executeConfigureEnv } from './tools/configure-env.js';
import {
  renderNotConfigured,
  buildNotConfiguredEnvelope,
  defaultActionsForKind,
  isNotConfiguredError,
  notConfiguredEnvelopeFromError,
  notConfiguredToolResult,
} from './lib/not-configured.js';

function notConfiguredMessageForTool(toolName: string): string {
  return renderNotConfigured({ callingTool: toolName });
}
import { topPatternsSchema, executeTopPatterns } from './tools/top-patterns.js';
import { resolveBatchSchema, executeResolveBatch } from './tools/resolve-batch.js';
import {
  investigateSchema,
  executeInvestigate,
} from './tools/investigate.js';
import { doctorSchema, executeDoctor, runDoctorChecks, renderDoctorReport } from './tools/doctor.js';
import { log } from './lib/log.js';
import { describeToolError } from './lib/tool-errors.js';
import { DemoReadOnlyError, isReadOnlyMode } from './lib/read-only-guard.js';
import { buildDemoReadOnlyEnvelope } from './lib/chassis-envelope.js';
import { retrieverQuerySchema, executeRetrieverQuery, retrieverNotConfiguredMessage } from './tools/retriever-query.js';
import { retrieverSeriesSchema, executeRetrieverSeries } from './tools/retriever-series.js';
import { retrieverQueryStatusSchema, executeRetrieverQueryStatus } from './tools/retriever-query-status.js';
import { retrieverProbeSchema, executeRetrieverProbe } from './tools/retriever-probe.js';
import { retrieverRegisterSchema, executeRetrieverRegister } from './tools/retriever-register.js';
import { patternDiffSchema, executePatternDiff } from './tools/pattern-diff.js';
import { whatsChangingSchema, executeWhatsChanging } from './tools/whats-changing.js';
import { whatsNewSchema, executeWhatsNew } from './tools/whats-new.js';
import { backfillMetricSchema, executeBackfillMetric } from './tools/backfill-metric.js';
import {
  customerMetricsQuerySchema,
  executeCustomerMetricsQuery,
} from './tools/customer-metrics-query.js';
import { discoverJoinSchema, executeDiscoverJoin } from './tools/discover-join.js';
import { metricOverlaySchema, executeMetricOverlay } from './tools/metric-overlay.js';
import { metricsThatMovedSchema, executeMetricsThatMoved } from './tools/metrics-that-moved.js';
import {
  rankByShapeSimilaritySchema,
  executeRankByShapeSimilarity,
} from './tools/rank-by-shape-similarity.js';
import {
  pocFromSiemSubmitSchema,
  pocFromSiemStatusSchema,
  executePocSubmit,
  executePocStatus,
} from './tools/poc-from-siem.js';
import { pocFromLocalSchema, executePocFromLocal } from './tools/poc-from-local.js';
import { discoverEnvSchema, executeDiscoverEnv } from './tools/discover-env.js';
import { adviseRetrieverSchema, executeAdviseRetriever } from './tools/advise-retriever.js';
import { adviseInstallSchema, executeAdviseInstall } from './tools/advise-install.js';
import { configureEngineSchema, executeConfigureEngine } from './tools/configure-engine.js';
import {
  estimateSavingsSchema,
  executeEstimateSavings,
  runEstimateVerify,
} from './tools/estimate-savings.js';
import { baselineSchema, executeBaseline } from './tools/baseline.js';
import {
  commitmentReportSchema,
  executeCommitmentReport,
  _setVerifyRunner,
  adaptVerifyResultToWeekly,
} from './tools/commitment-report.js';
import { patternMitigateSchema, executePatternMitigate } from './tools/pattern-mitigate.js';
import { loginStatusSchema, executeLoginStatus } from './tools/login-status.js';
import {
  signinStartSchema,
  signinCompleteSchema,
  executeSigninStart,
  executeSigninComplete,
} from './tools/signin.js';
import { signoutSchema, executeSignout } from './tools/signout.js';
import { updateSettingsSchema, executeUpdateSettings } from './tools/update-settings.js';
import { createEnvSchema, executeCreateEnv } from './tools/create-env.js';
import { updateEnvSchema, executeUpdateEnv } from './tools/update-env.js';
import { deleteEnvSchema, executeDeleteEnv } from './tools/delete-env.js';
import { envRegisterSchema, executeEnvRegister } from './tools/env-register.js';
import { setGitopsRepoSchema, executeSetGitopsRepo } from './tools/set-gitops-repo.js';
import {
  destSetSchema,
  executeDestSet,
  envValidateSchema,
  executeEnvValidate,
  envDiffVsEnvvarsSchema,
  executeEnvDiffVsEnvvars,
} from './tools/env-config-manage.js';
import {
  offloadAddSchema,
  executeOffloadAdd,
  offloadArchiveSchema,
  executeOffloadArchive,
} from './tools/offload-manage.js';
import { rotateApiKeySchema, executeRotateApiKey } from './tools/rotate-api-key.js';
import { servicesSchema, executeServices } from './tools/services.js';
import { overflowContentsSchema, executeOverflowContents } from './tools/overflow-contents.js';
import {
  fetchCapCsvForEnv,
  fetchActionIntentForEnv,
  fetchCapCsvFromConfigMap,
  fetchActionIntentFromConfigMap,
} from './lib/cap-csv-fetch.js';
import { findSkewSchema, executeFindSkew } from './tools/find-skew.js';
// find_constant_slots, find_uuid_in_body, find_incident_cluster removed
// because they produced findings the agent could not act on
// (engine-tokenization config changes need a human + redeploy) OR
// overlapped with log10x_investigate's trajectory + chain analysis.
import { discoverLabelsSchema, executeDiscoverLabels } from './tools/discover-labels.js';
import { extractTemplatesSchema, executeExtractTemplates } from './tools/extract-templates.js';
import { compileStartSchema, executeCompileStart } from './tools/compile-start.js';
import { compileStatusSchema, executeCompileStatus } from './tools/compile-status.js';
import { compileLinkSchema, executeCompileLink } from './tools/compile-link.js';
import { log10xStartSchema, executeLog10xStart } from './tools/log10x-start.js';
import { costOptionsSchema, executeCostOptions } from './tools/cost-options.js';
import { explainModeSchema, executeExplainMode } from './tools/explain-mode.js';
import { previewFilterSchema, executePreviewFilter } from './tools/preview-filter.js';
import { productQaSchema, executeProductQa } from './tools/product-qa.js';
import { patternDetailSchema, executePatternDetail } from './tools/pattern-detail.js';
import { measureCompactionSchema, executeMeasureCompaction } from './tools/measure-compaction.js';
import { setupRecurringSchema, executeSetupRecurring } from './tools/setup-recurring.js';
import { devRestartSchema, executeDevRestart } from './tools/dev-restart.js';
import { getStatus } from './resources/status.js';

// ── Environment + cost cache ──
//
// Env loading is deferred until after CLI flag handling so `--version`,
// `--list-tools`, `--doctor`, and `--help` all work without env vars set.
// `main()` calls `initEnvs()` once before `server.connect(transport)`,
// so every tool callback can use `getEnvs()` synchronously from that
// point onward. The async load path is required because autodiscovery
// (apiKey alone → GET /api/v1/user) hits the network.

let envs: Environments | undefined;
let bootMode: ModeResolution | undefined;

async function initEnvs(): Promise<void> {
  // loadEnvironments() now applies the SaaS↔on-prem alias bridge
  // internally so every caller (including tools like doctor that
  // re-load envs on each call) sees the same enriched byNickname map.
  // See src/lib/env-alias-bridge.ts.
  envs = await loadEnvironments();
}

/**
 * Detect the operating mode (analysis | analysis_pending | poc) for
 * this MCP boot. Runs once after envs are loaded; result is fixed for
 * the lifetime of the process. Tool handlers consult `bootMode.mode`
 * via `getBootMode()` to gate themselves; agents see all 44 tools in
 * `tools/list` and the client's tool-search ranks per query, but a
 * tool called in the wrong mode returns a clear "not available" reply
 * instead of 5xx'ing on a missing backend.
 */
async function initBootMode(): Promise<void> {
  bootMode = await detectMode();
}

export function getBootMode(): ModeResolution {
  if (!bootMode) {
    throw new Error(
      '[log10x-mcp] internal error: bootMode accessed before initBootMode() completed.'
    );
  }
  return bootMode;
}

function getEnvs(): Environments {
  if (!envs) {
    throw new Error(
      '[log10x-mcp] internal error: envs accessed before initEnvs() completed.'
    );
  }
  return envs;
}


/**
 * Wrap a tool implementation in a try/catch that produces actionable error
 * suggestions via `describeToolError(toolName, e)`. Every tool callback
 * goes through this helper instead of the raw try/catch idiom so error
 * surfaces are uniform and self-coaching for the model.
 *
 * Also instruments every call with `timed()` for free observability — ops
 * can set LOG10X_MCP_LOG_LEVEL=info to get per-tool call counts and
 * durations on stderr without any new endpoints or resources. On errors,
 * the raw error message is logged at debug level before `describeToolError`
 * rewrites it, so ops can see the original text when hunting root causes.
 */
/**
 * Tools that query the metrics backend (cost_drivers, top_patterns,
 * etc.). When the MCP is in pure-demo mode (no user configuration,
 * silently landed on the demo backend), these tools short-circuit
 * with a structured `not_configured` response instead of returning
 * demo data the user didn't ask for. We surface the conversation
 * starter without breaking the demo-mode walkthrough; the silent-demo
 * path will be removed in a later release.
 *
 * Tools NOT in this set bypass the gate: configure_env (the
 * onboarding tool itself), doctor (status reporting works in any
 * mode), local-only tools (resolve_batch, extract_templates,
 * dependency_check pasted input), signin_* (log10x account
 * management), discover_env (k8s discovery), poc_from_* (pre-config
 * sample reports).
 */
const METRIC_REQUIRING_TOOLS = new Set([
  'log10x_top_patterns',
  'log10x_pattern_trend',
  'log10x_pattern_examples',
  'log10x_event_lookup',
  'log10x_savings',
  'log10x_services',
  'log10x_overflow_contents',
  'log10x_discover_labels',
  'log10x_investigate',
  'log10x_backfill_metric',
  'log10x_metric_overlay',
  'log10x_metrics_that_moved',
  'log10x_rank_by_shape_similarity',
  'log10x_discover_join',
  'log10x_customer_metrics_query',
  'log10x_retriever_query',
  'log10x_retriever_series',
]);

// When set, the MCP is an intentional read-only demo playground: the metric
// tools serve the public demo data instead of the not_configured onboarding
// nag (see the gate in wrap()). isDemoMode stays true, so the demo banner still
// renders — we just stop nagging. Set by the hosted deployment.
const DEMO_PLAYGROUND = /^(1|true|yes)$/i.test(process.env.LOG10X_MCP_DEMO_PLAYGROUND ?? '');

type WrapResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

async function wrap(
  toolName: string,
  fn: () => Promise<string | StructuredOutput>
): Promise<WrapResult> {
  const started = Date.now();
  // Demo-mode gate: if this is a metric-requiring tool and the MCP is
  // in pure-demo state, redirect to the conversational onboarding flow
  // instead of returning silent-demo data, UNLESS this is an intentional
  // demo playground (LOG10X_MCP_DEMO_PLAYGROUND), which wants the demo data
  // served (the gated tools are exactly the demo's headline surface).
  if (
    METRIC_REQUIRING_TOOLS.has(toolName) &&
    envs &&
    envs.isDemoMode &&
    !envs.demoFallbackReason &&
    !DEMO_PLAYGROUND
  ) {
    log.info(`tool.${toolName}.not_configured`);
    // Structured not_configured envelope (status + remediation + actions),
    // not a bare text blob; the agent branches on data.status and the MCP
    // SDK requires structuredContent for tools that declare an outputSchema
    // (a text-only return here is rejected as "no structured content").
    // rq-1: retriever_query / retriever_series read the offload bucket (the
    // held-back cohort), not the metrics backend. This wrap gate pre-empts their
    // own correct kind:'retriever' gate, so branch the remediation here: a
    // metrics-backend nag points the agent at the wrong subsystem entirely.
    const isRetrieverTool =
      toolName === 'log10x_retriever_query' || toolName === 'log10x_retriever_series';
    const ncKind = isRetrieverTool ? 'retriever' : 'metrics_backend';
    return notConfiguredToolResult(
      buildNotConfiguredEnvelope({
        tool: toolName,
        kind: ncKind,
        remediation: isRetrieverTool
          ? retrieverNotConfiguredMessage()
          : notConfiguredMessageForTool(toolName),
        actions: defaultActionsForKind(ncKind),
      }),
    );
  }
  // Mode gate: if the boot-time mode-detect determined this tool is
  // not available in the current mode, return a clear out-of-mode
  // reply rather than letting it 5xx on a missing backend. Agents see
  // all tools in `tools/list` (client-side tool-search ranks them per
  // query, so cognitive surface is not the concern); the gate just
  // ensures wrong-mode calls produce a useful response.
  if (bootMode && !shouldRegisterTool(toolName, bootMode.mode)) {
    log.info(`tool.${toolName}.wrong_mode`, { mode: bootMode.mode });
    return {
      content: [
        {
          type: 'text' as const,
          text: formatOutOfModeMessage(toolName, bootMode),
        },
      ],
    };
  }
  try {
    const result = await runWithDemoFallbackRetry(toolName, fn);
    log.info(`tool.${toolName}.ok`, { ms: Date.now() - started });
    // Universal-envelope path: a tool that still returns plain markdown
    // (the unreshaped legacy tools — primitives, advisors, auth) gets
    // auto-wrapped into a StructuredOutput envelope here. The agent always
    // sees JSON. `data` carries `{ markdown }` until the per-tool reshape
    // upgrades it to a typed shape; the envelope itself is uniform from
    // day one. Demo banner is applied at the markdown-view extraction
    // step below, not here — keeps the envelope's data.markdown clean
    // for downstream consumers that don't want the banner prefix.
    let normalized: StructuredOutput;
    if (typeof result === 'string') {
      const headline = (result.split('\n').find((l) => l.trim().length > 0) ?? `${toolName} result`).slice(0, 200);
      normalized = buildEnvelope({
        tool: toolName,
        view: 'summary',
        summary: { headline },
        data: { markdown: result },
      });
    } else {
      normalized = result;
    }
    // Structured envelope path. Validate first so a malformed envelope
    // surfaces as an error rather than silently emitting bad JSON to
    // the transport.
    let validated: StructuredOutput;
    try {
      validated = StructuredOutputSchema.parse(normalized);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      log.warn(`tool.${toolName}.envelope_invalid`, { msg: msg.slice(0, 240) });
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Internal error: tool returned an invalid StructuredOutput envelope.\n` +
              `Tool: ${toolName}\n` +
              `Validation error: ${msg}`,
          },
        ],
        isError: true,
      };
    }
    // The 2025-03-26 MCP revision lets a tool emit `structuredContent` (typed
    // JSON) alongside the text channel. Hosts that honor it (Claude Desktop,
    // ChatGPT Desktop, Cursor's structured-output path) skip the JSON.parse on
    // the agent side and read fields directly; legacy hosts still see the
    // text fallback. We populate BOTH on every successful call.
    const enriched: StructuredOutput = {
      ...validated,
      warnings: maybeAddDemoBannerWarning(validated.warnings),
    };
    const structuredContent = enriched as unknown as Record<string, unknown>;
    // G6: image attachments. Tools that produced inline charts populate
    // envelope.images; we surface each as an MCP `image` content block.
    // Hosts that render images (Claude Desktop, ChatGPT Desktop) show the
    // chart; hosts that don't ignore the block.
    const imageBlocks: Array<{ type: 'image'; data: string; mimeType: string }> = [];
    const inlineImages = (validated as { images?: Array<{ data: string; mimeType: string; alt?: string }> }).images;
    if (Array.isArray(inlineImages)) {
      for (const img of inlineImages) {
        if (typeof img.data === 'string' && typeof img.mimeType === 'string') {
          imageBlocks.push({ type: 'image' as const, data: img.data, mimeType: img.mimeType });
        }
      }
    }
    if (validated.view === 'markdown') {
      // Renderer was invoked inside the tool; data.markdown carries the
      // rendered artifact. Text channel gets the markdown verbatim (with
      // demo banner); structured channel still ships the full typed envelope
      // so agents that want both can read it.
      const md = (validated.data as { markdown?: unknown }).markdown;
      if (typeof md !== 'string') {
        log.warn(`tool.${toolName}.markdown_view_missing_markdown`);
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Internal error: tool returned view: "markdown" but data.markdown is not a string.\n` +
                `Tool: ${toolName}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: applyDemoBanner(md) },
          ...imageBlocks,
        ],
        structuredContent,
      };
    }
    // JSON view. The text channel carries the envelope JSON-stringified so
    // hosts without `structuredContent` support still see typed data; the
    // structured channel ships the same envelope as a real object so modern
    // hosts skip the parse. Demo banner is metadata, not a prose prefix —
    // it lives in warnings[].
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(enriched, null, 2) },
        ...imageBlocks,
      ],
      structuredContent,
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    log.debug(`tool.${toolName}.raw_err`, { msg: raw });
    // Demo read-only gate: a writer tool called `requireWriteAccess()` while
    // the MCP is running with LOG10X_MCP_READ_ONLY=true. Return the canonical
    // demo_read_only envelope (status='error', data.status='demo_read_only',
    // data.error.error_type='demo_read_only') so the agent can branch on the
    // typed discriminant without parsing prose. structuredContent is populated
    // so MCP hosts that honor the 2025-03-26 revision see typed JSON directly.
    if (e instanceof DemoReadOnlyError) {
      log.info(`tool.${toolName}.demo_read_only`, {
        ms: Date.now() - started,
        would_have: e.would_have.slice(0, 200),
      });
      const envelope = buildDemoReadOnlyEnvelope({
        tool: toolName,
        would_have: e.would_have,
        hint: e.hint,
      });
      const structuredContent = envelope as unknown as Record<string, unknown>;
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(envelope, null, 2) },
        ],
        structuredContent,
      };
    }
    // A deliberate "not configured" throw (the loud human-escape-hatch
    // path, e.g. customer_metrics_query) must not abort the agent's chain
    // as an opaque error. Convert it to a structured, branchable
    // not_configured envelope (status + remediation + actions, NOT isError)
    // so the agent reads data.status, surfaces the fix, and continues.
    if (isNotConfiguredError(e)) {
      log.info(`tool.${toolName}.not_configured`, { ms: Date.now() - started });
      return notConfiguredToolResult(notConfiguredEnvelopeFromError(toolName, e));
    }
    log.warn(`tool.${toolName}.err`, { ms: Date.now() - started, msg: raw });
    return {
      content: [{ type: 'text' as const, text: applyDemoBanner(describeToolError(toolName, e)) }],
      isError: true,
    };
  }
}

/**
 * Run the tool's inner function. If it throws an auth error (401/403)
 * AND the MCP is currently in demo-fallback mode, revalidate
 * credentials once and retry the tool.
 *
 * Why: every account-scoped EnvConfig bakes the apiKey at boot
 * (`environments.ts:loadFromApi`). If the user's key was invalid at
 * boot (typo, transient backend issue, rotated key whose authorizer
 * cache had not yet cleared), the MCP falls back to the public demo
 * key and every account-scoped tool keeps using that demo key for the
 * lifetime of the process, even after the real key starts working.
 * Restarting the MCP host was the only recovery path until now.
 *
 * This wrapper makes recovery automatic: any account-scoped tool that
 * gets 401/403 while in demo-fallback triggers a single revalidation
 * + retry, transparently un-sticking the user. Pure demo mode (no key
 * configured at all) does NOT trigger this; only the fallback case
 * where the user intended to use a real account.
 *
 * Tools that don't hit the gateway (resolve_batch, extract_templates)
 * never produce 401/403 errors so this is a no-op for them.
 */
async function runWithDemoFallbackRetry<T>(
  toolName: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isAuthRecoverableError(e)) throw e;
    if (!envs || !envs.isDemoMode || !envs.demoFallbackReason) throw e;
    log.info(`tool.${toolName}.auth_retry.attempt`, {
      reason: envs.demoFallbackReason.slice(0, 200),
    });
    try {
      await revalidateEnvironments(envs);
    } catch (reloadErr) {
      log.warn(`tool.${toolName}.auth_retry.reload_failed`, {
        msg: (reloadErr as Error).message,
      });
      throw e;
    }
    if (envs.isDemoMode) {
      // Reload still ended in demo. Original error stands.
      log.info(`tool.${toolName}.auth_retry.still_demo`);
      throw e;
    }
    log.info(`tool.${toolName}.auth_retry.recovered`);
    return await fn();
  }
}

function isAuthRecoverableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /HTTP 401|HTTP 403|forbidden|unauthorized/i.test(msg);
}

/**
 * Prepend a banner to the tool result when the MCP is in
 * demo-fallback mode (user supplied an API key but it failed). The
 * goal is hard-to-miss notification — but the wording matters: only
 * account-scoped tools return demo data; local-only templater tools
 * (resolve_batch, extract_templates) operate on the caller's own
 * input regardless of credential state. So the banner describes the
 * MCP's *mode*, not "this tool's data."
 *
 * Pure demo mode (no key set) is the user's own choice and gets a
 * quieter footer instead.
 */
/**
 * Structured-envelope variant of applyDemoBanner. The demo-mode
 * signal is appended to the `warnings[]` array rather than prepended
 * as prose, because JSON consumers parse fields, not prefixes. Same
 * trigger conditions and wording as applyDemoBanner; just a different
 * surface.
 */
function maybeAddDemoBannerWarning(warnings: string[]): string[] {
  if (!envs?.isDemoMode) return warnings;
  if (envs.demoFallbackReason) {
    const reason = envs.demoFallbackReason.split('\n')[0].slice(0, 240);
    return [
      `DEMO MODE — your LOG10X_API_KEY failed validation. Account-scoped tools hit the public Log10x demo env, NOT your account. Reason: ${reason}. Call log10x_login_status for fix steps.`,
      ...warnings,
    ];
  }
  return [
    `Demo mode — account-scoped tools query the read-only Log10x demo env. Call log10x_login_status to use your own data.`,
    ...warnings,
  ];
}

/**
 * Format a clear "this tool is not available in the current boot mode"
 * reply. The agent calls a tool that mode-detect determined is
 * irrelevant (analysis tool in POC mode, POC tool in analysis mode);
 * we tell it why and what would change the mode.
 */
function formatOutOfModeMessage(toolName: string, mode: ModeResolution): string {
  const lines = [
    `## \`${toolName}\` is not available in this mode`,
    ``,
    `**Current mode**: \`${mode.mode}\``,
    `**Reason**: ${mode.reason}`,
    ``,
  ];
  if (mode.mode === 'poc') {
    lines.push(
      `This MCP detected no TSDB backend at boot and registered the POC tools (`,
      `\`log10x_poc_from_siem_*\`, \`log10x_poc_from_local\`) plus install advisors instead.`,
      ``,
      `If you have a 10x deployment with a TSDB (Grafana Cloud, AMP, GCP Managed Prometheus,`,
      `Datadog Prom, self-hosted Prometheus, or 10x Cloud), set the corresponding env vars`,
      `(\`LOG10X_CUSTOMER_METRICS_URL\` + \`LOG10X_CUSTOMER_METRICS_TYPE\` + \`LOG10X_CUSTOMER_METRICS_AUTH\`,`,
      `or any of the ambient detect paths) and restart the MCP. The analysis tools will`,
      `register on the next boot.`
    );
  } else if (mode.mode === 'analysis') {
    lines.push(
      `This MCP detected a live 10x deployment at boot and registered the analysis tools.`,
      ``,
      `\`${toolName}\` is a POC / install-advisor tool that runs against prospect environments.`,
      `If you actually want POC / install-advisor behavior in an analysis-mode env, unset the`,
      `customer-metrics env vars and restart.`
    );
  }
  return lines.join('\n');
}

function applyDemoBanner(text: string): string {
  if (!envs?.isDemoMode) return text;
  if (envs.demoFallbackReason) {
    const reason = envs.demoFallbackReason.split('\n')[0].slice(0, 240);
    return (
      `> ⚠ **DEMO MODE — your LOG10X_API_KEY failed validation.** ` +
      `Account-scoped tools (top_patterns, investigate, services, etc.) hit the public Log10x demo env, NOT your account. ` +
      `Local-only tools (resolve_batch, extract_templates) are unaffected. ` +
      `Reason: ${reason} ` +
      `Call \`log10x_login_status\` for fix steps.\n\n` +
      text
    );
  }
  // Pure demo: lighter footer; the user opted in by not setting a key.
  return text + `\n\n_(Demo mode — account-scoped tools query the read-only Log10x demo env. Call \`log10x_login_status\` to use your own data.)_`;
}

// ── Server ──

const SERVER_INFO = { name: 'log10x', version: readClientVersion() };

// Build/version provenance, surfaced on GET /health and in the mcp.boot log so
// anyone can confirm which image is running (e.g. to verify a redeploy rolled).
// commit + builtAt are baked into the container image via Docker build-args;
// they read 'unknown' on a local/stdio run that wasn't built that way.
const BUILD_INFO = {
  version: readClientVersion(),
  commit: process.env.LOG10X_MCP_BUILD_SHA ?? 'unknown',
  builtAt: process.env.LOG10X_MCP_BUILD_TIME ?? 'unknown',
};
const SERVER_OPTIONS = {
    // Declare the `logging` capability so calls to extra.sendNotification
    // ('notifications/message', ...) inside tool handlers don't throw
    // synchronously from the SDK's assertNotificationCapability guard.
    // We don't currently rely on mid-tool push for the sign-in flow
    // (the two-tool log10x_signin_start / log10x_signin_complete split
    // sidesteps Cursor's lack of mid-tool rendering), but declaring the
    // capability is correct hygiene and unblocks any other tool that
    // wants to use the channel on hosts that do support it.
    capabilities: { logging: {} },
    instructions: `ROUTING RULE: For any user request involving cost reduction, savings targets (save X%, cut my bill), open-ended platform orientation (what should I do, where do I start, how can you help), or any first-time interaction in a fresh session, you MUST call log10x_start before any other tool. log10x_start returns a structured menu and a question for the user; surface its must_render_verbatim and must_ask_user fields directly without summarizing or pre-picking an option. Do not call estimate_savings, cost_options, configure_engine, pattern_mitigate, or services until the user has answered log10x_start question.

NEGATION: DO NOT call log10x_estimate_savings, log10x_cost_options, log10x_configure_engine, log10x_pattern_mitigate, log10x_services, log10x_top_patterns, log10x_baseline, or log10x_commitment_report on the user first message of a fresh session if the message touches cost, savings, bill, expense, drop, compact, offload, tier-down, or any open-ended platform question. The orientation envelope from log10x_start surfaces the menu, the journey phase, the available action modes, and the structured question the user must answer. Skipping that step degrades the user experience to a black-box recommendation.

Log10x is the observability memory for the user's logs. Every log line the pipeline
has ever seen is fingerprinted into a stable pattern identity (the hash of a representing-token subset, so many template variants collapse to one) that stays constant across
deploys, restarts, pod names, timestamps, and request IDs. That identity is the key to a Prometheus
time series of volume and cost, so any pattern the user has ever emitted is instantly queryable by
name, by history, or by sample line — with zero prior query setup.

CUSTOMER TIER LADDER (determines which tools are available)

1. Dev CLI only — free local binary, no pipeline infrastructure.
   Available tools: log10x_resolve_batch (pasted-batch triage), log10x_dependency_check,
                    log10x_pattern_mitigate.
2. Reporter — standalone dedicated fluent-bit DaemonSet alongside the user's forwarder
   (zero-touch, read-only). Emits TenXSummary metrics for cost attribution + pattern
   fingerprinting.
   Adds: log10x_investigate, log10x_pattern_trend, log10x_top_patterns,
         log10x_event_lookup, log10x_savings.
3. Receiver — sidecar inside the user's existing forwarder (fluent-bit / fluentd /
   filebeat / logstash / otel-collector / vector). Filters, samples, and optionally
   losslessly compacts events in-flight. Replaces the legacy Regulator + Optimizer apps.
   Same tools as Reporter, plus event modification on the forwarder's path.
4. Retriever (deployable with or without Reporter/Receiver). Reads the customer-owned
   overflow S3 bucket the Receiver's offload action writes to, indexed by Bloom filter.
   Adds: log10x_retriever_query (read the offloaded cohort for a pattern, the events the
         Receiver held back from the SIEM). log10x_backfill_metric is deprecated and dark.

TOOL ROUTING BY USER INTENT

Daily-habit / operational:
- user pastes a raw log line, asks "what is this"                → log10x_event_lookup
- user pastes MULTIPLE events or a SIEM dump, asks "triage this" → log10x_resolve_batch
- "is this pattern new" / "when did this start"                  → log10x_event_lookup then log10x_pattern_trend
- "how often is this happening" / "is it getting worse"          → log10x_pattern_trend
- "top patterns in <service> right now"                          → log10x_top_patterns
- "why is X spiking" / "investigate X" / "what's causing this"   → log10x_investigate
- "am I allowed to drop this" / "what references this"           → log10x_dependency_check
- "drop X" / "filter X" / "mute X" / "stop ingesting X" /
  "reduce cost of X" / "kill X" / "get rid of X" / "shrink X" /
  "compact X" / "exclude X from Datadog/Splunk/Elastic/CloudWatch" → log10x_pattern_mitigate (returns the
                                                                      env-gated mitigation options + exact configs
                                                                      for this pattern: drop @ analyzer / drop @
                                                                      forwarder / mute @ 10x / compact @ 10x —
                                                                      only the options available in this env are
                                                                      included. Each option carries a paste-ready
                                                                      config snippet inline. Once the user picks one:
                                                                        option 1 or 2 → log10x_dependency_check
                                                                                        (paste the snippet from
                                                                                         pattern_mitigate.options[i].config_snippet)
                                                                        option 3       → log10x_dependency_check
                                                                                        → log10x_advise_install
                                                                        option 4       → log10x_configure_engine)
- (proactive): after log10x_top_patterns / log10x_event_lookup surfaces a
  high-volume pattern AND the user's framing is cost-related ("expensive", "bill", "save",
  "reduce", "spike"), offer to reduce it as a follow-up question — "Want me to show
  you options for reducing this?" Do this even if not asked. When the user says yes, call
  log10x_pattern_mitigate with the pattern identity from the prior row; it returns the
  env-gated mitigation options + exact configs for that pattern.

Cost investigation:
- "what's expensive right now" / "top patterns by cost" /
  "what changed" / "week-over-week delta" /
  "why did costs go up"                                          → log10x_top_patterns
  (log10x_top_patterns surfaces current rank + newly-emerged + delta-from-baseline
   for each pattern in one call. Use the \`comparison_window\` arg for "what changed
   since last week" framing.)
- "pipeline savings / ROI"                                       → log10x_savings

Offloaded cohort: RAW EVENTS the Receiver held back from the SIEM (the overflow bucket):
- "show me what's being offloaded for <pattern>", "sample the held-back events",
  "pull the raw events the Receiver kept out of Datadog/Splunk",
  "I need the offloaded events themselves, not aggregates"        → log10x_retriever_query
- "sample the offloaded <pattern> events"                         → log10x_retriever_query
- "verify the offload decision for customer X filtered by Y"      → log10x_retriever_query
  (Critical: retriever_query reads the offload bucket, the cohort the SIEM never received.
   It is not a mirror of indexed history. For events the SIEM still holds, the SIEM is the
   source. investigate returns aggregate pattern analysis; retriever_query returns the
   actual offloaded log lines. Re-ingest from the bucket is customer-driven, not an MCP action.)

Root-cause across services (the investigate wedge):
- user pastes an error, asks "what's causing the upstream"       → log10x_investigate
- Critical: log10x_investigate surfaces log-only signals (connection pool saturation, cache
  eviction storms, feature-flag cache flushes, retry amplification) that APM does NOT see
  because they manifest as slow-success traces, not errors. This is the structural wedge vs
  Datadog APM, Splunk APM, and OpenTelemetry tracing — correlation happens on the pattern-rate
  universe, not on spans that already exist.

Account / setup / discovery:
- "am I logged in" / "login status" / "what envs do I have"      → log10x_login_status
- "log me in" / "sign me up" / "create a Log10x account"         → log10x_signin_start, then log10x_signin_complete
  (Two-tool chain: log10x_signin_start opens the browser and returns the device_code + user_code,
   the model surfaces the code so the user can verify it matches the Auth0 page, then the model
   automatically calls log10x_signin_complete with that device_code to finish the flow. The user
   does NOT need to ask for the second step explicitly. For pasted-key sign-in instead of browser,
   skip log10x_signin_start and call log10x_signin_complete directly with { api_key: "<key>" }.)
- "sign out" / "log out" / "remove my credentials"               → log10x_signout
- "rotate my API key" / "I think my key was leaked"              → log10x_rotate_api_key
- "health check" / "is the MCP set up right" / "diagnose"        → log10x_doctor
- "create / rename / delete / set-default an env"                → log10x_{create,update,delete}_env
- "set analyzer cost" / "switch AI provider" / "use my own key"  → log10x_update_settings
- Critical: when the user asks about Log10x setup state, NEVER shell out to probe for a
  CLI binary. There is no log10x shell command. The MCP IS the surface. Framings like
  "is the log10x CLI installed", "log10x version", "whats my log10 status" should route
  to log10x_doctor or log10x_login_status — never to "which log10x" / "log10x --version"
  / env-var probes. If you find yourself reaching for shell tools to answer a Log10x
  question, stop and call the matching MCP tool instead.

NATURAL TOOL CHAINS

  Incident anchoring (user pastes a line during oncall):
    log10x_event_lookup  →  log10x_investigate
    (or for a batch: log10x_resolve_batch  →  log10x_investigate on the top pattern)

  Cost investigation:
    log10x_top_patterns  →  log10x_pattern_mitigate  →  log10x_dependency_check

  Mode selection and preview:
    log10x_start  →  log10x_cost_options  →  log10x_explain_mode  →  (apply) log10x_configure_engine
                                                                    →  (preview) log10x_preview_filter  →  log10x_pattern_detail  →  apply
    At reporter/dev tier log10x_cost_options returns 2 modes (observe_only + install_receiver);
    at receiver/retriever tier it returns 6 modes (drop/sample/compact/tier_down/offload/observe_only).

  Inspect the offloaded cohort for a pattern:
    log10x_event_lookup  →  log10x_retriever_query

RESPONSE STYLE

- For cost questions: show dollar amounts prominently, emphasize before→after deltas, flag new
  patterns. The value is attribution ("which specific patterns drive costs"), not "costs went up."
- For investigation results: confidence percentages are mechanically derived from data signal
  quality (stat × lag × chain for acute spikes; slope_sig × cohort for drift). When asked, walk
  the user through the decomposition.
- Never fabricate a pattern identity. The primitive is deterministic: same line → same identity,
  forever. If log10x_event_lookup returns no match, say so — do not guess.
- Honest empty returns are a feature. If log10x_investigate finds no significant movement, report
  that, do not pad with low-confidence noise.

NUMBERS DISCIPLINE — hard rules, no exceptions:

- Every dollar amount, percentage, event count, or timestamp in your response must appear
  verbatim in a tool result you called in this session. If you cannot point to the exact tool
  output, do not write the number. Say "not reported" instead.
- Do NOT compute percentages from before→after values — log10x_top_patterns emits the
  exact (+N%) delta on each row when comparison_window is set. Quote it. Do not re-derive it.
- Do NOT invent "peak" values. log10x_top_patterns returns window averages, not peaks.
  If the user asks for peaks, call log10x_pattern_trend explicitly and quote its max bucket.
- Do NOT synthesize a baseline number. If log10x_top_patterns does not list a pattern under
  the comparison_window delta, that pattern is not a cost driver — do not invent a baseline.
- log10x_dependency_check has two output modes. When SIEM credentials are present in the env
  (DD_API_KEY, SPLUNK_HOST+SPLUNK_TOKEN, ELASTIC_URL+KIBANA_URL, AWS chain), the tool runs the
  scan in-process and returns ACTUAL dashboard/alert/saved-search/monitor/metric-filter names
  + URLs — header reads "Dependency Check — <Vendor> (executed)". Treat these as authoritative.
  When credentials are missing, the tool falls back to a paste-ready bash command — header
  reads "(paste-ready)". In that case do NOT report "zero dependencies found" or "safe to drop"
  — wait for the user to run the script and paste back its results.

Analyzer cost is auto-detected from the user's profile. Typical rates if unspecified:
Splunk $6/GB, Datadog $2.50/GB, Elasticsearch $1/GB, CloudWatch $0.50/GB.

TOOL OUTPUT — AUDIENCE-SEPARATED MARKDOWN

Every tool returns one markdown blob. Two audiences read it:
  1. The user (sees rendered prose).
  2. You, the agent (read the raw text, chain follow-up calls).

The MCP marks agent-only content with these inline HTML comments so you can identify and consume them without leaking them to the user:

  <!-- agent-only: <free prose for the agent — constraints, suggested next calls, "do not X" warnings> -->
  <!-- NEXT_ACTIONS:[{...JSON tool-call hints...}] -->

Rule: when you produce a user-facing reply, DO NOT pass the contents of \`<!-- agent-only: ... -->\` or \`<!-- NEXT_ACTIONS: ... -->\` blocks to the user verbatim. They are tool→agent communication.

Consume them by:
  - Using the constraints inside \`agent-only\` to shape your synthesis (e.g., "do not re-label current-rank as growth" → say "top patterns by current cost" not "top cost drivers").
  - Using the \`NEXT_ACTIONS\` JSON when you decide your next tool call.

The visible markdown is the FACTS the user gets. Everything inside an HTML comment is for you to internalize, not relay.

INTERPRETING METRIC PATTERNS — what you may and may not say

Tool responses carry rich label context per series (message_pattern, severity_level, k8s_container, k8s_namespace, k8s_pod, tenx_user_service, tenx_user_process, instance, http_code, http_message, tenx_reported_name, tenx_unit_name, etc.). When the user asks you to describe or explain a result, you may decode and interpret these labels — that produces more useful prose than a deterministic decoder ever will. But it comes with strict rules to keep your synthesis grounded.

1. **Cite the source — by default LIGHTLY.** Render the decoded prose first, with the raw token suppressed or shown only as a short inline annotation. Heavy citation (full \`message_pattern=...\` blocks, side-by-side raw/decoded tables) is reserved for when the user explicitly asks for verification or when a row makes a high-stakes claim (cost driver, regression, safe-to-drop). The default user experience is the decode; the citation is on demand. If you can't cite at all, don't make the claim.

2. **Numbers come from the response.** Quote dollar amounts and byte volumes verbatim from the tool output. Scaling math (12h → annual, etc.) is allowed only when you show the arithmetic ("$1.4/12h × 730 = $1,022/yr"). Never derive a figure in your head and present it as a fact.

3. **Two tiers when the user asks for verification or audit.** A "**Facts:**" / "**Interpretation:**" split is appropriate when the user is auditing or debugging your synthesis. For a normal "show me X" request, write the decoded answer inline — facts and interpretation woven together — and skip the tiering. Default to terse, single-pass prose; reach for the two-tier layout only when warranted.

4. **Refusal beats guess.** If you don't recognize a \`message_pattern\` token, severity, or label value with high confidence, say "symbol unknown" or "context unclear" and run \`log10x_event_lookup\` for a known sample. When the pattern is under an active offload action, \`log10x_retriever_query\` can sample the held-back events. Do not invent a plausible-sounding identity.

5. **No reference to patterns/services/severities outside the response.** The label set in the tool result is the universe. Phrases like "you probably also have…" or "I'd expect to see…" are forbidden — they invite the user to look for problems that aren't in the data.

6. **No "safe to drop" claims without dependency_check.** You may SUGGEST muting or dropping a pattern. You may NOT assert it's safe. "Safe to drop" / "won't break any dashboards" / "no alerts depend on this" all require \`log10x_dependency_check\` evidence in the same conversation turn. The drop chain is deliberately gated this way to firewall interpretive hallucination from production-affecting action.

7. **Semantic decode for recognized public packages.** Syntactic renaming alone ("tgo_opentelemetry_io_collector_consumer_logs_go" → "consumer logs.go") is useless to a reader who doesn't already know what the file does. When the decoded symbol refers to a **widely-known public package, library, framework, or service** that you recognize with high confidence — OpenTelemetry Collector internals, AWS / GCP / Azure SDK code paths, Kafka clients, JVM runtimes, Stripe/Twilio/SendGrid SDKs, Kubernetes / Envoy / Istio internals, common ORMs, common databases, etc. — describe what the code path actually does in one short business-term phrase. Example: not "consumer logs.go" but "OTel Collector's logs-consumer dispatch — hands log batches from processors to exporters". This is not fabrication; it is recognition of public OSS / vendor code whose purpose is documented. For symbols that look CUSTOM to the user's own codebase (their company package names, internal service names, or anything you don't recognize confidently), render the decoded identifier only and say "application-specific symbol" or "unknown function". Confidence gate: if you wouldn't bet on the business meaning without checking the source, stay literal.

Decoding aids you may use:
- \`message_pattern\` tokens of shape \`<vendor>_<package>_<subpackage>_<file_or_method>\` are usually Go package paths or fully-qualified Go functions. Reconstruct with \`/\` separators and recognize the shape (e.g., \`go_opentelemetry_io_collector_…\` → \`go.opentelemetry.io/collector/…\`).
- Tokens ending \`_go\` are typically Go source-file references.
- CamelCase trailing tokens (e.g., \`…ConsumeLogsFunc_ConsumeLogs\`) usually indicate a Go method on a type.
- Tokens containing \`_id_\`, \`_name_\`, \`_version_\` often indicate a log line carrying those keys as resource attributes — the severity label may reflect the wrapper severity, not a real error semantic. Flag this distinction when relevant.

These are aids, not certainties. Cite the raw token; let the user verify.`,
};

// Primary server instance. Used for the stdio transport (the published npm
// entrypoint) and as the reference handle for the few tools that take a server
// handle (poc_* / advise_install — gated off in the hosted demo). The HTTP
// transport builds a fresh server per session via configureServer().
const server = new McpServer(SERVER_INFO, SERVER_OPTIONS);

// ── Self-telemetry ──
// recordStart() arms the tool-call counter (log10x_mcp_tool_call_total) the
// Log10x console reads to detect MCP activity. Silent no-op unless LOG10X_API_KEY
// + PROMETHEUS_REMOTE_WRITE_URL (or LOG10X_TELEMETRY_URL) are set.
//
// Per-call telemetry wrapping (withTelemetry) and the RegisteredTool registry
// (consumed by applyManifestToTools) are applied per-server inside
// applyToolRegistrations() / configureServer(), so the same logic serves both
// the stdio server and the per-session servers the HTTP transport builds.
recordStart();

/**
 * Register a Log10x tool, pulling its title / description / annotations from
 * the package-baked `default-manifest.json`. Each call site only carries the
 * concrete schema + handler — copy lives in JSON, edited as a manifest, and
 * remote overrides patch it at boot.
 *
 * Throws synchronously if the tool name has no entry in default-manifest.json
 * (build-time guard against drift between code and manifest).
 */
// Pending registrations queue. Top-level registerLog10xTool() calls
// push here at module load (before mode detection runs). After
// initBootMode() resolves the mode in main(), applyToolRegistrations()
// drains the queue and registers only the tools whose TOOL_MODES
// entry includes the current boot mode. Tools registered before
// bootMode is set (e.g. integration tests that bypass main()) fall
// through to a permissive register-everything path.
type PendingTool = {
  name: string;
  inputSchema: Record<string, unknown>;
  handler: (
    args: any,
    extra?: { sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void> }
  ) => Promise<WrapResult>;
};
const pendingTools: PendingTool[] = [];

function registerLog10xTool(
  name: string,
  inputSchema: Record<string, unknown>,
  handler: (
    args: any,
    extra?: { sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void> }
  ) => Promise<WrapResult>
): void {
  // Validate manifest entry at queue-time so the build-time guard still
  // catches missing default-manifest.json entries before main() runs.
  getPackageDefaultTool(name);
  pendingTools.push({ name, inputSchema, handler });
}

/**
 * Drain the pending registration queue against the server, gated by
 * the current boot mode. Tools not allowed in this mode are skipped
 * entirely (they will not appear in tools/list). Called from main()
 * after initBootMode() resolves the operating mode.
 */
/**
 * G5: operator-side category gates. Three env vars at boot:
 *
 *   LOG10X_MCP_ENABLED_CATEGORIES=cost,identify,investigate
 *     Allowlist. When set, ONLY tools whose category is in the list register.
 *     Empty / unset = all categories allowed.
 *
 *   LOG10X_MCP_DISABLED_CATEGORIES=poc,account
 *     Blocklist. Applied after the allowlist. Categories listed are skipped.
 *
 *   LOG10X_MCP_DISABLE_WRITE=true
 *     When true, every tool whose annotation `readOnlyHint` is explicitly
 *     `false` is skipped — useful for read-only customer demos, prospect
 *     evals, and CI sandboxes where the agent must not mutate state.
 *
 * Reads at applyToolRegistrations() time, after manifest load and mode
 * detect. Resolution order: mode-detect first (analysis/poc), then
 * category-allow, then category-deny, then write-disable.
 */
interface OperatorGate {
  enabledCategories: Set<string> | null;
  disabledCategories: Set<string>;
  disableWrite: boolean;
}
/**
 * G11: build the `_meta` block that ships on each tool definition. Carries
 * operational metadata that doesn't fit in the description (which is for
 * the agent's prompt) but that ranking-aware hosts can read.
 *
 * Fields:
 *   - category: same as the operator-gate category (cost / identify / ...).
 *     Lets a host group tools by category in its UI without parsing the
 *     description prose.
 *   - tier: which Log10x component the tool needs deployed at the customer
 *     side. Derived from category as a coarse default; per-tool overrides
 *     could live in the manifest later but the category mapping is right
 *     90+% of the time.
 *       cost/identify/investigate/drop  → 'reporter'
 *       retrieve                        → 'retriever'
 *       detect                          → 'cli'  (paste-mode runs locally)
 *       install/poc/account             → 'none'
 *   - confirmation_required: true when the tool ships a literal-string
 *     confirm gate (`confirm: "rotate-now"`, `confirm_name: "<env>"`).
 *     Lets hosts surface a clearer prompt before invocation.
 */
function buildToolMeta(
  name: string,
  category: string,
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; [k: string]: unknown } | undefined
): Record<string, unknown> {
  const tier =
    category === 'retrieve' ? 'retriever' :
    (category === 'detect' || category === 'compile') ? 'cli' :
    (category === 'install' || category === 'poc' || category === 'account') ? 'none' :
    'reporter';
  const confirmationRequired =
    name === 'log10x_delete_env' || name === 'log10x_rotate_api_key';
  return {
    category: category || 'uncategorized',
    tier,
    ...(confirmationRequired ? { confirmation_required: true } : {}),
    ...(annotations?.readOnlyHint === false ? { mutates_state: true } : {}),
  };
}

function readOperatorGate(): OperatorGate {
  const splitCsv = (s: string | undefined): Set<string> => new Set(
    (s ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
  );
  const enabled = process.env.LOG10X_MCP_ENABLED_CATEGORIES;
  const enabledSet = enabled && enabled.trim().length > 0 ? splitCsv(enabled) : null;
  const disabled = splitCsv(process.env.LOG10X_MCP_DISABLED_CATEGORIES);
  const disableWrite = /^(1|true|yes)$/i.test(process.env.LOG10X_MCP_DISABLE_WRITE ?? '');
  return { enabledCategories: enabledSet, disabledCategories: disabled, disableWrite };
}

function applyToolRegistrations(
  target: McpServer,
  registry: Map<string, RegisteredTool>
): { registered: string[]; skipped: string[] } {
  const mode = bootMode?.mode;
  const gate = readOperatorGate();
  const registered: string[] = [];
  const skipped: string[] = [];
  // Every tool publishes the envelope's shape as its `outputSchema`. The
  // per-tool `data` field is `z.unknown()` at the envelope layer — its real
  // shape lives in each tool's TypeScript interface and in the rendered docs.
  // We declare it uniformly here so MCP hosts that honor `outputSchema`
  // (Claude Desktop, ChatGPT Desktop) get a contract; hosts that don't,
  // ignore it. Pair with `structuredContent` on every result in wrap().
  const envelopeOutputSchema = StructuredOutputSchema.shape;
  for (const t of pendingTools) {
    const allowed = mode ? shouldRegisterTool(t.name, mode) : true;
    if (!allowed) {
      skipped.push(t.name);
      continue;
    }
    const meta = getPackageDefaultTool(t.name);
    // G5: category + write gates.
    const category = (meta.category ?? '').toLowerCase();
    // G11: _meta block surfaced on the tool definition. The MCP spec allows
    // arbitrary `_meta` on tools and on results; hosts that rank tools by
    // category / tier / safety profile (some autonomous agents do) consume
    // this. Hosts that don't see it ignore it. Grafana ships zero _meta
    // today, so this is straight lead.
    const toolMeta = buildToolMeta(t.name, category, meta.annotations);
    if (gate.enabledCategories && (!category || !gate.enabledCategories.has(category))) {
      log.info(`tool.${t.name}.gated_out`, { reason: 'category not in LOG10X_MCP_ENABLED_CATEGORIES', category });
      skipped.push(t.name);
      continue;
    }
    if (category && gate.disabledCategories.has(category)) {
      log.info(`tool.${t.name}.gated_out`, { reason: 'category in LOG10X_MCP_DISABLED_CATEGORIES', category });
      skipped.push(t.name);
      continue;
    }
    if (gate.disableWrite && meta.annotations && meta.annotations.readOnlyHint === false) {
      log.info(`tool.${t.name}.gated_out`, { reason: 'LOG10X_MCP_DISABLE_WRITE=true and tool has readOnlyHint:false' });
      skipped.push(t.name);
      continue;
    }
    // G3: wrap every input field with a coercive preprocess so the SDK's
    // strict Zod validation accepts the type-loose inputs LLM hosts
    // routinely emit (e.g., `"limit": "5"` instead of `"limit": 5`, or
    // `"events": "one event"` instead of `"events": ["one event"]`). The
    // wrapper preserves the agent-facing JSON Schema and the handler's
    // typed args, so downstream code is unchanged.
    const coerciveInputSchema = makeShapeCoercive(t.inputSchema as Record<string, never>);
    const registeredTool = (target.registerTool as any)(
      t.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: coerciveInputSchema,
        outputSchema: envelopeOutputSchema,
        annotations: meta.annotations,
        _meta: toolMeta,
      },
      withTelemetry(t.name, t.handler)
    );
    registry.set(t.name, registeredTool);
    registered.push(t.name);
  }
  return { registered, skipped };
}

// ── Tool: log10x_event_lookup ──

registerLog10xTool('log10x_event_lookup', eventLookupSchema, (args) =>
  wrap('log10x_event_lookup', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeEventLookup(args, env);
  })
);

// ── Tool: log10x_pattern_examples ──
//
// Orchestration primitive for fetching live SIEM events for one pattern
// with template-extracted slot values. Designed for `log10x_investigate`
// (or another orchestrator) to call autonomously when the chain needs
// event evidence. See memory/project_pattern_examples_design.md for the
// full design contract — read before changing this tool's shape.

registerLog10xTool('log10x_pattern_examples', patternExamplesSchema, (args) =>
  wrap('log10x_pattern_examples', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executePatternExamples(args, env);
  })
);

// ── Tool: log10x_product_qa ──
//
// Local docs-corpus lookup. No env / TSDB / SIEM dependency — the
// corpus is shipped inside the build at build/product-kb/docs (the
// build script copies it from config/mksite/docs). See
// src/lib/product-kb/index.ts for path resolution + override env.

registerLog10xTool('log10x_product_qa', productQaSchema, (args) =>
  wrap('log10x_product_qa', async () => executeProductQa(args))
);

// ── Tool: log10x_savings ──

registerLog10xTool('log10x_savings', savingsSchema, (args) =>
  wrap('log10x_savings', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeSavings(args, env);
  })
);

// ── Tool: log10x_pattern_trend ──

registerLog10xTool('log10x_pattern_trend', trendSchema, (args) =>
  wrap('log10x_pattern_trend', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeTrend(args, env);
  })
);

// ── Tool: log10x_dependency_check ──

registerLog10xTool('log10x_dependency_check', dependencyCheckSchema, (args) =>
  wrap('log10x_dependency_check', async () => executeDependencyCheck(args))
);

// ── Tool: log10x_configure_env ──
// Conversational onboarding entry point. Takes a backend config
// (discriminated union by kind), runs the live-backend validator,
// and on success persists to ~/.log10x/envs.json. Every metric tool
// surfaces this tool's name in its `not_configured` response so the
// agent knows how to drive setup.

registerLog10xTool('log10x_configure_env', configureEnvSchema, (args) =>
  wrap('log10x_configure_env', async () => {
    return executeConfigureEnv(args);
  })
);

// ── Tool: log10x_set_gitops_repo ──
// Write gitops.repo to ~/.log10x/envs.json so configure_engine can author
// cap-CSV PRs. Separate from configure_env because configure_env requires
// live-backend validation and is the wrong entry point for a gitops-only
// field update on an already-configured env.

registerLog10xTool('log10x_set_gitops_repo', setGitopsRepoSchema, (args) =>
  wrap('log10x_set_gitops_repo', async () => {
    return executeSetGitopsRepo(args);
  })
);

// ── Tool: log10x_dest_set ──
// Edit the SIEM destination block on an env-config document. Separate
// from configure_env (which validates the live metrics backend before
// writing) so the agent can change destination fields without re-supplying
// backend credentials.

registerLog10xTool('log10x_dest_set', destSetSchema, (args) =>
  wrap('log10x_dest_set', async () => {
    return executeDestSet(args);
  })
);

// ── Tool: log10x_env_validate ──
// Schema + cross-field sanity over a stored env-config document. Catches
// destination/region mismatches, ingest_url shape issues, cluster-vs-offload
// type misalignments before downstream tools fail with vendor errors.

registerLog10xTool('log10x_env_validate', envValidateSchema, (args) =>
  wrap('log10x_env_validate', async () => {
    return executeEnvValidate(args);
  })
);

// ── Tool: log10x_env_diff_vs_envvars ──
// Compare the stored env doc against the LOG10X_* env vars the bridge
// would have produced. Surfaces "I set the env var but it's being ignored"
// drift with per-field recommendations.

registerLog10xTool('log10x_env_diff_vs_envvars', envDiffVsEnvvarsSchema, (args) =>
  wrap('log10x_env_diff_vs_envvars', async () => {
    return executeEnvDiffVsEnvvars(args);
  })
);

// ── Tool: log10x_offload_add ──
// Append a new entry to the env-config document's offload_destinations[].
// Multi-target is the documented use case (drain a legacy bucket while a
// new one is primary); the schema array stays non-empty by default.

registerLog10xTool('log10x_offload_add', offloadAddSchema, (args) =>
  wrap('log10x_offload_add', async () => {
    return executeOffloadAdd(args);
  })
);

// ── Tool: log10x_offload_archive ──
// Flip one destination's status to `archived` (kept in the list as a
// historical reference). Refuses when the target is the last active
// destination — the Receiver needs at least one active destination to
// route the dropped slice to.

registerLog10xTool('log10x_offload_archive', offloadArchiveSchema, (args) =>
  wrap('log10x_offload_archive', async () => {
    return executeOffloadArchive(args);
  })
);

// ── Tool: log10x_top_patterns ──

registerLog10xTool('log10x_top_patterns', topPatternsSchema, (args) =>
  wrap('log10x_top_patterns', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeTopPatterns(args, env);
  })
);

// ── Tool: log10x_pattern_diff ──
//
// Set diff of patterns across a time boundary. Compares pattern presence in
// two windows and returns new / retired / persistent / re_emerged sets plus
// co_emergence_clusters (deploy fingerprint via first_seen clustering).
// Coherent only because log10x pattern_hash is stable across queries;
// competitors that re-cluster per query can't answer this.

registerLog10xTool('log10x_pattern_diff', patternDiffSchema, (args) =>
  wrap('log10x_pattern_diff', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executePatternDiff(args, env);
  })
);

// ── Tool: log10x_whats_changing ──
//
// Patterns ranked by delta vs a baseline window (not current cost). Restores
// the capability of the removed log10x_cost_drivers tool
// using the modern StructuredOutput envelope. Brand-new patterns (no
// baseline) are excluded — they go to log10x_whats_new.

registerLog10xTool('log10x_whats_changing', whatsChangingSchema, (args) =>
  wrap('log10x_whats_changing', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeWhatsChanging(args, env);
  })
);

// ── Tool: log10x_whats_new ──
//
// Patterns whose first_seen timestamp falls inside a recency window. Sister
// tool to whats_changing — new patterns have no baseline, so they get a
// clean home that doesn't pollute the delta-vs-baseline surface.

registerLog10xTool('log10x_whats_new', whatsNewSchema, (args) =>
  wrap('log10x_whats_new', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeWhatsNew(args, env);
  })
);

// ── Tool: log10x_services ──

registerLog10xTool('log10x_services', servicesSchema, (args) =>
  wrap('log10x_services', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeServices(args, env);
  })
);

// ── Tool: log10x_overflow_contents ──
//
// The contents view of the
// customer-owned offload bucket. Queries dropped-by-pattern from the
// TSDB, joins to the cap-CSV to filter to action=offload only, and
// routes the agent to log10x_retriever_query to inspect the offloaded cohort. See
// the long docstring on src/tools/overflow-contents.ts for the
// design rationale + cap-CSV degraded-mode semantics.

registerLog10xTool('log10x_overflow_contents', overflowContentsSchema, (args) =>
  wrap('log10x_overflow_contents', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeOverflowContents(args, env);
  })
);

// ── Tool: log10x_discover_labels ──

registerLog10xTool('log10x_discover_labels', discoverLabelsSchema, (args) =>
  wrap('log10x_discover_labels', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeDiscoverLabels(args, env);
  })
);

// ── Tool: log10x_investigate ──

registerLog10xTool('log10x_investigate', investigateSchema, (args) =>
  wrap('log10x_investigate', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeInvestigate(args, env);
  })
);

// ── Tool: log10x_resolve_batch ──

// ── Tool: log10x_find_skew ──

registerLog10xTool('log10x_find_skew', findSkewSchema, (args) =>
  wrap('log10x_find_skew', async () => executeFindSkew(args))
);

// find_constant_slots / find_uuid_in_body / find_incident_cluster
// removed pre-launch — see the import-block note above.

registerLog10xTool('log10x_resolve_batch', resolveBatchSchema, (args) =>
  wrap('log10x_resolve_batch', async () => executeResolveBatch(args))
);

// ── Tool: log10x_compile_start ──

registerLog10xTool('log10x_compile_start', compileStartSchema, (args) =>
  wrap('log10x_compile_start', async () => executeCompileStart(args))
);

// ── Tool: log10x_compile_status ──

registerLog10xTool('log10x_compile_status', compileStatusSchema, (args) =>
  wrap('log10x_compile_status', async () => executeCompileStatus(args))
);

// ── Tool: log10x_compile_link ──

registerLog10xTool('log10x_compile_link', compileLinkSchema, (args) =>
  wrap('log10x_compile_link', async () => executeCompileLink(args))
);

// ── Tool: log10x_extract_templates ──

registerLog10xTool('log10x_extract_templates', extractTemplatesSchema, (args) =>
  wrap('log10x_extract_templates', async () => executeExtractTemplates(args))
);

// ── Tool: log10x_retriever_query ──

registerLog10xTool('log10x_retriever_query', retrieverQuerySchema, (args) =>
  wrap('log10x_retriever_query', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeRetrieverQuery(args, env);
  })
);

// ── Tool: log10x_retriever_series ──

registerLog10xTool('log10x_retriever_series', retrieverSeriesSchema, (args) =>
  wrap('log10x_retriever_series', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeRetrieverSeries(args, env);
  })
);

// ── Tool: log10x_retriever_query_status ──

registerLog10xTool('log10x_retriever_query_status', retrieverQueryStatusSchema, (args) =>
  wrap('log10x_retriever_query_status', async () => executeRetrieverQueryStatus(args))
);

// ── Tool: log10x_retriever_probe ──
//
// End-to-end probe of the deployed retriever chain. Fires a synthetic query
// and asserts every stage (offload bucket freshness, indexer pipeline running,
// SQS depths, pod ready, CloudWatch scan/stream events, S3 qr/*.jsonl, MCP
// events returned). Returns a structured verdict (green / broken / unknown)
// with per-stage asserts and a remedy on the first failure.

registerLog10xTool('log10x_retriever_probe', retrieverProbeSchema, (args) =>
  wrap('log10x_retriever_probe', async () => executeRetrieverProbe(args))
);

// ── Tool: log10x_retriever_register ──
//
// Write the Retriever endpoint + queue coordinates onto an existing
// environment-config document. Requires `log10x_env_register` to have
// created the env first — refuses on env_not_found rather than
// stamping a partial document the rest of the schema can't satisfy.

registerLog10xTool('log10x_retriever_register', retrieverRegisterSchema, (args) =>
  wrap('log10x_retriever_register', async () => executeRetrieverRegister(args))
);

// ── Tool: log10x_backfill_metric ──

registerLog10xTool('log10x_backfill_metric', backfillMetricSchema, (args) =>
  wrap('log10x_backfill_metric', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeBackfillMetric(args, env);
  })
);

// ── Tool: log10x_start ──
//
// THE orientation tool the agent calls FIRST whenever a user expresses a
// cost-cutting goal or open-ended platform question. Returns a structured
// envelope with three compliance levers (must_render_verbatim,
// must_ask_user, forbidden_next_actions) that pin the agent into the
// orientation handshake before any other tool fires.

registerLog10xTool('log10x_start', log10xStartSchema, (args) =>
  wrap('log10x_start', async () => executeLog10xStart(args))
);

// ── Tool: log10x_cost_options ──
//
// Called after the user picks option 1 from log10x_start. Returns the
// outcome-first 6-mode action menu (drop / sample / compact / tier_down /
// offload / observe_only) at Receiver tier, or a 2-item collapsed menu
// (observe_only + install_receiver) at Reporter-only / Dev tier.

registerLog10xTool('log10x_cost_options', costOptionsSchema, (args) =>
  wrap('log10x_cost_options', async () =>
    executeCostOptions(args as { target_percent?: number; service?: string })
  )
);

// ── Tool: log10x_explain_mode ──
//
// Called after the user picks a mode from log10x_cost_options. Explains
// the chosen enforcement mode in service-level plain language before any
// action is taken, then offers Apply or Preview.

registerLog10xTool('log10x_explain_mode', explainModeSchema, (args) =>
  wrap('log10x_explain_mode', async () => executeExplainMode(args))
);

// ── Tool: log10x_preview_filter ──
//
// Shows the list of patterns that would be affected by the chosen mode
// before any action is taken. Fixed-width plain-text table with trend
// sparklines. Drills down to log10x_pattern_detail per row.

registerLog10xTool('log10x_preview_filter', previewFilterSchema, (args) =>
  wrap('log10x_preview_filter', async () => executePreviewFilter(args))
);

// ── Tool: log10x_pattern_detail ──
//
// Full single-pattern view: lineChart, cross-service bar chart, severity
// breakdown, and sample events. Called from log10x_preview_filter rows.

registerLog10xTool('log10x_pattern_detail', patternDetailSchema, (args) =>
  wrap('log10x_pattern_detail', async () => executePatternDetail(args))
);

// ── Tool: log10x_measure_compaction ──
//
// Measures real per-pattern compaction ratios from live SIEM samples.
// Requires the tenx CLI (for the engine run) and SIEM credentials (for the
// event pull). Does not need a metrics backend — local CLI + SIEM only.

registerLog10xTool('log10x_measure_compaction', measureCompactionSchema, (args) =>
  wrap('log10x_measure_compaction', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeMeasureCompaction(args, env);
  })
);

// ── Tool: log10x_setup_recurring ──
//
// Conversational wizard that configures a recurring autonomous cost-reduction
// agent. Emits policy.yaml + a scheduler manifest (CronJob / GHA / crontab).
// Available in analysis + analysis_pending modes (requires a live deployment).

registerLog10xTool('log10x_setup_recurring', setupRecurringSchema, (args) =>
  wrap('log10x_setup_recurring', async () => executeSetupRecurring(args))
);

// ── Tool: log10x_doctor ──

registerLog10xTool('log10x_doctor', doctorSchema, (args) =>
  wrap('log10x_doctor', async () => executeDoctor(args))
);

// ── Tool: log10x_login_status ──

registerLog10xTool('log10x_login_status', loginStatusSchema, () =>
  wrap('log10x_login_status', async () => executeLoginStatus({}, getEnvs()))
);

// ── Tool: log10x_signin_start ──
//
// Step 1 of the sign-in chain: requests an Auth0 device code, opens the
// user's browser, and returns the user_code + device_code immediately.
// Returns synchronously (no polling) because Cursor and most other MCP
// hosts do NOT render mid-tool `notifications/message` push, so the
// only reliable way to surface the user_code to a human is to put it
// in the tool's response markdown. The model then calls
// `log10x_signin_complete` with the device_code to finish the flow.

registerLog10xTool('log10x_signin_start', signinStartSchema, () =>
  wrap('log10x_signin_start', async () => executeSigninStart())
);

// ── Tool: log10x_signin_complete ──
//
// Step 2 of the sign-in chain. Two paths via mutually-exclusive args:
//   - { device_code }: finishes a browser flow started by `_start`.
//     Polls Auth0 until the user confirms in the browser, then
//     exchanges the access token for a Log10x API key.
//   - { api_key }:     pasted-key path. Validates the key against
//     /api/v1/user and persists. No browser, no IdP.
// Either path writes the resolved API key to ~/.log10x/credentials,
// hot-reloads envs in-process, and clears any overriding
// LOG10X_API_KEY env var so the new key wins the priority chain.

registerLog10xTool('log10x_signin_complete', signinCompleteSchema, (args) =>
  wrap('log10x_signin_complete', async () => executeSigninComplete(args, getEnvs()))
);

// ── Tool: log10x_signout ──

registerLog10xTool('log10x_signout', signoutSchema, () =>
  wrap('log10x_signout', async () => executeSignout({}, getEnvs()))
);

// ── Tool: log10x_update_settings ──

registerLog10xTool('log10x_update_settings', updateSettingsSchema, (args) =>
  wrap('log10x_update_settings', async () => executeUpdateSettings(args, getEnvs()))
);

// ── Tool: log10x_create_env ──

registerLog10xTool('log10x_create_env', createEnvSchema, (args) =>
  wrap('log10x_create_env', async () => executeCreateEnv(args, getEnvs()))
);

// ── Tool: log10x_update_env ──

registerLog10xTool('log10x_update_env', updateEnvSchema, (args) =>
  wrap('log10x_update_env', async () => executeUpdateEnv(args, getEnvs()))
);

// ── Tool: log10x_delete_env ──

registerLog10xTool('log10x_delete_env', deleteEnvSchema, (args) =>
  wrap('log10x_delete_env', async () => executeDeleteEnv(args, getEnvs()))
);

// ── Tool: log10x_env_register ──
//
// Writes a full EnvironmentConfig document (cluster identity, SIEM
// destination, offload destinations, streamer + retriever endpoints)
// to whichever on-prem store the customer's cloud uses. Distinct from
// create_env: that mints account-level identity on the SaaS backend;
// this writes the cluster-side descriptor every tool resolves against.

registerLog10xTool('log10x_env_register', envRegisterSchema, (args) =>
  wrap('log10x_env_register', async () => executeEnvRegister(args))
);

// ── Tool: log10x_rotate_api_key ──

registerLog10xTool('log10x_rotate_api_key', rotateApiKeySchema, (args) =>
  wrap('log10x_rotate_api_key', async () => executeRotateApiKey(args, getEnvs()))
);

// ── Tool: log10x_customer_metrics_query (v1.4) ──

registerLog10xTool('log10x_customer_metrics_query', customerMetricsQuerySchema, (args) =>
  wrap('log10x_customer_metrics_query', async () => executeCustomerMetricsQuery(args))
);

// ── Tool: log10x_discover_join (v1.4) ──

registerLog10xTool('log10x_discover_join', discoverJoinSchema, (args) =>
  wrap('log10x_discover_join', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeDiscoverJoin(args, env);
  })
);

// ── Cross-pillar primitives ────────────────────────────────────────────
//
// Three deterministic primitives that compose to a cross-pillar flow:
// filter movers → rank by shape → overlay top-K. The agent composes them;
// the tools return raw arithmetic, no tier and no causal framing.
//
// Validated against a 58-candidate chaos test where the composition filtered
// to 5 real signals (zero confounders, zero noise) and let an LLM judge
// build a coherent SRE cascade narrative (DNS → retry → dep latency →
// heap → GC → anchor).

registerLog10xTool('log10x_metrics_that_moved', metricsThatMovedSchema, (args) =>
  wrap('log10x_metrics_that_moved', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeMetricsThatMoved(args, env);
  })
);

registerLog10xTool(
  'log10x_rank_by_shape_similarity',
  rankByShapeSimilaritySchema,
  (args) =>
    wrap('log10x_rank_by_shape_similarity', async () => {
      const env = resolveEnv(getEnvs(), args.environment);
      return executeRankByShapeSimilarity(args, env);
    })
);

registerLog10xTool('log10x_metric_overlay', metricOverlaySchema, (args) =>
  wrap('log10x_metric_overlay', async () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeMetricOverlay(args, env);
  })
);

// ── Tool: log10x_poc_from_siem_submit / _status ──
//
// Async pair: submit kicks off a background pull + templatize + render;
// status polls for progress and returns the final markdown once done.
// Supports 8 SIEMs (cloudwatch, datadog, sumo, gcp-logging, elasticsearch,
// azure-monitor, splunk, clickhouse) with auto-discovery of credentials.

registerLog10xTool('log10x_poc_from_siem_submit', pocFromSiemSubmitSchema, (args) =>
  wrap('log10x_poc_from_siem_submit', async () =>
    executePocSubmit({
      window: args.window ?? '7d',
      target_event_count: args.target_event_count ?? 250_000,
      max_pull_minutes: args.max_pull_minutes ?? 5,
      privacy_mode: args.privacy_mode ?? true,
      ai_prettify: args.ai_prettify ?? true,
      total_daily_gb: args.total_daily_gb,
      total_monthly_gb: args.total_monthly_gb,
      total_annual_gb: args.total_annual_gb,
      auto_detect_volume: args.auto_detect_volume ?? true,
      _mcpServer: server,
      siem: args.siem,
      scope: args.scope,
      query: args.query,
      analyzer_cost_per_gb: args.analyzer_cost_per_gb,
      environment: args.environment,
      clickhouse_table: args.clickhouse_table,
      clickhouse_timestamp_column: args.clickhouse_timestamp_column,
      clickhouse_message_column: args.clickhouse_message_column,
      clickhouse_service_column: args.clickhouse_service_column,
      clickhouse_severity_column: args.clickhouse_severity_column,
      target_percent_reduction: args.target_percent_reduction,
      exception_services: args.exception_services,
    })
  )
);

registerLog10xTool('log10x_poc_from_siem_status', pocFromSiemStatusSchema, (args) =>
  wrap('log10x_poc_from_siem_status', async () => executePocStatus(args))
);

// ── Tool: log10x_poc_from_local ──
//
// Local-source POC: pulls log lines from kubectl (and, in follow-up
// work, docker / journald) when no log-analyzer connection is
// available. Distinct from log10x_poc_from_siem in three ways:
//   1. No vendor credentials needed (uses ambient kubeconfig)
//   2. Cost framing is an industry-pricing matrix, NOT a prediction
//      of any specific bill — kubectl only sees pod stdout, not
//      CloudTrail / ALB / VM-hosted apps
//   3. Synchronous (kubectl pull is fast); no snapshot lifecycle
// The user must explicitly invoke this tool — there is NO automatic
// fallthrough from log10x_poc_from_siem when SIEM creds fail. Implicit
// fallthrough would let a prospect see local-source numbers framed as
// if they were SIEM bill predictions; explicit invocation forces the
// caller to acknowledge the framing change.

registerLog10xTool('log10x_poc_from_local', pocFromLocalSchema, (args) =>
  wrap('log10x_poc_from_local', async () =>
    executePocFromLocal({
      source: args.source ?? 'kubectl',
      namespace: args.namespace ?? 'default',
      window: args.window ?? '1h',
      per_pod_limit: args.per_pod_limit ?? 5000,
      max_pods: args.max_pods ?? 20,
      privacy_mode: args.privacy_mode ?? true,
      target_percent_reduction: args.target_percent_reduction,
      exception_services: args.exception_services,
    })
  )
);

// ── Tool: log10x_discover_env (install advisor) ──

registerLog10xTool('log10x_discover_env', discoverEnvSchema, (args) =>
  wrap('log10x_discover_env', () => executeDiscoverEnv(args, bootMode?.mode ?? null))
);

// ── Tool: log10x_advise_retriever (install advisor) ──

registerLog10xTool('log10x_advise_retriever', adviseRetrieverSchema, (args) =>
  wrap('log10x_advise_retriever', () => executeAdviseRetriever(args))
);

// ── Tool: log10x_advise_install (install wizard for Reporter / Receiver) ──

registerLog10xTool('log10x_advise_install', adviseInstallSchema, (args) =>
  wrap('log10x_advise_install', () => executeAdviseInstall(args, getEnvs(), server))
);

// ── Tool: log10x_configure_engine (unified per-pattern action-plan PR author) ──

registerLog10xTool('log10x_configure_engine', configureEngineSchema, (args) =>
  wrap('log10x_configure_engine', () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeConfigureEngine(args, env);
  })
);

// ── Tool: log10x_estimate_savings (forecast + verify modes) ──

registerLog10xTool('log10x_estimate_savings', estimateSavingsSchema, (args) =>
  wrap('log10x_estimate_savings', () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeEstimateSavings(args, env);
  })
);

// ── Tool: log10x_baseline (Reporter-age / coverage / anomaly readiness gates) ──

registerLog10xTool('log10x_baseline', baselineSchema, (args) =>
  wrap('log10x_baseline', () => {
    const env = resolveEnv(getEnvs(), args.environment);
    return executeBaseline(args, env);
  })
);

// ── Wire runEstimateVerify into commitment_report at module load ──
//
// commitment_report defers to a runner installed via `_setVerifyRunner`
// so the weekly aggregator can be unit-tested with a stub. Without this
// wiring, every commitment_report call hard-returns a not_ready envelope
// (see commitment-report.ts:1016). The runner closure:
//   1. Looks up the EnvConfig from the commitment's env nickname
//      (envs are loaded once in initEnvs() before server.connect, so
//      getEnvs() is safe inside this async body).
//   2. Translates the (week_start, week_end) cursor into a post_window
//      length runEstimateVerify accepts ("Nd"). The commitment's
//      baseline_window is the pre-policy reference.
//   3. Adapts VerifyResult → WeeklyVerifyResult.
//
// Limitation: runEstimateVerify queries `[range]` ending at "now", so
// every weekly loop hits the same live snapshot. Week-specific windows
// and the per_pattern_breakdown cap-CSV join are not yet implemented;
// this path only unblocks the not_ready hard-return.

_setVerifyRunner(async ({ commitment, week_start, week_end }) => {
  const env = resolveEnv(getEnvs(), commitment.env);
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const weekDays = Math.max(
    1,
    Math.round(
      (Date.parse(week_end) - Date.parse(week_start)) / MS_PER_DAY
    )
  );
  // Best-effort fetch of action-intent.json (canonical action source) and
  // cap CSV (byte-cap context + legacy action suffix fallback). Both are
  // passed to runEstimateVerify for action-split attribution. On any
  // failure the respective field is undefined and the verify run falls
  // back to single-bucket attribution in commitment-report.
  //
  // Delivery channel comes from commitment.delivery_target captured at
  // apply time:
  //   - kind='configmap' → kubectl get configmap (the kubectl_configmap
  //     delivery path; otel-demo and other k8s-native deploys)
  //   - kind='gitops' or absent → gh api (the original PR-merge path;
  //     also the back-compat path for commitments persisted before
  //     delivery_target was added)
  // When both channels are wired, gitops wins (PR is the durable source
  // of truth and matches the source_disclosure label).
  const target = commitment.delivery_target;
  let capCsv: string | undefined;
  let actionIntent: Awaited<ReturnType<typeof fetchActionIntentForEnv>>;
  if (target?.kind === 'configmap') {
    [capCsv, actionIntent] = await Promise.all([
      fetchCapCsvFromConfigMap(target.name, target.namespace).catch(() => undefined),
      fetchActionIntentFromConfigMap(target.name, target.namespace).catch(() => undefined),
    ]);
  } else {
    [capCsv, actionIntent] = await Promise.all([
      fetchCapCsvForEnv(env).catch(() => undefined),
      fetchActionIntentForEnv(env).catch(() => undefined),
    ]);
  }
  const vr = await runEstimateVerify(
    {
      destination: commitment.destination,
      baseline_window: commitment.baseline_window || '7d',
      post_window: `${weekDays}d`,
      commitment_id: commitment.id,
      contract_type: commitment.contract_type,
      cap_csv_content: capCsv,
      action_intent_content: actionIntent
        ? JSON.stringify({ entries: actionIntent.entries, schema_version: '1.0' })
        : undefined,
    },
    env
  );
  return adaptVerifyResultToWeekly(vr, week_start);
});

// Fetch helpers live in `src/lib/cap-csv-fetch.ts` so tools can re-use
// them without duplicating the `gh api` call.

// ── Tool: log10x_commitment_report (CFO-facing Bayesian weekly aggregate) ──

registerLog10xTool('log10x_commitment_report', commitmentReportSchema, (args) =>
  wrap('log10x_commitment_report', () => executeCommitmentReport(args))
);

// ── Tool: log10x_pattern_mitigate (cost-reduction menu) ──

registerLog10xTool('log10x_pattern_mitigate', patternMitigateSchema, (args) =>
  wrap('log10x_pattern_mitigate', () => executePatternMitigate(args))
);

// ── Tool: log10x_dev_restart (dev mode only) ──
//
// Only registered when LOG10X_DEV_MODE=true. Forces a process.exit(0)
// so the MCP host respawns with an updated build. Never appears in
// production tools/list.

if (process.env.LOG10X_DEV_MODE === 'true') {
  registerLog10xTool('log10x_dev_restart', devRestartSchema, () =>
    wrap('log10x_dev_restart', async () => {
      if (process.env.LOG10X_DEV_MODE !== 'true') {
        throw new Error('log10x_dev_restart is not available in production builds');
      }
      return executeDevRestart();
    })
  );
}

// ── Resource: log10x://status ──
// Registered per-server in configureServer() so HTTP-session servers get it too.

// ── CLI flag handlers ──

const REGISTERED_TOOLS: Array<{ name: string; intent: string }> = [
  { name: 'log10x_start', intent: 'CALL FIRST on any cost / orient / "where do I start" question — returns tier + action menu + must_ask_user question; agent must surface verbatim and wait for user pick before any other tool' },
  { name: 'log10x_event_lookup', intent: 'What is this single log line — resolve to stable identity + cost + AI classification' },
  { name: 'log10x_pattern_examples', intent: 'Recent live events for a pattern from the log analyzer with template-parsed slot values, bounded to 24h. When the pattern is offloaded, retriever_query samples the held-back cohort.' },
  { name: 'log10x_savings', intent: 'Pipeline ROI — how much receiver / retriever are saving in dollars' },
  { name: 'log10x_pattern_trend', intent: 'Time series for a pattern — volume + cost history, spike detection, sparkline' },
  { name: 'log10x_dependency_check', intent: 'Scan SIEM + dashboards + alerts for refs to a pattern before muting / deleting it' },
  { name: 'log10x_top_patterns', intent: 'Top N patterns by current cost, with per-row delta vs comparison_window and newly-emerged section' },
  { name: 'log10x_pattern_diff', intent: 'Set diff of patterns across a time boundary — new/retired/persistent/re_emerged + co_emergence_clusters (deploy fingerprint). Coherent across boundaries because pattern_hash is stable across queries.' },
  { name: 'log10x_whats_changing', intent: 'Patterns ranked by delta vs baseline (growth/shrinkage). Brand-new patterns excluded — see log10x_whats_new for those. Restores the deleted log10x_cost_drivers capability.' },
  { name: 'log10x_whats_new', intent: 'Patterns whose first_seen falls inside a recency window. Separate from delta-vs-baseline because new patterns have no baseline.' },
  { name: 'log10x_investigate', intent: 'Single-call root-cause — causal chain for acute spikes or cohort for drift' },
  { name: 'log10x_resolve_batch', intent: 'Pasted-batch triage — per-pattern variable concentration + next actions' },
  { name: 'log10x_retriever_query', intent: 'Read the offloaded cohort for a pattern (tenx_user_pattern) from the customer-owned overflow bucket with JS filter expressions: the events the Receiver held back from the SIEM' },
  { name: 'log10x_retriever_series', intent: 'Time series over the offloaded cohort in the overflow bucket: auto-selects exact aggregation vs sampled parallel sub-window queries' },
  { name: 'log10x_retriever_probe', intent: 'End-to-end retriever chain probe — fires a synthetic query and asserts every stage (offload bucket, indexer pipeline, SQS, pod ready, CW scan/stream, S3 jsonl, MCP events). Returns green/broken/unknown with per-stage asserts and remedies.' },
  { name: 'log10x_backfill_metric', intent: 'Deprecated, kept dark. The live isDropped metric surface answers overflow-volume questions as a TSDB query.' },
  { name: 'log10x_doctor', intent: 'Startup health check — env config, gateway, tier, freshness, Retriever, paste endpoint, cross-pillar enrichment floor' },
  { name: 'log10x_login_status', intent: 'Report credential / env state — identity, env list with permissions, demo-mode upgrade guide if applicable' },
  { name: 'log10x_signin_start', intent: 'Step 1 of Auth0 Device Flow signup/signin: opens browser, returns the user_code + device_code so the model can surface them and chain to log10x_signin_complete' },
  { name: 'log10x_signin_complete', intent: 'Step 2 of sign-in: pass back the device_code from log10x_signin_start to finish the browser flow, OR pass api_key directly for pasted-key sign-in (no browser). Hot-reloads envs (no MCP-host restart needed)' },
  { name: 'log10x_signout', intent: 'Wipe ~/.log10x/credentials and fall back to demo mode (or lower-priority config); does not revoke the key on the backend' },
  { name: 'log10x_update_settings', intent: 'Update user metadata (analyzer cost, AI provider, etc.) via POST /api/v1/user' },
  { name: 'log10x_create_env', intent: 'Create a new Log10x environment on the account; pairs with log10x_advise_install for end-to-end provision-and-install' },
  { name: 'log10x_update_env', intent: 'Rename an env or change the default; requires the backend PUT route' },
  { name: 'log10x_delete_env', intent: 'Delete an env (destructive, irrecoverable) — requires confirm_name matching the env\'s name' },
  { name: 'log10x_set_gitops_repo', intent: 'Write gitops.repo to ~/.log10x/envs.json so configure_engine can author cap-CSV PRs; confirm="set-now" required' },
  { name: 'log10x_dest_set', intent: 'Update the SIEM destination block (siem_vendor / region / log_group_prefix / ingest_url) on an env-config document; idempotent, validates new doc against schema before write' },
  { name: 'log10x_env_validate', intent: 'Schema parse + cross-field sanity check on a stored env-config document — region/vendor pairing, ingest_url shape, cluster vs offload type alignment, active-offload presence' },
  { name: 'log10x_env_diff_vs_envvars', intent: 'Diff stored env-config doc against LOG10X_* env vars — surfaces silent-ignored env vars with per-field remediation; pure-on-prem-store configs return empty diff' },
  { name: 'log10x_retriever_register', intent: 'Attach the Retriever endpoint + queue coordinates to an existing env-config document. Requires log10x_env_register to have created the env first.' },
  { name: 'log10x_rotate_api_key', intent: 'Rotate the Log10x API key (destructive) — old key invalidated immediately, new one persisted to ~/.log10x/credentials' },
  { name: 'log10x_customer_metrics_query', intent: 'Direct PromQL passthrough to the customer metric backend (escape hatch for cross-pillar investigations)' },
  { name: 'log10x_discover_join', intent: 'Auto-discover the join label between Log10x pattern metrics and the customer metric backend via Jaccard similarity' },
  { name: 'log10x_metrics_that_moved', intent: 'Deterministic phase-aware filter — given an anchor and N candidates, return only candidates whose mean during the anchor\'s incident phase differs from its quiet-phase mean by ≥15%. First step of the cross-pillar investigation; kills diurnal/seasonal confounders before any correlation runs' },
  { name: 'log10x_rank_by_shape_similarity', intent: 'Rank candidates by Pearson + signed lag against an anchor. Returns raw arithmetic — pearson_signed, lag_seconds (negative = leads, possible cause), lag_tightness, lag_at_bound, anchor_phase_aligned. No tier, no causal framing — agent applies its own filter using the surfaced fields' },
  { name: 'log10x_metric_overlay', intent: 'Return two timeseries aligned to the same timestamp grid + deterministic facts (peak_at, peak_offset_seconds, n_buckets_aligned). NO Pearson, NO tier. Equivalent to opening two Grafana panels side by side — the agent reads the curves directly. Use after rank_by_shape_similarity to verify lag direction visually for top candidates' },
  { name: 'log10x_poc_from_siem_submit', intent: 'Pull a sample from the user\'s SIEM, templatize, and render a full cost-optimization POC report (async)' },
  { name: 'log10x_poc_from_siem_status', intent: 'Poll or retrieve the final report from a log10x_poc_from_siem_submit run' },
  { name: 'log10x_poc_from_local', intent: 'Run the POC from local kubectl logs (no SIEM credentials needed); industry-pricing matrix instead of bill prediction' },
  { name: 'log10x_discover_env', intent: 'Read-only probe of k8s + AWS — returns a snapshot_id the advise_* tools consume' },
  { name: 'log10x_advise_install', intent: 'Install wizard for Reporter / Receiver — walks the user through app / forwarder / backends / airgapped / license, then emits a concrete helm plan' },
  { name: 'log10x_advise_retriever', intent: 'Retriever install/verify/teardown plan: standalone reader over the customer-owned offload S3 bucket (S3 + SQS indexer + query)' },
  { name: 'log10x_configure_engine', intent: 'Unified per-pattern action-plan PR author — resolves a budget to a per-pattern plan (pass | sample | compact | drop | tier_down) under a per-destination cost model and emits a gitops PR.' },
  { name: 'log10x_estimate_savings', intent: 'Two-mode savings estimator — forecast mode projects bytes_out + $/mo for a proposed plan under the per-destination cost model; verify mode counts realized savings from the engine `isDropped` label with cap-hit / drift / new-patterns / leakage attribution.' },
  { name: 'log10x_baseline', intent: 'Pre-flight readiness gate for cost-reduction tools — verifies Reporter age (default 7d), pattern-coverage stability, and absence of acute anomalies; returns structured `not_ready` with the specific gate(s) that failed.' },
  { name: 'log10x_commitment_report', intent: 'CFO-facing weekly aggregate against a commitment record — Bayesian Beta(2,2) confidence prior on realized savings, markdown report suitable for sharing.' },
  { name: 'log10x_pattern_mitigate', intent: 'Return the env-gated mitigation options + exact configs for a pattern (drop @ analyzer, drop @ forwarder, mute @ 10x, compact @ 10x) in user terms with env-capability gating' },
  { name: 'log10x_overflow_contents', intent: 'Contents view of the customer-owned offload S3 bucket: per-pattern bytes, event count, time-first/last-seen, growth-rate; filtered to action=offload via the cap-CSV. Routes the agent to retriever_query to inspect the offloaded cohort.' },
  { name: 'log10x_setup_recurring', intent: 'Progressive wizard to configure a recurring cost-reduction agent — target services, savings %, schedule, scheduler (k8s/GHA/crontab), gitops repo — emits policy.yaml + scheduler manifest' },
  { name: 'log10x_offload_add', intent: 'Append a new offload destination (s3 / gcs / azure_blob / file) to an env-config document\'s offload_destinations[]. Multi-target offload is allowed; nickname must be unique within the list.' },
  { name: 'log10x_offload_archive', intent: 'Flip an offload destination\'s status to `archived` and stamp archived_at. Kept in the list as a historical reference. Refuses when the target is the only active destination — the Receiver requires at least one.' },
  { name: 'log10x_compile_start', intent: 'Start an ASYNC symbol-library compile (returns a job_id immediately — compiles run 10–30 min). Sources combine freely: a local source folder, GitHub repos, docker/OCI images, Helm charts, and Artifactory artifacts, via the Cloud-flavor Compiler app (Docker log10x/compiler-10x or a local cloud tenx) — scans code/binaries, emits .10x.json units + a linked .10x.tar. GitHub pull needs a token (github_token arg or GH_TOKEN env, required even for public repos); docker-image and Helm-referenced-image pull are daemonless (bundled podman, auto --cap-add SYS_ADMIN) and public images need no creds; Helm bare repo/chart names need helm_repos (OCI/URL resolve standalone); Artifactory needs artifactory_instance + artifactory_repo + a token. Output is pinned per-source so re-runs reuse prior units (near-instant). Edge flavor is refused. Poll with log10x_compile_status.' },
  { name: 'log10x_compile_status', intent: 'Poll an async compile started by log10x_compile_start (by job_id): job_status (running/completed/failed/timed_out), units produced + linked .10x.tar, and the engine diagnostics that make the compiler not a black box at scale — per-language scan-failure counts with capped samples, and the link report (merge/exclude counts + symbol-type histogram). Captures the exit code and frees the container on first terminal poll; repeat polls stay readable. Polls log10x_compile_link jobs too.' },
  { name: 'log10x_compile_link', intent: 'Link an existing folder of .10x.json symbol units into a single .10x.tar library, with NO source scan — the same compiler invoked with link-only args (units folder as outputSymbolFolder, no source), so it reuses on-disk units and merges them. Returns a job_id; poll with log10x_compile_status. Use to re-link after editing/pruning units or to rebuild a library from a units tree (e.g. the output folder of a prior log10x_compile_start).' },
];

async function handleCliFlags(): Promise<boolean> {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    // eslint-disable-next-line no-console
    console.log(`log10x-mcp ${readClientVersion()}`);
    return true;
  }
  if (args.includes('--list-tools')) {
    const maxNameLen = Math.max(...REGISTERED_TOOLS.map((t) => t.name.length));
    for (const t of REGISTERED_TOOLS) {
      // eslint-disable-next-line no-console
      console.log(`${t.name.padEnd(maxNameLen)}  ${t.intent}`);
    }
    return true;
  }
  if (args.includes('--doctor')) {
    try {
      const report = await runDoctorChecks();
      // eslint-disable-next-line no-console
      console.log(renderDoctorReport(report));
      process.exitCode = report.overall === 'fail' ? 1 : 0;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`Doctor failed to run: ${(e as Error).message}`);
      process.exitCode = 1;
    }
    return true;
  }
  if (args.includes('--help') || args.includes('-h')) {
    // eslint-disable-next-line no-console
    console.log(
      [
        'log10x-mcp — Log10x MCP server',
        '',
        'Usage: log10x-mcp [flag]',
        '',
        'Without flags, starts the MCP server over stdio for use by Claude Desktop, Cursor, etc.',
        '',
        'Flags:',
        '  --version, -v       Print the version and exit',
        '  --doctor            Run a startup health check and exit',
        '  --list-tools        Print the list of registered tools and exit',
        '  --help, -h          Print this help and exit',
        '',
        'Environment:',
        '  LOG10X_API_KEY            API key from console.log10x.com (or run `log10x_signin_start` then `log10x_signin_complete` to mint one via Auth0 Device Flow)',
        '  LOG10X_API_BASE           Override Prometheus gateway URL',
        '  __SAVE_LOG10X_RETRIEVER_URL__       Retriever query endpoint (optional)',
        '  LOG10X_PASTE_URL          Override Log10x paste endpoint (optional)',
        '  LOG10X_TENX_MODE          `local`, `docker`, or unset (auto-detect, prefers docker) — backend for tenx-running tools (privacy-mode + compile)',
        '  LOG10X_TENX_PATH          Path to local tenx CLI (used in local mode; compile requires the cloud flavor)',
        '  LOG10X_TENX_IMAGE         Docker image for the streaming tools when LOG10X_TENX_MODE=docker (default: log10x/pipeline-10x:latest)',
        '  LOG10X_COMPILER_IMAGE     Docker image for log10x_compile_start (default: log10x/compiler-10x:latest; falls back to LOG10X_TENX_IMAGE)',
        '  TENX_LICENSE_KEY          License key passed through to the compiler app (log10x_compile_start); omit to use the image built-in limited license',
        '  GH_TOKEN                  GitHub token for log10x_compile_start github_repos pull (or pass the github_token arg; required even for public repos)',
        '  DOCKER_USERNAME           Registry username for log10x_compile_start docker_images pull (or pass the docker_username arg; omit for public images)',
        '  DOCKER_TOKEN              Registry token/password for log10x_compile_start docker_images pull (or pass the docker_token arg; omit for public images)',
        '  ARTIFACTORY_TOKEN         Artifactory API token for log10x_compile_start artifactory_instance pull (or pass the artifactory_token arg)',
        '  LOG10X_THRESHOLDS_FILE    JSON file overriding investigate engine thresholds',
        '  LOG10X_MCP_LOG_LEVEL      stderr log level (silent | error | warn | info | debug)',
        '  DATADOG_API_KEY           Datadog API key for backfill_metric destination',
        '',
      ].join('\n')
    );
    return true;
  }
  return false;
}

// ── Server factory + transports ──

/**
 * Register all tools + the status resource onto a server instance and return
 * the RegisteredTool registry (consumed by applyManifestToTools). Used for the
 * stdio server and for each per-session server the HTTP transport builds.
 */
function configureServer(target: McpServer): Map<string, RegisteredTool> {
  const registry = new Map<string, RegisteredTool>();
  applyToolRegistrations(target, registry);
  target.resource(
    'pipeline-status',
    'log10x://status',
    { description: 'Current pipeline health and volume summary', mimeType: 'text/plain' },
    async () => {
      const env = getEnvs().default;
      const text = await getStatus(env);
      return { contents: [{ uri: 'log10x://status', text, mimeType: 'text/plain' }] };
    }
  );
  return registry;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 4_000_000) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * Remote Streamable HTTP transport (stateful sessions) for the hosted demo.
 * Each MCP session gets its own McpServer + transport, keyed by the
 * server-assigned Mcp-Session-Id; the heavy global init (env/mode/manifest) is
 * already done once before this runs. GET /health is a plain ALB liveness
 * probe. Enabled by LOG10X_MCP_HTTP_PORT. There is no auth in this layer —
 * the hosted deployment fronts it with a TLS-terminating reverse proxy and
 * serves only the read-only demo identity.
 */
function startHttpServer(
  port: number,
  manifest: Awaited<ReturnType<typeof loadManifest>>
): void {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const maxSessions = Number(process.env.LOG10X_MCP_MAX_SESSIONS ?? '200');

  const httpServer = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
      // 200 keeps the ALB health check happy (it matches on the status code);
      // the JSON body lets anyone read the running version/commit via curl.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ...BUILD_INFO }));
      return;
    }

    if (path !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        let transport = sessionId ? transports.get(sessionId) : undefined;

        if (!transport) {
          if (!isInitializeRequest(body)) {
            sendJsonRpcError(res, 400, 'No valid session — send an initialize request first.');
            return;
          }
          if (transports.size >= maxSessions) {
            sendJsonRpcError(res, 503, 'Demo server at session capacity; retry shortly.');
            return;
          }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              transports.set(sid, transport as StreamableHTTPServerTransport);
              log.info('http.session_open', { sessions: transports.size });
            },
          });
          transport.onclose = () => {
            const sid = transport?.sessionId;
            if (sid) transports.delete(sid);
            log.info('http.session_close', { sessions: transports.size });
          };
          const sessionServer = new McpServer(SERVER_INFO, SERVER_OPTIONS);
          const registry = configureServer(sessionServer);
          if (manifest) applyManifestToTools(manifest, registry);
          await sessionServer.connect(transport);
        }

        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          sendJsonRpcError(res, 400, 'Unknown or missing Mcp-Session-Id.');
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
    } catch (e) {
      log.warn('http.request_error', { msg: (e as Error).message });
      sendJsonRpcError(res, 500, 'Internal server error');
    }
  });

  httpServer.listen(port, () => {
    log.info('mcp.http_listening', { port });
    // eslint-disable-next-line no-console
    console.error(
      `[log10x-mcp] Streamable HTTP transport listening on :${port} (POST/GET/DELETE /mcp, health /health)`
    );
  });
}

// ── Start ──

async function main() {
  if (await handleCliFlags()) return;
  // G7: initialize OTel SDK if OTEL_EXPORTER_OTLP_ENDPOINT is set.
  // No-op otherwise. Must run before envs init so the very first network
  // call (env validation against the gateway) lands inside a trace too.
  const { initOtel } = await import('./lib/otel.js');
  await initOtel();
  // Eagerly resolve credentials before the server connects so any
  // configuration / network failure surfaces here with a clear
  // structured error instead of crashing on the first tool call from
  // the model, which is much harder to debug from a Claude Desktop log.
  try {
    await initEnvs();
  } catch (e) {
    if (e instanceof EnvironmentValidationError) {
      // eslint-disable-next-line no-console
      console.error(`\n[log10x-mcp] Configuration error:\n${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  // Detect operating mode (analysis | analysis_pending | poc) from
  // the TSDB-resolvability cascade. Bounded by 5s probe timeout. Sets
  // the module-scoped `bootMode` used by `wrap()` to gate out-of-mode
  // tool invocations with a clear reply rather than 5xx errors.
  await initBootMode();
  // Plumb the envs reference into self-telemetry so the wrapper can
  // resolve which env each tool call acted on, and flush can drop counters
  // from read-only envs (incl. demo). Must happen AFTER initEnvs so the
  // first telemetry flush has a populated env list.
  setEnvsProvider(getEnvs);
  // Pull the remote manifest before any server is configured. Network failure
  // / disabled / cache miss all silently fall through to the package-baked
  // defaults — boot must succeed offline.
  const manifest = await loadManifest(readClientVersion());
  const loaded = getEnvs();
  log.info('mcp.boot', {
    version: readClientVersion(),
    commit: BUILD_INFO.commit,
    built_at: BUILD_INFO.builtAt,
    tools: REGISTERED_TOOLS.length,
    envs: loaded.all.length,
    default_env: loaded.default.nickname,
    demo_mode: loaded.isDemoMode,
    demo_playground: DEMO_PLAYGROUND,
    read_only_mode: isReadOnlyMode(),
    manifest_loaded: manifest !== null,
    boot_mode: bootMode?.mode,
    boot_mode_backend: bootMode?.detectionPath,
    boot_mode_probe_ms: bootMode?.probeDurationMs,
  });
  // Read-only playground banner. The structured `mcp.boot` line is
  // gated behind LOG10X_MCP_LOG_LEVEL (silent by default), so operators
  // would not see read-only state in stock installs. Force a stderr
  // banner when the gate is on, regardless of log level.
  if (isReadOnlyMode()) {
    // eslint-disable-next-line no-console
    console.error(
      `[log10x-mcp] Running in read-only mode (LOG10X_MCP_READ_ONLY=${process.env.LOG10X_MCP_READ_ONLY}). Writer tools will return demo_read_only envelopes instead of executing.`,
    );
  }
  // Surface mode-detect resolution to stderr at boot so it shows up
  // in MCP-client logs without needing to call `log10x_doctor`.
  if (bootMode) {
    // eslint-disable-next-line no-console
    console.error(`[log10x-mcp] ${formatModeResolution(bootMode).split('\n')[0]}`);
  }

  // Transport selection. LOG10X_MCP_HTTP_PORT → remote Streamable HTTP (the
  // hosted demo playground; one McpServer per session). Otherwise the default
  // stdio transport (the published npm entrypoint for local MCP hosts). Tool
  // registration is gated by bootMode inside configureServer() either way.
  const httpPort = process.env.LOG10X_MCP_HTTP_PORT
    ? Number(process.env.LOG10X_MCP_HTTP_PORT)
    : undefined;
  if (httpPort && Number.isFinite(httpPort)) {
    startHttpServer(httpPort, manifest);
    return;
  }

  const registry = configureServer(server);
  if (manifest) applyManifestToTools(manifest, registry);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', error);
  process.exit(1);
});
