/**
 * Per-forwarder Helm install plans for the Log10x Receiver, plus the
 * standalone Reporter chart.
 *
 * Two deployment models live in this file:
 *
 *   1. RECEIVER — a `log10x/edge-10x` sidecar container injected into
 *      the user's existing forwarder pod via a values overlay
 *      (`extraContainers` + `extraVolumes` + per-chart config rewiring).
 *      The forwarder chart is always the UPSTREAM one (no Log10x
 *      repackages). The sidecar reads its license JWT from a
 *      Kubernetes Secret mounted at `/etc/tenx/license/license.jwt`
 *      via `TENX_LICENSE_FILE`. Each forwarder has a different
 *      config-rewiring shape (Fluent Bit replaces `config:`, OTel
 *      deep-merges `config:`, Vector replaces `customConfig`, Logstash
 *      uses `logstashConfig` + `logstashPipeline`, Fluentd needs a
 *      kustomize post-renderer that emits a sidecar-patch).
 *
 *      Filebeat is NOT supported in the Receiver wizard — the upstream
 *      `elastic/filebeat` chart doesn't expose extraContainers/extraVolumes
 *      hooks. Detection still reports it; the wizard surfaces a "not
 *      yet" message and falls back to the Reporter.
 *
 *   2. REPORTER (`STANDALONE_SPEC`) — Log10x's own `log10x/reporter-10x`
 *      chart bundles a fluent-bit + tenx-edge that tail
 *      `/var/log/containers/*.log` in parallel to the user's forwarder.
 *      Read-only, zero-touch. The chart uses a flat values layout with
 *      `log10xLicenseJwt` at the top level and a `tenx:` block ONLY for
 *      engine resource overrides / extraArgs / extraEnv. License
 *      delivery: chart-managed Secret by default (JWT inlined into
 *      `log10xLicenseJwt`), or user-supplied Secret via
 *      `licenseSecret.{create:false, existingSecret, secretKey}` for
 *      real (non-demo) licenses.
 *
 * Sources of truth:
 *   - Receiver overlays: mksite/docs/apps/receiver/deploy.md
 *   - Standalone Reporter chart: mksite/docs/apps/reporter/deploy.md
 */

import type {
  ForwarderKind,
  MetricsBackendKind,
  BackendCredentialConfig,
} from '../discovery/types.js';

export type OutputDestination = 'mock' | 'elasticsearch' | 'splunk' | 'datadog' | 'cloudwatch';

/** How a forwarder's helm chart labels its workloads + pods. */
export type SelectorStyle = 'k8s-recommended' | 'legacy-helm';

export interface ForwarderSpec {
  /** Display name. */
  label: string;
  /** One-sentence architecture summary. */
  integrationMode: string;
  /** Helm repo URL. */
  helmRepo: string;
  /** Helm repo alias used in `helm repo add`. */
  helmRepoAlias: string;
  /** Published chart reference (`<alias>/<chart>`). */
  chartRef: string;
  /** Availability of the log10x-repackaged chart. */
  chartAvailability: 'published' | 'wip' | 'upstream-fallback';
  /** Default container image reference (for messaging only). */
  primaryImageHint: string;
  /**
   * Container name that tails + processes events. In embedded-image
   * mode (fluent-bit, fluentd, filebeat, logstash, otel-collector) the
   * 10x logic runs *inside* this container — there is no separate
   * `tenx` sidecar, so verify probes MUST target this container name.
   */
  primaryContainerName: string;
  /**
   * True when this forwarder uses sidecar mode (separate `tenx`
   * container in the pod). Currently only meaningful for Vector.
   */
  hasTenxSidecar: boolean;
  /** Label-selector style the chart family uses. */
  selectorStyle: SelectorStyle;
  /** Return the kubectl label selector for a given release. */
  selectorLabel: (releaseName: string) => string;
  /**
   * Render the values.yaml as a SINGLE coherent YAML document.
   *
   * The chart format is unified around the Receiver — every supported
   * forwarder chart deploys the Receiver app and exposes feature flags
   * (`optimize`, `readOnly`) for the two opt-in modes:
   *   - default (neither flag): receive + filter events, emit them in
   *     their original form back through the forwarder.
   *   - optimize=true: receive + filter + losslessly compact (~20-40x
   *     volume reduction).
   *   - readOnly=true: receive + emit TenXSummary metrics, do NOT write
   *     events back through the forwarder (passive observation).
   *
   * The two flags are mutually exclusive at the chart level (every chart
   * has a `tenx-validate.yaml` template that fails helm install if both
   * are set). The advisor enforces the same invariant upstream.
   *
   * Every chart in the supported set (fluent-bit, fluentd, otel-collector,
   * filebeat, logstash) reads `tenx.optimize` / `tenx.readOnly` directly.
   */
  renderValues: (opts: {
    /**
     * Log10x license JWT — the credential the engine consumes. Fetched
     * from the gateway's `/api/v1/license/demo` (anonymous) or
     * `/api/v1/license` (Auth0-authed) endpoints. Not the same as the
     * MCP's `LOG10X_API_KEY` env var, which is used for MCP↔gateway auth.
     */
    licenseJwt: string;
    /**
     * True when the JWT was minted from the demo endpoint (anonymous,
     * 14-day, transient). Renderers inline the JWT for demo licenses
     * (one-step setup, no Secret to manage). For real (user) licenses
     * the renderer points the chart at an out-of-band Kubernetes Secret
     * that the user creates before `helm upgrade` — the JWT itself is
     * never written into values.yaml.
     */
    isDemoLicense?: boolean;
    /** Name of the Kubernetes Secret holding the real license JWT (when isDemoLicense=false). */
    licenseSecretName?: string;
    /** Key inside the Secret whose value is the JWT (when isDemoLicense=false). */
    licenseSecretKey?: string;
    releaseName: string;
    destination: OutputDestination;
    outputHost?: string;
    splunkHecToken?: string;
    /** Placeholder emitted into `tenx.gitToken`. Defaults to the public-repo no-op string. */
    gitToken?: string;
    /**
     * When true, emit events in compact encoded form (templateHash+vars,
     * ~20-40x volume reduction). Mutually exclusive with `readOnly`.
     */
    optimize?: boolean;
    /**
     * When true, run the receiver in read-only mode (passive metrics
     * emitter — no events written back through the forwarder). Mutually
     * exclusive with `optimize`.
     */
    readOnly?: boolean;
    /**
     * Metrics backends the engine emits TenXSummary to. `['log10x']` is
     * the chart default (SaaS Prometheus); additional / replacement
     * backends are wired via `tenx.extraArgs` (`@run/output/metric/<b>`)
     * and `tenx.extraEnv` (vendor-specific env vars).
     */
    backends?: MetricsBackendKind[];
    /**
     * Per-backend credential configuration (secret name + plain-value
     * overrides). The wizard collects these from the user; if a backend
     * is selected but no entry exists here, the renderer falls back to
     * `<backend>-credentials` for the secret name and the per-backend
     * defaults/placeholders for plain values.
     */
    backendCredentials?: Partial<Record<MetricsBackendKind, BackendCredentialConfig>>;
    /**
     * When true, the engine runs fully airgapped. For the standalone
     * Reporter chart this is the top-level `airgapped: true` value;
     * for Receiver inline overlays it's the `TENX_AIRGAPPED=true` env
     * var on the engine sidecar.
     */
    airgapped?: boolean;
    /**
     * How the helm command lands. Per-forwarder renderers branch on
     * this to emit either a full chart values file (fresh-release —
     * Reporter or Receiver with no existing release detected) or a
     * minimal overlay containing ONLY the keys we need to add/replace
     * on top of the user's existing chart values (upgrade-existing —
     * canonical Receiver path; the helm command uses --reuse-values to
     * keep the user's existing config intact under our overlay).
     *
     * Most receiver overlays (fluentbit, otel, vector, logstash) are
     * already minimal — they only declare extraContainers, extraVolumes,
     * and the config block. They render the same shape regardless of
     * mode. Only fluentd needs branched output (the kustomize-post-
     * renderer chart's values vary substantially between fresh-deploy
     * and overlay-on-existing).
     */
    installMode?: 'upgrade-existing' | 'fresh-release';
  }) => string;
  /**
   * Optional: extra files to emit alongside the values.yaml. Used by
   * forwarders whose sidecar pattern requires more than a single
   * values file — the Fluentd receiver overlay emits a kustomize
   * post-renderer directory (`tenx-kustomize/{kustomization.yaml,
   * sidecar-patch.yaml, post-render.sh, post-render.cmd}`) alongside
   * its values file. Returning [] is equivalent to omitting the field.
   *
   * Paths are relative to the working directory the user runs
   * `helm upgrade` from. The shell-shim file must declare
   * `executable: true` so the renderer surfaces a chmod hint AND the
   * AdvisePlanSummary surfaces `install_requires_chmod=true`.
   */
  renderExtraFiles?: (opts: {
    releaseName: string;
    namespace: string;
    optimize?: boolean;
    airgapped?: boolean;
    licenseSecretName: string;
    licenseSecretKey: string;
  }) => import('./types.js').PlanFile[];
  /**
   * Optional: extra command-line flags appended to the
   * `helm upgrade --install` invocation. Used by the Fluentd overlay
   * to add `--post-renderer ./tenx-kustomize/post-render.sh`.
   * Returning [] is equivalent to omitting.
   */
  extraHelmFlags?: (opts: { releaseName: string; namespace: string }) => string[];
  /**
   * Optional: commands to run BEFORE `helm upgrade` (within the
   * "Install via Helm" step). Used by the Fluentd overlay to chmod
   * the post-render shim. Returning [] is equivalent to omitting.
   */
  extraInstallCommands?: (opts: { releaseName: string; namespace: string }) => string[];
  /** Verify probes — commands that, collectively, prove data is flowing. */
  verifyProbes: (opts: {
    releaseName: string;
    namespace: string;
    destination: OutputDestination;
    /** True when the install enabled encoded output (see renderValues.optimize). */
    optimize?: boolean;
    /** True when the install enabled read-only mode (no return loop). */
    readOnly?: boolean;
  }) => Array<{
    name: string;
    question: string;
    commands: string[];
    expectOutput?: string;
    timeoutSec?: number;
  }>;
}

