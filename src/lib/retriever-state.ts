/**
 * retriever-state.ts — shared helper for resolving Retriever installation state.
 *
 * Resolution order (first fully-matched hit wins):
 *   1. env vars  — __SAVE_LOG10X_RETRIEVER_URL__ + __SAVE_LOG10X_RETRIEVER_BUCKET__
 *   2. snapshot  — installedComponentsDetail.retriever (namespace) + kubectl probe for URL
 *   3. kubectl probe — get svc by chart label, resolve LoadBalancer hostname or ClusterIP
 *   4. none      — no retriever reachable
 *
 * The `source` field on the returned state lets callers emit a
 * `source_disclosure.retriever_state_source` for audit.
 */

import { runJson } from './discovery/shell.js';
import type { DiscoverySnapshot } from './discovery/types.js';

export type RetrieverStateSource = 'env_var' | 'snapshot' | 'kubectl_probe' | 'none';

export interface RetrieverState {
  /** True when a URL + bucket pair was resolved. */
  installed: boolean;
  /** Query-handler URL (no trailing slash). Undefined when not resolved. */
  url?: string;
  /** Index/results S3 bucket. Undefined when not resolved. */
  bucket?: string;
  /**
   * Namespace where the Retriever pod lives.
   * Derived from the snapshot's installedComponentsDetail or kubectl probe.
   */
  namespace?: string;
  /** How the state was resolved — for source_disclosure. */
  source: RetrieverStateSource;
  /** Human-readable trace for audit / doctor output. */
  trace: string[];
}

/**
 * Resolve the Retriever's runtime state.
 *
 * @param snapshot  Optional discovery snapshot. When provided, step 2
 *                  (snapshot-based resolution) is attempted before the
 *                  live kubectl probe.
 */
export async function getRetrieverState(snapshot?: DiscoverySnapshot | null): Promise<RetrieverState> {
  const trace: string[] = [];

  // ── Step 1: explicit env vars ───────────────────────────────────────────────
  const envUrl = process.env.__SAVE_LOG10X_RETRIEVER_URL__;
  const envBucket = process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__;
  if (envUrl && envBucket) {
    trace.push('env_var: matched (__SAVE_LOG10X_RETRIEVER_URL__ + __SAVE_LOG10X_RETRIEVER_BUCKET__)');
    return {
      installed: true,
      url: envUrl.replace(/\/+$/, ''),
      bucket: envBucket,
      source: 'env_var',
      trace,
    };
  }
  trace.push(
    envUrl || envBucket
      ? 'env_var: skipped — only one of the two env vars set'
      : 'env_var: skipped — neither env var set',
  );

  // ── Step 2: snapshot ────────────────────────────────────────────────────────
  if (snapshot) {
    const detail = snapshot.recommendations?.installedComponentsDetail?.retriever;
    if (detail?.installed) {
      trace.push(`snapshot: found retriever in namespace ${detail.namespace}`);
      // Probe for the service URL in the known namespace.
      const svcResult = await probeKubectlRetrieverSvc(detail.namespace);
      if (svcResult.url) {
        trace.push(`snapshot: kubectl svc probe succeeded — ${svcResult.reason}`);
        return {
          installed: true,
          url: svcResult.url,
          bucket: envBucket ?? undefined,   // bucket is not in the snapshot detail; use env if set
          namespace: detail.namespace,
          source: 'snapshot',
          trace,
        };
      }
      trace.push(`snapshot: kubectl svc probe did not resolve URL — ${svcResult.reason}; namespace recorded`);
      // Partial hit: we know the namespace from the snapshot but no URL.
      // Fall through to kubectl_probe (cluster-wide search) which may still
      // find the svc in a different namespace label match.
    } else {
      trace.push('snapshot: no installedComponentsDetail.retriever found');
    }
  } else {
    trace.push('snapshot: not provided');
  }

  // ── Step 3: kubectl probe (cluster-wide) ────────────────────────────────────
  const kResult = await probeKubectlRetrieverSvcAll();
  if (kResult.url) {
    trace.push(`kubectl_probe: matched — ${kResult.reason}`);
    return {
      installed: true,
      url: kResult.url,
      bucket: envBucket ?? undefined,
      namespace: kResult.namespace,
      source: 'kubectl_probe',
      trace,
    };
  }
  trace.push(`kubectl_probe: no service found — ${kResult.reason}`);

  // ── Step 4: nothing resolved ─────────────────────────────────────────────────
  trace.push('none: retriever not reachable from env vars, snapshot, or kubectl probe');
  return { installed: false, source: 'none', trace };
}

// ── private helpers ──────────────────────────────────────────────────────────

