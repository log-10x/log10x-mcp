/**
 * Kubernetes ConfigMap-backed implementation of `EnvConfigStore`.
 *
 * Layout decision (multi-env): one ConfigMap per environment, in a shared
 * namespace (`log10x` by default, override via `LOG10X_K8S_NAMESPACE`):
 *
 *   ConfigMap name:  log10x-env-config-${env_id}
 *   Namespace:       ${LOG10X_K8S_NAMESPACE || 'log10x'}
 *   data["env.json"]: full serialized EnvironmentConfig (JSON)
 *   labels:
 *     app=log10x-env-config            ← list() selector
 *     log10x.com/env-id=${env_id}      ← reverse lookup convenience
 *     log10x.com/env-nickname=${nick}  ← human-friendly cross-ref
 *
 * Why one CM per env (not one shared CM with many keys):
 *   - RBAC: customers commonly want to restrict who can read/write a specific
 *     environment (prod vs staging). Per-CM RBAC is the standard pattern.
 *   - Conflict surface: per-env `kubectl apply` race never clobbers another
 *     env's payload — each env is its own object.
 *   - Audit trail: kube-apiserver audit log lines name the CM, so "who edited
 *     prod's offload bucket at 03:14" is a single grep.
 *
 * We shell out to `kubectl` rather than depend on `@kubernetes/client-node`:
 *   - Zero extra runtime deps for users who never touch the k8s store.
 *   - Inherits the user's kubeconfig / context / auth plugin chain for free
 *     (EKS IAM authenticator, GKE gcloud helper, AKS device-code, etc.).
 *   - The store contract is small (read/write/list/delete) — the surface that
 *     would benefit from a typed client isn't worth the dependency cost.
 *
 * `isAvailable()` is the gatekeeper for the resolver fall-through. It must
 * return `{ available: false, reason }` (NOT throw) when kubectl is missing
 * or the cluster is unreachable, so the resolver moves on to the next store.
 *
 * `read()` / `write()` / `list()` / `delete()` DO throw — once we've decided
 * the store is available, a kubectl auth failure mid-operation is a real
 * error the caller needs to see. In particular, auth failures surface as
 * `K8sConfigMapClusterUnreachableError` (status `cluster_unreachable`) so the
 * envelope distinguishes "kubectl can't reach the cluster" from "the env
 * just doesn't exist" — the latter is `read()` returning `null`.
 */

import { spawn } from 'child_process';

import type { EnvConfigStore } from './store-interface.js';
import { environmentConfigSchema, type EnvironmentConfig } from './types.js';

const DEFAULT_NAMESPACE = 'log10x';
const CM_NAME_PREFIX = 'log10x-env-config-';
const LIST_LABEL_SELECTOR = 'app=log10x-env-config';
const ENV_JSON_KEY = 'env.json';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Thrown when kubectl reports an auth/connectivity failure during a real
 * operation (read after isAvailable said yes, write, list, delete). The
 * resolver/tool envelope maps this to status=`cluster_unreachable` rather
 * than `env_not_found`, so users see the actual root cause.
 */
export class K8sConfigMapClusterUnreachableError extends Error {
  readonly status = 'cluster_unreachable' as const;
  readonly stderr: string;
  constructor(operation: string, stderr: string) {
    super(
      `kubectl ${operation} failed: cluster unreachable or unauthorized. ` +
        `kubectl stderr (first 1000 chars):\n${stderr.slice(0, 1000)}`,
    );
    this.name = 'K8sConfigMapClusterUnreachableError';
    this.stderr = stderr;
  }
}

/**
 * Thrown when kubectl exits non-zero for a reason that ISN'T cluster
 * connectivity (malformed manifest, payload too big, etc.). Distinct from
 * the unreachable error so callers don't mis-report.
 */
