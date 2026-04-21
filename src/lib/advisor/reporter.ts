/**
 * Reporter install/verify/teardown plan builder.
 *
 * Given a DiscoverySnapshot + user args, produce an `AdvisePlan` that
 * covers the whole lifecycle for one forwarder kind. The plan is pure
 * data — rendering to markdown is the render layer's job.
 */

import type { DiscoverySnapshot, ForwarderKind } from '../discovery/types.js';
import type { AdvisePlan, PlanStep, VerifyProbe, PreflightCheck } from './types.js';
import { REPORTER_FORWARDER_SPECS, type OutputDestination, type ForwarderSpec } from './reporter-forwarders.js';
import { run } from '../discovery/shell.js';

export interface ReporterAdviseArgs {
  snapshot: DiscoverySnapshot;
  /** Forwarder to target. If omitted, uses the snapshot's recommendation. */
  forwarder?: ForwarderKind;
  /** Helm release name. Default: 'my-reporter'. */
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
  /** Skip install — for users who just want verify or teardown guidance. */
  skipInstall?: boolean;
  /** Skip teardown. */
  skipTeardown?: boolean;
  /** Skip verify. */
  skipVerify?: boolean;
}

/** Produce the plan. Never throws — surfaces missing input as `blockers`. */
export async function buildReporterPlan(args: ReporterAdviseArgs): Promise<AdvisePlan> {
  const snapshot = args.snapshot;
  const releaseName = args.releaseName ?? 'my-reporter';
  const destination: OutputDestination = args.destination ?? 'mock';
  const namespace =
    args.namespace ?? snapshot.recommendations.suggestedNamespace ?? 'logging';

  const forwarderCandidate =
    args.forwarder ?? snapshot.recommendations.existingForwarder ?? 'fluent-bit';
  const forwarder: ForwarderKind =
    forwarderCandidate === 'unknown' ? 'fluent-bit' : forwarderCandidate;

  const spec = REPORTER_FORWARDER_SPECS[forwarder as Exclude<ForwarderKind, 'unknown'>];

  const blockers: string[] = [];
  if (!spec) {
    blockers.push(
      `No forwarder template for kind '${forwarder}'. Pass forwarder ∈ ${Object.keys(REPORTER_FORWARDER_SPECS).join('|')}.`
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

  const preflight = await runPreflight(
    snapshot,
    forwarder,
    releaseName,
    namespace,
    spec
  );

  const notes: string[] = [];
  if (snapshot.recommendations.alreadyInstalled.reporter) {
    notes.push(
      `A Reporter is already installed in namespace \`${snapshot.recommendations.alreadyInstalled.reporter}\`. Installing a second release under a different name + namespace is safe but will duplicate metric emission unless the existing one is torn down first.`
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

  const install: PlanStep[] = [];
  const verify: VerifyProbe[] = [];
  const teardown: PlanStep[] = [];

  if (spec && !args.skipInstall && blockers.length === 0) {
    install.push(...buildInstallSteps({ ...args, spec, releaseName, namespace, destination }));
  }
  if (spec && !args.skipVerify) {
    verify.push(
      ...spec.verifyProbes({ releaseName, namespace, destination }).map((p) => ({
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
    app: 'reporter',
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
  spec: ForwarderSpec | undefined
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
  const existing = snapshot.recommendations.existingForwarder;
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
}): PlanStep[] {
  const { spec, releaseName, namespace, destination, outputHost, splunkHecToken } = opts;
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
      contents: spec.renderValues({ apiKey, releaseName, destination, outputHost, splunkHecToken }),
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
