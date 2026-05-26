/**
 * Incident-cluster detector. Promoted from the inline TopPatternRow-coupled
 * implementation at `src/lib/top-patterns-render.ts:526-575` into a
 * generic, callable detector. Same algorithm; same conservative thresholds.
 *
 * Why it lives here:
 *   - the standalone `log10x_find_incident_cluster` tool calls this
 *     directly with `IncidentInput[]` synthesized from PromQL queries.
 *   - the existing top-patterns renderer also uses it; it re-imports
 *     `detectIncidents` from this module to keep one source of truth.
 *
 * Algorithm summary:
 *   Two patterns join into a cluster when they SHARE A SERVICE and meet
 *   any of three thresholds on their descriptor tokens (length >= 3,
 *   non-numeric):
 *     1. Jaccard >= 0.5 (strong direct overlap)
 *     2. overlap-coefficient >= 0.6 AND shared-tokens >= 3 (one
 *        descriptor's vocabulary is contained in the other; e.g., raw
 *        error vs same error wrapped in retry/flush text)
 *     3. Jaccard >= 0.2 AND Pearson correlation on the volume time
 *        series >= 0.75 (weak text overlap but co-moving curves)
 *
 *   Union-find collapses transitive joins. Conservative thresholds:
 *   over-merging is the trap SIEMs fall into (Datadog Patterns,
 *   Splunk clustering) and the differentiation comes from being
 *   honest about distinct failures.
 *
 * Confidence reported per cluster reflects the strongest signal that
 * fired:
 *   - 'jaccard_direct'           → confidence = Jaccard (>= 0.5)
 *   - 'overlap_shared'           → confidence = overlap coef (>= 0.6)
 *   - 'jaccard_with_correlation' → confidence = Pearson (>= 0.75)
 *
 * Returns only multi-member clusters (singletons are not "incidents").
 */

/** Generic input row for incident clustering. */
export interface IncidentInput {
  /** Pattern identity (symbolMessage when available, templateHash otherwise). */
  identity: string;
  /** Same-service requirement: only members of the same service can cluster. */
  service?: string;
  /** Human-readable description; tokens drive overlap measures. */
  descriptor: string;
  /** $/mo cost for this pattern, summed across cluster members in the output. */
  costPerMonthUsd: number;
  /** Volume time series for Pearson correlation; can be empty. */
  trendBytesPerSec?: number[];
}

export interface IncidentCluster {
  members: Array<{
    identity: string;
    costPerMonthUsd: number;
    descriptor: string;
  }>;
  /** Verbatim descriptor of the highest-cost member; not synthesized. */
  representativeLabel: string;
  service: string;
  combinedMonthlyUsd: number;
  joinSignal: 'jaccard_direct' | 'overlap_shared' | 'jaccard_with_correlation';
  /** Strength of the join signal that fired (Jaccard, overlap, or Pearson). */
  confidence: number;
}

// Thresholds — calibrated empirically against the otel-demo data
// during prior tuning. Lowering these collapses genuinely distinct
// failures; raising them misses real incidents. Do not adjust without
// re-running the eval harness.
export const INCIDENT_JACCARD_DIRECT = 0.5;
export const INCIDENT_OVERLAP_COEF = 0.6;
export const INCIDENT_MIN_SHARED = 3;
export const INCIDENT_JACCARD_WITH_CORR = 0.2;
export const INCIDENT_CORR = 0.75;

/**
 * Cluster a set of inputs into multi-member incidents.
 *
 * Cost: O(n^2) on token-set comparisons. Acceptable up to ~100 inputs
 * (the typical top_patterns limit). For larger inputs (e.g., wider
 * service slices), the caller should pre-slice by service first to
 * cap n.
 */
