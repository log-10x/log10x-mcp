/**
 * build-report-data — compute ReportData from the enriched POC
 * pipeline output. Everything here is tool arithmetic over measured
 * window values; the agent's only input is the annotation map, which
 * is validated fail-closed (unknown hash or over-cap length refuses
 * the render — never silently truncated or dropped).
 *
 * Honesty constraints implemented here:
 *  - severity gate: below MIN_SEVERITY_COVERAGE no volume action is
 *    proposed at all (a gate must fail on known-broken input).
 *  - THE CHANGE renders the container-keyed grammar configure_engine
 *    truly emits; the per-statement gap is stated, not papered over.
 *  - impacts are this window's arithmetic; no extrapolation.
 */

import type { RenderInput, _EnrichedPattern } from '../poc-report-renderer.js';
import type { Plan } from '../plan-solver.js';
import type { IncidentCluster } from '../detectors/incident-cluster.js';
import {
  isProtectedSeverity,
  isReducibleSeverity,
  severityAttributionSufficient,
} from '../severity-policy.js';
import { fmtBytes, fmtCount } from '../format.js';
import { buildFace } from './face-extraction.js';
import {
  lookupCommandCell,
  ACTIONS_FILE_NAME,
  type CmdCtx,
  type InstallMethod,
} from './command-matrix.js';
import {
  MAX_ANNOTATION_CHARS,
  REPORT_TEMPLATE_VERSION,
  type EvidenceFace,
  type ReportAction,
  type ReportData,
  type VerifyCheck,
} from './report-data.js';
import { perInstanceCap, instancesFor, describeInstances, medianInstances, type EnforcingInstances } from '../enforcing-instances.js';
import { placeServiceCap, marginSentence } from '../service-cap.js';
import {
  csvReason,
  keptNoun,
  fleetSentence,
  flexAddedSentence,
  linesPerDayFromCap,
  serviceLimitSentence,
  serviceLimitsFromPatterns,
  type FleetLimit,
} from './user-units.js';
import {
  dependencyLinesForFleetDefault,
  dependencyLinesForService,
  type RuleDependencySummary,
} from '../siem/deps/datadog-log-queries.js';
import {
  FLEET_DEFAULT_HEADROOM,
  defaultErrorFloor,
  fleetDefaultNumber,
  type FleetDefaultAction,
  type KeptCell,
} from '../fleet-default.js';

/** A cluster must carry at least this share of window bytes to drive
 * the verdict + an operational action. */
export const DOMINANT_CLUSTER_SHARE = 0.2;

/** Max statements a single volume action absorbs (top-3 faces + the
 * "and N more" counter). Keeps the report O(actions). */
const MAX_STATEMENTS_PER_ACTION = 15;
const MAX_FACES_PER_ACTION = 3;

/** Byte share below which a statement is not worth a volume action. */
const MIN_STATEMENT_SHARE = 0.005;

/** Engine rate-regulator reset window (mirrors configure_engine's
 * computeCapBytesPerWindow basis). */
const CAP_RESET_WINDOW_SECONDS = 240;

export const CAPS_FILE_NAME = 'log10x-caps.csv';
export { ACTIONS_FILE_NAME } from './command-matrix.js';

/**
 * The engine's two files from a plan's container rows. `caps.csv` gives each
 * container the bytes a pattern may spend per regulator window before its
 * excess takes the action; `actions.csv` gives the action. Both in the
 * engine's own grammar, `<container>,<bytes>::<reason>` and
 * `<container>,<action>::<reason>`, the empty middle field being the expiry
 * slot. A tier_down cap is the largest kept pattern's bytes, so the planned
 * patterns and no other exceed it; offload and drop act on the whole
 * container, so their cap is the 1-byte minimum (0 would switch the
 * regulator off for that container). `spanSeconds` is the span the plan's
 * byte figures cover. A container's row carries its own reason from
 * `reasonByContainer` when one is given (the plan's sentence in user units),
 * else `reason`.
 */
