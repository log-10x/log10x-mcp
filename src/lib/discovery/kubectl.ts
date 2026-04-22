/**
 * Read-only kubectl probes for the install advisor.
 *
 * Philosophy:
 *   - Every probe is best-effort. A probe failing never aborts the rest —
 *     we just record it in probeLog and move on. Most customers won't
 *     give us cluster-wide RBAC on every kind, and the advisor should
 *     still produce useful output from partial data.
 *   - Never list huge verbs cluster-wide (e.g., `get pods -A`). Scope to
 *     probed namespaces. Default: caller-supplied namespaces + `kube-system`.
 *   - No writes. No --dry-run=server (still counts as a write for RBAC).
 */

import { run, runJson, type ShellResult } from './shell.js';
import { classifyForwarderImage, classifyLog10xApp, isLog10xImage } from './forwarder-detect.js';
import type {
  DetectedForwarder,
  DetectedLog10xApp,
  ForwarderKind,
  HelmRelease,
  KubectlProbes,
  ProbeLogEntry,
} from './types.js';

/** The namespaces we always try to probe if not told otherwise. */
const DEFAULT_NAMESPACE_CANDIDATES = ['demo', 'logging', 'observability', 'otel-demo', 'default'];

/** System namespaces to skip when auto-selecting what to probe. */
const SKIP_NAMESPACES = new Set([
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'local-path-storage',
  'metrics-server',
]);

export interface KubectlProbeOpts {
  /** Explicit namespaces to probe. If absent, we auto-pick up to 5. */
  namespaces?: string[];
  /** Per-call timeout. Default 10_000ms. */
  timeoutMs?: number;
}

/**
 * Run the full set of kubectl probes. Returns a `KubectlProbes` record
 * plus the probe-log entries to append to the snapshot's audit log.
 */
export async function probeKubectl(
  opts: KubectlProbeOpts = {}
): Promise<{ probes: KubectlProbes; log: ProbeLogEntry[] }> {
  const log: ProbeLogEntry[] = [];
  const record = (r: ShellResult): void => {
    log.push({
      cmd: r.cmd,
      exitCode: r.exitCode,
      ms: r.ms,
      stderrSnippet: r.exitCode === 0 ? undefined : r.stderr.slice(0, 400) || undefined,
    });
  };

  // Step 1: can we talk to the cluster at all?
  const version = await run('kubectl', ['version', '--output=json'], { timeoutMs: opts.timeoutMs ?? 10_000 });
  record(version);
  if (version.exitCode !== 0) {
    return {
      probes: {
        available: false,
        error: version.stderr.slice(0, 400) || 'kubectl not usable',
        namespaces: [],
        probedNamespaces: [],
        forwarders: [],
        helmReleases: [],
        log10xApps: [],
        storageClasses: [],
        ingressClasses: [],
        serviceAccountIrsa: [],
      },
      log,
    };
  }

  // Step 2: current context + default namespace.
  const ctx = await run('kubectl', ['config', 'current-context'], { timeoutMs: 5_000 });
  record(ctx);
  const ns = await run('kubectl', ['config', 'view', '--minify', '--output=jsonpath={..namespace}'], {
    timeoutMs: 5_000,
  });
  record(ns);

  // Step 3: enumerate namespaces.
  const nsList = await runJson<{ items: Array<{ metadata: { name: string } }> }>(
    'kubectl',
    ['get', 'namespaces', '-o', 'json'],
    { timeoutMs: opts.timeoutMs ?? 10_000 }
  );
  record(nsList.result);
  const allNs = (nsList.parsed?.items ?? []).map((i) => i.metadata.name);

  // Step 4: pick probed namespaces. If caller specified, trust them.
  let probedNs: string[];
  if (opts.namespaces && opts.namespaces.length > 0) {
    probedNs = opts.namespaces.filter((n) => allNs.includes(n) || allNs.length === 0);
  } else {
    const preferred = DEFAULT_NAMESPACE_CANDIDATES.filter((n) => allNs.includes(n));
    const rest = allNs.filter((n) => !preferred.includes(n) && !SKIP_NAMESPACES.has(n));
    probedNs = [...preferred, ...rest.slice(0, Math.max(0, 5 - preferred.length))];
  }
  // Always include kube-system for forwarder detection (most common install location).
  if (!probedNs.includes('kube-system') && allNs.includes('kube-system')) probedNs.push('kube-system');

  // Step 5: forwarder + log10x detection across probed namespaces.
  const forwarders: DetectedForwarder[] = [];
  const log10xApps: DetectedLog10xApp[] = [];
  const helmReleases = await probeHelmReleases(record, opts.timeoutMs);

  for (const n of probedNs) {
    const { forwarders: f, apps } = await probeWorkloadsInNamespace(
      n,
      helmReleases,
      record,
      opts.timeoutMs
    );
    forwarders.push(...f);
    log10xApps.push(...apps);
  }

  // Step 6: cluster-scoped metadata (storage classes, ingress classes).
  const sc = await runJson<{ items: Array<{ metadata: { name: string } }> }>(
    'kubectl',
    ['get', 'storageclasses', '-o', 'json'],
    { timeoutMs: 8_000 }
  );
  record(sc.result);
  const storageClasses = (sc.parsed?.items ?? []).map((i) => i.metadata.name);

  const ic = await runJson<{ items: Array<{ metadata: { name: string } }> }>(
    'kubectl',
    ['get', 'ingressclasses', '-o', 'json'],
    { timeoutMs: 8_000 }
  );
  record(ic.result);
  const ingressClasses = (ic.parsed?.items ?? []).map((i) => i.metadata.name);

  // Step 7: service-account IRSA annotations in probed namespaces.
  const serviceAccountIrsa: KubectlProbes['serviceAccountIrsa'] = [];
  for (const n of probedNs) {
    const sa = await runJson<{
      items: Array<{
        metadata: { name: string; annotations?: Record<string, string> };
      }>;
    }>('kubectl', ['get', 'serviceaccounts', '-n', n, '-o', 'json'], {
      timeoutMs: 8_000,
    });
    record(sa.result);
    for (const item of sa.parsed?.items ?? []) {
      const roleArn = item.metadata.annotations?.['eks.amazonaws.com/role-arn'];
      if (roleArn) {
        serviceAccountIrsa.push({ namespace: n, name: item.metadata.name, roleArn });
      }
    }
  }

  return {
    probes: {
      available: true,
      context: ctx.stdout.trim(),
      currentNamespace: ns.stdout.trim() || null,
      namespaces: allNs,
      probedNamespaces: probedNs,
      forwarders,
      helmReleases,
      log10xApps,
      storageClasses,
      ingressClasses,
      serviceAccountIrsa,
    },
    log,
  };
}

