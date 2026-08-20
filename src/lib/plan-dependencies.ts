/**
 * Batch SIEM dependency scan for a ladder plan.
 *
 * The persona reviews' top blocker was "the plan says WHAT, never what it
 * TOUCHES" — nobody applies a routing change without knowing which dashboards,
 * alerts, and saved searches read the moved message types. The per-pattern
 * scanner already exists (lib/siem/deps, read-only API calls); this module
 * batches it over the rows a plan will actually render and folds the result
 * into one summary the verdict block can carry.
 *
 * Scope, deliberately v1:
 *  - Scans the TOP rows only (default 7 — the cards plus a margin). Each
 *    vendor call refetches the object inventory, so a full-estate scan (100+
 *    rows) belongs to a batched-inventory refactor of lib/siem/deps, not here.
 *  - Credential preflight is instant: env vars, plus ~/.aws/credentials for
 *    CloudWatch. An EC2 instance role is not detected — the note says so
 *    rather than letting the SDK's IMDS probe stall a plan render.
 *  - An overall deadline caps the scan; rows not reached are reported, never
 *    silently skipped.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from './plan-solver.js';
import type { SiemId } from './siem/pricing.js';
import {
  checkDeps as realCheckDeps,
  DEP_CHECK_VENDORS,
  type DepCheckResult,
} from './siem/deps/index.js';

export interface PlanRowDependencies {
  hash: string;
  name: string;
  displayName: string;
  refs: number;
  by_type: DepCheckResult['byType'];
  /** Names of the matched objects (dashboards/alerts/...), capped at 5. */
  names: string[];
}

export interface PlanDependencySummary {
  /** True when a scan actually ran (credentials present, vendor supported). */
  checked: boolean;
  vendor?: SiemId;
  /** How many of the plan's top rows were scanned. */
  scanned_rows: number;
  /** Rows (of the scanned set) with at least one referencing object. */
  rows_with_refs: number;
  total_refs: number;
  rows: PlanRowDependencies[];
  /** One human-readable line: what ran, or why nothing did. Render-safe. */
  note: string;
}

/** Map a plan destination onto the dep-check vendor that can scan it. */
export function depVendorForDestination(destination: SiemId): SiemId | null {
  const d = String(destination);
  if (d === 'splunk' || d === 'splunk_cloud') return 'splunk';
  if (d === 'datadog') return 'datadog';
  if (d === 'cloudwatch') return 'cloudwatch';
  if (d === 'elasticsearch' || d === 'elasticsearch_self' || d === 'elastic-serverless' || d === 'opensearch_self') {
    return 'elasticsearch';
  }
  return DEP_CHECK_VENDORS.includes(destination) ? destination : null;
}

/** Instant, env-only credential preflight per dep-check vendor. */
export function depCredsPresent(vendor: SiemId): { present: boolean; missing: string } {
  const env = process.env;
  switch (vendor) {
    case 'datadog':
      return {
        present: Boolean((env.DD_API_KEY || env.DATADOG_API_KEY) && (env.DD_APP_KEY || env.DATADOG_APP_KEY)),
        missing: 'DD_API_KEY + DD_APP_KEY',
      };
    case 'splunk':
      return {
        present: Boolean(env.SPLUNK_HOST && (env.SPLUNK_TOKEN || (env.SPLUNK_USERNAME && env.SPLUNK_PASSWORD))),
        missing: 'SPLUNK_HOST + SPLUNK_TOKEN',
      };
    case 'elasticsearch':
      return {
        present: Boolean(
          (env.KIBANA_URL || env.ELASTIC_URL || env.ELASTICSEARCH_URL) &&
            (env.KIBANA_API_KEY || env.ELASTIC_API_KEY || env.ELASTICSEARCH_API_KEY ||
              env.KIBANA_USERNAME || env.ELASTIC_USERNAME || env.ELASTICSEARCH_USERNAME),
        ),
        missing: 'KIBANA_URL + an API key or username/password',
      };
    case 'cloudwatch': {
      const sharedCreds = env.HOME ? existsSync(join(env.HOME, '.aws', 'credentials')) : false;
      return {
        present: Boolean(env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE || sharedCreds),
        missing: 'AWS_ACCESS_KEY_ID, AWS_PROFILE, or ~/.aws/credentials (instance roles are not auto-detected here)',
      };
    }
    default:
      return { present: false, missing: 'unsupported vendor' };
  }
}