export function engineFilesFromContainerCaps(
  caps: Plan['containerCaps'],
  spanSeconds: number,
  reason: string,
  instances?: EnforcingInstances,
  reasonByContainer?: Record<string, string>,
): { capsCsv: string; actionsCsv: string; capRows: string[] } {
  const fallback = reason.replace(/[,:]/g, ';');
  const capRows: string[] = [];
  const actionRows: string[] = [];
  for (const [container, v] of Object.entries(caps).sort(([a], [b]) => a.localeCompare(b))) {
    const perWindow = (v.capBytesMonthly * CAP_RESET_WINDOW_SECONDS) / Math.max(1, spanSeconds);
    const cap =
      v.action === 'offload' || v.action === 'drop' ? 1 : perInstanceCap(perWindow, instancesFor(instances, container));
    const own = reasonByContainer?.[container];
    const r = own ? csvReason(own) : fallback;
    capRows.push(`${container},${cap}::${r}`);
    actionRows.push(`${container},${v.action}::${r}`);
  }
  return {
    capsCsv: ['container,cap', ...capRows].join('\n') + '\n',
    actionsCsv: ['container,action', ...actionRows].join('\n') + '\n',
    capRows,
  };
}

export interface BuildReportOptions {
  siem: string | null;
  siemLabel: string | null;
  forwarder: string | null;
  install: InstallMethod;
  namespace?: string;
  workload?: string;
  /** Agent annotation slots, keyed by evidence hash. */
  annotations?: Record<string, string>;
  generatedAtIso: string;
  mcpVersion: string;
  /** The ladder plan the tool solved; its container rows become the engine files. */
  plan?: Plan;
  /** The span the plan's byte figures cover, in seconds. */
  planSpanSeconds?: number;
  /** Receivers enforcing each container's cap; caps are divided by them. */
  enforcingInstances?: EnforcingInstances;
  /** The fleet-wide default for services with no row, when the plan writes one. */
  fleetDefault?: FleetLimit;
  /** Compute the fleet default from this capture (wins over `fleetDefault`). */
  fleetDefaultRequest?: FleetDefaultRequest;
  /** One sentence on the caps' unit and how it was reached (receiver-bytes.ts). */
  capUnitStatement?: string;
  /** Datadog: the log monitors and log-based metrics that read each rule's moved lines, printed beside the rule. */
  ruleDependencies?: RuleDependencySummary;
}

export class ReportRefusal extends Error {}

export interface FleetDefaultRequest {
  /** Multiplier on the baseline. Default 2. */
  headroom?: number;
  /** Where a statement above the limit goes. Default `tier_down`. */
  action?: FleetDefaultAction;
  /** Share of ERROR and CRITICAL lines above the limit kept in Standard. Default by action. */
  errorFloor?: number;
}

/** The fleet default a capture sets, for the plan and for `log10x_advise_install`. */
export interface FleetDefaultReport {
  /** False when the capture keeps no statement to set the limit from. */
  computed: boolean;
  reason?: string;
  action: FleetDefaultAction;
  error_floor: number;
  headroom: number;
  /** The engine value, `rateReceiverAbsoluteCap`: bytes per reset window per node. */
  cap_bytes_per_window_per_node?: number;
  baseline_bytes_per_window_per_node?: number;
  baseline_statement?: string;
  baseline_container?: string;
  /** The limit in lines a day at the baseline statement's line size, across `nodes_for_lines` nodes. */
  limit_lines_per_day?: number;
  /** The median Receivers per container with a known count; 1 when none is known. */
  nodes_for_lines: number;
  containers_with_known_nodes: number;
  /** The fleet line in user units. */
  sentence: string;
}

/**
 * The fleet default from a capture: each container's largest kept statement
 * as a per-node cell, the rule in `fleet-default.ts` on those cells, and the
 * limit in lines a day for the fleet line.
 */
export function fleetDefaultFromPatterns<
  P extends { service?: string; bytes: number; count: number; receiverBytes?: number; receiverCapBytes?: number },