const DEFAULT_GIT_TOKEN = 'public-repo-no-token-needed';

const MOCK_OUTPUT_NOTE =
  '# Mock output — prints each event to the forwarder stdout with a [TENX-MOCK] prefix so `kubectl logs | grep TENX-MOCK` can deterministically verify the pipeline.';

// ── Shared helpers ──

/**
 * Render `tenx.optimize` / `tenx.readOnly` lines as nested YAML under
 * the existing `tenx:` block. Every chart now accepts these flags
 * directly (fluent-bit, fluentd, otel-collector, filebeat, logstash);
 * the chart's `tenx-validate.yaml` template fails install if both are
 * true at once, so the advisor enforces the same invariant upstream.
 * Emits one line per truthy flag at 2-space indent; emits nothing when
 * both are false (chart defaults are false).
 */
function renderTenxFeatureFlags(opts: { optimize?: boolean; readOnly?: boolean }): string {
  const lines: string[] = [];
  if (opts.optimize) lines.push('  optimize: true');
  if (opts.readOnly) lines.push('  readOnly: true');
  return lines.length === 0 ? '' : '\n' + lines.join('\n');
}

/**
 * Per-backend env-var contract — what the engine's metric output module
 * reads from the container env. Sourced verbatim from
 * `config/pipelines/run/output/metric/<backend>/config.yaml`. If the
 * engine changes a name, update it HERE — the wizard, the renderer,
 * and the elicitation form all key off this spec.
 *
 * Two classes of env vars:
 *   - `secret`: sensitive (API keys, tokens, passwords) — emitted as
 *     `valueFrom.secretKeyRef` so they're pulled from a k8s Secret.
 *   - `plain`: non-sensitive (URLs, regions, namespaces) — emitted as
 *     direct `value:` strings.
 *
 * Each `plain` entry can have a `default` (engine has a sensible
 * fallback if the user doesn't override) or a `placeholder` (user
 * MUST supply a value; the renderer emits a `<TODO>`-style marker so
 * `helm upgrade` doesn't silently install with garbage).
 */
export interface BackendEnvSpec {
  /** Sensitive env vars sourced via `valueFrom.secretKeyRef`. */
  secret: Array<{ envVar: string; secretKey: string }>;
  /** Non-sensitive env vars sourced via plain `value:`. */
  plain: Array<{ envVar: string; default?: string; placeholder?: string }>;
}

export const BACKEND_ENV_SPECS: Partial<Record<MetricsBackendKind, BackendEnvSpec>> = {
  // datadog — `config/pipelines/run/output/metric/datadog/config.yaml`
  // reads DD_API_KEY + DD_APP_KEY (required) + DD_SITE (defaults to
  // us5.datadoghq.com inside the engine config).
  datadog: {
    secret: [
      { envVar: 'DD_API_KEY', secretKey: 'api-key' },
      { envVar: 'DD_APP_KEY', secretKey: 'app-key' },
    ],
    plain: [{ envVar: 'DD_SITE', default: 'us5.datadoghq.com' }],
  },

  // elastic — `config/pipelines/run/output/metric/elastic/config.yaml`
  // reads ELASTICSEARCH_HOST + ELASTIC_API_KEY (API-key auth — see Q3:
  // we default to API key, the engine config also has a basic-auth
  // path via ELASTIC_USERNAME/PASSWORD that we don't surface).
  elastic: {
    secret: [{ envVar: 'ELASTIC_API_KEY', secretKey: 'api-key' }],
    plain: [
      { envVar: 'ELASTICSEARCH_HOST', placeholder: '<https://your-elastic-host:9200>' },
    ],
  },

  // cloudwatch — engine config reads AWS_ACCESS_KEY_ID +
  // AWS_SECRET_ACCESS_KEY + CW_NAMESPACE. IRSA isn't wired in the
  // engine module today (Q4: keep static-creds-only until the engine
  // adds IRSA support).
  cloudwatch: {
    secret: [
      { envVar: 'AWS_ACCESS_KEY_ID', secretKey: 'access-key-id' },
      { envVar: 'AWS_SECRET_ACCESS_KEY', secretKey: 'secret-access-key' },
    ],
    plain: [{ envVar: 'CW_NAMESPACE', placeholder: '<your-cloudwatch-namespace>' }],
  },

  // signalfx — engine reads SIGNALFX_ACCESS_TOKEN + SIGNALFX_INGEST_URL
  // (defaults to https://ingest.signalfx.com if unset).
  signalfx: {
    secret: [{ envVar: 'SIGNALFX_ACCESS_TOKEN', secretKey: 'access-token' }],
    plain: [{ envVar: 'SIGNALFX_INGEST_URL', default: 'https://ingest.signalfx.com' }],
  },

  // prometheus (remote-write) — engine reads PROMETHEUS_REMOTE_WRITE_URL
  // + USERNAME + PASSWORD. The URL has a localhost default but the
  // wizard treats it as user-required (no sensible cluster-wide default).
  prometheus: {
    secret: [
      { envVar: 'PROMETHEUS_REMOTE_WRITE_USERNAME', secretKey: 'username' },
      { envVar: 'PROMETHEUS_REMOTE_WRITE_PASSWORD', secretKey: 'password' },
    ],
    plain: [
      { envVar: 'PROMETHEUS_REMOTE_WRITE_URL', placeholder: '<https://your-prom/api/v1/write>' },
    ],
  },

  // log10x intentionally not listed — the SaaS path uses the license
  // JWT + the chart default; no extra env vars needed.
};

/** Default Secret name for a given backend when the wizard doesn't override. */
export function defaultSecretNameFor(kind: MetricsBackendKind): string {
  return `${kind}-credentials`;
}

/**
 * Render the `tenx.extraArgs` + `tenx.extraEnv` blocks that wire up
 * additional metrics backends (beyond the chart-default `log10x`) and
 * the `TENX_AIRGAPPED` env var for Receiver inline overlays.
 *
 * Emits nothing when there's nothing to add (default `['log10x']` and
 * not airgapped). Always emits 2-space-indented YAML to nest under
 * `tenx:`.
 *
 * `log10x` is the chart default — we don't emit `@run/output/metric/log10x`
 * because the chart already wires that pipeline. Only NON-log10x backends
 * get an extraArg.
 *
 * Sensitive env vars are rendered as `valueFrom.secretKeyRef` referencing
 * the user-supplied (or default `<backend>-credentials`) Secret. The user
 * creates the Secret out-of-band before `helm upgrade`.
 *
 * The `airgappedAsEnvVar` flag is true for Receiver inline overlays
 * (engine reads `TENX_AIRGAPPED`) and false for the standalone Reporter
 * chart (which has a top-level `airgapped:` value instead).
 */
function renderTenxExtraArgsAndEnv(opts: {
  backends?: MetricsBackendKind[];
  backendCredentials?: Partial<Record<MetricsBackendKind, BackendCredentialConfig>>;
  airgapped?: boolean;
  airgappedAsEnvVar: boolean;
}): string {
  const nonLog10xBackends = (opts.backends ?? []).filter((b) => b !== 'log10x');
  const lines: string[] = [];

  if (nonLog10xBackends.length > 0) {
    lines.push('  extraArgs:');
    for (const b of nonLog10xBackends) {
      lines.push(`    - "@run/output/metric/${b}"`);
    }
  }

  const envLines: string[] = [];
  for (const b of nonLog10xBackends) {
    const spec = BACKEND_ENV_SPECS[b];
    if (!spec) continue;
    const creds = opts.backendCredentials?.[b];
    const secretName = creds?.secretName ?? defaultSecretNameFor(b);
    const plainOverrides = creds?.plainValues ?? {};

    // Sensitive env vars — valueFrom.secretKeyRef.
    for (const s of spec.secret) {
      envLines.push(`    - name: ${s.envVar}`);
      envLines.push(`      valueFrom:`);
      envLines.push(`        secretKeyRef:`);
      envLines.push(`          name: ${secretName}`);
      envLines.push(`          key: ${s.secretKey}`);
    }
    // Plain env vars — direct `value:` strings.
    for (const p of spec.plain) {
      const v = plainOverrides[p.envVar] ?? p.default ?? p.placeholder ?? '';
      envLines.push(`    - name: ${p.envVar}`);
      envLines.push(`      value: "${v}"`);
    }
  }
  if (opts.airgapped && opts.airgappedAsEnvVar) {
    envLines.push(`    - name: TENX_AIRGAPPED`);
    envLines.push(`      value: "true"`);
  }
  if (envLines.length > 0) {
    lines.push('  extraEnv:');
    lines.push(...envLines);
  }

  return lines.length === 0 ? '' : '\n' + lines.join('\n');
}

/** k8s-recommended selector: `app.kubernetes.io/instance=<release>`. */
function k8sRecommendedSelector(releaseName: string): string {
  return `app.kubernetes.io/instance=${releaseName}`;
}

/** Legacy helm (elastic-style): `app=<release>-<chart>,release=<release>`. */
function legacyElasticSelector(releaseName: string, chartSubstring: string): string {
  return `app=${releaseName}-${chartSubstring},release=${releaseName}`;
}

// ── Shared sidecar overlay ──

/**
 * Renders the `extraContainers[log10x]` + `extraVolumes[tenx-license]`
 * block that every Receiver overlay needs. Per-forwarder specs supply
 * the engine launch args (`@run/input/forwarder/<kind>` + `@apps/receiver`
 * + optional `receiverOptimize true` for compact mode) and call this
 * helper to emit the shared sidecar shape consistently.
 *
 * Indentation: emits each line with no leading indent. Callers paste
 * it at column 0 of the values overlay. The two top-level keys it emits
 * are `extraContainers:` and `extraVolumes:`.
 *
 * License delivery: always via the Secret-mounted file pattern
 * (`TENX_LICENSE_FILE=/etc/tenx/license/license.jwt`). For demo licenses
 * the caller's pre-install step still has to create the Secret — there
 * is no "inline JWT" path for the Receiver. (The chart values are
 * user-managed; we don't get to add a top-level field that the chart
 * would interpret.)
 */
