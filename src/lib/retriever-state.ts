/**
 * retriever-state.ts — shared helper for resolving Retriever installation state.
 *
 * Resolution order (first fully-matched hit wins):
 *   1. env vars          — __SAVE_LOG10X_RETRIEVER_URL__ + __SAVE_LOG10X_RETRIEVER_BUCKET__
 *   2. snapshot          — installedComponentsDetail.retriever (namespace) + kubectl probe for URL
 *   3. helm_release_probe — helm list -A, filter chart=retriever-10x*, manifest parse, kubectl svc
 *   4. kubectl probe     — get svc by chart label, resolve LoadBalancer hostname or ClusterIP
 *   5. none              — no retriever reachable
 *
 * The `source` field on the returned state lets callers emit a
 * `source_disclosure.retriever_state_source` for audit.
 */

import { run, runJson } from './discovery/shell.js';
import type { DiscoverySnapshot } from './discovery/types.js';

export type RetrieverStateSource = 'env_var' | 'snapshot' | 'helm_release_probe' | 'kubectl_probe' | 'none';

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

  // ── Step 3: helm-release discovery (primary, no label dependency) ───────────
  const hResult = await helmReleaseDiscovery();
  if (hResult.url) {
    trace.push(`helm_release_probe: matched — ${hResult.reason}`);
    return {
      installed: true,
      url: hResult.url,
      bucket: envBucket ?? hResult.bucket ?? undefined,
      namespace: hResult.namespace,
      source: 'helm_release_probe',
      trace,
    };
  }
  trace.push(`helm_release_probe: ${hResult.reason}`);

  // ── Step 4: kubectl probe (cluster-wide) ────────────────────────────────────
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

  // ── Step 5: nothing resolved ─────────────────────────────────────────────────
  trace.push('none: retriever not reachable from env vars, snapshot, helm-release probe, or kubectl probe');
  return { installed: false, source: 'none', trace };
}

// ── private helpers ──────────────────────────────────────────────────────────

// ── helmReleaseDiscovery ─────────────────────────────────────────────────────

/**
 * Helm-release–based discovery for the Retriever Service.
 *
 * Steps:
 *   1. `helm list -A -o json` — find releases whose chart starts with "retriever-10x"
 *   2. `helm get manifest -n <ns> <release>` — parse multi-doc YAML for Service resources
 *   3. `kubectl get svc -n <ns> <name> -o json` — resolve an addressable endpoint
 *   4. `helm get values -n <ns> <release> -o json` — try to read tenx.bucket
 *
 * Returns the first resolved URL + bucket pair, or a reason string on failure.
 */
async function helmReleaseDiscovery(): Promise<{
  url?: string;
  bucket?: string;
  namespace?: string;
  reason: string;
}> {
  // Step 1: list all helm releases
  const { result: listResult, parsed: releases } = await runJson<HelmListEntry[]>(
    'helm',
    ['list', '-A', '-o', 'json'],
    { timeoutMs: 12_000 },
  );
  if (listResult.exitCode !== 0) {
    return { reason: `helm list failed (exit ${listResult.exitCode}): ${listResult.stderr.slice(0, 120)}` };
  }
  if (!Array.isArray(releases) || releases.length === 0) {
    return { reason: 'helm list returned no releases' };
  }

  // Filter to retriever-10x charts (case-insensitive prefix match)
  const retrieverReleases = releases.filter(
    (r) => typeof r.chart === 'string' && r.chart.toLowerCase().startsWith('retriever-10x'),
  );
  if (retrieverReleases.length === 0) {
    return { reason: 'no helm releases with chart starting with retriever-10x' };
  }

  // Step 2–3: for each matching release, get manifest and probe the Services
  for (const release of retrieverReleases) {
    const ns = release.namespace;
    const name = release.name;

    // Get manifest (multi-doc YAML)
    const manifestResult = await run(
      'helm',
      ['get', 'manifest', '-n', ns, name],
      { timeoutMs: 12_000 },
    );
    if (manifestResult.exitCode !== 0) {
      // non-fatal; try next release
      continue;
    }

    const serviceNames = extractServiceNamesFromManifest(manifestResult.stdout);
    if (serviceNames.length === 0) {
      continue;
    }

    // Step 3: probe each Service via kubectl
    for (const svcName of serviceNames) {
      const { result: svcResult, parsed: svcJson } = await runJson<KubeSingleSvc>(
        'kubectl',
        ['get', 'svc', '-n', ns, svcName, '-o', 'json'],
        { timeoutMs: 8_000 },
      );
      if (svcResult.exitCode !== 0 || !svcJson) continue;

      const url = resolveUrlFromSvcJson(svcJson, ns);
      if (!url) continue;

      // Step 4: try to get the tenx.bucket from helm values (best-effort)
      const bucket = await tryReadHelmBucket(ns, name);

      return {
        url,
        bucket,
        namespace: ns,
        reason: `helm release ${ns}/${name} (chart ${release.chart}) → svc ${ns}/${svcName}`,
      };
    }
  }

  return { reason: 'helm releases found but no addressable Retriever Service resolved from manifests' };
}

