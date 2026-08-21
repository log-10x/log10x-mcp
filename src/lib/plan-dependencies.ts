/**
 * Two-tier SIEM dependency scan for a ladder plan.
 *
 * The persona reviews' top blocker was "the plan says WHAT, never what it
 * TOUCHES". A naive literal scan is half theater: real monitors reference
 * SLICES (service:payment status:error), not message templates, so literal
 * absence is not safety — and slice overlap is too broad to exclude on
 * (every payment monitor overlaps every payment type). Hence two tiers:
 *
 *  TIER 1 — LITERAL: an object's query/title contains the type's distinctive
 *  tokens. High precision. These types are EXCLUDED from the plan by default
 *  (pinned at pass, plan re-solved) unless the user trades them back in.
 *
 *  TIER 2 — SLICE: objects whose text mentions a planned service at all.
 *  High recall, deliberately broad. A DISCLOSURE, never an exclusion —
 *  rendered with the destination's platform truth (Flex data and real-time
 *  monitors, the IA class and metric filters, offload and every query).
 *
 * The vendor inventory is fetched ONCE (lib/siem/deps fetchVendorInventory)
 * and matched locally, so a 200-type plan costs the same API calls as one.
 * Scan-depth honesty rides on the summary: what was scanned is stated, and
 * "no literal references found in what was scanned" is the strongest claim
 * the data supports — never "safe".
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan, PlannedRow, SolverPattern, SolveOpts } from './plan-solver.js';
import { solvePlan } from './plan-solver.js';
import type { SiemId } from './siem/pricing.js';
import {
  fetchVendorInventory as realFetchVendorInventory,
  matchObject,
  DEP_CHECK_VENDORS,
  type VendorInventory,
} from './siem/deps/index.js';

export interface PlanRowDependencies {
  hash: string;
  name: string;
  displayName: string;
  refs: number;
  /** Names of the referencing objects (monitors/searches/dashboards), capped at 5. */
  names: string[];
  /** Savings this row carried in the ORIGINAL solve — what excluding it forgoes. */
  forgoneUsd: number;
}

export interface SliceDependency {
  service: string;
  objects: number;
  /** Referencing-object names, capped at 5. */
  names: string[];
}