/** Run `helm list -A -o json` to enumerate all helm releases. */
async function probeHelmReleases(
  record: (r: ShellResult) => void,
  timeoutMs?: number
): Promise<HelmRelease[]> {
  const r = await runJson<
    Array<{
      name: string;
      namespace: string;
      chart: string;
      app_version: string;
      status: string;
      revision: string;
    }>
  >('helm', ['list', '-A', '-o', 'json'], { timeoutMs: timeoutMs ?? 10_000 });
  record(r.result);
  if (!r.parsed) return [];
  return r.parsed.map((h) => ({
    name: h.name,
    namespace: h.namespace,
    chart: h.chart,
    appVersion: h.app_version,
    status: h.status,
    revision: Number(h.revision) || 0,
  }));
}

/**
 * For one namespace, pull DaemonSets/Deployments/StatefulSets/CronJobs
 * and classify each top-level container image. We deliberately skip pods
 * to avoid listing thousands of objects on large clusters — workload
 * controllers give us the authoritative "what's installed" picture.
 */
async function probeWorkloadsInNamespace(
  namespace: string,
  helmReleases: HelmRelease[],
  record: (r: ShellResult) => void,
  timeoutMs?: number
): Promise<{ forwarders: DetectedForwarder[]; apps: DetectedLog10xApp[] }> {
  const forwarders: DetectedForwarder[] = [];
  const apps: DetectedLog10xApp[] = [];

  type WorkloadLike = {
    metadata: { name: string; labels?: Record<string, string> };
    spec?: {
      template?: {
        spec?: { containers?: Array<{ name: string; image: string }> };
      };
    };
    status?: { readyReplicas?: number; numberReady?: number };
  };

  async function fetchKind(
    kind: 'DaemonSet' | 'Deployment' | 'StatefulSet' | 'CronJob',
    apiVerb: string
  ): Promise<WorkloadLike[]> {
    const r = await runJson<{ items: WorkloadLike[] }>(
      'kubectl',
      ['get', apiVerb, '-n', namespace, '-o', 'json'],
      { timeoutMs: timeoutMs ?? 10_000 }
    );
    record(r.result);
    return r.parsed?.items ?? [];
  }

  const dsItems = await fetchKind('DaemonSet', 'daemonsets');
  const depItems = await fetchKind('Deployment', 'deployments');
  const ssItems = await fetchKind('StatefulSet', 'statefulsets');

  // CronJobs have a different shape — jobTemplate.spec.template.spec.containers
  const cjRaw = await runJson<{
    items: Array<{
      metadata: { name: string; labels?: Record<string, string> };
      spec?: {
        jobTemplate?: {
          spec?: { template?: { spec?: { containers?: Array<{ name: string; image: string }> } } };
        };
      };
    }>;
  }>('kubectl', ['get', 'cronjobs', '-n', namespace, '-o', 'json'], { timeoutMs: timeoutMs ?? 10_000 });
  record(cjRaw.result);

  function processWorkload(
    workloadKind: 'DaemonSet' | 'Deployment' | 'StatefulSet' | 'CronJob',
    w: WorkloadLike,
    containers: Array<{ name: string; image: string }> | undefined,
    readyReplicas: number
  ): void {
    const labels = w.metadata.labels ?? {};
    // Prefer longest-matching release name so `tenx-streamer-streamer-10x-stream-worker`
    // matches helm release `tenx-streamer`, not `tenx`. Exact label match wins outright.
    const instanceLabel = labels['app.kubernetes.io/instance'];
    const nsReleases = helmReleases.filter((h) => h.namespace === namespace);
    const helmRel =
      nsReleases.find((h) => h.name === instanceLabel) ??
      nsReleases
        .filter((h) => w.metadata.name.startsWith(h.name))
        .sort((a, b) => b.name.length - a.name.length)[0];

    // First pass: does ANY container look like a log10x app image? If so,
    // we classify the whole workload as a log10x app and skip forwarder
    // classification entirely — this prevents fluent-bit sidecars inside
    // log10x streamer/regulator pods from being mis-detected as a customer
    // forwarder.
    const log10xContainer = (containers ?? []).find(
      (c) => isLog10xImage(c.image) || classifyLog10xApp(c.image, labels, helmRel?.chart) !== 'unknown'
    );
    if (log10xContainer) {
      const appKind = classifyLog10xApp(log10xContainer.image, labels, helmRel?.chart);
      if (appKind !== 'unknown') {
        apps.push({
          kind: appKind,
          namespace,
          workloadKind,
          workloadName: w.metadata.name,
          image: log10xContainer.image,
          helmRelease: helmRel?.name,
          labels,
        });
        return;
      }
    }

    // Second pass: classify forwarders (primary container only). CronJobs
    // are never forwarders — they're batch workloads.
    if (workloadKind === 'CronJob') return;
    for (const c of containers ?? []) {
      const kind: ForwarderKind = classifyForwarderImage(c.image);
      if (kind !== 'unknown') {
        forwarders.push({
          kind,
          namespace,
          workloadKind,
          workloadName: w.metadata.name,
          image: c.image,
          containerName: c.name,
          labels,
          readyReplicas,
        });
        // One forwarder per workload is enough — avoid double-reporting if
        // multiple containers match.
        break;
      }
    }
  }

  for (const ds of dsItems) {
    processWorkload('DaemonSet', ds, ds.spec?.template?.spec?.containers, ds.status?.numberReady ?? 0);
  }
  for (const dep of depItems) {
    processWorkload('Deployment', dep, dep.spec?.template?.spec?.containers, dep.status?.readyReplicas ?? 0);
  }
  for (const ss of ssItems) {
    processWorkload('StatefulSet', ss, ss.spec?.template?.spec?.containers, ss.status?.readyReplicas ?? 0);
  }
  for (const cj of cjRaw.parsed?.items ?? []) {
    const containers = cj.spec?.jobTemplate?.spec?.template?.spec?.containers;
    processWorkload(
      'CronJob',
      { metadata: cj.metadata, status: {} },
      containers,
      0
    );
  }

  return { forwarders, apps };
}
