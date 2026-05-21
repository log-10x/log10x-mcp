/**
 * Per-forwarder drop-rule snippets for `log10x_top_patterns`.
 *
 * Every snippet is grounded in the 10x engine's actual forwarder module
 * at `~/git/l1x-co/config/modules/pipelines/run/modules/input/forwarder/`.
 * Each forwarder has a different mechanism by which the engine adds the
 * `tenx_hash` field on the return path; the drop-rule must filter on
 * that field at the right place in the pipeline (post-sidecar), or the
 * filter will fire on records that don't have the field yet.
 *
 * Each snippet returns `{ language, body, placementNote }`:
 *   - `language` — fence tag for the code block (xml / ini / ruby / yaml)
 *   - `body` — the snippet text, ready to copy-paste
 *   - `placementNote` — where in the user's config the snippet goes,
 *     and why (the "why" anchors the Reader to the engine's mechanism
 *     so they understand the filter isn't arbitrary)
 *
 * The hash-field name is configurable via the engine's
 * `symbolMessageHashField` setting (defaults to `tenx_hash`). Pass the
 * env's actual value as `hashField` so the snippet matches what the
 * sidecar is emitting.
 */

export type ForwarderId =
  | 'fluentd'
  | 'fluent-bit'
  | 'logstash'
  | 'otel-collector'
  | 'filebeat'
  | 'splunk-uf'
  | 'datadog-agent';

export interface ForwarderSnippet {
  language: 'xml' | 'ini' | 'ruby' | 'yaml';
  body: string;
  placementNote: string;
}

export const ALL_FORWARDERS: ForwarderId[] = [
  'fluentd',
  'fluent-bit',
  'logstash',
  'otel-collector',
  'filebeat',
  'splunk-uf',
  'datadog-agent',
];

function snippetFluentd(hash: string, hashField: string): ForwarderSnippet {
  return {
    language: 'xml',
    body: `<label @OUTPUT>
  <filter **>
    @type grep
    <exclude>
      key ${hashField}
      pattern /^${hash}$/
    </exclude>
  </filter>
  <!-- existing destination <match> blocks go below this filter -->
</label>`,
    placementNote:
      'inside the `@OUTPUT` label, before the destination `<match>` ' +
      `blocks. That's where the 10x sidecar's return path adds the ` +
      `\`${hashField}\` field.`,
  };
}

function snippetFluentBit(hash: string, hashField: string): ForwarderSnippet {
  return {
    language: 'ini',
    body: `[FILTER]
    Name    grep
    Match   tenx.*
    Exclude ${hashField} ${hash}`,
    placementNote:
      '`Match` must target `tenx.*` (the 10x return path tags events ' +
      'with `Tag_Prefix tenx.`, and ' +
      `\`${hashField}\` only exists on post-sidecar records).`,
  };
}

function snippetLogstash(hash: string, hashField: string): ForwarderSnippet {
  return {
    language: 'ruby',
    body: `filter {
  if [${hashField}] == "${hash}" {
    drop { }
  }
}`,
    placementNote:
      'inside the destinations pipeline filter block (the one reading ' +
      `from tcp :5045). The ingest pipeline does not see \`${hashField}\`.`,
  };
}

function snippetOtelCollector(hash: string, hashField: string): ForwarderSnippet {
  return {
    language: 'yaml',
    body: `processors:
  filter/drop_pattern:
    error_mode: ignore
    logs:
      log_record:
        - 'attributes["${hashField}"] == "${hash}"'

service:
  pipelines:
    logs/destinations:
      processors: [filter/drop_pattern]`,
    placementNote:
      `the destinations pipeline reads from 10x's OTLP return path. ` +
      `\`${hashField}\` arrives as a log-record attribute there.`,
  };
}

function snippetFilebeat(hash: string, hashField: string): ForwarderSnippet {
  return {
    language: 'yaml',
    body: `processors:
  - drop_event:
      when:
        equals:
          ${hashField}: "${hash}"`,
    placementNote:
      `under the \`unix:\` input that reads back from 10x's Unix socket. ` +
      `\`${hashField}\` arrives as a JSON-decoded field on that input.`,
  };
}

/**
 * splunk-uf uses a file-relay pattern: fluent-bit writes processed events
 * to a file; splunk-uf forwards that file. The drop actually happens at
 * the fluent-bit step, so the snippet is the fluent-bit one — but the
 * placement note explains the relay topology so the Reader doesn't go
 * looking for a `props.conf` edit.
 */
