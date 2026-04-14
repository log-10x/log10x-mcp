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
import { isStreamerConfigured } from '../lib/streamer-api.js';
import { loadEnvironments, type Environments, type EnvConfig } from '../lib/environments.js';
import { LABELS } from '../lib/promql.js';

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

export async function executeDoctor(args: { environment?: string }): Promise<string> {
  const report = await runDoctorChecks(args.environment);
  return renderDoctorReport(report);
}

/** Runs the full check sequence and returns a structured report. */
export async function runDoctorChecks(envNickname?: string): Promise<DoctorReport> {
  const globalChecks: DoctorCheck[] = [];
  const perEnvChecks: Record<string, DoctorCheck[]> = {};

  // 1. Environment configuration loads successfully (global).
  let envs: Environments | undefined;
  try {
    envs = loadEnvironments();
    globalChecks.push({
      name: 'environment_config',
      status: 'pass',
      message: `${envs.all.length} environment${envs.all.length === 1 ? '' : 's'} configured (${envs.all.map((e) => e.nickname).join(', ')}).`,
    });
  } catch (e) {
    globalChecks.push({
      name: 'environment_config',
      status: 'fail',
      message: (e as Error).message,
      fix: 'Set LOG10X_API_KEY + LOG10X_ENV_ID for single-env, or LOG10X_ENVS as a JSON array for multi-env. Get credentials at https://console.log10x.com → Profile → API Settings.',
    });
    return finalize(globalChecks, perEnvChecks);
  }

  // 2. Infrastructure-wide informational checks (streamer, datadog, paste).
  //    These don't depend on a specific env so they live in globalChecks.
  addInfrastructureChecks(globalChecks);
  await addPasteEndpointCheck(globalChecks);

  // 3. Per-environment checks.
  const targets: EnvConfig[] = envNickname
    ? (() => {
        const e = envs.byNickname.get(envNickname.toLowerCase());
        if (!e) {
          globalChecks.push({
            name: 'environment_resolution',
            status: 'fail',
            message: `Unknown environment nickname "${envNickname}". Available: ${envs.all.map((x) => x.nickname).join(', ')}.`,
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
function addInfrastructureChecks(checks: DoctorCheck[]): void {
  // Streamer endpoint configured? (informational, not required)
  if (isStreamerConfigured()) {
    checks.push({
      name: 'streamer_endpoint',
      status: 'pass',
      message: `LOG10X_STREAMER_URL=${process.env.LOG10X_STREAMER_URL} — streamer_query and backfill_metric will route to this endpoint.`,
    });
  } else {
    checks.push({
      name: 'streamer_endpoint',
      status: 'warn',
      message:
        'LOG10X_STREAMER_URL is not set. log10x_streamer_query and log10x_backfill_metric will return graceful "not configured" messages.',
      fix: 'Deploy the Storage Streamer per https://docs.log10x.com/apps/cloud/streamer/ and set LOG10X_STREAMER_URL to its query endpoint.',
    });
  }

  // Datadog backfill destination credentials? (informational)
  if (process.env.DATADOG_API_KEY || process.env.DD_API_KEY) {
    checks.push({
      name: 'datadog_destination',
      status: 'pass',
      message:
        'Datadog API key detected. log10x_backfill_metric can emit to Datadog (requires Streamer for the source).',
    });
  } else {
    checks.push({
      name: 'datadog_destination',
      status: 'warn',
      message:
        'No DATADOG_API_KEY (or DD_API_KEY) set. backfill_metric to Datadog will error if attempted.',
      fix: 'Set DATADOG_API_KEY in the MCP server environment if you plan to backfill Datadog metrics.',
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
        name: 'prometheus_gateway',
        status: 'pass',
        message: `prometheus.log10x.com reachable, auth OK for env ${env.nickname}.`,
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
      fix: `Verify LOG10X_API_KEY / LOG10X_ENV_ID for env ${env.nickname} at https://console.log10x.com. If the network is locked down, allowlist prometheus.log10x.com.`,
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
            'No Reporter tier detected — investigate / cost_drivers / pattern_trend tools will be unavailable in this env.',
          fix: 'Deploy Cloud Reporter (k8s CronJob) or Edge Reporter (forwarder pipeline) per https://docs.log10x.com/apps/.',
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
            message: `${detectedTier} reporter's most recent datapoint is ${Math.round(ageSec / 3600)} hours old. The Reporter has stopped emitting. Investigate / cost_drivers / pattern_trend will return stale data or empty results.`,
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

  // Cross-pillar enrichment floor (v1.4).
  // Only runs when a customer metric backend is configured. Verifies that
  // the labels needed for structural validation are actually present on
  // Log10x pattern metrics. Never fails — always degrades gracefully.
  if (process.env.LOG10X_CUSTOMER_METRICS_URL) {
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
        message: `Missing enrichment labels: ${missing.join(', ')}. Cross-pillar correlation will still work for anchor types whose required labels ARE present; affected anchor types will return validation_unavailable instead of joined confidence. Typical on non-k8s deployments or non-fluent/filebeat input formats.`,
        fix:
          'For k8s deployments: verify run/initialize/k8s is included in the Reporter config (it is by default) and that the forwarder passes kubernetes.pod_name / kubernetes.container_name / kubernetes.namespace_name metadata. For non-k8s deployments: no action required, the bridge operates in a narrower scope.',
      });
    }
  }

  return checks;
}

/** Doctor probe on the paste endpoint — global, only runs once regardless of env count. */
async function addPasteEndpointCheck(globalChecks: DoctorCheck[]): Promise<void> {
  try {
    const url = process.env.LOG10X_PASTE_URL || 'https://meljpepqpd.execute-api.us-east-1.amazonaws.com/paste';
    const res = await fetch(url, { method: 'OPTIONS' });
    if (res.ok || res.status === 204 || res.status === 405) {
      globalChecks.push({
        name: 'paste_endpoint',
        status: 'pass',
        message: 'Log10x paste endpoint reachable. log10x_resolve_batch will route through it by default.',
      });
    } else {
      globalChecks.push({
        name: 'paste_endpoint',
        status: 'warn',
        message: `Paste endpoint returned HTTP ${res.status}. resolve_batch may fail.`,
      });
    }
  } catch (e) {
    globalChecks.push({
      name: 'paste_endpoint',
      status: 'warn',
      message: `Paste endpoint unreachable: ${(e as Error).message}`,
      fix: 'If the network is locked down, allowlist the LOG10X_PASTE_URL host (default: meljpepqpd.execute-api.us-east-1.amazonaws.com). Or set privacy_mode=true on resolve_batch and install the local tenx CLI.',
    });
  }
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
  } else {
    lines.push('The MCP cannot serve tool calls until the failed check is resolved. See the fix above.');
  }
  return lines.join('\n');
}

function appendCheck(lines: string[], c: DoctorCheck): void {
  const icon = c.status === 'pass' ? 'PASS' : c.status === 'warn' ? 'WARN' : 'FAIL';
  lines.push(`**[${icon}] ${c.name}**`);
  lines.push(`  ${c.message}`);
  if (c.fix) lines.push(`  Fix: ${c.fix}`);
  lines.push('');
}
