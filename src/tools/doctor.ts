/**
 * log10x_doctor — startup health check.
 *
 * Single-call verdict on whether this MCP install is correctly wired to
 * the customer's Log10x backend. Designed to be called once at the start
 * of a session, or by the `--doctor` CLI flag at install time.
 *
 * Each check returns pass / warn / fail with a one-line explanation.
 *
 * Multi-env: when no `environment` arg is passed, doctor iterates ALL
 * configured environments and produces one report section per env, so
 * multi-env users see per-nickname issues without having to call the
 * tool N times. Passing an explicit `environment` nickname checks only
 * that env (useful from the MCP tool interface when the model is
 * already scoped to one env).
 */

import { z } from 'zod';
import { queryInstant } from '../lib/api.js';
import {
  resolveRetriever,
  formatRetrieverTrace,
  runRetrieverQuery,
  isRetrieverConfigured,
} from '../lib/retriever-api.js';
import { loadEnvironments, type Environments, type EnvConfig } from '../lib/environments.js';
import { LABELS } from '../lib/promql.js';
import { agentOnly } from '../lib/agent-only.js';
import { fmtBytes as formatBytes } from '../lib/format.js';
import { discoverAvailable } from '../lib/siem/index.js';
import { resolveBackend, formatDetectionTrace } from '../lib/customer-metrics.js';
import { type StructuredOutput } from '../lib/output-types.js';
import { tenxAvailabilityHint } from '../lib/install-hints.js';
import { newChassisTelemetry, buildChassisEnvelope } from '../lib/chassis-envelope.js';
import {
  resolveClusterConfig,
  pickActiveOffload,
  detectStaleOffloadEnvVar,
  detectStaleEnvVarForField,
} from '../lib/env-config/resolve-cluster-config.js';
import {
  verifyOffloadDelivery,
  defaultOffloadDeliveryDeps,
  type OffloadDeliveryVerdict,
} from '../lib/offload-delivery.js';
import { verifyConfigGeneration } from '../lib/config-generation.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
  /** Optional remediation hint when status is warn or fail. */
  fix?: string;
}

export interface DoctorReport {
  overall: CheckStatus;
  /** Top-level checks that apply independent of a specific environment. */
  globalChecks: DoctorCheck[];
  /** Per-environment checks, keyed by nickname. */
  perEnvChecks: Record<string, DoctorCheck[]>;
}

export const doctorSchema = {
  environment: z
    .string()
    .optional()
    .describe(
      'Optional environment nickname to probe. In multi-env setups, omit to run the checks against ALL configured environments; pass a specific nickname to check only that one.'
    ),
};

export async function executeDoctor(args: { environment?: string }): Promise<string | StructuredOutput> {
  const report = await runDoctorChecks(args.environment);
  const allChecks = [
    ...report.globalChecks.map((c) => ({ env: 'global', ...c })),
    ...Object.entries(report.perEnvChecks).flatMap(([env, checks]) => checks.map((c) => ({ env, ...c }))),
  ];
  const passCount = allChecks.filter((c) => c.status === 'pass').length;
  const warnCount = allChecks.filter((c) => c.status === 'warn').length;
  const failCount = allChecks.filter((c) => c.status === 'fail').length;
  const failing = allChecks.filter((c) => c.status === 'fail').map((c) => ({ env: c.env, name: c.name, message: c.message, fix: c.fix }));
  const warning = allChecks.filter((c) => c.status === 'warn').map((c) => ({ env: c.env, name: c.name, message: c.message, fix: c.fix }));
  const headline = `Doctor: overall ${report.overall.toUpperCase()} (${passCount} pass, ${warnCount} warn, ${failCount} fail).`;
  const human_summary = buildDoctorHumanSummary({
    overall: report.overall,
    passCount,
    warnCount,
    failCount,
    failing,
    warning,
    envCount: Object.keys(report.perEnvChecks).length,
  });
  return buildChassisEnvelope({
    tool: 'log10x_doctor',
    view: 'summary',
    headline,
    // overall:'warn' means every check RAN and only advisories fired —
    // nothing could-not-execute — so the tool itself succeeded. Map to
    // 'success', not 'partial'. 'partial' is reserved for incomplete data /
    // checks that could not run. The warn signal is carried by
    // payload.overall and the headline ("overall WARN"), not by the chassis
    // status. Prior code emitted status:'partial' while the headline said
    // WARN — two unreconciled health vocabularies for the same run.
    status: report.overall === 'pass' || report.overall === 'warn' ? 'success' : 'error',
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {},
    scope: {
      window: 'point_in_time',
      window_basis: 'auto_default',
      candidates_count: allChecks.length,
      candidates_usable: passCount + warnCount,
      candidates_failed: failing.map((f) => `${f.env}/${f.name}`),
    },
    payload: {
      overall: report.overall,
      counts: { pass: passCount, warn: warnCount, fail: failCount },
      checks_by_env: {
        global: report.globalChecks,
        ...report.perEnvChecks,
      },
      failing_checks: failing,
      warning_checks: warning,
    },
    human_summary,
    ...(report.overall === 'fail' ? {
      error: {
        error_type: 'config_missing' as const,
        retryable: false,
        suggested_backoff_ms: null,
        hint: failing.length > 0
          ? `${failing.length} check(s) failing: ${failing.slice(0, 2).map((f) => `${f.env}/${f.name}`).join(', ')}`
          : 'Doctor checks failed',
      },
    } : {}),
    actions: report.overall === 'fail'
      ? [{ tool: 'log10x_login_status', args: {}, reason: 'verify credentials and env state if checks are failing on auth/connectivity' }]
      : [],
    telemetry: newChassisTelemetry(),
  });
}

function buildDoctorHumanSummary(args: {
  overall: CheckStatus;
  passCount: number;
  warnCount: number;
  failCount: number;
  failing: Array<{ env: string; name: string }>;
  warning: Array<{ env: string; name: string }>;
  envCount: number;
}): string {
  const envWord = `${args.envCount} environment${args.envCount === 1 ? '' : 's'}`;
  const lead = `Doctor overall: ${args.overall.toUpperCase()} across ${envWord} (${args.passCount} pass, ${args.warnCount} warn, ${args.failCount} fail).`;
  const fails =
    args.failing.length > 0
      ? ` Failing: ${args.failing.slice(0, 3).map((f) => `${f.env}/${f.name}`).join(', ')}${args.failing.length > 3 ? `, +${args.failing.length - 3} more` : ''}.`
      : '';
  const warns =
    args.warning.length > 0 && args.failing.length === 0
      ? ` Warnings: ${args.warning.slice(0, 3).map((w) => `${w.env}/${w.name}`).join(', ')}${args.warning.length > 3 ? `, +${args.warning.length - 3} more` : ''}.`
      : '';
  return `${lead}${fails}${warns}`;
}