function snippetSplunkUf(hash: string, hashField: string): ForwarderSnippet {
  const inner = snippetFluentBit(hash, hashField);
  return {
    language: inner.language,
    body: inner.body,
    placementNote:
      `splunk-uf uses a file-relay pattern: fluent-bit writes processed events ` +
      `to a file, splunk-uf forwards that file. The drop happens at the ` +
      `fluent-bit step (snippet above).`,
  };
}

/** Same relay pattern as splunk-uf. */
function snippetDatadogAgent(hash: string, hashField: string): ForwarderSnippet {
  const inner = snippetFluentBit(hash, hashField);
  return {
    language: inner.language,
    body: inner.body,
    placementNote:
      `datadog-agent uses a file-relay pattern: fluent-bit writes processed ` +
      `events to a file, the datadog agent forwards that file. The drop ` +
      `happens at the fluent-bit step.`,
  };
}

const SNIPPET_GENERATORS: Record<ForwarderId, (hash: string, hashField: string) => ForwarderSnippet> = {
  fluentd: snippetFluentd,
  'fluent-bit': snippetFluentBit,
  logstash: snippetLogstash,
  'otel-collector': snippetOtelCollector,
  filebeat: snippetFilebeat,
  'splunk-uf': snippetSplunkUf,
  'datadog-agent': snippetDatadogAgent,
};

/**
 * Return the drop-rule snippet for the given forwarder + hash. The
 * `hashField` parameter is the engine's configured
 * `symbolMessageHashField` value (typically `tenx_hash`).
 */
export function dropRuleSnippet(
  forwarder: ForwarderId,
  hash: string,
  hashField: string = 'tenx_hash'
): ForwarderSnippet {
  return SNIPPET_GENERATORS[forwarder](hash, hashField);
}

/** Other forwarders besides the detected one — used to render the
 * "also supports X, Y, Z — ask for syntax" hint. Stable order. */
export function otherForwarders(detected: ForwarderId): ForwarderId[] {
  return ALL_FORWARDERS.filter(f => f !== detected);
}

/**
 * Per-forwarder "how to apply this to the running deployment" steps.
 *
 * Output is a 3-step bash block: discover the config (ConfigMap in
 * k8s, file path on a host), edit it, restart. We can't produce a
 * single self-applying one-liner because:
 *   - the ConfigMap name is install-specific (`fluentd-config`,
 *     `td-agent-config`, `fluent-bit`, etc. — depends on the Helm chart
 *     used)
 *   - the workload kind varies (DaemonSet vs Deployment)
 *   - the namespace varies (logging / kube-system / monitoring / etc.)
 *
 * So we generate templated commands the reader fills in. When
 * `namespace` is provided (pulled from the sample event's k8s metadata),
 * step 3 uses it concretely; otherwise it leaves a `<NAMESPACE>`
 * placeholder.
 *
 * When `isK8s` is false, the discovery step swaps to filesystem
 * inspection + `systemctl reload`.
 */
export interface ApplyInstructions {
  /** Markdown heading text (no leading `**`); caller wraps as needed. */
  heading: string;
  /** Multiline bash, ready for a ```bash fenced block. */
  steps: string;
}

export function applyInstructions(
  forwarder: ForwarderId,
  ctx: { namespace?: string; isK8s: boolean }
): ApplyInstructions {
  // splunk-uf and datadog-agent use a fluent-bit relay; the actual
  // filter edit happens against fluent-bit, so route through.
  const effective: ForwarderId =
    forwarder === 'splunk-uf' || forwarder === 'datadog-agent' ? 'fluent-bit' : forwarder;
  const relayNote =
    forwarder === 'splunk-uf' || forwarder === 'datadog-agent'
      ? `_${forwarder} uses a file-relay pattern: the filter goes in the upstream fluent-bit config, not in ${forwarder} itself._\n\n`
      : '';

  if (!ctx.isK8s) {
    return applyHostInstructions(effective, relayNote);
  }
  return applyK8sInstructions(effective, ctx.namespace, relayNote);
}

