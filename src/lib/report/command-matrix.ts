/**
 * Command matrix — versioned command cells keyed by
 * (siem × forwarder × install_method).
 *
 * Commands are exactly where hallucination is unaffordable, so cells
 * are static data, tested per cell, and the agent never composes
 * them. Missing context values are NOT invented: they render as
 * explicit `<fill-me>` placeholders the user must substitute, and the
 * report's apply block keeps them visibly marked.
 *
 * v1 ships two cells (design doc):
 *   cloudwatch × fluentd × k8s
 *   splunk    × hec     × k8s
 * The engine-side apply (caps.csv ConfigMap + rollout restart) is
 * SIEM-agnostic; what differs per SIEM is the retrieval/query key
 * notes and diagnostics. `host` install cells are reserved for a
 * later version — lookup returns null and the renderer says so
 * honestly rather than guessing service paths.
 */

export type InstallMethod = 'k8s' | 'host';

/**
 * Forwarder key space: discovery's ForwarderKind spellings, plus
 * 'hec' (a Splunk delivery path, not a detected forwarder). An alias
 * map normalizes the other enums' spellings — no fourth vocabulary.
 */
export type MatrixForwarder =
  | 'fluentd'
  | 'fluent-bit'
  | 'filebeat'
  | 'logstash'
  | 'otel-collector'
  | 'vector'
  | 'hec';

const FORWARDER_ALIASES: Record<string, MatrixForwarder> = {
  fluentd: 'fluentd',
  'fluent-bit': 'fluent-bit',
  fluentbit: 'fluent-bit',
  filebeat: 'filebeat',
  logstash: 'logstash',
  'otel-collector': 'otel-collector',
  vector: 'vector',
  hec: 'hec',
};

export function normalizeForwarder(raw: string | undefined): MatrixForwarder | null {
  if (!raw) return null;
  return FORWARDER_ALIASES[raw.toLowerCase()] ?? null;
}

export interface CmdCtx {
  /** k8s namespace the engine forwarder runs in. */
  namespace?: string;
  /** Forwarder workload name (daemonset/deployment). */
  workload?: string;
  /** Local caps file name written next to the report. */
  capsFileName: string;
}

export interface CommandCell {
  applyCaps(ctx: CmdCtx): string[];
  undoCaps(ctx: CmdCtx): string[];
  /** DNS diagnostic for operational actions whose cluster tokens
   * indicate resolution failures. */
  checkDns?(ctx: CmdCtx): string[];
}

/** Visible fill-me marker — tested to never be silently dropped. */
export const FILL_ME_NS = '<namespace>';
export const FILL_ME_WORKLOAD = '<forwarder-workload>';

function k8sApplyCaps(ctx: CmdCtx): string[] {
  const ns = ctx.namespace ?? FILL_ME_NS;
  const wl = ctx.workload ?? FILL_ME_WORKLOAD;
  return [
    `kubectl -n ${ns} create configmap log10x-caps --from-file=${ctx.capsFileName} \\`,
    `  --dry-run=client -o yaml | kubectl apply -f -`,
    `kubectl -n ${ns} rollout restart daemonset ${wl}`,
  ];
}

function k8sUndoCaps(ctx: CmdCtx): string[] {
  const ns = ctx.namespace ?? FILL_ME_NS;
  const wl = ctx.workload ?? FILL_ME_WORKLOAD;
  return [
    `kubectl -n ${ns} delete configmap log10x-caps`,
    `kubectl -n ${ns} rollout restart daemonset ${wl}`,
  ];
}

function k8sCheckDns(ctx: CmdCtx): string[] {
  const ns = ctx.namespace ?? FILL_ME_NS;
  return [
    `kubectl -n ${ns} run log10x-dnscheck --rm -it --image=busybox --restart=Never -- \\`,
    `  sh -c 'nslookup <failing-hostname>'`,
  ];
}

type CellKey = `${string}|${string}|${InstallMethod}`;

const CELLS: Record<CellKey, CommandCell> = {
  'cloudwatch|fluentd|k8s': {
    applyCaps: k8sApplyCaps,
    undoCaps: k8sUndoCaps,
    checkDns: k8sCheckDns,
  },
  'splunk|hec|k8s': {
    applyCaps: k8sApplyCaps,
    undoCaps: k8sUndoCaps,
    checkDns: k8sCheckDns,
  },
};

export function lookupCommandCell(
  siem: string | null,
  forwarder: string | null,
  install: InstallMethod,
): CommandCell | null {
  if (!siem || !forwarder) return null;
  const fwd = normalizeForwarder(forwarder);
  if (!fwd) return null;
  return CELLS[`${siem}|${fwd}|${install}`] ?? null;
}

/** Exported for the per-cell test sweep. */
export const _cellKeys = (): string[] => Object.keys(CELLS);
