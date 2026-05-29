/**
 * Reporter + Receiver install/verify/teardown plan builder.
 *
 * Given a DiscoverySnapshot + user args, produce an `AdvisePlan` that
 * covers the whole lifecycle for one forwarder kind. The plan is pure
 * data — rendering to markdown is the render layer's job.
 *
 * The same builder serves both apps. The current chart format unifies
 * around a single Receiver workload with two opt-in feature flags:
 *   - `optimize` — losslessly compact events (~20-40x volume reduction).
 *   - `readOnly` — emit metrics, do NOT write events back through the
 *     forwarder (passive observation).
 * The flags are mutually exclusive at the chart level. AdvisorApp keeps
 * a thin distinction at the user-facing surface: `reporter` is sugar
 * for "Receiver with readOnly=true" (different release-name default,
 * different verify wording, blocks optimize since there are no
 * write-back events to encode); `receiver` exposes the flags directly.
 */

import type {
  DiscoverySnapshot,
  ForwarderKind,
  MetricsBackendKind,
  BackendCredentialConfig,
} from '../discovery/types.js';
import type { AdvisePlan, PlanStep, VerifyProbe, PreflightCheck, GitopsExplainer } from './types.js';
import {
  RECEIVER_FORWARDER_SPECS,
  STANDALONE_SPEC,
  type OutputDestination,
  type ForwarderSpec,
} from './reporter-forwarders.js';

export type AdvisorApp = 'reporter' | 'receiver';

/**
 * Deployment shape — orthogonal to forwarder kind.
 *   inline     = replace the user's forwarder deployment with a
 *                log10x-repackaged version of the same chart (tenx baked
 *                in as a processor/filter/init-container).
 *   standalone = install log10x/reporter-10x as a parallel DaemonSet
 *                that bundles its own fluent-bit. Does NOT touch the
 *                user's forwarder. Report-mode only.
 * The user's detected forwarder kind is still surfaced in the plan when
 * shape='standalone' — as context, not as the install target.
 */
export type DeploymentShape = 'inline' | 'standalone';