export function detectIncidents(inputs: IncidentInput[]): IncidentCluster[] {
  const n = inputs.length;
  if (n < 2) return [];

  const tokens = inputs.map((r) => incidentTokens(r.descriptor));
  // Track which signal fired per joined pair so we can carry the
  // strongest signal forward into the cluster output.
  const parent = Array.from({ length: n }, (_, i) => i);
  const pairSignal = new Map<number, { signal: IncidentCluster['joinSignal']; confidence: number }>();

  const find = (x: number): number =>
    parent[x] === x ? x : (parent[x] = find(parent[x]));
  const union = (a: number, b: number, signal: IncidentCluster['joinSignal'], confidence: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent[ra] = rb;
    // Carry the strongest signal observed for any pair under this root.
    const key = rb;
    const prev = pairSignal.get(key);
    if (!prev || confidence > prev.confidence) {
      pairSignal.set(key, { signal, confidence });
    }
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if ((inputs[i].service || '') !== (inputs[j].service || '')) continue;
      const inter = intersectionSize(tokens[i], tokens[j]);
      const minSize = Math.min(tokens[i].size, tokens[j].size);
      const union2 = tokens[i].size + tokens[j].size - inter;
      const jac = union2 === 0 ? 0 : inter / union2;
      const overlap = minSize === 0 ? 0 : inter / minSize;

      if (jac >= INCIDENT_JACCARD_DIRECT) {
        union(i, j, 'jaccard_direct', jac);
        continue;
      }
      if (overlap >= INCIDENT_OVERLAP_COEF && inter >= INCIDENT_MIN_SHARED) {
        union(i, j, 'overlap_shared', overlap);
        continue;
      }
      if (
        jac >= INCIDENT_JACCARD_WITH_CORR &&
        (inputs[i].trendBytesPerSec?.length ?? 0) >= 3 &&
        (inputs[j].trendBytesPerSec?.length ?? 0) >= 3
      ) {
        const r = pearson(inputs[i].trendBytesPerSec!, inputs[j].trendBytesPerSec!);
        if (r >= INCIDENT_CORR) {
          union(i, j, 'jaccard_with_correlation', r);
        }
      }
    }
  }

  // Collect cluster members by root.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(i);
    else groups.set(root, [i]);
  }

  const clusters: IncidentCluster[] = [];
  for (const [root, idxs] of groups) {
    if (idxs.length < 2) continue;
    // Sort by cost desc so representative is the highest-cost member.
    idxs.sort((a, b) => inputs[b].costPerMonthUsd - inputs[a].costPerMonthUsd);
    const signal = pairSignal.get(root) ?? { signal: 'jaccard_direct' as const, confidence: 0 };
    clusters.push({
      members: idxs.map((i) => ({
        identity: inputs[i].identity,
        costPerMonthUsd: inputs[i].costPerMonthUsd,
        descriptor: inputs[i].descriptor,
      })),
      representativeLabel: inputs[idxs[0]].descriptor,
      service: inputs[idxs[0]].service || '(unattributed)',
      combinedMonthlyUsd: idxs.reduce((s, i) => s + inputs[i].costPerMonthUsd, 0),
      joinSignal: signal.signal,
      confidence: signal.confidence,
    });
  }
  clusters.sort((a, b) => b.combinedMonthlyUsd - a.combinedMonthlyUsd);
  return clusters;
}

/**
 * Tokenize a descriptor into meaningful lowercase tokens. Length >= 3
 * filters out 1-2-char noise; pure-numeric tokens (per-event IPs,
 * ports, counters) are dropped because they correlate spuriously
 * across unrelated patterns.
 */
function incidentTokens(desc: string): Set<string> {
  const out = new Set<string>();
  for (const t of desc.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length < 3 || /^\d+$/.test(t)) continue;
    out.add(t);
  }
  return out;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ax = a.slice(0, n);
  const bx = b.slice(0, n);
  const ma = ax.reduce((s, x) => s + x, 0) / n;
  const mb = bx.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = ax[i] - ma;
    const y = bx[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}