function applyK8sInstructions(
  fwd: Exclude<ForwarderId, 'splunk-uf' | 'datadog-agent'>,
  namespace: string | undefined,
  relayNote: string
): ApplyInstructions {
  const ns = namespace ?? '<NAMESPACE>';
  const cmFinder = K8S_CONFIGMAP_FINDER[fwd];
  const restart = K8S_RESTART[fwd];
  const editHint = K8S_EDIT_HINT[fwd];

  const steps = [
    `# 1) find the ${fwd} ConfigMap (the name varies by Helm chart):`,
    `kubectl get cm -A | grep -iE '${cmFinder}'`,
    ``,
    `# 2) edit it and paste the snippet above ${editHint}:`,
    `kubectl edit cm <CONFIGMAP_NAME> -n ${ns}`,
    ``,
    `# 3) restart ${fwd} so the new filter takes effect:`,
    `kubectl rollout restart ${restart} -n ${ns}`,
  ].join('\n');

  return {
    heading: `To apply this to the running ${fwd}`,
    steps: relayNote + steps,
  };
}

function applyHostInstructions(
  fwd: Exclude<ForwarderId, 'splunk-uf' | 'datadog-agent'>,
  relayNote: string
): ApplyInstructions {
  const inspect = HOST_INSPECT[fwd];
  const reload = HOST_RELOAD[fwd];
  const editHint = HOST_EDIT_HINT[fwd];

  const steps = [
    `# 1) locate the ${fwd} config file:`,
    inspect,
    ``,
    `# 2) edit the config and paste the snippet above ${editHint}:`,
    `sudo $EDITOR <config-path>`,
    ``,
    `# 3) reload ${fwd}:`,
    reload,
  ].join('\n');

  return {
    heading: `To apply this to running ${fwd}`,
    steps: relayNote + steps,
  };
}

/** Grep pattern for finding the forwarder's ConfigMap. Tolerant of
 * common naming variants so the reader doesn't miss it. */
const K8S_CONFIGMAP_FINDER: Record<Exclude<ForwarderId, 'splunk-uf' | 'datadog-agent'>, string> = {
  'fluentd': 'fluent|td-agent',
  'fluent-bit': 'fluent-bit|fluentbit',
  'logstash': 'logstash',
  'otel-collector': 'otel|opentelemetry',
  'filebeat': 'filebeat|beats',
};

/** The kubectl resource to restart for each forwarder. DaemonSet is
 * the common shape; logstash + otel-collector deploy as Deployment in
 * many setups, so we name both variants in a comment. */
const K8S_RESTART: Record<Exclude<ForwarderId, 'splunk-uf' | 'datadog-agent'>, string> = {
  'fluentd': 'daemonset/fluentd',
  'fluent-bit': 'daemonset/fluent-bit',
  'logstash': 'deployment/logstash    # or daemonset/logstash, depending on install',
  'otel-collector': 'daemonset/otel-collector-agent    # or deployment/otel-collector',
  'filebeat': 'daemonset/filebeat',
};

const K8S_EDIT_HINT: Record<Exclude<ForwarderId, 'splunk-uf' | 'datadog-agent'>, string> = {
  'fluentd': 'inside the existing <label @OUTPUT> section',
  'fluent-bit': 'in the filters section (after existing [FILTER] blocks)',
  'logstash': 'inside the destinations pipeline filter block',
  'otel-collector': 'into processors:, then add filter/drop_pattern to your logs pipeline',
  'filebeat': 'under processors: (top-level, alongside existing processors)',
};

const HOST_INSPECT: Record<Exclude<ForwarderId, 'splunk-uf' | 'datadog-agent'>, string> = {
  'fluentd': `sudo grep -l 'label @OUTPUT' /etc/fluent*/*.conf /etc/td-agent/*.conf 2>/dev/null`,
  'fluent-bit': `ls /etc/fluent-bit/*.conf /opt/fluent-bit/etc/*.conf 2>/dev/null`,
  'logstash': `ls /etc/logstash/conf.d/*.conf 2>/dev/null`,
  'otel-collector': `ls /etc/otelcol/*.yaml /etc/otel-collector/*.yaml 2>/dev/null`,
  'filebeat': `ls /etc/filebeat/filebeat.yml 2>/dev/null`,
};

const HOST_RELOAD: Record<Exclude<ForwarderId, 'splunk-uf' | 'datadog-agent'>, string> = {
  'fluentd': `sudo systemctl reload fluentd    # or:  sudo systemctl reload td-agent`,
  'fluent-bit': `sudo systemctl restart fluent-bit`,
  'logstash': `sudo systemctl restart logstash`,
  'otel-collector': `sudo systemctl restart otelcol    # or whichever unit name your install uses`,
  'filebeat': `sudo systemctl restart filebeat`,
};

const HOST_EDIT_HINT: Record<Exclude<ForwarderId, 'splunk-uf' | 'datadog-agent'>, string> = K8S_EDIT_HINT;