export interface ReporterAdviseArgs {
  snapshot: DiscoverySnapshot;
  /**
   * Which app this plan installs. Default: 'reporter'.
   * - 'reporter' → standalone dedicated fluent-bit DaemonSet, read-only
   * - 'receiver' → sidecar inside the user's existing forwarder
   * Deployment shape is derived from app; no `shape` arg.
   */
  app?: AdvisorApp;
  /** Forwarder to target. If omitted, uses the snapshot's recommendation. */
  forwarder?: ForwarderKind;
  /** Helm release name. Default: `my-${app}`. */
  releaseName?: string;
  /** Target namespace. Default: snapshot's suggestedNamespace. */
  namespace?: string;
  /**
   * Log10x license JWT — mints from `POST /api/v1/license/demo` (anonymous)
   * or `POST /api/v1/license` (Auth0-authed). Maps to the chart's
   * `log10xLicenseJwt` value. Required for a complete install plan.
   */
  licenseJwt?: string;
  /**
   * True when the JWT came from the demo endpoint. Drives the secret-vs-inline
   * decision in the chart values renderer: demo licenses inline the JWT
   * (one-step setup, transient); real licenses point the chart at an
   * out-of-band Kubernetes Secret the user creates before `helm upgrade`.
   */
  isDemoLicense?: boolean;
  /** Output destination flavor. Default: 'mock' (safe for dogfooding). */
  destination?: OutputDestination;
  /** Host for non-mock destinations (ES endpoint, Splunk HEC host, etc.). */
  outputHost?: string;
  /** Splunk HEC token if destination=splunk. */
  splunkHecToken?: string;
  /**
   * Enable encoded event output (compact templateHash+vars form,
   * ~20-40x volume reduction). Only meaningful when app='receiver';
   * blocks when app='reporter' (Reporter has no write-back path to
   * encode events on). Maps to `tenx.optimize: true` in every
   * supported chart's values.yaml.
   */
  optimize?: boolean;
  /**
   * Read-only mode (Receiver app only). When true, the receiver
   * publishes TenXSummary metrics but does NOT write events back
   * through the forwarder. Maps to `tenx.readOnly: true` in every
   * supported chart's values.yaml. Silently ignored when app='reporter'
   * — that app sets readOnly implicitly (Reporter IS read-only by
   * definition).
   */
  readOnly?: boolean;
  /**
   * Metrics backends the engine emits TenXSummary to. Multi-destination
   * — a user can report to log10x SaaS AND their own Datadog/Prom/etc.
   * simultaneously. Each entry maps to a `@run/output/metric/<backend>`
   * CLI arg appended to the engine's launch args, plus any vendor-
   * specific env vars (DD_API_KEY for datadog, ELASTIC_HOST for elastic,
   * etc.). Default: `['log10x']`. When `airgapped=true`, `'log10x'`
   * MUST NOT be in this list (engine sends nothing to log10x.com).
   */
  backends?: MetricsBackendKind[];
  /**
   * Per-backend credential configuration the wizard collected: secret
   * name + plain-value overrides. The renderer threads this into the
   * `tenx.extraEnv` block as `valueFrom.secretKeyRef` references.
   * When unset for a selected backend, the renderer falls back to
   * `<backend>-credentials` for the secret name and per-backend defaults
   * for plain values.
   */
  backendCredentials?: Partial<Record<MetricsBackendKind, BackendCredentialConfig>>;
  /**
   * Run the engine fully airgapped — no outbound calls to log10x.com
   * (no telemetry, no online license check, no update probes). Engine
   * emits only to the user-configured `backend`. Reporter chart maps
   * this to top-level `airgapped: true`; Receiver wires it via the
   * `TENX_AIRGAPPED=true` env var on the engine sidecar.
   *
   * Hard product constraint surfaced at plan-render time, NOT blocked:
   * demo / limited licenses cannot actually run airgapped — the engine
   * logs a warning and downgrades to online mode. The wizard surfaces
   * this softly and lets the user proceed without airgapped if they
   * decline to sign in.
   */
  airgapped?: boolean;
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
  const app: AdvisorApp = args.app ?? 'reporter';
  // Deployment shape is determined by app, not user choice:
  //   - reporter → standalone dedicated fluent-bit DaemonSet (zero-touch,
  //     production intent)
  //   - receiver → inline sidecar inside the user's existing forwarder
  // The `shape` arg is no longer accepted; it's derived. Keeping it as a
  // local for downstream code that reads it.
  const shape: DeploymentShape = app === 'reporter' ? 'standalone' : 'inline';
  const effectiveReadOnly = app === 'reporter' ? true : (args.readOnly ?? false);
  const effectiveOptimize = args.optimize ?? false;
  const destination: OutputDestination = args.destination ?? 'mock';

  const forwarderCandidate =
    args.forwarder ?? snapshot.recommendations.existingForwarder ?? 'fluentbit';
  const forwarder: ForwarderKind =
    forwarderCandidate === 'unknown' ? 'fluentbit' : forwarderCandidate;

  // For app=receiver, the WHOLE POINT is to inject the log10x sidecar
  // into the user's existing forwarder Helm release — NOT to deploy a
  // second copy. Default the release name to the detected release and
  // emit `helm upgrade --reuse-values <existing-release>` so the user's
  // existing chart values stay intact; our overlay layers on top.
  //
  // Reporter (standalone) keeps the old "fresh release" behavior — it's
  // a parallel DaemonSet that runs alongside the user's forwarder, not
  // into it.
  const detectedExisting: { releaseName: string; namespace: string } | undefined =
    app === 'receiver'
      ? detectExistingHelmRelease(snapshot, forwarder)
      : undefined;
  const installMode: 'upgrade-existing' | 'fresh-release' =
    detectedExisting && !args.releaseName ? 'upgrade-existing' : 'fresh-release';
  const releaseName =
    args.releaseName ?? detectedExisting?.releaseName ?? `my-${app}`;
  // When upgrading the existing release in-place, the namespace must
  // match the existing one — overrides the suggestedNamespace fallback.
  const namespace =
    installMode === 'upgrade-existing' && detectedExisting
      ? detectedExisting.namespace
      : args.namespace ?? snapshot.recommendations.suggestedNamespace ?? 'logging';

