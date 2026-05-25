/**
 * Detect metrics-backend agents running in the cluster.
 *
 * The wizard surfaces detected agents as pre-filled options for "where
 * should TenXSummary metrics go" — if the user already runs a Datadog
 * Agent, we offer Datadog as the destination so log10x metrics ride
 * alongside their existing logs/metrics on the same SIEM.
 *
 * Detection is label/name-based: each agent gets a list of matchers, and
 * we walk the cluster's helm releases + workload labels checking for a
 * hit. First match wins per kind. Confidence is graded so the wizard can
 * surface high-confidence detections prominently and treat low-confidence
 * ones as "also detected, maybe."
 *
 * Cheap probe: this all runs against data we ALREADY pulled in
 * `probeKubectl` (helm releases + the workloads we walked for forwarder
 * detection), so no additional shell calls.
 */

import type {
  DetectedMetricsBackend,
  MetricsBackendKind,
  HelmRelease,
  KubectlProbes,
} from './types.js';

/**
 * Per-backend matchers. Order in this array drives the priority — we
 * emit at most ONE entry per `kind`, taking the first matcher that
 * succeeds (so helm-release matches outrank workload-label matches for
 * the same backend, which outrank namespace-only matches).
 */
interface BackendMatcher {
  kind: MetricsBackendKind;
  confidence: DetectedMetricsBackend['confidence'];
  /** Substrings that must appear in the helm release's `chart` field. */
  helmChart?: string[];
  /**
   * Workload labels that confirm this backend. Match is `label[key]` must
   * equal one of the values OR include one of the values as a substring.
   */
  workloadLabel?: { key: string; values: string[] };
  /** Namespace names that strongly imply this backend. */
  namespace?: string[];
  /** Human-readable evidence string. `${X}` placeholders filled at match time. */
  evidenceTemplate: string;
}

const MATCHERS: BackendMatcher[] = [
  // ── Datadog ──
  {
    kind: 'datadog',
    confidence: 'helm-release',
    helmChart: ['datadog-'],
    evidenceTemplate: 'helm release `${name}` (chart `${chart}`) in `${namespace}`',
  },
  {
    kind: 'datadog',
    confidence: 'workload-match',
    workloadLabel: { key: 'app.kubernetes.io/name', values: ['datadog-agent', 'datadog'] },
    evidenceTemplate: 'workload labeled `app.kubernetes.io/name=datadog-agent` in `${namespace}`',
  },
  {
    kind: 'datadog',
    confidence: 'workload-match',
    workloadLabel: { key: 'app', values: ['datadog-agent', 'datadog'] },
    evidenceTemplate: 'workload labeled `app=datadog-agent` in `${namespace}`',
  },

  // ── Splunk Observability / SignalFx ──
  {
    kind: 'signalfx',
    confidence: 'helm-release',
    helmChart: ['splunk-otel-collector-', 'signalfx-agent-'],
    evidenceTemplate: 'helm release `${name}` (chart `${chart}`) in `${namespace}`',
  },
  {
    kind: 'signalfx',
    confidence: 'workload-match',
    workloadLabel: { key: 'app', values: ['splunk-otel-collector', 'signalfx-agent'] },
    evidenceTemplate: 'workload labeled `app=splunk-otel-collector` in `${namespace}`',
  },

  // ── Elastic ──
  {
    kind: 'elastic',
    confidence: 'helm-release',
    helmChart: ['eck-operator-', 'elasticsearch-', 'elastic-agent-'],
    evidenceTemplate: 'helm release `${name}` (chart `${chart}`) in `${namespace}`',
  },
  {
    kind: 'elastic',
    confidence: 'workload-match',
    workloadLabel: { key: 'app', values: ['elastic-agent', 'elasticsearch'] },
    evidenceTemplate: 'workload labeled `app=elastic-agent` in `${namespace}`',
  },
  {
    kind: 'elastic',
    confidence: 'workload-match',
    workloadLabel: { key: 'common.k8s.elastic.co/type', values: ['agent', 'elasticsearch'] },
    evidenceTemplate: 'ECK-managed workload in `${namespace}`',
  },

  // ── Prometheus ──
  {
    kind: 'prometheus',
    confidence: 'helm-release',
    helmChart: ['kube-prometheus-stack-', 'prometheus-operator-', 'prometheus-'],
    evidenceTemplate: 'helm release `${name}` (chart `${chart}`) in `${namespace}`',
  },
  {
    kind: 'prometheus',
    confidence: 'workload-match',
    workloadLabel: {
      key: 'app.kubernetes.io/name',
      values: ['prometheus', 'prometheus-operator', 'kube-prometheus-stack'],
    },
    evidenceTemplate: 'workload labeled `app.kubernetes.io/name=prometheus` in `${namespace}`',
  },

  // ── CloudWatch ──
  {
    kind: 'cloudwatch',
    confidence: 'helm-release',
    helmChart: ['aws-cloudwatch-metrics-', 'amazon-cloudwatch-observability-'],
    evidenceTemplate: 'helm release `${name}` (chart `${chart}`) in `${namespace}`',
  },
  {
    kind: 'cloudwatch',
    confidence: 'workload-match',
    workloadLabel: { key: 'app', values: ['cloudwatch-agent', 'amazon-cloudwatch'] },
    evidenceTemplate: 'workload labeled `app=cloudwatch-agent` in `${namespace}`',
  },
];

