/**
 * The four Kubernetes API calls the budget run makes from inside the
 * cluster, with the pod's service account: list running pods (nodes per
 * container), list nodes (Receivers for the `*` row), and get and replace the
 * policy ConfigMap. Node's https module and the mounted service-account
 * token and CA, so the image needs no kubectl.
 *
 * RBAC the CronJob manifest grants (scheduler-manifest-emitter.ts):
 * `list` on pods and nodes cluster-wide, `get` and `update` on the one
 * ConfigMap by name.
 */

import { readFileSync } from 'node:fs';
import { request } from 'node:https';

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface PodPlacement {
  nodeName?: string;
  containers?: string[];
}

export interface ConfigMapState {
  data: Record<string, string>;
  resourceVersion: string;
}

export interface K8sApi {
  listRunningPods(): Promise<PodPlacement[]>;
  countNodes(): Promise<number>;
  getConfigMap(namespace: string, name: string): Promise<ConfigMapState>;
  /** Replace the ConfigMap's data, failing on a concurrent write (resourceVersion). */
  replaceConfigMap(namespace: string, name: string, data: Record<string, string>, resourceVersion: string): Promise<void>;
}

/** The namespace this pod runs in, from the mounted service account. */
export function podNamespace(): string | undefined {
  try {
    return readFileSync(`${SA_DIR}/namespace`, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** An API client for the cluster this process runs in, or undefined outside a cluster. */
export function inClusterK8sApi(env: NodeJS.ProcessEnv = process.env): K8sApi | undefined {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT || '443';
  if (!host) return undefined;
  let token: string;
  let ca: Buffer;
  try {
    token = readFileSync(`${SA_DIR}/token`, 'utf8').trim();
    ca = readFileSync(`${SA_DIR}/ca.crt`);
  } catch {
    return undefined;
  }

  const call = <T>(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          host,
          port: Number(port),
          path,
          method,
          ca,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          },
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 0) >= 300) {
              reject(new Error(`Kubernetes API ${method} ${path}: HTTP ${res.statusCode} ${text.slice(0, 240)}`));
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch (e) {
              reject(new Error(`Kubernetes API ${method} ${path}: unparseable response (${String(e)})`));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Kubernetes API ${method} ${path}: timed out`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  return {
    async listRunningPods() {
      const r = await call<{ items?: Array<{ spec?: { nodeName?: string; containers?: Array<{ name?: string }> } }> }>(
        'GET',
        '/api/v1/pods?fieldSelector=status.phase%3DRunning',
      );
      return (r.items ?? []).map((p) => ({
        nodeName: p.spec?.nodeName,
        containers: (p.spec?.containers ?? []).map((c) => c.name ?? '').filter(Boolean),
      }));
    },
    async countNodes() {
      const r = await call<{ items?: unknown[] }>('GET', '/api/v1/nodes');
      return (r.items ?? []).length;
    },
    async getConfigMap(namespace, name) {
      const r = await call<{ data?: Record<string, string>; metadata?: { resourceVersion?: string } }>(
        'GET',
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${encodeURIComponent(name)}`,
      );
      return { data: r.data ?? {}, resourceVersion: r.metadata?.resourceVersion ?? '' };
    },
    async replaceConfigMap(namespace, name, data, resourceVersion) {
      const cur = await call<Record<string, unknown> & { metadata?: Record<string, unknown> }>(
        'GET',
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${encodeURIComponent(name)}`,
      );
      await call('PUT', `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${encodeURIComponent(name)}`, {
        ...cur,
        metadata: { ...(cur.metadata ?? {}), resourceVersion },
        data,
      });
    },
  };
}