>(
  patterns: P[],
  isMoved: (p: P) => boolean,
  windowSeconds: number,
  instances: EnforcingInstances | undefined,
  request: FleetDefaultRequest,
  siem: string | null,
  nameOf: (p: P) => string,
): FleetDefaultReport {
  const action = request.action ?? 'tier_down';
  const errorFloor = request.errorFloor ?? defaultErrorFloor(action);
  const headroom = request.headroom ?? FLEET_DEFAULT_HEADROOM;
  // In the Receiver's unit: each statement at its busiest window's rate.
  const capBytesOf = (p: P): number => p.receiverCapBytes ?? p.bytes;
  const keptMax = new Map<string, P>();
  for (const p of patterns) {
    if (!p.service || isMoved(p) || !(capBytesOf(p) > 0)) continue;
    const cur = keptMax.get(p.service);
    if (!cur || capBytesOf(p) > capBytesOf(cur)) keptMax.set(p.service, p);
  }
  const cells: KeptCell[] = [...keptMax].map(([container, p]) => ({
    container,
    keptMaxBytesPerWindow: (capBytesOf(p) * CAP_RESET_WINDOW_SECONDS) / Math.max(1, windowSeconds),
    instances: instancesFor(instances, container),
    statement: nameOf(p),
    avgBytesPerLine: p.count > 0 ? (p.receiverBytes ?? p.bytes) / p.count : undefined,
  }));
  const median = instances ? medianInstances(instances) : { median: 1, known: 0 };
  const num = fleetDefaultNumber(cells, headroom);
  if (!num) {
    return {
      computed: false,
      reason: 'the capture keeps no statement in a named container, so there is no baseline for the limit',
      action,
      error_floor: errorFloor,
      headroom,
      nodes_for_lines: median.median,
      containers_with_known_nodes: median.known,
      sentence: fleetSentence(siem),
    };
  }
  const limitLinesPerDay = linesPerDayFromCap(num.capBytesPerWindowPerNode, median.median, num.baseline.avgBytesPerLine ?? 1);
  return {
    computed: true,
    action,
    error_floor: errorFloor,
    headroom: num.headroom,
    cap_bytes_per_window_per_node: num.capBytesPerWindowPerNode,
    baseline_bytes_per_window_per_node: num.baselineBytesPerWindowPerNode,
    ...(num.baseline.statement ? { baseline_statement: num.baseline.statement } : {}),
    baseline_container: num.baseline.container,
    limit_lines_per_day: limitLinesPerDay,
    nodes_for_lines: median.median,
    containers_with_known_nodes: median.known,
    sentence: fleetSentence(siem, { limitLinesPerDay, action }),
  };
}

export interface BuiltReport {
  data: ReportData;
  /** Verbatim caps.csv content matching THE CHANGE rows, or null when
   * the plan has no volume action. Written beside the report so the
   * apply commands reference a real file. */
  capsCsv: string | null;
  /** The sibling actions.csv, the engine's per-container action file. */
  actionsCsv: string | null;
  /** Planned patterns with no container, which no cap row can key. */
  unattributedPlanned: number;
  /** The fleet default this capture sets, when the caller asked for one. */
  fleetDefault?: FleetDefaultReport;
}