export class K8sConfigMapStoreError extends Error {
  readonly stderr: string;
  readonly exitCode: number;
  constructor(operation: string, exitCode: number, stderr: string) {
    super(
      `kubectl ${operation} exited with code ${exitCode}.\n` +
        `Stderr (first 1000 chars):\n${stderr.slice(0, 1000)}`,
    );
    this.name = 'K8sConfigMapStoreError';
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export interface K8sConfigMapStoreOptions {
  /** Namespace holding the env-config CMs. Defaults to LOG10X_K8S_NAMESPACE or "log10x". */
  namespace?: string;
  /** kubectl binary path. Defaults to LOG10X_KUBECTL_PATH or "kubectl" on PATH. */
  kubectlPath?: string;
  /** Per-command timeout. Defaults to 15s. */
  timeoutMs?: number;
}

interface RawConfigMap {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
  data?: Record<string, string>;
}

interface RawConfigMapList {
  items?: RawConfigMap[];
}

export class K8sConfigMapStore implements EnvConfigStore {
  readonly kind = 'k8s' as const;
  private readonly namespace: string;
  private readonly kubectl: string;
  private readonly timeoutMs: number;

  constructor(opts: K8sConfigMapStoreOptions = {}) {
    this.namespace = opts.namespace || process.env.LOG10X_K8S_NAMESPACE || DEFAULT_NAMESPACE;
    this.kubectl = opts.kubectlPath || process.env.LOG10X_KUBECTL_PATH || 'kubectl';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Two-step probe:
   *   1. kubectl is on PATH (or at LOG10X_KUBECTL_PATH).
   *   2. The current kubeconfig context can list ConfigMaps in our namespace
   *      (`kubectl auth can-i list configmaps -n <ns>`).
   *
   * Returns `{ available: false, reason }` for any failure — never throws.
   * The resolver depends on this contract to fall through to the next store.
   */
  async isAvailable(): Promise<{ available: boolean; reason: string }> {
    // Step 1: kubectl reachable on PATH.
    try {
      await this.run(['version', '--client=true', '-o', 'json']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        reason: `kubectl not available (${truncate(msg, 200)}). ` +
          `Install kubectl or set LOG10X_KUBECTL_PATH to its absolute path.`,
      };
    }

    // Step 2: current context can list configmaps in the target namespace.
    try {
      const out = await this.run([
        'auth', 'can-i', 'list', 'configmaps', '-n', this.namespace,
      ]);
      if (out.trim().toLowerCase() !== 'yes') {
        return {
          available: false,
          reason: `kubectl context cannot list configmaps in namespace "${this.namespace}" ` +
            `(can-i returned: ${truncate(out.trim(), 80) || '<empty>'}). ` +
            `Grant the SA/user "get,list,create,update,delete" on configmaps, or change LOG10X_K8S_NAMESPACE.`,
        };
      }
    } catch (err) {
      // `kubectl auth can-i` exits non-zero when the answer is "no" AND when
      // the cluster is unreachable. Either way we report unavailable rather
      // than throwing — the resolver needs to keep walking the chain.
      const msg = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        reason: `kubectl context cannot reach namespace "${this.namespace}" or denied permission: ` +
          truncate(msg, 240),
      };
    }

    return { available: true, reason: `kubectl reachable; namespace="${this.namespace}"` };
  }

  /**
   * Lookup precedence:
   *   1. Treat input as env_id, fetch `log10x-env-config-{id}` directly (O(1)).
   *   2. On not-found, fall back to a labeled list and match by nickname
   *      (O(n) but only triggered when the direct hit missed).
   *
   * Cluster-unreachable errors are surfaced as
   * `K8sConfigMapClusterUnreachableError` so the envelope maps to
   * status=`cluster_unreachable`, not the misleading `env_not_found`.
   */
  async read(envIdOrNickname: string): Promise<EnvironmentConfig | null> {
    // 1. Direct env_id hit.
    const direct = await this.readByEnvId(envIdOrNickname);
    if (direct) return direct;

    // 2. Nickname fallback via list + filter.
    const all = await this.list();
    const match = all.find(
      cfg => cfg.nickname === envIdOrNickname || cfg.env_id === envIdOrNickname,
    );
    return match || null;
  }

  /**
   * Server-side apply via `kubectl create --dry-run=client -o yaml | kubectl apply -f -`.
   * The dry-run-then-apply pattern is the documented kubectl recipe for
   * idempotent upserts of literal data; it preserves --save-config so future
   * applies don't clobber labels added out-of-band.
   *
   * Validates the document against the zod schema BEFORE writing — refusing
   * to persist a malformed env is cheaper than discovering it at read time.
   */
  async write(config: EnvironmentConfig): Promise<void> {
    const parsed = environmentConfigSchema.parse(config);
    const cmName = cmNameForEnvId(parsed.env_id);
    const updated: EnvironmentConfig = {
      ...parsed,
      updated_at: parsed.updated_at ?? new Date().toISOString(),
    };
    const payload = JSON.stringify(updated);

    // Step 1: dry-run create → yaml manifest with literal env.json.
    const dryRunArgs = [
      'create', 'configmap', cmName,
      '-n', this.namespace,
      `--from-literal=${ENV_JSON_KEY}=${payload}`,
      '--save-config',
      '--dry-run=client',
      '-o', 'yaml',
    ];
    const yaml = await this.run(dryRunArgs);

    // Step 2: inject labels by appending a labels block. kubectl's
    // --from-literal builder doesn't accept --labels in older versions, and
    // post-apply `kubectl label` runs after the manifest is already on the
    // server, so injecting at apply time keeps the operation atomic.
    const labeledYaml = injectLabels(yaml, {
      app: 'log10x-env-config',
      'log10x.com/env-id': parsed.env_id,
      'log10x.com/env-nickname': parsed.nickname,
    });

    // Step 3: apply with stdin.
    await this.runWithStdin(['apply', '-f', '-'], labeledYaml);
  }

  /**
   * Lists every env-config CM in the namespace via the
   * `app=log10x-env-config` selector. The selector keeps us from sweeping up
   * unrelated CMs that share the namespace (common when log10x co-tenants
   * with another tool).
   *
   * Each CM's `data["env.json"]` is parsed against the schema; entries that
   * fail validation are skipped with a warning to stderr rather than failing
   * the whole list — one corrupt CM shouldn't hide every other env from the
   * discover_env flow.
   */
  async list(): Promise<EnvironmentConfig[]> {
    let raw: string;
    try {
      raw = await this.run([
        'get', 'configmaps', '-n', this.namespace,
        '-l', LIST_LABEL_SELECTOR,
        '-o', 'json',
      ]);
    } catch (err) {
      throw this.classifyError('list configmaps', err);
    }

    let parsed: RawConfigMapList;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `kubectl returned non-JSON when listing configmaps in "${this.namespace}": ` +
          truncate(raw, 200),
      );
    }

    const results: EnvironmentConfig[] = [];
    for (const item of parsed.items ?? []) {
      const cfg = parseEnvJsonFromCm(item);
      if (cfg) results.push(cfg);
    }
    return results;
  }

