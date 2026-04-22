/**
 * Reporter + Regulator install/verify/teardown plan builder.
 *
 * Given a DiscoverySnapshot + user args, produce an `AdvisePlan` that
 * covers the whole lifecycle for one forwarder kind. The plan is pure
 * data — rendering to markdown is the render layer's job.
 *
 * The same builder serves both apps: Reporter (kind=report, read-only
 * metric emission) and Regulator (kind=regulate, read + write back to
 * the forwarder with mute/sample/compact applied). They share every
 * forwarder spec, every chart, every preflight check. The single
 * differentiator is the `kind` value baked into the tenx values block,
 * which the chart templates route to different launch args.
 */

import type { DiscoverySnapshot, ForwarderKind } from '../discovery/types.js';
import type { AdvisePlan, PlanStep, VerifyProbe, PreflightCheck } from './types.js';
import {
  REPORTER_FORWARDER_SPECS,
  STANDALONE_SPEC,
  type OutputDestination,
  type ForwarderSpec,
  type TenxKind,
} from './reporter-forwarders.js';
import { run } from '../discovery/shell.js';

export type AdvisorApp = 'reporter' | 'regulator';

/**
 * Deployment shape — orthogonal to forwarder kind.
 *   inline     = replace the user's forwarder deployment with a
 *                log10x-repackaged version of the same chart (tenx baked
 *                in as a processor/filter/init-container).
 *   standalone = install log10x-k8s/reporter-10x as a parallel DaemonSet
 *                that bundles its own fluent-bit. Does NOT touch the
 *                user's forwarder. Report-mode only.
 * The user's detected forwarder kind is still surfaced in the plan when
 * shape='standalone' — as context, not as the install target.
 */
export type DeploymentShape = 'inline' | 'standalone';

export interface ReporterAdviseArgs {
  snapshot: DiscoverySnapshot;
  /** Which app this plan installs. Default: 'reporter'. */
  app?: AdvisorApp;
  /**
   * Deployment shape. Default: 'inline'. When 'standalone', the plan
   * installs reporter-10x alongside the user's forwarder instead of
   * replacing it — `forwarder` is kept in the plan as detected context
   * only and regulator/optimize combinations become blockers.
   */
  shape?: DeploymentShape;
  /** Forwarder to target. If omitted, uses the snapshot's recommendation. */
  forwarder?: ForwarderKind;
  /** Helm release name. Default: `my-${app}`. */
  releaseName?: string;
  /** Target namespace. Default: snapshot's suggestedNamespace. */
  namespace?: string;
  /** Log10x license key. Required for a complete install plan. */
  apiKey?: string;
  /** Output destination flavor. Default: 'mock' (safe for dogfooding). */
  destination?: OutputDestination;
  /** Host for non-mock destinations (ES endpoint, Splunk HEC host, etc.). */
  outputHost?: string;
  /** Splunk HEC token if destination=splunk. */
  splunkHecToken?: string;
  /**
   * Enable encoded event output (compact templateHash+vars form,
   * ~20-40x volume reduction). Only meaningful when app='regulator'.
   * Silently ignored otherwise. Verified working on fluent-bit@1.0.7 +
   * fluentd@1.0.7 via the `regulatorOptimize=true` env-var workaround
   * (the chart's `tenx.optimize: true` path is chart-broken — do NOT
   * use it directly). Unverified on filebeat/logstash/otel-collector.
   */
  optimize?: boolean;
  /** Skip install — for users who just want verify or teardown guidance. */
  skipInstall?: boolean;
  /** Skip teardown. */
  skipTeardown?: boolean;
  /** Skip verify. */
  skipVerify?: boolean;
}

const APP_TO_KIND: Record<AdvisorApp, TenxKind> = {
  reporter: 'report',
  regulator: 'regulate',
};