export function buildReportData(
  input: RenderInput,
  enriched: { patterns: _EnrichedPattern[]; clusters: IncidentCluster[] },
  opts: BuildReportOptions,
): BuiltReport {
  const extraction = input.extraction;
  const totalBytes = Math.max(1, extraction.totalBytes);
  const severitySufficient = severityAttributionSufficient(extraction.severityCoverage);

  // ── Cluster membership via the enricher's own assignment ──
  const byCluster = new Map<number, _EnrichedPattern[]>();
  for (const p of enriched.patterns) {
    const id = p.poc.incidentClusterId;
    if (id === null || id === undefined) continue;
    const list = byCluster.get(id) ?? [];
    list.push(p);
    byCluster.set(id, list);
  }
  let dominant: { idx: number; bytes: number; members: _EnrichedPattern[] } | null = null;
  for (const [idx, members] of byCluster) {
    const bytes = members.reduce((s, p) => s + p.bytes, 0);
    if (!dominant || bytes > dominant.bytes) dominant = { idx, bytes, members };
  }
  const dominantShare = dominant ? dominant.bytes / totalBytes : 0;
  const dominantCluster =
    dominant && dominantShare >= DOMINANT_CLUSTER_SHARE
      ? { ...dominant, cluster: enriched.clusters[dominant.idx] }
      : null;

  // The dominant cluster is addressable volume too — the feasibility verdict
  // and the agent headline both count it — but it is fixed at SOURCE, not by a
  // lossless 10x lever. Track whether it is a real failure (error-class) or
  // repeated informational output (collector debug/telemetry), which decides
  // the wording below (F7b) and lets the headline lead with the full
  // addressable total broken into its two parts (F7).
  const dominantIsFailure = dominantCluster
    ? dominantCluster.members.filter((m) => isProtectedSeverity(m.severity)).length * 2 >=
      dominantCluster.members.length
    : false;

  // ── Volume action selection (severity-gated, reducible only) ──
  const inDominant = new Set(dominantCluster?.members ?? []);
  const reducible = severitySufficient
    ? enriched.patterns
        .filter((p) => !inDominant.has(p))
        .filter((p) => isReducibleSeverity(p.severity))
        .filter((p) => ['tier_down', 'offload', 'compact'].includes(p.poc.refinedAction))
        .filter((p) => p.bytes / totalBytes >= MIN_STATEMENT_SHARE)
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, MAX_STATEMENTS_PER_ACTION)
    : [];

  const cell = lookupCommandCell(opts.siem, opts.forwarder, opts.install);
  const cmdCtx: CmdCtx = {
    namespace: opts.namespace,
    workload: opts.workload,
    capsFileName: CAPS_FILE_NAME,
    actionsFileName: ACTIONS_FILE_NAME,
  };
  const noCellNote = `no verified commands for this stack (${opts.siem ?? 'siem not set'} / ${opts.forwarder ?? 'forwarder not set'} / ${opts.install}) in this version; run log10x_advise_install`;

  const actions: ReportAction[] = [];
  const windowSeconds = Math.max(1, Math.round(input.windowHours * 3600));

  let capsCsv: string | null = null;
  let actionsCsv: string | null = null;
  let unattributedPlanned = 0;
  let fleetDefault: FleetDefaultReport | undefined;
  if (reducible.length > 0) {
    const impact = reducible.reduce((s, p) => s + p.bytes, 0);
    const faces = reducible.slice(0, MAX_FACES_PER_ACTION).map((p) => buildFace(p));
    const services = countByService(reducible);
    const label = serviceLabel(services);
    // The engine's files, one row per container. From the solved plan when
    // there is one; otherwise from this window's reducible patterns, with a
    // tier_down cap at the largest pattern the container keeps.
    let containerCaps: Plan['containerCaps'];
    let spanSeconds: number;
    /** The statements the files move, by the identity the plan keys on. */
    let isMoved: (p: _EnrichedPattern) => boolean;
    if (opts.plan && opts.planSpanSeconds) {
      containerCaps = opts.plan.containerCaps;
      spanSeconds = opts.planSpanSeconds;
      unattributedPlanned = opts.plan.planned.filter(
        (r) => r.action !== 'pass' && (!r.dominantService || r.dominantService === '(unattributed)'),
      ).length;
      const movedHashes = new Set(opts.plan.planned.filter((r) => r.action !== 'pass').map((r) => r.hash));
      isMoved = (p) => movedHashes.has(p.tenxHash ?? p.hash);
    } else {
      containerCaps = {};
      spanSeconds = windowSeconds;
      const reducibleSet = new Set(reducible);
      isMoved = (p) => reducibleSet.has(p);
      const hosts = new Set(reducible.map((p) => p.service).filter((s): s is string => !!s));
      unattributedPlanned = reducible.filter((p) => !p.service).length;
      for (const c of hosts) {
        let cap = 0;
        let keptMaxPattern: string | undefined;
        let movedMin: number | undefined;
        for (const p of enriched.patterns) {
          if (p.service !== c) continue;
          // The Receiver's unit, at the statement's busiest window's rate.
          const b = p.receiverCapBytes ?? p.bytes;
          if (reducibleSet.has(p)) {
            if (movedMin === undefined || b < movedMin) movedMin = b;
          } else if (b > cap) { cap = b; keptMaxPattern = p.symbolMessage ?? p.template.split("\n")[0]; }
        }
        // Between the largest kept and the smallest moved statement, at their geometric mean.
        const placed = placeServiceCap(cap, movedMin);
        containerCaps[c] = {
          action: 'tier_down',
          capBytesMonthly: placed.cap,
          ...(keptMaxPattern ? { keptMaxPattern } : {}),
          separated: placed.separated,
          ...(placed.margin !== undefined ? { margin: placed.margin } : {}),
          keptMaxBytesMonthly: placed.keptMax,
          ...(placed.movedMin !== undefined ? { movedMinBytesMonthly: placed.movedMin } : {}),
        };
      }
    }
    // The plan in user units: one sentence per container, lines a day and
    // dollars a month. The same sentence is each row's reason.
    const units = serviceLimitsFromPatterns(
      containerCaps,
      enriched.patterns,
      isMoved,
      windowSeconds,
      opts.siem,
      (p) => p.symbolMessage ?? (p.template ?? '').split('\n')[0] ?? p.hash,
    );
    const serviceLines = units.limits.map((l) => serviceLimitSentence(l, opts.siem));
    // Each tier_down limit's margin, in the reader's terms.
    const marginLines = Object.keys(containerCaps)
      .sort()
      .flatMap((c) => {
        const v = containerCaps[c];
        if (v.action !== 'tier_down' || v.keptMaxBytesMonthly === undefined) return [];
        const line = marginSentence(
          c,
          { separated: !!v.separated, margin: v.margin, keptMax: v.keptMaxBytesMonthly, movedMin: v.movedMinBytesMonthly },
          keptNoun(opts.siem),
        );
        return line ? [line] : [];
      });
    const reasonByContainer = Object.fromEntries(units.limits.map((l, i) => [l.service, serviceLines[i]]));
    // Each service's sentence, then the monitors and metrics that read its moved lines.
    const deps = opts.ruleDependencies;
    const serviceBlocks = units.limits.flatMap((l, i) => [
      serviceLines[i],
      ...(deps?.checked ? dependencyLinesForService(deps, l.service) : []),
    ]);
    const unscopedLines = deps ? deps.lines.slice(deps.rules.reduce((n, r) => n + r.lines.length, 0)) : [];
    const nameOfPattern = (p: _EnrichedPattern): string => p.symbolMessage ?? (p.template ?? '').split('\n')[0] ?? p.hash;
    if (opts.fleetDefaultRequest) {
      fleetDefault = fleetDefaultFromPatterns(
        enriched.patterns,
        isMoved,
        windowSeconds,
        opts.enforcingInstances,
        opts.fleetDefaultRequest,
        opts.siem,
        nameOfPattern,
      );
    }
    const fleetLine = fleetDefault ? fleetDefault.sentence : fleetSentence(opts.siem, opts.fleetDefault);
    const fleetLines = fleetDefault?.computed
      ? [
          fleetLine,
          `The fleet default is the largest statement kept, ${fleetDefault.baseline_statement ?? 'one statement'} in ` +
            `${fleetDefault.baseline_container}, per node, times ${fleetDefault.headroom}. It is a Receiver value, not a row in ` +
            `either file: log10x_advise_install writes it as rateReceiverAbsoluteCap with rateReceiverDefaultAction ` +
            `${fleetDefault.action}.`,
          ...dependencyLinesForFleetDefault(deps),
        ]
      : [
          fleetLine,
          ...(fleetDefault && !fleetDefault.computed ? [`No fleet default: ${fleetDefault.reason}.`] : []),
          ...dependencyLinesForFleetDefault(deps),
        ];
    const flexLine = flexAddedSentence(opts.siem, units.movedBytesMonthly, units.movedEventsMonthly);
    const files = engineFilesFromContainerCaps(
      containerCaps,
      spanSeconds,
      `MCP poc_from_local${opts.plan ? ` plan ${opts.plan.targetPct} pct` : ''}`,
      opts.enforcingInstances,
      reasonByContainer,
    );
    const rows = files.capRows;
    capsCsv = files.capsCsv;
    actionsCsv = files.actionsCsv;
    actions.push({
      kind: 'tier_down',
      title: `Route ${label} statements to the retrievable tier`,
      note:
        `${fmtCount(reducible.length)} low-severity statement${reducible.length === 1 ? '' : 's'} ` +
        `carry ${fmtBytes(impact)} this window. They keep landing in your own bucket, retrievable on demand; ` +
        `they stop landing on the ingest path. Nothing is deleted.`,
      impactBytes: impact,
      evidence: faces,
      ...(reducible.length > MAX_FACES_PER_ACTION
        ? { moreStatements: reducible.length - MAX_FACES_PER_ACTION }
        : {}),
      change: {
        commentLines: [
          ...serviceBlocks,
          ...marginLines,
          ...fleetLines,
          ...unscopedLines,
          ...(flexLine ? [flexLine] : []),
          `A limit sits between the largest statement the container keeps and the smallest it moves, at the same ratio from each.`,
          `${CAPS_FILE_NAME}: each container's limit in the engine's units, bytes per node, with its sentence as the reason; ` +
            `${ACTIONS_FILE_NAME}: where a container's excess goes.`,
          ...(opts.capUnitStatement ? [opts.capUnitStatement] : []),
          `Limits are per node: ` +
            Object.keys(containerCaps)
              .sort()
              .map((c) => (opts.enforcingInstances ? describeInstances(opts.enforcingInstances, c) : `${c}: node count unknown, written for one Receiver`))
              .join('; ') +
            (fleetDefault?.computed
              ? `; the fleet default: per node, its lines a day stated for ${fleetDefault.nodes_for_lines} ` +
                `node${fleetDefault.nodes_for_lines === 1 ? '' : 's'}, the median per container` +
                (fleetDefault.containers_with_known_nodes > 0
                  ? ` across ${fleetDefault.containers_with_known_nodes} with a known count`
                  : ', no container\'s count known')
              : '') +
            '.',
        ],
        rows,
        engineGapNote:
          `the engine applies each limit per container: every statement above it in a listed container takes the route, ` +
          `less the share its severity keeps` +
          (unattributedPlanned > 0
            ? `; ${unattributedPlanned} planned statement${unattributedPlanned === 1 ? '' : 's'} carried no container and ${unattributedPlanned === 1 ? 'is' : 'are'} not in these rows`
            : ''),
      },
      apply: cell
        ? { commands: cell.applyCaps(cmdCtx) }
        : { commands: [], unavailableNote: noCellNote },
      undo: cell
        ? { commands: cell.undoCaps(cmdCtx) }
        : { commands: [], unavailableNote: noCellNote },
    });
  }

  if (dominantCluster) {
    const members = [...dominantCluster.members].sort((a, b) => b.bytes - a.bytes);
    const faces = members.slice(0, 2).map((p) => buildFace(p));
    const services = new Set(members.map((m) => m.service).filter(Boolean));
    const pct = Math.round(dominantShare * 100);
    const dnsLike = /no[ _]?such[ _]?host|lookup|dns|resolve|unreachable|connection refused/i.test(
      dominantCluster.cluster?.representativeLabel ?? '',
    );
    actions.push({
      kind: 'operational',
      title: dominantIsFailure
        ? `Fix the failure behind ${pct}% of this window`
        : `Cut the repeated output driving ${pct}% of this window`,
      note:
        `${fmtCount(members.length)} statement${members.length === 1 ? '' : 's'}` +
        (services.size > 0 ? ` across ${services.size} service${services.size === 1 ? '' : 's'}` : '') +
        (dominantIsFailure
          ? ` report the same failure. Fixing it removes the volume at source; the re-run measures it.`
          : ` emit the same output on every occurrence. Turning it down at the source (log level or exporter verbosity) removes the volume before it is ever ingested; the re-run measures it.`),
      evidence: faces,
      ...(members.length > 2 ? { moreStatements: members.length - 2 } : {}),
      ...(dnsLike && cell?.checkDns ? { check: { commands: cell.checkDns(cmdCtx) } } : {}),
    });
  }

  if (actions.length > 6) actions.length = 6;

  // ── Annotations: fail-closed validation, then attach ──
  attachAnnotations(actions, opts.annotations);

  // ── Verdict ──
  const removableBytes = actions.reduce((s, a) => s + (a.impactBytes ?? 0), 0);
  const removablePct = (removableBytes / totalBytes) * 100;
  // F7: when a dominant fix-at-source cluster sits beside the lossless levers,
  // surface the full addressable total (lossless + source-fix) with its split,
  // so the report leads with the same number the agent and feasibility report
  // rather than the lossless slice alone.
  const sourceFixBytes = dominantCluster ? dominant!.bytes : 0;
  const achievable =
    sourceFixBytes > 0
      ? {
          losslessBytes: removableBytes,
          sourceFixBytes,
          losslessPct: (removableBytes / totalBytes) * 100,
          sourceFixPct: (sourceFixBytes / totalBytes) * 100,
          totalPct: ((removableBytes + sourceFixBytes) / totalBytes) * 100,
          sourceIsFailure: dominantIsFailure,
        }
      : undefined;

  const verdict = buildVerdict(actions, dominantCluster?.cluster ?? null, dominantShare, severitySufficient, extraction.severityCoverage, dominantIsFailure);

  // ── Verify panel ──
  const verify = buildVerifyChecks(input, enriched, severitySufficient, actions);

  // ── Kept ──
  const protectedEvents = severitySufficient
    ? enriched.patterns
        .filter((p) => isProtectedSeverity(p.severity))
        .reduce((s, p) => s + p.count, 0)
    : null;
  const keptSentences: string[] = [];
  if (protectedEvents !== null) {
    keptSentences.push(
      `every ERROR and WARN event (${fmtCount(protectedEvents)} this window) stays on the ingest path in full.`,
    );
  } else {
    keptSentences.push(
      `severity attribution covered ${Math.round((extraction.severityCoverage ?? 0) * 100)}% of statements: below the floor this tool requires, so no volume action was proposed and nothing is reduced.`,
    );
  }
  const tierIdx = actions.findIndex((a) => a.kind === 'tier_down');
  if (tierIdx >= 0) {
    keptSentences.push(
      `Statements routed by action ${tierIdx + 1} land in your own bucket and come back on demand with their statement identifier as the query key.`,
    );
  }

  const data: ReportData = {
    templateVersion: REPORT_TEMPLATE_VERSION,
    meta: {
      siemLabel: opts.siemLabel,
      forwarderLabel: opts.forwarder,
      runKind: 'first_run',
      generatedAtIso: opts.generatedAtIso,
      ...(extraction.engineBuild ? { engineBuild: extraction.engineBuild } : {}),
      mcpVersion: opts.mcpVersion,
    },
    window: {
      label: windowLabel(input.windowHours, input.window),
      events: extraction.totalEvents,
      statements: extraction.patterns.length,
      ingestedBytes: extraction.totalBytes,
    },
    totals: { removableBytes, removablePct },
    verdict,
    actions,
    expected: {
      beforeBytes: extraction.totalBytes,
      afterBytes: Math.max(0, extraction.totalBytes - removableBytes),
    },
    ...(achievable ? { achievable } : {}),
    verify,
    kept: { protectedEvents, sentences: keptSentences },
  };
  return { data, capsCsv, actionsCsv, unattributedPlanned, ...(fleetDefault ? { fleetDefault } : {}) };
}