type DepsChecker = typeof realCheckDeps;
let depsChecker: DepsChecker = realCheckDeps;
/** Test seam, same pattern as _setBackendLoader / _setVerifyRunner. */
export function _setDepsChecker(fn: DepsChecker): void {
  depsChecker = fn;
}
export function _resetDepsChecker(): void {
  depsChecker = realCheckDeps;
}

export interface CheckPlanDepsOptions {
  /** Top planned rows to scan. Default 7. */
  limit?: number;
  /** Overall wall-clock budget for the whole scan. Default 15000ms. */
  timeoutMs?: number;
}

export async function checkPlanDependencies(
  plan: Plan,
  opts: CheckPlanDepsOptions = {},
): Promise<PlanDependencySummary> {
  const limit = opts.limit ?? 7;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const none = (note: string): PlanDependencySummary => ({
    checked: false,
    scanned_rows: 0,
    rows_with_refs: 0,
    total_refs: 0,
    rows: [],
    note,
  });

  if (plan.planned.length === 0) return none('nothing planned, nothing to scan');

  const vendor = depVendorForDestination(plan.destination);
  if (!vendor) {
    return none(`no read-only dependency scanner for ${plan.destination} yet (covered: ${DEP_CHECK_VENDORS.join(', ')})`);
  }
  const creds = depCredsPresent(vendor);
  if (!creds.present) {
    return none(`not checked: no ${vendor} credentials in this session (need ${creds.missing}); run log10x_dependency_check after setting them`);
  }

  const targets = plan.planned.slice(0, limit);
  const deadline = Date.now() + timeoutMs;
  const rows: PlanRowDependencies[] = [];
  let scanned = 0;
  let timedOut = false;

  for (const r of targets) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    const tokens = r.name.split('_').filter((t) => t.length > 0);
    let scan: DepCheckResult;
    try {
      scan = await Promise.race([
        depsChecker(vendor, { pattern: r.name, tokens }),
        new Promise<DepCheckResult>((_res, rej) =>
          setTimeout(() => rej(new Error('row scan timeout')), Math.max(1000, deadline - Date.now())).unref?.(),
        ),
      ]);
    } catch {
      timedOut = true;
      break;
    }
    if (scan.error) {
      // Same error would repeat for every row (auth/endpoint) — stop, report.
      return none(`not checked: ${scan.error}`);
    }
    scanned += 1;
    if (scan.matches.length > 0) {
      rows.push({
        hash: r.hash,
        name: r.name,
        displayName: r.displayName,
        refs: scan.matches.length,
        by_type: scan.byType,
        names: scan.matches.slice(0, 5).map((m) => m.name),
      });
    }
  }

  const totalRefs = rows.reduce((s, x) => s + x.refs, 0);
  const noteParts = [
    `checked ${vendor} dashboards and alerts for the top ${scanned} planned message type${scanned === 1 ? '' : 's'}`,
    rows.length > 0
      ? `${rows.length} referenced by ${totalRefs} object${totalRefs === 1 ? '' : 's'}`
      : 'none referenced',
  ];
  if (timedOut) noteParts.push(`scan budget hit before the rest; run log10x_dependency_check for deeper coverage`);
  else if (plan.planned.length > scanned) noteParts.push(`${plan.planned.length - scanned} more planned types not scanned; run log10x_dependency_check per type for the rest`);

  return {
    checked: true,
    vendor,
    scanned_rows: scanned,
    rows_with_refs: rows.length,
    total_refs: totalRefs,
    rows,
    note: noteParts.join('; '),
  };
}