  /**
   * Hard delete by env_id. Returning silently on "not found" would mask
   * typos in the env_id, so we treat it as an error. Cluster-unreachable
   * still maps to the dedicated error class.
   */
  async delete(envId: string): Promise<void> {
    const cmName = cmNameForEnvId(envId);
    try {
      await this.run(['delete', 'configmap', cmName, '-n', this.namespace]);
    } catch (err) {
      throw this.classifyError(`delete configmap ${cmName}`, err);
    }
  }

  // ── internals ──

  /**
   * Direct env_id → CM read, returns null on NotFound, throws on
   * cluster-unreachable / other kubectl failures.
   */
  private async readByEnvId(envId: string): Promise<EnvironmentConfig | null> {
    const cmName = cmNameForEnvId(envId);
    let raw: string;
    try {
      raw = await this.run([
        'get', 'configmap', cmName,
        '-n', this.namespace,
        '-o', 'json',
      ]);
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw this.classifyError(`get configmap ${cmName}`, err);
    }

    let cm: RawConfigMap;
    try {
      cm = JSON.parse(raw);
    } catch {
      throw new Error(
        `kubectl returned non-JSON for configmap ${cmName}: ` + truncate(raw, 200),
      );
    }
    return parseEnvJsonFromCm(cm);
  }

  /**
   * Pick the right error class based on what kubectl said.
   * NotFound (already filtered earlier in readByEnvId) is the only "this is
   * actually a null result" path; everything else falls into either
   * cluster-unreachable (auth/network/no-context) or generic store error.
   */
  private classifyError(operation: string, err: unknown): Error {
    const stderr = stderrOf(err);
    if (looksLikeClusterUnreachable(stderr)) {
      return new K8sConfigMapClusterUnreachableError(operation, stderr);
    }
    if (err instanceof KubectlExitError) {
      return new K8sConfigMapStoreError(operation, err.exitCode, stderr);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private run(args: string[]): Promise<string> {
    return runKubectl(this.kubectl, args, null, this.timeoutMs);
  }

  private runWithStdin(args: string[], stdinData: string): Promise<string> {
    return runKubectl(this.kubectl, args, stdinData, this.timeoutMs);
  }
}

// ── helpers ──

function cmNameForEnvId(envId: string): string {
  // Defensive: ConfigMap names must be DNS-1123 subdomains. The env_id is
  // typically a UUID; we still normalize to be safe against legacy ids that
  // used uppercase or underscores.
  const sanitized = envId.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
  return `${CM_NAME_PREFIX}${sanitized}`;
}

function parseEnvJsonFromCm(cm: RawConfigMap): EnvironmentConfig | null {
  const raw = cm.data?.[ENV_JSON_KEY];
  if (!raw) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    // Corrupt JSON in a single CM shouldn't hide every other env. Skip with
    // a warning so operators see it but list() keeps going.
    process.stderr.write(
      `[k8s-env-config] skipping configmap ${cm.metadata?.namespace}/${cm.metadata?.name}: ` +
        `data["${ENV_JSON_KEY}"] is not valid JSON\n`,
    );
    return null;
  }
  const result = environmentConfigSchema.safeParse(doc);
  if (!result.success) {
    process.stderr.write(
      `[k8s-env-config] skipping configmap ${cm.metadata?.namespace}/${cm.metadata?.name}: ` +
        `payload failed schema validation (${result.error.issues.length} issue(s))\n`,
    );
    return null;
  }
  return result.data;
}

/**
 * Heuristic for "this was a 404 on the resource itself, not on the cluster".
 * kubectl's exit code is 1 in both cases; we have to read stderr.
 */
function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof KubectlExitError)) return false;
  const s = err.stderr.toLowerCase();
  return /not found/.test(s) && !looksLikeClusterUnreachable(err.stderr);
}