function renderLog10xSidecar(opts: {
  /** Forwarder kind used in the engine's `@run/input/forwarder/<kind>` arg. */
  forwarderKind: 'fluentbit' | 'fluentd' | 'otel-collector' | 'vector' | 'logstash';
  /** When true, append `receiverOptimize true` to the engine args. */
  optimize?: boolean;
  /** When true, append `TENX_AIRGAPPED=true` to the sidecar env. */
  airgapped?: boolean;
  /** Name of the Kubernetes Secret holding the license JWT. */
  licenseSecretName: string;
  /** Key inside the Secret whose value is the JWT. */
  licenseSecretKey: string;
}): string {
  const argLines: string[] = [
    `      - "@run/input/forwarder/${opts.forwarderKind}"`,
    `      - "@apps/receiver"`,
  ];
  if (opts.optimize) {
    argLines.push(`      - "receiverOptimize"`);
    argLines.push(`      - "true"`);
  }
  const envLines: string[] = [
    `      - name: TENX_LICENSE_FILE`,
    `        value: /etc/tenx/license/license.jwt`,
  ];
  if (opts.airgapped) {
    envLines.push(`      - name: TENX_AIRGAPPED`);
    envLines.push(`        value: "true"`);
  }
  return `extraContainers:
  - name: log10x
    image: log10x/edge-10x:latest
    imagePullPolicy: IfNotPresent
    args:
${argLines.join('\n')}
    env:
${envLines.join('\n')}
    volumeMounts:
      - name: tenx-license
        mountPath: /etc/tenx/license
        readOnly: true
    resources:
      requests: { cpu: 100m, memory: 256Mi }
      limits:   { cpu: 500m, memory: 512Mi }

extraVolumes:
  - name: tenx-license
    secret:
      secretName: ${opts.licenseSecretName}
      items:
        - key: ${opts.licenseSecretKey}
          path: license.jwt`;
}

// ── The spec map ──

