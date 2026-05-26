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
  }) => string;
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

export const REPORTER_FORWARDER_SPECS: Record<Exclude<ForwarderKind, 'unknown'>, ForwarderSpec> = {
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
      'DaemonSet using the log10x-repackaged Fluentd image (`log10x/fluentd-10x`). 10x logic runs inside the `fluentd` container — no separate sidecar.',
    helmRepo: 'https://log-10x.github.io/fluent-helm-charts',
    helmRepoAlias: 'log10x-fluent',
    chartRef: 'log10x-fluent/fluentd',
    chartAvailability: 'published',
    primaryImageHint: 'ghcr.io/log-10x/fluentd-10x',
    primaryContainerName: 'fluentd',
    hasTenxSidecar: false,
    selectorStyle: 'k8s-recommended',
    selectorLabel: (r) => k8sRecommendedSelector(r),
    renderValues: ({ licenseJwt, releaseName, destination, outputHost, splunkHecToken, gitToken, optimize, readOnly, backends, backendCredentials, airgapped }) => {
      // IMPORTANT: fluentd's output config lives UNDER `tenx:`, not
      // as a second top-level `tenx:` block. A prior version of this
      // template emitted two `tenx:` keys and YAML silently dropped
      // the first — losing licenseJwt/runtimeName/git config entirely.
      const outputConfig = renderFluentdOutputConfig(destination, outputHost, splunkHecToken);
      const fluentdExcludePaths = FORWARDER_EXCLUDE_REGEX.map((g) => `/var/log/containers/${g.replace('.*', '*').replace('\\.log$', '.log')}`)
        .map((g) => `"${g}"`)
        .join(', ');
      // Same as fluent-bit: chart values expose optimize + readOnly
      // booleans directly; chart templates handle the engine wiring.
      const featureFlags = renderTenxFeatureFlags({ optimize, readOnly });
      const extras = renderTenxExtraArgsAndEnv({ backends, backendCredentials, airgapped, airgappedAsEnvVar: true });
      return `tenx:
  enabled: true
  licenseJwt: "${licenseJwt}"${featureFlags}
  runtimeName: "${releaseName}"${extras}
  # Override the default container-log tail input to exclude all log-forwarder
  # container logs (fluent-bit, fluentd, filebeat, logstash, otel-collector).
  # Without this, when multiple forwarders share a node, each tails the other's
  # stdout and events recurse — verified to crash the tenx aggregator on 40KB+
  # self-referential events.
  fileConfigs:
    01_sources.conf: |-
      <source>
        @type tail
        @id in_tail_container_logs
        @label @CONCAT
        path /var/log/containers/*.log
        exclude_path [${fluentdExcludePaths}]
        pos_file /var/log/fluentd-containers.log.pos
        tag raw.kubernetes.*
        read_from_head true
        <parse>
          @type multi_format
          <pattern>
            format json
            time_key time
            time_type string
            time_format "%Y-%m-%dT%H:%M:%S.%NZ"
            keep_time_key false
          </pattern>
          <pattern>
            format regexp
            expression /^(?<time>.+) (?<stream>stdout|stderr)( (?<logtag>.))? (?<log>.*)$/
            time_format '%Y-%m-%dT%H:%M:%S.%N%:z'
            keep_time_key false
          </pattern>
        </parse>
        emit_unmatched_lines true
      </source>
  outputConfigs:
    06_final_output.conf: |-
${indent(outputConfig, 6)}
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
          question: 'Are all Reporter DaemonSet pods Ready?',
          commands: [`kubectl -n ${namespace} wait --for=condition=Ready pod -l ${sel} --timeout=5m`],
          expectOutput: 'condition met',
          timeoutSec: 300,
        },
        {
          name: 'processor-alive',
          question: 'Is the 10x Fluentd plugin initialized and processing records?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c fluentd --tail=400 | grep -iE 'tenx|10x|pattern' | head -20`,
          ],
        },
      ];
      if (destination === 'mock') {
        probes.push({
          name: 'tenx-mock-events',
          question: 'Are tagged [TENX-MOCK] events reaching stdout?',
          commands: [`kubectl -n ${namespace} logs -l ${sel} -c fluentd --tail=200 | grep -F 'TENX-MOCK' | head -5`],
          expectOutput: 'TENX-MOCK',
          timeoutSec: 120,
        });
      }
      if (optimize) {
        probes.push({
          name: 'tenx-encoded-events',
          question: 'Are events emitted in compact encoded form (templateHash+vars)?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c fluentd --tail=500 | grep -oE '"log":"~[^"]{5,20},[0-9]{10,}' | head -3`,
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
    // The log10x-elastic/logstash chart is broken in sidecar mode. The
    // chart runs tenx as a separate pod container reading from its own
    // STDIN, but the tenx-logstash design expects tenx to be a CHILD
    // PROCESS of logstash spawned by the `pipe` output plugin (so tenx's
    // stdin is wired to logstash's pipe). With the chart's layout,
    // tenx.stdin is a tty, it sees no input, and after ~9s the pipeline
    // shuts down. Do NOT ship this path to users until the chart is
    // fixed or a sidecar-capable launcher is added to tenx-edge.
    integrationMode:
      'StatefulSet + `tenx` sidecar — CURRENTLY BROKEN: the chart runs tenx as a side container reading from its own stdin, but tenx-logstash expects to be spawned by the logstash `pipe` output plugin. Do not advise users to install this until the chart is fixed.',
    helmRepo: 'https://log-10x.github.io/elastic-helm-charts',
    helmRepoAlias: 'log10x-elastic',
    chartRef: 'log10x-elastic/logstash',
    chartAvailability: 'wip',
    primaryImageHint: 'ghcr.io/log-10x/logstash-10x',
    primaryContainerName: 'logstash',
    hasTenxSidecar: false,
    selectorStyle: 'legacy-helm',
    selectorLabel: (r) => legacyElasticSelector(r, 'logstash'),
    renderValues: ({ licenseJwt, releaseName, destination, outputHost, gitToken, optimize, readOnly, backends, backendCredentials, airgapped }) => {
      const output = renderLogstashOutput(destination, outputHost);
      const featureFlags = renderTenxFeatureFlags({ optimize, readOnly });
      const extras = renderTenxExtraArgsAndEnv({ backends, backendCredentials, airgapped, airgappedAsEnvVar: true });
      return `tenx:
  enabled: true
  licenseJwt: "${licenseJwt}"
  runtimeName: "${releaseName}"${featureFlags}${extras}

# Avoid chart defaults hardcoding Elasticsearch credentials/mounts.
extraEnvs: []
secretMounts: []

logstashPipeline:
  output.conf: |
${indent(output, 4)}
`;
    },
    verifyProbes: ({ releaseName, namespace, destination }) => {
      const sel = legacyElasticSelector(releaseName, 'logstash');
      const probes = [
        {
          name: 'pods-ready',
          question: 'Are all Logstash+Reporter StatefulSet pods Ready?',
          commands: [`kubectl -n ${namespace} wait --for=condition=Ready pod -l ${sel} --timeout=10m`],
          expectOutput: 'condition met',
          timeoutSec: 600,
        },
        {
          name: 'processor-alive',
          question: 'Is the 10x filter plugin loaded in the logstash container?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c logstash --tail=400 | grep -iE 'tenx|10x|pattern' | head -20`,
          ],
        },
      ];
      if (destination === 'mock') {
        probes.push({
          name: 'tenx-mock-events',
          question: 'Are tagged [TENX-MOCK] events reaching stdout?',
          commands: [`kubectl -n ${namespace} logs -l ${sel} -c logstash --tail=200 | grep -F 'TENX-MOCK' | head -5`],
          expectOutput: 'TENX-MOCK',
          timeoutSec: 180,
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
      'Upstream `vector/vector` chart with a `tenx:` values overlay that injects the 10x engine into the Vector pod. No log10x fork.',
    helmRepo: 'https://helm.vector.dev',
    helmRepoAlias: 'vector',
    chartRef: 'vector/vector',
    chartAvailability: 'upstream-fallback',
    primaryImageHint: 'timberio/vector',
    primaryContainerName: 'vector',
    hasTenxSidecar: false,
    selectorStyle: 'k8s-recommended',
    selectorLabel: (r) => k8sRecommendedSelector(r),
    renderValues: ({ licenseJwt, releaseName, gitToken, optimize, readOnly, backends, backendCredentials, airgapped }) => {
      const featureFlags = renderTenxFeatureFlags({ optimize, readOnly });
      const extras = renderTenxExtraArgsAndEnv({ backends, backendCredentials, airgapped, airgappedAsEnvVar: true });
      // NOTE: this values overlay is a placeholder. The canonical Vector
      // overlay shape (sources/transforms/sinks wiring for the tenx
      // sidecar) is documented in mksite/docs/apps/receiver/deploy.md and
      // should land here verbatim once stable. The `tenx:` block follows
      // the same convention as the other forwarder charts.
      return `tenx:
  enabled: true
  licenseJwt: "${licenseJwt}"${featureFlags}
  runtimeName: "${releaseName}"${extras}

# TODO: Add the Vector sources/transforms/sinks wiring per
# mksite/docs/apps/receiver/deploy.md once the canonical overlay
# is finalized. The default vector/vector chart deploys an empty
# pipeline, so the install will succeed but no events flow until
# this block is filled in.
`;
    },
    verifyProbes: ({ releaseName, namespace, destination }) => {
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
          question: 'Are all Vector pods Ready?',
          commands: [`kubectl -n ${namespace} wait --for=condition=Ready pod -l ${sel} --timeout=5m`],
          expectOutput: 'condition met',
          timeoutSec: 300,
        },
        {
          name: 'processor-alive',
          question: 'Is the 10x sidecar reachable from the Vector container?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c vector --tail=400 | grep -iE 'tenx|10x|pattern' | head -20`,
          ],
        },
      ];
      if (destination === 'mock') {
        probes.push({
          name: 'tenx-mock-events',
          question: 'Are tagged [TENX-MOCK] events reaching stdout?',
          commands: [`kubectl -n ${namespace} logs -l ${sel} -c vector --tail=200 | grep -F 'TENX-MOCK' | head -5`],
          expectOutput: 'TENX-MOCK',
          timeoutSec: 120,
        });
      }
      return probes;
    },
  },

  'otel-collector': {
    label: 'OTel Collector',
    integrationMode:
      'DaemonSet using the log10x-repackaged chart `log10x-otel/opentelemetry-collector`. Uses the chart\'s hidden `logs/to-tenx` pipeline with a syslog exporter over a Unix socket; the 10x logic runs inside the collector container.',
    helmRepo: 'https://log-10x.github.io/opentelemetry-helm-charts',
    helmRepoAlias: 'log10x-otel',
    chartRef: 'log10x-otel/opentelemetry-collector',
    chartAvailability: 'published',
    primaryImageHint: 'ghcr.io/log-10x/opentelemetry-collector',
    primaryContainerName: 'opentelemetry-collector',
    hasTenxSidecar: false,
    selectorStyle: 'k8s-recommended',
    selectorLabel: (r) => k8sRecommendedSelector(r),
    renderValues: ({ licenseJwt, releaseName, destination, outputHost, gitToken, optimize, readOnly, backends, backendCredentials, airgapped }) => {
      // The OTel chart doesn't auto-wire filelog unless the preset is
      // on. We turn it on explicitly so the user's pipeline just works.
      // image.repository is required by the chart and has no default.
      const exporter = renderOtelExporter(destination, outputHost);
      // Same as fluent-bit: chart values expose optimize + readOnly
      // booleans directly; chart templates wire them to the matching
      // engine launch args (and gate the fluentforward / from-tenx
      // pipeline when readOnly is true).
      const featureFlags = renderTenxFeatureFlags({ optimize, readOnly });
      const extras = renderTenxExtraArgsAndEnv({ backends, backendCredentials, airgapped, airgappedAsEnvVar: true });
      return `mode: "daemonset"

# image.repository defaults in the chart's values.yaml to the upstream
# contrib image (otel/opentelemetry-collector-contrib), which is
# public. Override here if you want the log10x-repackaged image and
# have configured the necessary imagePullSecrets.

tenx:
  enabled: true
  licenseJwt: "${licenseJwt}"${featureFlags}
  runtimeName: "${releaseName}"${extras}

# Turn on the chart's filelog logsCollection preset so the receiver
# is actually wired up; advising pipeline.receivers without this
# results in "references receiver 'filelog' which is not configured".
presets:
  logsCollection:
    enabled: true
    includeCollectorLogs: false

config:
  exporters:
${indent(exporter, 4)}
  service:
    pipelines:
      logs:
        receivers: [filelog]
        processors: [memory_limiter, batch]
        exporters: [${destination === 'mock' ? 'debug' : 'elasticsearch'}]
`;
    },
    verifyProbes: ({ releaseName, namespace, destination }) => {
      const sel = k8sRecommendedSelector(releaseName);
      const probes = [
        {
          name: 'pods-ready',
          question: 'Are all OTel Collector pods Ready?',
          commands: [`kubectl -n ${namespace} wait --for=condition=Ready pod -l ${sel} --timeout=5m`],
          expectOutput: 'condition met',
          timeoutSec: 300,
        },
        {
          name: 'processor-alive',
          question: 'Is the 10x syslog exporter pipeline wired and emitting?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c opentelemetry-collector --tail=400 | grep -iE 'tenx|10x|pattern' | head -20`,
          ],
        },
      ];
      if (destination === 'mock') {
        probes.push({
          name: 'tenx-mock-events',
          question: 'Are tagged [TENX-MOCK] events reaching the debug exporter?',
          commands: [`kubectl -n ${namespace} logs -l ${sel} -c opentelemetry-collector --tail=200 | grep -F 'TENX-MOCK' | head -5`],
          expectOutput: 'TENX-MOCK',
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
// REPORTER_FORWARDER_SPECS because the spec map is keyed by "which user
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

/** Indent every line of `s` by `spaces` spaces. */
function indent(s: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return s
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}
