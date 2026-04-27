/**
 * Local-source POC sampling: pulls log lines directly from the
 * customer's own infrastructure (Kubernetes pods today; docker
 * containers and journald in follow-up work) when no log analyzer
 * connection is available.
 *
 * Use cases:
 *   - Prospect has no Datadog / Splunk / Elastic / etc. connection
 *   - Prospect has the connection but is unwilling to share API
 *     credentials yet (security review pending)
 *   - The SIEM-attached path failed and the LLM agent has explicit
 *     user consent to fall through (caller responsibility)
 *
 * Output framing in the renderer is different from SIEM-attached
 * mode: the dollar figure is NOT a prediction of the prospect's
 * actual bill, because we only see Kubernetes pod stdout — not
 * CloudTrail, ALB access logs, app logs from VMs, or anything else
 * the SIEM ingests. The local-source path renders an industry
 * pricing matrix ("at Datadog list price, this would be $X/yr; at
 * Splunk list price, $Y/yr") and forces the user to declare the
 * sample representative via the sample-composition table.
 */

import { spawn } from 'child_process';

export interface LocalSourceOptions {
  /** Kubernetes namespace; default 'default'. Pass '*' for all namespaces. */
  namespace?: string;
  /**
   * How far back to read logs per pod. Translated to `kubectl logs
   * --since=<window>`. Default '1h'.
   */
  window?: string;
  /** Cap on log lines pulled per pod. Default 5000. */
  perPodLimit?: number;
  /** Cap on number of pods sampled. Default 20. */
  maxPods?: number;
  /** Per-pod kubectl timeout in ms. Default 10000. */
  perPodTimeoutMs?: number;
  /** Override `kubectl` binary path (test seam). */
  kubectlPath?: string;
}

export interface LocalSourceResult {
  /** Raw log lines pulled across all sampled pods. */
  events: string[];
  /** Total bytes pulled (sum of line lengths). */
  totalBytes: number;
  /** Per-source breakdown for the sample-composition table. */
  composition: Array<{ source: string; bytes: number; lines: number; pct: number }>;
  /** Pods that were considered but failed (e.g., access denied). */
  failedPods: string[];
  /** Wall time spent pulling. */
  wallTimeMs: number;
  /** Notes for the report (kubectl-not-installed, no-pods-found, etc.). */
  notes: string[];
}

/**
 * Pull log lines from the customer's Kubernetes cluster and aggregate
 * them by pod for the sample-composition table.
 *
 * Failure modes (any of which set the appropriate note + return what
 * partial data was collected):
 *   - kubectl not installed → returns empty result with note
 *   - no pods in namespace → returns empty with note
 *   - per-pod kubectl logs failure → skip pod, add to `failedPods`
 *   - per-pod timeout → skip pod, add to `failedPods`
 */
export async function sampleFromKubectl(
  opts: LocalSourceOptions = {}
): Promise<LocalSourceResult> {
  const namespace = opts.namespace ?? 'default';
  const window = opts.window ?? '1h';
  const perPodLimit = opts.perPodLimit ?? 5000;
  const maxPods = opts.maxPods ?? 20;
  const perPodTimeoutMs = opts.perPodTimeoutMs ?? 10_000;
  const kubectlPath = opts.kubectlPath ?? 'kubectl';

  const start = Date.now();
  const notes: string[] = [];
  const failedPods: string[] = [];
  const events: string[] = [];
  const compositionMap = new Map<string, { bytes: number; lines: number }>();

  // 1. Enumerate pods.
  let podRefs: Array<{ namespace: string; name: string }>;
  try {
    podRefs = await listPods(kubectlPath, namespace, perPodTimeoutMs);
  } catch (e) {
    const msg = (e as Error).message;
    if (/ENOENT|not found/i.test(msg)) {
      notes.push('kubectl binary not found on PATH — install kubectl or set kubectlPath.');
    } else {
      notes.push(`kubectl get pods failed: ${msg.slice(0, 200)}`);
    }
    return {
      events: [],
      totalBytes: 0,
      composition: [],
      failedPods: [],
      wallTimeMs: Date.now() - start,
      notes,
    };
  }

  if (podRefs.length === 0) {
    notes.push(`No pods found in namespace "${namespace}".`);
    return {
      events: [],
      totalBytes: 0,
      composition: [],
      failedPods: [],
      wallTimeMs: Date.now() - start,
      notes,
    };
  }

  // 2. Random-sample down to maxPods.
  const sampled = pickRandom(podRefs, maxPods);

  // 3. Pull logs per pod, sequentially. Sequential keeps kubectl from
  // hammering the API server; the per-pod call is short-lived.
  for (const pod of sampled) {
    const podKey = `${pod.namespace}/${pod.name}`;
    try {
      const lines = await readPodLogs(
        kubectlPath,
        pod.namespace,
        pod.name,
        window,
        perPodLimit,
        perPodTimeoutMs
      );
      let podBytes = 0;
      for (const line of lines) {
        if (line.length === 0) continue;
        events.push(line);
        podBytes += Buffer.byteLength(line, 'utf8');
      }
      const existing = compositionMap.get(podKey) ?? { bytes: 0, lines: 0 };
      existing.bytes += podBytes;
      existing.lines += lines.length;
      compositionMap.set(podKey, existing);
    } catch (e) {
      failedPods.push(`${podKey}: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  const totalBytes = Array.from(compositionMap.values()).reduce(
    (s, v) => s + v.bytes,
    0
  );

  const composition = Array.from(compositionMap.entries())
    .map(([source, v]) => ({
      source,
      bytes: v.bytes,
      lines: v.lines,
      pct: totalBytes > 0 ? (v.bytes / totalBytes) * 100 : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    events,
    totalBytes,
    composition,
    failedPods,
    wallTimeMs: Date.now() - start,
    notes,
  };
}

/**
 * Pure helper: random subsample without replacement. Exported for tests.
 */
export function pickRandom<T>(items: T[], n: number, rng: () => number = Math.random): T[] {
  if (items.length <= n) return items.slice();
  // Reservoir sampling.
  const reservoir = items.slice(0, n);
  for (let i = n; i < items.length; i++) {
    const j = Math.floor(rng() * (i + 1));
    if (j < n) reservoir[j] = items[i];
  }
  return reservoir;
}

async function listPods(
  kubectlPath: string,
  namespace: string,
  timeoutMs: number
): Promise<Array<{ namespace: string; name: string }>> {
  const args =
    namespace === '*'
      ? ['get', 'pods', '--all-namespaces', '-o', 'json']
      : ['get', 'pods', '-n', namespace, '-o', 'json'];
  const stdout = await runCommand(kubectlPath, args, timeoutMs);
  const parsed = JSON.parse(stdout) as {
    items?: Array<{ metadata?: { namespace?: string; name?: string } }>;
  };
  const items = parsed.items ?? [];
  return items
    .map((it) => ({
      namespace: it.metadata?.namespace ?? '',
      name: it.metadata?.name ?? '',
    }))
    .filter((p) => p.name);
}

async function readPodLogs(
  kubectlPath: string,
  namespace: string,
  pod: string,
  window: string,
  perPodLimit: number,
  timeoutMs: number
): Promise<string[]> {
  const args = [
    'logs',
    '-n',
    namespace,
    pod,
    `--since=${window}`,
    `--tail=${perPodLimit}`,
  ];
  const stdout = await runCommand(kubectlPath, args, timeoutMs);
  return stdout.split('\n').filter((s) => s.length > 0);
}

function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`exit ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}
