/**
 * Per-forwarder Helm repo + chart + values templates for the Reporter.
 *
 * Keep each forwarder's spec isolated so a regression in one (e.g.,
 * Vector chart URL changes) doesn't cascade. The `quickstartValues`
 * string is YAML that's already been indented — caller pastes it
 * verbatim into the file step.
 *
 * Sources:
 *   - https://github.com/log-10x/fluent-helm-charts (fluent-bit, fluentd)
 *   - https://github.com/log-10x/elastic-helm-charts (filebeat-10x, logstash-10x)
 *   - https://github.com/log-10x/opentelemetry-helm-charts (otel-collector-10x)
 *   - Vector: log10x-repackaged chart is WIP; fall back to upstream + sidecar pattern
 *     (surfaced via `chartAvailability`).
 */

import type { ForwarderKind } from '../discovery/types.js';

export type OutputDestination = 'mock' | 'elasticsearch' | 'splunk' | 'datadog' | 'cloudwatch';

export interface ForwarderSpec {
  /** Display name for the forwarder (title-cased). */
  label: string;
  /** Short summary of how the Reporter integrates with this forwarder. */
  integrationMode: string;
  /** Helm repo URL. */
  helmRepo: string;
  /** Helm repo alias we'll use in `helm repo add`. */
  helmRepoAlias: string;
  /** Chart reference (e.g., `log10x-fluent/fluent-bit`). */
  chartRef: string;
  /** Whether the log10x-repackaged chart is generally published. */
  chartAvailability: 'published' | 'wip' | 'upstream-fallback';
  /** Default container image reference (for messaging only). */
  primaryImageHint: string;
  /**
   * Return a values.yaml snippet for the supplied destination.
   * Every destination must produce valid YAML for the target chart.
   */
  renderValues: (opts: {
    apiKey: string;
    releaseName: string;
    destination: OutputDestination;
    outputHost?: string;
    splunkHecToken?: string;
  }) => string;
  /**
   * Shell snippets (without `bash ` prefix) that verify data is flowing
   * end-to-end for this forwarder kind. Include commands that read from
   * the Reporter's own stdout, the forwarder's own stdout, and the
   * destination (when possible).
   */
  verifyProbes: (opts: { releaseName: string; namespace: string; destination: OutputDestination }) => Array<{
    name: string;
    question: string;
    commands: string[];
    expectOutput?: string;
    timeoutSec?: number;
  }>;
}

const baseTenxBlock = (apiKey: string, runtimeName: string): string =>
  `tenx:
  enabled: true
  apiKey: "${apiKey}"
  kind: "report"
  runtimeName: "${runtimeName}"
  config:
    git:
      enabled: true
      url: "https://github.com/log-10x/config.git"`;

/** Mock output writes to the pod's stdout so we can tail-verify. */
const MOCK_OUTPUT_NOTE =
  '# Mock output (stdout) — events are written to the forwarder pod stdout so you can tail-verify.';