/** Minimal shape we need from `helm list -A -o json`. */
interface HelmListEntry {
  name: string;
  namespace: string;
  chart: string;
  app_version?: string;
  status?: string;
  revision?: string | number;
}

/** Minimal shape of a single Service from `kubectl get svc ... -o json`. */
interface KubeSingleSvc {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    type?: string;
    clusterIP?: string;
    ports?: Array<{ port?: number; name?: string }>;
  };
  status?: {
    loadBalancer?: {
      ingress?: Array<{ hostname?: string; ip?: string }>;
    };
  };
}

/**
 * Parse multi-doc YAML from `helm get manifest` and return the metadata.name
 * of every resource whose `kind` is `Service`.
 *
 * We do not depend on a YAML library — Kubernetes manifest YAML is predictably
 * structured, so a line-scanning approach is robust enough here. Each document
 * is split on `^---` and we look for `kind: Service` + `name:` within the
 * same document.
 */
function extractServiceNamesFromManifest(manifest: string): string[] {
  const names: string[] = [];
  // Split on document separator lines (--- with optional trailing whitespace)
  const docs = manifest.split(/^---\s*$/m);
  for (const doc of docs) {
    if (!doc.trim()) continue;
    // Check if this document is a Service
    if (!/^\s*kind\s*:\s*Service\s*$/m.test(doc)) continue;
    // Extract metadata.name — look for `name:` within a `metadata:` block.
    // We scan line by line; once we see `metadata:`, the next `name: <value>`
    // at one deeper indentation level is the resource name.
    const lines = doc.split('\n');
    let inMetadata = false;
    for (const line of lines) {
      if (/^metadata\s*:/.test(line)) {
        inMetadata = true;
        continue;
      }
      if (inMetadata) {
        // A new top-level key ends the metadata block
        if (/^[a-zA-Z]/.test(line)) {
          inMetadata = false;
          continue;
        }
        const nameMatch = /^\s+name\s*:\s*(.+)$/.exec(line);
        if (nameMatch) {
          const val = nameMatch[1].trim().replace(/^["']|["']$/g, '');
          if (val) names.push(val);
          inMetadata = false; // only the first name under metadata matters
        }
      }
    }
  }
  return names;
}

/**
 * Resolve an HTTP endpoint URL from a parsed Service JSON object.
 *
 * Priority:
 *   1. LoadBalancer hostname  → `http://<hostname>:<port>`
 *   2. LoadBalancer IP        → `http://<ip>:<port>`
 *   3. ClusterIP              → `http://<svc>.<ns>.svc.cluster.local:<port>`
 *
 * Returns undefined when none of the above are available.
 */
function resolveUrlFromSvcJson(svc: KubeSingleSvc, defaultNs: string): string | undefined {
  const port = svc.spec?.ports?.[0]?.port ?? 8080;
  const ns = svc.metadata?.namespace ?? defaultNs;
  const name = svc.metadata?.name ?? '';

  const lbIngress = svc.status?.loadBalancer?.ingress ?? [];
  const hostname = lbIngress.find((e) => e.hostname)?.hostname;
  if (hostname) return `http://${hostname}:${port}`;

  const lbIp = lbIngress.find((e) => e.ip)?.ip;
  if (lbIp) return `http://${lbIp}:${port}`;

  const type = svc.spec?.type ?? 'ClusterIP';
  if (type === 'ClusterIP') {
    const clusterIp = svc.spec?.clusterIP;
    if (clusterIp && clusterIp !== 'None' && name) {
      return `http://${name}.${ns}.svc.cluster.local:${port}`;
    }
  }

  return undefined;
}

/**
 * Try to read the S3 results bucket from `helm get values`.
 * Checks (in order):
 *   1. tenx.bucket       — canonical field name used in newer chart versions
 *   2. bucket            — top-level alias used in some chart versions
 *   3. indexBucket       — the retriever-10x chart stores results as
 *                          "<bucket>/<subpath>/" in this field; we split on
 *                          the first "/" to extract just the bucket name and
 *                          also set LOG10X_RETRIEVER_INDEX_SUBPATH in-process
 *                          so downstream callers pick up the correct prefix.
 * Returns undefined on any failure — this is always best-effort.
 */
async function tryReadHelmBucket(namespace: string, release: string): Promise<string | undefined> {
  const { parsed } = await runJson<Record<string, unknown>>(
    'helm',
    ['get', 'values', '-n', namespace, release, '-o', 'json'],
    { timeoutMs: 8_000 },
  );
  if (!parsed || typeof parsed !== 'object') return undefined;
  // 1. tenx.bucket
  const tenx = parsed['tenx'];
  if (tenx && typeof tenx === 'object') {
    const b = (tenx as Record<string, unknown>)['bucket'];
    if (typeof b === 'string' && b) return b;
  }
  // 2. top-level bucket
  const topLevel = parsed['bucket'];
  if (typeof topLevel === 'string' && topLevel) return topLevel;
  // 3. indexBucket — format is "<bucket>[/<subpath>/]"
  const indexBucket = parsed['indexBucket'];
  if (typeof indexBucket === 'string' && indexBucket) {
    const slashIdx = indexBucket.indexOf('/');
    if (slashIdx === -1) return indexBucket;
    const bucket = indexBucket.slice(0, slashIdx);
    const subpath = indexBucket.slice(slashIdx + 1).replace(/\/+$/, '');
    if (bucket) {
      // Propagate the subpath into the process env so retrieverResultsLocation
      // builds the correct prefix for query-result polling. This is best-effort
      // and only applies when running inside a single MCP process invocation.
      if (subpath && !process.env.LOG10X_RETRIEVER_INDEX_SUBPATH) {
        process.env.LOG10X_RETRIEVER_INDEX_SUBPATH = subpath;
      }
      return bucket;
    }
  }
  return undefined;
}

type KubeSvcList = {
  items?: Array<{
    metadata: { name: string; namespace: string };
    spec?: { clusterIP?: string; ports?: Array<{ port: number; name?: string }> };
    status?: { loadBalancer?: { ingress?: Array<{ hostname?: string; ip?: string }> } };
  }>;
};

/**
 * Run kubectl get svc with a given label selector and scope.
 * Returns the parsed item list, or an empty list on failure.
 *
 * Fix 83b: the Helm chart published by log10x uses `app=retriever-10x`
 * (not the Kubernetes-recommended `app.kubernetes.io/name=retriever-10x`).
 * We try both selectors and merge results so the probe doesn't silently
 * return 0 services regardless of which label form the deployed chart uses.
 */
type KubeSvcItem = NonNullable<KubeSvcList['items']>[number];

async function kubectlGetSvc(
  scope: string[],  // e.g. ['-n', 'log10x'] or ['-A']
  label: string,
  timeoutMs: number,
): Promise<{ items: KubeSvcItem[]; reason: string; exitCode: number }> {
  const { result, parsed } = await runJson<KubeSvcList>(
    'kubectl',
    ['get', 'svc', ...scope, '-l', label, '-o', 'json'],
    { timeoutMs },
  );
  return {
    items: (parsed?.items ?? []) as NonNullable<KubeSvcList['items']>,
    reason: result.exitCode !== 0 ? result.stderr.slice(0, 120) : '',
    exitCode: result.exitCode,
  };
}

/**
 * Merge two SvcList item arrays, deduplicating by namespace/name.
 */
function mergeSvcItems(
  a: KubeSvcItem[],
  b: KubeSvcItem[],
): KubeSvcItem[] {
  const seen = new Set<string>();
  const result: KubeSvcItem[] = [];
  for (const item of [...a, ...b]) {
    const key = `${item.metadata.namespace}/${item.metadata.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

/**
 * Probe for the Retriever query-handler Service in a specific namespace.
 *
 * Fix 83b: tries both `app=retriever-10x` (chart label) and
 * `app.kubernetes.io/name=retriever-10x` (recommended label). Merges
 * results so it matches installs from either label form.
 */
async function probeKubectlRetrieverSvc(
  namespace: string,
): Promise<{ url?: string; reason: string }> {
  const scope = ['-n', namespace];
  const [r1, r2] = await Promise.all([
    kubectlGetSvc(scope, 'app=retriever-10x', 8_000),
    kubectlGetSvc(scope, 'app.kubernetes.io/name=retriever-10x', 8_000),
  ]);
  if (r1.exitCode !== 0 && r2.exitCode !== 0) {
    return { reason: `kubectl get svc in ${namespace} failed: ${r1.reason}` };
  }
  const items = mergeSvcItems(r1.items, r2.items);
  return pickServiceUrl(items, namespace);
}

/**
 * Cluster-wide probe — searches all namespaces for the Retriever service.
 *
 * Fix 83b: tries both `app=retriever-10x` and
 * `app.kubernetes.io/name=retriever-10x`, merges results.
 */
async function probeKubectlRetrieverSvcAll(): Promise<{ url?: string; namespace?: string; reason: string }> {
  const scope = ['-A'];
  const [r1, r2] = await Promise.all([
    kubectlGetSvc(scope, 'app=retriever-10x', 10_000),
    kubectlGetSvc(scope, 'app.kubernetes.io/name=retriever-10x', 10_000),
  ]);
  if (r1.exitCode !== 0 && r2.exitCode !== 0) {
    return { reason: `kubectl get svc -A failed: ${r1.reason}` };
  }
  const items = mergeSvcItems(r1.items, r2.items);
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
    return { reason: 'no services matched (tried app=retriever-10x and app.kubernetes.io/name=retriever-10x)' };
  }
  const qh =
    items.find((i) => i.metadata.name.includes('query-handler') || i.metadata.name.endsWith('query')) ??
    (items.length === 1 ? items[0] : undefined);
  if (!qh) {
    return { reason: `${items.length} retriever-10x service(s) found — none clearly a query-handler` };
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