/** Runs the full check sequence and returns a structured report. */
export async function runDoctorChecks(envNickname?: string): Promise<DoctorReport> {
  const globalChecks: DoctorCheck[] = [];
  const perEnvChecks: Record<string, DoctorCheck[]> = {};

  // 1. Environment configuration loads successfully (global).
  let envs: Environments | undefined;
  try {
    envs = await loadEnvironments();
    const summary = envs.all.map((e) => {
      const perm = e.permissions ? ` (${e.permissions.toLowerCase()})` : '';
      const star = e.isDefault ? ' ★' : '';
      return `${e.nickname}${perm}${star}`;
    }).join(', ');

    // Demo-mode signaling. Two flavors:
    //   - Pure demo (no LOG10X_API_KEY set): warn (the user opted in but
    //     should know all data is shared sample data).
    //   - Demo fallback (LOG10X_API_KEY set but failed validation): fail-
    //     style attention even though the MCP still works against demo,
    //     because the user almost certainly thinks they're hitting their
    //     own account.
    if (envs.isDemoMode && envs.demoFallbackReason) {
      globalChecks.push({
        name: 'environment_config',
        status: 'fail',
        message:
          `**DEMO FALLBACK** — your configured LOG10X_API_KEY failed validation, so the MCP is running against the public Log10x demo env (read-only). Reason: ${envs.demoFallbackReason.split('\n')[0].slice(0, 300)}. ` +
          `All API-hitting tools will return demo data, NOT your account. ` +
          `${envs.all.length} demo env${envs.all.length === 1 ? '' : 's'}: ${summary}. Default: ${envs.default.nickname}.`,
        fix: 'Easiest fix: run `log10x_signin_start` (the model will chain to `log10x_signin_complete` automatically) for the Auth0 Device Flow with GitHub or Google, or call `log10x_signin_complete` directly with `{ api_key: "<key>" }` to paste an existing key from https://console.log10x.com → Profile → API Settings. Either path mints / validates the key and auto-clears the bad `LOG10X_API_KEY` from this MCP server\'s process so the new key takes effect immediately, no host restart needed. Alternatively: re-check `LOG10X_API_KEY` at https://console.log10x.com → Profile → API Settings, update the value in your MCP host\'s config (e.g. claude_desktop_config.json) and fully restart the host. Or unset `LOG10X_API_KEY` entirely to keep demo mode without the warning. See `log10x_login_status` for the full breakdown.',
      });
    } else if (envs.isDemoMode) {
      globalChecks.push({
        name: 'environment_config',
        status: 'warn',
        message:
          `Running in **demo mode**, no LOG10X_API_KEY configured and no \`~/.log10x/credentials\` file. ${envs.all.length} read-only demo env${envs.all.length === 1 ? '' : 's'}: ${summary}. All data is shared sample data, not your own. Run \`log10x_signin_start\` to sign in (the model chains to \`log10x_signin_complete\` automatically) or call \`log10x_login_status\` for upgrade steps.`,
      });
    } else {
      globalChecks.push({
        name: 'environment_config',
        status: 'pass',
        message: `${envs.all.length} environment${envs.all.length === 1 ? '' : 's'}: ${summary}. Default: ${envs.default.nickname}. (★ = default env; nicknames with (read) are read-only.)`,
      });
    }
  } catch (e) {
    globalChecks.push({
      name: 'environment_config',
      status: 'fail',
      message: (e as Error).message,
      fix: 'Run `log10x_signin_start` to sign in via the Auth0 Device Flow with GitHub or Google (opens a browser, the model chains to `log10x_signin_complete` automatically once you confirm in the browser). Or call `log10x_signin_complete` directly with `{ api_key: "<key>" }` to paste an existing key. Or set `LOG10X_API_KEY` in your MCP host config (key from https://console.log10x.com → Profile → API Settings) and restart the host. Unsetting `LOG10X_API_KEY` drops the MCP into read-only demo mode. See `log10x_login_status` for the full breakdown.',
    });
    return finalize(globalChecks, perEnvChecks);
  }

  // 2. Infrastructure-wide informational checks (retriever, datadog, paste).
  //    These don't depend on a specific env so they live in globalChecks.
  await addInfrastructureChecks(globalChecks);
  await addEngineCheck(globalChecks);
  await addSiemDiscoveryCheck(globalChecks);
  addNetworkEgressInventory(globalChecks, envs);

  // 3. Per-environment checks. byNickname includes aliases from
  //    env-alias-bridge: SaaS env_id (UUID), on-prem env-config
  //    nicknames bridged via env_id. So when the SaaS env name differs
  //    from the typed nickname but both bridge via env_id, it still
  //    resolves correctly.
  const targets: EnvConfig[] = envNickname
    ? (() => {
        const e = envs.byNickname.get(envNickname.toLowerCase());
        if (!e) {
          // Build a deduped alias map so the error doesn't list every
          // alias as if each were a separate env.
          const aliasesByEnv = new Map<EnvConfig, string[]>();
          for (const [k, v] of envs.byNickname.entries()) {
            const list = aliasesByEnv.get(v) ?? [];
            list.push(k);
            aliasesByEnv.set(v, list);
          }
          const described = envs.all
            .map((x) => {
              const aliases = (aliasesByEnv.get(x) ?? []).filter((a) => a !== x.nickname.toLowerCase());
              return aliases.length === 0 ? x.nickname : `${x.nickname} (also: ${aliases.join(', ')})`;
            })
            .join('; ');
          globalChecks.push({
            name: 'environment_resolution',
            status: 'fail',
            message: `Unknown environment nickname "${envNickname}". Available: ${described}.`,
          });
          return [];
        }
        return [e];
      })()
    : envs.all;

  for (const env of targets) {
    perEnvChecks[env.nickname] = await runPerEnvChecks(env);
  }

  return finalize(globalChecks, perEnvChecks);
}

/** Checks that apply independent of a specific environment. */
/**
 * True when a URL's host is only routable inside a Kubernetes cluster
 * (the shape the helm_release_probe Retriever fallback emits). Used to
 * distinguish "resolved an endpoint" from "resolved a REACHABLE endpoint".
 */
export function isClusterInternalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    host.endsWith('.svc.cluster.local') ||
    host.endsWith('.svc') ||
    host.endsWith('.cluster.local') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  );
}

async function addInfrastructureChecks(checks: DoctorCheck[]): Promise<void> {
  // Env-config resolution probe. Walks the StoreKind discovery order (K8s
  // ConfigMap → AWS SSM → GCP Secret Manager → Azure App Config → local file)
  // and reports which store served the document, plus any LOG10X_* env vars
  // that disagree with the resolved values. The disagreements are surfaced
  // here as advisory `warn` checks rather than silently winning — that's the
  // canonical "but I set the env var" footgun for offload_bucket / streamer.url
  // / retriever.input_bucket. Sits BEFORE the retriever probes because they
  // (advise_retriever, retriever_probe) will read the same document.
  await addEnvConfigResolutionCheck(checks);

  // Retriever endpoint configured? (informational, not required)
  const retrieverRes = await resolveRetriever().catch((e) => ({
    url: undefined,
    bucket: undefined,
    detectionPath: undefined,
    trace: [{ path: 'explicit_env' as const, status: 'failed' as const, reason: (e as Error).message }],
  }));
  if (retrieverRes.url && retrieverRes.bucket && retrieverRes.detectionPath) {
    // "Resolved a URL" is NOT the same as "reachable from this MCP host". The
    // helm_release_probe fallback returns the in-cluster Service DNS name
    // (e.g. *.svc.cluster.local), which only resolves INSIDE the Kubernetes
    // cluster. If this MCP runs outside the cluster (no KUBERNETES_SERVICE_HOST)
    // and no SQS query queue is registered as a fallback, retriever_query will
    // fail with a connection error even though doctor "resolved" an endpoint —
    // which is exactly how a fully-deployed Retriever reads as a false PASS.
    const inCluster = !!process.env.KUBERNETES_SERVICE_HOST;
    const sqsQueueConfigured = !!process.env.LOG10X_RETRIEVER_QUERY_QUEUE_URL;
    const clusterInternal = isClusterInternalUrl(retrieverRes.url);
    if (clusterInternal && !inCluster && !sqsQueueConfigured) {
      checks.push({
        name: 'retriever_endpoint',
        status: 'warn',
        message:
          `Retriever resolved to a CLUSTER-INTERNAL address via ${retrieverRes.detectionPath}: url=${retrieverRes.url}. ` +
          'That hostname only resolves inside the Kubernetes cluster, and this MCP host is outside it (no KUBERNETES_SERVICE_HOST). ' +
          'With no SQS query queue registered as a fallback, log10x_retriever_query and log10x_backfill_metric will fail with a connection error — the Retriever may be fully deployed, but its query path is unreachable from here. ' +
          'The S3 overflow bucket itself is fine; only the query SERVICE is unreachable.',
        fix:
          'Register the deployed Retriever so the MCP routes via SQS (not the in-cluster HTTP URL): run log10x_retriever_register with the HTTP ingress URL + the 4 SQS queue URLs, or set LOG10X_RETRIEVER_QUERY_QUEUE_URL to the Quarkus query queue. Find the coordinates via log10x_advise_retriever (its preflight lists the live SQS queue URLs). Or run this MCP inside the cluster.',
      });
    } else {
      checks.push({
        name: 'retriever_endpoint',
        status: 'pass',
        message:
          `Retriever resolved via ${retrieverRes.detectionPath}: url=${retrieverRes.url}, bucket=${retrieverRes.bucket}` +
          (clusterInternal && sqsQueueConfigured ? ' (HTTP url is cluster-internal; queries route via the registered SQS queue)' : '') +
          `${inCluster ? ' (MCP runs in-cluster)' : ''}. ` +
          'log10x_retriever_query and log10x_backfill_metric will route here.',
      });
    }
  } else {
    checks.push({
      name: 'retriever_endpoint',
      status: 'warn',
      message:
        'Retriever not reachable from this MCP install. log10x_retriever_query and log10x_backfill_metric cannot read the offloaded cohort from the overflow bucket in this session. ' +
        'The overflow bucket holds the cohort the engine routed out of the stack, so these events are not in the SIEM at any tier. For events the SIEM still holds, query the SIEM directly; do not block on retriever setup.\n' +
        formatRetrieverTrace(retrieverRes.trace),
      fix:
        'Options: (a) set __SAVE_LOG10X_RETRIEVER_URL__ + __SAVE_LOG10X_RETRIEVER_BUCKET__ explicitly; (b) expose AWS creds (AWS_REGION + IAM with s3:ListAllMyBuckets) so auto-detect can find a log10x-retriever-* bucket; (c) deploy the Retriever — https://doc.log10x.com/apps/cloud/retriever/',
    });
  }

  // Datadog backfill destination credentials? (informational)
  // Accept DD_SITE and DATADOG_SITE interchangeably (as Datadog's own SDKs do).
  if (process.env.DATADOG_API_KEY || process.env.DD_API_KEY) {
    const site = process.env.DD_SITE || process.env.DATADOG_SITE || 'datadoghq.com';
    checks.push({
      name: 'datadog_destination',
      status: 'pass',
      message:
        `Datadog API key detected (site: ${site}). log10x_backfill_metric can emit to Datadog (requires Retriever for the source).`,
    });
  } else {
    checks.push({
      name: 'datadog_destination',
      status: 'warn',
      message:
        'No DATADOG_API_KEY (or DD_API_KEY) set. backfill_metric to Datadog will error if attempted.',
      fix: 'Set DATADOG_API_KEY in the MCP server environment if you plan to backfill Datadog metrics. DD_SITE / DATADOG_SITE controls the region (defaults to datadoghq.com).',
    });
  }

  // Retriever CW query logging check.
  // Skip when the retriever is not installed (retriever_endpoint already warned).
  if (retrieverRes.url && retrieverRes.bucket && retrieverRes.detectionPath) {
    await addRetrieverCwLoggingCheck(checks);
  }
}