export const RECEIVER_FORWARDER_SPECS: Record<Exclude<ForwarderKind, 'unknown'>, ForwarderSpec> = {
  'fluentbit': {
    label: 'Fluent Bit',
    integrationMode:
      'Sidecar (`log10x/edge-10x`) injected into the user\'s existing Fluent Bit pod via the upstream `fluent/fluent-bit` chart\'s `extraContainers` + `extraVolumes` hooks. The chart\'s `config:` is replaced to wire the sidecar bypass — events flow `[INPUT] tail → [OUTPUT] forward → sidecar → [INPUT] forward (Tag_Prefix tenx.) → [OUTPUT] (destination)`. Filters Match kube.* only so enrichment runs once.',
    helmRepo: 'https://fluent.github.io/helm-charts',
    helmRepoAlias: 'fluent',
    chartRef: 'fluent/fluent-bit',
    chartAvailability: 'published',
    primaryImageHint: 'log10x/edge-10x',
    primaryContainerName: 'log10x',
    hasTenxSidecar: true,
    selectorStyle: 'k8s-recommended',
    selectorLabel: (r) => k8sRecommendedSelector(r),
    renderValues: ({ destination, outputHost, splunkHecToken, optimize, airgapped, licenseSecretName, licenseSecretKey }) => {
      const sidecar = renderLog10xSidecar({
        forwarderKind: 'fluentbit',
        optimize,
        airgapped,
        licenseSecretName: licenseSecretName ?? 'log10x-license',
        licenseSecretKey: licenseSecretKey ?? 'license-jwt',
      });
      const destOutput = renderFluentBitDestinationOutput(destination, outputHost, splunkHecToken);
      return `# Receiver overlay for Fluent Bit (upstream fluent/fluent-bit chart).
# Layer on top of your existing values:
#   helm upgrade --install <release> fluent/fluent-bit \\
#     -f your-existing-fluent-bit-values.yaml \\
#     -f my-receiver.yaml --namespace <namespace>

${sidecar}

# Replace the chart's default config with the sidecar bypass pattern.
# Inputs: tail your sources + receive processed events back from the
# sidecar on :24225 with Tag_Prefix tenx. (so filters and the ingest
# handoff Match kube.* and skip the returning tenx.*).
# Filters: enrichment (kubernetes metadata) on kube.* only.
# Outputs: handoff to the sidecar on 127.0.0.1:24224 + destination
# for the returning tenx.* events.
config:
  service: |
    [SERVICE]
        Daemon Off
        Flush {{ .Values.flush }}
        Log_Level {{ .Values.logLevel }}
        Parsers_File /fluent-bit/etc/parsers.conf
        Parsers_File /fluent-bit/etc/conf/custom_parsers.conf
        HTTP_Server On
        HTTP_Listen 0.0.0.0
        HTTP_Port {{ .Values.metricsPort }}
        Health_Check On

  inputs: |
    [INPUT]
        Name tail
        Path /var/log/containers/*.log
        Exclude_Path ${FORWARDER_EXCLUDE_GLOBS}
        multiline.parser docker, cri
        Tag kube.*
        Mem_Buf_Limit 5MB
        Skip_Long_Lines On

    # Egress: returning events from the 10x sidecar. Tag_Prefix tenx.
    # prevents enrichment filters and the sidecar-handoff output from
    # re-firing (they Match kube.* only).
    [INPUT]
        Name forward
        Listen 0.0.0.0
        Port 24225
        Tag_Prefix tenx.

  filters: |
    [FILTER]
        Name kubernetes
        Match kube.*
        Merge_Log On
        Keep_Log Off
        K8S-Logging.Parser On
        K8S-Logging.Exclude On

  outputs: |
    # Hand off to the Log10x sidecar.
    [OUTPUT]
        Name forward
        Match kube.*
        Host 127.0.0.1
        Port 24224
        Retry_Limit False

${destOutput}
`;
    },
    verifyProbes: ({ releaseName, namespace, destination, optimize }) => {
      const sel = k8sRecommendedSelector(releaseName);
      const probes: Array<{
        name: string;
        question: string;
        commands: string[];
        expectOutput?: string;
        timeoutSec?: number;
      }> = [
        {
          name: 'pods-ready',
          question: 'Are all Fluent Bit pods Ready (with the log10x sidecar)?',
          commands: [`kubectl -n ${namespace} wait --for=condition=Ready pod -l ${sel} --timeout=5m`],
          expectOutput: 'condition met',
          timeoutSec: 300,
        },
        {
          name: 'sidecar-alive',
          question: 'Is the log10x sidecar running and processing events?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c log10x --tail=400 | grep -E 'tenx|pattern|receiver|template' | head -20`,
          ],
        },
        {
          name: 'forwarder-handoff',
          question: 'Is Fluent Bit forwarding kube.* events to the sidecar on 127.0.0.1:24224?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c fluent-bit --tail=400 | grep -E '\\\\[OUTPUT\\\\].*forward|127\\\\.0\\\\.0\\\\.1:24224' | head -10`,
          ],
        },
      ];
      if (destination === 'mock') {
        probes.push({
          name: 'tenx-mock-events',
          question: 'Are returning tenx.* events reaching the stdout destination?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c fluent-bit --tail=200 | grep -E '"tag":"tenx\\\\.' | head -5`,
          ],
          expectOutput: 'tenx.',
          timeoutSec: 120,
        });
      }
      if (optimize) {
        probes.push({
          name: 'tenx-encoded-events',
          question: 'Are events emitted in compact encoded form (templateHash+vars)?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c fluent-bit --tail=500 | grep -oE '"log":"~[^"]{5,20},[0-9]{10,}' | head -3`,
          ],
          expectOutput: '~',
          timeoutSec: 120,
        });
      }
      return probes;
    },
  },

  fluentd: {
    label: 'Fluentd',
    integrationMode:
      'Sidecar (`log10x/edge-10x`) injected into the user\'s existing Fluentd pod via the upstream `fluent/fluentd` chart + a kustomize post-renderer (the upstream chart has no extraContainers hook, so the sidecar is patched onto the rendered Deployment manifest via Strategic Merge Patch). The wizard emits five files — values.yaml + tenx-kustomize/{kustomization.yaml, sidecar-patch.yaml, post-render.sh, post-render.cmd} — and the `helm upgrade` step uses `--post-renderer ./tenx-kustomize/post-render.sh`.',
    helmRepo: 'https://fluent.github.io/helm-charts',
    helmRepoAlias: 'fluent',
    chartRef: 'fluent/fluentd',
    chartAvailability: 'published',
    primaryImageHint: 'log10x/edge-10x',
    primaryContainerName: 'log10x',
    hasTenxSidecar: true,
    selectorStyle: 'k8s-recommended',
    selectorLabel: (r) => k8sRecommendedSelector(r),
    renderValues: ({ destination, outputHost, splunkHecToken, installMode }) => {
      const destOutput = renderFluentdDestinationOutput(destination, outputHost, splunkHecToken);
      // Shared fileConfigs body — used by both modes. Routes through
      // the log10x sidecar via @INGEST → :24224 → :24225 → @OUTPUT.
      const fileConfigsBlock = `fileConfigs:
  01_sources.conf: |-
    # Replace this dummy source with your real sources (tail, http,
    # k8s, ...). Every source MUST route to @INGEST.
    <source>
      @type dummy
      @id in_dummy
      tag k8s.demo
      rate 1
      dummy {"log":"hello from fluentd dummy plugin","level":"info"}
      auto_increment_key seq
      @label @INGEST
    </source>

  02_filters.conf: |-
    <label @INGEST>
      # Enrichment filters go here — k8s_metadata, parsers,
      # record_transformer, etc. They fire exactly once per event;
      # the return path skips this label.
      <filter **>
        @type record_transformer
        enable_ruby false
        <record>
          cluster "$\{ENV['CLUSTER_NAME'] || 'unset'\}"
        </record>
      </filter>

      # Hand off to the Log10x sidecar. \`keepalive true\` matters for
      # the sidecar topology — otherwise Fluentd opens a fresh TCP
      # connection per chunk on the loopback path.
      <match **>
        @type forward
        @id out_to_tenx
        keepalive true
        keepalive_timeout 60s
        send_timeout 5s
        require_ack_response false
        <server>
          host 127.0.0.1
          port 24224
        </server>
        <buffer>
          @type memory
          flush_interval 1s
          flush_thread_count 1
        </buffer>
      </match>
    </label>

  03_dispatch.conf: |-
    # Forward source receiving processed events back from Log10x.
    # Bind on 0.0.0.0 so kubelet's tcpSocket probe can reach it from
    # the pod IP. The sidecar still connects via 127.0.0.1.
    <source>
      @type forward
      @id in_from_tenx
      bind 0.0.0.0
      port 24225
      @label @OUTPUT
    </source>

  04_outputs.conf: |-
    # @OUTPUT is the terminal label — replace with your real
    # destinations (out_elasticsearch, out_splunk_hec, out_kafka2,
    # out_s3, ...). Keep this label filter-free.
    <label @OUTPUT>
${indent(destOutput, 6)}
    </label>
`;

      // upgrade-existing emits a MINIMAL overlay: only the fileConfigs
      // block (the receiver bypass routing) on top of the user's
      // existing release values. Everything else (kind, replicaCount,
      // image, rbac, mounts) stays as they had it — preserved by
      // `helm upgrade --reuse-values`. fresh-release emits the full
      // chart values (needed when there's no existing release to
      // inherit defaults from).
      if (installMode === 'upgrade-existing') {
        return `# Receiver overlay for Fluentd — UPGRADE-EXISTING mode.
# Overlays JUST the keys the receiver needs on top of your existing
# fluent/fluentd Helm release. Your existing values (image, kind,
# replicaCount, rbac, mounts, etc.) stay as-is via --reuse-values; we
# only replace fileConfigs to wire the sidecar bypass.
#
# Run with:
#   chmod +x tenx-kustomize/post-render.sh
#   helm upgrade <existing-release> fluent/fluentd \\
#     -n <namespace> \\
#     --reuse-values \\
#     -f <release>-values.yaml \\
#     --post-renderer ./tenx-kustomize/post-render.sh

# @INGEST runs your enrichment filters once and forwards events to the
# 10x sidecar on :24224. @OUTPUT receives processed events back on
# :24225 and writes them to your destinations. This block REPLACES
# your existing fileConfigs — adapt the source/filter rules to your
# inputs.
${fileConfigsBlock}`;
      }
      return `# Receiver overlay for Fluentd (upstream fluent/fluentd chart).
# Layered with a kustomize post-renderer (see tenx-kustomize/ files) —
# the upstream chart has no extraContainers hook, so the sidecar is
# injected via a Strategic Merge Patch on the rendered manifest.
#
# Run with:
#   chmod +x tenx-kustomize/post-render.sh
#   helm upgrade --install <release> fluent/fluentd \\
#     -n <namespace> --create-namespace \\
#     -f <release>-values.yaml \\
#     --post-renderer ./tenx-kustomize/post-render.sh

kind: Deployment            # or DaemonSet for host-log tailing
replicaCount: 1

# Plain upstream image; the 10x sidecar is a separate container added
# via the kustomize overlay.
image:
  repository: fluent/fluentd
  tag: v1.18-debian-1

# No host log mounts in this example (the source below uses the
# \`dummy\` plugin). For real container-log tailing flip these to true
# and switch \`kind\` to DaemonSet.
mountVarLogDirectory: false
mountDockerContainersDirectory: false

rbac:
  create: false
serviceAccount:
  create: true
service:
  enabled: false
podSecurityPolicy:
  enabled: false

# @INGEST runs your enrichment filters once and forwards events to
# the 10x sidecar on :24224. @OUTPUT receives processed events back
# on :24225 and writes them to your destinations.
${fileConfigsBlock}`;
    },
    renderExtraFiles: ({ releaseName, optimize, airgapped, licenseSecretName, licenseSecretKey }) => {
      const deploymentName = `${releaseName}-fluentd`;
      // engine args for the sidecar — same convention as
      // renderLog10xSidecar but inline because the patch YAML lives
      // outside the values file. Each list item is indented to match
      // the surrounding Strategic Merge Patch structure.
      const argLines: string[] = [
        `                    - "@run/input/forwarder/fluentd"`,
        `                    - "@apps/receiver"`,
      ];
      if (optimize) {
        argLines.push(`                    - "receiverOptimize"`);
        argLines.push(`                    - "true"`);
      }
      const envLines: string[] = [
        `                    - name: TENX_LICENSE_FILE`,
        `                      value: /etc/tenx/license/license.jwt`,
      ];
      if (airgapped) {
        envLines.push(`                    - name: TENX_AIRGAPPED`);
        envLines.push(`                      value: "true"`);
      }
      return [
        {
          path: 'tenx-kustomize/kustomization.yaml',
          language: 'yaml',
          contents: `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - helm-output.yaml          # populated by post-render.sh at install time
patches:
  - path: sidecar-patch.yaml
    target: { kind: Deployment, name: ${deploymentName} }
`,
        },
        {
          path: 'tenx-kustomize/sidecar-patch.yaml',
          language: 'yaml',
          contents: `# Adds the log10x sidecar container to the Fluentd pod. Kubernetes
# restarts the container automatically if the 10x process exits.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${deploymentName}
spec:
  template:
    spec:
      containers:
        - name: log10x
          image: log10x/edge-10x:latest
          imagePullPolicy: IfNotPresent
          args:
${argLines.join('\n')}
          env:
${envLines.join('\n')}
          volumeMounts:
            - name: tenx-license
              mountPath: /etc/tenx/license
              readOnly: true
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits:   { cpu: 500m, memory: 512Mi }
      volumes:
        - name: tenx-license
          secret:
            secretName: ${licenseSecretName}
            items:
              - key: ${licenseSecretKey}
                path: license.jwt
`,
        },
        {
          path: 'tenx-kustomize/post-render.sh',
          language: 'bash',
          executable: true,
          contents: `#!/usr/bin/env bash
# Bridges Helm's stdin/stdout post-renderer protocol to kustomize's
# file-based model. Captures Helm's rendered manifests, then runs
# \`kubectl kustomize\` to apply the patches.
set -euo pipefail
DIR="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
cat > "$DIR/helm-output.yaml"
exec kubectl kustomize "$DIR"
`,
        },
        {
          path: 'tenx-kustomize/post-render.cmd',
          language: 'batch',
          contents: `@echo off
REM Windows shim — Helm.exe can't directly exec a .sh on Windows.
REM Use this path as \`--post-renderer\` on Windows; Linux/macOS use
REM the .sh directly.
bash "%~dp0post-render.sh"
`,
        },
      ];
    },
    extraInstallCommands: () => ['chmod +x tenx-kustomize/post-render.sh'],
    extraHelmFlags: () => ['--post-renderer ./tenx-kustomize/post-render.sh'],
    verifyProbes: ({ releaseName, namespace, destination, optimize }) => {
      const sel = k8sRecommendedSelector(releaseName);
      const probes: Array<{
        name: string;
        question: string;
        commands: string[];
        expectOutput?: string;
        timeoutSec?: number;
      }> = [
        {
          name: 'pods-ready',
          question: 'Are all Fluentd pods Ready (with the log10x sidecar)?',
          commands: [`kubectl -n ${namespace} wait --for=condition=Ready pod -l ${sel} --timeout=5m`],
          expectOutput: 'condition met',
          timeoutSec: 300,
        },
        {
          name: 'sidecar-alive',
          question: 'Is the log10x sidecar running and processing events?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c log10x --tail=400 | grep -E 'tenx|pattern|receiver|template' | head -20`,
          ],
        },
        {
          name: 'forwarder-handoff',
          question: 'Is Fluentd forwarding @INGEST events to the sidecar on 127.0.0.1:24224?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c fluentd --tail=400 | grep -E 'out_to_tenx|127\\\\.0\\\\.0\\\\.1:24224|@INGEST' | head -10`,
          ],
        },
      ];
      if (destination === 'mock') {
        probes.push({
          name: 'tenx-mock-events',
          question: 'Are returning events reaching the @OUTPUT label?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c fluentd --tail=200 | grep -E '@OUTPUT|in_from_tenx' | head -10`,
          ],
          timeoutSec: 120,
        });
      }
      if (optimize) {
        probes.push({
          name: 'tenx-encoded-events',
          question: 'Are events emitted in compact encoded form (templateHash+vars)?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c fluentd --tail=500 | grep -oE '~[A-Za-z0-9]{5,20},[0-9]{10,}' | head -3`,
          ],
          expectOutput: '~',
          timeoutSec: 120,
        });
      }
      return probes;
    },
  },

  filebeat: {
    label: 'Filebeat',
    integrationMode:
      'DaemonSet using the log10x-repackaged Filebeat image (`log10x/filebeat-10x`). 10x logic runs inside the `filebeat` container via a processor. Chart is in the Elastic-style helm repo and uses legacy Helm labels.',
    helmRepo: 'https://log-10x.github.io/elastic-helm-charts',
    helmRepoAlias: 'log10x-elastic',
    chartRef: 'log10x-elastic/filebeat',
    chartAvailability: 'published',
    primaryImageHint: 'ghcr.io/log-10x/filebeat-10x',
    primaryContainerName: 'filebeat',
    hasTenxSidecar: false,
    selectorStyle: 'legacy-helm',
    selectorLabel: (r) => legacyElasticSelector(r, 'filebeat'),
    renderValues: ({ licenseJwt, releaseName, destination, outputHost, gitToken, optimize, readOnly, backends, backendCredentials, airgapped }) => {
      // Chart defaults reference Elasticsearch secrets/certs. For a mock
      // install we MUST override extraEnvs/secretMounts to empty so pods
      // don't hang in FailedMount.
      const outputBlock = renderFilebeatOutput(destination, outputHost);
      const featureFlags = renderTenxFeatureFlags({ optimize, readOnly });
      const extras = renderTenxExtraArgsAndEnv({ backends, backendCredentials, airgapped, airgappedAsEnvVar: true });
      return `tenx:
  enabled: true
  licenseJwt: "${licenseJwt}"
  runtimeName: "${releaseName}"${featureFlags}${extras}

# The chart's default readiness/liveness probes run \`filebeat test output\`
# which doesn't support \`output.file\` (used by mock destination). Override
# to simple \`pgrep filebeat\` so the probes reflect actual process liveness.
# These are TOP-LEVEL chart values, not under \`daemonset:\`.
readinessProbe:
  exec:
    command: ["sh", "-c", "pgrep -x filebeat >/dev/null"]
  initialDelaySeconds: 10
  periodSeconds: 10
livenessProbe:
  exec:
    command: ["sh", "-c", "pgrep -x filebeat >/dev/null"]
  initialDelaySeconds: 30
  periodSeconds: 30

daemonset:
  # Avoid chart defaults that hardcode elasticsearch-master-credentials / certs.
  # Override to empty lists for mock/test; add back real refs for production ES.
  extraEnvs: []
  secretMounts: []
  filebeatConfig:
    filebeat.yml: |
${indent(outputBlock, 6)}
`;
    },
    verifyProbes: ({ releaseName, namespace, destination }) => {
      const sel = legacyElasticSelector(releaseName, 'filebeat');
      const probes = [
        {
          name: 'pods-ready',
          question: 'Are all Reporter DaemonSet pods Ready?',
          commands: [`kubectl -n ${namespace} wait --for=condition=Ready pod -l ${sel} --timeout=5m`],
          expectOutput: 'condition met',
          timeoutSec: 300,
        },
        {
          name: 'processor-alive',
          question: 'Is the 10x processor initialized in the filebeat container?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c filebeat --tail=400 | grep -iE 'tenx|10x|pattern' | head -20`,
          ],
        },
      ];
      if (destination === 'mock') {
        probes.push({
          name: 'tenx-mock-events',
          question: 'Are tagged [TENX-MOCK] events reaching stdout (via `output.file` path /tmp)?',
          commands: [
            `kubectl -n ${namespace} exec -it $(kubectl -n ${namespace} get pod -l ${sel} -o name | head -1) -c filebeat -- sh -c 'head -5 /tmp/tenx-mock.out 2>/dev/null || echo "no mock output yet"'`,
          ],
          expectOutput: 'TENX-MOCK',
          timeoutSec: 120,
        });
      }
      return probes;
    },
  },

  logstash: {
    label: 'Logstash',
    integrationMode:
      'Sidecar (`log10x/edge-10x`) injected into the user\'s existing Logstash pod via the upstream `elastic/logstash` chart. The chart uses `extraContainers` (as a YAML pipe-string) + `secretMounts` (not `extraVolumes`) for the license, plus `logstashConfig` (pipelines.yml) and `logstashPipeline` (per-pipeline .conf files). Two pipelines: `ingest` runs your filters once and hands events off to the sidecar over loopback TCP :5044; `destinations` is filter-free and receives processed events back from the sidecar on :5045 to ship to the real backends.',
    helmRepo: 'https://helm.elastic.co',
    helmRepoAlias: 'elastic',
    chartRef: 'elastic/logstash',
    chartAvailability: 'published',
    primaryImageHint: 'log10x/edge-10x',
    primaryContainerName: 'log10x',
    hasTenxSidecar: true,
    selectorStyle: 'k8s-recommended',
    selectorLabel: (r) => k8sRecommendedSelector(r),
    renderValues: ({ destination, outputHost, optimize, airgapped, licenseSecretName, licenseSecretKey }) => {
      // Logstash chart quirks (vs the other receiver overlays):
      //   - `extraContainers` is a YAML pipe-string, not a list. We inline
      //     the log10x container block here rather than using the shared
      //     renderLog10xSidecar helper (which emits a top-level list).
      //   - License is mounted via the chart's `secretMounts` field, not
      //     `extraVolumes`. The chart's `secretMounts[].subPath` projects a
      //     single key from the Secret to a file path on disk.
      const secretName = licenseSecretName ?? 'log10x-license';
      const secretKey = licenseSecretKey ?? 'license-jwt';
      const argLines: string[] = [
        `      - "@run/input/forwarder/logstash"`,
        `      - "@apps/receiver"`,
      ];
      if (optimize) {
        argLines.push(`      - "receiverOptimize"`);
        argLines.push(`      - "true"`);
      }
      const envLines: string[] = [
        `      - name: TENX_LICENSE_FILE`,
        `        value: /etc/tenx/license/license.jwt`,
      ];
      if (airgapped) {
        envLines.push(`      - name: TENX_AIRGAPPED`);
        envLines.push(`        value: "true"`);
      }
      const destOutput = renderLogstashDestinationOutput(destination, outputHost);
      return `# Receiver overlay for Logstash (upstream elastic/logstash chart).
# Layer on top of your existing values:
#   helm upgrade --install <release> elastic/logstash \\
#     -f your-existing-logstash-values.yaml \\
#     -f my-receiver.yaml --namespace <namespace>

# elastic/logstash quirk: extraContainers is a YAML pipe-string, not a list.
extraContainers: |
  - name: log10x
    image: log10x/edge-10x:latest
    imagePullPolicy: IfNotPresent
    args:
${argLines.join('\n')}
    env:
${envLines.join('\n')}
    volumeMounts:
      - name: tenx-license
        mountPath: /etc/tenx/license/license.jwt
        subPath: license.jwt
        readOnly: true
    resources:
      requests: { cpu: 100m, memory: 256Mi }
      limits:   { cpu: 500m, memory: 512Mi }

# License via the chart's secretMounts (not extraVolumes). subPath
# projects the Secret's \`${secretKey}\` key to a single file.
secretMounts:
  - name: tenx-license
    secretName: ${secretName}
    path: /etc/tenx/license/license.jwt
    subPath: ${secretKey}

# Two-pipeline driver: ingest runs your filters and hands off to the
# sidecar; destinations consumes returning events filter-free, so
# enrichment runs exactly once.
logstashConfig:
  pipelines.yml: |
    - pipeline.id: ingest
      path.config: "/usr/share/logstash/pipeline/tenx-ingest.conf"
    - pipeline.id: destinations
      path.config: "/usr/share/logstash/pipeline/tenx-destinations.conf"

logstashPipeline:
  tenx-ingest.conf: |
    input {
      # Replace with your real inputs (file, beats, http, ...). The
      # \`tag\` field becomes the event's source inside Log10x.
      file {
        path  => "/var/log/containers/*.log"
        codec => "json"
        start_position => "beginning"
      }
    }
    filter {
      mutate {
        add_field => { "cluster" => "$\{CLUSTER_NAME:unset\}" }
        add_field => { "tag" => "k8s.containers" }
      }
    }
    output {
      tcp {
        host  => "127.0.0.1"
        port  => 5044
        codec => json_lines
      }
    }
  tenx-destinations.conf: |
    input {
      tcp {
        host  => "0.0.0.0"
        port  => 5045
        codec => json_lines
      }
    }
    output {
${indent(destOutput, 6)}
    }
`;
    },
    verifyProbes: ({ releaseName, namespace, destination, optimize }) => {
      const sel = k8sRecommendedSelector(releaseName);
      const probes: Array<{
        name: string;
        question: string;
        commands: string[];
        expectOutput?: string;
        timeoutSec?: number;
      }> = [
        {
          name: 'pods-ready',
          question: 'Are all Logstash pods Ready (with the log10x sidecar)?',
          commands: [`kubectl -n ${namespace} wait --for=condition=Ready pod -l ${sel} --timeout=10m`],
          expectOutput: 'condition met',
          timeoutSec: 600,
        },
        {
          name: 'sidecar-alive',
          question: 'Is the log10x sidecar running and processing events?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c log10x --tail=400 | grep -E 'tenx|pattern|receiver|template' | head -20`,
          ],
        },
        {
          name: 'pipeline-wired',
          question: 'Are the ingest and destinations pipelines both running?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c logstash --tail=400 | grep -E 'pipeline.id|tenx-ingest|tenx-destinations|5044|5045' | head -20`,
          ],
        },
      ];
      if (destination === 'mock') {
        probes.push({
          name: 'tenx-mock-events',
          question: 'Are returning events reaching the stdout destination?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c logstash --tail=200 | grep -E 'tenx-destinations' | head -10`,
          ],
          timeoutSec: 180,
        });
      }
      if (optimize) {
        probes.push({
          name: 'tenx-encoded-events',
          question: 'Are events emitted in compact encoded form (templateHash+vars)?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c logstash --tail=500 | grep -oE '~[A-Za-z0-9]{5,20},[0-9]{10,}' | head -3`,
          ],
          expectOutput: '~',
          timeoutSec: 120,
        });
      }
      return probes;
    },
  },

  // Vector — upstream `vector/vector` chart with a values overlay (per
  // mksite/docs/apps/receiver/deploy.md). No log10x-repackaged Vector
  // chart exists; the integration is done via overlay on top of the
  // upstream chart. The exact `tenx:` overlay schema is still being
  // shaped — TODO: lock down the values structure once the engine team
  // publishes the canonical Vector sidecar config.
  vector: {
    label: 'Vector',
    integrationMode:
      'Sidecar (`log10x/edge-10x`) injected into the user\'s existing Vector pod via the upstream `vector/vector` chart\'s `extraContainers` + `extraVolumes` hooks. The chart\'s `customConfig` is replaced to wire the sidecar bypass — Vector\'s DAG IS the bypass: sources feed an `ingest` transform → `tenx_in` socket sink → the sidecar processes → returns via the `tenx_out` fluent source → destinations sinks consume `tenx_out` only.',
    helmRepo: 'https://helm.vector.dev',
    helmRepoAlias: 'vector',
    chartRef: 'vector/vector',
    chartAvailability: 'published',
    primaryImageHint: 'log10x/edge-10x',
    primaryContainerName: 'log10x',
    hasTenxSidecar: true,
    selectorStyle: 'k8s-recommended',
    selectorLabel: (r) => k8sRecommendedSelector(r),
    renderValues: ({ destination, outputHost, optimize, airgapped, licenseSecretName, licenseSecretKey }) => {
      const sidecar = renderLog10xSidecar({
        forwarderKind: 'vector',
        optimize,
        airgapped,
        licenseSecretName: licenseSecretName ?? 'log10x-license',
        licenseSecretKey: licenseSecretKey ?? 'license-jwt',
      });
      const destSink = renderVectorDestinationSink(destination, outputHost);
      return `# Receiver overlay for Vector (upstream vector/vector chart).
# Layer on top of your existing values:
#   helm upgrade --install <release> vector/vector \\
#     -f your-existing-vector-values.yaml \\
#     -f my-receiver.yaml --namespace <namespace>

${sidecar}

# Replace the chart's default customConfig with the sidecar bypass.
# Sources feed the \`ingest\` transform; sinks consume \`tenx_out\` so
# enrichment runs exactly once. Vector's DAG IS the bypass.
customConfig:
  data_dir: /vector-data-dir

  sources:
    # Replace with your real sources (file, kubernetes_logs, journald,
    # http_server, ...). All sources MUST feed the \`ingest\` transform —
    # anything wired directly to a destination skips Log10x.
    app_logs:
      type: kubernetes_logs

    # Returning events from the 10x sidecar. Bind on 0.0.0.0 so kubelet's
    # tcpSocket probe reaches the port from the pod IP; the sidecar still
    # connects via 127.0.0.1 (same pod, same netns).
    tenx_out:
      type: fluent
      mode: tcp
      address: 0.0.0.0:9001

  transforms:
    # Enrichment runs here exactly once before handoff. The return path
    # skips this transform via the DAG wiring below.
    ingest:
      type: remap
      inputs: [app_logs]
      source: |
        .cluster = get_env_var("CLUSTER_NAME") ?? "unset"
        .tag = .source_type

  sinks:
    # Hand off to the Log10x sidecar.
    tenx_in:
      type: socket
      inputs: [ingest]
      mode: tcp
      address: 127.0.0.1:9000
      encoding: { codec: json }
      framing: { method: newline_delimited }

    # Destinations consume tenx_out ONLY (never the raw sources or
    # \`ingest\`). That structural wiring is the enrichment bypass.
${indent(destSink, 4)}
`;
    },
    verifyProbes: ({ releaseName, namespace, destination, optimize }) => {
      const sel = k8sRecommendedSelector(releaseName);
      const probes: Array<{
        name: string;
        question: string;
        commands: string[];
        expectOutput?: string;
        timeoutSec?: number;
      }> = [
        {
          name: 'pods-ready',
          question: 'Are all Vector pods Ready (with the log10x sidecar)?',
          commands: [`kubectl -n ${namespace} wait --for=condition=Ready pod -l ${sel} --timeout=5m`],
          expectOutput: 'condition met',
          timeoutSec: 300,
        },
        {
          name: 'sidecar-alive',
          question: 'Is the log10x sidecar running and processing events?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c log10x --tail=400 | grep -E 'tenx|pattern|receiver|template' | head -20`,
          ],
        },
        {
          name: 'pipeline-wired',
          question: 'Is the tenx_in sink reaching the sidecar and tenx_out receiving returns?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c vector --tail=400 | grep -E 'tenx_in|tenx_out|fluent' | head -10`,
          ],
        },
      ];
      if (destination === 'mock') {
        probes.push({
          name: 'tenx-mock-events',
          question: 'Are returning events being printed by the console sink?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c vector --tail=200 | grep -E 'destinations' | head -10`,
          ],
          timeoutSec: 120,
        });
      }
      if (optimize) {
        probes.push({
          name: 'tenx-encoded-events',
          question: 'Are events emitted in compact encoded form (templateHash+vars)?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c vector --tail=500 | grep -oE '~[A-Za-z0-9]{5,20},[0-9]{10,}' | head -3`,
          ],
          expectOutput: '~',
          timeoutSec: 120,
        });
      }
      return probes;
    },
  },

  'otel-collector': {
    label: 'OTel Collector',
    integrationMode:
      'Sidecar (`log10x/edge-10x`) injected into the user\'s existing OTel Collector pod via the upstream `open-telemetry/opentelemetry-collector` chart\'s `extraContainers` + `extraVolumes` hooks. The chart\'s `config:` is deep-merged: we add an `otlp/tenx` exporter (handoff to sidecar at 127.0.0.1:4317), an `otlp/tenx` receiver (return path on 0.0.0.0:24225), rewire the `logs` pipeline through `otlp/tenx`, and add a `logs/from-tenx` pipeline that ships the returning events to the user\'s real destinations. Both directions are OTLP/gRPC over loopback.',
    helmRepo: 'https://open-telemetry.github.io/opentelemetry-helm-charts',
    helmRepoAlias: 'open-telemetry',
    chartRef: 'open-telemetry/opentelemetry-collector',
    chartAvailability: 'published',
    primaryImageHint: 'log10x/edge-10x',
    primaryContainerName: 'log10x',
    hasTenxSidecar: true,
    selectorStyle: 'k8s-recommended',
    selectorLabel: (r) => k8sRecommendedSelector(r),
    renderValues: ({ destination, outputHost, optimize, airgapped, licenseSecretName, licenseSecretKey }) => {
      const sidecar = renderLog10xSidecar({
        forwarderKind: 'otel-collector',
        optimize,
        airgapped,
        licenseSecretName: licenseSecretName ?? 'log10x-license',
        licenseSecretKey: licenseSecretKey ?? 'license-jwt',
      });
      // OTel destination exporter declaration + the exporter name(s) the
      // from-tenx pipeline references. For mock we use the chart's built-in
      // `debug` exporter (no extra config needed); for real destinations
      // we declare a typed exporter block.
      const { exporterName, exporterBlock } = renderOtelDestinationExporter(destination, outputHost);
      return `# Receiver overlay for OTel Collector (upstream open-telemetry/opentelemetry-collector chart).
# Layer on top of your existing values:
#   helm upgrade --install <release> open-telemetry/opentelemetry-collector \\
#     -f your-existing-otel-values.yaml \\
#     -f my-receiver.yaml --namespace <namespace>

${sidecar}

# config: is deep-merged with chart defaults and your existing values.
# We add: an otlp/tenx exporter (handoff to the sidecar), an otlp/tenx
# receiver (return path), rewire the logs pipeline through the sidecar,
# and add a logs/from-tenx pipeline that ships returning events to
# your real destinations.
config:
  receivers:
    otlp/tenx:
      protocols:
        grpc:
          endpoint: 0.0.0.0:24225

  exporters:
    otlp/tenx:
      endpoint: 127.0.0.1:4317
      tls:
        insecure: true
${exporterBlock ? `${indent(exporterBlock, 4)}\n` : ''}
  service:
    pipelines:
      # Replace your existing logs pipeline (Helm merges these lists
      # wholesale; spell out everything you need).
      logs:
        receivers: [filelog]                # ← your existing receivers
        processors:
          - memory_limiter
          - batch
        exporters: [otlp/tenx]

      # New egress pipeline. Processor-free so enrichment runs exactly once.
      logs/from-tenx:
        receivers: [otlp/tenx]
        exporters: [${exporterName}]
`;
    },
    verifyProbes: ({ releaseName, namespace, destination, optimize }) => {
      const sel = k8sRecommendedSelector(releaseName);
      const probes: Array<{
        name: string;
        question: string;
        commands: string[];
        expectOutput?: string;
        timeoutSec?: number;
      }> = [
        {
          name: 'pods-ready',
          question: 'Are all OTel Collector pods Ready (with the log10x sidecar)?',
          commands: [`kubectl -n ${namespace} wait --for=condition=Ready pod -l ${sel} --timeout=5m`],
          expectOutput: 'condition met',
          timeoutSec: 300,
        },
        {
          name: 'sidecar-alive',
          question: 'Is the log10x sidecar running and processing events?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c log10x --tail=400 | grep -E 'tenx|pattern|receiver|template' | head -20`,
          ],
        },
        {
          name: 'pipeline-wired',
          question: 'Is the otlp/tenx receiver listening and the logs pipeline routing through it?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c opentelemetry-collector --tail=400 | grep -E 'otlp/tenx|logs/from-tenx' | head -10`,
          ],
        },
      ];
      if (destination === 'mock') {
        probes.push({
          name: 'tenx-mock-events',
          question: 'Are returning events being printed by the debug exporter?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c opentelemetry-collector --tail=300 | grep -E 'debug' | head -10`,
          ],
          timeoutSec: 120,
        });
      }
      if (optimize) {
        probes.push({
          name: 'tenx-encoded-events',
          question: 'Are events emitted in compact encoded form (templateHash+vars)?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c opentelemetry-collector --tail=500 | grep -oE '~[A-Za-z0-9]{5,20},[0-9]{10,}' | head -3`,
          ],
          expectOutput: '~',
          timeoutSec: 120,
        });
      }
      return probes;
    },
  },
};