  // Reporter → STANDALONE_SPEC (always). Receiver → per-forwarder spec.
  const spec: ForwarderSpec | undefined =
    app === 'reporter'
      ? STANDALONE_SPEC
      : RECEIVER_FORWARDER_SPECS[forwarder as Exclude<ForwarderKind, 'unknown'>];

  const blockers: string[] = [];
  if (!spec) {
    blockers.push(
      `No forwarder template for kind '${forwarder}'. Pass forwarder ∈ ${Object.keys(RECEIVER_FORWARDER_SPECS).join('|')}.`
    );
  }
  if (app === 'reporter' && args.optimize) {
    blockers.push(
      'optimize=true is a Receiver-app feature (it encodes events emitted back through the forwarder). The Reporter app is standalone read-only — it only publishes aggregated TenXSummary metrics. Drop `optimize` or switch to `app=receiver`.'
    );
  }
  if (app === 'reporter' && args.readOnly) {
    blockers.push(
      'mode=readonly is a Receiver-app concept. The Reporter app is read-only by definition. Drop `mode` or switch to `app=receiver`.'
    );
  }
  if (args.optimize && args.readOnly) {
    blockers.push(
      'optimize=true is a no-op when mode=readonly. Compact encoding only matters when events are written back through the forwarder; in read-only mode the receiver emits metrics only. Pick one: optimize=true OR mode=readonly.'
    );
  }
  // logstash receiver path is now supported via the upstream
  // elastic/logstash chart + sidecar overlay (extraContainers as a
  // pipe-string, secretMounts for the license, logstashConfig +
  // logstashPipeline for the two-pipeline driver). The old log10x-elastic
  // chart that ran tenx as a stdin-fed container was the broken path;
  // it's gone. No blocker.

