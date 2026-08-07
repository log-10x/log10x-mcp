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
}

export class ReportRefusal extends Error {}

export interface BuiltReport {
  data: ReportData;
  /** Verbatim caps.csv content matching THE CHANGE rows, or null when
   * the plan has no volume action. Written beside the report so the
   * apply commands reference a real file. */
  capsCsv: string | null;
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
  };
  const noCellNote = `no verified commands for this stack (${opts.siem ?? 'siem not set'} / ${opts.forwarder ?? 'forwarder not set'} / ${opts.install}) in this version; run log10x_advise_install`;

  const actions: ReportAction[] = [];
  const windowSeconds = Math.max(1, Math.round(input.windowHours * 3600));

  let capsCsv: string | null = null;
  if (reducible.length > 0) {
    const impact = reducible.reduce((s, p) => s + p.bytes, 0);
    const faces = reducible.slice(0, MAX_FACES_PER_ACTION).map((p) => buildFace(p));
    const services = countByService(reducible);
    const label = serviceLabel(services);
    // Container-keyed rows, the grammar configure_engine truly emits:
    // `<container>,<capBytes>:<action>:<reason>`. Cap is scaled to the
    // engine's reset window from this window's measured bytes.
    const byContainer = new Map<string, number>();
    for (const p of reducible) {
      const key = p.service ?? '<container>';
      byContainer.set(key, (byContainer.get(key) ?? 0) + p.bytes);
    }
    const rows = Array.from(byContainer.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([container, bytes]) => {
        const cap = Math.max(1, Math.round(bytes * (CAP_RESET_WINDOW_SECONDS / windowSeconds)));
        return `${container},${cap}:tier_down:MCP poc_from_local soft`;
      });
    capsCsv = ['container,cap', ...rows].join('\n') + '\n';
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
          `${CAPS_FILE_NAME} — engine route rows, keyed by container.`,
          `Generated from this window; caps are scaled to the engine's ${CAP_RESET_WINDOW_SECONDS}s reset window.`,
        ],
        rows,
        engineGapNote:
          `the engine acts per container today; per-statement disposition is pending engine work, ` +
          `so these rows route the containers hosting the statements above`,
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
      title: `Fix the failure behind ${pct}% of this window`,
      note:
        `${fmtCount(members.length)} statement${members.length === 1 ? '' : 's'}` +
        (services.size > 0 ? ` across ${services.size} service${services.size === 1 ? '' : 's'}` : '') +
        ` report the same failure. Fixing it removes the volume at source; the re-run measures it.`,
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
  const verdict = buildVerdict(actions, dominantCluster?.cluster ?? null, dominantShare, severitySufficient, extraction.severityCoverage);

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
      `severity attribution covered ${Math.round((extraction.severityCoverage ?? 0) * 100)}% of statements — below the floor this tool requires, so no volume action was proposed and nothing is reduced.`,
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
      label: windowLabel(input.windowHours),
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
    verify,
    kept: { protectedEvents, sentences: keptSentences },
  };
  return { data, capsCsv };
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
        `annotation for ${hash} is ${text.length} chars; the cap is ${MAX_ANNOTATION_CHARS}. Shorten it — it will not be truncated.`,
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
    headline = `${pct}% of this window is one repeating failure: ${headLine}`;
    sentences.push(
      `${fmtCount(cluster.members.length)} statements in ${cluster.service} report the same failure on every occurrence.`,
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
      sentences.push(`Action ${i + 1} is the actual fix.`);
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

export function windowLabel(windowHours: number): string {
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