/** Produce the plan. Never throws — surfaces missing input as `blockers`. */
export async function buildReporterPlan(args: ReporterAdviseArgs): Promise<AdvisePlan> {
  const snapshot = args.snapshot;
  const app: AdvisorApp = args.app ?? 'reporter';
  const shape: DeploymentShape = args.shape ?? 'inline';
  const kind: TenxKind = APP_TO_KIND[app];
  const releaseName = args.releaseName ?? `my-${app}`;
  const destination: OutputDestination = args.destination ?? 'mock';
  const namespace =
    args.namespace ?? snapshot.recommendations.suggestedNamespace ?? 'logging';

  const forwarderCandidate =
    args.forwarder ?? snapshot.recommendations.existingForwarder ?? 'fluent-bit';
  const forwarder: ForwarderKind =
    forwarderCandidate === 'unknown' ? 'fluent-bit' : forwarderCandidate;

  // Spec selection splits on shape, not on forwarder kind. Standalone
  // always resolves to the reporter-10x spec regardless of what
  // forwarder was detected — the user's forwarder is kept as context
  // in the plan output but does not drive chart selection.
  const spec: ForwarderSpec | undefined =
    shape === 'standalone'
      ? STANDALONE_SPEC
      : REPORTER_FORWARDER_SPECS[forwarder as Exclude<ForwarderKind, 'unknown'>];

  const blockers: string[] = [];
  if (!spec) {
    blockers.push(
      `No forwarder template for kind '${forwarder}'. Pass forwarder ∈ ${Object.keys(REPORTER_FORWARDER_SPECS).join('|')}.`
    );
  }
  // Shape=standalone only supports reporter (report-only). The
  // reporter-10x chart has no hook into the user's forwarder output,
  // so it can't regulate/filter/compact events — only emit metrics.
  if (shape === 'standalone' && app === 'regulator') {
    blockers.push(
      'shape=standalone is only valid for app=reporter. The `log10x-k8s/reporter-10x` chart bundles its own fluent-bit + tenx-edge and reads container logs in parallel to your existing forwarder — it has no path to write regulated events back through that forwarder. Either switch to shape=inline (replaces your forwarder with a log10x-repackaged version) or app=reporter.'
    );
  }
  if (shape === 'standalone' && args.optimize) {
    blockers.push(
      'optimize=true requires shape=inline. Compact encoding rewrites events emitted back through the forwarder — standalone runs alongside your forwarder without touching its event path, so there are no events to encode. Drop `optimize` or switch to shape=inline.'
    );
  }
  // VERIFIED 2026-04-21: logstash chart sidecar wiring is ARCHITECTURALLY
  // broken regardless of chart version. tenx needs to be a child process
  // of logstash (spawned by the `pipe` output plugin), but the chart runs
  // tenx as an independent side container reading from its own stdin.
  // Pipeline inits, then shuts down after ~9s with no input. Chart 1.0.7
  // (shipped 2026-04-22) fixes the apps/edge path but does NOT fix the
  // stdin-wiring bug. Keep the blocker until the chart is refactored to
  // use the pipe-output plugin launch pattern.
  if (shape === 'inline' && spec && forwarder === 'logstash') {
    blockers.push(
      "The log10x-elastic/logstash chart is architecturally broken for sidecar mode: tenx needs to be a child process of logstash (spawned by the `pipe` output plugin), but the chart runs it as a separate container reading from its own stdin. Pipeline inits then shuts down after ~9s with no input. Chart 1.0.7 fixes the apps/ path but does NOT fix this wiring. Use fluent-bit, fluentd, filebeat, or otel-collector, OR deploy `log10x-k8s/reporter-10x` (non-invasive, parallel DaemonSet) alongside your existing logstash."
    );
  }
  if (!args.apiKey && !args.skipInstall) {
    blockers.push(
      'Log10x license key is required to produce an install plan. Pass `api_key` or set the snapshot-wide default and re-run. (Teardown and verify plans work without it.)'
    );
  }
  if (destination === 'splunk' && !args.splunkHecToken && !args.skipInstall) {
    blockers.push('destination=splunk requires `splunk_hec_token`.');
  }
  // optimize=true path, now unified across all charts at 1.0.7 — every
  // chart (fluent-bit, fluentd, filebeat, logstash, otel-collector) maps
  // kind=optimize to @apps/regulator + regulatorOptimize=true env var.
  // No per-forwarder blocker remains (logstash is blocked above for the
  // sidecar wiring bug, which applies regardless of optimize).
  if (shape === 'inline' && args.optimize && app === 'reporter') {
    blockers.push(
      'optimize=true is a Regulator-app feature (it encodes events emitted back through the forwarder). The Reporter app does not emit events back through the forwarder — it only publishes aggregated TenXSummary metrics. Drop `optimize` or switch to `app=regulator`.'
    );
  }

  const preflight = await runPreflight(
    snapshot,
    forwarder,
    releaseName,
    namespace,
    spec,
    shape
  );

  const notes: string[] = [];
  const appTitle = app === 'reporter' ? 'Reporter' : 'Regulator';
  if (snapshot.recommendations.alreadyInstalled[app]) {
    notes.push(
      `A ${appTitle} is already installed in namespace \`${snapshot.recommendations.alreadyInstalled[app]}\`. Installing a second release under a different name + namespace is safe but will duplicate ${app === 'reporter' ? 'metric emission' : 'regulation'} unless the existing one is torn down first.`
    );
  }
  if (spec?.chartAvailability === 'upstream-fallback') {
    notes.push(
      `The log10x-repackaged chart for **${spec.label}** is a work-in-progress. This plan installs upstream ${spec.label} + a hand-added Reporter sidecar via \`extraContainers\`. When the repackaged chart ships, switch to it.`
    );
  }
  if (destination === 'mock') {
    notes.push(
      'Destination is `mock` (events written to forwarder stdout). Ideal for dogfooding or smoke tests; switch to `elasticsearch`, `splunk`, `datadog`, or `cloudwatch` for production.'
    );
  }
  // Filebeat's tenx integration is hardcoded in the log10x/filebeat-10x
  // Dockerfile: `filebeat 2>&1 | tenx-edge run …`. The tenx subprocess
  // reads events from filebeat's stdout — which means `output.console`
  // in the user's filebeat.yml (or any output that writes to stdout)
  // corrupts the tenx input stream. This is NOT overridable at the
  // chart level. The mock destination the advisor ships uses
  // `output.file: /tmp/tenx-mock-*`, which is safe; any non-stdout
  // output (elasticsearch, splunk, logstash, kafka, etc.) is also safe.
  if (shape === 'inline' && forwarder === 'filebeat') {
    notes.push(
      "Filebeat constraint: **do not configure `output.console`** in `filebeat.yml`. Filebeat's tenx integration uses its stdout as the pipe to the 10x engine (baked into the `log10x/filebeat-10x` Dockerfile entrypoint: `filebeat 2>&1 | tenx-edge run …`). Any output that writes to stdout corrupts that pipe. Use `output.elasticsearch`, `output.file`, `output.logstash`, `output.kafka`, etc. — the mock destination used by this plan is `output.file` (safe by default)."
    );
  }
  // Surface the non-invasive alternative only when the plan is inline.
  // Once shape='standalone' is selected this IS the non-invasive path,
  // so re-recommending it would be noise.
  if (shape === 'inline' && app === 'reporter') {
    notes.push(
      'Alternative: the `log10x-k8s/reporter-10x@1.0.7` chart deploys a standalone non-invasive DaemonSet (fluent-bit + tenx-edge) that tails the same container logs your existing forwarder reads, without replacing it. Call `log10x_advise_reporter` with `shape: "standalone"` or use `log10x_advise_install` to compare paths. Recommended when you don\'t want the 10x logic running inside your production forwarder.'
    );
  }
  if (shape === 'standalone') {
    // Prefer the forwarder arg (what the caller is actually targeting /
    // what mode.ts picked) over the snapshot's existingForwarder field,
    // which may name a DIFFERENT workload than the one the plan is for
    // when the cluster runs multiple forwarder DaemonSets.
    const fwLabel = args.forwarder ?? snapshot.recommendations.existingForwarder ?? 'no forwarder';
    notes.push(
      `This plan installs **standalone** — \`log10x-k8s/reporter-10x\` runs as a parallel DaemonSet alongside your existing ${fwLabel} deployment. No changes to your forwarder; the chart bundles its own fluent-bit to tail /var/log/containers/*.log. Report-mode only (metrics). For regulation/filtering/compaction you'd install the \`log10x-fluent/*\` inline variant in place of your forwarder.`
    );
  }

  const install: PlanStep[] = [];
  const verify: VerifyProbe[] = [];
  const teardown: PlanStep[] = [];

  if (spec && !args.skipInstall && blockers.length === 0) {
    install.push(...buildInstallSteps({ ...args, spec, releaseName, namespace, destination, app, kind, optimize: args.optimize }));
  }
  if (spec && !args.skipVerify) {
    verify.push(
      ...spec.verifyProbes({ releaseName, namespace, destination, optimize: args.optimize }).map((p) => ({
        ...p,
      }))
    );
  }
  if (!args.skipTeardown) {
    // Use the forwarder's selector label so teardown actually matches
    // PVCs + residue on charts that use legacy Helm labels. Falls back
    // to the k8s-recommended selector when no spec (should never happen
    // once the forwarder is validated, but belt-and-braces).
    const selectorLabel = spec?.selectorLabel(releaseName) ?? `app.kubernetes.io/instance=${releaseName}`;
    teardown.push(...buildTeardownSteps(releaseName, namespace, selectorLabel));
  }

  return {
    app,
    snapshotId: snapshot.snapshotId,
    forwarder,
    releaseName,
    namespace,
    context: snapshot.kubectl.context,
    preflight,
    install,
    verify,
    teardown,
    notes,
    blockers,
  };
}

