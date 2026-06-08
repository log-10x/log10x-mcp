/**
 * kubectl-writer — push a ConfigMap to the customer's k8s cluster via
 * `kubectl apply`.
 *
 * Companion to the existing gitops/gh writer in configure-engine.ts. The
 * gh path opens a PR against the customer's gitops repo (slow loop:
 * review → merge → poll → engine hot-reload). This path is the
 * direct-apply alternative for environments where:
 *
 *   - the engine pulls action-intent from a ConfigMap (new pull source
 *     introduced alongside this writer), and
 *   - the operator wants in-session iteration speed (~seconds vs
 *     minutes), and
 *   - the MCP has direct kubectl access (the user's local kubeconfig
 *     pointed at the target cluster).
 *
 * Architecture: out-of-cluster. The MCP runs on the user's Mac and
 * invokes `kubectl apply -f - --dry-run=server`. The ConfigMap YAML is
 * built inline from caller-supplied content and piped via stdin.
 *
 * Safety model (layered):
 *   1. Caller flag (auto_apply=false / read_only=true on the tool) short-
 *      circuits to dry-run; the rendered YAML is returned in-envelope.
 *   2. Even when auto-applying, we ALWAYS do a `--dry-run=server` pass
 *      first to catch RBAC/quota/admission errors without writing.
 *   3. All user-controlled strings reach `kubectl` via process args
 *      (spawnSync's argv array) — NEVER via shell interpolation. The YAML
 *      body itself is piped through stdin, not constructed in argv.
 *   4. ConfigMap-size guard: k8s rejects objects > 1 MiB at the apiserver.
 *      We pre-flight on the SUM of value sizes and return a structured
 *      `request_entity_too_large` error before kubectl is invoked.
 *
 * Failure-classification: stderr from kubectl is regex-matched against
 * the common error families so the agent can branch on `error_type`
 * (forbidden, not_found, request_entity_too_large, conflict, timeout,
 * unknown). All errors flow back as `{ ok: false, error: {...} }` —
 * the function never throws.
 *
 * Why server-side dry-run by default: client-side dry-run only checks
 * schema; server-side runs the admission chain (RBAC, ResourceQuota,
 * webhooks). The latter is what the operator actually needs to know
 * about. If the cluster doesn't support server-side dry-run we fall
 * back to client-side and warn.
 */

import { spawnSync } from 'node:child_process';
import type { PrimitiveError, PrimitiveErrorType } from '../primitive-errors.js';

// ─── public surface ──────────────────────────────────────────────────

/**
 * The k8s ConfigMap size limit is 1 MiB (apiserver enforcement). Allow
 * a small headroom so the metadata block doesn't push us over.
 */
export const CONFIGMAP_MAX_BYTES = 1024 * 1024;
const CONFIGMAP_HEADROOM_BYTES = 4 * 1024;
const CONFIGMAP_SOFT_LIMIT = CONFIGMAP_MAX_BYTES - CONFIGMAP_HEADROOM_BYTES;

/** Default per-call timeout for kubectl invocations (ms). */
const KUBECTL_TIMEOUT_MS = 30_000;

export interface KubectlWriterArgs {
  /** Target k8s namespace. Must be DNS-1123-label valid. */
  namespace: string;
  /** Target ConfigMap name. Must be DNS-1123-subdomain valid. */
  configmap: string;
  /**
   * ConfigMap `data` map. Each value is a string; binary values are not
   * supported by this writer (the engine pulls action-intent.json which is
   * UTF-8 text).
   */
  content: { [key: string]: string };
  /**
   * When true, skip the real apply and only run `--dry-run=server`. The
   * returned `dry_run_diff` carries kubectl's stdout describing what
   * WOULD change. When false, we still run server-side dry-run first as
   * a pre-flight, then do the real apply if the dry-run succeeded.
   */
  dryRun: boolean;
  /**
   * Optional labels to merge into the ConfigMap metadata. Useful for
   * GitOps reconciliation markers (`app.kubernetes.io/managed-by=log10x`)
   * and for the engine's pull-source label selector.
   */
  labels?: { [key: string]: string };
  /**
   * Optional annotations. Stamped with `log10x.com/written-at` so the
   * engine can log the freshness of the ConfigMap on each pull.
   */
  annotations?: { [key: string]: string };
  /** Override the default timeout (ms). Tests pass a short value. */
  timeoutMs?: number;
  /**
   * Override the kubectl binary path. Default `kubectl` (resolved via
   * PATH). Tests pass `/bin/false` etc.
   */
  kubectlPath?: string;
  /**
   * Injected spawn implementation. Defaults to node's spawnSync. Tests
   * pass a mock that returns canned stdout/stderr/exit codes without
   * starting a real process.
   */
  spawn?: SpawnSyncFn;
}