function attachAnnotations(
  actions: ReportAction[],
  annotations: Record<string, string> | undefined,
): void {
  if (!annotations) return;
  const byHash = new Map<string, ReportAction>();
  for (const a of actions) for (const f of a.evidence) byHash.set(f.hash, a);
  for (const [hash, text] of Object.entries(annotations)) {
    if (text.length > MAX_ANNOTATION_CHARS) {
      throw new ReportRefusal(
        `annotation for ${hash} is ${text.length} chars; the cap is ${MAX_ANNOTATION_CHARS}. Shorten it: it will not be truncated.`,
      );
    }
    const action = byHash.get(hash);
    if (!action) {
      throw new ReportRefusal(
        `annotation targets unknown or non-evidence hash ${hash}; annotations may only attach to statements shown as evidence.`,
      );
    }
    // One slot per action: first annotation wins, a second refuses.
    if (action.annotation) {
      throw new ReportRefusal(
        `action "${action.title}" already carries an annotation; one slot per action.`,
      );
    }
    action.annotation = text;
  }
}

function buildVerdict(
  actions: ReportAction[],
  cluster: IncidentCluster | null,
  dominantShare: number,
  severitySufficient: boolean,
  severityCoverage: number,
  dominantIsFailure = false,
): ReportData['verdict'] {
  const sentences: string[] = [];
  let headline: string;
  if (cluster) {
    const pct = Math.round(dominantShare * 100);
    // Head line only — the representative descriptor of a welded
    // statement carries its stack lines, which belong in the evidence
    // face below, not in a heading. Taking the head line is a
    // selection, not an intra-line cut.
    const headLine = cluster.representativeLabel.split('\n')[0];
    // F7b: token clustering joins any repeated statement, not only errors. A
    // cluster of collector INFO debug lines is repeated OUTPUT, not a failure —
    // call it what its severity says it is.
    const noun = dominantIsFailure ? 'repeating failure' : 'repeated output';
    const verb = dominantIsFailure ? 'report the same failure' : 'emit the same output';
    headline = `${pct}% of this window is one ${noun}: ${headLine}`;
    sentences.push(
      `${fmtCount(cluster.members.length)} statements in ${cluster.service} ${verb} on every occurrence.`,
    );
  } else if (actions.length > 0) {
    const covered = actions.reduce((s, a) => s + a.evidence.length + (a.moreStatements ?? 0), 0);
    headline = `${fmtCount(covered)} statements carry the removable volume in this window`;
  } else if (!severitySufficient) {
    headline = `Severity attribution too thin to act on this window`;
    sentences.push(
      `Only ${Math.round(severityCoverage * 100)}% of statements carry a severity, below the floor for proposing volume actions. The verified checks below say what ran; improve attribution and re-run.`,
    );
  } else {
    headline = `No dominant cost driver in this window`;
    sentences.push(`No statement class cleared the volume floor for a proposed action.`);
  }
  actions.forEach((a, i) => {
    if (a.kind === 'tier_down') {
      sentences.push(`Action ${i + 1} routes low-severity statements off the ingest path; nothing is deleted.`);
    } else if (a.kind === 'cap') {
      sentences.push(`Action ${i + 1} caps that volume at the engine.`);
    } else {
      sentences.push(
        dominantIsFailure
          ? `Action ${i + 1} is the actual fix.`
          : `Action ${i + 1} cuts that repeated output at its source.`,
      );
    }
  });
  return { headline, sentences };
}