/**
 * Detect kubectl errors that mean "I couldn't even talk to the apiserver"
 * (TLS, DNS, expired token, no current context, refused). These map to
 * `cluster_unreachable` in the envelope so users see the real root cause
 * instead of `env_not_found`.
 */
function looksLikeClusterUnreachable(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes('unable to connect to the server') ||
    s.includes('connection refused') ||
    s.includes('no such host') ||
    s.includes('i/o timeout') ||
    s.includes('tls handshake') ||
    s.includes('x509: certificate') ||
    s.includes('unauthorized') ||
    s.includes('forbidden') ||
    s.includes('expired') ||
    s.includes('no configuration has been provided') ||
    s.includes('current-context') && s.includes('does not exist') ||
    s.includes('error loading config') ||
    s.includes('exec plugin') ||
    s.includes('authentication required')
  );
}

function stderrOf(err: unknown): string {
  if (err instanceof KubectlExitError) return err.stderr;
  if (err instanceof Error) return err.message;
  return String(err);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Inject labels into the metadata block of a kubectl-emitted YAML manifest.
 * The dry-run output always has `metadata:` followed by `name:`; we insert
 * a `labels:` sibling right after `name`. Safe because the manifest is
 * machine-generated and tightly formatted.
 */
function injectLabels(yaml: string, labels: Record<string, string>): string {
  const lines = yaml.split('\n');
  const out: string[] = [];
  let inMetadata = false;
  let injected = false;
  let metadataIndent = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    if (!injected) {
      const metaMatch = line.match(/^(\s*)metadata:\s*$/);
      if (metaMatch) {
        inMetadata = true;
        metadataIndent = metaMatch[1];
        continue;
      }
      if (inMetadata) {
        // Detect leaving metadata block (sibling key at the same indent).
        const exitMatch = line.match(/^(\s*)[A-Za-z]/);
        if (exitMatch && exitMatch[1].length <= metadataIndent.length && !line.startsWith(metadataIndent + ' ')) {
          // We've left the metadata block without finding a name line —
          // shouldn't happen with kubectl-emitted output, but bail safely.
          inMetadata = false;
        } else {
          const nameMatch = line.match(/^(\s+)name:\s*\S+/);
          if (nameMatch) {
            const childIndent = nameMatch[1];
            out.push(`${childIndent}labels:`);
            for (const [k, v] of Object.entries(labels)) {
              // Quote values: nickname may contain colons/spaces.
              out.push(`${childIndent}  ${k}: ${JSON.stringify(v)}`);
            }
            injected = true;
            inMetadata = false;
          }
        }
      }
    }
  }
  return out.join('\n');
}

// ── kubectl runner ──

class KubectlExitError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  constructor(exitCode: number, stderr: string, stdout: string) {
    super(`kubectl exited with code ${exitCode}: ${truncate(stderr, 240)}`);
    this.name = 'KubectlExitError';
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

/**
 * Spawn kubectl. Returns stdout on exit 0; rejects with KubectlExitError on
 * non-zero (so callers can inspect stderr) or a plain Error on spawn failure
 * (kubectl missing on PATH, ENOENT, etc.).
 */
function runKubectl(
  kubectl: string,
  args: string[],
  stdinData: string | null,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(kubectl, args, {
        env: process.env,
        stdio: [stdinData !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      rejectPromise(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`kubectl timed out after ${timeoutMs}ms: ${kubectl} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        rejectPromise(new KubectlExitError(code ?? -1, stderr, stdout));
      }
    });

    if (stdinData !== null && child.stdin) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }
  });
}