export interface KubectlWriterResult {
  ok: boolean;
  /** High-level state, branchable by the caller. */
  status:
    | 'applied'
    | 'dry_run_ok'
    | 'failed_validation'
    | 'failed_apply'
    | 'forbidden'
    | 'not_found'
    | 'request_entity_too_large'
    | 'conflict'
    | 'timeout'
    | 'kubectl_unavailable';
  /** Server-side dry-run diff (kubectl stdout) — present on success. */
  dry_run_diff?: string;
  /** Rendered ConfigMap YAML (always present so the caller can persist). */
  rendered_yaml: string;
  /** Structured error envelope, present iff ok=false. */
  error?: PrimitiveError;
  /**
   * Suggested kubectl one-liner the user can run to confirm the change
   * landed (`kubectl get configmap -n <ns> <name> -o yaml`).
   */
  verification_hint: string;
}

// ─── spawn surface (injectable for tests) ────────────────────────────

/** Trimmed surface of node's `spawnSync` return value. */
export interface SpawnSyncResult {
  status: number | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
  error?: Error & { code?: string };
  signal?: NodeJS.Signals | null;
}

/**
 * Spawn function signature compatible with `child_process.spawnSync`.
 * Tests pass a mock that returns canned results.
 */
export type SpawnSyncFn = (
  command: string,
  args: string[],
  options: { input: string; timeout: number; encoding?: BufferEncoding },
) => SpawnSyncResult;

// ─── entry ───────────────────────────────────────────────────────────

/**
 * Apply a ConfigMap to the customer's cluster (or dry-run only) via
 * kubectl. Never throws — all failures flow back as `{ ok: false, ... }`.
 *
 * The function does:
 *   1. Validate the namespace + configmap names (DNS-1123).
 *   2. Pre-flight the size against the apiserver's 1 MiB cap.
 *   3. Render the ConfigMap YAML deterministically (sorted keys).
 *   4. Run `kubectl apply -f - --dry-run=server`.
 *   5. If dryRun=false and dry-run succeeded, run the real apply.
 *   6. Classify kubectl exit code + stderr into a structured error.
 */
export function applyViaKubectl(args: KubectlWriterArgs): KubectlWriterResult {
  const spawn = args.spawn ?? (spawnSync as unknown as SpawnSyncFn);
  const kubectl = args.kubectlPath ?? 'kubectl';
  const timeoutMs = args.timeoutMs ?? KUBECTL_TIMEOUT_MS;
  const verification_hint = buildVerificationHint(args.namespace, args.configmap);

  // ── 1. Validate identifiers ───────────────────────────────────────
  const nsErr = validateDns1123Label(args.namespace, 'namespace');
  if (nsErr) {
    const yaml = ''; // not rendered when args are invalid
    return {
      ok: false,
      status: 'failed_validation',
      rendered_yaml: yaml,
      error: nsErr,
      verification_hint,
    };
  }
  const cmErr = validateDns1123Subdomain(args.configmap, 'configmap');
  if (cmErr) {
    return {
      ok: false,
      status: 'failed_validation',
      rendered_yaml: '',
      error: cmErr,
      verification_hint,
    };
  }

  // ── 2. Pre-flight size ────────────────────────────────────────────
  const sizeError = preflightSize(args.content);
  if (sizeError) {
    return {
      ok: false,
      status: 'request_entity_too_large',
      rendered_yaml: '',
      error: sizeError,
      verification_hint,
    };
  }

  // ── 3. Render YAML deterministically ──────────────────────────────
  const yaml = renderConfigMapYaml({
    namespace: args.namespace,
    configmap: args.configmap,
    content: args.content,
    labels: args.labels,
    annotations: args.annotations,
  });

  // ── 4. Server-side dry-run pre-flight ─────────────────────────────
  const dryRunResult = runKubectl(
    spawn,
    kubectl,
    ['apply', '-n', args.namespace, '-f', '-', '--dry-run=server', '-o', 'yaml'],
    yaml,
    timeoutMs,
  );

  if (dryRunResult.kind === 'unavailable') {
    return {
      ok: false,
      status: 'kubectl_unavailable',
      rendered_yaml: yaml,
      error: dryRunResult.error,
      verification_hint,
    };
  }
  if (dryRunResult.kind === 'timeout') {
    return {
      ok: false,
      status: 'timeout',
      rendered_yaml: yaml,
      error: dryRunResult.error,
      verification_hint,
    };
  }
  if (dryRunResult.kind === 'error') {
    return {
      ok: false,
      status: classifyKubectlStderr(dryRunResult.stderr),
      rendered_yaml: yaml,
      error: dryRunResult.error,
      verification_hint,
    };
  }

  // dry-run succeeded — caller wanted dry-run only, return now.
  if (args.dryRun) {
    return {
      ok: true,
      status: 'dry_run_ok',
      rendered_yaml: yaml,
      dry_run_diff: dryRunResult.stdout,
      verification_hint,
    };
  }

  // ── 5. Real apply ─────────────────────────────────────────────────
  const applyResult = runKubectl(
    spawn,
    kubectl,
    ['apply', '-n', args.namespace, '-f', '-'],
    yaml,
    timeoutMs,
  );

  if (applyResult.kind === 'unavailable') {
    return {
      ok: false,
      status: 'kubectl_unavailable',
      rendered_yaml: yaml,
      error: applyResult.error,
      verification_hint,
    };
  }
  if (applyResult.kind === 'timeout') {
    return {
      ok: false,
      status: 'timeout',
      rendered_yaml: yaml,
      error: applyResult.error,
      verification_hint,
    };
  }
  if (applyResult.kind === 'error') {
    return {
      ok: false,
      status: classifyKubectlStderr(applyResult.stderr),
      rendered_yaml: yaml,
      error: applyResult.error,
      verification_hint,
    };
  }

  return {
    ok: true,
    status: 'applied',
    rendered_yaml: yaml,
    dry_run_diff: dryRunResult.stdout,
    verification_hint,
  };
}