function buildVerifyChecks(
  input: RenderInput,
  enriched: { patterns: _EnrichedPattern[] },
  severitySufficient: boolean,
  actions: ReportAction[],
): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  const extraction = input.extraction;
  checks.push({
    id: 'engine_ran',
    state: 'ok',
    label: 'engine ran locally',
    detail: extraction.engineBuild ?? 'local CLI',
  });
  checks.push({
    id: 'resolution',
    state: 'ok',
    label: `${fmtCount(extraction.totalEvents)} events resolved to ${fmtCount(extraction.patterns.length)} statements`,
  });
  const welded = extraction.patterns.filter((p) => (p.template ?? '').includes('\n')).length;
  checks.push(
    welded > 0
      ? {
          id: 'weld_integrity',
          state: 'ok',
          label: 'multi-line statements welded',
          detail: `${fmtCount(welded)} statements arrive whole`,
        }
      : {
          id: 'weld_integrity',
          state: 'not_run',
          label: 'multi-line weld check',
          detail: 'no multi-line statements in this window',
        },
  );
  checks.push(
    severitySufficient
      ? {
          id: 'severity_attribution',
          state: 'ok',
          label: 'severity attribution sufficient',
          detail: `${Math.round(extraction.severityCoverage * 100)}% of statements`,
        }
      : {
          id: 'severity_attribution',
          state: 'warn',
          label: 'severity attribution below floor',
          detail: `${Math.round(extraction.severityCoverage * 100)}% of statements; volume actions withheld`,
        },
  );
  const tierIdx = actions.findIndex((a) => a.kind === 'tier_down');
  checks.push({
    id: 'tier_delivery',
    state: 'not_configured',
    label: 'retrievable tier delivery',
    detail: 'not configured in this window',
    ...(tierIdx >= 0 ? { enabledByAction: tierIdx + 1 } : {}),
  });
  checks.push({
    id: 'doctor',
    state: 'not_run',
    label: 'environment doctor',
    detail: 'run log10x_doctor for engine + delivery checks',
  });
  return checks;
}

function countByService(patterns: _EnrichedPattern[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of patterns) {
    if (!p.service) continue;
    m.set(p.service, (m.get(p.service) ?? 0) + p.bytes);
  }
  return m;
}

function serviceLabel(services: Map<string, number>): string {
  if (services.size === 0) return 'low-severity';
  const top = Array.from(services.entries()).sort((a, b) => b[1] - a[1])[0][0];
  return services.size === 1 ? top : `${top} and other low-severity`;
}

export function windowLabel(windowHours: number, window?: string): string {
  // A file source has no pull window — its span is an artifact of which lines
  // were sampled, so a time claim ("one hour of logs") is fabricated. Name the
  // sample instead. `window === 'file'` is the sentinel poc-from-local passes.
  if (window === 'file') return 'this log sample';
  if (windowHours <= 0) return 'this window';
  if (windowHours < 1) {
    const mins = Math.round(windowHours * 60);
    return `${mins} minutes`;
  }
  if (windowHours === 1) return 'one hour';
  if (windowHours === 24) return '24 hours';
  if (Number.isInteger(windowHours)) return `${windowHours} hours`;
  return `${Math.round(windowHours * 10) / 10} hours`;
}
