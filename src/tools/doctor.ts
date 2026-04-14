/**
 * log10x_doctor — startup health check.
 *
 * Single-call binary verdict on whether this MCP install is correctly
 * wired to the customer's Log10x backend. Designed to be called once at
 * the start of a session, or by the `--doctor` CLI flag at install time.
 *
 * Each check returns pass / warn / fail with a one-line explanation.
 * The tool itself returns a markdown report; the underlying check
 * runner is also exposed as `runDoctorChecks()` so the CLI flag can call
 * it without touching the MCP framework.
 */

import { z } from 'zod';
import { queryInstant } from '../lib/api.js';
import { isStreamerConfigured } from '../lib/streamer-api.js';
import { loadEnvironments, type Environments } from '../lib/environments.js';
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
  checks: DoctorCheck[];
}

export const doctorSchema = {
  environment: z.string().optional().describe('Optional environment nickname to probe (multi-env setups). Default: the first configured env.'),
};

export async function executeDoctor(args: { environment?: string }): Promise<string> {
  const report = await runDoctorChecks(args.environment);
  return renderDoctorReport(report);
}

/** Runs the full check sequence and returns a structured report. */
export async function runDoctorChecks(envNickname?: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // 1. Environment configuration loads successfully.
  let envs: Environments | undefined;
  try {
    envs = loadEnvironments();
    checks.push({
      name: 'environment_config',
      status: 'pass',
      message: `${envs.all.length} environment${envs.all.length === 1 ? '' : 's'} configured (${envs.all.map((e) => e.nickname).join(', ')}).`,
    });
  } catch (e) {
    checks.push({
      name: 'environment_config',
      status: 'fail',
      message: (e as Error).message,
      fix: 'Set LOG10X_API_KEY + LOG10X_ENV_ID for single-env, or LOG10X_ENVS as a JSON array for multi-env. Get credentials at https://console.log10x.com → Profile → API Settings.',
    });
    return finalize(checks); // can't run further checks without an env
  }

  // 2. Resolve the env we'll probe.
  const targetEnv = envNickname
    ? envs.byNickname.get(envNickname.toLowerCase())
    : envs.default;
  if (!targetEnv) {
    checks.push({
      name: 'environment_resolution',
      status: 'fail',
      message: `Unknown environment nickname "${envNickname}". Available: ${envs.all.map((e) => e.nickname).join(', ')}.`,
    });
    return finalize(checks);
  }

  // 3. API base reachable + auth works (lightweight query).
  try {
    const res = await queryInstant(targetEnv, `count(up{${LABELS.env}=~"edge|cloud"}) or vector(0)`);
    if (res.status === 'success') {
      checks.push({
        name: 'prometheus_gateway',
        status: 'pass',
        message: `prometheus.log10x.com reachable, auth OK for env ${targetEnv.nickname}.`,
      });
    } else {
      checks.push({
        name: 'prometheus_gateway',
        status: 'warn',
        message: `Gateway responded but query status was "${res.status}".`,
        fix: 'Check that the API key and env ID match and have read access.',
      });
    }
  } catch (e) {
    checks.push({
      name: 'prometheus_gateway',
      status: 'fail',
      message: `Gateway query failed: ${(e as Error).message}`,
      fix: 'Verify LOG10X_API_KEY / LOG10X_ENV_ID at https://console.log10x.com. If the network is locked down, allowlist prometheus.log10x.com.',
    });
  }

  // 4. Reporter tier detection — check whether edge or cloud has data.
  try {
    const res = await queryInstant(
      targetEnv,
      `count(all_events_summaryBytes_total{${LABELS.env}="edge"}) > 0`
    );
    if (res.status === 'success' && res.data.result.length > 0) {
      checks.push({
        name: 'reporter_tier',
        status: 'pass',
        message: 'Edge Reporter detected — full-fidelity metrics with dropped-event coverage.',
      });
    } else {
      const cloudRes = await queryInstant(
        targetEnv,
        `count(all_events_summaryBytes_total{${LABELS.env}="cloud"}) > 0`
      );
      if (cloudRes.status === 'success' && cloudRes.data.result.length > 0) {
        checks.push({
          name: 'reporter_tier',
          status: 'pass',
          message: 'Cloud Reporter detected — sampled metrics, ±1-5min inflection granularity.',
        });
      } else {
        checks.push({
          name: 'reporter_tier',
          status: 'warn',
          message: 'No Reporter tier detected — investigate / cost_drivers / pattern_trend tools will be unavailable.',
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

  // 5. Streamer endpoint configured? (informational, not required)
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
      message: 'LOG10X_STREAMER_URL is not set. log10x_streamer_query and log10x_backfill_metric will return graceful "not configured" messages.',
      fix: 'Deploy the Storage Streamer per https://docs.log10x.com/apps/cloud/streamer/ and set LOG10X_STREAMER_URL to its query endpoint.',
    });
  }

  // 6. Datadog backfill destination credentials? (informational)
  if (process.env.DATADOG_API_KEY || process.env.DD_API_KEY) {
    checks.push({
      name: 'datadog_destination',
      status: 'pass',
      message: 'Datadog API key detected. log10x_backfill_metric can emit to Datadog (requires Streamer for the source).',
    });
  } else {
    checks.push({
      name: 'datadog_destination',
      status: 'warn',
      message: 'No DATADOG_API_KEY (or DD_API_KEY) set. backfill_metric to Datadog will error if attempted.',
      fix: 'Set DATADOG_API_KEY in the MCP server environment if you plan to backfill Datadog metrics.',
    });
  }

  // 7. Paste Lambda smoke (used by resolve_batch). Just a cheap reachability
  // ping — we don't actually submit a batch. The endpoint is public so this
  // is safe even on misconfigured installs.
  try {
    const url = process.env.LOG10X_PASTE_URL || 'https://meljpepqpd.execute-api.us-east-1.amazonaws.com/paste';
    const res = await fetch(url, { method: 'OPTIONS' });
    if (res.ok || res.status === 204 || res.status === 405) {
      checks.push({
        name: 'paste_endpoint',
        status: 'pass',
        message: 'Log10x paste endpoint reachable. log10x_resolve_batch will route through it by default.',
      });
    } else {
      checks.push({
        name: 'paste_endpoint',
        status: 'warn',
        message: `Paste endpoint returned HTTP ${res.status}. resolve_batch may fail.`,
      });
    }
  } catch (e) {
    checks.push({
      name: 'paste_endpoint',
      status: 'warn',
      message: `Paste endpoint unreachable: ${(e as Error).message}`,
      fix: 'If the network is locked down, allowlist the LOG10X_PASTE_URL host (default: meljpepqpd.execute-api.us-east-1.amazonaws.com). Or set privacy_mode=true on resolve_batch and install the local tenx CLI.',
    });
  }

  return finalize(checks);
}

function finalize(checks: DoctorCheck[]): DoctorReport {
  const overall: CheckStatus = checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'warn')
    ? 'warn'
    : 'pass';
  return { overall, checks };
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
  for (const c of report.checks) {
    const icon = c.status === 'pass' ? 'PASS' : c.status === 'warn' ? 'WARN' : 'FAIL';
    lines.push(`**[${icon}] ${c.name}**`);
    lines.push(`  ${c.message}`);
    if (c.fix) lines.push(`  Fix: ${c.fix}`);
    lines.push('');
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
