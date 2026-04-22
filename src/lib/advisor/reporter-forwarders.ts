/**
 * Per-forwarder Helm repo + chart + values templates for the Reporter.
 *
 * Design after first dogfood pass (2026-04-21):
 *   - Every values snippet is a SINGLE coherent YAML doc — no duplicate
 *     top-level keys. The fluentd template had two `tenx:` keys,
 *     silently dropping the real config. Never again.
 *   - Every chart requires `tenx.gitToken` even when pulling a public
 *     repo, because init containers unconditionally mount a secret
 *     derived from it. We default to `"public-repo-no-token-needed"`.
 *   - `primaryContainerName` tells verify probes which container tails
 *     events. 10x runs INSIDE that container in embedded-image mode —
 *     there is no separate `tenx` sidecar for fluent-bit, fluentd,
 *     filebeat, logstash, or the OTel collector. (Vector is the lone
 *     sidecar case and that chart is still WIP.)
 *   - `selectorLabel` returns the correct kubectl label selector for
 *     each chart family. log10x-elastic charts (filebeat/logstash) use
 *     legacy Helm labels (`app=<release>-<chart>,release=<release>`)
 *     rather than `app.kubernetes.io/instance=<release>`. The advisor
 *     must honor this or every `kubectl wait` / `rollout status` /
 *     teardown command silently matches nothing.
 *   - Chart refs correspond to published chart names:
 *       log10x-fluent/fluent-bit     (confirmed live)
 *       log10x-fluent/fluentd        (confirmed live)
 *       log10x-elastic/filebeat      (NOT `-10x`)
 *       log10x-elastic/logstash      (NOT `-10x`)
 *       log10x-otel/opentelemetry-collector  (NOT `otel-collector-10x`)
 *
 * Sources:
 *   - https://github.com/log-10x/fluent-helm-charts
 *   - https://github.com/log-10x/elastic-helm-charts
 *   - https://github.com/log-10x/opentelemetry-helm-charts
 *
 * Vector is intentionally NOT in this map: no log10x-repackaged Vector
 * chart, no log10x/vector-10x image, and no vector forwarder modules in
 * the config repo. If a customer runs Vector, discovery reports it as
 * `unknown` and the advisor asks them to pick a supported forwarder.
 */

import type { ForwarderKind } from '../discovery/types.js';

export type OutputDestination = 'mock' | 'elasticsearch' | 'splunk' | 'datadog' | 'cloudwatch';

/**
 * Which tenx kind this install is for. `report` → Reporter (read-only
 * metric emission). `regulate` → Regulator (read + write events back
 * through the forwarder with mute/sample applied).
 */