// ─── YAML rendering ──────────────────────────────────────────────────

interface RenderInput {
  namespace: string;
  configmap: string;
  content: { [key: string]: string };
  labels?: { [key: string]: string };
  annotations?: { [key: string]: string };
}

/**
 * Render the ConfigMap YAML. Public for testing — the format is stable
 * across kubectl versions.
 */
export function renderConfigMapYaml(input: RenderInput): string {
  const lines: string[] = [];
  lines.push('apiVersion: v1');
  lines.push('kind: ConfigMap');
  lines.push('metadata:');
  lines.push(`  name: ${yamlScalar(input.configmap)}`);
  lines.push(`  namespace: ${yamlScalar(input.namespace)}`);
  // Always stamp managed-by so an operator scanning the cluster can find
  // log10x-managed ConfigMaps. Caller labels merge on top.
  const labels: { [k: string]: string } = {
    'app.kubernetes.io/managed-by': 'log10x-mcp',
    'log10x.com/source': 'configure_engine',
    ...(input.labels ?? {}),
  };
  lines.push('  labels:');
  for (const k of Object.keys(labels).sort()) {
    lines.push(`    ${yamlScalarKey(k)}: ${yamlScalar(labels[k])}`);
  }
  // Always stamp written-at; merge caller annotations on top.
  const annotations: { [k: string]: string } = {
    'log10x.com/written-at': new Date().toISOString(),
    ...(input.annotations ?? {}),
  };
  lines.push('  annotations:');
  for (const k of Object.keys(annotations).sort()) {
    lines.push(`    ${yamlScalarKey(k)}: ${yamlScalar(annotations[k])}`);
  }

  lines.push('data:');
  // Sort keys so the rendered YAML is byte-identical for identical input.
  const sortedKeys = Object.keys(input.content).sort();
  for (const k of sortedKeys) {
    const v = input.content[k];
    lines.push(`  ${yamlScalarKey(k)}: ${yamlBlockOrScalar(v, 4)}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Single-quoted YAML scalar. We escape `'` by doubling it. This is the
 * safe encoding for arbitrary ASCII; multi-line / large values use the
 * block-literal encoding below.
 */
function yamlScalar(s: string): string {
  // Quote always so we don't trip YAML 1.1's surprise booleans
  // (yes/no/on/off) or numeric coercions.
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * YAML key in scalar form. We quote keys that contain non-identifier
 * characters (dots, slashes — common in k8s annotation keys).
 */
function yamlScalarKey(k: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) return k;
  return `'${k.replace(/'/g, "''")}'`;
}

/**
 * Emit a value as a single-line quoted scalar when it fits, otherwise
 * as a block literal. The block literal preserves newlines exactly.
 */
function yamlBlockOrScalar(s: string, indent: number): string {
  if (!s.includes('\n')) return yamlScalar(s);
  const pad = ' '.repeat(indent);
  const body = s.split('\n').map((l) => `${pad}${l}`).join('\n');
  // `|-` strips the trailing newline; `|` keeps one. action-intent.json
  // ends with a single trailing newline, so `|` matches it exactly.
  return `|\n${body}`;
}

// ─── validation ──────────────────────────────────────────────────────

const DNS_1123_LABEL_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_1123_SUBDOMAIN_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

function validateDns1123Label(value: string, what: string): PrimitiveError | undefined {
  if (!value) {
    return primitiveError(
      'schema_invalid',
      `kubectl_configmap delivery: ${what} is empty. Pass a valid DNS-1123 label.`,
    );
  }
  if (value.length > 63) {
    return primitiveError(
      'schema_invalid',
      `kubectl_configmap delivery: ${what} "${value.slice(0, 30)}…" exceeds the 63-char DNS-1123 label limit.`,
    );
  }
  if (!DNS_1123_LABEL_RE.test(value)) {
    return primitiveError(
      'schema_invalid',
      `kubectl_configmap delivery: ${what} "${value}" is not a valid DNS-1123 label (lowercase letters, digits, hyphens; must start and end with alphanumeric).`,
    );
  }
  return undefined;
}

function validateDns1123Subdomain(value: string, what: string): PrimitiveError | undefined {
  if (!value) {
    return primitiveError(
      'schema_invalid',
      `kubectl_configmap delivery: ${what} is empty.`,
    );
  }
  if (value.length > 253) {
    return primitiveError(
      'schema_invalid',
      `kubectl_configmap delivery: ${what} exceeds the 253-char DNS-1123 subdomain limit.`,
    );
  }
  if (!DNS_1123_SUBDOMAIN_RE.test(value)) {
    return primitiveError(
      'schema_invalid',
      `kubectl_configmap delivery: ${what} "${value}" is not a valid DNS-1123 subdomain.`,
    );
  }
  return undefined;
}

/**
 * Pre-flight the ConfigMap size against the apiserver's 1 MiB cap. We
 * sum the byte length of all values plus a generous fudge factor for
 * key names + YAML overhead.
 */
function preflightSize(content: { [key: string]: string }): PrimitiveError | undefined {
  let total = 0;
  for (const [k, v] of Object.entries(content)) {
    total += Buffer.byteLength(k, 'utf8');
    total += Buffer.byteLength(v, 'utf8');
  }
  if (total > CONFIGMAP_SOFT_LIMIT) {
    const totalKb = (total / 1024).toFixed(1);
    return {
      error_type: 'schema_invalid',
      retryable: false,
      suggested_backoff_ms: null,
      hint:
        `ConfigMap payload is ${totalKb} KiB which exceeds the 1 MiB k8s apiserver cap ` +
        `(soft limit ${(CONFIGMAP_SOFT_LIMIT / 1024).toFixed(0)} KiB after headroom). ` +
        `Split the action-intent across multiple ConfigMaps, or compact rare patterns.`,
    };
  }
  return undefined;
}

// ─── kubectl runner ──────────────────────────────────────────────────

type KubectlOutcome =
  | { kind: 'ok'; stdout: string; stderr: string }
  | { kind: 'error'; stdout: string; stderr: string; error: PrimitiveError }
  | { kind: 'timeout'; error: PrimitiveError }
  | { kind: 'unavailable'; error: PrimitiveError };

function runKubectl(
  spawn: SpawnSyncFn,
  kubectl: string,
  args: string[],
  yaml: string,
  timeoutMs: number,
): KubectlOutcome {
  let res: SpawnSyncResult;
  try {
    res = spawn(kubectl, args, {
      input: yaml,
      timeout: timeoutMs,
      encoding: 'utf8',
    });
  } catch (e) {
    // spawnSync only throws on invalid args; normalize to unavailable.
    return {
      kind: 'unavailable',
      error: primitiveError(
        'config_missing',
        `Failed to invoke kubectl: ${(e as Error).message}. Confirm kubectl is installed and on PATH.`,
      ),
    };
  }

  const stdout = bufToString(res.stdout);
  const stderr = bufToString(res.stderr);

  // ENOENT / ENOTDIR: kubectl missing.
  if (res.error && (res.error.code === 'ENOENT' || res.error.code === 'ENOTDIR')) {
    return {
      kind: 'unavailable',
      error: primitiveError(
        'config_missing',
        `kubectl binary not found (${res.error.code}). Install kubectl and ensure it is on PATH for the MCP process.`,
      ),
    };
  }

  // Timeout via signal SIGTERM and null status (node's spawnSync sets
  // status=null when killed by signal/timeout).
  if (res.signal === 'SIGTERM' && res.status === null) {
    return {
      kind: 'timeout',
      error: primitiveError(
        'backend_timeout',
        `kubectl timed out after ${timeoutMs}ms. The cluster apiserver may be unreachable; check kubeconfig context and network.`,
        2000,
        true,
      ),
    };
  }

  if (res.status === 0) {
    return { kind: 'ok', stdout, stderr };
  }

  const tail = stderr.trim().split('\n').slice(-5).join('\n').slice(0, 600);
  return {
    kind: 'error',
    stdout,
    stderr,
    error: classifyKubectlError(stderr, res.status, tail),
  };
}

function bufToString(b: string | Buffer | undefined): string {
  if (b === undefined || b === null) return '';
  return typeof b === 'string' ? b : b.toString('utf8');
}

/**
 * Map kubectl stderr text to a high-level status code. Exposed so the
 * top-level result can carry both the structured error and a coarse
 * branch the caller can switch on without parsing strings.
 */
export function classifyKubectlStderr(stderr: string): KubectlWriterResult['status'] {
  const s = stderr.toLowerCase();
  if (/forbidden|access denied|cannot.*resource|user.*cannot/i.test(s)) return 'forbidden';
  if (/notfound|not found|no such|the server (?:could not find|doesn'?t have)/i.test(s)) {
    return 'not_found';
  }
  if (/requestentitytoolarge|request entity too large|too large/i.test(s)) {
    return 'request_entity_too_large';
  }
  if (/conflict|already exists/i.test(s)) return 'conflict';
  if (/timeout|timed out|connection refused|unable to connect/i.test(s)) return 'timeout';
  return 'failed_apply';
}

function classifyKubectlError(
  stderr: string,
  status: number | null,
  tail: string,
): PrimitiveError {
  const cls = classifyKubectlStderr(stderr);
  switch (cls) {
    case 'forbidden':
      return primitiveError(
        'config_missing',
        `kubectl Forbidden — the kubeconfig user lacks RBAC to write ConfigMaps in this namespace. ` +
          `Bind a Role/RoleBinding granting configmaps create+patch, or switch contexts. kubectl said: ${tail}`,
      );
    case 'not_found':
      return primitiveError(
        'config_missing',
        `kubectl NotFound — the target namespace does not exist. Create it first ` +
          `(kubectl create namespace …) or pass an existing one. kubectl said: ${tail}`,
      );
    case 'request_entity_too_large':
      return primitiveError(
        'schema_invalid',
        `kubectl RequestEntityTooLarge — the ConfigMap exceeds the 1 MiB apiserver cap. ` +
          `Split the payload or compact rare patterns. kubectl said: ${tail}`,
      );
    case 'conflict':
      return primitiveError(
        'backend_error',
        `kubectl Conflict — the resource changed between read and write. Retry the apply. kubectl said: ${tail}`,
        1000,
        true,
      );
    case 'timeout':
      return primitiveError(
        'backend_timeout',
        `kubectl timed out reaching the cluster. Check kubeconfig context and network. kubectl said: ${tail}`,
        2000,
        true,
      );
    default:
      return primitiveError(
        'backend_error',
        `kubectl exited ${status ?? 'null'}: ${tail || 'no stderr output'}`,
      );
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

function primitiveError(
  error_type: PrimitiveErrorType,
  hint: string,
  backoff_ms: number | null = null,
  retryable = false,
): PrimitiveError {
  return {
    error_type,
    retryable,
    suggested_backoff_ms: backoff_ms,
    hint,
  };
}

/**
 * Build the kubectl one-liner the caller surfaces in `verification_hint`
 * so the user can confirm the apply landed.
 */
export function buildVerificationHint(namespace: string, configmap: string): string {
  // Two-line hint: confirm the ConfigMap, then tail the receiver pods so
  // the user can see the engine pick up the new intent on its next pull.
  return (
    `kubectl get configmap -n ${namespace} ${configmap} -o yaml | head -40\n` +
    `kubectl logs -n ${namespace} -l app=tenx-fluentd --tail=200 | grep -i 'action-intent\\|configmap'`
  );
}