  // fluentd receiver path is now supported via the upstream fluent/fluentd
  // chart + a kustomize post-renderer overlay (the upstream chart has no
  // extraContainers hook, so the sidecar is patched onto the rendered
  // Deployment via Strategic Merge Patch). The wizard emits values.yaml
  // + tenx-kustomize/{kustomization,sidecar-patch,post-render.sh,
  // post-render.cmd} via the per-step `files[]` model and tells `helm
  // upgrade` to use `--post-renderer ./tenx-kustomize/post-render.sh`.
  // No blocker.
  if (!args.licenseJwt && !args.skipInstall) {
    blockers.push(
      'Log10x license JWT is required to produce an install plan. Pass `license_jwt` (fetch one from `POST /api/v1/license/demo` for anonymous demo, or `POST /api/v1/license` with an Auth0 access token for a user-scoped one). Teardown and verify plans work without it.'
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
    spec,
    app,
    installMode
  );

  const notes: string[] = [];
  const appTitle = app === 'reporter' ? 'Reporter' : 'Receiver';
  if (snapshot.recommendations.alreadyInstalled[app]) {
    notes.push(
      `A ${appTitle} is already installed in namespace \`${snapshot.recommendations.alreadyInstalled[app]}\`. Installing a second release under a different name + namespace is safe but will duplicate ${app === 'reporter' ? 'metric emission' : 'event filtering'} unless the existing one is torn down first.`
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
  if (app === 'receiver' && forwarder === 'filebeat') {
    notes.push(
      "Filebeat constraint: **do not configure `output.console`** in `filebeat.yml`. Filebeat's tenx integration uses its stdout as the pipe to the 10x engine (baked into the `log10x/filebeat-10x` Dockerfile entrypoint: `filebeat 2>&1 | tenx-edge run …`). Any output that writes to stdout corrupts that pipe. Use `output.elasticsearch`, `output.file`, `output.logstash`, `output.kafka`, etc. — the mock destination used by this plan is `output.file` (safe by default)."
    );
  }
  if (app === 'reporter') {
    // Prefer the forwarder arg (what the caller is actually targeting /
    // what mode.ts picked) over the snapshot's existingForwarder field,
    // which may name a DIFFERENT workload than the one the plan is for
    // when the cluster runs multiple forwarder DaemonSets.
    const fwLabel = args.forwarder ?? snapshot.recommendations.existingForwarder ?? 'no forwarder';
    notes.push(
      `This is the **standalone Reporter** install — a dedicated fluent-bit DaemonSet (\`log10x/reporter-10x\`) running alongside your existing ${fwLabel}. Zero touch to your forwarder; the chart bundles its own fluent-bit to tail /var/log/containers/*.log. Read-only — metrics only. For filtering/compaction install the Receiver as a sidecar in your existing forwarder.`
    );
  }

  const install: PlanStep[] = [];
  const verify: VerifyProbe[] = [];
  const teardown: PlanStep[] = [];

  if (spec && !args.skipInstall && blockers.length === 0) {
    install.push(...buildInstallSteps({ ...args, spec, releaseName, namespace, destination, app, optimize: effectiveOptimize, readOnly: effectiveReadOnly, installMode }));
  }
  // When the wizard is upgrading the user's existing forwarder release
  // (the canonical Receiver path), surface a note so the agent flags
  // "this is upgrading <release>, not creating a new one" to the user.
  // Important guardrail against the prior bug where the wizard deployed
  // a second forwarder alongside the user's existing one.
  if (installMode === 'upgrade-existing' && detectedExisting) {
    notes.push(
      `This plan UPGRADES your existing Helm release \`${detectedExisting.releaseName}\` in \`${detectedExisting.namespace}\` to inject the log10x sidecar. Your existing chart values are preserved via \`--reuse-values\`; the overlay layers on top. The wizard does NOT deploy a second ${forwarder}.`
    );
  }
  if (spec && !args.skipVerify) {
    verify.push(
      ...spec.verifyProbes({ releaseName, namespace, destination, optimize: effectiveOptimize, readOnly: effectiveReadOnly }).map((p) => ({
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

  // Derive the typed licenseKind from the inputs we know. Surfaces on
  // AdvisePlanSummary.license_kind so agents don't grep `notes` for
  // "demo license".
  //
  //   - no licenseJwt at all                       → 'placeholder'
  //     (skipInstall mode, or fetch failed and the plan emitted the
  //     REPLACE_WITH_LICENSE_JWT default)
  //   - isDemoLicense === true                     → 'demo'
  //   - isDemoLicense === false                    → 'user-scoped'
  //     (the wizard sets this explicitly when acquireLicenseForWizard
  //     returned a `signed-in-user` / `refreshed-then-user` reason)
  //   - isDemoLicense undefined + licenseJwt set   → 'user-pasted'
  //     (caller supplied a JWT but didn't tell us its kind; treat as
  //     opaque)
  const licenseKind: AdvisePlan['licenseKind'] = !args.licenseJwt
    ? 'placeholder'
    : args.isDemoLicense === true
      ? 'demo'
      : args.isDemoLicense === false
        ? 'user-scoped'
        : 'user-pasted';

  return {
    app,
    snapshotId: snapshot.snapshotId,
    forwarder,
    releaseName,
    namespace,
    context: snapshot.kubectl.context,
    licenseKind,
    installMode,
    existingHelmRelease:
      installMode === 'upgrade-existing' && detectedExisting
        ? { name: detectedExisting.releaseName, namespace: detectedExisting.namespace }
        : undefined,
    preflight,
    install,
    verify,
    teardown,
    notes,
    blockers,
    gitopsExplainer:
      app === 'receiver' && blockers.length === 0
        ? buildCompactReceiverGitopsExplainer({ optimize: args.optimize === true })
        : undefined,
  };
}

/**
 * GitOps section explaining MCP-managed compactReceiver updates.
 *
 * The receiver's compact decision can be:
 *   - global ON via the chart's `optimize` feature flag (compact every
 *     event — `tenx.optimize: true` in any supported chart's values.yaml), or
 *   - per-pattern via the compactReceiver module (CSV lookup + JS predicate),
 *     which is what this section is for.
 *
 * When `optimize=true`, MCP-managed per-pattern decisions are still useful
 * (to OPT OUT specific audit/compliance patterns), but the customer can
 * also skip GitOps entirely. We surface that trade-off in `whenToSkip`.
 */
/**
 * Find the user's existing Helm release for a given forwarder kind in
 * the snapshot. Used by the Receiver path to default `releaseName` to
 * the existing release name (so `helm upgrade` targets the user's real
 * forwarder pod instead of deploying a second copy alongside it).
 *
 * Detection priority:
 *   1. Match a `DetectedForwarder` of the chosen kind. Read the helm
 *      release from its labels:
 *        - `app.kubernetes.io/instance` (k8s-recommended, post-3.0)
 *        - `release` (legacy Helm pre-3.0; still emitted by elastic
 *          charts)
 *   2. Cross-check the candidate against `snapshot.kubectl.helmReleases`
 *      in the same namespace. If no matching release object is found,
 *      treat as "detected workload but not helm-managed" and return
 *      undefined — `helm upgrade --reuse-values` would fail with a
 *      no-release error, so we fall back to a fresh release.
 *
 * Returns the release name + namespace, or undefined when no existing
 * helm-managed release matches.
 */
function detectExistingHelmRelease(
  snapshot: DiscoverySnapshot,
  forwarder: ForwarderKind
): { releaseName: string; namespace: string } | undefined {
  if (forwarder === 'unknown') return undefined;
  const matches = snapshot.kubectl.forwarders.filter((f) => f.kind === forwarder);
  for (const m of matches) {
    const releaseFromLabels =
      m.labels['app.kubernetes.io/instance'] ?? m.labels['release'];
    if (!releaseFromLabels) continue;
    const helmRelease = snapshot.kubectl.helmReleases.find(
      (h) => h.name === releaseFromLabels && h.namespace === m.namespace
    );
    if (helmRelease) {
      return { releaseName: helmRelease.name, namespace: helmRelease.namespace };
    }
  }
  return undefined;
}

function buildCompactReceiverGitopsExplainer(opts: { optimize: boolean }): GitopsExplainer {
  return {
    headline:
      'The compactReceiver decides per-event whether to emit `encode()` (compact, ~20-40x smaller) or `fullText`. The decision is per-container: a CSV keyed by k8s_container name lists which containers to compact. Wire GitOps once and the MCP can author per-container PRs (`log10x_configure_compact`) — the engine hot-reloads the CSV without a pod restart.',
    whenToEnable: [
      'You want **selective** compaction — compact specific containers/services but preserve others (audit, compliance, debug).',
      'You want decisions to evolve over time without redeploying the receiver.',
      'You want the MCP to manage the cap-file via PRs (review-able, reversible).',
    ],
    whenToSkip: [
      opts.optimize
        ? 'The chart `optimize` feature flag is already set on this plan, which compacts every event. Add GitOps only if you need to opt SPECIFIC containers OUT of compaction (audit/compliance).'
        : 'You will turn on the chart `optimize` feature flag later to compact every event uniformly — no per-container decisions needed.',
      'You will not be using the receiver app at all (this section is receiver-only).',
    ],
    repoLayout: [
      { path: 'pipelines/run/receive/compact/compact-cap.csv', comment: 'MCP edits this — per-container CSV; in-place writes hot-reload (no restart)' },
      { path: 'pipelines/run/receive/compact/compact-object-cap.js', comment: 'predicate logic — JS change → pipeline restart (rarely needed; CSV covers most cases)' },
    ],
    envVars: [
      { name: 'GH_ENABLED', value: 'true', required: true, note: 'master switch for the GitHub puller' },
      { name: 'GH_REPO', value: 'your-org/your-config-repo', required: true, note: 'owner/name of the GitOps config repo (forked from log-10x/config recommended)' },
      { name: 'GH_TOKEN', value: '<github PAT>', required: true, note: 'PAT with Contents: Read scope; store as a k8s Secret + reference via valueFrom' },
      { name: 'GH_BRANCH', value: 'main', required: false, note: 'branch to pull from' },
      { name: 'GH_SYNC_INTERVAL', value: '30s', required: false, note: 'engine re-fetches the repo this often' },
      { name: 'compactReceiverLookupFile', value: 'pipelines/run/receive/compact/compact-cap.csv', required: true, note: 'must match the path inside your GitOps repo (env var name kept for engine compatibility; content is now per-container)' },
      { name: 'compactReceiverContainerField', value: 'k8s_container', required: false, note: 'event field whose value scopes the cap-file lookup; defaults to the k8s container name' },
      { name: 'compactReceiverDefault', value: 'false', required: false, note: '`false`: cap-file entries opt INTO compaction. `true`: cap-file entries opt OUT (use with the chart `optimize` flag)' },
    ],
    mcpHandoff: {
      tool: 'log10x_configure_compact',
      example:
        'log10x_configure_compact \\\n  gitops_repo=your-org/your-config-repo \\\n  service=payment-service \\\n  decision=true \\\n  reason="OPS-5123: high-volume container"',
    },
    caveats: [
      'The default `paths` glob in `pipelines/gitops/config.yaml` is hardcoded to `test/*.csv` for local testing. Override either by forking the config repo and editing the glob, or by setting `GH_PATH=pipelines/run/receive/compact/*` (Gap A — env override is being wired up).',
      'Customers running multiple receiver pods all watching the same GitOps repo will see fan-out: a single PR triggers reload on every pod within a poll window. That is the intended behavior — kept here as a heads-up for capacity planning.',
      'Hot-reload requires in-place writes (the gitops pattern). Do not source the cap-file via a Kubernetes ConfigMap mount — CM swaps the file via a symlink rename, which the engine\'s stat-based watcher will not see.',
    ],
  };
}

async function runPreflight(
  snapshot: DiscoverySnapshot,
  forwarder: ForwarderKind,
  releaseName: string,
  namespace: string,
  spec: ForwarderSpec | undefined,
  app: AdvisorApp,
  installMode: 'upgrade-existing' | 'fresh-release'
): Promise<PreflightCheck[]> {
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
  // Reporter runs ALONGSIDE the user's forwarder (standalone DaemonSet),
  // so any detected forwarder is fine — even none (the chart bundles its
  // own fluent-bit). Only the Receiver (sidecar) cares about alignment.
  const existing = snapshot.recommendations.existingForwarder;
  if (app === 'reporter') {
    checks.push({
      name: 'forwarder alignment',
      status: 'ok',
      detail: existing
        ? `detected \`${existing}\` — Reporter runs in parallel, no conflict`
        : 'no existing forwarder detected — Reporter bundles its own fluent-bit',
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

  // 4. Release-name collision check — semantics depend on installMode:
  //   - fresh-release   → release name MUST NOT already exist (would
  //     either fail the install or accidentally upgrade something
  //     unrelated). Existing release = FAIL.
  //   - upgrade-existing → release name MUST already exist (we're
  //     `helm upgrade`-ing into it). Existing release = OK, expected.
  //     Missing release = FAIL (helm upgrade would error).
  const releaseExists = snapshot.kubectl.helmReleases.some(
    (h) => h.name === releaseName && h.namespace === namespace
  );
  if (installMode === 'upgrade-existing') {
    checks.push({
      name: 'existing release for upgrade',
      status: releaseExists ? 'ok' : 'fail',
      detail: releaseExists
        ? `\`${releaseName}\` exists in \`${namespace}\` — this plan upgrades it in-place with --reuse-values`
        : `expected to upgrade \`${releaseName}\` in \`${namespace}\` but no such Helm release was detected; the snapshot may be stale, re-run log10x_discover_env`,
    });
  } else {
    checks.push({
      name: 'release collision',
      status: releaseExists ? 'fail' : 'ok',
      detail: releaseExists
        ? `a Helm release named \`${releaseName}\` already exists in \`${namespace}\` — pick a different release_name or uninstall the existing one first`
        : `no \`${releaseName}\` release in \`${namespace}\` — clear to install`,
    });
  }

  // Chart availability used to LIVE-probe `helm search repo` here. It
  // was removed because the chart refs it checked are static constants
  // in our own source (reporter-forwarders.ts):
  //   - reporter-10x / retriever-10x are charts WE publish under names
  //     we control.
  //   - The receiver forwarder charts (fluent/fluent-bit, vector/vector,
  //     open-telemetry/opentelemetry-collector, elastic/logstash) are
  //     well-known upstream identifiers that don't change.
  // The probe added the user's local helm repo entries on every plan
  // emit, blocked the wizard for up to 30s when helm was offline, and
  // checked constants we'd already shipped. If a future chart ref
  // drifts, helm install will surface it meaningfully on its own.

  // License JWT hint.
  checks.push({
    name: 'license JWT',
    status: 'unknown',
    detail:
      'bring your own log10x license JWT via the `license_jwt` argument (mint via `POST /api/v1/license/demo` or `POST /api/v1/license`). The plan fails closed without it.',
  });

  return checks;
}

function buildInstallSteps(opts: {
  spec: NonNullable<(typeof RECEIVER_FORWARDER_SPECS)[keyof typeof RECEIVER_FORWARDER_SPECS]>;
  releaseName: string;
  namespace: string;
  licenseJwt?: string;
  isDemoLicense?: boolean;
  destination: OutputDestination;
  outputHost?: string;
  splunkHecToken?: string;
  app: AdvisorApp;
  optimize?: boolean;
  readOnly?: boolean;
  backends?: MetricsBackendKind[];
  backendCredentials?: Partial<Record<MetricsBackendKind, BackendCredentialConfig>>;
  airgapped?: boolean;
  /**
   * 'upgrade-existing' = helm upgrade --reuse-values against the user's
   * detected forwarder release (Receiver path, canonical case — sidecar
   * goes INTO their existing forwarder pod).
   * 'fresh-release' = helm upgrade --install with a new release name
   * (Reporter path, or Receiver fallback when no helm release detected).
   */
  installMode: 'upgrade-existing' | 'fresh-release';
}): PlanStep[] {
  const {
    spec,
    releaseName,
    namespace,
    destination,
    outputHost,
    splunkHecToken,
    optimize,
    readOnly,
    backends,
    backendCredentials,
    airgapped,
    isDemoLicense,
    installMode,
  } = opts;
  const licenseJwt = opts.licenseJwt ?? 'REPLACE_WITH_LICENSE_JWT';
  const licenseSecretName = 'log10x-license';
  const licenseSecretKey = 'license-jwt';
  const steps: PlanStep[] = [];

  // The helm-repo step is only needed for fresh-release installs.
  // upgrade-existing means the user installed from this chart before,
  // so the repo is already added — `helm upgrade --reuse-values` would
  // resolve the chart from the locally cached repo. Skipping the step
  // keeps the plan focused on what's NEW (the receiver overlay).
  if (installMode === 'fresh-release') {
    steps.push({
      title: `Add ${spec.label} Helm repo`,
      rationale: `Makes the ${spec.chartRef} chart available to \`helm install\`.`,
      commands: [
        `helm repo add ${spec.helmRepoAlias} ${spec.helmRepo}`,
        `helm repo update`,
        `helm search repo ${spec.chartRef}`,
      ],
    });
  }

  if (installMode === 'fresh-release') {
    steps.push({
      title: 'Create target namespace',
      rationale: `The Reporter installs into \`${namespace}\`. \`--create-namespace\` on helm install will also do this, but a separate step makes retries idempotent.`,
      commands: [`kubectl create namespace ${namespace} --dry-run=client -o yaml | kubectl apply -f -`],
    });
  }
  // installMode='upgrade-existing': skip the namespace step — the user's
  // existing release is already in a real namespace; we just upgrade in place.

  // Real (user) licenses are kept out of values.yaml — the chart reads them
  // from an out-of-band Secret the user creates here. Demo licenses skip
  // this step (transient JWT, fine inline).
  if (isDemoLicense === false) {
    steps.push({
      title: 'Create license Secret',
      rationale: `Your license JWT must not live in values.yaml. The chart's \`licenseSecret\` block points the engine at this Secret — create it once, replace the JWT later by re-applying. The \`--from-literal\` approach below puts the JWT on the command line; if shell-history exposure matters, write it to a file first with \`umask 077\` and use \`--from-file=${licenseSecretKey}=<path>\`.`,
      commands: [
        `kubectl create secret generic ${licenseSecretName} \\
  -n ${namespace} \\
  --from-literal=${licenseSecretKey}='${licenseJwt}'`,
      ],
    });
  }

  const valuesFile = `${releaseName}-values.yaml`;
  const valuesPlanFile = {
    path: valuesFile,
    contents: spec.renderValues({
      licenseJwt,
      isDemoLicense,
      licenseSecretName,
      licenseSecretKey,
      releaseName,
      destination,
      outputHost,
      splunkHecToken,
      optimize,
      readOnly,
      backends,
      backendCredentials,
      airgapped,
      installMode,
    }),
    language: 'yaml' as const,
  };
  // Some forwarders (Fluentd) need extra files alongside the values
  // file — a kustomize post-renderer directory with sidecar-patch +
  // shell shims. Forwarders that need them implement `renderExtraFiles`;
  // others omit it and get the single-file step.
  const extraFiles = spec.renderExtraFiles
    ? spec.renderExtraFiles({
        releaseName,
        namespace,
        optimize,
        airgapped,
        licenseSecretName,
        licenseSecretKey,
      })
    : [];
  const allFiles = [valuesPlanFile, ...extraFiles];
  steps.push({
    title: extraFiles.length > 0 ? 'Write Helm values + kustomize overlay' : 'Write Helm values',
    rationale: extraFiles.length > 0
      ? `Tenx config + ${spec.label}-specific config, plus a kustomize post-renderer overlay (the upstream chart has no extraContainers hook — sidecar injected via Strategic Merge Patch on the rendered manifest).`
      : `Tenx config + ${spec.label}-specific output destination (\`${destination}\`).`,
    files: allFiles,
    commands: [],
  });

  const extraInstallCmds = spec.extraInstallCommands
    ? spec.extraInstallCommands({ releaseName, namespace })
    : [];
  const extraHelmFlags = spec.extraHelmFlags
    ? spec.extraHelmFlags({ releaseName, namespace })
    : [];
  const helmFlagSuffix = extraHelmFlags.length > 0
    ? ' \\\n  ' + extraHelmFlags.join(' \\\n  ')
    : '';
  // The receiver path upgrades the user's existing helm release with
  // `--reuse-values` so their chart values stay intact; our overlay
  // layers on top. The reporter path (or receiver fallback when no
  // existing release was detected) deploys a fresh release.
  if (installMode === 'upgrade-existing') {
    steps.push({
      title: `Upgrade the existing ${spec.label} release in-place`,
      rationale: `Injects the log10x sidecar into the user's existing \`${releaseName}\` release in \`${namespace}\` via \`helm upgrade --reuse-values\` + our overlay${extraHelmFlags.length > 0 ? ' + the kustomize post-renderer' : ''}. The user's chart values are preserved; we layer the receiver overlay on top. NO second forwarder is deployed.`,
      commands: [
        ...extraInstallCmds,
        `helm upgrade ${releaseName} ${spec.chartRef} \\\n  -n ${namespace} \\\n  --reuse-values \\\n  -f ${valuesFile}${helmFlagSuffix}`,
      ],
    });
  } else {
    steps.push({
      title: 'Install via Helm',
      rationale: extraHelmFlags.length > 0
        ? `Deploys the ${spec.label} chart with the 10x Receiver sidecar injected via the kustomize post-renderer (\`--post-renderer\` flag).`
        : `Deploys the ${spec.label} chart with the 10x Reporter sidecar enabled.`,
      commands: [
        ...extraInstallCmds,
        `helm upgrade --install ${releaseName} ${spec.chartRef} \\\n  -n ${namespace} --create-namespace \\\n  -f ${valuesFile}${helmFlagSuffix}`,
      ],
    });
  }

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