/**
 * Resolve the env-config document via the StoreKind chain (k8s → AWS SSM →
 * GCP Secret Manager → Azure App Config → local file) and surface:
 *   - which store served the document (`pass` when resolved)
 *   - any LOG10X_* env var that disagrees with a resolved field (`warn`)
 *
 * The check NEVER fails — a missing env-config is a `warn`, not a `fail`,
 * because tools fall through to LOG10X_* env vars when no store is reachable.
 * Failing here would block doctor on a state every other tool tolerates.
 */
async function addEnvConfigResolutionCheck(checks: DoctorCheck[]): Promise<void> {
  let resolved;
  try {
    resolved = await resolveClusterConfig();
  } catch (e) {
    checks.push({
      name: 'env_config_resolution',
      status: 'warn',
      message: `Env-config resolver threw: ${(e as Error).message}`,
      fix: 'Confirm one of the on-prem stores (K8s ConfigMap, AWS SSM, GCP Secret Manager, Azure App Config, ~/.log10x/envs) is reachable, or set the LOG10X_* env vars as a fallback.',
    });
    return;
  }
  if (!resolved.ok) {
    // Render the per-store trace inline so the user sees exactly which
    // stores were tried and why each was skipped.
    const traceLines = resolved.resolution_trace
      .map(t => `  - ${t.source}: ${t.status} (${t.reason})`)
      .join('\n');
    checks.push({
      name: 'env_config_resolution',
      status: 'warn',
      message:
        `No env-config document resolved (every store in the chain reported unavailable or had no matching document). ` +
        `Tools that need cluster identifiers (retriever_probe, advise_retriever, configure_engine destination auto-detect) ` +
        `will fall back to LOG10X_* env vars.\n\nResolution trace:\n${traceLines || '  (empty)'}`,
      fix:
        'Either register an env-config document via log10x_env_register (writes to whichever store is available) ' +
        'or set the minimal LOG10X_* env-var set (LOG10X_ENV_ID, LOG10X_CLUSTER_TYPE, LOG10X_SIEM_VENDOR, LOG10X_OFFLOAD_TYPE, LOG10X_OFFLOAD_BUCKET, LOG10X_STREAMER_URL, LOG10X_RETRIEVER_URL + four LOG10X_RETRIEVER_Q_* queue URLs).',
    });
    return;
  }

  const cfg = resolved.config;
  const storeKind = resolved.source_store_kind ?? '(env-var fallback)';
  const active = pickActiveOffload(cfg);
  const advisories: string[] = [];

  // Pull warnings the resolver already detected (env_id / nickname /
  // streamer.url / retriever.url / retriever.input_bucket /
  // destination.siem_vendor disagreements). The resolver only checks fields
  // it ALSO accepts from env-var fallback, so we add a couple of extras
  // below that the resolver doesn't cover (active offload bucket — the
  // LOG10X_STREAMER_BUCKET / LOG10X_OFFLOAD_BUCKET pair specifically).
  for (const w of resolved.stale_env_var_warnings) advisories.push(w);

  const offloadStale = detectStaleOffloadEnvVar(active?.bucket);
  if (offloadStale) advisories.push(offloadStale);

  const retrieverInputStale = detectStaleEnvVarForField(
    'retriever.input_bucket',
    cfg.retriever.input_bucket,
    'LOG10X_RETRIEVER_INPUT_BUCKET'
  );
  if (retrieverInputStale) advisories.push(retrieverInputStale);

  const retrieverUrlStale = detectStaleEnvVarForField(
    'retriever.url',
    cfg.retriever.url,
    'LOG10X_RETRIEVER_URL'
  );
  if (retrieverUrlStale) advisories.push(retrieverUrlStale);

  const streamerUrlStale = detectStaleEnvVarForField(
    'streamer.url',
    cfg.streamer.url,
    'LOG10X_STREAMER_URL'
  );
  if (streamerUrlStale) advisories.push(streamerUrlStale);

  const summary =
    `Env-config resolved from ${storeKind} store (source: ${resolved.source}). ` +
    `env_id="${cfg.env_id}" nickname="${cfg.nickname}" ` +
    `destination.siem_vendor="${cfg.destination.siem_vendor}" ` +
    `active_offload="${active?.nickname ?? '(none)'}/${active?.bucket ?? '?'}" ` +
    `retriever.input_bucket="${cfg.retriever.input_bucket}".`;

  if (advisories.length > 0) {
    checks.push({
      name: 'env_config_resolution',
      status: 'warn',
      message: `${summary}\n\n${advisories.length} stale-env-var advisor${advisories.length === 1 ? 'y' : 'ies'}:\n${advisories.map(w => `  - ${w}`).join('\n')}`,
      fix:
        'Unset the listed LOG10X_* env vars (or update the env-config document to match) so the on-prem store stays the single source of truth. ' +
        'Tools always prefer the store; the env var becomes a no-op the moment it disagrees.',
    });
  } else {
    checks.push({
      name: 'env_config_resolution',
      status: 'pass',
      message: summary,
    });
  }
}

/**
 * Check whether per-query CloudWatch logging is enabled on the deployed Retriever.
 * Requires helm + kubectl to be reachable. Fails gracefully when either is absent.
 */
async function addRetrieverCwLoggingCheck(checks: DoctorCheck[]): Promise<void> {
  // Use the same helm-list probe that helmReleaseDiscovery uses in retriever-state.ts.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);

  let releaseName: string | undefined;
  let namespace: string | undefined;

  try {
    const { stdout } = await execFileP(
      'helm',
      ['list', '-A', '-o', 'json'],
      { timeout: 10_000 }
    );
    const releases = JSON.parse(stdout) as Array<{ name: string; namespace: string; chart: string }>;
    const r = releases.find((x) => x.chart.toLowerCase().startsWith('retriever-10x'));
    if (r) {
      releaseName = r.name;
      namespace = r.namespace;
    }
  } catch {
    // kubectl/helm not available — skip
  }

  if (!releaseName || !namespace) {
    // Can't resolve the release name; skip without a spurious WARN.
    return;
  }

  let queryLogGroup: string | undefined;
  try {
    const { stdout } = await execFileP(
      'helm',
      ['get', 'values', releaseName, '-n', namespace, '-o', 'json'],
      { timeout: 8_000 }
    );
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const qlg = parsed['queryLogGroup'];
    if (typeof qlg === 'string' && qlg.trim()) {
      queryLogGroup = qlg.trim();
    } else {
      const tenx = parsed['tenx'];
      if (tenx && typeof tenx === 'object') {
        const nested = (tenx as Record<string, unknown>)['queryLogGroup'];
        if (typeof nested === 'string' && nested.trim()) {
          queryLogGroup = nested.trim();
        }
      }
    }
  } catch {
    // helm get values failed — skip without a spurious WARN
    return;
  }

  if (queryLogGroup) {
    checks.push({
      name: 'retriever_cw_logging',
      status: 'pass',
      message: `Retriever queryLogGroup = \`${queryLogGroup}\` (release ${namespace}/${releaseName}). Per-query CloudWatch observability is enabled; log10x_retriever_query_status can fetch execution logs for any queryId.`,
    });
  } else {
    checks.push({
      name: 'retriever_cw_logging',
      status: 'warn',
      message:
        `Retriever is installed (release ${namespace}/${releaseName}) but queryLogGroup is not set. ` +
        'Per-query CloudWatch logging is disabled; dispatcher failures will not appear in CloudWatch — only pod stdout is visible.',
      fix:
        'Set queryLogGroup in your retriever helm values (e.g. `queryLogGroup: log10x-retriever-query-events`) and ensure the IRSA role has logs:CreateLogStream and logs:PutLogEvents on the log group ARN. ' +
        'Call log10x_advise_retriever for the complete helm + IAM snippet.',
    });
  }
}

