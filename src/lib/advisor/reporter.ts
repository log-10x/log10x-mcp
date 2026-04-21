/**
 * Reporter install/verify/teardown plan builder.
 *
 * Given a DiscoverySnapshot + user args, produce an `AdvisePlan` that
 * covers the whole lifecycle for one forwarder kind. The plan is pure
 * data — rendering to markdown is the render layer's job.
 */

import type { DiscoverySnapshot, ForwarderKind } from '../discovery/types.js';
import type { AdvisePlan, PlanStep, VerifyProbe, PreflightCheck } from './types.js';
import { REPORTER_FORWARDER_SPECS, type OutputDestination } from './reporter-forwarders.js';

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
export function buildReporterPlan(args: ReporterAdviseArgs): AdvisePlan {
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

  const preflight = runPreflight(snapshot, forwarder, releaseName, namespace, spec?.chartAvailability);

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
    teardown.push(...buildTeardownSteps(releaseName, namespace));
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

function runPreflight(
  snapshot: DiscoverySnapshot,
  forwarder: ForwarderKind,
  releaseName: string,
  namespace: string,
  chartAvail: 'published' | 'wip' | 'upstream-fallback' | undefined
): PreflightCheck[] {
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

  // 5. Chart availability.
  checks.push({
    name: 'chart availability',
    status: chartAvail === 'published' ? 'ok' : chartAvail === 'upstream-fallback' ? 'warn' : 'unknown',
    detail:
      chartAvail === 'published'
        ? 'log10x-repackaged chart is published'
        : chartAvail === 'upstream-fallback'
        ? 'log10x-repackaged chart not yet published; plan uses upstream chart + sidecar pattern'
        : 'unknown',
  });

  // 6. API key hint.
  checks.push({
    name: 'license key',
    status: 'unknown',
    detail:
      'bring your own log10x license key via the `api_key` argument. The plan fails closed without it.',
  });

  return checks;
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
    rationale: 'Blocks until the DaemonSet/Deployment reports Ready. Required before verify probes.',
    commands: [
      `kubectl -n ${namespace} rollout status daemonset -l app.kubernetes.io/instance=${releaseName} --timeout=5m || true`,
      `kubectl -n ${namespace} rollout status deployment -l app.kubernetes.io/instance=${releaseName} --timeout=5m || true`,
      `kubectl -n ${namespace} rollout status statefulset -l app.kubernetes.io/instance=${releaseName} --timeout=10m || true`,
    ],
    expectDurationSec: 600,
  });

  return steps;
}

function buildTeardownSteps(releaseName: string, namespace: string): PlanStep[] {
  return [
    {
      title: 'Uninstall the Helm release',
      rationale: 'Removes the forwarder DaemonSet/Deployment, its ServiceAccount, ConfigMaps, and the 10x Reporter sidecar.',
      commands: [`helm -n ${namespace} uninstall ${releaseName}`],
    },
    {
      title: 'Clean up derived resources',
      rationale: 'Helm does not reap PVCs or Secrets that were created outside of the release.',
      commands: [
        `kubectl -n ${namespace} delete pvc -l app.kubernetes.io/instance=${releaseName} --ignore-not-found`,
        `kubectl -n ${namespace} delete secret reporter-credentials --ignore-not-found`,
      ],
    },
    {
      title: 'Verify nothing remains',
      rationale: 'Confirm no pods, services, or configmaps are lingering under the release label.',
      commands: [
        `kubectl -n ${namespace} get all,configmap,secret,pvc -l app.kubernetes.io/instance=${releaseName}`,
      ],
    },
  ];
}