/**
 * Run the detection pass over already-pulled probe data. Walks helm
 * releases and the workload labels we have on hand (from forwarder/
 * log10x-app detection) — no extra shell calls.
 *
 * Note on input shape: we accept the FULL `KubectlProbes` rather than
 * just the bits we need so future matchers (e.g., CRD presence, IRSA
 * role arns suggesting CloudWatch) can be added without changing the
 * call site.
 */
export function detectBackendAgents(probes: KubectlProbes): DetectedMetricsBackend[] {
  const seen = new Set<MetricsBackendKind>();
  const results: DetectedMetricsBackend[] = [];

  // Collect every workload label set we have visibility into. Forwarder
  // and log10x-app workloads are both useful here — a Datadog Agent or
  // Prometheus might be sitting right next to the user's forwarder in
  // the same namespace, and we already pulled its labels.
  const workloadLabelSets: Array<{ namespace: string; labels: Record<string, string> }> = [
    ...probes.forwarders.map((f) => ({ namespace: f.namespace, labels: f.labels })),
    ...probes.log10xApps.map((a) => ({ namespace: a.namespace, labels: a.labels })),
  ];

  for (const m of MATCHERS) {
    if (seen.has(m.kind)) continue;

    // Try helm-chart match first.
    if (m.helmChart) {
      const hit = matchHelm(m.helmChart, probes.helmReleases);
      if (hit) {
        results.push({
          kind: m.kind,
          confidence: m.confidence,
          evidence: fillTemplate(m.evidenceTemplate, {
            name: hit.name,
            chart: hit.chart,
            namespace: hit.namespace,
          }),
          namespace: hit.namespace,
        });
        seen.add(m.kind);
        continue;
      }
    }

    // Then workload-label match.
    if (m.workloadLabel) {
      const hit = matchWorkloadLabel(m.workloadLabel, workloadLabelSets);
      if (hit) {
        results.push({
          kind: m.kind,
          confidence: m.confidence,
          evidence: fillTemplate(m.evidenceTemplate, { namespace: hit.namespace }),
          namespace: hit.namespace,
        });
        seen.add(m.kind);
        continue;
      }
    }
  }

  return results;
}

function matchHelm(
  chartSubstrings: string[],
  releases: HelmRelease[]
): HelmRelease | undefined {
  for (const r of releases) {
    const chartLc = r.chart.toLowerCase();
    if (chartSubstrings.some((s) => chartLc.includes(s))) return r;
  }
  return undefined;
}

function matchWorkloadLabel(
  matcher: NonNullable<BackendMatcher['workloadLabel']>,
  workloadLabelSets: Array<{ namespace: string; labels: Record<string, string> }>
): { namespace: string } | undefined {
  for (const w of workloadLabelSets) {
    const val = w.labels[matcher.key];
    if (!val) continue;
    const valLc = val.toLowerCase();
    if (matcher.values.some((v) => valLc === v || valLc.includes(v))) {
      return { namespace: w.namespace };
    }
  }
  return undefined;
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] ?? `?${key}?`);
}