/** Per-environment probes: gateway auth, tier detection, metric freshness. */
async function runPerEnvChecks(env: EnvConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // Gateway reachable + auth works.
  try {
    const res = await queryInstant(env, `count(up{${LABELS.env}=~"edge|cloud"}) or vector(0)`);
    if (res.status === 'success') {
      checks.push({
        name: 'metrics_backend_reachable',
        status: 'pass',
        message: `Backend \`${env.metricsBackend.kind}\` at ${env.metricsBackend.endpoint} reachable, auth OK for env ${env.nickname}.`,
      });
    } else {
      checks.push({
        name: 'prometheus_gateway',
        status: 'warn',
        message: `Gateway responded but query status was "${res.status}".`,
        fix: 'Check that the API key and env ID match and have read access.',
      });
      return checks; // no point running freshness checks if gateway is broken
    }
  } catch (e) {
    checks.push({
      name: 'prometheus_gateway',
      status: 'fail',
      message: `Gateway query failed: ${(e as Error).message}`,
      fix: `Verify the credentials for env ${env.nickname}: re-check the key at https://console.log10x.com → Profile → API Settings, or run \`log10x_signin_start\` to mint a fresh one via the Auth0 Device Flow with GitHub or Google (the model chains to \`log10x_signin_complete\` automatically). To paste an existing key directly, call \`log10x_signin_complete\` with \`{ api_key: "<key>" }\`. If the network is locked down, allowlist prometheus.log10x.com.`,
    });
    return checks;
  }

  // Reporter tier detection.
  let detectedTier: 'edge' | 'cloud' | undefined;
  try {
    const res = await queryInstant(
      env,
      `count(all_events_summaryBytes_total{${LABELS.env}="edge"}) > 0`
    );
    if (res.status === 'success' && res.data.result.length > 0) {
      detectedTier = 'edge';
      checks.push({
        name: 'reporter_tier',
        status: 'pass',
        message: 'Edge Reporter detected — full-fidelity metrics with dropped-event coverage.',
      });
    } else {
      const cloudRes = await queryInstant(
        env,
        `count(all_events_summaryBytes_total{${LABELS.env}="cloud"}) > 0`
      );
      if (cloudRes.status === 'success' && cloudRes.data.result.length > 0) {
        detectedTier = 'cloud';
        checks.push({
          name: 'reporter_tier',
          status: 'pass',
          message: 'Cloud Reporter detected — sampled metrics, ±1-5min inflection granularity.',
        });
      } else {
        checks.push({
          name: 'reporter_tier',
          status: 'warn',
          message:
            'No Reporter tier detected, so investigate / whats_changing / pattern_trend tools will be unavailable in this env.',
          fix: 'Deploy Cloud Reporter (k8s CronJob) or Edge Reporter (forwarder pipeline) per https://doc.log10x.com/apps/reporter/.',
        });
      }
    }
  } catch (e) {
    checks.push({
      name: 'reporter_tier',
      status: 'warn',
      message: `Reporter probe failed: ${(e as Error).message}`,
    });
  }

  // Metric freshness — catches the "Reporter deployed but stopped emitting 6h ago" case.
  if (detectedTier) {
    try {
      // Query the age in seconds of the most recent non-stale datapoint.
      // time() - timestamp(last emission) = seconds since last scrape.
      const q = `time() - max(timestamp(all_events_summaryBytes_total{${LABELS.env}="${detectedTier}"}))`;
      const res = await queryInstant(env, q);
      if (res.status === 'success' && res.data.result[0]?.value) {
        const ageSec = parseFloat(res.data.result[0].value[1]);
        if (!Number.isFinite(ageSec)) {
          checks.push({
            name: 'metric_freshness',
            status: 'warn',
            message: 'Could not parse metric freshness from Prometheus response.',
          });
        } else if (ageSec <= 300) {
          checks.push({
            name: 'metric_freshness',
            status: 'pass',
            message: `${detectedTier} reporter emitted within the last ${Math.round(ageSec)}s — metrics are fresh.`,
          });
        } else if (ageSec <= 3600) {
          checks.push({
            name: 'metric_freshness',
            status: 'warn',
            message: `${detectedTier} reporter's most recent datapoint is ${Math.round(ageSec / 60)} minutes old. Tools will still answer but the data is stale.`,
            fix: 'Check the Reporter pod / CronJob is healthy. For Cloud Reporter, inspect the most recent CronJob run. For Edge Reporter, check the forwarder pipeline sidecar is emitting.',
          });
        } else {
          checks.push({
            name: 'metric_freshness',
            status: 'fail',
            message: `${detectedTier} reporter's most recent datapoint is ${Math.round(ageSec / 3600)} hours old. The Reporter has stopped emitting. Investigate / whats_changing / pattern_trend will return stale data or empty results.`,
            fix: 'The Reporter has stopped emitting metrics. Check the Reporter pod / CronJob status, recent logs, and restart if needed. This is the most common silent failure mode.',
          });
        }
      } else {
        checks.push({
          name: 'metric_freshness',
          status: 'warn',
          message: 'Metric freshness query returned no result. Unclear whether the Reporter is emitting.',
        });
      }
    } catch (e) {
      checks.push({
        name: 'metric_freshness',
        status: 'warn',
        message: `Freshness probe failed: ${(e as Error).message}`,
      });
    }
  }

  // Scale & capability context. Converts doctor from "am I healthy" to
  // "what can an agent ask here" — the agent reads this once on its first
  // call and sizes its tool-choice strategy appropriately. Especially
  // load-bearing at high volume, where the agent's strategy differs
  // materially from a 10 GB/day env.
  if (detectedTier) {
    await addScaleAndCapabilityCheck(env, detectedTier, checks);
  }

  // Observability-health signals. These run regardless of Reporter tier and
  // surface structural issues that the agent would otherwise have to discover
  // by hand each session. Driven by actual findings in customer acceptance
  // testing — each check has a named source scenario in GAPS.md (C1, C2, C3).
  //
  // All three are single-or-double PromQL queries against the existing
  // `all_events_summaryBytes_total{${LABELS.env}=~"edge|cloud"}` metric, so
  // they work on any environment — no demo assumptions, no hardcoded service
  // names, no regex libraries to maintain.
  if (detectedTier) {
    const tierSelector = `${LABELS.env}="${detectedTier}"`;

    // C2: severity distribution sanity check.
    // Flag environments where >99% of log volume is INFO with effectively
    // zero ERROR/WARN/CRIT/FATAL. Two interpretations: (a) services are
    // healthy and silent (unlikely at high volume) or (b) services aren't
    // emitting error-level logs at all (instrumentation gap). The tool
    // surfaces the question for the user to classify.
    try {
      const q = `sum by (${LABELS.severity}) (increase(all_events_summaryBytes_total{${tierSelector}}[30d]))`;
      const res = await queryInstant(env, q);
      if (res.status === 'success' && res.data.result.length > 0) {
        let total = 0;
        let infoBytes = 0;
        let errorLikeBytes = 0; // error + warn + crit + fatal
        for (const r of res.data.result) {
          if (!r.value) continue;
          const bytes = parseFloat(r.value[1]);
          if (!Number.isFinite(bytes)) continue;
          total += bytes;
          const sev = (r.metric[LABELS.severity] || '').toLowerCase();
          if (sev === 'info') infoBytes += bytes;
          if (sev === 'error' || sev === 'warn' || sev === 'warning' || sev === 'critical' || sev === 'crit' || sev === 'fatal') {
            errorLikeBytes += bytes;
          }
        }
        if (total > 0) {
          const infoRatio = infoBytes / total;
          const errorRatio = errorLikeBytes / total;
          if (infoRatio > 0.99 && errorRatio < 0.001) {
            checks.push({
              name: 'severity_distribution',
              status: 'warn',
              message: `Environment is ${Math.round(infoRatio * 100)}% INFO-severity with ${(errorRatio * 100).toFixed(2)}% error-class (ERROR/WARN/CRIT/FATAL). Two possibilities: (a) services are genuinely healthy, or (b) services aren't emitting error-level logs at all — instrumentation gap. If the latter, real problems won't surface until an incident exposes them.`,
              fix: 'Verify that at least one of your services has emitted an ERROR or WARN in the last 30 days (pick a service you know has had issues). If the count is zero and you expected otherwise, check your logger configuration — log levels below WARN are sometimes filtered at the forwarder.',
            });
          } else if (errorRatio === 0 && total > 0) {
            checks.push({
              name: 'severity_distribution',
              status: 'warn',
              message: `No ERROR/WARN/CRIT/FATAL severity log volume in the last 30 days. Either nothing is failing, or error-level logs are not reaching the pipeline. Worth verifying against your incident history.`,
            });
          } else {
            checks.push({
              name: 'severity_distribution',
              status: 'pass',
              message: `Severity distribution healthy: ${(infoRatio * 100).toFixed(0)}% INFO, ${(errorRatio * 100).toFixed(1)}% error-class (ERROR/WARN/CRIT/FATAL).`,
            });
          }
        }
      }
    } catch {
      // Non-fatal; doctor never blocks on observability-health signals.
    }

    // C3: cardinality concentration.
    // If a single pattern is >40% of environment spend, or the top 5 are
    // >70%, there's a large-dollar opportunity for investigation or
    // filtering. This turns "drop candidate discovery" from an agent task
    // into an automatic doctor recommendation.
    try {
      const totalQ = `sum(increase(all_events_summaryBytes_total{${tierSelector}}[30d]))`;
      const topQ = `topk(5, sum by (${LABELS.pattern}) (increase(all_events_summaryBytes_total{${tierSelector}}[30d])))`;
      const [totalRes, topRes] = await Promise.all([
        queryInstant(env, totalQ),
        queryInstant(env, topQ),
      ]);
      const total = totalRes.status === 'success' && totalRes.data.result[0]?.value
        ? parseFloat(totalRes.data.result[0].value[1]) : 0;
      const topRows = topRes.status === 'success' ? topRes.data.result : [];
      if (total > 0 && topRows.length > 0) {
        const topBytes = topRows
          .map((r) => r.value ? parseFloat(r.value[1]) : NaN)
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => b - a);
        const top1Ratio = topBytes[0] / total;
        const top5Ratio = topBytes.reduce((s, b) => s + b, 0) / total;
        if (top1Ratio > 0.4) {
          checks.push({
            name: 'cardinality_concentration',
            status: 'warn',
            message: `A single pattern is ${Math.round(top1Ratio * 100)}% of your 30-day log spend. If it's a DEBUG/INFO pattern, you have a large filtering opportunity; if it's an ERROR, you have an ongoing incident to investigate.`,
            fix: 'Call log10x_top_patterns(limit=1) to see which pattern. Then log10x_investigate on it to check whether it is an incident or noise. If it is noise, log10x_dependency_check + log10x_pattern_mitigate to cut cost safely.',
          });
        } else if (top5Ratio > 0.7) {
          checks.push({
            name: 'cardinality_concentration',
            status: 'warn',
            message: `The top 5 patterns are ${Math.round(top5Ratio * 100)}% of your 30-day log spend. Your logging cost is concentrated; investigating or filtering the top few has outsized impact.`,
            fix: 'Call log10x_top_patterns(limit=5) and log10x_whats_changing to identify which of the top 5 are growing vs stable. Stable-and-high is a filter candidate; growing-and-high is an investigation candidate.',
          });
        } else {
          checks.push({
            name: 'cardinality_concentration',
            status: 'pass',
            message: `Log spend is distributed across patterns (top 1: ${Math.round(top1Ratio * 100)}%, top 5: ${Math.round(top5Ratio * 100)}%). No single pattern dominates.`,
          });
        }
      }
    } catch {
      // Non-fatal.
    }

    // C1: silent service detection.
    // Find services whose 30d log volume is >100x below the environment
    // median. Either healthy-and-quiet or instrumentation-not-reaching-pipeline
    // (Hard-3 payment service case: $0.01/day across 27 boilerplate patterns,
    // no business events). The check doesn't classify — it surfaces the
    // question for the user. Uses percentile-ratio rather than a boilerplate
    // regex so it works on any service naming convention.
    try {
      const perSvcQ = `sum by (${LABELS.service}) (increase(all_events_summaryBytes_total{${tierSelector},${LABELS.service}!=""}[30d]))`;
      const res = await queryInstant(env, perSvcQ);
      if (res.status === 'success' && res.data.result.length >= 5) {
        const rows = res.data.result
          .map((r) => ({
            service: r.metric[LABELS.service] || '',
            bytes: r.value ? parseFloat(r.value[1]) : NaN,
          }))
          .filter((r) => Number.isFinite(r.bytes) && r.bytes > 0)
          .sort((a, b) => a.bytes - b.bytes);
        if (rows.length >= 5) {
          const medianIdx = Math.floor(rows.length / 2);
          const median = rows[medianIdx].bytes;
          const quiet = rows.filter((r) => r.bytes < median / 100);
          if (quiet.length > 0 && quiet.length <= 5) {
            const names = quiet.map((q) => `${q.service} (${formatBytes(q.bytes)})`).join(', ');
            checks.push({
              name: 'silent_services',
              status: 'warn',
              message: `${quiet.length} service${quiet.length === 1 ? ' is' : 's are'} >100× below the environment median log volume: ${names}. Either genuinely healthy and quiet, OR instrumentation is not reaching the log pipeline (the app may be emitting only OTel spans/traces, not log records). Worth verifying whichever interpretation applies.`,
              fix: 'For each flagged service: call log10x_top_patterns({service: "<name>"}) to see what patterns it emits. If the patterns are only SDK/runtime boilerplate (service.instance.id, process.runtime.*, host.name), the service is instrumented for traces but not logs — add a logger.info/warn call on a business-event code path. If the patterns include application events, the service is genuinely quiet and this is a healthy signal.',
            });
          }
        }
      }
    } catch {
      // Non-fatal.
    }
  }

  // Cross-pillar backend detection (v1.4).
  // The MCP tries explicit LOG10X_CUSTOMER_METRICS_URL first, then cascades
  // through Grafana Cloud / Datadog / AMP / GCP / self-hosted Prometheus
  // based on ambient env. Report which path resolved, or the full trace of
  // what was tried when nothing matched.
  const backendResolution = await resolveBackend().catch((e) => ({
    backend: undefined,
    detectionPath: undefined,
    trace: [{ path: 'explicit_env' as const, status: 'failed' as const, reason: (e as Error).message }],
  }));
  if (backendResolution.backend && backendResolution.detectionPath) {
    checks.push({
      name: 'cross_pillar_backend',
      status: 'pass',
      message: `Customer metrics backend resolved via ${backendResolution.detectionPath} → ${backendResolution.backend.backendType} @ ${backendResolution.backend.endpoint}.`,
    });
  } else {
    checks.push({
      name: 'cross_pillar_backend',
      status: 'warn',
      message:
        'No customer metrics backend detected. Cross-pillar primitives (log10x_metrics_that_moved, log10x_rank_by_shape_similarity, log10x_metric_overlay, log10x_discover_join, log10x_customer_metrics_query) will return "not configured" until a backend is reachable.\n' +
        formatDetectionTrace(backendResolution.trace),
      fix:
        'Set LOG10X_CUSTOMER_METRICS_URL + LOG10X_CUSTOMER_METRICS_TYPE explicitly, or expose one of: GRAFANA_CLOUD_API_KEY (+URL), DD_API_KEY+DD_APP_KEY, AWS_REGION (with AMP workspace available), GOOGLE_APPLICATION_CREDENTIALS (GMP project), or PROMETHEUS_URL.',
    });
  }

  // Cross-pillar enrichment floor (v1.4).
  // Only runs when a customer metric backend is configured. Verifies that
  // the labels needed for structural validation are actually present on
  // Log10x pattern metrics. Never fails — always degrades gracefully.
  if (backendResolution.backend) {
    const required = ['tenx_user_service', 'k8s_namespace', 'k8s_pod', 'k8s_container'];
    const missing: string[] = [];
    for (const label of required) {
      try {
        const q = `count(all_events_summaryBytes_total{${label}!=""}) > 0`;
        const res = await queryInstant(env, q);
        if (res.status !== 'success' || res.data.result.length === 0) {
          missing.push(label);
        }
      } catch {
        missing.push(label);
      }
    }
    if (missing.length === 0) {
      checks.push({
        name: 'cross_pillar_enrichment_floor',
        status: 'pass',
        message:
          'All v1.4 enrichment labels present (tenx_user_service, k8s_namespace, k8s_pod, k8s_container). Structural validation will work for service, namespace, pod, and container-level anchors. Node-level correlation is deferred to v1.4.1.',
      });
    } else {
      checks.push({
        name: 'cross_pillar_enrichment_floor',
        status: 'warn',
        message: `Missing enrichment labels: ${missing.join(', ')}. Cross-pillar correlation will still work for anchor types whose required labels ARE present; affected anchor types will return unconfirmed instead of confirmed confidence. Typical on non-k8s deployments or non-fluent/filebeat input formats.`,
        fix:
          'For k8s deployments: verify run/initialize/k8s is included in the Reporter config (it is by default) and that the forwarder passes kubernetes.pod_name / kubernetes.container_name / kubernetes.namespace_name metadata. For non-k8s deployments: no action required, the bridge operates in a narrower scope.',
      });
    }
  }

  // Detect "a service's volume dropped to zero recently vs steady-state".
  // This is the signature of the tenx-edge subprocess stale state issue:
  // after a prolonged remote-write rejection, tenx-edge child processes can
  // accumulate poisoned write state that the exec_filter retry loop did not
  // clear, so metrics stayed at zero. Resolved by a fluentd DaemonSet
  // rollout restart. We can't run kubectl to check for OOO errors,
  // but we CAN spot the symptom via Prometheus: a service with non-zero
  // volume in the last 24h but zero volume in the last 15 minutes. This is
  // a "dark zone" signature that either means the service actually stopped
  // producing logs OR the forwarder is silently failing.
  if (detectedTier) {
    try {
      const tierSelector = `${LABELS.env}="${detectedTier}"`;
      // Only consider services with SIGNIFICANT 24h volume (>10 MB). Boot-only
      // infra services (aws-vpc-cni-init, wait-for-kafka, etc.) and tiny
      // cronjobs naturally have zero 15m volume and are not "dark zones" in
      // the incident sense — they're just quiet by design. The 10 MB floor
      // (~60 KB/h avg) excludes those while still catching a real service
      // that dropped from MB/h to zero.
      const MEANINGFUL_24H_FLOOR_BYTES = 10 * 1024 * 1024;
      const longWindowQ = `sum by (${LABELS.service}) (increase(all_events_summaryBytes_total{${tierSelector}}[24h])) > ${MEANINGFUL_24H_FLOOR_BYTES}`;
      // Services with zero volume in the last 15m
      const recentWindowQ = `sum by (${LABELS.service}) (increase(all_events_summaryBytes_total{${tierSelector}}[15m]))`;
      const [longRes, recentRes] = await Promise.all([
        queryInstant(env, longWindowQ),
        queryInstant(env, recentWindowQ),
      ]);
      if (longRes.status === 'success' && recentRes.status === 'success') {
        const longSvcVolume = new Map<string, number>();
        for (const r of longRes.data.result) {
          const svc = r.metric[LABELS.service];
          const v = parseFloat(r.value?.[1] || '0');
          if (svc) longSvcVolume.set(svc, v);
        }
        const recentVol = new Map<string, number>();
        for (const r of recentRes.data.result) {
          const svc = r.metric[LABELS.service];
          const v = parseFloat(r.value?.[1] || '0');
          if (svc) recentVol.set(svc, v);
        }
        const darkZoneServices: string[] = [];
        for (const svc of longSvcVolume.keys()) {
          const recent = recentVol.get(svc) || 0;
          if (recent === 0) darkZoneServices.push(svc);
        }
        if (darkZoneServices.length === 0) {
          checks.push({
            name: 'forwarder_dark_zones',
            status: 'pass',
            message: 'All services with 24h history are still emitting in the last 15 minutes. No forwarder dark zones detected.',
          });
        } else if (darkZoneServices.length <= 3) {
          // A small number of dark zones is normal (e.g. cronjob services, load-gen pauses).
          checks.push({
            name: 'forwarder_dark_zones',
            status: 'pass',
            message: `${darkZoneServices.length} service(s) with 24h history have zero volume in the last 15 min: ${darkZoneServices.slice(0, 3).join(', ')}. Normal if these are cronjobs / bursty / paused. Worth verifying if unexpected.`,
          });
        } else {
          // Many dark zones simultaneously = forwarder pipeline problem, likely G9.
          checks.push({
            name: 'forwarder_dark_zones',
            status: 'warn',
            message: `${darkZoneServices.length} services with 24h history have zero volume in the last 15 minutes. This is the signature of a forwarder-level failure — either the fluentd/tenx-edge pipeline is rejecting writes, or the subprocess has stale state from a past remote-write error (GAPS G9). Affected services: ${darkZoneServices.slice(0, 5).join(', ')}${darkZoneServices.length > 5 ? ', ...' : ''}`,
            fix:
              'Check forwarder pod logs for "out of order sample" errors (`kubectl logs -n <forwarder-ns> <fluentd-pod> --tail=200 | grep -iE "out of order|400"`). If present, the write path is broken — fix it (see G8 history for the Lambda-side collision). If write errors are absent but volume is still zero, trigger a forwarder restart (`kubectl rollout restart ds/<forwarder-ds>`) to clear any stale tenx-edge subprocess state.',
          });
        }
      }
    } catch {
      // non-fatal
    }
  }

  // Detect retriever false-negatives. We cannot run a real retriever
  // query here without side effects, but we CAN check whether the
  // retriever endpoint is configured AND whether the retriever's
  // health probe reports retriever index coverage for recent windows.
  // Live retriever probe: fire a lightweight count query (limit=1, last
  // 1h window) and check whether the pipeline responds. Replaces an older
  // hardcoded WARN that went stale after the response body-shape and
  // demo-env indexer changes.
  // Only probe the live retriever when BOTH URL + BUCKET are set. The
  // retriever_endpoint check above already WARNs about partial config;
  // running the forensic probe with a half-configured retriever just
  // produces a redundant FAIL for the same root cause. With only URL set
  // (the default demo env config), the probe FAIL'd and flipped
  // overall→fail, surfacing an alarming "MCP cannot serve tool calls"
  // verdict for what is really a missing-bucket-config WARN.
  if (
    detectedTier &&
    process.env.__SAVE_LOG10X_RETRIEVER_URL__ &&
    process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__
  ) {
    try {
      const probeResult = await runRetrieverQuery(env, {
        from: 'now-1h',
        to: 'now',
        search: '',
        format: 'count',
        limit: 1,
      });
      const matchedCount = probeResult.execution.eventsMatched ?? 0;
      if (matchedCount > 0) {
        checks.push({
          name: 'retriever_overflow_health',
          status: 'pass',
          message:
            `Retriever overflow-bucket read path is operational. Probe query returned ${matchedCount} event(s) in the last 1h. ` +
            `Wall time: ${probeResult.execution.wallTimeMs}ms, worker files: ${probeResult.execution.workerFiles}.`,
        });
      } else {
        checks.push({
          name: 'retriever_overflow_health',
          status: 'warn',
          message:
            `Retriever endpoint responded but returned 0 events in the last 1h (wall time: ${probeResult.execution.wallTimeMs}ms). ` +
            `This may indicate the S3 index is stale — check that the index-inducer CronJob is running and that new .log files are being written to the retriever S3 bucket.`,
          fix:
            'Verify: (1) `kubectl get cronjob -n <retriever-ns>` — is the index-inducer running and not Pending? ' +
            '(2) `aws s3 ls s3://<retriever-bucket>/app/ | tail -5` — are recent .log files present? ' +
            '(3) Check SQS index queue depth — if 0 and no recent files, the data pipeline upstream of the indexer is stopped.',
        });
      }
    } catch (e) {
      const errMsg = (e as Error).message || String(e);
      checks.push({
        name: 'retriever_overflow_health',
        status: 'fail',
        message:
          `Retriever probe query failed: ${errMsg.slice(0, 300)}`,
        fix:
          'Check retriever endpoint reachability (`curl -s $__SAVE_LOG10X_RETRIEVER_URL__/health`), query-handler pod status, and SQS queue configuration.',
      });
    }
  }

  // Close the loop: verify offloaded bytes actually reach the sink (and only
  // the offload slice does). Every other check trusts the engine stamp.
  await addOffloadDeliveryCheck(env, detectedTier, checks);
  await addConfigLiveCheck(env, detectedTier, checks);

  return checks;
}