export type TenxKind = 'report' | 'regulate';

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
  /** Render the values.yaml as a SINGLE coherent YAML document. */
  renderValues: (opts: {
    apiKey: string;
    releaseName: string;
    destination: OutputDestination;
    /** Tenx kind — report (Reporter app) or regulate (Regulator app). */
    kind: TenxKind;
    outputHost?: string;
    splunkHecToken?: string;
    /** Placeholder emitted into `tenx.gitToken`. Defaults to the public-repo no-op string. */
    gitToken?: string;
  }) => string;
  /** Verify probes — commands that, collectively, prove data is flowing. */
  verifyProbes: (opts: {
    releaseName: string;
    namespace: string;
    destination: OutputDestination;
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

/** k8s-recommended selector: `app.kubernetes.io/instance=<release>`. */
function k8sRecommendedSelector(releaseName: string): string {
  return `app.kubernetes.io/instance=${releaseName}`;
}

/** Legacy helm (elastic-style): `app=<release>-<chart>,release=<release>`. */
function legacyElasticSelector(releaseName: string, chartSubstring: string): string {
  return `app=${releaseName}-${chartSubstring},release=${releaseName}`;
}

// ── The spec map ──

export const REPORTER_FORWARDER_SPECS: Record<Exclude<ForwarderKind, 'unknown'>, ForwarderSpec> = {
  'fluent-bit': {
    label: 'Fluent Bit',
    integrationMode:
      'DaemonSet using the log10x-repackaged Fluent Bit image (`log10x/fluent-bit-10x`). 10x logic is baked into the container via a Lua filter — no separate sidecar.',
    helmRepo: 'https://log-10x.github.io/fluent-helm-charts',
    helmRepoAlias: 'log10x-fluent',
    chartRef: 'log10x-fluent/fluent-bit',
    chartAvailability: 'published',
    primaryImageHint: 'ghcr.io/log-10x/fluent-bit-10x',
    primaryContainerName: 'fluent-bit',
    hasTenxSidecar: false,
    selectorStyle: 'k8s-recommended',
    selectorLabel: (r) => k8sRecommendedSelector(r),
    renderValues: ({ apiKey, releaseName, destination, kind, outputHost, splunkHecToken, gitToken }) => {
      const outputBlock = renderFluentBitOutput(destination, outputHost, splunkHecToken);
      return `tenx:
  enabled: true
  apiKey: "${apiKey}"
  kind: "${kind}"
  runtimeName: "${releaseName}"
  gitToken: "${gitToken ?? DEFAULT_GIT_TOKEN}"
  config:
    git:
      enabled: true
      url: "https://github.com/log-10x/config.git"

${outputBlock}
`;
    },
    verifyProbes: ({ releaseName, namespace, destination }) => {
      const sel = k8sRecommendedSelector(releaseName);
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
          question: 'Is the 10x Lua filter loaded and processing events?',
          commands: [
            `kubectl -n ${namespace} logs -l ${sel} -c fluent-bit --tail=400 | grep -E 'tenx|10x|pattern|lua' | head -20`,
          ],
        },
      ];
      if (destination === 'mock') {
        probes.push({
          name: 'tenx-mock-events',
          question: 'Are tagged [TENX-MOCK] events reaching stdout?',
          commands: [`kubectl -n ${namespace} logs -l ${sel} -c fluent-bit --tail=200 | grep -F 'TENX-MOCK' | head -5`],
          expectOutput: 'TENX-MOCK',
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
    renderValues: ({ apiKey, releaseName, destination, kind, outputHost, splunkHecToken, gitToken }) => {
      // IMPORTANT: fluentd's output config lives UNDER `tenx:`, not
      // as a second top-level `tenx:` block. A prior version of this
      // template emitted two `tenx:` keys and YAML silently dropped
      // the first — losing apiKey/kind/runtimeName/git config entirely.
      const outputConfig = renderFluentdOutputConfig(destination, outputHost, splunkHecToken);
      const fluentdExcludePaths = FORWARDER_EXCLUDE_REGEX.map((g) => `/var/log/containers/${g.replace('.*', '*').replace('\\.log$', '.log')}`)
        .map((g) => `"${g}"`)
        .join(', ');
      return `tenx:
  enabled: true
  apiKey: "${apiKey}"
  kind: "${kind}"
  runtimeName: "${releaseName}"
  gitToken: "${gitToken ?? DEFAULT_GIT_TOKEN}"
  config:
    git:
      enabled: true
      url: "https://github.com/log-10x/config.git"
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
    verifyProbes: ({ releaseName, namespace, destination }) => {
      const sel = k8sRecommendedSelector(releaseName);
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
    renderValues: ({ apiKey, releaseName, destination, kind, outputHost, gitToken }) => {
      // Chart defaults reference Elasticsearch secrets/certs. For a mock
      // install we MUST override extraEnvs/secretMounts to empty so pods
      // don't hang in FailedMount.
      const outputBlock = renderFilebeatOutput(destination, outputHost);
      return `tenx:
  enabled: true
  apiKey: "${apiKey}"
  kind: "${kind}"
  runtimeName: "${releaseName}"
  gitToken: "${gitToken ?? DEFAULT_GIT_TOKEN}"
  config:
    git:
      enabled: true
      url: "https://github.com/log-10x/config.git"

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
    // VERIFIED 2026-04-21: the log10x-elastic/logstash@1.0.6 chart is
    // BROKEN in sidecar mode. The chart runs tenx as a separate pod
    // container reading from its own STDIN, but the tenx-logstash design
    // expects tenx to be a CHILD PROCESS of logstash spawned by the
    // `pipe` output plugin (so tenx's stdin is wired to logstash's pipe).
    // With the chart's layout, tenx.stdin is a tty, it sees no input,
    // and after ~9s the pipeline shuts down. Do NOT ship this path to
    // users until the chart is fixed or a sidecar-capable launcher is
    // added to tenx-edge.
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
    renderValues: ({ apiKey, releaseName, destination, kind, outputHost, gitToken }) => {
      const output = renderLogstashOutput(destination, outputHost);
      return `tenx:
  enabled: true
  apiKey: "${apiKey}"
  kind: "${kind}"
  runtimeName: "${releaseName}"
  gitToken: "${gitToken ?? DEFAULT_GIT_TOKEN}"
  config:
    git:
      enabled: true
      url: "https://github.com/log-10x/config.git"

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
    renderValues: ({ apiKey, releaseName, destination, kind, outputHost, gitToken }) => {
      // The OTel chart doesn't auto-wire filelog unless the preset is
      // on. We turn it on explicitly so the user's pipeline just works.
      // image.repository is required by the chart and has no default.
      const exporter = renderOtelExporter(destination, outputHost);
      return `mode: "daemonset"

# image.repository defaults in the chart's values.yaml to the upstream
# contrib image (otel/opentelemetry-collector-contrib), which is
# public. Override here if you want the log10x-repackaged image and
# have configured the necessary imagePullSecrets.

tenx:
  enabled: true
  apiKey: "${apiKey}"
  kind: "${kind}"
  runtimeName: "${releaseName}"
  gitToken: "${gitToken ?? DEFAULT_GIT_TOKEN}"
  config:
    git:
      enabled: true
      url: "https://github.com/log-10x/config.git"

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