// ── Standalone Reporter spec (reporter-10x chart) ──
//
// Architecturally distinct from the inline specs above: the `reporter-10x`
// chart deploys a parallel DaemonSet (fluent-bit + tenx-edge) that tails
// the same /var/log/containers/*.log files the user's existing forwarder
// already tails, WITHOUT replacing or reconfiguring that forwarder. It is
// zero-touch: no values to patch on the user's prod pipeline, no pods to
// restart on their critical path.
//
// Kept as a separate export rather than a 6th entry in
// RECEIVER_FORWARDER_SPECS because the spec map is keyed by "which user
// forwarder kind do we replace" — and standalone replaces none. It runs
// alongside whatever the user has (or nothing). Callers select standalone
// via `shape: 'standalone'` in ReporterAdviseArgs; `forwarder` stays in
// the plan as detected context only.
//
// Only supports app=reporter (kind=report). The reporter-10x chart has no
// path to hook into the user's forwarder's output to filter / compact
// events — it only emits metrics. Callers passing app='receiver' or
// optimize=true with shape='standalone' get a blocker.
export const STANDALONE_SPEC: ForwarderSpec = {
  label: 'Standalone Reporter (reporter-10x)',
  integrationMode:
    'Parallel DaemonSet using the log10x/reporter-10x chart — bundles fluent-bit + tenx-edge. Tails /var/log/containers/*.log alongside your existing forwarder without touching it. Report-mode only (metrics, no filtering or encoded output).',
  helmRepo: 'https://log-10x.github.io/helm-charts',
  helmRepoAlias: 'log10x',
  chartRef: 'log10x/reporter-10x',
  chartAvailability: 'published',
  primaryImageHint: 'ghcr.io/log-10x/fluent-bit-10x',
  primaryContainerName: 'fluent-bit',
  hasTenxSidecar: false,
  selectorStyle: 'k8s-recommended',
  selectorLabel: (r) => k8sRecommendedSelector(r),
  renderValues: ({ licenseJwt, isDemoLicense, licenseSecretName, licenseSecretKey, releaseName, backends, backendCredentials, airgapped }) => {
    // reporter-10x uses a flat values layout: top-level log10xLicenseJwt
    // + runtimeName (NOT nested under `tenx:`). The chart turns the JWT
    // into a Kubernetes Secret and mounts it as a file pointed at by
    // TENX_LICENSE_FILE inside the engine container.
    //
    // Demo licenses (transient, 14-day, anonymous): inline the JWT in
    // values.yaml — chart creates a Secret on its own from that value.
    // One-step setup, fine for demos.
    //
    // Real (user) licenses: never write the JWT into values.yaml.
    // Instead, point the chart at an existing Secret the user creates
    // out-of-band. The chart's `licenseSecret.create=false` mode skips
    // the auto-Secret generation and mounts the user's existing one.
    //
    // We intentionally DO NOT emit `gitToken` or `config.git` defaults
    // — both match chart defaults and the chart's secret-template only
    // creates the git-token Secret when `config.git.enabled` OR
    // `symbols.git.enabled` is true (neither is by default), so the
    // chart works fine without them. The engine reads config from a
    // baked-in image path in default deployments.
    //
    // Airgapped is the chart's TOP-LEVEL `airgapped:` value (NOT a tenx
    // env var as in the Receiver overlays); the chart secret-templates
    // and engine launch args branch off it. Additional metrics backends
    // wire via `tenx.extraArgs` + `tenx.extraEnv` — same shape as
    // Receiver overlays.
    const airgappedLine = airgapped ? `\nairgapped: true` : '';
    const extras = renderTenxExtraArgsAndEnv({ backends, backendCredentials, airgapped, airgappedAsEnvVar: false });
    const tenxBlock = extras
      ? `\ntenx:${extras}\n`
      : '';
    const licenseBlock = isDemoLicense === false
      ? `log10xLicenseJwt: ""          # Provided via the Secret below (create it before \`helm upgrade\`)
licenseSecret:
  create: false
  existingSecret: ${licenseSecretName ?? 'log10x-license'}
  secretKey: ${licenseSecretKey ?? 'license-jwt'}`
      : `log10xLicenseJwt: "${licenseJwt}"`;
    return `# reporter-10x: non-invasive parallel DaemonSet.
# Runs alongside the user's existing forwarder without touching it.
${licenseBlock}
runtimeName: "${releaseName}"${airgappedLine}${tenxBlock}`;
  },
  verifyProbes: ({ releaseName, namespace }) => {
    const sel = k8sRecommendedSelector(releaseName);
    return [
      {
        name: 'pods-ready',
        question: 'Are all reporter-10x DaemonSet pods Ready?',
        commands: [`kubectl -n ${namespace} wait --for=condition=Ready pod -l ${sel} --timeout=5m`],
        expectOutput: 'condition met',
        timeoutSec: 300,
      },
      {
        name: 'processor-alive',
        question: 'Is tenx-edge processing events (pattern fingerprinting)?',
        commands: [
          `kubectl -n ${namespace} logs -l ${sel} -c fluent-bit --tail=400 | grep -iE 'tenx|10x|pattern' | head -20`,
        ],
      },
      {
        name: 'metrics-publishing',
        question: 'Is the Reporter publishing TenXSummary metrics to the log10x backend?',
        commands: [
          `kubectl -n ${namespace} logs -l ${sel} -c fluent-bit --tail=400 | grep -F 'Publishing TenXSummary' | head -3`,
        ],
        expectOutput: 'Publishing TenXSummary',
        timeoutSec: 300,
      },
    ];
  },
};

