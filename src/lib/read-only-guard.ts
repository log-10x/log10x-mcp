/**
 * Read-only guard for the hosted MCP playground.
 *
 * WHY THIS EXISTS
 *
 * The hosted demo playground (LOG10X_MCP_HTTP_PORT mode) exposes the full
 * tool catalog so callers can inspect descriptions + schemas, but any
 * tool that would write to a real customer system (k8s ConfigMaps, GitHub
 * PRs, gitops repos, AWS SSM, GCP SM, Azure AC, etc.) MUST refuse to
 * execute. The catalog stays "visible-but-locked": tool descriptions
 * still surface so an agent can plan against them; calling the tool
 * returns a structured `demo_read_only` envelope explaining what the
 * tool WOULD have done, instead of running.
 *
 * USAGE
 *
 *   import { requireWriteAccess } from '../lib/read-only-guard.js';
 *
 *   export async function executeConfigureEnv(args: Args) {
 *     requireWriteAccess('writes to k8s ConfigMap log10x-env-config-{env_id}');
 *     // ... rest of handler ...
 *   }
 *
 * The guard throws `DemoReadOnlyError`, which `buildChassisEnvelope()`
 * and the top-level `wrap()` in index.ts recognise and convert into the
 * canonical demo_read_only envelope shape.
 *
 * Set LOG10X_MCP_READ_ONLY=true (or '1') to activate. The boot log emits
 * "Running in read-only mode" so operators can see the gate is live.
 */

/**
 * Thrown by `requireWriteAccess()` when LOG10X_MCP_READ_ONLY is set.
 *
 * Carries:
 *   - `would_have`: a per-tool description of the side effect that was
 *     blocked, e.g. 'writes to k8s ConfigMap log10x-env-config-{env_id}'
 *     or 'opens a GitHub PR against your gitops repo'.
 *   - `hint`: the full agent-facing remediation string the envelope
 *     formatter will surface in `data.error.hint`.
 */
export class DemoReadOnlyError extends Error {
  constructor(public hint: string, public would_have: string) {
    super('demo_read_only');
    this.name = 'DemoReadOnlyError';
  }
}

/**
 * True when the MCP is running in the hosted demo playground's
 * read-only mode. Set by the deployment via env var.
 */
export function isReadOnlyMode(): boolean {
  return (
    process.env.LOG10X_MCP_READ_ONLY === 'true' ||
    process.env.LOG10X_MCP_READ_ONLY === '1'
  );
}

/**
 * Guard called at the top of every writer tool's executor. When
 * `isReadOnlyMode()` is true, throws `DemoReadOnlyError` with a
 * structured hint that the envelope formatter surfaces in the
 * `demo_read_only` envelope.
 *
 * `would_have` should be a single phrase describing the tool's side
 * effect (no leading capital, no trailing period). Examples:
 *   - 'writes to k8s ConfigMap log10x-env-config-{env_id}'
 *   - 'opens a GitHub PR against your gitops repo'
 *   - 'mutates the Receiver cap CSV in your gitops repo'
 *   - 'calls the Log10x control-plane API to register an environment'
 */
export function requireWriteAccess(would_have: string): void {
  if (!isReadOnlyMode()) return;
  const hint =
    `This MCP is running in read-only demo mode (LOG10X_MCP_READ_ONLY=true). ` +
    `This tool would have: ${would_have}. ` +
    `To execute, run against a real environment with the env var unset.`;
  throw new DemoReadOnlyError(hint, would_have);
}