async function runPreflight(
  snapshot: DiscoverySnapshot,
  forwarder: ForwarderKind,
  releaseName: string,
  namespace: string,
  spec: ForwarderSpec | undefined,
  shape: DeploymentShape
): Promise<PreflightCheck[]> {
  const chartAvail = spec?.chartAvailability;
  const checks: PreflightCheck[] = [];

  // 1. Cluster reachable.
  checks.push({
    name: 'kubectl',
    status: snapshot.kubectl.available ? 'ok' : 'fail',
    detail: snapshot.kubectl.available
      ? `context \`${snapshot.kubectl.context}\``
      : snapshot.kubectl.error ?? 'unknown failure',
  });

  // 2. Namespace exists (or will be created).
  const nsExists = snapshot.kubectl.namespaces.includes(namespace);
  checks.push({
    name: 'namespace',
    status: nsExists ? 'ok' : 'warn',
    detail: nsExists
      ? `\`${namespace}\` exists`
      : `\`${namespace}\` does not exist — the install step will create it`,
  });

  // 3. Existing forwarder alignment.
  // Standalone runs ALONGSIDE the user's forwarder by design — any
  // detected forwarder is fine (even a mismatch), no forwarder is fine
  // too (reporter-10x brings its own fluent-bit). Only inline plans
  // care about alignment.
  const existing = snapshot.recommendations.existingForwarder;
  if (shape === 'standalone') {
    checks.push({
      name: 'forwarder alignment',
      status: 'ok',
      detail: existing
        ? `detected \`${existing}\` — reporter-10x runs in parallel, no conflict`
        : 'no existing forwarder detected — reporter-10x bundles its own fluent-bit',
    });
  } else {
    checks.push({
      name: 'forwarder alignment',
      status:
        existing === forwarder ? 'ok' : existing ? 'warn' : 'warn',
      detail: existing
        ? existing === forwarder
          ? `detected \`${existing}\` matches the target`
          : `detected \`${existing}\` in the cluster; this plan targets \`${forwarder}\` — safe to co-exist in different namespaces, but confirm that's what you want`
        : 'no existing forwarder detected; the plan installs one from scratch',
    });
  }

  // 4. Release-name collision check.
  const releaseCollision = snapshot.kubectl.helmReleases.some(
    (h) => h.name === releaseName && h.namespace === namespace
  );
  checks.push({
    name: 'release collision',
    status: releaseCollision ? 'fail' : 'ok',
    detail: releaseCollision
      ? `a Helm release named \`${releaseName}\` already exists in \`${namespace}\` — pick a different release_name or uninstall the existing one first`
      : `no \`${releaseName}\` release in \`${namespace}\` — clear to install`,
  });

  // 5. Chart availability — LIVE probe via `helm search repo`.
  // The prior static flag claimed `published: ok` for chart refs that
  // didn't exist (e.g., `filebeat-10x` when the real name is `filebeat`).
  // We now add the repo and search for the chart; the check only
  // passes if helm returns a matching entry.
  if (spec) {
    const liveCheck = await probeChartAvailability(spec);
    checks.push(liveCheck);
  } else {
    checks.push({
      name: 'chart availability',
      status: 'unknown',
      detail: 'no spec for this forwarder',
    });
  }

  // 6. API key hint.
  checks.push({
    name: 'license key',
    status: 'unknown',
    detail:
      'bring your own log10x license key via the `api_key` argument. The plan fails closed without it.',
  });

  return checks;
}