// ── Destination-specific sub-renderers ──
// Pulled out so the destination logic lives in one place per forwarder.

// Exclude all known log-forwarder container logs from the tail input.
// Without this, every forwarder on a node tails every OTHER forwarder's
// output, producing runaway recursion where each event contains all the
// prior forwarded events escaped inside. Verified: 40KB+ events crash
// the tenx aggregator with ArrayIndexOutOfBoundsException / OOM.
const FORWARDER_EXCLUDE_GLOBS =
  '/var/log/containers/*fluent-bit*.log,/var/log/containers/*fluentd*.log,/var/log/containers/*filebeat*.log,/var/log/containers/*logstash*.log,/var/log/containers/*otel-collector*.log,/var/log/containers/*opentelemetry-collector*.log';

const FORWARDER_EXCLUDE_REGEX = [
  '.*fluent-bit.*\\.log$',
  '.*fluentd.*\\.log$',
  '.*filebeat.*\\.log$',
  '.*logstash.*\\.log$',
  '.*otel-collector.*\\.log$',
  '.*opentelemetry-collector.*\\.log$',
];

/**
 * Renders the destination `[OUTPUT]` block for the Fluent Bit receiver
 * overlay. This is the second [OUTPUT] in the chain — Match tenx.* —
 * consuming the post-sidecar tagged events emitted back into Fluent Bit
 * by the egress `[INPUT] forward Tag_Prefix tenx.`. The handoff
 * `[OUTPUT] forward Match kube.*` (events going TO the sidecar) is
 * constant and lives in the template body.
 *
 * Returns lines already indented with 4 spaces (config.outputs is a
 * pipe-string in YAML; the renderer concatenates this onto the template).
 */