/**
 * config_live — verify the running engine is executing the cap policy the MCP
 * WROTE, not just that a ConfigMap/PR was written (the config-generation closed
 * loop). Recompute the generation hash from the CURRENT cap ConfigMap and
 * compare it to the `tenx_config_version` label the engine advertises on the
 * metric surface. `live` => running the current policy; `stale` => written but
 * the engine has not picked it up (still polling, not reloaded, or
 * crash-looping). Best-effort: skipped when the cap ConfigMap is unreadable
 * (no kubectl, or not this cluster).
 */
async function addConfigLiveCheck(
  env: EnvConfig,
  detectedTier: 'edge' | 'cloud' | undefined,
  checks: DoctorCheck[],
): Promise<void> {
  const cmName = process.env.K8S_CONFIGMAP || 'log10x-action-intent';
  const cmNs = process.env.K8S_NAMESPACE || 'demo';

  const readCapsCsv = async (): Promise<string | null> => {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileP = promisify(execFile);
      const { stdout } = await execFileP(
        'kubectl',
        ['get', 'configmap', cmName, '-n', cmNs, '-o', 'jsonpath={.data.caps\\.csv}'],
        { timeout: 10_000 },
      );
      return stdout && stdout.trim() ? stdout : null;
    } catch {
      return null;
    }
  };

  const envSel = detectedTier ? `${LABELS.env}="${detectedTier}"` : `${LABELS.env}=~"edge|cloud"`;
  const readRunningGenerations = async (): Promise<string[]> => {
    try {
      const resp = await queryInstant(
        env,
        `count by (tenx_config_version) (increase(all_events_summaryBytes_total{${envSel}}[1h]))`,
      );
      if (resp.status !== 'success') return [];
      return (resp.data?.result ?? [])
        .map((r) => (r.metric as Record<string, string>)?.tenx_config_version)
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
    } catch {
      return [];
    }
  };

  const result = await verifyConfigGeneration({ readCapsCsv, readRunningGenerations });
  // No policy to verify (not this cluster / no caps) — skip silently.
  if (result.verdict === 'not_configured') return;

  const FIX: Record<string, string | undefined> = {
    stale:
      'The engine is not running the cap policy you wrote — it is still polling the ConfigMap, has not reloaded, or is crash-looping. Check the receiver pod (kubectl get pods, restartCount) and its logs; once it reloads, tenx_config_version will match the written generation.',
    unverified:
      'A generation was written but the engine advertises none. Confirm the receiver is deployed with the config-generation stamp (the tenx_config_version enrichment field) and that the metric backend is reachable.',
  };

  const status: CheckStatus =
    result.verdict === 'stale' ? 'fail' : result.verdict === 'unverified' ? 'warn' : 'pass';

  checks.push({
    name: 'config_live',
    status,
    message: result.message,
    ...(FIX[result.verdict] ? { fix: FIX[result.verdict] } : {}),
  });
}