/**
 * Live chart availability probe. Adds the repo (idempotent), runs
 * `helm search repo <chartRef>`, and returns an `ok` status iff a
 * matching entry is found. The step exists BECAUSE the first dogfood
 * pass shipped chart refs that looked real but didn't resolve
 * (filebeat-10x vs filebeat, logstash-10x vs logstash,
 * otel-collector-10x vs opentelemetry-collector). Every chart-ref
 * drift now fails preflight instead of helm-install.
 */
async function probeChartAvailability(spec: ForwarderSpec): Promise<PreflightCheck> {
  try {
    await run('helm', ['repo', 'add', spec.helmRepoAlias, spec.helmRepo, '--force-update'], {
      timeoutMs: 10_000,
    });
    await run('helm', ['repo', 'update', spec.helmRepoAlias], { timeoutMs: 10_000 });
    const search = await run('helm', ['search', 'repo', spec.chartRef, '-o', 'json'], {
      timeoutMs: 10_000,
    });
    if (search.exitCode !== 0) {
      return {
        name: 'chart availability',
        status: 'warn',
        detail: `\`helm search repo ${spec.chartRef}\` failed (exit ${search.exitCode}): ${search.stderr.slice(0, 200)}`,
      };
    }
    let parsed: Array<{ name: string; version: string; app_version: string }> = [];
    try {
      parsed = JSON.parse(search.stdout || '[]');
    } catch {
      parsed = [];
    }
    if (parsed.length === 0) {
      return {
        name: 'chart availability',
        status: 'fail',
        detail: `\`${spec.chartRef}\` returned 0 results from \`helm search repo\` — chart ref is wrong or the repo is offline`,
      };
    }
    const hit = parsed[0];
    return {
      name: 'chart availability',
      status: 'ok',
      detail: `\`${hit.name}\` v${hit.version} (app ${hit.app_version}) is live in repo \`${spec.helmRepoAlias}\``,
    };
  } catch (e) {
    return {
      name: 'chart availability',
      status: 'unknown',
      detail: `helm CLI not available or probe errored: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function buildInstallSteps(opts: {
  spec: NonNullable<(typeof REPORTER_FORWARDER_SPECS)[keyof typeof REPORTER_FORWARDER_SPECS]>;
  releaseName: string;
  namespace: string;
  apiKey?: string;
  destination: OutputDestination;
  outputHost?: string;
  splunkHecToken?: string;
  app: AdvisorApp;
  kind: TenxKind;
  optimize?: boolean;
}): PlanStep[] {
  const { spec, releaseName, namespace, destination, outputHost, splunkHecToken, kind, optimize } = opts;
  const apiKey = opts.apiKey ?? 'REPLACE_WITH_LICENSE_KEY';
  const steps: PlanStep[] = [];

  steps.push({
    title: `Add ${spec.label} Helm repo`,
    rationale: `Makes the ${spec.chartRef} chart available to \`helm install\`.`,
    commands: [
      `helm repo add ${spec.helmRepoAlias} ${spec.helmRepo}`,
      `helm repo update`,
      `helm search repo ${spec.chartRef}`,
    ],
  });

  steps.push({
    title: 'Create target namespace',
    rationale: `The Reporter installs into \`${namespace}\`. \`--create-namespace\` on helm install will also do this, but a separate step makes retries idempotent.`,
    commands: [`kubectl create namespace ${namespace} --dry-run=client -o yaml | kubectl apply -f -`],
  });

  const valuesFile = `${releaseName}-values.yaml`;
  steps.push({
    title: 'Write Helm values',
    rationale: `Tenx config + ${spec.label}-specific output destination (\`${destination}\`).`,
    file: {
      path: valuesFile,
      contents: spec.renderValues({ apiKey, releaseName, destination, kind, outputHost, splunkHecToken, optimize }),
      language: 'yaml',
    },
    commands: [],
  });

  steps.push({
    title: 'Install via Helm',
    rationale: `Deploys the ${spec.label} chart with the 10x Reporter sidecar enabled.`,
    commands: [
      `helm upgrade --install ${releaseName} ${spec.chartRef} \\\n  -n ${namespace} --create-namespace \\\n  -f ${valuesFile}`,
    ],
  });

  steps.push({
    title: 'Wait for rollout',
    rationale:
      'Blocks until the workload reports Ready. Uses the chart\'s own label selector (legacy Helm for elastic charts, k8s-recommended elsewhere) — a mismatched selector silently returns "No resources found" and exits 0.',
    commands: [
      `kubectl -n ${namespace} rollout status daemonset -l ${spec.selectorLabel(releaseName)} --timeout=5m || true`,
      `kubectl -n ${namespace} rollout status deployment -l ${spec.selectorLabel(releaseName)} --timeout=5m || true`,
      `kubectl -n ${namespace} rollout status statefulset -l ${spec.selectorLabel(releaseName)} --timeout=10m || true`,
    ],
    expectDurationSec: 600,
  });

  return steps;
}

function buildTeardownSteps(
  releaseName: string,
  namespace: string,
  selectorLabel: string
): PlanStep[] {
  return [
    {
      title: 'Uninstall the Helm release',
      rationale: 'Removes the forwarder DaemonSet/Deployment/StatefulSet, its ServiceAccount, ConfigMaps, and the 10x Reporter sidecar.',
      commands: [`helm -n ${namespace} uninstall ${releaseName}`],
    },
    {
      title: 'Clean up derived resources',
      rationale:
        'Helm does not reap PVCs or Secrets that were created outside of the release. Selector honors the chart family\'s label convention (k8s-recommended vs legacy Helm).',
      commands: [
        `kubectl -n ${namespace} delete pvc -l ${selectorLabel} --ignore-not-found`,
        `kubectl -n ${namespace} delete secret reporter-credentials --ignore-not-found`,
      ],
    },
    {
      title: 'Verify nothing remains',
      rationale: 'Confirm no pods, services, or configmaps are lingering under the release label.',
      commands: [
        `kubectl -n ${namespace} get all,configmap,secret,pvc -l ${selectorLabel}`,
      ],
    },
  ];
}
