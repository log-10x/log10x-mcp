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
import { fmtBytes as formatBytes } from '../lib/format.js';

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
        'Storage Streamer not reachable from this MCP install. Two possibilities: ' +
        '(a) Streamer is deployed but LOG10X_STREAMER_URL / LOG10X_STREAMER_BUCKET env vars are unset, ' +
        '(b) Streamer is not deployed for this customer at all. ' +
        'Either way, log10x_streamer_query and log10x_backfill_metric cannot retrieve raw events from the S3 archive in this session. ' +
        'For events inside SIEM hot retention (typically <7d), the fastest workaround is direct SIEM query — do not block on streamer setup.',
      fix: 'If the Streamer is deployed: set LOG10X_STREAMER_URL to the query handler URL (e.g., the NLB) and LOG10X_STREAMER_BUCKET to the archive bucket, then restart the MCP client. If not deployed: https://doc.log10x.com/apps/cloud/streamer/',
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
            fix: 'Call log10x_top_patterns(limit=1) to see which pattern. Then log10x_investigate on it to check whether it is an incident or noise. If it is noise, log10x_dependency_check + log10x_exclusion_filter to cut cost safely.',
          });
        } else if (top5Ratio > 0.7) {
          checks.push({
            name: 'cardinality_concentration',
            status: 'warn',
            message: `The top 5 patterns are ${Math.round(top5Ratio * 100)}% of your 30-day log spend. Your logging cost is concentrated; investigating or filtering the top few has outsized impact.`,
            fix: 'Call log10x_top_patterns(limit=5) and log10x_cost_drivers to identify which of the top 5 are growing vs stable. Stable-and-high is a filter candidate; growing-and-high is an investigation candidate.',
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

  // G9 mitigation: detect "a service's volume dropped to zero recently vs
  // steady-state". This is the signature of the tenx-edge subprocess stale
  // state bug caught 2026-04-15 — after a prolonged remote-write rejection
  // (G8, now fixed), tenx-edge child processes accumulated poisoned write
  // state that the exec_filter retry loop did not clear, so metrics stayed
  // at zero even after the Lambda fix was deployed. Resolved by a fluentd
  // DaemonSet rollout restart. We can't run kubectl to check for OOO errors,
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

  // G12 mitigation: detect streamer false-negatives. We cannot run a real
  // streamer query here without side effects, but we CAN check whether the
  // streamer endpoint is configured AND whether the paste endpoint's
  // health probe reports streamer index coverage for recent windows.
  // Shipping as a placeholder that reminds the user the streamer is
  // operationally uncertain until the engine-side false-negative and
  // canonical-name-crash bugs (G12) are fixed.
  if (detectedTier && process.env.LOG10X_STREAMER_URL) {
    checks.push({
      name: 'streamer_forensic_health',
      status: 'warn',
      message:
        'Streamer endpoint is configured, but forensic retrieval has a known engine-side false-negative issue: log10x_streamer_query may return 0 events on windows where log10x_pattern_trend proves events exist, and it may crash with "MCP error -32000: Connection closed" when passed a canonical slash-underscore pattern name. Tracked as GAPS G12.',
      fix:
        'Until the engine-side fix lands: (1) use short pattern names or free-text search strings rather than canonical pattern identities when calling log10x_streamer_query, (2) cross-check any zero-event result against log10x_pattern_trend on the same pattern+window before concluding the archive is empty, (3) prefer log10x_event_lookup + log10x_pattern_trend for any incident reconstruction where approximate timing is acceptable.',
    });
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