function renderFluentBitDestinationOutput(
  destination: OutputDestination,
  outputHost?: string,
  splunkHecToken?: string
): string {
  if (destination === 'mock') {
    return `    # Destination for processed tenx.* events. Replace with your real
    # destination (es, splunk, kafka, s3, ...) — this stdout block is
    # safe for dogfooding.
    [OUTPUT]
        Name stdout
        Match tenx.*
        Format json_lines`;
  }
  if (destination === 'elasticsearch') {
    return `    [OUTPUT]
        Name es
        Match tenx.*
        Host ${outputHost ?? 'elasticsearch-master'}
        Logstash_Format On`;
  }
  if (destination === 'splunk') {
    return `    [OUTPUT]
        Name splunk
        Match tenx.*
        Host ${outputHost ?? 'splunk-hec.example.com'}
        Port 8088
        TLS On
        Splunk_Token ${splunkHecToken ?? 'REPLACE_WITH_HEC_TOKEN'}`;
  }
  if (destination === 'datadog') {
    return `    [OUTPUT]
        Name datadog
        Match tenx.*
        Host http-intake.logs.datadoghq.com
        TLS On
        apikey \${DD_API_KEY}`;
  }
  if (destination === 'cloudwatch') {
    return `    [OUTPUT]
        Name cloudwatch_logs
        Match tenx.*
        region \${AWS_REGION:-us-east-1}
        log_group_name ${outputHost ?? '/aws/log10x/receiver'}
        log_stream_prefix ${'$\{POD_NAME\}'}-
        auto_create_group On`;
  }
  return '';
}

function renderFluentBitOutput(
  destination: OutputDestination,
  outputHost?: string,
  splunkHecToken?: string
): string {
  if (destination === 'mock') {
    // NOTE: uses `record_modifier` not `modify`. fluent-bit's modify
    // filter regex-compiles every Add value; `[TENX-MOCK]` is read as
    // an unterminated character class and the filter crashes at init.
    // `record_modifier` treats the value as a literal string.
    return `config:
  inputs: |
    [INPUT]
        Name tail
        Path /var/log/containers/*.log
        Exclude_Path ${FORWARDER_EXCLUDE_GLOBS}
        multiline.parser docker, cri
        Tag kube.*
        Mem_Buf_Limit 5MB
        Skip_Long_Lines On
  outputs: |
    ${MOCK_OUTPUT_NOTE}
    [OUTPUT]
        Name   stdout
        Match  *
        Format json_lines
  filters: |
    [FILTER]
        Name   record_modifier
        Match  *
        Record _tenx_mock_prefix TENX-MOCK`;
  }
  if (destination === 'elasticsearch') {
    return `config:
  outputs: |
    [OUTPUT]
        Name   es
        Match  kube.*
        Host   ${outputHost ?? 'elasticsearch-master'}
        Logstash_Format On`;
  }
  if (destination === 'splunk') {
    return `config:
  outputs: |
    [OUTPUT]
        Name         splunk
        Match        *
        Host         ${outputHost ?? 'splunk-hec.example.com'}
        Port         8088
        TLS          On
        Splunk_Token ${splunkHecToken ?? 'REPLACE_WITH_HEC_TOKEN'}`;
  }
  return '';
}

/**
 * Returns the body of the @OUTPUT label for the Fluentd receiver
 * overlay's 04_outputs.conf — the user's actual destination match. The
 * caller wraps this in `<label @OUTPUT>...</label>`. Indentation is 0
 * (caller indents). Matches the per-destination shape of the other
 * forwarder dest renderers (renderFluentBitDestinationOutput, etc.).
 */
function renderFluentdDestinationOutput(
  destination: OutputDestination,
  outputHost?: string,
  splunkHecToken?: string,
): string {
  if (destination === 'mock') {
    return `<match **>
  @type stdout
  @id out_stdout
</match>`;
  }
  if (destination === 'elasticsearch') {
    return `<match **>
  @type elasticsearch
  host "${outputHost ?? 'elasticsearch-master'}"
  port 9200
  logstash_format true
</match>`;
  }
  if (destination === 'splunk') {
    return `<match **>
  @type splunk_hec
  hec_host ${outputHost ?? 'splunk-hec.example.com'}
  hec_port 8088
  hec_token ${splunkHecToken ?? 'REPLACE_WITH_HEC_TOKEN'}
</match>`;
  }
  if (destination === 'datadog') {
    return `<match **>
  @type datadog
  api_key "#{ENV['DD_API_KEY']}"
  dd_source "log10x-receiver"
</match>`;
  }
  if (destination === 'cloudwatch') {
    return `<match **>
  @type cloudwatch_logs
  log_group_name ${outputHost ?? '/aws/log10x/receiver'}
  log_stream_name log10x-receiver
  auto_create_stream true
  region "#{ENV['AWS_REGION'] || 'us-east-1'}"
</match>`;
  }
  return `<match **>
  @type stdout
</match>`;
}