/**
 * Probe for the Retriever query-handler Service in a specific namespace.
 * Matches the chart label `app.kubernetes.io/name=retriever-10x` (the chart's
 * app.kubernetes.io/name value).
 */
async function probeKubectlRetrieverSvc(
  namespace: string,
): Promise<{ url?: string; reason: string }> {
  type SvcList = {
    items?: Array<{
      metadata: { name: string; namespace: string };
      spec?: { clusterIP?: string; ports?: Array<{ port: number; name?: string }> };
      status?: { loadBalancer?: { ingress?: Array<{ hostname?: string; ip?: string }> } };
    }>;
  };
  const { result, parsed } = await runJson<SvcList>(
    'kubectl',
    ['get', 'svc', '-n', namespace, '-l', 'app.kubernetes.io/name=retriever-10x', '-o', 'json'],
    { timeoutMs: 8_000 },
  );
  if (result.exitCode !== 0 || !parsed) {
    return { reason: `kubectl get svc in ${namespace} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 120)}` };
  }
  return pickServiceUrl(parsed.items ?? [], namespace);
}

/**
 * Cluster-wide probe — searches all namespaces for the Retriever service.
 */
async function probeKubectlRetrieverSvcAll(): Promise<{ url?: string; namespace?: string; reason: string }> {
  type SvcList = {
    items?: Array<{
      metadata: { name: string; namespace: string };
      spec?: { clusterIP?: string; ports?: Array<{ port: number; name?: string }> };
      status?: { loadBalancer?: { ingress?: Array<{ hostname?: string; ip?: string }> } };
    }>;
  };
  const { result, parsed } = await runJson<SvcList>(
    'kubectl',
    ['get', 'svc', '-A', '-l', 'app.kubernetes.io/name=retriever-10x', '-o', 'json'],
    { timeoutMs: 10_000 },
  );
  if (result.exitCode !== 0 || !parsed) {
    return { reason: `kubectl get svc -A failed (exit ${result.exitCode}): ${result.stderr.slice(0, 120)}` };
  }
  const items = parsed.items ?? [];
  const { url, reason } = pickServiceUrl(items, undefined);
  if (url && items.length > 0) {
    // Derive namespace from the chosen item — find the first match.
    const chosen = items.find((i) =>
      i.metadata.name.includes('query-handler') || i.metadata.name.endsWith('query')
    ) ?? (items.length === 1 ? items[0] : undefined);
    return { url, namespace: chosen?.metadata.namespace, reason };
  }
  return { reason };
}

/**
 * Pick the best URL from a list of service items.
 * Prefers the query-handler service (by name), falls back to the single match.
 * Prefers a LoadBalancer hostname, then LoadBalancer IP, then ClusterIP.
 */
function pickServiceUrl(
  items: Array<{
    metadata: { name: string; namespace: string };
    spec?: { clusterIP?: string; ports?: Array<{ port: number; name?: string }> };
    status?: { loadBalancer?: { ingress?: Array<{ hostname?: string; ip?: string }> } };
  }>,
  defaultNamespace: string | undefined,
): { url?: string; reason: string } {
  if (items.length === 0) {
    return { reason: 'no services with label app.kubernetes.io/name=retriever-10x found' };
  }
  const qh =
    items.find((i) => i.metadata.name.includes('query-handler') || i.metadata.name.endsWith('query')) ??
    (items.length === 1 ? items[0] : undefined);
  if (!qh) {
    return { reason: `${items.length} retriever-10x services found — none clearly a query-handler` };
  }

  const port = qh.spec?.ports?.[0]?.port ?? 8080;
  const ns = qh.metadata.namespace ?? defaultNamespace ?? 'unknown';

  // Prefer LoadBalancer hostname.
  const lbIngress = qh.status?.loadBalancer?.ingress ?? [];
  const hostname = lbIngress.find((e) => e.hostname)?.hostname;
  if (hostname) {
    return { url: `http://${hostname}:${port}`, reason: `LoadBalancer hostname ${ns}/${qh.metadata.name}:${port}` };
  }
  const lbIp = lbIngress.find((e) => e.ip)?.ip;
  if (lbIp) {
    return { url: `http://${lbIp}:${port}`, reason: `LoadBalancer IP ${ns}/${qh.metadata.name}:${port}` };
  }
  // Fall back to ClusterIP (in-cluster only).
  const clusterIp = qh.spec?.clusterIP;
  if (clusterIp && clusterIp !== 'None') {
    return { url: `http://${clusterIp}:${port}`, reason: `ClusterIP ${ns}/${qh.metadata.name}:${port} (in-cluster only)` };
  }

  return { reason: `service ${ns}/${qh.metadata.name} found but no addressable endpoint (no LB ingress, no ClusterIP)` };
}