export interface PlanDependencySummary {
  /** True when a scan actually ran (credentials present, vendor supported). */
  checked: boolean;
  vendor?: SiemId;
  /** What the scan could actually see, e.g. "monitor queries and dashboard
   *  titles/descriptions". The honesty line: absence of literal hits means
   *  "none found in THIS", never "safe". */
  scan_depth?: string;
  /** How many planned rows were matched (all of them — batch inventory). */
  scanned_rows: number;
  /** TIER 1: planned types literally referenced by name/query text. */
  literal: PlanRowDependencies[];
  /** TIER 1 outcome: types excluded from the final plan (pinned at pass). */
  excluded: PlanRowDependencies[];
  /** TIER 2: objects that mention a planned service at all — disclosure only. */
  slice: SliceDependency[];
  /** Destination truth for the levers in play, stated once. */
  platform_truth?: string;
  total_refs: number;
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

type InventoryFetcher = typeof realFetchVendorInventory;
let inventoryFetcher: InventoryFetcher = realFetchVendorInventory;
/** Test seam, same pattern as _setBackendLoader / _setVerifyRunner. */
export function _setInventoryFetcher(fn: InventoryFetcher): void {
  inventoryFetcher = fn;
}
export function _resetInventoryFetcher(): void {
  inventoryFetcher = realFetchVendorInventory;
}

/** Destination truth for the levers a plan actually uses. */
export function platformTruth(plan: Plan): string | undefined {
  const actions = new Set(plan.planned.map((r) => r.action));
  const parts: string[] = [];
  if (actions.has('tier_down')) {
    if (plan.destination === 'datadog') {
      parts.push('Flex-tier events do not feed real-time log monitors; monitors on these services evaluate on less data once types move');
    } else if (plan.destination === 'cloudwatch') {
      parts.push('the Infrequent Access class does not support metric filters or subscription filters; filters on these services stop seeing moved types');
    }
  }
  if (actions.has('offload')) {
    parts.push('offloaded types leave the destination entirely; every query, dashboard, and alert on these services sees fewer events (recoverable through the retriever)');
  }
  if (actions.has('drop') || actions.has('sample')) {
    parts.push('dropped or sampled types are gone from the destination; nothing downstream sees them');
  }
  return parts.length > 0 ? parts.join('. ') + '.' : undefined;
}

function objectAllText(o: { texts: { name: string[]; query: string[]; definition: string[] } }): string {
  return [...o.texts.name, ...o.texts.query, ...o.texts.definition].join('\n');
}

const GENERIC_SERVICE_NAMES = new Set(['api', 'app', 'web', 'www', 'all', 'main', 'core', 'base', 'test']);

/** TIER 2: which inventory objects mention each planned service at all. */
export function sliceScan(inv: VendorInventory, services: string[]): SliceDependency[] {
  const out: SliceDependency[] = [];
  for (const svc of services) {
    const name = svc.trim();
    if (name.length < 3) continue;
    if (name === '(unattributed)') continue;
    if (GENERIC_SERVICE_NAMES.has(name.toLowerCase())) continue;
    const re = new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    const hits = inv.objects.filter((o) => re.test(objectAllText(o)));
    if (hits.length === 0) continue;
    out.push({ service: name, objects: hits.length, names: hits.slice(0, 5).map((h) => h.name) });
  }
  return out;
}

export interface CheckPlanDepsOptions {
  /** Overall wall-clock budget for the inventory fetch. Default 20000ms. */
  timeoutMs?: number;
}

export async function checkPlanDependencies(
  plan: Plan,
  opts: CheckPlanDepsOptions = {},
): Promise<PlanDependencySummary> {
  const timeoutMs = opts.timeoutMs ?? 20_000;

  const none = (note: string): PlanDependencySummary => ({
    checked: false,
    scanned_rows: 0,
    literal: [],
    excluded: [],
    slice: [],
    total_refs: 0,
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

  let inv: VendorInventory;
  try {
    inv = await Promise.race([
      inventoryFetcher(vendor),
      new Promise<VendorInventory>((_res, rej) => {
        const t = setTimeout(() => rej(new Error('inventory fetch timeout')), timeoutMs);
        t.unref?.();
      }),
    ]);
  } catch (e) {
    return none(`not checked: inventory fetch failed (${e instanceof Error ? e.message : String(e)})`);
  }
  if (inv.error) return none(`not checked: ${inv.error}`);

  // TIER 1 — literal, ALL planned rows against the one inventory.
  const literal: PlanRowDependencies[] = [];
  for (const r of plan.planned) {
    const tokens = r.name.split('_').filter((t) => t.length >= 4);
    const effective = tokens.length > 0 ? tokens : [r.name.replace(/_/g, ' ')];
    const hits = inv.objects.filter((o) => matchObject(o, effective).length > 0);
    if (hits.length === 0) continue;
    literal.push({
      hash: r.hash,
      name: r.name,
      displayName: r.displayName,
      refs: hits.length,
      names: hits.slice(0, 5).map((h) => h.name),
      forgoneUsd: r.savedUsd,
    });
  }

  // TIER 2 — slice disclosure over the planned services.
  const services = [...new Set(plan.planned.map((r) => r.dominantService))];
  const slice = sliceScan(inv, services);

  const totalRefs = literal.reduce((s, x) => s + x.refs, 0);
  const noteParts = [
    `scanned ${inv.scanDepth} (${inv.objects.length} objects) against all ${plan.planned.length} planned message types`,
    literal.length > 0
      ? `${literal.length} referenced by name (${totalRefs} object${totalRefs === 1 ? '' : 's'})`
      : 'no literal references found in what was scanned',
  ];
  if (slice.length > 0) {
    noteParts.push(`${slice.reduce((s, x) => s + x.objects, 0)} objects mention the planned services`);
  }

  return {
    checked: true,
    vendor,
    scan_depth: inv.scanDepth,
    scanned_rows: plan.planned.length,
    literal,
    excluded: [],
    slice,
    platform_truth: platformTruth(plan),
    total_refs: totalRefs,
    note: noteParts.join('; '),
  };
}

/**
 * TIER 1 outcome: pin the literally-referenced types at pass and re-solve.
 * Pure given the summary — the caller passes the same patterns/opts it solved
 * with. Returns the re-solved plan and the exclusion record for the render;
 * the excluded rows carry the savings the exclusion forgoes.
 */
export function applyReferencedExclusion(
  patterns: SolverPattern[],
  solveOpts: SolveOpts,
  summary: PlanDependencySummary,
): { plan: Plan; excluded: PlanRowDependencies[] } {
  const excludedHashes = summary.literal.map((h) => h.hash);
  const plan = solvePlan(patterns, {
    ...solveOpts,
    pinnedHashes: [...(solveOpts.pinnedHashes ?? []), ...excludedHashes],
  });
  return { plan, excluded: summary.literal };
}

export type { PlannedRow };