export const REPORTER_FORWARDER_SPECS: Record<Exclude<ForwarderKind, 'unknown'>, ForwarderSpec> = {
  'fluent-bit': {
    label: 'Fluent Bit',
    integrationMode:
      'DaemonSet alongside (or replacing) your existing Fluent Bit. The Reporter sees the pre-output event stream via a local IPC socket.',
    helmRepo: 'https://log-10x.github.io/fluent-helm-charts',
    helmRepoAlias: 'log10x-fluent',
    chartRef: 'log10x-fluent/fluent-bit',
    chartAvailability: 'published',
    primaryImageHint: 'ghcr.io/log-10x/fluent-bit-10x',
    renderValues: ({ apiKey, releaseName, destination, outputHost, splunkHecToken }) => {
      const tenx = baseTenxBlock(apiKey, releaseName);
      let outputs = '';
      if (destination === 'mock') {
        outputs = `config:
  outputs: |
    ${MOCK_OUTPUT_NOTE}
    [OUTPUT]
        Name   stdout
        Match  *
        Format json_lines`;
      } else if (destination === 'elasticsearch') {
        outputs = `config:
  outputs: |
    [OUTPUT]
        Name   es
        Match  kube.*
        Host   ${outputHost ?? 'elasticsearch-master'}
        Logstash_Format On`;
      } else if (destination === 'splunk') {
        outputs = `config:
  outputs: |
    [OUTPUT]
        Name         splunk
        Match        *
        Host         ${outputHost ?? 'splunk-hec.example.com'}
        Port         8088
        TLS          On
        Splunk_Token ${splunkHecToken ?? 'REPLACE_WITH_HEC_TOKEN'}`;
      }
      return `${tenx}\n\n${outputs}\n`;
    },
    verifyProbes: ({ releaseName, namespace, destination }) => [
      {
        name: 'pods-ready',
        question: 'Are all Reporter pods Ready?',
        commands: [
          `kubectl -n ${namespace} wait --for=condition=Ready pod -l app.kubernetes.io/instance=${releaseName} --timeout=5m`,
        ],
        expectOutput: 'condition met',
        timeoutSec: 300,
      },
      {
        name: 'reporter-processing',
        question: 'Is the 10x sidecar processing events (non-zero metric count in stdout)?',
        commands: [
          `kubectl -n ${namespace} logs -l app.kubernetes.io/instance=${releaseName} -c tenx --tail=200 | grep -E 'pattern|metric|record' | head -20`,
        ],
      },
      ...(destination === 'mock'
        ? [
            {
              name: 'events-flowing',
              question: 'Is the forwarder emitting events to stdout?',
              commands: [
                `kubectl -n ${namespace} logs -l app.kubernetes.io/instance=${releaseName} -c fluent-bit --tail=100 | head -20`,
              ],
              timeoutSec: 60,
            },
          ]
        : []),
    ],
  },

  fluentd: {
    label: 'Fluentd',
    integrationMode:
      'DaemonSet with the Reporter as a sidecar reading the pre-output event stream. Uses the log10x-repackaged fluentd chart (image: `log-10x/fluentd-10x`).',
    helmRepo: 'https://log-10x.github.io/fluent-helm-charts',
    helmRepoAlias: 'log10x-fluent',
    chartRef: 'log10x-fluent/fluentd',
    chartAvailability: 'published',
    primaryImageHint: 'ghcr.io/log-10x/fluentd-10x',
    renderValues: ({ apiKey, releaseName, destination, outputHost, splunkHecToken }) => {
      const tenx = baseTenxBlock(apiKey, releaseName);
      let outputs = '';
      if (destination === 'mock') {
        outputs = `tenx:
  outputConfigs:
    06_final_output.conf: |-
      ${MOCK_OUTPUT_NOTE}
      <label @FINAL-OUTPUT>
        <match **>
          @type stdout
        </match>
      </label>`;
      } else if (destination === 'elasticsearch') {
        outputs = `tenx:
  outputConfigs:
    06_final_output.conf: |-
      <label @FINAL-OUTPUT>
        <match **>
          @type elasticsearch
          host "${outputHost ?? 'elasticsearch-master'}"
          port 9200
        </match>
      </label>`;
      } else if (destination === 'splunk') {
        outputs = `tenx:
  outputConfigs:
    06_final_output.conf: |-
      <label @FINAL-OUTPUT>
        <match **>
          @type splunk_hec
          hec_host ${outputHost ?? 'splunk-hec.example.com'}
          hec_port 8088
          hec_token ${splunkHecToken ?? 'REPLACE_WITH_HEC_TOKEN'}
        </match>
      </label>`;
      }
      return `${tenx}\n\n${outputs}\n`;
    },
    verifyProbes: ({ releaseName, namespace, destination }) => [
      {
        name: 'pods-ready',
        question: 'Are all Reporter pods Ready?',
        commands: [
          `kubectl -n ${namespace} wait --for=condition=Ready pod -l app.kubernetes.io/instance=${releaseName} --timeout=5m`,
        ],
        expectOutput: 'condition met',
        timeoutSec: 300,
      },
      {
        name: 'reporter-processing',
        question: 'Is the 10x sidecar processing events?',
        commands: [
          `kubectl -n ${namespace} logs -l app.kubernetes.io/instance=${releaseName} -c tenx --tail=200 | grep -E 'pattern|metric|record' | head -20`,
        ],
      },
      ...(destination === 'mock'
        ? [
            {
              name: 'events-flowing',
              question: 'Is fluentd emitting events to stdout (mock output)?',
              commands: [
                `kubectl -n ${namespace} logs -l app.kubernetes.io/instance=${releaseName} -c fluentd --tail=100 | head -20`,
              ],
              timeoutSec: 60,
            },
          ]
        : []),
    ],
  },

  filebeat: {
    label: 'Filebeat',
    integrationMode:
      'DaemonSet with the Reporter as a sidecar. Uses the log10x-repackaged filebeat-10x chart.',
    helmRepo: 'https://log-10x.github.io/elastic-helm-charts',
    helmRepoAlias: 'log10x-elastic',
    chartRef: 'log10x-elastic/filebeat-10x',
    chartAvailability: 'published',
    primaryImageHint: 'ghcr.io/log-10x/filebeat-10x',
    renderValues: ({ apiKey, releaseName, destination, outputHost }) => {
      const tenx = baseTenxBlock(apiKey, releaseName);
      let output = '';
      if (destination === 'mock') {
        output = `daemonset:
  filebeatConfig:
    filebeat.yml: |
      filebeat.inputs:
      - type: container
        paths:
        - /var/log/containers/*.log
      # ${MOCK_OUTPUT_NOTE}
      output.console:
        pretty: false`;
      } else if (destination === 'elasticsearch') {
        output = `daemonset:
  filebeatConfig:
    filebeat.yml: |
      filebeat.inputs:
      - type: container
        paths:
        - /var/log/containers/*.log
      output.elasticsearch:
        hosts: ["https://${outputHost ?? 'elasticsearch-master'}:9200"]`;
      }
      return `${tenx}\n\n${output}\n`;
    },
    verifyProbes: ({ releaseName, namespace }) => [
      {
        name: 'pods-ready',
        question: 'Are Filebeat+Reporter DaemonSet pods Ready?',
        commands: [
          `kubectl -n ${namespace} wait --for=condition=Ready pod -l app.kubernetes.io/instance=${releaseName} --timeout=5m`,
        ],
        expectOutput: 'condition met',
        timeoutSec: 300,
      },
      {
        name: 'reporter-processing',
        question: 'Is the 10x sidecar processing events?',
        commands: [
          `kubectl -n ${namespace} logs -l app.kubernetes.io/instance=${releaseName} -c tenx --tail=200 | grep -E 'pattern|metric|record' | head -20`,
        ],
      },
    ],
  },

  vector: {
    label: 'Vector',
    integrationMode:
      'DaemonSet using upstream Vector with the Reporter as a sidecar container. The log10x-repackaged Vector chart is in active development; until it ships, use the upstream Vector Helm chart + manual sidecar.',
    helmRepo: 'https://helm.vector.dev',
    helmRepoAlias: 'vector',
    chartRef: 'vector/vector',
    chartAvailability: 'upstream-fallback',
    primaryImageHint: 'timberio/vector:0.40.0-debian',
    renderValues: ({ apiKey, releaseName, destination, outputHost }) => {
      const tenx = baseTenxBlock(apiKey, releaseName);
      // Vector config is TOML-via-YAML-string. For mock, use the `console` sink.
      let sink = '';
      if (destination === 'mock') {
        sink = `      [sinks.mock_out]
      type = "console"
      inputs = ["kubernetes_logs"]
      encoding.codec = "json"`;
      } else if (destination === 'elasticsearch') {
        sink = `      [sinks.es]
      type = "elasticsearch"
      inputs = ["kubernetes_logs"]
      endpoint = "https://${outputHost ?? 'elasticsearch-master'}:9200"`;
      }
      return `# ${MOCK_OUTPUT_NOTE}
# NOTE: the log10x Vector chart is WIP. This template uses upstream Vector
# with a manually-added tenx sidecar via extraContainers. Confirm
# chart availability via \`helm search repo vector/vector\`.

${tenx}

role: Agent
customConfig:
  data_dir: /vector-data-dir
  sources:
    kubernetes_logs:
      type: kubernetes_logs
  sinks:
${sink}
`;
    },
    verifyProbes: ({ releaseName, namespace }) => [
      {
        name: 'pods-ready',
        question: 'Are Vector+Reporter DaemonSet pods Ready?',
        commands: [
          `kubectl -n ${namespace} wait --for=condition=Ready pod -l app.kubernetes.io/instance=${releaseName} --timeout=5m`,
        ],
        expectOutput: 'condition met',
        timeoutSec: 300,
      },
      {
        name: 'reporter-processing',
        question: 'Is the 10x sidecar processing events?',
        commands: [
          `kubectl -n ${namespace} logs -l app.kubernetes.io/instance=${releaseName} -c tenx --tail=200 | grep -E 'pattern|metric|record' | head -20`,
        ],
      },
    ],
  },

  logstash: {
    label: 'Logstash',
    integrationMode:
      'StatefulSet (Logstash is not a DaemonSet) with the Reporter as a sidecar. Uses the log10x-repackaged logstash-10x chart.',
    helmRepo: 'https://log-10x.github.io/elastic-helm-charts',
    helmRepoAlias: 'log10x-elastic',
    chartRef: 'log10x-elastic/logstash-10x',
    chartAvailability: 'published',
    primaryImageHint: 'ghcr.io/log-10x/logstash-10x',
    renderValues: ({ apiKey, releaseName, destination, outputHost }) => {
      const tenx = baseTenxBlock(apiKey, releaseName);
      let outputs = '';
      if (destination === 'mock') {
        outputs = `# ${MOCK_OUTPUT_NOTE}
logstashPipeline:
  output.conf: |
    output {
      stdout {
        codec => json_lines
      }
    }`;
      } else if (destination === 'elasticsearch') {
        outputs = `logstashPipeline:
  output.conf: |
    output {
      elasticsearch {
        hosts => ["${outputHost ?? 'elasticsearch-master'}:9200"]
        index => "logs-%{+YYYY.MM.dd}"
      }
    }`;
      }
      return `${tenx}\n\n${outputs}\n`;
    },
    verifyProbes: ({ releaseName, namespace }) => [
      {
        name: 'pods-ready',
        question: 'Are Logstash+Reporter StatefulSet pods Ready?',
        commands: [
          `kubectl -n ${namespace} wait --for=condition=Ready pod -l app.kubernetes.io/instance=${releaseName} --timeout=10m`,
        ],
        expectOutput: 'condition met',
        timeoutSec: 600,
      },
      {
        name: 'reporter-processing',
        question: 'Is the 10x sidecar processing events?',
        commands: [
          `kubectl -n ${namespace} logs -l app.kubernetes.io/instance=${releaseName} -c tenx --tail=200 | grep -E 'pattern|metric|record' | head -20`,
        ],
      },
    ],
  },

  'otel-collector': {
    label: 'OTel Collector',
    integrationMode:
      'DaemonSet using the log10x-repackaged otel-collector-10x chart. The Reporter runs as a sidecar and receives events from the collector via a local Unix socket.',
    helmRepo: 'https://log-10x.github.io/opentelemetry-helm-charts',
    helmRepoAlias: 'log10x-otel',
    chartRef: 'log10x-otel/otel-collector-10x',
    chartAvailability: 'published',
    primaryImageHint: 'ghcr.io/log-10x/otel-collector-10x',
    renderValues: ({ apiKey, releaseName, destination, outputHost }) => {
      const tenx = baseTenxBlock(apiKey, releaseName);
      let exporter = '';
      if (destination === 'mock') {
        exporter = `config:
  exporters:
    debug:
      verbosity: basic
  service:
    pipelines:
      logs:
        receivers: [filelog]
        processors: [memory_limiter, batch]
        # ${MOCK_OUTPUT_NOTE}
        exporters: [debug]`;
      } else if (destination === 'elasticsearch') {
        exporter = `config:
  exporters:
    elasticsearch:
      endpoints: ["https://${outputHost ?? 'elasticsearch-master'}:9200"]
      logs_index: logs
  service:
    pipelines:
      logs:
        receivers: [filelog]
        processors: [memory_limiter, batch]
        exporters: [elasticsearch]`;
      }
      return `mode: "daemonset"\n\n${tenx}\n\n${exporter}\n`;
    },
    verifyProbes: ({ releaseName, namespace }) => [
      {
        name: 'pods-ready',
        question: 'Are OTel Collector+Reporter pods Ready?',
        commands: [
          `kubectl -n ${namespace} wait --for=condition=Ready pod -l app.kubernetes.io/instance=${releaseName} --timeout=5m`,
        ],
        expectOutput: 'condition met',
        timeoutSec: 300,
      },
      {
        name: 'reporter-processing',
        question: 'Is the 10x sidecar processing events?',
        commands: [
          `kubectl -n ${namespace} logs -l app.kubernetes.io/instance=${releaseName} -c tenx --tail=200 | grep -E 'pattern|metric|record' | head -20`,
        ],
      },
    ],
  },
};