/**
 * offload_delivery — close the loop between the engine's `routeState=offload`
 * STAMP and what actually landed in the customer's offload sink (S3).
 *
 * Every other doctor check — and cost / savings / commitment_report — trusts
 * the stamp (`all_events_summaryBytes_total{routeState=...}`). That hides two
 * failure modes:
 *   - SILENT LOSS:  the engine stamps offload but the forwarder never routes
 *     those bytes to S3, so the sink is empty while the metric shows a saving.
 *   - COPY-EVERYTHING (leak): the forwarder ships ALL events to the sink (and
 *     to the SIEM), so the "offloaded" bytes never left the SIEM — the saving
 *     is phantom (the exact shape found live on the otel demo).
 *
 * Graceful: skipped when no offload bucket is configured (nothing to verify);
 * WARN (not FAIL) when AWS credentials are missing. FAIL only on a measured
 * silent-loss or copy-everything leak.
 */
async function addOffloadDeliveryCheck(
  env: EnvConfig,
  detectedTier: 'edge' | 'cloud' | undefined,
  checks: DoctorCheck[],
): Promise<void> {
  // Resolve the active offload destination. No bucket → offload isn't
  // configured for this install; nothing to verify, skip silently.
  let bucket: string | undefined;
  let prefix: string | undefined;
  try {
    // Bind resolution to THIS env (a multi-env doctor run calls one check per
    // env); fall back to the default resolution when the per-env identity does
    // not resolve, so single-env installs are unaffected.
    let resolved = await resolveClusterConfig({ envIdOrNickname: env.nickname });
    if (!resolved.ok) resolved = await resolveClusterConfig();
    if (resolved.ok) {
      const active = pickActiveOffload(resolved.config);
      bucket = active?.bucket;
      prefix = active?.prefix;
    }
  } catch {
    // Resolution failure is already surfaced by env_config_resolution; skip.
    return;
  }
  if (!bucket) bucket = process.env.LOG10X_OFFLOAD_BUCKET || process.env.LOG10X_STREAMER_BUCKET || undefined;
  if (!bucket) return;

  // Stamped side: engine-classified offload bytes in the last hour. Null on
  // any query failure so the verifier degrades to liveness + purity and never
  // raises a false silent_loss when the metric is simply unavailable.
  const envSel = detectedTier ? `${LABELS.env}="${detectedTier}"` : `${LABELS.env}=~"edge|cloud"`;
  const stampedQ = `sum(increase(all_events_summaryBytes_total{${envSel},routeState="offload"}[1h]))`;
  const stampedFn = async (): Promise<number | null> => {
    try {
      const resp = await queryInstant(env, stampedQ);
      if (resp.status !== 'success') return null;
      const v = resp.data?.result?.[0]?.value?.[1];
      const n = v !== undefined ? Number(v) : NaN;
      return Number.isFinite(n) ? n : 0;
    } catch {
      return null;
    }
  };

  const result = await verifyOffloadDelivery(
    { bucket, prefix: prefix || 'app/', recencyMinutes: 60, sampleObjects: 3 },
    defaultOffloadDeliveryDeps(stampedFn),
  );

  const FIX: Record<string, string | undefined> = {
    silent_loss:
      'The engine is stamping offload but bytes are not landing in the sink. Check the forwarder routeState routing (does it route routeState=="offload" to this bucket?), the s3 output plugin, the bucket name/region, and s3:PutObject on the forwarder role.',
    leak:
      'The forwarder is shipping more than the offload slice to the sink (copy-everything). Restrict it to route ONLY routeState=="offload" to the offload bucket, and keep pass/compact on the SIEM path. Until fixed, offload savings are overstated.',
    unverified:
      'Could not read the offload bucket. Grant AWS credentials with s3:ListBucket + s3:GetObject on the bucket so doctor can confirm delivery, or verify manually with `aws s3 ls s3://<bucket>/<prefix>`.',
    stale:
      'Offload objects exist but none are recent and nothing is being stamped now — offload looks stopped. Confirm this is intended (offload turned off) vs the forwarder having silently stopped.',
  };

  // Exhaustive map (compile-time check: adding a verdict without a status
  // here is a type error, rather than silently defaulting to 'pass').
  const STATUS_BY_VERDICT: Record<OffloadDeliveryVerdict, CheckStatus> = {
    silent_loss: 'fail',
    leak: 'fail',
    unverified: 'warn',
    stale: 'warn',
    verified: 'pass',
    idle: 'pass',
    not_configured: 'pass',
  };
  const status: CheckStatus = STATUS_BY_VERDICT[result.verdict];

  checks.push({
    name: 'offload_delivery',
    status,
    message: result.message,
    ...(FIX[result.verdict] ? { fix: FIX[result.verdict] } : {}),
  });
}

