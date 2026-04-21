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
    renderValues: ({ apiKey, releaseName, destination, outputHost, splunkHecToken, gitToken }) => {
      const outputBlock = renderFluentBitOutput(destination, outputHost, splunkHecToken);
      return `tenx:
  enabled: true
  apiKey: "${apiKey}"
  kind: "report"
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
          commands: [`kubectl -n ${namespace} logs -l ${sel} -c fluent-bit --tail=200 | grep -F '[TENX-MOCK]' | head -5`],
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
    renderValues: ({ apiKey, releaseName, destination, outputHost, splunkHecToken, gitToken }) => {
      // IMPORTANT: fluentd's output config lives UNDER `tenx:`, not
      // as a second top-level `tenx:` block. A prior version of this
      // template emitted two `tenx:` keys and YAML silently dropped
      // the first — losing apiKey/kind/runtimeName/git config entirely.
      const outputConfig = renderFluentdOutputConfig(destination, outputHost, splunkHecToken);
      return `tenx:
  enabled: true
  apiKey: "${apiKey}"
  kind: "report"
  runtimeName: "${releaseName}"
  gitToken: "${gitToken ?? DEFAULT_GIT_TOKEN}"
  config:
    git:
      enabled: true
      url: "https://github.com/log-10x/config.git"
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
          commands: [`kubectl -n ${namespace} logs -l ${sel} -c fluentd --tail=200 | grep -F '[TENX-MOCK]' | head -5`],
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
    renderValues: ({ apiKey, releaseName, destination, outputHost, gitToken }) => {
      // Chart defaults reference Elasticsearch secrets/certs. For a mock
      // install we MUST override extraEnvs/secretMounts to empty so pods
      // don't hang in FailedMount.
      const outputBlock = renderFilebeatOutput(destination, outputHost);
      return `tenx:
  enabled: true
  apiKey: "${apiKey}"
  kind: "report"
  runtimeName: "${releaseName}"
  gitToken: "${gitToken ?? DEFAULT_GIT_TOKEN}"
  config:
    git:
      enabled: true
      url: "https://github.com/log-10x/config.git"

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
      'StatefulSet using the log10x-repackaged Logstash image (`log10x/logstash-10x`). 10x logic runs inside the `logstash` container via a filter plugin. Chart uses legacy Helm labels.',
    helmRepo: 'https://log-10x.github.io/elastic-helm-charts',
    helmRepoAlias: 'log10x-elastic',
    chartRef: 'log10x-elastic/logstash',
    chartAvailability: 'published',
    primaryImageHint: 'ghcr.io/log-10x/logstash-10x',
    primaryContainerName: 'logstash',
    hasTenxSidecar: false,
    selectorStyle: 'legacy-helm',
    selectorLabel: (r) => legacyElasticSelector(r, 'logstash'),
    renderValues: ({ apiKey, releaseName, destination, outputHost, gitToken }) => {
      const output = renderLogstashOutput(destination, outputHost);
      return `tenx:
  enabled: true
  apiKey: "${apiKey}"
  kind: "report"
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
          commands: [`kubectl -n ${namespace} logs -l ${sel} -c logstash --tail=200 | grep -F '[TENX-MOCK]' | head -5`],
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
    renderValues: ({ apiKey, releaseName, destination, outputHost, gitToken }) => {
      // The OTel chart doesn't auto-wire filelog unless the preset is
      // on. We turn it on explicitly so the user's pipeline just works.
      // image.repository is required by the chart and has no default.
      const exporter = renderOtelExporter(destination, outputHost);
      return `mode: "daemonset"

# Required by the chart — no default.
image:
  repository: ghcr.io/log-10x/opentelemetry-collector
  # tag defaults to chart appVersion; pin here if needed.

tenx:
  enabled: true
  apiKey: "${apiKey}"
  kind: "report"
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
          commands: [`kubectl -n ${namespace} logs -l ${sel} -c opentelemetry-collector --tail=200 | grep -F '[TENX-MOCK]' | head -5`],
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

function renderFluentBitOutput(
  destination: OutputDestination,
  outputHost?: string,
  splunkHecToken?: string
): string {
  if (destination === 'mock') {
    return `config:
  outputs: |
    ${MOCK_OUTPUT_NOTE}
    [OUTPUT]
        Name   stdout
        Match  *
        Format json_lines
  filters: |
    [FILTER]
        Name   modify
        Match  *
        Add    _tenx_mock_prefix [TENX-MOCK]`;
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
    // output.console breaks the 10x stdout pipe per chart docs; use
    // output.file into a path only we tail to keep verification clean.
    return `filebeat.inputs:
- type: container
  paths:
  - /var/log/containers/*.log
processors:
- add_fields:
    target: ""
    fields:
      _tenx_mock_prefix: "[TENX-MOCK]"
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
