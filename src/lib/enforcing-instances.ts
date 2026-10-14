/**
 * How many Receiver instances enforce a container's cap.
 *
 * The rate regulator counts bytes per pattern per container inside each
 * Receiver. A DaemonSet Receiver sees only the pods on its own node, so a cap
 * derived from a container's fleet-wide rate must be divided by the nodes that
 * container's pods run on. A Receiver beside a central forwarder sees the
 * container's whole stream, so its cap is not divided.
 */

export type ReceiverMode = 'daemonset' | 'sidecar';

/** Where an instance count came from, stated beside it in the plan. */
export type InstanceBasis = 'argument' | 'discovery' | 'pod_list' | 'sidecar' | 'unknown';

export interface EnforcingInstances {
  mode: ReceiverMode;
  byContainer: Record<string, { instances: number; basis: InstanceBasis }>;
}

export function resolveEnforcingInstances(
  containers: string[],
  opts: {
    mode?: ReceiverMode;
    /** Caller-supplied node counts, keyed by container. */
    nodesByContainer?: Record<string, number>;
    /** Node counts from a discover_env snapshot. */
    discovered?: Record<string, number>;
    /** Node counts from the pods a POC listed. */
    fromPods?: Record<string, number>;
  },
): EnforcingInstances {
  const mode = opts.mode ?? 'daemonset';
  const byContainer: EnforcingInstances['byContainer'] = {};
  for (const c of containers) {
    if (mode === 'sidecar') {
      byContainer[c] = { instances: 1, basis: 'sidecar' };
      continue;
    }
    const pick = (src: Record<string, number> | undefined): number | undefined => {
      const n = src?.[c];
      return n != null && Number.isFinite(n) && n >= 1 ? Math.round(n) : undefined;
    };
    const arg = pick(opts.nodesByContainer);
    const disc = pick(opts.discovered);
    const pods = pick(opts.fromPods);
    if (arg != null) byContainer[c] = { instances: arg, basis: 'argument' };
    else if (disc != null) byContainer[c] = { instances: disc, basis: 'discovery' };
    else if (pods != null) byContainer[c] = { instances: pods, basis: 'pod_list' };
    else byContainer[c] = { instances: 1, basis: 'unknown' };
  }
  return { mode, byContainer };
}

export function instancesFor(e: EnforcingInstances | undefined, container: string): number {
  return e?.byContainer[container]?.instances ?? 1;
}

/** A per-window cap for one Receiver: the fleet-wide cap over the instances, at least 1 byte. */
export function perInstanceCap(fleetCapBytes: number, instances: number): number {
  return Math.max(1, Math.round(fleetCapBytes / Math.max(1, instances)));
}

/** The median instance count across containers with a known count; 1 when none is known. */
export function medianInstances(e: EnforcingInstances): { median: number; known: number } {
  const known = Object.values(e.byContainer)
    .filter((v) => v.basis !== 'unknown')
    .map((v) => v.instances)
    .sort((a, b) => a - b);
  if (known.length === 0) return { median: 1, known: 0 };
  const mid = Math.floor(known.length / 2);
  const median = known.length % 2 ? known[mid] : Math.round((known[mid - 1] + known[mid]) / 2);
  return { median, known: known.length };
}

const BASIS_WORDS: Record<InstanceBasis, string> = {
  argument: 'as given',
  discovery: 'from discovery',
  pod_list: 'from the pods sampled',
  sidecar: 'one Receiver sees its whole stream',
  unknown: 'node count unknown',
};

/** "checkout: per node, 3 nodes from discovery" and the like, one per container. */
export function describeInstances(e: EnforcingInstances, container: string): string {
  const v = e.byContainer[container];
  if (!v) return `${container}: node count unknown, written for one Receiver`;
  if (v.basis === 'sidecar') return `${container}: ${BASIS_WORDS.sidecar}, cap not divided`;
  if (v.basis === 'unknown') return `${container}: node count unknown, written for one Receiver`;
  return `${container}: per node, ${v.instances} node${v.instances === 1 ? '' : 's'} ${BASIS_WORDS[v.basis]}`;
}

/** True when any container's count is unknown, so the plan can say what to pass. */
export function anyUnknown(e: EnforcingInstances): boolean {
  return Object.values(e.byContainer).some((v) => v.basis === 'unknown');
}

/**
 * Distinct nodes per container name from `kubectl get pods` JSON items. Keyed
 * by container name because the regulator keys caps by the container field.
 */
export function nodesPerContainerFromPods(
  pods: Array<{ nodeName?: string; containers?: string[] }>,
): Record<string, number> {
  const nodes = new Map<string, Set<string>>();
  for (const p of pods) {
    if (!p.nodeName) continue;
    for (const c of p.containers ?? []) {
      const s = nodes.get(c) ?? new Set<string>();
      s.add(p.nodeName);
      nodes.set(c, s);
    }
  }
  return Object.fromEntries([...nodes].map(([c, s]) => [c, s.size]));
}

/**
 * Divide each `<container>,<bytes>[::<reason>]` row of a caps.csv by the
 * container's enforcing instances. Header and `#` preamble lines pass through.
 */
export function divideCapCsv(capsCsv: string, e: EnforcingInstances): string {
  return capsCsv
    .split('\n')
    .map((line) => {
      const m = /^([^,#][^,]*),(\d+)(.*)$/.exec(line);
      if (!m || m[1] === 'container') return line;
      const n = instancesFor(e, m[1]);
      return `${m[1]},${perInstanceCap(Number(m[2]), n)}${m[3]}`;
    })
    .join('\n');
}