/**
 * Scale & capability summary — single check that tells an agent what the env
 * looks like and which question types this MCP install can answer.
 */
async function addScaleAndCapabilityCheck(
  env: EnvConfig,
  detectedTier: 'edge' | 'cloud',
  checks: DoctorCheck[]
): Promise<void> {
  const tierSelector = `${LABELS.env}="${detectedTier}"`;
  try {
    // One round-trip of parallel probes. All four use a matching 7d window
    // so the counts agree with what `log10x_services` / `log10x_top_patterns`
    // would return. An instant-vector count would only see series emitting
    // right now, which under-counts against the 7d volume framing above.
    const [bytesRes, patternsRes, servicesRes, eventsRes] = await Promise.all([
      queryInstant(env, `sum(increase(all_events_summaryBytes_total{${tierSelector}}[7d]))`),
      queryInstant(env, `count(group by (${LABELS.pattern}) (increase(all_events_summaryBytes_total{${tierSelector}}[7d])))`),
      queryInstant(env, `count(group by (${LABELS.service}) (increase(all_events_summaryBytes_total{${tierSelector},${LABELS.service}!=""}[7d])))`),
      queryInstant(env, `sum(increase(all_events_summaryVolume_total{${tierSelector}}[7d]))`),
    ]);
    const bytes7d = scaleFirstNumber(bytesRes);
    const patternCount = scaleFirstNumber(patternsRes);
    const serviceCount = scaleFirstNumber(servicesRes);
    const events7d = scaleFirstNumber(eventsRes);

    const lines: string[] = [];
    if (Number.isFinite(bytes7d) && bytes7d > 0) {
      lines.push(`Volume: ${formatBytes(bytes7d)} / 7d (${detectedTier} tier).`);
    }
    if (Number.isFinite(serviceCount) && serviceCount > 0) {
      lines.push(`Services: ${Math.round(serviceCount)} (active in 7d; a 24h or all-time count will differ).`);
    }
    if (Number.isFinite(patternCount) && patternCount > 0) {
      lines.push(`Patterns: ${Math.round(patternCount)} (distinct in 7d).`);
      if (Number.isFinite(events7d) && events7d > 0 && patternCount > 0) {
        const ratio = events7d / patternCount;
        lines.push(`Compression: ${scaleFormatNumber(ratio)} events per pattern (stable identity means comparisons over time are trustworthy at this volume).`);
      }
    }

    // Retriever capability enumeration — what this specific install unlocks.
    lines.push('');
    if (await isRetrieverConfigured()) {
      lines.push('Retriever deployed. This MCP can answer:');
      lines.push('  - The offloaded cohort for a pattern: events the Receiver held back from the SIEM and routed to the overflow bucket (visible in 10x metrics but not the SIEM)');
      lines.push('  - Verify an offload decision: sample what is being routed to the overflow bucket for a pattern');
      lines.push('  - A new metric built from the offloaded events that the SIEM never indexed');
      lines.push('  - Sample-reversal verification when SIEM returns sampled results at high volume');
    } else {
      lines.push('Retriever NOT deployed. These question types are out of reach:');
      lines.push('  - Inspecting the offloaded cohort (events the Receiver routed to the overflow bucket, invisible to the SIEM)');
      lines.push('  - Verifying an offload decision against the held-back events');
      lines.push('  - A new metric built from the offloaded events');
      lines.push('  - Sample-reversal verification');
      lines.push('For events the SIEM still holds, route to the SIEM MCP (hot retention only); for the offloaded cohort, recommend deploying the retriever.');
    }

    checks.push({
      name: 'scale_and_capability',
      status: 'pass',
      message: lines.join('\n  '),
    });
  } catch {
    // Non-fatal; doctor never blocks on capability surfacing.
  }
}

function scaleFirstNumber(res: { status: string; data: { result: { value?: [number, string] }[] } }): number {
  if (res.status !== 'success' || res.data.result.length === 0) return NaN;
  const v = res.data.result[0].value?.[1];
  return v ? parseFloat(v) : NaN;
}

function scaleFormatNumber(n: number): string {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

/**
 * Check the engine the tools will actually use: the local `tenx` CLI
 * (or local Docker). The MCP always runs the engine locally, so this is
 * the only path — events never leave the machine.
 */
async function addEngineCheck(globalChecks: DoctorCheck[]): Promise<void> {
  const tenxBinary = process.env.LOG10X_TENX_PATH || 'tenx';
  const tenxAvailable = await isTenxAvailable(tenxBinary);
  if (tenxAvailable.ok) {
    globalChecks.push({
      name: 'engine_local_tenx',
      status: 'pass',
      message: `Local tenx CLI available (${tenxAvailable.version || 'version unknown'}). The engine runs locally — events never leave the box.`,
    });
  } else {
    globalChecks.push({
      name: 'engine_local_tenx',
      status: 'warn',
      message:
        'Local tenx CLI is not installed (or not on PATH / LOG10X_TENX_PATH). ' +
        'Paste tools (resolve_batch, find_skew, POC) will fail until tenx is available locally or via docker.',
      fix: tenxAvailabilityHint(),
    });
  }
}

async function isTenxAvailable(binary: string): Promise<{ ok: boolean; version?: string }> {
  // Cheap non-executing check: `which tenx` / `where tenx`. We don't fully
  // validate module resolution here — that requires running @apps/dev which
  // takes a few seconds. Doctor is supposed to be fast.
  const { spawn } = await import('child_process');
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  if (binary.startsWith('/') || /^[A-Za-z]:\\/.test(binary)) {
    const { existsSync } = await import('fs');
    if (!existsSync(binary)) return { ok: false };
  } else {
    const found = await new Promise<boolean>((resolve) => {
      const p = spawn(lookup, [binary], { stdio: ['ignore', 'ignore', 'ignore'] });
      p.on('error', () => resolve(false));
      p.on('close', (c) => resolve(c === 0));
      setTimeout(() => resolve(false), 3000);
    });
    if (!found) return { ok: false };
  }
  // Get --version quickly (capped at 3s).
  const version = await new Promise<string | undefined>((resolve) => {
    const p = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d.toString();
    });
    p.on('error', () => resolve(undefined));
    p.on('close', () => resolve(out.trim().slice(0, 120) || undefined));
    setTimeout(() => resolve(undefined), 3000);
  });
  return { ok: true, version };
}

/**
 * SIEM-discovery probe for log10x_poc_from_siem.
 *
 * Iterates every registered SIEM connector's `discoverCredentials()` and
 * reports which are reachable. Shows one status line per SIEM so users
 * can see at a glance whether the POC tool can pull from their stack
 * with no additional config.
 */