function renderFluentdOutputConfig(
  destination: OutputDestination,
  outputHost?: string,
  splunkHecToken?: string
): string {
  if (destination === 'mock') {
    return `${MOCK_OUTPUT_NOTE}
<label @FINAL-OUTPUT>
  <filter **>
    @type record_transformer
    <record>
      _tenx_mock_prefix "[TENX-MOCK]"
    </record>
  </filter>
  <match **>
    @type stdout
  </match>
</label>`;
  }
  if (destination === 'elasticsearch') {
    return `<label @FINAL-OUTPUT>
  <match **>
    @type elasticsearch
    host "${outputHost ?? 'elasticsearch-master'}"
    port 9200
  </match>
</label>`;
  }
  if (destination === 'splunk') {
    return `<label @FINAL-OUTPUT>
  <match **>
    @type splunk_hec
    hec_host ${outputHost ?? 'splunk-hec.example.com'}
    hec_port 8088
    hec_token ${splunkHecToken ?? 'REPLACE_WITH_HEC_TOKEN'}
  </match>
</label>`;
  }
  return '';
}

function renderFilebeatOutput(destination: OutputDestination, outputHost?: string): string {
  if (destination === 'mock') {
    // CRITICAL: the chart's default filebeat.yml includes a
    // \`processors: script\` step that runs tenx-report.js — which
    // marks each event with "tenx":true and writes it to stdout so
    // the tenx-edge process (reading filebeat's stdout via
    // \`filebeat ... 2>&1 | tenx-edge run ...\` in docker-entrypoint)
    // can ingest it. Replacing filebeat.yml without that script
    // processor means tenx sees zero events.
    //
    // Include the script processor here, per-forwarder-kind, so tenx
    // actually processes the data. The chart exposes the script
    // paths as \`tenx.processors.<kind>\` — but since we're fully
    // overriding filebeatConfig, we hardcode the path to tenx-report.js
    // which is baked at a known location in every log10x/filebeat-10x
    // image.
    //
    // CRITICAL (Dor, 2026-04-22): filebeat + log10x is INCOMPATIBLE with
    // \`output.console\`. The tenx subprocess reads from filebeat's
    // stdout — the same channel \`output.console\` writes to — so a
    // console output corrupts the tenx input stream. Use output.file
    // (below) for mock verification, or any non-stdout output in prod
    // (elasticsearch, splunk, logstash, kafka, etc.). The log10x/
    // filebeat-10x Dockerfile hardcodes this pipe assumption, so it's
    // not overridable at the chart level.
    //
    // output.file writes the regular event stream to /tmp/tenx-mock-*
    // for "is the forwarder working" verification. The script-processor
    // side writes separately to stdout for tenx ingestion.
    return `filebeat.inputs:
- type: filestream
  id: tenx_internal
  paths:
    - \${TENX_LOG_PATH:/etc/tenx/log}/*.log
  fields:
    log_type: tenx_internal
- type: container
  paths:
  - /var/log/containers/*.log
  exclude_files: ${JSON.stringify(FORWARDER_EXCLUDE_REGEX)}
  processors:
  - add_kubernetes_metadata:
      host: \${NODE_NAME}
      matchers:
      - logs_path:
          logs_path: "/var/log/containers/"
  - script:
      lang: javascript
      file: \${TENX_MODULES}/pipelines/run/modules/input/forwarder/filebeat/script/tenx-report.js

processors:
- add_fields:
    target: ""
    fields:
      _tenx_mock_prefix: "TENX-MOCK"

${MOCK_OUTPUT_NOTE}
output.file:
  path: "/tmp"
  filename: "tenx-mock"
  rotate_every_kb: 10000
  number_of_files: 5`;
  }
  if (destination === 'elasticsearch') {
    return `filebeat.inputs:
- type: container
  paths:
  - /var/log/containers/*.log
output.elasticsearch:
  hosts: ["https://${outputHost ?? 'elasticsearch-master'}:9200"]`;
  }
  return '';
}


function renderLogstashOutput(destination: OutputDestination, outputHost?: string): string {
  if (destination === 'mock') {
    return `${MOCK_OUTPUT_NOTE}
filter {
  mutate { add_field => { "_tenx_mock_prefix" => "[TENX-MOCK]" } }
}
output {
  stdout {
    codec => json_lines
  }
}`;
  }
  if (destination === 'elasticsearch') {
    return `output {
  elasticsearch {
    hosts => ["${outputHost ?? 'elasticsearch-master'}:9200"]
    index => "logs-%{+YYYY.MM.dd}"
  }
}`;
  }
  return 'output { }';
}

/**
 * Returns the inside-`output {...}` block for the Logstash receiver
 * overlay's `tenx-destinations.conf` pipeline. Consumes returning
 * processed events from the sidecar (on :5045) and ships them to the
 * user's chosen backend. Caller wraps this in `output { ... }`.
 * Indentation is 0 (caller indents).
 */
function renderLogstashDestinationOutput(destination: OutputDestination, outputHost?: string): string {
  if (destination === 'mock') {
    return `stdout { codec => json_lines }`;
  }
  if (destination === 'elasticsearch') {
    return `elasticsearch {
  hosts => ["${outputHost ?? 'elasticsearch-master'}:9200"]
  index => "logs-%{+YYYY.MM.dd}"
}`;
  }
  if (destination === 'splunk') {
    return `http {
  url => "https://${outputHost ?? 'splunk-hec.example.com'}:8088/services/collector/event"
  format => "json_batch"
  http_method => "post"
  headers => { "Authorization" => "Splunk \${SPLUNK_HEC_TOKEN}" }
}`;
  }
  if (destination === 'datadog') {
    return `http {
  url => "https://http-intake.logs.datadoghq.com/api/v2/logs"
  format => "json_batch"
  http_method => "post"
  headers => { "DD-API-KEY" => "\${DD_API_KEY}" }
}`;
  }
  if (destination === 'cloudwatch') {
    return `# CloudWatch Logs from Logstash uses the
    # logstash-output-cloudwatch_logs plugin (gem install required in
    # a custom image). Replace this stdout with the cloudwatch_logs
    # block once the plugin is installed.
stdout { codec => json_lines }`;
  }
  return `stdout { codec => json_lines }`;
}

/**
 * Returns the `destinations` sink block for the Vector receiver overlay.
 * Consumes the `tenx_out` source (post-sidecar events) and writes them
 * to the user's chosen backend. Indentation is 0 (caller indents).
 */
function renderVectorDestinationSink(destination: OutputDestination, outputHost?: string): string {
  if (destination === 'mock') {
    return `destinations:
  type: console
  inputs: [tenx_out]
  encoding:
    codec: json`;
  }
  if (destination === 'elasticsearch') {
    return `destinations:
  type: elasticsearch
  inputs: [tenx_out]
  endpoints: ["https://${outputHost ?? 'elasticsearch-master'}:9200"]
  mode: bulk
  bulk:
    index: logs`;
  }
  if (destination === 'splunk') {
    return `destinations:
  type: splunk_hec_logs
  inputs: [tenx_out]
  endpoint: "https://${outputHost ?? 'splunk-hec.example.com'}:8088"
  default_token: \${SPLUNK_HEC_TOKEN}`;
  }
  if (destination === 'datadog') {
    return `destinations:
  type: datadog_logs
  inputs: [tenx_out]
  default_api_key: \${DD_API_KEY}
  site: \${DD_SITE:-datadoghq.com}`;
  }
  if (destination === 'cloudwatch') {
    return `destinations:
  type: aws_cloudwatch_logs
  inputs: [tenx_out]
  group_name: ${outputHost ?? '/aws/log10x/receiver'}
  stream_name: log10x-receiver
  region: \${AWS_REGION:-us-east-1}
  encoding:
    codec: json`;
  }
  return `destinations:
  type: console
  inputs: [tenx_out]
  encoding:
    codec: json`;
}

function renderOtelExporter(destination: OutputDestination, outputHost?: string): string {
  if (destination === 'mock') {
    return `debug:
  verbosity: basic`;
  }
  if (destination === 'elasticsearch') {
    return `elasticsearch:
  endpoints: ["https://${outputHost ?? 'elasticsearch-master'}:9200"]
  logs_index: logs`;
  }
  return '';
}

/**
 * Returns the exporter name to reference from the `logs/from-tenx`
 * pipeline plus the optional exporter block to add under
 * `config.exporters`. `mock` uses the chart's built-in `debug` exporter
 * (no extra block needed). Real destinations get a typed exporter block.
 */
function renderOtelDestinationExporter(
  destination: OutputDestination,
  outputHost?: string,
): { exporterName: string; exporterBlock: string } {
  if (destination === 'mock') {
    return { exporterName: 'debug', exporterBlock: '' };
  }
  if (destination === 'elasticsearch') {
    return {
      exporterName: 'elasticsearch',
      exporterBlock: `elasticsearch:
  endpoints: ["https://${outputHost ?? 'elasticsearch-master'}:9200"]
  logs_index: logs`,
    };
  }
  if (destination === 'splunk') {
    return {
      exporterName: 'splunk_hec',
      exporterBlock: `splunk_hec:
  token: \${SPLUNK_HEC_TOKEN}
  endpoint: "https://${outputHost ?? 'splunk-hec.example.com'}:8088/services/collector"`,
    };
  }
  if (destination === 'datadog') {
    return {
      exporterName: 'datadog',
      exporterBlock: `datadog:
  api:
    key: \${DD_API_KEY}
    site: \${DD_SITE:-datadoghq.com}`,
    };
  }
  if (destination === 'cloudwatch') {
    return {
      exporterName: 'awscloudwatchlogs',
      exporterBlock: `awscloudwatchlogs:
  log_group_name: ${outputHost ?? '/aws/log10x/receiver'}
  log_stream_name: log10x-receiver
  region: \${AWS_REGION:-us-east-1}`,
    };
  }
  // Fallback to debug — should be unreachable since destination is enum-typed.
  return { exporterName: 'debug', exporterBlock: '' };
}

/** Indent every line of `s` by `spaces` spaces. */
function indent(s: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return s
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}
