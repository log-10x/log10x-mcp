/**
 * Classify a container image as a known forwarder kind (or log10x app).
 *
 * Image-string matching, highest-specificity first. We match on substrings
 * because registry host + tag vary wildly in the wild:
 *   - `public.ecr.aws/fluent/fluent-bit:3.2`
 *   - `cr.fluentbit.io/fluent/fluent-bit:3.2`
 *   - `ghcr.io/log-10x/fluent-bit-10x:latest`
 *   - `docker.elastic.co/beats/filebeat:8.15.0`
 *   - `docker.elastic.co/logstash/logstash:8.15.0`
 *   - `otel/opentelemetry-collector-contrib:0.108.0`
 *
 * Returns 'unknown' when nothing matches — callers can still surface the
 * raw image so a human can override.
 *
 * Vector is intentionally NOT classified as a forwarder the advisor can
 * install today: no log10x-repackaged Vector image ships, and the config
 * repo has no vector input/report modules. If a customer is running
 * Vector, it surfaces as `unknown` and the advisor falls back to asking
 * which supported forwarder to install.
 */

import type { ForwarderKind, Log10xAppKind } from './types.js';

/** Heuristic forwarder classifier. Order matters — specific before generic. */
export function classifyForwarderImage(image: string): ForwarderKind {
  const s = image.toLowerCase();
  // fluent-bit must be checked BEFORE fluentd because "fluent-bit" contains "fluent".
  if (s.includes('fluent-bit') || s.includes('fluentbit')) return 'fluentbit';
  if (s.includes('fluentd') || s.includes('fluent/fluentd')) return 'fluentd';
  if (s.includes('filebeat')) return 'filebeat';
  if (s.includes('logstash')) return 'logstash';
  if (s.includes('opentelemetry-collector') || s.includes('otel/collector') || s.includes('otel/opentelemetry'))
    return 'otel-collector';
  // Vector — Datadog's forwarder. Image refs: `timberio/vector`, `datadog/vector`.
  if (s.includes('timberio/vector') || s.includes('datadog/vector') || s.includes('vector:')) return 'vector';
  return 'unknown';
}

/**
 * Classify a log10x app workload by its image + label set + helm chart.
 *
 * The most reliable signal in practice is the `helm.sh/chart` label,
 * which every log10x helm chart stamps (`retriever-10x-X.Y.Z`,
 * `cron-10x-X.Y.Z`, `fluentd-X.Y.Z`, `fluent-bit-X.Y.Z`, etc.). We
 * consult that first, then fall back to image/name heuristics for
 * customers who've stripped the chart label.
 */
export function classifyLog10xApp(
  image: string,
  labels: Record<string, string>,
  helmChart?: string
): Log10xAppKind {
  const imgLc = image.toLowerCase();
  const chartLabel = (labels['helm.sh/chart'] ?? '').toLowerCase();
  const chart = ((helmChart ?? '') + ' ' + chartLabel).toLowerCase();
  const nameLabel = (labels['app.kubernetes.io/name'] ?? labels['app'] ?? '').toLowerCase();
  const helmName = (labels['app.kubernetes.io/instance'] ?? '').toLowerCase();

  // Retriever: distinct chart family + image family.
  if (
    imgLc.includes('retriever-10x') ||
    chart.includes('retriever-10x') ||
    nameLabel.includes('retriever')
  ) {
    return 'retriever';
  }

  // Reporter vs Receiver both use cron-10x chart — disambiguate via
  // release name (cloud-reporter / policy-gen) or explicit workload name.
  if (helmName.includes('cloud-reporter') || helmName.includes('reporter')) return 'reporter';
  if (helmName.includes('policy-gen') || helmName.includes('receiver')) return 'receiver';

  // Compiler (edge compact sidecar) — classify but not in install-advisor scope.
  if (imgLc.includes('compiler-10x') || chart.includes('compiler')) return 'compiler';

  // Receiver fallback: the pipeline-10x image (ghcr.io/log-10x/pipeline-10x-dev,
  // ghcr.io/log-10x/pipeline-10x, log10x/pipeline-10x) is the Receiver / Reducer
  // container. Match any workload whose primary container carries this image,
  // including dev-branch builds where the helm instance label is absent or
  // non-standard (e.g. tenx-fluentd DaemonSet on otel-demo).
  if (imgLc.includes('pipeline-10x') || imgLc.includes('pipeline-tenx')) return 'receiver';

  // Workload-name heuristics as a last resort when the image is a log-10x org
  // image we couldn't pin by image name. The name label is the most reliable
  // remaining signal — e.g. `app.kubernetes.io/name: tenx-receiver`.
  if (nameLabel.includes('receiver') || nameLabel.includes('reducer')) return 'receiver';

  // Last resort: a log-10x image we couldn't pin to a specific app.
  return 'unknown';
}

/** Is this image from the log10x image registries? */
export function isLog10xImage(image: string): boolean {
  const s = image.toLowerCase();
  // x8r1y5t9 is the ECR Public account alias for the log10x Lambda retriever image.
  return (
    s.includes('log-10x/') ||
    s.includes('log10x/') ||
    s.includes('/tenx-') ||
    s.includes('x8r1y5t9/lambda-10x')
  );
}