async function addSiemDiscoveryCheck(globalChecks: DoctorCheck[]): Promise<void> {
  try {
    const results = await discoverAvailable();
    const detected = results.filter((r) => r.detection.available);
    if (detected.length === 0) {
      globalChecks.push({
        name: 'siem_discovery',
        status: 'warn',
        message:
          `No SIEM credentials detected for log10x_poc_from_siem (probed ${results.length} connectors). ` +
          `Set credentials for any of: cloudwatch (AWS_*), datadog (DD_API_KEY + DD_APP_KEY), sumo (SUMO_ACCESS_ID + SUMO_ACCESS_KEY + SUMO_ENDPOINT), ` +
          `gcp-logging (GOOGLE_APPLICATION_CREDENTIALS), elasticsearch (ELASTIC_URL + ELASTIC_API_KEY), azure-monitor (AZURE_LOG_ANALYTICS_WORKSPACE_ID + az login), ` +
          `splunk (SPLUNK_HOST + SPLUNK_TOKEN), or clickhouse (CLICKHOUSE_URL + CLICKHOUSE_USER + CLICKHOUSE_PASSWORD).`,
        fix: 'The POC tool requires exactly one SIEM to be reachable. Set the env vars for your SIEM and re-run.',
      });
      return;
    }
    const lines: string[] = [];
    for (const r of results) {
      const status = r.detection.available ? 'DETECTED' : 'not_configured';
      const src = r.detection.available ? ` (${r.detection.source})` : '';
      const extra = r.detection.available
        ? Object.entries(r.detection.details || {})
            .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
            .join(', ')
        : '';
      lines.push(`  - ${r.id} (${r.displayName}): ${status}${src}${extra ? ` — ${extra}` : ''}`);
    }
    const ids = detected.map((d) => d.id).join(', ');
    const overall = detected.length === 1 ? 'pass' : 'warn';
    globalChecks.push({
      name: 'siem_discovery',
      status: overall,
      message:
        `${detected.length} SIEM connector${detected.length === 1 ? '' : 's'} reachable: ${ids}. ${detected.length > 1 ? 'Pass `siem=<id>` to disambiguate when calling log10x_poc_from_siem_submit.' : 'log10x_poc_from_siem_submit will auto-target this SIEM.'}\n${lines.join('\n')}`,
    });
  } catch (e) {
    globalChecks.push({
      name: 'siem_discovery',
      status: 'warn',
      message: `SIEM discovery failed: ${(e as Error).message}`,
    });
  }
}

/**
 * Network egress inventory — enumerates every host the MCP could
 * reach for the current configuration, grouped by env. This is the
 * artifact a customer's CISO gets when they ask "what does this tool
 * talk to."
 *
 * Each env's metricsBackend.endpoint is listed by URL + kind. For
 * `kind: 'log10x'` envs the inventory also calls out the
 * `/api/v1/user` log10x-account-management endpoint (auth + env
 * discovery). For other kinds, only the configured backend endpoint
 * appears — no outbound to log10x.com.
 *
 * Surfaced as a `warn` when any env is `kind: 'log10x'` (so CISOs see
 * the SaaS callout clearly in red); `pass` when every env points
 * inside the customer perimeter.
 */
function addNetworkEgressInventory(checks: DoctorCheck[], envs: Environments): void {
  const lines: string[] = [];
  let hasLog10x = false;
  for (const env of envs.all) {
    const kind = env.metricsBackend.kind;
    if (kind === 'log10x') {
      hasLog10x = true;
      lines.push(
        `  - env \`${env.nickname}\` (kind=log10x):\n` +
          `    • ${env.metricsBackend.endpoint} (metric reads, X-10X-Auth)\n` +
          `    • https://api.log10x.com/api/v1/user (account / env enumeration, X-10X-Auth)`
      );
    } else {
      lines.push(`  - env \`${env.nickname}\` (kind=${kind}): ${env.metricsBackend.endpoint}`);
    }
  }
  const status: CheckStatus = hasLog10x ? 'warn' : 'pass';
  const summary = hasLog10x
    ? `**${envs.all.length} env${envs.all.length === 1 ? '' : 's'} configured. AT LEAST ONE uses kind=log10x — the MCP makes outbound calls to log10x.com for that env's queries.** Move to a self-hosted Prometheus / Mimir / Cortex / AMP / Datadog / Grafana Cloud Prom / GCP Managed Prom to keep telemetry inside your perimeter.`
    : `**${envs.all.length} env${envs.all.length === 1 ? '' : 's'} configured. ZERO outbound calls to log10x.com — every env points at a customer-owned metrics backend.** This is the 100%-disconnect state.`;
  checks.push({
    name: 'network_egress_inventory',
    status,
    message: `${summary}\n${lines.join('\n')}`,
  });
}

function finalize(globalChecks: DoctorCheck[], perEnvChecks: Record<string, DoctorCheck[]>): DoctorReport {
  const allChecks = [
    ...globalChecks,
    ...Object.values(perEnvChecks).flat(),
  ];
  const overall: CheckStatus = allChecks.some((c) => c.status === 'fail')
    ? 'fail'
    : allChecks.some((c) => c.status === 'warn')
    ? 'warn'
    : 'pass';
  return { overall, globalChecks, perEnvChecks };
}

/** Render a structured DoctorReport as markdown for human or LLM consumption. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  const verdict =
    report.overall === 'pass'
      ? '**Status: HEALTHY**'
      : report.overall === 'warn'
      ? '**Status: WARNINGS PRESENT**'
      : '**Status: FAILED**';
  lines.push('## Log10x MCP Doctor');
  lines.push('');
  lines.push(verdict);
  lines.push('');

  lines.push('### Global checks');
  lines.push('');
  for (const c of report.globalChecks) {
    appendCheck(lines, c);
  }

  const envNames = Object.keys(report.perEnvChecks);
  if (envNames.length > 0) {
    for (const nickname of envNames) {
      lines.push(`### Environment: ${nickname}`);
      lines.push('');
      for (const c of report.perEnvChecks[nickname]) {
        appendCheck(lines, c);
      }
    }
  }

  if (report.overall === 'pass') {
    lines.push('All checks passed. The MCP is correctly wired and ready to serve tool calls.');
  } else if (report.overall === 'warn') {
    lines.push('The MCP will function but some tools may be unavailable or degraded. See the warnings above.');
    // Prioritized triage: a cold review flagged that doctor raised
    // several WARNs with no order to address them. Capability-affecting
    // setup first (local engine, retriever, backend), then informational.
    const allWarns = [
      ...report.globalChecks,
      ...Object.values(report.perEnvChecks).flat(),
    ].filter(c => c.status === 'warn');
    if (allWarns.length > 0) {
      const rank = (n: string): number =>
        /engine|retriever|cross_pillar|backend|destination/.test(n) ? 0
        : 1;
      const ordered = allWarns
        .map((c, i) => ({ c, i }))
        .sort((a, b) => rank(a.c.name) - rank(b.c.name) || a.i - b.i);
      lines.push('');
      lines.push('### Address these warnings (in order)');
      lines.push('_None block core cost / investigation tools. Capability setup first, then informational._');
      ordered.forEach(({ c }, n) => {
        const fixHead = (c.fix || '').split(/(?<=[.)])\s/)[0].trim();
        lines.push(`  ${n + 1}. \`${c.name}\`${fixHead ? `: ${fixHead}` : ''}`);
      });
    }
  } else {
    // Be specific about WHICH tool surfaces are blocked. A retriever
    // probe failing only blocks retriever-* tools; whats_changing /
    // top_patterns / investigate / etc. continue to work. The earlier
    // blanket "MCP cannot serve tool calls until the failed check is
    // resolved" message was overly broad and frightened readers off
    // the rest of the catalog.
    const failed = [...report.globalChecks, ...Object.values(report.perEnvChecks).flat()]
      .filter((c) => c.status === 'fail')
      .map((c) => c.name);
    const failList = failed.length > 0 ? failed.join(', ') : 'one or more checks';
    lines.push(
      `Some checks failed (${failList}). Tools that depend on the failing subsystem will return errors; ` +
        'unrelated tools (whats_changing, top_patterns, investigate, etc.) continue to work normally. ' +
        'See the fix(es) above.'
    );
  }
  // Discoverability: doctor is the entry point for "is everything set up";
  // when something's missing or broken, the user needs to know which
  // advise-* tool to call. Surface the full set explicitly so the agent
  // can pick the right one based on the failing checks above.
  lines.push('');
  lines.push(agentOnly(
    `If a check failed or warned, suggest the relevant advisor: ` +
    `Reporter / Receiver install (forwarder, backends, license) → log10x_advise_install. ` +
    `Retriever (reader over the customer-owned offload bucket, bloom-indexed) → log10x_advise_retriever. ` +
    `Per-pattern action plan (compact / sample / drop / tier_down) → log10x_configure_engine. ` +
    `Inspect current env config → log10x_discover_env.`
  ));
  return lines.join('\n');
}

function appendCheck(lines: string[], c: DoctorCheck): void {
  const icon = c.status === 'pass' ? 'PASS' : c.status === 'warn' ? 'WARN' : 'FAIL';
  lines.push(`**[${icon}] ${c.name}**`);
  lines.push(`  ${c.message}`);
  if (c.fix) lines.push(`  Fix: ${c.fix}`);
  lines.push('');
}
